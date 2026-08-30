function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function marketDataConfigurationBytes(value) {
  const sort = (candidate) => candidate !== null && typeof candidate === "object"
    ? Array.isArray(candidate)
      ? candidate.map(sort)
      : Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, sort(candidate[key])]))
    : candidate;
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`, "utf8");
}

function hex(value, bytes = 32) {
  return BigInt(value).toString(16).padStart(bytes * 2, "0");
}

function signedWord(value) {
  const candidate = BigInt(value);
  return hex(candidate < 0n ? (1n << 256n) + candidate : candidate);
}

function unsignedWord(value) {
  return hex(value);
}

export function marketDataBlockHash(number) {
  return `0x${hex(BigInt(number) + 1n)}`;
}

export function marketDataSwapLog({
  configuration,
  base,
  blockNumber,
  baseAmountRaw = 1n,
  quoteAmountRaw = 1n,
  amount0,
  amount1,
  transactionIndex = 0,
  logIndex = 0,
  poolId = base.poolId,
}) {
  const baseAmount = BigInt(baseAmountRaw);
  const quoteAmount = BigInt(quoteAmountRaw);
  const admittedAmount0 = amount0 ?? (base.baseIsCurrency0 ? -baseAmount : quoteAmount);
  const admittedAmount1 = amount1 ?? (base.baseIsCurrency0 ? quoteAmount : -baseAmount);
  return {
    address: configuration.poolManager,
    blockHash: marketDataBlockHash(blockNumber),
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    data: `0x${[
      signedWord(admittedAmount0),
      signedWord(admittedAmount1),
      unsignedWord(1n << 96n),
      unsignedWord(1_000_000n),
      signedWord(0n),
      unsignedWord(3_000n),
    ].join("")}`,
    logIndex: `0x${BigInt(logIndex).toString(16)}`,
    removed: false,
    topics: [
      configuration.swapTopic,
      poolId,
      `0x${"0".repeat(24)}${"1".repeat(40)}`,
    ],
    transactionHash: `0x${hex(BigInt(blockNumber) * 1_000n + BigInt(transactionIndex) + 1n)}`,
    transactionIndex: `0x${BigInt(transactionIndex).toString(16)}`,
  };
}

export function marketDataCandle({
  intervalStart = "2026-08-14T14:01:00.000Z",
  blockNumber = "36308141",
  open = { numerator: "300", denominator: "1" },
  high = { numerator: "310", denominator: "1" },
  low = { numerator: "295", denominator: "1" },
  close = { numerator: "305", denominator: "1" },
} = {}) {
  const intervalEnd = new Date(Date.parse(intervalStart) + 60_000).toISOString();
  return {
    baseVolumeRaw: "10000000000000000",
    close,
    firstSource: {
      blockHash: hash(BigInt(blockNumber) + 1n),
      blockNumber,
      logIndex: 0,
      transactionHash: hash(BigInt(blockNumber) * 100n + 1n),
      transactionIndex: 0,
    },
    high,
    intervalEnd,
    intervalStart,
    lastSource: {
      blockHash: hash(BigInt(blockNumber) + 1n),
      blockNumber,
      logIndex: 1,
      transactionHash: hash(BigInt(blockNumber) * 100n + 1n),
      transactionIndex: 0,
    },
    low,
    open,
    quoteVolumeRaw: "3000000",
    tradeCount: 2,
  };
}
