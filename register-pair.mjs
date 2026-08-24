#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePairRegistry } from "./collector/pair-registry.mjs";
import {
  estimatedPairRuntimeSeconds,
  validateCollectionPlan,
  collectionGroupEstimatedRuntime,
  collectionPlanGithubLoad,
} from "./scheduler/collection-plan.mjs";

const defaultPairRegistryPath = new URL("./registry/pairs.json", import.meta.url);
const defaultCollectionPlanPath = new URL("./registry/collection-plan.json", import.meta.url);
const valueFlags = new Set(["--candidate", "--measured-seconds"]);

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}

function parsePositiveInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid.`);
  const parsed = Number(value);
  positiveInteger(parsed, label);
  return parsed;
}

export function parseRegistrationArguments(argv) {
  if (argv.length === 1 && argv[0] === "--status") return { mode: "status", write: false };
  const values = {};
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") {
      if (write) throw new Error("Pair registration option is duplicated.");
      write = true;
      continue;
    }
    if (!valueFlags.has(flag) || flag in values) throw new Error("Pair registration option is invalid.");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error("Pair registration option requires one value.");
    }
    values[flag] = value;
    index += 1;
  }
  if (!values["--candidate"] || !values["--measured-seconds"]) {
    throw new Error("Pair registration requires --candidate and --measured-seconds.");
  }
  return {
    candidatePath: values["--candidate"],
    measuredSeconds: parsePositiveInteger(values["--measured-seconds"], "Measured pair duration"),
    mode: "candidate",
    write,
  };
}

export function registrationCapacity(collectionPlan) {
  return {
    durationPaddingPercent: collectionPlan.capacity.durationPaddingPercent,
    github: {
      ...collectionPlan.capacity.github,
      ...collectionPlanGithubLoad(collectionPlan),
    },
    groupCount: collectionPlan.groups.length,
    groups: collectionPlan.groups.map((group) => {
      const estimatedRuntimeSeconds = collectionGroupEstimatedRuntime(collectionPlan, group);
      return {
        estimatedRuntimeSeconds,
        groupId: group.groupId,
        pairCount: group.members.length,
        remainingPairSlots: collectionPlan.capacity.maximumPairsPerGroup - group.members.length,
        remainingSeconds: collectionPlan.capacity.maximumGroupSeconds - estimatedRuntimeSeconds,
      };
    }),
    maximumGroupCount: collectionPlan.capacity.maximumGroupCount,
    maximumGroupSeconds: collectionPlan.capacity.maximumGroupSeconds,
    maximumPairsPerGroup: collectionPlan.capacity.maximumPairsPerGroup,
    remainingGroupSlots: collectionPlan.capacity.maximumGroupCount - collectionPlan.groups.length,
  };
}

export function planPairRegistration({ pairRegistry, collectionPlan, candidate, measuredSeconds }) {
  const validPairRegistry = validatePairRegistry(pairRegistry);
  const validCollectionPlan = validateCollectionPlan(collectionPlan, validPairRegistry);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Pair registration candidate must be one registry entry.");
  }
  const pairId = candidate?.pair?.pairId;
  if (validPairRegistry.pairs.some((entry) => entry.pair.pairId === pairId)) {
    throw new Error("Pair registration candidate already exists.");
  }

  const nextPairRegistry = structuredClone(validPairRegistry);
  nextPairRegistry.pairs.push(structuredClone(candidate));
  nextPairRegistry.pairs.sort((left, right) => left.pair.pairId < right.pair.pairId ? -1 : left.pair.pairId > right.pair.pairId ? 1 : 0);
  validatePairRegistry(nextPairRegistry);

  positiveInteger(measuredSeconds, "Measured pair duration");
  const estimatedRuntimeSeconds = estimatedPairRuntimeSeconds(validCollectionPlan.capacity, measuredSeconds);
  const candidates = validCollectionPlan.groups
    .map((group, index) => ({
      group,
      index,
      currentSeconds: collectionGroupEstimatedRuntime(validCollectionPlan, group),
      nextSeconds: collectionGroupEstimatedRuntime(validCollectionPlan, {
        ...group,
        members: [...group.members, { measuredSeconds, pairId }],
      }),
    }))
    .filter(({ group, nextSeconds }) => (
      group.members.length < validCollectionPlan.capacity.maximumPairsPerGroup
      && nextSeconds <= validCollectionPlan.capacity.maximumGroupSeconds
    ))
    .sort((left, right) => left.currentSeconds - right.currentSeconds || left.index - right.index);
  if (candidates.length === 0) {
    throw new Error("Current collection groups have no capacity for another pair.");
  }

  const selected = candidates[0];
  const nextCollectionPlan = structuredClone(validCollectionPlan);
  nextCollectionPlan.groups[selected.index].members.push({ measuredSeconds, pairId });
  validateCollectionPlan(nextCollectionPlan, nextPairRegistry);

  return {
    pairRegistry: nextPairRegistry,
    collectionPlan: nextCollectionPlan,
    result: {
      estimatedRuntimeSeconds,
      groupEstimatedRuntimeSeconds: selected.nextSeconds,
      groupId: selected.group.groupId,
      measuredSeconds,
      pairId,
    },
  };
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function replaceRegistries({
  pairRegistryPath,
  collectionPlanPath,
  originalPairBytes,
  pairRegistry,
  collectionPlan,
}) {
  const suffix = `.registration-${process.pid}-${Date.now()}`;
  const pairTemporaryPath = `${pairRegistryPath}${suffix}`;
  const planTemporaryPath = `${collectionPlanPath}${suffix}`;
  await writeFile(pairTemporaryPath, jsonBytes(pairRegistry), { encoding: "utf8", flag: "wx" });
  let pairReplaced = false;
  try {
    await writeFile(planTemporaryPath, jsonBytes(collectionPlan), { encoding: "utf8", flag: "wx" });
    await rename(pairTemporaryPath, pairRegistryPath);
    pairReplaced = true;
    await rename(planTemporaryPath, collectionPlanPath);
  } catch (error) {
    if (pairReplaced) await writeFile(pairRegistryPath, originalPairBytes, "utf8");
    throw error;
  } finally {
    await Promise.allSettled([unlink(pairTemporaryPath), unlink(planTemporaryPath)]);
  }
}

export async function main(argv, {
  pairRegistryPath = defaultPairRegistryPath,
  collectionPlanPath = defaultCollectionPlanPath,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const options = parseRegistrationArguments(argv);
  const pairPath = pairRegistryPath instanceof URL ? fileURLToPath(pairRegistryPath) : pairRegistryPath;
  const planPath = collectionPlanPath instanceof URL ? fileURLToPath(collectionPlanPath) : collectionPlanPath;
  const [pairRegistrySource, collectionPlanSource] = await Promise.all([
    readFile(pairPath, "utf8"),
    readFile(planPath, "utf8"),
  ]);
  const pairRegistry = validatePairRegistry(JSON.parse(pairRegistrySource));
  const collectionPlan = validateCollectionPlan(JSON.parse(collectionPlanSource), pairRegistry);
  if (options.mode === "status") {
    const envelope = { ok: true, operation: "register-pair", status: "capacity", result: registrationCapacity(collectionPlan) };
    writeOutput(`${JSON.stringify(envelope)}\n`);
    return envelope;
  }
  const candidateSource = await readFile(options.candidatePath, "utf8");
  const planned = planPairRegistration({
    pairRegistry,
    collectionPlan,
    candidate: JSON.parse(candidateSource),
    measuredSeconds: options.measuredSeconds,
  });
  if (options.write) {
    await replaceRegistries({
      pairRegistryPath: pairPath,
      collectionPlanPath: planPath,
      originalPairBytes: pairRegistrySource,
      pairRegistry: planned.pairRegistry,
      collectionPlan: planned.collectionPlan,
    });
  }
  const envelope = { ok: true, operation: "register-pair", status: options.write ? "written" : "dry-run", result: planned.result };
  writeOutput(`${JSON.stringify(envelope)}\n`);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
