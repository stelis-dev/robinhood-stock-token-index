import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RpcEndpointUnavailableError } from "../collector/rpc-endpoint.mjs";
import { RpcClient } from "../collector/rpc-client.mjs";
import { runRpcIndexOperation } from "../collector/rpc-operation.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { block, FakeRpc, fixtureRegistry, swapLog } from "./fixtures.mjs";

function chainBlocks(baseSeconds, maximum) {
  return Array.from({ length: maximum + 1 }, (_, number) => block(number, baseSeconds + number * 10));
}

test("availability failover discards the unpublished attempt and restarts the complete collection", async () => {
  const registry = structuredClone(await fixtureRegistry());
  registry.collection.logRangeBlocks = 100;
  const group = registry.groups[0];
  const asset = group.assets[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 720);
  const primaryLog = swapLog({ registry, asset, block: blocks[361], amount0: -3_000_000n, amount1: 10_000_000_000_000_000n });
  const fallbackLog = swapLog({ registry, asset, block: blocks[365], amount0: -3_100_000n, amount1: 10_000_000_000_000_000n });
  const primary = new FakeRpc({ registry, blocks, logs: [primaryLog], finalizedNumber: 720 });
  const primaryGetLogs = primary.getLogs.bind(primary);
  let primaryRangeCount = 0;
  primary.getLogs = async (input) => {
    primaryRangeCount += 1;
    if (primaryRangeCount === 2) throw new RpcEndpointUnavailableError();
    return primaryGetLogs(input);
  };
  const fallback = new FakeRpc({ registry, blocks, logs: [fallbackLog], finalizedNumber: 720 });
  const store = new DirectoryStore({ root: await mkdtemp(join(tmpdir(), "stock-token-rpc-failover-")), registry, group });

  const completed = await runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [primary, fallback],
  });

  assert.equal(completed.status, "published");
  assert.equal(fallback.logRequests[0].from, primary.logRequests[0].from);
  const state = await store.readState();
  const day = await store.readDay(state.days[0]);
  assert.equal(day.candles.length, 1);
  assert.equal(day.candles[0].tradeCount, 1);
  assert.deepEqual(day.candles[0].close, { numerator: "310", denominator: "1" });
});

test("an integrity failure stops without trying another endpoint", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  let fallbackUsed = false;
  const integrityFailure = {
    async verifyChain() { throw new Error("RPC chain identity mismatch."); },
  };
  const unusedFallback = {
    async verifyChain() { fallbackUsed = true; },
  };
  const store = {
    async readState() { throw new Error("Store must not be read."); },
  };

  await assert.rejects(runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [integrityFailure, unusedFallback],
  }), /chain identity mismatch/);
  assert.equal(fallbackUsed, false);
});

test("malformed log identity is fatal without exposing provider text or using a fallback", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 720);
  const providerText = "private-provider-response";
  const malformed = new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 720 });
  malformed.getLogs = async () => [{ blockNumber: providerText }];
  let fallbackUsed = false;
  const fallback = { async verifyChain() { fallbackUsed = true; } };
  const store = new DirectoryStore({ root: await mkdtemp(join(tmpdir(), "stock-token-rpc-malformed-log-")), registry, group });

  await assert.rejects(runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [malformed, fallback],
  }), (error) => {
    assert.equal(error.message, "Swap block number is not a canonical hex quantity.");
    assert.doesNotMatch(error.message, new RegExp(providerText));
    return true;
  });
  assert.equal(fallbackUsed, false);
  assert.equal(await store.readState(), null);
});

test("an endpoint that does not cover the last stored block restarts collection", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 120);
  const previous = {
    contractVersion: "1",
    kind: "stock_token_execution_state",
    groupId: group.groupId,
    sequence: 1,
    nextBlock: "96",
    coveredUntilTimestamp: "2026-08-13T00:16:00.000Z",
    days: [],
  };
  const store = {
    state: previous,
    async readState() { return this.state; },
    async readDay() { throw new Error("Unexpected day read."); },
    async commit({ state }) { this.state = state; },
  };
  const completed = await runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [
      new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 90 }),
      new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 120 }),
    ],
  });

  assert.equal(completed.status, "published");
  assert.equal(completed.fromBlock, "96");
  assert.equal(store.state.sequence, 2);
});

test("a missing finalized block restarts collection on the next endpoint", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 120);
  const primary = new RpcClient({
    url: "https://primary.example/rpc",
    requestDelayMilliseconds: 1,
    requestTimeoutMilliseconds: 1_000,
    maximumResponseBytes: 1_024,
    maximumRpcAttempts: 1,
    maximumRpcRetryDelayMilliseconds: 1_000,
    fetchImplementation: async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_chainId" ? "0x1237" : null,
      }));
    },
    sleepImplementation: async () => {},
  });
  const store = {
    state: {
      contractVersion: "1",
      kind: "stock_token_execution_state",
      groupId: group.groupId,
      sequence: 1,
      nextBlock: "96",
      coveredUntilTimestamp: "2026-08-13T00:16:00.000Z",
      days: [],
    },
    async readState() { return this.state; },
    async readDay() { throw new Error("Unexpected day read."); },
    async commit({ state }) { this.state = state; },
  };

  const completed = await runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [primary, new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 120 })],
  });

  assert.equal(completed.status, "published");
  assert.equal(completed.fromBlock, "96");
});

test("the last covered block is the exact stale-endpoint boundary", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 95);
  let fallbackUsed = false;
  const fallback = {
    async verifyChain() { fallbackUsed = true; },
  };
  const store = {
    async readState() {
      return {
        contractVersion: "1",
        kind: "stock_token_execution_state",
        groupId: group.groupId,
        sequence: 1,
        nextBlock: "96",
        coveredUntilTimestamp: "2026-08-13T00:16:00.000Z",
        days: [],
      };
    },
  };
  const completed = await runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 95 }), fallback],
  });
  assert.equal(completed.status, "current");
  assert.equal(fallbackUsed, false);
});

test("repair falls back from a stale endpoint and never reads beyond the last covered block", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets[0];
  const base = Date.parse("2026-08-12T22:30:00.000Z") / 1000;
  const initialBlocks = chainBlocks(base, 720);
  const logs = [swapLog({ registry, asset, block: initialBlocks[361], amount0: -3_000_000n, amount1: 10_000_000_000_000_000n })];
  const store = new DirectoryStore({ root: await mkdtemp(join(tmpdir(), "stock-token-rpc-repair-boundary-")), registry, group });
  await runRpcIndexOperation({
    operation: "collect",
    registry,
    group,
    store,
    rpcClients: [new FakeRpc({ registry, blocks: initialBlocks, logs, finalizedNumber: 720 })],
  });

  const state = await store.readState();
  const lastCoveredBlock = BigInt(state.nextBlock) - 1n;
  const boundaryBlocks = initialBlocks.slice(0, Number(lastCoveredBlock) + 1);
  const stale = new FakeRpc({ registry, blocks: boundaryBlocks, logs, finalizedNumber: lastCoveredBlock - 1n });
  const repair = new FakeRpc({ registry, blocks: boundaryBlocks, logs, finalizedNumber: lastCoveredBlock });
  const completed = await runRpcIndexOperation({
    operation: "repair",
    registry,
    group,
    store,
    rpcClients: [stale, repair],
  });

  assert.equal(completed.status, "published");
  assert.equal(stale.logRequests.length, 0);
  assert.ok(repair.blockSearches.length >= 2);
  assert.ok(repair.blockSearches.every((search) => search.maximumBlock <= lastCoveredBlock));
});

test("the endpoint runner rejects clients beyond the configured topology", async () => {
  const registry = await fixtureRegistry();
  let used = false;
  const client = { async verifyChain() { used = true; } };
  await assert.rejects(runRpcIndexOperation({
    operation: "collect",
    registry,
    group: registry.groups[0],
    store: {},
    rpcClients: [client, {}, {}, {}],
  }), /set/);
  assert.equal(used, false);
});

test("aggregate endpoint failure exposes only a static message", async () => {
  const registry = await fixtureRegistry();
  const unavailable = {
    async verifyChain() { throw new RpcEndpointUnavailableError(); },
  };
  await assert.rejects(runRpcIndexOperation({
    operation: "collect",
    registry,
    group: registry.groups[0],
    store: {},
    rpcClients: [unavailable, { ...unavailable }],
  }), (error) => {
    assert.equal(error.message, "All RPC endpoints were unavailable.");
    return true;
  });
});
