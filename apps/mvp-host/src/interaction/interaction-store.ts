import type Database from "better-sqlite3";
import { InteractionSchema, type Interaction, type InteractionStatus } from "@flyx/mvp-protocol";
import { dispatchContextForTurn, type DispatchContext } from "../provider/types.js";
import type { SqliteStore } from "../storage/db.js";
import type { EventCommitRow } from "../orchestration/command-contract.js";
import type { InteractionFence, InteractionReservationRow, InteractionRow, NativeInteractionEvidence, NativeInteractionMethod } from "./types.js";
import type { SessionEvent } from "@flyx/mvp-protocol";
const OPEN = new Set<InteractionStatus>(["pending", "responding", "outcome_unknown"]);
const METHODS = new Set<NativeInteractionMethod>(["canUseTool/AskUserQuestion", "item/tool/requestUserInput", "canUseTool/approval", "item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
type SourcePayload = {
  interaction?: Interaction;
  interactionId?: string;
  expectedVersion?: number;
  dispatchContext?: {
    binding?: InteractionFence & {
      nativeRequestId: string;
      nativeMethod: NativeInteractionMethod;
      legacyApprovalId?: string;
    };
    evidence?: NativeInteractionEvidence;
  };
  status?: InteractionStatus;
  deliveryState?: Interaction["deliveryState"];
  reasonCode?: string;
};
/** Facts and reservations share SqliteStore.db and its synchronous commit hooks. */
export class InteractionStore {
  constructor(readonly db: Database.Database) { }
  attach(store: Pick<SqliteStore, "db" | "registerCommitHook">): () => void {
    if (store.db !== this.db)
      throw new Error("INTERACTION_CONNECTION_MISMATCH");
    return store.registerCommitHook((events, commit) => this.projectCommittedBatch(events, commit));
  }
  get(interactionId: string): InteractionRow | undefined {
    const row = this.db.prepare("SELECT * FROM interactions WHERE interaction_id = ?").get(interactionId) as RawInteraction | undefined;
    return row ? toInteraction(row) : undefined;
  }
  list(sessionId: string, options: {
    afterInteractionId?: string;
    limit?: number;
    openOnly?: boolean;
  } = {}): InteractionRow[] {
    const after = options.afterInteractionId ? this.get(options.afterInteractionId) : undefined;
    if (options.afterInteractionId && (!after || after.sessionId !== sessionId))
      throw new Error("INTERACTION_CURSOR_INVALID");
    const limit = Math.max(1, Math.min(101, options.limit ?? 51));
    const where = ["session_id = ?", ...(options.openOnly === false ? [] : ["status IN ('pending','responding','outcome_unknown')"]),
      ...(after ? ["(created_at > ? OR (created_at = ? AND interaction_id > ?))"] : [])];
    return (this.db.prepare(`SELECT * FROM interactions WHERE ${where.join(" AND ")} ORDER BY created_at,interaction_id LIMIT ?`)
      .all(sessionId, ...(after ? [after.createdAt, after.createdAt, after.interactionId] : []), limit) as RawInteraction[]).map(toInteraction);
  }
  matchingOpen(sessionId: string, filter: {
    turnId?: string;
    attemptId?: string;
    runtimeGeneration?: number;
    expiresBefore?: string;
  }, limit = 100): InteractionRow[] {
    const where = ["session_id=?", "status IN ('pending','responding','outcome_unknown')"];
    const values: Array<string | number> = [sessionId];
    if (filter.turnId) {
      where.push("turn_id=?");
      values.push(filter.turnId);
    }
    if (filter.attemptId) {
      where.push("attempt_id=?");
      values.push(filter.attemptId);
    }
    if (filter.runtimeGeneration !== undefined) {
      where.push("runtime_generation=?");
      values.push(filter.runtimeGeneration);
    }
    if (filter.expiresBefore) {
      where.push("expires_at<=? AND status<>'outcome_unknown'");
      values.push(filter.expiresBefore);
    }
    return (this.db.prepare(`SELECT * FROM interactions WHERE ${where.join(" AND ")} ORDER BY created_at,interaction_id LIMIT ?`)
      .all(...values, Math.max(1, Math.min(257, limit))) as RawInteraction[]).map(toInteraction);
  }
  reservation(interactionId: string): InteractionReservationRow | undefined {
    const row = this.db.prepare("SELECT * FROM interaction_reservations WHERE interaction_id = ?").get(interactionId) as RawReservation | undefined;
    return row ? toReservation(row) : undefined;
  }
  forIntent(intentId: string): InteractionRow | undefined {
    const row = this.db.prepare("SELECT interaction_id FROM interaction_reservations WHERE intent_id = ?").get(intentId) as {
      interaction_id: string;
    } | undefined;
    return row ? this.get(row.interaction_id) : undefined;
  }
  public(row: InteractionRow): Interaction {
    const { dispatchContext: _context, attemptId: _attemptId, runtimeId: _runtimeId, runtimeGeneration: _generation, nativeRequestId: _requestId, nativeMethod: _method, legacyApprovalId: _approvalId, updatedAt: _updatedAt, ...value } = row;
    return InteractionSchema.parse(value);
  }
  projectCommittedBatch(events: readonly SessionEvent[], commit: EventCommitRow): void {
    if (!this.db.inTransaction)
      throw new Error("INTERACTION_TRANSACTION_REQUIRED");
    for (const event of events) {
      if (event.sessionId !== commit.sessionId)
        throw new Error("INTERACTION_SOURCE_SCOPE_MISMATCH");
      if (event.type === "interaction.requested")
        this.projectRequested(event);
      else if (event.type === "interaction.response.accepted")
        this.projectReservation(event);
      else if (event.type === "interaction.delivery")
        this.projectDelivery(event);
      else if (event.type === "interaction.expired" || event.type === "interaction.superseded")
        this.projectObsolete(event, commit);
      else if (event.type === "approval.response.accepted" || event.type === "approval.resolved" || event.type === "approval.resolve.unavailable")
        this.mirrorLegacyApproval(event, commit);
      else if (["turn.completed", "turn.failed", "turn.cancelled", "session.recovery.required", "host.event_persist_failed"].includes(event.type)
        || (event.type === "turn.reconciled" && isRecord(event.payload) && isRecord(event.payload.outcome) && ["completed", "failed", "cancelled", "outcome_unknown"].includes(String(event.payload.outcome.status))))
        this.obsoleteForTerminal(event, commit);
    }
  }
  private projectRequested(event: SessionEvent): void {
    const payload = source(event);
    const value = InteractionSchema.parse(payload.interaction);
    const binding = payload.dispatchContext?.binding;
    if (!binding || !validBinding(binding) || binding.sessionId !== event.sessionId || value.sessionId !== event.sessionId
      || value.turnId !== binding.turnId || !methodMatches(value.kind, binding.nativeMethod))
      throw new Error("INTERACTION_NATIVE_BINDING_INVALID");
    const existing = this.get(value.interactionId);
    if (existing) {
      if (existing.nativeRequestId && (existing.nativeRequestId !== binding.nativeRequestId || existing.nativeMethod !== binding.nativeMethod
        || existing.attemptId !== binding.attemptId || existing.runtimeGeneration !== binding.runtimeGeneration
        || JSON.stringify(existing.request) !== JSON.stringify(value.request)))
        throw new Error("INTERACTION_NATIVE_REQUEST_CHANGED");
      if (existing.nativeRequestId || existing.status !== "pending" || this.reservation(existing.interactionId))
        return;
      this.db.prepare(`UPDATE interactions SET attempt_id=?,runtime_id=?,runtime_generation=?,native_request_id=?,native_method=?,dispatch_context_json=?,
    request_json=?,allowed_actions_json=?,expires_at=?,delivery_state='none',evidence_kind='native_request',updated_at=? WHERE interaction_id=?`)
        .run(binding.attemptId, binding.runtimeId, binding.runtimeGeneration, binding.nativeRequestId, binding.nativeMethod, JSON.stringify(binding.dispatchContext), JSON.stringify(value.request), JSON.stringify(value.allowedActions), value.expiresAt, event.occurredAt, value.interactionId);
      return;
    }
    this.db.prepare(`INSERT INTO interactions(interaction_id,session_id,turn_id,kind,attempt_id,runtime_id,runtime_generation,native_request_id,native_method,dispatch_context_json,
   version,status,delivery_state,evidence_kind,request_json,allowed_actions_json,legacy_approval_id,expires_at,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.interactionId, value.sessionId, value.turnId, value.kind, binding.attemptId, binding.runtimeId, binding.runtimeGeneration, binding.nativeRequestId, binding.nativeMethod, JSON.stringify(binding.dispatchContext), value.version, value.status, value.deliveryState, value.evidenceKind, JSON.stringify(value.request), JSON.stringify(value.allowedActions), binding.legacyApprovalId ?? null, value.expiresAt, value.createdAt, event.occurredAt);
  }
  private projectReservation(event: SessionEvent): void {
    const payload = source(event);
    const row = payload.interactionId ? this.get(payload.interactionId) : undefined;
    if (!row || row.sessionId !== event.sessionId || row.status !== "pending" || row.version !== payload.expectedVersion
      || row.expiresAt <= event.occurredAt || this.reservation(row.interactionId))
      throw new Error("INTERACTION_RESPONDING");
    const intent = this.db.prepare(`SELECT auth_subject_id,command_id,id,payload_json,request_hash FROM execution_intents
   WHERE session_id=? AND resource_id=? AND source_sequence=? AND kind IN ('respond_approval','respond_question')`)
      .get(event.sessionId, row.interactionId, event.sequence) as {
      auth_subject_id: string;
      command_id: string;
      id: string;
      payload_json: string;
      request_hash: string;
    } | undefined;
    if (!intent)
      throw new Error("INTERACTION_INTENT_REQUIRED");
    if (row.legacyApprovalId) {
      const old = this.db.prepare("SELECT intent_id FROM approval_reservations WHERE approval_id=?").get(row.legacyApprovalId) as {
        intent_id: string;
      } | undefined;
      if (!old || old.intent_id !== intent.id)
        throw new Error("INTERACTION_RESPONDING");
    }
    const changed = this.db.prepare("UPDATE interactions SET status='responding',delivery_state='accepted',version=version+1,updated_at=? WHERE interaction_id=? AND version=? AND status='pending'")
      .run(event.occurredAt, row.interactionId, payload.expectedVersion);
    if (changed.changes !== 1)
      throw new Error("INTERACTION_VERSION_CONFLICT");
    const answer = JSON.parse(intent.payload_json) as {
      action?: unknown;
      answers?: unknown;
    };
    this.db.prepare(`INSERT INTO interaction_reservations(interaction_id,auth_subject_id,command_id,intent_id,expected_version,answer_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?)`).run(row.interactionId, intent.auth_subject_id, intent.command_id, intent.id, payload.expectedVersion, JSON.stringify(row.kind === "question" ? { answers: answer.answers } : { action: answer.action }), event.occurredAt, event.occurredAt);
  }
  private projectDelivery(event: SessionEvent): void {
    const payload = source(event);
    const row = payload.interactionId ? this.get(payload.interactionId) : undefined;
    const evidence = payload.dispatchContext?.evidence;
    if (!row || row.sessionId !== event.sessionId || row.version !== payload.expectedVersion || !evidence || !this.reservation(row.interactionId))
      throw new Error("INTERACTION_DELIVERY_STALE");
    if (evidence.kind === "native-ack" && (!evidence.sourceId || evidence.nativeRequestId !== row.nativeRequestId))
      throw new Error("INTERACTION_NATIVE_EVIDENCE_INVALID");
    const next = payload.status;
    if (!next || !payload.deliveryState)
      throw new Error("INTERACTION_DELIVERY_INVALID");
    this.db.prepare("UPDATE interactions SET status=?,delivery_state=?,evidence_kind=?,reason_code=?,version=version+1,updated_at=? WHERE interaction_id=? AND version=?")
      .run(next, payload.deliveryState, evidence.kind === "native-ack" ? "native_confirmation" : evidence.kind === "local-delivery" ? "local_delivery" : "unknown", payload.reasonCode ?? null, event.occurredAt, row.interactionId, row.version);
    this.db.prepare("INSERT INTO interaction_delivery_evidence(id,interaction_id,kind,source_id,evidence_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(`evidence:${event.id}`, row.interactionId, evidence.kind, evidence.kind === "native-ack" ? evidence.sourceId : null, JSON.stringify(evidence), event.occurredAt);
  }
  private projectObsolete(event: SessionEvent, commit: EventCommitRow): void {
    const payload = source(event);
    const row = payload.interactionId ? this.get(payload.interactionId) : undefined;
    if (!row || row.sessionId !== event.sessionId || (payload.expectedVersion !== undefined && row.version !== payload.expectedVersion))
      throw new Error("INTERACTION_VERSION_CONFLICT");
    if (!OPEN.has(row.status))
      return;
    this.obsolete(row, event.type === "interaction.expired" ? "expired" : "superseded", payload.reasonCode ?? "request_obsolete", event, commit);
  }
  private obsolete(row: InteractionRow, status: "expired" | "superseded", reason: string, event: SessionEvent, commit: EventCommitRow): void {
    const reservation = this.reservation(row.interactionId);
    this.db.prepare("UPDATE interactions SET status=?,delivery_state=?,evidence_kind=?,reason_code=?,version=version+1,updated_at=? WHERE interaction_id=?")
      .run(status, reservation ? "unconfirmed" : row.deliveryState, reservation ? "unknown" : row.evidenceKind, reason, event.occurredAt, row.interactionId);
    if (row.legacyApprovalId)
      this.db.prepare("UPDATE approvals SET status='superseded',action=?,version=version+1,resolved_at=? WHERE approval_id=? AND status='pending'")
        .run(status, event.occurredAt, row.legacyApprovalId);
    if (!reservation)
      return;
    const intent = this.db.prepare("SELECT state,request_hash FROM execution_intents WHERE id=?").get(reservation.intentId) as {
      state: string;
      request_hash: string;
    } | undefined;
    if (!intent)
      throw new Error("INTERACTION_INTENT_REQUIRED");
    const provenNotSent = intent.state === "pending" || intent.state === "claimed";
    const receiptState = provenNotSent ? "failed" : "outcome_unknown";
    const response = { interactionId: row.interactionId, version: row.version + 1, status, deliveryState: "unconfirmed" };
    const changed = this.db.prepare(`UPDATE command_receipts SET state=?,response_json=?,updated_at=?,commit_id=?,source_sequence=?
   WHERE auth_subject_id=? AND command_id=? AND request_hash=?`)
      .run(receiptState, JSON.stringify(response), event.occurredAt, commit.id, event.sequence, reservation.authSubjectId, reservation.commandId, intent.request_hash);
    if (changed.changes !== 1)
      throw new Error("COMMAND_RECEIPT_NOT_FOUND");
    this.db.prepare("UPDATE execution_intents SET state=?,result_code=?,result_json=?,updated_at=? WHERE id=?")
      .run(provenNotSent ? "settled" : "outcome_unknown", reason, JSON.stringify(response), event.occurredAt, reservation.intentId);
  }
  private obsoleteForTerminal(event: SessionEvent, commit: EventCommitRow): void {
    if (!isRecord(event.payload) || typeof event.payload.turnId !== "string")
      return;
    const rows = this.db.prepare("SELECT * FROM interactions WHERE session_id=? AND turn_id=? AND status IN ('pending','responding','outcome_unknown')")
      .all(event.sessionId, event.payload.turnId) as RawInteraction[];
    for (const raw of rows)
      this.obsolete(toInteraction(raw), "superseded", "turn_no_longer_accepts_input", event, commit);
  }
  private mirrorLegacyApproval(event: SessionEvent, commit: EventCommitRow): void {
    if (!isRecord(event.payload) || typeof event.payload.approvalId !== "string")
      return;
    const raw = this.db.prepare("SELECT * FROM interactions WHERE legacy_approval_id=? AND session_id=?").get(event.payload.approvalId, event.sessionId) as RawInteraction | undefined;
    if (!raw)
      return;
    const row = toInteraction(raw);
    if (!OPEN.has(row.status))
      return;
    if (event.type === "approval.response.accepted") {
      const old = this.db.prepare("SELECT * FROM approval_reservations WHERE approval_id=?").get(row.legacyApprovalId) as {
        auth_subject_id: string;
        command_id: string;
        intent_id: string;
        expected_version: number;
        action: string;
      } | undefined;
      if (!old)
        return;
      if (!this.reservation(row.interactionId))
        this.db.prepare(`INSERT INTO interaction_reservations(interaction_id,auth_subject_id,command_id,intent_id,expected_version,answer_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(row.interactionId, old.auth_subject_id, old.command_id, old.intent_id, old.expected_version, JSON.stringify({ action: old.action }), event.occurredAt, event.occurredAt);
      this.db.prepare("UPDATE interactions SET status='responding',delivery_state='accepted',version=version+1,updated_at=? WHERE interaction_id=?")
        .run(event.occurredAt, row.interactionId);
    }
    else if (event.type === "approval.resolve.unavailable") {
      this.db.prepare("UPDATE interactions SET status='outcome_unknown',delivery_state='unconfirmed',evidence_kind='unknown',version=version+1,updated_at=? WHERE interaction_id=?")
        .run(event.occurredAt, row.interactionId);
    }
    else if (event.payload.action === "expired" || event.payload.action === "aborted") {
      this.obsolete(row, event.payload.action === "expired" ? "expired" : "superseded", "native_request_gone", event, commit);
    }
    else {
      this.db.prepare("UPDATE interactions SET status='delivered',delivery_state='local_delivery',evidence_kind='local_delivery',version=version+1,updated_at=? WHERE interaction_id=?")
        .run(event.occurredAt, row.interactionId);
    }
  }
}
function validBinding(binding: InteractionFence & {
  nativeRequestId: string;
  nativeMethod: NativeInteractionMethod;
}): boolean {
  return [binding.sessionId, binding.turnId, binding.attemptId, binding.runtimeId, binding.nativeRequestId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)
    && Number.isSafeInteger(binding.runtimeGeneration) && binding.runtimeGeneration > 0 && METHODS.has(binding.nativeMethod)
    && binding.dispatchContext?.sessionId === binding.sessionId && binding.dispatchContext.flyxTurnId === binding.turnId
    && binding.dispatchContext.attemptId === binding.attemptId && binding.dispatchContext.runtimeId === binding.runtimeId
    && binding.dispatchContext.runtimeGeneration === binding.runtimeGeneration;
}
export function methodMatches(kind: Interaction["kind"], method: NativeInteractionMethod): boolean {
  return kind === "question" ? method === "canUseTool/AskUserQuestion" || method === "item/tool/requestUserInput"
    : method === "canUseTool/approval" || method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
}
function source(event: SessionEvent): SourcePayload { if (!isRecord(event.payload))
  throw new Error("INTERACTION_SOURCE_INVALID"); return event.payload as SourcePayload; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
type RawInteraction = {
  interaction_id: string;
  session_id: string;
  turn_id: string;
  kind: "approval" | "question";
  attempt_id: string | null;
  runtime_id: string | null;
  runtime_generation: number | null;
  native_request_id: string | null;
  native_method: NativeInteractionMethod | null;
  dispatch_context_json: string | null;
  version: number;
  status: InteractionStatus;
  delivery_state: Interaction["deliveryState"];
  evidence_kind: Interaction["evidenceKind"];
  request_json: string;
  allowed_actions_json: string;
  reason_code: string | null;
  legacy_approval_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};
function toInteraction(row: RawInteraction): InteractionRow {
  const value = InteractionSchema.parse({
    interactionId: row.interaction_id, sessionId: row.session_id, turnId: row.turn_id, kind: row.kind, version: row.version, status: row.status,
    deliveryState: row.delivery_state, evidenceKind: row.evidence_kind, request: JSON.parse(row.request_json) as unknown, allowedActions: JSON.parse(row.allowed_actions_json) as unknown,
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}), expiresAt: row.expires_at, createdAt: row.created_at,
    responseAvailable: row.status === "pending" && !!row.native_request_id && !!row.native_method && !!row.attempt_id && !!row.runtime_id
  });
  return {
    ...value, ...(row.dispatch_context_json ? { dispatchContext: dispatchContextForTurn(row.turn_id, JSON.parse(row.dispatch_context_json) as DispatchContext) } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
    ...(row.runtime_generation !== null ? { runtimeGeneration: row.runtime_generation } : {}), ...(row.native_request_id ? { nativeRequestId: row.native_request_id } : {}),
    ...(row.native_method ? { nativeMethod: row.native_method } : {}), ...(row.legacy_approval_id ? { legacyApprovalId: row.legacy_approval_id } : {}), updatedAt: row.updated_at
  };
}
type RawReservation = {
  interaction_id: string;
  auth_subject_id: string;
  command_id: string;
  intent_id: string;
  expected_version: number;
  answer_json: string;
  created_at: string;
  updated_at: string;
};
function toReservation(row: RawReservation): InteractionReservationRow {
  return {
    interactionId: row.interaction_id, authSubjectId: row.auth_subject_id, commandId: row.command_id, intentId: row.intent_id, expectedVersion: row.expected_version,
    answer: JSON.parse(row.answer_json) as InteractionReservationRow["answer"], createdAt: row.created_at, updatedAt: row.updated_at
  };
}
