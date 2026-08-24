import { decodeArtifact, encodeArtifact } from "./canonical.mjs";
import { parsePairFileLogicalId } from "./pair-file-identity.mjs";
import {
  validateCanonicalReference,
  validateResolutionReference,
} from "./pair-files.mjs";
import { pairById } from "./pair-registry.mjs";
import {
  StoredDataIntegrityError,
  validatePairId,
  validateStateIdentity,
} from "../storage/stored-files.mjs";

const phases = new Set(["current", "history", "repair"]);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function referenceIdentity(reference, maximumArtifactBytes) {
  const identity = parsePairFileLogicalId(reference.logicalId);
  if (identity.kind === "resolution") {
    validateResolutionReference(reference, { maximumArtifactBytes });
    return { pairId: identity.pairId, kind: identity.kind, ownerMonth: identity.period, intervalSeconds: identity.intervalSeconds };
  }
  validateCanonicalReference(reference, { maximumArtifactBytes });
  return { pairId: identity.pairId, kind: identity.kind, ownerMonth: identity.period.slice(0, 7) };
}

function referenceOrder(reference, maximumArtifactBytes) {
  const identity = referenceIdentity(reference, maximumArtifactBytes);
  const rank = identity.kind === "day" ? "0" : identity.kind === "resolution" ? "1" : "2";
  const member = identity.kind === "resolution"
    ? String(identity.intervalSeconds).padStart(12, "0")
    : reference.logicalId;
  return `${identity.ownerMonth}:${rank}:${member}`;
}

export function comparePublicationReferences(left, right, { registry }) {
  const maximumArtifactBytes = registry.collection.maximumArtifactBytes;
  return referenceOrder(left, maximumArtifactBytes).localeCompare(referenceOrder(right, maximumArtifactBytes));
}

function sameReferenceKind(left, right, maximumArtifactBytes) {
  const a = referenceIdentity(left, maximumArtifactBytes);
  const b = referenceIdentity(right, maximumArtifactBytes);
  return a.pairId === b.pairId && a.kind === b.kind && left.logicalId === right.logicalId;
}

export function validatePairPublicationManifest(value, { registry, expectedPairId } = {}) {
  exactKeys(value, [
    "kind",
    "nextState",
    "pairId",
    "phase",
    "previousState",
    "replacements",
  ], "pair publication manifest");
  if (value.kind !== "pair_publication") throw new Error("Pair publication manifest identity is invalid.");
  const pairId = validatePairId(value.pairId);
  pairById(registry, pairId);
  if (expectedPairId !== undefined && pairId !== expectedPairId) throw new Error("Pair publication manifest pair is invalid.");
  if (!phases.has(value.phase)) throw new Error("Pair publication manifest phase is invalid.");
  const nextState = validateStateIdentity(value.nextState);
  const previousState = value.previousState === null ? null : validateStateIdentity(value.previousState);
  if (previousState === null ? nextState.sequence !== 1 : nextState.sequence !== previousState.sequence + 1) {
    throw new Error("Pair publication state generations are not adjacent.");
  }
  if (!Array.isArray(value.replacements) || value.replacements.length < 2) throw new Error("Pair publication replacements are required.");

  const maximumArtifactBytes = registry.collection.maximumArtifactBytes;
  const logicalIds = new Set();
  const changedMonths = new Map();
  let previousOrder = "";
  let dayCount = 0;
  let monthCount = 0;
  for (const [index, replacement] of value.replacements.entries()) {
    exactKeys(replacement, ["next", "previous"], `pair publication replacement[${index}]`);
    const nextIdentity = referenceIdentity(replacement.next, maximumArtifactBytes);
    if (nextIdentity.pairId !== pairId || replacement.next.sequence !== nextState.sequence) {
      throw new Error("Pair publication next reference identity is invalid.");
    }
    const order = referenceOrder(replacement.next, maximumArtifactBytes);
    if (order <= previousOrder || logicalIds.has(replacement.next.logicalId)) {
      throw new Error("Pair publication replacements are duplicated or unordered.");
    }
    previousOrder = order;
    logicalIds.add(replacement.next.logicalId);
    if (nextIdentity.kind === "day") dayCount += 1;
    if (nextIdentity.kind === "month") {
      monthCount += 1;
      changedMonths.set(nextIdentity.ownerMonth, replacement);
    }
    if (replacement.previous === null) continue;
    if (previousState === null || !sameReferenceKind(replacement.previous, replacement.next, maximumArtifactBytes)) {
      throw new Error("Pair publication previous reference identity is invalid.");
    }
    if (replacement.previous.sequence > previousState.sequence) throw new Error("Pair publication previous reference is newer than its state.");
  }
  if (dayCount === 0 || monthCount === 0) throw new Error("Pair publication must replace a pair day and pair month.");
  for (const replacement of value.replacements) {
    const identity = referenceIdentity(replacement.next, maximumArtifactBytes);
    if (identity.kind === "day" || identity.kind === "resolution") {
      const parent = changedMonths.get(identity.ownerMonth);
      if (parent === undefined) throw new Error("Pair publication changed child has no changed parent month.");
      if (parent.previous === null && replacement.previous !== null) {
        throw new Error("A new pair publication month cannot replace an existing child.");
      }
    }
  }
  return value;
}

export function encodePairPublicationManifest(value, context) {
  const encoded = encodeArtifact(validatePairPublicationManifest(value, context));
  if (
    encoded.gzipBytes.byteLength > context.registry.collection.maximumArtifactBytes
    || encoded.jsonBytes.byteLength > context.registry.collection.maximumArtifactBytes
  ) {
    throw new Error("Pair publication manifest exceeds the artifact byte boundary.");
  }
  return encoded;
}

export function decodePairPublicationManifest(bytes, context) {
  try {
    const decoded = decodeArtifact(bytes, context.registry.collection.maximumArtifactBytes);
    return validatePairPublicationManifest(decoded.value, context);
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}
