import { canonicalBytes } from "./canonical.mjs";
import {
  executeSharedCollectionPhase,
  prepareSharedCollectionPhase,
} from "./shared-collection.mjs";
import {
  buildInitialMarketDataRecording,
  buildNextMarketDataRecording,
} from "./market-data-recording.mjs";
import { createMarketDataReader } from "./market-data-reader.mjs";
import {
  abortMarketDataPublication,
  PendingPublicationMismatchError,
  publishMarketDataRecording,
  recoverMarketDataPublication,
} from "./market-data-publication.mjs";
import { maximumMarketDataAssetBytes } from "./market-data-assets.mjs";

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function reader(admittedConfiguration, store) {
  return createMarketDataReader({
    configuration: admittedConfiguration.configuration,
    maximumBytes: maximumMarketDataAssetBytes,
    store,
  });
}

function requireReplayPlan(preparedPhase, publicationRecord) {
  if (
    preparedPhase.phase !== publicationRecord.phase
    || !sameValue(preparedPhase.finalizedBlock, publicationRecord.finalizedBlock)
    || !sameValue(preparedPhase.target, publicationRecord.target)
    || !sameValue(preparedPhase.ranges, publicationRecord.ranges)
  ) throw new Error("Prepared phase differs from the pending publication replay.");
}

async function preparePhase({
  admittedConfiguration,
  fixedFinalizedBlock = null,
  onEndpointFailure,
  prepareSharedPhase,
  repair = null,
  rpcClients,
  selected,
  signal,
}) {
  return (await prepareSharedPhase({
    admittedConfiguration,
    fixedFinalizedBlock,
    onEndpointFailure,
    repair,
    rpcClients,
    signal,
    state: selected?.projection ?? null,
  })).preparedPhase;
}

async function executeDurablePhase({
  admittedConfiguration,
  executeSharedPhase,
  onEndpointFailure,
  pendingPublicationRecord,
  preparedPhase,
  rpcClients,
  selected,
  signal,
  store,
}) {
  signal?.throwIfAborted();
  if (preparedPhase.phase === "idle") return Object.freeze({ phase: "idle", status: "idle" });
  const completed = await executeSharedPhase({
    admittedConfiguration,
    onEndpointFailure,
    preparedPhase,
    rpcClients,
    signal,
    state: selected?.projection ?? null,
  });
  signal?.throwIfAborted();
  const marketDataReader = reader(admittedConfiguration, store);
  const recording = selected === null
    ? buildInitialMarketDataRecording({
      admittedConfiguration,
      collectionResult: completed.result,
      preparedPhase,
    })
    : await buildNextMarketDataRecording({
      admittedConfiguration,
      collectionResult: completed.result,
      marketDataReader,
      pendingPublicationRecord,
      preparedPhase,
      selected,
      store,
    });
  signal?.throwIfAborted();
  if (recording.status === "unchanged") {
    return Object.freeze({
      phase: completed.result.phase,
      selectedEndpointIndex: completed.selectedEndpointIndex,
      status: "unchanged",
    });
  }
  let published;
  try {
    published = await publishMarketDataRecording({
      admittedConfiguration,
      maximumBytes: maximumMarketDataAssetBytes,
      previousSelection: selected,
      recording,
      signal,
      store,
    });
  } catch (error) {
    if (error instanceof PendingPublicationMismatchError) {
      await abortMarketDataPublication({
        admittedConfiguration,
        maximumBytes: maximumMarketDataAssetBytes,
        signal,
        store,
      });
    }
    throw error;
  }
  return Object.freeze({
    finalizedBlock: completed.result.finalizedBlock,
    phase: completed.result.phase,
    root: published.root,
    selectedEndpointIndex: completed.selectedEndpointIndex,
    status: "published",
  });
}

export async function runMarketDataCollectOperation({
  admittedConfiguration,
  executeSharedPhase = executeSharedCollectionPhase,
  onEndpointFailure,
  prepareSharedPhase = prepareSharedCollectionPhase,
  rpcClients,
  signal,
  store,
}) {
  signal?.throwIfAborted();
  let recovery = await recoverMarketDataPublication({
    admittedConfiguration,
    maximumBytes: maximumMarketDataAssetBytes,
    signal,
    store,
  });
  let selected = await reader(admittedConfiguration, store).selection();
  let prepared;
  let pendingPublicationRecord = null;

  if (recovery.status === "replay_required") {
    const record = recovery.publicationRecord;
    if (record.phase === "current") {
      prepared = await preparePhase({
        admittedConfiguration,
        fixedFinalizedBlock: record.finalizedBlock,
        onEndpointFailure,
        prepareSharedPhase,
        rpcClients,
        selected,
        signal,
      });
      requireReplayPlan(prepared, record);
      pendingPublicationRecord = record;
    } else {
      const currentCandidate = await preparePhase({
        admittedConfiguration,
        onEndpointFailure,
        prepareSharedPhase,
        rpcClients,
        selected,
        signal,
      });
      if (record.phase === "history" && currentCandidate.phase !== "current") {
        prepared = await preparePhase({
          admittedConfiguration,
          fixedFinalizedBlock: record.finalizedBlock,
          onEndpointFailure,
          prepareSharedPhase,
          rpcClients,
          selected,
          signal,
        });
        requireReplayPlan(prepared, record);
        pendingPublicationRecord = record;
      } else {
        await abortMarketDataPublication({
          admittedConfiguration,
          maximumBytes: maximumMarketDataAssetBytes,
          signal,
          store,
        });
        recovery = Object.freeze({ status: "previous_retained" });
        prepared = currentCandidate;
      }
    }
  } else {
    prepared = await preparePhase({
      admittedConfiguration,
      onEndpointFailure,
      prepareSharedPhase,
      rpcClients,
      selected,
      signal,
    });
  }

  const phases = [];
  const first = await executeDurablePhase({
    admittedConfiguration,
    executeSharedPhase,
    onEndpointFailure,
    pendingPublicationRecord,
    preparedPhase: prepared,
    rpcClients,
    selected,
    signal,
    store,
  });
  phases.push(first);
  if (first.status !== "published") return Object.freeze({ phases: Object.freeze(phases), recovery });

  selected = await reader(admittedConfiguration, store).selection();
  const secondPrepared = await preparePhase({
    admittedConfiguration,
    fixedFinalizedBlock: first.finalizedBlock,
    onEndpointFailure,
    prepareSharedPhase,
    rpcClients,
    selected,
    signal,
  });
  const second = await executeDurablePhase({
    admittedConfiguration,
    executeSharedPhase,
    onEndpointFailure,
    pendingPublicationRecord: null,
    preparedPhase: secondPrepared,
    rpcClients,
    selected,
    signal,
    store,
  });
  phases.push(second);
  return Object.freeze({ phases: Object.freeze(phases), recovery });
}

export async function runMarketDataRepairOperation({
  admittedConfiguration,
  executeSharedPhase = executeSharedCollectionPhase,
  onEndpointFailure,
  prepareSharedPhase = prepareSharedCollectionPhase,
  repair,
  rpcClients,
  signal,
  store,
}) {
  signal?.throwIfAborted();
  let recovery = await recoverMarketDataPublication({
    admittedConfiguration,
    maximumBytes: maximumMarketDataAssetBytes,
    signal,
    store,
  });
  if (recovery.status === "replay_required") {
    if (recovery.publicationRecord.phase === "current") {
      throw new Error("Pending current publication must be completed by collect before repair.");
    }
    recovery = await abortMarketDataPublication({
      admittedConfiguration,
      maximumBytes: maximumMarketDataAssetBytes,
      signal,
      store,
    });
  }
  const selected = await reader(admittedConfiguration, store).selection();
  if (selected === null) throw new Error("Repair requires selected market data.");
  const prepared = await preparePhase({
    admittedConfiguration,
    onEndpointFailure,
    prepareSharedPhase,
    repair,
    rpcClients,
    selected,
    signal,
  });
  if (prepared.phase !== "repair") throw new Error("Prepared repair phase is invalid.");
  const phase = await executeDurablePhase({
    admittedConfiguration,
    executeSharedPhase,
    onEndpointFailure,
    pendingPublicationRecord: null,
    preparedPhase: prepared,
    rpcClients,
    selected,
    signal,
    store,
  });
  return Object.freeze({ phases: Object.freeze([phase]), recovery });
}
