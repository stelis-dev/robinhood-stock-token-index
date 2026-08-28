import { canonicalBytes, decodeArtifact, encodeArtifact, sha256Hex } from "./canonical.mjs";
import {
  applyAssetMembershipTransition,
  marketDataPublicationAssetName,
  maximumMarketDataAssetsPerRelease,
  physicalAssetIdentity,
} from "./market-data-assets.mjs";
import {
  projectPhysicalIdentities,
  publicationRecordAssetIdentity,
  parseRootAssetName,
  rootAssetIdentity,
  decodeStoredMember,
  validatePublicationRecord,
  validateSelectedRoot,
} from "./market-data-files.mjs";
import { createMarketDataReader } from "./market-data-reader.mjs";
import {
  validateLogicalTransition,
  validateMembershipTransitionAgainstLogical,
} from "./market-data-recording.mjs";
import {
  changedLogicalIds,
  expandChangedReferenceClosure,
  selectedLogicalAssetMap,
  validateMarketDataSelectionClosure,
  validateSelectionStateProjection,
} from "./market-data-selection.mjs";
import { StoredDataIntegrityError } from "../storage/storage-error.mjs";
import { parseMarketDataLogicalId } from "./market-data-file-identity.mjs";
import { verifyMarketDataMonths } from "./market-data-verifier.mjs";

export class PendingPublicationMismatchError extends Error {
  constructor() {
    super("Regenerated publication differs from the pending replay.");
    this.name = "PendingPublicationMismatchError";
  }
}

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function throwIfCancelled(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Publication cancellation signal is invalid.");
  signal?.throwIfAborted();
}

function identityKey(value) {
  return `${value.sha256}:${value.releaseTag}:${value.assetName}:${value.bytes}`;
}

function sameIdentity(left, right) {
  return left !== null && right !== null && identityKey(left) === identityKey(right);
}

function sortedIdentities(values) {
  return [...values].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

function physicalByKey(values) {
  return new Map(values.map((value) => [identityKey(value), value]));
}

function validateMembershipTransition(previousAssets, nextAssets) {
  const previousByIdentity = new Map(previousAssets.map((entry) => [identityKey(entry), entry]));
  for (const next of nextAssets) {
    const previous = previousByIdentity.get(identityKey(next));
    if (previous === undefined) continue;
    const previousLogicalIds = new Set(previous.logicalIds);
    if (next.logicalIds.some((logicalId) => !previousLogicalIds.has(logicalId))) {
      throw new StoredDataIntegrityError();
    }
  }
}

function validatePublicationSequence(record, nextRoot = null) {
  const next = parseRootAssetName(record.nextRoot.assetName);
  const previous = record.previousRoot === null ? null : parseRootAssetName(record.previousRoot.assetName);
  const expected = previous === null ? 1 : previous.publicationSequence + 1;
  if (
    next === null
    || previous !== null && !Number.isSafeInteger(expected)
    || next.publicationSequence !== expected
    || nextRoot !== null && nextRoot.publicationSequence !== expected
  ) throw new StoredDataIntegrityError();
}

function validatePublicationEquation(record, nextRoot) {
  validatePublicationRecord(record);
  validatePublicationSequence(record, nextRoot);
  validateMembershipTransition(record.previousAssets, nextRoot.assets);
  const previous = physicalByKey(projectPhysicalIdentities(record.previousAssets));
  const next = physicalByKey(projectPhysicalIdentities(nextRoot.assets));
  const expectedNew = sortedIdentities([...next].filter(([key]) => !previous.has(key)).map(([, value]) => value));
  const expectedSuperseded = sortedIdentities([
    ...[...previous].filter(([key]) => !next.has(key)).map(([, value]) => value),
    ...(record.previousRoot === null ? [] : [record.previousRoot]),
  ]);
  if (!sameValue(record.newAssets, expectedNew) || !sameValue(record.supersededAssets, expectedSuperseded)) {
    throw new StoredDataIntegrityError();
  }
}

function validatePendingOutsidePrevious(record) {
  validatePublicationSequence(record);
  const previous = physicalByKey(projectPhysicalIdentities(record.previousAssets));
  const nextRootKey = identityKey(record.nextRoot);
  if (previous.has(nextRootKey) || record.newAssets.some((identity) => previous.has(identityKey(identity)))) {
    throw new StoredDataIntegrityError();
  }
  if (record.newAssets.some((identity) => identityKey(identity) === nextRootKey)) throw new StoredDataIntegrityError();
}

function decodePublication(bytes, maximumBytes) {
  try {
    const decoded = decodeArtifact(bytes, maximumBytes);
    const value = validatePublicationRecord(decoded.value);
    return value;
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}

function reader(configuration, store, maximumBytes) {
  return createMarketDataReader({ configuration, store, maximumBytes });
}

async function selectedRoot(configuration, store, maximumBytes) {
  return reader(configuration, store, maximumBytes).selectedRoot();
}

async function removeAll(store, identities, options, signal) {
  for (const identity of identities) {
    throwIfCancelled(signal);
    await store.removeMarketDataAsset(identity, options);
  }
}

async function optionalRoot(configuration, store, maximumBytes, identity) {
  const listed = (await store.listMarketDataAssets(identity.releaseTag))
    .find((asset) => asset.assetName === identity.assetName);
  if (listed === undefined) return null;
  if (listed.state !== "uploaded" || listed.bytes !== identity.bytes || listed.sha256 !== null && listed.sha256 !== identity.sha256) {
    throw new StoredDataIntegrityError();
  }
  const gzipBytes = await store.readMarketDataAsset(identity);
  try {
    const root = decodeArtifact(gzipBytes, maximumBytes).value;
    validateSelectedRoot(root, configuration);
    return Object.freeze({ gzipBytes, identity, root });
  } catch {
    throw new StoredDataIntegrityError();
  }
}

async function verifyRemoteSelectionTransition({ configuration, maximumBytes, nextRoot, previousAssets, store }) {
  const marketDataReader = reader(configuration, store, maximumBytes);
  const selected = await marketDataReader.selection();
  if (selected === null || !sameIdentity(selected.identity, nextRoot)) throw new StoredDataIntegrityError();
  await validateMarketDataSelectionClosure({
    changedLogicalIds: changedLogicalIds(previousAssets, selected.root.assets),
    configuration,
    readLogicalFile: (reference) => marketDataReader.readLogicalMember(selected.root, reference),
    root: selected.root,
  });
  return selected;
}

async function validateLocalSelectionTransition({ admittedConfiguration, maximumBytes, previousSelected, previousSelection, recording, store }) {
  const expectedRoot = encodeArtifact(recording.root);
  const expectedPublication = encodeArtifact(recording.publicationRecord);
  const decodedRoot = decodeArtifact(recording.encodedRoot.gzipBytes, maximumBytes);
  const decodedPublication = decodeArtifact(recording.encodedPublicationRecord.gzipBytes, maximumBytes);
  if (
    !recording.encodedRoot.gzipBytes.equals(expectedRoot.gzipBytes)
    || !recording.encodedPublicationRecord.gzipBytes.equals(expectedPublication.gzipBytes)
    || !sameValue(decodedRoot.value, recording.root)
    || !sameValue(decodedPublication.value, recording.publicationRecord)
    || !sameIdentity(rootAssetIdentity(recording.root.publicationSequence, expectedRoot.gzipBytes), recording.publicationRecord.nextRoot)
  ) throw new Error("Encoded market-data publication is inconsistent.");
  const localMembers = new Map();
  const physical = [];
  for (const packed of recording.packedAssets) {
    const identity = physicalAssetIdentity(packed.selectedAsset);
    if (
      packed.bytes.byteLength !== identity.bytes
      || sha256Hex(packed.bytes) !== identity.sha256
      || packed.references.length !== packed.selectedAsset.logicalIds.length
    ) {
      throw new Error("Packed market-data asset is inconsistent.");
    }
    let offset = 0;
    for (let index = 0; index < packed.references.length; index += 1) {
      const reference = packed.references[index];
      if (
        reference.from !== offset
        || reference.assetSha256 !== identity.sha256
        || reference.logicalId !== packed.selectedAsset.logicalIds[index]
        || reference.until > packed.bytes.byteLength
      ) throw new Error("Packed market-data member range is inconsistent.");
      if (localMembers.has(reference.logicalId)) throw new Error("Packed market-data logical ID is duplicated.");
      localMembers.set(reference.logicalId, Object.freeze({
        gzipBytes: packed.bytes.subarray(reference.from, reference.until),
        reference,
        value: decodeStoredMember(
          reference,
          packed.bytes.subarray(reference.from, reference.until),
          maximumBytes,
          admittedConfiguration.configuration,
        ),
      }));
      offset = reference.until;
    }
    if (offset !== packed.bytes.byteLength) throw new Error("Packed market-data asset has unowned bytes.");
    physical.push(identity);
  }
  if (!sameValue(sortedIdentities(physical), recording.publicationRecord.newAssets)) {
    throw new Error("Packed market-data assets differ from the publication record.");
  }
  validateLogicalTransition(recording.logicalTransition);
  validateMembershipTransitionAgainstLogical(recording.logicalTransition, recording.membershipTransition);
  if (localMembers.size !== recording.logicalTransition.replacements.length) {
    throw new Error("Packed members differ from the exact logical transition.");
  }
  for (const replacement of recording.logicalTransition.replacements) {
    const local = localMembers.get(replacement.logicalId);
    if (
      local === undefined
      || !local.gzipBytes.equals(replacement.gzipBytes)
      || local.reference.gzipSha256 !== replacement.gzipSha256
      || local.reference.jsonBytes !== replacement.jsonBytes.byteLength
      || local.reference.jsonSha256 !== replacement.jsonSha256
    ) throw new Error("Packed member differs from the exact logical transition.");
  }
  const expectedMembership = applyAssetMembershipTransition({
    packedAssets: recording.packedAssets,
    previousAssets: recording.publicationRecord.previousAssets,
    transition: recording.membershipTransition,
  });
  const expectedSuperseded = sortedIdentities([
    ...expectedMembership.supersededAssets,
    ...(recording.publicationRecord.previousRoot === null ? [] : [recording.publicationRecord.previousRoot]),
  ]);
  if (
    !sameValue(expectedMembership.nextAssets, recording.root.assets)
    || !sameValue(expectedMembership.newAssets, recording.publicationRecord.newAssets)
    || !sameValue(expectedSuperseded, recording.publicationRecord.supersededAssets)
  ) throw new Error("Recording membership transition differs from the candidate publication.");
  const marketDataReader = reader(admittedConfiguration.configuration, store, maximumBytes);
  const previousValues = new Map();
  const readPrevious = async (reference) => {
    if (reference === undefined || previousSelected === null) return null;
    const identity = parseMarketDataLogicalId(reference.logicalId);
    if (identity.kind === "state" && previousSelection?.baseStates[identity.baseCurrencyAddress] !== undefined) {
      return previousSelection.baseStates[identity.baseCurrencyAddress];
    }
    if (!previousValues.has(reference.logicalId)) {
      previousValues.set(reference.logicalId, await marketDataReader.readLogicalMember(previousSelected.root, reference));
    }
    return previousValues.get(reference.logicalId);
  };
  const readNext = async (reference) => {
    if (reference === undefined) return null;
    const local = localMembers.get(reference.logicalId);
    if (local !== undefined) {
      if (!sameValue(local.reference, reference)) throw new StoredDataIntegrityError();
      return local.value;
    }
    if (previousSelected === null) throw new StoredDataIntegrityError();
    return marketDataReader.readLogicalMember(recording.root, reference);
  };
  if (previousSelected !== null) {
    const previousMembership = selectedLogicalAssetMap(previousSelected.root.assets);
    const previousReplacementIds = recording.logicalTransition.replacements
      .map((replacement) => replacement.logicalId)
      .filter((logicalId) => previousMembership.has(logicalId));
    const previousClosure = await validateMarketDataSelectionClosure({
      changedLogicalIds: previousReplacementIds,
      configuration: admittedConfiguration.configuration,
      readLogicalFile: (reference) => marketDataReader.readLogicalMember(previousSelected.root, reference),
      root: previousSelected.root,
    });
    for (const replacement of recording.logicalTransition.replacements) {
      const previousReference = previousClosure.references.get(replacement.logicalId);
      if (
        previousReference !== undefined
        && previousReference.gzipSha256 === replacement.gzipSha256
        && previousReference.jsonBytes === replacement.jsonBytes.byteLength
        && previousReference.jsonSha256 === replacement.jsonSha256
      ) throw new Error("An unchanged logical file cannot be replaced.");
    }
  }
  const changed = new Set();
  for (const logicalId of changedLogicalIds(recording.publicationRecord.previousAssets, recording.root.assets)) changed.add(logicalId);
  for (const logicalId of localMembers.keys()) changed.add(logicalId);
  for (const address of new Set([
    ...Object.keys(previousSelected?.root.baseCurrencies ?? {}),
    ...Object.keys(recording.root.baseCurrencies),
  ])) {
    const previousReference = previousSelected?.root.baseCurrencies[address];
    const nextReference = recording.root.baseCurrencies[address];
    if (!sameValue(previousReference ?? null, nextReference ?? null)) changed.add(`base/${address}/state`);
  }
  const expanded = await expandChangedReferenceClosure({
    changedLogicalIds: [...changed],
    nextRoot: recording.root,
    previousRoot: previousSelected?.root ?? null,
    readNext,
    readPrevious,
  });
  await validateMarketDataSelectionClosure({
    changedLogicalIds: expanded,
    configuration: admittedConfiguration.configuration,
    readLogicalFile: readNext,
    root: recording.root,
  });
  const baseStates = {};
  for (const [address, reference] of Object.entries(recording.root.baseCurrencies)) {
    baseStates[address] = await readNext(reference);
  }
  validateSelectionStateProjection({
    baseStates,
    configuration: admittedConfiguration.configuration,
    root: recording.root,
  });
  await verifyMarketDataMonths({
    baseStates,
    months: recording.logicalTransition.verificationMonths,
    readLogicalFile: readNext,
  });
}

function proveListedIdentity(asset, identity, { allowStarter }) {
  if (asset.assetName !== identity.assetName) throw new StoredDataIntegrityError();
  if (asset.state === "starter") {
    if (!allowStarter) throw new StoredDataIntegrityError();
    return;
  }
  if (asset.state !== "uploaded" || asset.bytes !== identity.bytes || asset.sha256 !== null && asset.sha256 !== identity.sha256) {
    throw new StoredDataIntegrityError();
  }
}

async function validateExactStorageMutation({ pending, recording, store }) {
  const byRelease = new Map();
  for (const identity of recording.publicationRecord.newAssets) {
    const values = byRelease.get(identity.releaseTag) ?? [];
    values.push(identity);
    byRelease.set(identity.releaseTag, values);
  }
  for (const [releaseTag, identities] of byRelease) {
    const listed = await store.listMarketDataAssets(releaseTag);
    let missing = 0;
    for (const identity of identities) {
      const asset = listed.find((candidate) => candidate.assetName === identity.assetName);
      if (asset === undefined) missing += 1;
      else {
        if (pending.status !== "uploaded") throw new StoredDataIntegrityError();
        proveListedIdentity(asset, identity, { allowStarter: true });
      }
    }
    if (listed.length + missing > maximumMarketDataAssetsPerRelease) {
      throw new Error("Market-data Release asset capacity is exceeded.");
    }
  }

  const catalog = await store.listMarketDataAssets("market-data-catalog");
  let missingCatalogAssets = 0;
  const listedRoot = catalog.find((asset) => asset.assetName === recording.publicationRecord.nextRoot.assetName);
  if (listedRoot === undefined) missingCatalogAssets += 1;
  else {
    if (pending.status !== "uploaded") throw new StoredDataIntegrityError();
    proveListedIdentity(listedRoot, recording.publicationRecord.nextRoot, { allowStarter: true });
  }
  const listedPublication = catalog.find((asset) => asset.assetName === marketDataPublicationAssetName);
  if (pending.status === "absent") {
    if (listedPublication !== undefined) throw new StoredDataIntegrityError();
    missingCatalogAssets += 1;
  } else if (pending.status === "uploaded") {
    if (listedPublication === undefined) throw new StoredDataIntegrityError();
  } else throw new StoredDataIntegrityError();
  if (catalog.length + missingCatalogAssets > maximumMarketDataAssetsPerRelease) {
    throw new Error("Market-data catalog asset capacity is exceeded.");
  }
}

export async function recoverMarketDataPublication({ admittedConfiguration, store, maximumBytes, signal }) {
  throwIfCancelled(signal);
  const pending = await store.readMarketDataPublication();
  if (pending.status === "absent") return Object.freeze({ status: "absent" });
  if (pending.status === "starter") {
    throwIfCancelled(signal);
    await store.removeMarketDataPublicationStarter();
    return Object.freeze({ status: "starter_removed" });
  }
  const record = decodePublication(pending.bytes, maximumBytes);
  const selected = await selectedRoot(admittedConfiguration.configuration, store, maximumBytes);
  const previousSelected = record.previousRoot === null
    ? selected === null
    : selected !== null && sameIdentity(selected.identity, record.previousRoot);
  const nextSelected = selected !== null && sameIdentity(selected.identity, record.nextRoot);
  if (previousSelected) {
    if (selected !== null && !sameValue(selected.root.assets, record.previousAssets)) throw new StoredDataIntegrityError();
    validatePendingOutsidePrevious(record);
    if (record.configurationSha256 !== admittedConfiguration.sha256) {
      await removeAll(store, [record.nextRoot, ...record.newAssets], { allowIncomplete: true }, signal);
      throwIfCancelled(signal);
      await store.removeMarketDataAsset(pending.identity);
      return Object.freeze({ status: "previous_retained" });
    }
    return Object.freeze({
      publicationIdentity: pending.identity,
      publicationRecord: record,
      status: "replay_required",
    });
  }
  if (!nextSelected) throw new StoredDataIntegrityError();
  validatePublicationEquation(record, selected.root);
  await verifyRemoteSelectionTransition({
    configuration: admittedConfiguration.configuration,
    maximumBytes,
    nextRoot: record.nextRoot,
    previousAssets: record.previousAssets,
    store,
  });
  if (record.previousRoot !== null) {
    const previous = await optionalRoot(
      admittedConfiguration.configuration,
      store,
      maximumBytes,
      record.previousRoot,
    );
    if (previous !== null && !sameValue(previous.root.assets, record.previousAssets)) throw new StoredDataIntegrityError();
  }
  await removeAll(store, record.supersededAssets, { allowIncomplete: true }, signal);
  throwIfCancelled(signal);
  await store.removeMarketDataAsset(pending.identity);
  return Object.freeze({ status: "next_selected" });
}

export async function abortMarketDataPublication({ admittedConfiguration, store, maximumBytes, signal }) {
  throwIfCancelled(signal);
  const recovery = await recoverMarketDataPublication({ admittedConfiguration, store, maximumBytes, signal });
  if (recovery.status !== "replay_required") return recovery;
  await removeAll(
    store,
    [recovery.publicationRecord.nextRoot, ...recovery.publicationRecord.newAssets],
    { allowIncomplete: true },
    signal,
  );
  throwIfCancelled(signal);
  await store.removeMarketDataAsset(recovery.publicationIdentity);
  return Object.freeze({ status: "previous_retained" });
}

export async function publishMarketDataRecording({ admittedConfiguration, store, maximumBytes, previousSelection = null, recording, signal }) {
  throwIfCancelled(signal);
  const pending = await store.readMarketDataPublication();
  const previousSelected = await selectedRoot(admittedConfiguration.configuration, store, maximumBytes);
  if (
    recording.publicationRecord.configurationSha256 !== admittedConfiguration.sha256
    || recording.publicationRecord.previousRoot === null && previousSelected !== null
    || recording.publicationRecord.previousRoot !== null && (
      previousSelected === null
      || !sameIdentity(recording.publicationRecord.previousRoot, previousSelected.identity)
      || !sameValue(recording.publicationRecord.previousAssets, previousSelected.root.assets)
    )
  ) throw new StoredDataIntegrityError();
  if (previousSelection !== null && !sameIdentity(previousSelection.identity, previousSelected?.identity)) throw new StoredDataIntegrityError();
  validatePublicationEquation(recording.publicationRecord, recording.root);
  await validateLocalSelectionTransition({ admittedConfiguration, maximumBytes, previousSelected, previousSelection, recording, store });
  throwIfCancelled(signal);
  const publicationIdentity = publicationRecordAssetIdentity(recording.encodedPublicationRecord.gzipBytes);
  if (pending.status === "starter") throw new Error("Pending publication starter must be recovered before collection.");
  if (pending.status === "uploaded") {
    const pendingRecord = decodePublication(pending.bytes, maximumBytes);
    if (
      !sameIdentity(pending.identity, publicationIdentity)
      || !pending.bytes.equals(recording.encodedPublicationRecord.gzipBytes)
      || !sameValue(pendingRecord, recording.publicationRecord)
    ) {
      throw new PendingPublicationMismatchError();
    }
  } else if (pending.status !== "absent") throw new StoredDataIntegrityError();
  await validateExactStorageMutation({ pending, recording, store });
  throwIfCancelled(signal);
  if (pending.status === "absent") {
    await store.writeMarketDataAsset(publicationIdentity, recording.encodedPublicationRecord.gzipBytes);
  }
  const packedByIdentity = new Map(recording.packedAssets.map((asset) => [identityKey(physicalAssetIdentity(asset.selectedAsset)), asset]));
  for (const identity of recording.publicationRecord.newAssets) {
    throwIfCancelled(signal);
    const packed = packedByIdentity.get(identityKey(identity));
    if (packed === undefined) throw new Error("Publication has no regenerated bytes for a new asset.");
    await store.writeMarketDataAsset(identity, packed.bytes);
  }
  throwIfCancelled(signal);
  await store.writeMarketDataAsset(recording.publicationRecord.nextRoot, recording.encodedRoot.gzipBytes);

  throwIfCancelled(signal);
  const verifier = reader(admittedConfiguration.configuration, store, maximumBytes);
  const selectedRootValue = await verifier.selectedRoot();
  if (selectedRootValue === null || !sameIdentity(selectedRootValue.identity, recording.publicationRecord.nextRoot) || !sameValue(selectedRootValue.root, recording.root)) {
    throw new StoredDataIntegrityError();
  }
  const selected = await verifyRemoteSelectionTransition({
    configuration: admittedConfiguration.configuration,
    maximumBytes,
    nextRoot: recording.publicationRecord.nextRoot,
    previousAssets: recording.publicationRecord.previousAssets,
    store,
  });
  await removeAll(store, recording.publicationRecord.supersededAssets, { allowIncomplete: true }, signal);
  throwIfCancelled(signal);
  await store.removeMarketDataAsset(publicationIdentity);
  return Object.freeze({ root: selected.identity, status: "published" });
}
