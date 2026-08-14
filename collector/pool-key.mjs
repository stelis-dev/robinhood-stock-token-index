import { keccak_256 } from "@noble/hashes/sha3.js";

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
