import { admitCollectionGroupRegistry, collectionGroupById } from "./collection-group-registry.mjs";

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation cancelled.");
}

export async function runCollectionGroup({
  pairRegistry,
  groupRegistry,
  groupId,
  runPair,
  signal,
}) {
  if (typeof runPair !== "function") throw new Error("Group pair operation is invalid.");
  const admittedGroups = admitCollectionGroupRegistry(groupRegistry, pairRegistry);
  const group = collectionGroupById(admittedGroups, groupId);
  const pairs = [];
  for (const pairId of group.pairIds) {
    throwIfAborted(signal);
    try {
      await runPair(pairId);
      pairs.push({ pairId, status: "success" });
    } catch {
      throwIfAborted(signal);
      pairs.push({ pairId, status: "failure" });
    }
  }
  return {
    status: pairs.every((pair) => pair.status === "success") ? "success" : "failure",
    pairs,
  };
}
