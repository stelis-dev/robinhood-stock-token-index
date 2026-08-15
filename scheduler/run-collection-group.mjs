import { validateCollectionPlan, collectionGroupById, collectionGroupPairIds } from "./collection-plan.mjs";

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation cancelled.");
}

export async function runCollectionGroup({
  pairRegistry,
  collectionPlan,
  groupId,
  runPair,
  signal,
}) {
  if (typeof runPair !== "function") throw new Error("Group pair operation is invalid.");
  const validatedPlan = validateCollectionPlan(collectionPlan, pairRegistry);
  const group = collectionGroupById(validatedPlan, groupId);
  const pairs = [];
  for (const pairId of collectionGroupPairIds(group)) {
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
