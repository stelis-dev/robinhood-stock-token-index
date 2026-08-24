import {
  pairMonthLogicalId,
} from "../collector/pair-file-identity.mjs";
import {
  candleResolutionCatalog,
  createResolutionArtifacts,
  resolutionMonthBounds,
} from "../collector/candle-resolution.mjs";
import {
  createPairFileReference,
  encodePairDayFile,
  encodePairMonthFile,
  encodePairStateFile,
  encodeResolutionArtifact,
} from "../collector/pair-files.mjs";
import { pairCandle, pairEntryBySymbol } from "./pair-fixtures.mjs";

function candle(intervalStart, blockNumber, prices = {}) {
  return pairCandle({ intervalStart, blockNumber, ...prices });
}

function sourceCandles(activationBlock) {
  const values = [
    candle("2026-08-14T14:16:00.000Z", (activationBlock + 10n).toString(), {
      open: { numerator: "300", denominator: "1" },
      high: { numerator: "310", denominator: "1" },
      low: { numerator: "295", denominator: "1" },
      close: { numerator: "305", denominator: "1" },
    }),
    candle("2026-08-14T14:17:00.000Z", (activationBlock + 11n).toString(), {
      open: { numerator: "305", denominator: "1" },
      high: { numerator: "320", denominator: "1" },
      low: { numerator: "300", denominator: "1" },
      close: { numerator: "315", denominator: "1" },
    }),
    candle("2026-08-14T14:18:00.000Z", (activationBlock + 12n).toString(), {
      open: { numerator: "315", denominator: "1" },
      high: { numerator: "318", denominator: "1" },
      low: { numerator: "290", denominator: "1" },
      close: { numerator: "292", denominator: "1" },
    }),
    candle("2026-08-31T06:00:00.000Z", (activationBlock + 17_100n).toString()),
    candle("2026-09-01T18:00:00.000Z", (activationBlock + 18_100n).toString()),
    candle("2026-09-02T01:00:00.000Z", (activationBlock + 19_100n).toString()),
  ];
  return values;
}

function dayPeriods(fromTimestamp, untilTimestamp) {
  const output = [];
  const cursor = new Date(fromTimestamp);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < Date.parse(untilTimestamp)) {
    output.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return output;
}

function dayBoundary(pair, day, index, total, sourceUntilTimestamp) {
  const dayStart = `${day}T00:00:00.000Z`;
  const dayUntil = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const fromTimestamp = index === 0 ? pair.activation.timestamp : dayStart;
  const untilTimestamp = index === total - 1 ? sourceUntilTimestamp : dayUntil;
  const activationBlock = BigInt(pair.activation.blockNumber);
  return {
    fromBlock: (activationBlock + BigInt(index * 1_000)).toString(),
    fromTimestamp,
    untilBlock: (activationBlock + BigInt((index + 1) * 1_000)).toString(),
    untilTimestamp,
  };
}

export function createResolutionFixture(registry) {
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const sequence = 1;
  const context = { registry };
  const sourceUntilTimestamp = "2026-09-03T00:00:00.000Z";
  const periods = dayPeriods(pair.activation.timestamp, sourceUntilTimestamp);
  const candles = sourceCandles(BigInt(pair.activation.blockNumber));
  const days = periods.map((period, index) => {
    const coverage = dayBoundary(pair, period, index, periods.length, sourceUntilTimestamp);
    const value = {
      kind: "pair_candle_day",
      pair,
      sequence,
      day: period,
      coverage,
      candles: candles.filter((entry) => entry.intervalStart.startsWith(period)),
    };
    const encoded = encodePairDayFile(value, context);
    return { value, encoded, reference: createPairFileReference({ encoded, context }) };
  });
  const sourceCoverage = {
    fromBlock: days[0].value.coverage.fromBlock,
    fromTimestamp: days[0].value.coverage.fromTimestamp,
    untilBlock: days.at(-1).value.coverage.untilBlock,
    untilTimestamp: days.at(-1).value.coverage.untilTimestamp,
  };

  const monthValues = [];
  const resolutionValues = [];
  const sourceByMonth = {};
  for (const ownerMonth of ["2026-08", "2026-09"]) {
    const monthDays = days.filter((entry) => entry.value.day.startsWith(ownerMonth));
    const sourceDays = ownerMonth === "2026-08" ? days : monthDays;
    const ownerSourceCoverage = {
      fromBlock: sourceDays[0].value.coverage.fromBlock,
      fromTimestamp: sourceDays[0].value.coverage.fromTimestamp,
      untilBlock: sourceDays.at(-1).value.coverage.untilBlock,
      untilTimestamp: sourceDays.at(-1).value.coverage.untilTimestamp,
    };
    const ownerCandles = candles.filter((entry) => (
      entry.intervalStart >= ownerSourceCoverage.fromTimestamp
      && entry.intervalEnd <= ownerSourceCoverage.untilTimestamp
    ));
    sourceByMonth[ownerMonth] = { coverage: ownerSourceCoverage, candles: ownerCandles };
    const resolutions = [];
    const materialized = createResolutionArtifacts({
      registry,
      pair,
      sourceCoverage: ownerSourceCoverage,
      candles: ownerCandles,
      requests: candleResolutionCatalog.slice(1).map((definition) => ({
        sequence,
        ownerMonth,
        intervalSeconds: definition.intervalSeconds,
        fromTimestamp: ownerSourceCoverage.fromTimestamp,
        untilTimestamp: ownerSourceCoverage.untilTimestamp,
      })),
    });
    for (const { artifact: value } of materialized) {
      if (value === null) continue;
      const encoded = encodeResolutionArtifact(value, context);
      const reference = createPairFileReference({ encoded, context });
      const entry = { value, encoded, reference };
      resolutions.push(entry);
      resolutionValues.push(entry);
    }
    const coverage = {
      fromBlock: monthDays[0].value.coverage.fromBlock,
      fromTimestamp: monthDays[0].value.coverage.fromTimestamp,
      untilBlock: monthDays.at(-1).value.coverage.untilBlock,
      untilTimestamp: monthDays.at(-1).value.coverage.untilTimestamp,
    };
    const sourceMonths = [pairMonthLogicalId(pair.pairId, ownerMonth)];
    const twoDay = resolutions.find((entry) => entry.value.intervalSeconds === 172_800);
    const ownerUntil = resolutionMonthBounds(ownerMonth).untilTimestamp;
    if (twoDay !== undefined && twoDay.value.timeCoverage.untilTimestamp > ownerUntil) {
      sourceMonths.push(pairMonthLogicalId(pair.pairId, ownerUntil.slice(0, 7)));
    }
    const value = {
      kind: "pair_candle_month",
      pair,
      sequence,
      month: ownerMonth,
      coverage,
      days: monthDays.map((entry) => entry.reference),
      sourceMonths,
      resolutions: resolutions.map((entry) => entry.reference),
    };
    const encoded = encodePairMonthFile(value, context);
    monthValues.push({ value, encoded, reference: createPairFileReference({ encoded, context }) });
  }
  const state = {
    kind: "pair_candle_state",
    pair,
    sequence,
    coverage: sourceCoverage,
    resolutions: candleResolutionCatalog,
    months: monthValues.map((entry) => entry.reference),
  };
  const encodedState = encodePairStateFile(state, context);
  return {
    context,
    pair,
    sourceCoverage,
    sourceByMonth,
    candles,
    days,
    resolutions: resolutionValues,
    months: monthValues,
    state,
    encodedState,
  };
}
