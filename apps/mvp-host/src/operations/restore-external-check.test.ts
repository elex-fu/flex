import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openForMaintenance } from "../storage/open-store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { BackupService } from "./backup-service.js";
import { operationOwnerFromHost } from "./operation-files.js";
import { RestoreExternalCheckService, restoreExternalBindingDigest, type RestoreExternalBinding, type RestoreExternalObservation } from "./restore-external-check.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-restore-check-")); await chmod(root, 0o700);
  const identityDirectory = join(root, "identity"); const databasePath = join(root, "host.sqlite"); const backupDirectory = join(root, "backup");
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory, coordinationDirectory: join(root, "owners"), mode: "maintenance" });
  const store = openForMaintenance({ databasePath, owner });
  cleanups.push(async () => { store.close(); owner.release(); await rm(root, { recursive: true, force: true }); });
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const session = store.createSession("/checkout/app");
  store.db.prepare("UPDATE sessions SET recovery_state='blocked',recovery_revision=7 WHERE id=?").run(session.id);
  store.db.prepare("INSERT INTO workspaces(id,canonical_root,worktree_root,checkout_key,kind,state,repository_id,capabilities_json,created_at,updated_at) VALUES('workspace','/checkout/app','/checkout','checkout-key','local','needs_verification','repository','[]','now','now')").run();
  const withSnapshot = async <T>(work: () => Promise<T>) => work();
  const backup = await new BackupService().create({ db: store.db, owner: operationOwnerFromHost(owner), identityDirectory, directory: backupDirectory, applicationVersion: "fixture", supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot });
  const gate = { v: 1, status: "external_state_unverified", restoredAt: new Date().toISOString(), backupCreatedAt: backup.manifest.createdAt,
    backupManifestDigest: restoreExternalBindingDigest(backup.manifest), possibleDispatchIntents: 0, reasonCodes: ["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"], relayRegistrationInvalidated: false };
  store.db.prepare("INSERT INTO host_state(key,value_json,updated_at) VALUES('restore_readiness',?,'now')").run(JSON.stringify(gate));
  let mutate: (value: RestoreExternalObservation) => RestoreExternalObservation = (value) => value;
  let now = new Date();
  const options = { db: store.db, owner, backupDirectory, identityDirectory, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot,
    now: () => now,
    inspectExternal: async (binding: RestoreExternalBinding): Promise<RestoreExternalObservation> => mutate({ version: 1, bindingDigest: restoreExternalBindingDigest(binding),
      supervisor: { sourceId: "fixture-supervisor-log", since: binding.backupCreatedAt, coverage: "complete", launches: [], unresolvedCommandIds: [] },
      checkouts: binding.workspaces.map((workspace) => ({ workspaceId: workspace.id, checkoutRoot: workspace.checkoutRoot, checkoutKey: workspace.checkoutKey, state: "verified", sourceId: "fixture-checkout", refsDigest: "a".repeat(64) })),
      histories: binding.nativeHandles.map((handle) => ({ handleId: String(handle.id), state: "verified", sourceId: "fixture-native-history", historyDigest: "b".repeat(64) })) }) };
  const service = new RestoreExternalCheckService(options);
  return { store, session, service, gate, options, mutate: (change: typeof mutate) => { mutate = change; }, advance: () => { now = new Date(now.getTime() + 90_000); } };
}
describe("restore external maintenance receipts", () => {
  it("persists restore_check evidence and only clears restore gate after fresh confirmation", async () => {
    const f = await fixture(); const evidence = await f.service.inspectState({ commandId: "inspect" });
    expect(evidence).toMatchObject({ state: "ready", revision: 1 });
    expect(f.store.db.prepare("SELECT kind,state FROM host_execution_operations WHERE id=?").get(evidence.operationId)).toEqual({ kind: "restore_check", state: "ready" });
    expect(await f.service.inspectState({ commandId: "inspect" })).toEqual(evidence);
    const confirmed = await f.service.confirmState({ operationId: evidence.operationId, evidenceId: evidence.evidenceId, expectedRevision: evidence.revision });
    expect(confirmed).toMatchObject({ state: "completed", revision: 2 });
    expect(f.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()).toBeUndefined();
    expect(f.store.getSession(f.session.id)).toMatchObject({ recoveryState: "blocked", recoveryRevision: 7 });
  });
  it("never treats missing command receipts as proof that post-backup commands did not execute", async () => {
    const f = await fixture(); f.mutate((value) => ({ ...value, supervisor: { ...value.supervisor, unresolvedCommandIds: ["missing-from-backup"] } }));
    const evidence = await f.service.inspectState({ commandId: "inspect-missing" });
    expect(evidence).toMatchObject({ state: "rejected", reasonCodes: ["RESTORE_ORIGINAL_OPERATIONS_UNRESOLVED"] });
    await expect(f.service.confirmState({ operationId: evidence.operationId, evidenceId: evidence.evidenceId, expectedRevision: evidence.revision })).rejects.toThrow("RESTORE_CHECK_STALE");
    expect(f.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()).toBeDefined();
  });
  it("accepts stopped same-owner helper launches and rejects them without durable full-tree stop proof", async () => {
    const f = await fixture();
    const launch = { launchId: "inspection-helper-launch", launchDigest: "d".repeat(64), state: "stopped" as const,
      stop: { kind: "process-tree-stopped" as const, sourceId: "supervisor-stop-ledger", contractId: "pidns-v1", launchDigest: "d".repeat(64) } };
    f.mutate((value) => ({ ...value, supervisor: { ...value.supervisor, launches: [launch] } }));
    expect(await f.service.inspectState({ commandId: "helper-stopped" })).toMatchObject({ state: "ready", reasonCodes: [] });
    f.mutate((value) => ({ ...value, supervisor: { ...value.supervisor, launches: [{ ...launch, state: "running" }] } }));
    expect(await f.service.inspectState({ commandId: "helper-running" })).toMatchObject({ state: "rejected", reasonCodes: ["RESTORE_ORIGINAL_OPERATIONS_UNRESOLVED"] });
    const { stop: _missingStop, ...launchWithoutStop } = launch;
    f.mutate((value) => ({ ...value, supervisor: { ...value.supervisor, launches: [launchWithoutStop] } }));
    expect(await f.service.inspectState({ commandId: "helper-stop-missing" })).toMatchObject({ state: "rejected", reasonCodes: ["RESTORE_ORIGINAL_OPERATIONS_UNRESOLVED"] });
    expect(f.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()).toBeDefined();
  });
  it("requires complete supervisor coverage and exact checkout root", async () => {
    const f = await fixture(); f.mutate((value) => ({ ...value, supervisor: { ...value.supervisor, coverage: "unknown" }, checkouts: value.checkouts.map((check) => ({ ...check, checkoutRoot: "/checkout/app" })) }));
    expect(await f.service.inspectState({ commandId: "bad-checks" })).toMatchObject({ state: "rejected", reasonCodes: ["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_SUPERVISOR_COVERAGE_UNVERIFIED"] });
  });
  it.each(["revision", "expiry", "database", "external"] as const)("rejects %s changes before confirmation without releasing gates", async (change) => {
    const f = await fixture(); const evidence = await f.service.inspectState({ commandId: `inspect-${change}` });
    if (change === "expiry") f.advance();
    if (change === "database") f.store.db.prepare("UPDATE sessions SET recovery_revision=recovery_revision+1 WHERE id=?").run(f.session.id);
    if (change === "external") f.mutate((value) => ({ ...value, checkouts: value.checkouts.map((check) => ({ ...check, refsDigest: "c".repeat(64) })) }));
    await expect(f.service.confirmState({ operationId: evidence.operationId, evidenceId: evidence.evidenceId, expectedRevision: evidence.revision + (change === "revision" ? 1 : 0) })).rejects.toThrow("RESTORE_CHECK_STALE");
    expect(f.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()).toBeDefined();
  });
  it("cannot confirm a legacy gate lacking exact backup provenance", async () => {
    const f = await fixture(); const { backupManifestDigest: _, ...legacy } = f.gate;
    f.store.db.prepare("UPDATE host_state SET value_json=? WHERE key='restore_readiness'").run(JSON.stringify(legacy));
    await expect(f.service.inspectState({ commandId: "legacy" })).rejects.toThrow("RESTORE_BACKUP_BINDING_MISSING");
  });
});
