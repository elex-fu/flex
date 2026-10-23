import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_V10_SCHEMA } from "../../test-support/frozen-v10-schema.js";
import { SqliteStore } from "../db.js";
import { applyExecutionActivationMigration } from "./011-execution-activation.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "./schema-version.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flyx-activation-migration-")); roots.push(root);
  const data = join(root, "data"); mkdirSync(data, { mode: 0o700 });
  return join(data, "host.sqlite");
}
const timestamp = "2026-10-18T00:00:00.000Z";

function seedV10(path: string): void {
  const db = new Database(path);
  try {
    db.exec(FROZEN_V10_SCHEMA);
    db.prepare(`INSERT INTO workspaces(id,canonical_root,worktree_root,checkout_key,kind,state,repository_id,capabilities_json,registration_operation_id,created_at,updated_at)
      VALUES('legacy-workspace','/offline/legacy-checkout','/offline/legacy-checkout',?,'local','needs_verification','legacy-repo','[]',NULL,?,?)`)
      .run("b".repeat(64), timestamp, timestamp);
    db.prepare(`INSERT INTO provider_instances(id,provider,executable,config_json,policy_version,state,verification_json,policy_capabilities_json,created_at,updated_at)
      VALUES('legacy-provider','codex','','{}',1,'unconfigured','{"state":"unverified","capabilities":[]}','[]',?,?)`)
      .run(timestamp, timestamp);
    expect(inspectSchema(db).version).toBe(10);
  } finally { db.close(); }
}

describe("execution activation migration 011", { timeout: 20_000 }, () => {
  it("upgrades a pinned v10 file and keeps old resources unverified", () => {
    const path = fixture(); seedV10(path);
    const store = new SqliteStore(path, { mode: "owned" });
    try {
      expect(inspectSchema(store.db).version).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(SUPPORTED_SCHEMA_VERSION).toBe(11);
      expect(store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
        Array.from({ length: SUPPORTED_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
      expect(store.db.prepare("SELECT id,state,activation_operation_id,activation_binding_digest,readiness_revision FROM workspaces").get())
        .toEqual({ id: "legacy-workspace", state: "needs_verification", activation_operation_id: null, activation_binding_digest: null, readiness_revision: 0 });
      expect(store.db.prepare("SELECT id,state,activation_operation_id,activation_binding_digest,readiness_revision FROM provider_instances").get())
        .toEqual({ id: "legacy-provider", state: "unconfigured", activation_operation_id: null, activation_binding_digest: null, readiness_revision: 0 });
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM host_execution_operations").get()).toEqual({ n: 0 });
      expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const schema = store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      store.close();
      const reopened = new SqliteStore(path, { mode: "owned" });
      try {
        expect(reopened.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        expect(reopened.db.prepare("SELECT readiness_revision FROM workspaces").get()).toEqual({ readiness_revision: 0 });
      } finally { reopened.close(); }
    } finally { store.close(); }
  });

  it("installs the management operation table with its admission constraints", () => {
    const path = fixture();
    const store = new SqliteStore(path, { mode: "owned" });
    try {
      const insert = store.db.prepare(`INSERT INTO host_execution_operations(id,actor_id,command_id,kind,request_hash,state,revision,owner_context_json,resource_binding_json,evidence_json,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      insert.run("op-1", "actor", "command-1", "activation", "d".repeat(64), "accepted", 0, "{}", "{}", null, null, timestamp, timestamp);
      expect(() => insert.run("op-2", "actor", "command-1", "activation", "d".repeat(64), "accepted", 0, "{}", "{}", null, null, timestamp, timestamp))
        .toThrow(/UNIQUE/);
      expect(() => insert.run("op-3", "actor", "command-2", "other", "d".repeat(64), "accepted", 0, "{}", "{}", null, null, timestamp, timestamp))
        .toThrow(/CHECK/);
      expect(() => insert.run("op-4", "actor", "command-3", "restore_check", "d".repeat(64), "guessed", 0, "{}", "{}", null, null, timestamp, timestamp))
        .toThrow(/CHECK/);
    } finally { store.close(); }
  });

  it("requires migration 010 before installing the activation schema", () => {
    const db = new Database(":memory:");
    try {
      db.exec(FROZEN_V10_SCHEMA);
      db.prepare("DELETE FROM schema_migrations WHERE version=10").run();
      expect(() => applyExecutionActivationMigration(db)).toThrow("EXECUTION_ACTIVATION_MIGRATION_REQUIRES_010");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='host_execution_operations'").get()).toBeUndefined();
      const columns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "readiness_revision")).toBe(false);
    } finally { db.close(); }
  });

  it("rejects a corrupted declared v11 operation contract without making changes", () => {
    const path = fixture();
    const store = new SqliteStore(path, { mode: "owned" }); store.close();
    const db = new Database(path);
    try {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='host_execution_operations'").get() as { sql: string };
      expect(row.sql).toContain("CHECK(kind IN ('activation','restore_check'))");
      db.exec("DROP TABLE host_execution_operations");
      db.exec(row.sql.replace("'activation','restore_check'", "'activation','restore_check','other'"));
    } finally { db.close(); }
    const before = readFileSync(path);
    expect(() => new SqliteStore(path, { mode: "owned" })).toThrow("Declared migration 11 schema is incomplete");
    expect(readFileSync(path)).toEqual(before);
  });

  it("rejects a v11 file whose resource revision was rewritten", () => {
    const path = fixture(); seedV10(path);
    const store = new SqliteStore(path, { mode: "owned" });
    store.db.prepare(`INSERT INTO workspaces(id,canonical_root,worktree_root,checkout_key,kind,state,repository_id,capabilities_json,registration_operation_id,created_at,updated_at)
      VALUES('active-workspace','/offline/active-checkout','/offline/active-checkout',?,'local','active','active-repo','[]',NULL,?,?)`)
      .run("c".repeat(64), timestamp, timestamp);
    store.close();
    const db = new Database(path);
    try { db.prepare("UPDATE workspaces SET readiness_revision=-1").run(); } finally { db.close(); }
    const before = readFileSync(path);
    expect(() => new SqliteStore(path, { mode: "owned" })).toThrow("Declared migration 11 schema is incomplete");
    expect(readFileSync(path)).toEqual(before);
  });

  it("makes an older program refuse to open a declared v11 store", () => {
    const path = fixture();
    const store = new SqliteStore(path, { mode: "owned" }); store.close();
    const db = new Database(path);
    try {
      expect(() => inspectSchema(db, { maximumVersion: 10 })).toThrow("newer than supported schema 10");
    } finally { db.close(); }
  });
});
