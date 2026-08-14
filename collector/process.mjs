import {
  createState,
  dayReference,
  emptyDayArtifact,
  encodeDay,
} from "./artifact.mjs";
import {
  CandleAccumulator,
  mergeCandles,
  replaceCoverage,
} from "./candles.mjs";
import { RpcEndpointUnavailableError } from "./rpc-endpoint.mjs";
import { blockTimestamp } from "./rpc-client.mjs";
import { admitSwapLog, admitSwapLogBlockNumber } from "./swap.mjs";

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function instant(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function dayOf(timestamp) {
  return timestamp.slice(0, 10);
}

function minuteFloor(seconds, candleSeconds) {
  return Math.floor(seconds / candleSeconds) * candleSeconds;
}

function minimum(left, right) {
  return left < right ? left : right;
}

function assertFinalizedCoversStoredRange(previous, finalized) {
  if (previous === null) return;
  const nextBlock = BigInt(previous.nextBlock);
  if (nextBlock === 0n) return;
  if (BigInt(finalized.number) < nextBlock - 1n) {
    throw new RpcEndpointUnavailableError();
  }
}

function stateReferenceByDay(state) {
  return new Map((state?.days ?? []).map((reference) => [reference.day, reference]));
}

function replaceDayReference(references, replacement) {
  const output = references.filter((reference) => reference.day !== replacement.day);
  output.push(replacement);
  return output.sort((left, right) => left.day.localeCompare(right.day));
}

async function readReferencedDays(store, state, days) {
  const references = stateReferenceByDay(state);
  const output = new Map();
  for (const day of days) {
    const reference = references.get(day);
    if (reference) output.set(day, await store.readDay(reference));
  }
  return output;
}

async function coveragePartitions({ rpc, fromBlock, untilBlock, fromTimestamp, untilTimestamp, signal }) {
  const output = [];
  let cursorBlock = BigInt(fromBlock);
  const exclusiveBlock = BigInt(untilBlock);
  let cursorSeconds = Math.floor(Date.parse(fromTimestamp) / 1000);
  const untilSeconds = Math.floor(Date.parse(untilTimestamp) / 1000);
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
      day: instant(cursorSeconds).slice(0, 10),
      coverage: {
        fromBlock: cursorBlock.toString(),
        untilBlock: segmentUntilBlock.toString(),
        fromTimestamp: instant(cursorSeconds),
        untilTimestamp: instant(segmentUntilSeconds),
      },
    });
    cursorBlock = segmentUntilBlock;
    cursorSeconds = segmentUntilSeconds;
  }
  return output;
}

async function collectRange({ registry, group, rpc, fromBlock, untilBlock, fromTimestamp, untilTimestamp, signal }) {
  const durationSeconds = Math.floor((Date.parse(untilTimestamp) - Date.parse(fromTimestamp)) / 1000);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new Error("Collection time range is invalid.");
  const maximumBuckets = Math.ceil(durationSeconds / registry.collection.candleSeconds) * group.assets.length;
  const accumulator = new CandleAccumulator({
    candleSeconds: registry.collection.candleSeconds,
    maximumBuckets,
  });
  let cursor = BigInt(fromBlock);
  const exclusive = BigInt(untilBlock);
  while (cursor < exclusive) {
    throwIfAborted(signal);
    const rangeUntil = minimum(cursor + BigInt(registry.collection.logRangeBlocks), exclusive);
    const logs = await rpc.getLogs({
      address: registry.deployment.poolManager,
      poolIds: group.assets.map((asset) => asset.poolId),
      swapTopic: registry.deployment.swapTopic,
      fromBlock: cursor,
      toBlock: rangeUntil - 1n,
    });
    const blockNumbers = [];
    for (const log of logs) {
      const blockNumber = admitSwapLogBlockNumber(log);
      if (blockNumber < cursor || blockNumber >= rangeUntil) throw new Error("RPC returned a log outside the requested range.");
      blockNumbers.push(blockNumber);
    }
    const headers = logs.length === 0
      ? new Map()
      : await rpc.getBlockHeaders(blockNumbers, registry.collection.headerBatchSize);
    const trades = logs.map((log, index) => {
      const header = headers.get(blockNumbers[index].toString());
      if (!header) throw new Error("RPC omitted a block header for a Swap log.");
      return admitSwapLog(log, { registry, group, block: header });
    });
    accumulator.addTrades(trades);
    cursor = rangeUntil;
  }
  const partitions = await coveragePartitions({
    rpc,
    fromBlock,
    untilBlock,
    fromTimestamp,
    untilTimestamp,
    signal,
  });
  return { candles: accumulator.values(), partitions };
}

async function publishRange({ registry, group, store, rpc, previous, fromBlock, untilBlock, fromTimestamp, untilTimestamp, signal }) {
  const collected = await collectRange({
    registry,
    group,
    rpc,
    fromBlock,
    untilBlock,
    fromTimestamp,
    untilTimestamp,
    signal,
  });
  const affectedDays = collected.partitions.map((entry) => entry.day);
  const existingDays = await readReferencedDays(store, previous, affectedDays);
  const candlesByDay = new Map();
  for (const candle of collected.candles) {
    const day = dayOf(candle.intervalStart);
    const values = candlesByDay.get(day) ?? [];
    values.push(candle);
    candlesByDay.set(day, values);
  }

  const sequence = previous === null ? 1 : previous.sequence + 1;
  let references = [...(previous?.days ?? [])];
  const encodedDays = [];
  for (const partition of collected.partitions) {
    const current = existingDays.get(partition.day) ?? emptyDayArtifact({ registry, group, day: partition.day });
    const next = {
      ...current,
      coverage: replaceCoverage(current.coverage, partition.coverage),
      candles: mergeCandles(
        current.candles,
        candlesByDay.get(partition.day) ?? [],
        partition.coverage.fromTimestamp,
        partition.coverage.untilTimestamp,
      ),
    };
    const encoded = encodeDay(next, { registry, group });
    const reference = dayReference({ groupId: group.groupId, day: partition.day, sequence, encoded });
    references = replaceDayReference(references, reference);
    encodedDays.push({ reference, encoded });
  }
  const state = createState({
    groupId: group.groupId,
    previous,
    nextBlock: untilBlock,
    coveredUntilTimestamp: untilTimestamp,
    days: references,
  });
  throwIfAborted(signal);
  await store.commit({ state, encodedDays });
  return {
    status: "published",
    groupId: group.groupId,
    sequence: state.sequence,
    fromBlock: BigInt(fromBlock).toString(),
    untilBlock: BigInt(untilBlock).toString(),
    fromTimestamp,
    untilTimestamp,
    candleCount: collected.candles.length,
  };
}

async function collectionBoundary({ registry, rpc, previous, finalized }) {
  const candleSeconds = registry.collection.candleSeconds;
  const finalizedNumber = BigInt(finalized.number);
  const finalizedSeconds = blockTimestamp(finalized);
  let fromBlock;
  let fromSeconds;
  if (previous === null) {
    fromSeconds = minuteFloor(finalizedSeconds - registry.collection.initialLookbackSeconds, candleSeconds);
    fromBlock = await rpc.findFirstBlockAtOrAfterTimestamp(fromSeconds, 0n, finalizedNumber);
  } else {
    fromBlock = BigInt(previous.nextBlock);
    fromSeconds = Math.floor(Date.parse(previous.coveredUntilTimestamp) / 1000);
  }

  const finalizedBoundarySeconds = minuteFloor(finalizedSeconds, candleSeconds);
  const workLimit = fromBlock + BigInt(registry.collection.maximumBlocksPerRun);
  const searchHigh = minimum(workLimit, finalizedNumber);
  const searchHighHeader = searchHigh === finalizedNumber
    ? finalized
    : await rpc.getBlock(searchHigh);
  const untilSeconds = searchHigh === finalizedNumber
    ? finalizedBoundarySeconds
    : minuteFloor(blockTimestamp(searchHighHeader), candleSeconds);
  if (fromBlock > finalizedNumber) {
    return { fromBlock, fromSeconds, untilBlock: finalizedNumber, untilSeconds };
  }
  const untilBlock = await rpc.findFirstBlockAtOrAfterTimestamp(
    untilSeconds,
    fromBlock,
    searchHigh,
    { maximumBlockHeader: searchHighHeader },
  );
  return { fromBlock, fromSeconds, untilBlock, untilSeconds };
}

export async function collectIndex({ registry, group, store, rpc, signal }) {
  throwIfAborted(signal);
  await rpc.verifyChain(registry.chain.numericChainId);
  const previous = await store.readState();
  const finalized = await rpc.getBlock(registry.chain.finalityTag);
  assertFinalizedCoversStoredRange(previous, finalized);
  const boundary = await collectionBoundary({ registry, rpc, previous, finalized });
  if (boundary.untilBlock <= boundary.fromBlock || boundary.untilSeconds <= boundary.fromSeconds) {
    return { status: "current", groupId: group.groupId, sequence: previous?.sequence ?? null };
  }
  return publishRange({
    registry,
    group,
    store,
    rpc,
    previous,
    fromBlock: boundary.fromBlock,
    untilBlock: boundary.untilBlock,
    fromTimestamp: instant(boundary.fromSeconds),
    untilTimestamp: instant(boundary.untilSeconds),
    signal,
  });
}

async function readAllDays(store, state) {
  const output = [];
  for (const reference of state.days) output.push({ reference, value: await store.readDay(reference) });
  return output;
}

export async function verifyIndex({ group, store }) {
  const state = await store.readState();
  if (state === null) return { status: "empty", groupId: group.groupId };
  const days = await readAllDays(store, state);
  const ranges = days.flatMap(({ value }) => value.coverage).sort((left, right) => {
    const block = BigInt(left.fromBlock) - BigInt(right.fromBlock);
    return block < 0n ? -1 : block > 0n ? 1 : left.fromTimestamp.localeCompare(right.fromTimestamp);
  });
  if (ranges.length === 0) {
    return {
      status: "verified",
      groupId: group.groupId,
      sequence: state.sequence,
      nextBlock: state.nextBlock,
      coveredUntilTimestamp: state.coveredUntilTimestamp,
      dayCount: 0,
      candleCount: 0,
    };
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].untilBlock !== ranges[index].fromBlock || ranges[index - 1].untilTimestamp !== ranges[index].fromTimestamp) {
      throw new Error("Stored coverage is not continuous.");
    }
  }
  const last = ranges.at(-1);
  if (last.untilBlock !== state.nextBlock || last.untilTimestamp !== state.coveredUntilTimestamp) {
    throw new Error("Stored coverage does not reach the state cursor.");
  }
  return {
    status: "verified",
    groupId: group.groupId,
    sequence: state.sequence,
    nextBlock: state.nextBlock,
    coveredUntilTimestamp: state.coveredUntilTimestamp,
    dayCount: days.length,
    candleCount: days.reduce((sum, entry) => sum + entry.value.candles.length, 0),
  };
}

export async function repairIndex({ registry, group, store, rpc, signal }) {
  throwIfAborted(signal);
  await rpc.verifyChain(registry.chain.numericChainId);
  const previous = await store.readState();
  if (previous === null) return { status: "empty", groupId: group.groupId };
  const verified = await verifyIndex({ group, store });
  if (previous.days.length === 0) return { ...verified, status: "empty" };
  const finalized = await rpc.getBlock(registry.chain.finalityTag);
  assertFinalizedCoversStoredRange(previous, finalized);

  const targetSeconds = minuteFloor(
    Math.floor(Date.parse(previous.coveredUntilTimestamp) / 1000) - registry.collection.repairLookbackSeconds,
    registry.collection.candleSeconds,
  );
  const firstReference = previous.days[0];
  const firstDay = await store.readDay(firstReference);
  const firstCoverage = firstDay.coverage[0];
  const earliestSeconds = Math.floor(Date.parse(firstCoverage.fromTimestamp) / 1000);
  const fromSeconds = Math.max(targetSeconds, earliestSeconds);
  const nextBlock = BigInt(previous.nextBlock);
  const fromBlock = await rpc.findFirstBlockAtOrAfterTimestamp(fromSeconds, BigInt(firstCoverage.fromBlock), nextBlock - 1n);
  if (fromBlock >= nextBlock) return { ...verified, status: "current" };
  return publishRange({
    registry,
    group,
    store,
    rpc,
    previous,
    fromBlock,
    untilBlock: nextBlock,
    fromTimestamp: instant(fromSeconds),
    untilTimestamp: previous.coveredUntilTimestamp,
    signal,
  });
}

export async function retainIndex({ registry, group, store, now = new Date() }) {
  const previous = await store.readState();
  if (previous === null) return { status: "empty", groupId: group.groupId };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("Retention time is invalid.");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = new Date(today - (registry.collection.retentionDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const days = previous.days.filter((reference) => reference.day >= cutoff);
  if (days.length === previous.days.length) return { status: "current", groupId: group.groupId, sequence: previous.sequence };
  const state = createState({
    groupId: group.groupId,
    previous,
    nextBlock: previous.nextBlock,
    coveredUntilTimestamp: previous.coveredUntilTimestamp,
    days,
  });
  await store.commit({ state, encodedDays: [] });
  return { status: "published", groupId: group.groupId, sequence: state.sequence, removedDayCount: previous.days.length - days.length };
}
