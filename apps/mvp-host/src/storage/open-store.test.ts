import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry } from "../auth/device-registry.js";
import { HostOwnerLock, createTestHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { SqliteStore } from "./db.js";
import { openForMaintenance, openForManagement, openOwned, openReadOnly } from "./open-store.js";
import { LEGACY_V2_SCHEMA } from "../test-support/legacy-v2-schema.js";
import { SUPPORTED_SCHEMA_VERSION } from "./migrations/schema-version.js";

const roots: string[] = [];
const owners: HostOwnerHandle[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const owner of owners.splice(0)) owner.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flyx-open-store-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  const databasePath = join(data, "host.sqlite");
  const identityDirectory = join(data, "identity");
  const coordinationDirectory = join(root, "coordination");
  const own = (mode: "host" | "maintenance" = "host") => {
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, coordinationDirectory, mode });
    owners.push(owner);
    return owner;
  };
  return { root, databasePath, identityDirectory, own };
}

const keep = (store: SqliteStore) => { stores.push(store); return store; };
const schema = (store: SqliteStore) => store.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

describe("safe Store opening", () => {
  it("rejects future schema before SCHEMA, identity creation or any writable pragma", () => {
    const f = fixture();
    const future = new Database(f.databasePath);
    future.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(99, 'future'); CREATE TABLE future_fact(id TEXT PRIMARY KEY);");
    future.close();
    const before = readFileSync(f.databasePath);
    const owner = f.own();
    expect(() => openOwned({ databasePath: f.databasePath, owner })).toThrow("newer than supported");
    expect(readFileSync(f.databasePath)).toEqual(before);
    expect(existsSync(`${f.databasePath}-wal`)).toBe(false);
    expect(existsSync(f.identityDirectory)).toBe(false);
    expect(() => openReadOnly(f.databasePath)).toThrow("newer than supported");
    expect(() => openForManagement(f.databasePath)).toThrow("newer than supported");
  });

  it("reads existing stores without DDL and refuses to create a missing file", () => {
    const f = fixture();
    const empty = new Database(f.databasePath);
    empty.close();
    const read = keep(openReadOnly(f.databasePath));
    expect(schema(read)).toEqual([]);
    expect(() => read.db.exec("CREATE TABLE forbidden(id TEXT)")).toThrow("readonly");
    expect(existsSync(f.identityDirectory)).toBe(false);
    const missing = join(f.root, "missing.sqlite");
    expect(() => openReadOnly(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects a declared v3 schema with missing columns instead of silently repairing it", () => {
    const f = fixture();
    const invalid = new Database(f.databasePath);
    invalid.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(3, 'declared'); CREATE TABLE turns(id TEXT PRIMARY KEY);");
    invalid.close();
    const before = readFileSync(f.databasePath);
    const owner = f.own();
    expect(() => openOwned({ databasePath: f.databasePath, owner })).toThrow("Declared schema is missing");
    expect(readFileSync(f.databasePath)).toEqual(before);
  });

  it("migrates a pinned legacy v2 database under ownership through the supported schema", () => {
    const f = fixture();
    const legacy = new Database(f.databasePath);
    legacy.exec(LEGACY_V2_SCHEMA);
    legacy.prepare("INSERT INTO sessions(id,workspace_id,workspace_path,provider,status,activity_state,head_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("legacy-session", "default", "/persisted-workspace", "claude", "active", "idle", 0, "2026-10-14T00:00:00.000Z", "2026-10-14T00:00:00.000Z");
    legacy.close();
    const owner = f.own();
    const migrated = keep(openOwned({ databasePath: f.databasePath, owner }));
    expect(migrated.getSession("legacy-session")?.workspacePath).toBe("/persisted-workspace");
    expect(migrated.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: SUPPORTED_SCHEMA_VERSION });
    const columns = migrated.db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "credential_revision")).toBe(true);
    expect(schema(keep(openReadOnly(f.databasePath)))).toEqual(schema(migrated));
  });

  it("rolls back baseline DDL and all version markers when legacy structure cannot validate", () => {
    const f = fixture();
    const malformed = new Database(f.databasePath);
    malformed.exec("CREATE TABLE auth_sessions(id TEXT PRIMARY KEY)");
    const before = malformed.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    malformed.close();
    const owner = f.own();
    expect(() => openOwned({ databasePath: f.databasePath, owner })).toThrow("Declared schema is missing");
    const read = keep(openReadOnly(f.databasePath));
    expect(schema(read)).toEqual(before);
  });

  it("rejects an invalid declared v3 active-Turn uniqueness predicate without changing it", () => {
    const f = fixture();
    const invalid = new SqliteStore(f.databasePath);
    invalid.db.exec("DROP INDEX one_active_turn_per_session; CREATE UNIQUE INDEX one_active_turn_per_session ON turns(session_id) WHERE status = 'completed'");
    const before = schema(invalid);
    invalid.close();
    const owner = f.own();
    expect(() => openOwned({ databasePath: f.databasePath, owner })).toThrow("invalid one_active_turn_per_session constraint");
    const raw = new Database(f.databasePath, { readonly: true });
    try { expect(raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(before); }
    finally { raw.close(); }
  });

  it("allows bounded live revocation without migration, recovery or identity creation", () => {
    const f = fixture();
    const owner = f.own();
    const host = keep(openOwned({ databasePath: f.databasePath, owner }));
    const registry = new DeviceRegistry(host, "test-host", { recoverLeases: false });
    const device = registry.createBrowserDevice();
    const session = host.createSession("/workspace");
    host.createTurn({ sessionId: session.id, turnId: "active", commandId: "start", requestHash: "request", prompt: "remain active", generation: 1 });
    const before = schema(host);
    const management = keep(openForManagement(f.databasePath));
    const local = new DeviceRegistry(management, "test-host", { recoverLeases: false });
    try {
      expect(management.db.pragma("busy_timeout", { simple: true })).toBe(1_000);
      expect(() => management.createSession("/forbidden-business")).toThrow("HOST_OWNER_REQUIRED");
      expect(() => management.setHostIdentityMirror({hostId:"forbidden",fingerprint:"forbidden"})).toThrow("HOST_OWNER_REQUIRED");
      expect(() => management.createPairingGrant("forbidden",new Date(Date.now()+60_000).toISOString())).toThrow("HOST_OWNER_REQUIRED");
      expect(local.credentialTransaction(() => local.revokeFromLocal(device.id))).toBe(true);
      expect(host.getDevice(device.id)?.revokedAt).toBeDefined();
      expect(host.getTurn("active")?.status).toBe("queued");
      expect(schema(host)).toEqual(before);
      expect(existsSync(f.identityDirectory)).toBe(false);
      owner.assertActive();
    } finally { registry.dispose(); local.dispose(); }
  });

  it("requires offline ownership for maintenance and cannot authorize a real file with a test owner", () => {
    const f = fixture();
    const owner = f.own();
    expect(() => openForMaintenance({ databasePath: f.databasePath, owner })).toThrow("Offline maintenance");
    expect(() => f.own("maintenance")).toThrow("Another Host");
    expect(() => openOwned({ databasePath: f.databasePath, owner: createTestHostOwner() })).toThrow("only open an in-memory");
    owner.release();
    const maintenance = f.own("maintenance");
    const store = keep(openForMaintenance({ databasePath: f.databasePath, owner: maintenance }));
    expect(store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: SUPPORTED_SCHEMA_VERSION });
  });
});
