import { setTimeout as delay } from "node:timers/promises";
import { isCanonicalHexQuantity, parseHexQuantity, safeHexQuantityNumber } from "./hex-quantity.mjs";
import { admitRpcUrl, maximumRpcBatchSize, RpcEndpointUnavailableError } from "./rpc-endpoint.mjs";

const allowedMethods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
const accessDeniedHttpStatuses = new Set([401, 403]);
const unavailableRpcErrorCodes = new Set([-32601, -32004, -32006]);
const retryableRpcErrorCodes = new Set([-32603, -32001, -32002, -32005]);

class RpcResponseBoundaryError extends Error {}

function exactBlock(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Block response is invalid.");
  if (!/^0x[0-9a-f]{64}$/.test(candidate.hash)) throw new Error("Block hash is invalid.");
  parseHexQuantity(candidate.number, "block number");
  parseHexQuantity(candidate.timestamp, "block timestamp");
  return { hash: candidate.hash, number: candidate.number, timestamp: candidate.timestamp };
}

function admitRpcResult(result, request) {
  if (request.method === "eth_chainId") {
    parseHexQuantity(result, "chain ID");
    return { result };
  }
  if (request.method === "eth_getBlockByNumber") {
    if (result === null) return { retryable: true };
    const block = exactBlock(result);
    const selector = request.params?.[0];
    if (isCanonicalHexQuantity(selector) && BigInt(block.number) !== BigInt(selector)) {
      throw new Error("RPC block response does not match the requested number.");
    }
    return { result: block };
  }
  if (request.method === "eth_getLogs") {
    if (!Array.isArray(result)) throw new Error("RPC log result is not an array.");
    return { result };
  }
  throw new Error("RPC response method is not admitted.");
}

function admitRpcEntry(entry, request) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.jsonrpc !== "2.0" || entry.id !== request.id) {
    throw new Error("RPC response envelope is invalid.");
  }
  const hasResult = Object.hasOwn(entry, "result");
  const hasError = Object.hasOwn(entry, "error");
  if (hasResult === hasError) throw new Error("RPC response must contain exactly one result or error.");
  if (hasResult) return admitRpcResult(entry.result, request);
  if (entry.error === null || typeof entry.error !== "object" || Array.isArray(entry.error) || !Number.isSafeInteger(entry.error.code) || typeof entry.error.message !== "string") {
    throw new Error("RPC error response is invalid.");
  }
  if (unavailableRpcErrorCodes.has(entry.error.code)) return { unavailable: true };
  if (retryableRpcErrorCodes.has(entry.error.code)) return { retryable: true };
  throw new Error(`RPC ${request.method} failed with code ${entry.error.code}.`);
}

function admitRpcResponse(value, requests, batch) {
  const entries = batch ? value : [value];
  if (!Array.isArray(entries) || entries.length !== requests.length) {
    throw new Error(batch ? "RPC batch response count is invalid." : "RPC response envelope is invalid.");
  }
  const expectedIds = new Set(requests.map((request) => request.id));
  const byId = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !Number.isSafeInteger(entry.id) || !expectedIds.has(entry.id) || byId.has(entry.id)) {
      throw new Error(batch ? "RPC batch response envelope is invalid." : "RPC response envelope is invalid.");
    }
    byId.set(entry.id, entry);
  }
  const results = [];
  let unavailable = false;
  let retryable = false;
  for (const request of requests) {
    const entry = byId.get(request.id);
    if (entry === undefined) throw new Error(batch ? "RPC batch response omitted an ID." : "RPC response envelope is invalid.");
    const admitted = admitRpcEntry(entry, request);
    if (admitted.unavailable === true) unavailable = true;
    if (admitted.retryable === true) retryable = true;
    results.push(admitted.result);
  }
  if (unavailable) return { unavailable };
  return retryable ? { retryable } : { results };
}

async function readBoundedResponse(response, maximumResponseBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && Number(contentLength) > maximumResponseBytes) {
    throw new RpcResponseBoundaryError("RPC response exceeds the admitted byte limit.");
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
        throw new RpcResponseBoundaryError("RPC response exceeds the admitted byte limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } else {
    const value = Buffer.from(await response.arrayBuffer());
    byteLength = value.byteLength;
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, byteLength);
  if (bytes.byteLength > maximumResponseBytes) throw new RpcResponseBoundaryError("RPC response exceeds the admitted byte limit.");
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
    this.#url = admitRpcUrl(url);
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

  async #retry(attempt, milliseconds = this.#backoff(attempt)) {
    if (attempt === this.maximumRpcAttempts) throw new RpcEndpointUnavailableError();
    await this.sleep(milliseconds, this.signal);
  }

  async #execute(requests, batch) {
    const payload = batch ? requests : requests[0];
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
        await this.#retry(attempt);
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        if (accessDeniedHttpStatuses.has(response.status)) throw new RpcEndpointUnavailableError();
        if (!isRetryableHttpStatus(response.status)) throw new Error(`RPC HTTP ${response.status}.`);
        const retryAfter = retryAfterMilliseconds(response.headers?.get?.("retry-after"), this.now());
        const retryDelay = retryAfter ?? this.#backoff(attempt);
        if (retryDelay > this.maximumRpcRetryDelayMilliseconds) {
          throw new RpcEndpointUnavailableError();
        }
        await this.#retry(attempt, retryDelay);
        continue;
      }
      let bytes;
      try {
        bytes = await readBoundedResponse(response, this.maximumResponseBytes);
      } catch (error) {
        this.signal?.throwIfAborted();
        if (error instanceof RpcResponseBoundaryError) throw error;
        await this.#retry(attempt);
        continue;
      }
      let value;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("RPC response is not JSON.");
      }
      const admitted = admitRpcResponse(value, requests, batch);
      if (admitted.unavailable === true) throw new RpcEndpointUnavailableError();
      if (admitted.retryable === true) {
        await this.#retry(attempt);
        continue;
      }
      return admitted.results;
    }
    throw new Error("RPC attempts were exhausted.");
  }

  async call(method, params) {
    if (!allowedMethods.has(method)) throw new Error(`RPC method is not admitted: ${method}`);
    const id = ++this.#id;
    const [result] = await this.#execute([{ jsonrpc: "2.0", id, method, params }], false);
    return result;
  }

  async batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > maximumRpcBatchSize) throw new Error("RPC batch size is invalid.");
    const requests = calls.map(({ method, params }) => {
      if (!allowedMethods.has(method)) throw new Error(`RPC method is not admitted: ${method}`);
      return { jsonrpc: "2.0", id: ++this.#id, method, params };
    });
    return this.#execute(requests, true);
  }

  async verifyChain(numericChainId) {
    const observed = BigInt(await this.call("eth_chainId", []));
    if (observed !== BigInt(numericChainId)) throw new Error("RPC chain identity mismatch.");
  }

  async getBlock(selector) {
    return this.call("eth_getBlockByNumber", [typeof selector === "bigint" ? `0x${selector.toString(16)}` : selector, false]);
  }

  async getBlockHeaders(numbers, batchSize) {
    const unique = [...new Set(numbers.map((value) => BigInt(value).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const output = new Map();
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      const part = unique.slice(offset, offset + batchSize);
      const results = await this.batch(part.map((number) => ({ method: "eth_getBlockByNumber", params: [`0x${number.toString(16)}`, false] })));
      for (let index = 0; index < part.length; index += 1) {
        output.set(part[index].toString(), results[index]);
      }
    }
    return output;
  }

  async getLogs({ address, poolIds, swapTopic, fromBlock, toBlock }) {
    return this.call("eth_getLogs", [{
      address,
      fromBlock: `0x${BigInt(fromBlock).toString(16)}`,
      toBlock: `0x${BigInt(toBlock).toString(16)}`,
      topics: [swapTopic, poolIds],
    }]);
  }

  async findFirstBlockAtOrAfterTimestamp(timestamp, minimumBlock, maximumBlock, { maximumBlockHeader } = {}) {
    let low = BigInt(minimumBlock);
    let high = BigInt(maximumBlock);
    if (low < 0n || low > high) throw new Error("Block search bounds are invalid.");
    const target = BigInt(timestamp);
    const highBlock = maximumBlockHeader ?? await this.getBlock(high);
    if (BigInt(highBlock.number) !== high) throw new Error("Block search header does not match its upper bound.");
    if (parseHexQuantity(highBlock.timestamp, "block timestamp") < target) return high + 1n;
    while (low < high) {
      const middle = (low + high) >> 1n;
      const block = await this.getBlock(middle);
      if (parseHexQuantity(block.timestamp, "block timestamp") < target) low = middle + 1n;
      else high = middle;
    }
    return low;
  }
}

export function blockTimestamp(block) {
  return safeHexQuantityNumber(block.timestamp, "Block timestamp");
}
