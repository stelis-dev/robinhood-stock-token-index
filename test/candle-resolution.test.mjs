import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  affectedResolutionOwnerMonths,
  candleResolutionCatalog,
  createResolutionArtifacts,
  validateResolutionArtifact,
  validateResolutionCatalog,
} from "../collector/candle-resolution.mjs";
import { canonicalBytes } from "../collector/canonical.mjs";
import {
  createPairFileReference,
  decodePairMonthFile,
  decodePairStateFile,
  decodeResolutionArtifact,
  encodePairDayFile,
  encodePairMonthFile,
  encodePairStateFile,
  validatePairDayFile,
  validatePairMonthFile,
  validateSelectedPairMonth,
  validatePairStateFile,
  validateResolutionReference,
} from "../collector/pair-files.mjs";
import { pairResolutionLogicalId } from "../collector/pair-file-identity.mjs";
import { readPairMonthResolution, verifyPairIndex } from "../collector/pair-reader.mjs";
import {
  decodePairPublicationManifest,
  encodePairPublicationManifest,
  validatePairPublicationManifest,
} from "../collector/publication-manifest.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { createStateIdentity, StoredDataIntegrityError } from "../storage/stored-files.mjs";
import { fixturePairRegistry } from "./pair-fixtures.mjs";
import { createResolutionFixture } from "./resolution-fixtures.mjs";

function resolution(fixture, month, seconds) {
  const entry = fixture.resolutions.find((candidate) => (
    candidate.value.ownerMonth === month && candidate.value.intervalSeconds === seconds
  ));
  if (entry === undefined) throw new Error(`Missing fixture resolution ${month}:${seconds}`);
  return entry;
}

function resolutionArtifactForTest({ registry, pair, sequence = 1, ownerMonth, intervalSeconds, sourceCoverage, candles }) {
  return createResolutionArtifacts({
    registry,
    pair,
    sourceCoverage,
    candles,
    requests: [{
      sequence,
      ownerMonth,
      intervalSeconds,
      fromTimestamp: sourceCoverage.fromTimestamp,
      untilTimestamp: sourceCoverage.untilTimestamp,
    }],
  })[0].artifact;
}

async function fixtureStore(registry, prefix) {
  return new DirectoryStore({
    root: await mkdtemp(join(tmpdir(), prefix)),
    maximumArtifactBytes: registry.collection.maximumArtifactBytes,
  });
}

async function publishFixture(store, fixture, {
  days = fixture.days,
  months = fixture.months,
  state = fixture.state,
  encodedState = fixture.encodedState,
} = {}) {
  for (const entry of days) await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
  for (const entry of fixture.resolutions) await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
  for (const entry of months) await store.writeReferenced(entry.reference, entry.encoded.gzipBytes);
  await store.writeState(state.pair.pairId, state.sequence, encodedState.gzipBytes);
}

function compareRational(left, right) {
  const difference = BigInt(left.numerator) * BigInt(right.denominator)
    - BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function independentlyMaterialize(candles, sourceCoverage, ownerMonth, intervalSeconds) {
  const intervalMilliseconds = intervalSeconds * 1_000;
  const ownerFrom = Date.parse(`${ownerMonth}-01T00:00:00.000Z`);
  const ownerUntilDate = new Date(ownerFrom);
  ownerUntilDate.setUTCMonth(ownerUntilDate.getUTCMonth() + 1);
  const ownerUntil = ownerUntilDate.getTime();
  const sourceFrom = Date.parse(sourceCoverage.fromTimestamp);
  const sourceUntil = Date.parse(sourceCoverage.untilTimestamp);
  const completeStarts = [];
  for (let cursor = ownerFrom; cursor < ownerUntil; cursor += 60_000) {
    if (cursor % intervalMilliseconds === 0 && cursor >= sourceFrom && cursor + intervalMilliseconds <= sourceUntil) {
      completeStarts.push(cursor);
    }
  }
  if (completeStarts.length === 0) return null;
  const output = [];
  for (const intervalStart of completeStarts) {
    const intervalEnd = intervalStart + intervalMilliseconds;
    const source = candles.filter((candle) => (
      Date.parse(candle.intervalStart) >= intervalStart && Date.parse(candle.intervalEnd) <= intervalEnd
    ));
    if (source.length === 0) continue;
    let high = source[0].high;
    let low = source[0].low;
    let baseVolumeRaw = 0n;
    let quoteVolumeRaw = 0n;
    let tradeCount = 0n;
    for (const candle of source) {
      if (compareRational(candle.high, high) > 0) high = candle.high;
      if (compareRational(candle.low, low) < 0) low = candle.low;
      baseVolumeRaw += BigInt(candle.baseVolumeRaw);
      quoteVolumeRaw += BigInt(candle.quoteVolumeRaw);
      tradeCount += BigInt(candle.tradeCount);
    }
    output.push({
      intervalStart: new Date(intervalStart).toISOString(),
      intervalEnd: new Date(intervalEnd).toISOString(),
      open: source[0].open,
      high,
      low,
      close: source.at(-1).close,
      baseVolumeRaw: baseVolumeRaw.toString(),
      quoteVolumeRaw: quoteVolumeRaw.toString(),
      tradeCount: tradeCount.toString(),
      firstSource: source[0].firstSource,
      lastSource: source.at(-1).lastSource,
      observedStart: source[0].intervalStart,
      observedEnd: source.at(-1).intervalEnd,
      sourceCandleCount: source.length,
    });
  }
  return {
    timeCoverage: {
      fromTimestamp: new Date(completeStarts[0]).toISOString(),
      untilTimestamp: new Date(completeStarts.at(-1) + intervalMilliseconds).toISOString(),
    },
    candles: output,
  };
}

test("the fixed resolution catalog directly aggregates canonical one-minute candles", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  assert.deepEqual(validateResolutionCatalog(structuredClone(candleResolutionCatalog)), candleResolutionCatalog);
  assert.deepEqual(candleResolutionCatalog.map(({ label, intervalSeconds }) => [label, intervalSeconds]), [
    ["1m", 60],
    ["15m", 900],
    ["30m", 1_800],
    ["1h", 3_600],
    ["2h", 7_200],
    ["4h", 14_400],
    ["6h", 21_600],
    ["12h", 43_200],
    ["1d", 86_400],
    ["2d", 172_800],
  ]);
  assert.equal(Object.isFrozen(candleResolutionCatalog), true);
  assert.ok(candleResolutionCatalog.every(Object.isFrozen));
  assert.deepEqual(affectedResolutionOwnerMonths({
    fromTimestamp: "2026-09-01T00:00:00.000Z",
    untilTimestamp: "2026-09-01T00:01:00.000Z",
    intervalSeconds: 900,
  }), ["2026-09"]);
  assert.deepEqual(affectedResolutionOwnerMonths({
    fromTimestamp: "2026-09-01T00:00:00.000Z",
    untilTimestamp: "2026-09-01T00:01:00.000Z",
    intervalSeconds: 172_800,
  }), ["2026-08"]);

  for (const ownerMonth of ["2026-08", "2026-09"]) {
    for (const definition of candleResolutionCatalog.slice(1)) {
      const expected = independentlyMaterialize(
        fixture.sourceByMonth[ownerMonth].candles,
        fixture.sourceByMonth[ownerMonth].coverage,
        ownerMonth,
        definition.intervalSeconds,
      );
      const actual = fixture.resolutions.find((entry) => (
        entry.value.ownerMonth === ownerMonth
        && entry.value.intervalSeconds === definition.intervalSeconds
      ));
      if (expected === null) {
        assert.equal(actual, undefined, `${ownerMonth}:${definition.label} must remain unpublished`);
      } else {
        assert.deepEqual({ timeCoverage: actual.value.timeCoverage, candles: actual.value.candles }, expected);
      }
    }
  }

  const fifteen = resolution(fixture, "2026-08", 900).value;
  const first = fifteen.candles.find((candle) => candle.intervalStart === "2026-08-14T14:15:00.000Z");
  assert.deepEqual(first, {
    intervalStart: "2026-08-14T14:15:00.000Z",
    intervalEnd: "2026-08-14T14:30:00.000Z",
    open: { numerator: "300", denominator: "1" },
    high: { numerator: "320", denominator: "1" },
    low: { numerator: "290", denominator: "1" },
    close: { numerator: "292", denominator: "1" },
    baseVolumeRaw: "30000000000000000",
    quoteVolumeRaw: "9000000",
    tradeCount: "6",
    firstSource: fixture.candles[0].firstSource,
    lastSource: fixture.candles[2].lastSource,
    observedStart: "2026-08-14T14:16:00.000Z",
    observedEnd: "2026-08-14T14:19:00.000Z",
    sourceCandleCount: 3,
  });
  const intervalCount = (
    Date.parse(fifteen.timeCoverage.untilTimestamp) - Date.parse(fifteen.timeCoverage.fromTimestamp)
  ) / 900_000;
  assert.ok(fifteen.candles.length < intervalCount, "covered empty intervals must remain sparse");

  const hierarchicalInput = fifteen.candles.map(({ observedStart, observedEnd, sourceCandleCount, ...candle }) => ({
    ...candle,
    tradeCount: Number(candle.tradeCount),
  }));
  assert.throws(
    () => resolutionArtifactForTest({
      registry,
      pair: fixture.pair,
      candles: hierarchicalInput,
      sourceCoverage: fixture.sourceByMonth["2026-08"].coverage,
      ownerMonth: "2026-08",
      intervalSeconds: 1_800,
    }),
    /Candle interval is invalid/,
  );
  assert.throws(
    () => resolutionArtifactForTest({
      registry,
      pair: fixture.pair,
      candles: fixture.candles,
      sourceCoverage: fixture.sourceCoverage,
      ownerMonth: "2026-09",
      intervalSeconds: 900,
    }),
    /owner-month bound/,
  );
});

test("one multi-month closure independently admits every stored resolution", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  assert.equal(fixture.days.length, 20);
  assert.equal(fixture.months.length, 2);
  assert.equal(fixture.resolutions.length, 17);
  assert.deepEqual(decodePairStateFile(fixture.encodedState.gzipBytes, fixture.context, fixture.pair.pairId), fixture.state);
  for (const { value } of fixture.months) {
    assert.deepEqual(
      validateSelectedPairMonth({ state: fixture.state, month: value }, fixture.context),
      { state: fixture.state, month: value },
    );
  }

  for (const month of fixture.months) {
    assert.deepEqual(decodePairMonthFile(month.encoded.gzipBytes, fixture.context, month.reference), month.value);
  }
  for (const entry of fixture.resolutions) {
    assert.deepEqual(decodeResolutionArtifact(entry.encoded.gzipBytes, fixture.context, entry.reference), entry.value);
    assert.equal(entry.reference.logicalId, pairResolutionLogicalId(
      fixture.pair.pairId,
      entry.value.ownerMonth,
      entry.value.intervalSeconds,
    ));
  }

  const august = fixture.months.find((entry) => entry.value.month === "2026-08").value;
  const september = fixture.months.find((entry) => entry.value.month === "2026-09").value;
  const twoDay = resolution(fixture, "2026-08", 172_800).value;
  assert.equal(twoDay.timeCoverage.untilTimestamp, "2026-09-02T00:00:00.000Z");
  assert.ok(twoDay.candles.some((candle) => (
    candle.intervalStart === "2026-08-31T00:00:00.000Z"
    && candle.intervalEnd === "2026-09-02T00:00:00.000Z"
  )));
  assert.deepEqual(august.sourceMonths, [
    `pairs/${fixture.pair.pairId}/months/2026-08`,
    `pairs/${fixture.pair.pairId}/months/2026-09`,
  ]);
  assert.equal(september.resolutions.some((reference) => reference.intervalSeconds === 172_800), false);
});

test("resolution contracts reject altered catalogs, ownership, coverage, and source meaning", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  assert.throws(() => validateResolutionCatalog(candleResolutionCatalog.slice(1)), /catalog/);
  assert.throws(() => validatePairStateFile({
    ...fixture.state,
    resolutions: [...fixture.state.resolutions].reverse(),
  }, fixture.context), /catalog/);
  assert.throws(() => validatePairStateFile({ ...fixture.state, unsupported: "value" }, fixture.context), /member set/);
  assert.throws(
    () => validatePairDayFile({ ...fixture.days[0].value, unsupported: "value" }, fixture.context),
    /member set/,
  );

  const augustMonth = structuredClone(fixture.months.find((entry) => entry.value.month === "2026-08").value);
  augustMonth.sourceMonths.pop();
  assert.throws(() => validatePairMonthFile(augustMonth, fixture.context), /source months/);
  assert.throws(
    () => validatePairMonthFile({ ...fixture.months[0].value, unsupported: "value" }, fixture.context),
    /member set/,
  );
  const reversed = structuredClone(fixture.months.find((entry) => entry.value.month === "2026-08").value);
  reversed.resolutions.reverse();
  assert.throws(() => validatePairMonthFile(reversed, fixture.context), /unordered/);

  const missingResolution = structuredClone(fixture.months.find((entry) => entry.value.month === "2026-08").value);
  missingResolution.resolutions.shift();
  assert.throws(
    () => validateSelectedPairMonth({ state: fixture.state, month: missingResolution }, fixture.context),
    /availability/,
  );
  const incompleteResolution = structuredClone(fixture.months.find((entry) => entry.value.month === "2026-08").value);
  incompleteResolution.resolutions[0].timeCoverage.fromTimestamp = "2026-08-14T14:30:00.000Z";
  assert.throws(
    () => validateSelectedPairMonth({ state: fixture.state, month: incompleteResolution }, fixture.context),
    /coverage does not match/,
  );

  const twoDay = structuredClone(resolution(fixture, "2026-08", 172_800).value);
  twoDay.ownerMonth = "2026-09";
  assert.throws(() => validateResolutionArtifact(twoDay, fixture.context), /coverage|owned|month|interval/);
  const unaligned = structuredClone(resolution(fixture, "2026-08", 900).value);
  unaligned.timeCoverage.fromTimestamp = "2026-08-14T14:16:00.000Z";
  assert.throws(() => validateResolutionArtifact(unaligned, fixture.context), /coverage/);
  const impossibleSourceCount = structuredClone(resolution(fixture, "2026-08", 900).value);
  impossibleSourceCount.candles[0].sourceCandleCount = 4;
  assert.throws(() => validateResolutionArtifact(impossibleSourceCount, fixture.context), /source count/);

  const escapedCoverage = structuredClone(fixture.months.find((entry) => entry.value.month === "2026-08").value);
  escapedCoverage.resolutions[0].timeCoverage.fromTimestamp = "2026-08-14T14:00:00.000Z";
  assert.throws(() => validatePairMonthFile(escapedCoverage, fixture.context), /canonical coverage/);

  const reference = structuredClone(resolution(fixture, "2026-08", 900).reference);
  reference.intervalSeconds = 60;
  assert.throws(
    () => validateResolutionReference(reference, { maximumArtifactBytes: registry.collection.maximumArtifactBytes }),
    /interval|resolution/i,
  );

  const changed = structuredClone(fixture.candles);
  changed[1].high = { numerator: "321", denominator: "1" };
  const altered = resolutionArtifactForTest({
    registry,
    pair: fixture.pair,
    sequence: 1,
    ownerMonth: "2026-08",
    intervalSeconds: 900,
    sourceCoverage: fixture.sourceCoverage,
    candles: changed,
  });
  assert.notEqual(canonicalBytes(altered).toString("hex"), canonicalBytes(resolution(fixture, "2026-08", 900).value).toString("hex"));
});

test("the publication manifest owns changed day, resolution, and month references", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  const august = fixture.months.find((entry) => entry.value.month === "2026-08");
  const day = fixture.days.find((entry) => entry.value.day === "2026-08-14");
  const fifteen = resolution(fixture, "2026-08", 900);
  const nextState = createStateIdentity(
    fixture.state.sequence,
    fixture.encodedState.gzipBytes,
    registry.collection.maximumArtifactBytes,
  );
  const manifest = {
    kind: "pair_publication",
    pairId: fixture.pair.pairId,
    phase: "current",
    previousState: null,
    nextState,
    replacements: [day.reference, fifteen.reference, august.reference]
      .map((next) => ({ previous: null, next })),
  };
  assert.deepEqual(validatePairPublicationManifest(manifest, {
    registry,
    expectedPairId: fixture.pair.pairId,
  }), manifest);
  const encodedManifest = encodePairPublicationManifest(manifest, {
    registry,
    expectedPairId: fixture.pair.pairId,
  });
  assert.deepEqual(decodePairPublicationManifest(encodedManifest.gzipBytes, {
    registry,
    expectedPairId: fixture.pair.pairId,
  }), manifest);

  const withoutMonth = { ...manifest, replacements: manifest.replacements.slice(0, 2) };
  assert.throws(() => validatePairPublicationManifest(withoutMonth, { registry }), /month|parent/);
  const unknownMember = { ...manifest, unsupported: "value" };
  assert.throws(() => validatePairPublicationManifest(unknownMember, { registry }), /member set/);
  const resolutionWithoutParent = {
    ...manifest,
    replacements: [
      manifest.replacements[0],
      manifest.replacements[2],
      { previous: null, next: resolution(fixture, "2026-09", 900).reference },
    ],
  };
  assert.throws(() => validatePairPublicationManifest(resolutionWithoutParent, { registry }), /parent month|owned|coverage|reference/i);

  const newMonthWithOldDay = structuredClone(manifest);
  newMonthWithOldDay.previousState = { sequence: 1, gzipBytes: 1, gzipSha256: "a".repeat(64) };
  newMonthWithOldDay.nextState = { sequence: 2, gzipBytes: 1, gzipSha256: "b".repeat(64) };
  for (const replacement of newMonthWithOldDay.replacements) replacement.next.sequence = 2;
  newMonthWithOldDay.replacements[0].previous = day.reference;
  assert.throws(
    () => validatePairPublicationManifest(newMonthWithOldDay, { registry }),
    /new pair publication month/,
  );
});

test("state and month indexes retain exact ordering, continuity, and same-publication ownership", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  const reversedState = structuredClone(fixture.state);
  reversedState.months.reverse();
  assert.throws(() => validatePairStateFile(reversedState, fixture.context), /parent|continuous|reference/);

  const missingMonth = structuredClone(fixture.state);
  missingMonth.months.pop();
  assert.throws(() => validatePairStateFile(missingMonth, fixture.context), /cover/);

  const augustOnlyState = structuredClone(fixture.state);
  augustOnlyState.months = [structuredClone(fixture.state.months[0])];
  augustOnlyState.coverage.untilBlock = augustOnlyState.months[0].coverage.untilBlock;
  augustOnlyState.coverage.untilTimestamp = augustOnlyState.months[0].coverage.untilTimestamp;
  assert.deepEqual(validatePairStateFile(augustOnlyState, fixture.context), augustOnlyState);
  assert.throws(
    () => validateSelectedPairMonth({
      state: augustOnlyState,
      month: fixture.months[0].value,
    }, fixture.context),
    /source month|coverage/,
  );

  const month = structuredClone(fixture.months[0].value);
  month.sequence = 2;
  assert.throws(() => validatePairMonthFile(month, fixture.context), /changed artifact/);

  const state = structuredClone(fixture.state);
  state.sequence = 2;
  assert.throws(() => validatePairStateFile(state, fixture.context), /changed month/);

  assert.deepEqual(encodePairMonthFile(fixture.months[0].value, fixture.context).gzipBytes, fixture.months[0].encoded.gzipBytes);
  assert.deepEqual(encodePairStateFile(fixture.state, fixture.context).gzipBytes, fixture.encodedState.gzipBytes);
});

test("full verification independently re-derives every selected resolution from one-minute files", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  const store = await fixtureStore(registry, "resolution-full-verification-");
  await publishFixture(store, fixture);

  const verified = await verifyPairIndex({ registry, pairId: fixture.pair.pairId, store });
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.selectedState, createStateIdentity(
    fixture.state.sequence,
    fixture.encodedState.gzipBytes,
    registry.collection.maximumArtifactBytes,
  ));
  assert.deepEqual(verified.catalog, candleResolutionCatalog);
  assert.equal(verified.dayCount, fixture.days.length);
  assert.equal(verified.sourceCandleCount, fixture.candles.length);
  assert.equal(verified.resolutionArtifactCount, fixture.resolutions.length);
  assert.equal(
    verified.resolutionCandleCount,
    fixture.resolutions.reduce((sum, entry) => sum + entry.value.candles.length, 0),
  );

  const changedDays = [...fixture.days];
  const changedDayIndex = changedDays.findIndex((entry) => entry.value.day === "2026-08-14");
  const changedDayValue = structuredClone(changedDays[changedDayIndex].value);
  changedDayValue.candles[0].baseVolumeRaw = "10000000000000001";
  const changedDayEncoded = encodePairDayFile(changedDayValue, fixture.context);
  const changedDayReference = createPairFileReference({ encoded: changedDayEncoded, context: fixture.context });
  changedDays[changedDayIndex] = {
    value: changedDayValue,
    encoded: changedDayEncoded,
    reference: changedDayReference,
  };

  const changedMonths = fixture.months.map((entry) => {
    if (entry.value.month !== "2026-08") return entry;
    const value = structuredClone(entry.value);
    value.days = value.days.map((reference) => (
      reference.logicalId === changedDayReference.logicalId ? changedDayReference : reference
    ));
    const encoded = encodePairMonthFile(value, fixture.context);
    return { value, encoded, reference: createPairFileReference({ encoded, context: fixture.context }) };
  });
  const changedState = structuredClone(fixture.state);
  changedState.months = changedMonths.map((entry) => entry.reference);
  const changedStateEncoded = encodePairStateFile(changedState, fixture.context);
  const inconsistent = await fixtureStore(registry, "resolution-inconsistent-verification-");
  await publishFixture(inconsistent, fixture, {
    days: changedDays,
    months: changedMonths,
    state: changedState,
    encodedState: changedStateEncoded,
  });
  await assert.rejects(
    verifyPairIndex({ registry, pairId: fixture.pair.pairId, store: inconsistent }),
    (error) => error instanceof StoredDataIntegrityError,
  );
});

test("one exact resolution read loads no other derived or one-minute artifact", async () => {
  const registry = await fixturePairRegistry();
  const fixture = createResolutionFixture(registry);
  const directory = await fixtureStore(registry, "resolution-independent-read-");
  await publishFixture(directory, fixture);
  const logicalReads = [];
  const store = {
    readSelectedState: (...args) => directory.readSelectedState(...args),
    readReferenced: async (reference) => {
      logicalReads.push(reference.logicalId);
      return directory.readReferenced(reference);
    },
  };
  const result = await readPairMonthResolution({
    registry,
    pairId: fixture.pair.pairId,
    ownerMonth: "2026-08",
    resolution: "4h",
    store,
  });
  assert.equal(result.status, "read");
  assert.deepEqual(result.resolution, { label: "4h", intervalSeconds: 14_400 });
  assert.equal(result.files.length, 1);
  assert.deepEqual(logicalReads, [
    fixture.months[0].reference.logicalId,
    resolution(fixture, "2026-08", 14_400).reference.logicalId,
  ]);

  logicalReads.length = 0;
  const absent = await readPairMonthResolution({
    registry,
    pairId: fixture.pair.pairId,
    ownerMonth: "2026-09",
    resolution: "2d",
    store,
  });
  assert.equal(absent.status, "absent");
  assert.equal(absent.reason, "resolution_not_published");
  assert.deepEqual(logicalReads, [fixture.months[1].reference.logicalId]);

  logicalReads.length = 0;
  await assert.rejects(
    readPairMonthResolution({
      registry,
      pairId: fixture.pair.pairId,
      ownerMonth: "2026-08",
      resolution: "3h",
      store,
    }),
    /resolution is invalid/,
  );
  assert.deepEqual(logicalReads, []);
});
