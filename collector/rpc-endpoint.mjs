export const maximumRpcEndpointCount = 3;
export const maximumRpcBatchSize = 100;

export function admitRpcUrl(value, label = "RPC URL") {
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
