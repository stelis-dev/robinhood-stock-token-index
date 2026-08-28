import assert from "node:assert/strict";
import test from "node:test";

import { loadMarketDataConfiguration } from "../collector/market-data-configuration.mjs";
import { RpcEndpointUnavailableError, RpcResponseRejectedError, rpcMethods } from "../collector/rpc-endpoint.mjs";
import {
  executeSharedCollectionPhase,
  prepareSharedCollectionPhase,
} from "../collector/shared-collection.mjs";
import { marketDataBlockHash, marketDataSwapLog } from "./market-data-fixtures.mjs";

const minuteFloor = (value) => new Date(Math.floor(Date.parse(value) / 60_000) * 60_000).toISOString();

class FakeSharedRpc {
  constructor({
    configuration,
    originBlock,
    originTimestamp,
    finalizedNumber,
    secondsPerBlock,
    logs = [],
    maximumPoolIds,
    unavailableLogRequest,
    returnLogsOutsideFilter = false,
  }) {
    this.configuration = configuration;
    this.originBlock = BigInt(originBlock);
    this.originSeconds = Math.floor(Date.parse(originTimestamp) / 1_000);
    this.finalizedNumber = BigInt(finalizedNumber);
    this.secondsPerBlock = secondsPerBlock;
    this.logs = logs;
    this.maximumPoolIds = maximumPoolIds;
    this.unavailableLogRequest = unavailableLogRequest;
    this.returnLogsOutsideFilter = returnLogsOutsideFilter;
    this.logRequests = [];
  }

  block(number) {
    const candidate = BigInt(number);
    return Object.freeze({
      number: candidate,
      hash: marketDataBlockHash(candidate),
      timestampSeconds: this.originSeconds
        + Math.floor(Number(candidate - this.originBlock) * this.secondsPerBlock),
    });
  }

  blockAt(timestamp) {
    const seconds = Math.floor(Date.parse(timestamp) / 1_000);
    const offset = Math.ceil((seconds - this.originSeconds) / this.secondsPerBlock);
    return this.originBlock + BigInt(offset);
  }

  async verifyChain(value) {
    if (value !== 4663) throw new Error("Fixture chain mismatch.");
  }

  async getBlock(selector) {
    const number = selector === "finalized" ? this.finalizedNumber : BigInt(selector);
    if (number > this.finalizedNumber) throw new Error("Fixture block exceeds finality.");
    return this.block(number);
  }

  async findFirstBlockAtOrAfterTimestamp(timestamp, minimumBlock, maximumBlock, { maximumBlockHeader } = {}) {
    let low = BigInt(minimumBlock);
    let high = BigInt(maximumBlock);
    if (maximumBlockHeader !== undefined && maximumBlockHeader.number !== high) {
      throw new Error("Fixture maximum block header is invalid.");
    }
    if (this.block(high).timestampSeconds < timestamp) return high + 1n;
    while (low < high) {
      const middle = (low + high) >> 1n;
      if (this.block(middle).timestampSeconds < timestamp) low = middle + 1n;
      else high = middle;
    }
    return low;
  }

  async getLogs({ address, poolIds, swapTopic, fromBlock, toBlock }) {
    if (address !== this.configuration.poolManager || swapTopic !== this.configuration.swapTopic) {
      throw new Error("Fixture log source is invalid.");
    }
    this.logRequests.push({ fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock), poolIds: [...poolIds] });
    if (this.logRequests.length === this.unavailableLogRequest) {
      throw new RpcEndpointUnavailableError("required_resource_unavailable", { rpcMethod: rpcMethods.getLogs });
    }
    if (this.maximumPoolIds !== undefined && poolIds.length > this.maximumPoolIds) {
      throw new RpcResponseRejectedError("response_too_large", { rpcMethod: rpcMethods.getLogs });
    }
    const selected = new Set(poolIds);
    return this.logs.filter((log) => {
      const number = BigInt(log.blockNumber);
      return number >= fromBlock && number <= toBlock
        && (this.returnLogsOutsideFilter || selected.has(log.topics[1]));
    });
  }

  async getBlockHeaders(expectations, _batchSize, { minimumTimestampSeconds, maximumTimestampSeconds }) {
    const output = new Map();
    for (const expectation of expectations) {
      const block = this.block(expectation.number);
      if (
        block.hash !== expectation.hash
        || block.timestampSeconds < minimumTimestampSeconds
        || block.timestampSeconds >= maximumTimestampSeconds
      ) throw new Error("Fixture header is outside its expected range.");
      output.set(block.number.toString(), block);
    }
    return output;
  }
}

function baseState(base, currentUntil, { historyFrom } = {}) {
  const sourceFrom = {
    blockNumber: (BigInt(base.initialize.blockNumber) - 1n).toString(),
    timestamp: minuteFloor(base.initialize.timestamp),
  };
  const admittedHistoryFrom = historyFrom ?? sourceFrom;
  return {
    decimals: base.decimals,
    pools: {
      [base.poolId]: {
        historyFrom: admittedHistoryFrom,
        initialize: base.initialize,
        poolKey: base.poolKey,
        sourceFrom,
      },
    },
    poolPeriods: [{
      fromBlock: admittedHistoryFrom.blockNumber,
      fromTimestamp: admittedHistoryFrom.timestamp,
      poolId: base.poolId,
      untilBlock: currentUntil.blockNumber,
      untilTimestamp: currentUntil.timestamp,
    }],
  };
}

function stateFor(configuration, bases, currentUntil, histories = {}) {
  return {
    currentUntil,
    poolManager: configuration.poolManager,
    usdgAddress: configuration.usdgAddress,
    usdgDecimals: configuration.usdgDecimals,
    baseCurrencies: Object.fromEntries(bases.map((base) => [
      base.baseCurrencyAddress,
      baseState(base, currentUntil, { historyFrom: histories[base.baseCurrencyAddress] }),
    ])),
  };
}

async function collectSharedPhase(inputs) {
  const prepared = await prepareSharedCollectionPhase(inputs);
  return executeSharedCollectionPhase({
    ...inputs,
    preparedPhase: prepared.preparedPhase,
  });
}

test("one undivided request covers all PoolIds before capacity-only PoolId splitting", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = { blockNumber: originBlock.toString(), timestamp: "2026-08-27T00:00:00.000Z" };
  const finalizedNumber = originBlock + 1n;
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber,
    secondsPerBlock: 60,
    maximumPoolIds: 4,
  });
  rpc.logs = configuration.bases.map((base, index) => marketDataSwapLog({
    configuration,
    base,
    blockNumber: originBlock,
    baseAmountRaw: 10n ** 18n,
    quoteAmountRaw: BigInt(index + 1) * 1_000_000n,
    transactionIndex: index,
  }));
  const completed = await collectSharedPhase({
    admittedConfiguration,
    state: stateFor(configuration, configuration.bases.slice(0, 2), currentUntil),
    rpcClients: [rpc],
  });
  assert.equal(completed.result.phase, "current");
  assert.equal(completed.result.bases.length, configuration.bases.length);
  assert.deepEqual(rpc.logRequests[0].poolIds, configuration.poolIds);
  assert.ok(rpc.logRequests.length > 1);
  assert.ok(completed.result.bases.every((base) => base.candles.length === 1));
  assert.ok(completed.result.bases.every((base) => base.coverage.untilTimestamp === "2026-08-27T00:01:00.000Z"));
});

test("endpoint fallback discards a partial history attempt and repeats the exact prepared ranges", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = { blockNumber: originBlock.toString(), timestamp: "2026-08-27T00:15:00.000Z" };
  const [first, second] = configuration.bases;
  const template = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock,
    secondsPerBlock: 10,
  });
  const histories = {
    [first.baseCurrencyAddress]: {
      blockNumber: template.blockAt("2026-08-26T12:00:00.000Z").toString(),
      timestamp: "2026-08-26T12:00:00.000Z",
    },
    [second.baseCurrencyAddress]: {
      blockNumber: template.blockAt("2026-08-26T11:55:00.000Z").toString(),
      timestamp: "2026-08-26T11:55:00.000Z",
    },
  };
  const state = stateFor(configuration, configuration.bases, currentUntil, histories);
  const primary = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock,
    secondsPerBlock: 10,
    unavailableLogRequest: 2,
  });
  primary.logs = [marketDataSwapLog({
    configuration,
    base: second,
    blockNumber: primary.blockAt("2026-08-26T11:42:00.000Z"),
    baseAmountRaw: 10n ** 18n,
    quoteAmountRaw: 999_000_000n,
  })];
  const fallback = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock,
    secondsPerBlock: 10,
  });
  fallback.logs = [
    marketDataSwapLog({
      configuration,
      base: first,
      blockNumber: fallback.blockAt("2026-08-26T11:50:00.000Z"),
      baseAmountRaw: 10n ** 18n,
      quoteAmountRaw: 2_000_000n,
      transactionIndex: 0,
    }),
    marketDataSwapLog({
      configuration,
      base: second,
      blockNumber: fallback.blockAt("2026-08-26T11:50:00.000Z"),
      baseAmountRaw: 10n ** 18n,
      quoteAmountRaw: 3_000_000n,
      transactionIndex: 1,
    }),
  ];
  const failures = [];
  const completed = await collectSharedPhase({
    admittedConfiguration,
    state,
    rpcClients: [primary, fallback],
    onEndpointFailure: (failure) => failures.push(failure),
  });
  assert.equal(completed.selectedEndpointIndex, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].endpointIndex, 0);
  assert.deepEqual(primary.logRequests[0], fallback.logRequests[0]);
  const secondResult = completed.result.bases.find((base) => base.baseCurrencyAddress === second.baseCurrencyAddress);
  assert.equal(secondResult.candles.length, 1);
  assert.deepEqual(secondResult.candles[0].close, { numerator: "3", denominator: "1" });
});

test("a malformed earlier page is fatal before a later page can become unavailable", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = { blockNumber: originBlock.toString(), timestamp: "2026-08-27T00:15:00.000Z" };
  const [first, second] = configuration.bases;
  const primary = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock,
    secondsPerBlock: 10,
    unavailableLogRequest: 2,
  });
  const histories = {
    [first.baseCurrencyAddress]: {
      blockNumber: primary.blockAt("2026-08-26T12:00:00.000Z").toString(),
      timestamp: "2026-08-26T12:00:00.000Z",
    },
    [second.baseCurrencyAddress]: {
      blockNumber: primary.blockAt("2026-08-26T11:55:00.000Z").toString(),
      timestamp: "2026-08-26T11:55:00.000Z",
    },
  };
  const malformed = marketDataSwapLog({
    configuration,
    base: second,
    blockNumber: primary.blockAt("2026-08-26T11:42:00.000Z"),
    baseAmountRaw: 10n ** 18n,
    quoteAmountRaw: 1_000_000n,
  });
  malformed.data = [malformed.data];
  primary.logs = [malformed];
  let fallbackUsed = false;
  const fallback = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock,
    secondsPerBlock: 10,
  });
  const fallbackVerify = fallback.verifyChain.bind(fallback);
  fallback.verifyChain = async (...args) => {
    fallbackUsed = true;
    return fallbackVerify(...args);
  };
  await assert.rejects(collectSharedPhase({
    admittedConfiguration,
    state: stateFor(configuration, configuration.bases, currentUntil, histories),
    rpcClients: [primary, fallback],
  }), (error) => error instanceof RpcResponseRejectedError && error.reason === "response_result_invalid");
  assert.equal(primary.logRequests.length, 1);
  assert.equal(fallbackUsed, false);
});

test("a malformed log outside the requested PoolId set is fatal before fallback", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = { blockNumber: originBlock.toString(), timestamp: "2026-08-27T00:00:00.000Z" };
  const primary = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock + 1n,
    secondsPerBlock: 60,
    returnLogsOutsideFilter: true,
  });
  const malformed = marketDataSwapLog({
    configuration,
    base: configuration.bases[0],
    blockNumber: originBlock,
    baseAmountRaw: 10n ** 18n,
    quoteAmountRaw: 1_000_000n,
    poolId: `0x${"f".repeat(64)}`,
  });
  malformed.data = [malformed.data];
  primary.logs = [malformed];
  let fallbackUsed = false;
  const fallback = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock + 1n,
    secondsPerBlock: 60,
  });
  const fallbackVerify = fallback.verifyChain.bind(fallback);
  fallback.verifyChain = async (...args) => {
    fallbackUsed = true;
    return fallbackVerify(...args);
  };
  await assert.rejects(collectSharedPhase({
    admittedConfiguration,
    state: stateFor(configuration, configuration.bases.slice(0, 2), currentUntil),
    rpcClients: [primary, fallback],
  }), (error) => error instanceof RpcResponseRejectedError && error.reason === "response_result_invalid");
  assert.equal(fallbackUsed, false);
});

test("a prepared phase performs no log read and fixes the target reused by the next phase", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: "2026-08-27T00:00:00.000Z",
    finalizedNumber: originBlock + 20n,
    secondsPerBlock: 60,
  });
  const firstState = stateFor(configuration, configuration.bases, {
    blockNumber: originBlock.toString(),
    timestamp: "2026-08-27T00:00:00.000Z",
  });
  const first = await prepareSharedCollectionPhase({
    admittedConfiguration,
    state: firstState,
    rpcClients: [rpc],
  });
  assert.equal(rpc.logRequests.length, 0);
  assert.equal(first.preparedPhase.target.timestamp, "2026-08-27T00:20:00.000Z");
  assert.equal(first.preparedPhase.work[0].untilTimestamp, "2026-08-27T00:15:00.000Z");

  rpc.finalizedNumber = originBlock + 25n;
  const secondState = stateFor(configuration, configuration.bases, {
    blockNumber: (originBlock + 15n).toString(),
    timestamp: "2026-08-27T00:15:00.000Z",
  });
  const second = await prepareSharedCollectionPhase({
    admittedConfiguration,
    fixedFinalizedBlock: first.preparedPhase.finalizedBlock,
    state: secondState,
    rpcClients: [rpc],
  });
  assert.deepEqual(second.preparedPhase.finalizedBlock, first.preparedPhase.finalizedBlock);
  assert.equal(second.preparedPhase.target.timestamp, first.preparedPhase.target.timestamp);
  assert.equal(second.preparedPhase.work[0].fromTimestamp, "2026-08-27T00:15:00.000Z");
  assert.equal(second.preparedPhase.work[0].untilTimestamp, "2026-08-27T00:20:00.000Z");
  assert.equal(rpc.logRequests.length, 0);
});

test("a new PoolId exposes the first block of its Initialize minute as sourceFrom", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const oldest = configuration.bases.reduce((left, right) => (
    BigInt(left.initialize.blockNumber) < BigInt(right.initialize.blockNumber) ? left : right
  ));
  const initializeMinute = minuteFloor(oldest.initialize.timestamp);
  const firstMinuteBlock = BigInt(oldest.initialize.blockNumber) - 100n;
  const secondsIntoMinute = Math.max(
    1,
    Math.floor((Date.parse(oldest.initialize.timestamp) - Date.parse(initializeMinute)) / 1_000),
  );
  const secondsPerBlock = secondsIntoMinute / 100;
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock: firstMinuteBlock,
    originTimestamp: initializeMinute,
    finalizedNumber: firstMinuteBlock + BigInt(Math.ceil(70 / secondsPerBlock)),
    secondsPerBlock,
  });
  const prepared = await prepareSharedCollectionPhase({
    admittedConfiguration,
    rpcClients: [rpc],
    state: null,
  });
  const work = prepared.preparedPhase.work.find((entry) => entry.poolId === oldest.poolId);
  const source = prepared.preparedPhase.newSources.find((entry) => entry.poolId === oldest.poolId);
  assert.equal(work.fromTimestamp, initializeMinute);
  assert.deepEqual(source.sourceFrom, {
    blockNumber: firstMinuteBlock.toString(),
    timestamp: initializeMinute,
  });
  assert.notEqual(source.sourceFrom.blockNumber, oldest.initialize.blockNumber);
});

test("execution rejects a different prior state even when it produces the same work ranges", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = {
    blockNumber: originBlock.toString(),
    timestamp: "2026-08-27T00:00:00.000Z",
  };
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock + 1n,
    secondsPerBlock: 60,
  });
  const preparedState = stateFor(configuration, configuration.bases, currentUntil);
  const changedState = structuredClone(preparedState);
  const base = configuration.bases[0];
  const pool = changedState.baseCurrencies[base.baseCurrencyAddress].pools[base.poolId];
  pool.historyFrom = {
    blockNumber: (BigInt(pool.sourceFrom.blockNumber) + 1n).toString(),
    timestamp: new Date(Date.parse(pool.sourceFrom.timestamp) + 60_000).toISOString(),
  };
  changedState.baseCurrencies[base.baseCurrencyAddress].poolPeriods[0].fromBlock
    = pool.historyFrom.blockNumber;
  changedState.baseCurrencies[base.baseCurrencyAddress].poolPeriods[0].fromTimestamp
    = pool.historyFrom.timestamp;
  const prepared = await prepareSharedCollectionPhase({
    admittedConfiguration,
    rpcClients: [rpc],
    state: preparedState,
  });
  await assert.rejects(executeSharedCollectionPhase({
    admittedConfiguration,
    preparedPhase: prepared.preparedPhase,
    rpcClients: [rpc],
    state: changedState,
  }), /Prepared shared-collection input identity changed/);
  assert.equal(rpc.logRequests.length, 0);
});

test("repair uses its recorded block range for both the request and returned coverage", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const originTimestamp = "2026-08-27T00:00:00.000Z";
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp,
    finalizedNumber: originBlock + 15n,
    secondsPerBlock: 60,
  });
  const currentUntil = {
    blockNumber: (originBlock + 15n).toString(),
    timestamp: "2026-08-27T00:15:00.000Z",
  };
  const base = configuration.bases[0];
  const repair = {
    baseCurrencyAddress: base.baseCurrencyAddress,
    fromBlock: (originBlock + 10n).toString(),
    fromTimestamp: "2026-08-27T00:10:00.000Z",
    poolId: base.poolId,
    untilBlock: currentUntil.blockNumber,
    untilTimestamp: currentUntil.timestamp,
  };
  const state = stateFor(configuration, [base], currentUntil, {
    [base.baseCurrencyAddress]: {
      blockNumber: originBlock.toString(),
      timestamp: originTimestamp,
    },
  });
  const completed = await collectSharedPhase({
    admittedConfiguration,
    repair,
    rpcClients: [rpc],
    state,
  });
  assert.deepEqual(rpc.logRequests, [{
    fromBlock: originBlock + 10n,
    poolIds: [base.poolId],
    toBlock: originBlock + 14n,
  }]);
  assert.deepEqual(completed.result.bases[0].coverage, {
    fromBlock: repair.fromBlock,
    fromTimestamp: repair.fromTimestamp,
    poolId: repair.poolId,
    untilBlock: repair.untilBlock,
    untilTimestamp: repair.untilTimestamp,
  });
});

test("repair rejects a block that is not the first block at its timestamp boundary", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: "2026-08-27T00:00:00.000Z",
    finalizedNumber: originBlock + 15n,
    secondsPerBlock: 60,
  });
  const currentUntil = {
    blockNumber: (originBlock + 15n).toString(),
    timestamp: "2026-08-27T00:15:00.000Z",
  };
  const base = configuration.bases[0];
  await assert.rejects(prepareSharedCollectionPhase({
    admittedConfiguration,
    repair: {
      baseCurrencyAddress: base.baseCurrencyAddress,
      fromBlock: (originBlock + 11n).toString(),
      fromTimestamp: "2026-08-27T00:10:00.000Z",
      poolId: base.poolId,
      untilBlock: currentUntil.blockNumber,
      untilTimestamp: currentUntil.timestamp,
    },
    rpcClients: [rpc],
    state: stateFor(configuration, [base], currentUntil, {
      [base.baseCurrencyAddress]: {
        blockNumber: originBlock.toString(),
        timestamp: "2026-08-27T00:00:00.000Z",
      },
    }),
  }), (error) => error instanceof RpcResponseRejectedError && error.reason === "response_result_invalid");
  assert.equal(rpc.logRequests.length, 0);
});

test("an endpoint behind the selected current boundary falls back before planning", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = {
    blockNumber: (originBlock + 15n).toString(),
    timestamp: "2026-08-27T00:15:00.000Z",
  };
  const state = stateFor(configuration, configuration.bases, currentUntil);
  const primary = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: "2026-08-27T00:00:00.000Z",
    finalizedNumber: originBlock + 14n,
    secondsPerBlock: 60,
  });
  const fallback = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: "2026-08-27T00:00:00.000Z",
    finalizedNumber: originBlock + 15n,
    secondsPerBlock: 60,
  });
  const failures = [];
  const prepared = await prepareSharedCollectionPhase({
    admittedConfiguration,
    onEndpointFailure: (failure) => failures.push(failure),
    rpcClients: [primary, fallback],
    state,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "required_resource_unavailable");
});

test("malformed duplicate Swap identity remains fatal", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const { configuration } = admittedConfiguration;
  const originBlock = 50_000_000n;
  const currentUntil = {
    blockNumber: originBlock.toString(),
    timestamp: "2026-08-27T00:00:00.000Z",
  };
  const base = configuration.bases[0];
  const log = marketDataSwapLog({
    configuration,
    base,
    blockNumber: originBlock,
    baseAmountRaw: 10n ** 18n,
    quoteAmountRaw: 1_000_000n,
  });
  const rpc = new FakeSharedRpc({
    configuration,
    originBlock,
    originTimestamp: currentUntil.timestamp,
    finalizedNumber: originBlock + 1n,
    secondsPerBlock: 60,
    logs: [log, structuredClone(log)],
  });
  await assert.rejects(collectSharedPhase({
    admittedConfiguration,
    rpcClients: [rpc],
    state: stateFor(configuration, [base], currentUntil),
  }), (error) => error instanceof RpcResponseRejectedError && error.reason === "response_result_invalid");
});
