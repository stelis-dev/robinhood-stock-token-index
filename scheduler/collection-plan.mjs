import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isCanonicalBytes32 } from "../collector/hex-data.mjs";
import { validatePairRegistry } from "../collector/pair-registry.mjs";

const collectionPlanUrl = new URL("../registry/collection-plan.json", import.meta.url);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}

export function estimatedPairRuntimeSeconds(capacity, measuredSeconds) {
  positiveInteger(measuredSeconds, "collection group member measuredSeconds");
  positiveInteger(capacity?.durationPaddingPercent, "collection duration padding");
  const numerator = measuredSeconds * (100 + capacity.durationPaddingPercent);
  if (!Number.isSafeInteger(numerator)) throw new Error("Estimated pair runtime exceeds the safe integer limit.");
  return Math.ceil(numerator / 100);
}

function scheduleExpression(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.split(/\s+/).length !== 5) {
    throw new Error("Collection schedule expression is invalid.");
  }
  return value;
}

export function validateCollectionPlan(candidate, pairRegistry) {
  const validPairRegistry = validatePairRegistry(pairRegistry);
  exactKeys(candidate, ["capacity", "groups"], "collection plan");
  exactKeys(candidate.capacity, [
    "durationPaddingPercent",
    "maximumGroupCount",
    "maximumGroupSeconds",
    "maximumPairsPerGroup",
  ], "collection capacity");
  for (const [key, value] of Object.entries(candidate.capacity)) positiveInteger(value, `collection capacity ${key}`);
  if (candidate.capacity.durationPaddingPercent > 100) throw new Error("Collection duration padding is invalid.");

  if (!Array.isArray(candidate.groups) || candidate.groups.length === 0 || candidate.groups.length > candidate.capacity.maximumGroupCount) {
    throw new Error("Collection group count exceeds the configured maximum.");
  }

  const knownPairIds = new Set(validPairRegistry.pairs.map((entry) => entry.pair.pairId));
  const assignedPairIds = new Set();
  const assignedSchedules = new Set();
  for (const [index, group] of candidate.groups.entries()) {
    exactKeys(group, ["groupId", "members", "schedules"], "collection group");
    if (group.groupId !== `group-${index + 1}`) throw new Error("Collection groups must use consecutive ordered IDs.");
    if (!Array.isArray(group.members) || group.members.length === 0 || group.members.length > candidate.capacity.maximumPairsPerGroup) {
      throw new Error("Collection group member count exceeds the configured maximum.");
    }
    if (!Array.isArray(group.schedules) || group.schedules.length === 0) {
      throw new Error("Collection group schedule membership is invalid.");
    }

    let estimatedRuntimeSeconds = 0;
    for (const member of group.members) {
      exactKeys(member, ["measuredSeconds", "pairId"], "collection group member");
      estimatedRuntimeSeconds += estimatedPairRuntimeSeconds(candidate.capacity, member.measuredSeconds);
      if (!Number.isSafeInteger(estimatedRuntimeSeconds) || estimatedRuntimeSeconds > candidate.capacity.maximumGroupSeconds) {
        throw new Error("Collection group estimated runtime exceeds the configured maximum.");
      }
      if (!isCanonicalBytes32(member.pairId) || !knownPairIds.has(member.pairId)) {
        throw new Error("Collection group contains an unknown pair.");
      }
      if (assignedPairIds.has(member.pairId)) throw new Error("Collection group pair membership is duplicated.");
      assignedPairIds.add(member.pairId);
    }

    for (const value of group.schedules) {
      const schedule = scheduleExpression(value);
      if (assignedSchedules.has(schedule)) throw new Error("Collection schedule expression is duplicated.");
      assignedSchedules.add(schedule);
    }
  }

  if (assignedPairIds.size !== knownPairIds.size) {
    throw new Error("Every registered pair must belong to exactly one collection group.");
  }
  return candidate;
}

export async function loadCollectionPlan(pairRegistry, path = fileURLToPath(collectionPlanUrl)) {
  return validateCollectionPlan(JSON.parse(await readFile(path, "utf8")), pairRegistry);
}

export function collectionGroupById(plan, groupId) {
  const group = plan.groups.find((candidate) => candidate.groupId === groupId);
  if (!group) throw new Error("Unknown collection group.");
  return group;
}

export function collectionGroupBySchedule(plan, schedule) {
  const group = plan.groups.find((candidate) => candidate.schedules.includes(schedule));
  if (!group) throw new Error("Unknown collection schedule.");
  return group;
}

export function collectionGroupPairIds(group) {
  return group.members.map((member) => member.pairId);
}

export function collectionGroupEstimatedRuntime(plan, group) {
  return group.members.reduce(
    (total, member) => total + estimatedPairRuntimeSeconds(plan.capacity, member.measuredSeconds),
    0,
  );
}
