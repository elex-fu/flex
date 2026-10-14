import type Database from "better-sqlite3";
import { CheckpointError } from "./types.js";
import type { CheckpointDiffEntry, CheckpointDiffRecord, CheckpointManifest, CheckpointPhase, CheckpointPreviewPlan } from "./types.js";

type ManifestRow = { manifest_json: string };
type DiffRow = { diff_id: string; session_id: string; before_checkpoint_id: string; after_checkpoint_id: string; layer: "workspace" | "index"; created_at: string };
/** Shares the owner's database/transaction. Construction never executes schema or opens another writer. */
export class CheckpointStore {
  constructor(readonly db: Database.Database) {}
  begin(manifest: CheckpointManifest): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO checkpoint_captures
        (checkpoint_id, session_id, workspace_id, turn_id, attempt_id, phase, status, workspace_ref, index_ref, manifest_json, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(manifest.checkpointId, manifest.sessionId, manifest.workspaceId, manifest.turnId ?? null,
          manifest.attemptId ?? null, manifest.phase, manifest.status, manifest.workspaceRef, manifest.indexRef, JSON.stringify(manifest), manifest.startedAt);
      this.pin(manifest.checkpointId, "capture", manifest.checkpointId);
    })();
  }
  finish(manifest: CheckpointManifest): void {
    this.db.transaction(() => {
      if (this.db.prepare(`UPDATE checkpoint_captures SET status = ?, manifest_json = ?, completed_at = ?
        WHERE checkpoint_id = ? AND status = 'capturing'`).run(manifest.status, JSON.stringify(manifest), manifest.completedAt ?? null, manifest.checkpointId).changes !== 1) {
        throw new CheckpointError("CAPTURE_STATE_CONFLICT", "Checkpoint was already settled");
      }
      const insert = this.db.prepare("INSERT INTO checkpoint_files (checkpoint_id, path, entry_json) VALUES (?, ?, ?)");
      for (const entry of manifest.entries) insert.run(manifest.checkpointId, entry.path, JSON.stringify(entry));
      // History remains pinned until an explicit retention policy releases it. No GC guesses from tree OIDs.
      this.pin(manifest.checkpointId, "history", manifest.checkpointId);
      this.unpin(manifest.checkpointId, "capture", manifest.checkpointId);
    })();
  }
  get(checkpointId: string, sessionId?: string): CheckpointManifest | undefined {
    const row = this.db.prepare("SELECT manifest_json FROM checkpoint_captures WHERE checkpoint_id = ?").get(checkpointId) as ManifestRow | undefined;
    const manifest = row ? JSON.parse(row.manifest_json) as CheckpointManifest : undefined;
    if (manifest && sessionId && manifest.sessionId !== sessionId) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Checkpoint belongs to another session");
    return manifest;
  }
  require(checkpointId: string, sessionId: string): CheckpointManifest {
    const manifest = this.get(checkpointId, sessionId);
    if (!manifest) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Checkpoint does not exist");
    return manifest;
  }
  findAttempt(sessionId: string, turnId: string, attemptId: string, phase: "before" | "after"): CheckpointManifest | undefined {
    const row = this.db.prepare("SELECT manifest_json FROM checkpoint_captures WHERE session_id = ? AND turn_id = ? AND attempt_id = ? AND phase = ?")
      .get(sessionId, turnId, attemptId, phase) as ManifestRow | undefined;
    return row ? JSON.parse(row.manifest_json) as CheckpointManifest : undefined;
  }
  getBaseline(sessionId: string): CheckpointManifest | undefined {
    const row = this.db.prepare(`SELECT capture.manifest_json FROM checkpoint_baselines baseline JOIN checkpoint_captures capture
      ON capture.checkpoint_id = baseline.checkpoint_id WHERE baseline.session_id = ?`).get(sessionId) as ManifestRow | undefined;
    return row ? JSON.parse(row.manifest_json) as CheckpointManifest : undefined;
  }
  bindBaseline(manifest: CheckpointManifest): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO checkpoint_baselines (session_id, checkpoint_id) VALUES (?, ?)").run(manifest.sessionId, manifest.checkpointId);
      const baseline = this.getBaseline(manifest.sessionId);
      if (baseline) this.pin(baseline.checkpointId, "baseline", manifest.sessionId);
    })();
  }
  list(sessionId: string, phase?: CheckpointPhase): CheckpointManifest[] {
    const rows = (phase ? this.db.prepare("SELECT manifest_json FROM checkpoint_captures WHERE session_id = ? AND phase = ? ORDER BY started_at, checkpoint_id").all(sessionId, phase)
      : this.db.prepare("SELECT manifest_json FROM checkpoint_captures WHERE session_id = ? ORDER BY started_at, checkpoint_id").all(sessionId)) as ManifestRow[];
    return rows.map((row) => JSON.parse(row.manifest_json) as CheckpointManifest);
  }
  putDiff(record: CheckpointDiffRecord): void {
    this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO checkpoint_diffs
        (diff_id, session_id, before_checkpoint_id, after_checkpoint_id, layer, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(record.diffId,
          record.sessionId, record.beforeCheckpointId, record.afterCheckpointId, record.layer, record.createdAt).changes;
      if (!inserted) return;
      const insert = this.db.prepare("INSERT INTO checkpoint_diff_files (diff_id, file_id, position, entry_json) VALUES (?, ?, ?, ?)");
      for (const entry of record.entries) insert.run(record.diffId, entry.fileId, entry.position, JSON.stringify(entry));
      this.pin(record.beforeCheckpointId, "diff", record.diffId); this.pin(record.afterCheckpointId, "diff", record.diffId);
    })();
  }
  getDiff(diffId: string, sessionId: string): Omit<CheckpointDiffRecord, "entries"> | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoint_diffs WHERE diff_id = ?").get(diffId) as DiffRow | undefined;
    if (!row) return undefined;
    if (row.session_id !== sessionId) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Diff belongs to another session");
    return { diffId: row.diff_id, sessionId: row.session_id, beforeCheckpointId: row.before_checkpoint_id,
      afterCheckpointId: row.after_checkpoint_id, layer: row.layer, createdAt: row.created_at };
  }
  diffCount(diffId: string): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM checkpoint_diff_files WHERE diff_id = ?").get(diffId) as { count: number }).count; }
  diffPage(diffId: string, afterPosition: number, limit: number): CheckpointDiffEntry[] {
    const rows = this.db.prepare("SELECT entry_json FROM checkpoint_diff_files WHERE diff_id = ? AND position > ? ORDER BY position LIMIT ?")
      .all(diffId, afterPosition, Math.max(1, Math.min(201, limit))) as Array<{ entry_json: string }>;
    return rows.map((row) => JSON.parse(row.entry_json) as CheckpointDiffEntry);
  }
  diffFile(diffId: string, fileId: string): CheckpointDiffEntry | undefined {
    const row = this.db.prepare("SELECT entry_json FROM checkpoint_diff_files WHERE diff_id = ? AND file_id = ?").get(diffId, fileId) as { entry_json: string } | undefined;
    return row ? JSON.parse(row.entry_json) as CheckpointDiffEntry : undefined;
  }
  putPreview(plan: CheckpointPreviewPlan): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO checkpoint_preview_plans
        (plan_id, actor_id, session_id, checkpoint_id, current_checkpoint_id, state, expires_at, plan_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(plan.planId, plan.actorId, plan.sessionId, plan.checkpointId, plan.currentCheckpointId, plan.state, plan.expiresAt, JSON.stringify(plan), plan.createdAt);
      this.pin(plan.checkpointId, "preview", plan.planId); this.pin(plan.currentCheckpointId, "preview", plan.planId);
    })();
  }
  getPreview(planId: string, sessionId: string, actorId: string): CheckpointPreviewPlan {
    const row = this.db.prepare("SELECT plan_json, state, actor_id, session_id FROM checkpoint_preview_plans WHERE plan_id = ?")
      .get(planId) as { plan_json: string; state: CheckpointPreviewPlan["state"]; actor_id: string; session_id: string } | undefined;
    if (!row) throw new CheckpointError("PLAN_STALE", "Preview plan does not exist");
    if (row.actor_id !== actorId || row.session_id !== sessionId) throw new CheckpointError("PLAN_SCOPE_MISMATCH", "Preview belongs to another actor or session");
    return { ...JSON.parse(row.plan_json) as CheckpointPreviewPlan, state: row.state };
  }
  transitionPreview(planId: string, from: CheckpointPreviewPlan["state"], to: CheckpointPreviewPlan["state"]): boolean {
    return this.db.prepare("UPDATE checkpoint_preview_plans SET state = ? WHERE plan_id = ? AND state = ?").run(to, planId, from).changes === 1;
  }
  pin(checkpointId: string, ownerKind: string, ownerId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO checkpoint_pins (checkpoint_id, owner_kind, owner_id) VALUES (?, ?, ?)").run(checkpointId, ownerKind, ownerId);
  }
  unpin(checkpointId: string, ownerKind: string, ownerId: string): void {
    this.db.prepare("DELETE FROM checkpoint_pins WHERE checkpoint_id = ? AND owner_kind = ? AND owner_id = ?").run(checkpointId, ownerKind, ownerId);
  }
  /** Capturing rows and every retained history/diff/preview/revert pin protect BOTH refs. */
  protectedRefs(): Array<{ checkpointId: string; workspaceRef: string; indexRef: string }> {
    return (this.db.prepare(`SELECT DISTINCT capture.checkpoint_id, capture.workspace_ref, capture.index_ref FROM checkpoint_captures capture
      LEFT JOIN checkpoint_pins pin ON pin.checkpoint_id = capture.checkpoint_id WHERE capture.status = 'capturing' OR pin.checkpoint_id IS NOT NULL`)
      .all() as Array<{ checkpoint_id: string; workspace_ref: string; index_ref: string }>).map((row) => ({ checkpointId: row.checkpoint_id, workspaceRef: row.workspace_ref, indexRef: row.index_ref }));
  }
}
