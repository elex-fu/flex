import type Database from "better-sqlite3";
import { validateTableContracts, validateUniqueIndex } from "./schema-constraints.js";

export const ATTENTION_SCHEMA_VERSION = 10;
export const ATTENTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS attention_facts (
ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL,
session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT REFERENCES turns(id), interaction_id TEXT,
version INTEGER NOT NULL CHECK(version>=0), kind TEXT NOT NULL CHECK(kind IN ('question','approval','completion','recovery_blocked')),
source_event_id TEXT NOT NULL REFERENCES session_events(id), source_commit_id TEXT NOT NULL REFERENCES event_commits(id),
source_sequence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS attention_completed_source ON session_events(session_id,json_extract(payload_json,'$.turnId'),sequence) WHERE type='turn.completed' OR (type='turn.reconciled' AND json_extract(payload_json,'$.outcome.status')='completed');
CREATE INDEX IF NOT EXISTS attention_source_commit ON attention_facts(source_commit_id);
CREATE INDEX IF NOT EXISTS attention_interaction ON attention_facts(interaction_id,superseded_at);
CREATE INDEX IF NOT EXISTS attention_turn ON attention_facts(turn_id,kind,superseded_at);
CREATE INDEX IF NOT EXISTS attention_session_ordinal ON attention_facts(session_id,ordinal);
CREATE TABLE IF NOT EXISTS attention_acknowledgements (
attention_id TEXT NOT NULL REFERENCES attention_facts(id) ON DELETE CASCADE,
device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
version INTEGER NOT NULL, acknowledged_at TEXT NOT NULL, PRIMARY KEY(attention_id,device_id)
);
CREATE TABLE IF NOT EXISTS attention_preferences (
device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
mode TEXT NOT NULL CHECK(mode IN ('all','interactions','none')), push_enabled INTEGER NOT NULL CHECK(push_enabled IN (0,1)),
revision INTEGER NOT NULL CHECK(revision>=0)
);
CREATE TABLE IF NOT EXISTS attention_push_subscriptions (
id TEXT PRIMARY KEY, host_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
platform TEXT NOT NULL CHECK(platform='expo'), token TEXT NOT NULL, token_hash TEXT NOT NULL, project_id TEXT NOT NULL,
created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, UNIQUE(host_id,device_id,token_hash,project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS attention_one_active_push ON attention_push_subscriptions(host_id,device_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS attention_deliveries (
id TEXT PRIMARY KEY, attention_id TEXT NOT NULL REFERENCES attention_facts(id) ON DELETE CASCADE,
device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, surface TEXT NOT NULL CHECK(surface IN ('in_app','push')),
state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','provider_delivered','presented','unavailable','outcome_unknown','cancelled','expired')),
attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, provider_receipt_id TEXT, result_code TEXT,
created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(attention_id,device_id)
);
CREATE INDEX IF NOT EXISTS attention_ready_deliveries ON attention_deliveries(state,next_attempt_at,created_at,id);
CREATE TABLE IF NOT EXISTS attention_runtime_state (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
`;
/** Called by the owned migration runner; constructors perform no DDL. */
export function applyAttentionSchema(db: Database.Database): void { db.exec(ATTENTION_SCHEMA_SQL); }

export function validateAttentionSchema(db: Database.Database): void {
  validateTableContracts(db, {
    attention_facts: { columns: ["ordinal","id","host_id","session_id","turn_id","interaction_id","version","kind","source_event_id","source_commit_id","source_sequence","created_at","expires_at","superseded_at"], primaryKey: ["ordinal"], nullable: ["turn_id","interaction_id","superseded_at"], unique: [["id"]], constraints: ["INTEGER PRIMARY KEY AUTOINCREMENT", "CHECK(version>=0)", "CHECK(kind IN ('question','approval','completion','recovery_blocked'))"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["turn_id"], parent: "turns", target: ["id"] }, { columns: ["source_event_id"], parent: "session_events", target: ["id"] }, { columns: ["source_commit_id"], parent: "event_commits", target: ["id"] }] },
    attention_acknowledgements: { columns: ["attention_id","device_id","version","acknowledged_at"], primaryKey: ["attention_id","device_id"], foreignKeys: [{ columns: ["attention_id"], parent: "attention_facts", target: ["id"], onDelete: "CASCADE" }, { columns: ["device_id"], parent: "devices", target: ["id"], onDelete: "CASCADE" }] },
    attention_preferences: { columns: ["device_id","mode","push_enabled","revision"], primaryKey: ["device_id"], constraints: ["CHECK(mode IN ('all','interactions','none'))", "CHECK(push_enabled IN (0,1))", "CHECK(revision>=0)"], foreignKeys: [{ columns: ["device_id"], parent: "devices", target: ["id"], onDelete: "CASCADE" }] },
    attention_push_subscriptions: { columns: ["id","host_id","device_id","platform","token","token_hash","project_id","created_at","expires_at","revoked_at"], primaryKey: ["id"], nullable: ["revoked_at"], unique: [["host_id","device_id","token_hash","project_id"]], constraints: ["CHECK(platform='expo')"], foreignKeys: [{ columns: ["device_id"], parent: "devices", target: ["id"], onDelete: "CASCADE" }] },
    attention_deliveries: { columns: ["id","attention_id","device_id","surface","state","attempts","next_attempt_at","provider_receipt_id","result_code","created_at","updated_at"], primaryKey: ["id"], nullable: ["provider_receipt_id","result_code"], unique: [["attention_id","device_id"]], constraints: ["CHECK(surface IN ('in_app','push'))", "CHECK(state IN ('pending','dispatching','accepted','provider_delivered','presented','unavailable','outcome_unknown','cancelled','expired'))"], foreignKeys: [{ columns: ["attention_id"], parent: "attention_facts", target: ["id"], onDelete: "CASCADE" }, { columns: ["device_id"], parent: "devices", target: ["id"], onDelete: "CASCADE" }] },
    attention_runtime_state: { columns: ["key","value","updated_at"], primaryKey: ["key"] },
  });
  validateUniqueIndex(db, "attention_push_subscriptions", ["host_id","device_id"], "WHERE revoked_at IS NULL", "attention_one_active_push");
}

/** Metadata only; the post-commit delivery worker is created by the Host factory. */
export function applyAttentionMigration(db: Database.Database, at = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=10").get()) { validateAttentionSchema(db); return; }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get()) throw new Error("ATTENTION_MIGRATION_REQUIRES_009");
    applyAttentionSchema(db);
    validateAttentionSchema(db);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(10,?)").run(at);
  })();
}
