#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { main as runPairCli } from "./cli.mjs";
import { loadPairRegistry } from "./collector/pair-registry.mjs";
import { loadCollectionGroupRegistry } from "./scheduler/collection-group-registry.mjs";
import { runCollectionGroup } from "./scheduler/run-collection-group.mjs";

const operations = new Set(["collect", "repair"]);
const flags = new Set(["--group", "--repository", "--root", "--store"]);

export function parseGroupArguments(argv) {
  const [operation, ...rest] = argv;
  if (!operations.has(operation)) throw new Error("Group operation must be collect or repair.");
  if (rest.length % 2 !== 0) throw new Error("Every command option requires one value.");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flags.has(flag) || typeof value !== "string" || value.length === 0 || flag in values) {
      throw new Error("Group command option is invalid.");
    }
    values[flag] = value;
  }
  const store = values["--store"];
  if (store !== "directory" && store !== "github") throw new Error("--store must be directory or github.");
  if (!values["--group"]) throw new Error("Every group operation requires --group.");
  if (store === "directory" && !values["--root"]) throw new Error("Directory storage requires --root.");
  if (store === "github" && !values["--repository"]) throw new Error("GitHub storage requires --repository.");
  if (store === "directory" && values["--repository"] || store === "github" && values["--root"]) {
    throw new Error("Storage options cannot cross adapter boundaries.");
  }
  return {
    operation,
    groupId: values["--group"],
    store,
    root: values["--root"],
    repository: values["--repository"],
  };
}

function pairArguments(options, pairId) {
  const storage = options.store === "directory"
    ? ["--store", "directory", "--root", options.root]
    : ["--store", "github", "--repository", options.repository];
  return [options.operation, "--pair", pairId, ...storage];
}

export async function main(argv, {
  environment = process.env,
  signal,
  pairMain = runPairCli,
} = {}) {
  const options = parseGroupArguments(argv);
  const pairRegistry = await loadPairRegistry();
  const groupRegistry = await loadCollectionGroupRegistry(pairRegistry);
  const result = await runCollectionGroup({
    pairRegistry,
    groupRegistry,
    groupId: options.groupId,
    signal,
    runPair: (pairId) => pairMain(pairArguments(options, pairId), { environment, signal }),
  });
  return {
    ok: result.status === "success",
    operation: options.operation,
    groupId: options.groupId,
    result,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Operation cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  main(process.argv.slice(2), { signal: controller.signal }).then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (!summary.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
