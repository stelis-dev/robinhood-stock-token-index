import assert from "node:assert/strict";
import test from "node:test";
import { decodeSwapLog } from "../collector/swap.mjs";
import { compactPairRegistry, pairSwapLog } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";

test("Swap decoding separates event validity from the ability to calculate a trade price", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "ETH").pair;
  const block = {
    number: `0x${BigInt(pair.activation.blockNumber).toString(16)}`,
    timestamp: `0x${BigInt(Math.floor(Date.parse(pair.activation.timestamp) / 1000)).toString(16)}`,
    hash: pair.activation.hash,
  };
  const log = (amount0, amount1) => pairSwapLog({ registry, pair, block, amount0, amount1 });

  const oneZero = decodeSwapLog(log(0n, -1n), { registry, pair, block });
  assert.equal(oneZero.blockTimestamp, Math.floor(Date.parse(pair.activation.timestamp) / 1000));
  assert.equal(oneZero.pairId, pair.pairId);
  assert.equal(oneZero.swapPosition.blockNumber, pair.activation.blockNumber);
  assert.equal(oneZero.trade, null);
  assert.equal(decodeSwapLog(log(0n, 0n), { registry, pair, block }).trade, null);
  assert.throws(
    () => decodeSwapLog(log(1n, 1n), { registry, pair, block }),
    /Non-zero Swap amounts must have opposite signs/,
  );

  const invalidPrice = log(0n, -1n);
  const words = invalidPrice.data.slice(2).match(/.{64}/g);
  words[2] = "0".repeat(64);
  invalidPrice.data = `0x${words.join("")}`;
  assert.throws(
    () => decodeSwapLog(invalidPrice, { registry, pair, block }),
    /Swap price or fee is invalid/,
  );
});
