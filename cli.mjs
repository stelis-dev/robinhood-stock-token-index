#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { isCanonicalBytes32 } from "./collector/hex-data.mjs";
import { readPairPeriod, verifyPairIndex } from "./collector/pair-reader.mjs";
import { loadPairRegistry, pairById } from "./collector/pair-registry.mjs";
import {
  createFinalizedBoundary,
  rpcOperationFailureFields,
  runRpcPairOperation,
} from "./collector/rpc-operation.mjs";
import { RpcClient } from "./collector/rpc-client.mjs";
import { validateRpcUrl, maximumRpcEndpointCount } from "./collector/rpc-endpoint.mjs";
import {
  collectionGroupBySchedule,
  loadCollectionPlan,
} from "./scheduler/collection-plan.mjs";
import { runCollectionGroup } from "./scheduler/run-collection-group.mjs";
import { createStore } from "./storage/create-store.mjs";
import { githubStorageFailureFields } from "./storage/github-release-store.mjs";
import { storedDataFailureFields } from "./storage/stored-files.mjs";

const operations = new Set(["collect", "read", "repair", "verify"]);
const flags = new Set(["--from", "--group", "--pair", "--repository", "--root", "--schedule", "--store", "--until"]);
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

export function pairOperationSuccessLog(phase, pairId, index, environment) {
  if (environment?.GITHUB_ACTIONS !== "true") return null;
  if (phase !== "current" && phase !== "history" && phase !== "repair") throw new Error("RPC operation phase is invalid.");
  if (!isCanonicalBytes32(pairId)) throw new Error("Pair operation identity is invalid.");
  return `pair_operation=${phase} status=success rpc_endpoint_source=${rpcEndpointSourceName(index)} pair_id=${pairId}\n`;
}

export function pairOperationFailureLog(phase, pairId, environment, error) {
  if (environment?.GITHUB_ACTIONS !== "true") return null;
  if (phase !== "current" && phase !== "history" && phase !== "repair") throw new Error("Pair operation phase is invalid.");
  if (!isCanonicalBytes32(pairId)) throw new Error("Pair operation identity is invalid.");
  const failure = githubStorageFailureFields(error)
    ?? rpcOperationFailureFields(error)
    ?? storedDataFailureFields(error);
  const fields = failure === null ? "component=collector reason=operation_rejected" : failure;
  return `pair_operation=${phase} status=failed ${fields} pair_id=${pairId}\n`;
}

export function publicationRecoveryLog(recovery, environment) {
  if (environment?.GITHUB_ACTIONS !== "true" || recovery?.status === "idle") return null;
  if (recovery === null || typeof recovery !== "object" || (recovery.status !== "aborted" && recovery.status !== "committed")) {
    throw new Error("Publication recovery result is invalid.");
  }
  if (!isCanonicalBytes32(recovery.pairId)) {
    throw new Error("Publication recovery pair identity is invalid.");
  }
  if (recovery.phase !== null && recovery.phase !== "current" && recovery.phase !== "history" && recovery.phase !== "repair") {
    throw new Error("Publication recovery phase is invalid.");
  }
  if (recovery.selectedSequence !== null && (!Number.isSafeInteger(recovery.selectedSequence) || recovery.selectedSequence <= 0)) {
    throw new Error("Publication recovery sequence is invalid.");
  }
  const outcome = recovery.status === "committed" ? "next_state_selected" : "previous_state_retained";
  const phase = recovery.phase === null ? "none" : recovery.phase;
  const sequence = recovery.selectedSequence === null ? "none" : recovery.selectedSequence;
  return `publication_recovery outcome=${outcome} phase=${phase} selected_sequence=${sequence} pair_id=${recovery.pairId}\n`;
}

export function selectRpcUrls(registry, environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) throw new Error("RPC environment is invalid.");
  const allowedNames = new Set(fallbackEnvironmentNames);
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith("INDEX_RPC_") && value !== undefined && value !== "" && !allowedNames.has(name)) {
      throw new Error("RPC environment contains an unsupported setting.");
    }
  }
  const primary = validateRpcUrl(registry?.chain?.primaryRpcUrl, "Registry primary RPC URL");
  const fallbackValues = [];
  let missingFallback = false;
  for (const name of fallbackEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value === "") {
      missingFallback = true;
      continue;
    }
    if (missingFallback) throw new Error("RPC fallback endpoint positions must be contiguous.");
    fallbackValues.push(validateRpcUrl(value, name));
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
  const targets = [
    ["pair", values["--pair"]],
    ["group", values["--group"]],
    ["schedule", values["--schedule"]],
  ].filter(([, value]) => value !== undefined);
  if (targets.length !== 1) throw new Error("Every operation requires exactly one --pair, --group, or --schedule target.");
  const [targetKind, targetId] = targets[0];
  if ((operation === "read" || operation === "verify") && targetKind !== "pair") {
    throw new Error("Read and verify require a pair target.");
  }
  if (targetKind === "group" && operation !== "collect" && operation !== "repair") {
    throw new Error("A group target accepts collect or repair.");
  }
  if (targetKind === "schedule" && operation !== "collect") {
    throw new Error("A schedule target accepts collect only.");
  }
  if (store === "directory" && !values["--root"]) throw new Error("Directory storage requires --root.");
  if (store === "github" && !values["--repository"]) throw new Error("GitHub storage requires --repository.");
  if (store === "directory" && values["--repository"] || store === "github" && values["--root"]) throw new Error("Storage options cannot cross adapter boundaries.");
  const hasPeriod = values["--from"] !== undefined || values["--until"] !== undefined;
  if (operation === "read" && (!values["--from"] || !values["--until"])) throw new Error("Read requires --from and --until.");
  if (operation !== "read" && hasPeriod) throw new Error("Only read accepts --from and --until.");
  return {
    operation,
    target: { kind: targetKind, id: targetId },
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

function writeOperationSuccess(phase, pairId, completed, environment, writeLog) {
  const line = pairOperationSuccessLog(phase, pairId, completed.selectedEndpointIndex, environment);
  if (line !== null) writeLog(line);
}

function writeOperationFailure(phase, pairId, environment, error, writeLog) {
  const line = pairOperationFailureLog(phase, pairId, environment, error);
  if (line !== null) writeLog(line);
}

function writeRecovery(recovery, environment, writeLog) {
  const line = publicationRecoveryLog(recovery, environment);
  if (line !== null) writeLog(line);
}

async function runPairOperation({
  phase,
  registry,
  pairId,
  store,
  clients,
  finalizedBoundary,
  signal,
  environment,
  writeLog,
}) {
  try {
    const completed = await runRpcPairOperation({
      operation: phase,
      registry,
      pairId,
      store,
      rpcClients: clients,
      finalizedBoundary,
      onRecovery: (recovery) => writeRecovery(recovery, environment, writeLog),
      signal,
    });
    writeOperationSuccess(phase, pairId, completed, environment, writeLog);
    return completed;
  } catch (error) {
    writeOperationFailure(phase, pairId, environment, error, writeLog);
    throw error;
  }
}

function pairOptions(options, pairId) {
  return { ...options, target: { kind: "pair", id: pairId } };
}

function createOperationContext(options, registry, { environment, signal, writeLog }) {
  const mutates = options.operation === "collect" || options.operation === "repair";
  if (options.store === "github" && mutates && (typeof environment.GITHUB_TOKEN !== "string" || environment.GITHUB_TOKEN.length === 0)) {
    throw new Error("GitHub token is required for storage mutation.");
  }
  return Object.freeze({
    environment,
    signal,
    writeLog,
    store: createStore({
      kind: options.store,
      root: options.root,
      repository: options.repository,
      token: environment.GITHUB_TOKEN,
      maximumArtifactBytes: registry.collection.maximumArtifactBytes,
      signal,
    }),
    clients: mutates ? Object.freeze(rpcClients(registry, environment, signal)) : null,
  });
}

export async function runPairCommand(options, registry, context) {
  const pairId = options.target.id;
  pairById(registry, pairId);
  const { clients, environment, signal, store } = context;
  const writeLog = context.writeLog ?? ((line) => process.stderr.write(line));
  let result;
  if (options.operation === "verify") {
    result = await verifyPairIndex({ registry, pairId, store });
  } else if (options.operation === "read") {
    result = await readPairPeriod({
      registry,
      store,
      input: { pairId, from: options.from, until: options.until },
    });
  } else {
    if (clients === null) throw new Error("RPC operation context is unavailable.");
    const finalizedBoundary = createFinalizedBoundary();
    if (options.operation === "repair") {
      const completed = await runPairOperation({
        phase: "repair", registry, pairId, store, clients, finalizedBoundary, signal, environment, writeLog,
      });
      result = [completed.result];
    } else {
      const first = await runPairOperation({
        phase: "current", registry, pairId, store, clients, finalizedBoundary, signal, environment, writeLog,
      });
      const secondPhase = first.reachedFinalizedBoundary ? "history" : "current";
      const second = await runPairOperation({
        phase: secondPhase, registry, pairId, store, clients, finalizedBoundary, signal, environment, writeLog,
      });
      result = [first.result, second.result];
    }
  }
  return { ok: true, operation: options.operation, pairId, result };
}

export async function main(argv, {
  environment = process.env,
  signal,
  createContext = createOperationContext,
  pairOperation = runPairCommand,
  writeLog = (line) => process.stderr.write(line),
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const options = parseArguments(argv);
  const registry = await loadPairRegistry();
  const context = createContext(options, registry, { environment, signal, writeLog });
  let envelope;
  if (options.target.kind === "pair") {
    envelope = await pairOperation(options, registry, context);
  } else {
    const collectionPlan = await loadCollectionPlan(registry);
    const groupId = options.target.kind === "group"
      ? options.target.id
      : collectionGroupBySchedule(collectionPlan, options.target.id).groupId;
    const result = await runCollectionGroup({
      pairRegistry: registry,
      collectionPlan,
      groupId,
      signal,
      runPair: (pairId) => pairOperation(pairOptions(options, pairId), registry, context),
    });
    envelope = {
      ok: result.status === "success",
      operation: options.operation,
      groupId,
      result,
    };
  }
  writeOutput(`${JSON.stringify(envelope)}\n`);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Operation cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  main(process.argv.slice(2), { signal: controller.signal }).then((envelope) => {
    if (!envelope.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
