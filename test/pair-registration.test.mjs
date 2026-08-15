import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { derivePoolId } from "../collector/pool-key.mjs";
import { validatePairRegistry } from "../collector/pair-registry.mjs";
import {
  main as registerPair,
  parseRegistrationArguments,
  planPairRegistration,
  registrationCapacity,
} from "../register-pair.mjs";
import { estimatedPairRuntimeSeconds, validateCollectionPlan, loadCollectionPlan } from "../scheduler/collection-plan.mjs";
import { fixturePairRegistry } from "./pair-fixtures.mjs";

function novelCandidate(registry) {
  const candidate = structuredClone(registry.pairs[0]);
  const address = "0x1111111111111111111111111111111111111111";
  candidate.pair.baseAsset.address = address;
  candidate.pair.baseIsCurrency0 = true;
  candidate.pair.poolKey.currency0 = address;
  candidate.pair.poolKey.currency1 = candidate.pair.quoteAsset.address;
  candidate.pair.pairId = derivePoolId(candidate.pair.poolKey);
  candidate.display.baseName = "Registration test asset";
  candidate.display.baseSymbol = "TEST";
  candidate.display.label = "TEST/USDG";
  return candidate;
}

async function registrationFixture() {
  const completePairRegistry = await fixturePairRegistry();
  const completeCollectionPlan = await loadCollectionPlan(completePairRegistry);
  const candidate = structuredClone(completePairRegistry.pairs.at(-1));
  const pairRegistry = structuredClone(completePairRegistry);
  pairRegistry.pairs.pop();
  const collectionPlan = structuredClone(completeCollectionPlan);
  for (const group of collectionPlan.groups) {
    group.members = group.members.filter((member) => member.pairId !== candidate.pair.pairId);
  }
  return { candidate, collectionPlan, pairRegistry };
}

test("registration arguments use one safety-margin calculation and default to a dry run", () => {
  assert.deepEqual(parseRegistrationArguments(["--status"]), { mode: "status", write: false });
  assert.deepEqual(parseRegistrationArguments([
    "--candidate", "/tmp/pair.json", "--measured-seconds", "145",
  ]), {
    candidatePath: "/tmp/pair.json",
    measuredSeconds: 145,
    mode: "candidate",
    write: false,
  });
  assert.equal(estimatedPairRuntimeSeconds({ durationPaddingPercent: 25 }, 145), 182);
  assert.equal(parseRegistrationArguments([
    "--candidate", "/tmp/pair.json", "--measured-seconds", "145", "--write",
  ]).write, true);
  assert.throws(() => parseRegistrationArguments(["--candidate", "/tmp/pair.json"]), /requires/);
  assert.throws(() => parseRegistrationArguments([
    "--candidate", "/tmp/pair.json", "--measured-seconds", "0",
  ]), /invalid/);
});

test("registration reports capacity calculated from the validated collection plan", async () => {
  const pairRegistry = await fixturePairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  assert.deepEqual(registrationCapacity(collectionPlan), {
    durationPaddingPercent: 25,
    groupCount: 3,
    groups: [
      { estimatedRuntimeSeconds: 582, groupId: "group-1", pairCount: 3, remainingPairSlots: 0, remainingSeconds: 138 },
      { estimatedRuntimeSeconds: 599, groupId: "group-2", pairCount: 3, remainingPairSlots: 0, remainingSeconds: 121 },
      { estimatedRuntimeSeconds: 589, groupId: "group-3", pairCount: 3, remainingPairSlots: 0, remainingSeconds: 131 },
    ],
    maximumGroupCount: 3,
    maximumGroupSeconds: 720,
    maximumPairsPerGroup: 3,
    remainingGroupSlots: 0,
  });
});

test("registration selects the eligible group with the lowest estimated runtime and cannot create capacity", async () => {
  const fixture = await registrationFixture();
  const planned = planPairRegistration({ ...fixture, measuredSeconds: 145 });
  assert.deepEqual(planned.result, {
    estimatedRuntimeSeconds: 182,
    groupEstimatedRuntimeSeconds: 599,
    groupId: "group-2",
    measuredSeconds: 145,
    pairId: fixture.candidate.pair.pairId,
  });
  assert.equal(planned.pairRegistry.pairs.at(-1).pair.pairId, fixture.candidate.pair.pairId);
  assert.deepEqual(planned.collectionPlan.groups[1].members.at(-1), {
    measuredSeconds: 145,
    pairId: fixture.candidate.pair.pairId,
  });

  const fullPairRegistry = await fixturePairRegistry();
  const fullCollectionPlan = await loadCollectionPlan(fullPairRegistry);
  assert.throws(() => planPairRegistration({
    pairRegistry: fullPairRegistry,
    collectionPlan: fullCollectionPlan,
    candidate: novelCandidate(fullPairRegistry),
    measuredSeconds: 145,
  }), /no capacity for another pair/);
  assert.throws(() => planPairRegistration({
    pairRegistry: fullPairRegistry,
    collectionPlan: fullCollectionPlan,
    candidate: fullPairRegistry.pairs[0],
    measuredSeconds: 145,
  }), /already exists/);
});

test("a dry run changes no registry and --write replaces both validated registries", async () => {
  const fixture = await registrationFixture();
  const root = await mkdtemp(join(tmpdir(), "pair-registration-"));
  const pairRegistryPath = join(root, "pairs.json");
  const collectionPlanPath = join(root, "collection-plan.json");
  const candidatePath = join(root, "candidate.json");
  const pairBytes = `${JSON.stringify(fixture.pairRegistry, null, 2)}\n`;
  const planBytes = `${JSON.stringify(fixture.collectionPlan, null, 2)}\n`;
  await Promise.all([
    writeFile(pairRegistryPath, pairBytes),
    writeFile(collectionPlanPath, planBytes),
    writeFile(candidatePath, `${JSON.stringify(fixture.candidate, null, 2)}\n`),
  ]);

  const output = [];
  await registerPair([
    "--candidate", candidatePath, "--measured-seconds", "145",
  ], { pairRegistryPath, collectionPlanPath, writeOutput: (line) => output.push(line) });
  assert.equal(await readFile(pairRegistryPath, "utf8"), pairBytes);
  assert.equal(await readFile(collectionPlanPath, "utf8"), planBytes);
  assert.match(output[0], /"status":"dry-run"/);

  await registerPair([
    "--candidate", candidatePath, "--measured-seconds", "145", "--write",
  ], { pairRegistryPath, collectionPlanPath, writeOutput: (line) => output.push(line) });
  const writtenPairs = JSON.parse(await readFile(pairRegistryPath, "utf8"));
  const writtenPlan = JSON.parse(await readFile(collectionPlanPath, "utf8"));
  validatePairRegistry(writtenPairs);
  validateCollectionPlan(writtenPlan, writtenPairs);
  assert.equal(writtenPairs.pairs.some((entry) => entry.pair.pairId === fixture.candidate.pair.pairId), true);
  assert.equal(writtenPlan.groups[1].members.at(-1).pairId, fixture.candidate.pair.pairId);
  assert.match(output[1], /"status":"written"/);
});
