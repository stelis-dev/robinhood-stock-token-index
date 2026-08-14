import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectIndex,
  repairIndex,
  retainIndex,
  verifyIndex,
} from "../collector/process.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { block, FakeRpc, fixtureRegistry, swapLog } from "./fixtures.mjs";

function chainBlocks(baseSeconds, maximum) {
  return Array.from({ length: maximum + 1 }, (_, number) => block(number, baseSeconds + number * 10));
}

test("collection, incremental continuation, repair, and exact verification share one process", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets.find((entry) => entry.symbol === "AAPL");
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 780);
  const logs = [
    swapLog({ registry, asset, block: blocks[361], amount0: -3_000_000n, amount1: 10_000_000_000_000_000n, logIndex: 0 }),
    swapLog({ registry, asset, block: blocks[365], amount0: -6_200_000n, amount1: 20_000_000_000_000_000n, logIndex: 1 }),
  ];
  const rpc = new FakeRpc({ registry, blocks, logs, finalizedNumber: 720 });
  const root = await mkdtemp(join(tmpdir(), "stock-token-index-"));
  const store = new DirectoryStore({ root, registry, group });

  const first = await collectIndex({ registry, group, store, rpc });
  assert.equal(first.status, "published");
  assert.equal(first.fromTimestamp, "2026-08-13T01:00:00.000Z");
  assert.equal(first.untilTimestamp, "2026-08-13T02:00:00.000Z");
  assert.equal(first.candleCount, 1);
  assert.equal((await verifyIndex({ group, store })).candleCount, 1);
  const firstState = await store.readState();
  const firstDay = await store.readDay(firstState.days[0]);
  assert.equal(firstDay.candles[0].tradeCount, 2);
  assert.deepEqual(firstDay.candles[0].close, { numerator: "310", denominator: "1" });

  rpc.finalizedNumber = 780n;
  rpc.logs.push(swapLog({ registry, asset, block: blocks[725], amount0: -3_050_000n, amount1: 10_000_000_000_000_000n, logIndex: 0 }));
  const second = await collectIndex({ registry, group, store, rpc });
  assert.equal(second.status, "published");
  const secondState = await store.readState();
  const secondDay = await store.readDay(secondState.days[0]);
  assert.equal(secondDay.candles.length, 2);
  assert.equal(secondDay.candles[0].tradeCount, 2);
  assert.equal((await readdir(join(root, "states"))).length, 1);

  rpc.logs[1] = swapLog({ registry, asset, block: blocks[365], amount0: -6_400_000n, amount1: 20_000_000_000_000_000n, logIndex: 1 });
  const repaired = await repairIndex({ registry, group, store, rpc });
  assert.equal(repaired.status, "published");
  const repairedState = await store.readState();
  const repairedDay = await store.readDay(repairedState.days[0]);
  assert.equal(repairedDay.candles.length, 2);
  assert.deepEqual(repairedDay.candles[0].close, { numerator: "320", denominator: "1" });
  assert.equal((await verifyIndex({ group, store })).status, "verified");

  const retention = await retainIndex({ registry, group, store, now: new Date("2028-08-13T00:00:00.000Z") });
  assert.equal(retention.removedDayCount, 1);
  assert.equal((await store.readState()).days.length, 0);
  assert.equal((await verifyIndex({ group, store })).dayCount, 0);
});

test("a failed range never advances the durable cursor", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 720);
  const rpc = new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 720 });
  const store = {
    state: null,
    async readState() { return this.state; },
    async readDay() { throw new Error("Unexpected day read."); },
    async commit() { throw new Error("publication interrupted"); },
  };
  await assert.rejects(collectIndex({ registry, group, store, rpc }), /publication interrupted/);
  assert.equal(store.state, null);
});

test("backlogged collection searches only the fixed per-run block range", async () => {
  const registry = structuredClone(await fixtureRegistry());
  registry.collection.maximumBlocksPerRun = 100;
  const group = registry.groups[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 1000);
  const rpc = new FakeRpc({ registry, blocks, logs: [], finalizedNumber: 1000 });
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

  const result = await collectIndex({ registry, group, store, rpc });
  assert.equal(result.status, "published");
  assert.equal(result.fromBlock, "96");
  assert.equal(result.untilBlock, "192");
  assert.equal(rpc.blockSearches.length, 1);
  assert.equal(rpc.blockSearches[0].minimumBlock, 96n);
  assert.equal(rpc.blockSearches[0].maximumBlock, 196n);
  assert.equal(BigInt(rpc.blockSearches[0].maximumBlockHeader.number), 196n);
  assert.equal(rpc.logRequests.at(-1).to, 191n);
});
