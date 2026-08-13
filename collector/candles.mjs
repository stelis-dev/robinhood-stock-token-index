import { compareRational, compareSourcePosition } from "./swap.mjs";

function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

export function compareCandleIdentity(left, right) {
  return left.poolId.localeCompare(right.poolId) || left.intervalStart.localeCompare(right.intervalStart);
}

export function buildCandles(trades, candleSeconds = 60) {
  const accumulator = new CandleAccumulator({ candleSeconds });
  accumulator.addTrades(trades);
  return accumulator.values();
}

export class CandleAccumulator {
  #buckets = new Map();
  #lastSource = null;

  constructor({ candleSeconds = 60, maximumBuckets = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(candleSeconds) || candleSeconds <= 0 || !Number.isSafeInteger(maximumBuckets) || maximumBuckets <= 0) {
      throw new Error("Candle accumulator limits are invalid.");
    }
    this.candleSeconds = candleSeconds;
    this.maximumBuckets = maximumBuckets;
  }

  addTrades(trades) {
    const ordered = [...trades].sort((a, b) => compareSourcePosition(a.source, b.source));
    for (const trade of ordered) {
      if (this.#lastSource && compareSourcePosition(this.#lastSource, trade.source) >= 0) {
        throw new Error("Swap source positions are duplicated or unordered across ranges.");
      }
      this.#lastSource = trade.source;
      const start = Math.floor(trade.blockTimestamp / this.candleSeconds) * this.candleSeconds;
      const key = `${trade.asset.poolId}:${start}`;
      const existing = this.#buckets.get(key);
      if (existing) {
        if (compareRational(trade.price, existing.high) > 0) existing.high = trade.price;
        if (compareRational(trade.price, existing.low) < 0) existing.low = trade.price;
        existing.close = trade.price;
        existing.tokenVolume += BigInt(trade.tokenAmountRaw);
        existing.quoteVolume += BigInt(trade.quoteAmountRaw);
        existing.tradeCount += 1;
        existing.lastSource = trade.source;
        continue;
      }
      if (this.#buckets.size >= this.maximumBuckets) throw new Error("Candle bucket limit exceeded.");
      this.#buckets.set(key, {
        asset: trade.asset,
        intervalStart: start,
        intervalEnd: start + this.candleSeconds,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        tokenVolume: BigInt(trade.tokenAmountRaw),
        quoteVolume: BigInt(trade.quoteAmountRaw),
        tradeCount: 1,
        firstSource: trade.source,
        lastSource: trade.source,
      });
    }
  }

  values() {
    return [...this.#buckets.values()].map((bucket) => ({
      symbol: bucket.asset.symbol,
      token: bucket.asset.token,
      poolId: bucket.asset.poolId,
      intervalStart: iso(bucket.intervalStart),
      intervalEnd: iso(bucket.intervalEnd),
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      tokenVolumeRaw: bucket.tokenVolume.toString(),
      quoteVolumeRaw: bucket.quoteVolume.toString(),
      tradeCount: bucket.tradeCount,
      firstSource: bucket.firstSource,
      lastSource: bucket.lastSource,
    })).sort(compareCandleIdentity);
  }
}

export function mergeCandles(existing, replacement, fromTimestamp, untilTimestamp) {
  const from = new Date(fromTimestamp).getTime();
  const until = new Date(untilTimestamp).getTime();
  const kept = existing.filter((candle) => {
    const start = new Date(candle.intervalStart).getTime();
    return start < from || start >= until;
  });
  const merged = [...kept, ...replacement].sort(compareCandleIdentity);
  for (let index = 1; index < merged.length; index += 1) {
    if (compareCandleIdentity(merged[index - 1], merged[index]) === 0) throw new Error("Duplicate candle identity.");
  }
  return merged;
}

export function mergeCoverage(existing, addition) {
  const entries = [...existing, addition].sort((a, b) => a.fromTimestamp.localeCompare(b.fromTimestamp));
  const output = [];
  for (const entry of entries) {
    const previous = output.at(-1);
    if (previous && entry.fromTimestamp <= previous.untilTimestamp && BigInt(entry.fromBlock) <= BigInt(previous.untilBlock)) {
      previous.untilBlock = (BigInt(entry.untilBlock) > BigInt(previous.untilBlock) ? BigInt(entry.untilBlock) : BigInt(previous.untilBlock)).toString();
      if (entry.untilTimestamp > previous.untilTimestamp) previous.untilTimestamp = entry.untilTimestamp;
    } else {
      output.push({ ...entry });
    }
  }
  return output;
}

export function replaceCoverage(existing, replacement) {
  const from = BigInt(replacement.fromBlock);
  const until = BigInt(replacement.untilBlock);
  const kept = [];
  for (const entry of existing) {
    const entryFrom = BigInt(entry.fromBlock);
    const entryUntil = BigInt(entry.untilBlock);
    if (entryUntil <= from || entryFrom >= until) {
      kept.push({ ...entry });
      continue;
    }
    if (entryFrom < from) {
      kept.push({
        ...entry,
        untilBlock: from.toString(),
        untilTimestamp: replacement.fromTimestamp,
      });
    }
    if (entryUntil > until) {
      kept.push({
        ...entry,
        fromBlock: until.toString(),
        fromTimestamp: replacement.untilTimestamp,
      });
    }
  }
  return mergeCoverage(kept, replacement);
}
