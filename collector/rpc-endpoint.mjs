export const maximumRpcEndpointCount = 3;
export const maximumRpcBatchSize = 100;

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
  constructor() {
    super("RPC endpoint is unavailable.");
    this.name = "RpcEndpointUnavailableError";
  }
}

export class RpcResponseRejectedError extends Error {
  #httpStatus;
  #reason;
  #rpcCode;

  constructor(reason, { httpStatus, rpcCode } = {}) {
    if (!rpcResponseRejectionReasons.has(reason)) throw new Error("RPC response rejection reason is invalid.");
    const hasHttpStatus = Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599;
    if ((reason === "http_rejected") !== hasHttpStatus) {
      throw new Error("RPC rejected HTTP status is invalid.");
    }
    if ((reason === "rpc_error") !== Number.isSafeInteger(rpcCode)) {
      throw new Error("RPC rejected error code is invalid.");
    }
    super("RPC response was rejected.");
    this.name = "RpcResponseRejectedError";
    this.#reason = reason;
    this.#httpStatus = httpStatus;
    this.#rpcCode = rpcCode;
  }

  get httpStatus() { return this.#httpStatus; }
  get reason() { return this.#reason; }
  get rpcCode() { return this.#rpcCode; }
}
