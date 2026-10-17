import type Database from "better-sqlite3";
import { validateCommandExecutionSchema } from "./004-command-execution.js";
import { validateRecoverySchema } from "./005-recovery.js";
import { validateViewsSchema } from "./006-views-schema.js";
import { validateCatalogSchema } from "./007-catalog.js";
import { validateInteractionSchema } from "./008-interactions.js";
import { validateWorkspaceHistorySchema } from "./009-workspace-history.js";
import { validateAttentionSchema } from "./010-attention.js";
import { validateExecutionActivationSchema } from "./011-execution-activation.js";

export const SUPPORTED_SCHEMA_VERSION = 11;

export class StoreSchemaError extends Error {
  constructor(readonly code: "FUTURE_SCHEMA" | "SCHEMA_INVALID", message: string) {
    super(message);
    this.name = "StoreSchemaError";
  }
}

export type SchemaInspection = { version: number; empty: boolean; legacy: boolean };
type Column = { name: string; pk: number; notnull: number };

export function requiredColumns(db: Database.Database, table: string, names: readonly string[]): Column[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Invalid migration table name");
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Column[];
  for (const name of names) {
    if (!columns.some((column) => column.name === name)) throw new StoreSchemaError("SCHEMA_INVALID", `Declared schema is missing ${table}.${name}; restore or repair it under offline maintenance.`);
  }
  return columns;
}

const V3_COLUMNS: Record<string, readonly string[]> = {
  schema_migrations: ["version", "applied_at"],
  host_state: ["key", "value_json", "updated_at"],
  auth_sessions: ["id", "token_hash", "created_at", "expires_at", "last_seen_at", "revoked_at", "device_id"],
  pairing_grants: ["id", "token_hash", "created_at", "expires_at", "confirmed_at", "consumed_at", "host_id", "requested_scopes", "approved_at", "device_id"],
  devices: ["id", "host_id", "display_name", "platform", "credential_kind", "public_key", "credential_hash", "credential_revision", "scopes_json", "created_at", "last_seen_at", "expires_at", "revoked_at"],
  protocol_sessions: ["id", "device_id", "protocol_version", "transport_kind", "transport_generation", "capability_json", "connected_at", "expires_at", "auth_session_id", "disconnected_at", "close_code"],
  access_audit_events: ["id", "device_id", "action", "target_type", "target_id", "transport_kind", "occurred_at", "result_code"],
  sessions: ["id", "workspace_id", "workspace_path", "provider", "provider_session_id", "baseline_head", "baseline_dirty", "baseline_status_json", "baseline_captured_at", "status", "activity_state", "head_sequence", "created_at", "updated_at"],
  turns: ["id", "session_id", "auth_subject_id", "command_id", "request_hash", "status", "prompt", "provider_session_id", "generation", "started_at", "finished_at", "created_at"],
  session_events: ["id", "session_id", "sequence", "type", "payload_json", "occurred_at"],
  timeline_items: ["session_id", "item_id", "kind", "status", "revision", "content_json", "updated_at"],
  approvals: ["approval_id", "session_id", "turn_id", "tool_use_id", "version", "status", "action", "request_json", "created_at", "resolved_at"],
  command_receipts: ["auth_subject_id", "command_id", "method", "request_hash", "state", "response_json", "created_at", "updated_at"],
};

function requirePrimaryKey(db: Database.Database, table: string, names: readonly string[]): void {
  const columns = requiredColumns(db, table, names).filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  if (columns.map((column) => column.name).join(",") !== names.join(",")) throw new StoreSchemaError("SCHEMA_INVALID", `Declared schema has an invalid ${table} primary key.`);
}

function requireUniqueIndex(db: Database.Database, table: string, names: readonly string[], partial: boolean): void {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; partial: number }>;
  const matches = indexes.some((index) => {
    if (!index.unique || Boolean(index.partial) !== partial) return false;
    const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as Array<{ name: string }>;
    return columns.map((column) => column.name).join(",") === names.join(",");
  });
  if (!matches) throw new StoreSchemaError("SCHEMA_INVALID", `Declared schema has no expected unique index for ${table}.`);
}

function requireConstraintSql(db: Database.Database, type: "table" | "index", name: string, fragment: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as { sql: string | null } | undefined;
  const normalize = (sql: string) => sql.toLowerCase().replace(/[\s"`\[\]]/g, "").replace(/;+$/, "");
  const actual = row?.sql ? normalize(row.sql) : "";
  const matches = type === "index" ? actual.slice(actual.indexOf("where")) === normalize(fragment) : actual.includes(normalize(fragment));
  if (!row?.sql || !matches) {
    throw new StoreSchemaError("SCHEMA_INVALID", `Declared schema has an invalid ${name} constraint.`);
  }
}

/** Validate facts claimed by a v3 marker; never repair a corrupt declared schema. */
export function validateV3Schema(db: Database.Database): void {
  for (const [table, names] of Object.entries(V3_COLUMNS)) requiredColumns(db, table, names);
  for (const [table, keys] of [["sessions", ["id"]], ["turns", ["id"]], ["timeline_items", ["session_id", "item_id"]],
    ["command_receipts", ["auth_subject_id", "command_id"]]] as const) requirePrimaryKey(db, table, keys);
  requireUniqueIndex(db, "session_events", ["session_id", "sequence"], false);
  requireUniqueIndex(db, "turns", ["session_id"], true);
  requireUniqueIndex(db, "approvals", ["turn_id", "tool_use_id"], true);
  const recoveryInstalled = Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get());
  requireConstraintSql(db, "index", "one_active_turn_per_session", recoveryInstalled
    ? "WHERE status IN ('queued', 'running', 'waiting_approval', 'interrupting')"
    : "WHERE status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'outcome_unknown')");
  requireConstraintSql(db, "index", "one_pending_approval_per_tool", "WHERE status = 'pending'");
  requireConstraintSql(db, "table", "sessions", "CHECK (status IN ('active', 'archived'))");
  requireConstraintSql(db, "table", "turns", "CHECK (status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'completed', 'failed', 'cancelled', 'outcome_unknown'))");
  requireConstraintSql(db, "table", "devices", "CHECK (credential_kind IN ('noise-static-key', 'browser-session'))");
  for (const [table, names] of Object.entries({
    sessions: ["workspace_id", "workspace_path", "provider", "status", "activity_state", "head_sequence", "created_at", "updated_at"],
    turns: ["session_id", "auth_subject_id", "command_id", "request_hash", "status", "prompt", "generation", "created_at"],
    command_receipts: ["auth_subject_id", "command_id", "method", "request_hash", "state", "response_json", "created_at", "updated_at"],
  })) {
    const columns = requiredColumns(db, table, names);
    if (names.some((name) => !columns.find((column) => column.name === name)?.notnull)) {
      throw new StoreSchemaError("SCHEMA_INVALID", `Declared schema has a nullable required ${table} column.`);
    }
  }
  const references = db.prepare("PRAGMA foreign_key_list(turns)").all() as Array<{ table: string; from: string; to: string }>;
  if (!references.some((reference) => reference.table === "sessions" && reference.from === "session_id" && reference.to === "id")) {
    throw new StoreSchemaError("SCHEMA_INVALID", "Declared schema is missing the Turn Session constraint.");
  }
}

/** Read this before any CREATE/ALTER or writable connection pragma. */
export function inspectSchema(db: Database.Database, options: { maximumVersion?: number; validateCurrent?: boolean } = {}): SchemaInspection {
  const maximumVersion = options.maximumVersion ?? SUPPORTED_SCHEMA_VERSION;
  const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; type: string }>;
  const migrationTable = tables.find((table) => table.name === "schema_migrations");
  const userVersion = Number(db.pragma("user_version", { simple: true }));
  if (userVersion > maximumVersion) throw new StoreSchemaError("FUTURE_SCHEMA", `Database schema ${userVersion} is newer than supported schema ${maximumVersion}; no changes were made.`);
  if (!migrationTable) return { version: 0, empty: tables.length === 0, legacy: tables.length > 0 };
  if (migrationTable.type !== "table") throw new StoreSchemaError("SCHEMA_INVALID", "Schema migration history is not a table.");
  requiredColumns(db, "schema_migrations", ["version", "applied_at"]);
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown }>;
  if (rows.some((row) => typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version <= 0)) {
    throw new StoreSchemaError("SCHEMA_INVALID", "Schema migration history contains an invalid version.");
  }
  const version = rows.length ? Number(rows.at(-1)!.version) : 0;
  if (version > maximumVersion) throw new StoreSchemaError("FUTURE_SCHEMA", `Database schema ${version} is newer than supported schema ${maximumVersion}; no changes were made.`);
  if (options.validateCurrent !== false) {
    if (version >= 3) validateV3Schema(db);
    if (version >= 4) {
      try { validateCommandExecutionSchema(db); }
      catch { throw new StoreSchemaError("SCHEMA_INVALID", "Declared command execution schema is incomplete; offline repair is required."); }
    }
    for (const [migration, validate] of [[5, validateRecoverySchema], [6, validateViewsSchema],
      [7, validateCatalogSchema], [8, validateInteractionSchema], [9, validateWorkspaceHistorySchema], [10, validateAttentionSchema],
      [11, validateExecutionActivationSchema]] as const) {
      if (version < migration) continue;
      if (!rows.some((row) => row.version === migration) || !rows.some((row) => row.version === migration - 1)) {
        throw new StoreSchemaError("SCHEMA_INVALID", `Declared schema is missing ordered migration ${migration}.`);
      }
      try { validate(db); }
      catch { throw new StoreSchemaError("SCHEMA_INVALID", `Declared migration ${migration} schema is incomplete; offline repair is required.`); }
    }
  }
  return { version, empty: tables.length === 0, legacy: version < 3 };
}
