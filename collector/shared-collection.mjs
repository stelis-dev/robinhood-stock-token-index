import { CandleAccumulator } from "./candles.mjs";
import { canonicalBytes, canonicalJson, sha256Hex } from "./canonical.mjs";
import {
  decodeMarketDataConfiguration,
  marketDataNumericChainId,
} from "./market-data-configuration.mjs";
import {
  maximumRpcBatchSize,
  maximumRpcEndpointCount,
  rpcMethods,
  RpcEndpointUnavailableError,
  RpcResponseRejectedError,
} from "./rpc-endpoint.mjs";
import { isCanonicalBytes32 } from "./hex-data.mjs";
import {
  planSharedCollectionPhase,
  sharedCollectionSliceSeconds,
  validateSharedCollectionRepair,
  validateSharedCollectionState,
} from "./shared-collection-plan.mjs";
import { admitSwapLog, decodeAdmittedSwap } from "./swap.mjs";
import {
  admitSwapPositionIdentity,
  compareSwapPosition,
  createSwapPositionIdentities,
} from "./swap-position.mjs";
import { formatUtcInstant, parseUtcInstantSeconds } from "./utc-time.mjs";

const minuteSeconds = 60;

export class SharedCollectionUnavailableError extends Error {
  constructor(failures) {
    super("All shared-collection RPC endpoints were unavailable.");
    this.name = "SharedCollectionUnavailableError";
    this.reason = "all_endpoints_unavailable";
    this.failures = Object.freeze(failures);
  }
}

export class SharedCollectionCapacityError extends Error {
  constructor(message = "One block and one PoolId exceed the RPC response boundary.") {
    super(message);
    this.name = "SharedCollectionCapacityError";
    this.reason = "capacity_exceeded";
  }
}

function rejectRpc(reason, rpcMethod) {
  return new RpcResponseRejectedError(reason, { rpcMethod });
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const member of value) deepFreeze(member);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) deepFreeze(member);
    return Object.freeze(value);
  }
  return value;
}

function admitRpc(rpcMethod, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof RpcResponseRejectedError) throw error;
    throw rejectRpc("response_result_invalid", rpcMethod);
  }
}

function sameBlock(left, right) {
  return left.number === right.number
    && left.hash === right.hash
    && left.timestampSeconds === right.timestampSeconds;
}

function createBlockIdentities() {
  return {
    blockByNumber: new Map(),
    blockNumberByHash: new Map(),
  };
}

function admitBlockIdentity(block, identities) {
  const number = block.number.toString();
  const knownBlock = identities.blockByNumber.get(number);
  const knownNumber = identities.blockNumberByHash.get(block.hash);
  if (
    knownBlock !== undefined && !sameBlock(knownBlock, block)
    || knownNumber !== undefined && knownNumber !== number
  ) {
    throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
  }
  identities.blockByNumber.set(number, block);
  identities.blockNumberByHash.set(block.hash, number);
  return block;
}

function exactBlockIdentity(block) {
  return Object.freeze({
    blockHash: block.hash,
    blockNumber: block.number.toString(),
    timestamp: formatUtcInstant(block.timestampSeconds, "Finalized block timestamp"),
  });
}

function endpointFailure(error, endpointIndex) {
  return Object.freeze({
    endpointIndex,
    reason: error.reason,
    rpcMethod: error.rpcMethod ?? null,
    httpStatus: error.httpStatus ?? null,
    rpcCode: error.rpcCode ?? null,
  });
}

function configurationInput(admittedConfiguration) {
  if (
    admittedConfiguration === null
    || typeof admittedConfiguration !== "object"
    || !Buffer.isBuffer(admittedConfiguration.bytes)
    || typeof admittedConfiguration.sha256 !== "string"
  ) {
    throw new TypeError("Admitted market-data configuration is invalid.");
  }
  const decoded = decodeMarketDataConfiguration(admittedConfiguration.bytes);
  if (decoded.sha256 !== admittedConfiguration.sha256) {
    throw new TypeError("Admitted market-data configuration identity is invalid.");
  }
  return decoded;
}

function sourceFromPool({ baseCurrencyAddress, decimals, poolId, poolKey }, configuration) {
  return Object.freeze({
    baseCurrencyAddress,
    source: Object.freeze({
      baseDecimals: decimals,
      baseIsCurrency0: poolKey.currency0 === baseCurrencyAddress,
      poolId,
      poolManager: configuration.poolManager,
      quoteDecimals: configuration.usdgDecimals,
      swapTopic: configuration.swapTopic,
    }),
  });
}

function poolSources(configuration, state) {
  const sources = new Map();
  const admit = (pool) => {
    const prepared = sourceFromPool(pool, configuration);
    const known = sources.get(pool.poolId);
    if (known !== undefined && canonicalJson(known) !== canonicalJson(prepared)) {
      throw new TypeError("One PoolId has conflicting shared-collection source facts.");
    }
    sources.set(pool.poolId, prepared);
  };
  for (const base of configuration.bases) admit(base);
  if (state !== null) {
    for (const [baseCurrencyAddress, baseState] of Object.entries(state.baseCurrencies)) {
      for (const [poolId, facts] of Object.entries(baseState.pools)) {
        admit({
          baseCurrencyAddress,
          decimals: baseState.decimals,
          poolId,
          poolKey: facts.poolKey,
        });
      }
    }
  }
  return sources;
}

function minimumSearchBlock(state) {
  if (state === null) return 0n;
  const blocks = Object.values(state.baseCurrencies).flatMap((baseState) => (
    Object.values(baseState.pools).map((facts) => BigInt(facts.sourceFrom.blockNumber))
  ));
  return blocks.reduce((minimum, value) => value < minimum ? value : minimum);
}

async function fixedFinalizedBlock(rpc, fixed) {
  await rpc.verifyChain(marketDataNumericChainId);
  const observed = await rpc.getBlock("finalized");
  if (fixed === null) return Object.freeze({ ...observed });
  if (observed.number < fixed.number) {
    throw new RpcEndpointUnavailableError("required_resource_unavailable", {
      rpcMethod: rpcMethods.getBlockByNumber,
    });
  }
  const reproduced = observed.number === fixed.number ? observed : await rpc.getBlock(fixed.number);
  if (!sameBlock(reproduced, fixed)) {
    throw rejectRpc("finalized_boundary_mismatch", rpcMethods.getBlockByNumber);
  }
  return fixed;
}

async function resolveBoundary(rpc, timestamp, minimumBlock, finalized, blockIdentities) {
  const timestampSeconds = parseUtcInstantSeconds(timestamp, "Shared range boundary", true);
  if (timestampSeconds > finalized.timestampSeconds) {
    throw new TypeError("Shared range boundary exceeds the fixed finalized block.");
  }
  const number = await rpc.findFirstBlockAtOrAfterTimestamp(
    timestampSeconds,
    minimumBlock,
    finalized.number,
    { maximumBlockHeader: finalized },
  );
  if (number > finalized.number) {
    throw new RpcEndpointUnavailableError("required_resource_unavailable", {
      rpcMethod: rpcMethods.getBlockByNumber,
    });
  }
  const block = number === finalized.number ? finalized : await rpc.getBlock(number);
  const previous = number === 0n ? null : await rpc.getBlock(number - 1n);
  admitBlockIdentity(block, blockIdentities);
  if (previous !== null) admitBlockIdentity(previous, blockIdentities);
  if (
    block.number !== number
    || block.timestampSeconds < timestampSeconds
    || previous !== null && previous.timestampSeconds >= timestampSeconds
  ) {
    throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
  }
  return Object.freeze({
    block: Object.freeze({ ...block }),
    blockNumber: number.toString(),
    previous: previous === null ? null : Object.freeze({ ...previous }),
    timestamp,
  });
}

async function verifyExactBoundary(rpc, value, finalized, blockIdentities) {
  const number = BigInt(value.blockNumber);
  if (number > finalized.number) {
    throw new RpcEndpointUnavailableError("required_resource_unavailable", {
      rpcMethod: rpcMethods.getBlockByNumber,
    });
  }
  const timestampSeconds = parseUtcInstantSeconds(value.timestamp, "Exact collection boundary", true);
  const block = number === finalized.number ? finalized : await rpc.getBlock(number);
  const previous = number === 0n ? null : await rpc.getBlock(number - 1n);
  admitBlockIdentity(block, blockIdentities);
  if (previous !== null) admitBlockIdentity(previous, blockIdentities);
  if (
    block.number !== number
    || block.timestampSeconds < timestampSeconds
    || previous !== null && previous.timestampSeconds >= timestampSeconds
  ) {
    throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
  }
  return Object.freeze({
    block: Object.freeze({ ...block }),
    blockNumber: number.toString(),
    previous: previous === null ? null : Object.freeze({ ...previous }),
    timestamp: value.timestamp,
  });
}

function sameBoundary(left, right) {
  return left.blockNumber === right.blockNumber
    && left.timestamp === right.timestamp
    && sameBlock(left.block, right.block);
}

function addBoundary(boundaries, boundary) {
  const known = boundaries.get(boundary.timestamp);
  if (known !== undefined && !sameBoundary(known, boundary)) {
    throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
  }
  boundaries.set(boundary.timestamp, boundary);
  return boundary;
}

async function prepareEndpoint({ rpc, configuration, state, repair, fixedFinalized }) {
  const finalized = await fixedFinalizedBlock(rpc, fixedFinalized);
  const blockIdentities = createBlockIdentities();
  admitBlockIdentity(finalized, blockIdentities);
  const currentRequiredBlock = state === null ? 0n : BigInt(state.currentUntil.blockNumber);
  if (finalized.number < currentRequiredBlock) {
    throw new RpcEndpointUnavailableError("required_resource_unavailable", {
      rpcMethod: rpcMethods.getBlockByNumber,
    });
  }
  const targetTimestamp = formatUtcInstant(
    Math.floor(finalized.timestampSeconds / minuteSeconds) * minuteSeconds,
    "Shared collection target",
  );
  const minimumBlock = minimumSearchBlock(state);
  const targetBoundary = await resolveBoundary(
    rpc,
    targetTimestamp,
    minimumBlock,
    finalized,
    blockIdentities,
  );
  const target = Object.freeze({ blockNumber: targetBoundary.blockNumber, timestamp: targetTimestamp });
  const plan = planSharedCollectionPhase({ configuration, state, target, repair });
  const boundaries = new Map([[targetTimestamp, targetBoundary]]);
  const rangeBoundaryTimestamps = plan.phase === "repair"
    ? []
    : new Set(plan.ranges.flatMap((range) => [range.fromTimestamp, range.untilTimestamp]));
  for (const timestamp of rangeBoundaryTimestamps) {
    if (!boundaries.has(timestamp)) {
      boundaries.set(
        timestamp,
        await resolveBoundary(rpc, timestamp, minimumBlock, finalized, blockIdentities),
      );
    }
  }
  const partial = { boundaries, finalized, minimumBlock, plan, target };
  const ownedBlocks = new Map();
  for (const work of plan.work) {
    for (const side of ["from", "until"]) {
      const timestamp = side === "from" ? work.fromTimestamp : work.untilTimestamp;
      const number = BigInt(workBoundaryBlock(work, side, partial, state));
      const resolved = plan.phase === "repair"
        ? addBoundary(boundaries, await verifyExactBoundary(
          rpc,
          { blockNumber: number.toString(), timestamp },
          finalized,
          blockIdentities,
        ))
        : boundaries.get(timestamp);
      if (resolved === undefined || resolved.blockNumber !== number.toString()) {
        throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
      }
      ownedBlocks.set(number.toString(), resolved.block);
    }
  }
  const newSources = [];
  const configuredBases = new Map(configuration.bases.map((base) => [base.baseCurrencyAddress, base]));
  for (const work of plan.work) {
    const baseState = state?.baseCurrencies[work.baseCurrencyAddress];
    if (baseState?.pools[work.poolId] !== undefined) continue;
    const configuredBase = configuredBases.get(work.baseCurrencyAddress);
    let sourceFrom;
    if (baseState === undefined) {
      const timestamp = formatUtcInstant(
        Math.floor(parseUtcInstantSeconds(
          configuredBase.initialize.timestamp,
          "Initialize timestamp",
        ) / minuteSeconds) * minuteSeconds,
        "Initialize minute",
      );
      sourceFrom = addBoundary(boundaries, await resolveBoundary(
        rpc,
        timestamp,
        0n,
        finalized,
        blockIdentities,
      ));
    } else {
      sourceFrom = boundaries.get(state.currentUntil.timestamp);
      if (sourceFrom === undefined) {
        throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
      }
    }
    if (!newSources.some((source) => source.poolId === work.poolId)) {
      newSources.push(Object.freeze({
        baseCurrencyAddress: work.baseCurrencyAddress,
        poolId: work.poolId,
        sourceFrom: Object.freeze({
          blockNumber: sourceFrom.blockNumber,
          timestamp: sourceFrom.timestamp,
        }),
      }));
    }
  }
  newSources.sort((left, right) => (
    left.baseCurrencyAddress.localeCompare(right.baseCurrencyAddress)
    || left.poolId.localeCompare(right.poolId)
  ));
  return Object.freeze({
    blockIdentities,
    boundaries,
    finalized,
    minimumBlock,
    newSources: Object.freeze(newSources),
    ownedBlocks,
    plan,
    target,
  });
}

function workBoundaryBlock(work, side, prepared, state) {
  const timestamp = side === "from" ? work.fromTimestamp : work.untilTimestamp;
  const explicit = side === "from" ? work.fromBlock : work.untilBlock;
  if (explicit !== undefined) return explicit;
  if (timestamp === prepared.target.timestamp) return prepared.target.blockNumber;
  if (state !== null && timestamp === state.currentUntil.timestamp) {
    return state.currentUntil.blockNumber;
  }
  const poolFacts = state?.baseCurrencies[work.baseCurrencyAddress]?.pools[work.poolId];
  if (poolFacts !== undefined) {
    for (const candidate of [poolFacts.historyFrom, poolFacts.sourceFrom]) {
      if (timestamp === candidate.timestamp) return candidate.blockNumber;
    }
  }
  return prepared.boundaries.get(timestamp).blockNumber;
}

function exactRanges(prepared) {
  if (prepared.plan.phase === "repair") {
    const [repair] = prepared.plan.work;
    return Object.freeze([Object.freeze({
      fromBlock: repair.fromBlock,
      fromTimestamp: repair.fromTimestamp,
      poolIds: Object.freeze([repair.poolId]),
      untilBlock: repair.untilBlock,
      untilTimestamp: repair.untilTimestamp,
    })]);
  }
  return Object.freeze(prepared.plan.ranges.map((range) => Object.freeze({
    fromBlock: prepared.boundaries.get(range.fromTimestamp).blockNumber,
    fromTimestamp: range.fromTimestamp,
    poolIds: range.poolIds,
    untilBlock: prepared.boundaries.get(range.untilTimestamp).blockNumber,
    untilTimestamp: range.untilTimestamp,
  })));
}

function preparedWork(prepared, state) {
  return Object.freeze(prepared.plan.work.map((work) => Object.freeze({
    ...work,
    fromBlock: workBoundaryBlock(work, "from", prepared, state),
    untilBlock: workBoundaryBlock(work, "until", prepared, state),
  })));
}

function preparedPhaseOutput(admitted, prepared, state) {
  const boundaryBlocks = new Map();
  for (const boundary of prepared.boundaries.values()) {
    boundaryBlocks.set(boundary.block.number.toString(), boundary.block);
  }
  for (const block of prepared.ownedBlocks.values()) {
    boundaryBlocks.set(block.number.toString(), block);
  }
  for (const source of prepared.newSources) {
    const boundary = prepared.boundaries.get(source.sourceFrom.timestamp);
    boundaryBlocks.set(boundary.block.number.toString(), boundary.block);
  }
  return deepFreeze({
    boundaryBlocks: [...boundaryBlocks.values()]
      .sort((left, right) => left.number < right.number ? -1 : left.number > right.number ? 1 : 0)
      .map(exactBlockIdentity),
    configurationSha256: admitted.sha256,
    finalizedBlock: exactBlockIdentity(prepared.finalized),
    newSources: prepared.newSources,
    phase: prepared.plan.phase,
    priorStateSha256: sha256Hex(canonicalBytes(state)),
    ranges: exactRanges(prepared),
    target: prepared.target,
    work: preparedWork(prepared, state),
  });
}

function responseTooLarge(error) {
  return error instanceof RpcResponseRejectedError
    && error.reason === "response_too_large"
    && error.rpcMethod === rpcMethods.getLogs;
}

async function collectCapacityPages({ rpc, range, poolIds, resolveMidpoint, signal, onPage }) {
  signal?.throwIfAborted();
  const fromBlock = BigInt(range.fromBlock);
  const untilBlock = BigInt(range.untilBlock);
  if (fromBlock === untilBlock) return;
  try {
    const rawLogs = await rpc.getLogs({
      address: range.poolManager,
      poolIds,
      swapTopic: range.swapTopic,
      fromBlock,
      toBlock: untilBlock - 1n,
    });
    const page = Object.freeze({ poolIds, range, rawLogs });
    await onPage(page);
    return;
  } catch (error) {
    if (!responseTooLarge(error)) throw error;
  }
  const fromSeconds = parseUtcInstantSeconds(range.fromTimestamp, "Capacity range start", true);
  const untilSeconds = parseUtcInstantSeconds(range.untilTimestamp, "Capacity range end", true);
  const minuteCount = (untilSeconds - fromSeconds) / minuteSeconds;
  if (minuteCount > 1) {
    const middleSeconds = fromSeconds + Math.floor(minuteCount / 2) * minuteSeconds;
    const middleTimestamp = formatUtcInstant(middleSeconds, "Capacity minute split");
    const middleBlock = await resolveMidpoint(middleTimestamp);
    const children = [
      { ...range, untilBlock: middleBlock, untilTimestamp: middleTimestamp },
      { ...range, fromBlock: middleBlock, fromTimestamp: middleTimestamp },
    ];
    for (const child of children) {
      await collectCapacityPages({ rpc, range: child, poolIds, resolveMidpoint, signal, onPage });
    }
    return;
  }
  if (untilBlock - fromBlock > 1n) {
    const middleBlock = ((fromBlock + untilBlock) >> 1n).toString();
    const children = [
      { ...range, untilBlock: middleBlock },
      { ...range, fromBlock: middleBlock },
    ];
    for (const child of children) {
      await collectCapacityPages({ rpc, range: child, poolIds, resolveMidpoint, signal, onPage });
    }
    return;
  }
  if (poolIds.length > 1) {
    const middle = Math.floor(poolIds.length / 2);
    for (const childPoolIds of [poolIds.slice(0, middle), poolIds.slice(middle)]) {
      await collectCapacityPages({
        rpc,
        range,
        poolIds: Object.freeze(childPoolIds),
        resolveMidpoint,
        signal,
        onPage,
      });
    }
    return;
  }
  throw new SharedCollectionCapacityError();
}

function createPageAdmission({
  accumulators,
  configuration,
  prepared,
  rpc,
  signal,
  sources,
  workByPoolId,
}) {
  return {
    accumulators,
    blocks: new Map(),
    configuration,
    identities: createSwapPositionIdentities(),
    prepared,
    positions: new Set(),
    rpc,
    signal,
    sources,
    workByPoolId,
  };
}

async function admitPage(page, state) {
  state.signal?.throwIfAborted();
  const admitted = admitRpc(rpcMethods.getLogs, () => page.rawLogs.map((log) => (
    admitSwapLog(log, {
      poolManager: state.configuration.poolManager,
      swapTopic: state.configuration.swapTopic,
    })
  )));
  const requested = new Set(page.poolIds);
  const pageFromBlock = BigInt(page.range.fromBlock);
  const pageUntilBlock = BigInt(page.range.untilBlock);
  if (admitted.some((swap) => (
    swap.blockNumber < pageFromBlock
    || swap.blockNumber >= pageUntilBlock
    || !requested.has(swap.poolId)
  ))) {
    throw rejectRpc("response_result_invalid", rpcMethods.getLogs);
  }
  const decodedEntries = [];
  const expectations = new Map();
  for (const swap of admitted) {
    const source = state.sources.get(swap.poolId);
    if (source === undefined) throw new TypeError("Shared plan PoolId has no admitted source.");
    const decoded = admitRpc(rpcMethods.getLogs, () => decodeAdmittedSwap(swap, source.source));
    const positionKey = `${decoded.blockNumber}:${decoded.swapPosition.transactionIndex}:${decoded.swapPosition.logIndex}`;
    if (state.positions.has(positionKey)) {
      throw rejectRpc("response_result_invalid", rpcMethods.getLogs);
    }
    admitRpc(rpcMethods.getLogs, () => (
      admitSwapPositionIdentity(decoded.swapPosition, state.identities, "Shared Swap logs")
    ));
    state.positions.add(positionKey);
    const blockKey = decoded.blockNumber.toString();
    const knownBlock = state.blocks.get(blockKey);
    if (knownBlock !== undefined && knownBlock.hash !== decoded.blockHash) {
      throw rejectRpc("response_result_invalid", rpcMethods.getLogs);
    }
    if (knownBlock === undefined) {
      expectations.set(blockKey, Object.freeze({ number: decoded.blockNumber, hash: decoded.blockHash }));
    }
    decodedEntries.push(decoded);
  }
  const headers = expectations.size === 0
    ? new Map()
    : await state.rpc.getBlockHeaders(
      [...expectations.values()],
      maximumRpcBatchSize,
      {
        minimumTimestampSeconds: parseUtcInstantSeconds(page.range.fromTimestamp, "Page range start", true),
        maximumTimestampSeconds: parseUtcInstantSeconds(page.range.untilTimestamp, "Page range end", true),
      },
    );
  for (const [number, header] of headers) {
    admitBlockIdentity(header, state.prepared.blockIdentities);
    state.blocks.set(number, header);
  }
  decodedEntries.sort((left, right) => compareSwapPosition(left.swapPosition, right.swapPosition));
  let previous = null;
  for (const decoded of decodedEntries) {
    if (previous !== null && compareSwapPosition(previous, decoded.swapPosition) >= 0) {
      throw rejectRpc("response_result_invalid", rpcMethods.getLogs);
    }
    previous = decoded.swapPosition;
    const header = state.blocks.get(decoded.blockNumber.toString());
    if (
      header === undefined
      || header.number !== decoded.blockNumber
      || header.hash !== decoded.blockHash
      || header.timestampSeconds < parseUtcInstantSeconds(page.range.fromTimestamp, "Swap range start", true)
      || header.timestampSeconds >= parseUtcInstantSeconds(page.range.untilTimestamp, "Swap range end", true)
    ) {
      throw rejectRpc("response_result_invalid", rpcMethods.getBlockByNumber);
    }
    const owned = state.workByPoolId.get(decoded.poolId);
    if (
      owned === undefined
      || header.timestampSeconds < parseUtcInstantSeconds(owned.fromTimestamp, "Owned range start", true)
      || header.timestampSeconds >= parseUtcInstantSeconds(owned.untilTimestamp, "Owned range end", true)
      || decoded.blockNumber < BigInt(owned.fromBlock)
      || decoded.blockNumber >= BigInt(owned.untilBlock)
    ) {
      throw rejectRpc("response_result_invalid", rpcMethods.getLogs);
    }
    admitRpc(rpcMethods.getLogs, () => state.accumulators.get(decoded.poolId).addSwaps([{
      blockTimestamp: header.timestampSeconds,
      poolId: decoded.poolId,
      swapPosition: decoded.swapPosition,
      trade: decoded.trade,
    }]));
  }
}

async function collectPrepared({
  rpc,
  prepared,
  configuration,
  state,
  signal,
}) {
  const sources = poolSources(configuration, state);
  const ranges = exactRanges(prepared);
  const accumulators = new Map();
  const workByPoolId = new Map();
  for (const poolId of new Set(prepared.plan.work.map((entry) => entry.poolId))) {
    accumulators.set(poolId, new CandleAccumulator({
      poolId,
      candleSeconds: minuteSeconds,
      maximumBuckets: sharedCollectionSliceSeconds / minuteSeconds,
    }));
  }
  for (const work of preparedWork(prepared, state)) {
    if (workByPoolId.has(work.poolId)) {
      throw new TypeError("One PoolId has more than one work range in one durable phase.");
    }
    workByPoolId.set(work.poolId, work);
  }
  const pageAdmission = createPageAdmission({
    accumulators,
    configuration,
    prepared,
    rpc,
    signal,
    sources,
    workByPoolId,
  });
  for (const range of ranges) {
    signal?.throwIfAborted();
    const requestRange = Object.freeze({
      ...range,
      poolManager: configuration.poolManager,
      swapTopic: configuration.swapTopic,
    });
    await collectCapacityPages({
      rpc,
      range: requestRange,
      poolIds: range.poolIds,
      resolveMidpoint: async (timestamp) => (
        await resolveBoundary(
          rpc,
          timestamp,
          prepared.minimumBlock,
          prepared.finalized,
          prepared.blockIdentities,
        )
      ).blockNumber,
      signal,
      onPage: (page) => admitPage(page, pageAdmission),
    });
  }
  const candlesByPool = new Map([...accumulators].map(([poolId, accumulator]) => [poolId, accumulator.values()]));
  const bases = prepared.plan.work.map((work) => {
    const owned = workByPoolId.get(work.poolId);
    const candles = candlesByPool.get(work.poolId).filter((candle) => (
      candle.intervalStart >= work.fromTimestamp && candle.intervalEnd <= work.untilTimestamp
    )).map(deepFreeze);
    return Object.freeze({
      baseCurrencyAddress: work.baseCurrencyAddress,
      candles: Object.freeze(candles),
      coverage: Object.freeze({
        fromBlock: owned.fromBlock,
        fromTimestamp: work.fromTimestamp,
        poolId: work.poolId,
        untilBlock: owned.untilBlock,
        untilTimestamp: work.untilTimestamp,
      }),
      kind: work.kind,
    });
  }).sort((left, right) => (
    left.coverage.fromTimestamp.localeCompare(right.coverage.fromTimestamp)
    || left.coverage.untilTimestamp.localeCompare(right.coverage.untilTimestamp)
    || left.coverage.poolId.localeCompare(right.coverage.poolId)
    || left.baseCurrencyAddress.localeCompare(right.baseCurrencyAddress)
  ));
  return Object.freeze({ bases: Object.freeze(bases), ranges });
}

function sharedCollectionInputs({
  admittedConfiguration,
  state: stateValue,
  rpcClients,
  onEndpointFailure,
  signal,
}) {
  const admitted = configurationInput(admittedConfiguration);
  const configuration = admitted.configuration;
  const state = validateSharedCollectionState(stateValue, configuration);
  if (
    !Array.isArray(rpcClients)
    || rpcClients.length === 0
    || rpcClients.length > maximumRpcEndpointCount
    || rpcClients.some((rpc) => (
      rpc === null
      || typeof rpc !== "object"
      || ["findFirstBlockAtOrAfterTimestamp", "getBlock", "getBlockHeaders", "getLogs", "verifyChain"]
        .some((method) => typeof rpc[method] !== "function")
    ))
  ) {
    throw new TypeError("Shared-collection RPC endpoint set is invalid.");
  }
  if (onEndpointFailure !== undefined && typeof onEndpointFailure !== "function") {
    throw new TypeError("Shared-collection endpoint observer is invalid.");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("Shared-collection cancellation signal is invalid.");
  }
  return Object.freeze({ admitted, configuration, state });
}

function fixedFinalizedInput(value) {
  if (value === null) return null;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort())
      !== JSON.stringify(["blockHash", "blockNumber", "timestamp"])
    || !isCanonicalBytes32(value.blockHash)
    || typeof value.blockNumber !== "string"
    || !/^(?:0|[1-9][0-9]*)$/u.test(value.blockNumber)
  ) {
    throw new TypeError("Fixed finalized block is invalid.");
  }
  let timestampSeconds;
  try {
    timestampSeconds = parseUtcInstantSeconds(value.timestamp, "Fixed finalized block timestamp");
  } catch {
    throw new TypeError("Fixed finalized block is invalid.");
  }
  return Object.freeze({
    hash: value.blockHash,
    number: BigInt(value.blockNumber),
    timestampSeconds,
  });
}

function repairFromPreparedPhase(preparedPhase) {
  if (preparedPhase?.phase !== "repair") return null;
  const work = Array.isArray(preparedPhase.work) ? preparedPhase.work[0] : null;
  if (work === null || typeof work !== "object") {
    throw new TypeError("Prepared repair phase is invalid.");
  }
  return {
    baseCurrencyAddress: work.baseCurrencyAddress,
    fromBlock: work.fromBlock,
    fromTimestamp: work.fromTimestamp,
    poolId: work.poolId,
    untilBlock: work.untilBlock,
    untilTimestamp: work.untilTimestamp,
  };
}

async function prepareWithEndpoints({
  admitted,
  configuration,
  state,
  repair,
  fixedFinalized,
  rpcClients,
  onEndpointFailure,
  signal,
}) {
  const failures = [];
  for (let endpointIndex = 0; endpointIndex < rpcClients.length; endpointIndex += 1) {
    signal?.throwIfAborted();
    try {
      const prepared = await prepareEndpoint({
        rpc: rpcClients[endpointIndex],
        configuration,
        state,
        repair,
        fixedFinalized,
      });
      return Object.freeze({
        prepared,
        preparedPhase: preparedPhaseOutput(admitted, prepared, state),
      });
    } catch (error) {
      if (!(error instanceof RpcEndpointUnavailableError)) throw error;
      const failure = endpointFailure(error, endpointIndex);
      failures.push(failure);
      onEndpointFailure?.(failure);
    }
  }
  throw new SharedCollectionUnavailableError(failures);
}

export async function prepareSharedCollectionPhase({
  admittedConfiguration,
  state: stateValue,
  rpcClients,
  repair = null,
  fixedFinalizedBlock = null,
  onEndpointFailure,
  signal,
}) {
  const inputs = sharedCollectionInputs({
    admittedConfiguration,
    state: stateValue,
    rpcClients,
    onEndpointFailure,
    signal,
  });
  if (repair !== null) validateSharedCollectionRepair(repair, inputs.state);
  const prepared = await prepareWithEndpoints({
    ...inputs,
    repair,
    fixedFinalized: fixedFinalizedInput(fixedFinalizedBlock),
    rpcClients,
    onEndpointFailure,
    signal,
  });
  return Object.freeze({ preparedPhase: prepared.preparedPhase });
}

export async function executeSharedCollectionPhase({
  admittedConfiguration,
  state: stateValue,
  preparedPhase,
  rpcClients,
  onEndpointFailure,
  signal,
}) {
  const inputs = sharedCollectionInputs({
    admittedConfiguration,
    state: stateValue,
    rpcClients,
    onEndpointFailure,
    signal,
  });
  if (
    preparedPhase === null
    || typeof preparedPhase !== "object"
    || preparedPhase.configurationSha256 !== inputs.admitted.sha256
    || preparedPhase.priorStateSha256 !== sha256Hex(canonicalBytes(inputs.state))
  ) {
    throw new TypeError("Prepared shared-collection input identity changed.");
  }
  const repair = repairFromPreparedPhase(preparedPhase);
  if (repair !== null) validateSharedCollectionRepair(repair, inputs.state);
  const fixedFinalized = fixedFinalizedInput(preparedPhase?.finalizedBlock ?? null);
  if (fixedFinalized === null) throw new TypeError("Prepared shared-collection phase is invalid.");
  const failures = [];
  for (let endpointIndex = 0; endpointIndex < rpcClients.length; endpointIndex += 1) {
    signal?.throwIfAborted();
    try {
      const prepared = await prepareEndpoint({
        rpc: rpcClients[endpointIndex],
        configuration: inputs.configuration,
        state: inputs.state,
        repair,
        fixedFinalized,
      });
      const reproducedPhase = preparedPhaseOutput(inputs.admitted, prepared, inputs.state);
      if (canonicalJson(reproducedPhase) !== canonicalJson(preparedPhase)) {
        throw rejectRpc("finalized_boundary_mismatch", rpcMethods.getBlockByNumber);
      }
      const collected = prepared.plan.phase === "idle"
        ? Object.freeze({ bases: Object.freeze([]), ranges: Object.freeze([]) })
        : await collectPrepared({
          rpc: rpcClients[endpointIndex],
          prepared,
          configuration: inputs.configuration,
          state: inputs.state,
          signal,
        });
      const result = Object.freeze({
        status: "collected",
        phase: prepared.plan.phase,
        configurationSha256: inputs.admitted.sha256,
        finalizedBlock: exactBlockIdentity(prepared.finalized),
        target: prepared.target,
        ranges: collected.ranges,
        bases: collected.bases,
      });
      return Object.freeze({
        result,
        selectedEndpointIndex: endpointIndex,
      });
    } catch (error) {
      if (!(error instanceof RpcEndpointUnavailableError)) throw error;
      const failure = endpointFailure(error, endpointIndex);
      failures.push(failure);
      onEndpointFailure?.(failure);
    }
  }
  throw new SharedCollectionUnavailableError(failures);
}
