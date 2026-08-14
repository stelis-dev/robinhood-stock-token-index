import { collectPairCurrent, collectPairHistory, repairPairIndex } from "./process.mjs";
import { maximumRpcEndpointCount, RpcEndpointUnavailableError } from "./rpc-endpoint.mjs";

const operationOwners = new Map([
  ["current", collectPairCurrent],
  ["history", collectPairHistory],
  ["repair", repairPairIndex],
]);

export async function runRpcPairOperation({ operation, registry, pairId, store, rpcClients, signal }) {
  const owner = operationOwners.get(operation);
  if (!owner) throw new Error("RPC pair operation must be current, history, or repair.");
  if (!Array.isArray(rpcClients) || rpcClients.length === 0 || rpcClients.length > maximumRpcEndpointCount || rpcClients.some((rpc) => rpc === null || typeof rpc !== "object")) {
    throw new Error("RPC endpoint set is invalid.");
  }

  for (let endpointIndex = 0; endpointIndex < rpcClients.length; endpointIndex += 1) {
    signal?.throwIfAborted();
    try {
      return {
        result: await owner({ registry, pairId, store, rpc: rpcClients[endpointIndex], signal }),
        selectedEndpointIndex: endpointIndex,
      };
    } catch (error) {
      if (!(error instanceof RpcEndpointUnavailableError)) throw error;
    }
  }
  throw new Error("All RPC endpoints were unavailable.");
}
