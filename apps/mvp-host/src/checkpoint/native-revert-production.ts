import type { SessionNativeHandle } from "@flyx/mvp-protocol";
import { SessionNativeHandleSchema } from "@flyx/mvp-protocol";
import type { HostCatalog } from "../catalog/host-catalog.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { catalogRecoveryConfigurationFingerprint } from "../session/catalog-recovery.js";
import { HostManagedRuntime } from "../provider/native-runtime-factory.js";
import { ManagedRuntimeController } from "../provider/managed-runtime.js";
import type { DispatchContext } from "../provider/types.js";
import type { NativeHistoryManifestSource } from "../provider/native-history-manifest.js";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { validateTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import type { SqliteStore } from "../storage/db.js";
import type { HostViews } from "../timeline/host-views.js";
import { TimelineBackfill } from "../timeline/backfill.js";
import { assertRestoreWriteReady } from "../operations/restore-service.js";
import { bindingDigest } from "./git-driver.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { inspectManagedNativeRevertExecution, HostManagedNativeRevertPort, MANAGED_NATIVE_REVERT_BOUNDARY_VERSION } from "./managed-native-revert-port.js";
import { ClaudeNativeRevertDriver, CodexNativeRevertDriver, NATIVE_REVERT_DRIVER_VERSION, ProviderNativeRevertDriver, type NativeRevertHandle, type TrustedNativeRevertCapability } from "./native-revert-drivers.js";
import { checkpointNativeHandleResolver, createNativeCheckpointAnchorCapture } from "./native-revert-anchors.js";
import type { NativeRevertMutation, NativeRevertMutationJournal } from "./native-revert-drivers.js";
import { randomUUID } from "node:crypto";
import type { CheckpointServiceOptions } from "./checkpoint-service.js";
import type { RevertOperation } from "./revert-types.js";
import type { HostRevertPorts } from "./host-checkpoints.js";

export type ProductionNativeRevertOptions = Readonly<{
  store: SqliteStore;
  owner: HostOwnerHandle;
  catalog: Pick<HostCatalog, "catalog" | "registry">;
  views: Pick<HostViews, "store" | "content" | "projector">;
  /** Trusted R4 manifest source with the live resource port attached. */
  manifestSource: Pick<NativeHistoryManifestSource, "verifiedManifestForInstance">;
  now?: () => Date;
}>;

export type ProductionNativeRevert = {
  ports: HostRevertPorts;
  captureNativeAnchor: NonNullable<CheckpointServiceOptions["captureNativeAnchor"]>;
};

type ManagedRow = { id: string; state: string; pid: number | null; process_group: number | null; identity_json: string | null; boundary_json: string | null; launch_digest: string | null; proof_json: string | null };

const IDLE = "idle";

function rowProven(row: ManagedRow): boolean {
  if (row.state === "not_spawned" && row.pid === null) return true;
  if (row.state !== "stopped" || !row.identity_json || !row.proof_json || !row.launch_digest) return false;
  try {
    validateTreeStopEvidence(JSON.parse(row.proof_json), JSON.parse(row.identity_json),
      row.boundary_json ? { proof: JSON.parse(row.boundary_json), launchDigest: row.launch_digest } : undefined,
      row.process_group ?? undefined);
    return true;
  } catch { return false; }
}

/**
 * Production revert wiring (design R6): every port is derived from live owned
 * state — the loaded Session runtime, the managed-process journal rows, the
 * trusted R4 compatibility manifest and the real catalog rows. Nothing is
 * supplied by an RPC body or environment variable, and every missing fact
 * keeps the capability unavailable (fail-closed) instead of guessed.
 */
export function createProductionNativeRevert(options: ProductionNativeRevertOptions): ProductionNativeRevert | undefined {
  const { store, owner, catalog, views } = options;
  const db = store.db;
  const providerRecords = catalog.catalog.providers().filter((record) => (record.provider === "codex" || record.provider === "claude") && record.executable);
  if (!providerRecords.some((record) => record.provider === "codex") && !providerRecords.some((record) => record.provider === "claude")) return undefined;
  const codexExecutable = providerRecords.find((record) => record.provider === "codex")?.executable;

  /** Session resource for a canonical native binding, from live catalog rows only. */
  const resolveByBinding = (binding: SessionNativeHandle) => {
    const session = catalog.catalog.allSessions().find((candidate) => candidate.nativeHandle
      && candidate.nativeHandle.provider === binding.provider && candidate.nativeHandle.providerInstanceId === binding.providerInstanceId
      && candidate.nativeHandle.workspaceId === binding.workspaceId && candidate.nativeHandle.nativeSessionId === binding.nativeSessionId);
    if (!session?.nativeHandle) return undefined;
    try { return catalog.registry.resolve(session.sessionId); } catch { return undefined; }
  };

  const currentHandle = (binding: SessionNativeHandle): NativeRevertHandle | undefined => {
    const target = resolveByBinding(binding);
    if (!target || !target.workspace.worktreeRoot || target.providerInstance.verification.state !== "verified" || !target.providerInstance.verification.runtimeVersion) return undefined;
    const manifest = options.manifestSource.verifiedManifestForInstance(binding.provider, binding.providerInstanceId, target.session.sessionId);
    if (!manifest || !manifest.verifiedVersions.includes(target.providerInstance.verification.runtimeVersion!)) return undefined;
    return {
      provider: binding.provider, providerInstanceId: binding.providerInstanceId, nativeSessionId: binding.nativeSessionId,
      workspaceId: binding.workspaceId, workspacePath: target.workspace.worktreeRoot,
      configurationFingerprint: catalogRecoveryConfigurationFingerprint(target), verifiedVersion: target.providerInstance.verification.runtimeVersion!,
      sessionId: target.session.sessionId,
    };
  };

  /** Original attempt context is reproducible after owner restart from the persisted operation row. */
  const dispatchContextForOperation = (mutation: NativeRevertMutation): DispatchContext => {
    const row = db.prepare("SELECT operation_json FROM checkpoint_revert_operations WHERE operation_id=?").get(mutation.operationId) as { operation_json: string } | undefined;
    if (!row) throw new Error("NATIVE_REVERT_OPERATION_UNAVAILABLE");
    const operation = JSON.parse(row.operation_json) as RevertOperation;
    const command = operation.commands.find((entry) => entry.dispatchContext.flyxTurnId === mutation.operationId && entry.dispatchContext.attemptId === mutation.requestId);
    if (!command) throw new Error("NATIVE_REVERT_OPERATION_UNAVAILABLE");
    return structuredClone(command.dispatchContext);
  };

  const sessionRows = (sessionId: string): ManagedRow[] => db.prepare(`SELECT p.id,p.state,p.pid,p.process_group,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json FROM managed_processes p
    LEFT JOIN managed_process_identities i ON i.process_id=p.id
    LEFT JOIN managed_process_boundaries b ON b.process_id=p.id
    LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id
    WHERE p.session_id=? ORDER BY p.id`).all(sessionId) as ManagedRow[];
  /** Original native producers only; a queued, not-yet-invoked Turn is allowed. */
  const nativeState = (handle: NativeRevertHandle): { quiescent: boolean; pendingRequest: boolean } => {
    const sessionId = typeof handle.sessionId === "string" ? handle.sessionId : undefined;
    if (!sessionId) return { quiescent: false, pendingRequest: true };
    const rows = sessionRows(sessionId);
    const session = db.prepare("SELECT recovery_state FROM sessions WHERE id=?").get(sessionId) as { recovery_state: string } | undefined;
    const quiescent = Boolean(session && session.recovery_state === IDLE && rows.every(rowProven));
    return { quiescent, pendingRequest: !quiescent };
  };
  const proveQuiescence = async (operation: RevertOperation): Promise<{ proven: boolean; proofId: string }> => {
    const rows = sessionRows(operation.sessionId);
    const session = db.prepare("SELECT recovery_state FROM sessions WHERE id=?").get(operation.sessionId) as { recovery_state: string } | undefined;
    return { proven: Boolean(session && session.recovery_state === IDLE && rows.every(rowProven)), proofId: bindingDigest({ rows }) };
  };

  /** Per-session managed runtime; the revert helper must never borrow another Session's boundary. */
  const runtimes = new Map<string, HostManagedRuntime>();
  const controllers = new Map<string, ManagedRuntimeController>();
  const prepareRuntime = (context: DispatchContext) => {
    const target = catalog.registry.resolve(context.sessionId);
    const key = `${context.sessionId}:${context.runtimeId}`;
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = new HostManagedRuntime({
        store, owner, sessionId: context.sessionId, runtimeId: context.runtimeId,
        workspace: target.workspace.worktreeRoot ?? target.workspace.canonicalRoot, provider: target.providerInstance.provider,
        assertDispatch: (candidate) => {
          owner.assertActive(); store.assertWriterOwner();
          if (candidate.sessionId !== context.sessionId || candidate.runtimeId !== context.runtimeId) throw new Error("NATIVE_REVERT_CONTEXT_REBOUND");
        },
      });
      runtimes.set(key, runtime);
      controllers.set(key, new ManagedRuntimeController(runtime.options));
    }
    return controllers.get(key)!.prepare(context);
  };

  const assertCurrent = (handle: NativeRevertHandle, mutation?: NativeRevertMutation): void => {
    owner.assertActive(); store.assertWriterOwner();
    if (mutation) {
      const row = db.prepare("SELECT operation_json FROM checkpoint_revert_operations WHERE operation_id=?").get(mutation.operationId) as { operation_json: string } | undefined;
      if (!row) throw new Error("NATIVE_REVERT_OPERATION_UNAVAILABLE");
    }
  };
  const contextFor = (handle: NativeRevertHandle, mutation?: NativeRevertMutation): DispatchContext => {
    if (mutation) return dispatchContextForOperation(mutation);
    if (handle.captureContext) return structuredClone(handle.captureContext);
    const sessionId = typeof handle.sessionId === "string" ? handle.sessionId : undefined;
    if (!sessionId) throw new Error("NATIVE_REVERT_CONTEXT_INVALID");
    // Reads are idempotent and journal-free, so the exact (owner, Session, native
    // binding) tuple must reproduce an identical context: the port re-evaluates
    // this callback inside its anti-rebound digest check, and a fresh random
    // attemptId would fail every real read closed as NATIVE_REVERT_CONTEXT_REBOUND.
    return { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: "native-revert-read", runtimeGeneration: 1, sessionId, flyxTurnId: "native-revert-read",
      attemptId: `native-revert-read:${bindingDigest({ sessionId, provider: handle.provider, providerInstanceId: handle.providerInstanceId, workspaceId: handle.workspaceId, nativeSessionId: handle.nativeSessionId })}` };
  };

  /** The mutation journal is owned by the RevertService; each instance binds a fresh port to it. */
  const buildPort = (journal: NativeRevertMutationJournal) => new HostManagedNativeRevertPort({
    // The per-session runtime is selected from the exact dispatch context; the
    // static controller is never used because prepareRuntime is always present.
    runtime: {},
    journal,
    contextFor,
    assertCurrent,
    nativeState,
    inspectExecution: (context) => inspectManagedNativeRevertExecution(db, context),
    // The per-session managed runtime is prepared from the exact dispatch
    // context; a Session never borrows another Session's execution boundary.
    prepareRuntime,
    ...(codexExecutable ? { codex: { executable: codexExecutable } } : { codex: { executable: "" } }),
    claude: {},
  });
  // Anchor capture is read-only: it never claims, mutates or queries a journal.
  const readJournal: NativeRevertMutationJournal = { claim: () => { throw new Error("NATIVE_REVERT_JOURNAL_UNAVAILABLE"); }, get: () => Promise.resolve(undefined), record: () => { throw new Error("NATIVE_REVERT_JOURNAL_UNAVAILABLE"); } };

  const capability = (handle: NativeRevertHandle): TrustedNativeRevertCapability | undefined => {
    const sessionId = typeof handle.sessionId === "string" ? handle.sessionId : undefined;
    const manifest = sessionId ? options.manifestSource.verifiedManifestForInstance(handle.provider, handle.providerInstanceId, sessionId) : undefined;
    if (!manifest || !manifest.verifiedVersions.includes(handle.verifiedVersion)) return undefined;
    return {
      provider: handle.provider, providerInstanceId: handle.providerInstanceId,
      configurationFingerprint: handle.configurationFingerprint, verifiedVersion: handle.verifiedVersion,
      evidenceId: manifest.evidenceId, driverVersion: NATIVE_REVERT_DRIVER_VERSION,
      managedBoundaryVersion: MANAGED_NATIVE_REVERT_BOUNDARY_VERSION,
      operations: handle.provider === "codex" ? ["conversation-rewind", "new-conversation"] : ["conversation-rewind"],
    };
  };
  const resolveHandle = checkpointNativeHandleResolver({ checkpoints: new CheckpointStore(db), current: currentHandle });

  const ports: HostRevertPorts = {
    acquire: async (input) => {
      const host = catalog.registry.loaded(input.sessionId);
      if (!(host instanceof SessionOrchestrator)) throw new Error("CHECKPOINT_RUNTIME_UNAVAILABLE");
      return { lease: await host.ensureCheckpointLease({ actorId: input.actorId, purpose: "revert" }) };
    },
    dispatchContextFor: (context, operationId, attemptId) => {
      const host = catalog.registry.loaded(context.sessionId);
      if (!(host instanceof SessionOrchestrator)) throw new Error("CHECKPOINT_RUNTIME_UNAVAILABLE");
      return { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: context.sessionId, flyxTurnId: operationId, runtimeId: host.runtimeId, runtimeGeneration: context.runtimeGeneration, attemptId };
    },
    nativeFactory: (journal) => {
      const port = buildPort(journal);
      return new ProviderNativeRevertDriver({
        ...(codexExecutable ? { codex: new CodexNativeRevertDriver({ resolveHandle, capability, port, journal, ...(options.now ? { now: options.now } : {}) }) } : {}),
        claude: new ClaudeNativeRevertDriver({ resolveHandle, capability, port, journal, ...(options.now ? { now: options.now } : {}) }),
      });
    },
    proveQuiescence,
    projectSuccess: (transaction, input) => {
      const nativeHandle = SessionNativeHandleSchema.parse(input.nativeProof.nativeHandle);
      catalog.catalog.setNativeHandle(input.operation.sessionId, nativeHandle);
      views.projector.createEpoch(input.operation.sessionId, "building", input.epoch);
      new TimelineBackfill(views.projector, () => owner.assertActive()).run(input.operation.sessionId, { epoch: input.epoch });
      return { epoch: input.epoch, nativeHandleBinding: bindingDigest(nativeHandle) };
    },
    assertRestoreWriteReady: (transaction) => { owner.assertActive(); store.assertWriterOwner(); assertRestoreWriteReady(transaction); },
    verifiedNativeCapabilities: async (sessionId) => {
      const target = catalog.registry.resolve(sessionId);
      const handle = target.session.nativeHandle;
      if (!handle || target.providerInstance.verification.state !== "verified" || !target.providerInstance.verification.runtimeVersion) return [];
      const manifest = options.manifestSource.verifiedManifestForInstance(handle.provider, handle.providerInstanceId, sessionId);
      if (!manifest || !manifest.verifiedVersions.includes(target.providerInstance.verification.runtimeVersion)) return [];
      return [{ kind: "conversation-rewind" as const, evidenceId: manifest.evidenceId, driverVersion: NATIVE_REVERT_DRIVER_VERSION, verifiedVersion: target.providerInstance.verification.runtimeVersion }];
    },
  };

  const metadataFor = (binding: SessionNativeHandle, context: { sessionId: string; turnId?: string; attemptId?: string; runtimeGeneration: number }): NativeRevertHandle | undefined => {
    const current = currentHandle(binding);
    if (!current) return undefined;
    if (context.turnId && context.attemptId) {
      const host = catalog.registry.loaded(context.sessionId);
      if (!(host instanceof SessionOrchestrator)) return undefined;
      current.captureContext = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: context.sessionId, flyxTurnId: context.turnId, attemptId: context.attemptId, runtimeId: host.runtimeId, runtimeGeneration: context.runtimeGeneration };
    }
    return current;
  };

  return { ports, captureNativeAnchor: createNativeCheckpointAnchorCapture({ port: buildPort(readJournal), metadataFor }) };
}
