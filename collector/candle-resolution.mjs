import { canonicalBytes } from "./canonical.mjs";
import {
  validateCandleSwapSpan,
  validatePairCandleSequence,
  validatePairCoverage,
  validateRational,
  validateSwapPositionOrder,
} from "./pair-candle.mjs";
import { validateRegisteredPairDescriptor } from "./pair-registry.mjs";
import { compareRational } from "./swap.mjs";
import {
  admitSwapPositionIdentity,
  compareSwapPosition,
  createSwapPositionIdentities,
} from "./swap-position.mjs";
import { parseUtcInstant, validateUtcMonth } from "./utc-time.mjs";
const unsignedDecimalPattern = /^(?:0|[1-9][0-9]*)$/;

export const candleResolutionCatalog = Object.freeze([
  Object.freeze({ label: "1m", intervalSeconds: 60, partition: "day" }),
  Object.freeze({ label: "15m", intervalSeconds: 900, partition: "month" }),
  Object.freeze({ label: "30m", intervalSeconds: 1_800, partition: "month" }),
  Object.freeze({ label: "1h", intervalSeconds: 3_600, partition: "month" }),
  Object.freeze({ label: "2h", intervalSeconds: 7_200, partition: "month" }),
  Object.freeze({ label: "4h", intervalSeconds: 14_400, partition: "month" }),
  Object.freeze({ label: "6h", intervalSeconds: 21_600, partition: "month" }),
  Object.freeze({ label: "12h", intervalSeconds: 43_200, partition: "month" }),
  Object.freeze({ label: "1d", intervalSeconds: 86_400, partition: "month" }),
  Object.freeze({ label: "2d", intervalSeconds: 172_800, partition: "month" }),
]);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function unsignedDecimal(value, label, positive = false) {
  if (typeof value !== "string" || !unsignedDecimalPattern.test(value)) throw new Error(`${label} is not a canonical unsigned decimal string.`);
  const parsed = BigInt(value);
  if (positive && parsed === 0n) throw new Error(`${label} must be positive.`);
  return parsed;
}

export function resolutionMonthBounds(value) {
  const ownerMonth = validateUtcMonth(value, "resolution owner month");
  const fromTimestamp = `${ownerMonth}-01T00:00:00.000Z`;
  const until = new Date(fromTimestamp);
  until.setUTCMonth(until.getUTCMonth() + 1);
  return { fromTimestamp, untilTimestamp: until.toISOString() };
}

export function validateResolutionCatalog(value) {
  if (!canonicalBytes(value).equals(canonicalBytes(candleResolutionCatalog))) {
    throw new Error("Candle resolution catalog is invalid.");
  }
  return value;
}

export function resolutionDefinition(value, { derivedOnly = false } = {}) {
  const definition = typeof value === "string"
    ? candleResolutionCatalog.find((entry) => entry.label === value)
    : candleResolutionCatalog.find((entry) => entry.intervalSeconds === value);
  if (definition === undefined || derivedOnly && definition.intervalSeconds === 60) {
    throw new Error("Candle resolution is invalid.");
  }
  return definition;
}

export function affectedResolutionOwnerMonths({ fromTimestamp, untilTimestamp, intervalSeconds }) {
  const definition = resolutionDefinition(intervalSeconds, { derivedOnly: true });
  const from = parseUtcInstant(fromTimestamp, "affected resolution range.fromTimestamp", true);
  const until = parseUtcInstant(untilTimestamp, "affected resolution range.untilTimestamp", true);
  if (from >= until) throw new Error("Affected resolution range is empty or inverted.");
  const intervalMilliseconds = definition.intervalSeconds * 1_000;
  const firstStart = Math.floor(from / intervalMilliseconds) * intervalMilliseconds;
  const lastStart = Math.floor((until - 1) / intervalMilliseconds) * intervalMilliseconds;
  const months = [];
  for (let start = firstStart; start <= lastStart; start += intervalMilliseconds) {
    const ownerMonth = new Date(start).toISOString().slice(0, 7);
    if (ownerMonth !== months.at(-1)) months.push(ownerMonth);
  }
  return months;
}

export function validateResolutionTimeCoverage(value, { intervalSeconds, ownerMonth } = {}) {
  const definition = resolutionDefinition(intervalSeconds, { derivedOnly: true });
  const monthValue = validateUtcMonth(ownerMonth, "resolution owner month");
  exactKeys(value, ["fromTimestamp", "untilTimestamp"], "resolution time coverage");
  const from = parseUtcInstant(value.fromTimestamp, "resolution coverage.fromTimestamp", true);
  const until = parseUtcInstant(value.untilTimestamp, "resolution coverage.untilTimestamp", true);
  const intervalMilliseconds = definition.intervalSeconds * 1_000;
  if (
    from >= until
    || from % intervalMilliseconds !== 0
    || until % intervalMilliseconds !== 0
    || value.fromTimestamp.slice(0, 7) !== monthValue
    || new Date(until - intervalMilliseconds).toISOString().slice(0, 7) !== monthValue
  ) {
    throw new Error("Resolution time coverage is invalid.");
  }
  return value;
}

export function resolutionTimeCoverageFromSource({
  fromTimestamp,
  untilTimestamp,
  ownerMonth,
  intervalSeconds,
}) {
  const definition = resolutionDefinition(intervalSeconds, { derivedOnly: true });
  const owner = validateUtcMonth(ownerMonth, "resolution owner month");
  const sourceFrom = parseUtcInstant(fromTimestamp, "resolution source.fromTimestamp", true);
  const sourceUntil = parseUtcInstant(untilTimestamp, "resolution source.untilTimestamp", true);
  if (sourceFrom >= sourceUntil) throw new Error("Resolution source range is empty or inverted.");
  const intervalMilliseconds = definition.intervalSeconds * 1_000;
  const monthBounds = resolutionMonthBounds(owner);
  const monthFrom = Date.parse(monthBounds.fromTimestamp);
  const monthUntil = Date.parse(monthBounds.untilTimestamp);
  const firstStart = Math.max(
    Math.ceil(sourceFrom / intervalMilliseconds) * intervalMilliseconds,
    Math.ceil(monthFrom / intervalMilliseconds) * intervalMilliseconds,
  );
  const lastStart = Math.min(
    Math.floor((sourceUntil - intervalMilliseconds) / intervalMilliseconds) * intervalMilliseconds,
    Math.ceil(monthUntil / intervalMilliseconds) * intervalMilliseconds - intervalMilliseconds,
  );
  if (lastStart < firstStart) return null;
  return validateResolutionTimeCoverage({
    fromTimestamp: new Date(firstStart).toISOString(),
    untilTimestamp: new Date(lastStart + intervalMilliseconds).toISOString(),
  }, { intervalSeconds: definition.intervalSeconds, ownerMonth: owner });
}

export function validateResolutionCandle(value, { intervalSeconds, ownerMonth, timeCoverage } = {}) {
  const definition = resolutionDefinition(intervalSeconds, { derivedOnly: true });
  const monthValue = validateUtcMonth(ownerMonth, "resolution owner month");
  exactKeys(value, [
    "baseVolumeRaw",
    "close",
    "firstSource",
    "high",
    "intervalEnd",
    "intervalStart",
    "lastSource",
    "low",
    "observedEnd",
    "observedStart",
    "open",
    "quoteVolumeRaw",
    "sourceCandleCount",
    "tradeCount",
  ], "resolution candle");
  const start = parseUtcInstant(value.intervalStart, "resolution candle.intervalStart", true);
  const end = parseUtcInstant(value.intervalEnd, "resolution candle.intervalEnd", true);
  const observedStart = parseUtcInstant(value.observedStart, "resolution candle.observedStart", true);
  const observedEnd = parseUtcInstant(value.observedEnd, "resolution candle.observedEnd", true);
  const intervalMilliseconds = definition.intervalSeconds * 1_000;
  if (
    end - start !== intervalMilliseconds
    || start % intervalMilliseconds !== 0
    || value.intervalStart.slice(0, 7) !== monthValue
    || observedStart < start
    || observedStart >= observedEnd
    || observedEnd > end
  ) {
    throw new Error("Resolution candle interval is invalid.");
  }
  if (timeCoverage !== undefined && (value.intervalStart < timeCoverage.fromTimestamp || value.intervalEnd > timeCoverage.untilTimestamp)) {
    throw new Error("Resolution candle is outside its time coverage.");
  }
  for (const key of ["open", "high", "low", "close"]) validateRational(value[key], `resolution candle.${key}`);
  if (
    compareRational(value.high, value.open) < 0
    || compareRational(value.high, value.close) < 0
    || compareRational(value.low, value.open) > 0
    || compareRational(value.low, value.close) > 0
    || compareRational(value.high, value.low) < 0
  ) {
    throw new Error("Resolution candle price bounds are invalid.");
  }
  unsignedDecimal(value.baseVolumeRaw, "resolution candle.baseVolumeRaw", true);
  unsignedDecimal(value.quoteVolumeRaw, "resolution candle.quoteVolumeRaw", true);
  const tradeCount = unsignedDecimal(value.tradeCount, "resolution candle.tradeCount", true);
  const sourceCandleCount = positiveInteger(value.sourceCandleCount, "resolution candle.sourceCandleCount");
  const observedMinutes = (observedEnd - observedStart) / 60_000;
  if (
    sourceCandleCount > definition.intervalSeconds / 60
    || sourceCandleCount > observedMinutes
    || tradeCount < BigInt(sourceCandleCount)
  ) {
    throw new Error("Resolution candle source count is inconsistent.");
  }
  validateCandleSwapSpan(value.firstSource, value.lastSource, tradeCount);
  return value;
}

export function validateResolutionCandleSequence(value, context) {
  if (!Array.isArray(value)) throw new Error("Resolution candles must be an array.");
  const identities = createSwapPositionIdentities();
  let previous;
  for (const candle of value) {
    validateResolutionCandle(candle, context);
    admitSwapPositionIdentity(candle.firstSource, identities, "Resolution candle sources");
    admitSwapPositionIdentity(candle.lastSource, identities, "Resolution candle sources");
    if (previous !== undefined) {
      if (candle.intervalStart <= previous.intervalStart) throw new Error("Resolution candles are duplicated or unordered.");
      validateSwapPositionOrder(
        previous.lastSource,
        candle.firstSource,
        "previous resolution candle.lastSource",
        "next resolution candle.firstSource",
        identities,
      );
      if (
        compareSwapPosition(previous.lastSource, candle.firstSource) >= 0
        || BigInt(previous.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)
      ) {
        throw new Error("Resolution candle source ranges overlap or are unordered.");
      }
    }
    previous = candle;
  }
  return value;
}

export function validateResolutionArtifact(value, { registry }) {
  exactKeys(value, [
    "candles",
    "intervalSeconds",
    "kind",
    "ownerMonth",
    "pair",
    "sequence",
    "timeCoverage",
  ], "resolution artifact");
  if (value.kind !== "pair_candle_resolution") {
    throw new Error("Resolution artifact identity is invalid.");
  }
  validateRegisteredPairDescriptor(value.pair, registry);
  positiveInteger(value.sequence, "resolution artifact sequence");
  const definition = resolutionDefinition(value.intervalSeconds, { derivedOnly: true });
  const ownerMonth = validateUtcMonth(value.ownerMonth, "resolution owner month");
  validateResolutionTimeCoverage(value.timeCoverage, {
    intervalSeconds: definition.intervalSeconds,
    ownerMonth,
  });
  validateResolutionCandleSequence(value.candles, {
    intervalSeconds: definition.intervalSeconds,
    ownerMonth,
    timeCoverage: value.timeCoverage,
  });
  const { fromTimestamp, untilTimestamp } = resolutionMonthBounds(ownerMonth);
  const maximumStarts = Math.ceil((Date.parse(untilTimestamp) - Date.parse(fromTimestamp)) / (definition.intervalSeconds * 1_000));
  if (value.candles.length > maximumStarts) throw new Error("Resolution artifact candle count is invalid.");
  return value;
}

export function createResolutionArtifacts({ registry, pair, sourceCoverage, candles, requests }) {
  const expectedPair = validateRegisteredPairDescriptor(pair, registry);
  validatePairCoverage(sourceCoverage, "resolution source coverage");
  const sourceFrom = Date.parse(sourceCoverage.fromTimestamp);
  const sourceUntil = Date.parse(sourceCoverage.untilTimestamp);
  if (!Array.isArray(candles) || candles.length > (sourceUntil - sourceFrom) / 60_000) {
    throw new Error("Resolution source candle count exceeds its coverage.");
  }
  validatePairCandleSequence(candles, { coverage: sourceCoverage });
  if (!Array.isArray(requests) || requests.length > candleResolutionCatalog.length - 1) {
    throw new Error("Resolution request count exceeds the fixed catalog.");
  }
  const identities = new Set();
  const maximumFollowingMilliseconds = resolutionDefinition("2d").intervalSeconds * 1_000;
  const prepared = requests.map((request, index) => {
    exactKeys(request, ["fromTimestamp", "intervalSeconds", "ownerMonth", "sequence", "untilTimestamp"], `resolution request[${index}]`);
    const definition = resolutionDefinition(request.intervalSeconds, { derivedOnly: true });
    const ownerMonth = validateUtcMonth(request.ownerMonth, "resolution owner month");
    const sequence = positiveInteger(request.sequence, "resolution request sequence");
    const from = parseUtcInstant(request.fromTimestamp, "resolution request.fromTimestamp", true);
    const until = parseUtcInstant(request.untilTimestamp, "resolution request.untilTimestamp", true);
    const monthBounds = resolutionMonthBounds(ownerMonth);
    if (
      from >= until
      || from < sourceFrom
      || until > sourceUntil
      || from < Date.parse(monthBounds.fromTimestamp)
      || until > Date.parse(monthBounds.untilTimestamp) + maximumFollowingMilliseconds
    ) {
      throw new Error("Resolution request escapes its admitted source or owner-month bound.");
    }
    const identity = `${ownerMonth}:${definition.intervalSeconds}`;
    if (identities.has(identity)) throw new Error("Resolution requests are duplicated.");
    identities.add(identity);
    const timeCoverage = resolutionTimeCoverageFromSource({
      fromTimestamp: request.fromTimestamp,
      untilTimestamp: request.untilTimestamp,
      ownerMonth,
      intervalSeconds: definition.intervalSeconds,
    });
    return {
      aggregates: new Map(),
      definition,
      firstStart: timeCoverage === null ? null : Date.parse(timeCoverage.fromTimestamp),
      lastEnd: timeCoverage === null ? null : Date.parse(timeCoverage.untilTimestamp),
      ownerMonth,
      sequence,
      timeCoverage,
    };
  });

  for (const candle of candles) {
    const candleStart = Date.parse(candle.intervalStart);
    for (const entry of prepared) {
      if (entry.timeCoverage === null) continue;
      const intervalMilliseconds = entry.definition.intervalSeconds * 1_000;
      const naturalStart = Math.floor(candleStart / intervalMilliseconds) * intervalMilliseconds;
      if (naturalStart < entry.firstStart || naturalStart >= entry.lastEnd) continue;
      const existing = entry.aggregates.get(naturalStart);
      if (existing === undefined) {
        entry.aggregates.set(naturalStart, {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          baseVolumeRaw: BigInt(candle.baseVolumeRaw),
          quoteVolumeRaw: BigInt(candle.quoteVolumeRaw),
          tradeCount: BigInt(candle.tradeCount),
          firstSource: candle.firstSource,
          lastSource: candle.lastSource,
          observedStart: candle.intervalStart,
          observedEnd: candle.intervalEnd,
          sourceCandleCount: 1,
        });
        continue;
      }
      if (compareRational(candle.high, existing.high) > 0) existing.high = candle.high;
      if (compareRational(candle.low, existing.low) < 0) existing.low = candle.low;
      existing.close = candle.close;
      existing.baseVolumeRaw += BigInt(candle.baseVolumeRaw);
      existing.quoteVolumeRaw += BigInt(candle.quoteVolumeRaw);
      existing.tradeCount += BigInt(candle.tradeCount);
      existing.lastSource = candle.lastSource;
      existing.observedEnd = candle.intervalEnd;
      existing.sourceCandleCount += 1;
    }
  }

  return prepared.map((entry) => {
    if (entry.timeCoverage === null) {
      return { ownerMonth: entry.ownerMonth, intervalSeconds: entry.definition.intervalSeconds, artifact: null };
    }
    const intervalMilliseconds = entry.definition.intervalSeconds * 1_000;
    const resolutionCandles = [...entry.aggregates.entries()]
      .sort(([left], [right]) => left - right)
      .map(([intervalStart, aggregate]) => ({
        intervalStart: new Date(intervalStart).toISOString(),
        intervalEnd: new Date(intervalStart + intervalMilliseconds).toISOString(),
        open: aggregate.open,
        high: aggregate.high,
        low: aggregate.low,
        close: aggregate.close,
        baseVolumeRaw: aggregate.baseVolumeRaw.toString(),
        quoteVolumeRaw: aggregate.quoteVolumeRaw.toString(),
        tradeCount: aggregate.tradeCount.toString(),
        firstSource: aggregate.firstSource,
        lastSource: aggregate.lastSource,
        observedStart: aggregate.observedStart,
        observedEnd: aggregate.observedEnd,
        sourceCandleCount: aggregate.sourceCandleCount,
      }));
    const artifact = validateResolutionArtifact({
      kind: "pair_candle_resolution",
      pair: expectedPair,
      sequence: entry.sequence,
      ownerMonth: entry.ownerMonth,
      intervalSeconds: entry.definition.intervalSeconds,
      timeCoverage: entry.timeCoverage,
      candles: resolutionCandles,
    }, { registry });
    return { ownerMonth: entry.ownerMonth, intervalSeconds: entry.definition.intervalSeconds, artifact };
  });
}
