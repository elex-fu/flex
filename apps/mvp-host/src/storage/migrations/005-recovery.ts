import type Database from "better-sqlite3";

export const RECOVERY_SCHEMA_VERSION = 5;
export const RECOVERY_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  sessions: ["active_turn_id", "recovery_state", "recovery_revision"],
  native_turn_bindings: ["id", "session_id", "turn_id", "attempt_id", "provider", "provider_instance_id", "native_session_id", "native_turn_id", "workspace_path", "configuration_fingerprint", "verified_version", "context_json", "revision", "updated_at"],
  recovery_evidence: ["id", "session_id", "turn_id", "attempt_id", "recovery_revision", "facts_fingerprint", "evidence_json", "observed_at", "expires_at"],
  recovery_operations: ["id", "session_id", "turn_id", "attempt_id", "auth_subject_id", "command_id", "action", "request_hash", "evidence_id", "phase", "result_json", "completed_revision", "created_at", "updated_at"],
};
export function validateRecoverySchema(db: Database.Database): void {
  for (const [table, expected] of Object.entries(RECOVERY_REQUIRED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (expected.some((name) => !columns.some((column) => column.name === name))) throw new Error(`SCHEMA_INVALID: migration 005 table ${table}`);
  }
}

/** Active relation consumers must be upgraded in the same release before relaxing the index. */
export function applyRecoveryMigration(db: Database.Database, appliedAt = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get()) { validateRecoverySchema(db); return; }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get()) throw new Error("RECOVERY_MIGRATION_REQUIRES_004");
    db.exec(`
      ALTER TABLE sessions ADD COLUMN active_turn_id TEXT REFERENCES turns(id);
      ALTER TABLE sessions ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'idle' CHECK (recovery_state IN ('idle','blocked'));
      ALTER TABLE sessions ADD COLUMN recovery_revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE native_turn_bindings (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), provider_instance_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL, native_turn_id TEXT, workspace_path TEXT NOT NULL,
        configuration_fingerprint TEXT NOT NULL, verified_version TEXT NOT NULL, context_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(turn_id,attempt_id)
      );
      CREATE TABLE recovery_evidence (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT, recovery_revision INTEGER NOT NULL, facts_fingerprint TEXT NOT NULL, evidence_json TEXT NOT NULL,
        observed_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX recovery_evidence_target ON recovery_evidence(session_id,turn_id,observed_at);
      CREATE TABLE recovery_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT, auth_subject_id TEXT NOT NULL, command_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('reconcile','acknowledge')), request_hash TEXT NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES recovery_evidence(id),
        phase TEXT NOT NULL CHECK(phase IN ('marked','checking','completed','blocked','failed')),
        result_json TEXT, completed_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(auth_subject_id,command_id),
        FOREIGN KEY(auth_subject_id,command_id) REFERENCES command_receipts(auth_subject_id,command_id)
      );
      CREATE INDEX recovery_operations_target ON recovery_operations(session_id,turn_id,phase);
    `);
    const sessions = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
    for (const session of sessions) {
      const candidates = db.prepare("SELECT id FROM turns WHERE session_id = ? AND status IN ('queued','running','waiting_approval','interrupting','outcome_unknown')")
        .all(session.id) as Array<{ id: string }>;
      if (candidates.length > 1) throw new Error("LEGACY_ACTIVE_TURN_AMBIGUOUS");
      if (candidates[0]) db.prepare("UPDATE sessions SET active_turn_id = ?, recovery_state = 'blocked', recovery_revision = 1 WHERE id = ?")
        .run(candidates[0].id, session.id);
    }
    db.exec(`DROP INDEX IF EXISTS one_active_turn_per_session;
      CREATE UNIQUE INDEX one_active_turn_per_session ON turns(session_id)
      WHERE status IN ('queued','running','waiting_approval','interrupting');`);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(5,?)").run(appliedAt);
    validateRecoverySchema(db);
  })();
}
