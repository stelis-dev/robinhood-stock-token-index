import { link, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  publicationObjectName,
  validateStoredReference,
  validateGeneration,
  validatePairId,
  validateStateIdentity,
  validateStateBytes,
  parseStateObjectName,
  referenceObjectName,
  stateObjectName,
  StoredDataIntegrityError,
  verifyStateIdentityBytes,
  verifyStoredReferenceBytes,
} from "./stored-files.mjs";

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

async function immutableWrite(path, bytes, maximumBytes) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
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

function referenceDirectory(root, reference) {
  const identity = validateStoredReference(reference);
  const pairRoot = join(root, "pairs", identity.pairId);
  const pairMonth = identity.kind === "day" ? identity.period.slice(0, 7) : identity.period;
  return join(pairRoot, "months", pairMonth);
}

function referencePath(root, reference) {
  return join(referenceDirectory(root, reference), referenceObjectName(reference));
}

function stateDirectory(root, pairId) {
  return join(root, "pairs", validatePairId(pairId), "state");
}

function statePath(root, pairId, sequence) {
  return join(stateDirectory(root, pairId), stateObjectName(sequence));
}

function publicationPath(root, pairId) {
  return join(stateDirectory(root, pairId), publicationObjectName);
}

async function removeExactFile(path, expectedBytes, maximumBytes) {
  const stored = await readOptionalBoundedFile(path, maximumBytes);
  if (stored === null) return;
  if (!stored.equals(expectedBytes)) throw new StoredDataIntegrityError();
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export class DirectoryStore {
  constructor({ root, maximumArtifactBytes }) {
    if (typeof root !== "string" || root.length === 0) throw new Error("Directory root is required.");
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
    this.root = root;
    this.maximumArtifactBytes = maximumArtifactBytes;
  }

  async readSelectedState(pairId) {
    validatePairId(pairId);
    const directory = stateDirectory(this.root, pairId);
    const candidates = (await entries(directory))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, sequence: parseStateObjectName(entry.name) }))
      .filter((entry) => entry.sequence !== null)
      .sort((left, right) => left.sequence - right.sequence);
    if (candidates.length === 0) return null;
    const selected = candidates.at(-1);
    const gzipBytes = validateStateBytes(await readBoundedFile(join(directory, selected.name), this.maximumArtifactBytes), this.maximumArtifactBytes);
    return { sequence: selected.sequence, gzipBytes };
  }

  async readReferenced(reference) {
    return verifyStoredReferenceBytes(
      reference,
      await readBoundedFile(referencePath(this.root, reference), this.maximumArtifactBytes),
      this.maximumArtifactBytes,
    );
  }

  async writeReferenced(reference, gzipBytes) {
    verifyStoredReferenceBytes(reference, gzipBytes, this.maximumArtifactBytes);
    const directory = referenceDirectory(this.root, reference);
    await mkdir(directory, { recursive: true });
    return verifyStoredReferenceBytes(
      reference,
      await immutableWrite(join(directory, referenceObjectName(reference)), gzipBytes, this.maximumArtifactBytes),
      this.maximumArtifactBytes,
    );
  }

  async writeState(pairId, sequence, gzipBytes) {
    validatePairId(pairId);
    validateGeneration(sequence);
    validateStateBytes(gzipBytes, this.maximumArtifactBytes);
    const directory = stateDirectory(this.root, pairId);
    await mkdir(directory, { recursive: true });
    return validateStateBytes(
      await immutableWrite(join(directory, stateObjectName(sequence)), gzipBytes, this.maximumArtifactBytes),
      this.maximumArtifactBytes,
    );
  }

  async readPublication(pairId) {
    validatePairId(pairId);
    const gzipBytes = await readOptionalBoundedFile(publicationPath(this.root, pairId), this.maximumArtifactBytes);
    return gzipBytes === null ? { status: "absent" } : { status: "uploaded", gzipBytes };
  }

  async createPublication(pairId, gzipBytes) {
    validatePairId(pairId);
    validateStateBytes(gzipBytes, this.maximumArtifactBytes);
    const directory = stateDirectory(this.root, pairId);
    await mkdir(directory, { recursive: true });
    return validateStateBytes(
      await immutableWrite(publicationPath(this.root, pairId), gzipBytes, this.maximumArtifactBytes),
      this.maximumArtifactBytes,
    );
  }

  async removePublication(pairId, gzipBytes) {
    validatePairId(pairId);
    validateStateBytes(gzipBytes, this.maximumArtifactBytes);
    await removeExactFile(publicationPath(this.root, pairId), gzipBytes, this.maximumArtifactBytes);
  }

  async removePublicationStarter(pairId) {
    validatePairId(pairId);
    if (await readOptionalBoundedFile(publicationPath(this.root, pairId), this.maximumArtifactBytes) !== null) {
      throw new StoredDataIntegrityError();
    }
  }

  async readState(pairId, identity) {
    validatePairId(pairId);
    validateStateIdentity(identity);
    const bytes = await readOptionalBoundedFile(statePath(this.root, pairId, identity.sequence), this.maximumArtifactBytes);
    return bytes === null ? null : verifyStateIdentityBytes(identity, bytes, this.maximumArtifactBytes);
  }

  async proveReferenced(reference) {
    await this.readReferenced(reference);
  }

  async removeReferenced(reference) {
    validateStoredReference(reference);
    const bytes = await readOptionalBoundedFile(referencePath(this.root, reference), this.maximumArtifactBytes);
    if (bytes === null) return;
    verifyStoredReferenceBytes(reference, bytes, this.maximumArtifactBytes);
    await removeExactFile(referencePath(this.root, reference), bytes, this.maximumArtifactBytes);
  }

  async removeState(pairId, identity) {
    validatePairId(pairId);
    validateStateIdentity(identity);
    const bytes = await this.readState(pairId, identity);
    if (bytes === null) return;
    await removeExactFile(statePath(this.root, pairId, identity.sequence), bytes, this.maximumArtifactBytes);
  }

}
