import { canonicalBytes, decodeArtifact, encodeArtifact } from "./canonical.mjs";
import {
  decodePairDay,
  decodePairMonth,
  decodePairState,
} from "./pair-artifact.mjs";
import { readPairStateSelection } from "./pair-reader.mjs";
import { pairById } from "./pair-registry.mjs";
import {
  createStateIdentity,
  parseStoredReferenceId,
  StoredDataIntegrityError,
  validatePairId,
  validateStateIdentity,
  validateStoredReference,
} from "../storage/stored-files.mjs";

const phases = new Set(["current", "history", "repair"]);

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function referenceOrder(reference) {
  const identity = parseStoredReferenceId(reference.logicalId);
  return `${identity.kind === "day" ? "0" : "1"}:${reference.logicalId}`;
}

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function sameStateIdentity(left, right) {
  return left.sequence === right.sequence
    && left.gzipBytes === right.gzipBytes
    && left.gzipSha256 === right.gzipSha256;
}

function admitStored(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}

function stateIdentityFromSelection(selection) {
  return selection === null ? null : selection.identity;
}

function validateReference(reference, { pairId, maximumArtifactBytes, sequence, label }) {
  const identity = validateStoredReference(reference);
  if (identity.pairId !== pairId || reference.sequence !== sequence) throw new Error(`${label} identity is invalid.`);
  if (reference.gzipBytes > maximumArtifactBytes || reference.jsonBytes > maximumArtifactBytes) {
    throw new Error(`${label} exceeds the stored-file byte boundary.`);
  }
  return identity;
}

export function validatePublicationManifest(value, { registry, expectedPairId } = {}) {
  exactKeys(value, [
    "contractVersion",
    "kind",
    "nextState",
    "pairId",
    "phase",
    "previousState",
    "replacements",
  ], "publication manifest");
  if (value.contractVersion !== "1" || value.kind !== "pair_publication") throw new Error("Publication manifest identity is invalid.");
  const pairId = validatePairId(value.pairId);
  pairById(registry, pairId);
  if (expectedPairId !== undefined && pairId !== expectedPairId) throw new Error("Publication manifest pair is invalid.");
  if (!phases.has(value.phase)) throw new Error("Publication phase is invalid.");
  const nextState = validateStateIdentity(value.nextState);
  const previousState = value.previousState === null ? null : validateStateIdentity(value.previousState);
  if (previousState === null ? nextState.sequence !== 1 : nextState.sequence !== previousState.sequence + 1) {
    throw new Error("Publication state generations are not adjacent.");
  }
  if (!Array.isArray(value.replacements) || value.replacements.length < 2) throw new Error("Publication replacements are required.");

  const maximumArtifactBytes = registry.collection.maximumArtifactBytes;
  const logicalIds = new Set();
  let previousOrder = "";
  let dayCount = 0;
  let monthCount = 0;
  const replacementsByLogicalId = new Map();
  for (const [index, replacement] of value.replacements.entries()) {
    exactKeys(replacement, ["next", "previous"], `publication replacement[${index}]`);
    const nextIdentity = validateReference(replacement.next, {
      pairId,
      maximumArtifactBytes,
      sequence: nextState.sequence,
      label: "Publication next reference",
    });
    const order = referenceOrder(replacement.next);
    if (order <= previousOrder || logicalIds.has(replacement.next.logicalId)) throw new Error("Publication replacements are duplicated or unordered.");
    previousOrder = order;
    logicalIds.add(replacement.next.logicalId);
    replacementsByLogicalId.set(replacement.next.logicalId, replacement);
    if (nextIdentity.kind === "day") dayCount += 1;
    else monthCount += 1;

    if (replacement.previous === null) continue;
    if (previousState === null) throw new Error("A first publication cannot replace a previous reference.");
    const previousIdentity = validateStoredReference(replacement.previous);
    if (
      previousIdentity.pairId !== pairId
      || previousIdentity.kind !== nextIdentity.kind
      || replacement.previous.logicalId !== replacement.next.logicalId
      || replacement.previous.sequence > previousState.sequence
      || replacement.previous.gzipBytes > maximumArtifactBytes
      || replacement.previous.jsonBytes > maximumArtifactBytes
    ) {
      throw new Error("Publication previous reference is invalid.");
    }
  }
  if (dayCount === 0 || monthCount === 0) throw new Error("Publication must replace at least one pair day and pair month.");
  for (const replacement of value.replacements) {
    const identity = parseStoredReferenceId(replacement.next.logicalId);
    if (identity.kind !== "day") continue;
    const monthLogicalId = `pairs/${pairId}/months/${identity.period.slice(0, 7)}`;
    const monthReplacement = replacementsByLogicalId.get(monthLogicalId);
    if (monthReplacement === undefined) throw new Error("Publication day has no changed parent month.");
    if (monthReplacement.previous === null && replacement.previous !== null) {
      throw new Error("A new publication month cannot replace an existing day.");
    }
  }
  return value;
}

export function encodePublicationManifest(value, context) {
  const validated = validatePublicationManifest(value, context);
  const encoded = encodeArtifact(validated);
  if (
    encoded.gzipBytes.byteLength === 0
    || encoded.gzipBytes.byteLength > context.registry.collection.maximumArtifactBytes
    || encoded.jsonBytes.byteLength > context.registry.collection.maximumArtifactBytes
  ) {
    throw new Error("Publication manifest exceeds the stored-file byte boundary.");
  }
  return encoded;
}

export function decodePublicationManifest(bytes, context) {
  try {
    const decoded = decodeArtifact(bytes, context.registry.collection.maximumArtifactBytes);
    return validatePublicationManifest(decoded.value, context);
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}

function exactReference(references, expected) {
  const found = references.find((reference) => reference.logicalId === expected.logicalId);
  if (found === undefined || !sameValue(found, expected)) throw new Error("Publication reference is not present in its parent file.");
  return found;
}

function createManifest({ registry, pair, previousSelection, phase, replacement }) {
  const previousState = stateIdentityFromSelection(previousSelection);
  const nextState = createStateIdentity(
    replacement.state.sequence,
    replacement.encodedState.gzipBytes,
    registry.collection.maximumArtifactBytes,
  );
  const entries = [...replacement.encodedDays, ...replacement.encodedMonths]
    .map((entry) => ({ next: entry.reference, previous: entry.previousReference }))
    .sort((left, right) => referenceOrder(left.next).localeCompare(referenceOrder(right.next)));
  const manifest = {
    contractVersion: "1",
    kind: "pair_publication",
    pairId: pair.pairId,
    phase,
    previousState,
    nextState,
    replacements: entries,
  };

  const nextMonthReferences = replacement.encodedMonths.map((entry) => entry.reference);
  const stateChangedMonths = replacement.state.months.filter((reference) => reference.sequence === nextState.sequence);
  if (!sameValue(stateChangedMonths, nextMonthReferences)) {
    throw new Error("Publication state changed months do not match the replacement.");
  }

  for (const entry of replacement.encodedMonths) {
    exactReference(replacement.state.months, entry.reference);
    const nextDayEntries = replacement.encodedDays.filter((candidate) => (
      parseStoredReferenceId(candidate.reference.logicalId).period.startsWith(entry.value.month)
    ));
    const monthChangedDays = entry.value.days.filter((reference) => reference.sequence === nextState.sequence);
    if (!sameValue(monthChangedDays, nextDayEntries.map((dayEntry) => dayEntry.reference))) {
      throw new Error("Publication month changed days do not match the replacement.");
    }
    for (const dayEntry of nextDayEntries) {
      exactReference(entry.value.days, dayEntry.reference);
    }
    if (entry.previousReference !== null) {
      if (previousSelection === null || entry.previousValue === null) throw new Error("Publication previous month is unavailable.");
      exactReference(previousSelection.state.months, entry.previousReference);
    }
  }
  for (const entry of replacement.encodedDays) {
    if (entry.previousReference === null) continue;
    const dayPeriod = parseStoredReferenceId(entry.reference.logicalId).period;
    const month = replacement.encodedMonths.find((candidate) => dayPeriod.startsWith(candidate.value.month));
    if (month?.previousValue === null || month === undefined) throw new Error("Publication previous day parent is unavailable.");
    exactReference(month.previousValue.days, entry.previousReference);
  }
  validatePublicationManifest(manifest, { registry, expectedPairId: pair.pairId });
  return { manifest, encoded: encodePublicationManifest(manifest, { registry, expectedPairId: pair.pairId }) };
}

function selectedMatches(selection, identity) {
  return selection !== null && sameStateIdentity(selection.identity, identity);
}

async function proveChangedClosure({ registry, store, selection, manifest, side }) {
  const expectedState = side === "next" ? manifest.nextState : manifest.previousState;
  if (expectedState === null || !selectedMatches(selection, expectedState)) throw new StoredDataIntegrityError();
  const monthReplacements = manifest.replacements.filter((entry) => parseStoredReferenceId(entry.next.logicalId).kind === "month");
  const dayReplacements = new Map(manifest.replacements
    .filter((entry) => parseStoredReferenceId(entry.next.logicalId).kind === "day")
    .map((entry) => [(side === "next" ? entry.next : entry.previous)?.logicalId, side === "next" ? entry.next : entry.previous])
    .filter(([logicalId]) => logicalId !== undefined));
  const admittedDayIds = new Set();

  if (side === "next") {
    const selectedChangedMonths = selection.state.months.filter((reference) => reference.sequence === manifest.nextState.sequence);
    const manifestChangedMonths = monthReplacements.map((replacement) => replacement.next);
    if (!sameValue(selectedChangedMonths, manifestChangedMonths)) throw new StoredDataIntegrityError();
  }

  for (const replacement of monthReplacements) {
    const reference = side === "next" ? replacement.next : replacement.previous;
    if (reference === null) continue;
    admitStored(() => exactReference(selection.state.months, reference));
    const bytes = await store.readReferenced(reference);
    const month = admitStored(() => decodePairMonth(bytes, { registry }, reference));
    if (side === "next") {
      const expectedChangedDays = [...dayReplacements.values()]
        .filter((dayReference) => parseStoredReferenceId(dayReference.logicalId).period.startsWith(month.month));
      const selectedChangedDays = month.days.filter((dayReference) => dayReference.sequence === manifest.nextState.sequence);
      if (!sameValue(selectedChangedDays, expectedChangedDays)) throw new StoredDataIntegrityError();
    }
    for (const dayReference of month.days) {
      await store.proveReferenced(dayReference);
      const expectedDay = dayReplacements.get(dayReference.logicalId);
      if (expectedDay !== undefined) {
        if (!sameValue(expectedDay, dayReference)) throw new StoredDataIntegrityError();
        admittedDayIds.add(dayReference.logicalId);
      }
    }
  }
  if (admittedDayIds.size !== dayReplacements.size) throw new StoredDataIntegrityError();
}

async function abortPublication({ registry, pairId, store, pending, manifest, selected }) {
  if (manifest.previousState !== null) {
    await proveChangedClosure({ registry, store, selection: selected, manifest, side: "previous" });
  }
  await store.removeState(pairId, manifest.nextState, { allowIncomplete: true });
  for (const replacement of [...manifest.replacements].reverse()) {
    await store.removeReferenced(replacement.next, { allowIncomplete: true });
  }
  await store.removePublication(pairId, pending.gzipBytes);
  return { status: "aborted", pairId, phase: manifest.phase, selectedSequence: manifest.previousState?.sequence ?? null };
}

async function commitPublication({ registry, pairId, store, pending, manifest, selected }) {
  await proveChangedClosure({ registry, store, selection: selected, manifest, side: "next" });
  for (const replacement of manifest.replacements) {
    if (replacement.previous !== null) await store.removeReferenced(replacement.previous);
  }
  if (manifest.previousState !== null) await store.removeState(pairId, manifest.previousState);
  await store.removePublication(pairId, pending.gzipBytes);
  return { status: "committed", pairId, phase: manifest.phase, selectedSequence: manifest.nextState.sequence };
}

export async function recoverPairPublication({ registry, pairId, store }) {
  pairById(registry, pairId);
  const pending = await store.readPublication(pairId);
  if (pending.status === "absent") return { status: "idle", pairId };
  if (pending.status === "starter") {
    await store.removePublicationStarter(pairId);
    return { status: "aborted", pairId, phase: null, selectedSequence: null };
  }
  if (pending.status !== "uploaded" || !Buffer.isBuffer(pending.gzipBytes)) throw new StoredDataIntegrityError();
  const manifest = decodePublicationManifest(pending.gzipBytes, { registry, expectedPairId: pairId });
  const selected = await readPairStateSelection({ registry, pairId, store });
  if (manifest.previousState === null ? selected === null : selectedMatches(selected, manifest.previousState)) {
    return abortPublication({ registry, pairId, store, pending, manifest, selected });
  }
  if (selectedMatches(selected, manifest.nextState)) {
    return commitPublication({ registry, pairId, store, pending, manifest, selected });
  }
  throw new StoredDataIntegrityError();
}

export async function publishPairReplacement({ registry, pair, store, previousSelection, phase, replacement, signal }) {
  const prepared = createManifest({ registry, pair, previousSelection, phase, replacement });
  const manifestBytes = await store.createPublication(pair.pairId, prepared.encoded.gzipBytes);
  const admitted = decodePublicationManifest(manifestBytes, { registry, expectedPairId: pair.pairId });
  if (!sameValue(admitted, prepared.manifest)) throw new StoredDataIntegrityError();

  for (const entry of replacement.encodedDays) {
    signal?.throwIfAborted();
    const storedBytes = await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    const stored = admitStored(() => decodePairDay(storedBytes, { registry }, entry.reference));
    if (!sameValue(stored, entry.value)) throw new StoredDataIntegrityError();
  }
  for (const entry of replacement.encodedMonths) {
    signal?.throwIfAborted();
    const storedBytes = await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    const stored = admitStored(() => decodePairMonth(storedBytes, { registry }, entry.reference));
    if (!sameValue(stored, entry.value)) throw new StoredDataIntegrityError();
  }
  signal?.throwIfAborted();
  const stateBytes = await store.writeState(pair.pairId, replacement.state.sequence, replacement.encodedState.gzipBytes);
  const state = admitStored(() => decodePairState(stateBytes, { registry }, pair.pairId));
  if (!sameValue(state, replacement.state)) throw new StoredDataIntegrityError();
  const selected = await readPairStateSelection({ registry, pairId: pair.pairId, store });
  if (!selectedMatches(selected, prepared.manifest.nextState) || !sameValue(selected.state, replacement.state)) {
    throw new StoredDataIntegrityError();
  }
  await commitPublication({
    registry,
    pairId: pair.pairId,
    store,
    pending: { status: "uploaded", gzipBytes: manifestBytes },
    manifest: prepared.manifest,
    selected,
  });
}
