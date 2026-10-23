import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { WORKTREE_CAPABILITY } from "@flyx/mvp-protocol";
import { dirname, join } from "node:path";
import { DeviceRegistry } from "./auth/device-registry.js";
import { AccessCommandReceipts } from "./api/access-command-receipts.js";
import { createHostAttentionBindings, type HostAttention } from "./attention/host-attention.js";
import { createHostCatalogReadBindings, type HostCatalog, type HostCatalogOptions } from "./catalog/host-catalog.js";
import { createCatalogLegacyHost } from "./catalog/catalog-legacy-host.js";
import { createCatalogCheckpoints } from "./checkpoint/catalog-checkpoints.js";
import type { HostRevertPorts } from "./checkpoint/host-checkpoints.js";
import { HOST_EXECUTION_READINESS_CAPABILITY, HOST_EXECUTION_READINESS_RPC_SCOPES, hostExecutionReadinessRpc } from "./diagnostics/activation-rpc.js";
import type { NativeCompatibilityArtifact } from "./diagnostics/compatibility-evidence.js";
import { createCompatibilityScenePolicy, type CompatibilityScenePolicy, type CompatibilityScenePolicyOptions } from "./diagnostics/compatibility-scene-policy.js";
import { providerConfigurationFingerprint } from "./lifecycle/host-activation-load.js";
import { createCatalogInteractionBindings } from "./interaction/catalog-interactions.js";
import { publicHostIdentity, type HostIdentityFileV1 } from "./identity/host-identity.js";
import { CatalogHostLifecycle } from "./lifecycle/catalog-host-lifecycle.js";
import { activationReadinessPort, HostActivationLoad, localActivationFacts, type ActivationLoadFacts, type LocalActivationFactsOptions } from "./lifecycle/host-activation-load.js";
import { createHostActivationService, type HostActivationService } from "./lifecycle/host-activation-service.js";
import { ManagedGitRunner, type ManagedGitRunnerOptions } from "./lifecycle/managed-git-runner.js";
import { assertHostOwner, type HostOwnerHandle } from "./lifecycle/host-owner.js";
import { SqliteProcessJournal, type ProcessLaunchContext } from "./lifecycle/managed-process-registry.js";
import { validateTreeStopEvidence } from "./lifecycle/managed-process-evidence.js";
import { createManagedWorkspaceQuery } from "./lifecycle/managed-workspace-query.js";
import { OperationRegistry } from "./lifecycle/operation-registry.js";
import { createHostOperations, hostDiagnosticsRpc, HOST_DIAGNOSTICS_RPC_SCOPES, OperationSnapshotLane } from "./operations/host-operations.js";
import type { SnapshotCoordinator } from "./operations/operation-files.js";
import { createCatalogRecoveryBindings } from "./session/catalog-recovery.js";
import { inspectCatalogStartupReadiness, type CatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { SessionOrchestrator, type CommittedNativeStopRecorder } from "./session/orchestrator.js";
import { createHostServer, type HostServer, type HostServerOptions } from "./server.js";
import { createActivationOperationStore } from "./storage/activation-store.js";
import { SqliteStore } from "./storage/db.js";
import { CatalogError } from "./storage/catalog-store.js";
import { HostViews } from "./timeline/host-views.js";
import { HostExecutionPermits } from "./workspace/host-execution-permits.js";
import { WORKTREE_COMMAND_METHODS, WORKTREE_RPC_SCOPES, type WorktreeCommandMethod } from "./workspace/host-worktrees.js";
import { createManagedScheduledHostWorktrees } from "./workspace/managed-host-worktrees.js";
import { createManagedRepositoryMetadata } from "./workspace/managed-repository-metadata.js";
import { NativeHistoryReaderFactory } from "./provider/native-history-reader.js";
import { createNativeHistoryManifestSource, type NativeHistorySceneBootstrap } from "./provider/native-history-manifest.js";
import type { DispatchContext } from "./provider/types.js";
import { GitService } from "./git/git-service.js";
import { NativeTerminalReceiptStore } from "./storage/native-receipt-store.js";
import type { RecoveryTarget } from "./storage/recovery-store.js";
import type { CatalogRecoveryIdentity, ExistingCatalogRecoveryReader } from "./session/catalog-recovery.js";
import { catalogRecoveryConfigurationFingerprint } from "./session/catalog-recovery.js";
import { homedir } from "node:os";

export type HostApplicationOptions = Pick<HostCatalogOptions, "configuration" | "initialLegacySession"> & {
  store: SqliteStore;
  owner: HostOwnerHandle;
  identity: HostIdentityFileV1;
  server: Pick<HostServerOptions, "connectivity" | "pairingConfirmation" | "webRoot" | "host" | "port">;
  snapshotLane?: SnapshotCoordinator;
  /** Host-private compatibility evidence log (design §6.3); defaults to the Store directory. */
  compatibilityEvidencePath?: string;
  compatibilityEndorsementPath?: string;
  /** Trusted local composition ports. No environment or RPC can supply them. */
  execution?: {
    git?: Omit<ManagedGitRunnerOptions, "journal" | "context" | "roots" | "privateRoots">;
    facts?: Pick<LocalActivationFactsOptions, "supervision" | "runtime">;
    observation?: ActivationLoadFacts;
    runtimeOptions?: HostCatalogOptions["runtimeOptions"];
    revert?: HostRevertPorts;
    compatibilityArtifact?: () => NativeCompatibilityArtifact | undefined;
    /** Design §6.3: compatibility fact recorder for the isolated compatibility
     *  scenario only. The online Host never constructs or injects one. */
    compatibilityRecorder?: () => CommittedNativeStopRecorder | undefined;
    /** Design §8.2: the isolated compatibility scene's own manifest-bootstrap
     *  authorization; undefined for the ordinary online Host. */
    compatibilityScene?: () => NativeHistorySceneBootstrap | undefined;
    worktreesRoot?: string;
    recovery?: Pick<Parameters<typeof createCatalogRecoveryBindings>[0], "nativeHistoryReaderFactory" | "processInspector" | "inspectBoundary" | "inspectWorkspace" | "verifiedManifestForInstance" | "existingCodexReader">;
  };
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
  const executionPermits = new HostExecutionPermits({ limit: 2 });
  let catalog: HostCatalog | undefined;
  let openingCatalog: HostCatalog["catalog"] | undefined;
  let lifecycle: CatalogHostLifecycle | undefined;
  let server: HostServer | undefined;
  let attention: HostAttention | undefined;
  let interactions: ReturnType<typeof createCatalogInteractionBindings> | undefined;
  let recovery: ReturnType<typeof createCatalogRecoveryBindings> | undefined;
  let devices: DeviceRegistry | undefined;
  let activationLoad: HostActivationLoad | undefined;
  let activation: HostActivationService | undefined;
  let checkpointBindings: ReturnType<typeof createCatalogCheckpoints> | undefined;
  let worktreeBindings: ReturnType<typeof createManagedScheduledHostWorktrees> | undefined;
  let nativeScenePolicy: CompatibilityScenePolicy | undefined;
  let started: Promise<string> | undefined;
  let applicationStarting = false;
  let attentionStarted = false;
  const assertAdmission = () => {
    if (!lifecycle) throw new CatalogError("HOST_BOOTING");
    lifecycle.assertAdmission();
  };
  /** Original-producer proof only: the gate every write path already shared. */
  const producerReadiness = (): CatalogStartupReadiness => {
    if (catalog) return inspectCatalogStartupReadiness(catalog);
    if (openingCatalog) return inspectCatalogStartupReadiness({ store, owner, catalog: openingCatalog });
    return { ready: false, blockers: ["HOST_BOOTING"] };
  };
  /** Read-only readiness uses the same observations as the online write gate. */
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
  const sceneBinding = (target: ReturnType<HostCatalog["registry"]["resolve"]>) => ({ sessionId: target.session.sessionId,
    workspaceId: target.workspace.workspaceId, canonicalRoot: target.workspace.canonicalRoot, checkoutRoot: target.workspace.worktreeRoot,
    providerInstanceId: target.providerInstance.providerInstanceId, provider: target.providerInstance.provider,
    configurationFingerprint: providerConfigurationFingerprint(target.providerInstance) });
  const assertNativeReady: NonNullable<HostCatalogOptions["assertNativeReady"]> = (target, authorization) => {
    assertBusinessReady();
    if (authorization) {
      if (!nativeScenePolicy) throw new CatalogError("COMPATIBILITY_SCENE_UNAVAILABLE");
      nativeScenePolicy.assertResource(authorization, sceneBinding(target)); return;
    }
    if (!activation) throw new CatalogError("ACTIVATION_SCHEMA_UNAVAILABLE");
    activation.assertReadyForWrite({ workspaceId: target.workspace.workspaceId, providerInstanceId: target.providerInstance.providerInstanceId });
  };
  const startAttentionIfReady = () => {
    if (!attention || attentionStarted || !applicationStarting || lifecycle?.readiness !== "ready" || owner.retainedReason || !producerReadiness().ready
      || store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()) return;
    attention.start(); attentionStarted = true;
  };
  const journal = new SqliteProcessJournal(store.db);
  const gitContext = new AsyncLocalStorage<ProcessLaunchContext>();
  const repositoryMetadata = createManagedRepositoryMetadata({ owner, runner: () => {
    if (!runner) throw new CatalogError("MANAGED_GIT_BACKEND_UNAVAILABLE"); return runner;
  } });
  const runner = options.execution?.git ? new ManagedGitRunner({ ...options.execution.git, journal, privateRoots: privateDirectories,
    repositoryMetadata: repositoryMetadata.run,
    roots: () => [...(catalog?.catalog.workspaces().flatMap((workspace) => [workspace.canonicalRoot, workspace.worktreeRoot]) ?? []),
      ...(options.configuration.workspaces?.map((workspace) => workspace.root) ?? []),
      ...(options.execution?.worktreesRoot ? [options.execution.worktreesRoot] : [])],
    context: ({ operationId }) => {
      const worktree = worktreeBindings?.worktrees.currentExecution()?.dispatchContext;
      if (worktree) return worktree;
      const scoped = gitContext.getStore(); if (scoped) return scoped;
      const manifest = operationId ? checkpointBindings?.checkpoints.checkpoints.store.get(operationId) : undefined;
      const host = manifest ? catalog?.registry.loaded(manifest.sessionId) : undefined;
      if (manifest?.attemptId && manifest.turnId && host instanceof SessionOrchestrator) return {
        hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: host.runtimeId,
        runtimeGeneration: manifest.runtimeGeneration, sessionId: manifest.sessionId, flyxTurnId: manifest.turnId, attemptId: manifest.attemptId,
      };
      if (manifest && host instanceof SessionOrchestrator) return { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
        runtimeId: host.runtimeId, runtimeGeneration: Math.max(1, manifest.runtimeGeneration), sessionId: manifest.sessionId, attemptId: manifest.checkpointId };
      return { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
        runtimeId: "host-git", runtimeGeneration: 1, attemptId: operationId ?? randomUUID() };
    },
  }) : undefined;
  const activationTrust = { destination: publicHostIdentity(identity), endorsementPath: options.compatibilityEndorsementPath ?? join(dirname(owner.databasePath), "compatibility-endorsement.json") };
  const observation = options.execution?.observation ?? localActivationFacts({ compatibilityEvidencePath, privateRoots: privateDirectories, ...options.execution?.facts, compatibilityTrust: activationTrust });
  const query = createManagedWorkspaceQuery({
    journal: new SqliteProcessJournal(store.db), privateRoots: privateDirectories,
    assertActive: () => { owner.assertActive(); store.assertWriterOwner(); },
    context: ({ operationId }) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
      runtimeId: "catalog-query", runtimeGeneration: 1, attemptId: operationId ?? randomUUID() }),
    ...(runner ? { executor: runner.workspaceQueryPort() } : {}),
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
        openingCatalog = catalogStore;
        const operations = createActivationOperationStore(
          { db: catalogStore.db, workspace: (id) => catalogStore.workspace(id), provider: (id) => catalogStore.provider(id) },
          { guard: () => { owner.assertActive(); owner.assertStorePath(store.db.name); } },
        );
        const load = new HostActivationLoad(operations, observation);
        activationLoad = load;
        activation = createHostActivationService({ facts: { db: store.db, owner, catalog: catalogStore, readiness: producerReadiness },
          operations, load, observation, actorId: "online-host", privateRoots: privateDirectories });
        return activationReadinessPort(load, () => ({ workspaces: catalogStore.workspaces(), providers: catalogStore.providers() }));
      },
      restoreWriteReady: () => {
        owner.assertActive(); store.assertWriterOwner(); operations.assertWriteReady();
        if (owner.retainedReason || !producerReadiness().ready) throw new CatalogError("HOST_RECOVERY_REQUIRED");
        // Local metadata configuration precedes the transport admission phase.
        if (lifecycle && lifecycle.readiness !== "booting") assertAdmission();
      },
      assertNativeReady,
      nativeScenePolicy: () => nativeScenePolicy,
      readViewInteractions: (sessionId, after) => {
        if (!interactions) throw new CatalogError("HOST_BOOTING");
        return interactions.readViewInteractions(sessionId, after);
      },
      runtimeOptions: (context, services) => {
        if (!interactions || !recovery || !checkpointBindings) throw new CatalogError("HOST_BINDINGS_INCOMPLETE");
        const hooks = interactions.runtimeOptions(context);
        const extra = options.execution?.runtimeOptions?.(context, services);
        const compatibilityRecorder = options.execution?.compatibilityRecorder?.();
        return { ...extra, ...hooks, recovery: recovery.runtimeRecoveryOptions(context),
          checkpoints: checkpointBindings.checkpoints.executionBinding,
          executionPermits,
          ...(nativeScenePolicy ? { nativeScenePolicy } : {}),
          // The trusted Host port wins over any runtimeOptions extra of the same key.
          ...(compatibilityRecorder ? { compatibilityRecorder } : {}),
          canReleaseAdditionalProducers: (dispatch) => {
            owner.assertActive();
            const records = store.db.prepare(`SELECT p.state,p.pid,p.process_group,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json FROM managed_processes p
              LEFT JOIN managed_process_identities i ON i.process_id=p.id
              LEFT JOIN managed_process_boundaries b ON b.process_id=p.id
              LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id
              WHERE p.owner_id=? AND p.owner_generation=? AND p.runtime_id=? AND p.session_id=? AND
                (p.turn_id IS NULL OR (p.runtime_generation=? AND p.turn_id=? AND p.attempt_id=?))`)
              .all(owner.ownerId, owner.generation, dispatch.runtimeId, dispatch.sessionId, dispatch.runtimeGeneration, dispatch.flyxTurnId, dispatch.attemptId) as Array<{ state: string; pid: number | null; process_group: number | null; identity_json: string | null; boundary_json: string | null; launch_digest: string | null; proof_json: string | null }>;
            return records.every((record) => {
              if (record.state === "not_spawned" && record.pid === null) return true;
              if (record.state !== "stopped" || !record.identity_json || !record.proof_json || !record.launch_digest) return false;
              try { validateTreeStopEvidence(JSON.parse(record.proof_json), JSON.parse(record.identity_json), record.boundary_json ? { proof: JSON.parse(record.boundary_json), launchDigest: record.launch_digest } : undefined, record.process_group ?? undefined); return true; } catch { return false; }
            }) && (extra?.canReleaseAdditionalProducers?.(dispatch) ?? true);
          },
          gitRunner: async (request) => {
            if (!runner) throw new CatalogError("MANAGED_GIT_BACKEND_UNAVAILABLE");
            const host = services.registry.loaded(context.session.sessionId);
            if (!(host instanceof SessionOrchestrator)) throw new CatalogError("GIT_RUNTIME_BINDING_UNAVAILABLE");
            const active = store.getActiveTurn(context.session.sessionId);
            return gitContext.run({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: host.runtimeId,
              runtimeGeneration: active?.generation ?? 1, sessionId: context.session.sessionId,
              attemptId: active?.attemptId ?? request.operationId ?? randomUUID(), ...(active ? { flyxTurnId: active.id } : {}) }, () => runner.gitServiceRunner()(request));
          },
          assertWriteReady: assertAdmission,
          assertNativeReady: (input) => assertNativeReady(services.registry.resolve(context.session.sessionId), input?.authorization),
          executionSetup: (host) => {
            checkpointBindings!.checkpoints.bindWorker(host.worker);
            extra?.executionSetup?.(host);
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
      services: [{ stopProducers: async () => { worktreeBindings?.stopAdmission(); }, drain: async () => true, seal: () => repositoryMetadata.seal() },
        ...(runner ? [runner.shutdownService] : []), { ...query.shutdownService, seal: () => query.seal() },
        { drain: (deadline) => executionPermits.drain(Math.max(0, deadline - Date.now())), seal: () => executionPermits.seal() }],
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
    checkpointBindings = createCatalogCheckpoints(runningCatalog, views, runner, options.execution?.revert);
    lifecycle.registerService({ drain: (deadline) => checkpointBindings!.checkpoints.drain(Math.max(0, deadline - Date.now())), seal: () => checkpointBindings!.checkpoints.seal() });
    interactions = createCatalogInteractionBindings({ catalog: runningCatalog, assertAdmission });
    const runningInteractions = interactions;
    // Design §8.2 trusted manifest source: shared by the Native read factory
    // (handle-level, with transcript contract) and recovery admission
    // (instance-level, no contract implied). The live resource port keeps the
    // manifest's configurationFingerprint in the recovery domain the reader
    // gate and recovery admission actually compare, derived from the live
    // catalog rows — never echoed from the handle asking for it. The scene
    // bootstrap authorizes the isolated run's own reads before import.
    const manifestSource = createNativeHistoryManifestSource({
      compatibilityEvidencePath, compatibilityTrust: activationTrust,
      ...(options.execution?.facts?.supervision ? { supervision: options.execution.facts.supervision } : {}),
      ...(options.execution?.facts?.runtime ? { runtime: options.execution.facts.runtime } : {}),
      ...(options.execution?.compatibilityScene ? { sceneBootstrap: options.execution.compatibilityScene } : {}),
      resourceFingerprint: (sessionId) => {
        try {
          owner.assertActive();
          const target = runningCatalog.registry.resolve(sessionId);
          return Object.freeze({ provider: target.providerInstance.provider, providerInstanceId: target.providerInstance.providerInstanceId,
            configurationFingerprint: catalogRecoveryConfigurationFingerprint(target) });
        } catch { return undefined; }
      },
      resolveProvider: (providerInstanceId) => runningCatalog.catalog.provider(providerInstanceId),
    });
    const nativeReceipts = new NativeTerminalReceiptStore(store.db);
    const nativeHistoryReaderFactory = options.execution?.recovery?.nativeHistoryReaderFactory ?? new NativeHistoryReaderFactory({
      assertBinding: (handle, checkoutRoot) => {
        owner.assertActive();
        const target = runningCatalog.registry.resolve(handle.sessionId);
        if (target.workspace.worktreeRoot !== checkoutRoot || target.providerInstance.providerInstanceId !== handle.providerInstanceId)
          throw new CatalogError("NATIVE_HISTORY_BINDING_CHANGED");
      },
      // A versioned installed read contract is required before any Native read.
      // The manifest exists only when the signed compatibility artifact that
      // verified the turn baseline also verified a read-only recovery
      // inspection and still matches the live provider instance facts.
      verifiedManifestForHandle: (handle) => manifestSource.verifiedManifestForHandle(handle),
      // The production Claude transcript source is anchored only by the
      // durable native result receipt journaled at SDK arrival time (table
      // native_terminal_receipts); without that anchor the read stays unknown.
      claudeTranscript: async (handle) => {
        if (handle.provider !== "claude") return undefined;
        owner.assertActive();
        const receipt = nativeReceipts.find(handle.sessionId, handle.turnId, handle.attemptId);
        if (!receipt || receipt.provider !== "claude" || receipt.nativeSessionId !== handle.nativeSessionId) return undefined;
        const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
        const transcriptPath = join(configRoot, "projects", handle.workspacePath.split("/").join("-"), `${receipt.nativeSessionId}.jsonl`);
        return Object.freeze({
          path: transcriptPath, format: "claude-sdk-result-v1" as const, runtimeVersion: handle.verifiedVersion,
          sessionId: handle.sessionId, providerInstanceId: handle.providerInstanceId, configurationFingerprint: handle.configurationFingerprint,
          anchor: {
            contextDigest: receipt.contextDigest, resultUuid: receipt.resultUuid, resultDigest: receipt.resultDigest,
            ...(receipt.interruptAcknowledged ? { interruptAcknowledged: true as const } : {}),
          },
        });
      },
    });
    recovery = createCatalogRecoveryBindings({ catalog: runningCatalog,
      ...options.execution?.recovery,
      ...(options.execution?.recovery?.verifiedManifestForInstance ? {} : { verifiedManifestForInstance: (identity: CatalogRecoveryIdentity) => manifestSource.verifiedManifestForInstance(identity.provider, identity.providerInstanceId, identity.sessionId) }),
      // The production existing-connection reader selects the loaded Session's
      // live Codex connection only; absence stays unknown and it never
      // reconnects, resumes or starts a provider (design §8.2).
      ...(options.execution?.recovery?.existingCodexReader ? {} : { existingCodexReader: (identity: CatalogRecoveryIdentity, original: DispatchContext): ExistingCatalogRecoveryReader | undefined => {
        if (identity.provider !== "codex") return undefined;
        try {
          owner.assertActive();
          const host = runningCatalog.registry.loaded(identity.sessionId);
          if (!(host instanceof SessionOrchestrator) || host.adapter.provider !== "codex") return undefined;
          const reader = host.adapter.codexRecoveryReader?.(original);
          if (!reader) return undefined;
          return Object.freeze({ source: "existing-connection", sessionId: identity.sessionId,
            providerInstanceId: identity.providerInstanceId, configurationFingerprint: identity.configurationFingerprint,
            runtimeVersion: reader.runtimeVersion, client: reader.client });
        } catch { return undefined; }
      } }),
      // Production workspace inspection reads the original checkout through
      // the managed git runner; any refusal keeps the state unknown.
      ...(options.execution?.recovery?.inspectWorkspace ? {} : { inspectWorkspace: async (target: RecoveryTarget): Promise<"clear" | "held" | "unknown"> => {
        if (!runner) return "unknown";
        try {
          owner.assertActive();
          const resolved = runningCatalog.registry.resolve(target.session.id);
          const checkoutRoot = resolved.workspace.worktreeRoot ?? resolved.workspace.canonicalRoot;
          const status = await new GitService(checkoutRoot, { runner: runner.gitServiceRunner() }).status();
          if (!status.available) return "unknown";
          return status.dirty ? "held" : "clear";
        } catch { return "unknown"; }
      } }),
      nativeHistoryReaderFactory,
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
    if (runner && options.execution?.worktreesRoot) {
      worktreeBindings = createManagedScheduledHostWorktrees({ catalog: runningCatalog.catalog, workspaces: runningCatalog.workspaces,
        sessions: runningCatalog.registry, devices, owner, managedRoot: options.execution.worktreesRoot, privateDirectories,
        runner, stopContractId: options.execution.git!.stopBackend.contractId, assertWriteReady: assertBusinessReady,
        repositoryMetadata,
        executionReadiness: () => options.execution?.facts?.supervision?.()?.contractId === options.execution?.git?.stopBackend.contractId
          ? { ready: true } : { ready: false, reasonCode: "SUPERVISION_CONTRACT_UNAVAILABLE" },
        trackOperation: (_kind, work) => lifecycle!.trackOperation("producer", work),
      });
      lifecycle.registerService({ drain: async (deadline) => (await worktreeBindings!.closeAndWait(Math.max(0, deadline - Date.now()))).clean,
        seal: () => worktreeBindings!.seal() });
    }
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
      domainPorts: [checkpointBindings.port, { methodScopes: WORKTREE_RPC_SCOPES, ready: () => store.db.open,
        capabilities: () => worktreeBindings?.worktrees.ready() ? [WORKTREE_CAPABILITY] : [],
        dispatch: async (frame, context) => {
          if (!Object.hasOwn(WORKTREE_RPC_SCOPES, frame.method)) return { handled: false };
          if (!worktreeBindings) throw new CatalogError("WORKTREE_MANAGED_BACKEND_UNAVAILABLE");
          context.assertAuthorized(frame.method);
          if (!context.leaseId || context.transportGeneration === undefined || context.protocolVersion !== 2 || !context.capabilities) throw new CatalogError("AUTH_REQUIRED");
          const sessionId = (frame.payload as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof sessionId !== "string") throw new CatalogError("SESSION_SCOPE_MISMATCH");
          const scope = WORKTREE_RPC_SCOPES[frame.method as keyof typeof WORKTREE_RPC_SCOPES];
          const authorize = () => { context.assertSessionScope?.(sessionId, scope); runningCatalog.assertActorSession(context.subjectId, sessionId, scope); };
          authorize();
          const actor = { subjectId: context.subjectId, leaseId: context.leaseId, transportGeneration: context.transportGeneration, protocolVersion: 2, capabilities: context.capabilities };
          const worktrees = worktreeBindings.worktrees;
          let payload: unknown;
          if (frame.method === "worktree.list") payload = worktrees.list(frame.payload, actor);
          else if (frame.method === "worktree.getOperation") payload = worktrees.getOperation(frame.payload, actor);
          else if (frame.method === "worktree.getReceipt") payload = worktrees.getReceipt(frame.payload, actor);
          else {
            if (!frame.commandId || !(WORKTREE_COMMAND_METHODS as readonly string[]).includes(frame.method)) throw new CatalogError("COMMAND_ID_REQUIRED");
            payload = await worktrees.command(frame.method as WorktreeCommandMethod, frame.payload, frame.commandId, actor);
          }
          runningDevices.assertLease(actor.leaseId, actor.transportGeneration); authorize();
          context.frameBudget?.assert(context.responseEnvelope?.(payload) ?? payload);
          return { handled: true, payload };
        },
      }, { methodScopes: HOST_DIAGNOSTICS_RPC_SCOPES, ready: () => store.db.open, capabilities: () => [],
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
      interactions: runningInteractions, recovery, attention, operations, checkpoints: checkpointBindings.checkpoints, activation,
      worktrees: worktreeBindings?.worktrees,
      start: () => started ??= (async () => {
        // This opens metadata/control admission. Original producer readiness
        // remains a separate current proof, so explicit recovery can release it.
        runningLifecycle.markReady();
        worktreeBindings?.start();
        applicationStarting = true; startAttentionIfReady();
        return runningServer.start();
      })(),
      stop: () => runningServer.stop(),
      queryReadiness: () => query.prepare(),
      startupReadiness,
      compatibilityArtifact: () => options.execution?.compatibilityArtifact?.(),
      /** Returns the created policy so the real entry can bind its recorder (M4 design §6.3). */
      prepareCompatibilityScene: async (input: Pick<CompatibilityScenePolicyOptions, "authorization" | "expectedDestination" | "entry" | "measureArtifact">): Promise<CompatibilityScenePolicy> => {
        if (nativeScenePolicy || runningCatalog.catalog.allSessions().some((session) => runningCatalog.registry.loaded(session.sessionId))) throw new CatalogError("COMPATIBILITY_SCENE_ALREADY_STARTED");
        if (!runner || !["supervisor", "managed_process_group"].includes(options.execution?.git?.stopBackend.kind ?? "") || options.execution?.facts?.supervision?.()?.contractId !== options.execution?.git?.stopBackend.contractId) throw new CatalogError("SUPERVISION_CONTRACT_UNAVAILABLE");
        nativeScenePolicy = await createCompatibilityScenePolicy({ ...input, store, owner,
          currentBinding: () => sceneBinding(runningCatalog.registry.resolve(runningCatalog.legacySessionId)),
          assertBaseline: (actorId, sessionId) => {
            assertBusinessReady(); runningCatalog.assertActorSession(actorId, sessionId, "session:write");
            const target = runningCatalog.registry.resolve(sessionId);
            runningCatalog.workspaces.requireControl(target.workspace.workspaceId);
            if (target.providerInstance.state === "disabled" || !target.providerInstance.policyCapabilities.includes("workspaceWrite") || !target.workspace.capabilities.includes("workspaceWrite")) throw new CatalogError("PROVIDER_CAPABILITY_UNVERIFIED");
          },
        });
        return nativeScenePolicy;
      },
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
