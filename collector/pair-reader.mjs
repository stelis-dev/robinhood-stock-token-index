import { canonicalBytes } from "./canonical.mjs";
import {
  createResolutionArtifacts,
  resolutionDefinition,
} from "./candle-resolution.mjs";
import {
  decodePairDayFile,
  decodePairMonthFile,
  decodePairStateFile,
  decodeResolutionArtifact,
  validateSelectedPairMonth,
} from "./pair-files.mjs";
import {
  validatePairCandleSequence,
} from "./pair-candle.mjs";
import { pairMonthLogicalId } from "./pair-file-identity.mjs";
import { pairById } from "./pair-registry.mjs";
import { validateUtcMonth } from "./utc-time.mjs";
import { createStateIdentity, StoredDataIntegrityError } from "../storage/stored-files.mjs";

function validateStoredData(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function exactReference(references, logicalId) {
  const reference = references.find((candidate) => candidate.logicalId === logicalId);
  if (reference === undefined) throw new StoredDataIntegrityError();
  return reference;
}

function resolutionProjection(definition) {
  return {
    label: definition.label,
    intervalSeconds: definition.intervalSeconds,
  };
}

export async function readPairStateSelection({ registry, pairId, store }) {
  pairById(registry, pairId);
  const selected = await store.readSelectedState(pairId);
  if (selected === null) return null;
  return validateStoredData(() => {
    if (selected === undefined || !Number.isSafeInteger(selected.sequence) || !Buffer.isBuffer(selected.gzipBytes)) {
      throw new StoredDataIntegrityError();
    }
    const state = decodePairStateFile(selected.gzipBytes, { registry }, pairId);
    if (state.sequence !== selected.sequence) throw new StoredDataIntegrityError();
    return {
      state,
      identity: createStateIdentity(selected.sequence, selected.gzipBytes, registry.collection.maximumArtifactBytes),
      gzipBytes: selected.gzipBytes,
    };
  });
}

export async function readPairMonth({ registry, store, reference }) {
  const bytes = await store.readReferenced(reference);
  return validateStoredData(() => decodePairMonthFile(bytes, { registry }, reference));
}

export async function readPairDay({ registry, store, reference }) {
  const bytes = await store.readReferenced(reference);
  return validateStoredData(() => decodePairDayFile(bytes, { registry }, reference));
}

export async function readPairResolution({ registry, store, reference }) {
  const bytes = await store.readReferenced(reference);
  return validateStoredData(() => decodeResolutionArtifact(bytes, { registry }, reference));
}

async function loadSelectedMonth({ registry, state, store, reference }) {
  const month = await readPairMonth({ registry, store, reference });
  validateStoredData(() => validateSelectedPairMonth({ state, month }, { registry }));
  const days = [];
  let previousCandle = null;
  for (const dayReference of month.days) {
    const value = await readPairDay({ registry, store, reference: dayReference });
    if (previousCandle !== null && value.candles.length > 0) {
      validateStoredData(() => validatePairCandleSequence([previousCandle, value.candles[0]]));
    }
    if (value.candles.length > 0) previousCandle = value.candles.at(-1);
    days.push({ reference: dayReference, value });
  }
  return { reference, value: month, days };
}

export async function readPairMonthResolution({
  registry,
  pairId,
  ownerMonth,
  resolution,
  store,
}) {
  const pair = pairById(registry, pairId).pair;
  const monthId = validateUtcMonth(ownerMonth, "read owner month");
  const definition = resolutionDefinition(resolution);
  const selected = await readPairStateSelection({ registry, pairId, store });
  const base = {
    pairId,
    ownerMonth: monthId,
    resolution: resolutionProjection(definition),
  };
  if (selected === null) return { status: "empty", ...base };
  const selectedState = selected.identity;
  const stateFields = {
    selectedState,
    stateCoverage: selected.state.coverage,
    catalog: selected.state.resolutions,
  };
  const monthReference = selected.state.months.find((reference) => (
    reference.logicalId === pairMonthLogicalId(pair.pairId, monthId)
  ));
  if (monthReference === undefined) {
    return { status: "absent", reason: "month_not_selected", ...base, ...stateFields };
  }
  const month = await readPairMonth({ registry, store, reference: monthReference });
  validateStoredData(() => validateSelectedPairMonth({ state: selected.state, month }, { registry }));
  if (definition.intervalSeconds === 60) {
    const files = [];
    let previousCandle = null;
    for (const reference of month.days) {
      const value = await readPairDay({ registry, store, reference });
      if (previousCandle !== null && value.candles.length > 0) {
        validateStoredData(() => validatePairCandleSequence([previousCandle, value.candles[0]]));
      }
      if (value.candles.length > 0) previousCandle = value.candles.at(-1);
      files.push({ reference, value });
    }
    return {
      status: "read",
      ...base,
      ...stateFields,
      monthReference,
      coverage: month.coverage,
      files,
    };
  }
  const reference = month.resolutions.find((candidate) => (
    candidate.intervalSeconds === definition.intervalSeconds
  ));
  if (reference === undefined) {
    return {
      status: "absent",
      reason: "resolution_not_published",
      ...base,
      ...stateFields,
      monthReference,
    };
  }
  const value = await readPairResolution({ registry, store, reference });
  return {
    status: "read",
    ...base,
    ...stateFields,
    monthReference,
    timeCoverage: value.timeCoverage,
    files: [{ reference, value }],
  };
}

export async function verifyPairIndex({ registry, pairId, store }) {
  const selected = await readPairStateSelection({ registry, pairId, store });
  if (selected === null) return { status: "empty", pairId };
  const state = selected.state;
  let carriedMonth = null;
  let previousCandle = null;
  let dayCount = 0;
  let sourceCandleCount = 0;
  let resolutionArtifactCount = 0;
  let resolutionCandleCount = 0;

  for (let index = 0; index < state.months.length; index += 1) {
    const reference = state.months[index];
    const owner = carriedMonth !== null && sameValue(carriedMonth.reference, reference)
      ? carriedMonth
      : await loadSelectedMonth({ registry, state, store, reference });
    carriedMonth = null;
    const ownerCandles = owner.days.flatMap(({ value }) => value.candles);
    const firstCandle = ownerCandles.at(0);
    if (previousCandle !== null && firstCandle !== undefined) {
      validateStoredData(() => validatePairCandleSequence([previousCandle, firstCandle]));
    }
    const lastCandle = ownerCandles.at(-1);
    if (lastCandle !== undefined) previousCandle = lastCandle;
    dayCount += owner.days.length;
    sourceCandleCount += ownerCandles.length;

    const resolutions = [];
    for (const resolutionReference of owner.value.resolutions) {
      resolutions.push(await readPairResolution({ registry, store, reference: resolutionReference }));
    }
    if (resolutions.length > 0) {
      const sourceMonths = [owner];
      for (const logicalId of owner.value.sourceMonths.slice(1)) {
        const sourceReference = exactReference(state.months, logicalId);
        const sourceMonth = carriedMonth !== null && sameValue(carriedMonth.reference, sourceReference)
          ? carriedMonth
          : await loadSelectedMonth({ registry, state, store, reference: sourceReference });
        carriedMonth = sourceMonth;
        sourceMonths.push(sourceMonth);
      }
      const sourceDays = sourceMonths.flatMap((month) => month.days);
      const expected = createResolutionArtifacts({
        registry,
        pair: state.pair,
        sourceCoverage: {
          fromBlock: sourceDays[0].reference.coverage.fromBlock,
          fromTimestamp: sourceDays[0].reference.coverage.fromTimestamp,
          untilBlock: sourceDays.at(-1).reference.coverage.untilBlock,
          untilTimestamp: sourceDays.at(-1).reference.coverage.untilTimestamp,
        },
        candles: sourceDays.flatMap((day) => day.value.candles),
        requests: resolutions.map((resolution) => ({
          sequence: resolution.sequence,
          ownerMonth: resolution.ownerMonth,
          intervalSeconds: resolution.intervalSeconds,
          fromTimestamp: resolution.timeCoverage.fromTimestamp,
          untilTimestamp: resolution.timeCoverage.untilTimestamp,
        })),
      });
      for (let resolutionIndex = 0; resolutionIndex < resolutions.length; resolutionIndex += 1) {
        if (expected[resolutionIndex].artifact === null || !sameValue(expected[resolutionIndex].artifact, resolutions[resolutionIndex])) {
          throw new StoredDataIntegrityError();
        }
      }
    }
    for (const resolution of resolutions) {
      resolutionArtifactCount += 1;
      resolutionCandleCount += resolution.candles.length;
    }
  }

  return {
    status: "verified",
    pairId,
    selectedState: selected.identity,
    catalog: state.resolutions,
    coverage: state.coverage,
    monthCount: state.months.length,
    dayCount,
    sourceCandleCount,
    resolutionArtifactCount,
    resolutionCandleCount,
  };
}
