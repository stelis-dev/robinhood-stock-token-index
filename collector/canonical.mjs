import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const sha256HexPattern = /^[0-9a-f]{64}$/;

// Canonical JSON sorts object keys and normalizes values so one valid value has one byte form.

function normalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Canonical numbers must be safe integers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const member = value[key];
      if (member === undefined) {
        throw new TypeError("Canonical objects cannot contain undefined.");
      }
      output[key] = normalize(member);
    }
    return output;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSha256Hex(value) {
  return typeof value === "string" && sha256HexPattern.test(value);
}

export function encodeArtifact(value) {
  const jsonBytes = canonicalBytes(value);
  const gzipBytes = gzipSync(jsonBytes, { level: 9, mtime: 0 });
  return {
    jsonBytes,
    gzipBytes,
    jsonSha256: sha256Hex(jsonBytes),
    gzipSha256: sha256Hex(gzipBytes),
  };
}

export function decodeArtifact(gzipBytes, maximumBytes = 16_777_216) {
  if (!Buffer.isBuffer(gzipBytes) || gzipBytes.byteLength > maximumBytes) throw new Error("Compressed data exceeds the maximum byte size.");
  const jsonBytes = gunzipSync(gzipBytes, { maxOutputLength: maximumBytes });
  const value = JSON.parse(jsonBytes.toString("utf8"));
  if (!canonicalBytes(value).equals(jsonBytes)) {
    throw new Error("Artifact JSON is not canonical.");
  }
  return {
    value,
    jsonBytes,
    jsonSha256: sha256Hex(jsonBytes),
    gzipSha256: sha256Hex(gzipBytes),
  };
}
