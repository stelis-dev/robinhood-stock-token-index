import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeMarketDataConfiguration,
  loadMarketDataConfiguration,
} from "../collector/market-data-configuration.mjs";
import { derivePoolId } from "../collector/pool-key.mjs";
import { planSharedCollectionPhase } from "../collector/shared-collection-plan.mjs";

const minuteFloor = (value) => new Date(Math.floor(Date.parse(value) / 60_000) * 60_000).toISOString();

function encoded(value) {
  const sort = (candidate) => candidate !== null && typeof candidate === "object"
    ? Array.isArray(candidate)
      ? candidate.map(sort)
      : Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, sort(candidate[key])]))
    : candidate;
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`, "utf8");
}

function baseState(base, currentUntil, { historyFrom } = {}) {
  const sourceFrom = {
    blockNumber: (BigInt(base.initialize.blockNumber) - 1n).toString(),
    timestamp: minuteFloor(base.initialize.timestamp),
  };
  const admittedHistoryFrom = historyFrom ?? sourceFrom;
  return {
    decimals: base.decimals,
    pools: {
      [base.poolId]: {
        historyFrom: admittedHistoryFrom,
        initialize: base.initialize,
        poolKey: base.poolKey,
        sourceFrom,
      },
    },
    poolPeriods: [{
      fromBlock: admittedHistoryFrom.blockNumber,
      fromTimestamp: admittedHistoryFrom.timestamp,
      poolId: base.poolId,
      untilBlock: currentUntil.blockNumber,
      untilTimestamp: currentUntil.timestamp,
    }],
  };
}

function selectedState(configuration, selectedBases, currentUntil, historyByAddress = {}) {
  return {
    currentUntil,
    poolManager: configuration.poolManager,
    usdgAddress: configuration.usdgAddress,
    usdgDecimals: configuration.usdgDecimals,
    baseCurrencies: Object.fromEntries(selectedBases.map((base) => [
      base.baseCurrencyAddress,
      baseState(base, currentUntil, { historyFrom: historyByAddress[base.baseCurrencyAddress] }),
    ])),
  };
}

test("current collection joins every new-base suffix to the overlapping shared query", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const selectedBases = configuration.bases.slice(0, 2);
  const currentUntil = { blockNumber: "50000000", timestamp: "2026-08-27T00:00:00.000Z" };
  const target = { blockNumber: "50000100", timestamp: "2026-08-27T00:15:00.000Z" };
  const plan = planSharedCollectionPhase({
    configuration,
    state: selectedState(configuration, selectedBases, currentUntil),
    target,
  });
  assert.equal(plan.phase, "current");
  assert.equal(plan.work.filter((entry) => entry.kind === "current").length, 2);
  assert.equal(plan.work.filter((entry) => entry.kind === "initial").length, 7);
  assert.deepEqual(plan.ranges, [{
    fromTimestamp: currentUntil.timestamp,
    untilTimestamp: target.timestamp,
    poolIds: configuration.poolIds,
  }]);
});

test("current backlog advances without creating a different boundary for uninitialized bases", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const selectedBases = configuration.bases.slice(0, 2);
  const currentUntil = { blockNumber: "50000000", timestamp: "2026-08-26T23:00:00.000Z" };
  const target = { blockNumber: "50001000", timestamp: "2026-08-27T00:15:00.000Z" };
  const plan = planSharedCollectionPhase({
    configuration,
    state: selectedState(configuration, selectedBases, currentUntil),
    target,
  });
  assert.equal(plan.phase, "current");
  assert.equal(plan.work.length, 2);
  assert.ok(plan.work.every((entry) => entry.kind === "current"));
  assert.ok(plan.work.every((entry) => entry.untilTimestamp === "2026-08-26T23:15:00.000Z"));
});

test("overlapping history slices emit their common range once with the PoolId union", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const currentUntil = { blockNumber: "50000000", timestamp: "2026-08-27T00:15:00.000Z" };
  const [first, second] = configuration.bases;
  const histories = {
    [first.baseCurrencyAddress]: { blockNumber: "49990000", timestamp: "2026-08-26T12:00:00.000Z" },
    [second.baseCurrencyAddress]: { blockNumber: "49989000", timestamp: "2026-08-26T11:55:00.000Z" },
  };
  const plan = planSharedCollectionPhase({
    configuration,
    state: selectedState(configuration, configuration.bases, currentUntil, histories),
    target: currentUntil,
  });
  assert.equal(plan.phase, "history");
  assert.equal(plan.work.length, 2);
  assert.deepEqual(plan.ranges, [
    {
      fromTimestamp: "2026-08-26T11:40:00.000Z",
      untilTimestamp: "2026-08-26T11:45:00.000Z",
      poolIds: [second.poolId],
    },
    {
      fromTimestamp: "2026-08-26T11:45:00.000Z",
      untilTimestamp: "2026-08-26T11:55:00.000Z",
      poolIds: [first.poolId, second.poolId].sort(),
    },
    {
      fromTimestamp: "2026-08-26T11:55:00.000Z",
      untilTimestamp: "2026-08-26T12:00:00.000Z",
      poolIds: [first.poolId],
    },
  ]);
});

test("repair plans only its selected PoolId range", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const currentUntil = { blockNumber: "50000000", timestamp: "2026-08-27T00:15:00.000Z" };
  const state = selectedState(configuration, configuration.bases, currentUntil);
  const base = configuration.bases[0];
  const repair = {
    baseCurrencyAddress: base.baseCurrencyAddress,
    fromBlock: base.initialize.blockNumber,
    fromTimestamp: minuteFloor(base.initialize.timestamp),
    poolId: base.poolId,
    untilBlock: (BigInt(base.initialize.blockNumber) + 1n).toString(),
    untilTimestamp: new Date(Date.parse(minuteFloor(base.initialize.timestamp)) + 60_000).toISOString(),
  };
  const plan = planSharedCollectionPhase({ configuration, state, target: currentUntil, repair });
  assert.equal(plan.phase, "repair");
  assert.deepEqual(plan.ranges, [{
    fromTimestamp: repair.fromTimestamp,
    untilTimestamp: repair.untilTimestamp,
    poolIds: [base.poolId],
  }]);
});

test("a configured PoolId change cannot begin after the selected current boundary", async () => {
  const admitted = await loadMarketDataConfiguration();
  const originalConfiguration = admitted.configuration;
  const currentUntil = { blockNumber: "50000000", timestamp: "2026-08-27T00:00:00.000Z" };
  const state = selectedState(originalConfiguration, originalConfiguration.bases, currentUntil);
  const changedValue = structuredClone(admitted.value);
  const address = originalConfiguration.bases[0].baseCurrencyAddress;
  const record = changedValue.baseCurrencies[address];
  record.poolKey.fee += 1;
  record.poolId = derivePoolId(record.poolKey);
  record.initialize = { blockNumber: "50000001", timestamp: "2026-08-27T00:00:30.000Z" };
  const changed = decodeMarketDataConfiguration(encoded(changedValue)).configuration;
  assert.throws(() => planSharedCollectionPhase({
    configuration: changed,
    state,
    target: { blockNumber: "50000100", timestamp: "2026-08-27T00:15:00.000Z" },
  }), /begins after the current boundary/);
});
