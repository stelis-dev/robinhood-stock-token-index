import assert from "node:assert/strict";
import test from "node:test";

import { loadMarketDataConfiguration } from "../collector/market-data-configuration.mjs";
import { decodeSwapLog } from "../collector/swap.mjs";
import { marketDataSwapLog } from "./market-data-fixtures.mjs";

test("Swap admission separates event validity from executable price", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases.find((candidate) => candidate.baseCurrencyAddress === `0x${"0".repeat(40)}`);
  const blockNumber = 50_000_000n;
  const log = (amount0, amount1) => marketDataSwapLog({
    amount0,
    amount1,
    base,
    blockNumber,
    configuration,
  });
  const source = {
    baseDecimals: base.decimals,
    baseIsCurrency0: base.baseIsCurrency0,
    poolId: base.poolId,
    poolManager: configuration.poolManager,
    quoteDecimals: configuration.usdgDecimals,
    swapTopic: configuration.swapTopic,
  };

  const oneZero = decodeSwapLog(log(0n, -1n), source);
  assert.equal(oneZero.blockNumber, blockNumber);
  assert.equal(oneZero.poolId, base.poolId);
  assert.equal(oneZero.trade, null);
  assert.equal(decodeSwapLog(log(0n, 0n), source).trade, null);
  assert.throws(() => decodeSwapLog(log(1n, 1n), source), /opposite signs/);

  for (const mutate of [
    (candidate) => { candidate.topics[2] = [candidate.topics[2]]; },
    (candidate) => { candidate.transactionHash = [candidate.transactionHash]; },
    (candidate) => { candidate.data = [candidate.data]; },
  ]) {
    const malformed = log(-1n, 1n);
    mutate(malformed);
    assert.throws(() => decodeSwapLog(malformed, source));
  }
});
