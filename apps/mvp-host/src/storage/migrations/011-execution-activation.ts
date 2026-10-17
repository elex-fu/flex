import type Database from "better-sqlite3";
import { validateTableContracts } from "./schema-constraints.js";

export const EXECUTION_ACTIVATION_SCHEMA_VERSION = 11;

/** Local management-operation receipt for activation and external restore checks. */
export const EXECUTION_ACTIVATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS host_execution_operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('activation','restore_check')),
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','checking','ready','completed','rejected','outcome_unknown')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  owner_context_json TEXT NOT NULL,
  resource_binding_json TEXT NOT NULL,
  evidence_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id, command_id)
);
`;

/**
 * Workspace/Provider verification records gain the activation reference and a
 * monotonic readiness revision. Old rows stay unverified: both references are
 * NULL and the revision starts at 0 until an explicit local activation.
 */
export const EXECUTION_ACTIVATION_COLUMNS = [
  ["activation_operation_id", "TEXT"],
  ["activation_binding_digest", "TEXT"],
  ["readiness_revision", "INTEGER NOT NULL DEFAULT 0"],
] as const;

const ACTIVATION_TABLES = ["workspaces", "provider_instances"] as const;

function addActivationColumns(db: Database.Database, table: (typeof ACTIVATION_TABLES)[number]): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  for (const [name, type] of EXECUTION_ACTIVATION_COLUMNS) {
    if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function validateExecutionActivationSchema(db: Database.Database): void {
  validateTableContracts(db, {
    host_execution_operations: { columns: ["id","actor_id","command_id","kind","request_hash","state","revision","owner_context_json","resource_binding_json","evidence_json","result_json","created_at","updated_at"], primaryKey: ["id"], nullable: ["evidence_json","result_json"], unique: [["actor_id","command_id"]], constraints: ["CHECK(kind IN ('activation','restore_check'))", "CHECK(state IN ('accepted','checking','ready','completed','rejected','outcome_unknown'))", "CHECK(revision >= 0)"] },
    workspaces: { columns: ["activation_operation_id","activation_binding_digest","readiness_revision"], primaryKey: ["id"], nullable: ["activation_operation_id","activation_binding_digest"] },
    provider_instances: { columns: ["activation_operation_id","activation_binding_digest","readiness_revision"], primaryKey: ["id"], nullable: ["activation_operation_id","activation_binding_digest"] },
  });
  for (const table of ACTIVATION_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    if (!columns.find((column) => column.name === "readiness_revision")?.notnull) throw new Error(`SCHEMA_INVALID: execution activation ${table} revision`);
    const invalid = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE readiness_revision IS NULL OR readiness_revision < 0`).get() as { n: number };
    if (invalid.n > 0) throw new Error(`SCHEMA_INVALID: execution activation ${table} revision value`);
  }
}

/** Metadata only; activation state is written by HostActivationService under the maintenance owner. */
export function applyExecutionActivationMigration(db: Database.Database, at = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=11").get()) { validateExecutionActivationSchema(db); return; }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=10").get()) throw new Error("EXECUTION_ACTIVATION_MIGRATION_REQUIRES_010");
    db.exec(EXECUTION_ACTIVATION_SCHEMA_SQL);
    for (const table of ACTIVATION_TABLES) addActivationColumns(db, table);
    validateExecutionActivationSchema(db);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(11,?)").run(at);
  })();
}
