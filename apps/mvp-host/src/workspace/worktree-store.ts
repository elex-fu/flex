import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ManagedWorktreeSummary, WorktreeInspection, WorktreeOperation, WorktreeRequest } from "@flyx/mvp-protocol";

export class WorktreeError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string) { super(message); this.name = "WorktreeError"; }
}
export type ManagedWorktreeRecord = Omit<ManagedWorktreeSummary, "directoryName"> & {
  path: string; managedRoot: string; rootIdentity: string; repositoryRoot: string; initialState?: ManagedWorktreeSummary["state"];
};
export type WorktreeOperationRecord = WorktreeOperation & {
  actorId: string; commandId: string; requestHash: string; request: WorktreeRequest; facts: Record<string, unknown>;
};
export type WorktreeStep = { boundary: string; ordinal: number; state: "dispatched" | "applied"; planned: unknown; result?: unknown };
export type WorktreeSnapshot = {
  snapshotId: string; worktreeId: string; repositoryId: string;
  workspaceCommit: string; indexCommit: string; headCommit: string;
  workspaceTree: string; indexTree: string; workspaceDigest: string; indexDigest: string;
  workspaceRef: string; indexRef: string; headRef: string;
};
export type StoredWorktreeInspection = WorktreeInspection & { observationsDigest: string };
type OpRow = { operation_id: string; actor_id: string; command_id: string; worktree_id: string; kind: WorktreeOperation["kind"]; state: WorktreeOperation["state"]; stage: string; request_hash: string; request_json: string; facts_json: string; error_code: string | null; created_at: string; updated_at: string };

/** Journals operations on the Engine/Catalog connection; never opens or migrates a writer. */
export class WorktreeStore {
  constructor(readonly db: Database.Database, readonly now: () => string = () => new Date().toISOString()) {}
  get(worktreeId: string): ManagedWorktreeRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM managed_worktrees WHERE worktree_id = ?").get(worktreeId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ManagedWorktreeRecord : undefined;
  }
  require(id: string): ManagedWorktreeRecord { const record = this.get(id); if (!record) throw new WorktreeError("WORKTREE_NOT_FOUND", "Managed worktree does not exist"); return record; }
  list(): ManagedWorktreeRecord[] { return (this.db.prepare("SELECT record_json FROM managed_worktrees ORDER BY worktree_id").all() as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as ManagedWorktreeRecord); }
  findCommand(actorId: string, commandId: string): WorktreeOperationRecord | undefined { return this.operationRow(this.db.prepare("SELECT * FROM worktree_operations WHERE actor_id = ? AND command_id = ?").get(actorId, commandId) as OpRow | undefined); }
  operation(id: string): WorktreeOperationRecord {
    const operation = this.operationRow(this.db.prepare("SELECT * FROM worktree_operations WHERE operation_id = ?").get(id) as OpRow | undefined);
    if (!operation) throw new WorktreeError("WORKTREE_OPERATION_NOT_FOUND", "Worktree operation does not exist"); return operation;
  }
  accept(record: ManagedWorktreeRecord, request: WorktreeRequest, actorId: string, commandId: string, requestHash: string, reserve?: (record: ManagedWorktreeRecord, operation: WorktreeOperationRecord) => unknown): WorktreeOperationRecord {
    return this.db.transaction(() => {
      const existing = this.findCommand(actorId, commandId);
      if (existing) { if (existing.requestHash !== requestHash) throw new WorktreeError("COMMAND_ID_REUSED", "Command ID belongs to another request"); return existing; }
      const current = this.get(record.worktreeId);
      if (request.kind !== "create") {
        if (!current || current.revision !== request.expectedRevision) throw new WorktreeError("WORKTREE_REVISION_CONFLICT", "Managed worktree revision changed");
        if (request.kind === "archive" && current.state !== "active" || request.kind === "restore" && current.state !== "archived") throw new WorktreeError("WORKTREE_STATE_CONFLICT", "Managed worktree is unavailable for this operation");
      }
      const timestamp = this.now();
      this.db.prepare("INSERT INTO managed_worktrees(worktree_id, repository_id, workspace_id, state, revision, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(worktree_id) DO UPDATE SET state = excluded.state, revision = excluded.revision, record_json = excluded.record_json")
        .run(record.worktreeId, record.repositoryId, record.workspaceId, record.state, record.revision, JSON.stringify(record));
      const id = randomUUID();
      this.db.prepare("INSERT INTO worktree_operations(operation_id,actor_id,command_id,worktree_id,kind,state,stage,request_hash,request_json,created_at,updated_at) VALUES (?,?,?,?,?,'pending','accepted',?,?,?,?)")
        .run(id, actorId, commandId, record.worktreeId, request.kind, requestHash, JSON.stringify(request), timestamp, timestamp);
      const op = this.operation(id);
      assertSync(reserve?.(record, op));
      return op;
    })();
  }
  running(id: string): void { this.db.prepare("UPDATE worktree_operations SET state='running', error_code=NULL, updated_at=? WHERE operation_id=? AND state='pending'").run(this.now(), id); }
  resume(id: string): void { this.db.prepare("UPDATE worktree_operations SET state='pending',error_code=NULL,updated_at=? WHERE operation_id=? AND state='outcome_unknown'").run(this.now(), id); }
  facts(id: string, patch: Record<string, unknown>): void { const op = this.operation(id); this.db.prepare("UPDATE worktree_operations SET facts_json=?,updated_at=? WHERE operation_id=?").run(JSON.stringify({ ...op.facts, ...patch }), this.now(), id); }
  steps(id: string): WorktreeStep[] {
    return (this.db.prepare("SELECT * FROM worktree_steps WHERE operation_id=? ORDER BY ordinal").all(id) as Array<{ boundary: string; ordinal: number; state: "dispatched" | "applied"; planned_json: string; result_json: string | null }>).map((row) => ({ boundary: row.boundary, ordinal: row.ordinal, state: row.state, planned: JSON.parse(row.planned_json), ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}) }));
  }
  beginStep(id: string, boundary: string, planned: unknown): WorktreeStep {
    this.db.transaction(() => {
      const ordinal = (this.db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM worktree_steps WHERE operation_id=?").get(id) as { n: number }).n;
      this.db.prepare("INSERT OR IGNORE INTO worktree_steps(operation_id,ordinal,boundary,state,planned_json) VALUES (?,?,?,'dispatched',?)").run(id, ordinal, boundary, JSON.stringify(planned ?? null));
      this.db.prepare("UPDATE worktree_operations SET stage=?,updated_at=? WHERE operation_id=?").run(boundary.split(":")[0], this.now(), id);
    })();
    const row = this.db.prepare("SELECT ordinal,state,planned_json,result_json FROM worktree_steps WHERE operation_id=? AND boundary=?").get(id, boundary) as { ordinal: number; state: WorktreeStep["state"]; planned_json: string; result_json: string | null };
    return { boundary, ordinal: row.ordinal, state: row.state, planned: JSON.parse(row.planned_json), ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}) };
  }
  finishStep(id: string, boundary: string, result: unknown): void { this.db.prepare("UPDATE worktree_steps SET state='applied',result_json=? WHERE operation_id=? AND boundary=?").run(JSON.stringify(result ?? null), id, boundary); }
  putSnapshot(snapshot: WorktreeSnapshot, operationId: string): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO worktree_snapshots(snapshot_id,worktree_id,snapshot_json,created_at) VALUES (?,?,?,?)").run(snapshot.snapshotId, snapshot.worktreeId, JSON.stringify(snapshot), this.now());
      for (const [kind, owner] of [["operation", operationId], ["history", snapshot.worktreeId]]) this.db.prepare("INSERT OR IGNORE INTO worktree_snapshot_pins(snapshot_id,owner_kind,owner_id) VALUES (?,?,?)").run(snapshot.snapshotId, kind!, owner!);
      this.facts(operationId, { snapshotId: snapshot.snapshotId });
    })();
  }
  snapshot(id: string): WorktreeSnapshot { const row = this.db.prepare("SELECT snapshot_json FROM worktree_snapshots WHERE snapshot_id=?").get(id) as { snapshot_json: string } | undefined; if (!row) throw new WorktreeError("WORKTREE_SNAPSHOT_UNAVAILABLE", "Retained worktree snapshot is unavailable"); return JSON.parse(row.snapshot_json) as WorktreeSnapshot; }
  protectedRefs(): Array<{ repositoryId: string; refs: string[] }> {
    const result = (this.db.prepare("SELECT DISTINCT snapshot_json FROM worktree_snapshots s JOIN worktree_snapshot_pins p ON p.snapshot_id=s.snapshot_id").all() as Array<{ snapshot_json: string }>).map((row) => {
      const s = JSON.parse(row.snapshot_json) as WorktreeSnapshot;
      return { repositoryId: s.repositoryId, refs: [s.workspaceRef, s.indexRef, s.headRef, "refs/flyx/checkpoints/" + s.snapshotId + "/workspace", "refs/flyx/checkpoints/" + s.snapshotId + "/index"] };
    });
    for (const row of this.db.prepare("SELECT o.facts_json,w.repository_id FROM worktree_operations o JOIN managed_worktrees w ON w.worktree_id=o.worktree_id WHERE o.state IN ('pending','running','outcome_unknown')").iterate() as Iterable<{ facts_json: string; repository_id: string }>) {
      const facts = JSON.parse(row.facts_json) as Record<string, unknown>;
      if (typeof facts.captureId === "string") result.push({ repositoryId: row.repository_id, refs: ["refs/flyx/checkpoints/" + facts.captureId + "/workspace", "refs/flyx/checkpoints/" + facts.captureId + "/index"] });
    }
    return result;
  }
  complete(id: string, patch: Partial<ManagedWorktreeRecord>, publish: (record: ManagedWorktreeRecord, operation: WorktreeOperationRecord) => unknown): WorktreeOperationRecord {
    return this.db.transaction(() => {
      const op = this.operation(id); if (op.state === "completed") return op;
      const current = this.require(op.worktreeId);
      const next = { ...current, ...patch, revision: current.revision + 1 };
      this.save(next);
      this.db.prepare("UPDATE worktree_operations SET state='completed',stage='completed',error_code=NULL,updated_at=? WHERE operation_id=?").run(this.now(), id);
      assertSync(publish(next, this.operation(id)));
      return this.operation(id);
    })();
  }
  rejectBeforeCheckout(id: string, code: string, publish: (record: ManagedWorktreeRecord, operation: WorktreeOperationRecord) => unknown): WorktreeOperationRecord {
    return this.db.transaction(() => {
      const op = this.operation(id), current = this.require(op.worktreeId);
      const next: ManagedWorktreeRecord = { ...current, state: current.initialState ?? "blocked", revision: current.revision + 1 };
      this.save(next);
      this.db.prepare("UPDATE worktree_operations SET state='failed',error_code=?,updated_at=? WHERE operation_id=?").run(code, this.now(), id);
      if (op.kind !== "create") assertSync(publish(next, this.operation(id)));
      return this.operation(id);
    })();
  }
  failed(id: string, code: string, uncertain = true): WorktreeOperationRecord {
    return this.db.transaction(() => {
      const op = this.operation(id), current = this.require(op.worktreeId);
      this.save({ ...current, state: "blocked", revision: current.revision + 1 });
      this.db.prepare("UPDATE worktree_operations SET state=?,error_code=?,updated_at=? WHERE operation_id=?").run(uncertain ? "outcome_unknown" : "failed", code, this.now(), id);
      return this.operation(id);
    })();
  }
  putInspection(evidence: StoredWorktreeInspection): void { this.db.prepare("INSERT INTO worktree_inspections(evidence_id,operation_id,evidence_json,observations_digest,expires_at) VALUES (?,?,?,?,?)").run(evidence.evidenceId, evidence.operationId, JSON.stringify(evidence), evidence.observationsDigest, evidence.expiresAt); }
  inspection(id: string): StoredWorktreeInspection { const row = this.db.prepare("SELECT evidence_json FROM worktree_inspections WHERE evidence_id=?").get(id) as { evidence_json: string } | undefined; if (!row) throw new WorktreeError("WORKTREE_EVIDENCE_STALE", "Worktree inspection does not exist"); return JSON.parse(row.evidence_json) as StoredWorktreeInspection; }
  private save(record: ManagedWorktreeRecord): void { this.db.prepare("UPDATE managed_worktrees SET state=?,revision=?,record_json=? WHERE worktree_id=?").run(record.state, record.revision, JSON.stringify(record), record.worktreeId); }
  private operationRow(row: OpRow | undefined): WorktreeOperationRecord | undefined { return row ? { operationId: row.operation_id, worktreeId: row.worktree_id, actorId: row.actor_id, commandId: row.command_id, kind: row.kind, state: row.state, stage: row.stage, requestHash: row.request_hash, request: JSON.parse(row.request_json), facts: JSON.parse(row.facts_json), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.error_code ? { errorCode: row.error_code } : {}) } : undefined; }
}
function assertSync(value: unknown): void { if (value && typeof value === "object" && "then" in value) throw new WorktreeError("WORKTREE_ASYNC_COMMIT", "Catalog publication must be synchronous in the Engine transaction"); }
