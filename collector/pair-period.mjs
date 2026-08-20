import { canonicalBytes } from "./canonical.mjs";
import { validatePairCandleSequence } from "./pair-artifact.mjs";
import { pairById } from "./pair-registry.mjs";
import { parseUtcInstant } from "./utc-time.mjs";

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

function monthBounds(value) {
  const start = `${value.slice(0, 7)}-01T00:00:00.000Z`;
  const until = new Date(start);
  until.setUTCMonth(until.getUTCMonth() + 1);
  return { start, until: until.toISOString() };
}

export function validatePairPeriodInput(value, registry) {
  exactKeys(value, ["from", "pairId", "until"], "pair period input");
  pairById(registry, value.pairId);
  const from = parseUtcInstant(value.from, "pair period from", true);
  const until = parseUtcInstant(value.until, "pair period until", true);
  const bounds = monthBounds(value.from);
  if (from >= until || value.from < bounds.start || value.until > bounds.until) {
    throw new Error("Pair period must be a non-empty interval in one UTC calendar month.");
  }
  return value;
}

function validateTimeRange(value, label, request) {
  exactKeys(value, ["from", "until"], label);
  const from = parseUtcInstant(value.from, `${label}.from`, true);
  const until = parseUtcInstant(value.until, `${label}.until`, true);
  if (from >= until || value.from < request.from || value.until > request.until) throw new Error(`${label} is outside the request.`);
  return value;
}

function validateRangePartition(available, unavailable, request) {
  if (!Array.isArray(available) || !Array.isArray(unavailable)) throw new Error("Pair period availability collections are invalid.");
  for (const [label, values] of [["available", available], ["unavailable", unavailable]]) {
    let previous = "";
    for (let index = 0; index < values.length; index += 1) {
      validateTimeRange(values[index], `${label}[${index}]`, request);
      if (values[index].from < previous) throw new Error(`${label} ranges are unordered.`);
      previous = values[index].until;
    }
  }
  const partition = [
    ...available.map((range) => ({ ...range, kind: "available" })),
    ...unavailable.map((range) => ({ ...range, kind: "unavailable" })),
  ].sort((left, right) => left.from.localeCompare(right.from) || left.until.localeCompare(right.until));
  let cursor = request.from;
  for (const range of partition) {
    if (range.from !== cursor) throw new Error("Available and unavailable ranges do not exactly partition the request.");
    cursor = range.until;
  }
  if (cursor !== request.until) throw new Error("Available and unavailable ranges do not cover the request.");
}

export function validatePairPeriodResult(value, { registry, input }) {
  exactKeys(value, ["available", "candles", "display", "pair", "requested", "unavailable"], "pair period result");
  exactKeys(value.requested, ["from", "until"], "pair period request");
  const request = validatePairPeriodInput(input, registry);
  if (value.pair?.pairId !== request.pairId || value.requested.from !== request.from || value.requested.until !== request.until) {
    throw new Error("Pair period result does not match its request.");
  }
  const entry = pairById(registry, request.pairId);
  if (!canonicalBytes(value.pair).equals(canonicalBytes(entry.pair)) || !canonicalBytes(value.display).equals(canonicalBytes(entry.display))) {
    throw new Error("Pair period identity or display is invalid.");
  }
  validateRangePartition(value.available, value.unavailable, value.requested);
  validatePairCandleSequence(value.candles);
  for (const candle of value.candles) {
    if (candle.intervalStart < value.requested.from || candle.intervalEnd > value.requested.until) {
      throw new Error("Pair period candle is outside the request.");
    }
    if (!value.available.some((range) => range.from <= candle.intervalStart && range.until >= candle.intervalEnd)) {
      throw new Error("Pair period candle is outside available coverage.");
    }
  }
  return value;
}
