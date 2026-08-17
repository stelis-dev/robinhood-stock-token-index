import { setTimeout as wait } from "node:timers/promises";
import {
  validateCleanupPlan,
  validateStoredReference,
  validateGeneration,
  validatePairId,
  validatePairMonth,
  validateStateBytes,
  parseReferencedObjectName,
  parseStateObjectName,
  referenceObjectName,
  stateObjectName,
  verifyStoredReferenceBytes,
} from "./stored-files.mjs";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const maximumRequestAttempts = 3;
const maximumRetryDelayMilliseconds = 60_000;
const transientRetryDelayMilliseconds = 1_000;
const rateLimitRetryDelayMilliseconds = 60_000;
const githubFailureReasons = new Set([
  "access_denied",
  "immutable_conflict",
  "invalid_response",
  "not_found",
  "rate_limited",
  "request_rejected",
  "storage_limit",
  "transient_http",
  "transport",
]);
const githubOperations = new Set([
  "create_release",
  "delete_asset",
  "download_asset",
  "download_public",
  "get_release",
  "list_assets",
  "upload_asset",
]);

export class GitHubStorageError extends Error {
  constructor(operation, reason, { retryable = false, retryDelayMilliseconds } = {}) {
    if (!githubOperations.has(operation) || !githubFailureReasons.has(reason)) {
      throw new Error("GitHub storage failure classification is invalid.");
    }
    if (typeof retryable !== "boolean") throw new Error("GitHub storage retry classification is invalid.");
    if (retryDelayMilliseconds !== undefined && (!Number.isSafeInteger(retryDelayMilliseconds) || retryDelayMilliseconds < 0)) {
      throw new Error("GitHub storage retry delay is invalid.");
    }
    super(`GitHub storage ${operation} failed: ${reason}.`);
    this.name = "GitHubStorageError";
    this.operation = operation;
    this.reason = reason;
    this.retryable = retryable;
    this.retryDelayMilliseconds = retryDelayMilliseconds;
  }
}

export function githubStorageFailureFields(error) {
  if (!(error instanceof GitHubStorageError)) return null;
  return `component=github operation=${error.operation} reason=${error.reason}`;
}

function admittedRetryDelay(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds > maximumRetryDelayMilliseconds) {
    return maximumRetryDelayMilliseconds + 1;
  }
  return Math.max(0, Math.floor(milliseconds));
}

function retryAfterMilliseconds(response) {
  const retryAfter = response.headers?.get?.("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    if (/^[0-9]+$/.test(retryAfter)) return admittedRetryDelay(Number(retryAfter) * 1_000);
    const instant = Date.parse(retryAfter);
    if (!Number.isNaN(instant)) return admittedRetryDelay(instant - Date.now());
  }
  const reset = response.headers?.get?.("x-ratelimit-reset");
  if (reset !== null && reset !== undefined && /^[0-9]+$/.test(reset)) {
    return admittedRetryDelay(Number(reset) * 1_000 - Date.now());
  }
  return rateLimitRetryDelayMilliseconds;
}

async function responseIndicatesSecondaryRateLimit(response) {
  if (response.status !== 403) return false;
  if (response.headers?.get?.("retry-after") !== null || response.headers?.get?.("x-ratelimit-remaining") === "0") return true;
  try {
    const bytes = await readBounded(response, 65_536);
    const value = JSON.parse(bytes.toString("utf8"));
    return typeof value?.message === "string" && /secondary rate limit|abuse detection/i.test(value.message);
  } catch {
    return false;
  }
}

async function classifyHttpFailure(response, operation) {
  if (response.status === 429 || await responseIndicatesSecondaryRateLimit(response)) {
    return new GitHubStorageError(operation, "rate_limited", {
      retryable: true,
      retryDelayMilliseconds: retryAfterMilliseconds(response),
    });
  }
  if (response.status === 401 || response.status === 403) return new GitHubStorageError(operation, "access_denied");
  if (response.status === 404) return new GitHubStorageError(operation, "not_found");
  if (response.status === 408 || response.status >= 500 && response.status <= 599) {
    return new GitHubStorageError(operation, "transient_http", { retryable: true });
  }
  if (response.status === 413) return new GitHubStorageError(operation, "storage_limit");
  return new GitHubStorageError(operation, "request_rejected");
}

async function readBounded(response, maximumBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && (!/^[0-9]+$/.test(contentLength) || BigInt(contentLength) > BigInt(maximumBytes))) {
    throw new Error("GitHub response exceeds the maximum byte size.");
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
        throw new Error("GitHub response exceeds the maximum byte size.");
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const value = Buffer.from(await response.arrayBuffer());
    byteLength = value.byteLength;
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, byteLength);
  if (bytes.byteLength > maximumBytes) throw new Error("GitHub response exceeds the maximum byte size.");
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not JSON.`);
  }
}

function validateRelease(value, tag) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id <= 0 || value.tag_name !== tag) {
    throw new Error("GitHub release response is invalid.");
  }
  return { id: value.id, tag };
}

function validateAsset(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.name !== "string" || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error("GitHub release asset response is invalid.");
  }
  return { id: value.id, name: value.name, size: value.size };
}

function stateTag(pairId) {
  return `pair-${validatePairId(pairId)}-state`;
}

function monthTag(pairId, pairMonth) {
  return `pair-${validatePairId(pairId)}-month-${validatePairMonth(pairMonth)}`;
}

function referenceTag(reference) {
  const identity = validateStoredReference(reference);
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
  #wait;

  constructor({
    repository,
    token,
    maximumArtifactBytes,
    fetchImplementation = fetch,
    signal,
    writeOperationalLog,
    waitImplementation = (milliseconds, waitSignal) => wait(milliseconds, undefined, { signal: waitSignal }),
  }) {
    if (!repositoryPattern.test(repository)) throw new Error("GitHub repository identity is invalid.");
    if (token !== undefined && (typeof token !== "string" || token.length === 0)) throw new Error("GitHub token is invalid.");
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
    if (writeOperationalLog !== undefined && typeof writeOperationalLog !== "function") throw new Error("Operational log writer is invalid.");
    if (typeof waitImplementation !== "function") throw new Error("GitHub retry wait implementation is invalid.");
    this.repository = repository;
    this.#token = token;
    this.#maximumArtifactBytes = maximumArtifactBytes;
    this.#writeOperationalLog = writeOperationalLog;
    this.#wait = waitImplementation;
    this.fetch = fetchImplementation;
    this.signal = signal;
  }

  #writeCleanupFailure(plan, phase, pairMonth, objectKind, error) {
    if (this.#writeOperationalLog === undefined) return;
    const month = pairMonth === undefined ? "" : ` pair_month=${pairMonth}`;
    const kind = objectKind === undefined ? "" : ` object_kind=${objectKind}`;
    const failure = githubStorageFailureFields(error);
    const fields = failure === null ? " component=collector reason=operation_rejected" : ` ${failure}`;
    this.#writeOperationalLog(
      `github_cleanup status=failed phase=${phase}${fields} pair_id=${plan.pairId} selected_sequence=${plan.selectedSequence}${month}${kind}\n`,
    );
  }

  #requireWriteToken() {
    if (this.#token === undefined) throw new Error("GitHub token is required for storage mutation.");
  }

  async #fetchResponse(target, operation, {
    method = "GET",
    body,
    headers,
  } = {}) {
    this.signal?.throwIfAborted();
    try {
      return await this.fetch(target, {
        method,
        headers,
        body,
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      this.signal?.throwIfAborted();
      throw new GitHubStorageError(operation, "transport", { retryable: true });
    }
  }

  async #retry(operation, action) {
    for (let attempt = 1; attempt <= maximumRequestAttempts; attempt += 1) {
      this.signal?.throwIfAborted();
      try {
        return await action();
      } catch (error) {
        this.signal?.throwIfAborted();
        if (!(error instanceof GitHubStorageError) || !error.retryable || attempt === maximumRequestAttempts) throw error;
        const delay = error.retryDelayMilliseconds
          ?? transientRetryDelayMilliseconds * 2 ** (attempt - 1);
        if (delay > maximumRetryDelayMilliseconds) throw error;
        try {
          await this.#wait(delay, this.signal);
        } catch {
          this.signal?.throwIfAborted();
          throw new GitHubStorageError(operation, "transport", { retryable: true });
        }
      }
    }
    throw new GitHubStorageError(operation, "transport");
  }

  async #readResponse(response, maximumBytes, operation) {
    try {
      return await readBounded(response, maximumBytes);
    } catch (error) {
      if (error instanceof GitHubStorageError) throw error;
      if (error instanceof Error && error.message === "GitHub response exceeds the maximum byte size.") {
        throw new GitHubStorageError(operation, "storage_limit");
      }
      this.signal?.throwIfAborted();
      throw new GitHubStorageError(operation, "transport", { retryable: true });
    }
  }

  async #apiRequest(path, {
    operation,
    method = "GET",
    body,
    requestContentType,
    accept = "application/vnd.github+json",
    allowNotFound = false,
    allowDeleted = false,
    maximumBytes = 2_097_152,
    retry = method === "GET" || method === "DELETE",
  } = {}) {
    if (!githubOperations.has(operation)) throw new Error("GitHub API operation classification is required.");
    const headers = {
      accept,
      "user-agent": "robinhood-stock-token-index",
      "x-github-api-version": "2022-11-28",
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    if (requestContentType !== undefined) headers["content-type"] = requestContentType;
    const request = async () => {
      const response = await this.#fetchResponse(`https://api.github.com${path}`, operation, { method, body, headers });
      if (allowNotFound && response.status === 404) {
        await response.body?.cancel?.().catch(() => {});
        return null;
      }
      if (allowDeleted && response.status === 404) {
        await response.body?.cancel?.().catch(() => {});
        return Buffer.alloc(0);
      }
      if (!response.ok) {
        const failure = await classifyHttpFailure(response, operation);
        await response.body?.cancel?.().catch(() => {});
        throw failure;
      }
      return this.#readResponse(response, maximumBytes, operation);
    };
    return retry ? this.#retry(operation, request) : request();
  }

  async #uploadRequest(releaseId, name, bytes) {
    this.#requireWriteToken();
    const response = await this.#fetchResponse(
      `https://uploads.github.com/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      "upload_asset",
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
    if (!response.ok) {
      const failure = await classifyHttpFailure(response, "upload_asset");
      await response.body?.cancel?.().catch(() => {});
      throw failure;
    }
    return this.#readResponse(response, 2_097_152, "upload_asset");
  }

  async #downloadPublic(tag, name) {
    return this.#retry("download_public", async () => {
      const response = await this.#fetchResponse(publicAssetUrl(this.repository, tag, name), "download_public", {
        headers: {
          accept: "application/octet-stream",
          "user-agent": "robinhood-stock-token-index",
        },
      });
      if (!response.ok) {
        const failure = await classifyHttpFailure(response, "download_public");
        await response.body?.cancel?.().catch(() => {});
        throw failure;
      }
      return this.#readResponse(response, this.#maximumArtifactBytes, "download_public");
    });
  }

  #validateResponse(operation, action) {
    try {
      return action();
    } catch {
      throw new GitHubStorageError(operation, "invalid_response");
    }
  }

  async #getRelease(tag) {
    if (this.#releases.has(tag)) return this.#releases.get(tag);
    const bytes = await this.#apiRequest(`/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`, {
      operation: "get_release",
      allowNotFound: true,
    });
    const release = bytes === null
      ? null
      : this.#validateResponse("get_release", () => validateRelease(parseJson(bytes, "GitHub release response"), tag));
    this.#releases.set(tag, release);
    return release;
  }

  async #ensureRelease(tag) {
    this.#requireWriteToken();
    const existing = await this.#getRelease(tag);
    if (existing) return existing;
    const requestBody = Buffer.from(JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }), "utf8");
    let reconcileBeforeCreate = false;
    const release = await this.#retry("create_release", async () => {
      if (reconcileBeforeCreate) {
        this.#releases.delete(tag);
        const reconciled = await this.#getRelease(tag);
        if (reconciled !== null) return reconciled;
      }
      try {
        const bytes = await this.#apiRequest(`/repos/${this.repository}/releases`, {
          operation: "create_release",
          method: "POST",
          body: requestBody,
          requestContentType: "application/vnd.github+json",
          retry: false,
        });
        return this.#validateResponse(
          "create_release",
          () => validateRelease(parseJson(bytes, "GitHub release creation response"), tag),
        );
      } catch (error) {
        reconcileBeforeCreate = true;
        this.#releases.delete(tag);
        const reconciled = await this.#getRelease(tag);
        if (reconciled !== null) return reconciled;
        throw error;
      }
    });
    this.#releases.set(tag, release);
    return release;
  }

  async #listAssets(releaseId) {
    if (this.#assets.has(releaseId)) return this.#assets.get(releaseId);
    const output = [];
    for (let page = 1; page <= 11; page += 1) {
      const bytes = await this.#apiRequest(`/repos/${this.repository}/releases/${releaseId}/assets?per_page=100&page=${page}`, {
        operation: "list_assets",
      });
      const part = this.#validateResponse("list_assets", () => {
        const values = parseJson(bytes, "GitHub release asset list");
        if (!Array.isArray(values)) throw new Error("GitHub release asset list is invalid.");
        return values.map(validateAsset);
      });
      output.push(...part);
      if (output.length > 1_000) throw new GitHubStorageError("list_assets", "storage_limit");
      if (part.length < 100) break;
      if (page === 11) throw new GitHubStorageError("list_assets", "storage_limit");
    }
    const names = new Set();
    for (const asset of output) {
      if (names.has(asset.name)) throw new GitHubStorageError("list_assets", "invalid_response");
      names.add(asset.name);
    }
    this.#assets.set(releaseId, output);
    return output;
  }

  async #refreshAssets(releaseId) {
    this.#assets.delete(releaseId);
    return this.#listAssets(releaseId);
  }

  async #downloadAsset(asset) {
    if (asset.size > this.#maximumArtifactBytes) throw new GitHubStorageError("download_asset", "storage_limit");
    return this.#apiRequest(`/repos/${this.repository}/releases/assets/${asset.id}`, {
      operation: "download_asset",
      accept: "application/octet-stream",
      maximumBytes: this.#maximumArtifactBytes,
    });
  }

  async #verifyImmutableAsset(asset, bytes) {
    const stored = await this.#downloadAsset(asset);
    if (!stored.equals(bytes)) throw new GitHubStorageError("upload_asset", "immutable_conflict");
    return asset;
  }

  async #uploadImmutable(release, name, bytes) {
    this.#requireWriteToken();
    let assets = await this.#listAssets(release.id);
    const existing = assets.find((asset) => asset.name === name);
    if (existing) return this.#verifyImmutableAsset(existing, bytes);
    if (assets.length >= 1_000) throw new GitHubStorageError("upload_asset", "storage_limit");

    let reconcileBeforeUpload = false;
    return this.#retry("upload_asset", async () => {
      if (reconcileBeforeUpload) {
        assets = await this.#refreshAssets(release.id);
        const reconciled = assets.find((asset) => asset.name === name);
        if (reconciled) return this.#verifyImmutableAsset(reconciled, bytes);
        if (assets.length >= 1_000) throw new GitHubStorageError("upload_asset", "storage_limit");
      }
      try {
        const uploadedBytes = await this.#uploadRequest(release.id, name, bytes);
        const uploaded = this.#validateResponse("upload_asset", () => {
          const value = validateAsset(parseJson(uploadedBytes, "GitHub asset upload response"));
          if (value.name !== name || value.size !== bytes.byteLength) {
            throw new Error("GitHub asset upload identity is invalid.");
          }
          return value;
        });
        await this.#verifyImmutableAsset(uploaded, bytes);
        assets.push(uploaded);
        return uploaded;
      } catch (error) {
        reconcileBeforeUpload = true;
        assets = await this.#refreshAssets(release.id);
        const reconciled = assets.find((asset) => asset.name === name);
        if (reconciled) return this.#verifyImmutableAsset(reconciled, bytes);
        if (assets.length >= 1_000) throw new GitHubStorageError("upload_asset", "storage_limit");
        throw error;
      }
    });
  }

  async #deleteAsset(releaseId, asset) {
    this.#requireWriteToken();
    await this.#apiRequest(`/repos/${this.repository}/releases/assets/${asset.id}`, {
      operation: "delete_asset",
      method: "DELETE",
      allowDeleted: true,
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
    const gzipBytes = validateStateBytes(
      await this.#downloadPublic(release.tag, selected.asset.name),
      this.#maximumArtifactBytes,
    );
    return { sequence: selected.sequence, gzipBytes };
  }

  async readReferenced(reference) {
    const tag = referenceTag(reference);
    const name = referenceObjectName(reference);
    return verifyStoredReferenceBytes(reference, await this.#downloadPublic(tag, name), this.#maximumArtifactBytes);
  }

  async resolvePairMonth(pairId, pairMonth) {
    validatePairId(pairId);
    validatePairMonth(pairMonth);
    return "present";
  }

  async writeReferenced(reference, gzipBytes) {
    this.#requireWriteToken();
    verifyStoredReferenceBytes(reference, gzipBytes, this.#maximumArtifactBytes);
    const release = await this.#ensureRelease(referenceTag(reference));
    await this.#uploadImmutable(release, referenceObjectName(reference), gzipBytes);
  }

  async writeState(pairId, sequence, gzipBytes) {
    this.#requireWriteToken();
    validatePairId(pairId);
    validateGeneration(sequence);
    validateStateBytes(gzipBytes, this.#maximumArtifactBytes);
    const release = await this.#ensureRelease(stateTag(pairId));
    await this.#uploadImmutable(release, stateObjectName(sequence), gzipBytes);
  }

  async cleanupSelectedGeneration(input) {
    this.#requireWriteToken();
    const plan = validateCleanupPlan(input);
    let phase = "selected_state_proof";
    let pairMonth;
    let objectKind;
    try {
      const stateRelease = await this.#getRelease(stateTag(plan.pairId));
      if (!stateRelease) throw new Error("Selected-state Release is unavailable during cleanup.");
      const stateAssets = [...await this.#listAssets(stateRelease.id)];
      if (!stateAssets.some((asset) => asset.name === plan.selectedStateName)) {
        throw new Error("Selected state file is unavailable during cleanup.");
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
      this.#writeCleanupFailure(plan, phase, pairMonth, objectKind, error);
      throw error;
    }
  }
}
