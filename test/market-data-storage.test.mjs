import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Hex } from "../collector/canonical.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { GitHubReleaseStore, GitHubStorageError } from "../storage/github-release-store.mjs";
import { StoredDataIntegrityError } from "../storage/storage-error.mjs";
import { FakeGitHub } from "./github-storage-fixture.mjs";
import { jsonResponse } from "./github-storage-fixture.mjs";

function dataIdentity(bytes) {
  const sha256 = sha256Hex(bytes);
  return Object.freeze({
    assetName: `data-${sha256}.bin`,
    bytes: bytes.byteLength,
    releaseTag: "market-data-2026-08-s1",
    sha256,
  });
}

test("market-data storage writes immutable physical assets and reads exact ranges", async () => {
  const bytes = Buffer.from("first-membersecond-member");
  const identity = dataIdentity(bytes);
  const store = new DirectoryStore({
    maximumArtifactBytes: 1_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-storage-")),
  });

  assert.deepEqual(await store.writeMarketDataAsset(identity, bytes), bytes);
  assert.deepEqual(await store.listMarketDataAssets(identity.releaseTag), [{
    assetName: identity.assetName,
    bytes: identity.bytes,
    sha256: identity.sha256,
    state: "uploaded",
  }]);
  assert.equal((await store.readMarketDataAsset(identity, { from: 12, until: 18 })).toString("utf8"), "second");
  await assert.rejects(
    store.writeMarketDataAsset(identity, Buffer.from("different")),
    /asset bytes are invalid/,
  );
  await store.removeMarketDataAsset(identity);
  assert.deepEqual(await store.listMarketDataAssets(identity.releaseTag), []);
});

test("DirectoryStore removes crash staging files outside the Release asset namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "market-data-storage-staging-"));
  const temporary = join(root, ".market-data-temporary");
  await mkdir(temporary, { recursive: true });
  await writeFile(join(temporary, `${"a".repeat(64)}-1-1.tmp`), "incomplete");
  const store = new DirectoryStore({ maximumArtifactBytes: 1_000_000, root });
  assert.deepEqual(await store.listMarketDataAssets("market-data-2026-08-s1"), []);
  assert.deepEqual(await readdir(temporary), [`${"a".repeat(64)}-1-1.tmp`]);
  const bytes = Buffer.from("first mutation");
  await store.writeMarketDataAsset(dataIdentity(bytes), bytes);
  assert.deepEqual(await readdir(temporary), []);
});

test("GitHub market-data Range reads retain the exact range across redirects and reject fallback", async () => {
  const bytes = Buffer.from("first-membersecond-member");
  const identity = dataIdentity(bytes);
  const github = new FakeGitHub();
  const writer = new GitHubReleaseStore({
    fetchImplementation: github.fetch,
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
  });
  await writer.writeMarketDataAsset(identity, bytes);

  const ranges = [];
  const encodings = [];
  const reader = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => {
      const url = new URL(target);
      if (url.hostname === "github.com") {
        ranges.push(new Headers(init.headers).get("range"));
        encodings.push(new Headers(init.headers).get("accept-encoding"));
        return new Response(null, { status: 302, headers: { location: "https://objects.example/asset" } });
      }
      if (url.hostname === "objects.example") {
        ranges.push(new Headers(init.headers).get("range"));
        encodings.push(new Headers(init.headers).get("accept-encoding"));
        return new Response(bytes.subarray(12, 18), {
          status: 206,
          headers: { "content-range": `bytes 12-17/${bytes.byteLength}` },
        });
      }
      return github.fetch(target, init);
    },
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
  });
  assert.equal((await reader.readMarketDataAsset(identity, { from: 12, until: 18 })).toString("utf8"), "second");
  assert.deepEqual(ranges, ["bytes=12-17", "bytes=12-17"]);
  assert.deepEqual(encodings, ["identity", "identity"]);

  const ignored = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => (
      new URL(target).hostname === "github.com" ? new Response(bytes) : github.fetch(target, init)
    ),
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
  });
  await assert.rejects(
    ignored.readMarketDataAsset(identity, { from: 12, until: 18 }),
    (error) => error instanceof GitHubStorageError
      && error.operation === "download_public"
      && error.reason === "request_rejected",
  );

  const contradictory = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => (
      new URL(target).hostname === "github.com"
        ? new Response(bytes.subarray(12, 18), { status: 206, headers: { "content-range": `bytes 11-16/${bytes.byteLength}` } })
        : github.fetch(target, init)
    ),
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
  });
  await assert.rejects(
    contradictory.readMarketDataAsset(identity, { from: 12, until: 18 }),
    (error) => error instanceof StoredDataIntegrityError,
  );

  const contradictoryLength = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => (
      new URL(target).hostname === "github.com"
        ? new Response(bytes.subarray(12, 18), {
          status: 206,
          headers: {
            "content-length": "7",
            "content-range": `bytes 12-17/${bytes.byteLength}`,
          },
        })
        : github.fetch(target, init)
    ),
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
  });
  await assert.rejects(
    contradictoryLength.readMarketDataAsset(identity, { from: 12, until: 18 }),
    (error) => error instanceof StoredDataIntegrityError,
  );
});

test("GitHub retry waits share one cumulative delay budget", async () => {
  const waits = [];
  const store = new GitHubReleaseStore({
    fetchImplementation: async () => new Response(null, {
      status: 429,
      headers: { "retry-after": "60" },
    }),
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    waitImplementation: async (milliseconds) => waits.push(milliseconds),
  });
  await assert.rejects(
    store.listMarketDataAssets("market-data-2026-08-s1"),
    (error) => error instanceof GitHubStorageError && error.reason === "rate_limited",
  );
  assert.deepEqual(waits, [60_000]);
});

test("an uncertain market-data upload is reconciled without a duplicate mutation", async () => {
  const bytes = Buffer.from("packed-market-data");
  const identity = dataIdentity(bytes);
  const github = new FakeGitHub();
  let responseLost = false;
  const store = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => {
      if (!responseLost && init.method === "POST" && new URL(target).hostname === "uploads.github.com") {
        const response = await github.fetch(target, init);
        assert.equal(response.status, 201);
        responseLost = true;
        return jsonResponse({ message: "response lost" }, 503);
      }
      return github.fetch(target, init);
    },
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
    waitImplementation: async () => {},
  });
  assert.deepEqual(await store.writeMarketDataAsset(identity, bytes), bytes);
  assert.equal(github.requests.filter((request) => (
    request.method === "POST" && new URL(request.target).hostname === "uploads.github.com"
  )).length, 1);
});

test("exact market-data deletion rejects contradictory remote identity", async () => {
  const bytes = Buffer.from("packed-market-data");
  const identity = dataIdentity(bytes);
  const github = new FakeGitHub();
  const writer = new GitHubReleaseStore({
    fetchImplementation: github.fetch,
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
  });
  await writer.writeMarketDataAsset(identity, bytes);
  github.releases.get(identity.releaseTag).assets.get(identity.assetName).digest = `sha256:${"0".repeat(64)}`;
  const restarted = new GitHubReleaseStore({
    fetchImplementation: github.fetch,
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
  });
  await assert.rejects(restarted.removeMarketDataAsset(identity), (error) => error instanceof StoredDataIntegrityError);
  assert.equal(github.releases.get(identity.releaseTag).assets.has(identity.assetName), true);
});

test("GitHub storage rejects a draft Release before writing an asset", async () => {
  const bytes = Buffer.from("packed-market-data");
  const identity = dataIdentity(bytes);
  const store = new GitHubReleaseStore({
    fetchImplementation: async () => jsonResponse({
      draft: true,
      id: 1,
      immutable: false,
      tag_name: identity.releaseTag,
    }),
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
  });
  await assert.rejects(store.writeMarketDataAsset(identity, bytes), (error) => (
    error instanceof GitHubStorageError && error.reason === "invalid_response"
  ));
});

test("GitHub storage cannot admit an immutable Release through creation reconciliation", async () => {
  const bytes = Buffer.from("packed-market-data");
  const identity = dataIdentity(bytes);
  let created = false;
  const requests = [];
  const store = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => {
      const url = new URL(target);
      const method = init.method ?? "GET";
      requests.push({ host: url.hostname, method, path: url.pathname });
      if (method === "GET" && url.pathname.includes("/releases/tags/")) {
        return created
          ? jsonResponse({ draft: false, id: 1, immutable: true, tag_name: identity.releaseTag })
          : jsonResponse({ message: "Not Found" }, 404);
      }
      if (method === "POST" && url.pathname === "/repos/owner/index/releases") {
        created = true;
        return jsonResponse({ draft: false, id: 1, immutable: true, tag_name: identity.releaseTag }, 201);
      }
      throw new Error(`Unexpected request: ${method} ${target}`);
    },
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
  });
  await assert.rejects(store.writeMarketDataAsset(identity, bytes), (error) => (
    error instanceof GitHubStorageError && error.reason === "immutable_conflict"
  ));
  assert.equal(requests.some((request) => request.host === "uploads.github.com"), false);
});

test("GitHub storage cannot delete from an immutable Release", async () => {
  const bytes = Buffer.from("packed-market-data");
  const identity = dataIdentity(bytes);
  const methods = [];
  const store = new GitHubReleaseStore({
    fetchImplementation: async (target, init = {}) => {
      const url = new URL(target);
      const method = init.method ?? "GET";
      methods.push(method);
      if (url.pathname.includes("/releases/tags/")) {
        return jsonResponse({ draft: false, id: 1, immutable: true, tag_name: identity.releaseTag });
      }
      if (url.pathname === "/repos/owner/index/releases/1/assets") {
        return jsonResponse([{
          digest: `sha256:${identity.sha256}`,
          id: 1,
          name: identity.assetName,
          size: identity.bytes,
          state: "uploaded",
        }]);
      }
      throw new Error(`Unexpected request: ${method} ${target}`);
    },
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
    token: "test-token",
  });
  await assert.rejects(store.removeMarketDataAsset(identity), (error) => (
    error instanceof GitHubStorageError && error.reason === "immutable_conflict"
  ));
  assert.equal(methods.includes("DELETE"), false);
});

test("GitHub storage rejects invalid UTF-8 in a successful API response", async () => {
  const tag = "market-data-2026-08-s1";
  const bytes = Buffer.concat([
    Buffer.from(`{"draft":false,"id":1,"tag_name":"${tag}","ignored":"`, "utf8"),
    Buffer.from([0x80]),
    Buffer.from('"}', "utf8"),
  ]);
  const store = new GitHubReleaseStore({
    fetchImplementation: async () => new Response(bytes),
    maximumArtifactBytes: 1_000_000,
    repository: "owner/index",
  });
  await assert.rejects(store.listMarketDataAssets(tag), (error) => (
    error instanceof GitHubStorageError && error.reason === "invalid_response"
  ));
});
