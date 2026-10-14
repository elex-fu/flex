import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { CheckpointManifest } from "../../checkpoint/types.js";

/** Called by the owned migration runner inside its shared SQLite transaction. */
export const CHECKPOINT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_captures (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL,
  turn_id TEXT, attempt_id TEXT, phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('capturing','complete','unsupported','raced','failed','legacy_inexact')),
  workspace_ref TEXT NOT NULL UNIQUE, index_ref TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_attempt_phase
  ON checkpoint_captures(session_id, turn_id, attempt_id, phase)
  WHERE turn_id IS NOT NULL AND attempt_id IS NOT NULL AND phase IN ('before','after');
CREATE INDEX IF NOT EXISTS checkpoint_session_history ON checkpoint_captures(session_id, started_at, checkpoint_id);
CREATE TABLE IF NOT EXISTS checkpoint_files (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id) ON DELETE CASCADE,
  path TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(checkpoint_id, path)
);
CREATE TABLE IF NOT EXISTS checkpoint_baselines (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id)
);
CREATE TABLE IF NOT EXISTS checkpoint_diffs (
  diff_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  before_checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id),
  after_checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id),
  layer TEXT NOT NULL CHECK(layer IN ('workspace','index')), created_at TEXT NOT NULL,
  UNIQUE(before_checkpoint_id, after_checkpoint_id, layer)
);
CREATE TABLE IF NOT EXISTS checkpoint_diff_files (
  diff_id TEXT NOT NULL REFERENCES checkpoint_diffs(diff_id) ON DELETE CASCADE,
  file_id TEXT NOT NULL, position INTEGER NOT NULL, entry_json TEXT NOT NULL,
  PRIMARY KEY(diff_id, file_id), UNIQUE(diff_id, position)
);
CREATE TABLE IF NOT EXISTS checkpoint_preview_plans (
  plan_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
  checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id),
  current_checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id),
  state TEXT NOT NULL CHECK(state IN ('active','consumed','expired','invalidated')),
  expires_at TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoint_preview_expiry ON checkpoint_preview_plans(state, expires_at);
CREATE TABLE IF NOT EXISTS checkpoint_pins (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id),
  owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  PRIMARY KEY(checkpoint_id, owner_kind, owner_id)
);
`;
export function applyCheckpointSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(CHECKPOINT_SCHEMA_SQL);
    // A legacy HEAD baseline cannot be backfilled into an exact historical workspace/index tree.
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!["baseline_head", "baseline_status_json", "baseline_captured_at"].every((name) => columns.some((column) => column.name === name))) return;
    const rows = db.prepare(`SELECT id, workspace_id, workspace_path, baseline_head, baseline_captured_at FROM sessions
      WHERE (baseline_head IS NOT NULL OR baseline_status_json IS NOT NULL OR baseline_captured_at IS NOT NULL)
      AND id NOT IN (SELECT session_id FROM checkpoint_baselines)`).all() as Array<{
        id: string; workspace_id: string; workspace_path: string; baseline_head: string | null; baseline_captured_at: string | null;
      }>;
    for (const row of rows) {
      const checkpointId = randomUUID(); const timestamp = row.baseline_captured_at ?? new Date().toISOString();
      const manifest: CheckpointManifest = {
        checkpointId, schemaVersion: 1, sessionId: row.id, workspaceId: row.workspace_id, workspacePath: row.workspace_path,
        phase: "session_baseline", status: "legacy_inexact", policyVersion: 1, capturedAt: timestamp, startedAt: timestamp, completedAt: timestamp,
        workspaceRef: `refs/flyx/checkpoints/${checkpointId}/workspace`, indexRef: `refs/flyx/checkpoints/${checkpointId}/index`,
        ...(row.baseline_head ? { head: row.baseline_head } : {}), lease: { workspaceId: row.workspace_id, leaseId: "legacy", generation: 0 },
        sessionRevision: 0, epoch: "legacy", runtimeGeneration: 0, nativeHandle: null, nativeHandleBinding: "0".repeat(64),
        samplingConsistency: "unavailable", unsupportedCount: 1, entries: [], statusEntries: [],
        unsupported: [{ reason: "legacy_head_baseline_is_not_a_snapshot" }], warnings: ["legacy_head_baseline_is_not_a_snapshot"],
      };
      db.prepare(`INSERT INTO checkpoint_captures (checkpoint_id, session_id, workspace_id, phase, status, workspace_ref, index_ref, manifest_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(checkpointId, row.id, row.workspace_id, manifest.phase, manifest.status,
          manifest.workspaceRef, manifest.indexRef, JSON.stringify(manifest), timestamp, timestamp);
      db.prepare("INSERT INTO checkpoint_baselines (session_id, checkpoint_id) VALUES (?, ?)").run(row.id, checkpointId);
      db.prepare("INSERT INTO checkpoint_pins (checkpoint_id, owner_kind, owner_id) VALUES (?, 'baseline', ?)").run(checkpointId, row.id);
    }
  })();
}
