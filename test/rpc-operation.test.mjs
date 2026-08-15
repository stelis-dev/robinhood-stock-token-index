import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPairPeriod, readPairState } from "../collector/pair-reader.mjs";
import { maximumRpcEndpointCount, RpcEndpointUnavailableError } from "../collector/rpc-endpoint.mjs";
import { runRpcPairOperation } from "../collector/rpc-operation.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { compactPairRegistry, FakePairRpc, pairSwapLog } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";

async function countingDirectory(registry) {
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "pair-rpc-operation-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  const writes = [];
  return {
    directory,
    writes,
    store: {
      readSelectedState: (...args) => directory.readSelectedState(...args),
      readReferenced: (...args) => directory.readReferenced(...args),
      resolvePairMonth: (...args) => directory.resolvePairMonth(...args),
      writeReferenced: async (...args) => {
        writes.push("reference");
        return directory.writeReferenced(...args);
      },
      writeState: async (...args) => {
        writes.push("state");
        return directory.writeState(...args);
      },
      cleanupSelectedGeneration: (...args) => directory.cleanupSelectedGeneration(...args),
    },
  };
}

test("availability after partial reads restarts the entire unpublished pair attempt", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const primary = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  primary.logs.push(pairSwapLog({
    registry,
    pair,
    block: primary.block(activation + 50n),
    baseAmountRaw: 10_000_000_000_000_000n,
    quoteAmountRaw: 2_500_000n,
  }));
  const primaryGetLogs = primary.getLogs.bind(primary);
  let primaryRanges = 0;
  primary.getLogs = async (input) => {
    primaryRanges += 1;
    if (primaryRanges === 2) throw new RpcEndpointUnavailableError();
    return primaryGetLogs(input);
  };
  const fallback = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  fallback.logs.push(pairSwapLog({
    registry,
    pair,
    block: fallback.block(activation + 60n),
    baseAmountRaw: 10_000_000_000_000_000n,
    quoteAmountRaw: 3_100_000n,
  }));
  const { directory, store, writes } = await countingDirectory(registry);
  const fallbackVerify = fallback.verifyChain.bind(fallback);
  fallback.verifyChain = async (...args) => {
    assert.deepEqual(writes, []);
    return fallbackVerify(...args);
  };

  const completed = await runRpcPairOperation({
    operation: "current",
    registry,
    pairId: pair.pairId,
    store,
    rpcClients: [primary, fallback],
  });
  assert.equal(completed.selectedEndpointIndex, 1);
  assert.equal(primary.logRequests[0].from, fallback.logRequests[0].from);
  assert.equal(primary.logRequests[0].to, fallback.logRequests[0].to);
  const state = await readPairState({ registry, pairId: pair.pairId, store: directory });
  const period = await readPairPeriod({
    registry,
    store: directory,
    input: {
      pairId: pair.pairId,
      from: pair.activation.timestamp,
      until: state.coverage.untilTimestamp,
    },
  });
  assert.equal(period.candles.length, 1);
  assert.deepEqual(period.candles[0].close, { numerator: "310", denominator: "1" });
  assert.equal(writes.at(-1), "state");
});

test("a Swap header outside the fixed time range is fatal and cannot be dropped or retried on another endpoint", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const primary = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  primary.logs.push(pairSwapLog({
    registry,
    pair,
    block: primary.block(activation + 60n),
    baseAmountRaw: 10_000_000_000_000_000n,
    quoteAmountRaw: 3_000_000n,
  }));
  const getBlockHeaders = primary.getBlockHeaders.bind(primary);
  primary.getBlockHeaders = async (...args) => {
    const headers = await getBlockHeaders(...args);
    for (const [number, header] of headers) {
      headers.set(number, {
        ...header,
        timestamp: `0x${BigInt(Math.floor(Date.parse("2026-08-15T14:01:00.000Z") / 1000)).toString(16)}`,
      });
    }
    return headers;
  };
  let fallbackUsed = false;
  const { directory, store, writes } = await countingDirectory(registry);
  await assert.rejects(runRpcPairOperation({
    operation: "current",
    registry,
    pairId: pair.pairId,
    store,
    rpcClients: [primary, { async verifyChain() { fallbackUsed = true; } }],
  }), /outside the fixed collection range/);
  assert.equal(fallbackUsed, false);
  assert.deepEqual(writes, []);
  assert.equal(await directory.readSelectedState(pair.pairId), null);
});

test("integrity and storage failures stop without invoking another endpoint", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  let fallbackUsed = false;
  const fallback = { async verifyChain() { fallbackUsed = true; } };
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "pair-rpc-fatal-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  await assert.rejects(runRpcPairOperation({
    operation: "current",
    registry,
    pairId: pair.pairId,
    store: directory,
    rpcClients: [{ async verifyChain() { throw new Error("RPC chain identity mismatch."); } }, fallback],
  }), /chain identity mismatch/);
  assert.equal(fallbackUsed, false);

  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  const failingStore = {
    readSelectedState: (...args) => directory.readSelectedState(...args),
    readReferenced: (...args) => directory.readReferenced(...args),
    resolvePairMonth: (...args) => directory.resolvePairMonth(...args),
    async writeReferenced() { throw new Error("storage publication failed"); },
    async writeState() { throw new Error("state must not be reached"); },
  };
  await assert.rejects(runRpcPairOperation({
    operation: "current",
    registry,
    pairId: pair.pairId,
    store: failingStore,
    rpcClients: [rpc, fallback],
  }), /storage publication failed/);
  assert.equal(fallbackUsed, false);
  assert.equal(await directory.readSelectedState(pair.pairId), null);
});

test("a committed activation mismatch is fatal rather than an availability fallback", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  const getBlock = rpc.getBlock.bind(rpc);
  rpc.getBlock = async (selector) => {
    const block = await getBlock(selector);
    if (selector !== "finalized" && BigInt(selector) === activation) return { ...block, hash: `0x${"f".repeat(64)}` };
    return block;
  };
  let fallbackUsed = false;
  const store = (await countingDirectory(registry)).directory;
  await assert.rejects(runRpcPairOperation({
    operation: "current",
    registry,
    pairId: pair.pairId,
    store,
    rpcClients: [rpc, { async verifyChain() { fallbackUsed = true; } }],
  }), /activation boundary/);
  assert.equal(fallbackUsed, false);
});

test("repair rejects an endpoint behind the stored range and never reads past that range on fallback", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "pair-rpc-repair-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  await runRpcPairOperation({
    operation: "current",
    registry,
    pairId: pair.pairId,
    store: directory,
    rpcClients: [new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n })],
  });
  const stale = new FakePairRpc({ registry, pair, finalizedNumber: activation + 358n });
  const fallback = new FakePairRpc({ registry, pair, finalizedNumber: activation + 359n });
  const completed = await runRpcPairOperation({
    operation: "repair",
    registry,
    pairId: pair.pairId,
    store: directory,
    rpcClients: [stale, fallback],
  });
  assert.equal(completed.selectedEndpointIndex, 1);
  assert.equal(stale.logRequests.length, 0);
  assert.ok(fallback.blockSearches.every((search) => search.maximumBlock <= activation + 359n));
});

test("the endpoint runner accepts at most three clients and returns one generic final error", async () => {
  const registry = await compactPairRegistry();
  const pairId = pairEntryBySymbol(registry, "NVDA").pair.pairId;
  let used = false;
  const client = { async verifyChain() { used = true; } };
  await assert.rejects(runRpcPairOperation({
    operation: "current",
    registry,
    pairId,
    store: {},
    rpcClients: Array.from({ length: maximumRpcEndpointCount + 1 }, () => client),
  }), /set/);
  assert.equal(used, false);

  const unavailable = { async verifyChain() { throw new RpcEndpointUnavailableError(); } };
  await assert.rejects(runRpcPairOperation({
    operation: "current",
    registry,
    pairId,
    store: {},
    rpcClients: [unavailable, { ...unavailable }],
  }), (error) => {
    assert.equal(error.message, "All RPC endpoints were unavailable.");
    return true;
  });
});
