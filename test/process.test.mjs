import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readPairMonth,
  readPairMonthResolution,
  readPairResolution,
  readPairStateSelection,
  verifyPairIndex,
} from "../collector/pair-reader.mjs";
import { pairById } from "../collector/pair-registry.mjs";
import { RpcResponseRejectedError } from "../collector/rpc-endpoint.mjs";
import { createFinalizedBoundary, runRpcPairOperation } from "../collector/rpc-operation.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { StoredDataIntegrityError } from "../storage/stored-files.mjs";
import { compactPairRegistry, FakePairRpc, pairSwapLog } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";
import { storagePort } from "./storage-port-fixture.mjs";

async function readPairState(input) {
  return (await readPairStateSelection(input))?.state ?? null;
}

async function runProcessPhase(operation, { rpc, ...input }) {
  return (await runRpcPairOperation({ operation, ...input, rpcClients: [rpc] })).result;
}

const runCurrentPhase = (input) => runProcessPhase("current", input);
const runHistoryPhase = (input) => runProcessPhase("history", input);
const runRepairPhase = (input) => runProcessPhase("repair", input);

async function directoryStore(registry, prefix) {
  return new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), prefix)),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
}

async function selectedResolutionArtifacts({ registry, pairId, store }) {
  const state = await readPairState({ registry, pairId, store });
  const output = new Map();
  for (const monthReference of state.months) {
    const month = await readPairMonth({ registry, store, reference: monthReference });
    for (const reference of month.resolutions) {
      output.set(`${month.month}:${reference.intervalSeconds}`, {
        reference,
        value: await readPairResolution({ registry, store, reference }),
      });
    }
  }
  return { state, output };
}

async function readOneMinuteRange({ registry, pairId, store, from, until }) {
  const candles = [];
  const cursor = new Date(from);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < Date.parse(until)) {
    const result = await readPairMonthResolution({
      registry,
      pairId,
      ownerMonth: cursor.toISOString().slice(0, 7),
      resolution: "1m",
      store,
    });
    if (result.status === "read") {
      candles.push(...result.files.flatMap(({ value }) => value.candles).filter((candle) => (
        candle.intervalStart >= from && candle.intervalEnd <= until
      )));
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return candles;
}

test("current, historical, and repair operations change only their assigned coverage boundaries", async () => {
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

  const current = await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc: currentRpc });
  assert.equal(current.status, "published");
  assert.equal(current.phase, "current");
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
  const firstHistory = await runHistoryPhase({ registry, pairId: pair.pairId, store, rpc: historyRpc });
  assert.equal(firstHistory.status, "published");
  assert.equal(firstHistory.phase, "history");
  assert.equal(firstHistory.sequence, 2);
  state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.fromTimestamp, "2026-08-14T13:01:00.000Z");
  assert.equal(state.coverage.untilTimestamp, "2026-08-14T15:01:00.000Z");

  const secondHistory = await runHistoryPhase({ registry, pairId: pair.pairId, store, rpc: historyRpc });
  assert.equal(secondHistory.status, "published");
  assert.equal(secondHistory.sequence, 3);
  state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.fromTimestamp, pair.historyStart.timestamp);
  assert.equal(state.coverage.untilTimestamp, "2026-08-14T15:01:00.000Z");
  assert.equal((await runHistoryPhase({ registry, pairId: pair.pairId, store, rpc: historyRpc })).status, "current");

  currentRpc.logs.push(historyRpc.logs[0]);
  const laterCurrent = await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc: currentRpc });
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
  const repaired = await runRepairPhase({ registry, pairId: pair.pairId, store, rpc: currentRpc });
  assert.equal(repaired.status, "published");
  assert.equal(repaired.phase, "repair");
  assert.equal(repaired.sequence, 5);
  const afterRepair = await readPairState({ registry, pairId: pair.pairId, store });
  assert.deepEqual(afterRepair.coverage, beforeRepair.coverage);

  const candles = await readOneMinuteRange({
    registry,
    pairId: pair.pairId,
    store,
    from: "2026-08-14T13:01:00.000Z",
    until: "2026-08-14T15:01:00.000Z",
  });
  assert.equal(candles.length, 2);
  assert.deepEqual(candles.find((candle) => candle.intervalStart === "2026-08-14T14:11:00.000Z").close, {
    numerator: "320",
    denominator: "1",
  });
  assert.equal((await verifyPairIndex({ registry, pairId: pair.pairId, store })).status, "verified");
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "state"))).length, 1);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "months", "2026-08"))).length, 6);
});

test("repair replaces every and only derived natural interval overlapping changed one-minute data", async () => {
  const registry = await compactPairRegistry({
    activationTimestamp: "2026-08-31T00:00:00.000Z",
    maximumBlocksPerRun: 2_000,
  });
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({
    registry,
    pair,
    finalizedNumber: activation + 4_320n,
    secondsPerBlock: 60,
  });
  const earlyBlock = activation + 3_491n;
  const changedBlock = activation + 4_091n;
  rpc.logs.push(
    pairSwapLog({
      registry,
      pair,
      block: rpc.block(earlyBlock),
      baseAmountRaw: 10_000_000_000_000_000n,
      quoteAmountRaw: 3_000_000n,
    }),
    pairSwapLog({
      registry,
      pair,
      block: rpc.block(changedBlock),
      baseAmountRaw: 10_000_000_000_000_000n,
      quoteAmountRaw: 3_100_000n,
    }),
  );
  const store = await directoryStore(registry, "pair-resolution-repair-");
  for (let day = 0; day < 3; day += 1) {
    const result = await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc });
    assert.equal(result.status, "published");
  }
  const before = await selectedResolutionArtifacts({ registry, pairId: pair.pairId, store });
  assert.equal(before.state.coverage.untilTimestamp, "2026-09-03T00:00:00.000Z");

  rpc.logs[1] = pairSwapLog({
    registry,
    pair,
    block: rpc.block(changedBlock),
    baseAmountRaw: 10_000_000_000_000_000n,
    quoteAmountRaw: 3_200_000n,
  });
  const repaired = await runRepairPhase({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(repaired.sequence, 4);
  const after = await selectedResolutionArtifacts({ registry, pairId: pair.pairId, store });
  assert.deepEqual(after.state.coverage, before.state.coverage);

  const changedInstant = rpc.block(changedBlock).timestampSeconds * 1_000;
  for (const [key, beforeEntry] of before.output) {
    const afterEntry = after.output.get(key);
    assert.ok(afterEntry);
    const intervalMilliseconds = beforeEntry.value.intervalSeconds * 1_000;
    const changedIntervalStart = new Date(Math.floor(changedInstant / intervalMilliseconds) * intervalMilliseconds).toISOString();
    const beforeChanged = beforeEntry.value.candles.find((candle) => candle.intervalStart === changedIntervalStart);
    const afterChanged = afterEntry.value.candles.find((candle) => candle.intervalStart === changedIntervalStart);
    const intervalWasComplete = beforeChanged !== undefined;
    if (intervalWasComplete) {
      assert.equal(afterEntry.reference.sequence, 4);
      assert.notDeepEqual(afterChanged, beforeChanged);
    } else {
      assert.deepEqual(afterEntry, beforeEntry);
    }
    assert.deepEqual(
      afterEntry.value.candles.filter((candle) => candle.intervalStart !== changedIntervalStart),
      beforeEntry.value.candles.filter((candle) => candle.intervalStart !== changedIntervalStart),
    );
  }
});

test("selected publication cleanup remains blocking and the next operation recovers it", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const store = await directoryStore(registry, "pair-cleanup-retry-");
  await runCurrentPhase({
    registry,
    pairId: pair.pairId,
    store,
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n }),
  });

  let stateSelected = false;
  let failSelectedCleanup = true;
  const removedReferences = [];
  const failingCleanupStore = storagePort(store, {
    writeState: async (...args) => {
      const bytes = await store.writeState(...args);
      stateSelected = true;
      return bytes;
    },
    removeReferenced: async (reference, ...rest) => {
      removedReferences.push(reference);
      if (stateSelected && failSelectedCleanup) throw new Error("cleanup failed after state selection");
      return store.removeReferenced(reference, ...rest);
    },
  });
  const caughtUpRpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n });
  await assert.rejects(
    runCurrentPhase({ registry, pairId: pair.pairId, store: failingCleanupStore, rpc: caughtUpRpc }),
    /cleanup failed after state selection/,
  );
  assert.equal((await readPairState({ registry, pairId: pair.pairId, store })).sequence, 2);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "state"))).length, 3);
  assert.equal((await store.readPublication(pair.pairId)).status, "uploaded");
  assert.equal(removedReferences.length, 1);

  failSelectedCleanup = false;
  const retried = await runCurrentPhase({ registry, pairId: pair.pairId, store: failingCleanupStore, rpc: caughtUpRpc });
  assert.equal(retried.status, "current");
  assert.equal((await store.readPublication(pair.pairId)).status, "absent");
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "state"))).length, 1);
  assert.equal((await readdir(join(store.root, "pairs", pair.pairId, "months", "2026-08"))).length, 5);
});

test("a first historical publication can start at history and end exactly at activation", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 1n });
  const store = await directoryStore(registry, "pair-history-first-");

  const first = await runHistoryPhase({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(first.status, "published");
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.untilBlock, pair.activation.blockNumber);
  assert.equal(state.coverage.untilTimestamp, pair.activation.timestamp);
  assert.equal(state.coverage.fromTimestamp, "2026-08-14T13:01:00.000Z");
});

test("native ETH and stock-token pairs use the same base-to-USDG candle calculation", async () => {
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
  await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc });
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  const candles = await readOneMinuteRange({
    registry,
    pairId: pair.pairId,
    store,
    from: pair.activation.timestamp,
    until: state.coverage.untilTimestamp,
  });
  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0].close, { numerator: "3000", denominator: "1" });
  assert.equal(state.pair.baseAsset.kind, "native");
  assert.equal(state.pair.quoteAsset.address, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
});

test("a Swap with a zero amount does not block history or contribute a candle price or volume", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "ETH").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 1n });
  rpc.logs.push(
    pairSwapLog({
      registry,
      pair,
      block: rpc.block(activation - 65n),
      baseAmountRaw: 1_000_000_000_000_000_000n,
      quoteAmountRaw: 3_000_000_000n,
      transactionIndex: 0,
    }),
    pairSwapLog({
      registry,
      pair,
      block: rpc.block(activation - 64n),
      amount0: 0n,
      amount1: -1n,
      transactionIndex: 1,
    }),
    pairSwapLog({
      registry,
      pair,
      block: rpc.block(activation - 63n),
      baseAmountRaw: 1_000_000_000_000_000_000n,
      quoteAmountRaw: 3_200_000_000n,
      transactionIndex: 2,
    }),
  );
  const store = await directoryStore(registry, "pair-zero-amount-swap-");

  const collected = await runHistoryPhase({ registry, pairId: pair.pairId, store, rpc });
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  const candles = await readOneMinuteRange({
    registry,
    pairId: pair.pairId,
    store,
    from: state.coverage.fromTimestamp,
    until: state.coverage.untilTimestamp,
  });

  assert.equal(collected.status, "published");
  assert.equal(collected.phase, "history");
  assert.equal(state.coverage.fromTimestamp, "2026-08-14T13:01:00.000Z");
  assert.equal(state.coverage.untilTimestamp, pair.activation.timestamp);
  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0].open, { numerator: "3000", denominator: "1" });
  assert.deepEqual(candles[0].close, { numerator: "3200", denominator: "1" });
  assert.equal(candles[0].baseVolumeRaw, "2000000000000000000");
  assert.equal(candles[0].quoteVolumeRaw, "6200000000");
  assert.equal(candles[0].tradeCount, 2);
  assert.equal(candles[0].firstSource.transactionIndex, 0);
  assert.equal(candles[0].lastSource.transactionIndex, 2);
});

test("duplicate zero-amount Swap positions are rejected before candle eligibility is considered", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "ETH").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 1n });
  const duplicate = pairSwapLog({
    registry,
    pair,
    block: rpc.block(activation - 64n),
    amount0: 0n,
    amount1: -1n,
  });
  rpc.logs.push(duplicate, structuredClone(duplicate));
  const store = await directoryStore(registry, "pair-duplicate-zero-amount-swap-");

  await assert.rejects(
    runHistoryPhase({ registry, pairId: pair.pairId, store, rpc }),
    (error) => error instanceof RpcResponseRejectedError
      && error.reason === "response_result_invalid"
      && error.rpcMethod === "eth_getLogs",
  );
  assert.equal(await readPairState({ registry, pairId: pair.pairId, store }), null);
});

test("adjacent current phases preserve continuity across a UTC month and year boundary", async () => {
  const registry = await compactPairRegistry({ activationTimestamp: "2026-12-31T23:30:00.000Z" });
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  const store = await directoryStore(registry, "pair-calendar-boundary-");
  const first = await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(first.untilTimestamp, "2027-01-01T00:00:00.000Z");
  let state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.deepEqual(state.months.map((reference) => reference.logicalId.slice(-7)), ["2026-12"]);
  const second = await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(second.fromBlock, first.untilBlock);
  assert.equal(second.fromTimestamp, first.untilTimestamp);
  state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.deepEqual(state.months.map((reference) => reference.logicalId.slice(-7)), ["2026-12", "2027-01"]);
  const december = await readPairMonthResolution({
    registry, pairId: pair.pairId, ownerMonth: "2026-12", resolution: "1m", store,
  });
  const january = await readPairMonthResolution({
    registry, pairId: pair.pairId, ownerMonth: "2027-01", resolution: "1m", store,
  });
  assert.equal(december.status, "read");
  assert.equal(january.status, "read");
});

test("block limits move to the complete minute boundary instead of publishing partial candles", async () => {
  const registry = await compactPairRegistry({ maximumBlocksPerRun: 100 });
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 500n });
  const store = await directoryStore(registry, "pair-minute-cut-");
  const current = await runCurrentPhase({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(BigInt(current.untilBlock) - activation, 96n);
  assert.equal(current.untilTimestamp, "2026-08-14T14:17:00.000Z");
  const history = await runHistoryPhase({ registry, pairId: pair.pairId, store, rpc });
  assert.equal(activation - BigInt(history.fromBlock), 102n);
  assert.equal(history.fromTimestamp, "2026-08-14T13:44:00.000Z");
});

test("multi-day block gaps advance one UTC day per phase and resume at the exact boundary", async () => {
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
  const finalizedBoundary = createFinalizedBoundary();
  const results = [];
  let reachedFinalizedBoundary = false;
  while (!reachedFinalizedBoundary) {
    const completed = await runRpcPairOperation({
      operation: "current",
      registry,
      pairId: pair.pairId,
      store,
      rpcClients: [rpc],
      finalizedBoundary,
    });
    results.push(completed.result);
    reachedFinalizedBoundary = completed.reachedFinalizedBoundary;
  }
  assert.equal(results.length, 7);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    assert.equal(result.status, "published");
    const fromSeconds = Math.floor(Date.parse(result.fromTimestamp) / 1000);
    const adjacentDay = Math.floor(fromSeconds / 86_400) * 86_400 + 86_400;
    assert.ok(Date.parse(result.untilTimestamp) / 1000 <= adjacentDay);
    if (index > 0) {
      assert.equal(result.fromBlock, results[index - 1].untilBlock);
      assert.equal(result.fromTimestamp, results[index - 1].untilTimestamp);
    }
  }
  const verified = await verifyPairIndex({ registry, pairId: pair.pairId, store });
  assert.equal(verified.dayCount, 7);
  assert.equal(verified.sourceCandleCount, 0);
  assert.ok(rpc.blockSearches.every((search) => search.minimumBlock <= search.maximumBlock));
});

test("historical collection crosses sparse block gaps one UTC day at a time", async () => {
  const registry = await compactPairRegistry({
    historyBlockOffset: 2n,
    historySecondsOffset: 6 * 86_400,
  });
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({
    registry,
    pair,
    finalizedNumber: activation + 1n,
    secondsPerBlock: 3 * 86_400,
  });
  const store = await directoryStore(registry, "pair-sparse-history-");
  const finalizedBoundary = createFinalizedBoundary();
  const results = [];
  let result;
  do {
    result = (await runRpcPairOperation({
      operation: "history",
      registry,
      pairId: pair.pairId,
      store,
      rpcClients: [rpc],
      finalizedBoundary,
    })).result;
    results.push(result);
  } while (result.status === "published");
  assert.equal(results.at(-1).status, "current");
  const published = results.slice(0, -1);
  assert.equal(published.length, 7);
  for (let index = 0; index < published.length; index += 1) {
    const phase = published[index];
    const untilSeconds = Math.floor(Date.parse(phase.untilTimestamp) / 1000);
    const previousDay = Math.floor((untilSeconds - 1) / 86_400) * 86_400;
    assert.ok(Date.parse(phase.fromTimestamp) / 1000 >= previousDay);
    if (index > 0) {
      assert.equal(phase.untilBlock, published[index - 1].fromBlock);
      assert.equal(phase.untilTimestamp, published[index - 1].fromTimestamp);
    }
  }
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.coverage.fromBlock, pair.historyStart.blockNumber);
  assert.equal(state.coverage.fromTimestamp, pair.historyStart.timestamp);
  assert.ok(rpc.blockSearches.every((search) => search.minimumBlock <= search.maximumBlock));
});

test("pair identity is validated before any market operation", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  let rpcUsed = false;
  const rpc = { async verifyChain() { rpcUsed = true; } };
  const store = await directoryStore(registry, "pair-unknown-");
  await assert.rejects(
    runCurrentPhase({ registry, pairId: `0x${"0".repeat(64)}`, store, rpc }),
    /Unknown pair/,
  );
  assert.equal(rpcUsed, false);
  assert.equal(pairById(registry, pair.pairId).pair.pairId, pair.pairId);
});

test("a changed child must be validated from storage before state selection", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const rpc = new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n });
  const directory = await directoryStore(registry, "pair-transition-integrity-");
  let corruptNextChildRead = true;
  let stateWriteReached = false;
  const store = storagePort(directory, {
    writeReferenced: async (...args) => {
      const bytes = await directory.writeReferenced(...args);
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
  });

  await assert.rejects(
    runCurrentPhase({ registry, pairId: pair.pairId, store, rpc }),
    (error) => error instanceof StoredDataIntegrityError,
  );
  assert.equal(stateWriteReached, false);
  assert.equal(await directory.readSelectedState(pair.pairId), null);
});
