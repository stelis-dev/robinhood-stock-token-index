import { canonicalBytes } from "./canonical.mjs";
import {
  decodePairDayFile,
  decodePairMonthFile,
  decodePairStateFile,
  decodeResolutionArtifact,
  validateSelectedPairMonth,
} from "./pair-files.mjs";
import {
  comparePublicationReferences,
  decodePairPublicationManifest,
  encodePairPublicationManifest,
  validatePairPublicationManifest,
} from "./publication-manifest.mjs";
import { readPairStateSelection } from "./pair-reader.mjs";
import { pairById } from "./pair-registry.mjs";
import {
  createStateIdentity,
  StoredDataIntegrityError,
} from "../storage/stored-files.mjs";
import { parsePairFileLogicalId } from "./pair-file-identity.mjs";

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function sameStateIdentity(left, right) {
  return left.sequence === right.sequence && left.gzipBytes === right.gzipBytes && left.gzipSha256 === right.gzipSha256;
}

function admitStored(action) {
  try {
    return action();
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

function changedReferences(references, sequence) {
  return references.filter((reference) => reference.sequence === sequence);
}

function createManifest({ registry, pair, previousSelection, phase, replacement }) {
  const previousState = previousSelection?.identity ?? null;
  const nextState = createStateIdentity(replacement.state.sequence, replacement.encodedState.gzipBytes, registry.collection.maximumArtifactBytes);
  const replacements = [...replacement.encodedDays, ...replacement.encodedResolutions, ...replacement.encodedMonths]
    .map((entry) => ({ next: entry.reference, previous: entry.previousReference }))
    .sort((left, right) => comparePublicationReferences(left.next, right.next, { registry }));
  const manifest = {
    kind: "pair_publication",
    pairId: pair.pairId,
    phase,
    previousState,
    nextState,
    replacements,
  };
  if (!sameValue(changedReferences(replacement.state.months, nextState.sequence), replacement.encodedMonths.map((entry) => entry.reference))) {
    throw new Error("Publication state changed months do not match the replacement.");
  }
  for (const monthEntry of replacement.encodedMonths) {
    exactReference(replacement.state.months, monthEntry.reference);
    validateSelectedPairMonth({ state: replacement.state, month: monthEntry.value }, { registry });
    const days = replacement.encodedDays.filter((entry) => parsePairFileLogicalId(entry.reference.logicalId).period.startsWith(monthEntry.value.month));
    const resolutions = replacement.encodedResolutions.filter((entry) => parsePairFileLogicalId(entry.reference.logicalId).period === monthEntry.value.month);
    if (!sameValue(changedReferences(monthEntry.value.days, nextState.sequence), days.map((entry) => entry.reference))) {
      throw new Error("Publication month changed days do not match the replacement.");
    }
    if (!sameValue(changedReferences(monthEntry.value.resolutions, nextState.sequence), resolutions.map((entry) => entry.reference))) {
      throw new Error("Publication month changed resolutions do not match the replacement.");
    }
    for (const entry of days) exactReference(monthEntry.value.days, entry.reference);
    for (const entry of resolutions) exactReference(monthEntry.value.resolutions, entry.reference);
    if (monthEntry.previousReference !== null) {
      if (previousSelection === null || monthEntry.previousValue === null) throw new Error("Publication previous month is unavailable.");
      exactReference(previousSelection.state.months, monthEntry.previousReference);
    }
  }
  for (const child of [...replacement.encodedDays, ...replacement.encodedResolutions]) {
    if (child.previousReference === null) continue;
    const identity = parsePairFileLogicalId(child.reference.logicalId);
    const ownerMonth = identity.kind === "day" ? identity.period.slice(0, 7) : identity.period;
    const parent = replacement.encodedMonths.find((entry) => entry.value.month === ownerMonth);
    if (parent === undefined || parent.previousValue === null) throw new Error("Publication previous child parent is unavailable.");
    exactReference(identity.kind === "day" ? parent.previousValue.days : parent.previousValue.resolutions, child.previousReference);
  }
  validatePairPublicationManifest(manifest, { registry, expectedPairId: pair.pairId });
  return { manifest, encoded: encodePairPublicationManifest(manifest, { registry, expectedPairId: pair.pairId }) };
}

function selectedMatches(selection, identity) {
  return selection !== null && sameStateIdentity(selection.identity, identity);
}

async function decodeChangedChild({ registry, store, reference }) {
  const bytes = await store.readReferenced(reference);
  const identity = parsePairFileLogicalId(reference.logicalId);
  if (identity.kind === "day") return admitStored(() => decodePairDayFile(bytes, { registry }, reference));
  if (identity.kind === "resolution") return admitStored(() => decodeResolutionArtifact(bytes, { registry }, reference));
  throw new StoredDataIntegrityError();
}

async function proveChangedClosure({ registry, store, selection, manifest, side }) {
  const expectedState = side === "next" ? manifest.nextState : manifest.previousState;
  if (expectedState === null || !selectedMatches(selection, expectedState)) throw new StoredDataIntegrityError();
  const monthReplacements = manifest.replacements.filter((entry) => parsePairFileLogicalId(entry.next.logicalId).kind === "month");
  const childReplacements = new Map(manifest.replacements
    .filter((entry) => parsePairFileLogicalId(entry.next.logicalId).kind !== "month")
    .map((entry) => {
      const reference = side === "next" ? entry.next : entry.previous;
      return [reference?.logicalId, reference];
    }).filter(([logicalId]) => logicalId !== undefined));
  const admitted = new Set();
  if (side === "next" && !sameValue(changedReferences(selection.state.months, manifest.nextState.sequence), monthReplacements.map((entry) => entry.next))) {
    throw new StoredDataIntegrityError();
  }
  for (const replacement of monthReplacements) {
    const reference = side === "next" ? replacement.next : replacement.previous;
    if (reference === null) continue;
    admitStored(() => exactReference(selection.state.months, reference));
    const bytes = await store.readReferenced(reference);
    const decodedMonth = admitStored(() => decodePairMonthFile(bytes, { registry }, reference));
    admitStored(() => validateSelectedPairMonth({ state: selection.state, month: decodedMonth }, { registry }));
    const children = [...decodedMonth.days, ...decodedMonth.resolutions];
    if (side === "next") {
      const expectedChanged = [...childReplacements.values()].filter((childReference) => {
        const identity = parsePairFileLogicalId(childReference.logicalId);
        return (identity.kind === "day" ? identity.period.slice(0, 7) : identity.period) === decodedMonth.month;
      });
      if (!sameValue(changedReferences(children, manifest.nextState.sequence), expectedChanged)) throw new StoredDataIntegrityError();
    }
    for (const childReference of children) {
      const expected = childReplacements.get(childReference.logicalId);
      if (expected !== undefined) {
        if (!sameValue(expected, childReference)) throw new StoredDataIntegrityError();
        admitted.add(childReference.logicalId);
        await decodeChangedChild({ registry, store, reference: childReference });
      } else {
        await store.proveReferenced(childReference);
      }
    }
  }
  if (admitted.size !== childReplacements.size) throw new StoredDataIntegrityError();
}

async function abortPublication({ registry, pairId, store, pending, manifest, selected }) {
  if (manifest.previousState !== null) await proveChangedClosure({ registry, store, selection: selected, manifest, side: "previous" });
  await store.removeState(pairId, manifest.nextState, { allowIncomplete: true });
  for (const replacement of [...manifest.replacements].reverse()) await store.removeReferenced(replacement.next, { allowIncomplete: true });
  await store.removePublication(pairId, pending.gzipBytes);
  return { status: "aborted", pairId, phase: manifest.phase, selectedSequence: manifest.previousState?.sequence ?? null };
}

async function commitPublication({ registry, pairId, store, pending, manifest, selected }) {
  await proveChangedClosure({ registry, store, selection: selected, manifest, side: "next" });
  for (const replacement of manifest.replacements) if (replacement.previous !== null) await store.removeReferenced(replacement.previous);
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
  const manifest = decodePairPublicationManifest(pending.gzipBytes, { registry, expectedPairId: pairId });
  const selected = await readPairStateSelection({ registry, pairId, store });
  if (manifest.previousState === null ? selected === null : selectedMatches(selected, manifest.previousState)) {
    return abortPublication({ registry, pairId, store, pending, manifest, selected });
  }
  if (selectedMatches(selected, manifest.nextState)) return commitPublication({ registry, pairId, store, pending, manifest, selected });
  throw new StoredDataIntegrityError();
}

export async function publishPairReplacement({ registry, pair, store, previousSelection, phase, replacement, signal }) {
  const prepared = createManifest({ registry, pair, previousSelection, phase, replacement });
  const manifestBytes = await store.createPublication(pair.pairId, prepared.encoded.gzipBytes);
  const admitted = decodePairPublicationManifest(manifestBytes, { registry, expectedPairId: pair.pairId });
  if (!sameValue(admitted, prepared.manifest)) throw new StoredDataIntegrityError();
  for (const entry of replacement.encodedDays) {
    signal?.throwIfAborted();
    const bytes = await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    if (!sameValue(admitStored(() => decodePairDayFile(bytes, { registry }, entry.reference)), entry.value)) throw new StoredDataIntegrityError();
  }
  for (const entry of replacement.encodedResolutions) {
    signal?.throwIfAborted();
    const bytes = await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    if (!sameValue(admitStored(() => decodeResolutionArtifact(bytes, { registry }, entry.reference)), entry.value)) throw new StoredDataIntegrityError();
  }
  for (const entry of replacement.encodedMonths) {
    signal?.throwIfAborted();
    const bytes = await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
    if (!sameValue(admitStored(() => decodePairMonthFile(bytes, { registry }, entry.reference)), entry.value)) throw new StoredDataIntegrityError();
  }
  signal?.throwIfAborted();
  const stateBytes = await store.writeState(pair.pairId, replacement.state.sequence, replacement.encodedState.gzipBytes);
  if (!sameValue(admitStored(() => decodePairStateFile(stateBytes, { registry }, pair.pairId)), replacement.state)) throw new StoredDataIntegrityError();
  const selected = await readPairStateSelection({ registry, pairId: pair.pairId, store });
  if (!selectedMatches(selected, prepared.manifest.nextState) || !sameValue(selected.state, replacement.state)) throw new StoredDataIntegrityError();
  await commitPublication({ registry, pairId: pair.pairId, store, pending: { status: "uploaded", gzipBytes: manifestBytes }, manifest: prepared.manifest, selected });
}
