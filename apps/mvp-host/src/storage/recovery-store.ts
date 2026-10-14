import { createHash, randomUUID } from "node:crypto";
import type { RecoveryEvidence, RecoveryOperation, SessionEvent } from "@flyx/mvp-protocol";
import { dispatchContextForTurn } from "../provider/types.js";
import type { DispatchContext, ProviderId } from "../provider/types.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import type { ProcessBoundaryEvidence, ProcessTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import type { NativeHandle, NativeTurnObservation } from "../provider/native-history.js";
import type { CommandReceiptUpdate, SessionRow, SqliteStore, TurnRow } from "./db.js";
import type { ExecutionIntentUpdate, PlannedEvent } from "../orchestration/command-contract.js";

export class RecoveryError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "RecoveryError"; }
}
export type RecoveryProcessRecord = {
  id: string; ownerId: string; ownerGeneration: number; runtimeId: string; runtimeGeneration: number;
  attemptId: string; sessionId?: string; turnId?: string; pid?: number; processGroup?: number;
  processIdentity?: ProcessIdentity; boundary?: ProcessBoundaryEvidence; stopProof?: ProcessTreeStopEvidence;
  treeControl: "process_group" | "unavailable";
  state: "launching" | "running" | "root_exited" | "stopped" | "not_spawned" | "unknown"; updatedAt: string;
};
export type ExecutionRecoveryObservation = {
  state: "stopped" | "running" | "unknown";
  workspaceState: "clear" | "held" | "unknown";
  reason?: string;
  evidence?: { kind: "process-tree-stopped"; sourceId: string; ownerId: string; ownerGeneration: number; resourceKeys: readonly string[]; processRecordIds?: readonly string[] };
};
export type NotDispatchedRecoveryOutcome = Readonly<{ status: "failed" | "cancelled"; sourceId: string; context: DispatchContext }>;
export type RecoveryTarget = {
  session: SessionRow; turn: TurnRow; context?: DispatchContext; nativeHandle?: NativeHandle;
  committedOutcome?: NotDispatchedRecoveryOutcome;
  processes: readonly RecoveryProcessRecord[]; ownerProcesses: readonly RecoveryProcessRecord[]; factsFingerprint: string;
};
export type StoredRecoveryEvidence = {
  view: RecoveryEvidence; factsFingerprint: string; execution: ExecutionRecoveryObservation; native: NativeTurnObservation;
  ownerJournalFingerprint?: string; committedOutcome?: NotDispatchedRecoveryOutcome;
};
export type RecoveryCommandInput = {
  authSubjectId: string; commandId: string; sessionId: string; turnId: string; attemptId?: string;
  evidenceId: string; expectedRecoveryRevision: number; acknowledgeUnknown?: true;
};
export type RecoveryJournal = {
  id: string; sessionId: string; turnId: string; attemptId?: string; authSubjectId: string; commandId: string;
  action: "reconcile" | "acknowledge"; requestHash: string; evidenceId: string;
  phase: "marked" | "checking" | "completed" | "blocked" | "failed"; result?: RecoveryOperation; completedRevision?: number;
};
export type OwnershipReleaseProof = {
  ownerId: string; ownerGeneration: number; evidenceId: string; turnId: string; attemptId: string; resourceKeys: readonly string[];
};
export type OwnershipReleaseContext = { resourceKey: string; ownerId: string; ownerGeneration: number; purpose: string; retainedReason?: string };
export type NativeBindingInput = {
  context: DispatchContext; provider: ProviderId; providerInstanceId: string; nativeSessionId: string; nativeTurnId?: string;
  workspacePath: string; configurationFingerprint: string; verifiedVersion: string;
};

/** Recovery facts, operations, and Engine all share one SQLite connection. */
export class RecoveryStore {
  constructor(readonly store: SqliteStore, private readonly options: { companionEvents?: (sessionId: string, turnId: string, reason: string) => PlannedEvent[] } = {}) {}

  target(sessionId: string, turnId: string, attemptId?: string): RecoveryTarget {
    const session = this.store.getSession(sessionId);
    const turn = this.store.getTurn(turnId);
    if (!session || !turn || turn.sessionId !== sessionId) throw new RecoveryError("RECOVERY_TARGET_NOT_FOUND");
    if (attemptId !== undefined && attemptId !== turn.attemptId) throw new RecoveryError("RECOVERY_ATTEMPT_MISMATCH");
    const nativeHandle = turn.attemptId ? this.nativeHandle(turnId, turn.attemptId) : undefined;
    const context = nativeHandle?.context ?? this.intentContext(turn) ?? this.processContext(turn);
    const processes = context
      ? this.processes("owner_id = ? AND owner_generation = ? AND runtime_id = ?", [context.hostOwnerId, context.hostOwnerGeneration, context.runtimeId])
      : turn.attemptId ? this.processes("turn_id = ? AND attempt_id = ?", [turn.id, turn.attemptId]) : [];
    const owners = new Set(processes.map((record) => JSON.stringify([record.ownerId, record.ownerGeneration])));
    const ownerProcesses = context ? this.processes("owner_id = ? AND owner_generation = ?", [context.hostOwnerId, context.hostOwnerGeneration])
      : owners.size === 1 && processes[0] ? this.processes("owner_id = ? AND owner_generation = ?", [processes[0].ownerId, processes[0].ownerGeneration]) : [];
    const committedOutcome = context ? this.notDispatchedOutcome(session, turn, context) : undefined;
    const factsFingerprint = digest({ sessionId, activeTurnId: session.activeTurnId ?? null, recoveryState: session.recoveryState,
      recoveryRevision: session.recoveryRevision, turnId, attemptId: turn.attemptId ?? null, status: turn.status,
      nativeSessionId: turn.providerSessionId ?? null, nativeTurnId: turn.nativeTurnId ?? null, generation: turn.generation,
      context: context ?? null, nativeHandle: nativeHandle ?? null, committedOutcome: committedOutcome ?? null, processes });
    return Object.freeze({ session: Object.freeze(session), turn: Object.freeze(turn), ...(context ? { context } : {}), ...(nativeHandle ? { nativeHandle } : {}), ...(committedOutcome ? { committedOutcome } : {}),
      processes: Object.freeze(processes.map((record) => Object.freeze(record))), ownerProcesses: Object.freeze(ownerProcesses.map((record) => Object.freeze(record))), factsFingerprint });
  }

  recordNativeBinding(input: NativeBindingInput, occurredAt = new Date().toISOString()): NativeHandle {
    return this.transaction(() => {
      const context = dispatchContextForTurn(input.context.flyxTurnId, input.context);
      const target = this.target(context.sessionId, context.flyxTurnId, context.attemptId);
      if (target.turn.attemptId !== context.attemptId || target.turn.generation !== context.runtimeGeneration
        || target.session.provider !== input.provider || target.session.workspacePath !== input.workspacePath
        || ![input.providerInstanceId, input.nativeSessionId, input.configurationFingerprint, input.verifiedVersion].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)
        || input.nativeTurnId !== undefined && (!input.nativeTurnId || input.nativeTurnId.length > 512)
        || target.context && digest(target.context) !== digest(context)) throw new RecoveryError("NATIVE_BINDING_MISMATCH");
      const existing = this.nativeHandle(target.turn.id, context.attemptId);
      if (existing) {
        if (existing.provider !== input.provider || existing.workspacePath !== input.workspacePath || existing.nativeSessionId !== input.nativeSessionId || existing.providerInstanceId !== input.providerInstanceId
          || existing.configurationFingerprint !== input.configurationFingerprint || existing.verifiedVersion !== input.verifiedVersion
          || digest(existing.context) !== digest(context) || existing.nativeTurnId && input.nativeTurnId && existing.nativeTurnId !== input.nativeTurnId) {
          throw new RecoveryError("NATIVE_BINDING_MISMATCH");
        }
        if (!input.nativeTurnId || existing.nativeTurnId === input.nativeTurnId) return existing;
        this.store.db.prepare("UPDATE native_turn_bindings SET native_turn_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(input.nativeTurnId, occurredAt, existing.id);
      } else {
        const id = digest({ turnId: target.turn.id, attemptId: context.attemptId });
        this.store.db.prepare(`INSERT INTO native_turn_bindings
          (id,session_id,turn_id,attempt_id,provider,provider_instance_id,native_session_id,native_turn_id,workspace_path,configuration_fingerprint,verified_version,context_json,revision,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(id, context.sessionId, context.flyxTurnId, context.attemptId,
          input.provider, input.providerInstanceId, input.nativeSessionId, input.nativeTurnId ?? null, input.workspacePath,
          input.configurationFingerprint, input.verifiedVersion, JSON.stringify(context), occurredAt);
      }
      if (target.turn.providerSessionId && target.turn.providerSessionId !== input.nativeSessionId
        || target.turn.nativeTurnId && input.nativeTurnId && target.turn.nativeTurnId !== input.nativeTurnId) throw new RecoveryError("NATIVE_BINDING_MISMATCH");
      this.store.db.prepare("UPDATE turns SET provider_session_id = ?, native_turn_id = COALESCE(?,native_turn_id) WHERE id = ? AND attempt_id = ?")
        .run(input.nativeSessionId, input.nativeTurnId ?? null, target.turn.id, context.attemptId);
      this.store.db.prepare("UPDATE sessions SET recovery_revision = recovery_revision + 1 WHERE id = ?").run(context.sessionId);
      return this.nativeHandle(target.turn.id, context.attemptId)!;
    });
  }

  nativeHandle(turnId: string, attemptId: string): NativeHandle | undefined {
    const row = this.store.db.prepare("SELECT * FROM native_turn_bindings WHERE turn_id = ? AND attempt_id = ?").get(turnId, attemptId) as RawBinding | undefined;
    return row ? Object.freeze({ id: row.id, sessionId: row.session_id, turnId: row.turn_id, attemptId: row.attempt_id, provider: row.provider,
      providerInstanceId: row.provider_instance_id, nativeSessionId: row.native_session_id, ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
      workspacePath: row.workspace_path, configurationFingerprint: row.configuration_fingerprint, verifiedVersion: row.verified_version,
      context: dispatchContextForTurn(row.turn_id, JSON.parse(row.context_json) as DispatchContext), revision: row.revision, updatedAt: row.updated_at }) : undefined;
  }

  saveEvidence(target: RecoveryTarget, evidence: StoredRecoveryEvidence): void {
    this.transaction(() => {
      if (this.target(target.session.id, target.turn.id, target.turn.attemptId).factsFingerprint !== target.factsFingerprint) throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
      this.store.db.prepare(`INSERT INTO recovery_evidence(id,session_id,turn_id,attempt_id,recovery_revision,facts_fingerprint,evidence_json,observed_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(evidence.view.evidenceId, target.session.id, target.turn.id, target.turn.attemptId ?? null,
        evidence.view.recoveryRevision, evidence.factsFingerprint, JSON.stringify(evidence), evidence.view.observedAt, evidence.view.expiresAt);
    });
  }

  evidence(id: string): StoredRecoveryEvidence | undefined {
    const row = this.store.db.prepare("SELECT evidence_json FROM recovery_evidence WHERE id = ?").get(id) as { evidence_json: string } | undefined;
    return row ? JSON.parse(row.evidence_json) as StoredRecoveryEvidence : undefined;
  }

  validateEvidence(input: RecoveryCommandInput, now: string): { target: RecoveryTarget; evidence: StoredRecoveryEvidence } {
    const target = this.target(input.sessionId, input.turnId, input.attemptId);
    const evidence = this.evidence(input.evidenceId);
    if (!evidence || evidence.view.sessionId !== input.sessionId || evidence.view.turnId !== input.turnId
      || evidence.view.attemptId !== target.turn.attemptId) throw new RecoveryError("RECOVERY_EVIDENCE_NOT_FOUND");
    if (evidence.view.recoveryRevision !== input.expectedRecoveryRevision || target.session.recoveryRevision !== input.expectedRecoveryRevision
      || evidence.factsFingerprint !== target.factsFingerprint || !Number.isFinite(Date.parse(evidence.view.expiresAt))
      || !Number.isFinite(Date.parse(now)) || Date.parse(evidence.view.expiresAt) <= Date.parse(now)) throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
    return { target, evidence };
  }

  beginOperation(input: RecoveryCommandInput, action: RecoveryJournal["action"], requestHash: string, now: string): { operation: RecoveryJournal; events: SessionEvent[] } {
    return this.transaction(() => {
      const existing = this.operationForCommand(input.authSubjectId, input.commandId);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.action !== action || existing.sessionId !== input.sessionId || existing.turnId !== input.turnId) throw new RecoveryError("COMMAND_ID_REUSED");
        return { operation: existing, events: [] };
      }
      if (this.store.getCommandReceipt(input.authSubjectId, input.commandId)) throw new RecoveryError("COMMAND_ID_REUSED");
      const { target } = this.validateEvidence(input, now);
      if (target.session.activeTurnId === target.turn.id && target.session.recoveryState !== "blocked") throw new RecoveryError("RECOVERY_NOT_REQUIRED");
      const id = randomUUID();
      const result = operationResult(id, target, "accepted", target.session.activeTurnId === target.turn.id ? "blocked" : "unchanged");
      const committed = this.store.commitCommand({ sessionId: input.sessionId, expectedRevision: target.session.revision, occurredAt: now,
        build: () => ({ result, receipts: [{ authSubjectId: input.authSubjectId, commandId: input.commandId, method: `session.recovery.${action}`,
          requestHash, requestFormatVersion: 2, targetSessionId: input.sessionId, state: "accepted", response: result }],
          events: [{ type: "recovery.operation.marked", payload: { ...result, evidenceId: input.evidenceId, action } }] }) })!;
      this.store.db.prepare(`INSERT INTO recovery_operations(id,session_id,turn_id,attempt_id,auth_subject_id,command_id,action,request_hash,evidence_id,phase,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'marked',?,?)`).run(id, input.sessionId, input.turnId, target.turn.attemptId ?? null,
        input.authSubjectId, input.commandId, action, requestHash, input.evidenceId, now, now);
      return { operation: this.operation(id)!, events: committed.events };
    });
  }

  markChecking(id: string, now: string): void {
    this.transaction(() => this.store.db.prepare("UPDATE recovery_operations SET phase = 'checking', updated_at = ? WHERE id = ? AND phase IN ('marked','checking')").run(now, id));
  }

  finishOperation(input: RecoveryCommandInput, journal: RecoveryJournal, evidence: StoredRecoveryEvidence,
    native: NativeTurnObservation, releaseGate: boolean, now: string): { result: RecoveryOperation; events: SessionEvent[] } {
    return this.transaction(() => {
      const { target } = this.validateEvidence(input, now);
      const activeTarget = target.session.activeTurnId === target.turn.id;
      if (activeTarget && target.session.recoveryState !== "blocked") throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
      const terminal = journal.action === "reconcile" && native.state === "terminal" ? native : undefined;
      const notDispatched = journal.action === "reconcile" && !terminal && releaseGate ? evidence.committedOutcome : undefined;
      if (notDispatched && (!target.committedOutcome || digest(notDispatched) !== digest(target.committedOutcome))) throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
      const knownStatus = terminal?.status ?? notDispatched?.status;
      if (terminal && ["completed", "failed", "cancelled"].includes(target.turn.status) && target.turn.status !== terminal.status) throw new RecoveryError("RECOVERY_TERMINAL_CONFLICT");
      if (journal.action === "acknowledge" && (!activeTarget || target.turn.status !== "outcome_unknown")) throw new RecoveryError("RECOVERY_TARGET_NOT_ACTIVE");
      const gate = activeTarget ? releaseGate ? "released" : "blocked" : "unchanged";
      const result = operationResult(journal.id, target, "completed", gate, knownStatus,
        target.session.recoveryRevision + (activeTarget && releaseGate ? 1 : 0));
      const originalResponse = notDispatched && target.turn.authSubjectId ? this.store.getCommandReceipt(target.turn.authSubjectId, target.turn.commandId)?.response : undefined;
      const response = notDispatched ? { ...(originalResponse && typeof originalResponse === "object" ? originalResponse : {}), turnId: target.turn.id, status: notDispatched.status,
        recovered: true, executionStopped: true, evidenceId: evidence.view.evidenceId, evidence: { kind: "not-dispatched" } }
        : terminal ? { turnId: target.turn.id, status: terminal.status, recovered: true, evidenceId: evidence.view.evidenceId,
        nativeEvidence: terminal.evidence, ...(terminal.error ? { error: terminal.error } : {}) }
        : { turnId: target.turn.id, status: "outcome_unknown", acknowledged: true, executionStopped: true, evidenceId: evidence.view.evidenceId };
      const receiptUpdates = this.originalReceiptUpdates(target, knownStatus ?? "outcome_unknown", response);
      receiptUpdates.push({ authSubjectId: journal.authSubjectId, commandId: journal.commandId, state: "completed", response: result, requestHash: journal.requestHash, required: true });
      const intentUpdates: ExecutionIntentUpdate[] = terminal || notDispatched ? [] : this.unknownIntentSettlement(target, evidence.view.evidenceId);
      const committed = this.store.commitCommand({ sessionId: target.session.id, expectedRevision: target.session.revision, occurredAt: now,
        build: () => ({ result, receiptUpdates, intentUpdates, events: [...(this.options.companionEvents?.(target.session.id, target.turn.id, terminal || notDispatched ? "recovery_reconciled" : "recovery_acknowledged") ?? []), { type: terminal || notDispatched ? "turn.recovery.reconciled" : "turn.recovery.acknowledged",
          payload: { ...result, evidenceId: evidence.view.evidenceId, ...(terminal ? { nativeEvidence: terminal } : notDispatched ? { committedOutcome: { status: notDispatched.status, source: "not-dispatched" } } : { outcomePreserved: "outcome_unknown" }) },
          options: { ...(terminal ? { turnId: target.turn.id, turnStatus: terminal.status, ...(terminal.nativeTurnId ? { nativeTurnId: terminal.nativeTurnId } : {}) } : {}),
            ...(activeTarget ? { activityState: releaseGate ? "idle" : "outcome_unknown" } : {}),
            timeline: { itemId: `recovery-${target.turn.id}`, kind: "system", status: knownStatus ?? "outcome_unknown",
              content: { turnId: target.turn.id, message: terminal ? `Recovered original Turn outcome: ${terminal.status}` : notDispatched ? "Execution stopped; original non-dispatched outcome preserved" : "Execution stopped; original outcome remains unknown", evidenceId: evidence.view.evidenceId } } } }] }) })!;
      if (activeTarget && releaseGate) {
        const changed = this.store.db.prepare("UPDATE sessions SET active_turn_id = NULL, recovery_state = 'idle', activity_state = 'idle', recovery_revision = recovery_revision + 1 WHERE id = ? AND active_turn_id = ? AND recovery_revision = ?")
          .run(target.session.id, target.turn.id, target.session.recoveryRevision);
        if (changed.changes !== 1) throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
      }
      this.store.db.prepare("UPDATE recovery_operations SET phase = 'completed', result_json = ?, completed_revision = ?, updated_at = ? WHERE id = ? AND phase IN ('marked','checking')")
        .run(JSON.stringify(result), committed.sessionRevision, now, journal.id);
      return { result, events: committed.events };
    });
  }

  failOperation(journal: RecoveryJournal, code: string, now: string): { result: RecoveryOperation; events: SessionEvent[] } {
    return this.transaction(() => {
      const target = this.target(journal.sessionId, journal.turnId, journal.attemptId);
      const result = operationResult(journal.id, target, code === "RECOVERY_BLOCKED" ? "blocked" : "failed", target.session.activeTurnId === target.turn.id ? "blocked" : "unchanged");
      const committed = this.store.commitCommand({ sessionId: target.session.id, expectedRevision: target.session.revision, occurredAt: now,
        build: () => ({ result, receiptUpdates: [{ authSubjectId: journal.authSubjectId, commandId: journal.commandId, state: "failed", response: { ...result, code }, requestHash: journal.requestHash, required: true }],
          events: [{ type: "recovery.operation.failed", payload: { ...result, code } }] }) })!;
      this.store.db.prepare("UPDATE recovery_operations SET phase = ?, result_json = ?, completed_revision = ?, updated_at = ? WHERE id = ?")
        .run(result.state, JSON.stringify(result), committed.sessionRevision, now, journal.id);
      return { result, events: committed.events };
    });
  }

  operation(id: string): RecoveryJournal | undefined {
    return toJournal(this.store.db.prepare("SELECT * FROM recovery_operations WHERE id = ?").get(id) as RawJournal | undefined);
  }
  operationForCommand(authSubjectId: string, commandId: string): RecoveryJournal | undefined {
    return toJournal(this.store.db.prepare("SELECT * FROM recovery_operations WHERE auth_subject_id = ? AND command_id = ?").get(authSubjectId, commandId) as RawJournal | undefined);
  }

  ownerJournalFingerprint(ownerId: string, generation: number): string {
    return digest(this.processes("owner_id = ? AND owner_generation = ?", [ownerId, generation]));
  }

  /** Retained filesystem ownership accepts only an already committed recovery result. */
  verifyReleaseProof = (proof: OwnershipReleaseProof, resource: OwnershipReleaseContext): boolean => {
    try {
      if (this.store.db.inTransaction) return false;
      if (proof.ownerId !== resource.ownerId || proof.ownerGeneration !== resource.ownerGeneration
        || !proof.resourceKeys.includes(resource.resourceKey)) return false;
      const evidence = this.evidence(proof.evidenceId);
      const stop = evidence?.execution.evidence;
      if (!evidence || evidence.execution.state !== "stopped" || evidence.execution.workspaceState !== "clear" || !stop
        || stop.ownerId !== proof.ownerId || stop.ownerGeneration !== proof.ownerGeneration || evidence.view.turnId !== proof.turnId
        || evidence.view.attemptId !== proof.attemptId || proof.resourceKeys.some((key) => !stop.resourceKeys.includes(key))
        || evidence.ownerJournalFingerprint !== this.ownerJournalFingerprint(proof.ownerId, proof.ownerGeneration)) return false;
      if (!resource.purpose.startsWith("workspace:")) {
        const ownerRecords = this.processes("owner_id = ? AND owner_generation = ?", [proof.ownerId, proof.ownerGeneration]);
        if (ownerRecords.some((record) => !stop.processRecordIds?.includes(record.id))
          || this.store.db.prepare("SELECT 1 FROM sessions WHERE active_turn_id IS NOT NULL OR recovery_state = 'blocked' LIMIT 1").get()) return false;
      }
      const rows = this.store.db.prepare("SELECT * FROM recovery_operations WHERE evidence_id = ? AND phase = 'completed'")
        .all(proof.evidenceId) as RawJournal[];
      return rows.some((row) => {
        const result = row.result_json ? JSON.parse(row.result_json) as RecoveryOperation : undefined;
        const session = this.store.getSession(row.session_id);
        return result?.gate === "released" && result.turnId === proof.turnId && result.attemptId === proof.attemptId
          && session?.activeTurnId === undefined && session?.recoveryState === "idle" && session.recoveryRevision === result.recoveryRevision;
      });
    } catch { return false; }
  };

  releaseProof(evidenceId: string, resourceKeys?: readonly string[]): OwnershipReleaseProof | undefined {
    const evidence = this.evidence(evidenceId);
    const stop = evidence?.execution.evidence;
    if (!evidence?.view.attemptId || !stop || evidence.execution.state !== "stopped" || evidence.execution.workspaceState !== "clear") return undefined;
    const proof = { ownerId: stop.ownerId, ownerGeneration: stop.ownerGeneration, evidenceId,
      turnId: evidence.view.turnId, attemptId: evidence.view.attemptId, resourceKeys: resourceKeys ?? stop.resourceKeys };
    if (!proof.resourceKeys.every((key) => stop.resourceKeys.includes(key))) return undefined;
    return proof;
  }

  private transaction<T>(fn: () => T): T {
    // R03 recovery-only maintenance permits this synchronous lane while
    // refusing general command admission; reads/Provider awaits stay outside.
    const store = this.store as SqliteStore & { withRecoveryTransaction?: <R>(callback: () => R) => R };
    const commit = () => this.store.db.transaction(fn)();
    return store.withRecoveryTransaction ? store.withRecoveryTransaction(commit) : commit();
  }

  private originalReceiptUpdates(target: RecoveryTarget, state: "completed" | "failed" | "cancelled" | "outcome_unknown", response: unknown): CommandReceiptUpdate[] {
    const updates: CommandReceiptUpdate[] = [];
    if (target.turn.authSubjectId) {
      const receipt = this.store.getCommandReceipt(target.turn.authSubjectId, target.turn.commandId);
      if (receipt) {
        if (receipt.requestHash !== target.turn.requestHash || receipt.method !== "session.startTurn") throw new RecoveryError("COMMAND_ID_REUSED");
        updates.push({ authSubjectId: receipt.authSubjectId, commandId: receipt.commandId, state, response, requestHash: receipt.requestHash, required: true });
      }
    }
    const controls = this.store.db.prepare(`SELECT DISTINCT r.auth_subject_id,r.command_id,r.request_hash FROM execution_intents i
      JOIN command_receipts r ON r.auth_subject_id = i.auth_subject_id AND r.command_id = i.command_id
      WHERE i.session_id = ? AND i.turn_id = ? AND i.kind = 'interrupt_turn' AND r.state IN ('accepted','outcome_unknown')`)
      .all(target.session.id, target.turn.id) as Array<{ auth_subject_id: string; command_id: string; request_hash: string }>;
    for (const control of controls) updates.push({ authSubjectId: control.auth_subject_id, commandId: control.command_id, state: "completed",
      response: { status: "completed", turnId: target.turn.id, turnStatus: state, disposition: "obsolete_after_execution_stopped", deliveryState: "unconfirmed" },
      requestHash: control.request_hash, required: true });
    return updates;
  }

  private unknownIntentSettlement(target: RecoveryTarget, evidenceId: string): ExecutionIntentUpdate[] {
    const rows = this.store.db.prepare("SELECT id,state FROM execution_intents WHERE session_id = ? AND turn_id = ? AND kind IN ('start_turn','interrupt_turn') AND state <> 'settled'")
      .all(target.session.id, target.turn.id) as Array<{ id: string; state: ExecutionIntentUpdate["expectedStates"][number] }>;
    return rows.map((row) => ({ id: row.id, expectedStates: [row.state], state: "settled", resultCode: "outcome_unknown_acknowledged",
      result: { turnId: target.turn.id, status: "outcome_unknown", executionStopped: true, evidenceId } }));
  }

  private notDispatchedOutcome(session: SessionRow, turn: TurnRow, context: DispatchContext): NotDispatchedRecoveryOutcome | undefined {
    if (!turn.authSubjectId || turn.status !== "failed" && turn.status !== "cancelled") return undefined;
    const receipt = this.store.getCommandReceipt(turn.authSubjectId, turn.commandId);
    if (!receipt || receipt.method !== "session.startTurn" || receipt.requestHash !== turn.requestHash || receipt.targetSessionId !== session.id
      || receipt.state !== turn.status || !receipt.commitId || !receipt.sourceSequence) return undefined;
    const response = receipt.response as { status?: string; turnId?: string; evidence?: { kind?: string } } | undefined;
    if (response?.status !== turn.status || response.turnId !== turn.id || response.evidence?.kind !== "not-dispatched") return undefined;
    const columns = this.store.db.prepare("PRAGMA table_info(execution_intents)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "dispatch_context_json")) return undefined;
    const intents = this.store.db.prepare(`SELECT * FROM execution_intents WHERE session_id=? AND turn_id=? AND attempt_id=? AND auth_subject_id=? AND command_id=? AND kind='start_turn'`)
      .all(session.id, turn.id, turn.attemptId, turn.authSubjectId, turn.commandId) as Array<{ id: string; state: string; request_hash: string; runtime_generation: number; dispatch_context_json: string | null; result_json: string | null; commit_id: string; source_sequence: number }>;
    const intent = intents[0];
    if (intents.length !== 1 || !intent || intent.state !== "settled" || intent.request_hash !== turn.requestHash || intent.runtime_generation !== turn.generation || !intent.dispatch_context_json || !intent.result_json) return undefined;
    try {
      const intentResult = JSON.parse(intent.result_json) as { status?: string; turnId?: string; evidence?: { kind?: string } };
      if (digest(JSON.parse(intent.dispatch_context_json)) !== digest(context) || intentResult.status !== turn.status || intentResult.turnId !== turn.id || intentResult.evidence?.kind !== "not-dispatched") return undefined;
      const source = this.store.db.prepare("SELECT commit_id,payload_json FROM session_events WHERE session_id=? AND sequence=?").get(session.id, receipt.sourceSequence) as { commit_id: string | null; payload_json: string } | undefined;
      const acceptedSource = this.store.db.prepare("SELECT commit_id FROM session_events WHERE session_id=? AND sequence=?").get(session.id, intent.source_sequence) as { commit_id: string | null } | undefined;
      if (!source || source.commit_id !== receipt.commitId || !acceptedSource || acceptedSource.commit_id !== intent.commit_id) return undefined;
      return Object.freeze({ status: turn.status, sourceId: digest({ receipt, intent, source, context }), context });
    } catch { return undefined; }
  }

  /** Migration 004 already journaled the exact launch identity; legacy missing attempts stay unknown. */
  private processContext(turn: TurnRow): DispatchContext | undefined {
    if (!turn.attemptId) return undefined;
    const records = this.processes("turn_id = ? AND attempt_id = ? AND session_id = ?", [turn.id, turn.attemptId, turn.sessionId]);
    if (!records.length || records.some((record) => record.runtimeGeneration !== turn.generation)) return undefined;
    const identities = records.map((record) => ({ hostOwnerId: record.ownerId, hostOwnerGeneration: record.ownerGeneration,
      sessionId: turn.sessionId, flyxTurnId: turn.id, runtimeId: record.runtimeId, runtimeGeneration: record.runtimeGeneration, attemptId: turn.attemptId! }));
    if (new Set(identities.map(digest)).size !== 1) return undefined;
    try { return dispatchContextForTurn(turn.id, identities[0]!); } catch { return undefined; }
  }

  private intentContext(turn: TurnRow): DispatchContext | undefined {
    const columns = this.store.db.prepare("PRAGMA table_info(execution_intents)").all() as Array<{ name: string }>;
    if (!turn.attemptId || !columns.some((column) => column.name === "dispatch_context_json")) return undefined;
    const rows = this.store.db.prepare("SELECT dispatch_context_json FROM execution_intents WHERE turn_id = ? AND attempt_id = ? AND kind = 'start_turn'")
      .all(turn.id, turn.attemptId) as Array<{ dispatch_context_json: string | null }>;
    if (rows.length !== 1 || !rows[0]?.dispatch_context_json) return undefined;
    try {
      const context = dispatchContextForTurn(turn.id, JSON.parse(rows[0].dispatch_context_json) as DispatchContext);
      return context.sessionId === turn.sessionId && context.attemptId === turn.attemptId && context.runtimeGeneration === turn.generation ? context : undefined;
    } catch { return undefined; }
  }

  private processes(where: string, args: readonly unknown[]): RecoveryProcessRecord[] {
    const hasEvidence = this.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('managed_process_identities','managed_process_boundaries','managed_process_stop_proofs')").get() as { n: number };
    const evidence = hasEvidence.n === 3 ? ", identity.identity_json, boundary.proof_json AS boundary_json, boundary.launch_digest, stop.proof_json AS stop_json" : "";
    const joins = hasEvidence.n === 3 ? ` LEFT JOIN managed_process_identities identity ON identity.process_id = managed_processes.id
      LEFT JOIN managed_process_boundaries boundary ON boundary.process_id = managed_processes.id
      LEFT JOIN managed_process_stop_proofs stop ON stop.process_id = managed_processes.id` : "";
    return (this.store.db.prepare(`SELECT managed_processes.*${evidence} FROM managed_processes${joins} WHERE ${where} ORDER BY managed_processes.id`).all(...args) as RawProcess[]).map((row) => ({
      id: row.id, ownerId: row.owner_id, ownerGeneration: row.owner_generation, runtimeId: row.runtime_id, runtimeGeneration: row.runtime_generation,
      attemptId: row.attempt_id, ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.pid !== null ? { pid: row.pid } : {}), ...(row.process_group !== null ? { processGroup: row.process_group } : {}),
      ...(row.identity_json ? { processIdentity: freezeJson<ProcessIdentity>(row.identity_json) } : {}),
      ...(row.boundary_json && row.launch_digest ? { boundary: Object.freeze({ proof: freezeJson<object>(row.boundary_json), launchDigest: row.launch_digest }) } : {}),
      ...(row.stop_json ? { stopProof: freezeJson<ProcessTreeStopEvidence>(row.stop_json) } : {}),
      treeControl: row.tree_control, state: row.state, updatedAt: row.updated_at }));
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function freezeJson<T>(json: string): T {
  const freeze = (value: unknown): unknown => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(JSON.parse(json)) as T;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, canonical(part)]));
  return value;
}
function operationResult(id: string, target: RecoveryTarget, state: RecoveryOperation["state"], gate: RecoveryOperation["gate"],
  turnStatus = target.turn.status, recoveryRevision = target.session.recoveryRevision): RecoveryOperation {
  return { operationId: id, sessionId: target.session.id, turnId: target.turn.id, ...(target.turn.attemptId ? { attemptId: target.turn.attemptId } : {}),
    state, gate, turnStatus, recoveryRevision };
}
type RawBinding = { id: string; session_id: string; turn_id: string; attempt_id: string; provider: ProviderId; provider_instance_id: string;
  native_session_id: string; native_turn_id: string | null; workspace_path: string; configuration_fingerprint: string; verified_version: string;
  context_json: string; revision: number; updated_at: string };
type RawJournal = { id: string; session_id: string; turn_id: string; attempt_id: string | null; auth_subject_id: string; command_id: string;
  action: RecoveryJournal["action"]; request_hash: string; evidence_id: string; phase: RecoveryJournal["phase"]; result_json: string | null; completed_revision: number | null };
function toJournal(row: RawJournal | undefined): RecoveryJournal | undefined {
  return row ? { id: row.id, sessionId: row.session_id, turnId: row.turn_id, ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    authSubjectId: row.auth_subject_id, commandId: row.command_id, action: row.action, requestHash: row.request_hash, evidenceId: row.evidence_id,
    phase: row.phase, ...(row.result_json ? { result: JSON.parse(row.result_json) as RecoveryOperation } : {}),
    ...(row.completed_revision !== null ? { completedRevision: row.completed_revision } : {}) } : undefined;
}
type RawProcess = { id: string; owner_id: string; owner_generation: number; runtime_id: string; runtime_generation: number; attempt_id: string;
  session_id: string | null; turn_id: string | null; pid: number | null; process_group: number | null; tree_control: RecoveryProcessRecord["treeControl"];
  state: RecoveryProcessRecord["state"]; updated_at: string; identity_json?: string | null; boundary_json?: string | null; launch_digest?: string | null; stop_json?: string | null };
