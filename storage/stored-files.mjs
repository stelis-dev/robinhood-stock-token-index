import { sha256Hex } from "../collector/canonical.mjs";

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

const pairIdPattern = /^0x[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const monthPattern = /^\d{4}-\d{2}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

export function validatePairId(value) {
  if (typeof value !== "string" || !pairIdPattern.test(value)) throw new Error("Pair ID is invalid.");
  return value;
}

export function validateGeneration(value, label = "generation") {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function canonicalPeriod(value, kind) {
  const pattern = kind === "month" ? monthPattern : dayPattern;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Reference ${kind} is invalid.`);
  const instant = kind === "month" ? `${value}-01T00:00:00.000Z` : `${value}T00:00:00.000Z`;
  const width = kind === "month" ? 7 : 10;
  if (Number.isNaN(Date.parse(instant)) || new Date(instant).toISOString().slice(0, width) !== value) {
    throw new Error(`Reference ${kind} is invalid.`);
  }
  return value;
}

export function validatePairMonth(value) {
  return canonicalPeriod(value, "month");
}

export function parseStoredReferenceId(value) {
  if (typeof value !== "string") throw new Error("Stored reference ID is invalid.");
  const match = value.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/);
  if (!match) throw new Error("Stored reference ID is invalid.");
  const kind = match[2] === "months" ? "month" : "day";
  return {
    pairId: validatePairId(match[1]),
    kind,
    period: canonicalPeriod(match[3], kind),
  };
}

export function validateStoredReference(value) {
  exactKeys(value, ["coverage", "gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId", "sequence"], "stored reference");
  const identity = parseStoredReferenceId(value.logicalId);
  validateGeneration(value.sequence, "reference generation");
  for (const key of ["gzipBytes", "jsonBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`Reference ${key} is invalid.`);
  }
  for (const key of ["gzipSha256", "jsonSha256"]) {
    if (typeof value[key] !== "string" || !digestPattern.test(value[key])) throw new Error(`Reference ${key} is invalid.`);
  }
  return identity;
}

export function validateStateIdentity(value) {
  exactKeys(value, ["gzipBytes", "gzipSha256", "sequence"], "state identity");
  validateGeneration(value.sequence, "state generation");
  if (!Number.isSafeInteger(value.gzipBytes) || value.gzipBytes <= 0) throw new Error("State gzip byte count is invalid.");
  if (typeof value.gzipSha256 !== "string" || !digestPattern.test(value.gzipSha256)) throw new Error("State gzip digest is invalid.");
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
  return `${identity.kind}-${identity.period}-g${generation(reference.sequence)}-${reference.gzipSha256}.json.gz`;
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
