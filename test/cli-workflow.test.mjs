import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  pairOperationFailureLog,
  pairOperationSuccessLog,
  parseArguments,
  publicationRecoveryLog,
  rpcEndpointSourceName,
  selectRpcUrls,
} from "../cli.mjs";
import { loadPairRegistry } from "../collector/pair-registry.mjs";
import { RpcResponseRejectedError } from "../collector/rpc-endpoint.mjs";
import {
  rpcEndpointFailureFacts,
  RpcPairOperationUnavailableError,
} from "../collector/rpc-operation.mjs";
import { loadCollectionPlan } from "../scheduler/collection-plan.mjs";
import { GitHubStorageError } from "../storage/github-release-store.mjs";
import { StoredDataIntegrityError } from "../storage/stored-files.mjs";
import { pairEntryBySymbol } from "./pair-fixtures.mjs";

test("the CLI validates one PoolId and sends read and storage options to their responsible components", async () => {
  const registry = await loadPairRegistry();
  const pairId = pairEntryBySymbol(registry, "NVDA").pair.pairId;
  assert.deepEqual(parseArguments(["verify", "--pair", pairId, "--store", "directory", "--root", "/tmp/index"]), {
    operation: "verify",
    target: { kind: "pair", id: pairId },
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
    target: { kind: "pair", id: pairId },
    store: "github",
    root: undefined,
    repository: "owner/repo",
    from: "2026-08-14T14:01:00.000Z",
    until: "2026-08-14T15:01:00.000Z",
  });
  assert.throws(() => parseArguments(["verify", "--store", "directory", "--root", "/tmp/index"]), /exactly one/);
  assert.throws(() => parseArguments(["read", "--pair", pairId, "--store", "directory", "--root", "/tmp/index"]), /--from and --until/);
  assert.throws(() => parseArguments(["collect", "--pair", pairId, "--from", "2026-08-14T14:01:00.000Z", "--store", "directory", "--root", "/tmp/index"]), /Only read/);
  assert.throws(() => parseArguments(["collect", "--pair", pairId, "--store", "github", "--repository", "owner/repo", "--root", "/tmp/index"]), /cannot cross/);
});

test("the CLI fixes the registry primary and validates only two contiguous secret URLs", async () => {
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

test("Actions logging reveals fixed operation, endpoint, and failure classifications only", () => {
  const pairId = `0x${"1".repeat(64)}`;
  const primaryError = new RpcResponseRejectedError("rpc_error", {
    rpcCode: -32000,
    rpcMethod: "eth_getLogs",
  });
  const primaryFailure = Object.freeze({
    endpointIndex: 0,
    error: primaryError,
  });
  assert.throws(() => new RpcResponseRejectedError("provider_specific_reason"), /reason is invalid/);
  assert.throws(() => new RpcResponseRejectedError("http_rejected"), /HTTP status is invalid/);
  assert.throws(() => new RpcResponseRejectedError("rpc_error"), /error code is invalid/);
  assert.throws(() => new RpcResponseRejectedError("response_result_invalid"), /method is invalid/);
  assert.throws(() => new RpcResponseRejectedError("rpc_error", { rpcCode: -32602, rpcMethod: "provider_method" }), /method is invalid/);
  assert.equal(rpcEndpointSourceName(0), "registry.chain.primaryRpcUrl");
  assert.equal(rpcEndpointSourceName(1), "INDEX_RPC_FALLBACK_URL_0");
  assert.equal(rpcEndpointSourceName(2), "INDEX_RPC_FALLBACK_URL_1");
  assert.throws(() => rpcEndpointSourceName(3), /selection/);
  assert.equal(pairOperationSuccessLog("history", pairId, 1, {}), null);
  assert.equal(
    pairOperationSuccessLog("history", pairId, 1, { GITHUB_ACTIONS: "true" }, [primaryFailure]),
    `pair_operation=history status=success rpc_endpoint_source=INDEX_RPC_FALLBACK_URL_0 failed_rpc_0_endpoint_source=registry.chain.primaryRpcUrl failed_rpc_0_reason=rpc_error failed_rpc_0_method=eth_getLogs failed_rpc_0_code=-32000 pair_id=${pairId}\n`,
  );
  assert.equal(pairOperationFailureLog("current", pairId, {}), null);
  assert.equal(
    pairOperationFailureLog("current", pairId, { GITHUB_ACTIONS: "true" }),
    `pair_operation=current status=failed component=collector reason=operation_rejected pair_id=${pairId}\n`,
  );
  assert.equal(
    pairOperationFailureLog(
      "history",
      pairId,
      { GITHUB_ACTIONS: "true" },
      new GitHubStorageError("delete_asset", "rate_limited", { retryable: true }),
    ),
    `pair_operation=history status=failed component=github operation=delete_asset reason=rate_limited pair_id=${pairId}\n`,
  );
  assert.equal(
    pairOperationFailureLog(
      "current",
      pairId,
      { GITHUB_ACTIONS: "true" },
      new RpcPairOperationUnavailableError(),
    ),
    `pair_operation=current status=failed component=rpc reason=all_endpoints_unavailable pair_id=${pairId}\n`,
  );
  assert.equal(
    pairOperationFailureLog(
      "history",
      pairId,
      { GITHUB_ACTIONS: "true" },
      primaryError,
      [primaryFailure],
    ),
    `pair_operation=history status=failed component=rpc reason=rpc_error rpc_method=eth_getLogs rpc_code=-32000 rpc_endpoint_source=registry.chain.primaryRpcUrl pair_id=${pairId}\n`,
  );
  assert.throws(() => pairOperationSuccessLog(
    "history",
    pairId,
    1,
    { GITHUB_ACTIONS: "true" },
    [{ endpointIndex: 0, error: new Error("provider message") }],
  ), /failure/);
  assert.equal(
    pairOperationFailureLog(
      "history",
      pairId,
      { GITHUB_ACTIONS: "true" },
      new StoredDataIntegrityError(),
    ),
    `pair_operation=history status=failed component=stored_data reason=integrity_rejected pair_id=${pairId}\n`,
  );
  assert.equal(publicationRecoveryLog({ status: "idle", pairId }, { GITHUB_ACTIONS: "true" }), null);
  assert.equal(
    publicationRecoveryLog({
      status: "aborted", pairId, phase: "current", selectedSequence: 4,
    }, { GITHUB_ACTIONS: "true" }),
    `publication_recovery outcome=previous_state_retained phase=current selected_sequence=4 pair_id=${pairId}\n`,
  );
  assert.equal(
    publicationRecoveryLog({
      status: "committed", pairId, phase: "history", selectedSequence: 5,
    }, { GITHUB_ACTIONS: "true" }),
    `publication_recovery outcome=next_state_selected phase=history selected_sequence=5 pair_id=${pairId}\n`,
  );
});

test("the workflow copies every configured cron and preserves queued and manual execution", async () => {
  const source = await readFile(new URL("../.github/workflows/index.yml", import.meta.url), "utf8");
  const pairRegistry = await loadPairRegistry();
  const collectionPlan = await loadCollectionPlan(pairRegistry);
  const expectedSchedules = collectionPlan.groups.flatMap((group) => group.schedules);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /targetKind:\n        description: Exact target kind/);
  assert.match(source, /targetId:\n        description: Exact pair or collection-group ID/);
  assert.match(source, /if: github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'/);
  assert.match(source, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(source, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(
    source,
    /concurrency:\n      group: robinhood-stock-token-index-operation\n      queue: max\n      cancel-in-progress: false/,
  );
  assert.match(source, /permissions:\n      contents: write/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_0: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_0 \}\}/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_1: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_1 \}\}/);
  assert.match(source, /OPERATION=collect\n            TARGET_FLAG=--schedule\n            TARGET_ID="\$\{SCHEDULE_EXPRESSION\}"/);
  assert.match(source, /node cli\.mjs "\$\{OPERATION\}" "\$\{TARGET_FLAG\}" "\$\{TARGET_ID\}"/);
  assert.deepEqual(
    [...source.slice(source.indexOf("  operate:")).matchAll(/node ([^\s]+\.mjs)/g)].map((match) => match[1]),
    ["cli.mjs"],
  );
  assert.deepEqual(
    [...source.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]),
    expectedSchedules,
  );
  for (const entry of pairRegistry.pairs) assert.doesNotMatch(source, new RegExp(entry.pair.pairId));
  const verifyJob = source.slice(source.indexOf("  verify:"), source.indexOf("  operate:"));
  const operateJob = source.slice(source.indexOf("  operate:"));
  assert.match(verifyJob, /run: npm test/);
  assert.doesNotMatch(operateJob, /run: npm test/);
  assert.doesNotMatch(operateJob, /node cli\.mjs verify/);
  assert.doesNotMatch(source, /vars\.INDEX_RPC_FALLBACK_URL/);
  assert.doesNotMatch(source, /pull_request_target/);
});
