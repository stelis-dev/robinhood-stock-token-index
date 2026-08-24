import { resolutionDefinition } from "./candle-resolution.mjs";
import { isCanonicalBytes32 } from "./hex-data.mjs";
import { validateUtcDay, validateUtcMonth } from "./utc-time.mjs";

export const pairDayResolutionLabel = resolutionDefinition("1m").label;

function canonicalPeriod(value, kind, label) {
  return kind === "month" ? validateUtcMonth(value, label) : validateUtcDay(value, label);
}

function pairId(value) {
  if (!isCanonicalBytes32(value)) throw new Error("File pair ID is invalid.");
  return value;
}

export function pairMonthLogicalId(value, ownerMonth) {
  return `pairs/${pairId(value)}/months/${canonicalPeriod(ownerMonth, "month", "Pair month")}`;
}

export function pairDayLogicalId(value, day) {
  return `pairs/${pairId(value)}/days/${canonicalPeriod(day, "day", "Pair day")}`;
}

export function pairResolutionLogicalId(value, ownerMonth, intervalSeconds) {
  const definition = resolutionDefinition(intervalSeconds, { derivedOnly: true });
  return `${pairMonthLogicalId(value, ownerMonth)}/resolutions/${definition.intervalSeconds}`;
}

export function parsePairFileLogicalId(value) {
  if (typeof value !== "string") throw new Error("File logical ID is invalid.");
  const resolution = value.match(/^pairs\/(0x[0-9a-f]{64})\/months\/(\d{4}-\d{2})\/resolutions\/([1-9][0-9]*)$/);
  if (resolution !== null) {
    const definition = resolutionDefinition(Number(resolution[3]), { derivedOnly: true });
    return {
      pairId: pairId(resolution[1]),
      kind: "resolution",
      period: canonicalPeriod(resolution[2], "month", "Resolution owner month"),
      intervalSeconds: definition.intervalSeconds,
      label: definition.label,
    };
  }
  const reference = value.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/);
  if (reference === null) throw new Error("File logical ID is invalid.");
  const kind = reference[2] === "months" ? "month" : "day";
  return {
    pairId: pairId(reference[1]),
    kind,
    period: canonicalPeriod(reference[3], kind, `Pair ${kind}`),
  };
}
