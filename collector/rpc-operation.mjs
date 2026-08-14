import { collectIndex, repairIndex } from "./process.mjs";
import { maximumRpcEndpointCount, RpcEndpointUnavailableError } from "./rpc-endpoint.mjs";

const operationOwners = new Map([
  ["collect", collectIndex],
  ["repair", repairIndex],
]);

export async function runRpcIndexOperation({ operation, registry, group, store, rpcClients, signal }) {
  const owner = operationOwners.get(operation);
  if (!owner) throw new Error("RPC index operation must be collect or repair.");
  if (!Array.isArray(rpcClients) || rpcClients.length === 0 || rpcClients.length > maximumRpcEndpointCount || rpcClients.some((rpc) => rpc === null || typeof rpc !== "object")) {
    throw new Error("RPC endpoint set is invalid.");
  }

  for (const rpc of rpcClients) {
    signal?.throwIfAborted();
    try {
      return await owner({ registry, group, store, rpc, signal });
    } catch (error) {
      if (!(error instanceof RpcEndpointUnavailableError)) throw error;
    }
  }

  throw new Error("All RPC endpoints were unavailable.");
}
