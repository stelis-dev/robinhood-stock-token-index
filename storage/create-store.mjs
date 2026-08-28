import { DirectoryStore } from "./directory-store.mjs";
import { GitHubReleaseStore } from "./github-release-store.mjs";

export function createStore({ kind, root, repository, token, maximumArtifactBytes, minimumMutationIntervalMilliseconds, signal, fetchImplementation }) {
  if (kind === "directory") {
    if (typeof root !== "string" || root.length === 0) throw new Error("Directory storage requires --root.");
    return new DirectoryStore({ root, maximumArtifactBytes, signal });
  }
  if (kind === "github") {
    return new GitHubReleaseStore({
      repository,
      token,
      maximumArtifactBytes,
      minimumMutationIntervalMilliseconds,
      signal,
      fetchImplementation,
    });
  }
  throw new Error(`Unknown storage adapter: ${kind}`);
}
