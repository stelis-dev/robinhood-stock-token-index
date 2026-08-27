import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "./canonical.mjs";
import { isCanonicalAddress } from "./hex-data.mjs";
import { admitPoolKey } from "./pool-key.mjs";
import { parseUtcInstant } from "./utc-time.mjs";

export const marketDataChainId = "eip155:4663";
export const marketDataNumericChainId = 4663;
export const marketDataFinalityTag = "finalized";
export const marketDataPoolManagerAddress = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const marketDataUsdgAddress = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const marketDataUsdgDecimals = 6;
export const marketDataSwapTopic = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const nativeEthAddress = "0x0000000000000000000000000000000000000000";

const configurationUrl = new URL("../registry/market-data.json", import.meta.url);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const unsignedDecimalPattern = /^(?:0|[1-9][0-9]*)$/u;

export class MarketDataConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketDataConfigurationError";
    this.reason = "configuration_invalid";
  }
}

function reject(message) {
  throw new MarketDataConfigurationError(message);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(`${label} has an invalid member set.`);
  }
}

function unsignedDecimal(value, label) {
  if (typeof value !== "string" || !unsignedDecimalPattern.test(value)) {
    reject(`${label} must be a canonical unsigned decimal string.`);
  }
  return BigInt(value);
}

function decimals(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    reject(`${label} is invalid.`);
  }
  return value;
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]),
    );
  }
  return value;
}

function marketDataConfigurationBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedJsonValue(value), null, 2)}\n`, "utf8");
}

function immutableJson(value) {
  if (Array.isArray(value)) {
    for (const member of value) immutableJson(member);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) immutableJson(member);
    return Object.freeze(value);
  }
  return value;
}

function validateMarketDataConfiguration(value) {
  exactKeys(value, ["baseCurrencies", "poolManager", "usdgDecimals"], "Market-data configuration");
  if (value.poolManager !== marketDataPoolManagerAddress) {
    reject("Market-data PoolManager does not equal the fixed PoolManager.");
  }
  if (value.usdgDecimals !== marketDataUsdgDecimals) {
    reject("Market-data USDG decimals do not equal the fixed USDG decimals.");
  }
  if (
    value.baseCurrencies === null
    || typeof value.baseCurrencies !== "object"
    || Array.isArray(value.baseCurrencies)
  ) {
    reject("Market-data base currencies must be an object.");
  }
  const records = Object.entries(value.baseCurrencies);
  if (records.length === 0) reject("Market-data configuration must contain a base currency.");
  const poolIds = new Set();
  const bases = records.map(([baseCurrencyAddress, record]) => {
    if (!isCanonicalAddress(baseCurrencyAddress) || baseCurrencyAddress === marketDataUsdgAddress) {
      reject("Market-data base currency address is invalid.");
    }
    exactKeys(
      record,
      ["decimals", "initialize", "poolId", "poolKey", "symbol"],
      `Base currency ${baseCurrencyAddress}`,
    );
    const baseDecimals = decimals(record.decimals, `Base currency ${baseCurrencyAddress} decimals`);
    if (baseCurrencyAddress === nativeEthAddress && baseDecimals !== 18) {
      reject("Native ETH decimals must be 18.");
    }
    if (typeof record.symbol !== "string") {
      reject(`Base currency ${baseCurrencyAddress} symbol is invalid.`);
    }
    exactKeys(record.initialize, ["blockNumber", "timestamp"], `Base currency ${baseCurrencyAddress} Initialize`);
    const initializationBlock = unsignedDecimal(
      record.initialize.blockNumber,
      `Base currency ${baseCurrencyAddress} Initialize block`,
    );
    try {
      parseUtcInstant(record.initialize.timestamp, `Base currency ${baseCurrencyAddress} Initialize timestamp`);
    } catch {
      reject(`Base currency ${baseCurrencyAddress} Initialize timestamp is invalid.`);
    }
    let admittedPoolKey;
    try {
      admittedPoolKey = admitPoolKey(record.poolKey, {
        baseCurrencyAddress,
        poolId: record.poolId,
        quoteCurrencyAddress: marketDataUsdgAddress,
      });
    } catch {
      reject(`Base currency ${baseCurrencyAddress} PoolKey or PoolId is invalid.`);
    }
    if (poolIds.has(record.poolId)) {
      reject(`Base currency ${baseCurrencyAddress} PoolId is invalid or duplicated.`);
    }
    poolIds.add(record.poolId);
    return Object.freeze({
      baseCurrencyAddress,
      baseIsCurrency0: admittedPoolKey.baseIsCurrency0,
      decimals: baseDecimals,
      initialize: Object.freeze({
        blockNumber: initializationBlock.toString(),
        timestamp: record.initialize.timestamp,
      }),
      poolId: record.poolId,
      poolKey: admittedPoolKey.poolKey,
    });
  }).sort((left, right) => left.baseCurrencyAddress.localeCompare(right.baseCurrencyAddress));
  return Object.freeze({
    chainId: marketDataChainId,
    numericChainId: marketDataNumericChainId,
    finalityTag: marketDataFinalityTag,
    poolManager: value.poolManager,
    swapTopic: marketDataSwapTopic,
    usdgAddress: marketDataUsdgAddress,
    usdgDecimals: value.usdgDecimals,
    bases: Object.freeze(bases),
    poolIds: Object.freeze([...poolIds].sort()),
  });
}

export function decodeMarketDataConfiguration(bytes) {
  if (!Buffer.isBuffer(bytes)) reject("Market-data configuration bytes are invalid.");
  let value;
  try {
    value = JSON.parse(fatalUtf8Decoder.decode(bytes));
  } catch {
    reject("Market-data configuration must be fatal UTF-8 JSON.");
  }
  if (!marketDataConfigurationBytes(value).equals(bytes)) {
    reject("Market-data configuration JSON encoding is not canonical.");
  }
  const admittedValue = immutableJson(structuredClone(value));
  return Object.freeze({
    bytes: Buffer.from(bytes),
    sha256: sha256Hex(bytes),
    value: admittedValue,
    configuration: validateMarketDataConfiguration(admittedValue),
  });
}

export async function loadMarketDataConfiguration(path = fileURLToPath(configurationUrl)) {
  return decodeMarketDataConfiguration(await readFile(path));
}
