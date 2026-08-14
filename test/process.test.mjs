import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectPairCurrent,
  collectPairHistory,
  repairPairIndex,
} from "../collector/process.mjs";
import { readPairPeriod, readPairState, verifyPairIndex } from "../collector/pair-reader.mjs";
import { pairById } from "../collector/pair-registry.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { compactPairRegistry, FakePairRpc, pairSwapLog } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";

async function directoryStore(registry, prefix) {
  return new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), prefix)),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
}

test("current, backward history, and repair move only their owned coverage edges", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const currentRpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n });
  currentRpc.logs.push(
    pairSwapLog({
      registry,
      pair,
      block: currentRpc.block(activation + 60n),
      baseAmountRaw: 10_000_000_000_000_000n,
      quoteAmountRaw: 3_000_000n,
    }),
    pairSwapLog({
      registry,
      pair,
      block: currentRpc.block(activation + 61n),
      baseAmountRaw: 10_000_000_000_000_000n,
      quoteAmountRaw: 3_100_000n,
    }),
  );
  const store = await directoryStore(registry, "pair-lifecycle-");

  const current = await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc: currentRpc });
  assert.equal(current.status, "published");
  assert.equal(current.sequence, 1);
  assert.equal(current.candleCount, 1);
  let state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.fromTimestamp, pair.activation.timestamp);
  assert.equal(state.coverage.untilTimestamp, "2026-08-14T15:01:00.000Z");

  const historyRpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n });
  historyRpc.logs.push(pairSwapLog({
    registry,
    pair,
    block: historyRpc.block(activation - 300n),
    baseAmountRaw: 10_000_000_000_000_000n,
    quoteAmountRaw: 2_900_000n,
  }));
  const firstHistory = await collectPairHistory({ registry, pairId: pair.pairId, store, rpc: historyRpc });
  assert.equal(firstHistory.status, "published");
  assert.equal(firstHistory.sequence, 2);
  state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.fromTimestamp, "2026-08-14T13:01:00.000Z");
  assert.equal(state.coverage.untilTimestamp, "2026-08-14T15:01:00.000Z");

  const secondHistory = await collectPairHistory({ registry, pairId: pair.pairId, store, rpc: historyRpc });
  assert.equal(secondHistory.status, "published");
  assert.equal(secondHistory.sequence, 3);
  state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.fromTimestamp, pair.historyStart.timestamp);
  assert.equal(state.coverage.untilTimestamp, "2026-08-14T15:01:00.000Z");
  assert.equal((await collectPairHistory({ registry, pairId: pair.pairId, store, rpc: historyRpc })).status, "current");

  currentRpc.logs.push(historyRpc.logs[0]);
  const laterCurrent = await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc: currentRpc });
  assert.equal(laterCurrent.status, "published");
  assert.equal(laterCurrent.sequence, 4);
  const beforeRepair = await readPairState({ registry, pairId: pair.pairId, store });
  currentRpc.logs[1] = pairSwapLog({
    registry,
    pair,
    block: currentRpc.block(activation + 61n),
    baseAmountRaw: 10_000_000_000_000_000n,
    quoteAmountRaw: 3_200_000n,
  });
  const repaired = await repairPairIndex({ registry, pairId: pair.pairId, store, rpc: currentRpc });
  assert.equal(repaired.status, "published");
  assert.equal(repaired.sequence, 5);
  const afterRepair = await readPairState({ registry, pairId: pair.pairId, store });
  assert.deepEqual(afterRepair.coverage, beforeRepair.coverage);

  const period = await readPairPeriod({
    registry,
    store,
    input: {
      pairId: pair.pairId,
      from: "2026-08-14T13:01:00.000Z",
      until: "2026-08-14T15:01:00.000Z",
    },
  });
  assert.equal(period.candles.length, 2);
  assert.deepEqual(period.candles.find((candle) => candle.intervalStart === "2026-08-14T14:11:00.000Z").close, {
    numerator: "320",
    denominator: "1",
  });
  assert.equal((await verifyPairIndex({ registry, pairId: pair.pairId, store })).status, "verified");
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "state"))).length, 1);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "months", "2026-08"))).length, 2);
});

test("a selected transition retries its bounded cleanup on the next current operation", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const store = await directoryStore(registry, "pair-cleanup-retry-");
  await collectPairCurrent({
    registry,
    pairId: pair.pairId,
    store,
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n }),
  });

  let stateSelected = false;
  let failSelectedCleanup = true;
  const cleanupSequences = [];
  const failingCleanupStore = {
    readSelectedState: (...args) => store.readSelectedState(...args),
    resolvePairMonth: (...args) => store.resolvePairMonth(...args),
    readReferenced: (...args) => store.readReferenced(...args),
    writeReferenced: (...args) => store.writeReferenced(...args),
    writeState: async (...args) => {
      await store.writeState(...args);
      stateSelected = true;
    },
    cleanupSelectedGeneration: (...args) => {
      cleanupSequences.push(args[0].selectedSequence);
      if (stateSelected && failSelectedCleanup) throw new Error("cleanup failed after state selection");
      return store.cleanupSelectedGeneration(...args);
    },
  };
  const caughtUpRpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n });
  await assert.rejects(
    collectPairCurrent({ registry, pairId: pair.pairId, store: failingCleanupStore, rpc: caughtUpRpc }),
    /cleanup failed after state selection/,
  );
  assert.equal((await readPairState({ registry, pairId: pair.pairId, store })).sequence, 2);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "state"))).length, 2);
  assert.deepEqual(cleanupSequences, [1, 2]);

  failSelectedCleanup = false;
  const retried = await collectPairCurrent({ registry, pairId: pair.pairId, store: failingCleanupStore, rpc: caughtUpRpc });
  assert.equal(retried.status, "current");
  assert.deepEqual(cleanupSequences, [1, 2, 2]);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "state"))).length, 1);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "months", "2026-08"))).length, 2);
});

test("a first historical publication can start at history and end exactly at activation", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 1n });
  const store = await directoryStore(registry, "pair-history-first-");

  const first = await collectPairHistory({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(first.status, "published");
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.untilBlock, pair.activation.blockNumber);
  assert.equal(state.coverage.untilTimestamp, pair.activation.timestamp);
  assert.equal(state.coverage.fromTimestamp, "2026-08-14T13:01:00.000Z");
});

test("native ETH and stock-token pairs use the same exact base-to-USDG candle path", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "ETH").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  rpc.logs.push(pairSwapLog({
    registry,
    pair,
    block: rpc.block(activation + 60n),
    baseAmountRaw: 1_000_000_000_000_000_000n,
    quoteAmountRaw: 3_000_000_000n,
  }));
  const store = await directoryStore(registry, "pair-native-eth-");
  await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc });
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  const period = await readPairPeriod({
    registry,
    store,
    input: {
      pairId: pair.pairId,
      from: pair.activation.timestamp,
      until: state.coverage.untilTimestamp,
    },
  });
  assert.equal(period.candles.length, 1);
  assert.deepEqual(period.candles[0].close, { numerator: "3000", denominator: "1" });
  assert.equal(state.pair.baseAsset.kind, "native");
  assert.equal(state.pair.quoteAsset.address, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
});

test("one replacement closure remains continuous across UTC month and year boundaries", async () => {
  const registry = await compactPairRegistry({ activationTimestamp: "2026-12-31T23:30:00.000Z" });
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  const store = await directoryStore(registry, "pair-calendar-boundary-");
  await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc });
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.deepEqual(state.months.map((reference) => reference.logicalId.slice(-7)), ["2026-12", "2027-01"]);
  const december = await readPairPeriod({
    registry,
    store,
    input: {
      pairId: pair.pairId,
      from: "2026-12-31T23:30:00.000Z",
      until: "2027-01-01T00:00:00.000Z",
    },
  });
  const january = await readPairPeriod({
    registry,
    store,
    input: {
      pairId: pair.pairId,
      from: "2027-01-01T00:00:00.000Z",
      until: "2027-01-01T00:30:00.000Z",
    },
  });
  assert.deepEqual(december.available, [{ from: december.requested.from, until: december.requested.until }]);
  assert.deepEqual(january.available, [{ from: january.requested.from, until: january.requested.until }]);
});

test("block limits move to the complete minute boundary instead of publishing partial candles", async () => {
  const registry = await compactPairRegistry({ maximumBlocksPerRun: 100 });
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 500n });
  const store = await directoryStore(registry, "pair-minute-cut-");
  const current = await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(BigInt(current.untilBlock) - activation, 96n);
  assert.equal(current.untilTimestamp, "2026-08-14T14:17:00.000Z");
  const history = await collectPairHistory({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(activation - BigInt(history.fromBlock), 102n);
  assert.equal(history.fromTimestamp, "2026-08-14T13:44:00.000Z");
});

test("multi-day block gaps remain continuous empty coverage without impossible block searches", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({
    registry,
    pair,
    finalizedNumber: activation + 2n,
    secondsPerBlock: 3 * 86_400,
  });
  const store = await directoryStore(registry, "pair-sparse-days-");
  const result = await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(result.status, "published");
  const verified = await verifyPairIndex({ registry, pairId: pair.pairId, store });
  assert.ok(verified.dayCount >= 6);
  assert.equal(verified.candleCount, 0);
  assert.ok(rpc.blockSearches.every((search) => search.minimumBlock <= search.maximumBlock));
});

test("pair identity is admitted before any market operation", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  let rpcUsed = false;
  const rpc = { async verifyChain() { rpcUsed = true; } };
  const store = await directoryStore(registry, "pair-unknown-");
  await assert.rejects(
    collectPairCurrent({ registry, pairId: `0x${"0".repeat(64)}`, store, rpc }),
    /Unknown pair/,
  );
  assert.equal(rpcUsed, false);
  assert.equal(pairById(registry, pair.pairId).pair.pairId, pair.pairId);
});

test("a changed child must be admitted from storage before state selection", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  const directory = await directoryStore(registry, "pair-transition-integrity-");
  let corruptNextChildRead = true;
  let stateWriteReached = false;
  const store = {
    readSelectedState: (...args) => directory.readSelectedState(...args),
    resolvePairMonth: (...args) => directory.resolvePairMonth(...args),
    writeReferenced: (...args) => directory.writeReferenced(...args),
    readReferenced: async (...args) => {
      const bytes = await directory.readReferenced(...args);
      if (!corruptNextChildRead) return bytes;
      corruptNextChildRead = false;
      const changed = Buffer.from(bytes);
      changed[changed.byteLength - 1] ^= 1;
      return changed;
    },
    async writeState() {
      stateWriteReached = true;
      throw new Error("State publication must not be reached.");
    },
  };

  await assert.rejects(
    collectPairCurrent({ registry, pairId: pair.pairId, store, rpc }),
    /Stored bytes do not match their reference/,
  );
  assert.equal(stateWriteReached, false);
  assert.equal(await directory.readSelectedState(pair.pairId), null);
});
