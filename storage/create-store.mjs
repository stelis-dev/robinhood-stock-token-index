import { DirectoryStore } from "./directory-store.mjs";
import { GitHubReleaseStore } from "./github-release-store.mjs";

export function createStore({ kind, root, repository, token, maximumArtifactBytes, signal, fetchImplementation, writeOperationalLog }) {
  if (kind === "directory") {
    if (typeof root !== "string" || root.length === 0) throw new Error("Directory storage requires --root.");
    return new DirectoryStore({ root, maximumArtifactBytes });
  }
  if (kind === "github") {
    return new GitHubReleaseStore({ repository, token, maximumArtifactBytes, signal, fetchImplementation, writeOperationalLog });
  }
  throw new Error(`Unknown storage adapter: ${kind}`);
}
