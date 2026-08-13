import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectIndex } from "../collector/process.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { GitHubReleaseStore } from "../storage/github-release-store.mjs";
import { block, FakeRpc, fixtureRegistry, swapLog } from "./fixtures.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

class FakeGitHub {
  constructor() {
    this.releases = new Map();
    this.nextReleaseId = 1;
    this.nextAssetId = 1;
    this.failStateUpload = false;
  }

  #releaseById(id) {
    return [...this.releases.values()].find((release) => release.id === Number(id));
  }

  #assetById(id) {
    for (const release of this.releases.values()) {
      for (const asset of release.assets.values()) if (asset.id === Number(id)) return asset;
    }
    return null;
  }

  fetch = async (target, init = {}) => {
    const url = new URL(target);
    const method = init.method ?? "GET";
    const requestHeaders = new Headers(init.headers);
    const tagMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/tags\/(.+)$/);
    if (method === "GET" && tagMatch) {
      const tag = decodeURIComponent(tagMatch[1]);
      const release = this.releases.get(tag);
      return release ? jsonResponse({ id: release.id, tag_name: tag }) : jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "POST" && url.pathname === "/repos/owner/index/releases") {
      assert.equal(requestHeaders.get("accept"), "application/vnd.github+json");
      assert.equal(requestHeaders.get("content-type"), "application/vnd.github+json");
      const request = JSON.parse(Buffer.from(init.body).toString("utf8"));
      const release = { id: this.nextReleaseId++, tag: request.tag_name, assets: new Map() };
      this.releases.set(release.tag, release);
      return jsonResponse({ id: release.id, tag_name: release.tag }, 201);
    }
    const assetListMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/([0-9]+)\/assets$/);
    if (method === "GET" && assetListMatch) {
      const release = this.#releaseById(assetListMatch[1]);
      if (!release) return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse([...release.assets.values()].map((asset) => ({ id: asset.id, name: asset.name, size: asset.bytes.byteLength })));
    }
    if (method === "POST" && assetListMatch && url.hostname === "uploads.github.com") {
      assert.equal(requestHeaders.get("accept"), "application/vnd.github+json");
      assert.equal(requestHeaders.get("content-type"), "application/octet-stream");
      const release = this.#releaseById(assetListMatch[1]);
      const name = url.searchParams.get("name");
      if (!release || !name) return jsonResponse({ message: "Not Found" }, 404);
      if (this.failStateUpload && name.includes("-state-")) return jsonResponse({ message: "failure" }, 500);
      const bytes = Buffer.from(init.body);
      const asset = { id: this.nextAssetId++, name, bytes };
      release.assets.set(name, asset);
      return jsonResponse({ id: asset.id, name, size: bytes.byteLength }, 201);
    }
    const assetMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/assets\/([0-9]+)$/);
    if (assetMatch && method === "GET") {
      assert.equal(requestHeaders.get("accept"), "application/octet-stream");
      assert.equal(requestHeaders.get("content-type"), null);
      const asset = this.#assetById(assetMatch[1]);
      return asset ? new Response(asset.bytes) : jsonResponse({ message: "Not Found" }, 404);
    }
    if (assetMatch && method === "DELETE") {
      for (const release of this.releases.values()) {
        for (const [name, asset] of release.assets) {
          if (asset.id === Number(assetMatch[1])) {
            release.assets.delete(name);
            return new Response(null, { status: 204 });
          }
        }
      }
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "GET" && url.pathname === "/repos/owner/index/releases") {
      return jsonResponse([...this.releases.values()].map((release) => ({ id: release.id, tag_name: release.tag })));
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${target}`);
  };
}

function chainBlocks(baseSeconds, maximum) {
  return Array.from({ length: maximum + 1 }, (_, number) => block(number, baseSeconds + number * 10));
}

test("directory and GitHub adapters preserve the same admitted state and day bytes", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 720);
  const logs = [swapLog({ registry, asset, block: blocks[361], amount0: -3_000_000n, amount1: 10_000_000_000_000_000n })];
  const directory = new DirectoryStore({ root: await mkdtemp(join(tmpdir(), "stock-token-directory-")), registry, group });
  const githubApi = new FakeGitHub();
  const github = new GitHubReleaseStore({ repository: "owner/index", token: "test", registry, group, fetchImplementation: githubApi.fetch });

  await collectIndex({ registry, group, store: directory, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 720 }) });
  await collectIndex({ registry, group, store: github, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 720 }) });
  const directoryState = await directory.readState();
  const githubState = await github.readState();
  assert.deepEqual(githubState, directoryState);
  assert.deepEqual(await github.readDay(githubState.days[0]), await directory.readDay(directoryState.days[0]));

  await collectIndex({ registry, group, store: github, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 720 }) });
  assert.deepEqual(await github.readState(), githubState);
});

test("GitHub publication never exposes state before every referenced day is stored", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 720);
  const logs = [swapLog({ registry, asset, block: blocks[361], amount0: -3_000_000n, amount1: 10_000_000_000_000_000n })];
  const githubApi = new FakeGitHub();
  githubApi.failStateUpload = true;
  const store = new GitHubReleaseStore({ repository: "owner/index", token: "test", registry, group, fetchImplementation: githubApi.fetch });
  await assert.rejects(collectIndex({ registry, group, store, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 720 }) }), /HTTP 500/);
  assert.equal(await store.readState(), null);
  assert.ok(githubApi.releases.get("index-2026-08").assets.size > 0);
});

test("an interrupted replacement leaves the previous state selected and a changed retry can publish", async () => {
  const registry = await fixtureRegistry();
  const group = registry.groups[0];
  const asset = group.assets[0];
  const base = Date.parse("2026-08-13T00:00:00.000Z") / 1000;
  const blocks = chainBlocks(base, 840);
  const logs = [swapLog({ registry, asset, block: blocks[361], amount0: -3_000_000n, amount1: 10_000_000_000_000_000n })];
  const githubApi = new FakeGitHub();
  const store = new GitHubReleaseStore({ repository: "owner/index", token: "test", registry, group, fetchImplementation: githubApi.fetch });
  await collectIndex({ registry, group, store, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 720 }) });
  const selected = await store.readState();

  githubApi.failStateUpload = true;
  logs.push(swapLog({ registry, asset, block: blocks[725], amount0: -3_100_000n, amount1: 10_000_000_000_000_000n }));
  await assert.rejects(collectIndex({ registry, group, store, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 780 }) }), /HTTP 500/);
  assert.deepEqual(await store.readState(), selected);

  githubApi.failStateUpload = false;
  logs.push(swapLog({ registry, asset, block: blocks[785], amount0: -3_200_000n, amount1: 10_000_000_000_000_000n }));
  const retried = await collectIndex({ registry, group, store, rpc: new FakeRpc({ registry, blocks, logs, finalizedNumber: 840 }) });
  assert.equal(retried.sequence, 2);
  const state = await store.readState();
  assert.equal(state.sequence, 2);
  assert.equal((await store.readDay(state.days[0])).candles.length, 3);
  assert.equal(githubApi.releases.get("index-2026-08").assets.size, 1);
});
