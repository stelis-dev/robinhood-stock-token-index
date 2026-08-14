const canonicalHexQuantityPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

export function isCanonicalHexQuantity(value) {
  return typeof value === "string" && canonicalHexQuantityPattern.test(value);
}

export function parseHexQuantity(value, label) {
  if (!isCanonicalHexQuantity(value)) {
    throw new Error(`${label} is not a canonical hex quantity.`);
  }
  return BigInt(value);
}

export function safeHexQuantityNumber(value, label) {
  const result = parseHexQuantity(value, label);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer boundary.`);
  }
  return Number(result);
}
