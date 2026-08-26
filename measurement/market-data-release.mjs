import { createCipheriv, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^[0-9a-f]{40}$/;
const runIdPattern = /^[1-9][0-9]*-[1-9][0-9]*$/;
const scaleFacts = Object.freeze({
  "launch-9": Object.freeze({
    dataBytes: 19_375_362,
  }),
  "stress-200": Object.freeze({
    dataBytes: 430_563_600,
  }),
});

class MeasurementError extends Error {
  constructor(reason, httpStatus = null) {
    super(reason);
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roundedMilliseconds = (value) => Math.round(value * 1_000) / 1_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseArguments = () => {
  const operation = process.argv[2];
  const expected = operation === "measure"
    ? ["--repository", "--commit", "--run-id", "--scale", "--output"]
    : operation === "cleanup"
      ? ["--repository", "--run-id"]
      : null;
  if (expected === null || process.argv.length !== 3 + expected.length * 2) {
    throw new MeasurementError("invalid_arguments");
  }
  const values = {};
  for (let index = 0; index < expected.length; index += 1) {
    if (process.argv[3 + index * 2] !== expected[index]) throw new MeasurementError("invalid_arguments");
    values[expected[index].slice(2)] = process.argv[4 + index * 2];
  }
  if (!repositoryPattern.test(values.repository)) throw new MeasurementError("invalid_repository");
  if (!runIdPattern.test(values["run-id"])) throw new MeasurementError("invalid_run_id");
  if (operation === "measure") {
    if (!commitPattern.test(values.commit)) throw new MeasurementError("invalid_commit");
    if (scaleFacts[values.scale] === undefined) throw new MeasurementError("invalid_scale");
    if (typeof values.output !== "string" || values.output.length === 0) {
      throw new MeasurementError("invalid_output");
    }
  }
  return {
    commit: values.commit,
    operation,
    output: values.output,
    repository: values.repository,
    runId: values["run-id"],
    scale: values.scale,
  };
};

const readJson = async (response, maximumBytes = 2_097_152) => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new MeasurementError("response_too_large", response.status);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new MeasurementError("response_too_large", response.status);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new MeasurementError("invalid_json_response", response.status);
  }
};

const apiRequest = async (repository, token, path, {
  body,
  method = "GET",
  expectedStatuses = [200],
} = {}) => {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "robinhood-stock-token-index-release-measurement",
      "x-github-api-version": "2026-03-10",
    },
    method,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!expectedStatuses.includes(response.status)) {
    throw new MeasurementError("github_api_status", response.status);
  }
  return response;
};

const generateFile = async (path, size, seed) => {
  const key = createHash("sha256").update(`key:${seed}`).digest();
  const iv = createHash("sha256").update(`iv:${seed}`).digest().subarray(0, 16);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const digest = createHash("sha256");
  const handle = await open(path, "wx");
  const zeroes = Buffer.alloc(8 * 1024 * 1024);
  let written = 0;
  try {
    while (written < size) {
      const length = Math.min(zeroes.byteLength, size - written);
      const bytes = cipher.update(zeroes.subarray(0, length));
      let chunkWritten = 0;
      while (chunkWritten < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          chunkWritten,
          bytes.byteLength - chunkWritten,
          written + chunkWritten,
        );
        if (result.bytesWritten <= 0) throw new MeasurementError("file_generation_failed");
        chunkWritten += result.bytesWritten;
      }
      digest.update(bytes);
      written += bytes.byteLength;
    }
    const final = cipher.final();
    if (final.byteLength !== 0 || written !== size) throw new MeasurementError("file_generation_failed");
  } finally {
    await handle.close();
  }
  return { path, sha256: digest.digest("hex"), size };
};

const localRange = async (file, from, until) => {
  const length = until - from;
  const bytes = Buffer.alloc(length);
  const handle = await open(file.path, "r");
  try {
    let readBytes = 0;
    while (readBytes < length) {
      const result = await handle.read(bytes, readBytes, length - readBytes, from + readBytes);
      if (result.bytesRead <= 0) throw new MeasurementError("local_range_short_read");
      readBytes += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return bytes;
};

const createRelease = async ({ repository, token, tag, commit }) => {
  const started = performance.now();
  const response = await apiRequest(repository, token, "/releases", {
    body: {
      body: "Temporary isolated market-data storage measurement. The workflow deletes this Release and tag.",
      draft: false,
      make_latest: "false",
      name: tag,
      prerelease: true,
      tag_name: tag,
      target_commitish: commit,
    },
    expectedStatuses: [201],
    method: "POST",
  });
  const value = await readJson(response);
  const uploadUrl = value.upload_url?.replace(/\{.*$/, "");
  if (
    !Number.isSafeInteger(value.id)
    || value.id <= 0
    || value.tag_name !== tag
    || uploadUrl !== `https://uploads.github.com/repos/${repository}/releases/${value.id}/assets`
  ) throw new MeasurementError("invalid_release_response");
  return {
    elapsedMilliseconds: roundedMilliseconds(performance.now() - started),
    id: value.id,
    uploadUrl,
  };
};

const resolveRelease = async ({ repository, token, tag }) => {
  const response = await apiRequest(repository, token, `/releases/tags/${encodeURIComponent(tag)}`, {
    expectedStatuses: [200, 404],
  });
  if (response.status === 404) return null;
  const value = await readJson(response);
  if (!Number.isSafeInteger(value.id) || value.id <= 0 || value.tag_name !== tag) {
    throw new MeasurementError("invalid_release_response");
  }
  return { id: value.id };
};

const uploadAsset = async ({ token, release, file, assetName, repository, tag }) => {
  const started = performance.now();
  const response = await fetch(`${release.uploadUrl}?name=${encodeURIComponent(assetName)}`, {
    body: createReadStream(file.path),
    duplex: "half",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-length": String(file.size),
      "content-type": "application/octet-stream",
      "user-agent": "robinhood-stock-token-index-release-measurement",
      "x-github-api-version": "2026-03-10",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(1_200_000),
  });
  if (response.status !== 201) throw new MeasurementError("upload_status", response.status);
  const value = await readJson(response);
  const expectedDownloadUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  if (
    !Number.isSafeInteger(value.id)
    || value.id <= 0
    || value.name !== assetName
    || value.state !== "uploaded"
    || value.size !== file.size
    || value.digest !== `sha256:${file.sha256}`
    || value.browser_download_url !== expectedDownloadUrl
  ) throw new MeasurementError("invalid_upload_response");
  return {
    browserDownloadUrl: value.browser_download_url,
    elapsedMilliseconds: roundedMilliseconds(performance.now() - started),
    id: value.id,
    name: assetName,
  };
};

const publicRequest = async (url, range = null) => {
  let current = new URL(url);
  let redirects = 0;
  while (true) {
    const headers = {
      accept: "application/octet-stream",
      "accept-encoding": "identity",
      "user-agent": "robinhood-stock-token-index-release-measurement",
    };
    if (range !== null) headers.range = range;
    const response = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(1_200_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { redirects, response };
    if (redirects >= 5) throw new MeasurementError("redirect_limit");
    const location = response.headers.get("location");
    if (location === null) throw new MeasurementError("missing_redirect");
    current = new URL(location, current);
    if (current.protocol !== "https:") throw new MeasurementError("invalid_redirect");
    await response.body?.cancel();
    redirects += 1;
  }
};

const hashResponse = async (response, maximumBytes) => {
  if (response.body === null) throw new MeasurementError("missing_download_body", response.status);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) !== maximumBytes)) {
    throw new MeasurementError("download_length", response.status);
  }
  if (response.headers.get("content-encoding") !== null) {
    throw new MeasurementError("download_encoding", response.status);
  }
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new MeasurementError("download_too_large", response.status);
    digest.update(chunk);
  }
  return { sha256: digest.digest("hex"), size };
};

const verifyPublicAsset = async (asset, file) => {
  const started = performance.now();
  let lastStatus = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const requested = await publicRequest(asset.browserDownloadUrl);
    lastStatus = requested.response.status;
    if (lastStatus === 200) {
      const identity = await hashResponse(requested.response, file.size);
      if (identity.size !== file.size || identity.sha256 !== file.sha256) {
        throw new MeasurementError("download_identity", lastStatus);
      }
      return {
        elapsedMilliseconds: roundedMilliseconds(performance.now() - started),
        redirects: requested.redirects,
      };
    }
    if (![404, 500, 502, 503, 504].includes(lastStatus) || attempt === 5) break;
    await requested.response.body?.cancel();
    await sleep(2_000 * attempt);
  }
  throw new MeasurementError("download_status", lastStatus);
};

const verifyPublicRanges = async (asset, file) => {
  const ranges = [
    { from: 0, until: 100 },
    { from: Math.floor(file.size / 2), until: Math.floor(file.size / 2) + 255 },
    { from: file.size - 100, until: file.size },
  ];
  const observed = [];
  for (const range of ranges) {
    const expected = await localRange(file, range.from, range.until);
    const started = performance.now();
    const requested = await publicRequest(
      asset.browserDownloadUrl,
      `bytes=${range.from}-${range.until - 1}`,
    );
    if (
      requested.response.status !== 206
      || requested.response.headers.get("content-range") !== `bytes ${range.from}-${range.until - 1}/${file.size}`
      || requested.response.headers.get("content-length") !== String(expected.byteLength)
      || requested.response.headers.get("content-encoding") !== null
    ) throw new MeasurementError("range_status", requested.response.status);
    const bytes = Buffer.from(await requested.response.arrayBuffer());
    if (!bytes.equals(expected)) throw new MeasurementError("range_identity", requested.response.status);
    observed.push({
      elapsedMilliseconds: roundedMilliseconds(performance.now() - started),
      from: range.from,
      redirects: requested.redirects,
      sha256: sha256(bytes),
      until: range.until,
    });
  }
  return observed;
};

const cleanupRemote = async ({ repository, token, tag, releaseId }) => {
  let resolvedId = releaseId;
  let cleanupFailure = null;
  if (resolvedId === null) {
    try {
      resolvedId = (await resolveRelease({ repository, token, tag }))?.id ?? null;
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (resolvedId !== null) {
    try {
      await apiRequest(repository, token, `/releases/${resolvedId}`, {
        expectedStatuses: [204, 404],
        method: "DELETE",
      });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  try {
    await apiRequest(repository, token, `/git/refs/tags/${encodeURIComponent(tag)}`, {
      expectedStatuses: [204, 404],
      method: "DELETE",
    });
  } catch (error) {
    cleanupFailure ??= error;
  }
  let releaseAbsent = false;
  let tagAbsent = false;
  try {
    releaseAbsent = await resolveRelease({ repository, token, tag }) === null;
  } catch (error) {
    cleanupFailure ??= error;
  }
  try {
    const tagResponse = await apiRequest(repository, token, `/git/ref/tags/${encodeURIComponent(tag)}`, {
      expectedStatuses: [200, 404],
    });
    tagAbsent = tagResponse.status === 404;
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (!releaseAbsent || !tagAbsent) {
    throw cleanupFailure instanceof MeasurementError
      ? cleanupFailure
      : new MeasurementError("cleanup_incomplete");
  }
  return { releaseAbsent, tagAbsent };
};

const writeResult = async (output, result) => {
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`);
  await writeFile(output, bytes, { flag: "wx" });
  const resultSha256 = sha256(bytes);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summary === "string" && summary.length > 0) {
    await appendFile(summary, `## Market-data Release measurement\n\n\`\`\`json\n${bytes.toString("utf8")}\`\`\`\n`);
  }
  process.stdout.write(`${JSON.stringify({ outputBytes: bytes.length, outputSha256: resultSha256 })}\n`);
};

const run = async () => {
  const args = parseArguments();
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0) throw new MeasurementError("missing_token");
  const tag = `market-data-storage-measurement-${args.runId}`;
  if (args.operation === "cleanup") {
    const cleanup = await cleanupRemote({
      releaseId: null,
      repository: args.repository,
      tag,
      token,
    });
    process.stdout.write(`${JSON.stringify({ cleanup, status: "clean" })}\n`);
    return;
  }
  const facts = scaleFacts[args.scale];
  const directory = await mkdtemp(join(tmpdir(), "market-data-release-measurement-"));
  let releaseId = null;
  let releaseCreateMilliseconds = null;
  let failure = null;
  let cleanup = { releaseAbsent: false, tagAbsent: false };
  let cleanupMilliseconds = null;
  let observation = null;
  try {
    const file = await generateFile(
      join(directory, "data.bin"),
      facts.dataBytes,
      `${args.runId}:data`,
    );
    const release = await createRelease({
      commit: args.commit,
      repository: args.repository,
      tag,
      token,
    });
    releaseId = release.id;
    releaseCreateMilliseconds = release.elapsedMilliseconds;
    const uploaded = await uploadAsset({
      assetName: basename(file.path),
      file,
      release,
      repository: args.repository,
      tag,
      token,
    });
    const verified = await verifyPublicAsset(uploaded, file);
    const ranges = await verifyPublicRanges(uploaded, file);
    observation = {
      assetName: uploaded.name,
      bytes: file.size,
      downloadMilliseconds: verified.elapsedMilliseconds,
      publicRedirects: verified.redirects,
      ranges,
      sha256: file.sha256,
      uploadMilliseconds: uploaded.elapsedMilliseconds,
    };
  } catch (error) {
    failure = {
      httpStatus: error instanceof MeasurementError ? error.httpStatus : null,
      reason: error instanceof MeasurementError ? error.reason : "unexpected_failure",
    };
  } finally {
    const cleanupStarted = performance.now();
    try {
      cleanup = await cleanupRemote({
        releaseId,
        repository: args.repository,
        tag,
        token,
      });
    } catch (error) {
      cleanup = {
        httpStatus: error instanceof MeasurementError ? error.httpStatus : null,
        reason: error instanceof MeasurementError ? error.reason : "unexpected_cleanup_failure",
        releaseAbsent: false,
        tagAbsent: false,
      };
    }
    cleanupMilliseconds = roundedMilliseconds(performance.now() - cleanupStarted);
    await rm(directory, { force: true, recursive: true });
  }
  const status = failure === null && cleanup.releaseAbsent && cleanup.tagAbsent ? "observed" : "failed";
  await writeResult(args.output, {
    cleanup,
    cleanupMilliseconds,
    commit: args.commit,
    failure,
    node: process.version,
    observation,
    repository: args.repository,
    releaseCreateMilliseconds,
    runId: args.runId,
    scale: args.scale,
    status,
    tag,
  });
  if (status !== "observed") process.exitCode = 1;
};

run().catch((error) => {
  process.stderr.write(`${error instanceof MeasurementError ? error.reason : "unexpected_failure"}\n`);
  process.exitCode = 1;
});
