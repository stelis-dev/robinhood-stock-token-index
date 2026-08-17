import { collectPairCurrent, collectPairHistory, repairPairIndex } from "./process.mjs";
import {
  maximumRpcEndpointCount,
  RpcEndpointUnavailableError,
  RpcResponseRejectedError,
} from "./rpc-endpoint.mjs";

const operationHandlers = new Map([
  ["current", collectPairCurrent],
  ["history", collectPairHistory],
  ["repair", repairPairIndex],
]);

export class RpcPairOperationUnavailableError extends Error {
  constructor() {
    super("All RPC endpoints were unavailable.");
    this.name = "RpcPairOperationUnavailableError";
  }
}

export function rpcOperationFailureFields(error) {
  if (error instanceof RpcPairOperationUnavailableError) {
    return "component=rpc reason=all_endpoints_unavailable";
  }
  if (!(error instanceof RpcResponseRejectedError)) return null;
  const httpStatus = error.httpStatus === undefined ? "" : ` http_status=${error.httpStatus}`;
  const rpcCode = error.rpcCode === undefined ? "" : ` rpc_code=${error.rpcCode}`;
  return `component=rpc reason=${error.reason}${httpStatus}${rpcCode}`;
}

export async function runRpcPairOperation({ operation, registry, pairId, store, rpcClients, signal }) {
  const handler = operationHandlers.get(operation);
  if (!handler) throw new Error("RPC pair operation must be current, history, or repair.");
  if (!Array.isArray(rpcClients) || rpcClients.length === 0 || rpcClients.length > maximumRpcEndpointCount || rpcClients.some((rpc) => rpc === null || typeof rpc !== "object")) {
    throw new Error("RPC endpoint set is invalid.");
  }

  for (let endpointIndex = 0; endpointIndex < rpcClients.length; endpointIndex += 1) {
    signal?.throwIfAborted();
    try {
      return {
        result: await handler({ registry, pairId, store, rpc: rpcClients[endpointIndex], signal }),
        selectedEndpointIndex: endpointIndex,
      };
    } catch (error) {
      if (!(error instanceof RpcEndpointUnavailableError)) throw error;
    }
  }
  throw new RpcPairOperationUnavailableError();
}
