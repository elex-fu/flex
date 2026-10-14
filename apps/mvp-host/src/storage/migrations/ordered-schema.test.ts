import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostOwnerLock } from "../../lifecycle/host-owner.js";
import type { ProcessInspector } from "../../lifecycle/process-inspector.js";
import { LEGACY_V2_SCHEMA } from "../../test-support/legacy-v2-schema.js";
import { SqliteStore } from "../db.js";
import { openForRecoveryMaintenance, openReadOnly, upgradeForRecoveryMaintenance } from "../open-store.js";
import { applyCommandExecutionMigration } from "./004-command-execution.js";
import { applyRecoveryMigration } from "./005-recovery.js";
import { applyViewsSchemaMigration } from "./006-views.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "./schema-version.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flyx-ordered-schema-")); roots.push(root);
  const data = join(root, "data"); mkdirSync(data, { mode: 0o700 });
  return { root, databasePath: join(data, "host.sqlite"), identityDirectory: join(data, "identity"), coordinationDirectory: join(root, "coordination") };
}
function seedV4(path: string): void {
  const db = new Database(path);
  try {
    db.exec(LEGACY_V2_SCHEMA);
    db.exec(`ALTER TABLE devices ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE auth_sessions ADD COLUMN device_id TEXT REFERENCES devices(id);
      ALTER TABLE pairing_grants ADD COLUMN host_id TEXT;
      ALTER TABLE pairing_grants ADD COLUMN requested_scopes TEXT;
      ALTER TABLE pairing_grants ADD COLUMN approved_at TEXT;
      ALTER TABLE pairing_grants ADD COLUMN device_id TEXT REFERENCES devices(id);
      INSERT INTO schema_migrations VALUES(3,'legacy')`);
    applyCommandExecutionMigration(db);
    // A frozen R05 v4 file predates the durable original dispatch binding.
    db.exec("ALTER TABLE execution_intents DROP COLUMN dispatch_context_json");
    expect(inspectSchema(db).version).toBe(4);
  } finally { db.close(); }
}

describe("ordered owned schema and recovery metadata", () => {
  it("migrates a real v4 file through recovery and views, then reopens without changing schema", () => {
    const f = fixture(); seedV4(f.databasePath);
    const first = new SqliteStore(f.databasePath, { mode: "owned" });
    const session = first.createSession("/controlled-workspace");
    const schema = first.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    expect(inspectSchema(first.db).version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect((first.db.prepare("PRAGMA table_info(execution_intents)").all() as Array<{ name: string }>).some((column) => column.name === "dispatch_context_json")).toBe(true);
    expect(first.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([1, 2, 3, 4, 5, 6].map((version) => ({ version })));
    first.close();
    const second = new SqliteStore(f.databasePath, { mode: "owned" });
    try {
      expect(second.getSession(session.id)?.workspacePath).toBe("/controlled-workspace");
      expect(second.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      const reader = openReadOnly(f.databasePath);
      try { expect(inspectSchema(reader.db).version).toBe(6); } finally { reader.close(); }
    } finally { second.close(); }
  });

  it("preserves retained owner files while explicitly installing v5/v6 metadata under both guards", () => {
    const f = fixture(); seedV4(f.databasePath);
    const inspector: ProcessInspector = {
      currentIdentity: () => ({ pid: 123, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "1" } }),
      inspect: () => ({ state: "exited", reason: "controlled-test" }),
    };
    const original = HostOwnerLock.acquire({ ...f, inspector }); original.retain("process_tree_unverified");
    const files = () => readdirSync(f.coordinationDirectory).filter((name) => name.endsWith(".owner")).sort().map((name) => readFileSync(join(f.coordinationDirectory, name)));
    const before = files();
    const held = HostOwnerLock.acquireForRecoveryMaintenance({ ...f, inspector });
    const store = openForRecoveryMaintenance({ databasePath: f.databasePath, owner: held });
    try {
      expect(inspectSchema(store.db).version).toBe(4);
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_evidence'").get()).toBeUndefined();
      upgradeForRecoveryMaintenance(held, store.db, (db) => { applyRecoveryMigration(db); applyViewsSchemaMigration(db); });
      expect(inspectSchema(store.db).version).toBe(6);
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM managed_process_stop_proofs").get()).toEqual({ count: 0 });
      expect(files()).toEqual(before);
      expect(() => store.assertWriterOwner()).toThrow("HOST_RECOVERY_ONLY");
      expect(() => held.release()).toThrow("without committed stop evidence");
    } finally { store.close(); held.closeMaintenance(); }
    expect(files()).toEqual(before);
  });

  it("rejects a corrupt declared v6 file without recreating private evidence tables", () => {
    const f = fixture();
    const store = new SqliteStore(f.databasePath, { mode: "owned" }); store.close();
    const raw = new Database(f.databasePath); raw.exec("DROP TABLE managed_process_boundaries"); raw.close();
    const before = readFileSync(f.databasePath);
    expect(() => new SqliteStore(f.databasePath, { mode: "owned" })).toThrow("migration 5 schema is incomplete");
    expect(readFileSync(f.databasePath)).toEqual(before);
  });

  it("does not install views or a v6 marker without the preceding recovery migration", () => {
    const f = fixture(); seedV4(f.databasePath);
    const db = new Database(f.databasePath);
    try {
      expect(() => applyViewsSchemaMigration(db)).toThrow("VIEWS_MIGRATION_REQUIRES_005");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='timeline_epochs'").get()).toBeUndefined();
      expect(inspectSchema(db).version).toBe(4);
    } finally { db.close(); }
  });
});
