import type { RecoveryEvidence, RecoveryInspectPayload, RecoveryOperation, SessionEvent } from "@flyx/mvp-protocol";
import { inspectCodexNativeTurn } from "../codex/recovery-reader.js";
import type { AppServerClient } from "../codex/app-server-client.js";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import { SystemProcessInspector, type ProcessIdentity, type ProcessInspector } from "../lifecycle/process-inspector.js";
import type { AdapterEvent, DispatchContext, ProviderId } from "../provider/types.js";
import type { NativeHandle, NativeTurnObservation, NativeInspectionExecutionEvidence } from "../provider/native-history.js";
import { inspectNativeBoundaryStop } from "../lifecycle/native-boundary-proof.js";
import type { PlannedEvent } from "../orchestration/command-contract.js";
import type { SqliteStore } from "../storage/db.js";
import { RecoveryError, digest, type RecoveryCommandInput, type RecoveryProcessRecord, type RecoveryTarget, type ExecutionRecoveryObservation, type NotDispatchedRecoveryOutcome } from "../storage/recovery-store.js";
import { RecoveryService } from "./recovery-service.js";

/** Loaded from a verified Provider manifest, never from an RPC payload or version probe. */
export type RecoveryResource = Readonly<{
  provider: ProviderId;
  providerInstanceId: string;
  workspacePath: string;
  configurationFingerprint: string;
  verifiedVersions: readonly string[];
  readerVersion?: string;
}>;
export type RecoveryResourceResolver = (target: { sessionId: string; turnId: string; context: DispatchContext; provider: ProviderId }) => RecoveryResource;
export type ProcessBoundaryObservation = Readonly<{
  state: "stopped" | "running" | "unknown";
  sourceId?: string;
  /** A versioned SDK/container boundary proves all descendants stopped. */
  contractId?: string;
  identityDigest?: string;
}>;
export type StoppedRuntimeRecoveryEvidence = Readonly<{ kind: "execution-stopped"; sourceId: string; evidenceId: string; operationId: string }>;
export type RecoveredRuntimeOutcome = Extract<NativeTurnObservation, { state: "terminal" }> | (NotDispatchedRecoveryOutcome & { state: "not_dispatched" });
export type HostRecoveryOptions = {
  store: SqliteStore;
  owner: HostOwnerHandle;
  sessionId: string;
  workspace: string;
  /** Exact checkout lease root; a Provider workspace can be a subdirectory. */
  checkoutRoot?: string;
  provider: ProviderId;
  resolveResource?: RecoveryResourceResolver;
  processInspector?: ProcessInspector;
  inspectBoundary?: (record: RecoveryProcessRecord, identity: ProcessIdentity) => Promise<ProcessBoundaryObservation>;
  inspectWorkspace?: (target: RecoveryTarget) => Promise<"clear" | "held" | "unknown">;
  /** An existing read-only client. Recovery never constructs or resumes a Provider. */
  codexReader?: (handle: NativeHandle) => Pick<AppServerClient, "request"> | undefined;
  /** Explicit recovery inspection only; never used by ordinary history queries. */
  nativeHistoryReader?: (handle: NativeHandle) => Promise<NativeTurnObservation>;
  verifyNativeInspectionEvidence?: (handle: NativeHandle, evidence: NativeInspectionExecutionEvidence) => boolean;
  canReleaseWorkspace?: (context: DispatchContext) => boolean;
  onCommit?: (events: readonly SessionEvent[]) => void;
  onBlocked?: (context: DispatchContext, reason: string) => void;
  supersedeInteractions?: (sessionId: string, original: { attemptId: string; runtimeGeneration: number }, reason: string) => void;
  reconcileRuntime?: (context: DispatchContext, native: RecoveredRuntimeOutcome) => void;
  reconcileStoppedRuntime?: (context: DispatchContext, evidence: StoppedRuntimeRecoveryEvidence) => void;
  afterRecovery?: (operation: RecoveryOperation, evidenceId: string) => void;
  assertCommandAuthorized?: (input: RecoveryCommandInput) => void | (() => void);
  companionEvents?: (sessionId: string, turnId: string, reason: string) => PlannedEvent[];
};

export type HostRecoveryRequestLifecycle = {
  assertAdmission(): void;
  assertOpen(): void;
  track<T>(work: () => Promise<T>): Promise<T>;
};

/** One factory for live RPC and restricted offline recovery, using the same durable Store. */
export class HostRecovery {
  readonly service: RecoveryService;
  private readonly resolver: RecoveryResourceResolver;
  private accepting = true;
  private sealed = false;
  private requestLifecycle: HostRecoveryRequestLifecycle | undefined;
  constructor(private readonly options: HostRecoveryOptions) {
    this.resolver = options.resolveResource ?? (() => ({ provider: options.provider, providerInstanceId: `legacy:${options.provider}`,
      workspacePath: options.workspace, configurationFingerprint: "unknown",
      verifiedVersions: [] }));
    this.service = new RecoveryService({ store: options.store, inspectExecution: (target) => this.inspectExecution(target),
      inspectNative: (handle) => this.inspectNative(handle), assertCommandAuthorized: (input) => this.authorizeCommand(input),
      ...(options.verifyNativeInspectionEvidence ? { verifyNativeInspectionEvidence: options.verifyNativeInspectionEvidence } : {}),
      ...(options.onCommit ? { onCommit: options.onCommit } : {}),
      ...(options.companionEvents ? { companionEvents: options.companionEvents } : {}) });
  }
  get recovery() { return this.service.recovery; }

  /** Bind an existing loaded service into the same global recovery lane. */
  bindRequestLifecycle(lifecycle: HostRecoveryRequestLifecycle): void {
    if (this.requestLifecycle && this.requestLifecycle !== lifecycle) throw new RecoveryError("RECOVERY_LIFECYCLE_ALREADY_BOUND");
    this.requestLifecycle = lifecycle;
  }
  beginDrain(): void { this.accepting = false; this.service.beginDrain(); }
  seal(): void { this.accepting = false; this.sealed = true; this.service.seal(); }
  private assertOpen(): void {
    if (this.sealed || !this.options.store.db.open) throw new RecoveryError("RECOVERY_CLOSED");
    this.requestLifecycle?.assertOpen();
  }
  private request<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
      if (!this.accepting) throw new RecoveryError("RECOVERY_DRAINING");
      this.requestLifecycle?.assertAdmission();
      return this.requestLifecycle ? this.requestLifecycle.track(work) : work();
    } catch (error) { return Promise.reject(error); }
  }

  assertAdmission(sessionId = this.options.sessionId): void {
    this.options.owner.assertActive();
    if (this.options.owner.recoveryOnly) throw new RecoveryError("HOST_RECOVERY_ONLY");
    const session = this.options.store.getSession(sessionId);
    if (!session) throw new RecoveryError("SESSION_NOT_FOUND");
    if (session.recoveryState === "blocked" || this.options.owner.retainedReason) throw new RecoveryError("RECOVERY_BLOCKED");
  }

  /** Called only after the Orchestrator has admitted the complete original event fence. */
  recordNativeEvent(event: AdapterEvent): void {
    if (event.kind !== "session_init" && event.kind !== "native_binding") return;
    const context = event.dispatchContext;
    this.validateLiveContext(context);
    const resource = this.resource(context, this.options.provider);
    if (event.kind === "session_init" && event.provider !== resource.provider) throw new RecoveryError("NATIVE_BINDING_MISMATCH");
    const previous = this.recovery.nativeHandle(context.flyxTurnId, context.attemptId);
    const observedVersion = event.kind === "session_init" ? event.runtimeVersion : previous?.verifiedVersion;
    const verifiedVersion = observedVersion && resource.verifiedVersions.includes(observedVersion) ? observedVersion : "unknown";
    this.recovery.recordNativeBinding({ context, provider: resource.provider, providerInstanceId: resource.providerInstanceId,
      nativeSessionId: event.kind === "session_init" ? event.providerSessionId : event.nativeSessionId,
      ...(event.kind === "native_binding" ? { nativeTurnId: event.nativeTurnId } : {}), workspacePath: resource.workspacePath,
      configurationFingerprint: resource.configurationFingerprint, verifiedVersion });
  }

  /** Invoke in the same transaction as known-terminal settlement, before its active relation is cleared. */
  protectTerminal(context: DispatchContext): boolean {
    this.validateLiveContext(context);
    let canRelease = false;
    try { canRelease = this.options.canReleaseWorkspace?.(context) === true; } catch { /* An inspection failure retains admission. */ }
    if (canRelease) return false;
    const changed = this.options.store.db.prepare(`UPDATE sessions SET recovery_state = 'blocked', recovery_revision = recovery_revision + 1,
      activity_state = 'outcome_unknown' WHERE id = ? AND active_turn_id = ? AND recovery_state = 'idle'`)
      .run(context.sessionId, context.flyxTurnId);
    return changed.changes === 1 || this.options.store.getSession(context.sessionId)?.recoveryState === "blocked";
  }
  retained(context: DispatchContext): void {
    this.options.onBlocked?.(context, "producer_stop_unverified");
    this.options.supersedeInteractions?.(context.sessionId, { attemptId: context.attemptId, runtimeGeneration: context.runtimeGeneration }, "recovery_blocked");
  }
  inspect(input: RecoveryInspectPayload): Promise<RecoveryEvidence> {
    return this.request(() => { this.assertTargetSession(input.sessionId); return this.service.inspect(input); });
  }
  reconcile(input: RecoveryCommandInput): Promise<RecoveryOperation> {
    return this.request(async () => {
      this.assertTargetSession(input.sessionId);
      const operation = await this.service.reconcile(input);
      this.assertOpen();
      this.afterCommitted(operation, input.evidenceId);
      return operation;
    });
  }
  acknowledge(input: RecoveryCommandInput & { acknowledgeUnknown: true }): Promise<RecoveryOperation> {
    return this.request(async () => {
      this.assertTargetSession(input.sessionId);
      const operation = await this.service.acknowledge(input);
      this.assertOpen();
      this.afterCommitted(operation, input.evidenceId);
      return operation;
    });
  }

  private authorizeCommand(input: RecoveryCommandInput): void | (() => void) {
    this.assertOpen();
    this.options.owner.assertActive();
    if (this.options.assertCommandAuthorized) return this.options.assertCommandAuthorized(input);
    if (this.options.owner.recoveryOnly && input.authSubjectId === `local-recovery:${this.options.owner.ownerId}`) return;
    const actor = this.options.store.getDevice(input.authSubjectId);
    if (!actor || actor.revokedAt || actor.expiresAt && actor.expiresAt <= new Date().toISOString()) throw new RecoveryError("DEVICE_REVOKED");
    if (!actor.scopes.includes("session:write")) throw new RecoveryError("FORBIDDEN");
  }

  private afterCommitted(operation: RecoveryOperation, evidenceId: string): void {
    this.assertOpen();
    if (operation.state !== "completed") return;
    evidenceId = this.recovery.operation(operation.operationId)?.evidenceId ?? evidenceId;
    const target = this.recovery.target(operation.sessionId, operation.turnId, operation.attemptId);
    const evidence = this.recovery.evidence(evidenceId);
    if (operation.recoveryRevision !== target.session.recoveryRevision
      || operation.gate === "released" && target.session.activeTurnId !== undefined
      || operation.gate === "blocked" && target.session.activeTurnId !== operation.turnId) return;
    if (target.context) {
      this.options.supersedeInteractions?.(target.session.id, { attemptId: target.context.attemptId, runtimeGeneration: target.context.runtimeGeneration }, "recovery_settled");
      this.assertOpen();
      if (evidence?.native.state === "terminal" && operation.gate === "released") this.options.reconcileRuntime?.(target.context, evidence.native);
      else if (evidence?.committedOutcome && operation.gate === "released") this.options.reconcileRuntime?.(target.context, { ...evidence.committedOutcome, state: "not_dispatched" });
      this.assertOpen();
      const journal = this.recovery.operation(operation.operationId);
      const stopped = evidence?.execution.evidence;
      if (operation.gate === "released" && journal?.phase === "completed" && journal.action === "acknowledge"
        && evidence?.execution.state === "stopped" && evidence.execution.workspaceState === "clear" && stopped?.kind === "process-tree-stopped") {
        this.options.reconcileStoppedRuntime?.(target.context, Object.freeze({ kind: "execution-stopped", sourceId: stopped.sourceId,
          evidenceId, operationId: operation.operationId }));
      }
      this.assertOpen();
      if (operation.gate === "blocked") this.options.onBlocked?.(target.context, "producer_stop_unverified");
    }
    this.assertOpen();
    this.options.afterRecovery?.(operation, evidenceId);
  }

  private resource(context: DispatchContext, provider: ProviderId): RecoveryResource {
    const resource = this.resolver({ sessionId: context.sessionId, turnId: context.flyxTurnId, context, provider });
    if (resource.provider !== provider || resource.workspacePath !== this.options.workspace || !resource.providerInstanceId || !resource.configurationFingerprint
      || !Array.isArray(resource.verifiedVersions) || resource.verifiedVersions.some((version) => !version || version === "unknown")) throw new RecoveryError("RECOVERY_RESOURCE_MISMATCH");
    return Object.freeze({ ...resource, verifiedVersions: Object.freeze([...resource.verifiedVersions]) });
  }
  private validateLiveContext(context: DispatchContext): void {
    this.options.owner.assertActive();
    if (this.options.owner.recoveryOnly) throw new RecoveryError("HOST_RECOVERY_ONLY");
    const target = this.recovery.target(context.sessionId, context.flyxTurnId, context.attemptId);
    if (context.hostOwnerId !== this.options.owner.ownerId || context.hostOwnerGeneration !== this.options.owner.generation
      || context.sessionId !== this.options.sessionId || target.session.activeTurnId !== context.flyxTurnId
      || target.turn.attemptId !== context.attemptId || target.turn.generation !== context.runtimeGeneration
      || target.context && digest(target.context) !== digest(context)) throw new RecoveryError("RECOVERY_CONTEXT_MISMATCH");
  }
  private assertTargetSession(sessionId: string): void {
    this.assertOpen();
    this.options.owner.assertActive();
    if (sessionId !== this.options.sessionId) throw new RecoveryError("SESSION_NOT_FOUND");
  }

  private async inspectNative(handle: NativeHandle): Promise<NativeTurnObservation> {
    this.assertOpen();
    const resource = this.resource(handle.context, handle.provider);
    if (resource.providerInstanceId !== handle.providerInstanceId || resource.configurationFingerprint !== handle.configurationFingerprint
      || !resource.verifiedVersions.includes(handle.verifiedVersion)) return { state: "unknown", reason: "native_history_configuration_unverified" };
    if (this.options.nativeHistoryReader) {
      const observed = await this.options.nativeHistoryReader(handle);
      this.assertOpen();
      if (observed.state === "terminal" && (observed.nativeSessionId !== handle.nativeSessionId
        || observed.nativeTurnId !== undefined && observed.nativeTurnId !== handle.nativeTurnId
        || observed.evidence.verifiedVersion !== handle.verifiedVersion)) return { state: "unknown", reason: "native_history_binding_mismatch" };
      return observed;
    }
    if (handle.provider === "codex") {
      const client = this.options.codexReader?.(handle);
      if (!client || !resource.readerVersion) return { state: "unknown", reason: "native_history_reader_unavailable" };
      const observed = await inspectCodexNativeTurn(handle, { client, verifiedVersions: resource.verifiedVersions, readerVersion: resource.readerVersion });
      this.assertOpen();
      return observed;
    }
    // These are original captured SDK result events, not user/assistant transcript endings.
    const events = this.options.store.db.prepare(`SELECT id,type,payload_json FROM session_events WHERE session_id = ?
      AND type IN ('turn.completed','turn.failed','turn.cancelled') AND json_extract(payload_json,'$.dispatchContext.flyxTurnId') = ?
      AND json_extract(payload_json,'$.dispatchContext.attemptId') = ? ORDER BY sequence`)
      .all(handle.sessionId, handle.turnId, handle.attemptId) as Array<{ id: string; type: string; payload_json: string }>;
    const matches = events.filter((row) => {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const terminalEvidence = payload.terminalEvidence as { kind?: string } | undefined;
      return digest(payload.dispatchContext) === digest(handle.context)
        && (payload.kind === "turn_completed" || terminalEvidence?.kind === "native-terminal");
    });
    if (matches.length !== 1) return { state: "unknown", reason: "original_sdk_terminal_proof_unavailable" };
    const original = matches[0]!;
    return { state: "terminal", nativeSessionId: handle.nativeSessionId,
      status: original.type === "turn.completed" ? "completed" : original.type === "turn.failed" ? "failed" : "cancelled",
      evidence: { kind: "native-terminal", sourceId: original.id, verifiedVersion: handle.verifiedVersion, dispatchContext: handle.context } };
  }

  private async inspectExecution(target: RecoveryTarget): Promise<ExecutionRecoveryObservation> {
    this.assertOpen();
    if (!target.context || !target.turn.attemptId || !target.processes.length) return { state: "unknown", workspaceState: "unknown", reason: "original_process_identity_missing" };
    const inspector = this.options.processInspector ?? new SystemProcessInspector();
    const proofs: Array<{ id: string; sourceId: string; contractId: string; identityDigest?: string }> = [];
    for (const record of target.ownerProcesses) {
      if (record.state === "not_spawned" && record.pid === undefined && record.processGroup === undefined && !record.processIdentity && !record.stopProof) { proofs.push({ id: record.id, sourceId: digest(record), contractId: "spawn-not-created" }); continue; }
      const identity = record.processIdentity;
      if (!identity || !identity.birth || identity.birth.kind !== "linux" || identity.platform !== "linux" || identity.pid !== record.pid
        || !/^[a-f0-9-]{36}$/i.test(identity.birth.bootId) || !/^\d+$/.test(identity.birth.startTicks)) return { state: "unknown", workspaceState: "unknown", reason: "original_process_birth_unverified" };
      const root = inspector.inspect(identity);
      if (root.state === "alive") return { state: "running", workspaceState: "held", reason: "original_process_alive" };
      if (root.state !== "exited") return { state: "unknown", workspaceState: "unknown", reason: "original_tree_boundary_unverified" };
      const boundary = this.options.inspectBoundary ? await this.options.inspectBoundary(record, Object.freeze(identity))
        : inspectNativeBoundaryStop(record.boundary?.proof, identity, inspector, (proof, original) => {
          const current = this.recovery.target(target.session.id, target.turn.id, target.turn.attemptId);
          const saved = current.ownerProcesses.find((candidate) => candidate.id === record.id);
          return !!saved?.boundary && !!record.boundary && /^[a-f0-9]{64}$/.test(saved.boundary.launchDigest)
            && digest(saved) === digest(record) && digest(saved.boundary.proof) === digest(proof)
            && saved.boundary.launchDigest === record.boundary.launchDigest && digest(saved.processIdentity) === digest(original)
            && !!current.context && digest(current.context) === digest(target.context);
        });
      this.assertOpen();
      if (boundary.state !== "stopped" || !boundary.sourceId || !boundary.contractId || boundary.identityDigest !== processIdentityDigest(identity)) {
        return { state: boundary.state === "running" ? "running" : "unknown", workspaceState: boundary.state === "running" ? "held" : "unknown", reason: "original_tree_boundary_unverified" };
      }
      proofs.push({ id: record.id, sourceId: boundary.sourceId, contractId: boundary.contractId, identityDigest: boundary.identityDigest });
    }
    const workspaceState = await this.options.inspectWorkspace?.(target) ?? "unknown";
    this.assertOpen();
    return { state: "stopped", workspaceState, evidence: { kind: "process-tree-stopped", sourceId: digest(proofs), ownerId: target.context.hostOwnerId,
      ownerGeneration: target.context.hostOwnerGeneration, resourceKeys: [...this.options.owner.resourceKeys, `workspace:${this.options.checkoutRoot ?? this.options.workspace}`],
      processRecordIds: proofs.map((proof) => proof.id) } };
  }

}

export function createHostRecovery(options: HostRecoveryOptions): HostRecovery { return new HostRecovery(options); }
