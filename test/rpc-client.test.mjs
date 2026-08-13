import assert from "node:assert/strict";
import test from "node:test";
import { RpcClient } from "../collector/rpc-client.mjs";

test("the RPC client correlates batch IDs rather than response order", async () => {
  const fetchImplementation = async (_url, init) => {
    const requests = JSON.parse(init.body);
    return new Response(JSON.stringify([...requests].reverse().map((request) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: request.params[0],
    }))));
  };
  const client = new RpcClient({ url: "https://rpc.example", requestDelayMilliseconds: 1, requestTimeoutMilliseconds: 1000, maximumResponseBytes: 4096, fetchImplementation });
  assert.deepEqual(await client.batch([
    { method: "eth_getBlockByNumber", params: ["0x1", false] },
    { method: "eth_getBlockByNumber", params: ["0x2", false] },
  ]), ["0x1", "0x2"]);
});

test("the RPC client stops reading beyond the response byte boundary", async () => {
  const client = new RpcClient({
    url: "https://rpc.example",
    requestDelayMilliseconds: 1,
    requestTimeoutMilliseconds: 1000,
    maximumResponseBytes: 16,
    fetchImplementation: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(100) })),
  });
  await assert.rejects(client.call("eth_chainId", []), /byte limit/);
});
