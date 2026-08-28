import assert from "node:assert/strict";
import test from "node:test";

import {
  affectedResolutionOwnerMonths,
  candleResolutionCatalog,
  createResolutionCandles,
  validateResolutionCatalog,
} from "../collector/candle-resolution.mjs";
import { createBaseResolutionFile } from "../collector/market-data-files.mjs";
import { marketDataCandle } from "./market-data-fixtures.mjs";

test("the fixed resolution catalog directly aggregates canonical one-minute candles", () => {
  assert.equal(candleResolutionCatalog.length, 10);
  assert.deepEqual(validateResolutionCatalog(candleResolutionCatalog), candleResolutionCatalog);
  const candles = [
    marketDataCandle({ intervalStart: "2026-08-27T00:01:00.000Z", blockNumber: "50000001" }),
    marketDataCandle({
      intervalStart: "2026-08-27T00:02:00.000Z",
      blockNumber: "50000002",
      close: { numerator: "320", denominator: "1" },
      high: { numerator: "320", denominator: "1" },
    }),
  ];
  const created = createResolutionCandles({
    candles,
    fromTimestamp: "2026-08-27T00:00:00.000Z",
    intervalSeconds: 900,
    ownerMonth: "2026-08",
    untilTimestamp: "2026-08-27T00:15:00.000Z",
  });
  assert.equal(created.candles.length, 1);
  assert.equal(created.candles[0].sourceCandleCount, 2);
  assert.deepEqual(created.candles[0].close, { numerator: "320", denominator: "1" });
  assert.equal(created.candles[0].firstSource.blockNumber, "50000001");
  assert.equal(created.candles[0].lastSource.blockNumber, "50000002");
});

test("an incomplete natural interval produces no derived candle", () => {
  const created = createResolutionCandles({
    candles: [marketDataCandle({ intervalStart: "2026-08-27T00:01:00.000Z", blockNumber: "50000001" })],
    fromTimestamp: "2026-08-27T00:00:00.000Z",
    intervalSeconds: 900,
    ownerMonth: "2026-08",
    untilTimestamp: "2026-08-27T00:14:00.000Z",
  });
  assert.deepEqual(created, { candles: [], timeCoverage: null });
});

test("a cross-month two-day interval remains owned by its natural start month", () => {
  assert.deepEqual(affectedResolutionOwnerMonths({
    fromTimestamp: "2026-09-01T00:00:00.000Z",
    intervalSeconds: 172_800,
    untilTimestamp: "2026-09-01T00:15:00.000Z",
  }), ["2026-08"]);
  const created = createResolutionCandles({
    candles: [marketDataCandle({ intervalStart: "2026-09-01T00:01:00.000Z", blockNumber: "50000001" })],
    fromTimestamp: "2026-08-31T00:00:00.000Z",
    intervalSeconds: 172_800,
    ownerMonth: "2026-08",
    untilTimestamp: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(created.candles.length, 1);
  assert.equal(created.candles[0].intervalStart, "2026-08-31T00:00:00.000Z");
  assert.equal(created.candles[0].intervalEnd, "2026-09-02T00:00:00.000Z");
});

test("adjacent day coverage from one PoolId forms one natural derived interval", () => {
  const poolId = `0x${"1".repeat(64)}`;
  const value = createBaseResolutionFile({
    baseCurrencyAddress: "0x0000000000000000000000000000000000000000",
    candles: [
      marketDataCandle({ intervalStart: "2026-08-27T00:01:00.000Z", blockNumber: "50000001" }),
      marketDataCandle({ intervalStart: "2026-08-28T00:01:00.000Z", blockNumber: "50100001" }),
    ],
    coverage: [
      {
        fromBlock: "50000000",
        fromTimestamp: "2026-08-27T00:00:00.000Z",
        poolId,
        untilBlock: "50100000",
        untilTimestamp: "2026-08-28T00:00:00.000Z",
      },
      {
        fromBlock: "50100000",
        fromTimestamp: "2026-08-28T00:00:00.000Z",
        poolId,
        untilBlock: "50200000",
        untilTimestamp: "2026-08-29T00:00:00.000Z",
      },
    ],
    intervalSeconds: 172_800,
    ownerMonth: "2026-08",
  });
  assert.equal(value.coverage.length, 1);
  assert.equal(value.candles.length, 1);
  assert.equal(value.candles[0].intervalStart, "2026-08-27T00:00:00.000Z");
  assert.equal(value.candles[0].intervalEnd, "2026-08-29T00:00:00.000Z");
});
