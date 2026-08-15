import { compareRational, compareSwapPosition } from "./swap.mjs";

function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

export function compareCandleIdentity(left, right) {
  return left.intervalStart.localeCompare(right.intervalStart);
}

export class CandleAccumulator {
  #buckets = new Map();
  #lastSwapPosition = null;

  constructor({ pairId, candleSeconds = 60, maximumBuckets = Number.MAX_SAFE_INTEGER }) {
    if (typeof pairId !== "string" || !/^0x[0-9a-f]{64}$/.test(pairId)) throw new Error("Candle pair identity is invalid.");
    if (!Number.isSafeInteger(candleSeconds) || candleSeconds <= 0 || !Number.isSafeInteger(maximumBuckets) || maximumBuckets <= 0) {
      throw new Error("Candle accumulator limits are invalid.");
    }
    this.pairId = pairId;
    this.candleSeconds = candleSeconds;
    this.maximumBuckets = maximumBuckets;
  }

  addTrades(trades) {
    if (!Array.isArray(trades)) throw new Error("Candle trades must be an array.");
    const ordered = [...trades].sort((left, right) => compareSwapPosition(left.swapPosition, right.swapPosition));
    for (const trade of ordered) {
      if (trade.pairId !== this.pairId) throw new Error("A trade belongs to another pair.");
      if (this.#lastSwapPosition && compareSwapPosition(this.#lastSwapPosition, trade.swapPosition) >= 0) {
        throw new Error("Swap source positions are duplicated or unordered across ranges.");
      }
      this.#lastSwapPosition = trade.swapPosition;
      const start = Math.floor(trade.blockTimestamp / this.candleSeconds) * this.candleSeconds;
      const existing = this.#buckets.get(start);
      if (existing) {
        if (compareRational(trade.price, existing.high) > 0) existing.high = trade.price;
        if (compareRational(trade.price, existing.low) < 0) existing.low = trade.price;
        existing.close = trade.price;
        existing.baseVolume += BigInt(trade.baseAmountRaw);
        existing.quoteVolume += BigInt(trade.quoteAmountRaw);
        existing.tradeCount += 1;
        existing.lastSource = trade.swapPosition;
        continue;
      }
      if (this.#buckets.size >= this.maximumBuckets) throw new Error("Candle bucket limit exceeded.");
      this.#buckets.set(start, {
        intervalStart: start,
        intervalEnd: start + this.candleSeconds,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        baseVolume: BigInt(trade.baseAmountRaw),
        quoteVolume: BigInt(trade.quoteAmountRaw),
        tradeCount: 1,
        firstSource: trade.swapPosition,
        lastSource: trade.swapPosition,
      });
    }
  }

  values() {
    return [...this.#buckets.values()].map((bucket) => ({
      intervalStart: iso(bucket.intervalStart),
      intervalEnd: iso(bucket.intervalEnd),
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      baseVolumeRaw: bucket.baseVolume.toString(),
      quoteVolumeRaw: bucket.quoteVolume.toString(),
      tradeCount: bucket.tradeCount,
      firstSource: bucket.firstSource,
      lastSource: bucket.lastSource,
    })).sort(compareCandleIdentity);
  }
}

export function mergePairCandles(existing, replacement, fromTimestamp, untilTimestamp) {
  if (!Array.isArray(existing) || !Array.isArray(replacement)) throw new Error("Candle replacement inputs must be arrays.");
  const kept = existing.filter((candle) => candle.intervalStart < fromTimestamp || candle.intervalStart >= untilTimestamp);
  const merged = [...kept, ...replacement].sort(compareCandleIdentity);
  for (let index = 1; index < merged.length; index += 1) {
    if (compareCandleIdentity(merged[index - 1], merged[index]) === 0) throw new Error("Duplicate candle identity.");
  }
  return merged;
}
