import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_V6_SCHEMA } from "../../test-support/frozen-v6-schema.js";
import { SqliteStore } from "../db.js";
import { applyCatalogMigration, legacyWorkspaceId } from "./007-catalog.js";
import { applyInteractionMigration } from "./008-interactions.js";
import { applyWorkspaceHistoryMigration } from "./009-workspace-history.js";
import { applyAttentionMigration } from "./010-attention.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "./schema-version.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(): string {
  const root = mkdtempSync(join(tmpdir(), "flyx-late-migrations-")); roots.push(root);
  return join(root, "host.sqlite");
}
const timestamp = "2026-10-14T00:00:00.000Z";
function seedV6(path: string, malformed = false): void {
  const db = new Database(path);
  try {
    db.exec(FROZEN_V6_SCHEMA);
    db.prepare(`INSERT INTO sessions(id,workspace_id,workspace_path,provider,provider_session_id,baseline_head,
      baseline_dirty,baseline_status_json,baseline_captured_at,status,activity_state,head_sequence,created_at,updated_at)
      VALUES('legacy','default','/offline/unverified-checkout','codex','native-legacy',?,1,'[]',?,'active','idle',0,?,?)`)
      .run("a".repeat(40), timestamp, timestamp, timestamp);
    db.prepare(`INSERT INTO turns(id,session_id,auth_subject_id,command_id,request_hash,status,prompt,generation,created_at)
      VALUES('old-turn','legacy','actor','old-command','digest','completed','old task',1,?)`).run(timestamp);
    db.prepare(`INSERT INTO approvals(approval_id,session_id,turn_id,tool_use_id,version,status,action,request_json,created_at,resolved_at)
      VALUES('old-approval','legacy','old-turn','tool',3,'resolved','allow_once',?,?,?)`)
      .run(malformed ? "{" : JSON.stringify({ toolName: "Bash", title: "Old approval", secret: "must not be projected" }), timestamp, timestamp);
    expect(inspectSchema(db).version).toBe(6);
  } finally { db.close(); }
}

describe("ordered Catalog, Interaction, workspace history and attention migration", () => {
  it("upgrades a pinned v6 file without verifying legacy paths or inventing Native evidence", () => {
    const path = file(); seedV6(path);
    const store = new SqliteStore(path, { mode: "owned" });
    try {
      expect(inspectSchema(store.db).version).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
        Array.from({ length: SUPPORTED_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
      expect(store.getSession("legacy")).toMatchObject({ workspaceId: legacyWorkspaceId("/offline/unverified-checkout"), providerSessionId: "native-legacy" });
      expect(store.db.prepare("SELECT state FROM workspaces").get()).toEqual({ state: "needs_verification" });
      expect(store.db.prepare("SELECT state FROM provider_instances").get()).toEqual({ state: "unconfigured" });
      expect(store.db.prepare("SELECT status,evidence_kind,delivery_state,version FROM interactions").get()).toEqual({ status: "delivered", evidence_kind: "legacy", delivery_state: "legacy", version: 3 });
      expect(store.db.prepare("SELECT request_json FROM interactions").get()).toEqual({ request_json: JSON.stringify({ toolName: "Bash", title: "Old approval" }) });
      expect(store.db.prepare("SELECT kind FROM interaction_delivery_evidence").all()).toEqual([{ kind: "legacy" }]);
      expect(store.db.prepare("SELECT status FROM checkpoint_captures").get()).toEqual({ status: "legacy_inexact" });
      expect(store.db.prepare("SELECT * FROM attention_facts").all()).toEqual([]);
      expect(store.db.prepare("SELECT * FROM execution_intents").all()).toEqual([]);
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(existsSync("/offline/unverified-checkout")).toBe(false);
      const schema = store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      const events = store.listEvents("legacy", 0);
      store.close();
      const reopened = new SqliteStore(path, { mode: "owned" });
      try {
        expect(reopened.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        expect(reopened.listEvents("legacy", 0)).toEqual(events);
        expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM checkpoint_captures").get()).toEqual({ n: 1 });
      } finally { reopened.close(); }
    } finally { store.close(); }
  });

  it("rolls back the entire upgrade when old Interaction evidence cannot be decoded", () => {
    const path = file(); seedV6(path, true);
    expect(() => new SqliteStore(path, { mode: "owned" })).toThrow();
    const db = new Database(path, { readonly: true });
    try {
      expect(inspectSchema(db).version).toBe(6);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('workspaces','interactions','checkpoint_captures','attention_facts')").all()).toEqual([]);
      expect(db.prepare("SELECT workspace_id,provider_session_id FROM sessions").get()).toEqual({ workspace_id: "default", provider_session_id: "native-legacy" });
      expect(db.prepare("SELECT request_json FROM approvals").get()).toEqual({ request_json: "{" });
    } finally { db.close(); }
  });

  it("requires each preceding migration before installing later tables", () => {
    const db = new Database(":memory:");
    try {
      db.exec(FROZEN_V6_SCHEMA);
      expect(() => applyInteractionMigration(db)).toThrow("INTERACTION_MIGRATION_REQUIRES_007");
      expect(() => applyWorkspaceHistoryMigration(db)).toThrow("WORKSPACE_HISTORY_MIGRATION_REQUIRES_008");
      expect(() => applyAttentionMigration(db)).toThrow("ATTENTION_MIGRATION_REQUIRES_009");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('interactions','checkpoint_captures','attention_facts')").all()).toEqual([]);
      applyCatalogMigration(db); applyInteractionMigration(db); applyWorkspaceHistoryMigration(db); applyAttentionMigration(db);
      expect(inspectSchema(db).version).toBe(10);
    } finally { db.close(); }
  });

  it.each([
    [7, "DROP TABLE catalog_import_manifests", "catalog_import_manifests", "source_digest TEXT NOT NULL UNIQUE", "source_digest TEXT UNIQUE"],
    [8, "DROP TABLE interaction_reservations", "interaction_reservations", "ON UPDATE CASCADE", "ON UPDATE RESTRICT"],
    [9, "DROP TABLE managed_worktrees", "managed_worktrees", "CHECK (revision >= 0)", "CHECK (revision >= -1)"],
    [10, "DROP TABLE attention_preferences", "attention_preferences", "CHECK(push_enabled IN (0,1))", "CHECK(push_enabled IN (0,1,2))"],
  ])("rejects corrupted declared migration %i constraints before making any changes", (version, drop, table, from, to) => {
    const path = file(); const store = new SqliteStore(path, { mode: "owned" }); store.close();
    const db = new Database(path);
    try {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(table) as { sql: string };
      expect(row.sql).toContain(from);
      db.exec(drop); db.exec(row.sql.replace(from, to));
    } finally { db.close(); }
    const before = readFileSync(path);
    expect(() => new SqliteStore(path, { mode: "owned" })).toThrow(`Declared migration ${version} schema is incomplete`);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([
    [9, "checkpoint_attempt_phase", "CREATE UNIQUE INDEX checkpoint_attempt_phase ON checkpoint_captures(session_id,turn_id,attempt_id,phase) WHERE turn_id IS NOT NULL AND attempt_id IS NOT NULL AND phase IN ('before')"],
    [9, "worktree_one_operation", "CREATE UNIQUE INDEX worktree_one_operation ON worktree_operations(worktree_id) WHERE state IN ('pending','running')"],
    [10, "attention_one_active_push", "CREATE UNIQUE INDEX attention_one_active_push ON attention_push_subscriptions(host_id,device_id) WHERE revoked_at IS NOT NULL"],
  ])("rejects altered admission predicates in migration %i", (version, name, sql) => {
    const path = file(); const store = new SqliteStore(path, { mode: "owned" }); store.close();
    const db = new Database(path); db.exec(`DROP INDEX ${name}`); db.exec(sql); db.close();
    const before = readFileSync(path);
    expect(() => new SqliteStore(path, { mode: "owned" })).toThrow(`Declared migration ${version} schema is incomplete`);
    expect(readFileSync(path)).toEqual(before);
  });
});
