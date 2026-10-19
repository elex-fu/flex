import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DeviceRegistry } from "./auth/device-registry.js";
import { AccessCommandReceipts } from "./api/access-command-receipts.js";
import { createHostAttentionBindings, type HostAttention } from "./attention/host-attention.js";
import { createHostCatalogReadBindings, type HostCatalog, type HostCatalogOptions } from "./catalog/host-catalog.js";
import { createCatalogLegacyHost } from "./catalog/catalog-legacy-host.js";
import { HOST_EXECUTION_READINESS_CAPABILITY, HOST_EXECUTION_READINESS_RPC_SCOPES, hostExecutionReadinessRpc } from "./diagnostics/activation-rpc.js";
import { createCatalogInteractionBindings } from "./interaction/catalog-interactions.js";
import type { HostIdentityFileV1 } from "./identity/host-identity.js";
import { CatalogHostLifecycle } from "./lifecycle/catalog-host-lifecycle.js";
import { activationReadinessPort, HostActivationLoad, localActivationFacts } from "./lifecycle/host-activation-load.js";
import { assertHostOwner, type HostOwnerHandle } from "./lifecycle/host-owner.js";
import { SqliteProcessJournal } from "./lifecycle/managed-process-registry.js";
import { createManagedWorkspaceQuery } from "./lifecycle/managed-workspace-query.js";
import { OperationRegistry } from "./lifecycle/operation-registry.js";
import { createHostOperations, hostDiagnosticsRpc, HOST_DIAGNOSTICS_RPC_SCOPES, OperationSnapshotLane } from "./operations/host-operations.js";
import type { SnapshotCoordinator } from "./operations/operation-files.js";
import { createCatalogRecoveryBindings } from "./session/catalog-recovery.js";
import { inspectCatalogStartupReadiness, type CatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { createHostServer, type HostServer, type HostServerOptions } from "./server.js";
import { createActivationOperationStore } from "./storage/activation-store.js";
import { SqliteStore } from "./storage/db.js";
import { CatalogError } from "./storage/catalog-store.js";
import { HostViews } from "./timeline/host-views.js";

export type HostApplicationOptions = Pick<HostCatalogOptions, "configuration" | "initialLegacySession"> & {
  store: SqliteStore;
  owner: HostOwnerHandle;
  identity: HostIdentityFileV1;
  server: Pick<HostServerOptions, "connectivity" | "pairingConfirmation" | "webRoot" | "host" | "port">;
  snapshotLane?: SnapshotCoordinator;
  /** Host-private compatibility evidence log (design §6.3); defaults to the Store directory. */
  compatibilityEvidencePath?: string;
};

/** The production entry owns global services; a selected Session owns only its lazy runtime. */
export async function createHostApplication(options: HostApplicationOptions) {
  const { store, owner, identity } = options;
  assertHostOwner(owner); owner.assertStorePath(store.db.name); store.assertWriterOwner();
  const mirror = store.getHostIdentityMirror();
  if (mirror?.hostId !== identity.hostId || mirror.fingerprint !== identity.fingerprint) throw new CatalogError("HOST_IDENTITY_MISMATCH");
  const privateDirectories = [dirname(owner.databasePath), owner.identityDirectory!, owner.coordinationDirectory!];
  const compatibilityEvidencePath = options.compatibilityEvidencePath ?? join(dirname(owner.databasePath), "compatibility-evidence.jsonl");
  const withSnapshot = options.snapshotLane ?? new OperationSnapshotLane(() => owner.assertActive()).withSnapshot;
  const registry = new OperationRegistry();
  let catalog: HostCatalog | undefined;
  let lifecycle: CatalogHostLifecycle | undefined;
  let server: HostServer | undefined;
  let attention: HostAttention | undefined;
  let interactions: ReturnType<typeof createCatalogInteractionBindings> | undefined;
  let recovery: ReturnType<typeof createCatalogRecoveryBindings> | undefined;
  let devices: DeviceRegistry | undefined;
  let activationLoad: HostActivationLoad | undefined;
  let started: Promise<string> | undefined;
  let applicationStarting = false;
  let attentionStarted = false;
  const assertAdmission = () => {
    if (!lifecycle) throw new CatalogError("HOST_BOOTING");
    lifecycle.assertAdmission();
  };
  /** Original-producer proof only: the gate every write path already shared. */
  const producerReadiness = (): CatalogStartupReadiness => {
    if (!catalog) return { ready: false, blockers: ["HOST_BOOTING"] };
    return inspectCatalogStartupReadiness(catalog);
  };
  /**
   * The startup verdict (design §6.3 step 5): the same producer proof plus the
   * explicit execution-activation load, so a drifted or missing activation is
   * reported with its exact reason codes. Admission itself keeps the existing
   * producer gate until the §7.1 purpose-split lands, because no shipped
   * platform can currently satisfy a required activation (no installed
   * supervisor/adapter facts and no proven managed-query executor), and
   * enforcing it now would block every existing execution path.
   */
  const startupReadiness = (): CatalogStartupReadiness => {
    if (!catalog) return { ready: false, blockers: ["HOST_BOOTING"] };
    const host = catalog, load = activationLoad;
    if (!load) return inspectCatalogStartupReadiness(host);
    return inspectCatalogStartupReadiness(host, {
      activationReadiness: () => load.scan({ workspaces: host.catalog.workspaces(), providers: host.catalog.providers() }),
    });
  };
  const assertBusinessReady = () => {
    assertAdmission();
    if (owner.retainedReason || !producerReadiness().ready) throw new CatalogError("HOST_RECOVERY_REQUIRED");
    operations.assertWriteReady();
  };
  const startAttentionIfReady = () => {
    if (!attention || attentionStarted || !applicationStarting || lifecycle?.readiness !== "ready" || owner.retainedReason || !producerReadiness().ready
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
      const readiness = startupReadiness();
      const producerReady = producerReadiness().ready;
      // Precise execution-activation reasons stay visible beside the coarse
      // producer verdict; an unactivated resource is never reported as a
      // missing original-producer proof alone.
      const activationReasons = (readiness.activation ?? []).flatMap((value) => value.ready ? [] : value.reasonCodes);
      const running = catalog?.catalog.allSessions().some((session) => {
        const runtime = catalog?.registry.loaded(session.sessionId);
        return runtime instanceof SessionOrchestrator && runtime.lifecycle.readiness === "ready";
      }) === true;
      return { readiness: { status: running && producerReady && !activationReasons.length && !restored && !owner.retainedReason ? "ready" : "read_only",
        reasonCodes: [...(owner.retainedReason ? ["OWNER_RECOVERY_REQUIRED"] : []), ...(restored ? ["RESTORE_EXTERNAL_STATE_UNVERIFIED"] : []),
          ...(!producerReady ? ["ORIGINAL_HOST_PRODUCERS_UNVERIFIED"] : []), ...activationReasons,
          ...(!running ? ["NATIVE_EXECUTION_UNVERIFIED"] : [])] } };
    },
  });
  try {
    const catalogOptions: HostCatalogOptions = { store, owner, configuration: options.configuration,
      ...(options.initialLegacySession ? { initialLegacySession: options.initialLegacySession } : {}),
      privateDirectories, hostViews: views, readOnlyGit: query.readOnlyGit,
      // The explicit activation load shares the one observation with future
      // verify/activate flows (design §6.3 step 5): the bootstrap withdraws only
      // the verdicts the recorded facts no longer support.
      activationReadiness: (catalogStore) => {
        const operations = createActivationOperationStore(
          { db: catalogStore.db, workspace: (id) => catalogStore.workspace(id), provider: (id) => catalogStore.provider(id) },
          { guard: () => { owner.assertActive(); owner.assertStorePath(store.db.name); } },
        );
        const load = new HostActivationLoad(operations, localActivationFacts({ compatibilityEvidencePath, privateRoots: privateDirectories }));
        activationLoad = load;
        return activationReadinessPort(load, () => ({ workspaces: catalogStore.workspaces(), providers: catalogStore.providers() }));
      },
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
    const readinessLoad = activationLoad;
    if (!readinessLoad) throw new CatalogError("ACTIVATION_SCHEMA_UNAVAILABLE");
    const executionReadiness = {
      load: readinessLoad,
      catalog: runningCatalog.catalog,
      owner: { recoveryOnly: owner.recoveryOnly, ...(owner.retainedReason ? { retainedReason: owner.retainedReason } : {}) },
      restorePending: () => Boolean(store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()),
      draining: () => { try { runningLifecycle.assertAdmission(); return false; } catch { return true; } },
    };
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
      }, { methodScopes: HOST_EXECUTION_READINESS_RPC_SCOPES, ready: () => store.db.open,
        capabilities: () => [HOST_EXECUTION_READINESS_CAPABILITY],
        dispatch: async (frame, context) => {
          if (!Object.hasOwn(HOST_EXECUTION_READINESS_RPC_SCOPES, frame.method)) return { handled: false };
          if (!context.leaseId || context.transportGeneration === undefined) throw new CatalogError("AUTH_REQUIRED");
          const current = runningDevices.assertLease(context.leaseId, context.transportGeneration);
          if (current.deviceId !== context.subjectId) throw new CatalogError("DEVICE_REVOKED");
          return { handled: true, payload: hostExecutionReadinessRpc(executionReadiness, frame.method, frame.payload, current.scopes) };
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
