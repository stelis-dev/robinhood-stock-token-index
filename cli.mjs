#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readPairPeriod, verifyPairIndex } from "./collector/pair-reader.mjs";
import { loadPairRegistry, pairById } from "./collector/pair-registry.mjs";
import { runRpcPairOperation } from "./collector/rpc-operation.mjs";
import { RpcClient } from "./collector/rpc-client.mjs";
import { admitRpcUrl, maximumRpcEndpointCount } from "./collector/rpc-endpoint.mjs";
import { createStore } from "./storage/create-store.mjs";

const operations = new Set(["collect", "read", "repair", "verify"]);
const flags = new Set(["--from", "--pair", "--repository", "--root", "--store", "--until"]);
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

export function rpcEndpointSelectionLog(role, index, environment) {
  if (environment?.GITHUB_ACTIONS !== "true") return null;
  if (role !== "current" && role !== "history" && role !== "repair") throw new Error("RPC operation role is invalid.");
  return `rpc_attempt=${role} rpc_endpoint_source=${rpcEndpointSourceName(index)}\n`;
}

export function pairOperationFailureLog(role, pairId, environment) {
  if (environment?.GITHUB_ACTIONS !== "true") return null;
  if (role !== "current" && role !== "history" && role !== "repair") throw new Error("Pair operation role is invalid.");
  if (typeof pairId !== "string" || !/^0x[0-9a-f]{64}$/.test(pairId)) throw new Error("Pair operation identity is invalid.");
  return `pair_operation=${role} status=failed pair_id=${pairId}\n`;
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
  if (!operations.has(operation)) throw new Error("Operation must be collect, read, repair, or verify.");
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
  if (!values["--pair"]) throw new Error("Every operation requires --pair.");
  if (store === "directory" && !values["--root"]) throw new Error("Directory storage requires --root.");
  if (store === "github" && !values["--repository"]) throw new Error("GitHub storage requires --repository.");
  if (store === "directory" && values["--repository"] || store === "github" && values["--root"]) throw new Error("Storage options cannot cross adapter boundaries.");
  const hasPeriod = values["--from"] !== undefined || values["--until"] !== undefined;
  if (operation === "read" && (!values["--from"] || !values["--until"])) throw new Error("Read requires --from and --until.");
  if (operation !== "read" && hasPeriod) throw new Error("Only read accepts --from and --until.");
  return {
    operation,
    pairId: values["--pair"],
    store,
    root: values["--root"],
    repository: values["--repository"],
    from: values["--from"],
    until: values["--until"],
  };
}

function rpcClients(registry, environment, signal) {
  return selectRpcUrls(registry, environment).map((url) => new RpcClient({
    url,
    requestDelayMilliseconds: registry.collection.requestDelayMilliseconds,
    requestTimeoutMilliseconds: registry.collection.requestTimeoutMilliseconds,
    maximumResponseBytes: registry.collection.maximumResponseBytes,
    maximumRpcAttempts: registry.collection.maximumRpcAttempts,
    maximumRpcRetryDelayMilliseconds: registry.collection.maximumRpcRetryDelayMilliseconds,
    signal,
  }));
}

function writeSelection(role, completed, environment) {
  const line = rpcEndpointSelectionLog(role, completed.selectedEndpointIndex, environment);
  if (line !== null) process.stderr.write(line);
}

function writeOperationFailure(role, pairId, environment) {
  const line = pairOperationFailureLog(role, pairId, environment);
  if (line !== null) process.stderr.write(line);
}

async function runPairOperation({ role, registry, pairId, store, clients, signal, environment }) {
  try {
    const completed = await runRpcPairOperation({
      operation: role,
      registry,
      pairId,
      store,
      rpcClients: clients,
      signal,
    });
    writeSelection(role, completed, environment);
    return completed.result;
  } catch (error) {
    writeOperationFailure(role, pairId, environment);
    throw error;
  }
}

export async function main(argv, { environment = process.env, signal } = {}) {
  const options = parseArguments(argv);
  const registry = await loadPairRegistry();
  pairById(registry, options.pairId);
  const mutatesGitHub = options.store === "github" && (options.operation === "collect" || options.operation === "repair");
  if (mutatesGitHub && (typeof environment.GITHUB_TOKEN !== "string" || environment.GITHUB_TOKEN.length === 0)) {
    throw new Error("GitHub token is required for storage mutation.");
  }
  const store = createStore({
    kind: options.store,
    root: options.root,
    repository: options.repository,
    token: environment.GITHUB_TOKEN,
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
    signal,
    writeOperationalLog: environment.GITHUB_ACTIONS === "true"
      ? (line) => process.stderr.write(line)
      : undefined,
  });
  let result;
  if (options.operation === "verify") {
    result = await verifyPairIndex({ registry, pairId: options.pairId, store });
  } else if (options.operation === "read") {
    result = await readPairPeriod({
      registry,
      store,
      input: { pairId: options.pairId, from: options.from, until: options.until },
    });
  } else {
    const clients = rpcClients(registry, environment, signal);
    if (options.operation === "repair") {
      result = await runPairOperation({
        role: "repair", registry, pairId: options.pairId, store, clients, signal, environment,
      });
    } else {
      const current = await runPairOperation({
        role: "current", registry, pairId: options.pairId, store, clients, signal, environment,
      });
      const history = await runPairOperation({
        role: "history", registry, pairId: options.pairId, store, clients, signal, environment,
      });
      result = { current, history };
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, operation: options.operation, pairId: options.pairId, result })}\n`);
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
