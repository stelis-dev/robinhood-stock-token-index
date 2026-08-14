import assert from "node:assert/strict";
import test from "node:test";
import { RpcClient } from "../collector/rpc-client.mjs";

function clientOptions(overrides = {}) {
  return {
    url: "https://rpc.example",
    requestDelayMilliseconds: 1,
    requestTimeoutMilliseconds: 1000,
    maximumResponseBytes: 4096,
    maximumRpcAttempts: 3,
    maximumRpcRetryDelayMilliseconds: 10_000,
    ...overrides,
  };
}

test("the RPC client correlates batch IDs rather than response order", async () => {
  const fetchImplementation = async (_url, init) => {
    const requests = JSON.parse(init.body);
    return new Response(JSON.stringify([...requests].reverse().map((request) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: request.params[0],
    }))));
  };
  const client = new RpcClient(clientOptions({ fetchImplementation }));
  assert.deepEqual(await client.batch([
    { method: "eth_getBlockByNumber", params: ["0x1", false] },
    { method: "eth_getBlockByNumber", params: ["0x2", false] },
  ]), ["0x1", "0x2"]);
});

test("the RPC client stops reading beyond the response byte boundary", async () => {
  const client = new RpcClient(clientOptions({
    maximumResponseBytes: 16,
    fetchImplementation: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(100) })),
  }));
  await assert.rejects(client.call("eth_chainId", []), /byte limit/);
});

test("the RPC client retries a 429 with the same request and honors Retry-After", async () => {
  const bodies = [];
  const waits = [];
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    requestDelayMilliseconds: 1500,
    fetchImplementation: async (_url, init) => {
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }));
    },
    sleepImplementation: async (milliseconds) => { waits.push(milliseconds); },
    nowImplementation: () => 10_000,
  }));
  assert.equal(await client.call("eth_chainId", []), "0x1237");
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(waits, [2000, 1500]);
});

test("the RPC client does not retry a non-transient HTTP failure", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("bad request", { status: 400 });
    },
  }));
  await assert.rejects(client.call("eth_chainId", []), /RPC HTTP 400\./);
  assert.equal(attempts, 1);
});

test("the RPC client bounds repeated transient failures", async () => {
  let attempts = 0;
  const waits = [];
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("unavailable", { status: 503 });
    },
    sleepImplementation: async (milliseconds) => { waits.push(milliseconds); },
    nowImplementation: () => 10_000,
  }));
  await assert.rejects(client.call("eth_chainId", []), /RPC HTTP 503 after 3 attempts\./);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 1, 2000, 1]);
});
