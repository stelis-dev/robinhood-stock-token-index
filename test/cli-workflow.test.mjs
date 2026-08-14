import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseArguments, rpcEndpointSelectionLog, rpcEndpointSourceName, selectRpcUrls } from "../cli.mjs";
import { loadRegistry } from "../collector/registry.mjs";

test("CLI selection cannot mix storage adapter configuration", () => {
  assert.deepEqual(parseArguments(["verify", "--store", "directory", "--root", "/tmp/index"]), {
    operation: "verify",
    store: "directory",
    root: "/tmp/index",
    repository: undefined,
  });
  assert.throws(() => parseArguments(["collect", "--store", "github", "--repository", "owner/repo", "--root", "/tmp/index"]), /cannot cross/);
  assert.throws(() => parseArguments(["unknown", "--store", "directory", "--root", "/tmp/index"]), /Operation/);
});

test("the CLI fixes the registry primary and admits only fallback slots zero and one", async () => {
  const registry = await loadRegistry();
  assert.deepEqual(selectRpcUrls(registry, {}), ["https://rpc.mainnet.chain.robinhood.com/"]);
  assert.deepEqual(selectRpcUrls(registry, {
    INDEX_RPC_FALLBACK_URL_0: "https://second.example/key",
    INDEX_RPC_FALLBACK_URL_1: "https://third.example/key",
  }), [
    "https://rpc.mainnet.chain.robinhood.com/",
    "https://second.example/key",
    "https://third.example/key",
  ]);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_1: "https://third.example" }), /contiguous/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "https://rpc.mainnet.chain.robinhood.com" }), /unique/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "https://two.example", INDEX_RPC_FALLBACK_URL_2: "https://four.example" }), /unsupported/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: " https://two.example" }), /whitespace/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "http://two.example" }), /HTTPS/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "https://user:token@two.example" }), /user information/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "https://two.example/#token" }), /fragment/);
});

test("the CLI reports only the fixed source name for the selected RPC endpoint", () => {
  assert.equal(rpcEndpointSourceName(0), "registry.chain.primaryRpcUrl");
  assert.equal(rpcEndpointSourceName(1), "INDEX_RPC_FALLBACK_URL_0");
  assert.equal(rpcEndpointSourceName(2), "INDEX_RPC_FALLBACK_URL_1");
  assert.throws(() => rpcEndpointSourceName(3), /selection/);
  assert.equal(rpcEndpointSelectionLog(1, {}), null);
  assert.equal(
    rpcEndpointSelectionLog(1, { GITHUB_ACTIONS: "true" }),
    "rpc_endpoint_source=INDEX_RPC_FALLBACK_URL_0\n",
  );
});

test("the workflow pins actions and keeps publication permission on the serialized operation job", async () => {
  const source = await readFile(new URL("../.github/workflows/index.yml", import.meta.url), "utf8");
  const registry = await loadRegistry();
  const collectSchedule = registry.collection.scheduleMinutes.join(",");
  assert.match(source, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(source, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.ok(source.includes(`cron: "${collectSchedule} * * * *"`));
  assert.ok(source.includes(`"${collectSchedule} * * * *") operation="collect"`));
  assert.match(source, /group: robinhood-stock-token-index-operation/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /permissions:\n      contents: write/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_0: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_0 \}\}/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_1: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_1 \}\}/);
  assert.doesNotMatch(source, /vars\.INDEX_RPC_FALLBACK_URL/);
  assert.doesNotMatch(source, /INDEX_RPC_FALLBACK_URL_2/);
  assert.doesNotMatch(source, /pull_request_target/);
});
