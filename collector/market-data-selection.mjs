import { canonicalBytes } from "./canonical.mjs";
import { parseMarketDataLogicalId } from "./market-data-file-identity.mjs";
import { mergeAdjacentCoverage, validateCoverageSequence, validateSelectedRoot } from "./market-data-files.mjs";
import { sharedCollectionSliceSeconds, validateSharedCollectionState } from "./shared-collection-plan.mjs";
import { StoredDataIntegrityError } from "../storage/storage-error.mjs";
import { parseUtcInstant, subtractUtcCalendarMonths } from "./utc-time.mjs";

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

export function selectedLogicalAssetMap(assets) {
  return new Map(assets.flatMap((asset) => asset.logicalIds.map((logicalId) => [logicalId, asset.sha256])));
}

export function changedLogicalIds(previousAssets, nextAssets) {
  const previous = selectedLogicalAssetMap(previousAssets);
  const next = selectedLogicalAssetMap(nextAssets);
  return Object.freeze([...new Set([...previous.keys(), ...next.keys()])]
    .filter((logicalId) => previous.get(logicalId) !== next.get(logicalId))
    .sort());
}

export async function expandChangedReferenceClosure({
  changedLogicalIds: initial,
  nextRoot,
  previousRoot,
  readNext,
  readPrevious,
}) {
  if (!Array.isArray(initial) || typeof readNext !== "function" || typeof readPrevious !== "function") {
    throw new StoredDataIntegrityError();
  }
  const differences = (previous, next) => {
    const left = new Map((previous ?? []).map((reference) => [reference.logicalId, reference]));
    const right = new Map((next ?? []).map((reference) => [reference.logicalId, reference]));
    return [...new Set([...left.keys(), ...right.keys()])].filter((logicalId) => (
      !sameValue(left.get(logicalId) ?? null, right.get(logicalId) ?? null)
    ));
  };
  const resolveParent = async (root, logicalId, readValue) => {
    if (root === null) return null;
    const identity = parseMarketDataLogicalId(logicalId);
    if (identity.kind === "state") return root.baseCurrencies[identity.baseCurrencyAddress] ?? null;
    if (identity.kind !== "month") throw new StoredDataIntegrityError();
    const stateReference = root.baseCurrencies[identity.baseCurrencyAddress];
    if (stateReference === undefined) return null;
    const state = await readValue(stateReference);
    return state?.months.find((reference) => reference.logicalId === logicalId) ?? null;
  };
  const changed = new Set();
  const queue = [];
  const queued = new Set();
  const add = (logicalId) => {
    changed.add(logicalId);
    const kind = parseMarketDataLogicalId(logicalId).kind;
    if ((kind === "state" || kind === "month") && !queued.has(logicalId)) {
      queued.add(logicalId);
      queue.push(logicalId);
    }
  };
  for (const logicalId of initial) add(logicalId);
  while (queue.length > 0) {
    const logicalId = queue.shift();
    const identity = parseMarketDataLogicalId(logicalId);
    const previousReference = await resolveParent(previousRoot, logicalId, readPrevious);
    const nextReference = await resolveParent(nextRoot, logicalId, readNext);
    const previousValue = previousReference === null ? null : await readPrevious(previousReference);
    const nextValue = nextReference === null ? null : await readNext(nextReference);
    const previousChildren = identity.kind === "state"
      ? previousValue?.months
      : previousValue === null ? [] : [...previousValue.days, ...Object.values(previousValue.resolutions)];
    const nextChildren = identity.kind === "state"
      ? nextValue?.months
      : nextValue === null ? [] : [...nextValue.days, ...Object.values(nextValue.resolutions)];
    for (const child of differences(previousChildren, nextChildren)) add(child);
  }
  return Object.freeze([...changed].sort());
}

export function validateCoverageSubsetProvenance(recordedCoverage, poolPeriods) {
  validateCoverageSequence(recordedCoverage, "Recorded file coverage");
  validateCoverageSequence(poolPeriods, "Base-state PoolId periods");
  const selectedFrom = poolPeriods[0];
  for (const segment of recordedCoverage) {
    const beforeTime = segment.untilTimestamp <= selectedFrom.fromTimestamp;
    const beforeBlock = BigInt(segment.untilBlock) <= BigInt(selectedFrom.fromBlock);
    if (beforeTime || beforeBlock) {
      if (beforeTime !== beforeBlock) throw new StoredDataIntegrityError();
      continue;
    }
    const matches = poolPeriods.filter((period) => (
      period.poolId === segment.poolId
      && period.fromTimestamp <= segment.fromTimestamp
      && period.untilTimestamp >= segment.untilTimestamp
      && BigInt(period.fromBlock) <= BigInt(segment.fromBlock)
      && BigInt(period.untilBlock) >= BigInt(segment.untilBlock)
    ));
    if (matches.length !== 1) throw new StoredDataIntegrityError();
  }
  return recordedCoverage;
}

function validateRetentionStateBoundary(poolPeriods, retentionLowerBound) {
  validateCoverageSequence(poolPeriods, "Base-state PoolId periods");
  parseUtcInstant(retentionLowerBound, "Retention lower bound", true);
  const earliestRetainedDay = `${retentionLowerBound.slice(0, 10)}T00:00:00.000Z`;
  const fromTimestamp = poolPeriods[0].fromTimestamp;
  if (fromTimestamp < earliestRetainedDay) throw new StoredDataIntegrityError();
  if (fromTimestamp < retentionLowerBound) {
    const prefixMilliseconds = Date.parse(retentionLowerBound) - Date.parse(fromTimestamp);
    if (prefixMilliseconds <= 0 || prefixMilliseconds >= sharedCollectionSliceSeconds * 1_000) {
      throw new StoredDataIntegrityError();
    }
  }
  return poolPeriods;
}

export function validateRecordedCoverageProvenance(recordedCoverage, poolPeriods, retentionLowerBound) {
  validateCoverageSequence(recordedCoverage, "Recorded file coverage");
  validateRetentionStateBoundary(poolPeriods, retentionLowerBound);
  validateCoverageSubsetProvenance(recordedCoverage, poolPeriods);
  const earliestRetainedDay = `${retentionLowerBound.slice(0, 10)}T00:00:00.000Z`;
  if (recordedCoverage[0].fromTimestamp < earliestRetainedDay) throw new StoredDataIntegrityError();
  const first = poolPeriods[0];
  const selectedStart = recordedCoverage.findIndex((segment) => (
    segment.fromTimestamp === first.fromTimestamp && segment.fromBlock === first.fromBlock
  ));
  if (selectedStart === -1 || !sameValue(mergeAdjacentCoverage(recordedCoverage.slice(selectedStart)), poolPeriods)) {
    throw new StoredDataIntegrityError();
  }
  return poolPeriods;
}

export function validateSelectionStateProjection({ baseStates, configuration, root }) {
  const projection = validateSharedCollectionState({
    baseCurrencies: Object.fromEntries(Object.entries(baseStates).map(([address, state]) => [address, {
      decimals: state.decimals,
      poolPeriods: state.poolPeriods,
      pools: state.pools,
    }])),
    currentUntil: root.currentUntil,
    poolManager: root.poolManager,
    usdgAddress: root.usdgAddress,
    usdgDecimals: root.usdgDecimals,
  }, configuration);
  const retentionLowerBound = subtractUtcCalendarMonths(root.currentUntil.timestamp, 12);
  for (const state of Object.values(projection.baseCurrencies)) {
    validateRetentionStateBoundary(state.poolPeriods, retentionLowerBound);
  }
  return projection;
}

export async function validateMarketDataSelectionClosure({
  changedLogicalIds: changed,
  configuration,
  readLogicalFile,
  root,
}) {
  validateSelectedRoot(root, configuration);
  if (!Array.isArray(changed) || typeof readLogicalFile !== "function") throw new StoredDataIntegrityError();
  const membership = selectedLogicalAssetMap(root.assets);
  const inspected = new Set(changed);
  for (const logicalId of changed) parseMarketDataLogicalId(logicalId);

  const values = new Map();
  const references = new Map();
  const requireMembership = (reference) => {
    if (membership.get(reference.logicalId) !== reference.assetSha256) throw new StoredDataIntegrityError();
  };
  const load = async (reference) => {
    const known = references.get(reference.logicalId);
    if (known !== undefined) {
      if (!sameValue(known, reference)) throw new StoredDataIntegrityError();
      return values.get(reference.logicalId);
    }
    requireMembership(reference);
    const value = await readLogicalFile(reference);
    references.set(reference.logicalId, reference);
    values.set(reference.logicalId, value);
    const identity = parseMarketDataLogicalId(reference.logicalId);
    if (identity.kind === "state") {
      for (const child of value.months) requireMembership(child);
    } else if (identity.kind === "month") {
      for (const child of value.days) requireMembership(child);
      for (const child of Object.values(value.resolutions)) requireMembership(child);
    }
    return value;
  };
  const resolve = async (logicalId) => {
    const identity = parseMarketDataLogicalId(logicalId);
    if (identity.kind === "state") return root.baseCurrencies[identity.baseCurrencyAddress] ?? null;
    const stateReference = root.baseCurrencies[identity.baseCurrencyAddress];
    if (stateReference === undefined) return null;
    const state = await load(stateReference);
    if (identity.kind === "month") {
      return state.months.find((reference) => reference.logicalId === logicalId) ?? null;
    }
    const month = identity.kind === "day" ? identity.period.slice(0, 7) : identity.period;
    const monthReference = state.months.find((reference) => (
      parseMarketDataLogicalId(reference.logicalId).period === month
    ));
    if (monthReference === undefined) return null;
    const owner = await load(monthReference);
    return identity.kind === "day"
      ? owner.days.find((reference) => reference.logicalId === logicalId) ?? null
      : owner.resolutions[identity.resolution] ?? null;
  };

  for (const logicalId of [...inspected].sort()) {
    const identity = parseMarketDataLogicalId(logicalId);
    const expectedAsset = membership.get(logicalId);
    const reference = await resolve(logicalId);
    if (expectedAsset === undefined) {
      if (identity.kind === "state" || reference !== null) throw new StoredDataIntegrityError();
      continue;
    }
    if (reference === null || reference.assetSha256 !== expectedAsset) throw new StoredDataIntegrityError();
    await load(reference);
  }
  return Object.freeze({ references, values });
}
