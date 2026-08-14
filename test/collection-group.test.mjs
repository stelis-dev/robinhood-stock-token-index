import assert from "node:assert/strict";
import test from "node:test";
import {
  admitCollectionGroupRegistry,
  collectionGroupById,
  loadCollectionGroupRegistry,
} from "../scheduler/collection-group-registry.mjs";
import { runCollectionGroup } from "../scheduler/run-collection-group.mjs";
import { main as runGroupCli, parseGroupArguments } from "../group-cli.mjs";
import { fixturePairRegistry } from "./pair-fixtures.mjs";

const expectedGroups = [
  [
    "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32",
    "0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579",
    "0xd32646872e6712af8cf778e34b6bbef1d2ae0bddd83764e1b07333518ad59333",
  ],
  [
    "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e",
    "0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e",
    "0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd",
  ],
  [
    "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1",
    "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb",
    "0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36",
  ],
];

test("the measured collection groups are the exact ordered partition of admitted pairs", async () => {
  const pairRegistry = await fixturePairRegistry();
  const registry = await loadCollectionGroupRegistry(pairRegistry);
  assert.deepEqual(
    registry.groups,
    expectedGroups.map((pairIds, index) => ({
      groupId: `group-${index + 1}`,
      pairIds,
    })),
  );
  assert.equal(collectionGroupById(registry, "group-2"), registry.groups[1]);
  assert.throws(() => collectionGroupById(registry, "group-4"), /Unknown collection group/);
});

test("group admission rejects structure that cannot be an exact pair partition", async () => {
  const pairRegistry = await fixturePairRegistry();
  const registry = await loadCollectionGroupRegistry(pairRegistry);
  const invalidCandidates = [];

  const extraRootMember = structuredClone(registry);
  extraRootMember.measurements = [];
  invalidCandidates.push(extraRootMember);

  const extraGroupMember = structuredClone(registry);
  extraGroupMember.groups[0].schedule = "unused";
  invalidCandidates.push(extraGroupMember);

  const skippedGroupId = structuredClone(registry);
  skippedGroupId.groups[1].groupId = "group-3";
  invalidCandidates.push(skippedGroupId);

  const emptyGroup = structuredClone(registry);
  emptyGroup.groups[0].pairIds = [];
  invalidCandidates.push(emptyGroup);

  const omittedPair = structuredClone(registry);
  omittedPair.groups[0].pairIds.pop();
  invalidCandidates.push(omittedPair);

  const duplicatedPair = structuredClone(registry);
  duplicatedPair.groups[1].pairIds[0] = duplicatedPair.groups[0].pairIds[0];
  invalidCandidates.push(duplicatedPair);

  const unknownPair = structuredClone(registry);
  unknownPair.groups[2].pairIds[0] = `0x${"0".repeat(64)}`;
  invalidCandidates.push(unknownPair);

  for (const candidate of invalidCandidates) {
    assert.throws(() => admitCollectionGroupRegistry(candidate, pairRegistry));
  }
});

test("the group runner preserves order and isolates a non-abort pair failure", async () => {
  const pairRegistry = await fixturePairRegistry();
  const groupRegistry = await loadCollectionGroupRegistry(pairRegistry);
  const group = groupRegistry.groups[0];
  const calls = [];
  const result = await runCollectionGroup({
    pairRegistry,
    groupRegistry,
    groupId: group.groupId,
    runPair: async (pairId) => {
      calls.push(pairId);
      if (pairId === group.pairIds[1]) throw new Error("untrusted pair failure");
    },
  });
  assert.deepEqual(calls, group.pairIds);
  assert.deepEqual(result, {
    status: "failure",
    pairs: group.pairIds.map((pairId, index) => ({
      pairId,
      status: index === 1 ? "failure" : "success",
    })),
  });
  assert.doesNotMatch(JSON.stringify(result), /untrusted/);
});

test("malformed membership and abort stop before another pair operation starts", async () => {
  const pairRegistry = await fixturePairRegistry();
  const groupRegistry = await loadCollectionGroupRegistry(pairRegistry);
  const malformed = structuredClone(groupRegistry);
  malformed.groups[0].pairIds.pop();
  let calls = 0;
  await assert.rejects(runCollectionGroup({
    pairRegistry,
    groupRegistry: malformed,
    groupId: "group-1",
    runPair: async () => { calls += 1; },
  }));
  assert.equal(calls, 0);

  const controller = new AbortController();
  const started = [];
  await assert.rejects(runCollectionGroup({
    pairRegistry,
    groupRegistry,
    groupId: "group-1",
    signal: controller.signal,
    runPair: async (pairId) => {
      started.push(pairId);
      controller.abort(new Error("Operation cancelled."));
    },
  }), /Operation cancelled/);
  assert.deepEqual(started, [groupRegistry.groups[0].pairIds[0]]);
});

test("the group CLI passes unchanged pair, storage, environment, and signal inputs", async () => {
  const pairRegistry = await fixturePairRegistry();
  const groupRegistry = await loadCollectionGroupRegistry(pairRegistry);
  const group = groupRegistry.groups[1];
  const environment = { GITHUB_TOKEN: "test-token", INDEX_RPC_FALLBACK_URL_0: "https://rpc.example/key" };
  const controller = new AbortController();
  const calls = [];
  const summary = await runGroupCli([
    "repair",
    "--group", group.groupId,
    "--store", "github",
    "--repository", "owner/index",
  ], {
    environment,
    signal: controller.signal,
    pairMain: async (argv, context) => calls.push({ argv, context }),
  });
  assert.deepEqual(calls, group.pairIds.map((pairId) => ({
    argv: ["repair", "--pair", pairId, "--store", "github", "--repository", "owner/index"],
    context: { environment, signal: controller.signal },
  })));
  assert.deepEqual(summary, {
    ok: true,
    operation: "repair",
    groupId: group.groupId,
    result: {
      status: "success",
      pairs: group.pairIds.map((pairId) => ({ pairId, status: "success" })),
    },
  });
});

test("the group CLI admits only one exact operation, group, and storage boundary", () => {
  assert.deepEqual(parseGroupArguments([
    "collect", "--group", "group-1", "--store", "directory", "--root", "/tmp/index",
  ]), {
    operation: "collect",
    groupId: "group-1",
    store: "directory",
    root: "/tmp/index",
    repository: undefined,
  });
  assert.throws(() => parseGroupArguments(["verify", "--group", "group-1", "--store", "directory", "--root", "/tmp/index"]), /collect or repair/);
  assert.throws(() => parseGroupArguments(["collect", "--store", "directory", "--root", "/tmp/index"]), /--group/);
  assert.throws(() => parseGroupArguments(["collect", "--group", "group-1", "--store", "github", "--repository", "owner/index", "--root", "/tmp/index"]), /cannot cross/);
});
