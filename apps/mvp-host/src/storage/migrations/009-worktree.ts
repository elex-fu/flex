import type Database from "better-sqlite3";
import { validateTableContracts, validateUniqueIndex } from "./schema-constraints.js";

/** Combined with Checkpoint/Revert 009 on the owned shared SQLite connection. */
export const WORKTREE_SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS managed_worktrees (worktree_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, workspace_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('creating','active','archiving','archived','restoring','blocked')), revision INTEGER NOT NULL CHECK (revision >= 0), record_json TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS worktree_operations (operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, command_id TEXT NOT NULL, worktree_id TEXT NOT NULL REFERENCES managed_worktrees(worktree_id), kind TEXT NOT NULL CHECK (kind IN ('create','archive','restore')), state TEXT NOT NULL CHECK (state IN ('pending','running','completed','failed','outcome_unknown')), stage TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, facts_json TEXT NOT NULL DEFAULT '{}', error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(actor_id, command_id));",
  "CREATE UNIQUE INDEX IF NOT EXISTS worktree_one_operation ON worktree_operations(worktree_id) WHERE state IN ('pending','running','outcome_unknown');",
  "CREATE TABLE IF NOT EXISTS worktree_steps (operation_id TEXT NOT NULL REFERENCES worktree_operations(operation_id), ordinal INTEGER NOT NULL, boundary TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatched','applied')), planned_json TEXT NOT NULL, result_json TEXT, PRIMARY KEY(operation_id,boundary), UNIQUE(operation_id,ordinal));",
  "CREATE TABLE IF NOT EXISTS worktree_snapshots (snapshot_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES managed_worktrees(worktree_id), snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS worktree_snapshot_pins (snapshot_id TEXT NOT NULL REFERENCES worktree_snapshots(snapshot_id), owner_kind TEXT NOT NULL CHECK(owner_kind IN ('operation','history','recovery')), owner_id TEXT NOT NULL, PRIMARY KEY(snapshot_id,owner_kind,owner_id));",
  "CREATE TABLE IF NOT EXISTS worktree_inspections (evidence_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES worktree_operations(operation_id), evidence_json TEXT NOT NULL, observations_digest TEXT NOT NULL, expires_at TEXT NOT NULL);",
].join("\n");

export function validateWorktreeSchema(db: Database.Database): void {
  validateTableContracts(db, {
    managed_worktrees: { columns: ["worktree_id","repository_id","workspace_id","state","revision","record_json"], primaryKey: ["worktree_id"], unique: [["workspace_id"]], constraints: ["CHECK(state IN ('creating','active','archiving','archived','restoring','blocked'))", "CHECK(revision >= 0)"] },
    worktree_operations: { columns: ["operation_id","actor_id","command_id","worktree_id","kind","state","stage","request_hash","request_json","facts_json","error_code","created_at","updated_at"], primaryKey: ["operation_id"], nullable: ["error_code"], unique: [["actor_id","command_id"]], constraints: ["CHECK(kind IN ('create','archive','restore'))", "CHECK(state IN ('pending','running','completed','failed','outcome_unknown'))"], foreignKeys: [{ columns: ["worktree_id"], parent: "managed_worktrees", target: ["worktree_id"] }] },
    worktree_steps: { columns: ["operation_id","ordinal","boundary","state","planned_json","result_json"], primaryKey: ["operation_id","boundary"], nullable: ["result_json"], unique: [["operation_id","ordinal"]], constraints: ["CHECK(state IN ('dispatched','applied'))"], foreignKeys: [{ columns: ["operation_id"], parent: "worktree_operations", target: ["operation_id"] }] },
    worktree_snapshots: { columns: ["snapshot_id","worktree_id","snapshot_json","created_at"], primaryKey: ["snapshot_id"], foreignKeys: [{ columns: ["worktree_id"], parent: "managed_worktrees", target: ["worktree_id"] }] },
    worktree_snapshot_pins: { columns: ["snapshot_id","owner_kind","owner_id"], primaryKey: ["snapshot_id","owner_kind","owner_id"], constraints: ["CHECK(owner_kind IN ('operation','history','recovery'))"], foreignKeys: [{ columns: ["snapshot_id"], parent: "worktree_snapshots", target: ["snapshot_id"] }] },
    worktree_inspections: { columns: ["evidence_id","operation_id","evidence_json","observations_digest","expires_at"], primaryKey: ["evidence_id"], foreignKeys: [{ columns: ["operation_id"], parent: "worktree_operations", target: ["operation_id"] }] },
  });
  validateUniqueIndex(db, "worktree_operations", ["worktree_id"], "WHERE state IN ('pending','running','outcome_unknown')", "worktree_one_operation");
}
