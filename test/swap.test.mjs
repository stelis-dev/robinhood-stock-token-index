import assert from "node:assert/strict";
import test from "node:test";
import { decodeSwapLog } from "../collector/swap.mjs";
import { compactPairRegistry, pairBlock, pairSwapLog } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";

test("Swap decoding separates event validity from the ability to calculate a trade price", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "ETH").pair;
  const block = pairBlock(
    pair.activation.blockNumber,
    Math.floor(Date.parse(pair.activation.timestamp) / 1000),
  );
  const log = (amount0, amount1) => pairSwapLog({ registry, pair, block, amount0, amount1 });
  const source = {
    baseDecimals: pair.baseAsset.decimals,
    baseIsCurrency0: pair.baseIsCurrency0,
    poolId: pair.pairId,
    poolManager: pair.poolManager,
    quoteDecimals: pair.quoteAsset.decimals,
    swapTopic: pair.swapTopic,
  };

  const oneZero = decodeSwapLog(log(0n, -1n), source);
  assert.equal(oneZero.blockNumber, BigInt(pair.activation.blockNumber));
  assert.equal(oneZero.blockHash, pair.activation.hash);
  assert.equal(oneZero.poolId, pair.pairId);
  assert.equal(oneZero.swapPosition.blockNumber, pair.activation.blockNumber);
  assert.equal(oneZero.trade, null);
  assert.equal(decodeSwapLog(log(0n, 0n), source).trade, null);
  assert.throws(
    () => decodeSwapLog(log(1n, 1n), source),
    /Non-zero Swap amounts must have opposite signs/,
  );

  const invalidPrice = log(0n, -1n);
  const words = invalidPrice.data.slice(2).match(/.{64}/g);
  words[2] = "0".repeat(64);
  invalidPrice.data = `0x${words.join("")}`;
  assert.throws(
    () => decodeSwapLog(invalidPrice, source),
    /Swap price or fee is invalid/,
  );

  for (const [mutate, expected] of [
    [(candidate) => { candidate.topics[2] = [candidate.topics[2]]; }, /sender topic/],
    [(candidate) => { candidate.transactionHash = [candidate.transactionHash]; }, /source hash/],
    [(candidate) => { candidate.data = [candidate.data]; }, /six ABI words/],
  ]) {
    const invalidData = log(-1n, 1n);
    mutate(invalidData);
    assert.throws(() => decodeSwapLog(invalidData, source), expected);
  }
});
