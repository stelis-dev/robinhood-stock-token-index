import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { admitPairRegistry } from "../collector/pair-registry.mjs";

const groupRegistryUrl = new URL("../registry/collection-groups.json", import.meta.url);
const pairIdPattern = /^0x[0-9a-f]{64}$/;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

export function admitCollectionGroupRegistry(candidate, pairRegistry) {
  const admittedPairs = admitPairRegistry(pairRegistry);
  exactKeys(candidate, ["groups"], "collection group registry");
  if (!Array.isArray(candidate.groups) || candidate.groups.length === 0) {
    throw new Error("Collection group count is invalid.");
  }

  const knownPairIds = new Set(admittedPairs.pairs.map((entry) => entry.pair.pairId));
  const assignedPairIds = new Set();
  for (const [index, group] of candidate.groups.entries()) {
    exactKeys(group, ["groupId", "pairIds"], "collection group");
    if (group.groupId !== `group-${index + 1}`) {
      throw new Error("Collection groups must use consecutive ordered IDs.");
    }
    if (!Array.isArray(group.pairIds) || group.pairIds.length === 0) {
      throw new Error("Collection group pair membership is invalid.");
    }
    for (const pairId of group.pairIds) {
      if (typeof pairId !== "string" || !pairIdPattern.test(pairId) || !knownPairIds.has(pairId)) {
        throw new Error("Collection group contains an unknown pair.");
      }
      if (assignedPairIds.has(pairId)) {
        throw new Error("Collection group pair membership is duplicated.");
      }
      assignedPairIds.add(pairId);
    }
  }

  if (assignedPairIds.size !== knownPairIds.size) {
    throw new Error("Collection groups must partition every admitted pair exactly once.");
  }
  return candidate;
}

export async function loadCollectionGroupRegistry(pairRegistry, path = fileURLToPath(groupRegistryUrl)) {
  return admitCollectionGroupRegistry(JSON.parse(await readFile(path, "utf8")), pairRegistry);
}

export function collectionGroupById(registry, groupId) {
  const group = registry.groups.find((candidate) => candidate.groupId === groupId);
  if (!group) throw new Error("Unknown collection group.");
  return group;
}
