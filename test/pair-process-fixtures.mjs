import { admitPairRegistry } from "../collector/pair-registry.mjs";
import { fixturePairRegistry, pairEntryBySymbol } from "./pair-fixtures.mjs";

function hex(value, bytes = 32) {
  return BigInt(value).toString(16).padStart(bytes * 2, "0");
}

function signedWord(value, bits) {
  const candidate = BigInt(value);
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  if (candidate < minimum || candidate > maximum) throw new Error("Fixture signed value is out of range.");
  return hex(candidate < 0n ? (1n << 256n) + candidate : candidate);
}

function unsignedWord(value) {
  return hex(value);
}

export function pairBlock(number, timestamp) {
  return {
    number: `0x${BigInt(number).toString(16)}`,
    timestamp: `0x${BigInt(timestamp).toString(16)}`,
    hash: `0x${hex(BigInt(number) + 1n)}`,
  };
}

export async function compactPairRegistry({
  activationTimestamp,
  maximumBlocksPerRun = 360,
} = {}) {
  const registry = structuredClone(await fixturePairRegistry());
  registry.collection.logRangeBlocks = 100;
  registry.collection.maximumBlocksPerRun = maximumBlocksPerRun;
  for (const entry of registry.pairs) {
    const blockNumber = BigInt(entry.pair.activation.blockNumber);
    const blockSeconds = Math.floor(Date.parse(entry.pair.activation.timestamp) / 1000);
    entry.pair.activation.hash = pairBlock(blockNumber, blockSeconds).hash;
  }
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  if (activationTimestamp !== undefined) pair.activation.timestamp = activationTimestamp;
  const activationBlock = BigInt(pair.activation.blockNumber);
  const activationSeconds = Math.floor(Date.parse(pair.activation.timestamp) / 1000);
  pair.activation.hash = pairBlock(activationBlock, activationSeconds).hash;
  pair.sourceInitialization = {
    blockNumber: (activationBlock - 720n).toString(),
    timestamp: new Date((activationSeconds - 7_200) * 1000).toISOString(),
  };
  pair.historyStart = {
    blockNumber: pair.sourceInitialization.blockNumber,
    timestamp: pair.sourceInitialization.timestamp,
  };
  return admitPairRegistry(registry);
}

export function pairSwapLog({ registry, pair, block, baseAmountRaw, quoteAmountRaw, transactionIndex = 0, logIndex = 0 }) {
  const base = BigInt(baseAmountRaw);
  const quote = BigInt(quoteAmountRaw);
  const amount0 = pair.baseIsCurrency0 ? -base : quote;
  const amount1 = pair.baseIsCurrency0 ? quote : -base;
  return {
    address: registry.deployment.poolManager,
    blockHash: block.hash,
    blockNumber: block.number,
    data: `0x${[
      signedWord(amount0, 128),
      signedWord(amount1, 128),
      unsignedWord(1n << 96n),
      unsignedWord(1_000_000n),
      signedWord(0n, 24),
      unsignedWord(3_000n),
    ].join("")}`,
    logIndex: `0x${BigInt(logIndex).toString(16)}`,
    removed: false,
    topics: [
      registry.deployment.swapTopic,
      pair.pairId,
      `0x${"0".repeat(24)}${"1".repeat(40)}`,
    ],
    transactionHash: `0x${hex(BigInt(block.number) * 100n + BigInt(transactionIndex) + 1n)}`,
    transactionIndex: `0x${BigInt(transactionIndex).toString(16)}`,
  };
}

export class FakePairRpc {
  constructor({ registry, pair, finalizedNumber, logs = [], secondsPerBlock = 10 }) {
    this.registry = registry;
    this.pair = pair;
    this.finalizedNumber = BigInt(finalizedNumber);
    this.logs = logs;
    this.secondsPerBlock = secondsPerBlock;
    this.activationBlock = BigInt(pair.activation.blockNumber);
    this.activationSeconds = Math.floor(Date.parse(pair.activation.timestamp) / 1000);
    this.logRequests = [];
    this.blockSearches = [];
  }

  block(number) {
    const candidate = BigInt(number);
    return pairBlock(
      candidate,
      this.activationSeconds + Number(candidate - this.activationBlock) * this.secondsPerBlock,
    );
  }

  async verifyChain(numericChainId) {
    if (numericChainId !== this.registry.chain.numericChainId) throw new Error("Fixture chain mismatch.");
  }

  async getBlock(selector) {
    const number = selector === "finalized" ? this.finalizedNumber : BigInt(selector);
    if (number > this.finalizedNumber) throw new Error("Fixture block is beyond finalized coverage.");
    return this.block(number);
  }

  async getBlockHeaders(numbers) {
    const output = new Map();
    for (const number of new Set(numbers.map((entry) => BigInt(entry).toString()))) {
      if (BigInt(number) > this.finalizedNumber) throw new Error("Fixture header is beyond finalized coverage.");
      output.set(number, this.block(number));
    }
    return output;
  }

  async getLogs({ address, poolIds, swapTopic, fromBlock, toBlock }) {
    if (address !== this.pair.poolManager || swapTopic !== this.pair.swapTopic || JSON.stringify(poolIds) !== JSON.stringify([this.pair.pairId])) {
      throw new Error("Fixture pair filter mismatch.");
    }
    const from = BigInt(fromBlock);
    const to = BigInt(toBlock);
    this.logRequests.push({ from, to });
    return this.logs.filter((entry) => {
      const number = BigInt(entry.blockNumber);
      return number >= from && number <= to && entry.topics[1] === this.pair.pairId;
    });
  }

  async findFirstBlockAtOrAfterTimestamp(timestamp, minimumBlock, maximumBlock, options = {}) {
    const target = BigInt(timestamp);
    let low = BigInt(minimumBlock);
    let high = BigInt(maximumBlock);
    if (low > high) throw new Error("Fixture block search bounds are invalid.");
    if (options.maximumBlockHeader && BigInt(options.maximumBlockHeader.number) !== high) {
      throw new Error("Fixture block search header does not match its upper bound.");
    }
    this.blockSearches.push({ timestamp: target, minimumBlock: low, maximumBlock: high });
    if (BigInt(this.block(high).timestamp) < target) return high + 1n;
    while (low < high) {
      const middle = (low + high) >> 1n;
      if (BigInt(this.block(middle).timestamp) < target) low = middle + 1n;
      else high = middle;
    }
    return low;
  }
}
