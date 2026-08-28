import { setTimeout as wait } from "node:timers/promises";
import { isSha256Hex, sha256Hex } from "../collector/canonical.mjs";
import {
  marketDataPublicationAssetName,
  maximumMarketDataAssetsPerRelease,
  validateMarketDataReleaseTag,
  validatePhysicalAssetIdentity,
} from "../collector/market-data-assets.mjs";
import { StoredDataIntegrityError } from "./storage-error.mjs";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const githubApiVersion = "2026-03-10";
const maximumRequestAttempts = 3;
const maximumRetryDelayMilliseconds = 60_000;
const transientRetryDelayMilliseconds = 1_000;
const rateLimitRetryDelayMilliseconds = 60_000;
const contentRequestMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
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
    const value = JSON.parse(fatalUtf8Decoder.decode(bytes));
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
    return JSON.parse(fatalUtf8Decoder.decode(bytes));
  } catch {
    throw new Error(`${label} is not JSON.`);
  }
}

function validateRelease(value, tag) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !Number.isSafeInteger(value.id)
    || value.id <= 0
    || value.tag_name !== tag
    || value.draft !== false
    || typeof value.immutable !== "boolean"
  ) {
    throw new Error("GitHub release response is invalid.");
  }
  return { id: value.id, immutable: value.immutable, tag };
}

function requireMutableRelease(release, operation = "create_release") {
  if (release.immutable) throw new GitHubStorageError(operation, "immutable_conflict");
  return release;
}

function validateAsset(value) {
  const digestIsValid = value?.digest === null
    || typeof value?.digest === "string"
      && value.digest.startsWith("sha256:")
      && isSha256Hex(value.digest.slice("sha256:".length));
  const stateIsValid = value?.state === "uploaded"
    ? value.size > 0 && digestIsValid
    : value?.state === "starter" && value.size === 0 && value.digest === null;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !Number.isSafeInteger(value.id)
    || value.id <= 0
    || typeof value.name !== "string"
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || !stateIsValid
  ) {
    throw new Error("GitHub release asset response is invalid.");
  }
  return { id: value.id, name: value.name, size: value.size, state: value.state, digest: value.digest };
}

function publicAssetUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export class GitHubReleaseStore {
  #token;
  #maximumArtifactBytes;
  #releases = new Map();
  #assets = new Map();
  #verifiedAssets = new Map();
  #wait;
  #now;
  #minimumMutationIntervalMilliseconds;
  #nextMutationAt = 0;

  constructor({
    repository,
    token,
    maximumArtifactBytes,
    minimumMutationIntervalMilliseconds = 0,
    fetchImplementation = fetch,
    nowImplementation = Date.now,
    signal,
    waitImplementation = (milliseconds, waitSignal) => wait(milliseconds, undefined, { signal: waitSignal }),
  }) {
    if (typeof repository !== "string" || !repositoryPattern.test(repository)) throw new Error("GitHub repository identity is invalid.");
    if (token !== undefined && (typeof token !== "string" || token.length === 0)) throw new Error("GitHub token is invalid.");
    if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes <= 0) throw new Error("Maximum artifact bytes is invalid.");
    if (!Number.isSafeInteger(minimumMutationIntervalMilliseconds) || minimumMutationIntervalMilliseconds < 0) {
      throw new Error("GitHub mutation interval is invalid.");
    }
    if (typeof waitImplementation !== "function") throw new Error("GitHub retry wait implementation is invalid.");
    if (typeof nowImplementation !== "function") throw new Error("GitHub clock implementation is invalid.");
    this.repository = repository;
    this.#token = token;
    this.#maximumArtifactBytes = maximumArtifactBytes;
    this.#minimumMutationIntervalMilliseconds = minimumMutationIntervalMilliseconds;
    this.#wait = waitImplementation;
    this.#now = nowImplementation;
    this.fetch = fetchImplementation;
    this.signal = signal;
  }

  #requireWriteToken() {
    if (this.#token === undefined) throw new Error("GitHub token is required for storage mutation.");
  }

  async #paceMutation(operation, method) {
    if (!contentRequestMethods.has(method) || this.#minimumMutationIntervalMilliseconds === 0) return;
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("GitHub clock returned an invalid instant.");
    const scheduled = Math.max(now, this.#nextMutationAt);
    const delay = scheduled - now;
    this.#nextMutationAt = scheduled + this.#minimumMutationIntervalMilliseconds;
    if (delay === 0) return;
    try {
      await this.#wait(delay, this.signal);
    } catch {
      this.signal?.throwIfAborted();
      throw new GitHubStorageError(operation, "transport", { retryable: true });
    }
  }

  async #fetchResponse(target, operation, {
    method = "GET",
    body,
    headers,
    redirect,
  } = {}) {
    this.signal?.throwIfAborted();
    await this.#paceMutation(operation, method);
    try {
      return await this.fetch(target, {
        method,
        headers,
        body,
        redirect,
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
    const budget = { delayMilliseconds: 0 };
    for (let attempt = 1; attempt <= maximumRequestAttempts; attempt += 1) {
      this.signal?.throwIfAborted();
      try {
        return await action();
      } catch (error) {
        this.signal?.throwIfAborted();
        if (!(error instanceof GitHubStorageError) || !error.retryable || attempt === maximumRequestAttempts) throw error;
        await this.#waitForRetry(operation, error, attempt, budget);
      }
    }
    throw new GitHubStorageError(operation, "transport");
  }

  async #waitForRetry(operation, error, attempt, budget) {
    if (budget === null || typeof budget !== "object" || !Number.isSafeInteger(budget.delayMilliseconds) || budget.delayMilliseconds < 0) {
      throw new Error("GitHub retry delay budget is invalid.");
    }
    const delay = error.retryDelayMilliseconds
      ?? transientRetryDelayMilliseconds * 2 ** (attempt - 1);
    if (delay > maximumRetryDelayMilliseconds || budget.delayMilliseconds + delay > maximumRetryDelayMilliseconds) throw error;
    budget.delayMilliseconds += delay;
    try {
      await this.#wait(delay, this.signal);
    } catch {
      this.signal?.throwIfAborted();
      throw new GitHubStorageError(operation, "transport", { retryable: true });
    }
  }

  async #readResponse(response, maximumBytes, operation, { boundsFailure = "storage_limit" } = {}) {
    if (boundsFailure !== "storage_limit" && boundsFailure !== "integrity") {
      throw new Error("GitHub response bounds classification is invalid.");
    }
    try {
      return await readBounded(response, maximumBytes);
    } catch (error) {
      if (error instanceof GitHubStorageError) throw error;
      if (error instanceof Error && error.message === "GitHub response exceeds the maximum byte size.") {
        if (boundsFailure === "integrity") throw new StoredDataIntegrityError();
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
      "x-github-api-version": githubApiVersion,
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
          "x-github-api-version": githubApiVersion,
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

  async #downloadPublicRange(identity, range) {
    if (!Number.isSafeInteger(range?.from) || !Number.isSafeInteger(range?.until) || range.from < 0 || range.from >= range.until || range.until > identity.bytes) {
      throw new Error("Market-data byte range is invalid.");
    }
    return this.#retry("download_public", async () => {
      let target = publicAssetUrl(this.repository, identity.releaseTag, identity.assetName);
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        const response = await this.#fetchResponse(target, "download_public", {
          headers: {
            accept: "application/octet-stream",
            "accept-encoding": "identity",
            range: `bytes=${range.from}-${range.until - 1}`,
            "user-agent": "robinhood-stock-token-index",
          },
          redirect: "manual",
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers?.get?.("location");
          await response.body?.cancel?.().catch(() => {});
          if (typeof location !== "string" || redirects === 5) throw new GitHubStorageError("download_public", "invalid_response");
          const redirected = new URL(location, target);
          if (redirected.protocol !== "https:") throw new GitHubStorageError("download_public", "invalid_response");
          target = redirected.toString();
          continue;
        }
        if (response.status !== 206) {
          const failure = response.ok
            ? new GitHubStorageError("download_public", "request_rejected")
            : await classifyHttpFailure(response, "download_public");
          await response.body?.cancel?.().catch(() => {});
          throw failure;
        }
        if (
          response.headers?.get?.("content-range") !== `bytes ${range.from}-${range.until - 1}/${identity.bytes}`
          || ![null, "identity"].includes(response.headers?.get?.("content-encoding"))
        ) {
          await response.body?.cancel?.().catch(() => {});
          throw new StoredDataIntegrityError();
        }
        const expectedBytes = range.until - range.from;
        const contentLength = response.headers?.get?.("content-length");
        if (contentLength !== null && (!/^[0-9]+$/u.test(contentLength) || BigInt(contentLength) !== BigInt(expectedBytes))) {
          await response.body?.cancel?.().catch(() => {});
          throw new StoredDataIntegrityError();
        }
        const bytes = await this.#readResponse(
          response,
          expectedBytes,
          "download_public",
          { boundsFailure: "integrity" },
        );
        if (bytes.byteLength !== expectedBytes) throw new StoredDataIntegrityError();
        return bytes;
      }
      throw new GitHubStorageError("download_public", "invalid_response");
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
    if (existing) return requireMutableRelease(existing);
    const requestBody = Buffer.from(JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }), "utf8");
    const budget = { delayMilliseconds: 0 };
    for (let attempt = 1; attempt <= maximumRequestAttempts; attempt += 1) {
      try {
        const bytes = await this.#apiRequest(`/repos/${this.repository}/releases`, {
          operation: "create_release",
          method: "POST",
          body: requestBody,
          requestContentType: "application/vnd.github+json",
          retry: false,
        });
        const release = this.#validateResponse(
          "create_release",
          () => validateRelease(parseJson(bytes, "GitHub release creation response"), tag),
        );
        const mutable = requireMutableRelease(release);
        this.#releases.set(tag, mutable);
        return mutable;
      } catch (error) {
        this.#releases.delete(tag);
        const reconciled = await this.#getRelease(tag);
        if (reconciled !== null) return requireMutableRelease(reconciled);
        if (!(error instanceof GitHubStorageError) || !error.retryable || attempt === maximumRequestAttempts) throw error;
        await this.#waitForRetry("create_release", error, attempt, budget);
      }
    }
    throw new GitHubStorageError("create_release", "transport");
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
      if (output.length > maximumMarketDataAssetsPerRelease) throw new GitHubStorageError("list_assets", "storage_limit");
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

  #verifiedAssetKey(releaseId, asset) {
    return `${releaseId}:${asset.id}:${asset.name}:${asset.size}:${asset.state}`;
  }

  #verifiedAsset(releaseId, asset, expectedDigest) {
    const evidence = this.#verifiedAssets.get(this.#verifiedAssetKey(releaseId, asset));
    return evidence?.digest === expectedDigest ? evidence : null;
  }

  #rememberVerifiedAsset(releaseId, asset, digest, bytes = null) {
    this.#verifiedAssets.set(this.#verifiedAssetKey(releaseId, asset), {
      digest,
      bytes: bytes === null ? null : Buffer.from(bytes),
    });
  }

  async #readAdmittedUploadedAsset(releaseId, asset) {
    if (asset.state !== "uploaded" || asset.size <= 0 || asset.size > this.#maximumArtifactBytes) {
      throw new StoredDataIntegrityError();
    }
    const metadataDigest = asset.digest?.slice("sha256:".length) ?? null;
    const evidence = this.#verifiedAssets.get(this.#verifiedAssetKey(releaseId, asset));
    if (evidence !== undefined && metadataDigest !== null && evidence.digest !== metadataDigest) {
      throw new StoredDataIntegrityError();
    }
    if (evidence?.bytes !== null && evidence?.bytes !== undefined) return Buffer.from(evidence.bytes);
    const bytes = await this.#downloadAsset(asset);
    const digest = sha256Hex(bytes);
    if (bytes.byteLength !== asset.size || metadataDigest !== null && digest !== metadataDigest) {
      throw new StoredDataIntegrityError();
    }
    this.#rememberVerifiedAsset(releaseId, asset, digest, bytes);
    return bytes;
  }

  async #verifyImmutableAsset(releaseId, asset, bytes) {
    if (asset.state !== "uploaded" || asset.size !== bytes.byteLength) {
      throw new GitHubStorageError("upload_asset", "immutable_conflict");
    }
    const expectedDigest = sha256Hex(bytes);
    const evidence = this.#verifiedAsset(releaseId, asset, expectedDigest);
    if (evidence?.bytes !== null && evidence?.bytes !== undefined) return Buffer.from(evidence.bytes);
    const stored = await this.#downloadAsset(asset);
    if (!stored.equals(bytes)) throw new GitHubStorageError("upload_asset", "immutable_conflict");
    if (asset.digest !== null && asset.digest !== `sha256:${expectedDigest}`) {
      throw new GitHubStorageError("upload_asset", "immutable_conflict");
    }
    this.#rememberVerifiedAsset(releaseId, asset, expectedDigest, stored);
    return stored;
  }

  async #confirmAssetAbsent(releaseId, name) {
    const assets = await this.#refreshAssets(releaseId);
    if (assets.some((asset) => asset.name === name)) throw new GitHubStorageError("upload_asset", "immutable_conflict");
    return assets;
  }

  async #reconcileUpload(release, name, bytes) {
    const assets = await this.#refreshAssets(release.id);
    const asset = assets.find((candidate) => candidate.name === name);
    if (asset === undefined) return { status: "absent", assets };
    if (asset.state === "starter") return { status: "starter", asset, assets };
    return {
      status: "uploaded",
      bytes: await this.#verifyImmutableAsset(release.id, asset, bytes),
      asset,
      assets,
    };
  }

  async #uploadImmutable(release, name, bytes) {
    this.#requireWriteToken();
    let assets = await this.#listAssets(release.id);
    let existing = assets.find((asset) => asset.name === name);
    if (existing?.state === "uploaded") return this.#verifyImmutableAsset(release.id, existing, bytes);
    if (existing?.state === "starter") {
      await this.#deleteAsset(release.id, existing);
      assets = await this.#confirmAssetAbsent(release.id, name);
    }
    if (assets.length >= maximumMarketDataAssetsPerRelease) throw new GitHubStorageError("upload_asset", "storage_limit");

    const budget = { delayMilliseconds: 0 };
    for (let attempt = 1; attempt <= maximumRequestAttempts; attempt += 1) {
      try {
        const uploadedBytes = await this.#uploadRequest(release.id, name, bytes);
        const uploaded = this.#validateResponse("upload_asset", () => {
          const value = validateAsset(parseJson(uploadedBytes, "GitHub asset upload response"));
          if (value.name !== name || value.size !== bytes.byteLength) {
            throw new Error("GitHub asset upload identity is invalid.");
          }
          return value;
        });
        const stored = await this.#verifyImmutableAsset(release.id, uploaded, bytes);
        assets.push(uploaded);
        this.#assets.set(release.id, assets);
        return stored;
      } catch (error) {
        const reconciled = await this.#reconcileUpload(release, name, bytes);
        if (reconciled.status === "uploaded") return reconciled.bytes;
        assets = reconciled.assets;
        if (reconciled.status === "starter") {
          await this.#deleteAsset(release.id, reconciled.asset);
          assets = await this.#confirmAssetAbsent(release.id, name);
        }
        if (assets.length >= maximumMarketDataAssetsPerRelease) throw new GitHubStorageError("upload_asset", "storage_limit");
        if (!(error instanceof GitHubStorageError) || !error.retryable || attempt === maximumRequestAttempts) throw error;
        await this.#waitForRetry("upload_asset", error, attempt, budget);
      }
    }
    throw new GitHubStorageError("upload_asset", "transport");
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
    for (const key of this.#verifiedAssets.keys()) {
      if (key.startsWith(`${releaseId}:${asset.id}:`)) this.#verifiedAssets.delete(key);
    }
  }

  async #proveUploadedAsset(releaseId, asset, expectedSize, expectedDigest) {
    if (asset.state !== "uploaded" || asset.size !== expectedSize) throw new StoredDataIntegrityError();
    if (this.#verifiedAsset(releaseId, asset, expectedDigest) !== null) return;
    if (asset.digest !== null) {
      if (asset.digest !== `sha256:${expectedDigest}`) throw new StoredDataIntegrityError();
      this.#rememberVerifiedAsset(releaseId, asset, expectedDigest);
      return;
    }
    const bytes = await this.#downloadAsset(asset);
    if (bytes.byteLength !== expectedSize || sha256Hex(bytes) !== expectedDigest) throw new StoredDataIntegrityError();
    this.#rememberVerifiedAsset(releaseId, asset, expectedDigest, bytes);
  }

  async #assetByName(tag, name) {
    const release = await this.#getRelease(tag);
    if (release === null) return { release: null, asset: null };
    const asset = (await this.#listAssets(release.id)).find((candidate) => candidate.name === name) ?? null;
    return { release, asset };
  }

  async #removeExactAsset({ tag, name, expectedSize, expectedDigest, allowIncomplete = false }) {
    const { release, asset } = await this.#assetByName(tag, name);
    if (release === null || asset === null) return;
    requireMutableRelease(release, "delete_asset");
    if (asset.state === "starter") {
      if (!allowIncomplete) throw new StoredDataIntegrityError();
      await this.#deleteAsset(release.id, asset);
      await this.#confirmAssetAbsent(release.id, name);
      return;
    }
    await this.#proveUploadedAsset(release.id, asset, expectedSize, expectedDigest);
    await this.#deleteAsset(release.id, asset);
  }

  async listMarketDataAssets(releaseTag) {
    validateMarketDataReleaseTag(releaseTag);
    const release = await this.#getRelease(releaseTag);
    if (release === null) return Object.freeze([]);
    return Object.freeze((await this.#listAssets(release.id)).map((asset) => Object.freeze({
      assetName: asset.name,
      bytes: asset.size,
      sha256: asset.digest?.slice("sha256:".length) ?? null,
      state: asset.state,
    })).sort((left, right) => left.assetName.localeCompare(right.assetName)));
  }

  async readMarketDataPublication() {
    const { release, asset } = await this.#assetByName("market-data-catalog", marketDataPublicationAssetName);
    if (release === null || asset === null) return Object.freeze({ status: "absent" });
    if (asset.state === "starter") return Object.freeze({ status: "starter" });
    const bytes = this.#token === undefined
      ? await this.#downloadPublic("market-data-catalog", marketDataPublicationAssetName)
      : await this.#readAdmittedUploadedAsset(release.id, asset);
    const sha256 = sha256Hex(bytes);
    if (bytes.byteLength !== asset.size || asset.digest !== null && asset.digest !== `sha256:${sha256}`) {
      throw new StoredDataIntegrityError();
    }
    return Object.freeze({
      bytes,
      identity: Object.freeze({
        assetName: marketDataPublicationAssetName,
        bytes: bytes.byteLength,
        releaseTag: "market-data-catalog",
        sha256,
      }),
      status: "uploaded",
    });
  }

  async removeMarketDataPublicationStarter() {
    this.#requireWriteToken();
    const { release, asset } = await this.#assetByName("market-data-catalog", marketDataPublicationAssetName);
    if (release === null || asset === null) return;
    requireMutableRelease(release, "delete_asset");
    if (asset.state !== "starter") throw new StoredDataIntegrityError();
    await this.#deleteAsset(release.id, asset);
    await this.#confirmAssetAbsent(release.id, marketDataPublicationAssetName);
  }

  async readMarketDataAsset(identity, range = null) {
    validatePhysicalAssetIdentity(identity);
    if (range !== null) return this.#downloadPublicRange(identity, range);
    const { release, asset } = await this.#assetByName(identity.releaseTag, identity.assetName);
    if (release === null || asset === null || asset.state !== "uploaded") throw new StoredDataIntegrityError();
    const bytes = this.#token === undefined
      ? await this.#downloadPublic(identity.releaseTag, identity.assetName)
      : await this.#readAdmittedUploadedAsset(release.id, asset);
    if (bytes.byteLength !== identity.bytes || sha256Hex(bytes) !== identity.sha256) throw new StoredDataIntegrityError();
    return bytes;
  }

  async writeMarketDataAsset(identity, bytes) {
    this.#requireWriteToken();
    validatePhysicalAssetIdentity(identity);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== identity.bytes || sha256Hex(bytes) !== identity.sha256) throw new Error("Market-data asset bytes are invalid.");
    const release = await this.#ensureRelease(identity.releaseTag);
    return this.#uploadImmutable(release, identity.assetName, bytes);
  }

  async removeMarketDataAsset(identity, { allowIncomplete = false } = {}) {
    this.#requireWriteToken();
    validatePhysicalAssetIdentity(identity);
    await this.#removeExactAsset({
      tag: identity.releaseTag,
      name: identity.assetName,
      expectedSize: identity.bytes,
      expectedDigest: identity.sha256,
      allowIncomplete,
    });
  }
}
