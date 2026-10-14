import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../storage/db.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { persistRelayRegistration, type RelayRegistration } from "../relay/relay-registration.js";
import { BackupService } from "./backup-service.js";
import { assertRestoreWriteReady, readRestoreReadinessGate, RestoreService, validateBackup } from "./restore-service.js";
import { digest, fileDigest, validateContentReferences, type OperationOwner, type SnapshotCoordinator } from "./operation-files.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const coordinate: SnapshotCoordinator = async (work) => work();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-operations-"));
  roots.push(root);
  await chmod(root, 0o700);
  const databasePath = join(root, "host.sqlite");
  const store = new SqliteStore(databasePath);
  stores.push(store);
  const identityDirectory = join(root, "identity");
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory });
  store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const owner: OperationOwner = { mode: "runtime", databasePath, assertActive: vi.fn() };
  const session = store.createSession(join(root, "workspace"));
  const base = { db: store.db, owner, identityDirectory, directory: join(root, "backup"), applicationVersion: "test-build", supportedSchemaVersion: 3, withSnapshot: coordinate };
  return { root, databasePath, store, identityDirectory, identity, owner, session, base };
}

function addContentTables(db: Database.Database) {
  db.exec("CREATE TABLE content_streams (id TEXT PRIMARY KEY, session_id TEXT NOT NULL); CREATE TABLE content_segments (stream_id TEXT, source_sequence INTEGER, byte_start INTEGER, byte_end INTEGER, data BLOB); CREATE TABLE content_refs (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, state TEXT, stream_id TEXT, through_sequence INTEGER, byte_length INTEGER, sha256 TEXT, blob_data BLOB)");
}

async function patchManifestHash(directory: string) {
  const path = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.database.sha256 = await fileDigest(join(directory, "database.sqlite"));
  await writeFile(path, JSON.stringify(manifest));
}

describe("owner coordinated consistent backup", () => {
  it("includes committed WAL facts and aligned private files without secrets in the manifest", async () => {
    const f = await fixture();
    f.store.db.pragma("wal_autocheckpoint = 0");
    f.store.acceptTurn({ authSubjectId: "device-1", sessionId: f.session.id, turnId: "turn-1", commandId: "command-1", requestHash: "request-1", prompt: "private prompt", generation: 1 });
    const relayPath = join(f.root, "relay.json");
    const registration: RelayRegistration = { v: 1, relayUrl: "wss://relay.example", routeId: randomBytes(24).toString("base64url"), relayCredential: randomBytes(32).toString("base64url"), generation: 17, createdAt: "2026-10-01T00:00:00.000Z" };
    await persistRelayRegistration(relayPath, registration);
    let coordinated = 0;
    const backup = await new BackupService().create({ ...f.base, relay: { registrationPath: relayPath, relayUrl: registration.relayUrl }, withSnapshot: async (work) => { coordinated += 1; return work(); } });
    expect(coordinated).toBe(1);
    expect(backup.manifest.schema).toEqual({ migrationVersion: 3, userVersion: 0 });
    expect(backup.manifest.identity.fingerprint).toBe(f.identity.fingerprint);
    expect(backup.manifest.relay?.generation).toBe(17);
    const serialized = JSON.stringify(backup.manifest);
    for (const secret of [f.identity.x25519SecretKey, f.identity.ed25519SecretKey, registration.relayCredential, registration.routeId, "private prompt", f.root]) expect(serialized).not.toContain(secret);
    for (const name of ["manifest.json", "database.sqlite", "host-identity.json", "relay-registration.json"]) expect((await stat(join(backup.directory, name))).mode & 0o777).toBe(0o600);
    expect((await stat(backup.directory)).mode & 0o777).toBe(0o700);
    const db = new Database(join(backup.directory, "database.sqlite"), { readonly: true, fileMustExist: true });
    try { expect(db.prepare("SELECT prompt FROM turns WHERE id = 'turn-1'").get()).toEqual({ prompt: "private prompt" }); }
    finally { db.close(); }
    await expect(validateBackup(backup.directory, 3)).resolves.toEqual(backup.manifest);
  });

  it("rejects a generation drift and removes the incomplete backup", async () => {
    const f = await fixture();
    const relayPath = join(f.root, "relay.json");
    const registration: RelayRegistration = { v: 1, relayUrl: "wss://relay.example", routeId: randomBytes(24).toString("base64url"), relayCredential: randomBytes(32).toString("base64url"), generation: 1, createdAt: "2026-10-01T00:00:00.000Z" };
    await persistRelayRegistration(relayPath, registration);
    const original = f.store.db.backup.bind(f.store.db);
    vi.spyOn(f.store.db, "backup").mockImplementation(async (path, options) => {
      const result = await original(path, options);
      await persistRelayRegistration(relayPath, { ...registration, generation: 2 });
      return result;
    });
    await expect(new BackupService().create({ ...f.base, relay: { registrationPath: relayPath, relayUrl: registration.relayUrl } })).rejects.toThrow("BACKUP_SNAPSHOT_CHANGED");
    await expect(stat(f.base.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects future schema before creating an artifact or changing facts", async () => {
    const f = await fixture();
    f.store.db.pragma("user_version = 999");
    await expect(new BackupService().create(f.base)).rejects.toThrow("SCHEMA_TOO_NEW");
    expect(f.store.getSession(f.session.id)?.activityState).toBe("idle");
    await expect(stat(f.base.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates bytes and contiguous stream prefixes rather than trusting lengths", async () => {
    const f = await fixture();
    addContentTables(f.store.db);
    const bytes = Buffer.from("secret output");
    f.store.db.prepare("INSERT INTO content_refs VALUES (?, ?, 'blob', 'ready', NULL, NULL, ?, ?, ?)").run("blob", f.session.id, bytes.length, digest(bytes), bytes);
    expect(validateContentReferences(f.store.db)).toBe(1);
    f.store.db.prepare("UPDATE content_refs SET blob_data = ? WHERE id = 'blob'").run(Buffer.alloc(bytes.length, 1));
    await expect(new BackupService().create(f.base)).rejects.toThrow("BACKUP_CONTENT_INVALID");
    f.store.db.exec("DELETE FROM content_refs");
    f.store.db.prepare("INSERT INTO content_streams VALUES ('stream', ?)").run(f.session.id);
    f.store.db.prepare("INSERT INTO content_segments VALUES ('stream', 1, 1, 4, ?)").run(Buffer.from("abc"));
    f.store.db.prepare("INSERT INTO content_refs VALUES ('prefix', ?, 'stream_prefix', 'ready', 'stream', 1, 3, ?, NULL)").run(f.session.id, digest("abc"));
    expect(() => validateContentReferences(f.store.db)).toThrow("BACKUP_CONTENT_INVALID");
    f.store.db.exec("DELETE FROM content_segments; DELETE FROM content_refs");
    f.store.db.prepare("INSERT INTO content_segments VALUES ('stream', 1, 0, 3, ?)").run(Buffer.from("abc"));
    f.store.db.prepare("INSERT INTO content_segments VALUES ('stream', 1, 3, 6, ?)").run(Buffer.from("def"));
    f.store.db.prepare("INSERT INTO content_refs VALUES ('old-prefix', ?, 'stream_prefix', 'ready', 'stream', 1, 3, ?, NULL)").run(f.session.id, digest("abc"));
    f.store.db.prepare("INSERT INTO content_refs VALUES ('inside-segment', ?, 'stream_prefix', 'ready', 'stream', 1, 4, ?, NULL)").run(f.session.id, digest("abcd"));
    expect(validateContentReferences(f.store.db)).toBe(2);
  });
});

describe("offline database restore", () => {
  it("creates a rollback point, invalidates access and requires external reconciliation", async () => {
    const f = await fixture();
    const timestamp = "2026-10-01T00:00:00.000Z";
    f.store.acceptTurn({ authSubjectId: "device-1", sessionId: f.session.id, turnId: "turn-1", commandId: "command-1", requestHash: "request-1", prompt: "work", generation: 1 });
    f.store.createDevice({ id: "device-1", hostId: f.identity.hostId, platform: "test", credentialKind: "noise-static-key", credentialRevision: 4, scopes: ["host:read"], createdAt: timestamp });
    f.store.db.prepare("UPDATE devices SET credential_hash = 'historical-credential'").run();
    f.store.db.prepare("INSERT INTO auth_sessions (id, token_hash, created_at, expires_at, last_seen_at, device_id) VALUES ('auth-1', 'token-hash', ?, '2099-01-01', ?, 'device-1')").run(timestamp, timestamp);
    f.store.createPairingGrant("grant-hash", "2099-01-01");
    f.store.createProtocolSession({ id: "lease-1", deviceId: "device-1", protocolVersion: 2, transportKind: "direct", transportGeneration: 3, capabilities: [], connectedAt: timestamp, expiresAt: "2099-01-01", authSessionId: "auth-1" });
    f.store.db.exec("CREATE TABLE execution_intents (id TEXT PRIMARY KEY, state TEXT NOT NULL, claim_owner_id TEXT, claim_owner_generation INTEGER, result_code TEXT, updated_at TEXT NOT NULL)");
    for (const state of ["pending", "claimed", "dispatching", "acknowledged", "settled"]) f.store.db.prepare("INSERT INTO execution_intents VALUES (?, ?, 'old-owner', 9, NULL, ?)").run(state, state, timestamp);
    const relayPath = join(f.root, "relay.json");
    const registration: RelayRegistration = { v: 1, relayUrl: "wss://relay.example", routeId: randomBytes(24).toString("base64url"), relayCredential: randomBytes(32).toString("base64url"), generation: 17, createdAt: timestamp };
    await persistRelayRegistration(relayPath, registration);
    const relay = { registrationPath: relayPath, relayUrl: registration.relayUrl };
    await new BackupService().create({ ...f.base, relay });
    f.store.commitEvent(f.session.id, "test.after_backup", { current: true });
    const external = join(f.root, "external-history");
    await writeFile(external, "Git and Provider advanced after backup");
    f.store.close();
    const result = await new RestoreService().restore({
      owner: { ...f.owner, mode: "maintenance" }, databasePath: f.databasePath, directory: f.base.directory,
      rollbackDirectory: join(f.root, "rollback"), identityDirectory: f.identityDirectory,
      applicationVersion: "test-build", supportedSchemaVersion: 3, withSnapshot: coordinate,
      assertDatabaseClosed: () => expect(f.store.db.open).toBe(false), relay,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(result.readiness.status).toBe("external_state_unverified");
    expect(result.readiness.possibleDispatchIntents).toBe(3);
    expect(result.readiness.reasonCodes).toEqual(["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"]);
    const restored = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(restored.prepare("SELECT revoked_at, credential_hash, credential_revision FROM devices").get()).toEqual({ revoked_at: "2026-10-02T00:00:00.000Z", credential_hash: null, credential_revision: 5 });
      expect(restored.prepare("SELECT state FROM command_receipts").get()).toEqual({ state: "outcome_unknown" });
      expect(restored.prepare("SELECT status FROM turns").get()).toEqual({ status: "outcome_unknown" });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM pairing_grants WHERE consumed_at IS NULL").get()).toEqual({ n: 0 });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
      expect(restored.prepare("SELECT close_code FROM protocol_sessions").get()).toEqual({ close_code: "HOST_RESTORED" });
      expect(restored.prepare("SELECT id, state, claim_owner_id FROM execution_intents WHERE id = 'dispatching'").get()).toEqual({ id: "dispatching", state: "outcome_unknown", claim_owner_id: null });
      expect(readRestoreReadinessGate(restored)).toEqual(result.readiness);
      expect(() => assertRestoreWriteReady(restored)).toThrow("RESTORE_EXTERNAL_STATE_UNVERIFIED");
      expect(JSON.parse((restored.prepare("SELECT response_json FROM command_receipts").get() as { response_json: string }).response_json)).toEqual({ turnId: "turn-1", status: "outcome_unknown", reason: "host_restore" });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'test.after_backup'").get()).toEqual({ n: 0 });
    } finally { restored.close(); }
    const rollback = new Database(join(result.rollbackDirectory, "database.sqlite"), { readonly: true, fileMustExist: true });
    try { expect(rollback.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'test.after_backup'").get()).toEqual({ n: 1 }); }
    finally { rollback.close(); }
    expect(await readFile(external, "utf8")).toBe("Git and Provider advanced after backup");
    await expect(stat(relayPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires maintenance ownership and closed handles before any installation", async () => {
    const f = await fixture();
    const options = { owner: f.owner, databasePath: f.databasePath, directory: f.base.directory, rollbackDirectory: join(f.root, "rollback"), identityDirectory: f.identityDirectory, applicationVersion: "test", supportedSchemaVersion: 3, withSnapshot: coordinate, assertDatabaseClosed: vi.fn() };
    await expect(new RestoreService().restore(options)).rejects.toThrow("RESTORE_OFFLINE_OWNER_REQUIRED");
    expect(options.assertDatabaseClosed).not.toHaveBeenCalled();
    expect(f.store.getSession(f.session.id)?.activityState).toBe("idle");
  });

  it("rejects hash mismatch and foreign key corruption without a rollback/install mutation", async () => {
    const f = await fixture();
    await new BackupService().create(f.base);
    const backupPath = join(f.base.directory, "database.sqlite");
    const backup = new Database(backupPath);
    backup.pragma("foreign_keys = OFF");
    backup.prepare("INSERT INTO turns (id, session_id, command_id, request_hash, status, prompt, generation, created_at) VALUES ('bad', 'missing-session', 'bad-command', 'bad-hash', 'completed', 'x', 1, '2026-01-01')").run();
    backup.pragma("wal_checkpoint(TRUNCATE)");
    backup.close();
    await expect(validateBackup(f.base.directory, 3)).rejects.toThrow("BACKUP_HASH_MISMATCH");
    await patchManifestHash(f.base.directory);
    await expect(validateBackup(f.base.directory, 3)).rejects.toThrow("BACKUP_FOREIGN_KEYS_FAILED");
    expect(f.store.getSession(f.session.id)?.activityState).toBe("idle");
    await expect(stat(join(f.root, "rollback"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the current database and rollback snapshot after a preinstall failure", async () => {
    const f = await fixture();
    await new BackupService().create(f.base);
    f.store.commitEvent(f.session.id, "test.current", {});
    f.store.close();
    await expect(new RestoreService().restore({
      owner: { ...f.owner, mode: "maintenance" }, databasePath: f.databasePath, directory: f.base.directory, rollbackDirectory: join(f.root, "rollback"),
      identityDirectory: f.identityDirectory, applicationVersion: "test", supportedSchemaVersion: 3, withSnapshot: coordinate, assertDatabaseClosed: () => undefined,
      beforeInstall: () => { throw new Error("injected preinstall failure"); },
    })).rejects.toThrow("injected preinstall failure");
    const current = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    try { expect(current.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'test.current'").get()).toEqual({ n: 1 }); }
    finally { current.close(); }
    await expect(stat(join(f.root, "rollback/manifest.json"))).resolves.toBeDefined();
  });
});
