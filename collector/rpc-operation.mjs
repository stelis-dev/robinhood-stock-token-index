import { recoverPairPublication } from "./publication.mjs";
import { runPairCurrentAttempt, runPairHistoryAttempt, runPairRepairAttempt } from "./process.mjs";
import {
  maximumRpcEndpointCount,
  RpcEndpointUnavailableError,
  RpcResponseRejectedError,
} from "./rpc-endpoint.mjs";

const operationHandlers = new Map([
  ["current", runPairCurrentAttempt],
  ["history", runPairHistoryAttempt],
  ["repair", runPairRepairAttempt],
]);

export class RpcPairOperationUnavailableError extends Error {
  constructor() {
    super("All RPC endpoints were unavailable.");
    this.name = "RpcPairOperationUnavailableError";
  }
}

export function rpcEndpointFailureFacts(error) {
  if (!(error instanceof RpcEndpointUnavailableError) && !(error instanceof RpcResponseRejectedError)) return null;
  return Object.freeze({
    reason: error.reason,
    rpcMethod: error.rpcMethod ?? null,
    httpStatus: error.httpStatus ?? null,
    rpcCode: error.rpcCode ?? null,
  });
}

function rpcFailureFields(failure) {
  const rpcMethod = failure.rpcMethod === null ? "" : ` rpc_method=${failure.rpcMethod}`;
  const httpStatus = failure.httpStatus === null ? "" : ` http_status=${failure.httpStatus}`;
  const rpcCode = failure.rpcCode === null ? "" : ` rpc_code=${failure.rpcCode}`;
  return `component=rpc reason=${failure.reason}${rpcMethod}${httpStatus}${rpcCode}`;
}

export function rpcOperationFailureFields(error) {
  if (error instanceof RpcPairOperationUnavailableError) {
    return "component=rpc reason=all_endpoints_unavailable";
  }
  const failure = rpcEndpointFailureFacts(error);
  return failure === null ? null : rpcFailureFields(failure);
}

export function createFinalizedBoundary() {
  return Object.seal({ block: null });
}

export async function runRpcPairOperation({
  operation,
  registry,
  pairId,
  store,
  rpcClients,
  finalizedBoundary = createFinalizedBoundary(),
  onEndpointFailure,
  onRecovery,
  signal,
}) {
  const handler = operationHandlers.get(operation);
  if (!handler) throw new Error("RPC pair operation must be current, history, or repair.");
  if (!Array.isArray(rpcClients) || rpcClients.length === 0 || rpcClients.length > maximumRpcEndpointCount || rpcClients.some((rpc) => rpc === null || typeof rpc !== "object")) {
    throw new Error("RPC endpoint set is invalid.");
  }
  if (typeof onRecovery !== "undefined" && typeof onRecovery !== "function") {
    throw new Error("Publication recovery observer is invalid.");
  }
  if (typeof onEndpointFailure !== "undefined" && typeof onEndpointFailure !== "function") {
    throw new Error("RPC endpoint failure observer is invalid.");
  }

  const recovery = await recoverPairPublication({ registry, pairId, store });
  onRecovery?.(recovery);

  for (let endpointIndex = 0; endpointIndex < rpcClients.length; endpointIndex += 1) {
    signal?.throwIfAborted();
    try {
      const completed = await handler({
        registry,
        pairId,
        store,
        rpc: rpcClients[endpointIndex],
        finalizedBoundary,
        signal,
      });
      return {
        ...completed,
        selectedEndpointIndex: endpointIndex,
        recovery,
      };
    } catch (error) {
      const failure = rpcEndpointFailureFacts(error);
      if (failure !== null) onEndpointFailure?.(Object.freeze({ endpointIndex, error }));
      if (!(error instanceof RpcEndpointUnavailableError)) throw error;
    }
  }
  throw new RpcPairOperationUnavailableError();
}
