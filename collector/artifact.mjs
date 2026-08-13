import { canonicalBytes, decodeArtifact, encodeArtifact, sha256Hex } from "./canonical.mjs";
import { compareRational, compareSourcePosition } from "./swap.mjs";
import { compareCandleIdentity } from "./candles.mjs";

const isoDayPattern = /^\d{4}-\d{2}-\d{2}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

function decimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not a decimal integer string.`);
  return BigInt(value);
}

function isoInstant(value, label) {
  if (typeof value !== "string" || !isoInstantPattern.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} is not a canonical UTC instant.`);
}

function isoDay(value, label) {
  if (!isoDayPattern.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a canonical UTC day.`);
  }
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
  if (typeof value.numerator !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value.numerator)) throw new Error(`${label} numerator is invalid.`);
  const numerator = BigInt(value.numerator);
  const denominator = decimalString(value.denominator, `${label} denominator`);
  if (denominator === 0n) throw new Error(`${label} denominator is zero.`);
  if (numerator <= 0n || gcd(numerator, denominator) !== 1n) throw new Error(`${label} is not a positive reduced rational.`);
}

function admitSource(value, label) {
  exactKeys(value, ["blockHash", "blockNumber", "logIndex", "transactionHash", "transactionIndex"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  if (!/^0x[0-9a-f]{64}$/.test(value.blockHash) || !/^0x[0-9a-f]{64}$/.test(value.transactionHash)) throw new Error(`${label} hash is invalid.`);
  for (const key of ["logIndex", "transactionIndex"]) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${label}.${key} is invalid.`);
}

export function emptyDayArtifact({ registry, group, day }) {
  return {
    contractVersion: "1",
    kind: "stock_token_execution_day",
    groupId: group.groupId,
    day,
    source: {
      chainId: registry.chain.chainId,
      finality: registry.chain.finalityTag,
      poolManager: registry.deployment.poolManager,
      quoteToken: registry.deployment.quoteToken,
      swapTopic: registry.deployment.swapTopic,
    },
    coverage: [],
    candles: [],
  };
}

export function admitDayArtifact(value, { registry, group }) {
  exactKeys(value, ["candles", "contractVersion", "coverage", "day", "groupId", "kind", "source"], "day artifact");
  isoDay(value.day, "day artifact day");
  if (value.contractVersion !== "1" || value.kind !== "stock_token_execution_day" || value.groupId !== group.groupId) throw new Error("Day artifact identity is invalid.");
  exactKeys(value.source, ["chainId", "finality", "poolManager", "quoteToken", "swapTopic"], "day source");
  if (value.source.chainId !== registry.chain.chainId || value.source.finality !== "finalized" || value.source.poolManager !== registry.deployment.poolManager || value.source.swapTopic !== registry.deployment.swapTopic || JSON.stringify(value.source.quoteToken) !== JSON.stringify(registry.deployment.quoteToken)) throw new Error("Day artifact source is invalid.");
  if (!Array.isArray(value.coverage) || !Array.isArray(value.candles)) throw new Error("Day artifact collections are invalid.");
  if (value.coverage.length !== 1 || value.candles.length > 86_400 / registry.collection.candleSeconds * group.assets.length) throw new Error("Day artifact collection bound is invalid.");
  let previousCoverage = null;
  for (const entry of value.coverage) {
    exactKeys(entry, ["fromBlock", "fromTimestamp", "untilBlock", "untilTimestamp"], "coverage");
    const from = decimalString(entry.fromBlock, "coverage.fromBlock");
    const until = decimalString(entry.untilBlock, "coverage.untilBlock");
    isoInstant(entry.fromTimestamp, "coverage.fromTimestamp");
    isoInstant(entry.untilTimestamp, "coverage.untilTimestamp");
    if (from > until || entry.fromTimestamp >= entry.untilTimestamp || Date.parse(entry.fromTimestamp) % 60_000 !== 0 || Date.parse(entry.untilTimestamp) % 60_000 !== 0 || !entry.fromTimestamp.startsWith(value.day) || new Date(entry.untilTimestamp).getTime() > new Date(`${value.day}T00:00:00.000Z`).getTime() + 86_400_000) throw new Error("Coverage range is invalid.");
    if (previousCoverage && (previousCoverage.untilTimestamp >= entry.fromTimestamp || BigInt(previousCoverage.untilBlock) > from)) throw new Error("Coverage ranges overlap or are unordered.");
    previousCoverage = entry;
  }
  const assets = new Map(group.assets.map((asset) => [asset.poolId, asset]));
  let previousCandle = null;
  for (const candle of value.candles) {
    exactKeys(candle, ["close", "firstSource", "high", "intervalEnd", "intervalStart", "lastSource", "low", "open", "poolId", "quoteVolumeRaw", "symbol", "token", "tokenVolumeRaw", "tradeCount"], "candle");
    const asset = assets.get(candle.poolId);
    if (!asset || candle.symbol !== asset.symbol || candle.token !== asset.token) throw new Error("Candle asset identity is invalid.");
    isoInstant(candle.intervalStart, "candle.intervalStart");
    isoInstant(candle.intervalEnd, "candle.intervalEnd");
    if (!candle.intervalStart.startsWith(value.day) || new Date(candle.intervalEnd).getTime() - new Date(candle.intervalStart).getTime() !== 60_000) throw new Error("Candle interval is invalid.");
    for (const key of ["open", "high", "low", "close"]) admitRational(candle[key], `candle.${key}`);
    if (compareRational(candle.high, candle.open) < 0 || compareRational(candle.high, candle.close) < 0 || compareRational(candle.low, candle.open) > 0 || compareRational(candle.low, candle.close) > 0 || compareRational(candle.high, candle.low) < 0) throw new Error("Candle price bounds are invalid.");
    admitSource(candle.firstSource, "candle.firstSource");
    admitSource(candle.lastSource, "candle.lastSource");
    if (compareSourcePosition(candle.firstSource, candle.lastSource) > 0) throw new Error("Candle source range is invalid.");
    if (decimalString(candle.tokenVolumeRaw, "candle.tokenVolumeRaw") === 0n || decimalString(candle.quoteVolumeRaw, "candle.quoteVolumeRaw") === 0n) throw new Error("Candle volumes must be positive.");
    if (!Number.isSafeInteger(candle.tradeCount) || candle.tradeCount <= 0) throw new Error("Candle trade count is invalid.");
    const coveringRange = value.coverage.find((entry) => entry.fromTimestamp <= candle.intervalStart && entry.untilTimestamp >= candle.intervalEnd && BigInt(entry.fromBlock) <= BigInt(candle.firstSource.blockNumber) && BigInt(entry.untilBlock) > BigInt(candle.lastSource.blockNumber));
    if (!coveringRange) throw new Error("Candle is outside admitted coverage.");
    if (previousCandle && compareCandleIdentity(previousCandle, candle) >= 0) throw new Error("Candles are not uniquely ordered.");
    previousCandle = candle;
  }
  return value;
}

export function createState({ groupId, previous, nextBlock, coveredUntilTimestamp, days }) {
  const sequence = previous === null ? 1 : previous.sequence + 1;
  return {
    contractVersion: "1",
    kind: "stock_token_execution_state",
    groupId,
    sequence,
    nextBlock: BigInt(nextBlock).toString(),
    coveredUntilTimestamp,
    days: [...days].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export function admitState(value, groupId) {
  exactKeys(value, ["contractVersion", "coveredUntilTimestamp", "days", "groupId", "kind", "nextBlock", "sequence"], "state");
  if (value.contractVersion !== "1" || value.kind !== "stock_token_execution_state" || value.groupId !== groupId || !Number.isSafeInteger(value.sequence) || value.sequence <= 0) throw new Error("State identity is invalid.");
  decimalString(value.nextBlock, "state.nextBlock");
  isoInstant(value.coveredUntilTimestamp, "state.coveredUntilTimestamp");
  if (Date.parse(value.coveredUntilTimestamp) % 60_000 !== 0) throw new Error("State cursor time is not minute aligned.");
  if (!Array.isArray(value.days) || value.days.length > 366) throw new Error("State day references are invalid.");
  let previousDay = "";
  for (const reference of value.days) {
    exactKeys(reference, ["assetName", "day", "gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "releaseTag"], "day reference");
    isoDay(reference.day, "day reference day");
    const generation = reference.assetName.match(new RegExp(`^${groupId}-${reference.day}-g([0-9]{16})-([0-9a-f]{64})\\.json\\.gz$`));
    if (reference.day <= previousDay || reference.releaseTag !== `index-${reference.day.slice(0, 7)}` || !generation || BigInt(generation[1]) > BigInt(value.sequence) || generation[2] !== reference.gzipSha256) throw new Error("Day reference identity is invalid.");
    for (const key of ["gzipBytes", "jsonBytes"]) if (!Number.isSafeInteger(reference[key]) || reference[key] <= 0) throw new Error("Day reference byte count is invalid.");
    for (const key of ["gzipSha256", "jsonSha256"]) if (!/^[0-9a-f]{64}$/.test(reference[key])) throw new Error("Day reference digest is invalid.");
    previousDay = reference.day;
  }
  return value;
}

export function encodeDay(value, context) {
  const encoded = encodeArtifact(admitDayArtifact(value, context));
  if (encoded.jsonBytes.byteLength > context.registry.collection.maximumArtifactBytes || encoded.gzipBytes.byteLength > context.registry.collection.maximumArtifactBytes) throw new Error("Day artifact exceeds the admitted byte limit.");
  return encoded;
}

export function encodeState(value, groupId, maximumArtifactBytes = 16_777_216) {
  const encoded = encodeArtifact(admitState(value, groupId));
  if (encoded.jsonBytes.byteLength > maximumArtifactBytes || encoded.gzipBytes.byteLength > maximumArtifactBytes) throw new Error("State artifact exceeds the admitted byte limit.");
  return encoded;
}

export function decodeDay(bytes, context, reference) {
  const decoded = decodeArtifact(bytes, context.registry.collection.maximumArtifactBytes);
  if (reference && (bytes.byteLength !== reference.gzipBytes || decoded.gzipSha256 !== reference.gzipSha256 || decoded.jsonBytes.byteLength !== reference.jsonBytes || decoded.jsonSha256 !== reference.jsonSha256)) throw new Error("Day artifact does not match its state reference.");
  return admitDayArtifact(decoded.value, context);
}

export function decodeState(bytes, groupId, maximumArtifactBytes = 16_777_216, expectedSequence) {
  const state = admitState(decodeArtifact(bytes, maximumArtifactBytes).value, groupId);
  if (expectedSequence !== undefined && BigInt(expectedSequence) !== BigInt(state.sequence)) {
    throw new Error("State asset generation does not match its canonical sequence.");
  }
  return state;
}

export function dayReference({ groupId, day, sequence, encoded }) {
  const generation = String(sequence).padStart(16, "0");
  return {
    day,
    releaseTag: `index-${day.slice(0, 7)}`,
    assetName: `${groupId}-${day}-g${generation}-${encoded.gzipSha256}.json.gz`,
    gzipBytes: encoded.gzipBytes.byteLength,
    gzipSha256: encoded.gzipSha256,
    jsonBytes: encoded.jsonBytes.byteLength,
    jsonSha256: encoded.jsonSha256,
  };
}

export function stateAssetName(groupId, sequence) {
  return `${groupId}-state-g${String(sequence).padStart(16, "0")}.json.gz`;
}

export function verifyEncodedReference(bytes, reference) {
  if (bytes.byteLength !== reference.gzipBytes || sha256Hex(bytes) !== reference.gzipSha256) throw new Error("Stored gzip bytes do not match their reference.");
  return true;
}

export function canonicalStateDigest(state) {
  return sha256Hex(canonicalBytes(state));
}
