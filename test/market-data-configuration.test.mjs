import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeMarketDataConfiguration,
  loadMarketDataConfiguration,
  marketDataPoolManagerAddress,
  marketDataUsdgAddress,
  marketDataUsdgDecimals,
  nativeEthAddress,
} from "../collector/market-data-configuration.mjs";

function encoded(value) {
  const sort = (candidate) => candidate !== null && typeof candidate === "object"
    ? Array.isArray(candidate)
      ? candidate.map(sort)
      : Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, sort(candidate[key])]))
    : candidate;
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`, "utf8");
}

test("the human-authored market-data configuration admits the exact base/USDG pools", async () => {
  const admitted = await loadMarketDataConfiguration();
  assert.equal(admitted.configuration.bases.length, 9);
  assert.equal(admitted.configuration.poolIds.length, 9);
  assert.equal(admitted.configuration.bases[0].baseCurrencyAddress, nativeEthAddress);
  assert.equal(admitted.configuration.bases[0].decimals, 18);
  assert.equal(admitted.configuration.poolManager, marketDataPoolManagerAddress);
  assert.equal(admitted.configuration.usdgDecimals, marketDataUsdgDecimals);
  for (const base of admitted.configuration.bases) {
    assert.ok(
      base.poolKey.currency0 === base.baseCurrencyAddress
        && base.poolKey.currency1 === marketDataUsdgAddress
      || base.poolKey.currency1 === base.baseCurrencyAddress
        && base.poolKey.currency0 === marketDataUsdgAddress,
    );
  }
  assert.ok(Object.isFrozen(admitted.configuration));
  assert.ok(Object.isFrozen(admitted.configuration.bases));
  assert.equal(admitted.sha256.length, 64);
});

test("configuration admission binds the fixed PoolManager and USDG decimals", async () => {
  const admitted = await loadMarketDataConfiguration();
  const wrongPoolManager = structuredClone(admitted.value);
  wrongPoolManager.poolManager = "0x0000000000000000000000000000000000000001";
  assert.throws(
    () => decodeMarketDataConfiguration(encoded(wrongPoolManager)),
    /does not equal the fixed PoolManager/,
  );

  const wrongUsdgDecimals = structuredClone(admitted.value);
  wrongUsdgDecimals.usdgDecimals = 255;
  assert.throws(
    () => decodeMarketDataConfiguration(encoded(wrongUsdgDecimals)),
    /do not equal the fixed USDG decimals/,
  );
});

test("configuration admission rejects non-canonical bytes and a PoolKey outside base/USDG", async () => {
  const admitted = await loadMarketDataConfiguration();
  const nonCanonical = Buffer.from(JSON.stringify(admitted.value), "utf8");
  assert.throws(() => decodeMarketDataConfiguration(nonCanonical), /encoding is not canonical/);
  assert.throws(
    () => decodeMarketDataConfiguration(Buffer.from([0xff])),
    /fatal UTF-8 JSON/,
  );

  const invalid = structuredClone(admitted.value);
  const [baseCurrencyAddress] = Object.keys(invalid.baseCurrencies).filter((address) => address !== nativeEthAddress);
  invalid.baseCurrencies[baseCurrencyAddress].poolKey.currency0 = nativeEthAddress;
  assert.throws(
    () => decodeMarketDataConfiguration(encoded(invalid)),
    /PoolKey or PoolId is invalid/,
  );
});

test("display-only symbol text does not select configuration admission", async () => {
  const admitted = await loadMarketDataConfiguration();
  const changed = structuredClone(admitted.value);
  const [baseCurrencyAddress] = Object.keys(changed.baseCurrencies);
  changed.baseCurrencies[baseCurrencyAddress].symbol = "Native Ether / review label";
  const decoded = decodeMarketDataConfiguration(encoded(changed));
  assert.deepEqual(decoded.configuration.bases, admitted.configuration.bases);
});
