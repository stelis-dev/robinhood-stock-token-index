import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPairReference,
  encodePairDay,
  encodePairMonth,
  encodePairState,
} from "../collector/pair-artifact.mjs";
import { readPairPeriod, readPairState, verifyPairIndex } from "../collector/pair-reader.mjs";
import { admitCleanupPlan } from "../storage/carriage.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { GitHubReleaseStore } from "../storage/github-release-store.mjs";
import { fixturePairRegistry, pairCandle, pairEntryBySymbol } from "./pair-fixtures.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

class FakeGitHub {
  constructor() {
    this.releases = new Map();
    this.nextReleaseId = 1;
    this.nextAssetId = 1;
    this.requests = [];
    this.failStateUpload = false;
  }

  #releaseById(id) {
    return [...this.releases.values()].find((release) => release.id === Number(id));
  }

  #assetById(id) {
    for (const release of this.releases.values()) {
      for (const asset of release.assets.values()) if (asset.id === Number(id)) return asset;
    }
    return null;
  }

  fetch = async (target, init = {}) => {
    const url = new URL(target);
    const method = init.method ?? "GET";
    const requestHeaders = new Headers(init.headers);
    this.requests.push({ method, target, authorization: requestHeaders.get("authorization") });
    const tagMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/tags\/(.+)$/);
    if (method === "GET" && tagMatch) {
      const tag = decodeURIComponent(tagMatch[1]);
      const release = this.releases.get(tag);
      return release ? jsonResponse({ id: release.id, tag_name: tag }) : jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "POST" && url.pathname === "/repos/owner/index/releases") {
      const request = JSON.parse(Buffer.from(init.body).toString("utf8"));
      const release = { id: this.nextReleaseId++, tag: request.tag_name, assets: new Map() };
      this.releases.set(release.tag, release);
      return jsonResponse({ id: release.id, tag_name: release.tag }, 201);
    }
    const assetListMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/([0-9]+)\/assets$/);
    if (method === "GET" && assetListMatch) {
      const release = this.#releaseById(assetListMatch[1]);
      if (!release) return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse([...release.assets.values()].map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.bytes.byteLength,
      })));
    }
    if (method === "POST" && assetListMatch && url.hostname === "uploads.github.com") {
      const release = this.#releaseById(assetListMatch[1]);
      const name = url.searchParams.get("name");
      if (!release || !name) return jsonResponse({ message: "Not Found" }, 404);
      if (this.failStateUpload && name.startsWith("state-g")) return jsonResponse({ message: "failure" }, 500);
      const bytes = Buffer.from(init.body);
      const asset = { id: this.nextAssetId++, name, bytes };
      release.assets.set(name, asset);
      return jsonResponse({ id: asset.id, name, size: bytes.byteLength }, 201);
    }
    const assetMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/assets\/([0-9]+)$/);
    if (assetMatch && method === "GET") {
      const asset = this.#assetById(assetMatch[1]);
      return asset ? new Response(asset.bytes) : jsonResponse({ message: "Not Found" }, 404);
    }
    if (assetMatch && method === "DELETE") {
      for (const release of this.releases.values()) {
        for (const [name, asset] of release.assets) {
          if (asset.id === Number(assetMatch[1])) {
            release.assets.delete(name);
            return new Response(null, { status: 204 });
          }
        }
      }
      return jsonResponse({ message: "Not Found" }, 404);
    }
    const publicAssetMatch = url.pathname.match(/^\/owner\/index\/releases\/download\/([^/]+)\/(.+)$/);
    if (method === "GET" && url.hostname === "github.com" && publicAssetMatch) {
      const release = this.releases.get(decodeURIComponent(publicAssetMatch[1]));
      const asset = release?.assets.get(decodeURIComponent(publicAssetMatch[2]));
      return asset ? new Response(asset.bytes) : jsonResponse({ message: "Not Found" }, 404);
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${target}`);
  };
}

function pairClosure(registry, sequence = 1) {
  const entry = pairEntryBySymbol(registry, "NVDA");
  const pair = entry.pair;
  const context = { registry };
  const coverage = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: "36308143",
    untilTimestamp: "2026-08-14T14:03:00.000Z",
  };
  const day = {
    contractVersion: "1",
    kind: "pair_candle_day",
    pair,
    sequence,
    day: "2026-08-14",
    coverage,
    candles: [pairCandle()],
  };
  const encodedDay = encodePairDay(day, context);
  const dayReference = createPairReference({ encoded: encodedDay, context });
  const month = {
    contractVersion: "1",
    kind: "pair_candle_month",
    pair,
    sequence,
    month: "2026-08",
    coverage,
    days: [dayReference],
  };
  const encodedMonth = encodePairMonth(month, context);
  const monthReference = createPairReference({ encoded: encodedMonth, context });
  const state = {
    contractVersion: "1",
    kind: "pair_candle_state",
    pair,
    sequence,
    coverage,
    months: [monthReference],
  };
  const encodedState = encodePairState(state, context);
  return {
    state,
    encodedState,
    cleanupPlan: {
      pairId: pair.pairId,
      selectedSequence: sequence,
      changedMonths: [{ monthReference, dayReferences: [dayReference] }],
    },
    children: [
      { reference: dayReference, encoded: encodedDay },
      { reference: monthReference, encoded: encodedMonth },
    ],
  };
}

function twoDayClosure(registry) {
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const context = { registry };
  const firstCoverage = {
    fromBlock: pair.activation.blockNumber,
    fromTimestamp: pair.activation.timestamp,
    untilBlock: "36311735",
    untilTimestamp: "2026-08-15T00:00:00.000Z",
  };
  const secondCoverage = {
    fromBlock: firstCoverage.untilBlock,
    fromTimestamp: firstCoverage.untilTimestamp,
    untilBlock: "36311741",
    untilTimestamp: "2026-08-15T00:01:00.000Z",
  };
  const firstDay = {
    contractVersion: "1",
    kind: "pair_candle_day",
    pair,
    sequence: 1,
    day: "2026-08-14",
    coverage: firstCoverage,
    candles: [pairCandle()],
  };
  const secondDay = {
    contractVersion: "1",
    kind: "pair_candle_day",
    pair,
    sequence: 2,
    day: "2026-08-15",
    coverage: secondCoverage,
    candles: [],
  };
  const encodedFirstDay = encodePairDay(firstDay, context);
  const encodedSecondDay = encodePairDay(secondDay, context);
  const firstDayReference = createPairReference({ encoded: encodedFirstDay, context });
  const secondDayReference = createPairReference({ encoded: encodedSecondDay, context });
  const coverage = {
    fromBlock: firstCoverage.fromBlock,
    fromTimestamp: firstCoverage.fromTimestamp,
    untilBlock: secondCoverage.untilBlock,
    untilTimestamp: secondCoverage.untilTimestamp,
  };
  const month = {
    contractVersion: "1",
    kind: "pair_candle_month",
    pair,
    sequence: 2,
    month: "2026-08",
    coverage,
    days: [firstDayReference, secondDayReference],
  };
  const encodedMonth = encodePairMonth(month, context);
  const monthReference = createPairReference({ encoded: encodedMonth, context });
  const state = {
    contractVersion: "1",
    kind: "pair_candle_state",
    pair,
    sequence: 2,
    coverage,
    months: [monthReference],
  };
  const encodedState = encodePairState(state, context);
  return {
    state,
    encodedState,
    cleanupPlan: {
      pairId: pair.pairId,
      selectedSequence: 2,
      changedMonths: [{ monthReference, dayReferences: [firstDayReference, secondDayReference] }],
    },
    children: [
      { reference: firstDayReference, encoded: encodedFirstDay },
      { reference: secondDayReference, encoded: encodedSecondDay },
      { reference: monthReference, encoded: encodedMonth },
    ],
  };
}

async function publishClosure(store, closure) {
  for (const child of closure.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
  await store.writeState(closure.state.pair.pairId, closure.state.sequence, closure.encodedState.gzipBytes);
}

test("directory and GitHub carriage yield the same selected canonical closure", async () => {
  const registry = await fixturePairRegistry();
  const closure = pairClosure(registry);
  const maximumArtifactBytes = registry.collection.maximumArtifactBytes;
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "stock-token-pair-directory-")),
    maximumArtifactBytes,
  });
  const githubApi = new FakeGitHub();
  const github = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await publishClosure(directory, closure);
  await publishClosure(github, closure);

  const directoryVerification = await verifyPairIndex({ registry, pairId: closure.state.pair.pairId, store: directory });
  const githubVerification = await verifyPairIndex({ registry, pairId: closure.state.pair.pairId, store: github });
  assert.deepEqual(githubVerification, directoryVerification);
  assert.deepEqual(githubVerification, {
    status: "verified",
    pairId: closure.state.pair.pairId,
    sequence: 1,
    coverage: closure.state.coverage,
    monthCount: 1,
    dayCount: 1,
    candleCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(github), /test-token/);

  const replacement = pairClosure(registry, 2);
  await publishClosure(directory, replacement);
  await publishClosure(github, replacement);
  assert.equal((await readPairState({ registry, pairId: replacement.state.pair.pairId, store: directory })).sequence, 2);
  assert.equal((await readPairState({ registry, pairId: replacement.state.pair.pairId, store: github })).sequence, 2);
  const unrelatedTag = "unrelated-release";
  githubApi.releases.set(unrelatedTag, {
    id: 999,
    tag: unrelatedTag,
    assets: new Map([["keep.bin", { id: 999, name: "keep.bin", bytes: Buffer.from("keep") }]]),
  });
  githubApi.requests.length = 0;
  await directory.cleanupSelectedGeneration(replacement.cleanupPlan);
  await github.cleanupSelectedGeneration(replacement.cleanupPlan);
  assert.equal((await readdir(join(directory.root, "pairs", replacement.state.pair.pairId, "state"))).length, 1);
  assert.equal((await readdir(join(directory.root, "pairs", replacement.state.pair.pairId, "months", "2026-08"))).length, 2);
  assert.equal(githubApi.releases.get(`pair-${replacement.state.pair.pairId}-state`).assets.size, 1);
  assert.equal(githubApi.releases.get(`pair-${replacement.state.pair.pairId}-month-2026-08`).assets.size, 2);
  assert.equal(githubApi.releases.get(unrelatedTag).assets.size, 1);
  assert.ok(githubApi.requests.every((request) => !request.target.includes(unrelatedTag)));
  assert.ok(githubApi.requests.every((request) => !request.target.endsWith("/repos/owner/index/releases")));
  assert.equal((await verifyPairIndex({ registry, pairId: replacement.state.pair.pairId, store: directory })).sequence, 2);
  assert.equal((await verifyPairIndex({ registry, pairId: replacement.state.pair.pairId, store: github })).sequence, 2);
});

test("cleanup proves the selected carrier and omission cannot authorize child deletion", async () => {
  const registry = await fixturePairRegistry();
  const closure = twoDayClosure(registry);
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "stock-token-pair-cleanup-safety-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  const githubApi = new FakeGitHub();
  const github = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  for (const store of [directory, github]) await publishClosure(store, closure);

  const omittedDayPlan = structuredClone(closure.cleanupPlan);
  omittedDayPlan.changedMonths[0].dayReferences.shift();
  for (const store of [directory, github]) {
    await store.cleanupSelectedGeneration(omittedDayPlan);
    assert.equal((await verifyPairIndex({ registry, pairId: closure.state.pair.pairId, store })).status, "verified");
  }

  const unpublished = pairClosure(registry, 3);
  for (const store of [directory, github]) {
    for (const child of unpublished.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
    await assert.rejects(
      store.cleanupSelectedGeneration(unpublished.cleanupPlan),
      /Selected state carrier is unavailable/,
    );
    assert.equal((await readPairState({ registry, pairId: closure.state.pair.pairId, store })).sequence, 2);
    assert.equal((await verifyPairIndex({ registry, pairId: closure.state.pair.pairId, store })).status, "verified");
  }
});

test("cleanup plan admission closes pair, generation, and logical-identity scope", async () => {
  const registry = await fixturePairRegistry();
  const closure = twoDayClosure(registry);
  assert.equal(admitCleanupPlan(closure.cleanupPlan).changedMonths.length, 1);

  const duplicated = structuredClone(closure.cleanupPlan);
  duplicated.changedMonths.push(structuredClone(duplicated.changedMonths[0]));
  assert.throws(() => admitCleanupPlan(duplicated), /duplicated or unordered/);

  const future = structuredClone(closure.cleanupPlan);
  future.changedMonths[0].dayReferences[0].sequence = 3;
  assert.throws(() => admitCleanupPlan(future), /does not belong/);

  const crossPair = structuredClone(closure.cleanupPlan);
  const otherPair = pairEntryBySymbol(registry, "ETH").pair.pairId;
  crossPair.changedMonths[0].dayReferences[0].logicalId = crossPair.changedMonths[0].dayReferences[0].logicalId.replace(
    closure.state.pair.pairId,
    otherPair,
  );
  assert.throws(() => admitCleanupPlan(crossPair), /does not belong/);
});

test("public GitHub reads omit authorization while every mutation requires a token before network use", async () => {
  const registry = await fixturePairRegistry();
  const closure = pairClosure(registry);
  const githubApi = new FakeGitHub();
  const maximumArtifactBytes = registry.collection.maximumArtifactBytes;
  const writer = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await publishClosure(writer, closure);
  const reader = new GitHubReleaseStore({
    repository: "owner/index",
    maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  githubApi.requests.length = 0;
  assert.equal((await verifyPairIndex({ registry, pairId: closure.state.pair.pairId, store: reader })).status, "verified");
  assert.ok(githubApi.requests.length > 0);
  assert.ok(githubApi.requests.every((request) => request.method === "GET" && request.authorization === null));
  const apiReads = githubApi.requests.filter((request) => new URL(request.target).hostname === "api.github.com");
  const publicReads = githubApi.requests.filter((request) => new URL(request.target).hostname === "github.com");
  assert.equal(apiReads.length, 2);
  assert.equal(publicReads.length, 3);

  const before = githubApi.requests.length;
  await assert.rejects(reader.writeState(
    closure.state.pair.pairId,
    closure.state.sequence,
    closure.encodedState.gzipBytes,
  ), /token is required/);
  await assert.rejects(reader.writeReferenced(
    closure.children[0].reference,
    closure.children[0].encoded.gzipBytes,
  ), /token is required/);
  await assert.rejects(reader.cleanupSelectedGeneration(closure.cleanupPlan), /token is required/);
  assert.equal(githubApi.requests.length, before);
});

test("a bounded period read touches only its selected pair and month and reports uncovered time", async () => {
  const registry = await fixturePairRegistry();
  const closure = pairClosure(registry);
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "stock-token-pair-period-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  await publishClosure(directory, closure);
  const logicalReads = [];
  const store = {
    readSelectedState: (...args) => directory.readSelectedState(...args),
    resolvePairMonth: (...args) => directory.resolvePairMonth(...args),
    readReferenced: async (reference) => {
      logicalReads.push(reference.logicalId);
      return directory.readReferenced(reference);
    },
  };
  const result = await readPairPeriod({
    registry,
    store,
    input: {
      pairId: closure.state.pair.pairId,
      from: "2026-08-14T14:00:00.000Z",
      until: "2026-08-14T14:03:00.000Z",
    },
  });
  assert.deepEqual(result.available, [{ from: "2026-08-14T14:01:00.000Z", until: "2026-08-14T14:03:00.000Z" }]);
  assert.deepEqual(result.unavailable, [{ from: "2026-08-14T14:00:00.000Z", until: "2026-08-14T14:01:00.000Z" }]);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(logicalReads, [
    `pairs/${closure.state.pair.pairId}/months/2026-08`,
    `pairs/${closure.state.pair.pairId}/days/2026-08-14`,
  ]);

  const unavailableReads = [];
  const unavailable = await readPairPeriod({
    registry,
    input: {
      pairId: closure.state.pair.pairId,
      from: "2026-08-14T14:01:00.000Z",
      until: "2026-08-14T14:03:00.000Z",
    },
    store: {
      readSelectedState: (...args) => directory.readSelectedState(...args),
      resolvePairMonth: async () => "unavailable",
      readReferenced: async (reference) => {
        unavailableReads.push(reference.logicalId);
        return directory.readReferenced(reference);
      },
    },
  });
  assert.deepEqual(unavailable.available, []);
  assert.deepEqual(unavailable.unavailable, [{ from: unavailable.requested.from, until: unavailable.requested.until }]);
  assert.deepEqual(unavailableReads, []);
});

test("carrier generation mismatch, missing children, and unequal immutable state bytes fail closed", async () => {
  const registry = await fixturePairRegistry();
  const closure = pairClosure(registry);
  const root = await mkdtemp(join(tmpdir(), "stock-token-pair-integrity-"));
  const store = new DirectoryStore({ root, maximumArtifactBytes: registry.collection.maximumArtifactBytes });
  for (const child of closure.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
  await store.writeState(closure.state.pair.pairId, 2, closure.encodedState.gzipBytes);
  await assert.rejects(
    readPairState({ registry, pairId: closure.state.pair.pairId, store }),
    /does not match its carrier generation/,
  );

  const cleanStore = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "stock-token-pair-missing-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  await cleanStore.writeState(closure.state.pair.pairId, 1, closure.encodedState.gzipBytes);
  await assert.rejects(
    verifyPairIndex({ registry, pairId: closure.state.pair.pairId, store: cleanStore }),
    /ENOENT/,
  );

  const different = Buffer.from(closure.encodedState.gzipBytes);
  different[different.byteLength - 1] ^= 1;
  await assert.rejects(
    cleanStore.writeState(closure.state.pair.pairId, 1, different),
    /immutable bytes differ/,
  );
});

test("a failed state upload leaves uploaded children unselected", async () => {
  const registry = await fixturePairRegistry();
  const closure = pairClosure(registry);
  const githubApi = new FakeGitHub();
  const store = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  for (const child of closure.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
  githubApi.failStateUpload = true;
  await assert.rejects(
    store.writeState(closure.state.pair.pairId, closure.state.sequence, closure.encodedState.gzipBytes),
    /HTTP 500/,
  );
  assert.equal(await store.readSelectedState(closure.state.pair.pairId), null);
});
