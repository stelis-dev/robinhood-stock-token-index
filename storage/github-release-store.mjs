import {
  canonicalStateDigest,
  decodeDay,
  decodeState,
  encodeState,
  stateAssetName,
  verifyEncodedReference,
} from "../collector/artifact.mjs";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function readBounded(response, maximumBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && (!/^[0-9]+$/.test(contentLength) || BigInt(contentLength) > BigInt(maximumBytes))) {
    throw new Error("GitHub response exceeds the admitted byte limit.");
  }
  const chunks = [];
  let byteLength = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new Error("GitHub response exceeds the admitted byte limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const value = Buffer.from(await response.arrayBuffer());
    byteLength = value.byteLength;
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, byteLength);
  if (bytes.byteLength > maximumBytes) throw new Error("GitHub response exceeds the admitted byte limit.");
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not JSON.`);
  }
}

function admitRelease(value, tag) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id <= 0 || value.tag_name !== tag) {
    throw new Error("GitHub release response is invalid.");
  }
  return { id: value.id, tag };
}

function admitAsset(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.name !== "string" || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error("GitHub release asset response is invalid.");
  }
  return { id: value.id, name: value.name, size: value.size };
}

export class GitHubReleaseStore {
  constructor({ repository, token, registry, group, fetchImplementation = fetch, signal }) {
    if (!repositoryPattern.test(repository)) throw new Error("GitHub repository identity is invalid.");
    if (typeof token !== "string" || token.length === 0) throw new Error("GitHub token is required.");
    this.repository = repository;
    this.token = token;
    this.registry = registry;
    this.group = group;
    this.fetch = fetchImplementation;
    this.signal = signal;
  }

  async #request(path, { method = "GET", body, contentType = "application/vnd.github+json", allowNotFound = false, maximumBytes = 2_097_152 } = {}) {
    this.signal?.throwIfAborted();
    const target = path.startsWith("https://") ? path : `https://api.github.com${path}`;
    const response = await this.fetch(target, {
      method,
      headers: {
        accept: contentType === "application/gzip" ? "application/octet-stream" : "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": contentType,
        "user-agent": "robinhood-stock-token-index",
        "x-github-api-version": "2022-11-28",
      },
      body,
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    const bytes = await readBounded(response, maximumBytes);
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}.`);
    return bytes;
  }

  async #getRelease(tag) {
    const bytes = await this.#request(`/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    return bytes === null ? null : admitRelease(parseJson(bytes, "GitHub release response"), tag);
  }

  async #ensureRelease(tag) {
    const existing = await this.#getRelease(tag);
    if (existing) return existing;
    const body = Buffer.from(JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }), "utf8");
    const bytes = await this.#request(`/repos/${this.repository}/releases`, { method: "POST", body });
    return admitRelease(parseJson(bytes, "GitHub release creation response"), tag);
  }

  async #listAssets(releaseId) {
    const output = [];
    for (let page = 1; page <= 11; page += 1) {
      const bytes = await this.#request(`/repos/${this.repository}/releases/${releaseId}/assets?per_page=100&page=${page}`);
      const values = parseJson(bytes, "GitHub release asset list");
      if (!Array.isArray(values)) throw new Error("GitHub release asset list is invalid.");
      const part = values.map(admitAsset);
      output.push(...part);
      if (output.length > 1_000) throw new Error("GitHub release asset list exceeds the admitted asset limit.");
      if (part.length < 100) break;
      if (page === 11) throw new Error("GitHub release asset list exceeds the admitted page limit.");
    }
    const names = new Set();
    for (const asset of output) {
      if (names.has(asset.name)) throw new Error("GitHub release contains duplicate asset names.");
      names.add(asset.name);
    }
    return output;
  }

  async #downloadAsset(asset) {
    if (asset.size > this.registry.collection.maximumArtifactBytes) throw new Error("GitHub asset exceeds the admitted byte limit.");
    return this.#request(`/repos/${this.repository}/releases/assets/${asset.id}`, {
      contentType: "application/gzip",
      maximumBytes: this.registry.collection.maximumArtifactBytes,
    });
  }

  async #uploadImmutable(release, name, bytes) {
    const assets = await this.#listAssets(release.id);
    const existing = assets.find((asset) => asset.name === name);
    if (existing) {
      const stored = await this.#downloadAsset(existing);
      if (!stored.equals(bytes)) throw new Error(`GitHub immutable asset differs: ${name}`);
      return existing;
    }
    const uploadedBytes = await this.#request(`https://uploads.github.com/repos/${this.repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: bytes,
      contentType: "application/gzip",
    });
    const uploaded = admitAsset(parseJson(uploadedBytes, "GitHub asset upload response"));
    if (uploaded.name !== name || uploaded.size !== bytes.byteLength) throw new Error("GitHub asset upload identity is invalid.");
    const stored = await this.#downloadAsset(uploaded);
    if (!stored.equals(bytes)) throw new Error(`GitHub uploaded asset differs: ${name}`);
    return uploaded;
  }

  async #deleteAsset(assetId) {
    await this.#request(`/repos/${this.repository}/releases/assets/${assetId}`, { method: "DELETE", maximumBytes: 1024 });
  }

  async #listIndexReleases() {
    const output = [];
    for (let page = 1; page <= 20; page += 1) {
      const bytes = await this.#request(`/repos/${this.repository}/releases?per_page=100&page=${page}`);
      const values = parseJson(bytes, "GitHub release list");
      if (!Array.isArray(values)) throw new Error("GitHub release list is invalid.");
      for (const value of values) {
        if (value && typeof value.tag_name === "string" && /^index-(?:state|[0-9]{4}-[0-9]{2})$/.test(value.tag_name)) {
          output.push(admitRelease(value, value.tag_name));
        }
      }
      if (values.length < 100) break;
      if (page === 20) throw new Error("GitHub release list exceeds the admitted page limit.");
    }
    return output;
  }

  async readState() {
    const release = await this.#getRelease("index-state");
    if (!release) return null;
    const pattern = new RegExp(`^${this.group.groupId}-state-g([0-9]{16})\\.json\\.gz$`);
    const candidates = (await this.#listAssets(release.id))
      .map((asset) => ({ asset, match: asset.name.match(pattern) }))
      .filter((entry) => entry.match)
      .sort((left, right) => left.asset.name.localeCompare(right.asset.name));
    if (candidates.length === 0) return null;
    return decodeState(
      await this.#downloadAsset(candidates.at(-1).asset),
      this.group.groupId,
      this.registry.collection.maximumArtifactBytes,
      candidates.at(-1).match[1],
    );
  }

  async readDay(reference) {
    const release = await this.#getRelease(reference.releaseTag);
    if (!release) throw new Error(`GitHub release is missing: ${reference.releaseTag}`);
    const asset = (await this.#listAssets(release.id)).find((candidate) => candidate.name === reference.assetName);
    if (!asset) throw new Error(`GitHub day asset is missing: ${reference.assetName}`);
    return decodeDay(await this.#downloadAsset(asset), { registry: this.registry, group: this.group }, reference);
  }

  async commit({ state, encodedDays }) {
    const encodedState = encodeState(state, this.group.groupId, this.registry.collection.maximumArtifactBytes);
    for (const entry of encodedDays) {
      verifyEncodedReference(entry.encoded.gzipBytes, entry.reference);
      const release = await this.#ensureRelease(entry.reference.releaseTag);
      await this.#uploadImmutable(release, entry.reference.assetName, entry.encoded.gzipBytes);
    }
    const stateRelease = await this.#ensureRelease("index-state");
    await this.#uploadImmutable(stateRelease, stateAssetName(this.group.groupId, state.sequence), encodedState.gzipBytes);
    const selected = await this.readState();
    if (!selected || canonicalStateDigest(selected) !== canonicalStateDigest(state)) throw new Error("GitHub did not select the published state.");
    await this.cleanup(state);
    return encodedState;
  }

  async cleanup(state) {
    const retained = new Map();
    for (const reference of state.days) {
      const names = retained.get(reference.releaseTag) ?? new Set();
      names.add(reference.assetName);
      retained.set(reference.releaseTag, names);
    }
    const stateName = stateAssetName(this.group.groupId, state.sequence);
    for (const release of await this.#listIndexReleases()) {
      const assets = await this.#listAssets(release.id);
      for (const asset of assets) {
        if (release.tag === "index-state") {
          const match = asset.name.match(new RegExp(`^${this.group.groupId}-state-g([0-9]{16})\\.json\\.gz$`));
          if (match && BigInt(match[1]) < BigInt(state.sequence) && asset.name !== stateName) await this.#deleteAsset(asset.id);
          continue;
        }
        const match = asset.name.match(new RegExp(`^${this.group.groupId}-[0-9]{4}-[0-9]{2}-[0-9]{2}-g([0-9]{16})-[0-9a-f]{64}\\.json\\.gz$`));
        if (match && BigInt(match[1]) <= BigInt(state.sequence) && !retained.get(release.tag)?.has(asset.name)) {
          await this.#deleteAsset(asset.id);
        }
      }
    }
  }
}
