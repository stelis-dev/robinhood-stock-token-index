import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { derivePoolId } from "./pool-key.mjs";
import { admitRpcUrl, maximumRpcBatchSize } from "./rpc-endpoint.mjs";

const addressPattern = /^0x[0-9a-f]{40}$/;
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const symbolPattern = /^[A-Z][A-Z0-9.]{0,15}$/;
const nativeCurrency = "0x0000000000000000000000000000000000000000";
const registryUrl = new URL("../registry/pairs.json", import.meta.url);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}

function decimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a decimal integer string.`);
  }
  return BigInt(value);
}

function instant(value, label, minuteAligned = false) {
  if (typeof value !== "string" || !instantPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC instant.`);
  }
  if (new Date(value).toISOString() !== value || minuteAligned && Date.parse(value) % 60_000 !== 0) {
    throw new Error(`${label} has an invalid UTC boundary.`);
  }
  return Date.parse(value);
}

function nonemptyText(value, label, maximumLength = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${label} is invalid.`);
  }
}

function admitAsset(value, label) {
  if (value?.kind === "erc20") {
    exactKeys(value, ["address", "decimals", "kind"], label);
    if (!addressPattern.test(value.address) || value.address === nativeCurrency) throw new Error(`${label} ERC-20 address is invalid.`);
  } else if (value?.kind === "native") {
    exactKeys(value, ["currency", "decimals", "kind"], label);
    if (value.currency !== nativeCurrency) {
      throw new Error(`${label} native currency is invalid.`);
    }
    if (value.decimals !== 18) throw new Error(`${label} native decimals must be 18.`);
  } else {
    throw new Error(`${label} kind is invalid.`);
  }
  if (!Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
    throw new Error(`${label} decimals are invalid.`);
  }
  return value;
}

function assetCurrency(value) {
  return value.kind === "native" ? value.currency : value.address;
}

function assetLocator(value) {
  return `${value.kind}:${assetCurrency(value)}`;
}

function admitAssetFacts(asset, symbol, name, facts) {
  const locator = assetLocator(asset);
  const value = JSON.stringify([asset.decimals, symbol, name]);
  const existing = facts.get(locator);
  if (existing !== undefined && existing !== value) {
    throw new Error("An asset locator has conflicting numeric or display facts.");
  }
  facts.set(locator, value);
}

function admitInitialization(value) {
  exactKeys(value, ["blockNumber", "timestamp"], "sourceInitialization");
  decimalString(value.blockNumber, "sourceInitialization.blockNumber");
  instant(value.timestamp, "sourceInitialization.timestamp");
}

function admitMinuteBoundary(value, label, withHash = false) {
  exactKeys(value, withHash ? ["blockNumber", "hash", "timestamp"] : ["blockNumber", "timestamp"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  instant(value.timestamp, `${label}.timestamp`, true);
  if (withHash && !bytes32Pattern.test(value.hash)) throw new Error(`${label}.hash is invalid.`);
}

export function subtractUtcCalendarMonths(value, months) {
  instant(value, "calendar source", true);
  positiveInteger(months, "calendar month count");
  const source = new Date(value);
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() - months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
  )).toISOString();
}

function minuteFloor(value) {
  return new Date(Math.floor(Date.parse(value) / 60_000) * 60_000).toISOString();
}

function admitPairDescriptor(value, registry) {
  exactKeys(value, [
    "activation",
    "baseAsset",
    "baseIsCurrency0",
    "chainId",
    "finality",
    "historyStart",
    "pairId",
    "poolKey",
    "poolManager",
    "quoteAsset",
    "sourceInitialization",
    "swapTopic",
  ], "pair descriptor");
  if (!bytes32Pattern.test(value.pairId)) throw new Error("Pair ID is invalid.");
  if (value.chainId !== registry.chain.chainId || value.finality !== registry.chain.finalityTag || value.poolManager !== registry.deployment.poolManager || value.swapTopic !== registry.deployment.swapTopic) {
    throw new Error("Pair source does not match the registry deployment.");
  }
  admitAsset(value.baseAsset, "baseAsset");
  admitAsset(value.quoteAsset, "quoteAsset");
  if (typeof value.baseIsCurrency0 !== "boolean") throw new Error("Pair orientation is invalid.");
  exactKeys(value.poolKey, ["currency0", "currency1", "fee", "hooks", "tickSpacing"], "poolKey");
  for (const key of ["currency0", "currency1", "hooks"]) {
    if (!addressPattern.test(value.poolKey[key])) throw new Error(`poolKey.${key} is invalid.`);
  }
  positiveInteger(value.poolKey.fee, "poolKey.fee");
  positiveInteger(value.poolKey.tickSpacing, "poolKey.tickSpacing");
  if (value.poolKey.fee > 1_000_000 || value.poolKey.tickSpacing > 8_388_607 || BigInt(value.poolKey.currency0) >= BigInt(value.poolKey.currency1)) {
    throw new Error("PoolKey numeric or currency order is invalid.");
  }
  const baseCurrency = assetCurrency(value.baseAsset);
  const quoteCurrency = assetCurrency(value.quoteAsset);
  if (baseCurrency === quoteCurrency || (value.baseIsCurrency0 ? value.poolKey.currency0 : value.poolKey.currency1) !== baseCurrency || (value.baseIsCurrency0 ? value.poolKey.currency1 : value.poolKey.currency0) !== quoteCurrency) {
    throw new Error("Pair assets do not match the PoolKey orientation.");
  }
  if (derivePoolId(value.poolKey) !== value.pairId) throw new Error("Pair ID does not derive from its PoolKey.");

  admitInitialization(value.sourceInitialization);
  admitMinuteBoundary(value.historyStart, "historyStart");
  admitMinuteBoundary(value.activation, "activation", true);
  const initializationBlock = decimalString(value.sourceInitialization.blockNumber, "sourceInitialization.blockNumber");
  const historyBlock = decimalString(value.historyStart.blockNumber, "historyStart.blockNumber");
  const activationBlock = decimalString(value.activation.blockNumber, "activation.blockNumber");
  const initializationTime = instant(value.sourceInitialization.timestamp, "sourceInitialization.timestamp");
  const historyTime = instant(value.historyStart.timestamp, "historyStart.timestamp", true);
  const activationTime = instant(value.activation.timestamp, "activation.timestamp", true);
  if (initializationBlock > historyBlock || historyBlock > activationBlock || initializationTime > historyTime + 59_999 || historyTime > activationTime) {
    throw new Error("Pair source, history, and activation boundaries are inverted.");
  }
  const calendarCutoff = subtractUtcCalendarMonths(value.activation.timestamp, registry.collection.historyMonths);
  const initializationFloor = minuteFloor(value.sourceInitialization.timestamp);
  const expectedHistoryTime = initializationFloor > calendarCutoff ? initializationFloor : calendarCutoff;
  if (value.historyStart.timestamp !== expectedHistoryTime) throw new Error("Pair history start does not match the source/calendar boundary.");
  if (initializationFloor >= calendarCutoff && value.historyStart.blockNumber !== value.sourceInitialization.blockNumber) {
    throw new Error("Pair history start must use its initialization block.");
  }
  return value;
}

function admitDisplay(value) {
  exactKeys(value, ["baseName", "baseSymbol", "label", "quoteName", "quoteSymbol"], "pair display");
  for (const key of ["baseSymbol", "quoteSymbol"]) {
    if (typeof value[key] !== "string" || !symbolPattern.test(value[key])) throw new Error(`pair display ${key} is invalid.`);
  }
  for (const key of ["baseName", "quoteName", "label"]) nonemptyText(value[key], `pair display ${key}`);
  if (value.label !== `${value.baseSymbol}/${value.quoteSymbol}`) throw new Error("Pair display label is inconsistent.");
  return value;
}

export function admitPairRegistry(candidate) {
  exactKeys(candidate, ["chain", "collection", "deployment", "pairs"], "pair registry");

  exactKeys(candidate.chain, ["chainId", "finalityTag", "numericChainId", "primaryRpcUrl"], "chain");
  const chainIdentity = typeof candidate.chain.chainId === "string" ? candidate.chain.chainId.match(/^eip155:([1-9][0-9]*)$/) : null;
  positiveInteger(candidate.chain.numericChainId, "chain.numericChainId");
  if (!chainIdentity || BigInt(chainIdentity[1]) !== BigInt(candidate.chain.numericChainId) || candidate.chain.finalityTag !== "finalized") {
    throw new Error("Chain identity or finality is invalid.");
  }
  admitRpcUrl(candidate.chain.primaryRpcUrl, "Primary RPC URL");

  exactKeys(candidate.deployment, ["poolManager", "stateView", "swapTopic"], "deployment");
  if (!addressPattern.test(candidate.deployment.poolManager) || !addressPattern.test(candidate.deployment.stateView) || !bytes32Pattern.test(candidate.deployment.swapTopic)) {
    throw new Error("Deployment identity is invalid.");
  }

  const collectionKeys = [
    "candleSeconds",
    "headerBatchSize",
    "historyMonths",
    "logRangeBlocks",
    "maximumArtifactBytes",
    "maximumBlocksPerRun",
    "maximumResponseBytes",
    "maximumRpcAttempts",
    "maximumRpcRetryDelayMilliseconds",
    "repairLookbackSeconds",
    "requestDelayMilliseconds",
    "requestTimeoutMilliseconds",
  ];
  exactKeys(candidate.collection, collectionKeys, "collection");
  for (const key of collectionKeys) positiveInteger(candidate.collection[key], `collection.${key}`);
  if (candidate.collection.candleSeconds !== 60 || candidate.collection.historyMonths !== 12) throw new Error("Unexpected candle or history boundary.");
  if (candidate.collection.headerBatchSize > maximumRpcBatchSize || candidate.collection.maximumArtifactBytes > 16_777_216 || candidate.collection.maximumResponseBytes > 16_777_216) {
    throw new Error("Collection byte or batch boundary exceeds the admitted limit.");
  }
  if (candidate.collection.maximumRpcAttempts > 10 || candidate.collection.maximumRpcRetryDelayMilliseconds > 300_000) {
    throw new Error("RPC retry boundary exceeds the admitted limit.");
  }

  if (!Array.isArray(candidate.pairs) || candidate.pairs.length === 0) {
    throw new Error("Pair count is invalid.");
  }
  const assetFacts = new Map();
  let previousPairId = "";
  for (const entry of candidate.pairs) {
    exactKeys(entry, ["display", "pair"], "pair registry entry");
    admitPairDescriptor(entry.pair, candidate);
    admitDisplay(entry.display);
    admitAssetFacts(entry.pair.baseAsset, entry.display.baseSymbol, entry.display.baseName, assetFacts);
    admitAssetFacts(entry.pair.quoteAsset, entry.display.quoteSymbol, entry.display.quoteName, assetFacts);
    if (entry.pair.pairId <= previousPairId) throw new Error("Pairs must be uniquely ordered by pair ID.");
    previousPairId = entry.pair.pairId;
  }
  return candidate;
}

export async function loadPairRegistry(path = fileURLToPath(registryUrl)) {
  return admitPairRegistry(JSON.parse(await readFile(path, "utf8")));
}

export function pairById(registry, pairId) {
  const entry = registry.pairs.find((candidate) => candidate.pair.pairId === pairId);
  if (!entry) throw new Error(`Unknown pair: ${pairId}`);
  return entry;
}
