const utcInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;

export function parseUtcInstant(value, label, minuteAligned = false) {
  if (typeof value !== "string" || !utcInstantPattern.test(value)) {
    throw new Error(`${label} must be a canonical UTC instant.`);
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} has an invalid UTC boundary.`);
  }
  if (minuteAligned && milliseconds % 60_000 !== 0) throw new Error(`${label} must be minute-aligned.`);
  return milliseconds;
}

export function parseUtcInstantSeconds(value, label, minuteAligned = false) {
  return parseUtcInstant(value, label, minuteAligned) / 1_000;
}

export function formatUtcInstant(timestampSeconds, label = "Unix timestamp") {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  const milliseconds = timestampSeconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`${label} is outside the canonical UTC instant range.`);
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is outside the canonical UTC instant range.`);
  }
  const value = date.toISOString();
  if (!utcInstantPattern.test(value)) {
    throw new Error(`${label} is outside the canonical UTC instant range.`);
  }
  return value;
}

export function validateUnixTimestampSeconds(value, label = "Unix timestamp") {
  formatUtcInstant(value, label);
  return value;
}
