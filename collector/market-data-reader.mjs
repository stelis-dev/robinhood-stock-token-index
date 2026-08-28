import { decodeArtifact, sha256Hex } from "./canonical.mjs";
import { physicalAssetIdentity } from "./market-data-assets.mjs";
import {
  decodeStoredMember,
  parseRootAssetName,
  validateBaseDayFile,
  validateBaseMonthFile,
  validateBaseResolutionFile,
  validateBaseStateFile,
  validateSelectedRoot,
  validateStoredMemberReference,
} from "./market-data-files.mjs";
import { baseMonthLogicalId, baseResolutionLogicalId } from "./market-data-file-identity.mjs";
import { parseMarketDataLogicalId } from "./market-data-file-identity.mjs";
import { validateSelectionStateProjection } from "./market-data-selection.mjs";
import { StoredDataIntegrityError } from "../storage/storage-error.mjs";

function storedData(action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof StoredDataIntegrityError) throw error;
    throw new StoredDataIntegrityError();
  }
}

export function createMarketDataReader({ configuration, store, maximumBytes }) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new Error("Market-data byte boundary is invalid.");
  const releaseCache = new Map();
  async function releaseAssets(tag) {
    if (!releaseCache.has(tag)) releaseCache.set(tag, await store.listMarketDataAssets(tag));
    return releaseCache.get(tag);
  }
  async function provePhysicalAsset(entry) {
    const identity = physicalAssetIdentity(entry);
    const metadata = (await releaseAssets(identity.releaseTag)).find((asset) => asset.assetName === identity.assetName);
    if (metadata === undefined || metadata.state !== "uploaded" || metadata.bytes !== identity.bytes || metadata.sha256 !== null && metadata.sha256 !== identity.sha256) {
      throw new StoredDataIntegrityError();
    }
    return identity;
  }
  function selectedAsset(root, reference) {
    validateStoredMemberReference(reference);
    const matches = root.assets.filter((entry) => entry.sha256 === reference.assetSha256 && entry.logicalIds.includes(reference.logicalId));
    if (matches.length !== 1) throw new StoredDataIntegrityError();
    return matches[0];
  }
  async function readMember(root, reference, validator) {
    const entry = selectedAsset(root, reference);
    const identity = await provePhysicalAsset(entry);
    const gzipBytes = await store.readMarketDataAsset(identity, { from: reference.from, until: reference.until });
    const value = storedData(() => decodeStoredMember(reference, gzipBytes, maximumBytes, configuration));
    return storedData(() => validator(value, configuration));
  }
  async function readLogicalMember(root, reference) {
    const identity = storedData(() => parseMarketDataLogicalId(reference.logicalId));
    const validator = identity.kind === "state"
      ? validateBaseStateFile
      : identity.kind === "month"
        ? validateBaseMonthFile
        : identity.kind === "day"
          ? validateBaseDayFile
          : validateBaseResolutionFile;
    return readMember(root, reference, validator);
  }
  async function selectedRoot() {
    const candidates = [];
    const sequences = new Set();
    for (const asset of await releaseAssets("market-data-catalog")) {
      const parsed = parseRootAssetName(asset.assetName);
      if (parsed === null || asset.state !== "uploaded") continue;
      if (sequences.has(parsed.publicationSequence)) throw new StoredDataIntegrityError();
      sequences.add(parsed.publicationSequence);
      if (asset.bytes <= 0 || asset.sha256 !== null && asset.sha256 !== parsed.sha256) throw new StoredDataIntegrityError();
      candidates.push({
        identity: {
          assetName: asset.assetName,
          bytes: asset.bytes,
          releaseTag: "market-data-catalog",
          sha256: parsed.sha256,
        },
        sequence: parsed.publicationSequence,
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => left.sequence - right.sequence);
    const selected = candidates.at(-1);
    const gzipBytes = await store.readMarketDataAsset(selected.identity);
    const root = storedData(() => {
      if (gzipBytes.byteLength !== selected.identity.bytes || sha256Hex(gzipBytes) !== selected.identity.sha256) throw new StoredDataIntegrityError();
      const decoded = decodeArtifact(gzipBytes, maximumBytes);
      validateSelectedRoot(decoded.value, configuration);
      if (decoded.value.publicationSequence !== selected.sequence) throw new StoredDataIntegrityError();
      return decoded.value;
    });
    return Object.freeze({ gzipBytes, identity: Object.freeze(selected.identity), root });
  }
  async function selection() {
    const selected = await selectedRoot();
    if (selected === null) return null;
    const baseStates = {};
    for (const address of Object.keys(selected.root.baseCurrencies)) {
      baseStates[address] = (await baseState(selected, address)).value;
    }
    const projection = storedData(() => validateSelectionStateProjection({ baseStates, configuration, root: selected.root }));
    return Object.freeze({ ...selected, baseStates: Object.freeze(baseStates), projection });
  }
  async function baseState(selected, address) {
    const reference = selected.root.baseCurrencies[address];
    if (reference === undefined) return null;
    return Object.freeze({ reference, value: await readMember(selected.root, reference, validateBaseStateFile) });
  }
  async function baseMonth(selected, address, month, stateValue = selected.baseStates?.[address]) {
    const state = stateValue;
    if (state === undefined) return null;
    const reference = state.months.find((entry) => entry.logicalId === baseMonthLogicalId(address, month));
    if (reference === undefined) return null;
    return Object.freeze({ reference, value: await readMember(selected.root, reference, validateBaseMonthFile) });
  }
  async function baseDay(selected, reference) {
    return Object.freeze({ reference, value: await readMember(selected.root, reference, validateBaseDayFile) });
  }
  async function baseResolution(selected, reference) {
    return Object.freeze({ reference, value: await readMember(selected.root, reference, validateBaseResolutionFile) });
  }
  async function readResolution({ baseCurrencyAddress, month, resolution }) {
    const selected = await selectedRoot();
    if (selected === null) return { status: "unpublished" };
    const state = await baseState(selected, baseCurrencyAddress);
    if (state === null) return { status: "absent" };
    storedData(() => validateSelectionStateProjection({
      baseStates: { [baseCurrencyAddress]: state.value },
      configuration,
      root: selected.root,
    }));
    const owner = await baseMonth(selected, baseCurrencyAddress, month, state.value);
    if (owner === null) return { status: "absent" };
    if (resolution === "1m") {
      const files = [];
      for (const reference of owner.value.days) files.push(await baseDay(selected, reference));
      return { status: "read", root: selected.identity, month: owner.reference, files };
    }
    const reference = owner.value.resolutions[resolution];
    if (reference?.logicalId !== baseResolutionLogicalId(baseCurrencyAddress, resolution, month)) throw new StoredDataIntegrityError();
    return { status: "read", root: selected.identity, month: owner.reference, files: [await baseResolution(selected, reference)] };
  }
  return Object.freeze({ baseDay, baseMonth, baseResolution, baseState, readLogicalMember, readResolution, selectedRoot, selection });
}
