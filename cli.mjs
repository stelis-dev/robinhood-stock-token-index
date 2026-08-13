#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  collectIndex,
  repairIndex,
  retainIndex,
  verifyIndex,
} from "./collector/process.mjs";
import { loadRegistry } from "./collector/registry.mjs";
import { RpcClient } from "./collector/rpc-client.mjs";
import { createStore } from "./storage/create-store.mjs";

const operations = new Set(["collect", "repair", "retention", "verify"]);
const flags = new Set(["--repository", "--root", "--store"]);

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
    const rpc = new RpcClient({
      url: registry.chain.defaultRpcUrl,
      requestDelayMilliseconds: registry.collection.requestDelayMilliseconds,
      requestTimeoutMilliseconds: registry.collection.requestTimeoutMilliseconds,
      maximumResponseBytes: registry.collection.maximumResponseBytes,
      signal,
    });
    results.push(options.operation === "collect"
      ? await collectIndex({ registry, group, store, rpc, signal })
      : await repairIndex({ registry, group, store, rpc, signal }));
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
