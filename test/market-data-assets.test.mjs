import assert from "node:assert/strict";
import test from "node:test";

import { encodeArtifact } from "../collector/canonical.mjs";
import {
  applyAssetMembershipTransition,
  maximumMarketDataAssetBytes,
  packLogicalMembers,
  validateSelectedAssetEntry,
} from "../collector/market-data-assets.mjs";
import {
  baseDayLogicalId,
  baseMonthLogicalId,
  baseResolutionLogicalId,
  baseStateLogicalId,
} from "../collector/market-data-file-identity.mjs";
import { loadMarketDataConfiguration } from "../collector/market-data-configuration.mjs";
import {
  createBaseResolutionFile,
  encodeMarketDataLogicalFile,
  validateSelectedRoot,
} from "../collector/market-data-files.mjs";
import { candleResolutionCatalog } from "../collector/candle-resolution.mjs";
import { marketDataCandle } from "./market-data-fixtures.mjs";
import {
  validateLogicalTransition,
  validateMembershipTransitionAgainstLogical,
} from "../collector/market-data-recording.mjs";

function member(logicalId, value) {
  const encoded = encodeArtifact(value);
  return {
    gzipBytes: encoded.gzipBytes,
    gzipSha256: encoded.gzipSha256,
    jsonBytes: encoded.jsonBytes,
    jsonSha256: encoded.jsonSha256,
    logicalId,
  };
}

test("deterministic packing and monotonic asset membership preserve exact closure", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const address = configuration.bases[0].baseCurrencyAddress;
  const dayId = baseDayLogicalId(address, "2026-08-14");
  const resolutionId = baseResolutionLogicalId(address, "15m", "2026-08");
  const initialMembers = [member(dayId, { value: "day-a" }), member(resolutionId, { value: "resolution-a" })];
  const packed = packLogicalMembers({
    assetNamePrefix: "data",
    maximumAssetBytes: 1_000_000,
    members: initialMembers,
    releaseTag: "market-data-2026-08-s1",
  });
  assert.deepEqual(
    packLogicalMembers({
      assetNamePrefix: "data",
      maximumAssetBytes: 1_000_000,
      members: [...initialMembers].reverse(),
      releaseTag: "market-data-2026-08-s1",
    }),
    packed,
  );
  const initial = applyAssetMembershipTransition({
    packedAssets: packed,
    previousAssets: [],
    transition: {
      removals: [],
      replacements: [
        { logicalId: dayId, previousAssetSha256: null },
        { logicalId: resolutionId, previousAssetSha256: null },
      ],
    },
  });
  assert.equal(initial.nextAssets.length, 1);
  const logicalTransition = {
    changedMonths: [baseMonthLogicalId(address, "2026-08")],
    collectionDays: [dayId],
    removals: [],
    replacements: initialMembers,
    verificationMonths: [baseMonthLogicalId(address, "2026-08")],
  };
  assert.deepEqual(validateLogicalTransition(logicalTransition).removals, []);
  assert.deepEqual(validateMembershipTransitionAgainstLogical(logicalTransition, {
    removals: [],
    replacements: [
      { logicalId: dayId, previousAssetSha256: null },
      { logicalId: resolutionId, previousAssetSha256: null },
    ],
  }).removals, []);
  assert.throws(() => validateLogicalTransition({
    ...logicalTransition,
    replacements: [initialMembers[1]],
  }), /required collection day/);
  assert.throws(() => validateMembershipTransitionAgainstLogical(logicalTransition, {
    removals: [],
    replacements: [{ logicalId: dayId, previousAssetSha256: null }],
  }), /exact logical transition/);
  const verificationOnly = {
    changedMonths: [],
    collectionDays: [],
    removals: [],
    replacements: [member(baseStateLogicalId(address), { value: "retention-state" })],
    verificationMonths: [baseMonthLogicalId(address, "2026-08")],
  };
  assert.deepEqual(validateLogicalTransition(verificationOnly).changedMonths, []);
  assert.throws(() => validateLogicalTransition({
    ...verificationOnly,
    replacements: [initialMembers[1]],
  }), /outside the recording scope/);

  const replacementPacked = packLogicalMembers({
    assetNamePrefix: "data",
    maximumAssetBytes: 1_000_000,
    members: [member(dayId, { value: "day-b" })],
    releaseTag: "market-data-2026-08-s1",
  });
  const updated = applyAssetMembershipTransition({
    packedAssets: replacementPacked,
    previousAssets: initial.nextAssets,
    transition: {
      removals: [],
      replacements: [{ logicalId: dayId, previousAssetSha256: initial.nextAssets[0].sha256 }],
    },
  });
  const retained = updated.nextAssets.find((entry) => entry.sha256 === initial.nextAssets[0].sha256);
  assert.deepEqual(retained.logicalIds, [resolutionId]);
  assert.throws(() => applyAssetMembershipTransition({
    packedAssets: packed,
    previousAssets: updated.nextAssets,
    transition: {
      removals: [],
      replacements: [{ logicalId: dayId, previousAssetSha256: replacementPacked[0].selectedAsset.sha256 }],
    },
  }), /retained asset cannot gain/);

  const removed = applyAssetMembershipTransition({
    packedAssets: [],
    previousAssets: updated.nextAssets,
    transition: { replacements: [], removals: [resolutionId] },
  });
  assert.ok(removed.supersededAssets.some((identity) => identity.sha256 === initial.nextAssets[0].sha256));
});

test("root membership maps every selected base-state reference to one physical asset", async () => {
  const admitted = await loadMarketDataConfiguration();
  const base = admitted.configuration.bases[0];
  const stateId = baseStateLogicalId(base.baseCurrencyAddress);
  const packed = packLogicalMembers({
    assetNamePrefix: "index",
    maximumAssetBytes: 1_000_000,
    members: [member(stateId, { value: "state bytes" })],
    releaseTag: "market-data-index-s1",
  });
  const reference = packed[0].references[0];
  const root = {
    assets: [packed[0].selectedAsset],
    baseCurrencies: { [base.baseCurrencyAddress]: reference },
    currentUntil: { blockNumber: "50000000", timestamp: "2026-08-27T00:00:00.000Z" },
    poolManager: admitted.configuration.poolManager,
    publicationSequence: 1,
    resolutions: candleResolutionCatalog,
    usdgAddress: admitted.configuration.usdgAddress,
    usdgDecimals: admitted.configuration.usdgDecimals,
  };
  assert.deepEqual(validateSelectedRoot(root, admitted.configuration), root);

  const dayId = baseDayLogicalId(base.baseCurrencyAddress, "2026-08-27");
  const candle = marketDataCandle({ intervalStart: "2026-08-27T00:00:00.000Z", blockNumber: "50000001" });
  const coverage = [{
    fromBlock: "50000000",
    fromTimestamp: "2026-08-27T00:00:00.000Z",
    poolId: base.poolId,
    untilBlock: "50001000",
    untilTimestamp: "2026-08-27T00:15:00.000Z",
  }];
  assert.equal(encodeMarketDataLogicalFile(dayId, {
    baseCurrencyAddress: base.baseCurrencyAddress,
    candles: [candle],
    coverage,
    day: "2026-08-27",
  }, admitted.configuration).logicalId, dayId);
  const resolution = createBaseResolutionFile({
    baseCurrencyAddress: base.baseCurrencyAddress,
    candles: [candle],
    coverage,
    intervalSeconds: 900,
    ownerMonth: "2026-08",
  });
  assert.equal(resolution.candles.length, 1);
  assert.equal(resolution.candles[0].sourceCandleCount, 1);
});

test("logical file encoding binds its address and period to its logical ID", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  assert.throws(() => encodeMarketDataLogicalFile(
    baseDayLogicalId(base.baseCurrencyAddress, "2026-08-14"),
    {
      baseCurrencyAddress: base.baseCurrencyAddress,
      candles: [],
      coverage: [{
        fromBlock: "1",
        fromTimestamp: "2026-08-15T00:00:00.000Z",
        poolId: base.poolId,
        untilBlock: "2",
        untilTimestamp: "2026-08-15T00:15:00.000Z",
      }],
      day: "2026-08-15",
    },
    configuration,
  ), /logical identity/);

});

test("selected physical assets cannot exceed the fixed byte boundary", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  const sha256 = "a".repeat(64);
  assert.throws(() => validateSelectedAssetEntry({
    assetName: `data-${sha256}.bin`,
    bytes: maximumMarketDataAssetBytes + 1,
    logicalIds: [baseDayLogicalId(base.baseCurrencyAddress, "2026-08-14")],
    releaseTag: "market-data-2026-08-s1",
    sha256,
  }), /byte boundary/);
});
