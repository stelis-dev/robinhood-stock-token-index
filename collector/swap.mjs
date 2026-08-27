import { isCanonicalAddress, isCanonicalBytes32, isCanonicalHexData } from "./hex-data.mjs";
import { parseHexQuantity } from "./hex-quantity.mjs";

const uint256Limit = 1n << 256n;

function word(data, index) {
  const start = 2 + index * 64;
  return `0x${data.slice(start, start + 64)}`;
}

function unsignedWord(value, bits) {
  const result = BigInt(value);
  if (result < 0n || result >= 1n << BigInt(bits)) throw new Error(`Unsigned ${bits}-bit ABI word is out of range.`);
  return result;
}

function signedWord(value, bits) {
  const encoded = BigInt(value);
  if (encoded < 0n || encoded >= uint256Limit) throw new Error("Signed ABI word is outside uint256.");
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  const raw = encoded & mask;
  const sign = 1n << BigInt(bits - 1);
  const negative = (raw & sign) !== 0n;
  const expected = negative ? raw | (uint256Limit - (1n << width)) : raw;
  if (encoded !== expected) throw new Error(`Signed ${bits}-bit ABI word is not sign extended.`);
  return negative ? raw - (1n << width) : raw;
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

export function rational(numerator, denominator) {
  if (denominator === 0n) throw new Error("A rational denominator cannot be zero.");
  let n = numerator;
  let d = denominator;
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d);
  return { numerator: (n / divisor).toString(), denominator: (d / divisor).toString() };
}

function validateSwapLogBlockNumber(log) {
  if (log === null || typeof log !== "object" || Array.isArray(log)) throw new Error("Swap log must be an object.");
  return parseHexQuantity(log.blockNumber, "Swap block number");
}

export function compareRational(left, right) {
  const a = BigInt(left.numerator) * BigInt(right.denominator);
  const b = BigInt(right.numerator) * BigInt(left.denominator);
  return a < b ? -1 : a > b ? 1 : 0;
}

function swapPosition(log, blockNumber) {
  const transactionIndex = parseHexQuantity(log.transactionIndex, "Swap transaction index");
  const logIndex = parseHexQuantity(log.logIndex, "Swap log index");
  if (transactionIndex > BigInt(Number.MAX_SAFE_INTEGER) || logIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Swap source index exceeds the safe integer boundary.");
  }
  return Object.freeze({
    blockNumber: blockNumber.toString(),
    blockHash: log.blockHash,
    transactionIndex: Number(transactionIndex),
    transactionHash: log.transactionHash,
    logIndex: Number(logIndex),
  });
}

function validateSwapSource(source) {
  if (
    source === null
    || typeof source !== "object"
    || Array.isArray(source)
    || JSON.stringify(Object.keys(source).sort()) !== JSON.stringify([
      "baseDecimals",
      "baseIsCurrency0",
      "poolId",
      "poolManager",
      "quoteDecimals",
      "swapTopic",
    ])
    || !Number.isSafeInteger(source.baseDecimals)
    || source.baseDecimals < 0
    || source.baseDecimals > 255
    || typeof source.baseIsCurrency0 !== "boolean"
    || !isCanonicalBytes32(source.poolId)
    || !isCanonicalAddress(source.poolManager)
    || !Number.isSafeInteger(source.quoteDecimals)
    || source.quoteDecimals < 0
    || source.quoteDecimals > 255
    || !isCanonicalBytes32(source.swapTopic)
  ) {
    throw new Error("Swap source is invalid.");
  }
  return source;
}

export function admitSwapLog(log, { poolManager, swapTopic }) {
  if (!isCanonicalAddress(poolManager) || !isCanonicalBytes32(swapTopic)) {
    throw new Error("Swap admission source is invalid.");
  }
  if (log === null || typeof log !== "object" || Array.isArray(log)) throw new Error("Swap log must be an object.");
  const keys = ["address", "blockHash", "blockNumber", "data", "logIndex", "removed", "topics", "transactionHash", "transactionIndex"];
  for (const key of keys) if (!Object.hasOwn(log, key)) throw new Error(`Swap log omitted ${key}.`);
  if (log.address !== poolManager || log.removed !== false) {
    throw new Error("Swap log has an invalid source or removal state.");
  }
  if (
    !Array.isArray(log.topics)
    || log.topics.length !== 3
    || log.topics[0] !== swapTopic
    || !isCanonicalBytes32(log.topics[1])
  ) {
    throw new Error("Swap log topics are invalid.");
  }
  if (!isCanonicalBytes32(log.topics[2]) || !log.topics[2].startsWith(`0x${"0".repeat(24)}`)) throw new Error("Swap sender topic is invalid.");
  if (!isCanonicalBytes32(log.blockHash) || !isCanonicalBytes32(log.transactionHash)) throw new Error("Swap source hash is invalid.");
  const logBlockNumber = validateSwapLogBlockNumber(log);
  const swapPositionValue = swapPosition(log, logBlockNumber);
  if (!isCanonicalHexData(log.data, 192)) throw new Error("Swap data must contain six ABI words.");

  const amount0 = signedWord(word(log.data, 0), 128);
  const amount1 = signedWord(word(log.data, 1), 128);
  const sqrtPriceX96 = unsignedWord(word(log.data, 2), 160);
  const liquidity = unsignedWord(word(log.data, 3), 128);
  const tick = signedWord(word(log.data, 4), 24);
  const fee = unsignedWord(word(log.data, 5), 24);
  if (sqrtPriceX96 === 0n || fee > 1_000_000n) throw new Error("Swap price or fee is invalid.");
  if (amount0 !== 0n && amount1 !== 0n && (amount0 < 0n) === (amount1 < 0n)) {
    throw new Error("Non-zero Swap amounts must have opposite signs.");
  }

  return Object.freeze({
    amount0,
    amount1,
    blockHash: log.blockHash,
    blockNumber: logBlockNumber,
    poolId: log.topics[1],
    swapPosition: swapPositionValue,
  });
}

export function decodeAdmittedSwap(admitted, sourceValue) {
  const source = validateSwapSource(sourceValue);
  if (
    admitted === null
    || typeof admitted !== "object"
    || Array.isArray(admitted)
    || admitted.poolId !== source.poolId
    || typeof admitted.amount0 !== "bigint"
    || typeof admitted.amount1 !== "bigint"
  ) {
    throw new Error("Admitted Swap does not match its configured source.");
  }
  const decoded = {
    blockHash: admitted.blockHash,
    blockNumber: admitted.blockNumber,
    poolId: source.poolId,
    swapPosition: admitted.swapPosition,
    trade: null,
  };
  if (admitted.amount0 === 0n || admitted.amount1 === 0n) return decoded;

  const baseAmount = absolute(source.baseIsCurrency0 ? admitted.amount0 : admitted.amount1);
  const quoteAmount = absolute(source.baseIsCurrency0 ? admitted.amount1 : admitted.amount0);
  decoded.trade = {
    price: rational(
      quoteAmount * 10n ** BigInt(source.baseDecimals),
      baseAmount * 10n ** BigInt(source.quoteDecimals),
    ),
    baseAmountRaw: baseAmount.toString(),
    quoteAmountRaw: quoteAmount.toString(),
  };
  return decoded;
}

export function decodeSwapLog(log, sourceValue) {
  const source = validateSwapSource(sourceValue);
  return decodeAdmittedSwap(admitSwapLog(log, source), source);
}
