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

function stateTag(pairId) {
  return `pair-${admitPairId(pairId)}-state`;
}

function monthTag(pairId, pairMonth) {
  return `pair-${admitPairId(pairId)}-month-${admitPairMonth(pairMonth)}`;
}

function referenceTag(reference) {
  const identity = admitCarriedReference(reference);
  const pairMonth = identity.kind === "month" ? identity.period : identity.period.slice(0, 7);
  return monthTag(identity.pairId, pairMonth);
}

function publicAssetUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export class GitHubReleaseStore {
  #token;
  #maximumArtifactBytes;
  #releases = new Map();
  #assets = new Map();
  #writeOperationalLog;

  constructor({ repository, token, maximumArtifactBytes, fetchImplementation = fetch, signal, writeOperationalLog }) {
    if (!repositoryPattern.test(repository)) throw new Error("GitHub repository identity is invalid.");
    if (token !== undefined && (typeof token !== "string" || token.length === 0)) throw new Error("GitHub token is invalid.");
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
    if (writeOperationalLog !== undefined && typeof writeOperationalLog !== "function") throw new Error("Operational log writer is invalid.");
    this.repository = repository;
    this.#token = token;
    this.#maximumArtifactBytes = maximumArtifactBytes;
    this.#writeOperationalLog = writeOperationalLog;
    this.fetch = fetchImplementation;
    this.signal = signal;
  }

  #writeCleanupFailure(plan, phase, pairMonth, objectKind) {
    if (this.#writeOperationalLog === undefined) return;
    const month = pairMonth === undefined ? "" : ` pair_month=${pairMonth}`;
    const kind = objectKind === undefined ? "" : ` object_kind=${objectKind}`;
    this.#writeOperationalLog(
      `github_cleanup status=failed phase=${phase} pair_id=${plan.pairId} selected_sequence=${plan.selectedSequence}${month}${kind}\n`,
    );
  }

  #requireWriteToken() {
    if (this.#token === undefined) throw new Error("GitHub token is required for storage mutation.");
  }

  async #fetchResponse(target, {
    method = "GET",
    body,
    headers,
  } = {}) {
    this.signal?.throwIfAborted();
    return this.fetch(target, {
      method,
      headers,
      body,
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  }

  async #apiRequest(path, {
    method = "GET",
    body,
    requestContentType,
    accept = "application/vnd.github+json",
    allowNotFound = false,
    maximumBytes = 2_097_152,
  } = {}) {
    const headers = {
      accept,
      "user-agent": "robinhood-stock-token-index",
      "x-github-api-version": "2022-11-28",
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    if (requestContentType !== undefined) headers["content-type"] = requestContentType;
    const response = await this.#fetchResponse(`https://api.github.com${path}`, { method, body, headers });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} request failed with HTTP ${response.status}.`);
    return readBounded(response, maximumBytes);
  }

  async #uploadRequest(releaseId, name, bytes) {
    this.#requireWriteToken();
    const response = await this.#fetchResponse(
      `https://uploads.github.com/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: bytes,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/octet-stream",
          "user-agent": "robinhood-stock-token-index",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub upload request failed with HTTP ${response.status}.`);
    return readBounded(response, 2_097_152);
  }

  async #downloadPublic(tag, name) {
    const response = await this.#fetchResponse(publicAssetUrl(this.repository, tag, name), {
      headers: {
        accept: "application/octet-stream",
        "user-agent": "robinhood-stock-token-index",
      },
    });
    if (!response.ok) throw new Error(`GitHub public asset download failed with HTTP ${response.status}.`);
    return readBounded(response, this.#maximumArtifactBytes);
  }

  async #getRelease(tag) {
    if (this.#releases.has(tag)) return this.#releases.get(tag);
    const bytes = await this.#apiRequest(`/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    const release = bytes === null ? null : admitRelease(parseJson(bytes, "GitHub release response"), tag);
    this.#releases.set(tag, release);
    return release;
  }

  async #ensureRelease(tag) {
    this.#requireWriteToken();
    const existing = await this.#getRelease(tag);
    if (existing) return existing;
    const requestBody = Buffer.from(JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }), "utf8");
    const bytes = await this.#apiRequest(`/repos/${this.repository}/releases`, {
      method: "POST",
      body: requestBody,
      requestContentType: "application/vnd.github+json",
    });
    const release = admitRelease(parseJson(bytes, "GitHub release creation response"), tag);
    this.#releases.set(tag, release);
    return release;
  }

  async #listAssets(releaseId) {
    if (this.#assets.has(releaseId)) return this.#assets.get(releaseId);
    const output = [];
    for (let page = 1; page <= 11; page += 1) {
      const bytes = await this.#apiRequest(`/repos/${this.repository}/releases/${releaseId}/assets?per_page=100&page=${page}`);
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
    this.#assets.set(releaseId, output);
    return output;
  }

  async #downloadAsset(asset) {
    if (asset.size > this.#maximumArtifactBytes) throw new Error("GitHub asset exceeds the admitted byte limit.");
    return this.#apiRequest(`/repos/${this.repository}/releases/assets/${asset.id}`, {
      accept: "application/octet-stream",
      maximumBytes: this.#maximumArtifactBytes,
    });
  }

  async #uploadImmutable(release, name, bytes) {
    this.#requireWriteToken();
    const assets = await this.#listAssets(release.id);
    const existing = assets.find((asset) => asset.name === name);
    if (existing) {
      const stored = await this.#downloadAsset(existing);
      if (!stored.equals(bytes)) throw new Error("GitHub immutable asset differs from the requested bytes.");
      return existing;
    }
    if (assets.length >= 1_000) throw new Error("GitHub release has reached the admitted asset limit.");
    const uploadedBytes = await this.#uploadRequest(release.id, name, bytes);
    const uploaded = admitAsset(parseJson(uploadedBytes, "GitHub asset upload response"));
    if (uploaded.name !== name || uploaded.size !== bytes.byteLength) throw new Error("GitHub asset upload identity is invalid.");
    const stored = await this.#downloadAsset(uploaded);
    if (!stored.equals(bytes)) throw new Error("GitHub uploaded asset differs from the requested bytes.");
    assets.push(uploaded);
    return uploaded;
  }

  async #deleteAsset(releaseId, asset) {
    this.#requireWriteToken();
    await this.#apiRequest(`/repos/${this.repository}/releases/assets/${asset.id}`, {
      method: "DELETE",
      maximumBytes: 1_024,
    });
    const assets = this.#assets.get(releaseId);
    if (assets) {
      const index = assets.findIndex((candidate) => candidate.id === asset.id);
      if (index !== -1) assets.splice(index, 1);
    }
  }

  async readSelectedState(pairId) {
    const release = await this.#getRelease(stateTag(pairId));
    if (!release) return null;
    const candidates = (await this.#listAssets(release.id))
      .map((asset) => ({ asset, sequence: parseStateObjectName(asset.name) }))
      .filter((entry) => entry.sequence !== null)
      .sort((left, right) => left.sequence - right.sequence);
    if (candidates.length === 0) return null;
    const selected = candidates.at(-1);
    const gzipBytes = admitStateBytes(
      await this.#downloadPublic(release.tag, selected.asset.name),
      this.#maximumArtifactBytes,
    );
    return { sequence: selected.sequence, gzipBytes };
  }

  async readReferenced(reference) {
    const tag = referenceTag(reference);
    const name = referenceObjectName(reference);
    return verifyCarriedReferenceBytes(reference, await this.#downloadPublic(tag, name), this.#maximumArtifactBytes);
  }

  async resolvePairMonth(pairId, pairMonth) {
    admitPairId(pairId);
    admitPairMonth(pairMonth);
    return "present";
  }

  async writeReferenced(reference, gzipBytes) {
    this.#requireWriteToken();
    verifyCarriedReferenceBytes(reference, gzipBytes, this.#maximumArtifactBytes);
    const release = await this.#ensureRelease(referenceTag(reference));
    await this.#uploadImmutable(release, referenceObjectName(reference), gzipBytes);
  }

  async writeState(pairId, sequence, gzipBytes) {
    this.#requireWriteToken();
    admitPairId(pairId);
    admitCarrierSequence(sequence);
    admitStateBytes(gzipBytes, this.#maximumArtifactBytes);
    const release = await this.#ensureRelease(stateTag(pairId));
    await this.#uploadImmutable(release, stateObjectName(sequence), gzipBytes);
  }

  async cleanupSelectedGeneration(input) {
    this.#requireWriteToken();
    const plan = admitCleanupPlan(input);
    let phase = "selected_state_proof";
    let pairMonth;
    let objectKind;
    try {
      const stateRelease = await this.#getRelease(stateTag(plan.pairId));
      if (!stateRelease) throw new Error("Selected-state Release is unavailable during cleanup.");
      const stateAssets = [...await this.#listAssets(stateRelease.id)];
      if (!stateAssets.some((asset) => asset.name === plan.selectedStateName)) {
        throw new Error("Selected state carrier is unavailable during cleanup.");
      }

      phase = "changed_month_proof";
      const scopes = [];
      for (const changedMonth of plan.changedMonths) {
        pairMonth = changedMonth.month;
        const tag = monthTag(plan.pairId, changedMonth.month);
        const release = await this.#getRelease(tag);
        if (!release) throw new Error("Referenced pair-month Release is unavailable during cleanup.");
        const assets = [...await this.#listAssets(release.id)];
        const names = new Set(assets.map((asset) => asset.name));
        for (const object of changedMonth.objects) {
          if (!names.has(object.name)) throw new Error("Retained object is unavailable during cleanup.");
        }
        scopes.push({
          pairMonth: changedMonth.month,
          release,
          assets,
          retained: new Map(changedMonth.objects.map((object) => [object.logicalId, object.name])),
        });
      }

      phase = "superseded_state_removal";
      pairMonth = undefined;
      objectKind = undefined;
      for (const asset of stateAssets) {
        const sequence = parseStateObjectName(asset.name);
        if (sequence !== null && sequence < plan.selectedSequence) await this.#deleteAsset(stateRelease.id, asset);
      }

      phase = "superseded_child_removal";
      for (const scope of scopes) {
        pairMonth = scope.pairMonth;
        for (const asset of scope.assets) {
          const parsed = parseReferencedObjectName(plan.pairId, asset.name);
          const retainedName = parsed === null ? undefined : scope.retained.get(parsed.logicalId);
          if (retainedName !== undefined && parsed.sequence <= plan.selectedSequence && asset.name !== retainedName) {
            objectKind = parsed.kind;
            await this.#deleteAsset(scope.release.id, asset);
          }
        }
      }
    } catch (error) {
      this.#writeCleanupFailure(plan, phase, pairMonth, objectKind);
      throw error;
    }
  }
}
