import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateCollectionPlan,
  collectionGroupEstimatedRuntime,
  collectionGroupById,
  collectionGroupPairIds,
  loadCollectionPlan,
} from "../scheduler/collection-plan.mjs";
import { runCollectionGroup } from "../scheduler/run-collection-group.mjs";
import { main as runCli, parseArguments, runPairCommand } from "../cli.mjs";
import { RpcClient } from "../collector/rpc-client.mjs";
import { RpcEndpointUnavailableError } from "../collector/rpc-endpoint.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { compactPairRegistry, FakePairRpc } from "./pair-process-fixtures.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";
import { fixturePairRegistry } from "./pair-fixtures.mjs";

test("the collection plan defines all group limits, estimated runtimes, members, and schedules", async () => {
  const pairRegistry = await fixturePairRegistry();
  const plan = await loadCollectionPlan(pairRegistry);
  assert.deepEqual(plan.capacity, {
    durationPaddingPercent: 25,
    maximumGroupCount: 3,
    maximumGroupSeconds: 720,
    maximumPairsPerGroup: 3,
  });
  assert.deepEqual(plan.groups.map((group) => collectionGroupEstimatedRuntime(plan, group)), [582, 599, 589]);
  assert.deepEqual(
    new Set(plan.groups.flatMap(collectionGroupPairIds)),
    new Set(pairRegistry.pairs.map((entry) => entry.pair.pairId)),
  );
  assert.equal(new Set(plan.groups.flatMap((group) => group.schedules)).size, 9);
  assert.equal(collectionGroupById(plan, "group-2"), plan.groups[1]);
  assert.throws(() => collectionGroupById(plan, "group-4"), /Unknown collection group/);
});

test("collection-plan validation rejects group limits, estimated runtime, schedule, and membership conflicts", async () => {
  const pairRegistry = await fixturePairRegistry();
  const plan = await loadCollectionPlan(pairRegistry);
  const invalidCandidates = [];

  const extraRootMember = structuredClone(plan);
  extraRootMember.measurements = [];
  invalidCandidates.push(extraRootMember);

  const extraGroupMember = structuredClone(plan);
  extraGroupMember.groups[0].operation = "collect";
  invalidCandidates.push(extraGroupMember);

  const skippedGroupId = structuredClone(plan);
  skippedGroupId.groups[1].groupId = "group-3";
  invalidCandidates.push(skippedGroupId);

  const tooManyGroups = structuredClone(plan);
  const movedGroupMember = tooManyGroups.groups[2].members.pop();
  tooManyGroups.groups.push({ groupId: "group-4", members: [movedGroupMember], schedules: ["1 1 * * *"] });
  invalidCandidates.push(tooManyGroups);

  const tooManyMembers = structuredClone(plan);
  tooManyMembers.groups[0].members.push(tooManyMembers.groups[1].members.shift());
  invalidCandidates.push(tooManyMembers);

  const excessiveDuration = structuredClone(plan);
  excessiveDuration.groups[0].members[0].measuredSeconds = 721;
  invalidCandidates.push(excessiveDuration);

  const emptyGroup = structuredClone(plan);
  emptyGroup.groups[0].members = [];
  invalidCandidates.push(emptyGroup);

  const omittedPair = structuredClone(plan);
  omittedPair.groups[0].members.pop();
  invalidCandidates.push(omittedPair);

  const duplicatedPair = structuredClone(plan);
  duplicatedPair.groups[1].members[0].pairId = duplicatedPair.groups[0].members[0].pairId;
  invalidCandidates.push(duplicatedPair);

  const unknownPair = structuredClone(plan);
  unknownPair.groups[2].members[0].pairId = `0x${"0".repeat(64)}`;
  invalidCandidates.push(unknownPair);

  const duplicateSchedule = structuredClone(plan);
  duplicateSchedule.groups[1].schedules[0] = duplicateSchedule.groups[0].schedules[0];
  invalidCandidates.push(duplicateSchedule);

  for (const candidate of invalidCandidates) {
    assert.throws(() => validateCollectionPlan(candidate, pairRegistry));
  }
});

test("the group runner preserves order and isolates a non-abort pair failure", async () => {
  const pairRegistry = await fixturePairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  const group = collectionPlan.groups[0];
  const pairIds = collectionGroupPairIds(group);
  const calls = [];
  const result = await runCollectionGroup({
    pairRegistry,
    collectionPlan,
    groupId: group.groupId,
    runPair: async (pairId) => {
      calls.push(pairId);
      if (pairId === pairIds[1]) throw new Error("untrusted pair failure");
    },
  });
  assert.deepEqual(calls, pairIds);
  assert.deepEqual(result, {
    status: "failure",
    pairs: pairIds.map((pairId, index) => ({
      pairId,
      status: index === 1 ? "failure" : "success",
    })),
  });
  assert.doesNotMatch(JSON.stringify(result), /untrusted/);
});

test("malformed membership and abort stop before another pair operation starts", async () => {
  const pairRegistry = await fixturePairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  const malformed = structuredClone(collectionPlan);
  malformed.groups[0].members.pop();
  let calls = 0;
  await assert.rejects(runCollectionGroup({
    pairRegistry,
    collectionPlan: malformed,
    groupId: "group-1",
    runPair: async () => { calls += 1; },
  }));
  assert.equal(calls, 0);

  const controller = new AbortController();
  const started = [];
  await assert.rejects(runCollectionGroup({
    pairRegistry,
    collectionPlan,
    groupId: "group-1",
    signal: controller.signal,
    runPair: async (pairId) => {
      started.push(pairId);
      controller.abort(new Error("Operation cancelled."));
    },
  }), /Operation cancelled/);
  assert.deepEqual(started, [collectionPlan.groups[0].members[0].pairId]);
});

test("the unified CLI passes unchanged group operation, storage, environment, and signal inputs", async () => {
  const pairRegistry = await fixturePairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  const group = collectionPlan.groups[1];
  const pairIds = collectionGroupPairIds(group);
  const environment = { GITHUB_TOKEN: "test-token", INDEX_RPC_FALLBACK_URL_0: "https://rpc.example/key" };
  const controller = new AbortController();
  const calls = [];
  const output = [];
  const writeLog = () => {};
  const summary = await runCli([
    "repair",
    "--group", group.groupId,
    "--store", "github",
    "--repository", "owner/index",
  ], {
    environment,
    signal: controller.signal,
    pairOperation: async (options, registry, context) => calls.push({ options, registry, context }),
    writeLog,
    writeOutput: (line) => output.push(line),
  });
  assert.deepEqual(calls.map((call) => call.options), pairIds.map((pairId) => ({
    operation: "repair",
    target: { kind: "pair", id: pairId },
    store: "github",
    root: undefined,
    repository: "owner/index",
    from: undefined,
    until: undefined,
  })));
  assert.ok(calls.every((call) => call.registry === calls[0].registry));
  assert.ok(calls.every((call) => call.context === calls[0].context));
  assert.equal(calls[0].context.environment, environment);
  assert.equal(calls[0].context.signal, controller.signal);
  assert.equal(calls[0].context.writeLog, writeLog);
  assert.deepEqual(summary, {
    ok: true,
    operation: "repair",
    groupId: group.groupId,
    result: {
      status: "success",
      pairs: pairIds.map((pairId) => ({ pairId, status: "success" })),
    },
  });
  assert.deepEqual(output, [`${JSON.stringify(summary)}\n`]);
});

test("the unified CLI resolves a scheduled expression only through the collection plan", async () => {
  const pairRegistry = await fixturePairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  const group = collectionPlan.groups[2];
  const calls = [];
  const output = [];
  const summary = await runCli([
    "collect",
    "--schedule", group.schedules[1],
    "--store", "directory",
    "--root", "/tmp/index",
  ], {
    pairOperation: async (options) => calls.push(options),
    writeOutput: (line) => output.push(line),
  });
  assert.deepEqual(calls.map((options) => options.target), collectionGroupPairIds(group).map((pairId) => ({
    kind: "pair", id: pairId,
  })));
  assert.equal(summary.groupId, group.groupId);
  assert.deepEqual(output, [`${JSON.stringify(summary)}\n`]);
});

test("one group command preserves storage evidence and RPC pacing across pair boundaries", async () => {
  const pairRegistry = await fixturePairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  const group = collectionPlan.groups[0];
  let now = 1_000;
  const waits = [];
  const endpoint = new RpcClient({
    url: "https://rpc.example/key",
    requestDelayMilliseconds: 10,
    requestTimeoutMilliseconds: 1_000,
    maximumResponseBytes: 1_000,
    maximumRpcAttempts: 1,
    maximumRpcRetryDelayMilliseconds: 1_000,
    nowImplementation: () => now,
    sleepImplementation: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    fetchImplementation: async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1237" }));
    },
  });
  const storageEvidence = new Map();
  const contexts = [];
  await runCli([
    "collect", "--group", group.groupId, "--store", "directory", "--root", "/tmp/index",
  ], {
    createContext: (_options, _registry, { environment, signal }) => Object.freeze({
      environment,
      signal,
      store: storageEvidence,
      clients: Object.freeze([endpoint]),
    }),
    pairOperation: async (options, _registry, context) => {
      contexts.push(context);
      assert.equal(await context.clients[0].call("eth_chainId", []), "0x1237");
      context.store.set(options.target.id, contexts.length);
    },
    writeOutput: () => {},
  });
  assert.equal(new Set(contexts).size, 1);
  assert.equal(contexts[0].clients[0], endpoint);
  assert.equal(contexts[0].store, storageEvidence);
  assert.deepEqual([...storageEvidence.keys()], collectionGroupPairIds(group));
  assert.deepEqual(waits, [10, 10]);
});

test("pair collect uses at most two current-first phases against one finalized boundary", async () => {
  const caughtUpRegistry = await compactPairRegistry();
  const pair = pairEntryBySymbol(caughtUpRegistry, "NVDA").pair;
  const activation = BigInt(pair.activation.blockNumber);
  const primary = new FakePairRpc({
    registry: caughtUpRegistry,
    pair,
    finalizedNumber: activation + 360n,
  });
  let primaryVerifications = 0;
  const verifyPrimary = primary.verifyChain.bind(primary);
  primary.verifyChain = async (...args) => {
    primaryVerifications += 1;
    if (primaryVerifications === 2) throw new RpcEndpointUnavailableError();
    return verifyPrimary(...args);
  };
  const fallback = new FakePairRpc({
    registry: caughtUpRegistry,
    pair,
    finalizedNumber: activation + 720n,
  });
  const fallbackSelectors = [];
  const fallbackGetBlock = fallback.getBlock.bind(fallback);
  fallback.getBlock = async (selector) => {
    fallbackSelectors.push(selector);
    return fallbackGetBlock(selector);
  };
  const caughtUpStore = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "pair-command-caught-up-")),
    maximumArtifactBytes: caughtUpRegistry.collection.maximumArtifactBytes,
  });
  const options = {
    operation: "collect",
    target: { kind: "pair", id: pair.pairId },
    store: "directory",
    root: caughtUpStore.root,
  };
  const caughtUp = await runPairCommand(options, caughtUpRegistry, {
    environment: {},
    signal: undefined,
    store: caughtUpStore,
    clients: [primary, fallback],
  });
  assert.deepEqual(caughtUp.result.map((phase) => phase.phase), ["current", "history"]);
  assert.equal(caughtUp.result.length, 2);
  assert.ok(fallbackSelectors.some((selector) => typeof selector === "bigint" && selector === activation + 360n));

  const laggingRegistry = await compactPairRegistry({ maximumBlocksPerRun: 100 });
  const laggingPair = pairEntryBySymbol(laggingRegistry, "NVDA").pair;
  const laggingActivation = BigInt(laggingPair.activation.blockNumber);
  const laggingStore = new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), "pair-command-lagging-")),
    maximumArtifactBytes: laggingRegistry.collection.maximumArtifactBytes,
  });
  const lagging = await runPairCommand({
    ...options,
    target: { kind: "pair", id: laggingPair.pairId },
    root: laggingStore.root,
  }, laggingRegistry, {
    environment: {},
    signal: undefined,
    store: laggingStore,
    clients: [new FakePairRpc({
      registry: laggingRegistry,
      pair: laggingPair,
      finalizedNumber: laggingActivation + 500n,
    })],
  });
  assert.deepEqual(lagging.result.map((phase) => phase.phase), ["current", "current"]);
  assert.equal(lagging.result.length, 2);
});

test("the unified CLI accepts one group or schedule target and only its allowed operations", () => {
  assert.deepEqual(parseArguments([
    "collect", "--group", "group-1", "--store", "directory", "--root", "/tmp/index",
  ]), {
    operation: "collect",
    target: { kind: "group", id: "group-1" },
    store: "directory",
    root: "/tmp/index",
    repository: undefined,
    from: undefined,
    until: undefined,
  });
  assert.equal(parseArguments([
    "collect", "--schedule", "7,52 0-23/3 * * *", "--store", "github", "--repository", "owner/index",
  ]).target.kind, "schedule");
  assert.throws(() => parseArguments(["verify", "--group", "group-1", "--store", "directory", "--root", "/tmp/index"]), /pair target/);
  assert.throws(() => parseArguments(["repair", "--schedule", "7,52 0-23/3 * * *", "--store", "directory", "--root", "/tmp/index"]), /collect only/);
  assert.throws(() => parseArguments(["collect", "--store", "directory", "--root", "/tmp/index"]), /exactly one/);
  assert.throws(() => parseArguments(["collect", "--pair", "a", "--group", "group-1", "--store", "directory", "--root", "/tmp/index"]), /exactly one/);
});
