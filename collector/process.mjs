import {
  createPairReference,
  encodePairDay,
  encodePairMonth,
  encodePairState,
  pairDayLogicalId,
  pairMonthLogicalId,
} from "./pair-artifact.mjs";
import { CandleAccumulator, mergePairCandles } from "./candles.mjs";
import {
  readPairDay,
  readPairMonth,
  readPairStateSelection,
} from "./pair-reader.mjs";
import { pairById } from "./pair-registry.mjs";
import { publishPairReplacement } from "./publication.mjs";
import { RpcEndpointUnavailableError, RpcResponseRejectedError } from "./rpc-endpoint.mjs";
import { blockTimestamp } from "./rpc-client.mjs";
import { decodeSwapLog, validateSwapLogBlockNumber } from "./swap.mjs";

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

function admittedRpcLogBlockNumber(log) {
  try {
    return validateSwapLogBlockNumber(log);
  } catch (error) {
    if (error instanceof RpcResponseRejectedError) throw error;
    throw new RpcResponseRejectedError("response_result_invalid");
  }
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

function sameBlock(left, right) {
  return left.number === right.number
    && left.hash === right.hash
    && left.timestamp === right.timestamp;
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
  if (BigInt(providerFinalized.number) < BigInt(finalizedBoundary.block.number)) {
    throw new RpcEndpointUnavailableError();
  }
  const providerCopy = providerFinalized.number === finalizedBoundary.block.number
    ? providerFinalized
    : await rpc.getBlock(BigInt(finalizedBoundary.block.number));
  if (!sameBlock(providerCopy, finalizedBoundary.block)) {
    throw new RpcResponseRejectedError("finalized_boundary_mismatch");
  }
  return finalizedBoundary.block;
}

async function verifyActivationBoundary(pair, rpc) {
  const block = await rpc.getBlock(BigInt(pair.activation.blockNumber));
  if (
    BigInt(block.number) !== BigInt(pair.activation.blockNumber)
    || block.hash !== pair.activation.hash
    || instant(blockTimestamp(block)) !== pair.activation.timestamp
  ) {
    throw new RpcResponseRejectedError("activation_boundary_mismatch");
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
      const blockNumber = admittedRpcLogBlockNumber(log);
      if (blockNumber < cursor || blockNumber >= rangeUntil) {
        throw new RpcResponseRejectedError("response_result_invalid");
      }
      blockNumbers.push(blockNumber);
    }
    const headers = logs.length === 0
      ? new Map()
      : await rpc.getBlockHeaders(blockNumbers, registry.collection.headerBatchSize);
    const swaps = [];
    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index];
      const header = headers.get(blockNumbers[index].toString());
      if (!header) throw new RpcResponseRejectedError("response_result_invalid");
      const decoded = decodeSwapLog(log, { registry, pair, block: header });
      if (decoded.blockTimestamp < rangeFromSeconds || decoded.blockTimestamp >= rangeUntilSeconds) {
        throw new RpcResponseRejectedError("response_result_invalid");
      }
      swaps.push(decoded);
    }
    accumulator.addSwaps(swaps);
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

async function loadAffectedArtifacts({ registry, pair, store, state, partitions }) {
  const months = new Map();
  const days = new Map();
  const affectedMonths = [...new Set(partitions.map((partition) => partition.day.slice(0, 7)))].sort();
  for (const pairMonth of affectedMonths) {
    const monthReference = state?.months.find((candidate) => candidate.logicalId === pairMonthLogicalId(pair.pairId, pairMonth));
    const month = monthReference ? await readPairMonth({ registry, store, reference: monthReference }) : null;
    months.set(pairMonth, { value: month, reference: monthReference ?? null });
    for (const partition of partitions.filter((candidate) => candidate.day.startsWith(`${pairMonth}-`))) {
      const reference = month?.days.find((candidate) => candidate.logicalId === pairDayLogicalId(pair.pairId, partition.day));
      days.set(partition.day, {
        value: reference ? await readPairDay({ registry, store, reference }) : null,
        reference: reference ?? null,
      });
    }
  }
  return { months, days };
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

async function buildReplacement({ registry, pair, store, previousSelection, phase, range, collected }) {
  const previous = previousSelection?.state ?? null;
  const expectedCoverage = expectedStateCoverage(previous, pair, range, phase);
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
    const currentEntry = existing.days.get(partition.day);
    const current = currentEntry?.value ?? null;
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
    encodedDays.push({
      value: day,
      reference,
      encoded,
      previousReference: currentEntry?.reference ?? null,
    });
    replacementDays.set(partition.day, reference);
  }

  const encodedMonths = [];
  const replacementMonths = new Map();
  for (const pairMonth of [...new Set(collected.partitions.map((partition) => partition.day.slice(0, 7)))].sort()) {
    const currentEntry = existing.months.get(pairMonth);
    let references = [...(currentEntry?.value?.days ?? [])];
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
    encodedMonths.push({
      value: month,
      reference,
      encoded,
      previousReference: currentEntry?.reference ?? null,
      previousValue: currentEntry?.value ?? null,
    });
    replacementMonths.set(pairMonth, reference);
  }

  let monthReferences = [...(previous?.months ?? [])];
  for (const replacement of replacementMonths.values()) monthReferences = replaceReference(monthReferences, replacement);
  const derivedCoverage = coverageFromReferences(monthReferences);
  if (!sameCoverage(derivedCoverage, expectedCoverage)) throw new Error("Rebuilt pair state does not match the operation coverage.");
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
  const fromSeconds = Math.floor(Date.parse(state?.coverage.untilTimestamp ?? pair.activation.timestamp) / 1000);
  const finalizedNumber = BigInt(finalized.number);
  if (finalizedNumber < fromBlock) return { range: null, reachedFinalizedBoundary: true };
  const finalizedBoundarySeconds = minuteFloor(blockTimestamp(finalized), registry.collection.candleSeconds);
  if (finalizedBoundarySeconds <= fromSeconds) return { range: null, reachedFinalizedBoundary: true };
  const searchHigh = minimum(fromBlock + BigInt(registry.collection.maximumBlocksPerRun), finalizedNumber);
  const searchHighHeader = searchHigh === finalizedNumber ? finalized : await rpc.getBlock(searchHigh);
  const nextDaySeconds = Math.floor(fromSeconds / 86_400) * 86_400 + 86_400;
  const untilSeconds = minimum(
    minuteFloor(blockTimestamp(searchHighHeader), registry.collection.candleSeconds),
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
      fromTimestamp: instant(fromSeconds),
      untilBlock: untilBlock.toString(),
      untilTimestamp: instant(untilSeconds),
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
  const nominalSeconds = minuteFloor(blockTimestamp(nominalHeader), registry.collection.candleSeconds);
  const historySeconds = Math.floor(Date.parse(pair.historyStart.timestamp) / 1000);
  const fromSeconds = Math.floor(Date.parse(fromTimestamp) / 1000);
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
  const nextFromTimestamp = instant(boundarySeconds);
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
