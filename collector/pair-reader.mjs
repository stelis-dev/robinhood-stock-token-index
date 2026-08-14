import { canonicalBytes } from "./canonical.mjs";
import {
  admitPairCandleSequence,
  decodePairDay,
  decodePairMonth,
  decodePairState,
  pairMonthLogicalId,
} from "./pair-artifact.mjs";
import { admitPairPeriodInput, admitPairPeriodResult } from "./pair-period.mjs";
import { pairById } from "./pair-registry.mjs";

function exactReference(references, logicalId, label) {
  const reference = references.find((candidate) => candidate.logicalId === logicalId);
  if (!reference) throw new Error(`${label} reference is missing from the selected closure.`);
  return reference;
}

export async function readPairState({ registry, pairId, store }) {
  pairById(registry, pairId);
  const selected = await store.readSelectedState(pairId);
  if (selected === null) return null;
  if (selected === undefined || !Number.isSafeInteger(selected.sequence) || !Buffer.isBuffer(selected.gzipBytes)) {
    throw new Error("Selected state carriage is invalid.");
  }
  const state = decodePairState(selected.gzipBytes, { registry }, pairId);
  if (state.sequence !== selected.sequence) throw new Error("Selected state sequence does not match its carrier generation.");
  return state;
}

export async function readPairMonth({ registry, store, reference }) {
  return decodePairMonth(await store.readReferenced(reference), { registry }, reference);
}

export async function readPairDay({ registry, store, reference }) {
  return decodePairDay(await store.readReferenced(reference), { registry }, reference);
}

export async function verifyPairIndex({ registry, pairId, store }) {
  const state = await readPairState({ registry, pairId, store });
  if (state === null) return { status: "empty", pairId };
  let dayCount = 0;
  let candleCount = 0;
  let previousCandle = null;
  for (const monthReference of state.months) {
    const monthIdentity = monthReference.logicalId.slice(-7);
    if (await store.resolvePairMonth(pairId, monthIdentity) !== "present") {
      throw new Error("A selected pair month is unavailable.");
    }
    const month = await readPairMonth({ registry, store, reference: monthReference });
    for (const dayReference of month.days) {
      const day = await readPairDay({ registry, store, reference: dayReference });
      if (previousCandle !== null && day.candles.length > 0) {
        admitPairCandleSequence([previousCandle, day.candles[0]]);
      }
      if (day.candles.length > 0) previousCandle = day.candles.at(-1);
      dayCount += 1;
      candleCount += day.candles.length;
    }
  }
  return {
    status: "verified",
    pairId,
    sequence: state.sequence,
    coverage: state.coverage,
    monthCount: state.months.length,
    dayCount,
    candleCount,
  };
}

function maximum(left, right) {
  return left > right ? left : right;
}

function minimum(left, right) {
  return left < right ? left : right;
}

function availability(request, availableRange) {
  if (availableRange === null) return { available: [], unavailable: [{ ...request }] };
  const available = [{ ...availableRange }];
  const unavailable = [];
  if (request.from < availableRange.from) unavailable.push({ from: request.from, until: availableRange.from });
  if (availableRange.until < request.until) unavailable.push({ from: availableRange.until, until: request.until });
  return { available, unavailable };
}

export async function readPairPeriod({ registry, input, store }) {
  const request = admitPairPeriodInput(input, registry);
  const entry = pairById(registry, request.pairId);
  const state = await readPairState({ registry, pairId: request.pairId, store });
  let availableRange = null;
  let candles = [];
  if (state !== null) {
    const from = maximum(request.from, state.coverage.fromTimestamp);
    const until = minimum(request.until, state.coverage.untilTimestamp);
    if (from < until) {
      const monthIdentity = from.slice(0, 7);
      const monthReference = exactReference(state.months, pairMonthLogicalId(request.pairId, monthIdentity), "Pair month");
      const resolved = await store.resolvePairMonth(request.pairId, monthIdentity);
      if (resolved !== "present" && resolved !== "unavailable") throw new Error("Pair month resolution is invalid.");
      if (resolved === "present") {
        const month = await readPairMonth({ registry, store, reference: monthReference });
        for (const dayReference of month.days) {
          if (dayReference.coverage.untilTimestamp <= from || dayReference.coverage.fromTimestamp >= until) continue;
          const day = await readPairDay({ registry, store, reference: dayReference });
          candles.push(...day.candles.filter((candle) => candle.intervalStart >= from && candle.intervalEnd <= until));
        }
        availableRange = { from, until };
      }
    }
  }
  const ranges = availability({ from: request.from, until: request.until }, availableRange);
  const result = {
    pair: entry.pair,
    display: entry.display,
    requested: { from: request.from, until: request.until },
    candles,
    available: ranges.available,
    unavailable: ranges.unavailable,
  };
  return admitPairPeriodResult(result, { registry, input: request });
}

export function samePairState(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}
