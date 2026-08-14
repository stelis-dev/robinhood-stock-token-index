import { loadPairRegistry } from "../collector/pair-registry.mjs";

function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export async function fixturePairRegistry() {
  return loadPairRegistry();
}

export function pairEntryBySymbol(registry, symbol) {
  const entry = registry.pairs.find((candidate) => candidate.display.baseSymbol === symbol);
  if (!entry) throw new Error(`Fixture pair is missing: ${symbol}`);
  return entry;
}

export function pairCandle({
  intervalStart = "2026-08-14T14:01:00.000Z",
  blockNumber = "36308141",
  open = { numerator: "300", denominator: "1" },
  high = { numerator: "310", denominator: "1" },
  low = { numerator: "295", denominator: "1" },
  close = { numerator: "305", denominator: "1" },
} = {}) {
  const intervalEnd = new Date(Date.parse(intervalStart) + 60_000).toISOString();
  return {
    intervalStart,
    intervalEnd,
    open,
    high,
    low,
    close,
    baseVolumeRaw: "10000000000000000",
    quoteVolumeRaw: "3000000",
    tradeCount: 2,
    firstSource: {
      blockNumber,
      blockHash: hash(BigInt(blockNumber) + 1n),
      transactionIndex: 0,
      transactionHash: hash(BigInt(blockNumber) * 100n + 1n),
      logIndex: 0,
    },
    lastSource: {
      blockNumber,
      blockHash: hash(BigInt(blockNumber) + 1n),
      transactionIndex: 0,
      transactionHash: hash(BigInt(blockNumber) * 100n + 1n),
      logIndex: 1,
    },
  };
}
