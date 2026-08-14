#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  retainIndex,
  verifyIndex,
} from "./collector/process.mjs";
import { loadRegistry } from "./collector/registry.mjs";
import { runRpcIndexOperation } from "./collector/rpc-operation.mjs";
import { RpcClient } from "./collector/rpc-client.mjs";
import { admitRpcUrl, maximumRpcEndpointCount } from "./collector/rpc-endpoint.mjs";
import { createStore } from "./storage/create-store.mjs";

const operations = new Set(["collect", "repair", "retention", "verify"]);
const flags = new Set(["--repository", "--root", "--store"]);
const fallbackEnvironmentNames = Object.freeze([
  "INDEX_RPC_FALLBACK_URL_0",
  "INDEX_RPC_FALLBACK_URL_1",
]);
const rpcEndpointSourceNames = Object.freeze([
  "registry.chain.primaryRpcUrl",
  ...fallbackEnvironmentNames,
]);
if (fallbackEnvironmentNames.length + 1 !== maximumRpcEndpointCount) throw new Error("RPC endpoint configuration is inconsistent.");

export function rpcEndpointSourceName(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= rpcEndpointSourceNames.length) {
    throw new Error("RPC endpoint selection is invalid.");
  }
  return rpcEndpointSourceNames[index];
}

export function rpcEndpointSelectionLog(index, environment) {
  if (environment?.GITHUB_ACTIONS !== "true") return null;
  return `rpc_endpoint_source=${rpcEndpointSourceName(index)}\n`;
}

export function selectRpcUrls(registry, environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) throw new Error("RPC environment is invalid.");
  const admittedNames = new Set(fallbackEnvironmentNames);
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith("INDEX_RPC_") && value !== undefined && value !== "" && !admittedNames.has(name)) {
      throw new Error("RPC environment contains an unsupported setting.");
    }
  }
  const primary = admitRpcUrl(registry?.chain?.primaryRpcUrl, "Registry primary RPC URL");
  const fallbackValues = [];
  let missingFallback = false;
  for (const name of fallbackEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value === "") {
      missingFallback = true;
      continue;
    }
    if (missingFallback) throw new Error("RPC fallback endpoint positions must be contiguous.");
    fallbackValues.push(admitRpcUrl(value, name));
  }
  const urls = [primary, ...fallbackValues];
  if (new Set(urls).size !== urls.length) throw new Error("RPC endpoint URLs must be unique.");
  return urls;
}

export function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (!operations.has(operation)) throw new Error("Operation must be collect, repair, retention, or verify.");
  if (rest.length % 2 !== 0) throw new Error("Every command option requires one value.");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flags.has(flag) || typeof value !== "string" || value.length === 0 || flag in values) throw new Error(`Invalid command option: ${flag}`);
    values[flag] = value;
  }
  const store = values["--store"];
  if (store !== "directory" && store !== "github") throw new Error("--store must be directory or github.");
  if (store === "directory" && !values["--root"]) throw new Error("Directory storage requires --root.");
  if (store === "github" && !values["--repository"]) throw new Error("GitHub storage requires --repository.");
  if (store === "directory" && values["--repository"] || store === "github" && values["--root"]) throw new Error("Storage options cannot cross adapter boundaries.");
  return {
    operation,
    store,
    root: values["--root"],
    repository: values["--repository"],
  };
}

export async function main(argv, { environment = process.env, signal } = {}) {
  const options = parseArguments(argv);
  const registry = await loadRegistry();
  const rpcClients = options.operation === "collect" || options.operation === "repair"
    ? selectRpcUrls(registry, environment).map((url) => (
      new RpcClient({
        url,
        requestDelayMilliseconds: registry.collection.requestDelayMilliseconds,
        requestTimeoutMilliseconds: registry.collection.requestTimeoutMilliseconds,
        maximumResponseBytes: registry.collection.maximumResponseBytes,
        maximumRpcAttempts: registry.collection.maximumRpcAttempts,
        maximumRpcRetryDelayMilliseconds: registry.collection.maximumRpcRetryDelayMilliseconds,
        signal,
      })
    ))
    : null;
  const results = [];
  for (const group of registry.groups) {
    signal?.throwIfAborted();
    const store = createStore({
      kind: options.store,
      root: options.root,
      repository: options.repository,
      token: environment.GITHUB_TOKEN,
      registry,
      group,
      signal,
    });
    if (options.operation === "verify") {
      results.push(await verifyIndex({ registry, group, store }));
      continue;
    }
    if (options.operation === "retention") {
      results.push(await retainIndex({ registry, group, store }));
      continue;
    }
    const completed = await runRpcIndexOperation({
      operation: options.operation,
      registry,
      group,
      store,
      rpcClients,
      signal,
    });
    const selectionLog = rpcEndpointSelectionLog(completed.selectedEndpointIndex, environment);
    if (selectionLog !== null) process.stderr.write(selectionLog);
    results.push(completed.result);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, operation: options.operation, results })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Operation cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
