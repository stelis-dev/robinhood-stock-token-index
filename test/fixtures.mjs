import { loadRegistry } from "../collector/registry.mjs";

function hex(value, bytes = 32) {
  return BigInt(value).toString(16).padStart(bytes * 2, "0");
}

function signedWord(value, bits) {
  const candidate = BigInt(value);
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  if (candidate < minimum || candidate > maximum) throw new Error("Fixture signed value is out of range.");
  const encoded = candidate < 0n ? (1n << 256n) + candidate : candidate;
  return hex(encoded);
}

function unsignedWord(value) {
  return hex(value);
}

export function block(number, timestamp) {
  return {
    number: `0x${BigInt(number).toString(16)}`,
    timestamp: `0x${BigInt(timestamp).toString(16)}`,
    hash: `0x${hex(BigInt(number) + 1n)}`,
  };
}

export function swapLog({ registry, asset, block: sourceBlock, transactionIndex = 0, logIndex = 0, amount0, amount1, sqrtPriceX96 = 1n << 96n, liquidity = 1_000_000n, tick = 0n, fee = 3000n }) {
  return {
    address: registry.deployment.poolManager,
    blockHash: sourceBlock.hash,
    blockNumber: sourceBlock.number,
    data: `0x${[
      signedWord(amount0, 128),
      signedWord(amount1, 128),
      unsignedWord(sqrtPriceX96),
      unsignedWord(liquidity),
      signedWord(tick, 24),
      unsignedWord(fee),
    ].join("")}`,
    logIndex: `0x${BigInt(logIndex).toString(16)}`,
    removed: false,
    topics: [
      registry.deployment.swapTopic,
      asset.poolId,
      `0x${"0".repeat(24)}${"1".repeat(40)}`,
    ],
    transactionHash: `0x${hex(BigInt(sourceBlock.number) * 100n + BigInt(transactionIndex) + 1n)}`,
    transactionIndex: `0x${BigInt(transactionIndex).toString(16)}`,
  };
}

export class FakeRpc {
  constructor({ registry, blocks, logs, finalizedNumber }) {
    this.registry = registry;
    this.blocks = new Map(blocks.map((entry) => [BigInt(entry.number).toString(), entry]));
    this.logs = logs;
    this.finalizedNumber = BigInt(finalizedNumber);
    this.logRequests = [];
  }

  async verifyChain(numericChainId) {
    if (numericChainId !== this.registry.chain.numericChainId) throw new Error("Fixture chain mismatch.");
  }

  async getBlock(selector) {
    const number = selector === "finalized" ? this.finalizedNumber : BigInt(selector);
    const value = this.blocks.get(number.toString());
    if (!value) throw new Error(`Fixture block is missing: ${number}`);
    return value;
  }

  async getBlockHeaders(numbers) {
    const output = new Map();
    for (const number of new Set(numbers.map((entry) => BigInt(entry).toString()))) {
      const value = this.blocks.get(number);
      if (!value) throw new Error(`Fixture block is missing: ${number}`);
      output.set(number, value);
    }
    return output;
  }

  async getLogs({ address, poolIds, swapTopic, fromBlock, toBlock }) {
    if (address !== this.registry.deployment.poolManager || swapTopic !== this.registry.deployment.swapTopic) throw new Error("Fixture filter mismatch.");
    const admittedPools = new Set(poolIds);
    const from = BigInt(fromBlock);
    const to = BigInt(toBlock);
    this.logRequests.push({ from, to });
    return this.logs.filter((entry) => {
      const number = BigInt(entry.blockNumber);
      return number >= from && number <= to && admittedPools.has(entry.topics[1]);
    });
  }

  async findFirstBlockAtOrAfterTimestamp(timestamp, minimumBlock, maximumBlock) {
    const target = BigInt(timestamp);
    for (let number = BigInt(minimumBlock); number <= BigInt(maximumBlock); number += 1n) {
      const value = this.blocks.get(number.toString());
      if (!value) throw new Error(`Fixture block is missing: ${number}`);
      if (BigInt(value.timestamp) >= target) return number;
    }
    return BigInt(maximumBlock) + 1n;
  }
}

export async function fixtureRegistry() {
  return loadRegistry();
}
