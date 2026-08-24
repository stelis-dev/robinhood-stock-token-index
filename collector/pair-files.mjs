import {
  canonicalBytes,
  decodeArtifact,
  encodeArtifact,
  isSha256Hex,
  sha256Hex,
} from "./canonical.mjs";
import {
  candleResolutionCatalog,
  resolutionDefinition,
  resolutionMonthBounds,
  resolutionTimeCoverageFromSource,
  validateResolutionArtifact,
  validateResolutionCatalog,
  validateResolutionTimeCoverage,
} from "./candle-resolution.mjs";
import {
  validatePairCandleSequence,
  validatePairCoverage,
} from "./pair-candle.mjs";
import {
  pairDayLogicalId,
  pairMonthLogicalId,
  pairResolutionLogicalId,
  parsePairFileLogicalId,
} from "./pair-file-identity.mjs";
import { pairById, validateRegisteredPairDescriptor } from "./pair-registry.mjs";
import { validateUtcDay, validateUtcMonth } from "./utc-time.mjs";

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

function validateByteMembers(value, maximumArtifactBytes, label) {
  for (const key of ["jsonBytes", "gzipBytes"]) {
    positiveInteger(value[key], `${label}.${key}`);
    if (value[key] > maximumArtifactBytes) throw new Error(`${label} exceeds the artifact byte boundary.`);
  }
  for (const key of ["jsonSha256", "gzipSha256"]) {
    if (!isSha256Hex(value[key])) throw new Error(`${label}.${key} is invalid.`);
  }
}

export function validateCanonicalReference(value, { expectedLogicalId, maximumSequence, maximumArtifactBytes }) {
  positiveInteger(maximumArtifactBytes, "maximum artifact bytes");
  exactKeys(value, ["coverage", "gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId", "sequence"], "canonical reference");
  const identity = parsePairFileLogicalId(value.logicalId);
  if (identity.kind === "resolution") throw new Error("Canonical reference identity is invalid.");
  if (expectedLogicalId !== undefined && value.logicalId !== expectedLogicalId) throw new Error("Canonical reference does not match its parent.");
  positiveInteger(value.sequence, "canonical reference sequence");
  if (maximumSequence !== undefined && value.sequence > maximumSequence) throw new Error("Canonical reference is newer than its parent.");
  validatePairCoverage(value.coverage, "canonical reference coverage");
  const fromTimestamp = identity.kind === "month"
    ? `${identity.period}-01T00:00:00.000Z`
    : `${identity.period}T00:00:00.000Z`;
  const until = new Date(fromTimestamp);
  if (identity.kind === "month") until.setUTCMonth(until.getUTCMonth() + 1);
  else until.setUTCDate(until.getUTCDate() + 1);
  if (value.coverage.fromTimestamp < fromTimestamp || value.coverage.untilTimestamp > until.toISOString()) {
    throw new Error("Canonical reference coverage escapes its logical period.");
  }
  validateByteMembers(value, maximumArtifactBytes, "canonical reference");
  return identity;
}

export function validateResolutionReference(value, { expectedLogicalId, maximumSequence, maximumArtifactBytes }) {
  positiveInteger(maximumArtifactBytes, "maximum artifact bytes");
  exactKeys(value, [
    "gzipBytes",
    "gzipSha256",
    "intervalSeconds",
    "jsonBytes",
    "jsonSha256",
    "logicalId",
    "sequence",
    "timeCoverage",
  ], "resolution reference");
  const identity = parsePairFileLogicalId(value.logicalId);
  if (identity.kind !== "resolution") throw new Error("Resolution reference logical ID is invalid.");
  if (expectedLogicalId !== undefined && value.logicalId !== expectedLogicalId) throw new Error("Resolution reference does not match its parent.");
  if (value.intervalSeconds !== identity.intervalSeconds) throw new Error("Resolution reference interval is inconsistent.");
  positiveInteger(value.sequence, "resolution reference sequence");
  if (maximumSequence !== undefined && value.sequence > maximumSequence) throw new Error("Resolution reference is newer than its parent.");
  validateResolutionTimeCoverage(value.timeCoverage, {
    intervalSeconds: identity.intervalSeconds,
    ownerMonth: identity.period,
  });
  validateByteMembers(value, maximumArtifactBytes, "resolution reference");
  return identity;
}

function encode(value, context, validation) {
  const encoded = encodeArtifact(validation(value, context));
  if (
    encoded.jsonBytes.byteLength > context.registry.collection.maximumArtifactBytes
    || encoded.gzipBytes.byteLength > context.registry.collection.maximumArtifactBytes
  ) {
    throw new Error("Pair file exceeds the artifact byte boundary.");
  }
  return encoded;
}

function encodedReferenceMembers(decoded, gzipBytes) {
  return {
    jsonBytes: decoded.jsonBytes.byteLength,
    jsonSha256: decoded.jsonSha256,
    gzipBytes: gzipBytes.byteLength,
    gzipSha256: decoded.gzipSha256,
  };
}

export function createPairFileReference({ encoded, context }) {
  exactKeys(encoded, ["gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256"], "encoded pair file");
  if (!Buffer.isBuffer(encoded.gzipBytes) || !Buffer.isBuffer(encoded.jsonBytes)) throw new Error("Encoded pair file bytes are invalid.");
  const maximumArtifactBytes = context.registry.collection.maximumArtifactBytes;
  const decoded = decodeArtifact(encoded.gzipBytes, maximumArtifactBytes);
  if (
    !decoded.jsonBytes.equals(encoded.jsonBytes)
    || decoded.jsonSha256 !== encoded.jsonSha256
    || decoded.gzipSha256 !== encoded.gzipSha256
  ) {
    throw new Error("Encoded pair file members do not describe the same bytes.");
  }
  const child = decoded.value;
  if (child.kind === "pair_candle_resolution") {
    validateResolutionArtifact(child, context);
    const reference = {
      logicalId: pairResolutionLogicalId(child.pair.pairId, child.ownerMonth, child.intervalSeconds),
      sequence: child.sequence,
      intervalSeconds: child.intervalSeconds,
      timeCoverage: child.timeCoverage,
      ...encodedReferenceMembers(decoded, encoded.gzipBytes),
    };
    validateResolutionReference(reference, { maximumArtifactBytes });
    return reference;
  }
  if (child.kind === "pair_candle_day") {
    validatePairDayFile(child, context);
    const reference = {
      logicalId: pairDayLogicalId(child.pair.pairId, child.day),
      sequence: child.sequence,
      coverage: child.coverage,
      ...encodedReferenceMembers(decoded, encoded.gzipBytes),
    };
    validateCanonicalReference(reference, { maximumArtifactBytes });
    return reference;
  }
  if (child.kind === "pair_candle_month") {
    validatePairMonthFile(child, context);
    const reference = {
      logicalId: pairMonthLogicalId(child.pair.pairId, child.month),
      sequence: child.sequence,
      coverage: child.coverage,
      ...encodedReferenceMembers(decoded, encoded.gzipBytes),
    };
    validateCanonicalReference(reference, { maximumArtifactBytes });
    return reference;
  }
  throw new Error("Only a pair day, pair month, or resolution can be referenced.");
}

function validateOrderedCanonicalReferences(references, expectedLogicalIds, ownerSequence, maximumArtifactBytes, parentCoverage, label) {
  if (!Array.isArray(references) || references.length !== expectedLogicalIds.length) throw new Error(`${label} references do not cover their interval.`);
  let fromBlock = parentCoverage.fromBlock;
  let fromTimestamp = parentCoverage.fromTimestamp;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    validateCanonicalReference(reference, {
      expectedLogicalId: expectedLogicalIds[index],
      maximumSequence: ownerSequence,
      maximumArtifactBytes,
    });
    if (reference.coverage.fromBlock !== fromBlock || reference.coverage.fromTimestamp !== fromTimestamp) {
      throw new Error(`${label} reference coverage is not continuous.`);
    }
    fromBlock = reference.coverage.untilBlock;
    fromTimestamp = reference.coverage.untilTimestamp;
  }
  if (fromBlock !== parentCoverage.untilBlock || fromTimestamp !== parentCoverage.untilTimestamp) {
    throw new Error(`${label} references do not cover the complete parent range.`);
  }
}

function intersectedPeriods(fromTimestamp, untilTimestamp, kind) {
  const values = [];
  const cursor = new Date(fromTimestamp);
  if (kind === "month") cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = Date.parse(untilTimestamp);
  while (cursor.getTime() < end) {
    values.push(cursor.toISOString().slice(0, kind === "month" ? 7 : 10));
    if (kind === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

export function pairMonthSourceIds(pairId, ownerMonth, resolutionReferences) {
  if (!Array.isArray(resolutionReferences)) throw new Error("Pair month resolution references must be an array.");
  const expected = [pairMonthLogicalId(pairId, ownerMonth)];
  const twoDaySeconds = resolutionDefinition("2d", { derivedOnly: true }).intervalSeconds;
  const twoDay = resolutionReferences.find((reference) => reference.intervalSeconds === twoDaySeconds);
  if (twoDay !== undefined) {
    const ownerUntil = resolutionMonthBounds(ownerMonth).untilTimestamp;
    if (twoDay.timeCoverage.untilTimestamp > ownerUntil) {
      expected.push(pairMonthLogicalId(pairId, ownerUntil.slice(0, 7)));
    }
  }
  return expected;
}

export function validatePairStateFile(value, { registry }) {
  exactKeys(value, ["coverage", "kind", "months", "pair", "resolutions", "sequence"], "pair state file");
  if (value.kind !== "pair_candle_state") throw new Error("Pair state file identity is invalid.");
  const pair = validateRegisteredPairDescriptor(value.pair, registry);
  positiveInteger(value.sequence, "pair state file sequence");
  validatePairCoverage(value.coverage, "pair state file coverage");
  validateResolutionCatalog(value.resolutions);
  const fromBlock = BigInt(value.coverage.fromBlock);
  const untilBlock = BigInt(value.coverage.untilBlock);
  if (
    fromBlock < BigInt(pair.historyStart.blockNumber)
    || fromBlock > BigInt(pair.activation.blockNumber)
    || untilBlock < BigInt(pair.activation.blockNumber)
    || value.coverage.fromTimestamp < pair.historyStart.timestamp
    || value.coverage.fromTimestamp > pair.activation.timestamp
    || value.coverage.untilTimestamp < pair.activation.timestamp
  ) {
    throw new Error("Pair state file coverage is outside pair boundaries.");
  }
  const months = intersectedPeriods(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "month");
  validateOrderedCanonicalReferences(
    value.months,
    months.map((entry) => pairMonthLogicalId(pair.pairId, entry)),
    value.sequence,
    registry.collection.maximumArtifactBytes,
    value.coverage,
    "Pair state file month",
  );
  if (!value.months.some((reference) => reference.sequence === value.sequence)) {
    throw new Error("Pair state file does not include a changed month.");
  }
  return value;
}

export function validatePairMonthFile(value, { registry }) {
  exactKeys(value, [
    "coverage",
    "days",
    "kind",
    "month",
    "pair",
    "resolutions",
    "sequence",
    "sourceMonths",
  ], "pair month file");
  if (value.kind !== "pair_candle_month") throw new Error("Pair month file identity is invalid.");
  validateRegisteredPairDescriptor(value.pair, registry);
  const sequence = positiveInteger(value.sequence, "pair month file sequence");
  const ownerMonth = validateUtcMonth(value.month, "pair month file month");
  validatePairCoverage(value.coverage, "pair month file coverage");
  const monthBounds = resolutionMonthBounds(ownerMonth);
  if (value.coverage.fromTimestamp < monthBounds.fromTimestamp || value.coverage.untilTimestamp > monthBounds.untilTimestamp) {
    throw new Error("Pair month file coverage escapes its UTC month.");
  }
  const days = intersectedPeriods(value.coverage.fromTimestamp, value.coverage.untilTimestamp, "day");
  validateOrderedCanonicalReferences(
    value.days,
    days.map((entry) => pairDayLogicalId(value.pair.pairId, entry)),
    sequence,
    registry.collection.maximumArtifactBytes,
    value.coverage,
    "Pair month file day",
  );
  if (!Array.isArray(value.resolutions)) throw new Error("Pair month file resolutions must be an array.");
  let previousInterval = 60;
  for (const reference of value.resolutions) {
    const identity = validateResolutionReference(reference, {
      maximumSequence: sequence,
      maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    });
    if (identity.pairId !== value.pair.pairId || identity.period !== ownerMonth || identity.intervalSeconds <= previousInterval) {
      throw new Error("Pair month file resolutions are duplicated, unordered, or owned by another month.");
    }
    if (
      reference.timeCoverage.fromTimestamp < value.coverage.fromTimestamp
      || reference.timeCoverage.untilTimestamp <= monthBounds.untilTimestamp
        && reference.timeCoverage.untilTimestamp > value.coverage.untilTimestamp
    ) {
      throw new Error("Pair month file resolution coverage escapes canonical coverage.");
    }
    previousInterval = identity.intervalSeconds;
  }
  if (!Array.isArray(value.sourceMonths) || !canonicalBytes(value.sourceMonths).equals(canonicalBytes(
    pairMonthSourceIds(value.pair.pairId, value.month, value.resolutions),
  ))) {
    throw new Error("Pair month file source months are invalid.");
  }
  if (![...value.days, ...value.resolutions].some((reference) => reference.sequence === sequence)) {
    throw new Error("Pair month file does not include a changed artifact.");
  }
  return value;
}

export function validatePairDayFile(value, { registry }) {
  exactKeys(value, ["candles", "coverage", "day", "kind", "pair", "sequence"], "pair day file");
  if (value.kind !== "pair_candle_day") throw new Error("Pair day file identity is invalid.");
  validateRegisteredPairDescriptor(value.pair, registry);
  positiveInteger(value.sequence, "pair day file sequence");
  const period = validateUtcDay(value.day, "pair day file day");
  validatePairCoverage(value.coverage, "pair day file coverage");
  const fromTimestamp = `${period}T00:00:00.000Z`;
  const untilTimestamp = new Date(Date.parse(fromTimestamp) + 86_400_000).toISOString();
  if (value.coverage.fromTimestamp < fromTimestamp || value.coverage.untilTimestamp > untilTimestamp) {
    throw new Error("Pair day file coverage escapes its UTC day.");
  }
  if (!Array.isArray(value.candles) || value.candles.length > 1_440) throw new Error("Pair day file candle count is invalid.");
  validatePairCandleSequence(value.candles, { expectedDay: period, coverage: value.coverage });
  return value;
}

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

export function validateSelectedPairMonth({ state, month }, { registry }) {
  validatePairStateFile(state, { registry });
  validatePairMonthFile(month, { registry });
  const logicalId = pairMonthLogicalId(month.pair.pairId, month.month);
  const selectedReference = state.months.find((reference) => reference.logicalId === logicalId);
  if (
    selectedReference === undefined
    || selectedReference.sequence !== month.sequence
    || !sameValue(selectedReference.coverage, month.coverage)
  ) {
    throw new Error("Pair month file is not selected by the pair state.");
  }
  const selectedMonthIds = new Set(state.months.map((reference) => reference.logicalId));
  for (const sourceMonth of month.sourceMonths) {
    if (!selectedMonthIds.has(sourceMonth)) throw new Error("Resolution source month is not selected.");
  }
  const references = new Map(month.resolutions.map((reference) => [reference.intervalSeconds, reference]));
  for (const definition of candleResolutionCatalog.slice(1)) {
    const expectedCoverage = resolutionTimeCoverageFromSource({
      fromTimestamp: state.coverage.fromTimestamp,
      untilTimestamp: state.coverage.untilTimestamp,
      ownerMonth: month.month,
      intervalSeconds: definition.intervalSeconds,
    });
    const reference = references.get(definition.intervalSeconds);
    if (expectedCoverage === null ? reference !== undefined : reference === undefined) {
      throw new Error("Pair month file resolution availability does not match selected canonical coverage.");
    }
    if (reference !== undefined && !sameValue(reference.timeCoverage, expectedCoverage)) {
      throw new Error("Pair month file resolution coverage does not match selected canonical coverage.");
    }
  }
  return { state, month };
}

export function encodePairStateFile(value, context) {
  return encode(value, context, validatePairStateFile);
}

export function encodePairDayFile(value, context) {
  return encode(value, context, validatePairDayFile);
}

export function encodePairMonthFile(value, context) {
  return encode(value, context, validatePairMonthFile);
}

export function encodeResolutionArtifact(value, context) {
  return encode(value, context, validateResolutionArtifact);
}

export function decodePairStateFile(bytes, context, expectedPairId) {
  pairById(context.registry, expectedPairId);
  const decoded = decodeArtifact(bytes, context.registry.collection.maximumArtifactBytes);
  const value = validatePairStateFile(decoded.value, context);
  if (value.pair.pairId !== expectedPairId) throw new Error("Pair state file does not match the requested pair.");
  return value;
}

function decodeReferenced(bytes, context, reference, kind) {
  const maximumArtifactBytes = context.registry.collection.maximumArtifactBytes;
  if (kind === "resolution") validateResolutionReference(reference, { maximumArtifactBytes });
  else validateCanonicalReference(reference, { maximumArtifactBytes });
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== reference.gzipBytes || sha256Hex(bytes) !== reference.gzipSha256) {
    throw new Error("Pair file bytes do not match their reference.");
  }
  const decoded = decodeArtifact(bytes, maximumArtifactBytes);
  if (decoded.jsonBytes.byteLength !== reference.jsonBytes || decoded.jsonSha256 !== reference.jsonSha256) {
    throw new Error("Decoded pair file does not match its reference.");
  }
  if (kind === "month") {
    const value = validatePairMonthFile(decoded.value, context);
    if (
      value.sequence !== reference.sequence
      || reference.logicalId !== pairMonthLogicalId(value.pair.pairId, value.month)
      || !canonicalBytes(value.coverage).equals(canonicalBytes(reference.coverage))
    ) {
      throw new Error("Pair month file identity does not match its reference.");
    }
    return value;
  }
  if (kind === "day") {
    const value = validatePairDayFile(decoded.value, context);
    if (
      value.sequence !== reference.sequence
      || reference.logicalId !== pairDayLogicalId(value.pair.pairId, value.day)
      || !canonicalBytes(value.coverage).equals(canonicalBytes(reference.coverage))
    ) {
      throw new Error("Pair day file identity does not match its reference.");
    }
    return value;
  }
  const value = validateResolutionArtifact(decoded.value, context);
  if (
    value.sequence !== reference.sequence
    || reference.logicalId !== pairResolutionLogicalId(value.pair.pairId, value.ownerMonth, value.intervalSeconds)
    || !canonicalBytes(value.timeCoverage).equals(canonicalBytes(reference.timeCoverage))
  ) {
    throw new Error("Resolution artifact identity does not match its reference.");
  }
  return value;
}

export function decodePairMonthFile(bytes, context, reference) {
  return decodeReferenced(bytes, context, reference, "month");
}

export function decodePairDayFile(bytes, context, reference) {
  return decodeReferenced(bytes, context, reference, "day");
}

export function decodeResolutionArtifact(bytes, context, reference) {
  return decodeReferenced(bytes, context, reference, "resolution");
}
