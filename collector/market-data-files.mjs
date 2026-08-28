import { decodeArtifact, encodeArtifact, isSha256Hex, sha256Hex } from "./canonical.mjs";
import {
  candleResolutionCatalog,
  createResolutionCandles,
  resolutionDefinition,
  resolutionMonthBounds,
  resolutionSourceBounds,
  validateResolutionCandleSequence,
  validateResolutionCatalog,
} from "./candle-resolution.mjs";
import { isCanonicalAddress, isCanonicalBytes32 } from "./hex-data.mjs";
import {
  marketDataPublicationAssetName,
  physicalAssetIdentity,
  validatePhysicalAssetIdentity,
  validateSelectedAssetEntries,
} from "./market-data-assets.mjs";
import {
  baseDayLogicalId,
  baseMonthLogicalId,
  baseResolutionLogicalId,
  baseStateLogicalId,
  parseMarketDataLogicalId,
} from "./market-data-file-identity.mjs";
import { validateMarketDataCandleSequence } from "./market-data-candle.mjs";
import { admitPoolKey } from "./pool-key.mjs";
import { parseUtcInstant, validateUtcDay, validateUtcMonth } from "./utc-time.mjs";

const unsignedDecimalPattern = /^(?:0|[1-9][0-9]*)$/u;
const rootNamePattern = /^root-s([1-9][0-9]*)-([0-9a-f]{64})\.json\.gz$/u;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function decimalString(value, label) {
  if (typeof value !== "string" || !unsignedDecimalPattern.test(value)) throw new Error(`${label} must be a canonical unsigned decimal string.`);
  return BigInt(value);
}

export function validateCollectionBoundary(value, label = "Collection boundary") {
  exactKeys(value, ["blockNumber", "timestamp"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  parseUtcInstant(value.timestamp, `${label}.timestamp`, true);
  return value;
}

export function validateCoverageSegment(value, label = "Coverage segment") {
  exactKeys(value, ["fromBlock", "fromTimestamp", "poolId", "untilBlock", "untilTimestamp"], label);
  const fromBlock = decimalString(value.fromBlock, `${label}.fromBlock`);
  const untilBlock = decimalString(value.untilBlock, `${label}.untilBlock`);
  const from = parseUtcInstant(value.fromTimestamp, `${label}.fromTimestamp`, true);
  const until = parseUtcInstant(value.untilTimestamp, `${label}.untilTimestamp`, true);
  if (!isCanonicalBytes32(value.poolId) || fromBlock > untilBlock || from >= until) throw new Error(`${label} is invalid.`);
  return value;
}

export function validateCoverageSequence(value, label = "Coverage") {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  let previous = null;
  for (let index = 0; index < value.length; index += 1) {
    const segment = validateCoverageSegment(value[index], `${label}[${index}]`);
    if (previous !== null && (previous.untilTimestamp !== segment.fromTimestamp || previous.untilBlock !== segment.fromBlock)) {
      throw new Error(`${label} is not continuous.`);
    }
    previous = segment;
  }
  return value;
}

export function mergeAdjacentCoverage(value, label = "Coverage") {
  const segments = validateCoverageSequence(value, label);
  const output = [];
  for (const segment of segments) {
    const previous = output.at(-1);
    if (
      previous !== undefined
      && previous.poolId === segment.poolId
      && previous.untilBlock === segment.fromBlock
      && previous.untilTimestamp === segment.fromTimestamp
    ) {
      output[output.length - 1] = Object.freeze({
        ...previous,
        untilBlock: segment.untilBlock,
        untilTimestamp: segment.untilTimestamp,
      });
    } else output.push(Object.freeze({ ...segment }));
  }
  return Object.freeze(output);
}

function validateCandlesInsideCoverage(candles, coverage) {
  for (const candle of candles) {
    const matches = coverage.filter((segment) => (
      segment.fromTimestamp <= candle.intervalStart
      && segment.untilTimestamp >= candle.intervalEnd
      && BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber)
      && BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber)
    ));
    if (matches.length !== 1) throw new Error("Candle has no exact PoolId-owned coverage.");
  }
}

export function validateBaseDayFile(value) {
  exactKeys(value, ["baseCurrencyAddress", "candles", "coverage", "day"], "Base day file");
  if (!isCanonicalAddress(value.baseCurrencyAddress)) throw new Error("Base day address is invalid.");
  const day = validateUtcDay(value.day, "Base day");
  const coverage = validateCoverageSequence(value.coverage, "Base day coverage");
  if (coverage.some((segment) => !segment.fromTimestamp.startsWith(day) || !new Date(Date.parse(segment.untilTimestamp) - 1).toISOString().startsWith(day))) {
    throw new Error("Base day coverage escapes its UTC day.");
  }
  validateMarketDataCandleSequence(value.candles);
  validateCandlesInsideCoverage(value.candles, coverage);
  if (value.candles.some((candle) => !candle.intervalStart.startsWith(day))) throw new Error("Base day candle escapes its UTC day.");
  return value;
}

export function validateBaseResolutionFile(value) {
  exactKeys(value, ["baseCurrencyAddress", "candles", "coverage", "intervalSeconds", "ownerMonth"], "Base resolution file");
  if (!isCanonicalAddress(value.baseCurrencyAddress)) throw new Error("Base resolution address is invalid.");
  const definition = resolutionDefinition(value.intervalSeconds, { derivedOnly: true });
  const ownerMonth = validateUtcMonth(value.ownerMonth, "Resolution owner month");
  const coverage = validateCoverageSequence(value.coverage, "Base resolution coverage");
  const sourceBounds = resolutionSourceBounds({
    intervalSeconds: definition.intervalSeconds,
    ownerMonth,
  });
  const monthBounds = resolutionMonthBounds(ownerMonth);
  if (coverage.some((segment) => (
    segment.fromTimestamp < sourceBounds.fromTimestamp
    || segment.untilTimestamp > sourceBounds.untilTimestamp
  )) || coverage[0].fromTimestamp >= monthBounds.untilTimestamp) {
    throw new Error("Base resolution coverage escapes its owner period.");
  }
  validateResolutionCandleSequence(value.candles, { intervalSeconds: definition.intervalSeconds, ownerMonth });
  validateCandlesInsideCoverage(value.candles, coverage);
  return value;
}

export function createBaseResolutionFile({ baseCurrencyAddress, coverage, candles, intervalSeconds, ownerMonth }) {
  if (!isCanonicalAddress(baseCurrencyAddress)) throw new Error("Base resolution address is invalid.");
  const definition = resolutionDefinition(intervalSeconds, { derivedOnly: true });
  const month = validateUtcMonth(ownerMonth, "Resolution owner month");
  const admittedCoverage = validateCoverageSequence(coverage, "Resolution source coverage");
  validateMarketDataCandleSequence(candles);
  validateCandlesInsideCoverage(candles, admittedCoverage);
  const sourceBounds = resolutionSourceBounds({
    intervalSeconds: definition.intervalSeconds,
    ownerMonth: month,
  });
  const selectedCoverage = mergeAdjacentCoverage(admittedCoverage.filter((segment) => (
    segment.untilTimestamp > sourceBounds.fromTimestamp
    && segment.fromTimestamp < sourceBounds.untilTimestamp
  )), "Resolution selected coverage");
  const output = [];
  for (const segment of selectedCoverage) {
    const segmentCandles = candles.filter((candle) => (
      segment.fromTimestamp <= candle.intervalStart
      && segment.untilTimestamp >= candle.intervalEnd
      && BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber)
      && BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber)
    ));
    const created = createResolutionCandles({
      candles: segmentCandles,
      fromTimestamp: segment.fromTimestamp,
      intervalSeconds: definition.intervalSeconds,
      ownerMonth: month,
      untilTimestamp: segment.untilTimestamp,
    });
    output.push(...created.candles);
  }
  output.sort((left, right) => left.intervalStart.localeCompare(right.intervalStart));
  return validateBaseResolutionFile({
    baseCurrencyAddress,
    candles: output,
    coverage: selectedCoverage,
    intervalSeconds: definition.intervalSeconds,
    ownerMonth: month,
  });
}

export function validateStoredMemberReference(value, expectedLogicalId) {
  exactKeys(value, ["assetSha256", "from", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId", "until"], "Stored member reference");
  parseMarketDataLogicalId(value.logicalId);
  if (expectedLogicalId !== undefined && value.logicalId !== expectedLogicalId) throw new Error("Stored member logical identity is invalid.");
  const from = nonnegativeInteger(value.from, "Stored member from");
  const until = positiveInteger(value.until, "Stored member until");
  positiveInteger(value.jsonBytes, "Stored member JSON bytes");
  if (from >= until || !isSha256Hex(value.assetSha256) || !isSha256Hex(value.gzipSha256) || !isSha256Hex(value.jsonSha256)) {
    throw new Error("Stored member reference is invalid.");
  }
  return value;
}

export function validateBaseMonthFile(value) {
  exactKeys(value, ["baseCurrencyAddress", "coverage", "days", "month", "resolutions"], "Base month file");
  if (!isCanonicalAddress(value.baseCurrencyAddress)) throw new Error("Base month address is invalid.");
  const month = validateUtcMonth(value.month, "Base month");
  const coverage = validateCoverageSequence(value.coverage, "Base month coverage");
  const monthFrom = `${month}-01T00:00:00.000Z`;
  const monthUntil = new Date(monthFrom);
  monthUntil.setUTCMonth(monthUntil.getUTCMonth() + 1);
  if (coverage.some((segment) => segment.fromTimestamp < monthFrom || segment.untilTimestamp > monthUntil.toISOString())) {
    throw new Error("Base month coverage escapes its UTC month.");
  }
  if (!Array.isArray(value.days) || value.days.length === 0) throw new Error("Base month days are invalid.");
  let previousDay = "";
  for (const reference of value.days) {
    const identity = parseMarketDataLogicalId(reference.logicalId);
    if (identity.kind !== "day" || !identity.period.startsWith(month) || identity.period <= previousDay) throw new Error("Base month days are invalid.");
    validateStoredMemberReference(reference, baseDayLogicalId(value.baseCurrencyAddress, identity.period));
    previousDay = identity.period;
  }
  const definitions = candleResolutionCatalog.slice(1);
  if (value.resolutions === null || typeof value.resolutions !== "object" || Array.isArray(value.resolutions)
    || JSON.stringify(Object.keys(value.resolutions).sort()) !== JSON.stringify(definitions.map((entry) => entry.label).sort())) {
    throw new Error("Base month resolutions are invalid.");
  }
  for (const definition of definitions) {
    validateStoredMemberReference(value.resolutions[definition.label], baseResolutionLogicalId(value.baseCurrencyAddress, definition.label, month));
  }
  return value;
}

function validateBaseState(value, configuration, requireMonths) {
  exactKeys(value, ["baseCurrencyAddress", "decimals", "months", "poolPeriods", "pools"], "Base state file");
  const configured = configuration.bases.find((base) => base.baseCurrencyAddress === value.baseCurrencyAddress);
  if (configured === undefined || value.decimals !== configured.decimals) throw new Error("Base state configuration is invalid.");
  const periods = validateCoverageSequence(value.poolPeriods, "Base state PoolId periods");
  if (value.pools === null || typeof value.pools !== "object" || Array.isArray(value.pools)) throw new Error("Base state pools are invalid.");
  for (const [poolId, facts] of Object.entries(value.pools)) {
    if (!isCanonicalBytes32(poolId)) throw new Error("Base state PoolId is invalid.");
    exactKeys(facts, ["historyFrom", "initialize", "poolKey", "sourceFrom"], "Base state PoolId facts");
    validateCollectionBoundary(facts.historyFrom, "PoolId historyFrom");
    validateCollectionBoundary(facts.sourceFrom, "PoolId sourceFrom");
    exactKeys(facts.initialize, ["blockNumber", "timestamp"], "PoolId Initialize");
    decimalString(facts.initialize.blockNumber, "PoolId Initialize block");
    parseUtcInstant(facts.initialize.timestamp, "PoolId Initialize timestamp");
    admitPoolKey(facts.poolKey, { baseCurrencyAddress: value.baseCurrencyAddress, poolId, quoteCurrencyAddress: configuration.usdgAddress });
    const owned = periods.filter((period) => period.poolId === poolId);
    if (owned.length === 0 || owned[0].fromBlock !== facts.historyFrom.blockNumber || owned[0].fromTimestamp !== facts.historyFrom.timestamp) {
      throw new Error("Base state PoolId history boundary is invalid.");
    }
  }
  if (periods.some((period) => value.pools[period.poolId] === undefined)) throw new Error("Base state period has no PoolId facts.");
  if (!Array.isArray(value.months) || requireMonths && value.months.length === 0) throw new Error("Base state months are invalid.");
  let previousMonth = "";
  for (const reference of value.months) {
    const identity = parseMarketDataLogicalId(reference.logicalId);
    if (identity.kind !== "month" || identity.period <= previousMonth) throw new Error("Base state months are invalid.");
    validateStoredMemberReference(reference, baseMonthLogicalId(value.baseCurrencyAddress, identity.period));
    previousMonth = identity.period;
  }
  return value;
}

export function validateBaseStateProgress(value, configuration) {
  return validateBaseState(value, configuration, false);
}

export function validateBaseStateFile(value, configuration) {
  return validateBaseState(value, configuration, true);
}

function selectedLogicalIds(assets) {
  return new Map(assets.flatMap((asset) => asset.logicalIds.map((logicalId) => [logicalId, asset.sha256])));
}

export function validateSelectedRoot(value, configuration) {
  exactKeys(value, ["assets", "baseCurrencies", "currentUntil", "poolManager", "publicationSequence", "resolutions", "usdgAddress", "usdgDecimals"], "Selected root");
  positiveInteger(value.publicationSequence, "Root publication sequence");
  validateCollectionBoundary(value.currentUntil, "Root currentUntil");
  if (value.poolManager !== configuration.poolManager || value.usdgAddress !== configuration.usdgAddress || value.usdgDecimals !== configuration.usdgDecimals) {
    throw new Error("Selected root global facts are invalid.");
  }
  validateResolutionCatalog(value.resolutions);
  validateSelectedAssetEntries(value.assets);
  if (value.assets.length === 0) throw new Error("Selected root assets are empty.");
  const logicalIds = selectedLogicalIds(value.assets);
  if (
    value.baseCurrencies === null
    || typeof value.baseCurrencies !== "object"
    || Array.isArray(value.baseCurrencies)
    || Object.keys(value.baseCurrencies).length === 0
  ) throw new Error("Selected root base currencies are invalid.");
  for (const [address, reference] of Object.entries(value.baseCurrencies)) {
    if (!configuration.bases.some((base) => base.baseCurrencyAddress === address)) throw new Error("Selected root base currency is not configured.");
    validateStoredMemberReference(reference, baseStateLogicalId(address));
    if (logicalIds.get(reference.logicalId) !== reference.assetSha256) throw new Error("Selected root base state membership is invalid.");
  }
  return value;
}

function validateFinalizedBlock(value) {
  exactKeys(value, ["blockHash", "blockNumber", "timestamp"], "Finalized block");
  if (!isCanonicalBytes32(value.blockHash)) throw new Error("Finalized block hash is invalid.");
  decimalString(value.blockNumber, "Finalized block number");
  parseUtcInstant(value.timestamp, "Finalized block timestamp");
}

function validateSharedRange(value) {
  exactKeys(value, ["fromBlock", "fromTimestamp", "poolIds", "untilBlock", "untilTimestamp"], "Shared range");
  const fromBlock = decimalString(value.fromBlock, "Shared range fromBlock");
  const untilBlock = decimalString(value.untilBlock, "Shared range untilBlock");
  const from = parseUtcInstant(value.fromTimestamp, "Shared range fromTimestamp", true);
  const until = parseUtcInstant(value.untilTimestamp, "Shared range untilTimestamp", true);
  if (fromBlock > untilBlock || from >= until || !Array.isArray(value.poolIds) || value.poolIds.length === 0) throw new Error("Shared range is invalid.");
  let previous = "";
  for (const poolId of value.poolIds) {
    if (!isCanonicalBytes32(poolId) || poolId <= previous) throw new Error("Shared range PoolIds are invalid.");
    previous = poolId;
  }
}

export function validatePublicationRecord(value) {
  exactKeys(value, ["configurationSha256", "finalizedBlock", "newAssets", "nextRoot", "phase", "previousAssets", "previousRoot", "ranges", "supersededAssets", "target"], "Publication record");
  if (!isSha256Hex(value.configurationSha256)) throw new Error("Publication configuration identity is invalid.");
  validateFinalizedBlock(value.finalizedBlock);
  validateCollectionBoundary(value.target, "Publication target");
  if (!new Set(["current", "history", "repair"]).has(value.phase)) throw new Error("Publication phase is invalid.");
  validateSelectedAssetEntries(value.previousAssets);
  for (const key of ["newAssets", "supersededAssets"]) {
    if (!Array.isArray(value[key])) throw new Error(`Publication ${key} is invalid.`);
    let previous = "";
    for (const identity of value[key]) {
      validatePhysicalAssetIdentity(identity);
      if (identity.sha256 <= previous) throw new Error(`Publication ${key} is duplicated or unordered.`);
      previous = identity.sha256;
    }
  }
  validatePhysicalAssetIdentity(value.nextRoot);
  if (value.previousRoot !== null) validatePhysicalAssetIdentity(value.previousRoot);
  if (!Array.isArray(value.ranges) || value.ranges.length === 0) throw new Error("Publication ranges are invalid.");
  for (const range of value.ranges) validateSharedRange(range);
  return value;
}

function validateLogicalFileIdentity(logicalId, value, configuration) {
  const identity = parseMarketDataLogicalId(logicalId);
  if (identity.kind === "day") {
    const admitted = validateBaseDayFile(value);
    if (admitted.baseCurrencyAddress !== identity.baseCurrencyAddress || admitted.day !== identity.period) {
      throw new Error("Base day logical identity does not match its contents.");
    }
  } else if (identity.kind === "resolution") {
    const admitted = validateBaseResolutionFile(value);
    if (
      admitted.baseCurrencyAddress !== identity.baseCurrencyAddress
      || admitted.ownerMonth !== identity.period
      || admitted.intervalSeconds !== identity.intervalSeconds
    ) throw new Error("Base resolution logical identity does not match its contents.");
  } else if (identity.kind === "month") {
    const admitted = validateBaseMonthFile(value);
    if (admitted.baseCurrencyAddress !== identity.baseCurrencyAddress || admitted.month !== identity.period) {
      throw new Error("Base month logical identity does not match its contents.");
    }
  } else {
    const admitted = validateBaseStateFile(value, configuration);
    if (admitted.baseCurrencyAddress !== identity.baseCurrencyAddress) {
      throw new Error("Base state logical identity does not match its contents.");
    }
  }
  return value;
}

export function encodeMarketDataLogicalFile(logicalId, value, configuration) {
  validateLogicalFileIdentity(logicalId, value, configuration);
  const encoded = encodeArtifact(value);
  return Object.freeze({
    gzipBytes: encoded.gzipBytes,
    gzipSha256: encoded.gzipSha256,
    jsonBytes: encoded.jsonBytes,
    jsonSha256: encoded.jsonSha256,
    logicalId,
  });
}

export function decodeMarketDataLogicalFile(logicalId, gzipBytes, maximumBytes, configuration) {
  const decoded = decodeArtifact(gzipBytes, maximumBytes);
  validateLogicalFileIdentity(logicalId, decoded.value, configuration);
  return decoded;
}

export function rootAssetIdentity(sequence, gzipBytes) {
  positiveInteger(sequence, "Root publication sequence");
  if (!Buffer.isBuffer(gzipBytes) || gzipBytes.byteLength === 0) throw new Error("Root bytes are invalid.");
  const sha256 = sha256Hex(gzipBytes);
  return Object.freeze({
    assetName: `root-s${sequence}-${sha256}.json.gz`,
    bytes: gzipBytes.byteLength,
    releaseTag: "market-data-catalog",
    sha256,
  });
}

export function publicationRecordAssetIdentity(gzipBytes) {
  if (!Buffer.isBuffer(gzipBytes) || gzipBytes.byteLength === 0) throw new Error("Publication record bytes are invalid.");
  return Object.freeze({
    assetName: marketDataPublicationAssetName,
    bytes: gzipBytes.byteLength,
    releaseTag: "market-data-catalog",
    sha256: sha256Hex(gzipBytes),
  });
}

export function parseRootAssetName(value) {
  const match = typeof value === "string" ? value.match(rootNamePattern) : null;
  if (match === null) return null;
  const publicationSequence = Number(match[1]);
  return Number.isSafeInteger(publicationSequence) ? { publicationSequence, sha256: match[2] } : null;
}

export function decodeStoredMember(reference, gzipBytes, maximumBytes, configuration) {
  validateStoredMemberReference(reference);
  if (!Buffer.isBuffer(gzipBytes) || gzipBytes.byteLength !== reference.until - reference.from || sha256Hex(gzipBytes) !== reference.gzipSha256) {
    throw new Error("Stored member gzip identity is invalid.");
  }
  const decoded = decodeMarketDataLogicalFile(reference.logicalId, gzipBytes, maximumBytes, configuration);
  if (decoded.jsonBytes.byteLength !== reference.jsonBytes || decoded.jsonSha256 !== reference.jsonSha256) throw new Error("Stored member JSON identity is invalid.");
  return decoded.value;
}

export function projectPhysicalIdentities(entries) {
  validateSelectedAssetEntries(entries);
  return Object.freeze(entries.map(physicalAssetIdentity));
}
