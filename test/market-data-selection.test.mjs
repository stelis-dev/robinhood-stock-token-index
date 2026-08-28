import assert from "node:assert/strict";
import test from "node:test";

import { candleResolutionCatalog } from "../collector/candle-resolution.mjs";
import { loadMarketDataConfiguration } from "../collector/market-data-configuration.mjs";
import {
  baseDayLogicalId,
  baseMonthLogicalId,
  baseResolutionLogicalId,
  baseStateLogicalId,
} from "../collector/market-data-file-identity.mjs";
import {
  expandChangedReferenceClosure,
  validateMarketDataSelectionClosure,
  validateRecordedCoverageProvenance,
} from "../collector/market-data-selection.mjs";
import {
  createBaseResolutionFile,
  validateBaseMonthFile,
  validateBaseResolutionFile,
} from "../collector/market-data-files.mjs";
import { validateSelectedAssetEntry } from "../collector/market-data-assets.mjs";
import { verifyMarketDataMonths } from "../collector/market-data-verifier.mjs";
import { StoredDataIntegrityError } from "../storage/storage-error.mjs";

function reference(logicalId, assetSha256, offset) {
  return {
    assetSha256,
    from: offset,
    gzipSha256: `${offset % 10}`.repeat(64),
    jsonBytes: 1,
    jsonSha256: `${(offset + 1) % 10}`.repeat(64),
    logicalId,
    until: offset + 1,
  };
}

test("selection closure rejects membership removed from an unchanged owner", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  const stateId = baseStateLogicalId(base.baseCurrencyAddress);
  const monthId = baseMonthLogicalId(base.baseCurrencyAddress, "2026-08");
  const dayId = baseDayLogicalId(base.baseCurrencyAddress, "2026-08-27");
  const stateSha = "1".repeat(64);
  const monthSha = "2".repeat(64);
  const dataSha = "3".repeat(64);
  const stateReference = reference(stateId, stateSha, 0);
  const monthReference = reference(monthId, monthSha, 0);
  const dayReference = reference(dayId, dataSha, 0);
  const resolutionReferences = Object.fromEntries(candleResolutionCatalog.slice(1).map((entry, index) => [
    entry.label,
    reference(baseResolutionLogicalId(base.baseCurrencyAddress, entry.label, "2026-08"), dataSha, index + 1),
  ]));
  const values = new Map([
    [stateId, { months: [monthReference] }],
    [monthId, { days: [dayReference], resolutions: resolutionReferences }],
    [dayId, {}],
    ...Object.values(resolutionReferences).map((entry) => [entry.logicalId, {}]),
  ]);
  const dataLogicalIds = [dayId, ...Object.values(resolutionReferences).map((entry) => entry.logicalId)].sort();
  const root = {
    assets: [
      { assetName: `index-${stateSha}.bin`, bytes: 1, logicalIds: [stateId], releaseTag: "market-data-index-s1", sha256: stateSha },
      { assetName: `index-${monthSha}.bin`, bytes: 1, logicalIds: [monthId], releaseTag: "market-data-index-s1", sha256: monthSha },
      { assetName: `data-${dataSha}.bin`, bytes: 10, logicalIds: dataLogicalIds, releaseTag: "market-data-2026-08-s1", sha256: dataSha },
    ].sort((left, right) => left.sha256.localeCompare(right.sha256)),
    baseCurrencies: { [base.baseCurrencyAddress]: stateReference },
    currentUntil: { blockNumber: "50001000", timestamp: "2026-08-27T00:15:00.000Z" },
    poolManager: configuration.poolManager,
    publicationSequence: 1,
    resolutions: candleResolutionCatalog,
    usdgAddress: configuration.usdgAddress,
    usdgDecimals: configuration.usdgDecimals,
  };
  const missing = structuredClone(root);
  missing.assets.find((asset) => asset.sha256 === dataSha).logicalIds = dataLogicalIds.filter((logicalId) => logicalId !== dayId);
  await assert.rejects(validateMarketDataSelectionClosure({
    changedLogicalIds: [dayId],
    configuration,
    readLogicalFile: async (entry) => values.get(entry.logicalId),
    root: missing,
  }), (error) => error instanceof StoredDataIntegrityError);

  const nextStateReference = { ...stateReference, assetSha256: "5".repeat(64) };
  const expanded = await expandChangedReferenceClosure({
    changedLogicalIds: [stateId, monthId],
    nextRoot: { baseCurrencies: { [base.baseCurrencyAddress]: nextStateReference } },
    previousRoot: root,
    readNext: async (entry) => entry.logicalId === stateId ? { months: [] } : null,
    readPrevious: async (entry) => values.get(entry.logicalId),
  });
  assert.ok(expanded.includes(dayId));
  for (const entry of Object.values(resolutionReferences)) assert.ok(expanded.includes(entry.logicalId));
});

test("stored coverage must retain the base-state PoolId provenance", () => {
  const common = {
    fromBlock: "1",
    fromTimestamp: "2026-08-27T00:00:00.000Z",
    untilBlock: "2",
    untilTimestamp: "2026-08-27T00:15:00.000Z",
  };
  assert.throws(() => validateRecordedCoverageProvenance(
    [{ ...common, poolId: `0x${"1".repeat(64)}` }],
    [{ ...common, poolId: `0x${"2".repeat(64)}` }],
    common.fromTimestamp,
  ), (error) => error instanceof StoredDataIntegrityError);

  assert.deepEqual(validateRecordedCoverageProvenance(
    [{ ...common, poolId: `0x${"1".repeat(64)}` }],
    [{ ...common, poolId: `0x${"1".repeat(64)}` }],
    "2026-08-27T00:05:00.000Z",
  ), [{ ...common, poolId: `0x${"1".repeat(64)}` }]);

  assert.throws(() => validateRecordedCoverageProvenance([
    {
      fromBlock: "0",
      fromTimestamp: "2024-01-01T00:00:00.000Z",
      poolId: `0x${"1".repeat(64)}`,
      untilBlock: common.fromBlock,
      untilTimestamp: common.fromTimestamp,
    },
    { ...common, poolId: `0x${"1".repeat(64)}` },
  ], [{ ...common, poolId: `0x${"1".repeat(64)}` }], common.fromTimestamp), (error) => (
    error instanceof StoredDataIntegrityError
  ));
});

test("verification-month admission rejects stale resolution and source provenance", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  const address = base.baseCurrencyAddress;
  const monthId = baseMonthLogicalId(address, "2026-08");
  const dayId = baseDayLogicalId(address, "2026-08-27");
  const coverage = [{
    fromBlock: "1",
    fromTimestamp: "2026-08-27T00:00:00.000Z",
    poolId: base.poolId,
    untilBlock: "3",
    untilTimestamp: "2026-08-27T00:30:00.000Z",
  }];
  const dayReference = reference(dayId, "3".repeat(64), 1);
  const monthReference = reference(monthId, "2".repeat(64), 1);
  const resolutionReferences = Object.fromEntries(candleResolutionCatalog.slice(1).map((definition, index) => [
    definition.label,
    reference(baseResolutionLogicalId(address, definition.label, "2026-08"), "3".repeat(64), index + 2),
  ]));
  const values = new Map([
    [dayId, { baseCurrencyAddress: address, candles: [], coverage, day: "2026-08-27" }],
    [monthId, {
      baseCurrencyAddress: address,
      coverage,
      days: [dayReference],
      month: "2026-08",
      resolutions: resolutionReferences,
    }],
  ]);
  for (const definition of candleResolutionCatalog.slice(1)) {
    values.set(resolutionReferences[definition.label].logicalId, createBaseResolutionFile({
      baseCurrencyAddress: address,
      candles: [],
      coverage,
      intervalSeconds: definition.intervalSeconds,
      ownerMonth: "2026-08",
    }));
  }
  values.set(resolutionReferences["15m"].logicalId, createBaseResolutionFile({
    baseCurrencyAddress: address,
    candles: [],
    coverage: [{ ...coverage[0], untilBlock: "2", untilTimestamp: "2026-08-27T00:15:00.000Z" }],
    intervalSeconds: 900,
    ownerMonth: "2026-08",
  }));
  const baseState = { months: [monthReference], poolPeriods: coverage };
  await assert.rejects(verifyMarketDataMonths({
    baseStates: { [address]: baseState },
    months: [monthId],
    readLogicalFile: async (entry) => values.get(entry.logicalId),
  }), (error) => error instanceof StoredDataIntegrityError);

  values.set(resolutionReferences["15m"].logicalId, createBaseResolutionFile({
    baseCurrencyAddress: address,
    candles: [],
    coverage,
    intervalSeconds: 900,
    ownerMonth: "2026-08",
  }));
  await assert.rejects(verifyMarketDataMonths({
    baseStates: { [address]: {
      ...baseState,
      poolPeriods: [{ ...coverage[0], poolId: `0x${"f".repeat(64)}` }],
    } },
    months: [monthId],
    readLogicalFile: async (entry) => values.get(entry.logicalId),
  }), (error) => error instanceof StoredDataIntegrityError);
});

test("month and resolution coverage remain inside their owner period", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  const assetSha256 = "7".repeat(64);
  const coverage = [{
    fromBlock: "1",
    fromTimestamp: "2024-01-01T00:00:00.000Z",
    poolId: base.poolId,
    untilBlock: "2",
    untilTimestamp: "2024-01-01T00:15:00.000Z",
  }];
  const resolutions = Object.fromEntries(candleResolutionCatalog.slice(1).map((entry, index) => [
    entry.label,
    reference(baseResolutionLogicalId(base.baseCurrencyAddress, entry.label, "2026-08"), assetSha256, index + 1),
  ]));
  assert.throws(() => validateBaseMonthFile({
    baseCurrencyAddress: base.baseCurrencyAddress,
    coverage,
    days: [reference(baseDayLogicalId(base.baseCurrencyAddress, "2026-08-01"), assetSha256, 20)],
    month: "2026-08",
    resolutions,
  }), /escapes/);
  assert.throws(() => validateBaseResolutionFile({
    baseCurrencyAddress: base.baseCurrencyAddress,
    candles: [],
    coverage,
    intervalSeconds: 900,
    ownerMonth: "2026-08",
  }), /escapes/);
});

test("physical asset placement follows owner month and one index kind", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const address = configuration.bases[0].baseCurrencyAddress;
  const sha256 = "4".repeat(64);
  assert.throws(() => validateSelectedAssetEntry({
    assetName: `data-${sha256}.bin`,
    bytes: 1,
    logicalIds: [baseDayLogicalId(address, "2026-08-27")],
    releaseTag: "market-data-2026-09-s1",
    sha256,
  }), /owner month/);
  assert.throws(() => validateSelectedAssetEntry({
    assetName: `index-${sha256}.bin`,
    bytes: 1,
    logicalIds: [baseMonthLogicalId(address, "2026-08"), baseStateLogicalId(address)].sort(),
    releaseTag: "market-data-index-s1",
    sha256,
  }), /cannot mix/);
});
