import { isCanonicalBytes32 } from "./hex-data.mjs";
import {
  admitSwapPositionIdentity,
  compareSwapPosition,
  createSwapPositionIdentities,
} from "./swap-position.mjs";
import { compareRational } from "./swap.mjs";
import { parseUtcInstant } from "./utc-time.mjs";

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function decimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is not a decimal integer string.`);
  return BigInt(value);
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function gcd(left, right) {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function validateRational(value, label) {
  exactKeys(value, ["denominator", "numerator"], label);
  if (typeof value.numerator !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.numerator)) throw new Error(`${label} numerator is invalid.`);
  const numerator = BigInt(value.numerator);
  const denominator = decimalString(value.denominator, `${label} denominator`);
  if (numerator <= 0n || denominator === 0n || gcd(numerator, denominator) !== 1n) throw new Error(`${label} is not a positive reduced rational.`);
  return value;
}

function validateSwapPosition(value, label) {
  exactKeys(value, ["blockHash", "blockNumber", "logIndex", "transactionHash", "transactionIndex"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  if (!isCanonicalBytes32(value.blockHash) || !isCanonicalBytes32(value.transactionHash)) throw new Error(`${label} hash is invalid.`);
  for (const key of ["logIndex", "transactionIndex"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${label}.${key} is invalid.`);
  }
  return value;
}

function validateSwapPositionIdentity(value, label, identities) {
  validateSwapPosition(value, label);
  return admitSwapPositionIdentity(value, identities, "Candle sources");
}

export function validateSwapPositionOrder(first, last, firstLabel, lastLabel, identities = createSwapPositionIdentities()) {
  validateSwapPositionIdentity(first, firstLabel, identities);
  validateSwapPositionIdentity(last, lastLabel, identities);
  const order = compareSwapPosition(first, last);
  if (order > 0) throw new Error("Candle source range is inverted.");
  if (first.blockNumber === last.blockNumber && order < 0 && first.logIndex >= last.logIndex) {
    throw new Error("Candle source transaction and log order disagree.");
  }
  return order;
}

export function validateCandleSwapSpan(first, last, tradeCount) {
  const order = validateSwapPositionOrder(first, last, "candle.firstSource", "candle.lastSource");
  const count = BigInt(tradeCount);
  if (count === 1n && order !== 0 || count > 1n && order === 0) throw new Error("Candle trade count does not match its source span.");
}

export function validateMarketDataCandle(value, { expectedDay, coverage } = {}) {
  exactKeys(value, [
    "baseVolumeRaw", "close", "firstSource", "high", "intervalEnd", "intervalStart",
    "lastSource", "low", "open", "quoteVolumeRaw", "tradeCount",
  ], "market-data candle");
  const start = parseUtcInstant(value.intervalStart, "candle.intervalStart", true);
  const end = parseUtcInstant(value.intervalEnd, "candle.intervalEnd", true);
  if (end - start !== 60_000 || expectedDay !== undefined && !value.intervalStart.startsWith(expectedDay)) throw new Error("Candle interval is invalid.");
  for (const key of ["open", "high", "low", "close"]) validateRational(value[key], `candle.${key}`);
  if (
    compareRational(value.high, value.open) < 0
    || compareRational(value.high, value.close) < 0
    || compareRational(value.low, value.open) > 0
    || compareRational(value.low, value.close) > 0
    || compareRational(value.high, value.low) < 0
  ) throw new Error("Candle price bounds are invalid.");
  if (decimalString(value.baseVolumeRaw, "candle.baseVolumeRaw") === 0n || decimalString(value.quoteVolumeRaw, "candle.quoteVolumeRaw") === 0n) {
    throw new Error("Candle volumes must be positive.");
  }
  positiveInteger(value.tradeCount, "candle.tradeCount");
  validateCandleSwapSpan(value.firstSource, value.lastSource, value.tradeCount);
  if (coverage && (
    value.intervalStart < coverage.fromTimestamp
    || value.intervalEnd > coverage.untilTimestamp
    || BigInt(value.firstSource.blockNumber) < BigInt(coverage.fromBlock)
    || BigInt(value.lastSource.blockNumber) >= BigInt(coverage.untilBlock)
  )) throw new Error("Candle is outside its enclosing coverage.");
  return value;
}

export function validateMarketDataCandleSequence(value, candleContext = {}) {
  if (!Array.isArray(value)) throw new Error("Market-data candles must be an array.");
  const identities = createSwapPositionIdentities();
  let previous;
  for (const candle of value) {
    validateMarketDataCandle(candle, candleContext);
    validateSwapPositionIdentity(candle.firstSource, "candle.firstSource", identities);
    validateSwapPositionIdentity(candle.lastSource, "candle.lastSource", identities);
    if (previous !== undefined) {
      if (candle.intervalStart <= previous.intervalStart) throw new Error("Market-data candles are duplicated or unordered.");
      validateSwapPositionOrder(previous.lastSource, candle.firstSource, "previous candle.lastSource", "next candle.firstSource", identities);
      if (BigInt(previous.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)) {
        throw new Error("Different candle minutes must use strictly increasing source blocks.");
      }
    }
    previous = candle;
  }
  return value;
}
