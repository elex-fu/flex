import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DeviceRegistry } from "./auth/device-registry.js";
import { AccessCommandReceipts } from "./api/access-command-receipts.js";
import { createHostAttentionBindings, type HostAttention } from "./attention/host-attention.js";
import { createHostCatalogReadBindings, type HostCatalog, type HostCatalogOptions } from "./catalog/host-catalog.js";
import { createCatalogLegacyHost } from "./catalog/catalog-legacy-host.js";
import { createCatalogInteractionBindings } from "./interaction/catalog-interactions.js";
import type { HostIdentityFileV1 } from "./identity/host-identity.js";
import { CatalogHostLifecycle } from "./lifecycle/catalog-host-lifecycle.js";
import { assertHostOwner, type HostOwnerHandle } from "./lifecycle/host-owner.js";
import { SqliteProcessJournal } from "./lifecycle/managed-process-registry.js";
import { createManagedWorkspaceQuery } from "./lifecycle/managed-workspace-query.js";
import { OperationRegistry } from "./lifecycle/operation-registry.js";
import { createHostOperations, hostDiagnosticsRpc, HOST_DIAGNOSTICS_RPC_SCOPES, OperationSnapshotLane } from "./operations/host-operations.js";
import type { SnapshotCoordinator } from "./operations/operation-files.js";
import { createCatalogRecoveryBindings } from "./session/catalog-recovery.js";
import { inspectCatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { createHostServer, type HostServer, type HostServerOptions } from "./server.js";
import { SqliteStore } from "./storage/db.js";
import { CatalogError } from "./storage/catalog-store.js";
import { HostViews } from "./timeline/host-views.js";

export type HostApplicationOptions = Pick<HostCatalogOptions, "configuration" | "initialLegacySession"> & {
  store: SqliteStore;
  owner: HostOwnerHandle;
  identity: HostIdentityFileV1;
  server: Pick<HostServerOptions, "connectivity" | "pairingConfirmation" | "webRoot" | "host" | "port">;
  snapshotLane?: SnapshotCoordinator;
};

/** The production entry owns global services; a selected Session owns only its lazy runtime. */
export async function createHostApplication(options: HostApplicationOptions) {
  const { store, owner, identity } = options;
  assertHostOwner(owner); owner.assertStorePath(store.db.name); store.assertWriterOwner();
  const mirror = store.getHostIdentityMirror();
  if (mirror?.hostId !== identity.hostId || mirror.fingerprint !== identity.fingerprint) throw new CatalogError("HOST_IDENTITY_MISMATCH");
  const privateDirectories = [dirname(owner.databasePath), owner.identityDirectory!, owner.coordinationDirectory!];
  const withSnapshot = options.snapshotLane ?? new OperationSnapshotLane(() => owner.assertActive()).withSnapshot;
  const registry = new OperationRegistry();
  let catalog: HostCatalog | undefined;
  let lifecycle: CatalogHostLifecycle | undefined;
  let server: HostServer | undefined;
  let attention: HostAttention | undefined;
  let interactions: ReturnType<typeof createCatalogInteractionBindings> | undefined;
  let recovery: ReturnType<typeof createCatalogRecoveryBindings> | undefined;
  let devices: DeviceRegistry | undefined;
  let started: Promise<string> | undefined;
  let applicationStarting = false;
  let attentionStarted = false;
  const assertAdmission = () => {
    if (!lifecycle) throw new CatalogError("HOST_BOOTING");
    lifecycle.assertAdmission();
  };
  const startupReadiness = () => {
    if (!catalog) return { ready: false, blockers: ["HOST_BOOTING"] };
    return inspectCatalogStartupReadiness(catalog);
  };
  const assertBusinessReady = () => {
    assertAdmission();
    if (owner.retainedReason || !startupReadiness().ready) throw new CatalogError("HOST_RECOVERY_REQUIRED");
    operations.assertWriteReady();
  };
  const startAttentionIfReady = () => {
    if (!attention || attentionStarted || !applicationStarting || lifecycle?.readiness !== "ready" || owner.retainedReason || !startupReadiness().ready
      || store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()) return;
    attention.start(); attentionStarted = true;
  };
  const query = createManagedWorkspaceQuery({
    journal: new SqliteProcessJournal(store.db), privateRoots: privateDirectories,
    assertActive: () => { owner.assertActive(); store.assertWriterOwner(); },
    context: ({ operationId }) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
      runtimeId: "catalog-query", runtimeGeneration: 1, attemptId: operationId ?? randomUUID() }),
    trackOperation: (work) => {
      assertAdmission();
      void registry.track("producer", () => work).catch(() => {});
    },
  });
  const views = new HostViews(store, owner, {
    resolveResource: (sessionId) => catalog?.viewResource(sessionId),
    assertSessionAccess: (principal, resource) => {
      if (!catalog) throw new CatalogError("HOST_BOOTING");
      catalog.assertActorSession(principal.subjectId, resource.sessionId, "session:read");
    },
  });
  const operations = createHostOperations({ store, owner }, {
    identityDirectory: owner.identityDirectory!, applicationVersion: "0.0.1", withSnapshot,
    doctorFacts: () => {
      const restored = Boolean(store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get());
      const producerReady = startupReadiness().ready;
      const running = catalog?.catalog.allSessions().some((session) => {
        const runtime = catalog?.registry.loaded(session.sessionId);
        return runtime instanceof SessionOrchestrator && runtime.lifecycle.readiness === "ready";
      }) === true;
      return { readiness: { status: running && producerReady && !restored && !owner.retainedReason ? "ready" : "read_only",
        reasonCodes: [...(owner.retainedReason ? ["OWNER_RECOVERY_REQUIRED"] : []), ...(restored ? ["RESTORE_EXTERNAL_STATE_UNVERIFIED"] : []),
          ...(!producerReady ? ["ORIGINAL_HOST_PRODUCERS_UNVERIFIED"] : []),
          ...(!running ? ["NATIVE_EXECUTION_UNVERIFIED"] : [])] } };
    },
  });
  try {
    const catalogOptions: HostCatalogOptions = { store, owner, configuration: options.configuration,
      ...(options.initialLegacySession ? { initialLegacySession: options.initialLegacySession } : {}),
      privateDirectories, hostViews: views, readOnlyGit: query.readOnlyGit,
      restoreWriteReady: () => { operations.assertWriteReady(); if (lifecycle) assertBusinessReady(); },
      readViewInteractions: (sessionId, after) => {
        if (!interactions) throw new CatalogError("HOST_BOOTING");
        return interactions.readViewInteractions(sessionId, after);
      },
      runtimeOptions: (context) => {
        if (!interactions || !recovery) throw new CatalogError("HOST_BOOTING");
        const hooks = interactions.runtimeOptions(context);
        return { ...hooks, recovery: recovery.runtimeRecoveryOptions(context),
          assertWriteReady: assertBusinessReady,
          executionSetup: (host) => {
            hooks.executionSetup?.(host);
            const detach = host.subscribe((event) => { void attention?.postCommitWake(event).catch(() => {}); });
            host.registerShutdownService({ drain: async () => {}, close: detach });
          },
        };
      },
    };
    const runningCatalog: HostCatalog = await createHostCatalogReadBindings(catalogOptions);
    catalog = runningCatalog;
    lifecycle = new CatalogHostLifecycle({ store, owner, catalog: runningCatalog, operations: registry,
      services: [{ ...query.shutdownService, seal: () => query.seal() }],
      afterTransportsClosed: () => { devices?.close(); views.close(); },
      sealJournals: () => {
        let failure: unknown;
        for (const fence of [() => runningCatalog.sealBeforeStoreClose(), () => server?.fenceTransports(), () => devices?.close(), () => views.close()]) {
          try { fence(); } catch (error) { failure ??= error; }
        }
        if (failure) throw failure;
      },
    });
    devices = new DeviceRegistry(store, identity.hostId);
    interactions = createCatalogInteractionBindings({ catalog: runningCatalog, assertAdmission: assertBusinessReady });
    const runningInteractions = interactions;
    recovery = createCatalogRecoveryBindings({ catalog: runningCatalog,
      companionEvents: runningInteractions.companionEvents, supersedeInteractions: runningInteractions.supersedeInteractions,
      assertRecoveryAdmission: assertAdmission, trackRecovery: (work) => lifecycle!.trackOperation("control", work),
      onCommit: (events) => { startAttentionIfReady(); for (const event of events) void attention?.postCommitWake(event).catch(() => {}); },
    });
    if (!store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()) attention = createHostAttentionBindings({ store, owner, hostId: identity.hostId, devices,
      interactions: runningInteractions.service, readInteraction: runningInteractions.readInteraction,
      assertActorSession: (deviceId, sessionId) => runningCatalog.assertActorSession(deviceId, sessionId, "session:read"),
      assertDeliveryReady: assertBusinessReady,
      trackDelivery: (work) => lifecycle!.trackOperation("producer", work),
    });
    // Keep both projections through final unknown commits. Session close never
    // disposes the shared Views or this global Interaction anchor.
    if (attention) { const runningAttention = attention; lifecycle.registerService({ ...runningAttention.shutdownService, seal: () => runningAttention.seal() }); }
    lifecycle.registerService(runningInteractions.shutdownService);
    lifecycle.registerService(recovery.shutdownService);
    // Current helpers are legitimate during a request. Check their complete
    // persisted stop evidence only after every producer/service has drained.
    lifecycle.registerService({ drain: async () => inspectCatalogStartupReadiness(runningCatalog, { includeCurrentOwner: true }).ready });
    const runningLifecycle = lifecycle;
    const legacyHost = createCatalogLegacyHost(runningCatalog, {
      closeAndWait: (deadlineMs) => runningLifecycle.closeAndWait(deadlineMs),
      registerTransportShutdown: (close) => runningLifecycle.registerTransportShutdown(close),
    });
    const runningDevices = devices;
    server = createHostServer({ ...options.server, orchestrator: legacyHost, lifecycle: runningLifecycle, devices: runningDevices,
      identity, identityDirectory: owner.identityDirectory!, snapshotLane: withSnapshot,
      catalogPort: runningCatalog, views, accessReceipts: new AccessCommandReceipts(runningDevices),
      interactionCapabilities: runningInteractions.interactionCapabilities,
      recoveryForSession: recovery.recoveryForSession, recoveryCapabilities: recovery.recoveryCapabilities,
      ...(attention ? { attention } : {}),
      domainPorts: [{ methodScopes: HOST_DIAGNOSTICS_RPC_SCOPES, ready: () => store.db.open, capabilities: () => [],
        dispatch: async (frame, context) => {
          if (!Object.hasOwn(HOST_DIAGNOSTICS_RPC_SCOPES, frame.method)) return { handled: false };
          if (!context.leaseId || context.transportGeneration === undefined) throw new CatalogError("AUTH_REQUIRED");
          const current = runningDevices.assertLease(context.leaseId, context.transportGeneration);
          if (current.deviceId !== context.subjectId) throw new CatalogError("DEVICE_REVOKED");
          return { handled: true, payload: hostDiagnosticsRpc(operations, frame.method, frame.payload, current.scopes) };
        },
      }],
    });
    const runningServer = server;
    return {
      catalog: runningCatalog, lifecycle: runningLifecycle, server: runningServer, devices: runningDevices,
      interactions: runningInteractions, recovery, attention, operations,
      start: () => started ??= (async () => {
        // This opens metadata/control admission. Original producer readiness
        // remains a separate current proof, so explicit recovery can release it.
        runningLifecycle.markReady();
        applicationStarting = true; startAttentionIfReady();
        return runningServer.start();
      })(),
      stop: () => runningServer.stop(),
      queryReadiness: () => query.prepare(),
      startupReadiness,
    };
  } catch (error) {
    // No default path prepares a Native runtime. Once a lifecycle exists it
    // alone owns cleanup; earlier metadata construction has no external work.
    try {
      if (lifecycle) await lifecycle.closeAndWait();
      else { await catalog?.closeAndWait(); await query.close(); views.close(); store.close(); owner.release(); }
    } catch (cleanupError) {
      console.error(`Host startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "recovery required"}`);
    }
    throw error;
  }
}
