import { randomUUID } from "node:crypto";
import type { RecoveryEvidence, RecoveryInspectPayload, RecoveryOperation, SessionEvent } from "@flyx/mvp-protocol";
import type { NativeHandle, NativeTurnObservation } from "../provider/native-history.js";
import type { PlannedEvent } from "../orchestration/command-contract.js";
import type { SqliteStore } from "../storage/db.js";
import { RecoveryError, RecoveryStore, digest } from "../storage/recovery-store.js";
import type { ExecutionRecoveryObservation, RecoveryCommandInput, RecoveryTarget, StoredRecoveryEvidence, NotDispatchedRecoveryOutcome } from "../storage/recovery-store.js";

export type RecoveryServiceOptions = {
  store: SqliteStore;
  /** Read-only: inspect the original execution tree and its canonical checkout lease. */
  inspectExecution?: (target: RecoveryTarget) => Promise<ExecutionRecoveryObservation>;
  /** Read-only: never resume/start a conversation or repeat the original command. */
  inspectNative?: (handle: NativeHandle) => Promise<NativeTurnObservation>;
  now?: () => string;
  id?: () => string;
  evidenceTtlMs?: number;
  onCommit?: (events: readonly SessionEvent[]) => void;
  /** Capture a per-call recheck; legacy void hooks run again after asynchronous inspection. */
  assertCommandAuthorized?: (input: RecoveryCommandInput) => void | (() => void);
  companionEvents?: (sessionId: string, turnId: string, reason: string) => PlannedEvent[];
};

/** Result recovery and execution release are separate, evidence-bound operations. */
export class RecoveryService {
  readonly recovery: RecoveryStore;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly evidenceTtlMs: number;
  private readonly running = new Map<string, { hash: string; result: Promise<RecoveryOperation> }>();
  private accepting = true;
  private sealed = false;
  constructor(private readonly options: RecoveryServiceOptions) {
    this.recovery = new RecoveryStore(options.store, { ...(options.companionEvents ? { companionEvents: options.companionEvents } : {}) });
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    this.evidenceTtlMs = Math.max(1, Math.min(60_000, options.evidenceTtlMs ?? 30_000));
  }

  /** Stop new requests while admitted work can still finish on the open Store. */
  beginDrain(): void { this.accepting = false; }
  /** In-flight observations may finish, but can no longer reach SQL or publication. */
  seal(): void { this.accepting = false; this.sealed = true; }
  private assertOpen(): void {
    if (this.sealed || !this.options.store.db.open) throw new RecoveryError("RECOVERY_CLOSED");
  }
  private assertRequestAdmission(): void {
    this.assertOpen();
    if (!this.accepting) throw new RecoveryError("RECOVERY_DRAINING");
  }
  private publish(events: readonly SessionEvent[]): void {
    this.assertOpen();
    this.options.onCommit?.(events);
  }

  async inspect(input: RecoveryInspectPayload): Promise<RecoveryEvidence> {
    this.assertRequestAdmission();
    const target = this.recovery.target(input.sessionId, input.turnId, input.attemptId);
    const observed = await this.observe(target);
    this.assertOpen();
    const observedAt = this.now();
    const view: RecoveryEvidence = {
      evidenceId: this.id(), sessionId: target.session.id, turnId: target.turn.id,
      ...(target.turn.attemptId ? { attemptId: target.turn.attemptId } : {}), recoveryRevision: target.session.recoveryRevision,
      observedAt, expiresAt: new Date(Date.parse(observedAt) + this.evidenceTtlMs).toISOString(),
      processState: observed.execution.state, workspaceState: observed.execution.workspaceState, nativeState: observed.native.state,
      ...(observed.native.state === "terminal" ? { nativeOutcome: observed.native.status } : {}),
      ...(observed.committedOutcome ? { committedOutcome: { status: observed.committedOutcome.status, source: "not-dispatched" as const } } : {}),
      nextSteps: ["inspect", ...(observed.native.state === "terminal" || observed.committedOutcome && this.canRelease(observed.execution) ? ["reconcile" as const] : []),
        ...(this.canRelease(observed.execution) && target.session.activeTurnId === target.turn.id && target.turn.status === "outcome_unknown"
          && observed.native.state !== "terminal" ? ["acknowledge" as const] : []),
        ...(!this.canRelease(observed.execution) ? ["local_inspection" as const] : [])],
    };
    const stop = observed.execution.evidence;
    const evidence: StoredRecoveryEvidence = { view, factsFingerprint: target.factsFingerprint, ...observed,
      ...(stop ? { ownerJournalFingerprint: this.recovery.ownerJournalFingerprint(stop.ownerId, stop.ownerGeneration) } : {}) };
    this.assertOpen();
    this.recovery.saveEvidence(target, evidence);
    return view;
  }

  reconcile(input: RecoveryCommandInput): Promise<RecoveryOperation> { return this.run(input, "reconcile"); }
  acknowledge(input: RecoveryCommandInput & { acknowledgeUnknown: true }): Promise<RecoveryOperation> { return this.run(input, "acknowledge"); }

  private run(input: RecoveryCommandInput, action: "reconcile" | "acknowledge"): Promise<RecoveryOperation> {
    try { this.assertRequestAdmission(); } catch (error) { return Promise.reject(error); }
    if (!input.commandId || !input.authSubjectId) return Promise.reject(new RecoveryError("COMMAND_ID_REQUIRED"));
    if (action === "acknowledge" && input.acknowledgeUnknown !== true) return Promise.reject(new RecoveryError("RECOVERY_ACKNOWLEDGEMENT_REQUIRED"));
    const hash = digest({ action, sessionId: input.sessionId, turnId: input.turnId, attemptId: input.attemptId ?? null,
      evidenceId: input.evidenceId, expectedRecoveryRevision: input.expectedRecoveryRevision, acknowledgeUnknown: input.acknowledgeUnknown ?? false });
    const key = JSON.stringify([input.authSubjectId, input.commandId]);
    const running = this.running.get(key);
    if (running) return running.hash === hash ? running.result : Promise.reject(new RecoveryError("COMMAND_ID_REUSED"));
    const result = this.perform(input, action, hash);
    this.running.set(key, { hash, result });
    void result.finally(() => this.running.delete(key)).catch(() => {});
    return result;
  }

  private async perform(request: RecoveryCommandInput, action: "reconcile" | "acknowledge", hash: string): Promise<RecoveryOperation> {
    const input = Object.freeze({ ...request });
    this.assertOpen();
    const continuation = this.options.assertCommandAuthorized?.(input);
    if (continuation !== undefined && typeof continuation !== "function") throw new RecoveryError("SYNCHRONOUS_RECOVERY_AUTHORIZATION_REQUIRED");
    this.assertOpen();
    const marked = this.recovery.beginOperation(input, action, hash, this.now());
    if (marked.operation.result) return marked.operation.result;
    this.publish(marked.events);
    this.assertOpen();
    const journal = marked.operation;
    this.recovery.markChecking(journal.id, this.now());
    try {
      const { target, evidence } = this.recovery.validateEvidence(input, this.now());
      const observed = await this.observe(target);
      this.assertOpen();
      if (digest(observed.execution) !== digest(evidence.execution) || digest(observed.native) !== digest(evidence.native) || digest(observed.committedOutcome ?? null) !== digest(evidence.committedOutcome ?? null)) {
        throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
      }
      const rechecked = continuation ? continuation() : this.options.assertCommandAuthorized?.(input);
      if (rechecked !== undefined) throw new RecoveryError("SYNCHRONOUS_RECOVERY_AUTHORIZATION_REQUIRED");
      this.assertOpen();
      const release = this.canRelease(observed.execution);
      if (action === "reconcile" && observed.native.state !== "terminal" && !(observed.committedOutcome && release)
        || action === "acknowledge" && (!release || observed.native.state === "terminal")) {
        const blocked = this.recovery.failOperation(journal, "RECOVERY_BLOCKED", this.now());
        this.publish(blocked.events);
        return blocked.result;
      }
      const settled = this.recovery.finishOperation(input, journal, evidence, observed.native, release, this.now());
      this.publish(settled.events);
      return settled.result;
    } catch (error) {
      // Sealing leaves the already accepted journal/receipt untouched. A late
      // observation cannot turn shutdown into a failed-operation SQL callback.
      this.assertOpen();
      if (error instanceof RecoveryError) {
        const failed = this.recovery.failOperation(journal, error.code, this.now());
        this.publish(failed.events);
      }
      // Database failures leave the accepted marker for explicit query/recovery;
      // they never turn a possibly-sent original command into a replay intent.
      throw error;
    }
  }

  private async observe(target: RecoveryTarget): Promise<{ execution: ExecutionRecoveryObservation; native: NativeTurnObservation; committedOutcome?: NotDispatchedRecoveryOutcome }> {
    this.assertOpen();
    const [execution, native] = await Promise.allSettled([
      this.options.inspectExecution ? this.options.inspectExecution(target) : Promise.resolve(defaultExecutionObservation(target)),
      target.nativeHandle && this.options.inspectNative ? this.options.inspectNative(target.nativeHandle) : Promise.resolve<NativeTurnObservation>({ state: "unknown", reason: "native_history_inspection_unavailable" }),
    ]);
    this.assertOpen();
    return {
      execution: this.normalizeExecution(target, execution.status === "fulfilled" ? execution.value : { state: "unknown", workspaceState: "unknown", reason: "process_inspection_failed" }),
      ...(target.committedOutcome ? { committedOutcome: target.committedOutcome } : {}),
      native: this.normalizeNative(target, native.status === "fulfilled" ? native.value : { state: "unknown", reason: "native_history_read_failed" }),
    };
  }

  private normalizeExecution(target: RecoveryTarget, observation: ExecutionRecoveryObservation): ExecutionRecoveryObservation {
    if (observation.state !== "stopped") return { state: observation.state === "running" ? "running" : "unknown",
      workspaceState: observation.workspaceState === "held" ? "held" : "unknown", ...(observation.reason ? { reason: observation.reason } : {}) };
    const proof = observation.evidence;
    const owners = new Set(target.processes.map((record) => JSON.stringify([record.ownerId, record.ownerGeneration])));
    const owner = target.context ? JSON.stringify([target.context.hostOwnerId, target.context.hostOwnerGeneration]) : owners.size === 1 ? [...owners][0] : undefined;
    if (!target.turn.attemptId || !proof || proof.kind !== "process-tree-stopped" || !proof.sourceId
      || owner !== JSON.stringify([proof.ownerId, proof.ownerGeneration]) || !Number.isSafeInteger(proof.ownerGeneration) || proof.ownerGeneration < 1
      || observation.workspaceState === "clear" && proof.resourceKeys.length === 0 || proof.resourceKeys.length > 16 || proof.resourceKeys.some((key) => typeof key !== "string" || !key || key.length > 4096)) {
      return { state: "unknown", workspaceState: "unknown", reason: "process_stop_proof_binding_missing" };
    }
    const processRecordIds = [...new Set(proof.processRecordIds ?? target.processes.map((record) => record.id))].sort();
    if (target.processes.some((record) => !processRecordIds.includes(record.id))
      || processRecordIds.some((id) => !target.ownerProcesses.some((record) => record.id === id))) {
      return { state: "unknown", workspaceState: "unknown", reason: "process_stop_scope_mismatch" };
    }
    return { state: "stopped", workspaceState: observation.workspaceState === "clear" ? "clear" : observation.workspaceState === "held" ? "held" : "unknown",
      evidence: { ...proof, resourceKeys: [...new Set(proof.resourceKeys)].sort(), processRecordIds }, ...(observation.reason ? { reason: observation.reason } : {}) };
  }

  private normalizeNative(target: RecoveryTarget, observation: NativeTurnObservation): NativeTurnObservation {
    if (observation.state === "unknown") return observation;
    const handle = target.nativeHandle;
    if (!handle || observation.nativeSessionId !== handle.nativeSessionId) return { state: "unknown", reason: "native_session_binding_mismatch" };
    if (handle.provider === "codex") {
      if (!handle.nativeTurnId || observation.nativeTurnId !== handle.nativeTurnId) return { state: "unknown", reason: "native_turn_binding_mismatch" };
    } else {
      // A live SDK result can prove its captured Flyx attempt without a
      // native Turn ID. Session transcripts never supply this run evidence.
      if (observation.state !== "terminal" || observation.nativeTurnId !== undefined || !observation.evidence.dispatchContext
        || digest(observation.evidence.dispatchContext) !== digest(handle.context)) return { state: "unknown", reason: "claude_native_run_evidence_missing" };
    }
    if (observation.state === "terminal" && (observation.evidence.kind !== "native-terminal" || !observation.evidence.sourceId
      || observation.evidence.verifiedVersion !== handle.verifiedVersion || handle.verifiedVersion === "unknown")) {
      return { state: "unknown", reason: "native_terminal_evidence_unverified" };
    }
    return observation;
  }
  private canRelease(execution: ExecutionRecoveryObservation): boolean {
    return execution.state === "stopped" && execution.workspaceState === "clear" && execution.evidence?.kind === "process-tree-stopped";
  }
}

/** Root exit, absent PID, transcript endings, and stale heartbeats do not prove tree stop. */
export function defaultExecutionObservation(target: RecoveryTarget): ExecutionRecoveryObservation {
  if (target.processes.length && target.processes.every((record) => record.state === "stopped" || record.state === "not_spawned")) {
    const owners = new Set(target.processes.map((record) => JSON.stringify([record.ownerId, record.ownerGeneration])));
    const record = target.processes[0]!;
    if (owners.size === 1) return { state: "stopped", workspaceState: "unknown", reason: "workspace_writer_proof_required",
      evidence: { kind: "process-tree-stopped", sourceId: digest(target.processes), ownerId: record.ownerId, ownerGeneration: record.ownerGeneration,
        resourceKeys: [] } };
  }
  return { state: "unknown", workspaceState: "unknown", reason: target.processes.some((record) => record.state === "launching")
    ? "spawn_window_not_reconciled" : "process_tree_identity_unverified" };
}
