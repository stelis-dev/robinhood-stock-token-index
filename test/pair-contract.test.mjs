import assert from "node:assert/strict";
import test from "node:test";
import {
  validatePairCandle,
} from "../collector/pair-candle.mjs";
import {
  pairDayLogicalId,
  pairMonthLogicalId,
} from "../collector/pair-file-identity.mjs";
import { candleResolutionCatalog } from "../collector/candle-resolution.mjs";
import {
  createPairFileReference,
  decodePairDayFile,
  decodePairMonthFile,
  decodePairStateFile,
  encodePairDayFile,
  encodePairMonthFile,
  encodePairStateFile,
  validatePairDayFile,
  validatePairMonthFile,
  validatePairStateFile,
} from "../collector/pair-files.mjs";
import { canonicalBytes, encodeArtifact } from "../collector/canonical.mjs";
import { validatePairRegistry, subtractUtcCalendarMonths } from "../collector/pair-registry.mjs";
import { derivePoolId } from "../collector/pool-key.mjs";
import { fixturePairRegistry, pairCandle, pairEntryBySymbol } from "./pair-fixtures.mjs";

const expectedActivation = {
  blockNumber: "36308141",
  hash: "0xbf86c7863b10b0849ff2e677638fb67e49e2d4658d2d47b7e13466c45467a633",
  timestamp: "2026-08-14T14:01:00.000Z",
};
const expectedQuoteAsset = {
  kind: "erc20",
  address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  decimals: 6,
};
const expectedRegistryRoot = {
  chain: {
    chainId: "eip155:4663",
    numericChainId: 4663,
    primaryRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    finalityTag: "finalized",
  },
  deployment: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    swapTopic: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  },
  collection: {
    candleSeconds: 60,
    headerBatchSize: 100,
    historyMonths: 12,
    logRangeBlocks: 2_000,
    maximumArtifactBytes: 16_777_216,
    maximumBlocksPerRun: 32_000,
    maximumResponseBytes: 16_777_216,
    maximumRpcAttempts: 7,
    maximumRpcRetryDelayMilliseconds: 60_000,
    repairLookbackSeconds: 21_600,
    requestDelayMilliseconds: 1_500,
    requestTimeoutMilliseconds: 30_000,
  },
};
const expectedBaseNames = new Map([
  ["AAPL", "Apple • Robinhood Token"],
  ["AMZN", "Amazon • Robinhood Token"],
  ["ETH", "Ether"],
  ["GOOGL", "Alphabet Class A • Robinhood Token"],
  ["META", "Meta Platforms • Robinhood Token"],
  ["MSFT", "Microsoft • Robinhood Token"],
  ["NVDA", "NVIDIA • Robinhood Token"],
  ["SPY", "SPDR S&P 500 ETF Trust • Robinhood Token"],
  ["TSLA", "Tesla • Robinhood Token"],
]);
const expectedInitialPairs = [
  ["NVDA", "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", false, 3000, 60, "1576460", "2026-07-02T23:28:11.000Z", "2026-07-02T23:28:00.000Z"],
  ["ETH", "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32", "0x0000000000000000000000000000000000000000", true, 460, 9, "4429344", "2026-07-08T14:30:35.000Z", "2026-07-08T14:30:00.000Z"],
  ["META", "0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36", "0xc0d6457c16cc70d6790dd43521c899c87ce02f35", false, 3000, 60, "6937031", "2026-07-11T12:18:48.000Z", "2026-07-11T12:18:00.000Z"],
  ["TSLA", "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e", "0x322f0929c4625ed5bad873c95208d54e1c003b2d", true, 3000, 60, "2670479", "2026-07-05T06:18:59.000Z", "2026-07-05T06:18:00.000Z"],
  ["MSFT", "0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579", "0xe93237c50d904957cf27e7b1133b510c669c2e74", false, 3000, 60, "12971135", "2026-07-18T12:13:12.000Z", "2026-07-18T12:13:00.000Z"],
  ["AAPL", "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb", "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", false, 3000, 60, "8379983", "2026-07-13T04:28:32.000Z", "2026-07-13T04:28:00.000Z"],
  ["AMZN", "0xd32646872e6712af8cf778e34b6bbef1d2ae0bddd83764e1b07333518ad59333", "0x12f190a9f9d7d37a250758b26824b97ce941bf54", true, 3000, 60, "10379084", "2026-07-15T12:05:23.000Z", "2026-07-15T12:05:00.000Z"],
  ["GOOGL", "0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", true, 3000, 60, "8386390", "2026-07-13T04:39:15.000Z", "2026-07-13T04:39:00.000Z"],
  ["SPY", "0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd", "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", true, 3000, 60, "9349681", "2026-07-14T07:28:30.000Z", "2026-07-14T07:28:00.000Z"],
];

function assertInitialRegistry(registry) {
  assert.deepEqual({
    chain: registry.chain,
    deployment: registry.deployment,
    collection: registry.collection,
  }, expectedRegistryRoot);
  assert.equal(registry.pairs.length, expectedInitialPairs.length);
  assert.deepEqual(registry.pairs.map((entry) => entry.pair.pairId), [...registry.pairs].map((entry) => entry.pair.pairId).sort());

  for (const [symbol, pairId, baseCurrency, baseIsCurrency0, fee, tickSpacing, initializationBlock, initializationTimestamp, historyTimestamp] of expectedInitialPairs) {
    const entry = registry.pairs.find((candidate) => candidate.pair.pairId === pairId);
    assert.ok(entry, `Missing fixed pair ${pairId}`);
    assert.deepEqual(entry.display, {
      baseName: expectedBaseNames.get(symbol),
      baseSymbol: symbol,
      label: `${symbol}/USDG`,
      quoteName: "USDG",
      quoteSymbol: "USDG",
    });
    assert.equal(entry.pair.baseAsset.kind === "native" ? entry.pair.baseAsset.currency : entry.pair.baseAsset.address, baseCurrency);
    assert.equal(entry.pair.baseAsset.decimals, 18);
    assert.equal(entry.pair.baseIsCurrency0, baseIsCurrency0);
    assert.equal(entry.pair.poolKey.fee, fee);
    assert.equal(entry.pair.poolKey.tickSpacing, tickSpacing);
    assert.equal(entry.pair.poolKey.hooks, "0x0000000000000000000000000000000000000000");
    assert.equal(entry.pair.poolKey[baseIsCurrency0 ? "currency0" : "currency1"], baseCurrency);
    assert.equal(entry.pair.poolKey[baseIsCurrency0 ? "currency1" : "currency0"], expectedQuoteAsset.address);
    assert.deepEqual(entry.pair.quoteAsset, expectedQuoteAsset);
    assert.deepEqual(entry.pair.sourceInitialization, { blockNumber: initializationBlock, timestamp: initializationTimestamp });
    assert.deepEqual(entry.pair.historyStart, { blockNumber: initializationBlock, timestamp: historyTimestamp });
    assert.deepEqual(entry.pair.activation, expectedActivation);
    assert.equal(derivePoolId(entry.pair.poolKey), entry.pair.pairId);
  }
}

function dataset(registry) {
  const entry = pairEntryBySymbol(registry, "NVDA");
  const pair = entry.pair;
  const sequence = 1;
  const coverage = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: "36308143",
    untilTimestamp: "2026-08-14T14:03:00.000Z",
  };
  const context = { registry };
  const day = {
    kind: "pair_candle_day",
    pair,
    sequence,
    day: "2026-08-14",
    coverage,
    candles: [pairCandle()],
  };
  const encodedDay = encodePairDayFile(day, context);
  const dayReference = createPairFileReference({ encoded: encodedDay, context });
  const month = {
    kind: "pair_candle_month",
    pair,
    sequence,
    month: "2026-08",
    coverage,
    days: [dayReference],
    sourceMonths: [pairMonthLogicalId(pair.pairId, "2026-08")],
    resolutions: [],
  };
  const encodedMonth = encodePairMonthFile(month, context);
  const monthReference = createPairFileReference({ encoded: encodedMonth, context });
  const state = {
    kind: "pair_candle_state",
    pair,
    sequence,
    coverage,
    resolutions: candleResolutionCatalog,
    months: [monthReference],
  };
  const encodedState = encodePairStateFile(state, context);
  return {
    context,
    entry,
    pair,
    coverage,
    day,
    month,
    state,
    encodedDay,
    encodedMonth,
    encodedState,
    dayReference,
    monthReference,
  };
}

function fixedReference(logicalId, coverage, sequence = 1) {
  return {
    logicalId,
    sequence,
    coverage,
    jsonBytes: 1,
    jsonSha256: "1".repeat(64),
    gzipBytes: 1,
    gzipSha256: "2".repeat(64),
  };
}

function encodedReference(logicalId, coverage, sequence, encoded) {
  return {
    logicalId,
    sequence,
    coverage,
    jsonBytes: encoded.jsonBytes.byteLength,
    jsonSha256: encoded.jsonSha256,
    gzipBytes: encoded.gzipBytes.byteLength,
    gzipSha256: encoded.gzipSha256,
  };
}

function multiChildIndexes(registry) {
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const sequence = 1;
  const context = { registry };
  const monthCoverage = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: "36310000",
    untilTimestamp: "2026-08-15T00:01:00.000Z",
  };
  const dayBoundary = { blockNumber: "36309000", timestamp: "2026-08-15T00:00:00.000Z" };
  const month = {
    kind: "pair_candle_month",
    pair,
    sequence,
    month: "2026-08",
    coverage: monthCoverage,
    days: [
      fixedReference(pairDayLogicalId(pair.pairId, "2026-08-14"), {
        fromBlock: monthCoverage.fromBlock,
        fromTimestamp: monthCoverage.fromTimestamp,
        untilBlock: dayBoundary.blockNumber,
        untilTimestamp: dayBoundary.timestamp,
      }),
      fixedReference(pairDayLogicalId(pair.pairId, "2026-08-15"), {
        fromBlock: dayBoundary.blockNumber,
        fromTimestamp: dayBoundary.timestamp,
        untilBlock: monthCoverage.untilBlock,
        untilTimestamp: monthCoverage.untilTimestamp,
      }),
    ],
    sourceMonths: [pairMonthLogicalId(pair.pairId, "2026-08")],
    resolutions: [],
  };

  const monthBoundary = { blockNumber: "37000001", timestamp: "2026-09-01T00:00:00.000Z" };
  const stateCoverage = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: "37000002",
    untilTimestamp: "2026-09-01T00:01:00.000Z",
  };
  const state = {
    kind: "pair_candle_state",
    pair,
    sequence,
    coverage: stateCoverage,
    resolutions: candleResolutionCatalog,
    months: [
      fixedReference(pairMonthLogicalId(pair.pairId, "2026-08"), {
        fromBlock: stateCoverage.fromBlock,
        fromTimestamp: stateCoverage.fromTimestamp,
        untilBlock: monthBoundary.blockNumber,
        untilTimestamp: monthBoundary.timestamp,
      }),
      fixedReference(pairMonthLogicalId(pair.pairId, "2026-09"), {
        fromBlock: monthBoundary.blockNumber,
        fromTimestamp: monthBoundary.timestamp,
        untilBlock: stateCoverage.untilBlock,
        untilTimestamp: stateCoverage.untilTimestamp,
      }),
    ],
  };
  return { context, month, state };
}

test("the pair registry validates nine specific pools and derives every PoolId from its PoolKey", async () => {
  const registry = await fixturePairRegistry();
  assertInitialRegistry(registry);
  assert.deepEqual(validatePairRegistry(structuredClone(registry)), registry);

  const eth = pairEntryBySymbol(registry, "ETH");
  assert.deepEqual(eth.pair.baseAsset, {
    kind: "native",
    currency: "0x0000000000000000000000000000000000000000",
    decimals: 18,
  });
  assert.equal(eth.pair.poolKey.fee, 460);
  assert.equal(eth.pair.poolKey.tickSpacing, 9);
  assert.equal(eth.pair.quoteAsset.address, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  assert.equal(eth.display.quoteSymbol, "USDG");

  const wrongPool = structuredClone(registry);
  wrongPool.pairs[0].pair.pairId = `0x${"0".repeat(64)}`;
  assert.throws(() => validatePairRegistry(wrongPool), /does not derive/);
  const fakeNativeToken = structuredClone(registry);
  fakeNativeToken.pairs.find((entry) => entry.display.baseSymbol === "ETH").pair.baseAsset.address = "0x0000000000000000000000000000000000000001";
  assert.throws(() => validatePairRegistry(fakeNativeToken), /member set/);
  const wrongNativeDecimals = structuredClone(registry);
  wrongNativeDecimals.pairs.find((entry) => entry.display.baseSymbol === "ETH").pair.baseAsset.decimals = 6;
  assert.throws(() => validatePairRegistry(wrongNativeDecimals), /native decimals/);
  const conflictingQuoteDisplay = structuredClone(registry);
  conflictingQuoteDisplay.pairs[0].display.quoteName = "Conflicting quote display";
  assert.throws(() => validatePairRegistry(conflictingQuoteDisplay), /conflicting numeric or display facts/);
  const conflictingQuoteDecimals = structuredClone(registry);
  conflictingQuoteDecimals.pairs[0].pair.quoteAsset.decimals = 18;
  assert.throws(() => validatePairRegistry(conflictingQuoteDecimals), /conflicting numeric or display facts/);
  const zeroCurrencyErc20 = structuredClone(registry);
  zeroCurrencyErc20.pairs.find((entry) => entry.display.baseSymbol === "ETH").pair.baseAsset = {
    kind: "erc20",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
  };
  assert.throws(() => validatePairRegistry(zeroCurrencyErc20), /ERC-20 address/);
  const arrayStateView = structuredClone(registry);
  arrayStateView.deployment.stateView = [arrayStateView.deployment.stateView];
  assert.throws(() => validatePairRegistry(arrayStateView), /Deployment identity/);
  const arrayActivationHash = structuredClone(registry);
  arrayActivationHash.pairs[0].pair.activation.hash = [arrayActivationHash.pairs[0].pair.activation.hash];
  assert.throws(() => validatePairRegistry(arrayActivationHash), /activation.hash/);
  const changedQuoteDisplay = structuredClone(registry);
  for (const entry of changedQuoteDisplay.pairs) {
    entry.display.quoteName = "Changed quote display";
    entry.display.quoteSymbol = "OTHER";
    entry.display.label = `${entry.display.baseSymbol}/OTHER`;
  }
  assert.deepEqual(validatePairRegistry(changedQuoteDisplay), changedQuoteDisplay);
  assert.throws(() => assertInitialRegistry(changedQuoteDisplay), assert.AssertionError);
  const earlyHistory = structuredClone(registry);
  earlyHistory.pairs[0].pair.historyStart.timestamp = "2026-07-02T23:27:00.000Z";
  assert.throws(() => validatePairRegistry(earlyHistory), /boundaries|history start/);
});

test("pair candles accept only possible first and last Swap positions", () => {
  assert.deepEqual(validatePairCandle(pairCandle()), pairCandle());
  const oneTrade = pairCandle();
  oneTrade.tradeCount = 1;
  oneTrade.lastSource = structuredClone(oneTrade.firstSource);
  assert.deepEqual(validatePairCandle(oneTrade), oneTrade);
  const acrossTransactions = pairCandle();
  acrossTransactions.lastSource.transactionIndex = 1;
  acrossTransactions.lastSource.transactionHash = `0x${"c".repeat(64)}`;
  acrossTransactions.lastSource.logIndex = 2;
  assert.deepEqual(validatePairCandle(acrossTransactions), acrossTransactions);
  const acrossBlocks = pairCandle();
  acrossBlocks.lastSource.blockNumber = (BigInt(acrossBlocks.firstSource.blockNumber) + 1n).toString();
  acrossBlocks.lastSource.blockHash = `0x${"b".repeat(64)}`;
  acrossBlocks.lastSource.transactionHash = `0x${"a".repeat(64)}`;
  acrossBlocks.lastSource.logIndex = 0;
  assert.deepEqual(validatePairCandle(acrossBlocks), acrossBlocks);

  const repeatedSource = pairCandle();
  repeatedSource.lastSource = structuredClone(repeatedSource.firstSource);
  assert.throws(() => validatePairCandle(repeatedSource), /trade count/);
  const oneTradeRange = pairCandle();
  oneTradeRange.tradeCount = 1;
  assert.throws(() => validatePairCandle(oneTradeRange), /trade count/);
  const inverted = pairCandle();
  [inverted.firstSource, inverted.lastSource] = [inverted.lastSource, inverted.firstSource];
  assert.throws(() => validatePairCandle(inverted), /inverted/);
  const conflictingBlock = pairCandle();
  conflictingBlock.lastSource.blockHash = `0x${"f".repeat(64)}`;
  assert.throws(() => validatePairCandle(conflictingBlock), /block identity/);
  const conflictingTransaction = pairCandle();
  conflictingTransaction.lastSource.transactionHash = `0x${"e".repeat(64)}`;
  assert.throws(() => validatePairCandle(conflictingTransaction), /transaction identity/);
  const reusedBlockHash = pairCandle();
  reusedBlockHash.lastSource.blockNumber = (BigInt(reusedBlockHash.firstSource.blockNumber) + 1n).toString();
  assert.throws(() => validatePairCandle(reusedBlockHash), /block identity/);
  const reusedTransactionHash = pairCandle();
  reusedTransactionHash.lastSource.transactionIndex = 1;
  assert.throws(() => validatePairCandle(reusedTransactionHash), /transaction identity/);
  const contradictoryLogOrder = pairCandle();
  contradictoryLogOrder.firstSource.logIndex = 5;
  contradictoryLogOrder.lastSource.transactionIndex = 1;
  contradictoryLogOrder.lastSource.transactionHash = `0x${"d".repeat(64)}`;
  contradictoryLogOrder.lastSource.logIndex = 3;
  assert.throws(() => validatePairCandle(contradictoryLogOrder), /transaction and log order/);
});

test("pair-day files require candles in increasing Swap order", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  const first = pairCandle();
  const second = pairCandle({
    intervalStart: "2026-08-14T14:02:00.000Z",
    blockNumber: "36308142",
  });
  const day = (candles) => ({ ...values.day, candles });

  assert.deepEqual(validatePairDayFile(day([first, second]), values.context).candles, [first, second]);

  const repeated = structuredClone(second);
  repeated.firstSource = structuredClone(first.firstSource);
  repeated.lastSource = structuredClone(first.lastSource);
  assert.throws(() => validatePairDayFile(day([first, repeated]), values.context), /source range|source blocks/);

  const sameBlock = pairCandle({
    intervalStart: "2026-08-14T14:02:00.000Z",
    blockNumber: first.firstSource.blockNumber,
  });
  sameBlock.firstSource.logIndex = 2;
  sameBlock.lastSource.logIndex = 3;
  assert.throws(() => validatePairDayFile(day([first, sameBlock]), values.context), /strictly increasing source blocks/);

  const widerCoverage = { ...values.coverage, untilBlock: "36308144" };
  const reusedNonAdjacentBlockHash = structuredClone(second);
  reusedNonAdjacentBlockHash.lastSource.blockNumber = "36308143";
  reusedNonAdjacentBlockHash.lastSource.blockHash = first.firstSource.blockHash;
  reusedNonAdjacentBlockHash.lastSource.transactionHash = `0x${"9".repeat(64)}`;
  assert.throws(
    () => validatePairDayFile({ ...values.day, coverage: widerCoverage, candles: [first, reusedNonAdjacentBlockHash] }, values.context),
    /block identity/,
  );
  const reusedNonAdjacentTransactionHash = structuredClone(second);
  reusedNonAdjacentTransactionHash.lastSource.blockNumber = "36308143";
  reusedNonAdjacentTransactionHash.lastSource.blockHash = `0x${"8".repeat(64)}`;
  reusedNonAdjacentTransactionHash.lastSource.transactionHash = first.firstSource.transactionHash;
  assert.throws(
    () => validatePairDayFile({ ...values.day, coverage: widerCoverage, candles: [first, reusedNonAdjacentTransactionHash] }, values.context),
    /transaction identity/,
  );
});

test("stored hashes and digests must be primitive canonical strings", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  const candle = pairCandle();
  candle.firstSource.blockHash = [candle.firstSource.blockHash];
  candle.firstSource.transactionHash = [candle.firstSource.transactionHash];
  candle.lastSource.blockNumber = (BigInt(candle.firstSource.blockNumber) + 1n).toString();
  candle.lastSource.blockHash = [`0x${(BigInt(candle.lastSource.blockNumber) + 1n).toString(16).padStart(64, "0")}`];
  candle.lastSource.transactionIndex = 0;
  candle.lastSource.transactionHash = [`0x${(BigInt(candle.lastSource.blockNumber) * 100n + 1n).toString(16).padStart(64, "0")}`];
  candle.lastSource.logIndex = 0;
  assert.throws(
    () => validatePairDayFile({ ...values.day, candles: [candle] }, values.context),
    /hash is invalid/,
  );

  const state = structuredClone(values.state);
  state.months[0].gzipSha256 = [state.months[0].gzipSha256];
  assert.throws(() => validatePairStateFile(state, values.context), /gzipSha256/);
});

test("UTC calendar subtraction clamps leap-day history without elapsed-day arithmetic", () => {
  assert.equal(
    subtractUtcCalendarMonths("2024-02-29T14:01:00.000Z", 12),
    "2023-02-28T14:01:00.000Z",
  );
});

test("display changes do not alter immutable pair artifact bytes", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  const relabeled = structuredClone(registry);
  relabeled.pairs.find((entry) => entry.pair.pairId === values.pair.pairId).display.baseName = "Corrected display name";
  validatePairRegistry(relabeled);
  assert.deepEqual(encodePairDayFile(values.day, { registry: relabeled }).gzipBytes, values.encodedDay.gzipBytes);
  assert.doesNotMatch(canonicalBytes(values.day).toString("utf8"), /NVIDIA|NVDA|USDG/);

  const sameDisplay = structuredClone(registry);
  sameDisplay.pairs[1].display = structuredClone(sameDisplay.pairs[0].display);
  assert.deepEqual(validatePairRegistry(sameDisplay), sameDisplay);
});

test("an unpublished pair has no state file rather than an empty stored state", async () => {
  const registry = await fixturePairRegistry();
  const pair = pairEntryBySymbol(registry, "ETH").pair;
  const emptyState = {
    kind: "pair_candle_state",
    pair,
    sequence: 1,
    coverage: {
      fromBlock: pair.activation.blockNumber,
      fromTimestamp: pair.activation.timestamp,
      untilBlock: pair.activation.blockNumber,
      untilTimestamp: pair.activation.timestamp,
    },
    resolutions: candleResolutionCatalog,
    months: [],
  };
  assert.throws(() => validatePairStateFile(emptyState, { registry }), /inverted/);
  assert.throws(() => encodePairStateFile(emptyState, { registry }), /inverted/);
});

test("state, month, and day files form one deterministic hash-verified data set", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  for (const [decoder, encoded] of [
    [decodePairMonthFile, values.encodedMonth],
    [decodePairDayFile, values.encodedDay],
  ]) {
    assert.throws(() => decoder(encoded.gzipBytes, values.context), /reference/);
    assert.throws(() => decoder(encoded.gzipBytes, values.context, null), /reference/);
  }
  assert.deepEqual(decodePairDayFile(values.encodedDay.gzipBytes, values.context, values.dayReference), values.day);
  assert.deepEqual(decodePairMonthFile(values.encodedMonth.gzipBytes, values.context, values.monthReference), values.month);
  assert.deepEqual(decodePairStateFile(values.encodedState.gzipBytes, values.context, values.pair.pairId), values.state);
  const ethPair = pairEntryBySymbol(registry, "ETH").pair;
  assert.throws(() => decodePairStateFile(values.encodedState.gzipBytes, values.context, ethPair.pairId), /requested pair/);
  assert.deepEqual(encodePairStateFile(values.state, values.context).gzipBytes, values.encodedState.gzipBytes);

  const changedBytes = Buffer.from(values.encodedDay.gzipBytes);
  changedBytes[changedBytes.byteLength - 1] ^= 1;
  assert.throws(() => decodePairDayFile(changedBytes, values.context, values.dayReference), /reference/);
  const wrongDigest = { ...values.dayReference, gzipSha256: "0".repeat(64) };
  assert.throws(() => decodePairDayFile(values.encodedDay.gzipBytes, values.context, wrongDigest), /reference/);
  const wrongJsonDigest = { ...values.dayReference, jsonSha256: "0".repeat(64) };
  assert.throws(() => decodePairDayFile(values.encodedDay.gzipBytes, values.context, wrongJsonDigest), /reference/);
  const wrongLogicalId = { ...values.dayReference, logicalId: pairDayLogicalId(ethPair.pairId, values.day.day) };
  assert.throws(() => decodePairDayFile(values.encodedDay.gzipBytes, values.context, wrongLogicalId), /identity/);
  const wrongSequence = { ...values.dayReference, sequence: values.dayReference.sequence + 1 };
  assert.throws(() => decodePairDayFile(values.encodedDay.gzipBytes, values.context, wrongSequence), /identity/);
  const wrongCoverage = structuredClone(values.dayReference);
  wrongCoverage.coverage.untilTimestamp = "2026-08-14T14:02:00.000Z";
  assert.throws(() => decodePairDayFile(values.encodedDay.gzipBytes, values.context, wrongCoverage), /identity/);
  const wrongPairDay = structuredClone(values.day);
  wrongPairDay.pair.poolKey.fee += 1;
  const wrongPairEncoded = encodeArtifact(wrongPairDay);
  const wrongPairReference = encodedReference(
    pairDayLogicalId(values.pair.pairId, values.day.day),
    values.day.coverage,
    values.day.sequence,
    wrongPairEncoded,
  );
  assert.throws(() => decodePairDayFile(wrongPairEncoded.gzipBytes, values.context, wrongPairReference), /descriptor/);
  const wrongPeriodDay = { ...values.day, day: "2026-08-15" };
  const wrongPeriodEncoded = encodeArtifact(wrongPeriodDay);
  const wrongPeriodReference = encodedReference(
    pairDayLogicalId(values.pair.pairId, wrongPeriodDay.day),
    values.day.coverage,
    values.day.sequence,
    wrongPeriodEncoded,
  );
  assert.throws(() => decodePairDayFile(wrongPeriodEncoded.gzipBytes, values.context, wrongPeriodReference), /logical period/);
  const ethDay = { ...values.day, pair: ethPair };
  const encodedEthDay = encodePairDayFile(ethDay, values.context);
  const mislabeledEthReference = {
    ...createPairFileReference({ encoded: encodedEthDay, context: values.context }),
    logicalId: pairDayLogicalId(values.pair.pairId, values.day.day),
  };
  assert.throws(() => decodePairDayFile(encodedEthDay.gzipBytes, values.context, mislabeledEthReference), /identity/);
});

test("reference creation cannot exceed the configured maximum file size", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  const boundedRegistry = structuredClone(registry);
  boundedRegistry.collection.maximumArtifactBytes = values.encodedDay.gzipBytes.byteLength - 1;
  assert.throws(
    () => createPairFileReference({ encoded: values.encodedDay, context: { registry: boundedRegistry } }),
    /maximum byte size/,
  );
});

test("every index level must cover all child periods named by its coverage", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  assert.throws(() => validatePairStateFile({ ...values.state, months: [] }, values.context), /cover/);
  assert.throws(() => validatePairMonthFile({ ...values.month, days: [] }, values.context), /cover/);
  const narrower = structuredClone(values.monthReference);
  narrower.coverage.fromTimestamp = "2026-08-14T14:02:00.000Z";
  assert.throws(() => validatePairStateFile({ ...values.state, months: [narrower] }, values.context), /continuous/);
  const escapedDay = structuredClone(values.dayReference);
  escapedDay.coverage.untilTimestamp = "2026-09-01T00:01:00.000Z";
  assert.throws(() => validatePairMonthFile({ ...values.month, days: [escapedDay] }, values.context), /logical period/);
});

test("every state and month generation references a file written in the same generation", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  assert.throws(
    () => validatePairMonthFile({ ...values.month, sequence: 2 }, values.context),
    /changed artifact/,
  );
  assert.throws(
    () => validatePairStateFile({ ...values.state, sequence: 2 }, values.context),
    /changed month/,
  );
});

test("multi-child indexes reject omission, duplication, reversal, gaps, and overlaps", async () => {
  const registry = await fixturePairRegistry();
  const values = multiChildIndexes(registry);
  assert.deepEqual(validatePairMonthFile(values.month, values.context), values.month);
  assert.deepEqual(validatePairStateFile(values.state, values.context), values.state);

  assert.throws(() => validatePairMonthFile({ ...values.month, days: values.month.days.slice(0, 1) }, values.context), /cover/);
  assert.throws(() => validatePairStateFile({ ...values.state, months: [values.state.months[0], values.state.months[0]] }, values.context), /parent/);
  assert.throws(() => validatePairStateFile({ ...values.state, months: [...values.state.months].reverse() }, values.context), /parent/);

  const gap = structuredClone(values.month);
  gap.days[0].coverage.untilBlock = (BigInt(gap.days[0].coverage.untilBlock) - 1n).toString();
  assert.throws(() => validatePairMonthFile(gap, values.context), /continuous/);

  const overlap = structuredClone(values.state);
  overlap.months[0].coverage.untilTimestamp = "2026-09-01T00:01:00.000Z";
  overlap.months[0].coverage.untilBlock = overlap.coverage.untilBlock;
  assert.throws(() => validatePairStateFile(overlap, values.context), /logical period/);
});

test("a pair-day validates covered empty time but never synthetic or unbounded candles", async () => {
  const registry = await fixturePairRegistry();
  const values = dataset(registry);
  assert.equal(validatePairDayFile({ ...values.day, candles: [] }, values.context).candles.length, 0);
  assert.throws(() => validatePairDayFile({ ...values.day, candles: Array(1_441).fill(values.day.candles[0]) }, values.context), /count/);
  const outside = structuredClone(values.day);
  outside.candles[0].intervalStart = "2026-08-14T14:03:00.000Z";
  outside.candles[0].intervalEnd = "2026-08-14T14:04:00.000Z";
  assert.throws(() => validatePairDayFile(outside, values.context), /outside its enclosing coverage/);
});
