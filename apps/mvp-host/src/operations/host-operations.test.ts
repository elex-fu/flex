import Database from "better-sqlite3";
import { chmod, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import type { SqliteStore } from "../storage/db.js";
import { loadOrCreateHostIdentity, getHostIdentityMirror } from "../identity/host-identity.js";
import { CommandEngine } from "../orchestration/command-engine.js";
import { createHostOperations, doctorHostDatabase, hostDiagnosticsRpc, OperationSnapshotLane, restoreWriteGuard, runHostOperationsCli, restoreHostBackup } from "./host-operations.js";
import { digest } from "./operation-files.js";
const roots: string[] = []; const owners: HostOwnerHandle[] = []; const stores: SqliteStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const owner of owners.splice(0)) owner.release(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-host-operations-")); roots.push(root); await chmod(root, 0o700);
  const databasePath = join(root, "host.sqlite"); const identityDirectory = join(root, "identity"); const coordinationDirectory = join(root, "owners");
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, coordinationDirectory }); owners.push(owner);
  const store = openOwned({ databasePath, owner }); stores.push(store);
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const session = store.createSession(join(root, "workspace"));
  const options = { identityDirectory, applicationVersion: "test", doctorFacts: () => ({ readiness: { status: "ready" as const, reasonCodes: [] } }) };
  const operations = createHostOperations({ store, owner }, options);
  return { root, databasePath, identityDirectory, coordinationDirectory, owner, store, identity, session, options, operations };
}
const gate = { v: 1, status: "external_state_unverified", restoredAt: "2026-10-01T00:00:00.000Z", backupCreatedAt: "2026-09-01T00:00:00.000Z", possibleDispatchIntents: 0, reasonCodes: ["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"], relayRegistrationInvalidated: false };
describe("callable owned Host operations", () => {
  it("serves scoped strict sanitized diagnostics and read-only CLI Doctor without Provider probes", async () => {
    const f = await fixture(); f.store.acceptTurn({ authSubjectId: "secret-device", commandId: "command", requestHash: "hash", sessionId: f.session.id, turnId: "turn", prompt: "private text", generation: 1 });
    const remote = hostDiagnosticsRpc(f.operations, "host.getDiagnostics", {}, new Set(["host:read"]));
    expect(remote.activity).toBeUndefined(); expect(remote.schema.writable).toBe(true);
    expect(() => hostDiagnosticsRpc(f.operations, "host.doctor", {}, new Set(["session:read"]))).toThrow("FORBIDDEN");
    expect(() => hostDiagnosticsRpc(f.operations, "host.doctor", { workspace: "/arbitrary" }, new Set(["host:read"]))).toThrow();
    const local = await runHostOperationsCli(["doctor"], { databasePath: f.databasePath });
    expect(local).toMatchObject({ owner: { mode: "read_only", state: "unverified" }, schema: { writable: false } });
    for (const secret of [f.root, "secret-device", "private text", f.identity.ed25519SecretKey]) expect(JSON.stringify(local)).not.toContain(secret);
    await expect(runHostOperationsCli(["doctor", "unexpected"], { databasePath: f.databasePath })).rejects.toThrow("OPERATIONS_INVALID_COMMAND");
  });
  it("shares the snapshot lane with identity/Relay work and creates an actually valid CLI backup", async () => {
    const f = await fixture(); const lane = new OperationSnapshotLane(() => f.owner.assertActive());
    const operations = createHostOperations({ store: f.store, owner: f.owner }, { ...f.options, withSnapshot: lane.withSnapshot });
    let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
    const registration = lane.withSnapshot(async () => { entered(); await barrier; }); await started;
    const directory = join(f.root, "backup"); const creating = runHostOperationsCli(["backup", directory], { databasePath: f.databasePath, runtime: operations });
    await new Promise<void>((resolve) => setImmediate(resolve)); await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    release(); await registration; const backup = await creating;
    expect(backup).toMatchObject({ directory: await realpath(directory) });
    const validation = await runHostOperationsCli(["validate", directory], { databasePath: f.databasePath });
    expect(validation).toMatchObject({ identity: { fingerprint: f.identity.fingerprint }, includesExternalGitOrProviderHistory: false });
    await expect(lane.withSnapshot(async () => { throw new Error("failed rotation"); })).rejects.toThrow("failed rotation");
    await expect(lane.withSnapshot(async () => 1)).resolves.toBe(1);
  });
  it("provides an Engine admission guard which denies both valid and malformed restored gates", async () => {
    const f = await fixture(); const guard = restoreWriteGuard(f.store); const engine = new CommandEngine(f.store, { admission: guard });
    const before = f.store.getSession(f.session.id)!.headSequence;
    for (const value of [JSON.stringify(gate), '"ready"', '{"state":"ready"}', "malformed"]) {
      f.store.db.prepare("INSERT INTO host_state(key,value_json,updated_at) VALUES('restore_readiness',?,'now') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(value);
      let decided = false;
      expect(() => engine.commitRequest({ authSubjectId: "device", commandId: value, method: "test.restore", requestHash: value, targetSessionId: f.session.id }, () => { decided = true; return { result: {}, events: [] }; })).toThrow(/RESTORE_/);
      expect(decided).toBe(false); expect(f.store.getSession(f.session.id)!.headSequence).toBe(before);
      expect(() => f.operations.assertWriteReady()).toThrow(/RESTORE_/);
    }
    expect(f.operations.doctor({ kind: "local" }).readiness.reasonCodes).toContain("RESTORE_GATE_INVALID");
  });
  it("routes restore only through a verified offline owner and reopens the fenced history", async () => {
    const f = await fixture(); const backup = join(f.root, "backup"); await f.operations.backup(backup);
    await expect(runHostOperationsCli(["restore", backup, join(f.root, "rollback")], { databasePath: f.databasePath, runtime: f.operations })).rejects.toThrow("RESTORE_OFFLINE_OWNER_REQUIRED");
    f.store.close(); f.owner.release();
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory, coordinationDirectory: f.coordinationDirectory, mode: "maintenance" }); owners.push(owner);
    const offline = { owner, databasePath: f.databasePath, identityDirectory: f.identityDirectory, applicationVersion: "test", assertDatabaseClosed: () => expect(f.store.db.open).toBe(false) };
    const restored = await runHostOperationsCli(["restore", backup, join(f.root, "rollback")], { databasePath: f.databasePath, offlineRestore: offline });
    expect(restored).toMatchObject({ readiness: { status: "external_state_unverified" } });
    expect(doctorHostDatabase({ databasePath: f.databasePath }).readiness.reasonCodes).toContain("RESTORE_GIT_STATE_UNVERIFIED");
    const forged = { ...owner } as HostOwnerHandle;
    await expect(restoreHostBackup({ ...offline, owner: forged, directory: backup, rollbackDirectory: join(f.root, "never") })).rejects.toThrow("verified Host owner");
  });
  it("refuses retained owners and asynchronous staging hooks before installation", async () => {
    const f = await fixture(); const directory = join(f.root, "backup"); await f.operations.backup(directory); f.store.close(); f.owner.release();
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory, coordinationDirectory: f.coordinationDirectory, mode: "maintenance" }); owners.push(owner);
    const options = { owner, databasePath: f.databasePath, identityDirectory: f.identityDirectory, applicationVersion: "test", directory, rollbackDirectory: join(f.root, "rollback"), assertDatabaseClosed: () => expect(f.store.db.open).toBe(false) };
    owner.retain("producer_stop_unverified");
    try { await expect(restoreHostBackup(options)).rejects.toThrow("RESTORE_PRODUCERS_UNVERIFIED"); }
    finally { owner.clearRetention({ ownerId: owner.ownerId, ownerGeneration: owner.generation, evidenceId: "test-proof", turnId: "test-turn", attemptId: "test-attempt", resourceKeys: owner.resourceKeys }, () => true); }
    await expect(stat(options.rollbackDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(restoreHostBackup({ ...options, prepareRestoredDatabase: async () => {} })).rejects.toThrow("RESTORE_ASYNC_PREPARATION");
    const current = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    try { expect(current.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()).toBeUndefined(); } finally { current.close(); }
  });

  it("never modifies future-schema files when CLI Doctor/validation fails closed", async () => {
    const f = await fixture(); f.store.db.pragma("user_version = 999"); f.store.db.pragma("wal_checkpoint(TRUNCATE)"); f.store.close();
    const before = digest(await readFile(f.databasePath));
    expect(doctorHostDatabase({ databasePath: f.databasePath }).readiness.reasonCodes).toContain("SCHEMA_TOO_NEW");
    expect(digest(await readFile(f.databasePath))).toBe(before);
    const read = new Database(f.databasePath, { readonly: true, fileMustExist: true }); try { expect(read.pragma("user_version", { simple: true })).toBe(999); } finally { read.close(); }
  });
});
