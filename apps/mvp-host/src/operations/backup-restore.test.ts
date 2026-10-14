import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteStore } from "../storage/db.js";
import { HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { invalidateRestoredAccess } from "./restore-service.js";
import { ContentStore } from "../content/content-store.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { persistRelayRegistration, type RelayRegistration } from "../relay/relay-registration.js";
import { BackupService } from "./backup-service.js";
import { assertRestoreWriteReady, readRestoreReadinessGate, RestoreService, validateBackup } from "./restore-service.js";
import { digest, fileDigest, operationOwnerFromHost, validateContentReferences, type SnapshotCoordinator } from "./operation-files.js";

const roots: string[] = [];
const stores: SqliteStore[] = [];
const owners: HostOwnerHandle[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const owner of owners.splice(0)) owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const coordinate: SnapshotCoordinator = async (work) => work();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-operations-"));
  roots.push(root);
  await chmod(root, 0o700);
  const databasePath = join(root, "host.sqlite");
  const identityDirectory = join(root, "identity"); const coordinationDirectory = join(root, "owners");
  const hostOwner = HostOwnerLock.acquire({ databasePath, identityDirectory, coordinationDirectory }); owners.push(hostOwner);
  const store = openOwned({ databasePath, owner: hostOwner }); stores.push(store);
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory });
  store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const owner = operationOwnerFromHost(hostOwner);
  const session = store.createSession(join(root, "workspace"));
  const base = { db: store.db, owner, identityDirectory, directory: join(root, "backup"), applicationVersion: "test-build", supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot: coordinate };
  return { root, databasePath, store, identityDirectory, coordinationDirectory, identity, owner, hostOwner, session, base };
}

function maintenance(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close(); f.hostOwner.release();
  const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory, coordinationDirectory: f.coordinationDirectory, mode: "maintenance" }); owners.push(owner);
  return operationOwnerFromHost(owner);
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
    expect(backup.manifest.schema).toEqual({ migrationVersion: SUPPORTED_SCHEMA_VERSION, userVersion: 0 });
    expect(backup.manifest.identity.fingerprint).toBe(f.identity.fingerprint);
    expect(backup.manifest.relay?.generation).toBe(17);
    const serialized = JSON.stringify(backup.manifest);
    for (const secret of [f.identity.x25519SecretKey, f.identity.ed25519SecretKey, registration.relayCredential, registration.routeId, "private prompt", f.root]) expect(serialized).not.toContain(secret);
    for (const name of ["manifest.json", "database.sqlite", "host-identity.json", "relay-registration.json"]) expect((await stat(join(backup.directory, name))).mode & 0o777).toBe(0o600);
    expect((await stat(backup.directory)).mode & 0o777).toBe(0o700);
    const db = new Database(join(backup.directory, "database.sqlite"), { readonly: true, fileMustExist: true });
    try { expect(db.prepare("SELECT prompt FROM turns WHERE id = 'turn-1'").get()).toEqual({ prompt: "private prompt" }); }
    finally { db.close(); }
    await expect(validateBackup(backup.directory, SUPPORTED_SCHEMA_VERSION)).resolves.toEqual(backup.manifest);
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

  it("clamps requested support to the installed validator and rejects corrupt declared constraints", async () => {
    const f = await fixture(); f.store.db.pragma(`user_version = ${SUPPORTED_SCHEMA_VERSION + 1}`);
    await expect(new BackupService().create({ ...f.base, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION + 100 })).rejects.toThrow("SCHEMA_TOO_NEW");
    await expect(stat(f.base.directory)).rejects.toMatchObject({ code: "ENOENT" });
    f.store.db.pragma("user_version = 0"); f.store.db.exec("DROP INDEX one_active_timeline_epoch");
    await expect(new BackupService().create(f.base)).rejects.toThrow("BACKUP_SCHEMA_INVALID");
    expect(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'one_active_timeline_epoch'").get()).toBeUndefined();
    await expect(stat(f.base.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates bytes and contiguous stream prefixes rather than trusting lengths", async () => {
    const f = await fixture();
    const content = new ContentStore(f.store.db); const bytes = Buffer.from("secret output");
    const blob = content.putBlob({ sessionId: f.session.id, format: "text/plain", text: bytes.toString("utf8") });
    expect(validateContentReferences(f.store.db)).toBe(1);
    f.store.db.prepare("UPDATE content_refs SET blob_data = ? WHERE id = ?").run(Buffer.alloc(bytes.length, 1), blob.ref);
    await expect(new BackupService().create(f.base)).rejects.toThrow("BACKUP_CONTENT_INVALID");
    f.store.db.prepare("UPDATE content_refs SET blob_data = ? WHERE id = ?").run(bytes, blob.ref);
    const stream = content.beginStream({ sessionId: f.session.id, itemId: "stream-item", format: "text/plain" });
    const old = content.appendSegment({ streamId: stream.streamId, sourceSequence: 1, text: "abc" });
    content.appendSegment({ streamId: stream.streamId, sourceSequence: 2, text: "def" });
    f.store.db.prepare("UPDATE content_segments SET byte_start = 1, byte_end = 4 WHERE stream_id = ? AND byte_start = 0").run(stream.streamId);
    expect(() => validateContentReferences(f.store.db)).toThrow("BACKUP_CONTENT_INVALID");
    f.store.db.prepare("UPDATE content_segments SET byte_start = 0, byte_end = 3 WHERE stream_id = ? AND byte_start = 1").run(stream.streamId);
    f.store.db.prepare("INSERT INTO content_refs(id,session_id,kind,state,stream_id,through_sequence,byte_length,sha256,format,created_at) VALUES ('inside-segment',?,'stream_prefix','ready',?,2,4,?,'text/plain','now')")
      .run(f.session.id, stream.streamId, digest("abcd"));
    expect(validateContentReferences(f.store.db)).toBe(4);
    const oldChunk = content.getChunk({ sessionId: f.session.id, ref: old.ref, offset: 0 });
    if (oldChunk.encoding !== "utf8") throw new Error("Expected public text"); expect(oldChunk.text).toBe("abc");
  });
});

describe("restored deferred work is fenced", () => {
  it("invalidates actual Interaction/attention rows atomically and retains completed facts", async () => {
    const f = await fixture(); const timestamp = "2026-10-01T00:00:00.000Z";
    f.store.acceptTurn({ authSubjectId: "device-1", sessionId: f.session.id, turnId: "turn-1", commandId: "command-1", requestHash: "hash", prompt: "work", generation: 1 });
    f.store.createDevice({ id: "device-1", hostId: f.identity.hostId, platform: "test", credentialKind: "noise-static-key", credentialRevision: 1, scopes: ["host:read"], createdAt: timestamp });
    const question = { blocking: true, questions: [{ questionId: "q", header: "Question", question: "Value?", options: [], multiSelect: false, allowFreeText: true, secret: false }] };
    for (const status of ["pending", "responding", "outcome_unknown", "confirmed"]) f.store.db.prepare(`INSERT INTO interactions
      (interaction_id,session_id,turn_id,kind,version,status,delivery_state,evidence_kind,request_json,allowed_actions_json,expires_at,created_at,updated_at)
      VALUES(?,?,?,'question',4,?,?,?,?,'["answer"]','2099-01-01',?,?)`)
      .run(status, f.session.id, "turn-1", status, status === "pending" ? "none" : status === "confirmed" ? "native_confirmation" : "accepted", status === "confirmed" ? "native_confirmation" : "native_request", JSON.stringify(question), timestamp, timestamp);
    const source = f.store.db.prepare("SELECT id,commit_id,sequence FROM session_events WHERE session_id=? ORDER BY sequence LIMIT 1").get(f.session.id) as { id: string; commit_id: string; sequence: number };
    f.store.db.prepare(`INSERT INTO attention_facts(id,host_id,session_id,turn_id,version,kind,source_event_id,source_commit_id,source_sequence,created_at,expires_at)
      VALUES('attention',?,?,?,0,'question',?,?,?,?,'2099-01-01')`).run(f.identity.hostId, f.session.id, "turn-1", source.id, source.commit_id, source.sequence, timestamp);
    f.store.db.prepare(`INSERT INTO attention_push_subscriptions(id,host_id,device_id,platform,token,token_hash,project_id,created_at,expires_at)
      VALUES('push',?,'device-1','expo','private-token',?,'project',?,'2099-01-01')`).run(f.identity.hostId, digest("private-token"), timestamp);
    for (const [index, state] of ["pending", "dispatching", "outcome_unknown", "accepted", "provider_delivered", "presented"].entries()) {
      const id = `attention-device-${index}`; f.store.createDevice({ id, hostId: f.identity.hostId, platform: "test", credentialKind: "browser-session", credentialRevision: 1, scopes: ["host:read"], createdAt: timestamp });
      f.store.db.prepare(`INSERT INTO attention_deliveries(id,attention_id,device_id,surface,state,next_attempt_at,created_at,updated_at) VALUES(?,'attention',?,'push',?,?,?,?)`).run(state, id, state, timestamp, timestamp, timestamp);
    }
    f.store.db.prepare("INSERT INTO timeline_epochs(session_id,epoch,projector_version,indexed_sequence,state) VALUES(?,'old',2,2,'active')").run(f.session.id);
    const facts = JSON.stringify(f.store.db.prepare("SELECT * FROM session_events ORDER BY sequence").all());
    invalidateRestoredAccess(f.store.db, "2026-10-02T00:00:00.000Z");
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE status IN ('pending','responding','outcome_unknown')").get()).toEqual({ n: 0 });
    expect(f.store.db.prepare("SELECT version,status,evidence_kind FROM interactions WHERE interaction_id='confirmed'").get()).toEqual({ version: 4, status: "confirmed", evidence_kind: "native_confirmation" });
    expect(f.store.db.prepare("SELECT version,status,delivery_state FROM interactions WHERE interaction_id='responding'").get()).toEqual({ version: 5, status: "superseded", delivery_state: "unconfirmed" });
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM attention_push_subscriptions WHERE revoked_at IS NULL").get()).toEqual({ n: 0 });
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM attention_facts WHERE superseded_at IS NULL").get()).toEqual({ n: 0 });
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM attention_deliveries WHERE state='cancelled'").get()).toEqual({ n: 5 });
    expect(f.store.db.prepare("SELECT state FROM attention_deliveries WHERE id='presented'").get()).toEqual({ state: "presented" });
    expect(f.store.db.prepare("SELECT state FROM timeline_epochs WHERE epoch='old'").get()).toEqual({ state: "retired" });
    expect(JSON.stringify(f.store.db.prepare("SELECT * FROM session_events ORDER BY sequence").all())).toBe(facts);
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
    const original = f.store.db.prepare("SELECT id FROM execution_intents WHERE command_id = 'command-1'").get() as { id: string };
    for (const [ordinal, state] of ["pending", "claimed", "dispatching", "acknowledged", "settled"].entries()) f.store.db.prepare(`INSERT INTO execution_intents
      (id,session_id,turn_id,auth_subject_id,command_id,ordinal,actor_kind,kind,resource_id,payload_json,request_hash,request_format_version,source_sequence,commit_id,runtime_generation,attempt_id,state,claim_owner_id,claim_owner_generation,result_code,created_at,updated_at)
      SELECT ?,session_id,turn_id,auth_subject_id,command_id,?,actor_kind,kind,resource_id,payload_json,request_hash,request_format_version,source_sequence,commit_id,runtime_generation,attempt_id,?,'old-owner',9,?,created_at,? FROM execution_intents WHERE id=?`)
      .run(state, ordinal + 1, state, state === "settled" ? "completed" : null, timestamp, original.id);
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
      owner: maintenance(f), databasePath: f.databasePath, directory: f.base.directory,
      rollbackDirectory: join(f.root, "rollback"), identityDirectory: f.identityDirectory,
      applicationVersion: "test-build", supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot: coordinate,
      assertDatabaseClosed: () => expect(f.store.db.open).toBe(false), relay,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(result.readiness.status).toBe("external_state_unverified");
    expect(result.readiness.possibleDispatchIntents).toBe(5);
    expect(result.readiness.reasonCodes).toEqual(["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"]);
    const restored = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(restored.prepare("SELECT revoked_at, credential_hash, credential_revision FROM devices").get()).toEqual({ revoked_at: "2026-10-02T00:00:00.000Z", credential_hash: null, credential_revision: 5 });
      expect(restored.prepare("SELECT state FROM command_receipts").get()).toEqual({ state: "outcome_unknown" });
      expect(restored.prepare("SELECT status FROM turns").get()).toEqual({ status: "outcome_unknown" });
      expect(restored.prepare("SELECT active_turn_id, recovery_state, recovery_revision FROM sessions").get()).toMatchObject({ active_turn_id: "turn-1", recovery_state: "blocked", recovery_revision: 2 });
      expect(restored.prepare("SELECT COUNT(*) AS n FROM execution_intents WHERE state IN ('pending','claimed','dispatching','acknowledged')").get()).toEqual({ n: 0 });
      expect(restored.prepare("SELECT state,result_code FROM execution_intents WHERE id='settled'").get()).toEqual({ state: "settled", result_code: "completed" });
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
    const options = { owner: f.owner, databasePath: f.databasePath, directory: f.base.directory, rollbackDirectory: join(f.root, "rollback"), identityDirectory: f.identityDirectory, applicationVersion: "test", supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot: coordinate, assertDatabaseClosed: vi.fn() };
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
    await expect(validateBackup(f.base.directory, SUPPORTED_SCHEMA_VERSION)).rejects.toThrow("BACKUP_HASH_MISMATCH");
    await patchManifestHash(f.base.directory);
    await expect(validateBackup(f.base.directory, SUPPORTED_SCHEMA_VERSION)).rejects.toThrow("BACKUP_FOREIGN_KEYS_FAILED");
    expect(f.store.getSession(f.session.id)?.activityState).toBe("idle");
    await expect(stat(join(f.root, "rollback"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the current database and rollback snapshot after a preinstall failure", async () => {
    const f = await fixture();
    await new BackupService().create(f.base);
    f.store.commitEvent(f.session.id, "test.current", {});
    f.store.close();
    await expect(new RestoreService().restore({
      owner: maintenance(f), databasePath: f.databasePath, directory: f.base.directory, rollbackDirectory: join(f.root, "rollback"),
      identityDirectory: f.identityDirectory, applicationVersion: "test", supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot: coordinate, assertDatabaseClosed: () => undefined,
      beforeInstall: () => { throw new Error("injected preinstall failure"); },
    })).rejects.toThrow("injected preinstall failure");
    const current = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    try { expect(current.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'test.current'").get()).toEqual({ n: 1 }); }
    finally { current.close(); }
    await expect(stat(join(f.root, "rollback/manifest.json"))).resolves.toBeDefined();
  });
});
