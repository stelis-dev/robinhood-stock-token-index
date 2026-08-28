import { isSha256Hex, sha256Hex } from "./canonical.mjs";
import { parseMarketDataLogicalId } from "./market-data-file-identity.mjs";
import { validateUtcMonth } from "./utc-time.mjs";

const dataReleasePattern = /^market-data-(\d{4}-\d{2})-s([1-9][0-9]*)$/u;
const indexReleasePattern = /^market-data-index-s([1-9][0-9]*)$/u;
const dataAssetPattern = /^data-([0-9a-f]{64})\.bin$/u;
const indexAssetPattern = /^index-([0-9a-f]{64})\.bin$/u;
const rootAssetPattern = /^root-s([1-9][0-9]*)-([0-9a-f]{64})\.json\.gz$/u;
export const marketDataPublicationAssetName = "publication.json.gz";
export const maximumMarketDataAssetBytes = 430_563_600;
export const maximumMarketDataAssetsPerRelease = 1_000;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has an invalid member set.`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function safePositiveDigits(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function dataRelease(value) {
  const match = typeof value === "string" ? value.match(dataReleasePattern) : null;
  if (match === null || !safePositiveDigits(match[2])) return null;
  try {
    validateUtcMonth(match[1], "Market-data Release month");
  } catch {
    return null;
  }
  return match;
}

function indexRelease(value) {
  const match = typeof value === "string" ? value.match(indexReleasePattern) : null;
  return match !== null && safePositiveDigits(match[1]) ? match : null;
}

export function validatePhysicalAssetIdentity(value) {
  exactKeys(value, ["assetName", "bytes", "releaseTag", "sha256"], "Physical asset identity");
  if (
    typeof value.assetName !== "string"
    || value.assetName.length === 0
    || typeof value.releaseTag !== "string"
    || value.releaseTag.length === 0
    || !isSha256Hex(value.sha256)
  ) throw new Error("Physical asset identity is invalid.");
  const bytes = positiveInteger(value.bytes, "Physical asset bytes");
  if (bytes > maximumMarketDataAssetBytes) throw new Error("Physical asset exceeds the fixed byte boundary.");
  const data = dataRelease(value.releaseTag);
  const index = indexRelease(value.releaseTag);
  const root = value.assetName.match(rootAssetPattern);
  const valid = data !== null && value.assetName.match(dataAssetPattern)?.[1] === value.sha256
    || index !== null && value.assetName.match(indexAssetPattern)?.[1] === value.sha256
    || value.releaseTag === "market-data-catalog" && (
      root?.[2] === value.sha256 && safePositiveDigits(root[1])
      || value.assetName === marketDataPublicationAssetName
    );
  if (!valid) throw new Error("Physical asset name and Release family are inconsistent.");
  return value;
}

export function validateMarketDataReleaseTag(value) {
  if (
    value !== "market-data-catalog"
    && dataRelease(value) === null
    && indexRelease(value) === null
  ) throw new Error("Market-data Release tag is invalid.");
  return value;
}

export function physicalAssetIdentity(value) {
  validateSelectedAssetEntry(value);
  return Object.freeze({
    assetName: value.assetName,
    bytes: value.bytes,
    releaseTag: value.releaseTag,
    sha256: value.sha256,
  });
}

export function validateSelectedAssetEntry(value) {
  exactKeys(value, ["assetName", "bytes", "logicalIds", "releaseTag", "sha256"], "Selected asset entry");
  validatePhysicalAssetIdentity({
    assetName: value.assetName,
    bytes: value.bytes,
    releaseTag: value.releaseTag,
    sha256: value.sha256,
  });
  if (value.releaseTag === "market-data-catalog") throw new Error("A catalog asset cannot be selected as a logical member asset.");
  if (!Array.isArray(value.logicalIds) || value.logicalIds.length === 0) throw new Error("Selected logical IDs are invalid.");
  const data = dataRelease(value.releaseTag);
  const indexKinds = new Set();
  let previous = "";
  for (const logicalId of value.logicalIds) {
    const identity = parseMarketDataLogicalId(logicalId);
    if (
      value.assetName.startsWith("data-") && !new Set(["day", "resolution"]).has(identity.kind)
      || value.assetName.startsWith("index-") && !new Set(["month", "state"]).has(identity.kind)
    ) throw new Error("Selected logical ID uses the wrong physical asset family.");
    if (data !== null) {
      const ownerMonth = identity.kind === "day" ? identity.period.slice(0, 7) : identity.period;
      if (ownerMonth !== data[1]) throw new Error("Data asset Release month differs from its logical owner month.");
    } else indexKinds.add(identity.kind);
    if (logicalId <= previous) throw new Error("Selected logical IDs are duplicated or unordered.");
    previous = logicalId;
  }
  if (indexKinds.size > 1) throw new Error("One index asset cannot mix base-state and base-month members.");
  return value;
}

export function validateSelectedAssetEntries(value) {
  if (!Array.isArray(value)) throw new Error("Selected asset entries must be an array.");
  const logicalIds = new Set();
  let previousSha256 = "";
  for (const entry of value) {
    validateSelectedAssetEntry(entry);
    if (entry.sha256 <= previousSha256) throw new Error("Selected asset entries are duplicated or unordered.");
    previousSha256 = entry.sha256;
    for (const logicalId of entry.logicalIds) {
      if (logicalIds.has(logicalId)) throw new Error("One logical ID is selected from multiple assets.");
      logicalIds.add(logicalId);
    }
  }
  return value;
}

function validateEncodedMember(value) {
  exactKeys(value, ["gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId"], "Encoded logical member");
  parseMarketDataLogicalId(value.logicalId);
  if (
    !Buffer.isBuffer(value.gzipBytes)
    || value.gzipBytes.byteLength === 0
    || !Buffer.isBuffer(value.jsonBytes)
    || value.jsonBytes.byteLength === 0
    || !isSha256Hex(value.gzipSha256)
    || !isSha256Hex(value.jsonSha256)
    || sha256Hex(value.gzipBytes) !== value.gzipSha256
    || sha256Hex(value.jsonBytes) !== value.jsonSha256
  ) throw new Error("Encoded logical member is invalid.");
  return value;
}

export function packLogicalMembers({ members, releaseTag, assetNamePrefix, maximumAssetBytes }) {
  if (!Array.isArray(members) || members.length === 0) throw new Error("Packing requires logical members.");
  if (typeof releaseTag !== "string" || releaseTag.length === 0) throw new Error("Packing Release tag is invalid.");
  if (assetNamePrefix !== "data" && assetNamePrefix !== "index") throw new Error("Packing asset prefix is invalid.");
  positiveInteger(maximumAssetBytes, "Maximum physical asset bytes");
  const ordered = [...members].map(validateEncodedMember).sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (new Set(ordered.map((member) => member.logicalId)).size !== ordered.length) throw new Error("Packing logical IDs are duplicated.");
  const groups = [];
  let group = [];
  let groupBytes = 0;
  for (const member of ordered) {
    if (member.gzipBytes.byteLength > maximumAssetBytes) throw new Error("One logical member exceeds the physical asset boundary.");
    if (group.length > 0 && groupBytes + member.gzipBytes.byteLength > maximumAssetBytes) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(member);
    groupBytes += member.gzipBytes.byteLength;
  }
  groups.push(group);
  return Object.freeze(groups.map((entries) => {
    const bytes = Buffer.concat(entries.map((entry) => entry.gzipBytes));
    const sha256 = sha256Hex(bytes);
    let offset = 0;
    const references = Object.freeze(entries.map((entry) => {
      const from = offset;
      offset += entry.gzipBytes.byteLength;
      return Object.freeze({
        assetSha256: sha256,
        from,
        gzipSha256: entry.gzipSha256,
        jsonBytes: entry.jsonBytes.byteLength,
        jsonSha256: entry.jsonSha256,
        logicalId: entry.logicalId,
        until: offset,
      });
    }));
    const selectedAsset = Object.freeze({
      assetName: `${assetNamePrefix}-${sha256}.bin`,
      bytes: bytes.byteLength,
      logicalIds: Object.freeze(entries.map((entry) => entry.logicalId)),
      releaseTag,
      sha256,
    });
    validateSelectedAssetEntry(selectedAsset);
    return Object.freeze({ bytes, references, selectedAsset });
  }));
}

function selectedByLogicalId(entries) {
  return new Map(entries.flatMap((entry) => entry.logicalIds.map((logicalId) => [logicalId, entry.sha256])));
}

function identityKey(identity) {
  return `${identity.sha256}:${identity.releaseTag}:${identity.assetName}:${identity.bytes}`;
}

export function validateAssetMembershipTransition(value) {
  exactKeys(value, ["removals", "replacements"], "Asset membership transition");
  if (!Array.isArray(value.replacements) || !Array.isArray(value.removals)) {
    throw new Error("Asset membership transition members are invalid.");
  }
  let previousLogicalId = "";
  for (const replacement of value.replacements) {
    exactKeys(replacement, ["logicalId", "previousAssetSha256"], "Asset membership replacement");
    parseMarketDataLogicalId(replacement.logicalId);
    if (
      replacement.logicalId <= previousLogicalId
      || replacement.previousAssetSha256 !== null && !isSha256Hex(replacement.previousAssetSha256)
    ) throw new Error("Asset membership replacements are duplicated, unordered, or invalid.");
    previousLogicalId = replacement.logicalId;
  }
  previousLogicalId = "";
  const replacementIds = new Set(value.replacements.map((replacement) => replacement.logicalId));
  for (const logicalId of value.removals) {
    parseMarketDataLogicalId(logicalId);
    if (logicalId <= previousLogicalId || replacementIds.has(logicalId)) {
      throw new Error("Asset membership removals are duplicated, unordered, or overlap replacements.");
    }
    previousLogicalId = logicalId;
  }
  return value;
}

export function applyAssetMembershipTransition({ previousAssets, packedAssets, transition }) {
  validateSelectedAssetEntries(previousAssets);
  if (!Array.isArray(packedAssets)) throw new Error("Packed assets must be an array.");
  validateAssetMembershipTransition(transition);
  const { replacements, removals } = transition;
  const nextBySha256 = new Map(previousAssets.map((entry) => [entry.sha256, {
    ...entry,
    logicalIds: new Set(entry.logicalIds),
  }]));
  const previousLogicalIds = selectedByLogicalId(previousAssets);
  const packedLogicalIds = new Map();
  for (const packed of packedAssets) {
    validateSelectedAssetEntry(packed.selectedAsset);
    if (nextBySha256.has(packed.selectedAsset.sha256)) throw new Error("A retained asset cannot gain packed membership.");
    for (const logicalId of packed.selectedAsset.logicalIds) {
      if (packedLogicalIds.has(logicalId)) throw new Error("Packed logical ID is duplicated.");
      packedLogicalIds.set(logicalId, packed.selectedAsset.sha256);
    }
    nextBySha256.set(packed.selectedAsset.sha256, {
      ...packed.selectedAsset,
      logicalIds: new Set(packed.selectedAsset.logicalIds),
    });
  }
  const changedLogicalIds = new Set();
  for (const change of replacements) {
    exactKeys(change, ["logicalId", "previousAssetSha256"], "Asset membership replacement");
    parseMarketDataLogicalId(change.logicalId);
    if (changedLogicalIds.has(change.logicalId) || packedLogicalIds.get(change.logicalId) === undefined) {
      throw new Error("Asset membership replacement is invalid.");
    }
    const previousSha256 = previousLogicalIds.get(change.logicalId) ?? null;
    if (previousSha256 !== change.previousAssetSha256) throw new Error("Previous asset membership is inconsistent.");
    if (previousSha256 !== null) nextBySha256.get(previousSha256).logicalIds.delete(change.logicalId);
    changedLogicalIds.add(change.logicalId);
  }
  for (const logicalId of removals) {
    parseMarketDataLogicalId(logicalId);
    if (changedLogicalIds.has(logicalId) || packedLogicalIds.has(logicalId)) throw new Error("Removed asset membership is invalid.");
    const previousSha256 = previousLogicalIds.get(logicalId);
    if (previousSha256 === undefined) throw new Error("Removed logical ID was not selected.");
    nextBySha256.get(previousSha256).logicalIds.delete(logicalId);
    changedLogicalIds.add(logicalId);
  }
  if (changedLogicalIds.size !== packedLogicalIds.size + removals.length) {
    throw new Error("Packed asset membership has no exact replacement set.");
  }
  const nextAssets = [...nextBySha256.values()]
    .filter((entry) => entry.logicalIds.size > 0)
    .map((entry) => Object.freeze({
      assetName: entry.assetName,
      bytes: entry.bytes,
      logicalIds: Object.freeze([...entry.logicalIds].sort()),
      releaseTag: entry.releaseTag,
      sha256: entry.sha256,
    }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  validateSelectedAssetEntries(nextAssets);
  const previousIdentities = new Map(previousAssets.map((entry) => [identityKey(entry), physicalAssetIdentity(entry)]));
  const nextIdentities = new Map(nextAssets.map((entry) => [identityKey(entry), physicalAssetIdentity(entry)]));
  const newAssets = [...nextIdentities].filter(([key]) => !previousIdentities.has(key)).map(([, identity]) => identity);
  const supersededAssets = [...previousIdentities].filter(([key]) => !nextIdentities.has(key)).map(([, identity]) => identity);
  return Object.freeze({
    newAssets: Object.freeze(newAssets.sort((left, right) => left.sha256.localeCompare(right.sha256))),
    nextAssets: Object.freeze(nextAssets),
    supersededAssets: Object.freeze(supersededAssets.sort((left, right) => left.sha256.localeCompare(right.sha256))),
  });
}
