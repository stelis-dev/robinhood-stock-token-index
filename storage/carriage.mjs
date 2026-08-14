import { sha256Hex } from "../collector/canonical.mjs";

const pairIdPattern = /^0x[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const monthPattern = /^\d{4}-\d{2}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid member set.`);
}

export function admitPairId(value) {
  if (typeof value !== "string" || !pairIdPattern.test(value)) throw new Error("Pair ID is invalid.");
  return value;
}

export function admitCarrierSequence(value, label = "carrier sequence") {
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

export function admitPairMonth(value) {
  return canonicalPeriod(value, "month");
}

export function parseReferenceLogicalId(value) {
  if (typeof value !== "string") throw new Error("Reference logical identity is invalid.");
  const match = value.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/);
  if (!match) throw new Error("Reference logical identity is invalid.");
  const kind = match[2] === "months" ? "month" : "day";
  return {
    pairId: admitPairId(match[1]),
    kind,
    period: canonicalPeriod(match[3], kind),
  };
}

export function admitCarriedReference(value) {
  exactKeys(value, ["coverage", "gzipBytes", "gzipSha256", "jsonBytes", "jsonSha256", "logicalId", "sequence"], "carried reference");
  const identity = parseReferenceLogicalId(value.logicalId);
  admitCarrierSequence(value.sequence, "reference sequence");
  for (const key of ["gzipBytes", "jsonBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`Reference ${key} is invalid.`);
  }
  for (const key of ["gzipSha256", "jsonSha256"]) {
    if (typeof value[key] !== "string" || !digestPattern.test(value[key])) throw new Error(`Reference ${key} is invalid.`);
  }
  return identity;
}

function generation(value) {
  return String(admitCarrierSequence(value)).padStart(16, "0");
}

export function stateObjectName(sequence) {
  return `state-g${generation(sequence)}.json.gz`;
}

export function referenceObjectName(reference) {
  const identity = admitCarriedReference(reference);
  return `${identity.kind}-${identity.period}-g${generation(reference.sequence)}-${reference.gzipSha256}.json.gz`;
}

export function parseReferencedObjectName(pairId, value) {
  const ownerPairId = admitPairId(pairId);
  const match = typeof value === "string"
    ? value.match(/^(month|day)-(.+)-g([0-9]{16})-([0-9a-f]{64})\.json\.gz$/)
    : null;
  if (!match) return null;
  const kind = match[1];
  let period;
  try {
    period = canonicalPeriod(match[2], kind);
  } catch {
    return null;
  }
  const sequence = Number(match[3]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return {
    pairId: ownerPairId,
    kind,
    period,
    sequence,
    gzipSha256: match[4],
    logicalId: `pairs/${ownerPairId}/${kind === "month" ? "months" : "days"}/${period}`,
    name: value,
  };
}

export function admitCleanupPlan(value) {
  exactKeys(value, ["changedMonths", "pairId", "selectedSequence"], "cleanup plan");
  const pairId = admitPairId(value.pairId);
  const selectedSequence = admitCarrierSequence(value.selectedSequence, "selected state sequence");
  if (!Array.isArray(value.changedMonths) || value.changedMonths.length === 0) {
    throw new Error("Cleanup changed months are required.");
  }

  const logicalIds = new Set();
  const changedMonths = [];
  let previousMonth = "";
  for (const [index, scope] of value.changedMonths.entries()) {
    exactKeys(scope, ["dayReferences", "monthReference"], `cleanup changedMonths[${index}]`);
    const monthIdentity = admitCarriedReference(scope.monthReference);
    if (monthIdentity.kind !== "month" || monthIdentity.pairId !== pairId || scope.monthReference.sequence !== selectedSequence) {
      throw new Error("Cleanup month does not identify the selected pair generation.");
    }
    if (monthIdentity.period <= previousMonth) throw new Error("Cleanup months are duplicated or unordered.");
    previousMonth = monthIdentity.period;
    if (!Array.isArray(scope.dayReferences) || scope.dayReferences.length === 0) {
      throw new Error("Cleanup month day references are required.");
    }

    const objects = [];
    const append = (reference, identity) => {
      if (logicalIds.has(reference.logicalId)) throw new Error("Cleanup logical identities are duplicated.");
      logicalIds.add(reference.logicalId);
      objects.push({
        logicalId: reference.logicalId,
        name: referenceObjectName(reference),
        sequence: reference.sequence,
      });
    };
    append(scope.monthReference, monthIdentity);

    let previousDay = "";
    let ownsChangedDay = false;
    for (const dayReference of scope.dayReferences) {
      const dayIdentity = admitCarriedReference(dayReference);
      if (
        dayIdentity.kind !== "day"
        || dayIdentity.pairId !== pairId
        || dayIdentity.period.slice(0, 7) !== monthIdentity.period
        || dayReference.sequence > selectedSequence
      ) {
        throw new Error("Cleanup day does not belong to its selected pair-month.");
      }
      if (dayIdentity.period <= previousDay) throw new Error("Cleanup days are duplicated or unordered.");
      previousDay = dayIdentity.period;
      ownsChangedDay ||= dayReference.sequence === selectedSequence;
      append(dayReference, dayIdentity);
    }
    if (!ownsChangedDay) throw new Error("Cleanup month has no owner-generation day.");
    changedMonths.push({ month: monthIdentity.period, objects });
  }

  return {
    pairId,
    selectedSequence,
    selectedStateName: stateObjectName(selectedSequence),
    changedMonths,
  };
}

export function verifyCarriedReferenceBytes(reference, bytes, maximumArtifactBytes) {
  admitCarriedReference(reference);
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== reference.gzipBytes || bytes.byteLength > maximumArtifactBytes || sha256Hex(bytes) !== reference.gzipSha256) {
    throw new Error("Carried bytes do not match their reference.");
  }
  return bytes;
}

export function admitStateBytes(bytes, maximumArtifactBytes) {
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumArtifactBytes) {
    throw new Error("State bytes exceed the admitted carriage boundary.");
  }
  return bytes;
}

export function parseStateObjectName(value) {
  const match = typeof value === "string" ? value.match(/^state-g([0-9]{16})\.json\.gz$/) : null;
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
