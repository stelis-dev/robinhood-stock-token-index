import { link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeDay, decodeState, encodeState, stateAssetName } from "../collector/artifact.mjs";

async function files(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function immutableWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await link(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`Stored immutable bytes differ: ${path}`);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class DirectoryStore {
  constructor({ root, registry, group }) {
    this.root = root;
    this.registry = registry;
    this.group = group;
  }

  async #initialize() {
    await mkdir(join(this.root, "states"), { recursive: true });
    await mkdir(join(this.root, "days"), { recursive: true });
  }

  async readState() {
    await this.#initialize();
    const pattern = new RegExp(`^${this.group.groupId}-state-g([0-9]{16})\\.json\\.gz$`);
    const candidates = (await files(join(this.root, "states"))).map((name) => ({ name, match: name.match(pattern) })).filter((entry) => entry.match).sort((a, b) => a.name.localeCompare(b.name));
    if (candidates.length === 0) return null;
    return decodeState(
      await readFile(join(this.root, "states", candidates.at(-1).name)),
      this.group.groupId,
      this.registry.collection.maximumArtifactBytes,
      candidates.at(-1).match[1],
    );
  }

  async readDay(reference) {
    const bytes = await readFile(join(this.root, "days", reference.releaseTag, reference.assetName));
    return decodeDay(bytes, { registry: this.registry, group: this.group }, reference);
  }

  async commit({ state, encodedDays }) {
    await this.#initialize();
    for (const entry of encodedDays) {
      const directory = join(this.root, "days", entry.reference.releaseTag);
      await mkdir(directory, { recursive: true });
      await immutableWrite(join(directory, entry.reference.assetName), entry.encoded.gzipBytes);
    }
    const encodedState = encodeState(state, this.group.groupId, this.registry.collection.maximumArtifactBytes);
    await immutableWrite(join(this.root, "states", stateAssetName(this.group.groupId, state.sequence)), encodedState.gzipBytes);
    await this.cleanup(state);
    return encodedState;
  }

  async cleanup(state) {
    const statePattern = new RegExp(`^${this.group.groupId}-state-g([0-9]{16})\\.json\\.gz$`);
    for (const name of await files(join(this.root, "states"))) {
      const match = name.match(statePattern);
      if (match && BigInt(match[1]) < BigInt(state.sequence)) await unlink(join(this.root, "states", name));
    }
    const retainedDays = new Map();
    for (const reference of state.days) retainedDays.set(`${reference.releaseTag}/${reference.assetName}`, true);
    const dayPattern = new RegExp(`^${this.group.groupId}-[0-9]{4}-[0-9]{2}-[0-9]{2}-g([0-9]{16})-[0-9a-f]{64}\\.json\\.gz$`);
    for (const releaseTag of await files(join(this.root, "days"))) {
      for (const name of await files(join(this.root, "days", releaseTag))) {
        const match = name.match(dayPattern);
        if (match && BigInt(match[1]) <= BigInt(state.sequence) && !retainedDays.has(`${releaseTag}/${name}`)) await unlink(join(this.root, "days", releaseTag, name));
      }
    }
  }
}
