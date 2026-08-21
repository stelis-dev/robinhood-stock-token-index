import assert from "node:assert/strict";
import test from "node:test";
import { RpcEndpointUnavailableError, RpcResponseRejectedError } from "../collector/rpc-endpoint.mjs";
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

function rpcBlock(number) {
  const value = BigInt(number);
  return {
    hash: `0x${(value + 1n).toString(16).padStart(64, "0")}`,
    number: `0x${value.toString(16)}`,
    timestamp: `0x${(value + 100n).toString(16)}`,
  };
}

function admittedBlock(number) {
  const value = BigInt(number);
  return {
    hash: rpcBlock(value).hash,
    number: value,
    timestampSeconds: Number(value + 100n),
  };
}

function blockExpectation(number) {
  const value = BigInt(number);
  return { hash: rpcBlock(value).hash, number: value };
}

const headerTimeRange = Object.freeze({
  minimumTimestampSeconds: 0,
  maximumTimestampSeconds: 10_000,
});

const logRequest = Object.freeze({
  address: `0x${"1".repeat(40)}`,
  poolIds: Object.freeze([`0x${"2".repeat(64)}`]),
  swapTopic: `0x${"3".repeat(64)}`,
  fromBlock: 1n,
  toBlock: 2n,
});

test("only admitted read operations can create an RPC request", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      throw new Error("network must not be reached");
    },
  }));
  assert.equal("call" in client, false);
  assert.equal("batch" in client, false);
  await assert.rejects(client.verifyChain(0), /chain ID/);
  await assert.rejects(client.getBlock("latest"), /selector/);
  await assert.rejects(client.getBlock(-1n), /selector/);
  await assert.rejects(client.getBlockHeaders([blockExpectation(1)], 0, headerTimeRange), /batch size/);
  await assert.rejects(client.getBlockHeaders([
    { ...blockExpectation(1), hash: [blockExpectation(1).hash] },
  ], 1, headerTimeRange), /expectations/);
  await assert.rejects(client.getBlockHeaders([
    blockExpectation(1),
    blockExpectation(1),
  ], 2, headerTimeRange), /expectations/);
  await assert.rejects(client.getBlockHeaders(
    [blockExpectation(1)],
    1,
    { minimumTimestampSeconds: 100, maximumTimestampSeconds: 100 },
  ), /timestamp range/);
  await assert.rejects(client.getLogs({ ...logRequest, fromBlock: 3n, toBlock: 2n }), /block range/);
  await assert.rejects(client.getLogs({ ...logRequest, poolIds: ["not-a-pool-id"] }), /pool IDs/);
  await assert.rejects(client.getLogs({ ...logRequest, address: [logRequest.address] }), /log source/);
  await assert.rejects(client.getLogs({ ...logRequest, swapTopic: [logRequest.swapTopic] }), /log source/);
  await assert.rejects(client.getLogs({ ...logRequest, poolIds: [[logRequest.poolIds[0]]] }), /pool IDs/);
  assert.equal(attempts, 0);
});

test("RPC block data must be primitive canonical strings", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ...rpcBlock(1), hash: [rpcBlock(1).hash] },
      }));
    },
  }));
  await assert.rejects(client.getBlock("finalized"), (error) => (
    error instanceof RpcResponseRejectedError
      && error.reason === "response_result_invalid"
      && error.rpcMethod === "eth_getBlockByNumber"
  ));
  assert.equal(attempts, 1);
});

test("RPC block timestamps must fit the canonical UTC representation", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ...rpcBlock(1), timestamp: "0x1fffffffffffff" },
      }));
    },
  }));
  await assert.rejects(client.getBlock("finalized"), (error) => (
    error instanceof RpcResponseRejectedError
      && error.reason === "response_result_invalid"
      && error.rpcMethod === "eth_getBlockByNumber"
  ));
  assert.equal(attempts, 1);
});

test("the RPC client correlates batch IDs rather than response order", async () => {
  const fetchImplementation = async (_url, init) => {
    const requests = JSON.parse(init.body);
    return new Response(JSON.stringify([...requests].reverse().map((request) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: rpcBlock(request.params[0]),
    }))));
  };
  const client = new RpcClient(clientOptions({ fetchImplementation }));
  const headers = await client.getBlockHeaders(
    [blockExpectation(1), blockExpectation(2)],
    100,
    headerTimeRange,
  );
  assert.deepEqual([...headers.values()], [admittedBlock(1), admittedBlock(2)]);
});

test("the RPC client stops reading beyond the response byte boundary", async () => {
  const client = new RpcClient(clientOptions({
    maximumResponseBytes: 16,
    fetchImplementation: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(100) })),
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => (
    error instanceof RpcResponseRejectedError && error.reason === "response_too_large"
  ));
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
  await client.verifyChain(0x1237);
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(waits, [2000, 1500]);
});

test("the RPC client retries bounded transport failures", async () => {
  let attempts = 0;
  const waits = [];
  const client = new RpcClient(clientOptions({
    url: "https://rpc.example/secret-token",
    fetchImplementation: async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("network unavailable for https://rpc.example/secret-token");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }));
    },
    sleepImplementation: async (milliseconds) => { waits.push(milliseconds); },
    nowImplementation: () => 10_000,
  }));
  await client.verifyChain(0x1237);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 1, 2000, 1]);
});

test("RPC failures do not expose endpoint or untrusted provider text", async () => {
  const endpointToken = "private-endpoint-token";
  const transport = new RpcClient(clientOptions({
    url: `https://rpc.example/${endpointToken}`,
    maximumRpcAttempts: 1,
    fetchImplementation: async () => { throw new TypeError(`failed ${endpointToken}`); },
  }));
  await assert.rejects(transport.verifyChain(0x1237), (error) => {
    assert.ok(error instanceof RpcEndpointUnavailableError);
    assert.equal(error.message, "RPC endpoint is unavailable.");
    assert.equal(error.reason, "transport_unavailable");
    assert.equal(error.rpcMethod, "eth_chainId");
    assert.doesNotMatch(error.message, new RegExp(endpointToken));
    return true;
  });
  assert.doesNotMatch(JSON.stringify(transport), new RegExp(endpointToken));

  let providerAttempts = 0;
  const provider = new RpcClient(clientOptions({
    maximumRpcAttempts: 1,
    fetchImplementation: async () => {
      providerAttempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: `provider echoed ${endpointToken}`, data: endpointToken },
      }));
    },
  }));
  await assert.rejects(provider.verifyChain(0x1237), (error) => {
    assert.ok(error instanceof RpcResponseRejectedError);
    assert.equal(error.reason, "rpc_error");
    assert.equal(error.rpcCode, -32602);
    assert.equal(error.rpcMethod, "eth_chainId");
    assert.equal(error.message, "RPC response was rejected.");
    assert.doesNotMatch(error.message, new RegExp(endpointToken));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(endpointToken));
    return true;
  });
  assert.equal(providerAttempts, 1);
});

test("the RPC client does not retry a non-transient HTTP failure", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("bad request", { status: 400 });
    },
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => (
    error instanceof RpcResponseRejectedError
      && error.reason === "http_rejected"
      && error.httpStatus === 400
  ));
  assert.equal(attempts, 1);
});

test("endpoint access denial skips local retries without exposing provider text", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("credential details", { status: 403 });
    },
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => {
    assert.ok(error instanceof RpcEndpointUnavailableError);
    assert.equal(error.message, "RPC endpoint is unavailable.");
    assert.equal(error.reason, "access_denied");
    assert.equal(error.rpcMethod, "eth_chainId");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  assert.equal(attempts, 1);
});

test("an endpoint without a required RPC capability skips local retries", async () => {
  for (const code of [-32601, -32004, -32006]) {
    let attempts = 0;
    const client = new RpcClient(clientOptions({
      fetchImplementation: async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code, message: "provider capability details" },
        }));
      },
    }));
    await assert.rejects(client.verifyChain(0x1237), (error) => error instanceof RpcEndpointUnavailableError);
    assert.equal(attempts, 1);
  }
});

test("pruned history makes only historical data reads immediately unavailable", async () => {
  for (const readHistoricalData of [
    (client) => client.getBlock(1n),
    (client) => client.getLogs(logRequest),
  ]) {
    let attempts = 0;
    const client = new RpcClient(clientOptions({
      fetchImplementation: async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: 4444, message: "pruned history details" },
        }));
      },
    }));
    await assert.rejects(readHistoricalData(client), (error) => error instanceof RpcEndpointUnavailableError);
    assert.equal(attempts, 1);
  }

  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 4444, message: "pruned history details" },
      }));
    },
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => (
    error instanceof RpcResponseRejectedError
      && error.reason === "rpc_error"
      && error.rpcCode === 4444
      && error.rpcMethod === "eth_chainId"
  ));
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
  await assert.rejects(client.verifyChain(0x1237), (error) => {
    assert.ok(error instanceof RpcEndpointUnavailableError);
    assert.equal(error.reason, "http_unavailable");
    assert.equal(error.rpcMethod, "eth_chainId");
    assert.equal(error.httpStatus, 503);
    return true;
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 1, 2000, 1]);
});

test("all server-side HTTP failures receive the configured retries", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    maximumRpcAttempts: 2,
    fetchImplementation: async () => {
      attempts += 1;
      return new Response("upstream timed out", { status: 524 });
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => error instanceof RpcEndpointUnavailableError);
  assert.equal(attempts, 2);
});

test("validated read server errors retry the identical admitted request", async () => {
  for (const code of [-32099, -32007, -32000]) {
    const bodies = [];
    let attempts = 0;
    const client = new RpcClient(clientOptions({
      fetchImplementation: async (_url, init) => {
        bodies.push(init.body);
        attempts += 1;
        if (attempts < 3) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code, message: "provider server details must remain private" },
          }));
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }));
      },
      sleepImplementation: async () => {},
      nowImplementation: () => 10_000,
    }));
    await client.verifyChain(0x1237);
    assert.equal(attempts, 3);
    assert.equal(new Set(bodies).size, 1);
  }

  let exhaustedAttempts = 0;
  const exhausted = new RpcClient(clientOptions({
    maximumRpcAttempts: 2,
    fetchImplementation: async () => {
      exhaustedAttempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "provider server details must remain private" },
      }));
    },
    sleepImplementation: async () => {},
  }));
  await assert.rejects(
    exhausted.getLogs(logRequest),
    (error) => (
      error instanceof RpcEndpointUnavailableError
        && error.reason === "rpc_error"
        && error.rpcCode === -32000
        && error.rpcMethod === "eth_getLogs"
    ),
  );
  assert.equal(exhaustedAttempts, 2);
});

test("invalid request, invalid parameters, and transaction rejection remain fatal", async () => {
  for (const code of [-32600, -32602, -32003]) {
    let attempts = 0;
    const client = new RpcClient(clientOptions({
      fetchImplementation: async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code, message: "untrusted invalid-input details" },
        }));
      },
      sleepImplementation: async () => {},
    }));
    await assert.rejects(client.getLogs(logRequest), (error) => (
      error instanceof RpcResponseRejectedError
        && error.reason === "rpc_error"
        && error.rpcCode === code
        && error.rpcMethod === "eth_getLogs"
    ));
    assert.equal(attempts, 1);
  }
});

test("a missing required block is retried by the endpoint before it is validated", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: attempts === 1 ? null : rpcBlock(1),
      }));
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  assert.equal((await client.getBlock("finalized")).number, 1n);
  assert.equal(attempts, 2);
});

test("an endpoint that temporarily lacks the required block receives bounded retries", async () => {
  const bodies = [];
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async (_url, init) => {
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -39001, message: "unknown block details" },
        }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rpcBlock(1) }));
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  assert.equal((await client.getBlock("finalized")).number, 1n);
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("a batch retries as one request and never validates partial success", async () => {
  const bodies = [];
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async (_url, init) => {
      bodies.push(init.body);
      attempts += 1;
      const requests = JSON.parse(init.body);
      if (attempts === 1) {
        return new Response(JSON.stringify([
          { jsonrpc: "2.0", id: requests[0].id, result: rpcBlock(1) },
          { jsonrpc: "2.0", id: requests[1].id, error: { code: -32002, message: "resource unavailable" } },
        ]));
      }
      return new Response(JSON.stringify(requests.map((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: rpcBlock(request.params[0]),
      }))));
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  const headers = await client.getBlockHeaders(
    [blockExpectation(1), blockExpectation(2)],
    100,
    headerTimeRange,
  );
  assert.deepEqual([...headers.values()], [admittedBlock(1), admittedBlock(2)]);
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("fatal batch errors take precedence over availability errors", async () => {
  for (const availabilityCode of [-32002, -32601]) {
    let attempts = 0;
    const client = new RpcClient(clientOptions({
      fetchImplementation: async (_url, init) => {
        attempts += 1;
        const requests = JSON.parse(init.body);
        return new Response(JSON.stringify([
          { jsonrpc: "2.0", id: requests[0].id, error: { code: availabilityCode, message: "availability details" } },
          { jsonrpc: "2.0", id: requests[1].id, result: rpcBlock(3) },
        ]));
      },
      sleepImplementation: async () => {},
    }));
    await assert.rejects(client.getBlockHeaders(
      [blockExpectation(1), blockExpectation(2)],
      100,
      headerTimeRange,
    ), (error) => (
      error instanceof RpcResponseRejectedError
        && error.reason === "response_result_invalid"
        && error.rpcMethod === "eth_getBlockByNumber"
    ));
    assert.equal(attempts, 1);
  }
});

test("batch header identity and time validation precede sibling availability", async () => {
  for (const malformed of [
    { ...rpcBlock(2), hash: `0x${"f".repeat(64)}` },
    { ...rpcBlock(2), timestamp: "0x2710" },
  ]) {
    let attempts = 0;
    const client = new RpcClient(clientOptions({
      fetchImplementation: async (_url, init) => {
        attempts += 1;
        const requests = JSON.parse(init.body);
        return new Response(JSON.stringify([
          { jsonrpc: "2.0", id: requests[0].id, error: { code: -32002, message: "availability details" } },
          { jsonrpc: "2.0", id: requests[1].id, result: malformed },
        ]));
      },
      sleepImplementation: async () => {},
    }));
    await assert.rejects(client.getBlockHeaders(
      [blockExpectation(1), blockExpectation(2)],
      100,
      headerTimeRange,
    ), (error) => (
      error instanceof RpcResponseRejectedError
        && error.reason === "response_result_invalid"
        && error.rpcMethod === "eth_getBlockByNumber"
    ));
    assert.equal(attempts, 1);
  }
});

test("repeated JSON-RPC resource-not-found errors exhaust to the endpoint availability signal", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "missing resource with provider details" },
      }));
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => {
    assert.ok(error instanceof RpcEndpointUnavailableError);
    assert.equal(error.message, "RPC endpoint is unavailable.");
    assert.equal(error.reason, "rpc_error");
    assert.equal(error.rpcMethod, "eth_chainId");
    assert.equal(error.rpcCode, -32001);
    return true;
  });
  assert.equal(attempts, 3);
});

test("JSON-RPC internal errors receive the configured retries", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    maximumRpcAttempts: 2,
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "provider internal details" },
      }));
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => (
    error instanceof RpcEndpointUnavailableError
      && error.reason === "rpc_error"
      && error.rpcMethod === "eth_chainId"
      && error.rpcCode === -32603
  ));
  assert.equal(attempts, 2);
});

test("an oversized 429 is retried without validating its body", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    maximumResponseBytes: 64,
    fetchImplementation: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("x".repeat(1000), { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }));
    },
    sleepImplementation: async () => {},
    nowImplementation: () => 10_000,
  }));
  await client.verifyChain(0x1237);
  assert.equal(attempts, 2);
});

test("malformed success responses remain fatal and are not retried", async () => {
  let attempts = 0;
  const client = new RpcClient(clientOptions({
    fetchImplementation: async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: "0x1237",
        error: { code: -32005, message: "limit" },
      }));
    },
  }));
  await assert.rejects(client.verifyChain(0x1237), (error) => (
    error instanceof RpcResponseRejectedError && error.reason === "response_envelope_invalid"
  ));
  assert.equal(attempts, 1);
});
