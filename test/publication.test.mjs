import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPairMonth, readPairState } from "../collector/pair-reader.mjs";
import {
  decodePublicationManifest,
  encodePublicationManifest,
  recoverPairPublication,
} from "../collector/publication.mjs";
import { collectPairCurrent } from "../collector/process.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { GitHubReleaseStore, GitHubStorageError } from "../storage/github-release-store.mjs";
import {
  parseStoredReferenceId,
  publicationObjectName,
  referenceObjectName,
  stateObjectName,
  StoredDataIntegrityError,
} from "../storage/stored-files.mjs";
import { compactPairRegistry, FakePairRpc } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";
import { FakeGitHub } from "./github-storage-fixture.mjs";
import { storagePort } from "./storage-port-fixture.mjs";

const replacementTrace = Object.freeze([
  "create_publication",
  "write_day",
  "write_month",
  "write_state",
  "remove_day",
  "remove_month",
  "remove_state",
  "remove_publication",
]);
const firstPublicationTrace = Object.freeze([
  "create_publication",
  "write_day",
  "write_month",
  "write_state",
  "remove_publication",
]);

function directory(root, registry) {
  return new DirectoryStore({ root, maximumArtifactBytes: registry.collection.maximumArtifactBytes });
}

function referenceFile(root, reference) {
  const identity = parseStoredReferenceId(reference.logicalId);
  const pairMonth = identity.kind === "month" ? identity.period : identity.period.slice(0, 7);
  return join(root, "pairs", identity.pairId, "months", pairMonth, referenceObjectName(reference));
}

async function corruptReference(root, reference) {
  const path = referenceFile(root, reference);
  const bytes = await readFile(path);
  bytes[bytes.byteLength - 1] ^= 1;
  await writeFile(path, bytes);
}

async function initializedPair() {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const root = await mkdtemp(join(tmpdir(), "pair-publication-"));
  const store = directory(root, registry);
  await collectPairCurrent({
    registry,
    pairId: pair.pairId,
    store,
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n }),
  });
  return { registry, pair, activation, root, store };
}

function interruptedStore(store, stopAfter, trace, onManifest) {
  const afterMutation = (label, value) => {
    trace.push(label);
    if (typeof stopAfter === "number" ? trace.length === stopAfter : label === stopAfter) {
      throw new Error("Simulated process termination.");
    }
    return value;
  };
  return storagePort(store, {
    createPublication: async (pairId, bytes) => {
      onManifest?.(bytes);
      return afterMutation("create_publication", await store.createPublication(pairId, bytes));
    },
    writeReferenced: async (reference, bytes) => afterMutation(
      `write_${parseStoredReferenceId(reference.logicalId).kind}`,
      await store.writeReferenced(reference, bytes),
    ),
    writeState: async (...args) => afterMutation("write_state", await store.writeState(...args)),
    removeReferenced: async (reference, ...rest) => afterMutation(
      `remove_${parseStoredReferenceId(reference.logicalId).kind}`,
      await store.removeReferenced(reference, ...rest),
    ),
    removeState: async (...args) => afterMutation("remove_state", await store.removeState(...args)),
    removePublication: async (...args) => afterMutation(
      "remove_publication",
      await store.removePublication(...args),
    ),
  });
}

async function assertOnlySelectedClosure({ registry, pair, root, store, expectedSequence }) {
  const state = await readPairState({ registry, pairId: pair.pairId, store });
  assert.equal(state.sequence, expectedSequence);
  const stateFiles = (await readdir(join(root, "pairs", pair.pairId, "state"))).sort();
  assert.deepEqual(stateFiles, [stateObjectName(expectedSequence)]);
  assert.equal(stateFiles.includes(publicationObjectName), false);

  const expectedByMonth = new Map();
  for (const monthReference of state.months) {
    const month = await readPairMonth({ registry, store, reference: monthReference });
    const pairMonth = parseStoredReferenceId(monthReference.logicalId).period;
    expectedByMonth.set(pairMonth, [
      referenceObjectName(monthReference),
      ...month.days.map(referenceObjectName),
    ].sort());
  }
  const monthRoot = join(root, "pairs", pair.pairId, "months");
  const actualMonths = (await readdir(monthRoot)).sort();
  assert.deepEqual(actualMonths, [...expectedByMonth.keys()].sort());
  for (const pairMonth of actualMonths) {
    assert.deepEqual(
      (await readdir(join(monthRoot, pairMonth))).sort(),
      expectedByMonth.get(pairMonth),
    );
  }
}

async function filesBelow(path, prefix = "") {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesBelow(join(path, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

async function runReplacement({ registry, pair, activation, store }) {
  return collectPairCurrent({
    registry,
    pairId: pair.pairId,
    store,
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n }),
  });
}

function githubRequestTrace(requests) {
  return requests.map((request) => {
    const url = new URL(request.target);
    if (request.method === "POST" && url.hostname === "uploads.github.com") {
      const name = url.searchParams.get("name");
      if (name === publicationObjectName) return "upload_publication";
      if (name.startsWith("day-")) return "upload_day";
      if (name.startsWith("month-")) return "upload_month";
      if (name.startsWith("state-")) return "upload_state";
    }
    if (request.method === "GET" && /\/releases\/tags\//.test(url.pathname)) return "get_release";
    if (request.method === "GET" && /\/releases\/[0-9]+\/assets$/.test(url.pathname)) return "list_assets";
    if (request.method === "GET" && /\/releases\/assets\/[0-9]+$/.test(url.pathname)) return "get_asset";
    if (request.method === "DELETE") return "delete_asset";
    return `${request.method} ${url.hostname}${url.pathname}`;
  });
}

test("every durable replacement boundary restarts into exactly one selected closure", async () => {
  const complete = await initializedPair();
  const completeTrace = [];
  const completed = await runReplacement({
    ...complete,
    store: interruptedStore(complete.store, Number.POSITIVE_INFINITY, completeTrace),
  });
  assert.equal(completed.sequence, 2);
  assert.deepEqual(completeTrace, replacementTrace);
  await assertOnlySelectedClosure({ ...complete, store: complete.store, expectedSequence: 2 });

  for (let stopAfter = 1; stopAfter <= replacementTrace.length; stopAfter += 1) {
    const fixture = await initializedPair();
    const trace = [];
    await assert.rejects(
      runReplacement({
        ...fixture,
        store: interruptedStore(fixture.store, stopAfter, trace),
      }),
      /Simulated process termination/,
    );
    assert.deepEqual(trace, replacementTrace.slice(0, stopAfter));

    const restarted = directory(fixture.root, fixture.registry);
    const recovered = await recoverPairPublication({
      registry: fixture.registry,
      pairId: fixture.pair.pairId,
      store: restarted,
    });
    const expectedSequence = stopAfter < replacementTrace.indexOf("write_state") + 1 ? 1 : 2;
    const expectedStatus = stopAfter === replacementTrace.length
      ? "idle"
      : expectedSequence === 1 ? "aborted" : "committed";
    assert.equal(recovered.status, expectedStatus);
    await assertOnlySelectedClosure({ ...fixture, store: restarted, expectedSequence });
  }

  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  for (let stopAfter = 1; stopAfter <= firstPublicationTrace.length; stopAfter += 1) {
    const root = await mkdtemp(join(tmpdir(), "pair-first-publication-"));
    const store = directory(root, registry);
    const trace = [];
    await assert.rejects(
      collectPairCurrent({
        registry,
        pairId: pair.pairId,
        store: interruptedStore(store, stopAfter, trace),
        rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n }),
      }),
      /Simulated process termination/,
    );
    assert.deepEqual(trace, firstPublicationTrace.slice(0, stopAfter));
    const restarted = directory(root, registry);
    const recovered = await recoverPairPublication({ registry, pairId: pair.pairId, store: restarted });
    const selected = stopAfter >= firstPublicationTrace.indexOf("write_state") + 1;
    assert.equal(
      recovered.status,
      stopAfter === firstPublicationTrace.length ? "idle" : selected ? "committed" : "aborted",
    );
    if (selected) {
      await assertOnlySelectedClosure({ registry, pair, root, store: restarted, expectedSequence: 1 });
    } else {
      assert.equal(await readPairState({ registry, pairId: pair.pairId, store: restarted }), null);
      assert.deepEqual(await filesBelow(join(root, "pairs", pair.pairId)), []);
    }
  }
});

test("the fixed publication slot rejects a different transition before any child write", async () => {
  const fixture = await initializedPair();
  let manifestBytes;
  const trace = [];
  await assert.rejects(
    runReplacement({
      ...fixture,
      store: interruptedStore(fixture.store, 1, trace, (bytes) => { manifestBytes = Buffer.from(bytes); }),
    }),
    /Simulated process termination/,
  );
  assert.deepEqual(trace, ["create_publication"]);
  const admitted = decodePublicationManifest(manifestBytes, {
    registry: fixture.registry,
    expectedPairId: fixture.pair.pairId,
  });
  const conflicting = encodePublicationManifest({ ...admitted, phase: "history" }, {
    registry: fixture.registry,
    expectedPairId: fixture.pair.pairId,
  });
  await assert.rejects(
    fixture.store.createPublication(fixture.pair.pairId, conflicting.gzipBytes),
    /immutable bytes differ/,
  );
  assert.equal((await readPairState({
    registry: fixture.registry,
    pairId: fixture.pair.pairId,
    store: fixture.store,
  })).sequence, 1);
  assert.equal((await fixture.store.readPublication(fixture.pair.pairId)).status, "uploaded");

  assert.equal((await recoverPairPublication({
    registry: fixture.registry,
    pairId: fixture.pair.pairId,
    store: fixture.store,
  })).status, "aborted");
  await assertOnlySelectedClosure({ ...fixture, expectedSequence: 1 });
});

test("recovery proves retained data before its first superseded deletion", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const root = await mkdtemp(join(tmpdir(), "pair-publication-retained-"));
  const store = directory(root, registry);
  const multiDayRpc = new FakePairRpc({
    registry,
    pair,
    finalizedNumber: activation + 2n,
    secondsPerBlock: 86_400,
  });
  await collectPairCurrent({ registry, pairId: pair.pairId, store, rpc: multiDayRpc });

  const trace = [];
  await assert.rejects(
    collectPairCurrent({
      registry,
      pairId: pair.pairId,
      store: interruptedStore(store, "write_state", trace),
      rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 3n, secondsPerBlock: 86_400 }),
    }),
    /Simulated process termination/,
  );
  const selected = await readPairState({ registry, pairId: pair.pairId, store });
  const changedMonth = await readPairMonth({ registry, store, reference: selected.months[0] });
  const retainedDay = changedMonth.days.find((reference) => reference.sequence === 1);
  assert.ok(retainedDay);
  await corruptReference(root, retainedDay);

  let deletionReached = false;
  const recoveryStore = storagePort(directory(root, registry), {
    async removeReferenced() {
      deletionReached = true;
      throw new Error("Deletion must not be reached.");
    },
  });
  await assert.rejects(
    recoverPairPublication({ registry, pairId: pair.pairId, store: recoveryStore }),
    (error) => error instanceof StoredDataIntegrityError,
  );
  assert.equal(deletionReached, false);
  assert.equal((await store.readPublication(pair.pairId)).status, "uploaded");
});

test("recovery never deletes a same-name superseded file with different bytes", async () => {
  const fixture = await initializedPair();
  const previousState = await readPairState({
    registry: fixture.registry,
    pairId: fixture.pair.pairId,
    store: fixture.store,
  });
  const previousMonth = await readPairMonth({
    registry: fixture.registry,
    store: fixture.store,
    reference: previousState.months[0],
  });
  const previousDay = previousMonth.days[0];
  const trace = [];
  await assert.rejects(
    runReplacement({
      ...fixture,
      store: interruptedStore(fixture.store, "write_state", trace),
    }),
    /Simulated process termination/,
  );
  await corruptReference(fixture.root, previousDay);
  await assert.rejects(
    recoverPairPublication({
      registry: fixture.registry,
      pairId: fixture.pair.pairId,
      store: directory(fixture.root, fixture.registry),
    }),
    (error) => error instanceof StoredDataIntegrityError,
  );
  assert.equal((await readFile(referenceFile(fixture.root, previousDay))).byteLength, previousDay.gzipBytes);
  assert.equal((await fixture.store.readPublication(fixture.pair.pairId)).status, "uploaded");
});

test("a cold GitHub replacement follows the request trace derived from the publication state machine", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const githubApi = new FakeGitHub();
  const createStore = () => new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
  });
  await collectPairCurrent({
    registry,
    pairId: pair.pairId,
    store: createStore(),
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n }),
  });

  githubApi.requests.length = 0;
  await collectPairCurrent({
    registry,
    pairId: pair.pairId,
    store: createStore(),
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n }),
  });
  assert.deepEqual(githubRequestTrace(githubApi.requests), [
    "get_release",
    "list_assets",
    "get_asset",
    "get_release",
    "list_assets",
    "get_asset",
    "get_asset",
    "upload_publication",
    "get_asset",
    "upload_day",
    "get_asset",
    "upload_month",
    "get_asset",
    "upload_state",
    "get_asset",
    "delete_asset",
    "delete_asset",
    "delete_asset",
    "delete_asset",
  ]);
});

test("a cold GitHub recovery resumes selected cleanup through its derived request trace", async () => {
  const registry = await compactPairRegistry();
  const pair = pairEntryBySymbol(registry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const githubApi = new FakeGitHub();
  const createStore = () => new GitHubReleaseStore({
    repository: "owner/index",
    token: "test-token",
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    fetchImplementation: githubApi.fetch,
    waitImplementation: async () => {},
  });
  const firstStore = createStore();
  await collectPairCurrent({
    registry,
    pairId: pair.pairId,
    store: firstStore,
    rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 360n }),
  });
  const previousState = await readPairState({ registry, pairId: pair.pairId, store: firstStore });
  const previousMonth = await readPairMonth({ registry, store: firstStore, reference: previousState.months[0] });
  githubApi.failDeleteAssetName = referenceObjectName(previousMonth.days[0]);
  await assert.rejects(
    collectPairCurrent({
      registry,
      pairId: pair.pairId,
      store: firstStore,
      rpc: new FakePairRpc({ registry, pair, finalizedNumber: activation + 720n }),
    }),
    (error) => error instanceof GitHubStorageError && error.operation === "delete_asset",
  );

  githubApi.failDeleteAssetName = null;
  githubApi.requests.length = 0;
  const recovered = await recoverPairPublication({ registry, pairId: pair.pairId, store: createStore() });
  assert.equal(recovered.status, "committed");
  assert.deepEqual(githubRequestTrace(githubApi.requests), [
    "get_release",
    "list_assets",
    "get_asset",
    "get_asset",
    "get_release",
    "list_assets",
    "get_asset",
    "delete_asset",
    "delete_asset",
    "delete_asset",
    "delete_asset",
  ]);
});
