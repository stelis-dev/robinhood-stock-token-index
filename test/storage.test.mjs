import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
import {
  createStateIdentity,
  publicationObjectName,
  referenceObjectName,
  stateObjectName,
  StoredDataIntegrityError,
} from "../storage/stored-files.mjs";
import { sha256Hex } from "../collector/canonical.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { GitHubReleaseStore, GitHubStorageError } from "../storage/github-release-store.mjs";
import { fixturePairRegistry, pairCandle, pairEntryBySymbol } from "./pair-fixtures.mjs";
import { FakeGitHub, jsonResponse } from "./github-storage-fixture.mjs";

function pairDataset(registry, sequence = 1) {
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
    children: [
      { reference: dayReference, encoded: encodedDay },
      { reference: monthReference, encoded: encodedMonth },
    ],
  };
}

async function publishDataset(store, dataset) {
  for (const child of dataset.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
  await store.writeState(dataset.state.pair.pairId, dataset.state.sequence, dataset.encodedState.gzipBytes);
}

test("GitHub storage requires a primitive repository identity", () => {
  assert.throws(() => new GitHubReleaseStore({
    repository: ["owner/index"],
    maximumArtifactBytes: 1_024,
  }), /repository identity/);
});

test("directory and GitHub storage return the same selected data set", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
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
  await publishDataset(directory, dataset);
  await publishDataset(github, dataset);

  const directoryVerification = await verifyPairIndex({ registry, pairId: dataset.state.pair.pairId, store: directory });
  const githubVerification = await verifyPairIndex({ registry, pairId: dataset.state.pair.pairId, store: github });
  assert.deepEqual(githubVerification, directoryVerification);
  assert.deepEqual(githubVerification, {
    status: "verified",
    pairId: dataset.state.pair.pairId,
    sequence: 1,
    coverage: dataset.state.coverage,
    monthCount: 1,
    dayCount: 1,
    candleCount: 1,
  });
  assert.doesNotMatch(JSON.stringify(github), /test-token/);

  const replacement = pairDataset(registry, 2);
  await publishDataset(directory, replacement);
  await publishDataset(github, replacement);
  assert.equal((await readPairState({ registry, pairId: replacement.state.pair.pairId, store: directory })).sequence, 2);
  assert.equal((await readPairState({ registry, pairId: replacement.state.pair.pairId, store: github })).sequence, 2);
  const unrelatedTag = "unrelated-release";
  githubApi.releases.set(unrelatedTag, {
    id: 999,
    tag: unrelatedTag,
    assets: new Map([["keep.bin", {
      id: 999,
      name: "keep.bin",
      bytes: Buffer.from("keep"),
      state: "uploaded",
      digest: `sha256:${sha256Hex(Buffer.from("keep"))}`,
    }]]),
  });
  githubApi.requests.length = 0;
  assert.equal(githubApi.releases.get(unrelatedTag).assets.size, 1);
  assert.ok(githubApi.requests.every((request) => !request.target.includes(unrelatedTag)));
  assert.equal((await verifyPairIndex({ registry, pairId: replacement.state.pair.pairId, store: directory })).sequence, 2);
  assert.equal((await verifyPairIndex({ registry, pairId: replacement.state.pair.pairId, store: github })).sequence, 2);
});

test("an uncertain GitHub deletion is reconciled by retrying the same asset until it is absent", async () => {
  const registry = await fixturePairRegistry();
  const previous = pairDataset(registry, 1);
  const selected = pairDataset(registry, 2);
  const githubApi = new FakeGitHub();
  const previousMonth = previous.children.find((child) => child.reference.logicalId.includes("/months/"));
  const deletedName = referenceObjectName(previousMonth.reference);
  let intercepted = false;
  const waits = [];
  const github = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: async (target, init) => {
      if (!intercepted && init?.method === "DELETE") {
        const response = await githubApi.fetch(target, init);
        assert.equal(response.status, 204);
        intercepted = true;
        return jsonResponse({ message: "upstream response was lost" }, 503);
      }
      return githubApi.fetch(target, init);
    },
    waitImplementation: async (milliseconds) => waits.push(milliseconds),
  });
  await publishDataset(github, previous);
  await publishDataset(github, selected);

  await github.removeReferenced(previousMonth.reference);

  assert.equal(intercepted, true);
  assert.deepEqual(waits, [1_000]);
  const monthRelease = githubApi.releases.get(`pair-${selected.state.pair.pairId}-month-2026-08`);
  assert.equal(monthRelease.assets.has(deletedName), false);
  assert.equal((await verifyPairIndex({
    registry,
    pairId: selected.state.pair.pairId,
    store: github,
  })).sequence, 2);
});

test("a terminal GitHub exact deletion failure preserves the selected data set", async () => {
  const registry = await fixturePairRegistry();
  const previous = pairDataset(registry, 1);
  const selected = pairDataset(registry, 2);
  const githubApi = new FakeGitHub();
  const github = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
    waitImplementation: async () => {},
  });
  await publishDataset(github, previous);
  await publishDataset(github, selected);
  const previousMonth = previous.children.find((child) => child.reference.logicalId.includes("/months/"));
  githubApi.failDeleteAssetName = referenceObjectName(previousMonth.reference);
  const failedAssetId = githubApi.releases
    .get(`pair-${selected.state.pair.pairId}-month-2026-08`)
    .assets.get(githubApi.failDeleteAssetName).id;

  await assert.rejects(github.removeReferenced(previousMonth.reference), (error) => (
    error instanceof GitHubStorageError
    && error.operation === "delete_asset"
    && error.reason === "transient_http"
  ));
  assert.equal(githubApi.requests.filter((request) => (
    request.method === "DELETE" && request.target.endsWith(`/assets/${failedAssetId}`)
  )).length, 3);
  assert.equal((await verifyPairIndex({
    registry,
    pairId: selected.state.pair.pairId,
    store: github,
  })).sequence, 2);
});

test("GitHub rate-limit retries honor Retry-After without exposing the response body", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const githubApi = new FakeGitHub();
  const writer = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await publishDataset(writer, dataset);
  let limited = false;
  const waits = [];
  const reader = new GitHubReleaseStore({
    repository: "owner/index",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: async (target, init) => {
      if (!limited && new URL(target).hostname === "api.github.com") {
        limited = true;
        return new Response(JSON.stringify({ message: "secret provider detail" }), {
          status: 429,
          headers: { "retry-after": "2" },
        });
      }
      return githubApi.fetch(target, init);
    },
    waitImplementation: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal((await verifyPairIndex({
    registry,
    pairId: dataset.state.pair.pairId,
    store: reader,
  })).status, "verified");
  assert.deepEqual(waits, [2_000]);
  assert.doesNotMatch(JSON.stringify(reader), /secret provider detail|test-token/);
});

test("an upload committed before a failed response is reconciled without a duplicate POST", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const githubApi = new FakeGitHub();
  let intercepted = false;
  const waits = [];
  const store = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: async (target, init) => {
      if (!intercepted && init?.method === "POST" && new URL(target).hostname === "uploads.github.com") {
        const response = await githubApi.fetch(target, init);
        assert.equal(response.status, 201);
        intercepted = true;
        return jsonResponse({ message: "upstream response was lost" }, 503);
      }
      return githubApi.fetch(target, init);
    },
    waitImplementation: async (milliseconds) => waits.push(milliseconds),
  });

  await publishDataset(store, dataset);

  assert.equal(intercepted, true);
  assert.deepEqual(waits, []);
  assert.equal(
    githubApi.requests.filter((request) => request.method === "POST" && new URL(request.target).hostname === "uploads.github.com").length,
    3,
  );
  assert.equal((await verifyPairIndex({ registry, pairId: dataset.state.pair.pairId, store })).status, "verified");
});

test("an unavailable upload reconciliation never repeats the mutation before a later exact read", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const cases = [
    {
      name: referenceObjectName(dataset.children[0].reference),
      write: (store) => store.writeReferenced(dataset.children[0].reference, dataset.children[0].encoded.gzipBytes),
    },
    {
      name: publicationObjectName,
      write: (store) => store.createPublication(dataset.state.pair.pairId, Buffer.from("publication")),
    },
  ];

  for (const entry of cases) {
    const githubApi = new FakeGitHub();
    let responseLost = false;
    let reconciliationFailures = 0;
    const fetchImplementation = async (target, init = {}) => {
      const url = new URL(target);
      if (
        !responseLost
        && init.method === "POST"
        && url.hostname === "uploads.github.com"
        && url.searchParams.get("name") === entry.name
      ) {
        const response = await githubApi.fetch(target, init);
        assert.equal(response.status, 201);
        responseLost = true;
        reconciliationFailures = 3;
        return jsonResponse({ message: "upstream response was lost" }, 503);
      }
      if (reconciliationFailures > 0 && init.method === "GET" && /\/releases\/[0-9]+\/assets$/.test(url.pathname)) {
        reconciliationFailures -= 1;
        return jsonResponse({ message: "lookup unavailable" }, 503);
      }
      return githubApi.fetch(target, init);
    };
    const first = new GitHubReleaseStore({
      repository: "owner/index",
      token: "test-token",
      maximumArtifactBytes: registry.collection.maximumArtifactBytes,
      fetchImplementation,
      waitImplementation: async () => {},
    });
    await assert.rejects(entry.write(first), (error) => (
      error instanceof GitHubStorageError
      && error.operation === "list_assets"
      && error.reason === "transient_http"
    ));
    const uploadPosts = () => githubApi.requests.filter((request) => (
      request.method === "POST"
      && new URL(request.target).hostname === "uploads.github.com"
      && new URL(request.target).searchParams.get("name") === entry.name
    )).length;
    assert.equal(uploadPosts(), 1);

    const restarted = new GitHubReleaseStore({
      repository: "owner/index",
      token: "test-token",
      maximumArtifactBytes: registry.collection.maximumArtifactBytes,
      fetchImplementation: githubApi.fetch,
      waitImplementation: async () => {},
    });
    await entry.write(restarted);
    assert.equal(uploadPosts(), 1);
  }
});

test("GitHub proof reuses verified bytes and reads a missing digest only once", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const reference = dataset.children[0].reference;
  const githubApi = new FakeGitHub();
  const writer = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await writer.writeReferenced(reference, dataset.children[0].encoded.gzipBytes);
  githubApi.requests.length = 0;
  await writer.proveReferenced(reference);
  assert.deepEqual(githubApi.requests, []);

  const release = [...githubApi.releases.values()].find((candidate) => candidate.assets.has(referenceObjectName(reference)));
  const asset = release.assets.get(referenceObjectName(reference));
  asset.digest = null;
  const restarted = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  githubApi.requests.length = 0;
  await restarted.readReferenced(reference);
  await restarted.proveReferenced(reference);
  assert.equal(githubApi.requests.filter((request) => (
    request.method === "GET" && request.target.endsWith(`/releases/assets/${asset.id}`)
  )).length, 1);
});

test("only uploaded state assets are selectable and exact starters remain removable", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const pairId = dataset.state.pair.pairId;
  const githubApi = new FakeGitHub();
  const tag = `pair-${pairId}-state`;
  const stateIdentity = createStateIdentity(
    dataset.state.sequence,
    dataset.encodedState.gzipBytes,
    registry.collection.maximumArtifactBytes,
  );
  githubApi.releases.set(tag, {
    id: 91,
    tag,
    assets: new Map([
      [publicationObjectName, {
        id: 92,
        name: publicationObjectName,
        bytes: Buffer.alloc(0),
        state: "starter",
        digest: null,
      }],
      [stateObjectName(dataset.state.sequence), {
        id: 93,
        name: stateObjectName(dataset.state.sequence),
        bytes: Buffer.alloc(0),
        state: "starter",
        digest: null,
      }],
    ]),
  });
  const store = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });

  assert.equal((await store.readPublication(pairId)).status, "starter");
  assert.equal(await store.readSelectedState(pairId), null);
  await store.removePublicationStarter(pairId);
  await store.removeState(pairId, stateIdentity, { allowIncomplete: true });
  assert.deepEqual([...githubApi.releases.get(tag).assets.keys()], []);
});

test("contradictory starter metadata is rejected without deletion", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const pairId = dataset.state.pair.pairId;
  const githubApi = new FakeGitHub();
  const tag = `pair-${pairId}-state`;
  const bytes = Buffer.from("not incomplete");
  githubApi.releases.set(tag, {
    id: 94,
    tag,
    assets: new Map([[publicationObjectName, {
      id: 95,
      name: publicationObjectName,
      bytes,
      state: "starter",
      digest: `sha256:${sha256Hex(bytes)}`,
    }]]),
  });
  const store = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await assert.rejects(
    store.readPublication(pairId),
    (error) => error instanceof GitHubStorageError
      && error.operation === "list_assets"
      && error.reason === "invalid_response",
  );
  assert.equal(githubApi.requests.some((request) => request.method === "DELETE"), false);
});

test("a Release created before a failed response is reconciled without duplicate creation", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const githubApi = new FakeGitHub();
  let intercepted = false;
  const store = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: async (target, init) => {
      const url = new URL(target);
      if (!intercepted && init?.method === "POST" && url.hostname === "api.github.com" && url.pathname === "/repos/owner/index/releases") {
        const response = await githubApi.fetch(target, init);
        assert.equal(response.status, 201);
        intercepted = true;
        return jsonResponse({ message: "upstream response was lost" }, 503);
      }
      return githubApi.fetch(target, init);
    },
    waitImplementation: async () => {},
  });

  await publishDataset(store, dataset);

  assert.equal(intercepted, true);
  assert.equal(
    githubApi.requests.filter((request) => request.method === "POST" && request.target === "https://api.github.com/repos/owner/index/releases").length,
    2,
  );
  assert.equal(githubApi.releases.size, 2);
  assert.equal((await verifyPairIndex({ registry, pairId: dataset.state.pair.pairId, store })).status, "verified");
});

test("an unavailable Release reconciliation never repeats creation before a later exact read", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const githubApi = new FakeGitHub();
  let responseLost = false;
  let reconciliationFailures = 0;
  const fetchImplementation = async (target, init = {}) => {
    const url = new URL(target);
    if (!responseLost && init.method === "POST" && url.pathname === "/repos/owner/index/releases") {
      const response = await githubApi.fetch(target, init);
      assert.equal(response.status, 201);
      responseLost = true;
      reconciliationFailures = 3;
      return jsonResponse({ message: "upstream response was lost" }, 503);
    }
    if (reconciliationFailures > 0 && init.method === "GET" && /\/releases\/tags\//.test(url.pathname)) {
      reconciliationFailures -= 1;
      return jsonResponse({ message: "lookup unavailable" }, 503);
    }
    return githubApi.fetch(target, init);
  };
  const first = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation,
    waitImplementation: async () => {},
  });
  await assert.rejects(
    first.writeReferenced(dataset.children[0].reference, dataset.children[0].encoded.gzipBytes),
    (error) => error instanceof GitHubStorageError
      && error.operation === "get_release"
      && error.reason === "transient_http",
  );
  const creationPosts = () => githubApi.requests.filter((request) => (
    request.method === "POST" && request.target === "https://api.github.com/repos/owner/index/releases"
  )).length;
  assert.equal(creationPosts(), 1);

  const restarted = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await restarted.writeReferenced(dataset.children[0].reference, dataset.children[0].encoded.gzipBytes);
  assert.equal(creationPosts(), 1);
});

test("exact GitHub deletion rejects mismatched uploaded metadata without mutation", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const reference = dataset.children[0].reference;
  const githubApi = new FakeGitHub();
  const writer = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await writer.writeReferenced(reference, dataset.children[0].encoded.gzipBytes);
  const release = [...githubApi.releases.values()].find((candidate) => candidate.assets.has(referenceObjectName(reference)));
  const asset = release.assets.get(referenceObjectName(reference));
  asset.digest = `sha256:${"0".repeat(64)}`;
  const restarted = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  githubApi.requests.length = 0;
  await assert.rejects(
    restarted.removeReferenced(reference),
    (error) => error instanceof StoredDataIntegrityError,
  );
  assert.equal(release.assets.has(referenceObjectName(reference)), true);
  assert.equal(githubApi.requests.some((request) => request.method === "DELETE"), false);
});

test("public GitHub reads omit authorization while every mutation requires a token before network use", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const githubApi = new FakeGitHub();
  const maximumArtifactBytes = registry.collection.maximumArtifactBytes;
  const writer = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await publishDataset(writer, dataset);
  const reader = new GitHubReleaseStore({
    repository: "owner/index",
    maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  githubApi.requests.length = 0;
  assert.equal((await verifyPairIndex({ registry, pairId: dataset.state.pair.pairId, store: reader })).status, "verified");
  assert.ok(githubApi.requests.length > 0);
  assert.ok(githubApi.requests.every((request) => request.method === "GET" && request.authorization === null));
  const apiReads = githubApi.requests.filter((request) => new URL(request.target).hostname === "api.github.com");
  const publicReads = githubApi.requests.filter((request) => new URL(request.target).hostname === "github.com");
  assert.equal(apiReads.length, 2);
  assert.equal(publicReads.length, 3);

  const before = githubApi.requests.length;
  await assert.rejects(reader.writeState(
    dataset.state.pair.pairId,
    dataset.state.sequence,
    dataset.encodedState.gzipBytes,
  ), /token is required/);
  await assert.rejects(reader.writeReferenced(
    dataset.children[0].reference,
    dataset.children[0].encoded.gzipBytes,
  ), /token is required/);
  await assert.rejects(reader.removeReferenced(dataset.children[0].reference), /token is required/);
  assert.equal(githubApi.requests.length, before);
});

test("a bounded period read touches only its selected pair and month and reports uncovered time", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const directory = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "stock-token-pair-period-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  await publishDataset(directory, dataset);
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
      pairId: dataset.state.pair.pairId,
      from: "2026-08-14T14:00:00.000Z",
      until: "2026-08-14T14:03:00.000Z",
    },
  });
  assert.deepEqual(result.available, [{ from: "2026-08-14T14:01:00.000Z", until: "2026-08-14T14:03:00.000Z" }]);
  assert.deepEqual(result.unavailable, [{ from: "2026-08-14T14:00:00.000Z", until: "2026-08-14T14:01:00.000Z" }]);
  assert.equal(result.candles.length, 1);
  assert.deepEqual(logicalReads, [
    `pairs/${dataset.state.pair.pairId}/months/2026-08`,
    `pairs/${dataset.state.pair.pairId}/days/2026-08-14`,
  ]);

  const unavailableReads = [];
  const unavailable = await readPairPeriod({
    registry,
    input: {
      pairId: dataset.state.pair.pairId,
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

test("stored generation mismatch, missing referenced files, and changed immutable state bytes fail", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const root = await mkdtemp(join(tmpdir(), "stock-token-pair-integrity-"));
  const store = new DirectoryStore({ root, maximumArtifactBytes: registry.collection.maximumArtifactBytes });
  for (const child of dataset.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
  await store.writeState(dataset.state.pair.pairId, 2, dataset.encodedState.gzipBytes);
  await assert.rejects(
    readPairState({ registry, pairId: dataset.state.pair.pairId, store }),
    (error) => error instanceof StoredDataIntegrityError,
  );

  const cleanStore = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "stock-token-pair-missing-")),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
  await cleanStore.writeState(dataset.state.pair.pairId, 1, dataset.encodedState.gzipBytes);
  await assert.rejects(
    verifyPairIndex({ registry, pairId: dataset.state.pair.pairId, store: cleanStore }),
    /ENOENT/,
  );

  const different = Buffer.from(dataset.encodedState.gzipBytes);
  different[different.byteLength - 1] ^= 1;
  await assert.rejects(
    cleanStore.writeState(dataset.state.pair.pairId, 1, different),
    /immutable bytes differ/,
  );
});

test("a failed state upload leaves uploaded children unselected", async () => {
  const registry = await fixturePairRegistry();
  const dataset = pairDataset(registry);
  const githubApi = new FakeGitHub();
  const store = new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
    waitImplementation: async () => {},
  });
  for (const child of dataset.children) await store.writeReferenced(child.reference, child.encoded.gzipBytes);
  githubApi.failStateUpload = true;
  await assert.rejects(
    store.writeState(dataset.state.pair.pairId, dataset.state.sequence, dataset.encodedState.gzipBytes),
    (error) => error instanceof GitHubStorageError && error.operation === "upload_asset" && error.reason === "transient_http",
  );
  assert.equal(
    githubApi.requests.filter((request) => request.method === "POST" && request.target.includes("state-g")).length,
    3,
  );
  assert.equal(await store.readSelectedState(dataset.state.pair.pairId), null);
});
