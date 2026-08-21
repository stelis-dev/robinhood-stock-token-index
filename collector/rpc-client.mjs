import { setTimeout as delay } from "node:timers/promises";
import { isCanonicalAddress, isCanonicalBytes32 } from "./hex-data.mjs";
import { isCanonicalHexQuantity, parseHexQuantity, safeHexQuantityNumber } from "./hex-quantity.mjs";
import {
  validateRpcUrl,
  maximumRpcBatchSize,
  rpcMethods,
  RpcEndpointUnavailableError,
  RpcResponseRejectedError,
} from "./rpc-endpoint.mjs";
import { validateUnixTimestampSeconds } from "./utc-time.mjs";

const accessDeniedHttpStatuses = new Set([401, 403]);
const immediateUnavailableRpcErrorCodes = new Set([-32601, -32004, -32006]);
const historicalDataRpcMethods = new Set([
  rpcMethods.getBlockByNumber,
  rpcMethods.getLogs,
]);
const retryableValidatedReadRpcErrorCodes = new Set([-32603, -32000, -32001, -32002, -32005]);

function responseRejected(reason, rpcMethod, facts = {}) {
  return new RpcResponseRejectedError(reason, { ...facts, rpcMethod });
}

function endpointFailure(reason, rpcMethod, facts = {}) {
  return Object.freeze({ reason, rpcMethod, ...facts });
}

function endpointUnavailable(failure) {
  return new RpcEndpointUnavailableError(failure.reason, failure);
}

function rpcErrorDisposition(rpcMethod, rpcCode) {
  if (immediateUnavailableRpcErrorCodes.has(rpcCode)) return "unavailable";
  if (rpcCode === 4444 && historicalDataRpcMethods.has(rpcMethod)) return "unavailable";
  if (retryableValidatedReadRpcErrorCodes.has(rpcCode) || (rpcCode >= -32099 && rpcCode <= -32007)) return "retryable";
  if (rpcMethod === rpcMethods.getBlockByNumber && rpcCode === -39001) return "retryable";
  return "rejected";
}

function exactBlock(candidate, rpcMethod) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw responseRejected("response_result_invalid", rpcMethod);
  }
  if (!isCanonicalBytes32(candidate.hash)) {
    throw responseRejected("response_result_invalid", rpcMethod);
  }
  let number;
  let timestampSeconds;
  try {
    number = parseHexQuantity(candidate.number, "block number");
    timestampSeconds = validateUnixTimestampSeconds(
      safeHexQuantityNumber(candidate.timestamp, "block timestamp"),
      "Block timestamp",
    );
  } catch {
    throw responseRejected("response_result_invalid", rpcMethod);
  }
  return Object.freeze({ hash: candidate.hash, number, timestampSeconds });
}

function validateAdmittedBlock(candidate, label) {
  if (
    candidate === null
    || typeof candidate !== "object"
    || Array.isArray(candidate)
    || JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["hash", "number", "timestampSeconds"])
    || typeof candidate.number !== "bigint"
    || candidate.number < 0n
    || !isCanonicalBytes32(candidate.hash)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  validateUnixTimestampSeconds(candidate.timestampSeconds, `${label} timestamp`);
  return candidate;
}

function validateRpcResult(result, request) {
  if (request.method === rpcMethods.chainId) {
    try {
      parseHexQuantity(result, "chain ID");
    } catch {
      throw responseRejected("response_result_invalid", request.method);
    }
    return { result };
  }
  if (request.method === rpcMethods.getBlockByNumber) {
    if (result === null) {
      return {
        retryable: endpointFailure("required_resource_unavailable", request.method),
      };
    }
    const block = exactBlock(result, request.method);
    const selector = request.params?.[0];
    if (isCanonicalHexQuantity(selector) && block.number !== BigInt(selector)) {
      throw responseRejected("response_result_invalid", request.method);
    }
    if (
      request.expectedBlockHash !== undefined
      && (
        block.hash !== request.expectedBlockHash
        || block.timestampSeconds < request.minimumTimestampSeconds
        || block.timestampSeconds >= request.maximumTimestampSeconds
      )
    ) {
      throw responseRejected("response_result_invalid", request.method);
    }
    return { result: block };
  }
  if (request.method === rpcMethods.getLogs) {
    if (!Array.isArray(result)) throw responseRejected("response_result_invalid", request.method);
    return { result };
  }
  throw new Error("RPC response method is unsupported.");
}

function validateRpcEntry(entry, request) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.jsonrpc !== "2.0" || entry.id !== request.id) {
    throw responseRejected("response_envelope_invalid", request.method);
  }
  const hasResult = Object.hasOwn(entry, "result");
  const hasError = Object.hasOwn(entry, "error");
  if (hasResult === hasError) throw responseRejected("response_envelope_invalid", request.method);
  if (hasResult) return validateRpcResult(entry.result, request);
  if (entry.error === null || typeof entry.error !== "object" || Array.isArray(entry.error) || !Number.isSafeInteger(entry.error.code) || typeof entry.error.message !== "string") {
    throw responseRejected("response_envelope_invalid", request.method);
  }
  const disposition = rpcErrorDisposition(request.method, entry.error.code);
  const failure = endpointFailure("rpc_error", request.method, { rpcCode: entry.error.code });
  if (disposition === "unavailable") return { unavailable: failure };
  if (disposition === "retryable") return { retryable: failure };
  throw responseRejected("rpc_error", request.method, { rpcCode: entry.error.code });
}

function validateRpcResponse(value, requests, batch) {
  const rpcMethod = requests[0].method;
  const entries = batch ? value : [value];
  if (!Array.isArray(entries) || entries.length !== requests.length) {
    throw responseRejected("response_envelope_invalid", rpcMethod);
  }
  const expectedIds = new Set(requests.map((request) => request.id));
  const byId = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !Number.isSafeInteger(entry.id) || !expectedIds.has(entry.id) || byId.has(entry.id)) {
      throw responseRejected("response_envelope_invalid", rpcMethod);
    }
    byId.set(entry.id, entry);
  }
  const results = [];
  let unavailable = null;
  let retryable = null;
  for (const request of requests) {
    const entry = byId.get(request.id);
    if (entry === undefined) throw responseRejected("response_envelope_invalid", rpcMethod);
    const validated = validateRpcEntry(entry, request);
    if (validated.unavailable !== undefined && unavailable === null) unavailable = validated.unavailable;
    if (validated.retryable !== undefined && retryable === null) retryable = validated.retryable;
    results.push(validated.result);
  }
  if (unavailable !== null) return { unavailable };
  return retryable === null ? { results } : { retryable };
}

async function readBoundedResponse(response, maximumResponseBytes, rpcMethod) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && Number(contentLength) > maximumResponseBytes) {
    throw responseRejected("response_too_large", rpcMethod);
  }
  const chunks = [];
  let byteLength = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response-size boundary remains authoritative over stream cleanup.
        }
        throw responseRejected("response_too_large", rpcMethod);
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const value = Buffer.from(await response.arrayBuffer());
    byteLength = value.byteLength;
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, byteLength);
  if (bytes.byteLength > maximumResponseBytes) throw responseRejected("response_too_large", rpcMethod);
  return bytes;
}

function retryAfterMilliseconds(value, nowMilliseconds) {
  if (value === null || value === undefined) return null;
  if (/^[0-9]+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const target = Date.parse(value);
  return Number.isFinite(target) ? Math.max(0, target - nowMilliseconds) : null;
}

async function sleep(milliseconds, signal) {
  await delay(milliseconds, undefined, signal ? { signal } : undefined);
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // HTTP status remains authoritative over response-body cleanup.
  }
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

function requestEnvelope({ jsonrpc, id, method, params }) {
  return { jsonrpc, id, method, params };
}

export class RpcClient {
  #id = 0;
  #lastRequestAt = 0;
  #url;

  constructor({
    url,
    requestDelayMilliseconds,
    requestTimeoutMilliseconds,
    maximumResponseBytes,
    maximumRpcAttempts,
    maximumRpcRetryDelayMilliseconds,
    fetchImplementation = fetch,
    sleepImplementation = sleep,
    nowImplementation = Date.now,
    signal,
  }) {
    this.#url = validateRpcUrl(url);
    for (const [label, value] of [
      ["request delay", requestDelayMilliseconds],
      ["request timeout", requestTimeoutMilliseconds],
      ["maximum response bytes", maximumResponseBytes],
      ["maximum RPC attempts", maximumRpcAttempts],
      ["maximum RPC retry delay", maximumRpcRetryDelayMilliseconds],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`RPC ${label} must be a positive safe integer.`);
    }
    this.requestDelayMilliseconds = requestDelayMilliseconds;
    this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.maximumResponseBytes = maximumResponseBytes;
    this.maximumRpcAttempts = maximumRpcAttempts;
    this.maximumRpcRetryDelayMilliseconds = maximumRpcRetryDelayMilliseconds;
    this.fetch = fetchImplementation;
    this.sleep = sleepImplementation;
    this.now = nowImplementation;
    this.signal = signal;
  }

  async #pace() {
    const remaining = this.requestDelayMilliseconds - (this.now() - this.#lastRequestAt);
    if (remaining > 0) await this.sleep(remaining, this.signal);
    this.#lastRequestAt = this.now();
  }

  #backoff(attempt) {
    return Math.min(
      Math.max(1000, this.requestDelayMilliseconds) * (2 ** (attempt - 1)),
      this.maximumRpcRetryDelayMilliseconds,
    );
  }

  async #retry(attempt, failure, milliseconds = this.#backoff(attempt)) {
    if (attempt === this.maximumRpcAttempts) throw endpointUnavailable(failure);
    await this.sleep(milliseconds, this.signal);
  }

  async #execute(requests, batch) {
    const rpcMethod = requests[0]?.method;
    if (rpcMethod === undefined || requests.some((request) => request.method !== rpcMethod)) {
      throw new Error("An RPC transport request must contain one method.");
    }
    const payload = batch ? requests.map(requestEnvelope) : requestEnvelope(requests[0]);
    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= this.maximumRpcAttempts; attempt += 1) {
      this.signal?.throwIfAborted();
      await this.#pace();
      let response;
      try {
        response = await this.fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: this.signal
            ? AbortSignal.any([this.signal, AbortSignal.timeout(this.requestTimeoutMilliseconds)])
            : AbortSignal.timeout(this.requestTimeoutMilliseconds),
        });
      } catch (error) {
        this.signal?.throwIfAborted();
        await this.#retry(attempt, endpointFailure("transport_unavailable", rpcMethod));
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        if (accessDeniedHttpStatuses.has(response.status)) {
          throw endpointUnavailable(endpointFailure("access_denied", rpcMethod, { httpStatus: response.status }));
        }
        if (!isRetryableHttpStatus(response.status)) {
          throw responseRejected("http_rejected", rpcMethod, { httpStatus: response.status });
        }
        const failure = endpointFailure("http_unavailable", rpcMethod, { httpStatus: response.status });
        const retryAfter = retryAfterMilliseconds(response.headers?.get?.("retry-after"), this.now());
        const retryDelay = retryAfter ?? this.#backoff(attempt);
        if (retryDelay > this.maximumRpcRetryDelayMilliseconds) {
          throw endpointUnavailable(failure);
        }
        await this.#retry(attempt, failure, retryDelay);
        continue;
      }
      let bytes;
      try {
        bytes = await readBoundedResponse(response, this.maximumResponseBytes, rpcMethod);
      } catch (error) {
        this.signal?.throwIfAborted();
        if (error instanceof RpcResponseRejectedError) throw error;
        await this.#retry(attempt, endpointFailure("transport_unavailable", rpcMethod));
        continue;
      }
      let value;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw responseRejected("response_not_json", rpcMethod);
      }
      const validated = validateRpcResponse(value, requests, batch);
      if (validated.unavailable !== undefined) throw endpointUnavailable(validated.unavailable);
      if (validated.retryable !== undefined) {
        await this.#retry(attempt, validated.retryable);
        continue;
      }
      return validated.results;
    }
    throw new Error("RPC attempts were exhausted.");
  }

  async #call(method, params) {
    const id = ++this.#id;
    const [result] = await this.#execute([{ jsonrpc: "2.0", id, method, params }], false);
    return result;
  }

  async #batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > maximumRpcBatchSize) throw new Error("RPC batch size is invalid.");
    const requests = calls.map((call) => ({ ...call, jsonrpc: "2.0", id: ++this.#id }));
    return this.#execute(requests, true);
  }

  async verifyChain(numericChainId) {
    if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) throw new Error("RPC chain ID is invalid.");
    const observed = BigInt(await this.#call(rpcMethods.chainId, []));
    if (observed !== BigInt(numericChainId)) {
      throw responseRejected("chain_identity_mismatch", rpcMethods.chainId);
    }
  }

  async getBlock(selector) {
    if (selector !== "finalized" && (typeof selector !== "bigint" || selector < 0n)) {
      throw new Error("RPC block selector is invalid.");
    }
    const encoded = typeof selector === "bigint" ? `0x${selector.toString(16)}` : selector;
    return this.#call(rpcMethods.getBlockByNumber, [encoded, false]);
  }

  async getBlockHeaders(expectations, batchSize, { minimumTimestampSeconds, maximumTimestampSeconds } = {}) {
    if (!Array.isArray(expectations) || expectations.length === 0) throw new Error("RPC block header expectations are invalid.");
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > maximumRpcBatchSize) {
      throw new Error("RPC block header batch size is invalid.");
    }
    validateUnixTimestampSeconds(minimumTimestampSeconds, "RPC block header minimum timestamp");
    validateUnixTimestampSeconds(maximumTimestampSeconds, "RPC block header maximum timestamp");
    if (minimumTimestampSeconds >= maximumTimestampSeconds) throw new Error("RPC block header timestamp range is invalid.");
    const byNumber = new Map();
    for (const expectation of expectations) {
      if (
        expectation === null
        || typeof expectation !== "object"
        || Array.isArray(expectation)
        || JSON.stringify(Object.keys(expectation).sort()) !== JSON.stringify(["hash", "number"])
        || typeof expectation.number !== "bigint"
        || expectation.number < 0n
        || !isCanonicalBytes32(expectation.hash)
        || byNumber.has(expectation.number.toString())
      ) {
        throw new Error("RPC block header expectations are invalid.");
      }
      byNumber.set(expectation.number.toString(), expectation);
    }
    const ordered = [...byNumber.values()].sort((left, right) => (
      left.number < right.number ? -1 : left.number > right.number ? 1 : 0
    ));
    const output = new Map();
    for (let offset = 0; offset < ordered.length; offset += batchSize) {
      const part = ordered.slice(offset, offset + batchSize);
      const results = await this.#batch(part.map(({ number, hash }) => ({
        method: rpcMethods.getBlockByNumber,
        params: [`0x${number.toString(16)}`, false],
        expectedBlockHash: hash,
        minimumTimestampSeconds,
        maximumTimestampSeconds,
      })));
      for (let index = 0; index < part.length; index += 1) {
        output.set(part[index].number.toString(), results[index]);
      }
    }
    return output;
  }

  async getLogs({ address, poolIds, swapTopic, fromBlock, toBlock }) {
    if (!isCanonicalAddress(address) || !isCanonicalBytes32(swapTopic)) {
      throw new Error("RPC log source is invalid.");
    }
    if (!Array.isArray(poolIds) || poolIds.length === 0 || poolIds.some((value) => !isCanonicalBytes32(value)) || new Set(poolIds).size !== poolIds.length) {
      throw new Error("RPC log pool IDs are invalid.");
    }
    if (typeof fromBlock !== "bigint" || typeof toBlock !== "bigint" || fromBlock < 0n || fromBlock > toBlock) {
      throw new Error("RPC log block range is invalid.");
    }
    return this.#call(rpcMethods.getLogs, [{
      address,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [swapTopic, poolIds],
    }]);
  }

  async findFirstBlockAtOrAfterTimestamp(timestamp, minimumBlock, maximumBlock, { maximumBlockHeader } = {}) {
    validateUnixTimestampSeconds(timestamp, "Block search timestamp");
    if (typeof minimumBlock !== "bigint" || typeof maximumBlock !== "bigint") {
      throw new Error("Block search bounds are invalid.");
    }
    let low = minimumBlock;
    let high = maximumBlock;
    if (low < 0n || low > high) throw new Error("Block search bounds are invalid.");
    const target = timestamp;
    const highBlock = maximumBlockHeader === undefined
      ? await this.getBlock(high)
      : validateAdmittedBlock(maximumBlockHeader, "Block search upper-bound header");
    if (highBlock.number !== high) throw new Error("Block search header does not match its upper bound.");
    if (highBlock.timestampSeconds < target) return high + 1n;
    while (low < high) {
      const middle = (low + high) >> 1n;
      const block = await this.getBlock(middle);
      if (block.timestampSeconds < target) low = middle + 1n;
      else high = middle;
    }
    return low;
  }
}
