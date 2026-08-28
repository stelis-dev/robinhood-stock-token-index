import { canonicalBytes } from "./canonical.mjs";
import { candleResolutionCatalog } from "./candle-resolution.mjs";
import { createBaseResolutionFile } from "./market-data-files.mjs";
import { createMarketDataReader } from "./market-data-reader.mjs";
import { maximumMarketDataAssetBytes } from "./market-data-assets.mjs";
import { parseMarketDataLogicalId } from "./market-data-file-identity.mjs";
import {
  selectedLogicalAssetMap,
  validateCoverageSubsetProvenance,
  validateRecordedCoverageProvenance,
} from "./market-data-selection.mjs";
import { StoredDataIntegrityError } from "../storage/storage-error.mjs";
import { subtractUtcCalendarMonths } from "./utc-time.mjs";

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function combinedCoverage(days) {
  return days.flatMap((day) => day.coverage).sort((left, right) => (
    left.fromTimestamp.localeCompare(right.fromTimestamp)
    || left.untilTimestamp.localeCompare(right.untilTimestamp)
  ));
}

function nextMonth(month) {
  const value = new Date(`${month}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 7);
}

function integrity(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}

async function verifyLoadedMonth({ address, following, loaded, readResolution }) {
  const month = parseMarketDataLogicalId(loaded.owner.reference.logicalId).period;
  const monthCoverage = combinedCoverage(loaded.days);
  if (!sameValue(monthCoverage, loaded.owner.value.coverage)) throw new StoredDataIntegrityError();
  const sourceDays = following === null ? loaded.days : [...loaded.days, ...following.days];
  const sourceCoverage = combinedCoverage(sourceDays);
  const sourceCandles = sourceDays.flatMap((day) => day.candles);
  let resolutionCount = 0;
  for (const definition of candleResolutionCatalog.slice(1)) {
    const reference = loaded.owner.value.resolutions[definition.label];
    const stored = await readResolution(reference);
    const derived = integrity(() => createBaseResolutionFile({
      baseCurrencyAddress: address,
      candles: sourceCandles,
      coverage: sourceCoverage,
      intervalSeconds: definition.intervalSeconds,
      ownerMonth: month,
    }));
    if (!sameValue(stored, derived)) throw new StoredDataIntegrityError();
    resolutionCount += 1;
  }
  return Object.freeze({ monthCoverage, resolutionCount });
}

export async function verifyMarketDataMonths({ months, baseStates, readLogicalFile }) {
  if (!Array.isArray(months) || baseStates === null || typeof baseStates !== "object" || typeof readLogicalFile !== "function") {
    throw new StoredDataIntegrityError();
  }
  const cache = new Map();
  const load = async (reference) => {
    if (cache.has(reference.logicalId)) return cache.get(reference.logicalId);
    const owner = Object.freeze({ reference, value: await readLogicalFile(reference) });
    const days = [];
    for (const dayReference of owner.value.days) days.push(await readLogicalFile(dayReference));
    const loaded = Object.freeze({ owner, days: Object.freeze(days) });
    cache.set(reference.logicalId, loaded);
    return loaded;
  };
  for (const logicalId of months) {
    const identity = parseMarketDataLogicalId(logicalId);
    if (identity.kind !== "month") throw new StoredDataIntegrityError();
    const state = baseStates[identity.baseCurrencyAddress];
    if (state === undefined) throw new StoredDataIntegrityError();
    const monthReferences = new Map(state.months.map((reference) => [
      parseMarketDataLogicalId(reference.logicalId).period,
      reference,
    ]));
    const reference = monthReferences.get(identity.period);
    if (reference === undefined) continue;
    const loaded = await load(reference);
    const followingReference = monthReferences.get(nextMonth(identity.period));
    const following = followingReference === undefined ? null : await load(followingReference);
    const verified = await verifyLoadedMonth({
      address: identity.baseCurrencyAddress,
      following,
      loaded,
      readResolution: readLogicalFile,
    });
    validateCoverageSubsetProvenance(verified.monthCoverage, state.poolPeriods);
    const selectedFrom = state.poolPeriods[0];
    if (
      verified.monthCoverage[0].fromTimestamp <= selectedFrom.fromTimestamp
      && verified.monthCoverage.at(-1).untilTimestamp > selectedFrom.fromTimestamp
      && !verified.monthCoverage.some((segment) => (
        segment.fromTimestamp === selectedFrom.fromTimestamp
        && segment.fromBlock === selectedFrom.fromBlock
      ))
    ) throw new StoredDataIntegrityError();
  }
}

export async function verifyMarketDataRecording({ admittedConfiguration, store }) {
  const marketDataReader = createMarketDataReader({
    configuration: admittedConfiguration.configuration,
    maximumBytes: maximumMarketDataAssetBytes,
    store,
  });
  const selected = await marketDataReader.selection();
  if (selected === null) return Object.freeze({ status: "unpublished" });
  const retentionLowerBound = subtractUtcCalendarMonths(selected.root.currentUntil.timestamp, 12);
  const remaining = selectedLogicalAssetMap(selected.root.assets);
  const reached = new Set();
  function consume(reference) {
    if (reached.has(reference.logicalId) || remaining.get(reference.logicalId) !== reference.assetSha256) {
      throw new StoredDataIntegrityError();
    }
    reached.add(reference.logicalId);
    remaining.delete(reference.logicalId);
  }
  async function loadMonth(reference) {
    consume(reference);
    const owner = Object.freeze({
      reference,
      value: await marketDataReader.readLogicalMember(selected.root, reference),
    });
    const days = [];
    for (const reference of owner.value.days) {
      consume(reference);
      days.push(await marketDataReader.readLogicalMember(selected.root, reference));
    }
    return Object.freeze({ owner, days: Object.freeze(days) });
  }

  let dayCount = 0;
  let resolutionCount = 0;
  for (const [address, state] of Object.entries(selected.baseStates)) {
    consume(selected.root.baseCurrencies[address]);
    const recordedCoverage = [];
    const monthReferences = new Map(state.months.map((reference) => [
      parseMarketDataLogicalId(reference.logicalId).period,
      reference,
    ]));
    let carried = null;
    for (const monthReference of state.months) {
      const month = parseMarketDataLogicalId(monthReference.logicalId).period;
      const loaded = carried !== null && sameValue(carried.owner.reference, monthReference)
        ? carried
        : await loadMonth(monthReference);
      dayCount += loaded.days.length;
      const followingReference = monthReferences.get(nextMonth(month));
      const following = followingReference === undefined ? null : await loadMonth(followingReference);
      const verified = await verifyLoadedMonth({
        address,
        following,
        loaded,
        readResolution: async (reference) => {
          consume(reference);
          return marketDataReader.readLogicalMember(selected.root, reference);
        },
      });
      recordedCoverage.push(...verified.monthCoverage);
      resolutionCount += verified.resolutionCount;
      carried = following;
    }
    validateRecordedCoverageProvenance(recordedCoverage, state.poolPeriods, retentionLowerBound);
  }
  if (remaining.size !== 0) throw new StoredDataIntegrityError();
  return Object.freeze({
    baseCurrencyCount: Object.keys(selected.baseStates).length,
    dayCount,
    publicationSequence: selected.root.publicationSequence,
    resolutionCount,
    root: selected.identity,
    status: "verified",
  });
}
