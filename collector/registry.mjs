import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { admitRpcUrl, maximumRpcBatchSize } from "./rpc-endpoint.mjs";

const addressPattern = /^0x[0-9a-f]{40}$/;
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
const symbolPattern = /^[A-Z][A-Z0-9.]{0,15}$/;
const groupIdPattern = /^group-([0-9]{2})$/;
const maximumGroups = 32;
const maximumAssetsPerGroup = 8;
const registryUrl = new URL("../registry/groups.json", import.meta.url);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function abiWord(value, bytes) {
  const hex = typeof value === "bigint" ? value.toString(16) : value.slice(2);
  if (hex.length > bytes * 2) throw new Error("ABI value exceeds its type width.");
  return hex.padStart(64, "0");
}

export function derivePoolId({ currency0, currency1, fee, tickSpacing, hooks }) {
  const encoded = [
    abiWord(currency0, 20),
    abiWord(currency1, 20),
    abiWord(BigInt(fee), 3),
    abiWord(BigInt(tickSpacing), 3),
    abiWord(hooks, 20),
  ].join("");
  return `0x${Buffer.from(keccak_256(Buffer.from(encoded, "hex"))).toString("hex")}`;
}

export function admitRegistry(candidate) {
  exactKeys(candidate, ["chain", "collection", "deployment", "groups"], "registry");

  exactKeys(candidate.chain, ["chainId", "finalityTag", "numericChainId", "primaryRpcUrl"], "chain");
  if (candidate.chain.chainId !== "eip155:4663" || candidate.chain.numericChainId !== 4663) {
    throw new Error("Unexpected chain identity.");
  }
  if (candidate.chain.finalityTag !== "finalized") throw new Error("The cursor must use finalized blocks.");
  admitRpcUrl(candidate.chain.primaryRpcUrl, "Primary RPC URL");

  exactKeys(candidate.deployment, ["fee", "hooks", "poolManager", "quoteToken", "stateView", "swapTopic", "tickSpacing"], "deployment");
  for (const [key, value] of [["poolManager", candidate.deployment.poolManager], ["stateView", candidate.deployment.stateView], ["hooks", candidate.deployment.hooks]]) {
    if (!addressPattern.test(value)) throw new Error(`Invalid ${key}.`);
  }
  if (!bytes32Pattern.test(candidate.deployment.swapTopic)) throw new Error("Invalid Swap topic.");
  if (candidate.deployment.fee !== 3000 || candidate.deployment.tickSpacing !== 60) {
    throw new Error("Unexpected PoolKey parameters.");
  }
  exactKeys(candidate.deployment.quoteToken, ["address", "decimals", "symbol"], "quoteToken");
  if (!addressPattern.test(candidate.deployment.quoteToken.address) || candidate.deployment.quoteToken.decimals !== 6 || candidate.deployment.quoteToken.symbol !== "USDG") {
    throw new Error("Unexpected quote token.");
  }

  const collectionKeys = ["candleSeconds", "headerBatchSize", "initialLookbackSeconds", "logRangeBlocks", "maximumArtifactBytes", "maximumBlocksPerRun", "maximumResponseBytes", "maximumRpcAttempts", "maximumRpcRetryDelayMilliseconds", "repairLookbackSeconds", "requestDelayMilliseconds", "requestTimeoutMilliseconds", "retentionDays", "scheduleMinutes"];
  exactKeys(candidate.collection, collectionKeys, "collection");
  for (const key of collectionKeys.filter((key) => key !== "scheduleMinutes")) positiveInteger(candidate.collection[key], `collection.${key}`);
  if (candidate.collection.candleSeconds !== 60 || candidate.collection.retentionDays !== 365) throw new Error("Unexpected candle or retention boundary.");
  if (candidate.collection.headerBatchSize > maximumRpcBatchSize) throw new Error("Header batch size exceeds the RPC batch boundary.");
  if (candidate.collection.maximumArtifactBytes > 16_777_216) throw new Error("Artifact byte limit exceeds the admitted boundary.");
  if (candidate.collection.maximumRpcAttempts > 10 || candidate.collection.maximumRpcRetryDelayMilliseconds > 300_000) throw new Error("RPC retry boundary exceeds the admitted limit.");
  if (JSON.stringify(candidate.collection.scheduleMinutes) !== "[7,22,37,52]") throw new Error("Unexpected schedule minutes.");

  if (!Array.isArray(candidate.groups) || candidate.groups.length === 0 || candidate.groups.length > maximumGroups) throw new Error("Registry group count is invalid.");
  const identities = new Set();
  for (let groupIndex = 0; groupIndex < candidate.groups.length; groupIndex += 1) {
    const group = candidate.groups[groupIndex];
    exactKeys(group, ["assets", "groupId"], "group");
    const groupIdentity = group.groupId.match(groupIdPattern);
    if (!groupIdentity || Number(groupIdentity[1]) !== groupIndex + 1 || !Array.isArray(group.assets) || group.assets.length === 0 || group.assets.length > maximumAssetsPerGroup) throw new Error("Registry group identity or asset count is invalid.");
    const sorted = [...group.assets].sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (JSON.stringify(sorted.map((a) => a.symbol)) !== JSON.stringify(group.assets.map((a) => a.symbol))) throw new Error("Assets must be ordered by symbol.");
    for (const asset of group.assets) {
      exactKeys(asset, ["currency0", "currency1", "name", "poolId", "stockTokenIsCurrency0", "symbol", "token", "tokenDecimals"], `asset ${asset.symbol}`);
      if (!symbolPattern.test(asset.symbol) || typeof asset.name !== "string" || asset.name.length === 0 || asset.name.length > 128) throw new Error("Invalid asset label.");
      for (const value of [asset.token, asset.currency0, asset.currency1]) if (!addressPattern.test(value)) throw new Error(`Invalid address for ${asset.symbol}.`);
      if (!bytes32Pattern.test(asset.poolId) || asset.tokenDecimals !== 18 || typeof asset.stockTokenIsCurrency0 !== "boolean") throw new Error(`Invalid pool for ${asset.symbol}.`);
      if (BigInt(asset.currency0) >= BigInt(asset.currency1)) throw new Error(`Currencies are not ordered for ${asset.symbol}.`);
      const expectedToken = asset.stockTokenIsCurrency0 ? asset.currency0 : asset.currency1;
      const expectedQuote = asset.stockTokenIsCurrency0 ? asset.currency1 : asset.currency0;
      if (expectedToken !== asset.token || expectedQuote !== candidate.deployment.quoteToken.address) throw new Error(`Pool currencies do not match ${asset.symbol}.`);
      const derivedPoolId = derivePoolId({
        currency0: asset.currency0,
        currency1: asset.currency1,
        fee: candidate.deployment.fee,
        tickSpacing: candidate.deployment.tickSpacing,
        hooks: candidate.deployment.hooks,
      });
      if (derivedPoolId !== asset.poolId) throw new Error(`Pool ID does not derive from the PoolKey for ${asset.symbol}.`);
      for (const identity of [asset.symbol, asset.token, asset.poolId]) {
        if (identities.has(identity)) throw new Error(`Duplicate asset identity: ${identity}`);
        identities.add(identity);
      }
    }
  }
  return candidate;
}

export async function loadRegistry(path = fileURLToPath(registryUrl)) {
  return admitRegistry(JSON.parse(await readFile(path, "utf8")));
}

export function groupById(registry, groupId) {
  const group = registry.groups.find((entry) => entry.groupId === groupId);
  if (!group) throw new Error(`Unknown group: ${groupId}`);
  return group;
}
