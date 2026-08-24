import { isSha256Hex, sha256Hex } from "../collector/canonical.mjs";
import { isCanonicalBytes32 } from "../collector/hex-data.mjs";
import {
  pairDayResolutionLabel,
  parsePairFileLogicalId,
} from "../collector/pair-file-identity.mjs";

export class StoredDataIntegrityError extends Error {
  constructor() {
    super("Stored data failed integrity validation.");
    this.name = "StoredDataIntegrityError";
  }
}

export function storedDataFailureFields(error) {
  return error instanceof StoredDataIntegrityError
    ? "component=stored_data reason=integrity_rejected"
    : null;
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

export function validatePairId(value) {
  if (!isCanonicalBytes32(value)) throw new Error("Pair ID is invalid.");
  return value;
}

export function validateGeneration(value, label = "generation") {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

export function validateStoredReference(value) {
  const identity = parsePairFileLogicalId(value?.logicalId);
  if (identity.kind === "resolution") {
    exactKeys(value, ["gzipBytes", "gzipSha256", "intervalSeconds", "jsonBytes", "jsonSha256", "logicalId", "sequence", "timeCoverage"], "stored resolution reference");
    if (value.intervalSeconds !== identity.intervalSeconds) throw new Error("Stored resolution interval is invalid.");
    exactKeys(value.timeCoverage, ["fromTimestamp", "untilTimestamp"], "stored resolution coverage");
    if (
      typeof value.timeCoverage.fromTimestamp !== "string"
      || typeof value.timeCoverage.untilTimestamp !== "string"
      || value.timeCoverage.fromTimestamp >= value.timeCoverage.untilTimestamp
    ) {
      throw new Error("Stored resolution coverage is invalid.");
    }
    validateGeneration(value.sequence, "reference generation");
    for (const key of ["gzipBytes", "jsonBytes"]) {
      if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`Reference ${key} is invalid.`);
    }
    for (const key of ["gzipSha256", "jsonSha256"]) {
      if (!isSha256Hex(value[key])) throw new Error(`Reference ${key} is invalid.`);
    }
    return identity;
  }
  exactKeys(value, ["coverage", "gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId", "sequence"], "stored reference");
  validateGeneration(value.sequence, "reference generation");
  for (const key of ["gzipBytes", "jsonBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`Reference ${key} is invalid.`);
  }
  for (const key of ["gzipSha256", "jsonSha256"]) {
    if (!isSha256Hex(value[key])) throw new Error(`Reference ${key} is invalid.`);
  }
  return identity;
}

export function validateStateIdentity(value) {
  exactKeys(value, ["gzipBytes", "gzipSha256", "sequence"], "state identity");
  validateGeneration(value.sequence, "state generation");
  if (!Number.isSafeInteger(value.gzipBytes) || value.gzipBytes <= 0) throw new Error("State gzip byte count is invalid.");
  if (!isSha256Hex(value.gzipSha256)) throw new Error("State gzip digest is invalid.");
  return value;
}

export function createStateIdentity(sequence, bytes, maximumArtifactBytes) {
  validateGeneration(sequence, "state generation");
  validateStateBytes(bytes, maximumArtifactBytes);
  return validateStateIdentity({
    sequence,
    gzipBytes: bytes.byteLength,
    gzipSha256: sha256Hex(bytes),
  });
}

function generation(value) {
  return String(validateGeneration(value)).padStart(16, "0");
}

export function stateObjectName(sequence) {
  return `state-g${generation(sequence)}.json.gz`;
}

export const publicationObjectName = "publication.json.gz";

export function referenceObjectName(reference) {
  const identity = validateStoredReference(reference);
  if (identity.kind === "day") {
    return `candles-${identity.period}-${pairDayResolutionLabel}-g${generation(reference.sequence)}-${reference.gzipSha256}.json.gz`;
  }
  if (identity.kind === "resolution") return `candles-${identity.period}-${identity.label}-g${generation(reference.sequence)}-${reference.gzipSha256}.json.gz`;
  return `month-${identity.period}-g${generation(reference.sequence)}-${reference.gzipSha256}.json.gz`;
}

export function verifyStoredReferenceBytes(reference, bytes, maximumArtifactBytes) {
  validateStoredReference(reference);
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== reference.gzipBytes || bytes.byteLength > maximumArtifactBytes || sha256Hex(bytes) !== reference.gzipSha256) {
    throw new StoredDataIntegrityError();
  }
  return bytes;
}

export function validateStateBytes(bytes, maximumArtifactBytes) {
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumArtifactBytes) {
    throw new StoredDataIntegrityError();
  }
  return bytes;
}

export function verifyStateIdentityBytes(identity, bytes, maximumArtifactBytes) {
  validateStateIdentity(identity);
  validateStateBytes(bytes, maximumArtifactBytes);
  if (bytes.byteLength !== identity.gzipBytes || sha256Hex(bytes) !== identity.gzipSha256) {
    throw new StoredDataIntegrityError();
  }
  return bytes;
}

export function parseStateObjectName(value) {
  const match = typeof value === "string" ? value.match(/^state-g([0-9]{16})\.json\.gz$/) : null;
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
