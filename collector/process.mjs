import { pairDayLogicalId, pairMonthLogicalId } from "./pair-file-identity.mjs";
import {
  affectedResolutionOwnerMonths,
  candleResolutionCatalog,
  createResolutionArtifacts,
} from "./candle-resolution.mjs";
import { canonicalBytes } from "./canonical.mjs";
import { CandleAccumulator, mergePairCandles } from "./candles.mjs";
import {
  createPairFileReference,
  encodePairDayFile,
  encodePairMonthFile,
  encodePairStateFile,
  encodeResolutionArtifact,
  pairMonthSourceIds,
} from "./pair-files.mjs";
import {
  readPairDay,
  readPairMonth,
  readPairResolution,
  readPairStateSelection,
} from "./pair-reader.mjs";
import { pairById } from "./pair-registry.mjs";
import { publishPairReplacement } from "./publication.mjs";
import {
  rpcMethods,
  RpcEndpointUnavailableError,
  RpcResponseRejectedError,
} from "./rpc-endpoint.mjs";
import { decodeSwapLog } from "./swap.mjs";
import {
  admitSwapPositionIdentity,
  compareSwapPosition,
  createSwapPositionIdentities,
} from "./swap-position.mjs";
import { formatUtcInstant, parseUtcInstantSeconds } from "./utc-time.mjs";

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function minuteFloor(seconds, candleSeconds) {
  return Math.floor(seconds / candleSeconds) * candleSeconds;
}

function minimum(left, right) {
  return left < right ? left : right;
}

function maximum(left, right) {
  return left > right ? left : right;
}

function rejectRpcResponse(reason, rpcMethod) {
  return new RpcResponseRejectedError(reason, { rpcMethod });
}

function admitRpcResponse(rpcMethod, admission) {
  try {
    return admission();
  } catch (error) {
    if (error instanceof RpcResponseRejectedError) throw error;
    throw rejectRpcResponse("response_result_invalid", rpcMethod);
  }
}

function replaceReference(references, replacement) {
  return [...references.filter((reference) => reference.logicalId !== replacement.logicalId), replacement]
    .sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

function replaceResolutionReference(references, replacement) {
  return [...references.filter((reference) => reference.logicalId !== replacement.logicalId), replacement]
    .sort((left, right) => left.intervalSeconds - right.intervalSeconds);
}

function coverageFromReferences(references) {
  if (!Array.isArray(references) || references.length === 0) throw new Error("A parent file cannot be built without child references.");
  return {
    fromBlock: references[0].coverage.fromBlock,
    fromTimestamp: references[0].coverage.fromTimestamp,
    untilBlock: references.at(-1).coverage.untilBlock,
    untilTimestamp: references.at(-1).coverage.untilTimestamp,
  };
}

function sameCoverage(left, right) {
  return left.fromBlock === right.fromBlock
    && left.fromTimestamp === right.fromTimestamp
    && left.untilBlock === right.untilBlock
    && left.untilTimestamp === right.untilTimestamp;
}

function joinCoverage(existing, replacement) {
  if (existing === null) return { ...replacement };
  if (
    existing.fromTimestamp === replacement.fromTimestamp
      && existing.fromBlock !== replacement.fromBlock
    || existing.untilTimestamp === replacement.untilTimestamp
      && existing.untilBlock !== replacement.untilBlock
  ) {
    throw new Error("Equal coverage instants disagree on their block boundary.");
  }
  const ordered = [existing, replacement].sort((left, right) => left.fromTimestamp.localeCompare(right.fromTimestamp));
  const [first, second] = ordered;
  if (first.untilTimestamp < second.fromTimestamp || BigInt(first.untilBlock) < BigInt(second.fromBlock)) {
    throw new Error("Day replacement would create a coverage gap.");
  }
  if (first.untilTimestamp === second.fromTimestamp && first.untilBlock !== second.fromBlock) {
    throw new Error("Adjacent day coverage disagrees on its block boundary.");
  }
  const from = existing.fromTimestamp <= replacement.fromTimestamp ? existing : replacement;
  const until = existing.untilTimestamp >= replacement.untilTimestamp ? existing : replacement;
  return {
    fromBlock: from.fromBlock,
    fromTimestamp: from.fromTimestamp,
    untilBlock: until.untilBlock,
    untilTimestamp: until.untilTimestamp,
  };
}

function assertFinalizedCoversStoredRange(state, pair, finalized) {
  const untilBlock = BigInt(state?.coverage.untilBlock ?? pair.activation.blockNumber);
  const requiredBlock = untilBlock === 0n ? 0n : untilBlock - 1n;
  if (finalized.number < requiredBlock) {
    throw new RpcEndpointUnavailableError("required_resource_unavailable", {
      rpcMethod: rpcMethods.getBlockByNumber,
    });
  }
}

function sameBlock(left, right) {
  return left.number === right.number
    && left.hash === right.hash
    && left.timestampSeconds === right.timestampSeconds;
}

async function fixedFinalizedBlock({ registry, pair, rpc, state, finalizedBoundary }) {
  if (finalizedBoundary === null || typeof finalizedBoundary !== "object" || !Object.hasOwn(finalizedBoundary, "block")) {
    throw new Error("Finalized boundary holder is invalid.");
  }
  const providerFinalized = await rpc.getBlock(registry.chain.finalityTag);
  assertFinalizedCoversStoredRange(state, pair, providerFinalized);
  if (finalizedBoundary.block === null) {
    finalizedBoundary.block = Object.freeze({ ...providerFinalized });
    return finalizedBoundary.block;
  }
  if (providerFinalized.number < finalizedBoundary.block.number) {
    throw new RpcEndpointUnavailableError("required_resource_unavailable", {
      rpcMethod: rpcMethods.getBlockByNumber,
    });
  }
  const providerCopy = providerFinalized.number === finalizedBoundary.block.number
    ? providerFinalized
    : await rpc.getBlock(finalizedBoundary.block.number);
  if (!sameBlock(providerCopy, finalizedBoundary.block)) {
    throw rejectRpcResponse("finalized_boundary_mismatch", rpcMethods.getBlockByNumber);
  }
  return finalizedBoundary.block;
}

async function verifyActivationBoundary(pair, rpc) {
  const block = await rpc.getBlock(BigInt(pair.activation.blockNumber));
  if (
    block.number !== BigInt(pair.activation.blockNumber)
    || block.hash !== pair.activation.hash
    || formatUtcInstant(block.timestampSeconds, "Activation block timestamp") !== pair.activation.timestamp
  ) {
    throw rejectRpcResponse("activation_boundary_mismatch", rpcMethods.getBlockByNumber);
  }
}

async function coveragePartitions({ rpc, fromBlock, untilBlock, fromTimestamp, untilTimestamp, signal }) {
  const output = [];
  let cursorBlock = BigInt(fromBlock);
  const exclusiveBlock = BigInt(untilBlock);
  let cursorSeconds = parseUtcInstantSeconds(fromTimestamp, "Coverage start", true);
  const untilSeconds = parseUtcInstantSeconds(untilTimestamp, "Coverage end", true);
  if (cursorBlock > exclusiveBlock || cursorSeconds >= untilSeconds) throw new Error("Coverage partition range is invalid.");
  while (cursorSeconds < untilSeconds) {
    throwIfAborted(signal);
    const nextDaySeconds = Math.floor(cursorSeconds / 86_400) * 86_400 + 86_400;
    const segmentUntilSeconds = Math.min(untilSeconds, nextDaySeconds);
    const segmentUntilBlock = segmentUntilSeconds === untilSeconds || cursorBlock === exclusiveBlock
      ? exclusiveBlock
      : await rpc.findFirstBlockAtOrAfterTimestamp(segmentUntilSeconds, cursorBlock, exclusiveBlock - 1n);
    if (segmentUntilBlock < cursorBlock || segmentUntilBlock > exclusiveBlock) {
      throw new Error("Coverage block boundary is outside the collected range.");
    }
    output.push({
      day: formatUtcInstant(cursorSeconds, "Coverage day boundary").slice(0, 10),
      coverage: {
        fromBlock: cursorBlock.toString(),
        fromTimestamp: formatUtcInstant(cursorSeconds, "Coverage start"),
        untilBlock: segmentUntilBlock.toString(),
        untilTimestamp: formatUtcInstant(segmentUntilSeconds, "Coverage end"),
      },
    });
    cursorBlock = segmentUntilBlock;
    cursorSeconds = segmentUntilSeconds;
  }
  return output;
}

function admitSwapLogPage({ logs, source, minimumBlock, maximumBlock, previousPosition, identities }) {
  const decoded = logs.map((log) => decodeSwapLog(log, source))
    .sort((left, right) => compareSwapPosition(left.swapPosition, right.swapPosition));
  const expectedBlocks = new Map();
  let lastPosition = previousPosition;
  for (const swap of decoded) {
    if (swap.blockNumber < minimumBlock || swap.blockNumber >= maximumBlock) {
      throw new Error("Swap log is outside its requested block range.");
    }
    if (lastPosition !== null && compareSwapPosition(lastPosition, swap.swapPosition) >= 0) {
      throw new Error("Swap source positions are duplicated or unordered across ranges.");
    }
    lastPosition = swap.swapPosition;
    admitSwapPositionIdentity(swap.swapPosition, identities, "Swap logs");
    const blockKey = swap.blockNumber.toString();
    expectedBlocks.set(blockKey, { number: swap.blockNumber, hash: swap.blockHash });
  }
  return { decoded, expectedBlocks: [...expectedBlocks.values()], lastPosition };
}

async function collectFixedRange({ registry, pair, rpc, range, signal }) {
  const rangeFromSeconds = parseUtcInstantSeconds(range.fromTimestamp, "Collection range start", true);
  const rangeUntilSeconds = parseUtcInstantSeconds(range.untilTimestamp, "Collection range end", true);
  const durationSeconds = rangeUntilSeconds - rangeFromSeconds;
  const maximumBuckets = Math.ceil(durationSeconds / registry.collection.candleSeconds);
  if (!Number.isSafeInteger(maximumBuckets) || maximumBuckets <= 0) throw new Error("Collection time range is invalid.");
  const accumulator = new CandleAccumulator({
    poolId: pair.pairId,
    candleSeconds: registry.collection.candleSeconds,
    maximumBuckets,
  });
  let cursor = BigInt(range.fromBlock);
  const exclusive = BigInt(range.untilBlock);
  let previousSwapPosition = null;
  const swapPositionIdentities = createSwapPositionIdentities();
  const source = Object.freeze({
    baseDecimals: pair.baseAsset.decimals,
    baseIsCurrency0: pair.baseIsCurrency0,
    poolId: pair.pairId,
    poolManager: pair.poolManager,
    quoteDecimals: pair.quoteAsset.decimals,
    swapTopic: pair.swapTopic,
  });
  if (cursor > exclusive) throw new Error("Collection block range is inverted.");
  while (cursor < exclusive) {
    throwIfAborted(signal);
    const rangeUntil = minimum(cursor + BigInt(registry.collection.logRangeBlocks), exclusive);
    const logs = await rpc.getLogs({
      address: pair.poolManager,
      poolIds: [pair.pairId],
      swapTopic: pair.swapTopic,
      fromBlock: cursor,
      toBlock: rangeUntil - 1n,
    });
    const page = admitRpcResponse(rpcMethods.getLogs, () => admitSwapLogPage({
      logs,
      source,
      minimumBlock: cursor,
      maximumBlock: rangeUntil,
      previousPosition: previousSwapPosition,
      identities: swapPositionIdentities,
    }));
    previousSwapPosition = page.lastPosition;
    const headers = page.expectedBlocks.length === 0
      ? new Map()
      : await rpc.getBlockHeaders(
        page.expectedBlocks,
        registry.collection.headerBatchSize,
        { minimumTimestampSeconds: rangeFromSeconds, maximumTimestampSeconds: rangeUntilSeconds },
      );
    const swaps = [];
    for (const decoded of page.decoded) {
      const header = headers.get(decoded.blockNumber.toString());
      if (
        header === undefined
        || header.number !== decoded.blockNumber
        || header.hash !== decoded.blockHash
        || header.timestampSeconds < rangeFromSeconds
        || header.timestampSeconds >= rangeUntilSeconds
      ) {
        throw rejectRpcResponse("response_result_invalid", rpcMethods.getBlockByNumber);
      }
      swaps.push({
        poolId: decoded.poolId,
        blockTimestamp: header.timestampSeconds,
        swapPosition: decoded.swapPosition,
        trade: decoded.trade,
      });
    }
    admitRpcResponse(rpcMethods.getLogs, () => accumulator.addSwaps(swaps));
    cursor = rangeUntil;
  }
  return {
    candles: accumulator.values(),
    partitions: await coveragePartitions({ rpc, ...range, signal }),
  };
}

async function assertSelectedStateUnchanged({ registry, pairId, store, previousSelection }) {
  const current = await readPairStateSelection({ registry, pairId, store });
  if (
    previousSelection === null
      ? current !== null
      : current === null
        || current.identity.sequence !== previousSelection.identity.sequence
        || !current.gzipBytes.equals(previousSelection.gzipBytes)
  ) {
    throw new Error("Selected pair state changed during the operation.");
  }
}

function utcDays(fromTimestamp, untilTimestamp) {
  const output = [];
  const cursor = new Date(fromTimestamp);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < Date.parse(untilTimestamp)) {
    output.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return output;
}

function createArtifactLoader({ registry, pair, store, state }) {
  const months = new Map();
  const days = new Map();
  const resolutions = new Map();
  return {
    async month(pairMonth) {
      if (months.has(pairMonth)) return months.get(pairMonth);
      const reference = state?.months.find((candidate) => candidate.logicalId === pairMonthLogicalId(pair.pairId, pairMonth)) ?? null;
      const value = reference === null ? null : await readPairMonth({ registry, store, reference });
      const entry = { value, reference };
      months.set(pairMonth, entry);
      return entry;
    },
    async day(period) {
      if (days.has(period)) return days.get(period);
      const month = await this.month(period.slice(0, 7));
      const reference = month.value?.days.find((candidate) => candidate.logicalId === pairDayLogicalId(pair.pairId, period)) ?? null;
      const value = reference === null ? null : await readPairDay({ registry, store, reference });
      const entry = { value, reference };
      days.set(period, entry);
      return entry;
    },
    async resolution(ownerMonth, intervalSeconds) {
      const key = `${ownerMonth}:${intervalSeconds}`;
      if (resolutions.has(key)) return resolutions.get(key);
      const month = await this.month(ownerMonth);
      const reference = month.value?.resolutions.find((candidate) => candidate.intervalSeconds === intervalSeconds) ?? null;
      const value = reference === null ? null : await readPairResolution({ registry, store, reference });
      const entry = { value, reference };
      resolutions.set(key, entry);
      return entry;
    },
  };
}

function expectedStateCoverage(previous, pair, range, phase) {
  const activation = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: pair.activation.blockNumber,
    untilTimestamp: pair.activation.timestamp,
  };
  const existing = previous?.coverage ?? activation;
  if (phase === "current") {
    if (range.fromBlock !== existing.untilBlock || range.fromTimestamp !== existing.untilTimestamp) {
      throw new Error("Current collection does not start at the stored coverage end.");
    }
    return { ...existing, untilBlock: range.untilBlock, untilTimestamp: range.untilTimestamp };
  }
  if (phase === "history") {
    if (range.untilBlock !== existing.fromBlock || range.untilTimestamp !== existing.fromTimestamp) {
      throw new Error("Historical collection does not end at the stored coverage start.");
    }
    return { ...existing, fromBlock: range.fromBlock, fromTimestamp: range.fromTimestamp };
  }
  if (previous === null || range.fromTimestamp < existing.fromTimestamp || range.untilTimestamp > existing.untilTimestamp || BigInt(range.fromBlock) < BigInt(existing.fromBlock) || BigInt(range.untilBlock) > BigInt(existing.untilBlock)) {
    throw new Error("Repair range escapes selected coverage.");
  }
  return { ...existing };
}

function joinTimeCoverage(existing, replacement) {
  if (existing === null) return { ...replacement };
  const ordered = [existing, replacement].sort((left, right) => left.fromTimestamp.localeCompare(right.fromTimestamp));
  if (ordered[0].untilTimestamp < ordered[1].fromTimestamp) throw new Error("Resolution replacement would create a time-coverage gap.");
  return {
    fromTimestamp: ordered[0].fromTimestamp,
    untilTimestamp: ordered[0].untilTimestamp >= ordered[1].untilTimestamp
      ? ordered[0].untilTimestamp
      : ordered[1].untilTimestamp,
  };
}

function mergeResolutionArtifact(existing, replacement, sequence) {
  if (replacement === null) return existing;
  if (existing === null) return { ...replacement, sequence };
  if (
    existing.pair.pairId !== replacement.pair.pairId
    || existing.ownerMonth !== replacement.ownerMonth
    || existing.intervalSeconds !== replacement.intervalSeconds
  ) throw new Error("Resolution replacement identity is invalid.");
  return {
    ...existing,
    sequence,
    timeCoverage: joinTimeCoverage(existing.timeCoverage, replacement.timeCoverage),
    candles: [
      ...existing.candles.filter((candle) => (
        candle.intervalStart < replacement.timeCoverage.fromTimestamp
        || candle.intervalStart >= replacement.timeCoverage.untilTimestamp
      )),
      ...replacement.candles,
    ].sort((left, right) => left.intervalStart.localeCompare(right.intervalStart)),
  };
}

async function buildReplacement({ registry, pair, store, previousSelection, phase, range, collected }) {
  const previous = previousSelection?.state ?? null;
  const expectedCoverage = expectedStateCoverage(previous, pair, range, phase);
  const loader = createArtifactLoader({ registry, pair, store, state: previous });
  const sequence = previous === null ? 1 : previous.sequence + 1;
  const candlesByDay = new Map();
  for (const candle of collected.candles) {
    const day = candle.intervalStart.slice(0, 10);
    const values = candlesByDay.get(day) ?? [];
    values.push(candle);
    candlesByDay.set(day, values);
  }

  const encodedDays = [];
  const candidateDays = new Map();
  for (const partition of collected.partitions) {
    const currentEntry = await loader.day(partition.day);
    const current = currentEntry?.value ?? null;
    const day = {
      kind: "pair_candle_day",
      pair,
      sequence,
      day: partition.day,
      coverage: joinCoverage(current?.coverage ?? null, partition.coverage),
      candles: mergePairCandles(
        current?.candles ?? [],
        candlesByDay.get(partition.day) ?? [],
        partition.coverage.fromTimestamp,
        partition.coverage.untilTimestamp,
      ),
    };
    const encoded = encodePairDayFile(day, { registry });
    const reference = createPairFileReference({ encoded, context: { registry } });
    encodedDays.push({
      value: day,
      reference,
      encoded,
      previousReference: currentEntry?.reference ?? null,
    });
    candidateDays.set(partition.day, { value: day, reference });
  }

  const canonicalChangedMonths = new Set(collected.partitions.map((partition) => partition.day.slice(0, 7)));
  const affectedByResolution = new Map();
  const ownerMonths = new Set(canonicalChangedMonths);
  for (const definition of candleResolutionCatalog.slice(1)) {
    const owners = affectedResolutionOwnerMonths({
      fromTimestamp: range.fromTimestamp,
      untilTimestamp: range.untilTimestamp,
      intervalSeconds: definition.intervalSeconds,
    });
    affectedByResolution.set(definition.intervalSeconds, owners);
    for (const owner of owners) ownerMonths.add(owner);
  }

  async function candidateDay(period) {
    return candidateDays.get(period) ?? loader.day(period);
  }

  const resolutionRequests = [];
  for (const definition of candleResolutionCatalog.slice(1)) {
    const intervalMilliseconds = definition.intervalSeconds * 1_000;
    const from = Math.floor(Date.parse(range.fromTimestamp) / intervalMilliseconds) * intervalMilliseconds;
    const until = Math.ceil(Date.parse(range.untilTimestamp) / intervalMilliseconds) * intervalMilliseconds;
    const fromTimestamp = new Date(Math.max(from, Date.parse(expectedCoverage.fromTimestamp))).toISOString();
    const untilTimestamp = new Date(Math.min(until, Date.parse(expectedCoverage.untilTimestamp))).toISOString();
    if (fromTimestamp >= untilTimestamp) continue;
    for (const ownerMonth of affectedByResolution.get(definition.intervalSeconds)) {
      resolutionRequests.push({
        sequence,
        ownerMonth,
        intervalSeconds: definition.intervalSeconds,
        fromTimestamp,
        untilTimestamp,
      });
    }
  }
  const sourceFrom = resolutionRequests.reduce(
    (value, request) => value === null || request.fromTimestamp < value ? request.fromTimestamp : value,
    null,
  );
  const sourceUntil = resolutionRequests.reduce(
    (value, request) => value === null || request.untilTimestamp > value ? request.untilTimestamp : value,
    null,
  );
  const resolutionSourceEntries = [];
  if (sourceFrom !== null && sourceUntil !== null) {
    for (const period of utcDays(sourceFrom, sourceUntil)) {
      const entry = await candidateDay(period);
      if (entry.value === null) throw new Error("Resolution source day is unavailable inside candidate coverage.");
      resolutionSourceEntries.push(entry);
    }
  }
  const fragments = resolutionRequests.length === 0 ? [] : createResolutionArtifacts({
    registry,
    pair,
    sourceCoverage: coverageFromReferences(resolutionSourceEntries.map((entry) => entry.reference)),
    candles: resolutionSourceEntries.flatMap((entry) => entry.value.candles),
    requests: resolutionRequests,
  });
  const encodedResolutions = [];
  const candidateResolutionReferences = new Map();
  for (const fragmentEntry of fragments) {
    const { artifact: fragment, ownerMonth, intervalSeconds } = fragmentEntry;
    if (fragment === null) continue;
    const currentEntry = await loader.resolution(ownerMonth, intervalSeconds);
    const value = mergeResolutionArtifact(currentEntry.value, fragment, sequence);
    const unchanged = currentEntry.value !== null
      && canonicalBytes({ ...value, sequence: currentEntry.value.sequence }).equals(canonicalBytes(currentEntry.value));
    if (unchanged) {
      candidateResolutionReferences.set(`${ownerMonth}:${intervalSeconds}`, currentEntry.reference);
      continue;
    }
    const encoded = encodeResolutionArtifact(value, { registry });
    const reference = createPairFileReference({ encoded, context: { registry } });
    encodedResolutions.push({ value, reference, encoded, previousReference: currentEntry.reference });
    candidateResolutionReferences.set(`${ownerMonth}:${intervalSeconds}`, reference);
  }

  const encodedMonths = [];
  const replacementMonths = new Map();
  for (const pairMonth of [...ownerMonths].sort()) {
    const currentEntry = await loader.month(pairMonth);
    if (currentEntry.value === null && !canonicalChangedMonths.has(pairMonth)) continue;
    let dayReferences = [...(currentEntry.value?.days ?? [])];
    for (const [period, entry] of candidateDays) {
      if (period.startsWith(`${pairMonth}-`)) dayReferences = replaceReference(dayReferences, entry.reference);
    }
    if (dayReferences.length === 0) continue;
    let resolutionReferences = [...(currentEntry.value?.resolutions ?? [])];
    for (const definition of candleResolutionCatalog.slice(1)) {
      const replacement = candidateResolutionReferences.get(`${pairMonth}:${definition.intervalSeconds}`);
      if (replacement !== undefined) resolutionReferences = replaceResolutionReference(resolutionReferences, replacement);
    }
    if (![...dayReferences, ...resolutionReferences].some((reference) => reference.sequence === sequence)) continue;
    const month = {
      kind: "pair_candle_month",
      pair,
      sequence,
      month: pairMonth,
      coverage: coverageFromReferences(dayReferences),
      days: dayReferences,
      sourceMonths: pairMonthSourceIds(pair.pairId, pairMonth, resolutionReferences),
      resolutions: resolutionReferences,
    };
    const encoded = encodePairMonthFile(month, { registry });
    const reference = createPairFileReference({ encoded, context: { registry } });
    encodedMonths.push({
      value: month,
      reference,
      encoded,
      previousReference: currentEntry.reference,
      previousValue: currentEntry.value,
    });
    replacementMonths.set(pairMonth, reference);
  }

  let monthReferences = [...(previous?.months ?? [])];
  for (const replacement of replacementMonths.values()) monthReferences = replaceReference(monthReferences, replacement);
  const derivedCoverage = coverageFromReferences(monthReferences);
  if (!sameCoverage(derivedCoverage, expectedCoverage)) throw new Error("Rebuilt pair state does not match the operation coverage.");
  const state = {
    kind: "pair_candle_state",
    pair,
    sequence,
    coverage: expectedCoverage,
    resolutions: candleResolutionCatalog,
    months: monthReferences,
  };
  const encodedState = encodePairStateFile(state, { registry });
  return { state, encodedState, encodedDays, encodedResolutions, encodedMonths };
}

async function publishReplacement({ registry, pair, store, previousSelection, phase, range, collected, signal }) {
  const replacement = await buildReplacement({ registry, pair, store, previousSelection, phase, range, collected });
  await assertSelectedStateUnchanged({ registry, pairId: pair.pairId, store, previousSelection });
  await publishPairReplacement({ registry, pair, store, previousSelection, phase, replacement, signal });
  return {
    status: "published",
    phase,
    pairId: pair.pairId,
    sequence: replacement.state.sequence,
    fromBlock: range.fromBlock,
    untilBlock: range.untilBlock,
    fromTimestamp: range.fromTimestamp,
    untilTimestamp: range.untilTimestamp,
    candleCount: collected.candles.length,
  };
}

async function currentRange({ registry, pair, rpc, state, finalized }) {
  const fromBlock = BigInt(state?.coverage.untilBlock ?? pair.activation.blockNumber);
  const fromSeconds = parseUtcInstantSeconds(
    state?.coverage.untilTimestamp ?? pair.activation.timestamp,
    "Current range start",
    true,
  );
  const finalizedNumber = finalized.number;
  if (finalizedNumber < fromBlock) return { range: null, reachedFinalizedBoundary: true };
  const finalizedBoundarySeconds = minuteFloor(finalized.timestampSeconds, registry.collection.candleSeconds);
  if (finalizedBoundarySeconds <= fromSeconds) return { range: null, reachedFinalizedBoundary: true };
  const searchHigh = minimum(fromBlock + BigInt(registry.collection.maximumBlocksPerRun), finalizedNumber);
  const searchHighHeader = searchHigh === finalizedNumber ? finalized : await rpc.getBlock(searchHigh);
  const nextDaySeconds = Math.floor(fromSeconds / 86_400) * 86_400 + 86_400;
  const untilSeconds = minimum(
    minuteFloor(searchHighHeader.timestampSeconds, registry.collection.candleSeconds),
    minimum(finalizedBoundarySeconds, nextDaySeconds),
  );
  if (untilSeconds <= fromSeconds) {
    return { range: null, reachedFinalizedBoundary: searchHigh === finalizedNumber };
  }
  const untilBlock = await rpc.findFirstBlockAtOrAfterTimestamp(
    untilSeconds,
    fromBlock,
    searchHigh,
    { maximumBlockHeader: searchHighHeader },
  );
  if (untilBlock < fromBlock || untilBlock > searchHigh) throw new Error("Current boundary is outside its fixed block range.");
  return {
    range: {
      fromBlock: fromBlock.toString(),
      fromTimestamp: formatUtcInstant(fromSeconds, "Current range start"),
      untilBlock: untilBlock.toString(),
      untilTimestamp: formatUtcInstant(untilSeconds, "Current range end"),
    },
    reachedFinalizedBoundary: untilSeconds === finalizedBoundarySeconds,
  };
}

async function historyRange({ registry, pair, rpc, state }) {
  const fromBlock = BigInt(state?.coverage.fromBlock ?? pair.activation.blockNumber);
  const fromTimestamp = state?.coverage.fromTimestamp ?? pair.activation.timestamp;
  const historyBlock = BigInt(pair.historyStart.blockNumber);
  if (fromBlock === historyBlock && fromTimestamp === pair.historyStart.timestamp) return null;
  if (fromBlock < historyBlock || fromTimestamp < pair.historyStart.timestamp) throw new Error("Stored coverage start is before the pair historyStart boundary.");
  const nominalBlock = maximum(fromBlock - BigInt(registry.collection.maximumBlocksPerRun), historyBlock);
  const nominalHeader = await rpc.getBlock(nominalBlock);
  const nominalSeconds = minuteFloor(nominalHeader.timestampSeconds, registry.collection.candleSeconds);
  const historySeconds = parseUtcInstantSeconds(pair.historyStart.timestamp, "History boundary", true);
  const fromSeconds = parseUtcInstantSeconds(fromTimestamp, "Stored coverage start", true);
  const previousDaySeconds = Math.floor((fromSeconds - 1) / 86_400) * 86_400;
  const boundarySeconds = Math.max(nominalSeconds, historySeconds, previousDaySeconds);
  let nextFromBlock;
  if (boundarySeconds === historySeconds) {
    nextFromBlock = historyBlock;
  } else {
    const fromHeader = nominalBlock === fromBlock ? nominalHeader : await rpc.getBlock(fromBlock);
    nextFromBlock = await rpc.findFirstBlockAtOrAfterTimestamp(
      boundarySeconds,
      historyBlock,
      fromBlock,
      { maximumBlockHeader: fromHeader },
    );
  }
  const nextFromTimestamp = formatUtcInstant(boundarySeconds, "History range start");
  if (nextFromBlock > fromBlock || nextFromTimestamp >= fromTimestamp) {
    throw new Error("History collection cannot move by one complete minute.");
  }
  return {
    fromBlock: nextFromBlock.toString(),
    fromTimestamp: nextFromTimestamp,
    untilBlock: fromBlock.toString(),
    untilTimestamp: fromTimestamp,
  };
}

async function repairRange({ registry, rpc, state }) {
  if (state.coverage.fromTimestamp === state.coverage.untilTimestamp) return null;
  const earliestSeconds = parseUtcInstantSeconds(state.coverage.fromTimestamp, "Repair coverage start", true);
  const untilSeconds = parseUtcInstantSeconds(state.coverage.untilTimestamp, "Repair coverage end", true);
  const targetSeconds = Math.max(
    earliestSeconds,
    minuteFloor(untilSeconds - registry.collection.repairLookbackSeconds, registry.collection.candleSeconds),
  );
  const firstBlock = BigInt(state.coverage.fromBlock);
  const exclusiveBlock = BigInt(state.coverage.untilBlock);
  let fromBlock = firstBlock;
  if (targetSeconds > earliestSeconds && firstBlock < exclusiveBlock) {
    fromBlock = await rpc.findFirstBlockAtOrAfterTimestamp(targetSeconds, firstBlock, exclusiveBlock - 1n);
    if (fromBlock > exclusiveBlock) throw new Error("Repair boundary escapes selected coverage.");
  }
  return {
    fromBlock: fromBlock.toString(),
    fromTimestamp: formatUtcInstant(targetSeconds, "Repair range start"),
    untilBlock: exclusiveBlock.toString(),
    untilTimestamp: state.coverage.untilTimestamp,
  };
}

async function collectAndPublish({ registry, pair, store, rpc, previousSelection, phase, range, signal }) {
  const collected = await collectFixedRange({ registry, pair, rpc, range, signal });
  return publishReplacement({ registry, pair, store, previousSelection, phase, range, collected, signal });
}

export async function runPairCurrentAttempt({ registry, pairId, store, rpc, finalizedBoundary, signal }) {
  throwIfAborted(signal);
  const pair = pairById(registry, pairId).pair;
  await rpc.verifyChain(registry.chain.numericChainId);
  await verifyActivationBoundary(pair, rpc);
  const previousSelection = await readPairStateSelection({ registry, pairId, store });
  const previous = previousSelection?.state ?? null;
  const finalized = await fixedFinalizedBlock({
    registry, pair, rpc, state: previous, finalizedBoundary,
  });
  const selected = await currentRange({ registry, pair, rpc, state: previous, finalized });
  if (selected.range === null) {
    return {
      result: { status: "current", phase: "current", pairId, sequence: previous?.sequence ?? null },
      reachedFinalizedBoundary: selected.reachedFinalizedBoundary,
    };
  }
  return {
    result: await collectAndPublish({
      registry, pair, store, rpc, previousSelection, phase: "current", range: selected.range, signal,
    }),
    reachedFinalizedBoundary: selected.reachedFinalizedBoundary,
  };
}

export async function runPairHistoryAttempt({ registry, pairId, store, rpc, finalizedBoundary, signal }) {
  throwIfAborted(signal);
  const pair = pairById(registry, pairId).pair;
  await rpc.verifyChain(registry.chain.numericChainId);
  await verifyActivationBoundary(pair, rpc);
  const previousSelection = await readPairStateSelection({ registry, pairId, store });
  const previous = previousSelection?.state ?? null;
  await fixedFinalizedBlock({ registry, pair, rpc, state: previous, finalizedBoundary });
  const range = await historyRange({ registry, pair, rpc, state: previous });
  if (range === null) {
    return { result: { status: "current", phase: "history", pairId, sequence: previous?.sequence ?? null } };
  }
  return {
    result: await collectAndPublish({ registry, pair, store, rpc, previousSelection, phase: "history", range, signal }),
  };
}

export async function runPairRepairAttempt({ registry, pairId, store, rpc, finalizedBoundary, signal }) {
  throwIfAborted(signal);
  const pair = pairById(registry, pairId).pair;
  await rpc.verifyChain(registry.chain.numericChainId);
  await verifyActivationBoundary(pair, rpc);
  const previousSelection = await readPairStateSelection({ registry, pairId, store });
  const previous = previousSelection?.state ?? null;
  if (previous === null) return { result: { status: "empty", phase: "repair", pairId, sequence: null } };
  await fixedFinalizedBlock({ registry, pair, rpc, state: previous, finalizedBoundary });
  const range = await repairRange({ registry, rpc, state: previous });
  if (range === null) {
    return { result: { status: "current", phase: "repair", pairId, sequence: previous.sequence } };
  }
  return {
    result: await collectAndPublish({ registry, pair, store, rpc, previousSelection, phase: "repair", range, signal }),
  };
}
