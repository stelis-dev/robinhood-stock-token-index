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

function safeProduct(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds the safe integer limit.`);
  return value;
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

function cronValues(value, minimum, maximum, label) {
  const values = new Set();
  for (const part of value.split(",")) {
    const match = part.match(/^([0-9]+)(?:-([0-9]+)(?:\/([1-9][0-9]*))?)?$/);
    if (match === null) throw new Error(`Collection schedule ${label} field is invalid.`);
    const from = Number(match[1]);
    const until = match[2] === undefined ? from : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (from < minimum || until > maximum || from > until) throw new Error(`Collection schedule ${label} field is invalid.`);
    for (let candidate = from; candidate <= until; candidate += step) values.add(candidate);
  }
  return [...values].sort((left, right) => left - right);
}

function scheduleMinutes(value) {
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = scheduleExpression(value).split(/\s+/);
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    throw new Error("Collection schedules must run every UTC calendar day.");
  }
  const minutes = cronValues(minuteField, 0, 59, "minute");
  const hours = cronValues(hourField, 0, 23, "hour");
  return hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
}

export function collectionPlanGithubLoad(plan) {
  const pairCommandsByMinute = Array(1_440).fill(0);
  for (const group of plan.groups) {
    for (const schedule of group.schedules) {
      for (const minute of scheduleMinutes(schedule)) pairCommandsByMinute[minute] += group.members.length;
    }
  }
  let maximumPairCommandsPerHour = 0;
  for (let start = 0; start < pairCommandsByMinute.length; start += 1) {
    let count = 0;
    for (let offset = 0; offset < 60; offset += 1) count += pairCommandsByMinute[(start + offset) % pairCommandsByMinute.length];
    maximumPairCommandsPerHour = Math.max(maximumPairCommandsPerHour, count);
  }
  const estimatedRequestsPerHour = safeProduct(
    maximumPairCommandsPerHour,
    plan.capacity.github.estimatedRequestsPerPairCollect,
    "Estimated GitHub requests per hour",
  );
  const estimatedContentRequestsPerHour = safeProduct(
    maximumPairCommandsPerHour,
    plan.capacity.github.estimatedContentRequestsPerPairCollect,
    "Estimated GitHub content requests per hour",
  );
  return {
    maximumPairCommandsPerHour,
    estimatedRequestsPerHour,
    estimatedContentRequestsPerHour,
    maximumPacedContentRequestsPerMinute: Math.ceil(60_000 / githubMutationIntervalMilliseconds(plan)),
  };
}

export function githubMutationIntervalMilliseconds(plan) {
  positiveInteger(plan?.capacity?.github?.maximumContentRequestsPerMinute, "GitHub content request minute capacity");
  return Math.floor(60_000 / plan.capacity.github.maximumContentRequestsPerMinute) + 1;
}

function githubGroupPacingSeconds(plan, pairCount) {
  positiveInteger(pairCount, "collection group pair count");
  const contentRequests = safeProduct(
    pairCount,
    plan.capacity.github.estimatedContentRequestsPerPairCollect,
    "Estimated GitHub group content requests",
  );
  const pacingMilliseconds = safeProduct(
    Math.max(0, contentRequests - 1),
    githubMutationIntervalMilliseconds(plan),
    "Estimated GitHub group pacing duration",
  );
  return Math.ceil(pacingMilliseconds / 1_000);
}

export function validateCollectionPlan(candidate, pairRegistry) {
  const validPairRegistry = validatePairRegistry(pairRegistry);
  exactKeys(candidate, ["capacity", "groups"], "collection plan");
  exactKeys(candidate.capacity, [
    "durationPaddingPercent",
    "github",
    "maximumGroupCount",
    "maximumGroupSeconds",
    "maximumPairsPerGroup",
  ], "collection capacity");
  for (const key of ["durationPaddingPercent", "maximumGroupCount", "maximumGroupSeconds", "maximumPairsPerGroup"]) {
    positiveInteger(candidate.capacity[key], `collection capacity ${key}`);
  }
  exactKeys(candidate.capacity.github, [
    "estimatedContentRequestsPerPairCollect",
    "estimatedRequestsPerPairCollect",
    "maximumContentRequestsPerHour",
    "maximumContentRequestsPerMinute",
    "maximumRequestsPerHour",
  ], "collection GitHub capacity");
  for (const [key, value] of Object.entries(candidate.capacity.github)) positiveInteger(value, `collection GitHub capacity ${key}`);
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

    for (const member of group.members) {
      exactKeys(member, ["measuredSeconds", "pairId"], "collection group member");
      estimatedPairRuntimeSeconds(candidate.capacity, member.measuredSeconds);
      if (!isCanonicalBytes32(member.pairId) || !knownPairIds.has(member.pairId)) {
        throw new Error("Collection group contains an unknown pair.");
      }
      if (assignedPairIds.has(member.pairId)) throw new Error("Collection group pair membership is duplicated.");
      assignedPairIds.add(member.pairId);
    }
    if (collectionGroupEstimatedRuntime(candidate, group) > candidate.capacity.maximumGroupSeconds) {
      throw new Error("Collection group estimated runtime exceeds the configured maximum.");
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
  const githubLoad = collectionPlanGithubLoad(candidate);
  if (
    githubLoad.estimatedRequestsPerHour > candidate.capacity.github.maximumRequestsPerHour
    || githubLoad.estimatedContentRequestsPerHour > candidate.capacity.github.maximumContentRequestsPerHour
    || githubLoad.maximumPacedContentRequestsPerMinute > candidate.capacity.github.maximumContentRequestsPerMinute
  ) {
    throw new Error("Collection schedule exceeds the configured GitHub request capacity.");
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
  const pairRuntime = group.members.reduce(
    (total, member) => total + estimatedPairRuntimeSeconds(plan.capacity, member.measuredSeconds),
    0,
  );
  const total = pairRuntime + githubGroupPacingSeconds(plan, group.members.length);
  if (!Number.isSafeInteger(total)) throw new Error("Collection group estimated runtime exceeds the safe integer limit.");
  return total;
}
