import { isCanonicalAddress } from "./hex-data.mjs";
import { resolutionDefinition } from "./candle-resolution.mjs";
import { validateUtcDay, validateUtcMonth } from "./utc-time.mjs";

function baseAddress(value) {
  if (!isCanonicalAddress(value)) throw new Error("Market-data base currency address is invalid.");
  return value;
}

export function baseStateLogicalId(address) {
  return `base/${baseAddress(address)}/state`;
}

export function baseMonthLogicalId(address, month) {
  return `base/${baseAddress(address)}/month/${validateUtcMonth(month, "Base owner month")}`;
}

export function baseDayLogicalId(address, day) {
  return `base/${baseAddress(address)}/day/${validateUtcDay(day, "Base owner day")}`;
}

export function baseResolutionLogicalId(address, resolution, month) {
  const definition = resolutionDefinition(resolution, { derivedOnly: true });
  return `base/${baseAddress(address)}/resolution/${definition.label}/${validateUtcMonth(month, "Resolution owner month")}`;
}

export function parseMarketDataLogicalId(value) {
  if (typeof value !== "string") throw new Error("Market-data logical ID is invalid.");
  const state = value.match(/^base\/(0x[0-9a-f]{40})\/state$/u);
  if (state !== null) return { baseCurrencyAddress: baseAddress(state[1]), kind: "state" };
  const period = value.match(/^base\/(0x[0-9a-f]{40})\/(month|day)\/(.+)$/u);
  if (period !== null) {
    const kind = period[2];
    return {
      baseCurrencyAddress: baseAddress(period[1]),
      kind,
      period: kind === "month"
        ? validateUtcMonth(period[3], "Base owner month")
        : validateUtcDay(period[3], "Base owner day"),
    };
  }
  const resolution = value.match(/^base\/(0x[0-9a-f]{40})\/resolution\/([^/]+)\/(\d{4}-\d{2})$/u);
  if (resolution !== null) {
    const definition = resolutionDefinition(resolution[2], { derivedOnly: true });
    return {
      baseCurrencyAddress: baseAddress(resolution[1]),
      intervalSeconds: definition.intervalSeconds,
      kind: "resolution",
      period: validateUtcMonth(resolution[3], "Resolution owner month"),
      resolution: definition.label,
    };
  }
  throw new Error("Market-data logical ID is invalid.");
}
