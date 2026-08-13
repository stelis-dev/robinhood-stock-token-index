const allowedMethods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);

function hexQuantity(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new Error(`${label} is not a canonical hex quantity.`);
  }
  return BigInt(value);
}

function exactBlock(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Block response is invalid.");
  if (!/^0x[0-9a-f]{64}$/.test(candidate.hash)) throw new Error("Block hash is invalid.");
  hexQuantity(candidate.number, "block number");
  hexQuantity(candidate.timestamp, "block timestamp");
  return { hash: candidate.hash, number: candidate.number, timestamp: candidate.timestamp };
}

export class RpcClient {
  #id = 0;
  #lastRequestAt = 0;

  constructor({ url, requestDelayMilliseconds, requestTimeoutMilliseconds, maximumResponseBytes, fetchImplementation = fetch, signal }) {
    this.url = new URL(url).toString();
    this.requestDelayMilliseconds = requestDelayMilliseconds;
    this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.maximumResponseBytes = maximumResponseBytes;
    this.fetch = fetchImplementation;
    this.signal = signal;
  }

  async #pace() {
    const remaining = this.requestDelayMilliseconds - (Date.now() - this.#lastRequestAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    this.#lastRequestAt = Date.now();
  }

  async #post(payload) {
    this.signal?.throwIfAborted();
    await this.#pace();
    const body = JSON.stringify(payload);
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(this.requestTimeoutMilliseconds)])
        : AbortSignal.timeout(this.requestTimeoutMilliseconds),
    });
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength !== null && contentLength !== undefined && Number(contentLength) > this.maximumResponseBytes) {
      throw new Error("RPC response exceeds the admitted byte limit.");
    }
    const chunks = [];
    let byteLength = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > this.maximumResponseBytes) {
          await reader.cancel();
          throw new Error("RPC response exceeds the admitted byte limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const value = Buffer.from(await response.arrayBuffer());
      byteLength = value.byteLength;
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, byteLength);
    if (bytes.byteLength > this.maximumResponseBytes) throw new Error("RPC response exceeds the admitted byte limit.");
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}.`);
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("RPC response is not JSON.");
    }
    return value;
  }

  async call(method, params) {
    if (!allowedMethods.has(method)) throw new Error(`RPC method is not admitted: ${method}`);
    const id = ++this.#id;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params });
    if (response === null || typeof response !== "object" || Array.isArray(response) || response.jsonrpc !== "2.0" || response.id !== id) {
      throw new Error("RPC response envelope is invalid.");
    }
    if ("error" in response) throw new Error(`RPC ${method} failed: ${JSON.stringify(response.error)}`);
    if (!("result" in response)) throw new Error("RPC response omitted its result.");
    return response.result;
  }

  async batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > 100) throw new Error("RPC batch size is invalid.");
    const requests = calls.map(({ method, params }) => {
      if (!allowedMethods.has(method)) throw new Error(`RPC method is not admitted: ${method}`);
      return { jsonrpc: "2.0", id: ++this.#id, method, params };
    });
    const response = await this.#post(requests);
    if (!Array.isArray(response) || response.length !== requests.length) throw new Error("RPC batch response count is invalid.");
    const byId = new Map();
    for (const entry of response) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry.jsonrpc !== "2.0" || !Number.isSafeInteger(entry.id) || byId.has(entry.id)) {
        throw new Error("RPC batch response envelope is invalid.");
      }
      byId.set(entry.id, entry);
    }
    return requests.map((request) => {
      const entry = byId.get(request.id);
      if (!entry) throw new Error("RPC batch response omitted an ID.");
      if ("error" in entry) throw new Error(`RPC ${request.method} failed: ${JSON.stringify(entry.error)}`);
      if (!("result" in entry)) throw new Error("RPC batch response omitted its result.");
      return entry.result;
    });
  }

  async verifyChain(numericChainId) {
    const observed = hexQuantity(await this.call("eth_chainId", []), "chain ID");
    if (observed !== BigInt(numericChainId)) throw new Error("RPC chain identity mismatch.");
  }

  async getBlock(selector) {
    return exactBlock(await this.call("eth_getBlockByNumber", [typeof selector === "bigint" ? `0x${selector.toString(16)}` : selector, false]));
  }

  async getBlockHeaders(numbers, batchSize) {
    const unique = [...new Set(numbers.map((value) => BigInt(value).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const output = new Map();
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      const part = unique.slice(offset, offset + batchSize);
      const results = await this.batch(part.map((number) => ({ method: "eth_getBlockByNumber", params: [`0x${number.toString(16)}`, false] })));
      for (let index = 0; index < part.length; index += 1) {
        const block = exactBlock(results[index]);
        if (BigInt(block.number) !== part[index]) throw new Error("RPC block batch returned the wrong number.");
        output.set(part[index].toString(), block);
      }
    }
    return output;
  }

  async getLogs({ address, poolIds, swapTopic, fromBlock, toBlock }) {
    const result = await this.call("eth_getLogs", [{
      address,
      fromBlock: `0x${BigInt(fromBlock).toString(16)}`,
      toBlock: `0x${BigInt(toBlock).toString(16)}`,
      topics: [swapTopic, poolIds],
    }]);
    if (!Array.isArray(result)) throw new Error("RPC log result is not an array.");
    return result;
  }

  async findFirstBlockAtOrAfterTimestamp(timestamp, minimumBlock, maximumBlock) {
    let low = BigInt(minimumBlock);
    let high = BigInt(maximumBlock);
    if (low < 0n || low > high) throw new Error("Block search bounds are invalid.");
    const target = BigInt(timestamp);
    if (hexQuantity((await this.getBlock(high)).timestamp, "block timestamp") < target) return high + 1n;
    while (low < high) {
      const middle = (low + high) >> 1n;
      const block = await this.getBlock(middle);
      if (hexQuantity(block.timestamp, "block timestamp") < target) low = middle + 1n;
      else high = middle;
    }
    return low;
  }
}

export function blockTimestamp(block) {
  const value = hexQuantity(block.timestamp, "block timestamp");
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Block timestamp exceeds the safe integer boundary.");
  return Number(value);
}
