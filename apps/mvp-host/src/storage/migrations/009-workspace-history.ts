import type Database from "better-sqlite3";
import { applyCheckpointSchema, applyRevertSchema, validateCheckpointSchema, validateRevertSchema } from "./009-checkpoints.js";
import { WORKTREE_SCHEMA_SQL, validateWorktreeSchema } from "./009-worktree.js";

export const WORKSPACE_HISTORY_SCHEMA_VERSION = 9;
export function validateWorkspaceHistorySchema(db: Database.Database): void {
  validateCheckpointSchema(db);
  validateRevertSchema(db);
  validateWorktreeSchema(db);
}

/** Shared metadata transaction only; Git and Native work starts after admission. */
export function applyWorkspaceHistoryMigration(db: Database.Database, at = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get()) { validateWorkspaceHistorySchema(db); return; }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get()) throw new Error("WORKSPACE_HISTORY_MIGRATION_REQUIRES_008");
    applyCheckpointSchema(db);
    applyRevertSchema(db);
    db.exec(WORKTREE_SCHEMA_SQL);
    validateWorkspaceHistorySchema(db);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(9,?)").run(at);
  })();
}
