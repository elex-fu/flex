import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { CheckpointManifest } from "../../checkpoint/types.js";
import { validateTableContracts, validateUniqueIndex } from "./schema-constraints.js";

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

export function validateCheckpointSchema(db: Database.Database): void {
  validateTableContracts(db, {
    checkpoint_captures: { columns: ["checkpoint_id","session_id","workspace_id","turn_id","attempt_id","phase","status","workspace_ref","index_ref","manifest_json","started_at","completed_at"], primaryKey: ["checkpoint_id"], nullable: ["turn_id","attempt_id","completed_at"], unique: [["workspace_ref"],["index_ref"]], constraints: ["CHECK(status IN ('capturing','complete','unsupported','raced','failed','legacy_inexact'))"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }] },
    checkpoint_files: { columns: ["checkpoint_id","path","entry_json"], primaryKey: ["checkpoint_id","path"], foreignKeys: [{ columns: ["checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"], onDelete: "CASCADE" }] },
    checkpoint_baselines: { columns: ["session_id","checkpoint_id"], primaryKey: ["session_id"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }] },
    checkpoint_diffs: { columns: ["diff_id","session_id","before_checkpoint_id","after_checkpoint_id","layer","created_at"], primaryKey: ["diff_id"], unique: [["before_checkpoint_id","after_checkpoint_id","layer"]], constraints: ["CHECK(layer IN ('workspace','index'))"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["before_checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }, { columns: ["after_checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }] },
    checkpoint_diff_files: { columns: ["diff_id","file_id","position","entry_json"], primaryKey: ["diff_id","file_id"], unique: [["diff_id","position"]], foreignKeys: [{ columns: ["diff_id"], parent: "checkpoint_diffs", target: ["diff_id"], onDelete: "CASCADE" }] },
    checkpoint_preview_plans: { columns: ["plan_id","actor_id","session_id","checkpoint_id","current_checkpoint_id","state","expires_at","plan_json","created_at"], primaryKey: ["plan_id"], constraints: ["CHECK(state IN ('active','consumed','expired','invalidated'))"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }, { columns: ["current_checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }] },
    checkpoint_pins: { columns: ["checkpoint_id","owner_kind","owner_id"], primaryKey: ["checkpoint_id","owner_kind","owner_id"], foreignKeys: [{ columns: ["checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }] },
  });
  validateUniqueIndex(db, "checkpoint_captures", ["session_id","turn_id","attempt_id","phase"], "WHERE turn_id IS NOT NULL AND attempt_id IS NOT NULL AND phase IN ('before','after')", "checkpoint_attempt_phase");
}


/** R16 shares migration009 and the owned Store transaction. Never waits for Git or Native here. */
export const REVERT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_revert_operations (
  operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES checkpoint_preview_plans(plan_id),
  revision INTEGER NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('validated','safety_captured','workspace_restored','provider_rewound','projection_committed','partial_failure')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','completed','rolled_back')),
  operation_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(actor_id,command_id), FOREIGN KEY(actor_id,command_id) REFERENCES command_receipts(auth_subject_id,command_id)
);
CREATE INDEX IF NOT EXISTS checkpoint_reverts_by_session ON checkpoint_revert_operations(session_id,status);
CREATE TABLE IF NOT EXISTS checkpoint_revert_steps (
  operation_id TEXT NOT NULL REFERENCES checkpoint_revert_operations(operation_id),
  step_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  step_json TEXT NOT NULL, PRIMARY KEY(operation_id,step_id), UNIQUE(operation_id,ordinal)
);
CREATE TABLE IF NOT EXISTS checkpoint_revert_step_attempts (
  attempt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatching','applied','outcome_unknown')), attempt_json TEXT NOT NULL,
  FOREIGN KEY(operation_id,step_id) REFERENCES checkpoint_revert_steps(operation_id,step_id)
);
CREATE TABLE IF NOT EXISTS checkpoint_revert_gates (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id), operation_id TEXT NOT NULL REFERENCES checkpoint_revert_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  recovery_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('blocked','released'))
);
CREATE TABLE IF NOT EXISTS checkpoint_revert_evidence (
  evidence_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES checkpoint_revert_operations(operation_id),
  session_id TEXT NOT NULL REFERENCES sessions(id), actor_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_by TEXT
);
CREATE TABLE IF NOT EXISTS checkpoint_revert_view_boundaries (
  operation_id TEXT PRIMARY KEY REFERENCES checkpoint_revert_operations(operation_id), session_id TEXT NOT NULL REFERENCES sessions(id),
  old_epoch TEXT NOT NULL, new_epoch TEXT NOT NULL, target_checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id),
  safety_checkpoint_id TEXT NOT NULL REFERENCES checkpoint_captures(checkpoint_id), source_sequence INTEGER NOT NULL,
  native_binding TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
export function applyRevertSchema(db: Database.Database): void {
  const names = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{name:string}>).map((row) => row.name);
  if (!["revision", "active_turn_id", "recovery_state", "recovery_revision"].every((name) => names.includes(name))) throw new Error("REVERT_REQUIRES_COMMAND_AND_RECOVERY_SCHEMA");
  db.exec(REVERT_SCHEMA_SQL);validateRevertSchema(db);
}

export const REVERT_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  checkpoint_revert_operations: ["operation_id","session_id","actor_id","command_id","plan_id","revision","stage","status","operation_json","created_at","updated_at"],
  checkpoint_revert_steps: ["operation_id","step_id","ordinal","kind","state","step_json"],
  checkpoint_revert_step_attempts: ["attempt_id","operation_id","step_id","state","attempt_json"],
  checkpoint_revert_gates: ["session_id","operation_id","recovery_revision","state"],
  checkpoint_revert_evidence: ["evidence_id","operation_id","session_id","actor_id","evidence_json","expires_at","consumed_by"],
  checkpoint_revert_view_boundaries: ["operation_id","session_id","old_epoch","new_epoch","target_checkpoint_id","safety_checkpoint_id","source_sequence","native_binding","created_at"],
};
export function validateRevertSchema(db: Database.Database): void {
  for (const [table, expected] of Object.entries(REVERT_REQUIRED_COLUMNS)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((row)=>row.name);
    if (expected.some((name)=>!columns.includes(name))) throw new Error(`SCHEMA_INVALID: migration009 ${table}`);
  }
  validateTableContracts(db, {
    checkpoint_revert_operations: { columns: REVERT_REQUIRED_COLUMNS.checkpoint_revert_operations!, primaryKey: ["operation_id"], unique: [["actor_id","command_id"]], constraints: ["CHECK(stage IN ('validated','safety_captured','workspace_restored','provider_rewound','projection_committed','partial_failure'))", "CHECK(status IN ('queued','running','blocked','completed','rolled_back'))"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["plan_id"], parent: "checkpoint_preview_plans", target: ["plan_id"] }, { columns: ["actor_id","command_id"], parent: "command_receipts", target: ["auth_subject_id","command_id"] }] },
    checkpoint_revert_steps: { columns: REVERT_REQUIRED_COLUMNS.checkpoint_revert_steps!, primaryKey: ["operation_id","step_id"], unique: [["operation_id","ordinal"]], foreignKeys: [{ columns: ["operation_id"], parent: "checkpoint_revert_operations", target: ["operation_id"] }] },
    checkpoint_revert_step_attempts: { columns: REVERT_REQUIRED_COLUMNS.checkpoint_revert_step_attempts!, primaryKey: ["attempt_id"], constraints: ["CHECK(state IN ('dispatching','applied','outcome_unknown'))"], foreignKeys: [{ columns: ["operation_id","step_id"], parent: "checkpoint_revert_steps", target: ["operation_id","step_id"] }] },
    checkpoint_revert_gates: { columns: REVERT_REQUIRED_COLUMNS.checkpoint_revert_gates!, primaryKey: ["session_id"], constraints: ["CHECK(state IN ('blocked','released'))", "REFERENCES checkpoint_revert_operations(operation_id) DEFERRABLE INITIALLY DEFERRED"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["operation_id"], parent: "checkpoint_revert_operations", target: ["operation_id"] }] },
    checkpoint_revert_evidence: { columns: REVERT_REQUIRED_COLUMNS.checkpoint_revert_evidence!, primaryKey: ["evidence_id"], nullable: ["consumed_by"], foreignKeys: [{ columns: ["operation_id"], parent: "checkpoint_revert_operations", target: ["operation_id"] }, { columns: ["session_id"], parent: "sessions", target: ["id"] }] },
    checkpoint_revert_view_boundaries: { columns: REVERT_REQUIRED_COLUMNS.checkpoint_revert_view_boundaries!, primaryKey: ["operation_id"], foreignKeys: [{ columns: ["operation_id"], parent: "checkpoint_revert_operations", target: ["operation_id"] }, { columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["target_checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }, { columns: ["safety_checkpoint_id"], parent: "checkpoint_captures", target: ["checkpoint_id"] }] },
  });
}
