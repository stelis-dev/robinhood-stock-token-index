import { keccak_256 } from "@noble/hashes/sha3.js";
import { isCanonicalAddress, isCanonicalBytes32 } from "./hex-data.mjs";

function abiWord(value, bytes) {
  const hex = typeof value === "bigint" ? value.toString(16) : value.slice(2);
  if (hex.length > bytes * 2) throw new Error("ABI value exceeds its type width.");
  return hex.padStart(64, "0");
}

export function derivePoolId({ currency0, currency1, fee, tickSpacing, hooks }) {
  const encoded = [
    abiWord(currency0, 20),
    abiWord(currency1, 20),
    abiWord(BigInt(fee), 3),
    abiWord(BigInt(tickSpacing), 3),
    abiWord(hooks, 20),
  ].join("");
  return `0x${Buffer.from(keccak_256(Buffer.from(encoded, "hex"))).toString("hex")}`;
}

export function admitPoolKey(value, { baseCurrencyAddress, poolId, quoteCurrencyAddress }) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(["currency0", "currency1", "fee", "hooks", "tickSpacing"])
    || !isCanonicalAddress(baseCurrencyAddress)
    || !isCanonicalBytes32(poolId)
    || !isCanonicalAddress(quoteCurrencyAddress)
  ) {
    throw new Error("PoolKey input is invalid.");
  }
  for (const key of ["currency0", "currency1", "hooks"]) {
    if (!isCanonicalAddress(value[key])) throw new Error("PoolKey is invalid.");
  }
  const baseIsCurrency0 = value.currency0 === baseCurrencyAddress;
  if (
    BigInt(value.currency0) >= BigInt(value.currency1)
    || !Number.isSafeInteger(value.fee)
    || value.fee < 0
    || value.fee >= 2 ** 24
    || !Number.isSafeInteger(value.tickSpacing)
    || value.tickSpacing <= 0
    || value.tickSpacing >= 2 ** 23
    || !(
      baseIsCurrency0 && value.currency1 === quoteCurrencyAddress
      || value.currency1 === baseCurrencyAddress && value.currency0 === quoteCurrencyAddress
    )
    || derivePoolId(value) !== poolId
  ) {
    throw new Error("PoolKey is invalid.");
  }
  return Object.freeze({
    baseIsCurrency0,
    poolKey: Object.freeze({ ...value }),
  });
}
