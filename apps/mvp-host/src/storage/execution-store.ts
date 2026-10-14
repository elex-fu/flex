import type { SqliteStore } from "./db.js";
import type { ApprovalReservationRow, ExecutionIntentRow, ExecutionIntentState, ExecutionIntentUpdate } from "../orchestration/command-contract.js";

/** A view of the same connection; it never opens a second SQLite writer. */
export class ExecutionStore {
  constructor(readonly store: SqliteStore) {}
  get(id: string): ExecutionIntentRow | undefined {
    const row = this.store.db.prepare("SELECT * FROM execution_intents WHERE id = ?").get(id) as RawExecutionIntent | undefined;
    return row ? toExecutionIntent(row) : undefined;
  }
  forCommand(authSubjectId: string, commandId: string): ExecutionIntentRow[] {
    return (this.store.db.prepare("SELECT * FROM execution_intents WHERE auth_subject_id = ? AND command_id = ? ORDER BY ordinal")
      .all(authSubjectId, commandId) as RawExecutionIntent[]).map(toExecutionIntent);
  }
  list(input: { sessionId?: string; state?: ExecutionIntentState; limit?: number } = {}): ExecutionIntentRow[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (input.sessionId) { clauses.push("session_id = ?"); args.push(input.sessionId); }
    if (input.state) { clauses.push("state = ?"); args.push(input.state); }
    args.push(Math.max(1, Math.min(1000, input.limit ?? 100)));
    return (this.store.db.prepare(`SELECT * FROM execution_intents ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, ordinal, id LIMIT ?`)
      .all(...args) as RawExecutionIntent[]).map(toExecutionIntent);
  }
  reservation(approvalId: string): ApprovalReservationRow | undefined {
    const row = this.store.db.prepare("SELECT * FROM approval_reservations WHERE approval_id = ?").get(approvalId) as RawReservation | undefined;
    return row ? toReservation(row) : undefined;
  }
  claim(id: string, owner: { id: string; generation: number }): ExecutionIntentRow {
    return this.transition({ id, expectedStates: ["pending"], state: "claimed", claimOwnerId: owner.id, claimOwnerGeneration: owner.generation });
  }
  transition(update: ExecutionIntentUpdate): ExecutionIntentRow {
    const current = this.get(update.id);
    if (!current) throw new Error("EXECUTION_INTENT_NOT_FOUND");
    this.store.commitCommand({ sessionId: current.sessionId, build: () => ({ result: undefined, intentUpdates: [update] }) });
    return this.get(update.id)!;
  }
}
export type RawExecutionIntent = {
  id: string; session_id: string; turn_id: string | null; auth_subject_id: string; command_id: string; ordinal: number;
  actor_kind: "device" | "host"; kind: string; resource_id: string; payload_json: string; request_hash: string;
  request_format_version: 1 | 2; source_sequence: number; commit_id: string | null; runtime_generation: number;
  attempt_id: string; state: ExecutionIntentState; claim_owner_id: string | null; claim_owner_generation: number | null;
  native_request_id: string | null; result_code: string | null; result_json: string | null; created_at: string; updated_at: string;
};
export function toExecutionIntent(row: RawExecutionIntent): ExecutionIntentRow {
  return { id: row.id, sessionId: row.session_id, ...(row.turn_id ? { turnId: row.turn_id } : {}),
    authSubjectId: row.auth_subject_id, commandId: row.command_id, ordinal: row.ordinal, actorKind: row.actor_kind,
    kind: row.kind, resourceId: row.resource_id, payload: JSON.parse(row.payload_json) as unknown, requestHash: row.request_hash,
    requestFormatVersion: row.request_format_version, sourceSequence: row.source_sequence, ...(row.commit_id ? { commitId: row.commit_id } : {}),
    runtimeGeneration: row.runtime_generation, attemptId: row.attempt_id, state: row.state,
    ...(row.claim_owner_id ? { claimOwnerId: row.claim_owner_id } : {}),
    ...(row.claim_owner_generation !== null ? { claimOwnerGeneration: row.claim_owner_generation } : {}),
    ...(row.native_request_id ? { nativeRequestId: row.native_request_id } : {}), ...(row.result_code ? { resultCode: row.result_code } : {}),
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
}
type RawReservation = { approval_id: string; auth_subject_id: string; command_id: string; intent_id: string; expected_version: number;
  action: string; state: ApprovalReservationRow["state"]; created_at: string; updated_at: string };
function toReservation(row: RawReservation): ApprovalReservationRow {
  return { approvalId: row.approval_id, authSubjectId: row.auth_subject_id, commandId: row.command_id, intentId: row.intent_id,
    expectedVersion: row.expected_version, action: row.action, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at };
}
