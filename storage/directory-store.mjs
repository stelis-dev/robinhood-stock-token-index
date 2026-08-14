import { link, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  admitCleanupPlan,
  admitCarriedReference,
  admitCarrierSequence,
  admitPairId,
  admitPairMonth,
  admitStateBytes,
  parseReferencedObjectName,
  parseStateObjectName,
  referenceObjectName,
  stateObjectName,
  verifyCarriedReferenceBytes,
} from "./carriage.mjs";

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
      throw new Error("Stored file exceeds the admitted byte boundary.");
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
}

function referenceDirectory(root, reference) {
  const identity = admitCarriedReference(reference);
  const pairRoot = join(root, "pairs", identity.pairId);
  const pairMonth = identity.kind === "month" ? identity.period : identity.period.slice(0, 7);
  return join(pairRoot, "months", pairMonth);
}

function referencePath(root, reference) {
  return join(referenceDirectory(root, reference), referenceObjectName(reference));
}

export class DirectoryStore {
  constructor({ root, maximumArtifactBytes }) {
    if (typeof root !== "string" || root.length === 0) throw new Error("Directory root is required.");
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
    this.root = root;
    this.maximumArtifactBytes = maximumArtifactBytes;
  }

  async readSelectedState(pairId) {
    admitPairId(pairId);
    const directory = join(this.root, "pairs", pairId, "state");
    const candidates = (await entries(directory))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, sequence: parseStateObjectName(entry.name) }))
      .filter((entry) => entry.sequence !== null)
      .sort((left, right) => left.sequence - right.sequence);
    if (candidates.length === 0) return null;
    const selected = candidates.at(-1);
    const gzipBytes = admitStateBytes(await readBoundedFile(join(directory, selected.name), this.maximumArtifactBytes), this.maximumArtifactBytes);
    return { sequence: selected.sequence, gzipBytes };
  }

  async readReferenced(reference) {
    return verifyCarriedReferenceBytes(
      reference,
      await readBoundedFile(referencePath(this.root, reference), this.maximumArtifactBytes),
      this.maximumArtifactBytes,
    );
  }

  async resolvePairMonth(pairId, pairMonth) {
    admitPairId(pairId);
    admitPairMonth(pairMonth);
    return "present";
  }

  async writeReferenced(reference, gzipBytes) {
    verifyCarriedReferenceBytes(reference, gzipBytes, this.maximumArtifactBytes);
    const directory = referenceDirectory(this.root, reference);
    await mkdir(directory, { recursive: true });
    await immutableWrite(join(directory, referenceObjectName(reference)), gzipBytes, this.maximumArtifactBytes);
  }

  async writeState(pairId, sequence, gzipBytes) {
    admitPairId(pairId);
    admitCarrierSequence(sequence);
    admitStateBytes(gzipBytes, this.maximumArtifactBytes);
    const directory = join(this.root, "pairs", pairId, "state");
    await mkdir(directory, { recursive: true });
    await immutableWrite(join(directory, stateObjectName(sequence)), gzipBytes, this.maximumArtifactBytes);
  }

  async cleanupSelectedGeneration(input) {
    const plan = admitCleanupPlan(input);
    const stateDirectory = join(this.root, "pairs", plan.pairId, "state");
    const stateEntries = await entries(stateDirectory);
    if (!stateEntries.some((entry) => entry.isFile() && entry.name === plan.selectedStateName)) {
      throw new Error("Selected state carrier is unavailable during cleanup.");
    }

    const scopes = [];
    for (const changedMonth of plan.changedMonths) {
      const directory = join(this.root, "pairs", plan.pairId, "months", changedMonth.month);
      const scopeEntries = await entries(directory);
      const names = new Set(scopeEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
      for (const object of changedMonth.objects) {
        if (!names.has(object.name)) throw new Error("Retained object is unavailable during cleanup.");
      }
      scopes.push({
        directory,
        entries: scopeEntries,
        retained: new Map(changedMonth.objects.map((object) => [object.logicalId, object.name])),
      });
    }

    for (const entry of stateEntries) {
      const sequence = entry.isFile() ? parseStateObjectName(entry.name) : null;
      if (sequence !== null && sequence < plan.selectedSequence) await unlink(join(stateDirectory, entry.name));
    }

    for (const scope of scopes) {
      for (const entry of scope.entries) {
        const parsed = entry.isFile() ? parseReferencedObjectName(plan.pairId, entry.name) : null;
        const retainedName = parsed === null ? undefined : scope.retained.get(parsed.logicalId);
        if (retainedName !== undefined && parsed.sequence <= plan.selectedSequence && entry.name !== retainedName) {
          await unlink(join(scope.directory, entry.name));
        }
      }
    }
  }

}
