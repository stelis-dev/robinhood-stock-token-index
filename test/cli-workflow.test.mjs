import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseArguments,
  rpcEndpointSourceName,
  runCommand,
  selectRpcUrls,
} from "../cli.mjs";
import { loadMarketDataConfiguration } from "../collector/market-data-configuration.mjs";
import { maximumMarketDataAssetBytes } from "../collector/market-data-assets.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";

test("the CLI owns one shared collection target and exact read and repair inputs", () => {
  assert.deepEqual(parseArguments([
    "collect", "--store", "github", "--repository", "owner/index",
  ]), {
    baseCurrencyAddress: undefined,
    fromBlock: undefined,
    fromTimestamp: undefined,
    month: undefined,
    operation: "collect",
    poolId: undefined,
    repository: "owner/index",
    resolution: undefined,
    root: undefined,
    store: "github",
    untilBlock: undefined,
    untilTimestamp: undefined,
  });
  assert.equal(parseArguments([
    "read",
    "--base", `0x${"1".repeat(40)}`,
    "--month", "2026-08",
    "--resolution", "4h",
    "--store", "directory",
    "--root", "/tmp/index",
  ]).operation, "read");
  assert.equal(parseArguments([
    "repair",
    "--base", `0x${"1".repeat(40)}`,
    "--pool-id", `0x${"2".repeat(64)}`,
    "--from-block", "1",
    "--from-timestamp", "2026-08-27T00:00:00.000Z",
    "--until-block", "2",
    "--until-timestamp", "2026-08-27T00:01:00.000Z",
    "--store", "directory",
    "--root", "/tmp/index",
  ]).operation, "repair");
  assert.throws(() => parseArguments(["collect", "--base", `0x${"1".repeat(40)}`, "--store", "directory", "--root", "/tmp/index"]), /unrelated/);
  assert.throws(() => parseArguments(["read", "--store", "directory", "--root", "/tmp/index"]), /requires/);
  assert.throws(() => parseArguments(["collect", "--store", "github", "--repository", "owner/index", "--root", "/tmp/index"]), /cannot cross/);
});

test("RPC endpoints use the fixed primary and two ordered optional fallback secrets", () => {
  assert.deepEqual(selectRpcUrls({}), ["https://rpc.mainnet.chain.robinhood.com/"]);
  assert.deepEqual(selectRpcUrls({
    INDEX_RPC_FALLBACK_URL_0: "https://second.example/key",
    INDEX_RPC_FALLBACK_URL_1: "https://third.example/key",
  }), ["https://rpc.mainnet.chain.robinhood.com/", "https://second.example/key", "https://third.example/key"]);
  assert.equal(rpcEndpointSourceName(0), "primary");
  assert.equal(rpcEndpointSourceName(1), "INDEX_RPC_FALLBACK_URL_0");
  assert.throws(() => selectRpcUrls({
    INDEX_RPC_FALLBACK_URL_1: "https://third.example",
  }), /contiguous/);
  assert.throws(() => selectRpcUrls({
    INDEX_RPC_URL: "https://primary.example",
    INDEX_RPC_EXTRA: "https://extra.example",
  }), /unsupported/);
});

test("read and verify report no selected root without claiming physical storage is empty", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const store = new DirectoryStore({
    maximumArtifactBytes: maximumMarketDataAssetBytes,
    root: await mkdtemp(join(tmpdir(), "market-data-cli-")),
  });
  const verify = await runCommand(parseArguments([
    "verify", "--store", "directory", "--root", store.root,
  ]), admittedConfiguration, { environment: {}, store });
  assert.deepEqual(verify, { status: "unpublished" });
  const base = admittedConfiguration.configuration.bases[0].baseCurrencyAddress;
  const read = await runCommand(parseArguments([
    "read", "--base", base, "--month", "2026-08", "--resolution", "1m",
    "--store", "directory", "--root", store.root,
  ]), admittedConfiguration, { environment: {}, store });
  assert.deepEqual(read, { status: "unpublished" });
});

test("the qualified workflow schedules only shared collect every fifteen minutes", async () => {
  const source = await readFile(new URL("../.github/workflows/usdg-market-data.yml", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]), ["8,23,38,53 * * * *"]);
  assert.doesNotMatch(source, /INDEX_RPC_URL/);
  assert.match(source, /INDEX_RPC_FALLBACK_URL_0: \$\{\{ secrets\.INDEX_RPC_FALLBACK_URL_0 \}\}/);
  assert.match(source, /node cli\.mjs collect --store github/);
  assert.match(source, /node cli\.mjs repair/);
  assert.doesNotMatch(source, /--pair|--group|--schedule|targetKind|targetId/);
  assert.match(source, /github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'/);
  assert.match(source, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(source, /"\$\{EVENT_NAME\}" == "schedule" \|\| "\$\{MANUAL_OPERATION\}" == "collect"/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /queue: max/);
});
