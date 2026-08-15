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

  addSwaps(swaps) {
    if (!Array.isArray(swaps)) throw new Error("Decoded Swaps must be an array.");
    const ordered = [...swaps].sort((left, right) => compareSwapPosition(left.swapPosition, right.swapPosition));
    for (const swap of ordered) {
      if (swap.pairId !== this.pairId) throw new Error("A Swap belongs to another pair.");
      if (this.#lastSwapPosition && compareSwapPosition(this.#lastSwapPosition, swap.swapPosition) >= 0) {
        throw new Error("Swap source positions are duplicated or unordered across ranges.");
      }
      this.#lastSwapPosition = swap.swapPosition;
      if (swap.trade === null) continue;
      const start = Math.floor(swap.blockTimestamp / this.candleSeconds) * this.candleSeconds;
      const existing = this.#buckets.get(start);
      if (existing) {
        if (compareRational(swap.trade.price, existing.high) > 0) existing.high = swap.trade.price;
        if (compareRational(swap.trade.price, existing.low) < 0) existing.low = swap.trade.price;
        existing.close = swap.trade.price;
        existing.baseVolume += BigInt(swap.trade.baseAmountRaw);
        existing.quoteVolume += BigInt(swap.trade.quoteAmountRaw);
        existing.tradeCount += 1;
        existing.lastSource = swap.swapPosition;
        continue;
      }
      if (this.#buckets.size >= this.maximumBuckets) throw new Error("Candle bucket limit exceeded.");
      this.#buckets.set(start, {
        intervalStart: start,
        intervalEnd: start + this.candleSeconds,
        open: swap.trade.price,
        high: swap.trade.price,
        low: swap.trade.price,
        close: swap.trade.price,
        baseVolume: BigInt(swap.trade.baseAmountRaw),
        quoteVolume: BigInt(swap.trade.quoteAmountRaw),
        tradeCount: 1,
        firstSource: swap.swapPosition,
        lastSource: swap.swapPosition,
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
