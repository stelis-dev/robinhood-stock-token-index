import { canonicalJson } from "./canonical.mjs";
import { isCanonicalBytes32 } from "./hex-data.mjs";
import { admitPoolKey } from "./pool-key.mjs";
import { parseUtcInstant, subtractUtcCalendarMonths } from "./utc-time.mjs";

const minuteMilliseconds = 60_000;
const maximumSliceMilliseconds = 15 * minuteMilliseconds;
const dayMilliseconds = 86_400_000;
const unsignedDecimalPattern = /^(?:0|[1-9][0-9]*)$/u;

export class SharedCollectionPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "SharedCollectionPlanError";
    this.reason = "collection_plan_invalid";
  }
}

function reject(message) {
  throw new SharedCollectionPlanError(message);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(`${label} has an invalid member set.`);
  }
}

function decimalString(value, label) {
  if (typeof value !== "string" || !unsignedDecimalPattern.test(value)) {
    reject(`${label} must be a canonical unsigned decimal string.`);
  }
  return BigInt(value);
}

function minuteTimestamp(value, label) {
  try {
    return parseUtcInstant(value, label, true);
  } catch {
    reject(`${label} is invalid.`);
  }
}

function instant(value, label) {
  try {
    return parseUtcInstant(value, label);
  } catch {
    reject(`${label} is invalid.`);
  }
}

function boundary(value, label) {
  exactKeys(value, ["blockNumber", "timestamp"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  minuteTimestamp(value.timestamp, `${label}.timestamp`);
  return Object.freeze({ ...value });
}

function initializeFact(value, label) {
  exactKeys(value, ["blockNumber", "timestamp"], label);
  decimalString(value.blockNumber, `${label}.blockNumber`);
  instant(value.timestamp, `${label}.timestamp`);
  return Object.freeze({ ...value });
}

function coverageSegment(value, label) {
  exactKeys(
    value,
    ["fromBlock", "fromTimestamp", "poolId", "untilBlock", "untilTimestamp"],
    label,
  );
  const fromBlock = decimalString(value.fromBlock, `${label}.fromBlock`);
  const untilBlock = decimalString(value.untilBlock, `${label}.untilBlock`);
  const fromTime = minuteTimestamp(value.fromTimestamp, `${label}.fromTimestamp`);
  const untilTime = minuteTimestamp(value.untilTimestamp, `${label}.untilTimestamp`);
  if (!isCanonicalBytes32(value.poolId) || fromBlock > untilBlock || fromTime >= untilTime) {
    reject(`${label} is invalid.`);
  }
  return Object.freeze({ ...value });
}

function configurationBases(configuration) {
  if (
    configuration === null
    || typeof configuration !== "object"
    || !Array.isArray(configuration.bases)
    || typeof configuration.usdgAddress !== "string"
  ) {
    reject("Admitted market-data configuration is invalid.");
  }
  return new Map(configuration.bases.map((base) => [base.baseCurrencyAddress, base]));
}

function validatePoolFacts(value, { baseCurrencyAddress, usdgAddress, poolId, label }) {
  exactKeys(value, ["historyFrom", "initialize", "poolKey", "sourceFrom"], label);
  const historyFrom = boundary(value.historyFrom, `${label}.historyFrom`);
  const initialize = initializeFact(value.initialize, `${label}.initialize`);
  const sourceFrom = boundary(value.sourceFrom, `${label}.sourceFrom`);
  let poolKey;
  try {
    poolKey = admitPoolKey(value.poolKey, {
      baseCurrencyAddress,
      poolId,
      quoteCurrencyAddress: usdgAddress,
    }).poolKey;
  } catch {
    reject(`${label}.poolKey is invalid.`);
  }
  const initializeMinute = Math.floor(Date.parse(initialize.timestamp) / minuteMilliseconds) * minuteMilliseconds;
  if (
    Date.parse(sourceFrom.timestamp) < initializeMinute
    || Date.parse(sourceFrom.timestamp) > Date.parse(initialize.timestamp)
      && BigInt(sourceFrom.blockNumber) <= BigInt(initialize.blockNumber)
    || historyFrom.timestamp < sourceFrom.timestamp
    || BigInt(historyFrom.blockNumber) < BigInt(sourceFrom.blockNumber)
  ) {
    reject(`${label} boundaries are inverted.`);
  }
  return Object.freeze({ historyFrom, initialize, poolKey, sourceFrom });
}

export function validateSharedCollectionState(value, configuration) {
  const configuredBases = configurationBases(configuration);
  if (value === null) return null;
  exactKeys(
    value,
    ["baseCurrencies", "currentUntil", "poolManager", "usdgAddress", "usdgDecimals"],
    "Shared collection state",
  );
  if (
    value.poolManager !== configuration.poolManager
    || value.usdgAddress !== configuration.usdgAddress
    || value.usdgDecimals !== configuration.usdgDecimals
  ) {
    reject("Shared collection global market-data facts changed.");
  }
  const currentUntil = boundary(value.currentUntil, "Shared collection currentUntil");
  if (
    value.baseCurrencies === null
    || typeof value.baseCurrencies !== "object"
    || Array.isArray(value.baseCurrencies)
  ) {
    reject("Shared collection base currencies must be an object.");
  }
  const admittedBases = {};
  const poolOwners = new Map(configuration.bases.map((base) => [
    base.poolId,
    base.baseCurrencyAddress,
  ]));
  for (const [baseCurrencyAddress, baseState] of Object.entries(value.baseCurrencies)) {
    const configured = configuredBases.get(baseCurrencyAddress);
    if (configured === undefined) reject("Selected base currency is absent from configuration.");
    exactKeys(baseState, ["decimals", "poolPeriods", "pools"], `State base ${baseCurrencyAddress}`);
    if (baseState.decimals !== configured.decimals) reject("Selected base currency decimals changed.");
    if (
      baseState.pools === null
      || typeof baseState.pools !== "object"
      || Array.isArray(baseState.pools)
      || Object.keys(baseState.pools).length === 0
    ) {
      reject(`State base ${baseCurrencyAddress} pools are invalid.`);
    }
    const pools = {};
    for (const [poolId, facts] of Object.entries(baseState.pools)) {
      if (!isCanonicalBytes32(poolId)) reject(`State base ${baseCurrencyAddress} PoolId is invalid.`);
      const poolOwner = poolOwners.get(poolId);
      if (poolOwner !== undefined && poolOwner !== baseCurrencyAddress) {
        reject("One PoolId cannot belong to two base currencies.");
      }
      poolOwners.set(poolId, baseCurrencyAddress);
      pools[poolId] = validatePoolFacts(facts, {
        baseCurrencyAddress,
        usdgAddress: configuration.usdgAddress,
        poolId,
        label: `State base ${baseCurrencyAddress} pool ${poolId}`,
      });
      if (
        configured.poolId === poolId
        && (
          canonicalJson(configured.poolKey) !== canonicalJson(pools[poolId].poolKey)
          || canonicalJson(configured.initialize) !== canonicalJson(pools[poolId].initialize)
        )
      ) {
        reject(`State base ${baseCurrencyAddress} current PoolId facts changed.`);
      }
    }
    if (!Array.isArray(baseState.poolPeriods) || baseState.poolPeriods.length === 0) {
      reject(`State base ${baseCurrencyAddress} pool periods are invalid.`);
    }
    const poolPeriods = baseState.poolPeriods.map((period, index) => {
      const admitted = coverageSegment(period, `State base ${baseCurrencyAddress} poolPeriods[${index}]`);
      if (pools[admitted.poolId] === undefined) {
        reject(`State base ${baseCurrencyAddress} period PoolId has no facts.`);
      }
      return admitted;
    });
    for (let index = 1; index < poolPeriods.length; index += 1) {
      const previous = poolPeriods[index - 1];
      const current = poolPeriods[index];
      if (
        previous.untilTimestamp !== current.fromTimestamp
        || previous.untilBlock !== current.fromBlock
      ) {
        reject(`State base ${baseCurrencyAddress} pool periods are not continuous.`);
      }
    }
    const lastPeriod = poolPeriods.at(-1);
    if (
      lastPeriod.untilTimestamp !== currentUntil.timestamp
      || lastPeriod.untilBlock !== currentUntil.blockNumber
    ) {
      reject(`State base ${baseCurrencyAddress} current boundary is inconsistent.`);
    }
    if (
      lastPeriod.poolId !== configured.poolId
      && (
        floorMinuteTimestamp(configured.initialize.timestamp) > currentUntil.timestamp
        || BigInt(configured.initialize.blockNumber) > BigInt(currentUntil.blockNumber)
      )
    ) {
      reject(`Configured PoolId change for ${baseCurrencyAddress} begins after the current boundary.`);
    }
    for (const [poolId, facts] of Object.entries(pools)) {
      const periods = poolPeriods.filter((period) => period.poolId === poolId);
      if (periods.length === 0) reject(`State base ${baseCurrencyAddress} has unused pool facts.`);
      if (
        periods[0].fromTimestamp !== facts.historyFrom.timestamp
        || periods[0].fromBlock !== facts.historyFrom.blockNumber
      ) {
        reject(`State base ${baseCurrencyAddress} history boundary is inconsistent.`);
      }
    }
    admittedBases[baseCurrencyAddress] = Object.freeze({
      decimals: baseState.decimals,
      poolPeriods: Object.freeze(poolPeriods),
      pools: Object.freeze(pools),
    });
  }
  if (Object.keys(admittedBases).length === 0) reject("A selected root cannot contain no base currency.");
  return Object.freeze({
    baseCurrencies: Object.freeze(admittedBases),
    currentUntil,
    poolManager: value.poolManager,
    usdgAddress: value.usdgAddress,
    usdgDecimals: value.usdgDecimals,
  });
}

function maximumTimestamp(...values) {
  return values.reduce((maximum, value) => value > maximum ? value : maximum);
}

function floorMinuteTimestamp(value) {
  return new Date(Math.floor(Date.parse(value) / minuteMilliseconds) * minuteMilliseconds).toISOString();
}

function startOfUtcDay(value) {
  return new Date(Math.floor(Date.parse(value) / dayMilliseconds) * dayMilliseconds).toISOString();
}

function addWork(work, { baseCurrencyAddress, kind, poolId, fromTimestamp, untilTimestamp }) {
  if (fromTimestamp >= untilTimestamp) return;
  work.push(Object.freeze({ baseCurrencyAddress, kind, poolId, fromTimestamp, untilTimestamp }));
}

function sharedRanges(work) {
  if (work.length === 0) return Object.freeze([]);
  const boundaries = [...new Set(work.flatMap((entry) => [entry.fromTimestamp, entry.untilTimestamp]))].sort();
  const ranges = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const fromTimestamp = boundaries[index - 1];
    const untilTimestamp = boundaries[index];
    const poolIds = [...new Set(work.filter((entry) => (
      entry.fromTimestamp <= fromTimestamp && entry.untilTimestamp >= untilTimestamp
    )).map((entry) => entry.poolId))].sort();
    if (poolIds.length === 0) continue;
    const previous = ranges.at(-1);
    if (
      previous !== undefined
      && previous.untilTimestamp === fromTimestamp
      && JSON.stringify(previous.poolIds) === JSON.stringify(poolIds)
    ) {
      ranges[ranges.length - 1] = Object.freeze({
        fromTimestamp: previous.fromTimestamp,
        untilTimestamp,
        poolIds: previous.poolIds,
      });
    } else {
      ranges.push(Object.freeze({ fromTimestamp, untilTimestamp, poolIds: Object.freeze(poolIds) }));
    }
  }
  return Object.freeze(ranges);
}

function historyComponents(candidates) {
  const ordered = [...candidates].sort((left, right) => (
    left.fromTimestamp.localeCompare(right.fromTimestamp)
    || left.untilTimestamp.localeCompare(right.untilTimestamp)
    || left.poolId.localeCompare(right.poolId)
  ));
  const components = [];
  for (const candidate of ordered) {
    const previous = components.at(-1);
    if (previous === undefined || candidate.fromTimestamp >= previous.untilTimestamp) {
      components.push({ untilTimestamp: candidate.untilTimestamp, entries: [candidate] });
      continue;
    }
    previous.entries.push(candidate);
    if (candidate.untilTimestamp > previous.untilTimestamp) previous.untilTimestamp = candidate.untilTimestamp;
  }
  return components;
}

function selectedHistoryWork(state, retentionLowerBound) {
  const candidates = [];
  for (const [baseCurrencyAddress, baseState] of Object.entries(state.baseCurrencies)) {
    for (const [poolId, facts] of Object.entries(baseState.pools)) {
      const untilTimestamp = facts.historyFrom.timestamp;
      const lowerTimestamp = maximumTimestamp(
        facts.sourceFrom.timestamp,
        floorMinuteTimestamp(facts.initialize.timestamp),
        retentionLowerBound,
      );
      if (untilTimestamp <= lowerTimestamp) continue;
      const fromTimestamp = maximumTimestamp(
        new Date(Date.parse(untilTimestamp) - maximumSliceMilliseconds).toISOString(),
        startOfUtcDay(new Date(Date.parse(untilTimestamp) - 1).toISOString()),
        lowerTimestamp,
      );
      candidates.push(Object.freeze({
        baseCurrencyAddress,
        kind: "history",
        poolId,
        fromTimestamp,
        untilTimestamp,
      }));
    }
  }
  const components = historyComponents(candidates);
  if (components.length === 0) return [];
  components.sort((left, right) => {
    const until = right.untilTimestamp.localeCompare(left.untilTimestamp);
    if (until !== 0) return until;
    const leftId = [...left.entries].map((entry) => entry.poolId).sort().join("\0");
    const rightId = [...right.entries].map((entry) => entry.poolId).sort().join("\0");
    return leftId.localeCompare(rightId);
  });
  return components[0].entries;
}

function validateTarget(value) {
  return boundary(value, "Shared collection target");
}

export function validateSharedCollectionRepair(value, state) {
  exactKeys(
    value,
    ["baseCurrencyAddress", "fromBlock", "fromTimestamp", "poolId", "untilBlock", "untilTimestamp"],
    "Shared collection repair",
  );
  const segment = coverageSegment({
    fromBlock: value.fromBlock,
    fromTimestamp: value.fromTimestamp,
    poolId: value.poolId,
    untilBlock: value.untilBlock,
    untilTimestamp: value.untilTimestamp,
  }, "Shared collection repair");
  if (Date.parse(segment.untilTimestamp) - Date.parse(segment.fromTimestamp) > maximumSliceMilliseconds) {
    reject("Shared collection repair exceeds fifteen minutes.");
  }
  if (
    segment.fromTimestamp.slice(0, 10)
      !== new Date(Date.parse(segment.untilTimestamp) - 1).toISOString().slice(0, 10)
  ) {
    reject("Shared collection repair must stay inside one UTC day.");
  }
  const baseState = state?.baseCurrencies[value.baseCurrencyAddress];
  if (baseState === undefined || !baseState.poolPeriods.some((period) => (
    period.poolId === segment.poolId
    && period.fromTimestamp <= segment.fromTimestamp
    && period.untilTimestamp >= segment.untilTimestamp
    && BigInt(period.fromBlock) <= BigInt(segment.fromBlock)
    && BigInt(period.untilBlock) >= BigInt(segment.untilBlock)
  ))) {
    reject("Shared collection repair is outside selected coverage.");
  }
  return Object.freeze({ baseCurrencyAddress: value.baseCurrencyAddress, ...segment });
}

export function planSharedCollectionPhase({ configuration, state: stateValue, target: targetValue, repair = null }) {
  const configuredBases = configurationBases(configuration);
  const state = validateSharedCollectionState(stateValue, configuration);
  const target = validateTarget(targetValue);
  const targetTime = Date.parse(target.timestamp);
  if (state !== null && Date.parse(state.currentUntil.timestamp) > targetTime) {
    reject("Shared collection target precedes selected current coverage.");
  }
  if (repair !== null) {
    const admittedRepair = validateSharedCollectionRepair(repair, state);
    const work = Object.freeze([Object.freeze({
      baseCurrencyAddress: admittedRepair.baseCurrencyAddress,
      fromBlock: admittedRepair.fromBlock,
      kind: "repair",
      poolId: admittedRepair.poolId,
      fromTimestamp: admittedRepair.fromTimestamp,
      untilBlock: admittedRepair.untilBlock,
      untilTimestamp: admittedRepair.untilTimestamp,
    })]);
    return Object.freeze({ phase: "repair", target, work, ranges: sharedRanges(work) });
  }

  const work = [];
  const currentFrom = state?.currentUntil.timestamp;
  const hasCurrentGap = currentFrom !== undefined && currentFrom < target.timestamp;
  let currentUntil = null;
  if (hasCurrentGap) {
    currentUntil = new Date(Math.min(
      targetTime,
      Date.parse(currentFrom) + maximumSliceMilliseconds,
      (Math.floor(Date.parse(currentFrom) / dayMilliseconds) + 1) * dayMilliseconds,
    )).toISOString();
    for (const [baseCurrencyAddress, baseState] of Object.entries(state.baseCurrencies)) {
      const configuredBase = configuredBases.get(baseCurrencyAddress);
      addWork(work, {
        baseCurrencyAddress,
        kind: "current",
        poolId: configuredBase.poolId,
        fromTimestamp: currentFrom,
        untilTimestamp: currentUntil,
      });
    }
  }

  const initialUntil = hasCurrentGap ? currentUntil : target.timestamp;
  const initialUntilTime = Date.parse(initialUntil);
  const initialRetentionLowerBound = subtractUtcCalendarMonths(initialUntil, 12);
  for (const base of configuration.bases) {
    if (state?.baseCurrencies[base.baseCurrencyAddress] !== undefined) continue;
    const initializeMinute = floorMinuteTimestamp(base.initialize.timestamp);
    if (
      initializeMinute < target.timestamp
      && BigInt(base.initialize.blockNumber) > BigInt(target.blockNumber)
    ) {
      reject(`Base currency ${base.baseCurrencyAddress} Initialize block exceeds its target.`);
    }
    const fromTimestamp = maximumTimestamp(
      new Date(initialUntilTime - maximumSliceMilliseconds).toISOString(),
      startOfUtcDay(new Date(initialUntilTime - 1).toISOString()),
      initializeMinute,
      initialRetentionLowerBound,
    );
    addWork(work, {
      baseCurrencyAddress: base.baseCurrencyAddress,
      kind: "initial",
      poolId: base.poolId,
      fromTimestamp,
      untilTimestamp: initialUntil,
    });
  }

  if (work.length !== 0) {
    const admittedWork = Object.freeze(work.sort((left, right) => (
      left.fromTimestamp.localeCompare(right.fromTimestamp)
      || left.untilTimestamp.localeCompare(right.untilTimestamp)
      || left.poolId.localeCompare(right.poolId)
      || left.baseCurrencyAddress.localeCompare(right.baseCurrencyAddress)
    )));
    return Object.freeze({ phase: "current", target, work: admittedWork, ranges: sharedRanges(admittedWork) });
  }

  if (state === null) {
    return Object.freeze({ phase: "idle", target, work: Object.freeze([]), ranges: Object.freeze([]) });
  }
  const retentionLowerBound = subtractUtcCalendarMonths(target.timestamp, 12);
  const historyWork = selectedHistoryWork(state, retentionLowerBound);
  if (historyWork.length === 0) {
    return Object.freeze({ phase: "idle", target, work: Object.freeze([]), ranges: Object.freeze([]) });
  }
  const admittedHistory = Object.freeze([...historyWork].sort((left, right) => (
    left.fromTimestamp.localeCompare(right.fromTimestamp)
    || left.untilTimestamp.localeCompare(right.untilTimestamp)
    || left.poolId.localeCompare(right.poolId)
    || left.baseCurrencyAddress.localeCompare(right.baseCurrencyAddress)
  )));
  return Object.freeze({ phase: "history", target, work: admittedHistory, ranges: sharedRanges(admittedHistory) });
}

export const sharedCollectionSliceSeconds = maximumSliceMilliseconds / 1_000;
