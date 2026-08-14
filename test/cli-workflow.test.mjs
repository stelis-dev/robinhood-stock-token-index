import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseArguments, selectRpcUrl } from "../cli.mjs";
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

test("the CLI selects one explicit RPC URL without a fallback list", () => {
  assert.equal(selectRpcUrl("https://public.example", {}), "https://public.example/");
  assert.equal(selectRpcUrl("https://public.example", { INDEX_RPC_URL: "https://operator.example/rpc" }), "https://operator.example/rpc");
  assert.throws(() => selectRpcUrl("https://public.example", { INDEX_RPC_URL: " https://operator.example" }), /whitespace/);
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
  assert.match(source, /INDEX_RPC_URL: \$\{\{ secrets\.INDEX_RPC_URL \}\}/);
  assert.doesNotMatch(source, /pull_request_target/);
});
