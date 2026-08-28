export const maximumRpcEndpointCount = 3;
export const maximumRpcBatchSize = 100;
export const marketDataRpcLimits = Object.freeze({
  maximumResponseBytes: 16_777_216,
  maximumRpcAttempts: 7,
  maximumRpcRetryDelayMilliseconds: 60_000,
  requestDelayMilliseconds: 1_500,
  requestTimeoutMilliseconds: 30_000,
});
export const rpcMethods = Object.freeze({
  chainId: "eth_chainId",
  getBlockByNumber: "eth_getBlockByNumber",
  getLogs: "eth_getLogs",
});

const admittedRpcMethods = new Set(Object.values(rpcMethods));

const rpcEndpointUnavailableReasons = new Set([
  "access_denied",
  "endpoint_unavailable",
  "http_unavailable",
  "required_resource_unavailable",
  "rpc_error",
  "transport_unavailable",
]);

const rpcResponseRejectionReasons = new Set([
  "activation_boundary_mismatch",
  "chain_identity_mismatch",
  "finalized_boundary_mismatch",
  "http_rejected",
  "response_envelope_invalid",
  "response_not_json",
  "response_result_invalid",
  "response_too_large",
  "rpc_error",
]);

export function validateRpcUrl(value, label = "RPC URL") {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a nonempty URL without surrounding whitespace.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new Error(`${label} must use HTTPS without user information or a fragment.`);
  }
  return parsed.toString();
}

export class RpcEndpointUnavailableError extends Error {
  #httpStatus;
  #reason;
  #rpcCode;
  #rpcMethod;

  constructor(reason = "endpoint_unavailable", { httpStatus, rpcCode, rpcMethod } = {}) {
    if (!rpcEndpointUnavailableReasons.has(reason)) throw new Error("RPC endpoint-unavailable reason is invalid.");
    const hasHttpStatus = Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599;
    const hasRpcCode = Number.isSafeInteger(rpcCode);
    const hasRpcMethod = admittedRpcMethods.has(rpcMethod);
    if ((reason === "access_denied" || reason === "http_unavailable") !== hasHttpStatus) {
      throw new Error("RPC endpoint-unavailable HTTP status is invalid.");
    }
    if ((reason === "rpc_error") !== hasRpcCode) {
      throw new Error("RPC endpoint-unavailable error code is invalid.");
    }
    if ((reason !== "endpoint_unavailable") !== hasRpcMethod) {
      throw new Error("RPC endpoint-unavailable method is invalid.");
    }
    super("RPC endpoint is unavailable.");
    this.name = "RpcEndpointUnavailableError";
    this.#reason = reason;
    this.#httpStatus = httpStatus;
    this.#rpcCode = rpcCode;
    this.#rpcMethod = rpcMethod;
  }

  get httpStatus() { return this.#httpStatus; }
  get reason() { return this.#reason; }
  get rpcCode() { return this.#rpcCode; }
  get rpcMethod() { return this.#rpcMethod; }
}

export class RpcResponseRejectedError extends Error {
  #httpStatus;
  #reason;
  #rpcCode;
  #rpcMethod;

  constructor(reason, { httpStatus, rpcCode, rpcMethod } = {}) {
    if (!rpcResponseRejectionReasons.has(reason)) throw new Error("RPC response rejection reason is invalid.");
    const hasHttpStatus = Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599;
    if ((reason === "http_rejected") !== hasHttpStatus) {
      throw new Error("RPC rejected HTTP status is invalid.");
    }
    if ((reason === "rpc_error") !== Number.isSafeInteger(rpcCode)) {
      throw new Error("RPC rejected error code is invalid.");
    }
    if (!admittedRpcMethods.has(rpcMethod)) {
      throw new Error("RPC rejected method is invalid.");
    }
    super("RPC response was rejected.");
    this.name = "RpcResponseRejectedError";
    this.#reason = reason;
    this.#httpStatus = httpStatus;
    this.#rpcCode = rpcCode;
    this.#rpcMethod = rpcMethod;
  }

  get httpStatus() { return this.#httpStatus; }
  get reason() { return this.#reason; }
  get rpcCode() { return this.#rpcCode; }
  get rpcMethod() { return this.#rpcMethod; }
}
