import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseArguments, rpcEndpointSelectionLog, rpcEndpointSourceName, selectRpcUrls } from "../cli.mjs";
import { loadPairRegistry } from "../collector/pair-registry.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";

test("the CLI admits one exact pair and keeps read-period and storage options on their owners", async () => {
  const registry = await loadPairRegistry();
  const pairId = pairEntryBySymbol(registry, "NVDA").pair.pairId;
  assert.deepEqual(parseArguments(["verify", "--pair", pairId, "--store", "directory", "--root", "/tmp/index"]), {
    operation: "verify",
    pairId,
    store: "directory",
    root: "/tmp/index",
    repository: undefined,
    from: undefined,
    until: undefined,
  });
  assert.deepEqual(parseArguments([
    "read",
    "--pair", pairId,
    "--from", "2026-08-14T14:01:00.000Z",
    "--until", "2026-08-14T15:01:00.000Z",
    "--store", "github",
    "--repository", "owner/repo",
  ]), {
    operation: "read",
    pairId,
    store: "github",
    root: undefined,
    repository: "owner/repo",
    from: "2026-08-14T14:01:00.000Z",
    until: "2026-08-14T15:01:00.000Z",
  });
  assert.throws(() => parseArguments(["verify", "--store", "directory", "--root", "/tmp/index"]), /--pair/);
  assert.throws(() => parseArguments(["read", "--pair", pairId, "--store", "directory", "--root", "/tmp/index"]), /--from and --until/);
  assert.throws(() => parseArguments(["collect", "--pair", pairId, "--from", "2026-08-14T14:01:00.000Z", "--store", "directory", "--root", "/tmp/index"]), /Only read/);
  assert.throws(() => parseArguments(["collect", "--pair", pairId, "--store", "github", "--repository", "owner/repo", "--root", "/tmp/index"]), /cannot cross/);
});

test("the CLI fixes the registry primary and admits only two contiguous secret URLs", async () => {
  const registry = await loadPairRegistry();
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
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_FOO: "https://four.example" }), /unsupported/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: " https://two.example" }), /whitespace/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "http://two.example" }), /HTTPS/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "https://user:token@two.example" }), /user information/);
  assert.throws(() => selectRpcUrls(registry, { INDEX_RPC_FALLBACK_URL_0: "https://two.example/#token" }), /fragment/);
});

test("Actions logging reveals only attempt role and the fixed endpoint source name", () => {
  assert.equal(rpcEndpointSourceName(0), "registry.chain.primaryRpcUrl");
  assert.equal(rpcEndpointSourceName(1), "INDEX_RPC_FALLBACK_URL_0");
  assert.equal(rpcEndpointSourceName(2), "INDEX_RPC_FALLBACK_URL_1");
  assert.throws(() => rpcEndpointSourceName(3), /selection/);
  assert.equal(rpcEndpointSelectionLog("history", 1, {}), null);
  assert.equal(
    rpcEndpointSelectionLog("history", 1, { GITHUB_ACTIONS: "true" }),
    "rpc_attempt=history rpc_endpoint_source=INDEX_RPC_FALLBACK_URL_0\n",
  );
});

test("the workflow tests source changes and keeps manual pair operations transition-scoped", async () => {
  const source = await readFile(new URL("../.github/workflows/index.yml", import.meta.url), "utf8");
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /pair:\n        description: Exact pair ID/);
  assert.match(source, /if: github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(source, /github\.event_name == 'schedule'/);
  assert.match(source, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(source, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(source, /group: robinhood-stock-token-index-operation/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /permissions:\n      contents: write/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_0: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_0 \}\}/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_1: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_1 \}\}/);
  const verifyJob = source.slice(source.indexOf("  verify:"), source.indexOf("  operate:"));
  const operateJob = source.slice(source.indexOf("  operate:"));
  assert.match(verifyJob, /run: npm test/);
  assert.doesNotMatch(operateJob, /run: npm test/);
  assert.doesNotMatch(operateJob, /node cli\.mjs verify/);
  assert.doesNotMatch(source, /vars\.INDEX_RPC_FALLBACK_URL/);
  assert.doesNotMatch(source, /pull_request_target/);
});
