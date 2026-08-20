const lowercaseHexPattern = /^[0-9a-f]*$/;

// Ethereum JSON-RPC data is a lowercase 0x-prefixed sequence of complete bytes.

export function isCanonicalHexData(value, byteLength) {
  return typeof value === "string"
    && Number.isSafeInteger(byteLength)
    && byteLength >= 0
    && value.length === 2 + byteLength * 2
    && value.startsWith("0x")
    && lowercaseHexPattern.test(value.slice(2));
}

export function isCanonicalAddress(value) {
  return isCanonicalHexData(value, 20);
}

export function isCanonicalBytes32(value) {
  return isCanonicalHexData(value, 32);
}
