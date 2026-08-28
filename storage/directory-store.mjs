import { link, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../collector/canonical.mjs";
import {
  marketDataPublicationAssetName,
  validateMarketDataReleaseTag,
  validatePhysicalAssetIdentity,
} from "../collector/market-data-assets.mjs";
import { StoredDataIntegrityError } from "./storage-error.mjs";

const marketDataNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const temporaryNamePattern = /^[0-9a-f]{64}-[1-9][0-9]*-[0-9]+\.tmp$/u;

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readBoundedFile(path, maximumBytes) {
  const file = await open(path, "r");
  try {
    const information = await file.stat();
    if (!information.isFile() || information.size <= 0 || information.size > maximumBytes) {
      throw new Error("Stored file exceeds the maximum byte size.");
    }
    const bytes = Buffer.alloc(information.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("Stored file changed during its bounded read.");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== information.size) throw new Error("Stored file changed during its bounded read.");
    return bytes;
  } finally {
    await file.close();
  }
}

async function readOptionalBoundedFile(path, maximumBytes) {
  try {
    return await readBoundedFile(path, maximumBytes);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function cleanupTemporaryDirectory(path, signal) {
  signal?.throwIfAborted();
  for (const entry of await entries(path)) {
    signal?.throwIfAborted();
    if (entry.isFile() && temporaryNamePattern.test(entry.name)) await unlink(join(path, entry.name));
  }
}

async function immutableWrite(path, bytes, maximumBytes, temporaryDirectory, signal) {
  signal?.throwIfAborted();
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = join(temporaryDirectory, `${sha256Hex(bytes)}-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", signal });
  try {
    signal?.throwIfAborted();
    await link(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readBoundedFile(path, maximumBytes);
    if (!existing.equals(bytes)) throw new Error("Stored immutable bytes differ from the requested bytes.");
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return readBoundedFile(path, maximumBytes);
}

function marketDataPath(root, releaseTag, assetName) {
  if (!marketDataNamePattern.test(releaseTag) || !marketDataNamePattern.test(assetName)) {
    throw new Error("Market-data physical identity is invalid.");
  }
  return join(root, "releases", releaseTag, assetName);
}

export class DirectoryStore {
  constructor({ root, maximumArtifactBytes, signal }) {
    if (typeof root !== "string" || root.length === 0) throw new Error("Directory root is required.");
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("Directory storage cancellation signal is invalid.");
    this.root = root;
    this.maximumArtifactBytes = maximumArtifactBytes;
    this.signal = signal;
    this.temporaryDirectory = join(root, ".market-data-temporary");
    this.mutationReady = null;
  }

  async #prepareMutation() {
    this.signal?.throwIfAborted();
    if (this.mutationReady === null) {
      this.mutationReady = cleanupTemporaryDirectory(this.temporaryDirectory, this.signal);
    }
    await this.mutationReady;
  }

  async listMarketDataAssets(releaseTag) {
    this.signal?.throwIfAborted();
    validateMarketDataReleaseTag(releaseTag);
    const directory = join(this.root, "releases", releaseTag);
    const output = [];
    for (const entry of await entries(directory)) {
      if (!entry.isFile() || !marketDataNamePattern.test(entry.name)) continue;
      const bytes = await readBoundedFile(join(directory, entry.name), this.maximumArtifactBytes);
      output.push(Object.freeze({ assetName: entry.name, bytes: bytes.byteLength, sha256: sha256Hex(bytes), state: "uploaded" }));
    }
    return Object.freeze(output.sort((left, right) => left.assetName.localeCompare(right.assetName)));
  }

  async readMarketDataPublication() {
    this.signal?.throwIfAborted();
    const bytes = await readOptionalBoundedFile(
      marketDataPath(this.root, "market-data-catalog", marketDataPublicationAssetName),
      this.maximumArtifactBytes,
    );
    if (bytes === null) return Object.freeze({ status: "absent" });
    return Object.freeze({
      bytes,
      identity: Object.freeze({
        assetName: marketDataPublicationAssetName,
        bytes: bytes.byteLength,
        releaseTag: "market-data-catalog",
        sha256: sha256Hex(bytes),
      }),
      status: "uploaded",
    });
  }

  async removeMarketDataPublicationStarter() {
    await this.#prepareMutation();
    if (await readOptionalBoundedFile(
      marketDataPath(this.root, "market-data-catalog", marketDataPublicationAssetName),
      this.maximumArtifactBytes,
    ) !== null) throw new StoredDataIntegrityError();
  }

  async readMarketDataAsset(identity, range = null) {
    this.signal?.throwIfAborted();
    validatePhysicalAssetIdentity(identity);
    const stored = await readBoundedFile(marketDataPath(this.root, identity.releaseTag, identity.assetName), this.maximumArtifactBytes);
    if (stored.byteLength !== identity.bytes || sha256Hex(stored) !== identity.sha256) throw new StoredDataIntegrityError();
    if (range === null) return stored;
    if (!Number.isSafeInteger(range?.from) || !Number.isSafeInteger(range?.until) || range.from < 0 || range.from >= range.until || range.until > stored.byteLength) {
      throw new Error("Market-data byte range is invalid.");
    }
    return stored.subarray(range.from, range.until);
  }

  async writeMarketDataAsset(identity, bytes) {
    await this.#prepareMutation();
    validatePhysicalAssetIdentity(identity);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== identity.bytes || sha256Hex(bytes) !== identity.sha256) {
      throw new Error("Market-data asset bytes are invalid.");
    }
    const directory = join(this.root, "releases", identity.releaseTag);
    await mkdir(directory, { recursive: true });
    return immutableWrite(
      marketDataPath(this.root, identity.releaseTag, identity.assetName),
      bytes,
      this.maximumArtifactBytes,
      this.temporaryDirectory,
      this.signal,
    );
  }

  async removeMarketDataAsset(identity) {
    await this.#prepareMutation();
    validatePhysicalAssetIdentity(identity);
    const path = marketDataPath(this.root, identity.releaseTag, identity.assetName);
    const stored = await readOptionalBoundedFile(path, this.maximumArtifactBytes);
    if (stored === null) return;
    if (stored.byteLength !== identity.bytes || sha256Hex(stored) !== identity.sha256) throw new StoredDataIntegrityError();
    try {
      this.signal?.throwIfAborted();
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
