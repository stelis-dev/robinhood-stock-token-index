#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { isCanonicalAddress, isCanonicalBytes32 } from "./collector/hex-data.mjs";
import { maximumMarketDataAssetBytes } from "./collector/market-data-assets.mjs";
import { loadMarketDataConfiguration } from "./collector/market-data-configuration.mjs";
import {
  runMarketDataCollectOperation,
  runMarketDataRepairOperation,
} from "./collector/market-data-operation.mjs";
import { createMarketDataReader } from "./collector/market-data-reader.mjs";
import { verifyMarketDataRecording } from "./collector/market-data-verifier.mjs";
import { RpcClient } from "./collector/rpc-client.mjs";
import {
  marketDataRpcLimits,
  maximumRpcEndpointCount,
  validateRpcUrl,
} from "./collector/rpc-endpoint.mjs";
import { createStore } from "./storage/create-store.mjs";

const operations = new Set(["collect", "read", "repair", "verify"]);
const flags = new Set([
  "--base", "--from-block", "--from-timestamp", "--month", "--pool-id",
  "--repository", "--resolution", "--root", "--store", "--until-block", "--until-timestamp",
]);
const rpcEnvironmentNames = Object.freeze([
  "INDEX_RPC_URL",
  "INDEX_RPC_FALLBACK_URL_0",
  "INDEX_RPC_FALLBACK_URL_1",
]);
if (rpcEnvironmentNames.length !== maximumRpcEndpointCount) throw new Error("RPC endpoint inputs are inconsistent.");

export function rpcEndpointSourceName(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= rpcEnvironmentNames.length) {
    throw new Error("RPC endpoint selection is invalid.");
  }
  return rpcEnvironmentNames[index];
}

export function selectRpcUrls(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) throw new Error("RPC environment is invalid.");
  const allowed = new Set(rpcEnvironmentNames);
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith("INDEX_RPC_") && value !== undefined && value !== "" && !allowed.has(name)) {
      throw new Error("RPC environment contains an unsupported setting.");
    }
  }
  const values = [];
  let missing = false;
  for (const name of rpcEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value === "") {
      if (name === "INDEX_RPC_URL") throw new Error("INDEX_RPC_URL is required.");
      missing = true;
      continue;
    }
    if (missing) throw new Error("RPC fallback endpoint positions must be contiguous.");
    values.push(validateRpcUrl(value, name));
  }
  if (new Set(values).size !== values.length) throw new Error("RPC endpoint URLs must be unique.");
  return Object.freeze(values);
}

function optionValues(rest) {
  if (rest.length % 2 !== 0) throw new Error("Every command option requires one value.");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flags.has(flag) || typeof value !== "string" || value.length === 0 || Object.hasOwn(values, flag)) {
      throw new Error(`Invalid command option: ${flag}`);
    }
    values[flag] = value;
  }
  return values;
}

function selectedOptions(values, names) {
  return names.filter((name) => values[name] !== undefined);
}

export function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (!operations.has(operation)) throw new Error("Operation must be collect, read, repair, or verify.");
  const values = optionValues(rest);
  const store = values["--store"];
  if (store !== "directory" && store !== "github") throw new Error("--store must be directory or github.");
  if (store === "directory" && values["--root"] === undefined) throw new Error("Directory storage requires --root.");
  if (store === "github" && values["--repository"] === undefined) throw new Error("GitHub storage requires --repository.");
  if (store === "directory" && values["--repository"] !== undefined || store === "github" && values["--root"] !== undefined) {
    throw new Error("Storage options cannot cross adapter boundaries.");
  }
  const readNames = ["--base", "--month", "--resolution"];
  const repairNames = ["--base", "--from-block", "--from-timestamp", "--pool-id", "--until-block", "--until-timestamp"];
  const dataNames = [...new Set([...readNames, ...repairNames])];
  if (operation === "read" && selectedOptions(values, readNames).length !== readNames.length) {
    throw new Error("Read requires --base, --month, and --resolution.");
  }
  if (operation === "repair" && selectedOptions(values, repairNames).length !== repairNames.length) {
    throw new Error("Repair requires one exact base currency, PoolId, block range, and time range.");
  }
  const allowedDataNames = operation === "read" ? new Set(readNames) : operation === "repair" ? new Set(repairNames) : new Set();
  if (dataNames.some((name) => values[name] !== undefined && !allowedDataNames.has(name))) {
    throw new Error("Operation contains an unrelated market-data selection.");
  }
  return Object.freeze({
    baseCurrencyAddress: values["--base"],
    fromBlock: values["--from-block"],
    fromTimestamp: values["--from-timestamp"],
    month: values["--month"],
    operation,
    poolId: values["--pool-id"],
    repository: values["--repository"],
    resolution: values["--resolution"],
    root: values["--root"],
    store,
    untilBlock: values["--until-block"],
    untilTimestamp: values["--until-timestamp"],
  });
}

function createRpcClients(environment, signal) {
  return selectRpcUrls(environment).map((url) => new RpcClient({ ...marketDataRpcLimits, signal, url }));
}

function createCommandStore(options, environment, signal) {
  const mutates = options.operation === "collect" || options.operation === "repair";
  if (options.store === "github" && mutates && (typeof environment.GITHUB_TOKEN !== "string" || environment.GITHUB_TOKEN.length === 0)) {
    throw new Error("GITHUB_TOKEN is required for GitHub storage mutation.");
  }
  return createStore({
    kind: options.store,
    maximumArtifactBytes: maximumMarketDataAssetBytes,
    minimumMutationIntervalMilliseconds: mutates ? 1_500 : 0,
    repository: options.repository,
    root: options.root,
    signal,
    token: mutates ? environment.GITHUB_TOKEN : undefined,
  });
}

function endpointFailureLine(failure, environment) {
  if (environment.GITHUB_ACTIONS !== "true") return null;
  if (failure === null || typeof failure !== "object" || !Number.isSafeInteger(failure.endpointIndex) || typeof failure.reason !== "string") {
    throw new Error("RPC endpoint failure is invalid.");
  }
  const method = failure.rpcMethod === null ? "" : ` rpc_method=${failure.rpcMethod}`;
  const http = failure.httpStatus === null ? "" : ` http_status=${failure.httpStatus}`;
  const code = failure.rpcCode === null ? "" : ` rpc_code=${failure.rpcCode}`;
  return `market_data_rpc status=unavailable endpoint_source=${rpcEndpointSourceName(failure.endpointIndex)} reason=${failure.reason}${method}${http}${code}\n`;
}

function repairInput(options) {
  if (!isCanonicalAddress(options.baseCurrencyAddress) || !isCanonicalBytes32(options.poolId)) {
    throw new Error("Repair base currency or PoolId is invalid.");
  }
  return Object.freeze({
    baseCurrencyAddress: options.baseCurrencyAddress,
    fromBlock: options.fromBlock,
    fromTimestamp: options.fromTimestamp,
    poolId: options.poolId,
    untilBlock: options.untilBlock,
    untilTimestamp: options.untilTimestamp,
  });
}

export async function runCommand(options, admittedConfiguration, {
  environment,
  signal,
  store = createCommandStore(options, environment, signal),
  writeLog = (line) => process.stderr.write(line),
} = {}) {
  const onEndpointFailure = (failure) => {
    const line = endpointFailureLine(failure, environment);
    if (line !== null) writeLog(line);
  };
  if (options.operation === "verify") return verifyMarketDataRecording({ admittedConfiguration, store });
  if (options.operation === "read") {
    if (!admittedConfiguration.configuration.bases.some((base) => base.baseCurrencyAddress === options.baseCurrencyAddress)) {
      throw new Error("Read base currency is absent from configuration.");
    }
    return createMarketDataReader({
      configuration: admittedConfiguration.configuration,
      maximumBytes: maximumMarketDataAssetBytes,
      store,
    }).readResolution({
      baseCurrencyAddress: options.baseCurrencyAddress,
      month: options.month,
      resolution: options.resolution,
    });
  }
  const rpcClients = createRpcClients(environment, signal);
  if (options.operation === "collect") {
    return runMarketDataCollectOperation({ admittedConfiguration, onEndpointFailure, rpcClients, signal, store });
  }
  return runMarketDataRepairOperation({
    admittedConfiguration,
    onEndpointFailure,
    repair: repairInput(options),
    rpcClients,
    signal,
    store,
  });
}

export async function main(argv, {
  environment = process.env,
  signal,
  writeLog = (line) => process.stderr.write(line),
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const options = parseArguments(argv);
  const admittedConfiguration = await loadMarketDataConfiguration();
  const result = await runCommand(options, admittedConfiguration, { environment, signal, writeLog });
  const envelope = Object.freeze({ ok: true, operation: options.operation, result });
  writeOutput(`${JSON.stringify(envelope)}\n`);
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Operation cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  main(process.argv.slice(2), { signal: controller.signal }).then(() => {}).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
