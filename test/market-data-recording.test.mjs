import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeArtifact } from "../collector/canonical.mjs";
import {
  decodeMarketDataConfiguration,
  loadMarketDataConfiguration,
} from "../collector/market-data-configuration.mjs";
import { derivePoolId } from "../collector/pool-key.mjs";
import {
  applyBaseStateResult,
  buildInitialMarketDataRecording,
  buildNextMarketDataRecording,
  createBaseDayCandidate,
  retainedCoverageBoundary,
} from "../collector/market-data-recording.mjs";
import {
  marketDataCandle,
  marketDataConfigurationBytes,
} from "./market-data-fixtures.mjs";
import { createMarketDataReader } from "../collector/market-data-reader.mjs";
import {
  publishMarketDataRecording,
  recoverMarketDataPublication,
} from "../collector/market-data-publication.mjs";
import {
  publicationRecordAssetIdentity,
  rootAssetIdentity,
  validateBaseStateFile,
  validateBaseStateProgress,
} from "../collector/market-data-files.mjs";
import { physicalAssetIdentity } from "../collector/market-data-assets.mjs";
import { DirectoryStore } from "../storage/directory-store.mjs";
import { runMarketDataCollectOperation } from "../collector/market-data-operation.mjs";
import { verifyMarketDataRecording } from "../collector/market-data-verifier.mjs";

function result(base, kind, fromTimestamp, untilTimestamp, fromBlock, untilBlock, candles = []) {
  return {
    baseCurrencyAddress: base.baseCurrencyAddress,
    candles,
    coverage: {
      fromBlock,
      fromTimestamp,
      poolId: base.poolId,
      untilBlock,
      untilTimestamp,
    },
    kind,
  };
}

async function initialRecording({
  admittedConfiguration = null,
  fromBlock = "50000000",
  fromTimestamp = "2026-08-27T00:00:00.000Z",
  untilBlock = "50001000",
  untilTimestamp = "2026-08-27T00:15:00.000Z",
} = {}) {
  const admitted = admittedConfiguration ?? await loadMarketDataConfiguration();
  const { configuration } = admitted;
  const bases = configuration.bases.map((base) => result(
    base,
    "initial",
    fromTimestamp,
    untilTimestamp,
    fromBlock,
    untilBlock,
  ));
  const newSources = configuration.bases.map((base) => ({
    baseCurrencyAddress: base.baseCurrencyAddress,
    poolId: base.poolId,
    sourceFrom: {
      blockNumber: (BigInt(base.initialize.blockNumber) - 1n).toString(),
      timestamp: new Date(Math.floor(Date.parse(base.initialize.timestamp) / 60_000) * 60_000).toISOString(),
    },
  }));
  const range = {
    fromBlock,
    fromTimestamp,
    poolIds: configuration.poolIds,
    untilBlock,
    untilTimestamp,
  };
  const finalizedBlock = {
    blockHash: `0x${"1".repeat(64)}`,
    blockNumber: (BigInt(untilBlock) + 1n).toString(),
    timestamp: new Date(Date.parse(untilTimestamp) + 1_000).toISOString(),
  };
  const target = { blockNumber: untilBlock, timestamp: untilTimestamp };
  const collectionResult = {
    bases,
    configurationSha256: admitted.sha256,
    finalizedBlock,
    phase: "current",
    ranges: [range],
    status: "collected",
    target,
  };
  const preparedPhase = {
    configurationSha256: admitted.sha256,
    finalizedBlock,
    newSources,
    phase: "current",
    ranges: [range],
    target,
  };
  return {
    admittedConfiguration: admitted,
    collectionResult,
    preparedPhase,
    recording: buildInitialMarketDataRecording({
      admittedConfiguration: admitted,
      collectionResult,
      preparedPhase,
    }),
  };
}

test("one base result updates coverage, candles, and PoolId progress through one owner", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  const initial = result(
    base,
    "initial",
    "2026-08-27T00:00:00.000Z",
    "2026-08-27T00:15:00.000Z",
    "50000000",
    "50001000",
    [marketDataCandle({ intervalStart: "2026-08-27T00:01:00.000Z", blockNumber: "50000100" })],
  );
  const sourceFrom = {
    blockNumber: (BigInt(base.initialize.blockNumber) - 1n).toString(),
    timestamp: new Date(Math.floor(Date.parse(base.initialize.timestamp) / 60_000) * 60_000).toISOString(),
  };
  const initialState = applyBaseStateResult({ configuration, previousState: null, result: initial, sourceFrom });
  assert.deepEqual(validateBaseStateProgress(initialState, configuration), initialState);
  assert.throws(() => validateBaseStateFile(initialState, configuration), /months/);
  const initialDay = createBaseDayCandidate({ configuration, previousDay: null, result: initial });
  assert.equal(initialState.poolPeriods[0].untilTimestamp, initial.coverage.untilTimestamp);
  assert.equal(initialDay.candles.length, 1);

  const current = result(
    base,
    "current",
    initial.coverage.untilTimestamp,
    "2026-08-27T00:30:00.000Z",
    initial.coverage.untilBlock,
    "50002000",
    [marketDataCandle({ intervalStart: "2026-08-27T00:16:00.000Z", blockNumber: "50001100" })],
  );
  const currentState = applyBaseStateResult({ configuration, previousState: initialState, result: current });
  const currentDay = createBaseDayCandidate({ configuration, previousDay: initialDay, result: current });
  assert.equal(currentState.poolPeriods.length, 1);
  assert.equal(currentDay.coverage.length, 2);
  assert.deepEqual(retainedCoverageBoundary(
    currentDay.coverage,
    "2026-08-27T00:17:00.000Z",
  ), { blockNumber: initial.coverage.untilBlock, timestamp: current.coverage.fromTimestamp });
  assert.equal(currentState.poolPeriods[0].untilTimestamp, current.coverage.untilTimestamp);
  assert.deepEqual(currentDay.candles.map((candle) => candle.intervalStart), [
    "2026-08-27T00:01:00.000Z",
    "2026-08-27T00:16:00.000Z",
  ]);

  const unchangedRepair = result(
    base,
    "repair",
    "2026-08-27T00:15:00.000Z",
    current.coverage.untilTimestamp,
    initial.coverage.untilBlock,
    current.coverage.untilBlock,
    [current.candles[0]],
  );
  assert.equal(createBaseDayCandidate({ configuration, previousDay: currentDay, result: unchangedRepair }), null);

  const repair = result(
    base,
    "repair",
    "2026-08-27T00:15:00.000Z",
    current.coverage.untilTimestamp,
    initial.coverage.untilBlock,
    current.coverage.untilBlock,
    [marketDataCandle({ intervalStart: "2026-08-27T00:16:00.000Z", blockNumber: "50001101" })],
  );
  const repairedDay = createBaseDayCandidate({ configuration, previousDay: currentDay, result: repair });
  assert.equal(repairedDay.candles.length, 2);
  assert.equal(repairedDay.candles[1].firstSource.blockNumber, "50001101");
});

test("a configured PoolId change preserves previous facts and starts at the selected current boundary", async () => {
  const { configuration } = await loadMarketDataConfiguration();
  const base = configuration.bases[0];
  const previousPoolKey = { ...base.poolKey, fee: base.poolKey.fee + 1 };
  const previousPoolId = derivePoolId(previousPoolKey);
  const previousFrom = { blockNumber: "50000000", timestamp: "2026-08-27T00:00:00.000Z" };
  const currentBoundary = { blockNumber: "50001000", timestamp: "2026-08-27T00:15:00.000Z" };
  const previousState = {
    baseCurrencyAddress: base.baseCurrencyAddress,
    decimals: base.decimals,
    months: [],
    poolPeriods: [{
      fromBlock: previousFrom.blockNumber,
      fromTimestamp: previousFrom.timestamp,
      poolId: previousPoolId,
      untilBlock: currentBoundary.blockNumber,
      untilTimestamp: currentBoundary.timestamp,
    }],
    pools: {
      [previousPoolId]: {
        historyFrom: previousFrom,
        initialize: base.initialize,
        poolKey: previousPoolKey,
        sourceFrom: previousFrom,
      },
    },
  };
  assert.deepEqual(validateBaseStateProgress(previousState, configuration), previousState);

  const current = result(
    base,
    "current",
    currentBoundary.timestamp,
    "2026-08-27T00:30:00.000Z",
    currentBoundary.blockNumber,
    "50002000",
  );
  const updated = applyBaseStateResult({
    configuration,
    previousState,
    result: current,
    sourceFrom: currentBoundary,
  });

  assert.deepEqual(updated.poolPeriods.map((period) => ({
    fromTimestamp: period.fromTimestamp,
    poolId: period.poolId,
    untilTimestamp: period.untilTimestamp,
  })), [
    {
      fromTimestamp: previousFrom.timestamp,
      poolId: previousPoolId,
      untilTimestamp: currentBoundary.timestamp,
    },
    {
      fromTimestamp: currentBoundary.timestamp,
      poolId: base.poolId,
      untilTimestamp: current.coverage.untilTimestamp,
    },
  ]);
  assert.deepEqual(updated.pools[previousPoolId], previousState.pools[previousPoolId]);
  assert.deepEqual(updated.pools[base.poolId].sourceFrom, currentBoundary);
  assert.deepEqual(updated.pools[base.poolId].historyFrom, currentBoundary);
  assert.deepEqual(validateBaseStateProgress(updated, configuration), updated);
});

test("clean launch builds data, month index, state index, root, and publication in dependency order", async () => {
  const { admittedConfiguration, recording } = await initialRecording();
  const { configuration } = admittedConfiguration;
  assert.equal(Object.keys(recording.root.baseCurrencies).length, configuration.bases.length);
  assert.equal(recording.root.publicationSequence, 1);
  assert.equal(recording.publicationRecord.previousRoot, null);
  assert.equal(recording.publicationRecord.newAssets.length, recording.packedAssets.length);
  assert.ok(recording.root.assets.every((asset) => asset.logicalIds.length > 0));
  assert.ok(recording.packedAssets.some((asset) => asset.selectedAsset.releaseTag.startsWith("market-data-2026-08-s")));
  assert.ok(recording.packedAssets.some((asset) => asset.selectedAsset.releaseTag.startsWith("market-data-index-s")));
});

test("root-last publication records and reads one complete clean launch", async () => {
  const { admittedConfiguration, recording } = await initialRecording();
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-publication-")),
  });
  assert.deepEqual(await publishMarketDataRecording({ maximumBytes: 10_000_000,
    admittedConfiguration,
    recording,
    store,
  }), { root: recording.publicationRecord.nextRoot, status: "published" });
  assert.equal((await store.readMarketDataPublication()).status, "absent");
  const selected = await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  }).selection();
  assert.equal(selected.root.publicationSequence, 1);
  assert.equal(Object.keys(selected.baseStates).length, admittedConfiguration.configuration.bases.length);
  assert.deepEqual(await verifyMarketDataRecording({ admittedConfiguration, store }), {
    baseCurrencyCount: admittedConfiguration.configuration.bases.length,
    dayCount: admittedConfiguration.configuration.bases.length,
    publicationSequence: 1,
    resolutionCount: admittedConfiguration.configuration.bases.length * 9,
    root: recording.publicationRecord.nextRoot,
    status: "verified",
  });
});

test("publication rejects a root reference that differs from its packed member before selection", async () => {
  const { admittedConfiguration, recording } = await initialRecording();
  const root = structuredClone(recording.root);
  const address = admittedConfiguration.configuration.bases[0].baseCurrencyAddress;
  root.baseCurrencies[address].from += 1;
  const encodedRoot = encodeArtifact(root);
  const nextRoot = rootAssetIdentity(root.publicationSequence, encodedRoot.gzipBytes);
  const publicationRecord = { ...recording.publicationRecord, nextRoot };
  const tampered = {
    ...recording,
    encodedPublicationRecord: encodeArtifact(publicationRecord),
    encodedRoot,
    publicationRecord,
    root,
  };
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-reference-mismatch-")),
  });
  await assert.rejects(publishMarketDataRecording({
    admittedConfiguration,
    maximumBytes: 10_000_000,
    recording: tampered,
    store,
  }));
  assert.equal((await createMarketDataReader({
    configuration: admittedConfiguration.configuration,
    maximumBytes: 10_000_000,
    store,
  }).selectedRoot()), null);

  const skippedRoot = { ...recording.root, publicationSequence: 2 };
  const encodedSkippedRoot = encodeArtifact(skippedRoot);
  const skippedNextRoot = rootAssetIdentity(skippedRoot.publicationSequence, encodedSkippedRoot.gzipBytes);
  const skippedRecord = { ...recording.publicationRecord, nextRoot: skippedNextRoot };
  const sequenceStore = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-sequence-mismatch-")),
  });
  await assert.rejects(publishMarketDataRecording({
    admittedConfiguration,
    maximumBytes: 10_000_000,
    recording: {
      ...recording,
      encodedPublicationRecord: encodeArtifact(skippedRecord),
      encodedRoot: encodedSkippedRoot,
      publicationRecord: skippedRecord,
      root: skippedRoot,
    },
    store: sequenceStore,
  }));
  assert.equal((await createMarketDataReader({
    configuration: admittedConfiguration.configuration,
    maximumBytes: 10_000_000,
    store: sequenceStore,
  }).selectedRoot()), null);
});

test("publication admits root bytes through the reader decode boundary before mutation", async () => {
  const { admittedConfiguration, recording } = await initialRecording();
  const maximumBytes = recording.encodedRoot.gzipBytes.byteLength;
  assert.ok(recording.encodedRoot.jsonBytes.byteLength > maximumBytes);
  const store = new DirectoryStore({
    maximumArtifactBytes: maximumBytes,
    root: await mkdtemp(join(tmpdir(), "market-data-root-decode-bound-")),
  });
  await assert.rejects(publishMarketDataRecording({
    admittedConfiguration,
    maximumBytes,
    recording,
    store,
  }));
  assert.equal((await store.readMarketDataPublication()).status, "absent");
  assert.equal((await createMarketDataReader({
    configuration: admittedConfiguration.configuration,
    maximumBytes,
    store,
  }).selectedRoot()), null);
});

test("an exact base read does not load an unrelated base-state member", async () => {
  const { admittedConfiguration, recording } = await initialRecording();
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-single-base-read-")),
  });
  await publishMarketDataRecording({
    admittedConfiguration,
    maximumBytes: 10_000_000,
    recording,
    store,
  });
  const [requested, unrelated] = admittedConfiguration.configuration.bases;
  const blocked = recording.root.baseCurrencies[unrelated.baseCurrencyAddress];
  const guardedStore = {
    listMarketDataAssets: (...arguments_) => store.listMarketDataAssets(...arguments_),
    readMarketDataAsset: (identity, range = null) => {
      if (
        range?.from === blocked.from
        && range?.until === blocked.until
        && identity.sha256 === blocked.assetSha256
      ) throw new Error("Unrelated base state was read.");
      return store.readMarketDataAsset(identity, range);
    },
  };
  const read = await createMarketDataReader({
    configuration: admittedConfiguration.configuration,
    maximumBytes: 10_000_000,
    store: guardedStore,
  }).readResolution({
    baseCurrencyAddress: requested.baseCurrencyAddress,
    month: "2026-08",
    resolution: "2d",
  });
  assert.equal(read.status, "read");
});

test("publication recovery replays an unpublished transition or completes selected-root cleanup", async () => {
  const first = await initialRecording();
  const firstStore = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-recovery-before-root-")),
  });
  const publicationIdentity = publicationRecordAssetIdentity(first.recording.encodedPublicationRecord.gzipBytes);
  await firstStore.writeMarketDataAsset(publicationIdentity, first.recording.encodedPublicationRecord.gzipBytes);
  const firstPacked = first.recording.packedAssets[0];
  await firstStore.writeMarketDataAsset(physicalAssetIdentity(firstPacked.selectedAsset), firstPacked.bytes);
  const pendingReplay = await recoverMarketDataPublication({ maximumBytes: 10_000_000,
    admittedConfiguration: first.admittedConfiguration,
    store: firstStore,
  });
  assert.equal(pendingReplay.status, "replay_required");
  assert.deepEqual(pendingReplay.publicationRecord, first.recording.publicationRecord);
  assert.equal((await firstStore.readMarketDataPublication()).status, "uploaded");
  assert.equal((await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: first.admittedConfiguration.configuration,
    store: firstStore,
  }).selectedRoot()), null);
  await publishMarketDataRecording({ maximumBytes: 10_000_000,
    admittedConfiguration: first.admittedConfiguration,
    recording: first.recording,
    store: firstStore,
  });
  assert.equal((await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: first.admittedConfiguration.configuration,
    store: firstStore,
  }).selectedRoot()).root.publicationSequence, 1);

  const second = await initialRecording();
  const secondStore = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-recovery-after-root-")),
  });
  const secondPublication = publicationRecordAssetIdentity(second.recording.encodedPublicationRecord.gzipBytes);
  await secondStore.writeMarketDataAsset(secondPublication, second.recording.encodedPublicationRecord.gzipBytes);
  for (const packed of second.recording.packedAssets) {
    await secondStore.writeMarketDataAsset(physicalAssetIdentity(packed.selectedAsset), packed.bytes);
  }
  await secondStore.writeMarketDataAsset(second.recording.publicationRecord.nextRoot, second.recording.encodedRoot.gzipBytes);
  assert.deepEqual(await recoverMarketDataPublication({ maximumBytes: 10_000_000,
    admittedConfiguration: second.admittedConfiguration,
    store: secondStore,
  }), { status: "next_selected" });
  assert.equal((await secondStore.readMarketDataPublication()).status, "absent");
  assert.equal((await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: second.admittedConfiguration.configuration,
    store: secondStore,
  }).selectedRoot()).root.publicationSequence, 1);
});

test("publisher mismatch is non-destructive and the serialized operation owner aborts the pending transition", async () => {
  const first = await initialRecording();
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-replay-mismatch-")),
  });
  const publicationIdentity = publicationRecordAssetIdentity(first.recording.encodedPublicationRecord.gzipBytes);
  await store.writeMarketDataAsset(publicationIdentity, first.recording.encodedPublicationRecord.gzipBytes);
  const firstPacked = first.recording.packedAssets[0];
  await store.writeMarketDataAsset(physicalAssetIdentity(firstPacked.selectedAsset), firstPacked.bytes);

  const different = await initialRecording({
    untilBlock: "50001100",
    untilTimestamp: "2026-08-27T00:16:00.000Z",
  });
  await assert.rejects(publishMarketDataRecording({ maximumBytes: 10_000_000,
    admittedConfiguration: different.admittedConfiguration,
    recording: different.recording,
    store,
  }), /differs from the pending replay/);
  assert.equal((await store.readMarketDataPublication()).status, "uploaded");
  assert.equal((await store.listMarketDataAssets(firstPacked.selectedAsset.releaseTag)).length, 1);
  assert.equal((await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: first.admittedConfiguration.configuration,
    store,
  }).selectedRoot()), null);

  const changedResult = structuredClone(first.collectionResult);
  changedResult.bases[0].candles = [marketDataCandle({
    intervalStart: "2026-08-27T00:01:00.000Z",
    blockNumber: "50000100",
  })];
  await assert.rejects(runMarketDataCollectOperation({
    admittedConfiguration: first.admittedConfiguration,
    executeSharedPhase: async () => ({ result: changedResult, selectedEndpointIndex: 0 }),
    prepareSharedPhase: async () => ({ preparedPhase: first.preparedPhase }),
    rpcClients: [{}],
    store,
  }), /differs from the pending replay/);
  assert.equal((await store.readMarketDataPublication()).status, "absent");
  assert.deepEqual(await store.listMarketDataAssets(firstPacked.selectedAsset.releaseTag), []);
});

test("the operation owner independently regenerates and resumes a pending current publication", async () => {
  const initial = await initialRecording();
  const store = new DirectoryStore({
    maximumArtifactBytes: 430_563_600,
    root: await mkdtemp(join(tmpdir(), "market-data-operation-replay-")),
  });
  const publicationIdentity = publicationRecordAssetIdentity(initial.recording.encodedPublicationRecord.gzipBytes);
  await store.writeMarketDataAsset(publicationIdentity, initial.recording.encodedPublicationRecord.gzipBytes);
  const uploaded = initial.recording.packedAssets[0];
  await store.writeMarketDataAsset(physicalAssetIdentity(uploaded.selectedAsset), uploaded.bytes);
  let prepareCalls = 0;
  const result = await runMarketDataCollectOperation({
    admittedConfiguration: initial.admittedConfiguration,
    executeSharedPhase: async ({ preparedPhase }) => {
      assert.deepEqual(preparedPhase, initial.preparedPhase);
      return { result: initial.collectionResult, selectedEndpointIndex: 0 };
    },
    prepareSharedPhase: async ({ fixedFinalizedBlock }) => {
      prepareCalls += 1;
      assert.deepEqual(fixedFinalizedBlock, initial.collectionResult.finalizedBlock);
      return prepareCalls === 1
        ? { preparedPhase: initial.preparedPhase }
        : { preparedPhase: {
          ...initial.preparedPhase,
          phase: "idle",
          ranges: [],
        } };
    },
    rpcClients: [{}],
    store,
  });
  assert.equal(result.recovery.status, "replay_required");
  assert.equal(result.phases.length, 2);
  assert.equal(result.phases[0].status, "published");
  assert.equal(result.phases[1].status, "idle");
  assert.equal((await store.readMarketDataPublication()).status, "absent");
});

test("cancellation after shared collection cannot publish a Directory root", async () => {
  const initial = await initialRecording();
  const controller = new AbortController();
  const store = new DirectoryStore({
    maximumArtifactBytes: 430_563_600,
    root: await mkdtemp(join(tmpdir(), "market-data-operation-cancel-")),
  });
  await assert.rejects(runMarketDataCollectOperation({
    admittedConfiguration: initial.admittedConfiguration,
    executeSharedPhase: async () => {
      controller.abort(new Error("Operation cancelled."));
      return { result: initial.collectionResult, selectedEndpointIndex: 0 };
    },
    prepareSharedPhase: async () => ({ preparedPhase: initial.preparedPhase }),
    rpcClients: [{}],
    signal: controller.signal,
    store,
  }), /cancelled/);
  assert.equal((await createMarketDataReader({
    configuration: initial.admittedConfiguration.configuration,
    maximumBytes: 10_000_000,
    store,
  }).selectedRoot()), null);
});

test("a pending history publication is removed before a newer current phase", async () => {
  const initial = await initialRecording();
  const store = new DirectoryStore({
    maximumArtifactBytes: 430_563_600,
    root: await mkdtemp(join(tmpdir(), "market-data-current-priority-")),
  });
  await publishMarketDataRecording({ maximumBytes: 10_000_000,
    admittedConfiguration: initial.admittedConfiguration,
    recording: initial.recording,
    store,
  });
  const initialReader = createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: initial.admittedConfiguration.configuration,
    store,
  });
  const selected = await initialReader.selection();
  const historyBases = initial.admittedConfiguration.configuration.bases.map((base) => result(
    base,
    "history",
    "2026-08-26T23:45:00.000Z",
    "2026-08-27T00:00:00.000Z",
    "49999000",
    "50000000",
  ));
  const historyRange = {
    fromBlock: "49999000",
    fromTimestamp: "2026-08-26T23:45:00.000Z",
    poolIds: initial.admittedConfiguration.configuration.poolIds,
    untilBlock: "50000000",
    untilTimestamp: "2026-08-27T00:00:00.000Z",
  };
  const historyResult = {
    bases: historyBases,
    configurationSha256: initial.admittedConfiguration.sha256,
    finalizedBlock: initial.collectionResult.finalizedBlock,
    phase: "history",
    ranges: [historyRange],
    status: "collected",
    target: initial.collectionResult.target,
  };
  const pendingHistory = await buildNextMarketDataRecording({
    admittedConfiguration: initial.admittedConfiguration,
    collectionResult: historyResult,
    marketDataReader: initialReader,
    preparedPhase: { configurationSha256: initial.admittedConfiguration.sha256, newSources: [] },
    selected,
    store,
  });
  await store.writeMarketDataAsset(
    publicationRecordAssetIdentity(pendingHistory.encodedPublicationRecord.gzipBytes),
    pendingHistory.encodedPublicationRecord.gzipBytes,
  );
  const pendingAsset = pendingHistory.packedAssets[0];
  await store.writeMarketDataAsset(physicalAssetIdentity(pendingAsset.selectedAsset), pendingAsset.bytes);

  const currentUntil = "2026-08-27T00:30:00.000Z";
  const currentRange = {
    fromBlock: "50001000",
    fromTimestamp: "2026-08-27T00:15:00.000Z",
    poolIds: initial.admittedConfiguration.configuration.poolIds,
    untilBlock: "50002000",
    untilTimestamp: currentUntil,
  };
  const currentResult = {
    bases: initial.admittedConfiguration.configuration.bases.map((base) => result(
      base,
      "current",
      currentRange.fromTimestamp,
      currentRange.untilTimestamp,
      currentRange.fromBlock,
      currentRange.untilBlock,
    )),
    configurationSha256: initial.admittedConfiguration.sha256,
    finalizedBlock: {
      blockHash: `0x${"4".repeat(64)}`,
      blockNumber: "50002001",
      timestamp: "2026-08-27T00:30:01.000Z",
    },
    phase: "current",
    ranges: [currentRange],
    status: "collected",
    target: { blockNumber: "50002000", timestamp: currentUntil },
  };
  const currentPrepared = {
    configurationSha256: initial.admittedConfiguration.sha256,
    finalizedBlock: currentResult.finalizedBlock,
    newSources: [],
    phase: "current",
    ranges: currentResult.ranges,
    target: currentResult.target,
  };
  let prepares = 0;
  const operated = await runMarketDataCollectOperation({
    admittedConfiguration: initial.admittedConfiguration,
    executeSharedPhase: async () => ({ result: currentResult, selectedEndpointIndex: 0 }),
    prepareSharedPhase: async () => {
      prepares += 1;
      return prepares === 1
        ? { preparedPhase: currentPrepared }
        : { preparedPhase: { ...currentPrepared, phase: "idle", ranges: [] } };
    },
    rpcClients: [{}],
    store,
  });
  assert.equal(operated.recovery.status, "previous_retained");
  assert.equal(operated.phases[0].phase, "current");
  assert.equal((await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: initial.admittedConfiguration.configuration,
    store,
  }).selection()).root.currentUntil.timestamp, currentUntil);
});

test("a later shared phase replaces only its changed logical closure and advances one root", async () => {
  const { admittedConfiguration, recording: initial } = await initialRecording();
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-next-recording-")),
  });
  await publishMarketDataRecording({ maximumBytes: 10_000_000,
    admittedConfiguration,
    recording: initial,
    store,
  });
  const marketDataReader = createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  });
  const selected = await marketDataReader.selection();
  const fromTimestamp = initial.root.currentUntil.timestamp;
  const untilTimestamp = "2026-08-27T00:30:00.000Z";
  const bases = admittedConfiguration.configuration.bases.map((base) => result(
    base,
    "current",
    fromTimestamp,
    untilTimestamp,
    initial.root.currentUntil.blockNumber,
    "50002000",
  ));
  const range = {
    fromBlock: initial.root.currentUntil.blockNumber,
    fromTimestamp,
    poolIds: admittedConfiguration.configuration.poolIds,
    untilBlock: "50002000",
    untilTimestamp,
  };
  const next = await buildNextMarketDataRecording({
    admittedConfiguration,
    collectionResult: {
      bases,
      configurationSha256: admittedConfiguration.sha256,
      finalizedBlock: {
        blockHash: `0x${"2".repeat(64)}`,
        blockNumber: "50002001",
        timestamp: "2026-08-27T00:30:01.000Z",
      },
      phase: "current",
      ranges: [range],
      status: "collected",
      target: { blockNumber: "50002000", timestamp: untilTimestamp },
    },
    marketDataReader,
    preparedPhase: {
      configurationSha256: admittedConfiguration.sha256,
      newSources: [],
    },
    selected,
    store,
  });
  assert.equal(next.status, "recording");
  assert.equal(next.root.publicationSequence, 2);
  assert.equal(next.root.currentUntil.timestamp, untilTimestamp);
  await publishMarketDataRecording({ maximumBytes: 10_000_000,
    admittedConfiguration,
    recording: next,
    store,
  });
  const selectedNext = await createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  }).selection();
  assert.equal(selectedNext.root.publicationSequence, 2);
  assert.equal(selectedNext.projection.currentUntil.timestamp, untilTimestamp);
});

test("a backlog phase records newly configured bases at its common current coverage end", async () => {
  const admittedConfiguration = await loadMarketDataConfiguration();
  const retainedAddresses = new Set(admittedConfiguration.configuration.bases.slice(0, 9).map((base) => (
    base.baseCurrencyAddress
  )));
  const previousValue = structuredClone(admittedConfiguration.value);
  for (const address of Object.keys(previousValue.baseCurrencies)) {
    if (!retainedAddresses.has(address)) delete previousValue.baseCurrencies[address];
  }
  const previousConfiguration = decodeMarketDataConfiguration(marketDataConfigurationBytes(previousValue));
  const { recording: initial } = await initialRecording({ admittedConfiguration: previousConfiguration });
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-new-bases-")),
  });
  await publishMarketDataRecording({
    maximumBytes: 10_000_000,
    admittedConfiguration: previousConfiguration,
    recording: initial,
    store,
  });

  const marketDataReader = createMarketDataReader({
    maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  });
  const selected = await marketDataReader.selection();
  const fromTimestamp = initial.root.currentUntil.timestamp;
  const untilTimestamp = "2026-08-27T00:30:00.000Z";
  const untilBlock = "50002000";
  const missing = admittedConfiguration.configuration.bases.filter((base) => !retainedAddresses.has(base.baseCurrencyAddress));
  const bases = admittedConfiguration.configuration.bases.map((base) => result(
    base,
    retainedAddresses.has(base.baseCurrencyAddress) ? "current" : "initial",
    fromTimestamp,
    untilTimestamp,
    initial.root.currentUntil.blockNumber,
    untilBlock,
  ));
  const newSources = missing.map((base) => ({
    baseCurrencyAddress: base.baseCurrencyAddress,
    poolId: base.poolId,
    sourceFrom: {
      blockNumber: (BigInt(base.initialize.blockNumber) - 1n).toString(),
      timestamp: new Date(Math.floor(Date.parse(base.initialize.timestamp) / 60_000) * 60_000).toISOString(),
    },
  }));
  const range = {
    fromBlock: initial.root.currentUntil.blockNumber,
    fromTimestamp,
    poolIds: admittedConfiguration.configuration.poolIds,
    untilBlock,
    untilTimestamp,
  };
  const recording = await buildNextMarketDataRecording({
    admittedConfiguration,
    collectionResult: {
      bases,
      configurationSha256: admittedConfiguration.sha256,
      finalizedBlock: {
        blockHash: `0x${"4".repeat(64)}`,
        blockNumber: "50010001",
        timestamp: "2026-08-27T01:30:01.000Z",
      },
      phase: "current",
      ranges: [range],
      status: "collected",
      target: { blockNumber: "50010000", timestamp: "2026-08-27T01:30:00.000Z" },
    },
    marketDataReader,
    preparedPhase: {
      configurationSha256: admittedConfiguration.sha256,
      newSources,
    },
    selected,
    store,
  });
  await publishMarketDataRecording({
    maximumBytes: 10_000_000,
    admittedConfiguration,
    recording,
    store,
  });

  const verified = await verifyMarketDataRecording({ admittedConfiguration, store });
  assert.equal(verified.status, "verified");
  assert.equal(verified.baseCurrencyCount, admittedConfiguration.configuration.bases.length);
  const selectedNext = await createMarketDataReader({
    maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  }).selection();
  assert.equal(selectedNext.root.currentUntil.timestamp, untilTimestamp);
  assert.equal(Object.keys(selectedNext.baseStates).length, admittedConfiguration.configuration.bases.length);
  assert.ok(Object.values(selectedNext.baseStates).every((state) => (
    state.poolPeriods.at(-1).untilTimestamp === untilTimestamp
  )));
});

test("a new-month phase updates a derived interval owned by the preceding month", async () => {
  const { admittedConfiguration, recording: initial } = await initialRecording({
    fromTimestamp: "2026-08-31T23:45:00.000Z",
    untilTimestamp: "2026-09-01T00:00:00.000Z",
  });
  const store = new DirectoryStore({
    maximumArtifactBytes: 10_000_000,
    root: await mkdtemp(join(tmpdir(), "market-data-cross-month-")),
  });
  await publishMarketDataRecording({ maximumBytes: 10_000_000, admittedConfiguration, recording: initial, store });
  const firstReader = createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  });
  const selected = await firstReader.selection();
  const address = admittedConfiguration.configuration.bases[0].baseCurrencyAddress;
  const beforeMonth = await firstReader.baseMonth(selected, address, "2026-08");
  const beforeTwoDay = beforeMonth.value.resolutions["2d"];
  const bases = admittedConfiguration.configuration.bases.map((base) => result(
    base,
    "current",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:15:00.000Z",
    "50001000",
    "50002000",
  ));
  const next = await buildNextMarketDataRecording({
    admittedConfiguration,
    collectionResult: {
      bases,
      configurationSha256: admittedConfiguration.sha256,
      finalizedBlock: {
        blockHash: `0x${"3".repeat(64)}`,
        blockNumber: "50002001",
        timestamp: "2026-09-01T00:15:01.000Z",
      },
      phase: "current",
      ranges: [{
        fromBlock: "50001000",
        fromTimestamp: "2026-09-01T00:00:00.000Z",
        poolIds: admittedConfiguration.configuration.poolIds,
        untilBlock: "50002000",
        untilTimestamp: "2026-09-01T00:15:00.000Z",
      }],
      status: "collected",
      target: { blockNumber: "50002000", timestamp: "2026-09-01T00:15:00.000Z" },
    },
    marketDataReader: firstReader,
    preparedPhase: { configurationSha256: admittedConfiguration.sha256, newSources: [] },
    selected,
    store,
  });
  await publishMarketDataRecording({ maximumBytes: 10_000_000, admittedConfiguration, recording: next, store });
  const nextReader = createMarketDataReader({ maximumBytes: 10_000_000,
    configuration: admittedConfiguration.configuration,
    store,
  });
  const selectedNext = await nextReader.selection();
  const afterMonth = await nextReader.baseMonth(selectedNext, address, "2026-08");
  const afterTwoDay = afterMonth.value.resolutions["2d"];
  assert.notEqual(afterTwoDay.assetSha256, beforeTwoDay.assetSha256);
  assert.equal((await nextReader.baseResolution(selectedNext, afterTwoDay)).value.coverage.at(-1).untilTimestamp, "2026-09-01T00:15:00.000Z");
});
