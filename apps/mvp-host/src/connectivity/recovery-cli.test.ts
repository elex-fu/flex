import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import type { ProcessInspector } from "../lifecycle/process-inspector.js";
import { WorkspaceLease } from "../workspace/workspace-lease.js";
import { LEGACY_V2_SCHEMA } from "../test-support/legacy-v2-schema.js";
import { applyCommandExecutionMigration } from "../storage/migrations/004-command-execution.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { openForRecoveryMaintenance, openReadOnly } from "../storage/open-store.js";
import { parseRecoveryCommand, runOfflineRecovery } from "./recovery-cli.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const inspector: ProcessInspector = { currentIdentity: () => ({ pid: 123, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "42" } }), inspect: () => ({ state: "exited", reason: "deterministic original Host exit" }) };
function fixture(state: "not_spawned" | "root_exited" = "not_spawned", crash: { unretained?: boolean; noJournal?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "flyx-offline-recovery-")); roots.push(root);
  const workspace = join(root, "checkout"); mkdirSync(workspace);
  const options = { databasePath: join(root, "data", "host.sqlite"), identityDirectory: join(root, "data", "identity"), coordinationDirectory: join(root, "coordination"), inspector };
  mkdirSync(join(root, "data"));
  const original = HostOwnerLock.acquire(options);
  const lease = WorkspaceLease.acquire({ workspace, owner: original, operationId: "original-turn", inspector });
  const db = new Database(options.databasePath);
  // A pinned legacy baseline plus the actual installed 003/004 alterations, never a relabeled newer database.
  db.exec(LEGACY_V2_SCHEMA);
  db.exec(`ALTER TABLE auth_sessions ADD COLUMN device_id TEXT REFERENCES devices(id);
    ALTER TABLE devices ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pairing_grants ADD COLUMN host_id TEXT;
    ALTER TABLE pairing_grants ADD COLUMN requested_scopes TEXT;
    ALTER TABLE pairing_grants ADD COLUMN approved_at TEXT;
    ALTER TABLE pairing_grants ADD COLUMN device_id TEXT REFERENCES devices(id);
    INSERT INTO schema_migrations VALUES(3,'legacy-003');`);
  applyCommandExecutionMigration(db);
  db.prepare(`INSERT INTO sessions(id,workspace_path,provider,status,activity_state,head_sequence,created_at,updated_at) VALUES('original-session',?,'claude','active','outcome_unknown',0,'then','then')`).run(workspace);
  db.prepare(`INSERT INTO turns(id,session_id,auth_subject_id,command_id,request_hash,status,prompt,generation,attempt_id,created_at)
    VALUES('original-turn','original-session','original-actor','original-command','original-hash','outcome_unknown','possibly sent',1,'original-attempt','then')`).run();
  db.prepare(`INSERT INTO command_receipts(auth_subject_id,command_id,method,request_hash,state,response_json,target_session_id,request_format_version,created_at,updated_at)
    VALUES('original-actor','original-command','session.startTurn','original-hash','outcome_unknown','{}','original-session',2,'then','then')`).run();
  if (!crash.noJournal) db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,tree_control,state,updated_at)
    VALUES('original-process',?,?,'original-runtime',1,'original-attempt','original-session','original-turn',?,'unavailable',?,'then')`).run(original.ownerId, original.generation, state === "not_spawned" ? null : 123, state);
  db.close(); if (!crash.unretained) { lease.retain("producer_stop_unverified"); original.retain("producer_stop_unverified"); }
  const retained = () => readdirSync(options.coordinationDirectory).filter((path) => path.endsWith(".owner")).sort().map((path) => readFileSync(join(options.coordinationDirectory, path)).toString());
  const inspect = (upgradeMetadata: boolean) => ({ kind: "recovery" as const, action: "inspect" as const, sessionId: "original-session", turnId: "original-turn", attemptId: "original-attempt", upgradeMetadata });
  return { options, retained, inspect, original };
}

describe("offline recovery CLI under retained original guards", () => {
  it("requires explicit unknown acknowledgement and rejects caller-supplied process conclusions", () => {
    expect(parseRecoveryCommand(["recovery", "inspect", "session", "turn", "--upgrade-metadata"])).toMatchObject({ action: "inspect", upgradeMetadata: true });
    expect(() => parseRecoveryCommand(["recovery", "acknowledge", "session", "turn", "evidence", "1", "recovery-command"])).toThrow("acknowledge-unknown");
    expect(() => parseRecoveryCommand(["recovery", "inspect", "session", "turn", "--tree-stopped"])).toThrow("Unsupported");
  });

  it("explicitly upgrades retained v4 metadata, acknowledges a proven never-spawned original attempt, then releases only committed exact resources", async () => {
    const f = fixture(); const before = f.retained();
    await expect(runOfflineRecovery(f.inspect(false), f.options)).rejects.toMatchObject({ code: "RECOVERY_SCHEMA_UPGRADE_REQUIRED" }); expect(f.retained()).toEqual(before);
    const evidence = await runOfflineRecovery(f.inspect(true), f.options);
    expect(evidence).toMatchObject({ processState: "stopped", workspaceState: "clear", nativeState: "unknown" }); expect(f.retained()).toEqual(before);
    if (!("evidenceId" in evidence)) throw new Error("Inspection result required");
    const command = { ...f.inspect(false), action: "acknowledge" as const, commandId: "local-recovery-command", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, acknowledgeUnknown: true as const };
    const result = await runOfflineRecovery(command, f.options);
    expect(result).toMatchObject({ state: "completed", gate: "released", turnStatus: "outcome_unknown", ownershipReleased: true });
    expect(readdirSync(f.options.coordinationDirectory).filter((file) => file.endsWith(".owner") || file.endsWith(".maintenance"))).toEqual([]);
    const store = openReadOnly(f.options.databasePath);
    try {
      expect(store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 5 });
      expect(store.getActiveTurn("original-session")).toBeUndefined();
      expect(store.getTurn("original-turn")).toMatchObject({ status: "outcome_unknown", authSubjectId: "original-actor", attemptId: "original-attempt" });
      expect(store.getCommandReceipt("original-actor", "original-command")).toMatchObject({ state: "outcome_unknown", response: { acknowledged: true } });
      expect(store.getCommandReceipt(`local-recovery:${f.original.ownerId}`, "local-recovery-command")?.state).toBe("completed");
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM native_turn_bindings").get()).toEqual({ n: 0 });
    } finally { store.close(); }
    const successor = HostOwnerLock.acquire(f.options); successor.release();
  });

  it("unblocks persisted session residency after a proven offline release on catalog databases", async () => {
    const f = fixture();
    // A catalog-era (007+) database also carries session_catalog; a released
    // offline recovery must reconcile its residency exactly like the live
    // Host's afterRecovery hook, or the next start stays HOST_RECOVERY_REQUIRED.
    const catalog = new Database(f.options.databasePath);
    catalog.exec(`CREATE TABLE session_catalog (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, provider_instance_id TEXT NOT NULL, title TEXT, native_handle_json TEXT, residency_state TEXT NOT NULL, archived_at TEXT)`);
    catalog.prepare("INSERT INTO session_catalog VALUES('original-session','instance','Original',NULL,'blocked',NULL)").run();
    catalog.close();
    const evidence = await runOfflineRecovery(f.inspect(true), f.options);
    if (!("evidenceId" in evidence)) throw new Error("Inspection result required");
    const result = await runOfflineRecovery({ ...f.inspect(false), action: "acknowledge", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, commandId: "residency-reconcile", acknowledgeUnknown: true }, f.options);
    expect(result).toMatchObject({ state: "completed", gate: "released", ownershipReleased: true });
    const store = openReadOnly(f.options.databasePath);
    try {
      expect(store.db.prepare("SELECT residency_state FROM session_catalog WHERE session_id='original-session'").get()).toEqual({ residency_state: "unloaded" });
      expect(store.db.prepare("SELECT type FROM session_events WHERE session_id='original-session' ORDER BY id DESC LIMIT 1").get()).toEqual({ type: "session.recovery.residency.reconciled" });
    } finally { store.close(); }
  });

  it("holds unretained original crash files unchanged and still denies proof-free release or normal writers", async () => {
    const f = fixture("not_spawned", { unretained: true }); const before = f.retained();
    const scope = HostOwnerLock.acquireForRecoveryMaintenance(f.options);
    expect(scope.retainedReason).toBeUndefined(); expect(f.retained()).toEqual(before);
    expect(() => scope.release()).toThrow("committed stop evidence");
    const restricted = openForRecoveryMaintenance({ databasePath: scope.databasePath, owner: scope });
    expect(() => restricted.createSession("/forbidden-business")).toThrow("HOST_RECOVERY_ONLY");
    const workspace = (restricted.db.prepare("SELECT workspace_path FROM sessions WHERE id='original-session'").get() as { workspace_path: string }).workspace_path;
    expect(() => new SessionOrchestrator({ workspace, owner: scope, store: restricted })).toThrow("HOST_RECOVERY_ONLY");
    scope.assertActive(); expect(restricted.getTurn("original-turn")?.status).toBe("outcome_unknown"); restricted.close();
    scope.closeMaintenance(); expect(f.retained()).toEqual(before);
    const evidence = await runOfflineRecovery(f.inspect(true), f.options);
    if (!("evidenceId" in evidence)) throw new Error("Inspection result required");
    expect(f.retained()).toEqual(before);
    expect(await runOfflineRecovery({ ...f.inspect(false), action: "acknowledge", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, commandId: "recover-hard-crash", acknowledgeUnknown: true }, f.options))
      .toMatchObject({ gate: "released", ownershipReleased: true, turnStatus: "outcome_unknown" });
  });

  it("refuses live or unverifiable original Host identity even when crash files were unretained", async () => {
    const f = fixture("not_spawned", { unretained: true }); const before = f.retained();
    for (const state of ["alive", "unknown"] as const) {
      await expect(runOfflineRecovery(f.inspect(true), { ...f.options, inspector: { currentIdentity: inspector.currentIdentity, inspect: () => ({ state, reason: "unproved original exit" }) } })).rejects.toThrow("cannot be proven exited");
      expect(f.retained()).toEqual(before);
      expect(readdirSync(f.options.coordinationDirectory).filter((file) => file.endsWith(".maintenance"))).toEqual([]);
    }
  });

  it("cannot release an unretained crash with no original launch journal or invent stop evidence", async () => {
    const f = fixture("not_spawned", { unretained: true, noJournal: true }); const before = f.retained();
    const evidence = await runOfflineRecovery(f.inspect(true), f.options);
    expect(evidence).toMatchObject({ processState: "unknown", nativeState: "unknown" });
    if (!("evidenceId" in evidence)) throw new Error("Inspection result required");
    expect(await runOfflineRecovery({ ...f.inspect(false), action: "acknowledge", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, commandId: "no-launch-proof", acknowledgeUnknown: true }, f.options))
      .toMatchObject({ state: "blocked", gate: "blocked", ownershipReleased: false });
    expect(f.retained()).toEqual(before);
  });

  it("keeps a launched legacy attempt blocked after additive upgrade when strong birth/tree proof was never persisted", async () => {
    const f = fixture("root_exited"); const before = f.retained();
    const evidence = await runOfflineRecovery(f.inspect(true), f.options);
    expect(evidence).toMatchObject({ processState: "unknown", nativeState: "unknown" });
    if (!("evidenceId" in evidence)) throw new Error("Inspection result required");
    const result = await runOfflineRecovery({ ...f.inspect(false), action: "acknowledge", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, commandId: "must-stay-blocked", acknowledgeUnknown: true }, f.options);
    expect(result).toMatchObject({ state: "blocked", gate: "blocked", ownershipReleased: false }); expect(f.retained()).toEqual(before);
    expect(() => HostOwnerLock.acquire(f.options)).toThrow("Another Host");
  });
});
