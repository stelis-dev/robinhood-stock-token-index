import {
  createPairReference,
  encodePairDay,
  encodePairMonth,
  encodePairState,
  pairDayLogicalId,
  pairMonthLogicalId,
} from "./pair-artifact.mjs";
import { canonicalBytes } from "./canonical.mjs";
import { CandleAccumulator, mergePairCandles } from "./candles.mjs";
import {
  readPairDay,
  readPairMonth,
  readPairState,
  samePairState,
} from "./pair-reader.mjs";
import { pairById } from "./pair-registry.mjs";
import { RpcEndpointUnavailableError } from "./rpc-endpoint.mjs";
import { blockTimestamp } from "./rpc-client.mjs";
import { admitSwapLog, admitSwapLogBlockNumber } from "./swap.mjs";

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function instant(seconds) {
  return new Date(seconds * 1000).toISOString();
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

function replaceReference(references, replacement) {
  return [...references.filter((reference) => reference.logicalId !== replacement.logicalId), replacement]
    .sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

function coverageFromReferences(references) {
  if (!Array.isArray(references) || references.length === 0) throw new Error("An index artifact cannot be built without child references.");
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
  if (BigInt(finalized.number) < requiredBlock) throw new RpcEndpointUnavailableError();
}

async function verifyActivationBoundary(pair, rpc) {
  const block = await rpc.getBlock(BigInt(pair.activation.blockNumber));
  if (
    BigInt(block.number) !== BigInt(pair.activation.blockNumber)
    || block.hash !== pair.activation.hash
    || instant(blockTimestamp(block)) !== pair.activation.timestamp
  ) {
    throw new Error("RPC activation boundary does not match the committed pair source.");
  }
}

async function coveragePartitions({ rpc, fromBlock, untilBlock, fromTimestamp, untilTimestamp, signal }) {
  const output = [];
  let cursorBlock = BigInt(fromBlock);
  const exclusiveBlock = BigInt(untilBlock);
  let cursorSeconds = Math.floor(Date.parse(fromTimestamp) / 1000);
  const untilSeconds = Math.floor(Date.parse(untilTimestamp) / 1000);
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
      day: instant(cursorSeconds).slice(0, 10),
      coverage: {
        fromBlock: cursorBlock.toString(),
        fromTimestamp: instant(cursorSeconds),
        untilBlock: segmentUntilBlock.toString(),
        untilTimestamp: instant(segmentUntilSeconds),
      },
    });
    cursorBlock = segmentUntilBlock;
    cursorSeconds = segmentUntilSeconds;
  }
  return output;
}

async function collectFixedRange({ registry, pair, rpc, range, signal }) {
  const rangeFromSeconds = Math.floor(Date.parse(range.fromTimestamp) / 1000);
  const rangeUntilSeconds = Math.floor(Date.parse(range.untilTimestamp) / 1000);
  const durationSeconds = rangeUntilSeconds - rangeFromSeconds;
  const maximumBuckets = Math.ceil(durationSeconds / registry.collection.candleSeconds);
  if (!Number.isSafeInteger(maximumBuckets) || maximumBuckets <= 0) throw new Error("Collection time range is invalid.");
  const accumulator = new CandleAccumulator({
    pairId: pair.pairId,
    candleSeconds: registry.collection.candleSeconds,
    maximumBuckets,
  });
  let cursor = BigInt(range.fromBlock);
  const exclusive = BigInt(range.untilBlock);
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
    const blockNumbers = [];
    for (const log of logs) {
      const blockNumber = admitSwapLogBlockNumber(log);
      if (blockNumber < cursor || blockNumber >= rangeUntil) throw new Error("RPC returned a log outside the requested range.");
      blockNumbers.push(blockNumber);
    }
    const headers = logs.length === 0
      ? new Map()
      : await rpc.getBlockHeaders(blockNumbers, registry.collection.headerBatchSize);
    accumulator.addTrades(logs.map((log, index) => {
      const header = headers.get(blockNumbers[index].toString());
      if (!header) throw new Error("RPC omitted a block header for a Swap log.");
      const trade = admitSwapLog(log, { registry, pair, block: header });
      if (trade.blockTimestamp < rangeFromSeconds || trade.blockTimestamp >= rangeUntilSeconds) {
        throw new Error("Swap block timestamp is outside the fixed collection range.");
      }
      return trade;
    }));
    cursor = rangeUntil;
  }
  return {
    candles: accumulator.values(),
    partitions: await coveragePartitions({ rpc, ...range, signal }),
  };
}

async function assertSelectedStateUnchanged({ registry, pairId, store, previous }) {
  const current = await readPairState({ registry, pairId, store });
  if (previous === null ? current !== null : current === null || !samePairState(previous, current)) {
    throw new Error("Selected pair state changed during the operation.");
  }
}

async function loadAffectedArtifacts({ registry, pair, store, state, partitions }) {
  const months = new Map();
  const days = new Map();
  const affectedMonths = [...new Set(partitions.map((partition) => partition.day.slice(0, 7)))].sort();
  for (const pairMonth of affectedMonths) {
    const monthReference = state?.months.find((candidate) => candidate.logicalId === pairMonthLogicalId(pair.pairId, pairMonth));
    const month = monthReference ? await readPairMonth({ registry, store, reference: monthReference }) : null;
    months.set(pairMonth, month);
    for (const partition of partitions.filter((candidate) => candidate.day.startsWith(`${pairMonth}-`))) {
      const reference = month?.days.find((candidate) => candidate.logicalId === pairDayLogicalId(pair.pairId, partition.day));
      days.set(partition.day, reference ? await readPairDay({ registry, store, reference }) : null);
    }
  }
  return { months, days };
}

async function cleanupSelectedTransition({ registry, pairId, store, state }) {
  if (state === null) return;
  const changedMonths = [];
  for (const monthReference of state.months.filter((reference) => reference.sequence === state.sequence)) {
    const month = await readPairMonth({ registry, store, reference: monthReference });
    changedMonths.push({ monthReference, dayReferences: month.days });
  }
  await store.cleanupSelectedGeneration({
    pairId,
    selectedSequence: state.sequence,
    changedMonths,
  });
}

function expectedStateCoverage(previous, pair, range, role) {
  const activation = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: pair.activation.blockNumber,
    untilTimestamp: pair.activation.timestamp,
  };
  const existing = previous?.coverage ?? activation;
  if (role === "current") {
    if (range.fromBlock !== existing.untilBlock || range.fromTimestamp !== existing.untilTimestamp) {
      throw new Error("Current collection does not start at the selected forward edge.");
    }
    return { ...existing, untilBlock: range.untilBlock, untilTimestamp: range.untilTimestamp };
  }
  if (role === "history") {
    if (range.untilBlock !== existing.fromBlock || range.untilTimestamp !== existing.fromTimestamp) {
      throw new Error("History collection does not end at the selected historical edge.");
    }
    return { ...existing, fromBlock: range.fromBlock, fromTimestamp: range.fromTimestamp };
  }
  if (previous === null || range.fromTimestamp < existing.fromTimestamp || range.untilTimestamp > existing.untilTimestamp || BigInt(range.fromBlock) < BigInt(existing.fromBlock) || BigInt(range.untilBlock) > BigInt(existing.untilBlock)) {
    throw new Error("Repair range escapes selected coverage.");
  }
  return { ...existing };
}

async function buildReplacement({ registry, pair, store, previous, role, range, collected }) {
  await assertSelectedStateUnchanged({ registry, pairId: pair.pairId, store, previous });
  const expectedCoverage = expectedStateCoverage(previous, pair, range, role);
  const existing = await loadAffectedArtifacts({ registry, pair, store, state: previous, partitions: collected.partitions });
  const sequence = previous === null ? 1 : previous.sequence + 1;
  const candlesByDay = new Map();
  for (const candle of collected.candles) {
    const day = candle.intervalStart.slice(0, 10);
    const values = candlesByDay.get(day) ?? [];
    values.push(candle);
    candlesByDay.set(day, values);
  }

  const encodedDays = [];
  const replacementDays = new Map();
  for (const partition of collected.partitions) {
    const current = existing.days.get(partition.day);
    const day = {
      contractVersion: "1",
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
    const encoded = encodePairDay(day, { registry });
    const reference = createPairReference({ encoded, context: { registry } });
    encodedDays.push({ value: day, reference, encoded });
    replacementDays.set(partition.day, reference);
  }

  const encodedMonths = [];
  const replacementMonths = new Map();
  for (const pairMonth of [...new Set(collected.partitions.map((partition) => partition.day.slice(0, 7)))].sort()) {
    let references = [...(existing.months.get(pairMonth)?.days ?? [])];
    for (const [day, replacement] of replacementDays) {
      if (day.startsWith(`${pairMonth}-`)) references = replaceReference(references, replacement);
    }
    const month = {
      contractVersion: "1",
      kind: "pair_candle_month",
      pair,
      sequence,
      month: pairMonth,
      coverage: coverageFromReferences(references),
      days: references,
    };
    const encoded = encodePairMonth(month, { registry });
    const reference = createPairReference({ encoded, context: { registry } });
    encodedMonths.push({ value: month, reference, encoded });
    replacementMonths.set(pairMonth, reference);
  }

  let monthReferences = [...(previous?.months ?? [])];
  for (const replacement of replacementMonths.values()) monthReferences = replaceReference(monthReferences, replacement);
  const derivedCoverage = coverageFromReferences(monthReferences);
  if (!sameCoverage(derivedCoverage, expectedCoverage)) throw new Error("Rebuilt closure does not match the operation coverage.");
  const state = {
    contractVersion: "1",
    kind: "pair_candle_state",
    pair,
    sequence,
    coverage: expectedCoverage,
    months: monthReferences,
  };
  const encodedState = encodePairState(state, { registry });
  return { state, encodedState, encodedDays, encodedMonths };
}

async function publishReplacement({ registry, pair, store, previous, role, range, collected, signal }) {
  const replacement = await buildReplacement({ registry, pair, store, previous, role, range, collected });
  await cleanupSelectedTransition({ registry, pairId: pair.pairId, store, state: previous });
  for (const entry of replacement.encodedDays) {
    throwIfAborted(signal);
    await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    const stored = await readPairDay({ registry, store, reference: entry.reference });
    if (!canonicalBytes(stored).equals(canonicalBytes(entry.value))) throw new Error("Published pair day does not match its replacement.");
  }
  for (const entry of replacement.encodedMonths) {
    throwIfAborted(signal);
    await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    const stored = await readPairMonth({ registry, store, reference: entry.reference });
    if (!canonicalBytes(stored).equals(canonicalBytes(entry.value))) throw new Error("Published pair month does not match its replacement.");
  }
  throwIfAborted(signal);
  await store.writeState(pair.pairId, replacement.state.sequence, replacement.encodedState.gzipBytes);
  const selectedState = await readPairState({ registry, pairId: pair.pairId, store });
  if (selectedState === null || !samePairState(selectedState, replacement.state)) {
    throw new Error("Published pair state is not the selected state.");
  }
  await cleanupSelectedTransition({ registry, pairId: pair.pairId, store, state: selectedState });
  return {
    status: "published",
    role,
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
  const fromSeconds = Math.floor(Date.parse(state?.coverage.untilTimestamp ?? pair.activation.timestamp) / 1000);
  const finalizedNumber = BigInt(finalized.number);
  if (finalizedNumber < fromBlock) return null;
  const finalizedBoundarySeconds = minuteFloor(blockTimestamp(finalized), registry.collection.candleSeconds);
  if (finalizedBoundarySeconds <= fromSeconds) return null;
  const searchHigh = minimum(fromBlock + BigInt(registry.collection.maximumBlocksPerRun), finalizedNumber);
  const searchHighHeader = searchHigh === finalizedNumber ? finalized : await rpc.getBlock(searchHigh);
  const untilSeconds = minimum(
    minuteFloor(blockTimestamp(searchHighHeader), registry.collection.candleSeconds),
    finalizedBoundarySeconds,
  );
  if (untilSeconds <= fromSeconds) return null;
  const untilBlock = await rpc.findFirstBlockAtOrAfterTimestamp(
    untilSeconds,
    fromBlock,
    searchHigh,
    { maximumBlockHeader: searchHighHeader },
  );
  if (untilBlock < fromBlock || untilBlock > searchHigh) throw new Error("Current boundary is outside its fixed block range.");
  return {
    fromBlock: fromBlock.toString(),
    fromTimestamp: instant(fromSeconds),
    untilBlock: untilBlock.toString(),
    untilTimestamp: instant(untilSeconds),
  };
}

async function historyRange({ registry, pair, rpc, state }) {
  const fromBlock = BigInt(state?.coverage.fromBlock ?? pair.activation.blockNumber);
  const fromTimestamp = state?.coverage.fromTimestamp ?? pair.activation.timestamp;
  const historyBlock = BigInt(pair.historyStart.blockNumber);
  if (fromBlock === historyBlock && fromTimestamp === pair.historyStart.timestamp) return null;
  if (fromBlock < historyBlock || fromTimestamp < pair.historyStart.timestamp) throw new Error("Selected history edge is outside the pair boundary.");
  const nominalBlock = maximum(fromBlock - BigInt(registry.collection.maximumBlocksPerRun), historyBlock);
  let nextFromBlock;
  let nextFromTimestamp;
  if (nominalBlock === historyBlock) {
    nextFromBlock = historyBlock;
    nextFromTimestamp = pair.historyStart.timestamp;
  } else {
    const nominalHeader = await rpc.getBlock(nominalBlock);
    const nominalSeconds = minuteFloor(blockTimestamp(nominalHeader), registry.collection.candleSeconds);
    const historySeconds = Math.floor(Date.parse(pair.historyStart.timestamp) / 1000);
    const boundarySeconds = Math.max(nominalSeconds, historySeconds);
    nextFromBlock = await rpc.findFirstBlockAtOrAfterTimestamp(
      boundarySeconds,
      historyBlock,
      nominalBlock,
      { maximumBlockHeader: nominalHeader },
    );
    nextFromTimestamp = instant(boundarySeconds);
  }
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
  const earliestSeconds = Math.floor(Date.parse(state.coverage.fromTimestamp) / 1000);
  const untilSeconds = Math.floor(Date.parse(state.coverage.untilTimestamp) / 1000);
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
    fromTimestamp: instant(targetSeconds),
    untilBlock: exclusiveBlock.toString(),
    untilTimestamp: state.coverage.untilTimestamp,
  };
}

async function collectAndPublish({ registry, pair, store, rpc, previous, role, range, signal }) {
  const collected = await collectFixedRange({ registry, pair, rpc, range, signal });
  return publishReplacement({ registry, pair, store, previous, role, range, collected, signal });
}

export async function collectPairCurrent({ registry, pairId, store, rpc, signal }) {
  throwIfAborted(signal);
  const pair = pairById(registry, pairId).pair;
  await rpc.verifyChain(registry.chain.numericChainId);
  await verifyActivationBoundary(pair, rpc);
  const previous = await readPairState({ registry, pairId, store });
  const finalized = await rpc.getBlock(registry.chain.finalityTag);
  assertFinalizedCoversStoredRange(previous, pair, finalized);
  const range = await currentRange({ registry, pair, rpc, state: previous, finalized });
  if (range === null) {
    await cleanupSelectedTransition({ registry, pairId, store, state: previous });
    return { status: "current", role: "current", pairId, sequence: previous?.sequence ?? null };
  }
  return collectAndPublish({ registry, pair, store, rpc, previous, role: "current", range, signal });
}

export async function collectPairHistory({ registry, pairId, store, rpc, signal }) {
  throwIfAborted(signal);
  const pair = pairById(registry, pairId).pair;
  await rpc.verifyChain(registry.chain.numericChainId);
  await verifyActivationBoundary(pair, rpc);
  const previous = await readPairState({ registry, pairId, store });
  const finalized = await rpc.getBlock(registry.chain.finalityTag);
  assertFinalizedCoversStoredRange(previous, pair, finalized);
  const range = await historyRange({ registry, pair, rpc, state: previous });
  if (range === null) {
    await cleanupSelectedTransition({ registry, pairId, store, state: previous });
    return { status: "current", role: "history", pairId, sequence: previous?.sequence ?? null };
  }
  return collectAndPublish({ registry, pair, store, rpc, previous, role: "history", range, signal });
}

export async function repairPairIndex({ registry, pairId, store, rpc, signal }) {
  throwIfAborted(signal);
  const pair = pairById(registry, pairId).pair;
  await rpc.verifyChain(registry.chain.numericChainId);
  await verifyActivationBoundary(pair, rpc);
  const previous = await readPairState({ registry, pairId, store });
  if (previous === null) return { status: "empty", role: "repair", pairId, sequence: null };
  const finalized = await rpc.getBlock(registry.chain.finalityTag);
  assertFinalizedCoversStoredRange(previous, pair, finalized);
  const range = await repairRange({ registry, rpc, state: previous });
  if (range === null) {
    await cleanupSelectedTransition({ registry, pairId, store, state: previous });
    return { status: "current", role: "repair", pairId, sequence: previous.sequence };
  }
  return collectAndPublish({ registry, pair, store, rpc, previous, role: "repair", range, signal });
}
