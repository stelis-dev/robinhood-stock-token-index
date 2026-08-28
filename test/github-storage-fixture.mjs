import { sha256Hex } from "../collector/canonical.mjs";

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export class FakeGitHub {
  constructor() {
    this.releases = new Map();
    this.nextReleaseId = 1;
    this.nextAssetId = 1;
    this.requests = [];
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
    this.requests.push({ method, target, authorization: requestHeaders.get("authorization") });
    const tagMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/tags\/(.+)$/);
    if (method === "GET" && tagMatch) {
      const tag = decodeURIComponent(tagMatch[1]);
      const release = this.releases.get(tag);
      return release ? jsonResponse({ draft: false, id: release.id, immutable: false, tag_name: tag }) : jsonResponse({ message: "Not Found" }, 404);
    }
    if (method === "POST" && url.pathname === "/repos/owner/index/releases") {
      const request = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (this.releases.has(request.tag_name)) return jsonResponse({ message: "already_exists" }, 422);
      const release = { id: this.nextReleaseId++, tag: request.tag_name, assets: new Map() };
      this.releases.set(release.tag, release);
      return jsonResponse({ draft: false, id: release.id, immutable: false, tag_name: release.tag }, 201);
    }
    const assetListMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/([0-9]+)\/assets$/);
    if (method === "GET" && assetListMatch) {
      const release = this.#releaseById(assetListMatch[1]);
      if (!release) return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse([...release.assets.values()].map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.bytes.byteLength,
        state: asset.state,
        digest: asset.digest,
      })));
    }
    if (method === "POST" && assetListMatch && url.hostname === "uploads.github.com") {
      const release = this.#releaseById(assetListMatch[1]);
      const name = url.searchParams.get("name");
      if (!release || !name) return jsonResponse({ message: "Not Found" }, 404);
      if (release.assets.has(name)) return jsonResponse({ message: "already_exists" }, 422);
      const bytes = Buffer.from(init.body);
      const asset = {
        id: this.nextAssetId++,
        name,
        bytes,
        state: "uploaded",
        digest: `sha256:${sha256Hex(bytes)}`,
      };
      release.assets.set(name, asset);
      return jsonResponse({ id: asset.id, name, size: bytes.byteLength, state: asset.state, digest: asset.digest }, 201);
    }
    const assetMatch = url.pathname.match(/^\/repos\/owner\/index\/releases\/assets\/([0-9]+)$/);
    if (assetMatch && method === "GET") {
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
    const publicAssetMatch = url.pathname.match(/^\/owner\/index\/releases\/download\/([^/]+)\/(.+)$/);
    if (method === "GET" && url.hostname === "github.com" && publicAssetMatch) {
      const release = this.releases.get(decodeURIComponent(publicAssetMatch[1]));
      const asset = release?.assets.get(decodeURIComponent(publicAssetMatch[2]));
      return asset ? new Response(asset.bytes) : jsonResponse({ message: "Not Found" }, 404);
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${target}`);
  };
}
