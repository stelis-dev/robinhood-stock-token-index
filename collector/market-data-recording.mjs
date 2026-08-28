import { canonicalBytes, encodeArtifact, isSha256Hex, sha256Hex } from "./canonical.mjs";
import { affectedResolutionOwnerMonths, candleResolutionCatalog } from "./candle-resolution.mjs";
import {
  applyAssetMembershipTransition,
  maximumMarketDataAssetBytes,
  maximumMarketDataAssetsPerRelease,
  packLogicalMembers,
  validateAssetMembershipTransition,
} from "./market-data-assets.mjs";
import {
  baseDayLogicalId,
  baseMonthLogicalId,
  baseResolutionLogicalId,
  baseStateLogicalId,
  parseMarketDataLogicalId,
} from "./market-data-file-identity.mjs";
import {
  createBaseResolutionFile,
  encodeMarketDataLogicalFile,
  mergeAdjacentCoverage,
  rootAssetIdentity,
  validateBaseDayFile,
  validateBaseMonthFile,
  validateBaseStateFile,
  validateBaseStateProgress,
  validateCoverageSequence,
  validatePublicationRecord,
  validateSelectedRoot,
} from "./market-data-files.mjs";
import { parseUtcInstant, subtractUtcCalendarMonths } from "./utc-time.mjs";
import { sharedCollectionSliceSeconds } from "./shared-collection-plan.mjs";

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (!sameValue(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

function validateOrderedLogicalIds(value, label, expectedKind = null) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  let previous = "";
  for (const logicalId of value) {
    const identity = parseMarketDataLogicalId(logicalId);
    if (logicalId <= previous || expectedKind !== null && identity.kind !== expectedKind) {
      throw new Error(`${label} is duplicated, unordered, or has the wrong logical kind.`);
    }
    previous = logicalId;
  }
  return value;
}

function validateLogicalReplacement(value) {
  exactKeys(value, ["gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId"], "Logical transition replacement");
  parseMarketDataLogicalId(value.logicalId);
  if (
    !Buffer.isBuffer(value.gzipBytes)
    || value.gzipBytes.byteLength === 0
    || !Buffer.isBuffer(value.jsonBytes)
    || value.jsonBytes.byteLength === 0
    || !isSha256Hex(value.gzipSha256)
    || !isSha256Hex(value.jsonSha256)
    || sha256Hex(value.gzipBytes) !== value.gzipSha256
    || sha256Hex(value.jsonBytes) !== value.jsonSha256
  ) throw new Error("Logical transition replacement identity is invalid.");
  return value;
}

export function validateLogicalTransition(value) {
  exactKeys(value, ["changedMonths", "collectionDays", "removals", "replacements", "verificationMonths"], "Logical transition");
  validateOrderedLogicalIds(value.collectionDays, "Logical transition collection days", "day");
  validateOrderedLogicalIds(value.changedMonths, "Logical transition changed months", "month");
  validateOrderedLogicalIds(value.verificationMonths, "Logical transition verification months", "month");
  validateOrderedLogicalIds(value.removals, "Logical transition removals");
  if (!Array.isArray(value.replacements)) throw new Error("Logical transition replacements must be an array.");
  let previousLogicalId = "";
  for (const replacement of value.replacements) {
    validateLogicalReplacement(replacement);
    if (replacement.logicalId <= previousLogicalId) throw new Error("Logical transition replacements are duplicated or unordered.");
    previousLogicalId = replacement.logicalId;
  }
  const replacementIds = new Set(value.replacements.map((replacement) => replacement.logicalId));
  if (value.collectionDays.some((logicalId) => !replacementIds.has(logicalId))) {
    throw new Error("Logical transition omits a required collection day.");
  }
  if (value.removals.some((logicalId) => replacementIds.has(logicalId))) {
    throw new Error("Logical transition replacements and removals overlap.");
  }
  const verificationMonths = new Set(value.verificationMonths);
  if (value.changedMonths.some((logicalId) => !verificationMonths.has(logicalId))) {
    throw new Error("Every changed month must also be verified.");
  }
  const allowed = new Set(value.collectionDays);
  for (const logicalId of value.changedMonths) {
    const identity = parseMarketDataLogicalId(logicalId);
    allowed.add(logicalId);
    allowed.add(baseStateLogicalId(identity.baseCurrencyAddress));
    for (const definition of candleResolutionCatalog.slice(1)) {
      allowed.add(baseResolutionLogicalId(identity.baseCurrencyAddress, definition.label, identity.period));
    }
  }
  for (const logicalId of value.verificationMonths) {
    allowed.add(baseStateLogicalId(parseMarketDataLogicalId(logicalId).baseCurrencyAddress));
  }
  for (const logicalId of value.removals) {
    const identity = parseMarketDataLogicalId(logicalId);
    allowed.add(baseStateLogicalId(identity.baseCurrencyAddress));
  }
  if (value.replacements.some((replacement) => !allowed.has(replacement.logicalId))) {
    throw new Error("Logical transition replacement is outside the recording scope.");
  }
  return value;
}

function logicalTransition({ changedMonths, collectionDays, replacements, removals, verificationMonths }) {
  return Object.freeze(validateLogicalTransition({
    changedMonths: Object.freeze([...changedMonths].sort()),
    collectionDays: Object.freeze([...collectionDays].sort()),
    removals: Object.freeze([...removals].sort()),
    replacements: Object.freeze([...replacements].sort((left, right) => (
      left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0
    ))),
    verificationMonths: Object.freeze([...verificationMonths].sort()),
  }));
}

function membershipTransitionFromLogical(logical, previousLogicalAssets) {
  validateLogicalTransition(logical);
  const transition = Object.freeze(validateAssetMembershipTransition({
    replacements: Object.freeze(logical.replacements.map((replacement) => Object.freeze({
      logicalId: replacement.logicalId,
      previousAssetSha256: previousLogicalAssets.get(replacement.logicalId) ?? null,
    }))),
    removals: logical.removals,
  }));
  return transition;
}

export function validateMembershipTransitionAgainstLogical(logical, transition) {
  validateLogicalTransition(logical);
  validateAssetMembershipTransition(transition);
  if (
    !sameValue(logical.removals, transition.removals)
    || !sameValue(
      logical.replacements.map((replacement) => replacement.logicalId),
      transition.replacements.map((replacement) => replacement.logicalId),
    )
  ) throw new Error("Physical membership transition differs from the exact logical transition.");
  return transition;
}

export function mergeRecordedCoverage(existingValue, replacement, kind) {
  const existing = existingValue.length === 0 ? [] : validateCoverageSequence(existingValue, "Existing coverage");
  validateCoverageSequence([replacement], "Replacement coverage");
  if (kind === "initial") {
    if (existing.length !== 0) throw new Error("Initial coverage cannot replace selected coverage.");
    return Object.freeze([Object.freeze({ ...replacement })]);
  }
  if (existing.length === 0) throw new Error("Selected coverage is required.");
  if (kind === "repair") {
    if (!existing.some((segment) => (
      segment.poolId === replacement.poolId
      && segment.fromTimestamp <= replacement.fromTimestamp
      && segment.untilTimestamp >= replacement.untilTimestamp
      && BigInt(segment.fromBlock) <= BigInt(replacement.fromBlock)
      && BigInt(segment.untilBlock) >= BigInt(replacement.untilBlock)
    ))) throw new Error("Repair escapes selected coverage.");
    return Object.freeze(existing.map((segment) => Object.freeze({ ...segment })));
  }
  if (kind === "current") {
    const last = existing.at(-1);
    if (last.untilBlock !== replacement.fromBlock || last.untilTimestamp !== replacement.fromTimestamp) {
      throw new Error("Current coverage is not adjacent to the selected end.");
    }
    return Object.freeze(validateCoverageSequence([...existing, replacement], "Updated current coverage")
      .map((segment) => Object.freeze({ ...segment })));
  }
  if (kind === "history") {
    const ownedIndex = existing.findIndex((segment) => (
      segment.poolId === replacement.poolId
      && segment.fromBlock === replacement.untilBlock
      && segment.fromTimestamp === replacement.untilTimestamp
    ));
    if (ownedIndex === -1) throw new Error("History coverage is not adjacent to its selected start.");
    const output = [...existing];
    output.splice(ownedIndex, 0, replacement);
    return Object.freeze(validateCoverageSequence(output, "Updated history coverage")
      .map((segment) => Object.freeze({ ...segment })));
  }
  throw new Error("Recorded coverage kind is invalid.");
}

export function mergeRecordedCandles(existing, replacement, coverage) {
  if (!Array.isArray(existing) || !Array.isArray(replacement)) throw new Error("Recorded candles are invalid.");
  const merged = [
    ...existing.filter((candle) => (
      candle.intervalStart < coverage.fromTimestamp
      || candle.intervalEnd > coverage.untilTimestamp
    )),
    ...replacement,
  ].sort((left, right) => left.intervalStart.localeCompare(right.intervalStart));
  return Object.freeze(merged.map((candle) => Object.freeze(structuredClone(candle))));
}

function configuredBase(configuration, address) {
  const base = configuration.bases.find((candidate) => candidate.baseCurrencyAddress === address);
  if (base === undefined) throw new Error("Recorded base currency is absent from configuration.");
  return base;
}

function newPoolFacts(base, sourceFrom) {
  return Object.freeze({
    historyFrom: Object.freeze({ ...sourceFrom }),
    initialize: base.initialize,
    poolKey: base.poolKey,
    sourceFrom: Object.freeze({ ...sourceFrom }),
  });
}

export function applyBaseStateResult({ configuration, previousState, result, sourceFrom = null }) {
  const base = configuredBase(configuration, result.baseCurrencyAddress);
  const coverage = result.coverage;
  if (previousState === null) {
    if (result.kind !== "initial" || sourceFrom === null || sourceFrom.timestamp > coverage.fromTimestamp) {
      throw new Error("Initial base state input is invalid.");
    }
    return validateBaseStateProgress({
      baseCurrencyAddress: base.baseCurrencyAddress,
      decimals: base.decimals,
      months: [],
      poolPeriods: [coverage],
      pools: { [coverage.poolId]: {
        ...newPoolFacts(base, sourceFrom),
        historyFrom: Object.freeze({ blockNumber: coverage.fromBlock, timestamp: coverage.fromTimestamp }),
      } },
    }, configuration);
  }
  const previousIsProgress = previousState.months.length === 0;
  (previousIsProgress ? validateBaseStateProgress : validateBaseStateFile)(previousState, configuration);
  const pools = structuredClone(previousState.pools);
  const periods = structuredClone(previousState.poolPeriods);
  if (result.kind === "current") {
    if (pools[coverage.poolId] === undefined) {
      if (sourceFrom === null || sourceFrom.blockNumber !== coverage.fromBlock || sourceFrom.timestamp !== coverage.fromTimestamp) {
        throw new Error("Changed PoolId source boundary is invalid.");
      }
      pools[coverage.poolId] = newPoolFacts(base, sourceFrom);
    }
    const merged = mergeAdjacentCoverage(mergeRecordedCoverage(periods, coverage, "current"));
    periods.splice(0, periods.length, ...merged);
  } else if (result.kind === "history") {
    if (pools[coverage.poolId] === undefined) throw new Error("History PoolId facts are unavailable.");
    const merged = mergeAdjacentCoverage(mergeRecordedCoverage(periods, coverage, "history"));
    periods.splice(0, periods.length, ...merged);
    pools[coverage.poolId].historyFrom = { blockNumber: coverage.fromBlock, timestamp: coverage.fromTimestamp };
  } else if (result.kind === "repair") {
    mergeRecordedCoverage(periods, coverage, "repair");
  } else {
    throw new Error("Existing base state result kind is invalid.");
  }
  return (previousIsProgress ? validateBaseStateProgress : validateBaseStateFile)({
    baseCurrencyAddress: previousState.baseCurrencyAddress,
    decimals: previousState.decimals,
    months: previousState.months,
    poolPeriods: periods,
    pools,
  }, configuration);
}

export function createBaseDayCandidate({ configuration, previousDay, result }) {
  const day = result.coverage.fromTimestamp.slice(0, 10);
  if (result.coverage.untilTimestamp.slice(0, 10) !== day && !result.coverage.untilTimestamp.endsWith("T00:00:00.000Z")) {
    throw new Error("One phase result crosses a UTC day.");
  }
  if (previousDay !== null && previousDay.day !== day) throw new Error("Previous base day identity is invalid.");
  if (previousDay === null && result.kind === "repair") throw new Error("Repair requires a selected base day.");
  const coverage = mergeRecordedCoverage(
    previousDay?.coverage ?? [],
    result.coverage,
    previousDay === null ? "initial" : result.kind,
  );
  const candles = mergeRecordedCandles(previousDay?.candles ?? [], result.candles, result.coverage);
  const value = {
    baseCurrencyAddress: result.baseCurrencyAddress,
    candles,
    coverage,
    day,
  };
  validateBaseDayFile(value);
  if (previousDay !== null && sameValue(previousDay, value)) return null;
  configuredBase(configuration, result.baseCurrencyAddress);
  return Object.freeze(value);
}

function referenceByLogicalId(packedAssets) {
  return new Map(packedAssets.flatMap((asset) => asset.references.map((reference) => [reference.logicalId, reference])));
}

function oneCurrentBoundary(results) {
  const boundaries = new Map(results.map((result) => [
    `${result.coverage.untilBlock}:${result.coverage.untilTimestamp}`,
    { blockNumber: result.coverage.untilBlock, timestamp: result.coverage.untilTimestamp },
  ]));
  if (boundaries.size !== 1) throw new Error("Initial recording has no global current boundary.");
  return boundaries.values().next().value;
}

export function buildInitialMarketDataRecording({
  admittedConfiguration,
  preparedPhase,
  collectionResult,
}) {
  const configuration = admittedConfiguration.configuration;
  if (
    collectionResult?.phase !== "current"
    || collectionResult.configurationSha256 !== admittedConfiguration.sha256
    || collectionResult.bases.length !== configuration.bases.length
    || collectionResult.bases.some((result) => result.kind !== "initial")
  ) throw new Error("Initial recording requires one complete initial collection result.");
  const sourceByPoolId = new Map(preparedPhase.newSources.map((source) => [source.poolId, source]));
  const dayValues = [];
  const stateValues = new Map();
  for (const result of collectionResult.bases) {
    const source = sourceByPoolId.get(result.coverage.poolId);
    if (source?.baseCurrencyAddress !== result.baseCurrencyAddress) throw new Error("Initial source boundary is unavailable.");
    dayValues.push(createBaseDayCandidate({ configuration, previousDay: null, result }));
    stateValues.set(result.baseCurrencyAddress, applyBaseStateResult({
      configuration,
      previousState: null,
      result,
      sourceFrom: source.sourceFrom,
    }));
  }
  const dataMembersByMonth = new Map();
  function addDataMember(month, member) {
    const members = dataMembersByMonth.get(month) ?? [];
    members.push(member);
    dataMembersByMonth.set(month, members);
  }
  for (const day of dayValues) {
    const month = day.day.slice(0, 7);
    addDataMember(month, encodeMarketDataLogicalFile(
      baseDayLogicalId(day.baseCurrencyAddress, day.day),
      day,
      configuration,
    ));
    for (const definition of candleResolutionCatalog.slice(1)) {
      const value = createBaseResolutionFile({
        baseCurrencyAddress: day.baseCurrencyAddress,
        candles: day.candles,
        coverage: day.coverage,
        intervalSeconds: definition.intervalSeconds,
        ownerMonth: month,
      });
      addDataMember(month, encodeMarketDataLogicalFile(
        baseResolutionLogicalId(day.baseCurrencyAddress, definition.label, month),
        value,
        configuration,
      ));
    }
  }
  const dataAssets = [...dataMembersByMonth].sort(([left], [right]) => left.localeCompare(right)).flatMap(([month, members]) => (
    packLogicalMembers({
      assetNamePrefix: "data",
      maximumAssetBytes: maximumMarketDataAssetBytes,
      members,
      releaseTag: `market-data-${month}-s1`,
    })
  ));
  const dataReferences = referenceByLogicalId(dataAssets);
  const monthValues = [];
  for (const day of dayValues) {
    const month = day.day.slice(0, 7);
    const resolutions = Object.fromEntries(candleResolutionCatalog.slice(1).map((definition) => [
      definition.label,
      dataReferences.get(baseResolutionLogicalId(day.baseCurrencyAddress, definition.label, month)),
    ]));
    monthValues.push(validateBaseMonthFile({
      baseCurrencyAddress: day.baseCurrencyAddress,
      coverage: day.coverage,
      days: [dataReferences.get(baseDayLogicalId(day.baseCurrencyAddress, day.day))],
      month,
      resolutions,
    }));
  }
  const monthMembers = monthValues.map((value) => encodeMarketDataLogicalFile(
    baseMonthLogicalId(value.baseCurrencyAddress, value.month),
    value,
    configuration,
  ));
  const monthAssets = packLogicalMembers({
    assetNamePrefix: "index",
    maximumAssetBytes: maximumMarketDataAssetBytes,
    members: monthMembers,
    releaseTag: "market-data-index-s1",
  });
  const monthReferences = referenceByLogicalId(monthAssets);
  const stateMembers = [];
  for (const [address, state] of stateValues) {
    const month = monthValues.find((value) => value.baseCurrencyAddress === address);
    const value = validateBaseStateFile({
      ...state,
      months: [monthReferences.get(baseMonthLogicalId(address, month.month))],
    }, configuration);
    stateValues.set(address, value);
    stateMembers.push(encodeMarketDataLogicalFile(baseStateLogicalId(address), value, configuration));
  }
  const stateAssets = packLogicalMembers({
    assetNamePrefix: "index",
    maximumAssetBytes: maximumMarketDataAssetBytes,
    members: stateMembers,
    releaseTag: "market-data-index-s1",
  });
  const stateReferences = referenceByLogicalId(stateAssets);
  const packedAssets = Object.freeze([...dataAssets, ...monthAssets, ...stateAssets]);
  const initialMonths = monthValues.map((month) => baseMonthLogicalId(month.baseCurrencyAddress, month.month));
  const logical = logicalTransition({
    changedMonths: initialMonths,
    collectionDays: dayValues.map((day) => baseDayLogicalId(day.baseCurrencyAddress, day.day)),
    removals: [],
    replacements: [
      ...[...dataMembersByMonth.values()].flatMap((members) => members),
      ...monthMembers,
      ...stateMembers,
    ],
    verificationMonths: initialMonths,
  });
  const transition = membershipTransitionFromLogical(logical, new Map());
  validateMembershipTransitionAgainstLogical(logical, transition);
  const membership = applyAssetMembershipTransition({
    packedAssets,
    previousAssets: [],
    transition,
  });
  const root = validateSelectedRoot({
    assets: membership.nextAssets,
    baseCurrencies: Object.fromEntries(configuration.bases.map((base) => [
      base.baseCurrencyAddress,
      stateReferences.get(baseStateLogicalId(base.baseCurrencyAddress)),
    ])),
    currentUntil: oneCurrentBoundary(collectionResult.bases),
    poolManager: configuration.poolManager,
    publicationSequence: 1,
    resolutions: candleResolutionCatalog,
    usdgAddress: configuration.usdgAddress,
    usdgDecimals: configuration.usdgDecimals,
  }, configuration);
  const encodedRoot = encodeArtifact(root);
  const nextRoot = rootAssetIdentity(root.publicationSequence, encodedRoot.gzipBytes);
  const publicationRecord = validatePublicationRecord({
    configurationSha256: admittedConfiguration.sha256,
    finalizedBlock: collectionResult.finalizedBlock,
    newAssets: membership.newAssets,
    nextRoot,
    phase: collectionResult.phase,
    previousAssets: [],
    previousRoot: null,
    ranges: collectionResult.ranges,
    supersededAssets: [],
    target: collectionResult.target,
  });
  const encodedPublicationRecord = encodeArtifact(publicationRecord);
  if (encodedRoot.gzipBytes.byteLength > maximumMarketDataAssetBytes || encodedPublicationRecord.gzipBytes.byteLength > maximumMarketDataAssetBytes) {
    throw new Error("Initial root or publication record exceeds the physical asset boundary.");
  }
  return Object.freeze({
    encodedPublicationRecord,
    encodedRoot,
    logicalTransition: logical,
    membershipTransition: transition,
    packedAssets,
    publicationRecord,
    root,
  });
}

function nextMonthInstant(month) {
  const value = new Date(`${month}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString();
}

function nextMonth(month) {
  return nextMonthInstant(month).slice(0, 7);
}

function nextDayInstant(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
}

function logicalAssetSha256(root) {
  return new Map(root.assets.flatMap((asset) => asset.logicalIds.map((logicalId) => [logicalId, asset.sha256])));
}

function sameEncoded(reference, encoded) {
  return reference !== undefined
    && reference.gzipSha256 === encoded.gzipSha256
    && reference.jsonBytes === encoded.jsonBytes.byteLength
    && reference.jsonSha256 === encoded.jsonSha256;
}

function combinedCoverage(days) {
  const coverage = days.flatMap((day) => day.coverage).sort((left, right) => (
    left.fromTimestamp.localeCompare(right.fromTimestamp)
    || left.untilTimestamp.localeCompare(right.untilTimestamp)
  ));
  return validateCoverageSequence(coverage, "Recorded month coverage");
}

export function retainedCoverageBoundary(coverage, lowerBound) {
  validateCoverageSequence(coverage, "Retention source coverage");
  parseUtcInstant(lowerBound, "Retention lower bound", true);
  const segment = coverage.find((candidate) => (
    candidate.fromTimestamp <= lowerBound && candidate.untilTimestamp > lowerBound
  ));
  return segment === undefined ? null : Object.freeze({
    blockNumber: segment.fromBlock,
    timestamp: segment.fromTimestamp,
  });
}

function trimStateRetention(state, lowerBound, retainedFrom) {
  if (state.poolPeriods[0].fromTimestamp >= lowerBound) return state;
  const retainedTime = retainedFrom === null ? Number.NaN : Date.parse(retainedFrom.timestamp);
  const lowerTime = Date.parse(lowerBound);
  if (
    retainedFrom === null
    || retainedTime > lowerTime
    || lowerTime - retainedTime >= sharedCollectionSliceSeconds * 1_000
    || retainedFrom.timestamp.slice(0, 10) !== lowerBound.slice(0, 10)
  ) throw new Error("Retention durable-segment prefix is invalid.");
  const periods = [];
  for (const period of state.poolPeriods) {
    if (period.untilTimestamp <= retainedFrom.timestamp) continue;
    if (period.fromTimestamp < retainedFrom.timestamp) {
      if (BigInt(period.fromBlock) > BigInt(retainedFrom.blockNumber) || BigInt(period.untilBlock) < BigInt(retainedFrom.blockNumber)) {
        throw new Error("Retention boundary escapes selected coverage.");
      }
      periods.push({
        ...period,
        fromBlock: retainedFrom.blockNumber,
        fromTimestamp: retainedFrom.timestamp,
      });
    } else periods.push(period);
  }
  if (periods.length === 0) throw new Error("Retention removed all selected current coverage.");
  const pools = structuredClone(state.pools);
  for (const poolId of Object.keys(pools)) {
    const owned = periods.filter((period) => period.poolId === poolId);
    if (owned.length === 0) delete pools[poolId];
    else pools[poolId].historyFrom = { blockNumber: owned[0].fromBlock, timestamp: owned[0].fromTimestamp };
  }
  return { ...state, poolPeriods: periods, pools };
}

function retagPackedAsset(packed, releaseTag) {
  return Object.freeze({
    ...packed,
    selectedAsset: Object.freeze({ ...packed.selectedAsset, releaseTag }),
  });
}

async function assignReleaseShards({ family, packedAssets, replayAssets, store, releaseUsage }) {
  const output = [];
  for (const packed of packedAssets) {
    let shard = 1;
    while (true) {
      const releaseTag = `${family}${shard}`;
      if (!releaseUsage.has(releaseTag)) {
        releaseUsage.set(releaseTag, {
          assignedNames: new Set(),
          existing: await store.listMarketDataAssets(releaseTag),
        });
      }
      const usage = releaseUsage.get(releaseTag);
      const existingAsset = usage.existing.find((asset) => asset.assetName === packed.selectedAsset.assetName);
      if (existingAsset !== undefined) {
        const replay = replayAssets.get(`${releaseTag}:${packed.selectedAsset.assetName}`);
        if (
          replay === undefined
          || replay.bytes !== packed.selectedAsset.bytes
          || replay.sha256 !== packed.selectedAsset.sha256
          || existingAsset.state !== "starter" && (
            existingAsset.state !== "uploaded"
            || existingAsset.bytes !== replay.bytes
            || existingAsset.sha256 !== null && existingAsset.sha256 !== replay.sha256
          )
        ) throw new Error("A regenerated asset conflicts with pending publication recovery.");
        output.push(retagPackedAsset(packed, releaseTag));
        break;
      }
      if (usage.assignedNames.has(packed.selectedAsset.assetName)) throw new Error("A packed asset is duplicated.");
      if (usage.existing.length + usage.assignedNames.size < maximumMarketDataAssetsPerRelease) {
        usage.assignedNames.add(packed.selectedAsset.assetName);
        output.push(retagPackedAsset(packed, releaseTag));
        break;
      }
      shard += 1;
    }
  }
  return output;
}

async function packDataMembersByMonth({ membersByMonth, replayAssets, store, releaseUsage }) {
  const output = [];
  for (const [month, members] of [...membersByMonth].sort(([left], [right]) => left.localeCompare(right))) {
    const provisional = packLogicalMembers({
      assetNamePrefix: "data",
      maximumAssetBytes: maximumMarketDataAssetBytes,
      members,
      releaseTag: `market-data-${month}-s1`,
    });
    output.push(...await assignReleaseShards({
      family: `market-data-${month}-s`,
      packedAssets: provisional,
      replayAssets,
      releaseUsage,
      store,
    }));
  }
  return output;
}

async function packIndexMembers({ members, replayAssets, store, releaseUsage }) {
  if (members.length === 0) return [];
  const provisional = packLogicalMembers({
    assetNamePrefix: "index",
    maximumAssetBytes: maximumMarketDataAssetBytes,
    members,
    releaseTag: "market-data-index-s1",
  });
  return assignReleaseShards({
    family: "market-data-index-s",
    packedAssets: provisional,
    replayAssets,
    releaseUsage,
    store,
  });
}

function sourceForResult(preparedPhase, result) {
  return preparedPhase.newSources.find((source) => (
    source.baseCurrencyAddress === result.baseCurrencyAddress
    && source.poolId === result.coverage.poolId
  ))?.sourceFrom ?? null;
}

export async function buildNextMarketDataRecording({
  admittedConfiguration,
  collectionResult,
  marketDataReader,
  pendingPublicationRecord = null,
  preparedPhase,
  selected,
  store,
}) {
  if (selected === null || collectionResult?.status !== "collected") throw new Error("A selected recording and complete result are required.");
  const configuration = admittedConfiguration.configuration;
  if (collectionResult.configurationSha256 !== admittedConfiguration.sha256 || preparedPhase.configurationSha256 !== admittedConfiguration.sha256) {
    throw new Error("Recording configuration identity changed.");
  }
  const stateValues = new Map(Object.entries(selected.baseStates));
  const replayAssets = new Map((pendingPublicationRecord?.newAssets ?? []).map((identity) => [
    `${identity.releaseTag}:${identity.assetName}`,
    identity,
  ]));
  const ownerCache = new Map();
  const monthCache = new Map();
  const changedDays = new Map();
  const changedMonths = new Set();
  const verificationMonths = new Set();
  async function loadOwner(address, month) {
    const key = `${address}:${month}`;
    if (!ownerCache.has(key)) ownerCache.set(key, await marketDataReader.baseMonth(selected, address, month));
    return ownerCache.get(key);
  }
  async function loadMonth(address, month) {
    const key = `${address}:${month}`;
    if (monthCache.has(key)) return monthCache.get(key);
    const owner = await loadOwner(address, month);
    const days = new Map();
    if (owner !== null) {
      for (const reference of owner.value.days) {
        const file = await marketDataReader.baseDay(selected, reference);
        days.set(file.value.day, file);
      }
    }
    const loaded = { owner, days };
    monthCache.set(key, loaded);
    return loaded;
  }
  async function retainedBoundary(address, state, lowerBound) {
    if (state.poolPeriods[0].fromTimestamp >= lowerBound) return null;
    const ownerMonth = lowerBound.slice(0, 7);
    const owner = await loadOwner(address, ownerMonth);
    const dayLogicalId = baseDayLogicalId(address, lowerBound.slice(0, 10));
    const dayReference = owner?.value.days.find((reference) => reference.logicalId === dayLogicalId);
    if (dayReference === undefined) throw new Error("Retention lower-bound day is not recorded.");
    const day = await marketDataReader.baseDay(selected, dayReference);
    const boundary = retainedCoverageBoundary(day.value.coverage, lowerBound);
    if (boundary !== null) return Object.freeze({ boundary, ownerMonth });
    throw new Error("Retention has no recorded boundary after its lower bound.");
  }

  for (const result of collectionResult.bases) {
    const previousState = stateValues.get(result.baseCurrencyAddress) ?? null;
    const sourceFrom = sourceForResult(preparedPhase, result);
    stateValues.set(result.baseCurrencyAddress, applyBaseStateResult({
      configuration,
      previousState,
      result,
      sourceFrom,
    }));
    const day = result.coverage.fromTimestamp.slice(0, 10);
    const month = day.slice(0, 7);
    const loaded = await loadMonth(result.baseCurrencyAddress, month);
    const previousDay = changedDays.get(`${result.baseCurrencyAddress}:${day}`)?.value
      ?? loaded.days.get(day)?.value
      ?? null;
    const value = createBaseDayCandidate({ configuration, previousDay, result });
    if (value !== null) changedDays.set(`${result.baseCurrencyAddress}:${day}`, { month, value });
    changedMonths.add(`${result.baseCurrencyAddress}:${month}`);
    verificationMonths.add(`${result.baseCurrencyAddress}:${month}`);
    for (const definition of candleResolutionCatalog.slice(1)) {
      for (const ownerMonth of affectedResolutionOwnerMonths({
        fromTimestamp: result.coverage.fromTimestamp,
        intervalSeconds: definition.intervalSeconds,
        untilTimestamp: result.coverage.untilTimestamp,
      })) {
        changedMonths.add(`${result.baseCurrencyAddress}:${ownerMonth}`);
        verificationMonths.add(`${result.baseCurrencyAddress}:${ownerMonth}`);
      }
    }
  }

  const nextCurrentUntil = collectionResult.phase === "current"
    ? oneCurrentBoundary(collectionResult.bases)
    : selected.root.currentUntil;
  const retentionLowerBound = subtractUtcCalendarMonths(nextCurrentUntil.timestamp, 12);
  for (const [address, state] of stateValues) {
    const retained = await retainedBoundary(address, state, retentionLowerBound);
    const retentionBoundaryChanged = retained !== null && (
      retained.boundary.blockNumber !== state.poolPeriods[0].fromBlock
      || retained.boundary.timestamp !== state.poolPeriods[0].fromTimestamp
    );
    const trimmed = trimStateRetention(
      state,
      retentionLowerBound,
      retained?.boundary ?? null,
    );
    stateValues.set(address, (state.months.length === 0 ? validateBaseStateProgress : validateBaseStateFile)(trimmed, configuration));
    if (retentionBoundaryChanged) verificationMonths.add(`${address}:${retained.ownerMonth}`);
  }

  const retentionRemovals = new Set();
  for (const [address, state] of Object.entries(selected.baseStates)) {
    for (const reference of state.months) {
      const identity = parseMarketDataLogicalId(reference.logicalId);
      if (nextMonthInstant(identity.period) <= retentionLowerBound) {
        const owner = await loadOwner(address, identity.period);
        if (owner === null) throw new Error("Selected retention month is unavailable.");
        retentionRemovals.add(reference.logicalId);
        for (const dayReference of owner.value.days) retentionRemovals.add(dayReference.logicalId);
        for (const resolutionReference of Object.values(owner.value.resolutions)) retentionRemovals.add(resolutionReference.logicalId);
        continue;
      }
      if (`${identity.period}-01T00:00:00.000Z` >= retentionLowerBound) continue;
      const owner = await loadOwner(address, identity.period);
      if (owner === null) throw new Error("Selected retention month is unavailable.");
      const retainedDays = owner.value.days.filter((dayReference) => (
        nextDayInstant(parseMarketDataLogicalId(dayReference.logicalId).period) > retentionLowerBound
      ));
      if (retainedDays.length === 0) {
        retentionRemovals.add(reference.logicalId);
        for (const dayReference of owner.value.days) retentionRemovals.add(dayReference.logicalId);
        for (const resolutionReference of Object.values(owner.value.resolutions)) retentionRemovals.add(resolutionReference.logicalId);
      } else {
        let removedDay = false;
        for (const dayReference of owner.value.days) {
          if (nextDayInstant(parseMarketDataLogicalId(dayReference.logicalId).period) <= retentionLowerBound) {
            retentionRemovals.add(dayReference.logicalId);
            removedDay = true;
          }
        }
        if (removedDay) {
          changedMonths.add(`${address}:${identity.period}`);
          verificationMonths.add(`${address}:${identity.period}`);
        }
      }
    }
  }
  const previousLogicalAssets = logicalAssetSha256(selected.root);
  const collectionDays = collectionResult.bases.filter((result) => (
    result.kind !== "repair"
    || changedDays.has(`${result.baseCurrencyAddress}:${result.coverage.fromTimestamp.slice(0, 10)}`)
  )).map((result) => baseDayLogicalId(
    result.baseCurrencyAddress,
    result.coverage.fromTimestamp.slice(0, 10),
  ));
  const removals = new Set(retentionRemovals);
  const dataMembersByMonth = new Map();
  const nextMonthValues = new Map();
  function addDataMember(month, member) {
    const values = dataMembersByMonth.get(month) ?? [];
    values.push(member);
    dataMembersByMonth.set(month, values);
  }
  for (const key of [...changedMonths].sort()) {
    const separator = key.indexOf(":");
    const address = key.slice(0, separator);
    const month = key.slice(separator + 1);
    const loaded = await loadMonth(address, month);
    const days = new Map(loaded.days);
    for (const [changedKey, changed] of changedDays) {
      if (changedKey.startsWith(`${address}:`) && changed.month === month) days.set(changed.value.day, { reference: null, value: changed.value });
    }
    for (const [day, file] of [...days]) {
      if (nextDayInstant(day) <= retentionLowerBound) {
        days.delete(day);
      }
    }
    if (days.size === 0) {
      nextMonthValues.set(key, null);
      continue;
    }
    const orderedDays = [...days.values()].sort((left, right) => left.value.day.localeCompare(right.value.day));
    for (const file of orderedDays) {
      if (file.reference !== null) continue;
      addDataMember(month, encodeMarketDataLogicalFile(
        baseDayLogicalId(address, file.value.day),
        file.value,
        configuration,
      ));
    }
    const coverage = combinedCoverage(orderedDays.map((file) => file.value));
    const resolutionDays = new Map(orderedDays.map((file) => [file.value.day, file]));
    const following = await loadMonth(address, nextMonth(month));
    for (const [day, file] of following.days) resolutionDays.set(day, file);
    for (const [changedKey, changed] of changedDays) {
      if (changedKey.startsWith(`${address}:`) && changed.month === nextMonth(month)) {
        resolutionDays.set(changed.value.day, { reference: null, value: changed.value });
      }
    }
    for (const [day] of resolutionDays) {
      if (nextDayInstant(day) <= retentionLowerBound) resolutionDays.delete(day);
    }
    const orderedResolutionDays = [...resolutionDays.values()].sort((left, right) => left.value.day.localeCompare(right.value.day));
    const resolutionCoverage = combinedCoverage(orderedResolutionDays.map((file) => file.value));
    const resolutionCandles = orderedResolutionDays.flatMap((file) => file.value.candles);
    for (const definition of candleResolutionCatalog.slice(1)) {
      const value = createBaseResolutionFile({
        baseCurrencyAddress: address,
        candles: resolutionCandles,
        coverage: resolutionCoverage,
        intervalSeconds: definition.intervalSeconds,
        ownerMonth: month,
      });
      const encoded = encodeMarketDataLogicalFile(
        baseResolutionLogicalId(address, definition.label, month),
        value,
        configuration,
      );
      if (!sameEncoded(loaded.owner?.value.resolutions[definition.label], encoded)) addDataMember(month, encoded);
    }
    nextMonthValues.set(key, { coverage, days: orderedDays, loaded });
  }

  const releaseUsage = new Map();
  const dataAssets = await packDataMembersByMonth({ membersByMonth: dataMembersByMonth, releaseUsage, replayAssets, store });
  const dataReferences = referenceByLogicalId(dataAssets);
  const monthMembers = [];
  for (const [key, candidate] of nextMonthValues) {
    if (candidate === null) continue;
    const separator = key.indexOf(":");
    const address = key.slice(0, separator);
    const month = key.slice(separator + 1);
    const dayReferences = candidate.days.map((file) => (
      file.reference ?? dataReferences.get(baseDayLogicalId(address, file.value.day))
    ));
    const resolutions = Object.fromEntries(candleResolutionCatalog.slice(1).map((definition) => {
      const logicalId = baseResolutionLogicalId(address, definition.label, month);
      return [definition.label, dataReferences.get(logicalId) ?? candidate.loaded.owner?.value.resolutions[definition.label]];
    }));
    const value = validateBaseMonthFile({
      baseCurrencyAddress: address,
      coverage: candidate.coverage,
      days: dayReferences,
      month,
      resolutions,
    });
    const encoded = encodeMarketDataLogicalFile(baseMonthLogicalId(address, month), value, configuration);
    if (sameEncoded(candidate.loaded.owner?.reference, encoded)) nextMonthValues.set(key, { ...candidate, reference: candidate.loaded.owner.reference, value });
    else {
      monthMembers.push(encoded);
      nextMonthValues.set(key, { ...candidate, reference: null, value });
    }
  }

  const monthAssets = await packIndexMembers({ members: monthMembers, releaseUsage, replayAssets, store });
  const monthReferences = referenceByLogicalId(monthAssets);
  const stateMembers = [];
  const nextStateValues = new Map();
  for (const [address, state] of stateValues) {
    const previousState = selected.baseStates[address] ?? null;
    const previousMonths = previousState?.months ?? [];
    const months = [];
    for (const reference of previousMonths) {
      const identity = parseMarketDataLogicalId(reference.logicalId);
      if (nextMonthInstant(identity.period) <= retentionLowerBound) {
        continue;
      }
      const changed = nextMonthValues.get(`${address}:${identity.period}`);
      if (changed === null) continue;
      months.push(changed === undefined
        ? reference
        : changed.reference ?? monthReferences.get(baseMonthLogicalId(address, identity.period)));
    }
    for (const [key, changed] of nextMonthValues) {
      if (!key.startsWith(`${address}:`) || changed === null) continue;
      const month = key.slice(key.indexOf(":") + 1);
      if (previousMonths.some((reference) => parseMarketDataLogicalId(reference.logicalId).period === month)) continue;
      months.push(changed.reference ?? monthReferences.get(baseMonthLogicalId(address, month)));
    }
    months.sort((left, right) => left.logicalId.localeCompare(right.logicalId));
    const value = validateBaseStateFile({ ...state, months }, configuration);
    nextStateValues.set(address, value);
    const encoded = encodeMarketDataLogicalFile(baseStateLogicalId(address), value, configuration);
    const previousReference = selected.root.baseCurrencies[address];
    if (!sameEncoded(previousReference, encoded)) stateMembers.push(encoded);
  }

  const stateAssets = await packIndexMembers({ members: stateMembers, releaseUsage, replayAssets, store });
  const stateReferences = referenceByLogicalId(stateAssets);
  const packedAssets = Object.freeze([...dataAssets, ...monthAssets, ...stateAssets]);
  const logical = logicalTransition({
    changedMonths: [...changedMonths].map((key) => {
      const separator = key.indexOf(":");
      return baseMonthLogicalId(key.slice(0, separator), key.slice(separator + 1));
    }),
    collectionDays,
    removals,
    replacements: [
      ...[...dataMembersByMonth.values()].flatMap((members) => members),
      ...monthMembers,
      ...stateMembers,
    ],
    verificationMonths: [...verificationMonths].map((key) => {
      const separator = key.indexOf(":");
      return baseMonthLogicalId(key.slice(0, separator), key.slice(separator + 1));
    }),
  });
  if (logical.replacements.length === 0 && logical.removals.length === 0) return Object.freeze({ status: "unchanged" });
  const transition = membershipTransitionFromLogical(logical, previousLogicalAssets);
  validateMembershipTransitionAgainstLogical(logical, transition);
  const membership = applyAssetMembershipTransition({
    packedAssets,
    previousAssets: selected.root.assets,
    transition,
  });
  const root = validateSelectedRoot({
    assets: membership.nextAssets,
    baseCurrencies: Object.fromEntries([...nextStateValues].map(([address]) => [
      address,
      stateReferences.get(baseStateLogicalId(address)) ?? selected.root.baseCurrencies[address],
    ])),
    currentUntil: nextCurrentUntil,
    poolManager: configuration.poolManager,
    publicationSequence: selected.root.publicationSequence + 1,
    resolutions: candleResolutionCatalog,
    usdgAddress: configuration.usdgAddress,
    usdgDecimals: configuration.usdgDecimals,
  }, configuration);
  const encodedRoot = encodeArtifact(root);
  const nextRoot = rootAssetIdentity(root.publicationSequence, encodedRoot.gzipBytes);
  const publicationRecord = validatePublicationRecord({
    configurationSha256: admittedConfiguration.sha256,
    finalizedBlock: collectionResult.finalizedBlock,
    newAssets: membership.newAssets,
    nextRoot,
    phase: collectionResult.phase,
    previousAssets: selected.root.assets,
    previousRoot: selected.identity,
    ranges: collectionResult.ranges,
    supersededAssets: Object.freeze(sortedIdentities([...membership.supersededAssets, selected.identity])),
    target: collectionResult.target,
  });
  const encodedPublicationRecord = encodeArtifact(publicationRecord);
  if (encodedRoot.gzipBytes.byteLength > maximumMarketDataAssetBytes || encodedPublicationRecord.gzipBytes.byteLength > maximumMarketDataAssetBytes) {
    throw new Error("Root or publication record exceeds the physical asset boundary.");
  }
  return Object.freeze({
    encodedPublicationRecord,
    encodedRoot,
    logicalTransition: logical,
    membershipTransition: transition,
    packedAssets,
    publicationRecord,
    root,
    status: "recording",
  });
}

function sortedIdentities(values) {
  return [...values].sort((left, right) => left.sha256.localeCompare(right.sha256));
}
