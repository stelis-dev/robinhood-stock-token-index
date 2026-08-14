import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  admitDayArtifact,
  createState,
  decodeDay,
  decodeState,
  emptyDayArtifact,
  encodeDay,
  encodeState,
} from "../collector/artifact.mjs";
import { buildCandles } from "../collector/candles.mjs";
import { canonicalBytes } from "../collector/canonical.mjs";
import { admitRegistry } from "../collector/registry.mjs";
import { admitSwapLog } from "../collector/swap.mjs";
import { block, fixtureRegistry, swapLog } from "./fixtures.mjs";

async function storedFixture(name) {
  return Buffer.from((await readFile(new URL(name, import.meta.url), "utf8")).trim(), "base64");
}

test("the registry closes the one common PoolKey rule", async () => {
  const registry = await fixtureRegistry();
  assert.deepEqual(admitRegistry(structuredClone(registry)), registry);
  assert.equal(registry.chain.primaryRpcUrl, "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(registry.groups.length, 1);
  assert.equal(registry.groups[0].assets.length, 8);
  const changed = structuredClone(registry);
  changed.groups[0].assets[0].poolId = `0x${"0".repeat(64)}`;
  assert.throws(() => admitRegistry(changed), /does not derive/);

  const expanded = structuredClone(registry);
  expanded.groups.push({ groupId: "group-02", assets: [expanded.groups[0].assets.pop()] });
  assert.deepEqual(admitRegistry(expanded), expanded);
  const duplicate = structuredClone(expanded);
  duplicate.groups[1].assets.push(structuredClone(duplicate.groups[0].assets[0]));
  duplicate.groups[1].assets.sort((left, right) => left.symbol.localeCompare(right.symbol));
  assert.throws(() => admitRegistry(duplicate), /Duplicate asset identity/);

  const unsafePrimary = structuredClone(registry);
  unsafePrimary.chain.primaryRpcUrl = "https://user:token@rpc.example/#secret";
  assert.throws(() => admitRegistry(unsafePrimary), /user information or a fragment/);

  const oversizedBatch = structuredClone(registry);
  oversizedBatch.collection.headerBatchSize = 101;
  assert.throws(() => admitRegistry(oversizedBatch), /batch boundary/);
});

test("Swap admission decodes signed ABI words and exact execution values", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets.find((entry) => entry.symbol === "AAPL");
  const sourceBlock = block(10, 1_786_579_210);
  const log = swapLog({
    registry,
    asset,
    block: sourceBlock,
    amount0: -3_000_000n,
    amount1: 10_000_000_000_000_000n,
    tick: -12n,
  });
  const trade = admitSwapLog(log, { registry, group, block: sourceBlock });
  assert.deepEqual(trade.price, { numerator: "300", denominator: "1" });
  assert.equal(trade.tick, "-12");
  assert.equal(trade.quoteAmountRaw, "3000000");
  assert.equal(trade.tokenAmountRaw, "10000000000000000");
  assert.throws(() => admitSwapLog({ ...log, removed: true }, { registry, group, block: sourceBlock }), /removal state/);
  const malformedSignExtension = { ...log, data: `0x${"0".repeat(32)}${"f".repeat(32)}${log.data.slice(66)}` };
  assert.throws(() => admitSwapLog(malformedSignExtension, { registry, group, block: sourceBlock }), /sign extended/);
  const totalFeeLog = swapLog({
    registry,
    asset,
    block: sourceBlock,
    amount0: -3_000_000n,
    amount1: 10_000_000_000_000_000n,
    fee: 3499n,
  });
  assert.equal(admitSwapLog(totalFeeLog, { registry, group, block: sourceBlock }).fee, "3499");
  const invalidFeeLog = swapLog({
    registry,
    asset,
    block: sourceBlock,
    amount0: -3_000_000n,
    amount1: 10_000_000_000_000_000n,
    fee: 1_000_001n,
  });
  assert.throws(() => admitSwapLog(invalidFeeLog, { registry, group, block: sourceBlock }), /price or fee/);

  const unsafeTimestampBlock = { ...sourceBlock, timestamp: "0x20000000000000" };
  const unsafeTimestampLog = { ...log, blockHash: unsafeTimestampBlock.hash };
  assert.throws(
    () => admitSwapLog(unsafeTimestampLog, { registry, group, block: unsafeTimestampBlock }),
    /safe integer boundary/,
  );
});

test("one-minute candles preserve every trade and do not create empty candles", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets.find((entry) => entry.symbol === "AAPL");
  const firstBlock = block(20, 1_786_579_210);
  const secondBlock = block(21, 1_786_579_250);
  const first = admitSwapLog(swapLog({ registry, asset, block: firstBlock, amount0: -3_000_000n, amount1: 10_000_000_000_000_000n }), { registry, group, block: firstBlock });
  const second = admitSwapLog(swapLog({ registry, asset, block: secondBlock, amount0: -6_200_000n, amount1: 20_000_000_000_000_000n }), { registry, group, block: secondBlock });
  const candles = buildCandles([second, first]);
  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0].open, { numerator: "300", denominator: "1" });
  assert.deepEqual(candles[0].close, { numerator: "310", denominator: "1" });
  assert.equal(candles[0].tradeCount, 2);
  assert.equal(candles[0].quoteVolumeRaw, "9200000");
  assert.throws(() => buildCandles([first, first]), /duplicated or unordered/);
});

test("artifact admission rejects noncanonical numeric and coverage claims", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets.find((entry) => entry.symbol === "AAPL");
  const sourceBlock = block(30, Date.parse("2026-08-13T01:00:10.000Z") / 1000);
  const trade = admitSwapLog(swapLog({ registry, asset, block: sourceBlock, amount0: -3_000_000n, amount1: 10_000_000_000_000_000n }), { registry, group, block: sourceBlock });
  const artifact = emptyDayArtifact({ registry, group, day: "2026-08-13" });
  artifact.coverage = [{
    fromBlock: "30",
    untilBlock: "31",
    fromTimestamp: "2026-08-13T01:00:00.000Z",
    untilTimestamp: "2026-08-13T01:01:00.000Z",
  }];
  artifact.candles = buildCandles([trade]);
  const encoded = encodeDay(artifact, { registry, group });
  assert.deepEqual(decodeDay(encoded.gzipBytes, { registry, group }), artifact);
  assert.deepEqual(encodeDay(artifact, { registry, group }).gzipBytes, encoded.gzipBytes);

  const unreduced = structuredClone(artifact);
  unreduced.candles[0].open = { numerator: "600", denominator: "2" };
  assert.throws(() => admitDayArtifact(unreduced, { registry, group }), /positive reduced rational/);
  const outside = structuredClone(artifact);
  outside.coverage[0].untilBlock = "30";
  assert.throws(() => admitDayArtifact(outside, { registry, group }), /outside admitted coverage/);
  const noncanonicalJson = Buffer.concat([canonicalBytes(artifact), Buffer.from("\n")]);
  assert.notEqual(noncanonicalJson.byteLength, encoded.jsonBytes.byteLength);
  assert.throws(() => admitDayArtifact(emptyDayArtifact({ registry, group, day: "2026-08-13" }), { registry, group }), /collection bound/);

  const state = createState({
    groupId: group.groupId,
    previous: null,
    nextBlock: "31",
    coveredUntilTimestamp: "2026-08-13T01:01:00.000Z",
    days: [],
  });
  const stateBytes = encodeState(state, group.groupId).gzipBytes;
  assert.throws(() => decodeState(stateBytes, group.groupId, 16_777_216, "2"), /generation/);
});

test("multi-asset candle ordering is admitted by the same identity comparator", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const sourceBlock = block(40, Date.parse("2026-08-13T02:00:10.000Z") / 1000);
  const trades = group.assets.slice(0, 2).map((asset, index) => admitSwapLog(swapLog({
    registry,
    asset,
    block: sourceBlock,
    transactionIndex: index,
    amount0: asset.stockTokenIsCurrency0 ? 10_000_000_000_000_000n : -3_000_000n,
    amount1: asset.stockTokenIsCurrency0 ? -3_000_000n : 10_000_000_000_000_000n,
  }), { registry, group, block: sourceBlock }));
  const artifact = emptyDayArtifact({ registry, group, day: "2026-08-13" });
  artifact.coverage = [{
    fromBlock: "40",
    untilBlock: "41",
    fromTimestamp: "2026-08-13T02:00:00.000Z",
    untilTimestamp: "2026-08-13T02:01:00.000Z",
  }];
  artifact.candles = buildCandles(trades);
  assert.equal(admitDayArtifact(artifact, { registry, group }), artifact);
});

test("the persisted v1 contract is independent of RPC implementation", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const state = decodeState(await storedFixture("./stored-v1-state.base64"), group.groupId, registry.collection.maximumArtifactBytes, "2");
  const day = decodeDay(
    await storedFixture("./stored-v1-day.base64"),
    { registry, group },
    state.days[0],
  );

  assert.equal(state.contractVersion, "1");
  assert.equal(state.nextBlock, "35124203");
  assert.equal(day.contractVersion, "1");
  assert.equal(day.candles.length, 49);
});
