import { canonicalBytes, decodeArtifact, encodeArtifact, sha256Hex } from "./canonical.mjs";
import { pairById } from "./pair-registry.mjs";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const monthPattern = /^\d{4}-\d{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const digestPattern = /^[0-9a-f]{64}$/;

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

function decimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not a decimal integer string.`);
  return BigInt(value);
}

function instant(value, label, minuteAligned = true) {
  if (typeof value !== "string" || !instantPattern.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is not a canonical UTC instant.`);
  }
  if (minuteAligned && Date.parse(value) % 60_000 !== 0) throw new Error(`${label} is not minute aligned.`);
  return Date.parse(value);
}

function day(value, label) {
  if (typeof value !== "string" || !dayPattern.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a canonical UTC day.`);
  }
  return value;
}

function month(value, label) {
  if (typeof value !== "string" || !monthPattern.test(value) || new Date(`${value}-01T00:00:00.000Z`).toISOString().slice(0, 7) !== value) {
    throw new Error(`${label} is not a canonical UTC month.`);
  }
  return value;
}

function pairDescriptor(value, registry) {
  const pairId = value?.pairId;
  const expected = pairById(registry, pairId).pair;
  if (!canonicalBytes(value).equals(canonicalBytes(expected))) throw new Error("Artifact pair descriptor is invalid.");
  return expected;
}

export function admitPairCoverage(value, label = "coverage") {
  exactKeys(value, ["fromBlock", "fromTimestamp", "untilBlock", "untilTimestamp"], label);
  const fromBlock = decimalString(value.fromBlock, `${label}.fromBlock`);
  const untilBlock = decimalString(value.untilBlock, `${label}.untilBlock`);
  const fromTime = instant(value.fromTimestamp, `${label}.fromTimestamp`);
  const untilTime = instant(value.untilTimestamp, `${label}.untilTimestamp`);
  if (fromBlock > untilBlock || fromTime >= untilTime) {
    throw new Error(`${label} is inverted.`);
  }
  return value;
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

function admitRational(value, label) {
  exactKeys(value, ["denominator", "numerator"], label);
  if (typeof value.numerator !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value.numerator)) throw new Error(`${label} numerator is invalid.`);
  const numerator = BigInt(value.numerator);
  const denominator = decimalString(value.denominator, `${label} denominator`);
  if (numerator <= 0n || denominator === 0n || gcd(numerator, denominator) !== 1n) throw new Error(`${label} is not a positive reduced rational.`);
  return value;
}

function compareRational(left, right) {
  const result = BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
  return result < 0n ? -1 : result > 0n ? 1 : 0;
}

function admitSource(value, label) {
  exactKeys(value, ["blockHash", "blockNumber", "logIndex", "transactionHash", "transactionIndex"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  if (!/^0x[0-9a-f]{64}$/.test(value.blockHash) || !/^0x[0-9a-f]{64}$/.test(value.transactionHash)) throw new Error(`${label} hash is invalid.`);
  for (const key of ["logIndex", "transactionIndex"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${label}.${key} is invalid.`);
  }
  return value;
}

function compareSourceCoordinates(left, right) {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex < right.transactionIndex ? -1 : 1;
  return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
}

function sourceIdentities() {
  return {
    blockHashByNumber: new Map(),
    blockNumberByHash: new Map(),
    transactionHashByCoordinate: new Map(),
    transactionCoordinateByHash: new Map(),
  };
}

function admitSourceIdentity(value, label, identities) {
  admitSource(value, label);
  const knownBlockHash = identities.blockHashByNumber.get(value.blockNumber);
  const knownBlockNumber = identities.blockNumberByHash.get(value.blockHash);
  if (
    (knownBlockHash !== undefined && knownBlockHash !== value.blockHash)
    || (knownBlockNumber !== undefined && knownBlockNumber !== value.blockNumber)
  ) {
    throw new Error("Candle sources disagree on their block identity.");
  }
  identities.blockHashByNumber.set(value.blockNumber, value.blockHash);
  identities.blockNumberByHash.set(value.blockHash, value.blockNumber);

  const transactionCoordinate = `${value.blockNumber}:${value.transactionIndex}`;
  const knownTransactionHash = identities.transactionHashByCoordinate.get(transactionCoordinate);
  const knownTransactionCoordinate = identities.transactionCoordinateByHash.get(value.transactionHash);
  if (
    (knownTransactionHash !== undefined && knownTransactionHash !== value.transactionHash)
    || (knownTransactionCoordinate !== undefined && knownTransactionCoordinate !== transactionCoordinate)
  ) {
    throw new Error("Candle sources disagree on their transaction identity.");
  }
  identities.transactionHashByCoordinate.set(transactionCoordinate, value.transactionHash);
  identities.transactionCoordinateByHash.set(value.transactionHash, transactionCoordinate);
  return value;
}

function admitOrderedSourceRelationship(first, last, firstLabel, lastLabel, identities = sourceIdentities()) {
  admitSourceIdentity(first, firstLabel, identities);
  admitSourceIdentity(last, lastLabel, identities);
  const order = compareSourceCoordinates(first, last);
  if (order > 0) throw new Error("Candle source range is inverted.");
  const sameBlockCoordinate = first.blockNumber === last.blockNumber;
  if (sameBlockCoordinate && order < 0 && first.logIndex >= last.logIndex) {
    throw new Error("Candle source transaction and log order disagree.");
  }
  return order;
}

function admitSourceSpan(first, last, tradeCount) {
  const order = admitOrderedSourceRelationship(first, last, "candle.firstSource", "candle.lastSource");
  if (tradeCount === 1 && order !== 0 || tradeCount > 1 && order === 0) {
    throw new Error("Candle trade count does not match its source span.");
  }
}

export function admitPairCandle(value, { expectedDay, coverage } = {}) {
  exactKeys(value, [
    "baseVolumeRaw",
    "close",
    "firstSource",
    "high",
    "intervalEnd",
    "intervalStart",
    "lastSource",
    "low",
    "open",
    "quoteVolumeRaw",
    "tradeCount",
  ], "pair candle");
  const start = instant(value.intervalStart, "candle.intervalStart");
  const end = instant(value.intervalEnd, "candle.intervalEnd");
  if (end - start !== 60_000 || expectedDay !== undefined && !value.intervalStart.startsWith(expectedDay)) throw new Error("Candle interval is invalid.");
  for (const key of ["open", "high", "low", "close"]) admitRational(value[key], `candle.${key}`);
  if (compareRational(value.high, value.open) < 0 || compareRational(value.high, value.close) < 0 || compareRational(value.low, value.open) > 0 || compareRational(value.low, value.close) > 0 || compareRational(value.high, value.low) < 0) {
    throw new Error("Candle price bounds are invalid.");
  }
  if (decimalString(value.baseVolumeRaw, "candle.baseVolumeRaw") === 0n || decimalString(value.quoteVolumeRaw, "candle.quoteVolumeRaw") === 0n) {
    throw new Error("Candle volumes must be positive.");
  }
  positiveInteger(value.tradeCount, "candle.tradeCount");
  admitSourceSpan(value.firstSource, value.lastSource, value.tradeCount);
  if (coverage && (value.intervalStart < coverage.fromTimestamp || value.intervalEnd > coverage.untilTimestamp || BigInt(value.firstSource.blockNumber) < BigInt(coverage.fromBlock) || BigInt(value.lastSource.blockNumber) >= BigInt(coverage.untilBlock))) {
    throw new Error("Candle is outside admitted coverage.");
  }
  return value;
}

export function admitPairCandleSequence(value, candleContext = {}) {
  if (!Array.isArray(value)) throw new Error("Pair candles must be an array.");
  const identities = sourceIdentities();
  let previous;
  for (const candle of value) {
    admitPairCandle(candle, candleContext);
    admitSourceIdentity(candle.firstSource, "candle.firstSource", identities);
    admitSourceIdentity(candle.lastSource, "candle.lastSource", identities);
    if (previous !== undefined) {
      if (candle.intervalStart <= previous.intervalStart) {
        throw new Error("Pair candles are duplicated or unordered.");
      }
      admitOrderedSourceRelationship(
        previous.lastSource,
        candle.firstSource,
        "previous candle.lastSource",
        "next candle.firstSource",
        identities,
      );
      if (BigInt(previous.lastSource.blockNumber) >= BigInt(candle.firstSource.blockNumber)) {
        throw new Error("Different candle minutes must use strictly increasing source blocks.");
      }
    }
    previous = candle;
  }
  return value;
}

function logicalId(kind, pairId, period) {
  if (!/^0x[0-9a-f]{64}$/.test(pairId)) throw new Error("Logical pair identity is invalid.");
  const suffix = period === undefined ? "state" : `${kind}/${period}`;
  return `pairs/${pairId}/${suffix}`;
}

export function pairStateLogicalId(pairId) {
  return logicalId("", pairId);
}

export function pairMonthLogicalId(pairId, value) {
  return logicalId("months", pairId, month(value, "month"));
}

export function pairDayLogicalId(pairId, value) {
  return logicalId("days", pairId, day(value, "day"));
}

export function createPairReference({ encoded, context }) {
  exactKeys(encoded, ["gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256"], "encoded artifact");
  if (!Buffer.isBuffer(encoded.gzipBytes) || !Buffer.isBuffer(encoded.jsonBytes)) throw new Error("Encoded artifact bytes are invalid.");
  const maximumArtifactBytes = positiveInteger(context.registry.collection.maximumArtifactBytes, "maximum artifact bytes");
  const decoded = decodeArtifact(encoded.gzipBytes, maximumArtifactBytes);
  if (!decoded.jsonBytes.equals(encoded.jsonBytes) || decoded.gzipSha256 !== encoded.gzipSha256 || decoded.jsonSha256 !== encoded.jsonSha256) {
    throw new Error("Encoded artifact members do not describe the same bytes.");
  }
  const child = decoded.value;
  let identity;
  if (child.kind === "pair_candle_month") {
    admitPairMonth(child, context);
    identity = pairMonthLogicalId(child.pair.pairId, child.month);
  } else if (child.kind === "pair_candle_day") {
    admitPairDay(child, context);
    identity = pairDayLogicalId(child.pair.pairId, child.day);
  } else {
    throw new Error("Only a pair month or day can be referenced.");
  }
  const reference = {
    logicalId: identity,
    sequence: child.sequence,
    coverage: child.coverage,
    jsonBytes: decoded.jsonBytes.byteLength,
    jsonSha256: decoded.jsonSha256,
    gzipBytes: encoded.gzipBytes.byteLength,
    gzipSha256: decoded.gzipSha256,
  };
  return admitPairReference(reference, { maximumArtifactBytes });
}

function admitPairReference(value, { logicalId: expectedLogicalId, maximumSequence, maximumArtifactBytes }) {
  exactKeys(value, ["coverage", "gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId", "sequence"], "artifact reference");
  positiveInteger(maximumArtifactBytes, "maximum artifact bytes");
  const identity = typeof value.logicalId === "string" ? value.logicalId.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/) : null;
  if (!identity) {
    throw new Error("Reference logical identity is invalid.");
  }
  if (expectedLogicalId !== undefined && value.logicalId !== expectedLogicalId) throw new Error("Reference logical identity does not match its owner.");
  positiveInteger(value.sequence, "reference sequence");
  if (maximumSequence !== undefined && value.sequence > maximumSequence) throw new Error("Reference sequence exceeds its owner.");
  admitPairCoverage(value.coverage, "reference coverage");
  let periodStart;
  let periodUntil;
  if (identity[2] === "months") {
    month(identity[3], "reference month");
    periodStart = `${identity[3]}-01T00:00:00.000Z`;
    const next = new Date(periodStart);
    next.setUTCMonth(next.getUTCMonth() + 1);
    periodUntil = next.toISOString();
  } else {
    day(identity[3], "reference day");
    periodStart = `${identity[3]}T00:00:00.000Z`;
    periodUntil = new Date(Date.parse(periodStart) + 86_400_000).toISOString();
  }
  if (value.coverage.fromTimestamp < periodStart || value.coverage.untilTimestamp > periodUntil) throw new Error("Reference coverage escapes its logical period.");
  for (const key of ["jsonBytes", "gzipBytes"]) {
    positiveInteger(value[key], `reference.${key}`);
    if (value[key] > maximumArtifactBytes) throw new Error("Reference byte count exceeds the artifact boundary.");
  }
  for (const key of ["jsonSha256", "gzipSha256"]) if (!digestPattern.test(value[key])) throw new Error(`reference.${key} is invalid.`);
  return value;
}

function admitHeader(value, { registry, kind }) {
  exactKeys(value, kind.keys, kind.label);
  if (value.contractVersion !== "1" || value.kind !== kind.value) throw new Error(`${kind.label} identity is invalid.`);
  pairDescriptor(value.pair, registry);
  positiveInteger(value.sequence, `${kind.label} sequence`);
}

function intersectedKeys(fromTimestamp, untilTimestamp, size) {
  const keys = [];
  const untilExclusive = Date.parse(untilTimestamp);
  if (Date.parse(fromTimestamp) === untilExclusive) return keys;
  const cursor = new Date(fromTimestamp);
  if (size === "month") cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < untilExclusive) {
    keys.push(size === "month" ? cursor.toISOString().slice(0, 7) : cursor.toISOString().slice(0, 10));
    if (size === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function admitOrderedReferences(references, expectedLogicalIds, ownerSequence, maximumArtifactBytes, parentCoverage, label) {
  if (!Array.isArray(references) || references.length !== expectedLogicalIds.length) throw new Error(`${label} references do not cover their interval.`);
  let cursorBlock = parentCoverage.fromBlock;
  let cursorTimestamp = parentCoverage.fromTimestamp;
  for (let index = 0; index < references.length; index += 1) {
    admitPairReference(references[index], {
      logicalId: expectedLogicalIds[index],
      maximumSequence: ownerSequence,
      maximumArtifactBytes,
    });
    if (references[index].coverage.fromBlock !== cursorBlock || references[index].coverage.fromTimestamp !== cursorTimestamp) {
      throw new Error(`${label} reference coverage is not continuous.`);
    }
    cursorBlock = references[index].coverage.untilBlock;
    cursorTimestamp = references[index].coverage.untilTimestamp;
  }
  if (cursorBlock !== parentCoverage.untilBlock || cursorTimestamp !== parentCoverage.untilTimestamp) throw new Error(`${label} references do not reach their owner coverage.`);
  if (!references.some((reference) => reference.sequence === ownerSequence)) {
    throw new Error(`${label} references do not contain an owner-generation child.`);
  }
}

export function admitPairState(value, { registry }) {
  const kind = {
    label: "pair state",
    value: "pair_candle_state",
    keys: ["contractVersion", "coverage", "kind", "months", "pair", "sequence"],
  };
  admitHeader(value, { registry, kind });
  admitPairCoverage(value.coverage, "state coverage");
  const pair = pairById(registry, value.pair.pairId).pair;
  const fromBlock = BigInt(value.coverage.fromBlock);
  const untilBlock = BigInt(value.coverage.untilBlock);
  const historyBlock = BigInt(pair.historyStart.blockNumber);
  const activationBlock = BigInt(pair.activation.blockNumber);
  if (fromBlock < historyBlock || fromBlock > activationBlock || untilBlock < activationBlock || value.coverage.fromTimestamp < pair.historyStart.timestamp || value.coverage.fromTimestamp > pair.activation.timestamp || value.coverage.untilTimestamp < pair.activation.timestamp) {
    throw new Error("State coverage is outside pair history and activation bounds.");
  }
  const months = intersectedKeys(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "month");
  admitOrderedReferences(
    value.months,
    months.map((entry) => pairMonthLogicalId(pair.pairId, entry)),
    value.sequence,
    registry.collection.maximumArtifactBytes,
    value.coverage,
    "State month",
  );
  return value;
}

export function admitPairMonth(value, { registry }) {
  const kind = {
    label: "pair month",
    value: "pair_candle_month",
    keys: ["contractVersion", "coverage", "days", "kind", "month", "pair", "sequence"],
  };
  admitHeader(value, { registry, kind });
  month(value.month, "pair month");
  admitPairCoverage(value.coverage, "month coverage");
  const monthStart = `${value.month}-01T00:00:00.000Z`;
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthUntil = nextMonth.toISOString();
  if (value.coverage.fromTimestamp < monthStart || value.coverage.untilTimestamp > monthUntil) throw new Error("Month coverage escapes its UTC month.");
  const days = intersectedKeys(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "day");
  admitOrderedReferences(
    value.days,
    days.map((entry) => pairDayLogicalId(value.pair.pairId, entry)),
    value.sequence,
    registry.collection.maximumArtifactBytes,
    value.coverage,
    "Month day",
  );
  return value;
}

export function admitPairDay(value, { registry }) {
  const kind = {
    label: "pair day",
    value: "pair_candle_day",
    keys: ["candles", "contractVersion", "coverage", "day", "kind", "pair", "sequence"],
  };
  admitHeader(value, { registry, kind });
  day(value.day, "pair day");
  admitPairCoverage(value.coverage, "day coverage");
  const dayStart = `${value.day}T00:00:00.000Z`;
  const dayUntil = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  if (value.coverage.fromTimestamp < dayStart || value.coverage.untilTimestamp > dayUntil) throw new Error("Day coverage escapes its UTC day.");
  if (!Array.isArray(value.candles) || value.candles.length > 1_440) throw new Error("Pair day candle count is invalid.");
  admitPairCandleSequence(value.candles, { expectedDay: value.day, coverage: value.coverage });
  return value;
}

function encode(value, context, admission) {
  const encoded = encodeArtifact(admission(value, context));
  if (encoded.jsonBytes.byteLength > context.registry.collection.maximumArtifactBytes || encoded.gzipBytes.byteLength > context.registry.collection.maximumArtifactBytes) {
    throw new Error("Pair artifact exceeds the admitted byte limit.");
  }
  return encoded;
}

function decodeReferencedPairArtifact(bytes, context, reference, admission) {
  admitPairReference(reference, { maximumArtifactBytes: context.registry.collection.maximumArtifactBytes });
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== reference.gzipBytes || sha256Hex(bytes) !== reference.gzipSha256) {
    throw new Error("Stored bytes do not match their reference.");
  }
  const decoded = decodeArtifact(bytes, context.registry.collection.maximumArtifactBytes);
  if (decoded.jsonBytes.byteLength !== reference.jsonBytes || decoded.jsonSha256 !== reference.jsonSha256) {
    throw new Error("Decoded artifact does not match its reference.");
  }
  const value = admission(decoded.value, context);
  if (value.sequence !== reference.sequence) throw new Error("Artifact sequence does not match its reference.");
  if (!canonicalBytes(value.coverage).equals(canonicalBytes(reference.coverage))) throw new Error("Artifact coverage does not match its reference.");
  const expectedLogicalId = value.kind === "pair_candle_month"
      ? pairMonthLogicalId(value.pair.pairId, value.month)
      : pairDayLogicalId(value.pair.pairId, value.day);
  if (reference.logicalId !== expectedLogicalId) throw new Error("Artifact identity does not match its reference.");
  return value;
}

export function encodePairState(value, context) {
  return encode(value, context, admitPairState);
}

export function encodePairMonth(value, context) {
  return encode(value, context, admitPairMonth);
}

export function encodePairDay(value, context) {
  return encode(value, context, admitPairDay);
}

export function decodePairState(bytes, context, expectedPairId) {
  pairById(context.registry, expectedPairId);
  const decoded = decodeArtifact(bytes, context.registry.collection.maximumArtifactBytes);
  const value = admitPairState(decoded.value, context);
  if (value.pair.pairId !== expectedPairId) throw new Error("Pair state does not match its requested logical identity.");
  return value;
}

export function decodePairMonth(bytes, context, reference) {
  return decodeReferencedPairArtifact(bytes, context, reference, admitPairMonth);
}

export function decodePairDay(bytes, context, reference) {
  return decodeReferencedPairArtifact(bytes, context, reference, admitPairDay);
}
