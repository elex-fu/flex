import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryCapability, type SessionEvent } from "@flyx/mvp-protocol";
import { createHostCatalogBindings } from "../catalog/host-catalog.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import type { ProcessIdentity, ProcessInspector } from "../lifecycle/process-inspector.js";
import type { ProviderAdapter, DispatchContext } from "../provider/types.js";
import type { AppServerClient } from "../codex/app-server-client.js";
import { RecoveryStore } from "../storage/recovery-store.js";
import { openOwned } from "../storage/open-store.js";
import { inspectSchema } from "../storage/migrations/schema-version.js";
import { SessionOrchestrator } from "./orchestrator.js";
import type { SessionRuntimeContext } from "./session-registry.js";
import { createCatalogRecoveryBindings, catalogRecoveryConfigurationFingerprint } from "./catalog-recovery.js";
import type { CatalogRecoveryBindings, CatalogRecoveryOptions, CatalogRecoveryIdentity, CachedCatalogRecoveryManifest, ExistingCatalogRecoveryReader } from "./catalog-recovery.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const identity: ProcessIdentity = { pid: 123, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "42" } };
const inspector: ProcessInspector = { currentIdentity: () => identity, inspect: () => ({ state: "exited", reason: "original birth exited" }) };
function manifest(target: CatalogRecoveryIdentity): CachedCatalogRecoveryManifest {
  return { source: "real-provider", state: "verified", evidenceId: "cached-acceptance-contract", provider: target.provider,
    providerInstanceId: target.providerInstanceId, configurationFingerprint: target.configurationFingerprint, verifiedVersions: ["verified-v1"] };
}
function existingReader(target: CatalogRecoveryIdentity, client: Pick<AppServerClient, "request">): ExistingCatalogRecoveryReader {
  return { source: "existing-connection", sessionId: target.sessionId, providerInstanceId: target.providerInstanceId,
    configurationFingerprint: target.configurationFingerprint, runtimeVersion: "verified-v1", client };
}
async function fixture(extra: Omit<CatalogRecoveryOptions, "catalog"> = {}, live = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-catalog-recovery-")));
  const checkout = join(root, "checkout"); const workspace = join(checkout, "app");
  mkdirSync(workspace, { recursive: true }); execFileSync("git", ["init", "--quiet", checkout]);
  const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
  cleanups.push(() => { if (store.db.open) store.close(); owner.release(); rmSync(root, { recursive: true, force: true }); });
  store.setHostIdentityMirror({ hostId: "host", fingerprint: "a".repeat(64) });
  for (const [id, scopes, hostId] of [["writer", ["session:read", "session:write"], "host"], ["reader", ["session:read"], "host"], ["foreign", ["session:write"], "foreign-host"]] as const)
    store.createDevice({ id, hostId, scopes: [...scopes], platform: "test", credentialKind: "browser-session", credentialRevision: 1, createdAt: new Date().toISOString() });
  const denied = new Set<string>(); let bindings!: CatalogRecoveryBindings;
  const runTurn = vi.fn(async () => { throw new Error("No Provider dispatch in recovery"); });
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => { throw new Error("No Provider version probe"); }, preflight: async () => { throw new Error("No paid preflight"); },
    runTurn, interrupt: async () => "unavailable", respondApproval: () => false, closeAndWait: async () => ({ stopped: true, treeStopped: true, records: [] }) };
  const runtimeFactory = vi.fn((context: SessionRuntimeContext) => {
    if (!live) throw new Error("Recovery must never load a Provider");
    return new SessionOrchestrator({ store: context.store, owner: context.owner, ownsStore: false, recoverOnStart: false,
      sessionId: context.session.sessionId, runtimeId: context.runtimeId, workspace: context.workspace.canonicalRoot,
      checkoutRoot: context.workspace.worktreeRoot, adapter, recovery: bindings.runtimeRecoveryOptions(context) });
  });
  const host = await createHostCatalogBindings({ store, owner,
    configuration: { workspaces: [{ workspaceId: "workspace", root: workspace }], providerInstances: (["claude", "codex"] as const).map((provider) => ({ providerInstanceId: `instance-${provider}`, provider, executable: process.execPath, policyCapabilities: live ? ["workspaceWrite"] : [] })) },
    initialLegacySession: { workspaceId: "workspace", providerInstanceId: "instance-claude" }, runtimeFactory,
    assertSessionAccess: (actor, target) => { if (denied.has(`${actor}:${target.session.sessionId}`)) throw Object.assign(new Error("Session grant revoked"), { code: "FORBIDDEN" }); } });
  bindings = createCatalogRecoveryBindings({ catalog: host, ...extra });
  // Seed owned historical facts without claiming current Provider verification.
  const codex = host.catalog.create({ authSubjectId: "writer", commandId: "create-codex" }, { workspaceId: "workspace", providerInstanceId: "instance-codex", title: "Recovery target" }, { workspace: host.workspaces.require("workspace"), provider: host.providers.require("instance-codex") }).summary.sessionId;
  const unknown = (sessionId = codex, fingerprint?: string) => {
    const start = `start:${sessionId}`; const turnId = `turn:${sessionId}`; const attemptId = `attempt:${sessionId}`;
    store.acceptTurn({ authSubjectId: "writer", sessionId, turnId, commandId: start, requestHash: `hash:${sessionId}`, prompt: "original prompt", generation: 1, attemptId });
    const context: DispatchContext = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId, flyxTurnId: turnId,
      runtimeId: `runtime:${sessionId}`, runtimeGeneration: 1, attemptId };
    const target = host.registry.resolve(sessionId);
    new RecoveryStore(store).recordNativeBinding({ context, provider: target.session.provider, providerInstanceId: target.session.providerInstanceId,
      nativeSessionId: `native-session:${sessionId}`, ...(target.session.provider === "codex" ? { nativeTurnId: `native-turn:${sessionId}` } : {}),
      workspacePath: workspace, configurationFingerprint: fingerprint ?? catalogRecoveryConfigurationFingerprint(target), verifiedVersion: "verified-v1" });
    store.commitEvent(sessionId, "turn.unknown", { turnId }, { turnId, turnStatus: "outcome_unknown", activityState: "outcome_unknown",
      commandReceipt: { authSubjectId: "writer", commandId: start, state: "outcome_unknown", response: { turnId, status: "outcome_unknown" } } });
    host.catalog.setResidency(sessionId, "blocked");
    return { sessionId, turnId, attemptId, context, start };
  };
  const recordProcess = (context: DispatchContext) => {
    store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
      VALUES('original-process',?,?,?,?,?,?,?,123,123,'process_group','root_exited','now')`)
      .run(context.hostOwnerId, context.hostOwnerGeneration, context.runtimeId, context.runtimeGeneration, context.attemptId, context.sessionId, context.flyxTurnId);
    store.db.prepare("INSERT INTO managed_process_identities(process_id,identity_json) VALUES('original-process',?)").run(JSON.stringify(identity));
    const boundary = { version: 1, boundaryId: "12345678-1234-1234-1234-123456789abc", platform: "linux", backend: "linux_bubblewrap", kernelRelease: "fixture", backendVersion: "fixture", backendDigest: "a".repeat(64), policyDigest: "b".repeat(64), evidenceDigest: "c".repeat(64), verifiedPrivateReadBoundary: true, verifiedPrivateWriteBoundary: true, verifiedChildInheritance: true, treeIsolation: "linux_pid_namespace", verifiedDescendantStop: true };
    store.db.prepare("INSERT INTO managed_process_boundaries(process_id,proof_json,launch_digest) VALUES('original-process',?,?)").run(JSON.stringify(boundary), "d".repeat(64));
  };
  cleanups.push(async () => { await host.closeAndWait(100); });
  return { root, checkout, workspace, owner, store, host, bindings, codex, denied, runtimeFactory, runTurn, unknown, recordProcess };
}
function terminalClient() {
  const request = vi.fn(async (method: string, params: unknown) => { const id = (params as { threadId: string }).threadId;
    expect(method).toBe("thread/read"); return { thread: { id, turns: [{ id: id.replace("native-session:", "native-turn:"), status: "completed" }] } }; });
  return { request, client: { request: request as unknown as AppServerClient["request"] } };
}

describe("Catalogue recovery without Provider residency", () => {
  it("reads SQL10 unloaded/blocked Sessions without probing, loading or promoting Catalog verification", async () => {
    const reader = terminalClient(); const lookup = vi.fn((target: CatalogRecoveryIdentity) => existingReader(target, reader.client));
    const f = await fixture({ existingCodexReader: lookup }); const original = f.unknown();
    f.host.providers.recordVerification("instance-codex", { state: "verified", runtimeVersion: "verified-v1", capabilities: [] });
    expect(inspectSchema(f.store.db).version).toBe(11); expect(f.bindings.recoveryCapabilities()).toEqual([RecoveryCapability]);
    const intents = f.store.db.prepare("SELECT id,state FROM execution_intents ORDER BY id").all();
    const recovery = f.bindings.recoveryForSession(f.codex)!;
    expect(recovery).toBe(f.bindings.recoveryForSession(f.codex));
    expect(await recovery.inspect(original)).toMatchObject({ nativeState: "unknown", processState: "unknown" });
    expect(lookup).not.toHaveBeenCalled(); expect(reader.request).not.toHaveBeenCalled();
    expect(f.runtimeFactory).not.toHaveBeenCalled(); expect(f.runTurn).not.toHaveBeenCalled();
    expect(f.host.registry.loaded(f.codex)).toBeUndefined();
    expect(f.store.db.prepare("SELECT id,state FROM execution_intents ORDER BY id").all()).toEqual(intents);
    f.store.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(12,'future')").run();
    expect(f.bindings.recoveryCapabilities()).toEqual([]); expect(f.bindings.recoveryForSession(f.codex)).toBeUndefined();
  });

  it("binds live capture and recovery fingerprints while excluding mutable observed verification and residency", async () => {
    const f = await fixture({}, true);
    const before = catalogRecoveryConfigurationFingerprint(f.host.registry.resolve(f.host.legacySessionId));
    f.host.providers.recordVerification("instance-claude", { state: "verified", runtimeVersion: "version-probe", capabilities: ["workspaceWrite"] });
    const runtime = await f.host.registry.ensureLoaded(f.host.legacySessionId);
    if (!(runtime instanceof SessionOrchestrator)) throw new Error("Expected the supplied live recovery runtime");
    expect(catalogRecoveryConfigurationFingerprint(f.host.registry.resolve(f.host.legacySessionId))).toBe(before);
    expect(f.bindings.recoveryForSession(f.host.legacySessionId)).toBe(runtime.recovery);
    expect(f.runtimeFactory).toHaveBeenCalledTimes(1); expect(f.runTurn).not.toHaveBeenCalled();
    const context: DispatchContext = { hostOwnerId: f.owner.ownerId, hostOwnerGeneration: f.owner.generation, sessionId: runtime.sessionId,
      flyxTurnId: "capture", runtimeId: runtime.runtimeId, runtimeGeneration: 1, attemptId: "capture-attempt" };
    const options = f.bindings.runtimeRecoveryOptions(f.runtimeFactory.mock.calls[0]![0]);
    expect(options.resolveResource!({ sessionId: runtime.sessionId, turnId: "capture", context, provider: "claude" }))
      .toMatchObject({ providerInstanceId: "instance-claude", workspacePath: f.workspace, configurationFingerprint: before, verifiedVersions: [] });
    expect(options.checkoutRoot).toBe(f.checkout);
  });

  it("recovers only the original native Turn through an existing verified connection and publishes through shared Views", async () => {
    const reader = terminalClient(); const companion = vi.fn(() => [{ type: "interaction.superseded", payload: { deliveryState: "unconfirmed" } }]);
    const supersede = vi.fn();
    const f = await fixture({ verifiedManifestForInstance: manifest, existingCodexReader: (target) => existingReader(target, reader.client), companionEvents: companion, supersedeInteractions: supersede });
    const original = f.unknown(); const recovery = f.bindings.recoveryForSession(f.codex)!;
    const observed: SessionEvent[] = []; f.host.registry.subscribe(f.codex, (event) => observed.push(event));
    const evidence = await recovery.inspect(original);
    expect(evidence).toMatchObject({ nativeState: "terminal", nativeOutcome: "completed", processState: "unknown" });
    const result = await recovery.reconcile({ ...original, authSubjectId: "writer", commandId: "recover-native", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    expect(result).toMatchObject({ turnStatus: "completed", gate: "blocked" });
    expect(f.store.getCommandReceipt("writer", original.start)?.state).toBe("completed");
    expect(f.store.getSession(f.codex)?.recoveryState).toBe("blocked");
    expect(f.host.catalog.requireSession(f.codex).residency).toBe("blocked");
    expect(reader.request).toHaveBeenCalledWith("thread/read", { threadId: `native-session:${f.codex}`, includeTurns: true }, 15000);
    expect(companion).toHaveBeenCalledWith(f.codex, original.turnId, "recovery_reconciled");
    expect(supersede).toHaveBeenCalledWith(f.codex, { attemptId: original.attemptId, runtimeGeneration: 1 }, "recovery_settled");
    expect(observed.some((event) => event.type === "turn.recovery.reconciled")).toBe(true); expect(f.host.views?.ready(f.codex)).toBe(true);
    expect(f.runtimeFactory).not.toHaveBeenCalled(); expect(f.runTurn).not.toHaveBeenCalled();
  });

  it.each(["fixture-manifest", "foreign-config", "malformed-manifest", "fresh-reader", "reader-version", "legacy-binding"])("keeps %s native evidence unknown", async (mismatch) => {
    const reader = terminalClient();
    const f = await fixture({ verifiedManifestForInstance: (target) => ({ ...manifest(target), ...(mismatch === "fixture-manifest" ? { source: "fixture" as never } : {}), ...(mismatch === "foreign-config" ? { configurationFingerprint: "other" } : {}), ...(mismatch === "malformed-manifest" ? { evidenceId: 1 as never } : {}) }),
      existingCodexReader: (target) => ({ ...existingReader(target, reader.client), ...(mismatch === "fresh-reader" ? { source: "new-connection" as never } : {}), ...(mismatch === "reader-version" ? { runtimeVersion: "unverified-version-probe" } : {}) }) });
    const original = f.unknown(f.codex, mismatch === "legacy-binding" ? "unknown" : undefined);
    expect((await f.bindings.recoveryForSession(f.codex)!.inspect(original)).nativeState).toBe("unknown");
    expect(reader.request).not.toHaveBeenCalled(); expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it.each(["grant", "manifest"])("rechecks current %s evidence after async inspection before settling the original receipt", async (changed) => {
    let allowed = true; let reads = 0; let release!: () => void;
    const barrier = new Promise<void>((yes) => { release = yes; });
    const request = vi.fn(async (_method: string, params: unknown) => { if (++reads === 2) await barrier; const id = (params as { threadId: string }).threadId;
      return { thread: { id, turns: [{ id: id.replace("native-session:", "native-turn:"), status: "completed" }] } }; });
    const f = await fixture({ verifiedManifestForInstance: (target) => allowed ? manifest(target) : undefined,
      existingCodexReader: (target) => existingReader(target, { request: request as unknown as AppServerClient["request"] }) });
    const original = f.unknown(); const recovery = f.bindings.recoveryForSession(f.codex)!;
    const evidence = await recovery.inspect(original); const receipt = f.store.getCommandReceipt("writer", original.start);
    const pending = recovery.reconcile({ ...original, authSubjectId: "writer", commandId: `recover-${changed}`, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    await new Promise<void>((yes) => setImmediate(yes));
    expect(f.store.getCommandReceipt("writer", `recover-${changed}`)?.state).toBe("accepted");
    if (changed === "grant") f.denied.add(`writer:${f.codex}`); else allowed = false;
    release(); await expect(pending).rejects.toMatchObject({ code: changed === "grant" ? "FORBIDDEN" : "RECOVERY_EVIDENCE_STALE" });
    expect(f.store.getTurn(original.turnId)?.status).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("writer", original.start)).toEqual(receipt);
    expect(f.store.getCommandReceipt("writer", `recover-${changed}`)?.state).toBe("failed");
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it("rejects foreign or read-only actors and changed immutable Catalog configuration before recovery markers", async () => {
    const f = await fixture(); const original = f.unknown(); const recovery = f.bindings.recoveryForSession(f.codex)!;
    const evidence = await recovery.inspect(original);
    const input = { ...original, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision };
    for (const actor of ["foreign", "reader"]) {
      await expect(recovery.reconcile({ ...input, authSubjectId: actor, commandId: `recover-${actor}` })).rejects.toMatchObject({ code: actor === "foreign" ? "DEVICE_REVOKED" : "SCOPE_REQUIRED" });
      expect(f.store.getCommandReceipt(actor, `recover-${actor}`)).toBeUndefined();
    }
    const provider = f.host.catalog.provider("instance-codex")!;
    f.host.catalog.putProvider({ ...provider, config: { ...provider.config, model: "changed-config" } });
    await expect(recovery.reconcile({ ...input, authSubjectId: "writer", commandId: "old-config" })).rejects.toMatchObject({ code: "RECOVERY_RESOURCE_MISMATCH" });
    expect(f.store.getCommandReceipt("writer", "old-config")).toBeUndefined();
    expect(f.bindings.recoveryForSession(f.codex)).not.toBe(recovery);
    expect((await f.bindings.recoveryForSession(f.codex)!.inspect(original)).nativeState).toBe("unknown");
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it("requires aggregate owner process stop and keeps a live sibling execution from releasing the checkout", async () => {
    const liveInspector: ProcessInspector = { currentIdentity: () => identity, inspect: (original) => original.pid === 124 ? { state: "alive", reason: "original sibling alive" } : { state: "exited", reason: "original exited" } };
    const f = await fixture({ processInspector: liveInspector, inspectWorkspace: async () => "clear" });
    const original = f.unknown(); f.recordProcess(original.context);
    f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
      VALUES('sibling-process',?,?,'sibling-runtime',1,'sibling-attempt',?,NULL,124,124,'process_group','running','now')`)
      .run(f.owner.ownerId, f.owner.generation, f.host.legacySessionId);
    f.store.db.prepare("INSERT INTO managed_process_identities(process_id,identity_json) VALUES('sibling-process',?)").run(JSON.stringify({ ...identity, pid: 124, birth: { ...identity.birth, startTicks: "43" } }));
    const recovery = f.bindings.recoveryForSession(f.codex)!; const evidence = await recovery.inspect(original);
    expect(evidence).toMatchObject({ processState: "running", workspaceState: "held", nativeState: "unknown" });
    expect(await recovery.acknowledge({ ...original, authSubjectId: "writer", commandId: "sibling-not-stopped", evidenceId: evidence.evidenceId,
      expectedRecoveryRevision: evidence.recoveryRevision, acknowledgeUnknown: true })).toMatchObject({ state: "blocked", gate: "blocked" });
    expect(f.store.getTurn(original.turnId)?.status).toBe("outcome_unknown");
    expect(f.host.catalog.requireSession(f.codex).residency).toBe("blocked"); expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the actual checkout proof root and preserves unknown history after explicit acknowledgment (release fault: %s)", async (fault) => {
    const release = vi.fn(() => { if (fault) throw new Error("Ownership release failed"); });
    const f = await fixture({ processInspector: inspector, inspectWorkspace: async () => "clear", afterRecovery: release });
    const original = f.unknown(); f.recordProcess(original.context); const recovery = f.bindings.recoveryForSession(f.codex)!;
    const evidence = await recovery.inspect(original);
    expect(evidence).toMatchObject({ processState: "stopped", workspaceState: "clear", nativeState: "unknown" });
    const input = { ...original, authSubjectId: "writer", commandId: "acknowledge", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, acknowledgeUnknown: true as const };
    if (fault) {
      await expect(recovery.acknowledge(input)).rejects.toMatchObject({ code: "RECOVERY_RELEASE_PROOF_INVALID" });
      expect(f.store.getSession(f.codex)).toMatchObject({ activeTurnId: original.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
      expect(f.host.catalog.requireSession(f.codex).residency).toBe("blocked");
      expect(() => f.host.catalog.assertIdle(f.codex)).toThrowError(expect.objectContaining({ code: "RECOVERY_BLOCKED" }));
    } else {
      expect(await recovery.acknowledge(input)).toMatchObject({ gate: "released", turnStatus: "outcome_unknown" });
      expect(f.host.catalog.requireSession(f.codex).residency).toBe("unloaded");
      expect(() => f.host.catalog.assertIdle(f.codex)).not.toThrow();
      const proof = recovery.recovery.releaseProof(evidence.evidenceId, [`workspace:${f.checkout}`])!;
      expect(recovery.recovery.verifyReleaseProof(proof, { resourceKey: `workspace:${f.checkout}`, ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, purpose: `workspace:${original.turnId}` })).toBe(true);
      expect(recovery.recovery.releaseProof(evidence.evidenceId, [`workspace:${f.workspace}`])).toBeUndefined();
      expect(f.host.views?.ready(f.codex)).toBe(true);
    }
    expect(f.store.getTurn(original.turnId)?.status).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("writer", original.start)?.state).toBe("outcome_unknown");
    expect(release).toHaveBeenCalledTimes(1); expect(f.runtimeFactory).not.toHaveBeenCalled(); expect(f.runTurn).not.toHaveBeenCalled();
  });
});


describe("global recovery admission and shutdown", () => {
  it("tracks unloaded and existing loaded RPCs through the same global control lane", async () => {
    const admission = vi.fn(); const tracked = vi.fn();
    const track = <T>(work: () => Promise<T>): Promise<T> => { tracked(); return work(); };
    const f = await fixture({ assertRecoveryAdmission: admission, trackRecovery: track }, true);
    f.host.providers.recordVerification("instance-claude", { state: "verified", runtimeVersion: "fixture-runtime", capabilities: ["workspaceWrite"] });
    const unloaded = f.unknown(); await f.bindings.recoveryForSession(f.codex)!.inspect(unloaded);
    const runtime = await f.host.registry.ensureLoaded(f.host.legacySessionId);
    if (!(runtime instanceof SessionOrchestrator)) throw new Error("Expected live runtime");
    const loaded = f.unknown(runtime.sessionId);
    const bound = f.bindings.recoveryForSession(runtime.sessionId)!;
    expect(bound).toBe(runtime.recovery); await runtime.recovery.inspect(loaded);
    expect(tracked).toHaveBeenCalledTimes(2); expect(admission).toHaveBeenCalled();
    expect(await f.bindings.shutdownService.drain(Date.now() + 100)).toBe(true);
    await expect(bound.inspect(loaded)).rejects.toMatchObject({ code: "RECOVERY_DRAINING" });
    expect(f.bindings.recoveryCapabilities()).toEqual([]);
    expect(f.bindings.recoveryForSession(f.codex)).toBeUndefined();
  });

  it("denies global admission before SQL and before observation starts", async () => {
    let allowed = true; const admission = vi.fn(() => { if (!allowed) throw new Error("HOST_DRAINING"); });
    const reader = terminalClient(); const f = await fixture({ assertRecoveryAdmission: admission, verifiedManifestForInstance: manifest,
      existingCodexReader: (target) => existingReader(target, reader.client) });
    const original = f.unknown(); const bound = f.bindings.recoveryForSession(f.codex)!; allowed = false;
    const sql = vi.spyOn(f.store.db, "prepare");
    await expect(bound.inspect(original)).rejects.toThrow("HOST_DRAINING");
    expect(sql).not.toHaveBeenCalled(); expect(reader.request).not.toHaveBeenCalled(); sql.mockRestore();
  });

  it("drains an admitted inspection using the absolute deadline while keeping unknown projection publication open", async () => {
    let release!: () => void; const barrier = new Promise<void>((yes) => { release = yes; });
    const request = vi.fn(async () => { await barrier; return { thread: { id: "unmatched", turns: [] } }; });
    const f = await fixture({ verifiedManifestForInstance: manifest, existingCodexReader: (target) => existingReader(target, { request: request as unknown as AppServerClient["request"] }) });
    const original = f.unknown(); const bound = f.bindings.recoveryForSession(f.codex)!;
    const pending = bound.inspect(original); const draining = f.bindings.shutdownService.drain(Date.now() + 500);
    await expect(bound.inspect(original)).rejects.toMatchObject({ code: "RECOVERY_DRAINING" });
    const observed: SessionEvent[] = []; f.host.registry.subscribe(f.codex, (event) => observed.push(event));
    const unknown = f.store.commitEvent(f.codex, "execution.control.unknown", { turnId: original.turnId, reason: "Host shutdown original producer still unknown" });
    f.host.registry.publishCommittedEvents([unknown]);
    expect(observed).toContainEqual(unknown); expect(f.host.views?.ready(f.codex)).toBe(true);
    release(); await expect(pending).resolves.toMatchObject({ nativeState: "unknown" });
    expect(await draining).toBe(true); expect(f.store.getTurn(original.turnId)?.status).toBe("outcome_unknown");
  });

  it("registers before accepted publication and seals timed-out reconcile before Store close", async () => {
    let reads = 0; let release!: () => void; const barrier = new Promise<void>((yes) => { release = yes; });
    const request = vi.fn(async (_method: string, params: unknown) => { if (++reads === 2) await barrier; const id = (params as { threadId: string }).threadId;
      return { thread: { id, turns: [{ id: id.replace("native-session:", "native-turn:"), status: "completed" }] } }; });
    let draining: Promise<void | boolean> | undefined; let bindings!: CatalogRecoveryBindings;
    const commits = vi.fn((events: readonly SessionEvent[]) => { if (events.some((event) => event.type === "recovery.operation.marked")) draining = bindings.shutdownService.drain(Date.now() - 1); });
    const supersede = vi.fn(); const after = vi.fn();
    const f = await fixture({ verifiedManifestForInstance: manifest, existingCodexReader: (target) => existingReader(target, { request: request as unknown as AppServerClient["request"] }),
      onCommit: commits, supersedeInteractions: supersede, afterRecovery: after }); bindings = f.bindings;
    const original = f.unknown(); const bound = f.bindings.recoveryForSession(f.codex)!; const evidence = await bound.inspect(original);
    const pending = bound.reconcile({ ...original, authSubjectId: "writer", commandId: "draining-reconcile", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    const rejected = expect(pending).rejects.toMatchObject({ code: "RECOVERY_CLOSED" });
    expect(await draining).toBe(false);
    expect(f.store.getCommandReceipt("writer", "draining-reconcile")?.state).toBe("accepted");
    expect(f.store.getCommandReceipt("writer", original.start)?.state).toBe("outcome_unknown");
    await f.host.closeAndWait(100); f.bindings.shutdownService.seal?.();
    const sql = vi.spyOn(f.store.db, "prepare"); f.store.close(); release(); await rejected;
    expect(sql).not.toHaveBeenCalled(); expect(commits).toHaveBeenCalledTimes(1); expect(after).not.toHaveBeenCalled(); expect(supersede).not.toHaveBeenCalled();
  });
});


describe("recovery continuation fences", () => {
  it("seals a deferred RPC at its absolute drain deadline and never resumes SQL/publication after close", async () => {
    let reads = 0; let release!: () => void; const barrier = new Promise<void>((yes) => { release = yes; });
    const request = vi.fn(async (_method: string, params: unknown) => { if (++reads === 2) await barrier; const id = (params as { threadId: string }).threadId;
      return { thread: { id, turns: [{ id: id.replace("native-session:", "native-turn:"), status: "completed" }] } }; });
    const commits = vi.fn(); const supersede = vi.fn(); const after = vi.fn();
    const f = await fixture({ verifiedManifestForInstance: manifest, existingCodexReader: (target) => existingReader(target, { request: request as unknown as AppServerClient["request"] }),
      onCommit: commits, supersedeInteractions: supersede, afterRecovery: after });
    const original = f.unknown(); const bound = f.bindings.recoveryForSession(f.codex)!; const evidence = await bound.inspect(original);
    const pending = bound.reconcile({ ...original, authSubjectId: "writer", commandId: "deferred-recovery", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    const rejected = expect(pending).rejects.toMatchObject({ code: "RECOVERY_CLOSED" });
    await new Promise<void>((yes) => setImmediate(yes)); expect(reads).toBe(2);
    expect(bound.recovery.operationForCommand("writer", "deferred-recovery")?.phase).toBe("checking");
    expect(await f.bindings.shutdownService.drain(Date.now() - 1)).toBe(false);
    expect(f.store.getCommandReceipt("writer", "deferred-recovery")?.state).toBe("accepted");
    await f.host.closeAndWait(100); const sql = vi.spyOn(f.store.db, "prepare"); f.store.close(); release(); await rejected;
    expect(sql).not.toHaveBeenCalled(); expect(commits).toHaveBeenCalledTimes(1); expect(after).not.toHaveBeenCalled(); expect(supersede).not.toHaveBeenCalled();
  });

  it("checks its own open guard between service completion and runtime/resource callbacks", async () => {
    let bindings!: CatalogRecoveryBindings; let clearSql = () => {};
    const reader = terminalClient(); const supersede = vi.fn(); const after = vi.fn();
    const f = await fixture({ verifiedManifestForInstance: manifest, existingCodexReader: (target) => existingReader(target, reader.client), supersedeInteractions: supersede, afterRecovery: after,
      onCommit: (events) => { if (events.some((event) => event.type === "turn.recovery.reconciled")) { bindings.shutdownService.seal?.(); clearSql(); } } }); bindings = f.bindings;
    const original = f.unknown(); const bound = bindings.recoveryForSession(f.codex)!; const evidence = await bound.inspect(original);
    const sql = vi.spyOn(f.store.db, "prepare"); clearSql = () => { sql.mockClear(); };
    await expect(bound.reconcile({ ...original, authSubjectId: "writer", commandId: "sealed-after-commit", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision }))
      .rejects.toMatchObject({ code: "RECOVERY_CLOSED" });
    expect(sql).not.toHaveBeenCalled(); sql.mockRestore();
    expect(f.store.getCommandReceipt("writer", "sealed-after-commit")?.state).toBe("completed");
    expect(f.store.getTurn(original.turnId)?.status).toBe("completed"); expect(f.store.getSession(f.codex)?.recoveryState).toBe("blocked");
    expect(after).not.toHaveBeenCalled(); expect(supersede).not.toHaveBeenCalled();
  });
});


describe("admitted recovery authorization during Catalog drain", () => {
  it.each(["reconcile", "acknowledge"] as const)("completes an admitted deferred %s after logical close while denying new requests", async (action) => {
    let closing = false; let reads = 0; let workspaceReads = 0; let release!: () => void;
    const barrier = new Promise<void>((yes) => { release = yes; });
    const request = vi.fn(async (_method: string, params: unknown) => { if (++reads === 2) await barrier; const id = (params as { threadId: string }).threadId;
      return { thread: { id, turns: [{ id: id.replace("native-session:", "native-turn:"), status: "completed" }] } }; });
    const f = await fixture({ assertRecoveryAdmission: () => { if (closing) throw new Error("HOST_DRAINING"); },
      ...(action === "reconcile" ? { verifiedManifestForInstance: manifest, existingCodexReader: (target: CatalogRecoveryIdentity) => existingReader(target, { request: request as unknown as AppServerClient["request"] }) } : {}),
      processInspector: inspector, inspectWorkspace: async () => { if (++workspaceReads === 2 && action === "acknowledge") await barrier; return "clear"; } });
    const original = f.unknown(); if (action === "acknowledge") f.recordProcess(original.context);
    const bound = f.bindings.recoveryForSession(f.codex)!; const evidence = await bound.inspect(original);
    const input = { ...original, authSubjectId: "writer", commandId: `admitted-${action}`, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision };
    const pending = action === "reconcile" ? bound.reconcile(input) : bound.acknowledge({ ...input, acknowledgeUnknown: true });
    await new Promise<void>((yes) => setImmediate(yes));
    expect(bound.recovery.operationForCommand("writer", input.commandId)?.phase).toBe("checking");
    closing = true; await f.host.closeAndWait(100); expect(f.store.db.open).toBe(true); expect(f.host.ready).toBe(false);
    expect(() => f.host.assertActorSession("writer", f.codex, "session:write")).toThrow("HOST_CLOSED");
    const draining = f.bindings.shutdownService.drain(Date.now() + 500);
    await expect(bound.inspect(original)).rejects.toMatchObject({ code: "RECOVERY_DRAINING" });
    await expect(bound.reconcile({ ...input, commandId: "new-during-close" })).rejects.toMatchObject({ code: "RECOVERY_DRAINING" });
    expect(f.store.getCommandReceipt("writer", "new-during-close")).toBeUndefined();
    release(); const result = await pending; expect(await draining).toBe(true);
    expect(result).toMatchObject({ state: "completed", turnStatus: action === "reconcile" ? "completed" : "outcome_unknown", gate: action === "reconcile" ? "blocked" : "released" });
    expect(f.store.getCommandReceipt("writer", input.commandId)?.state).toBe("completed");
    expect(f.store.getTurn(original.turnId)?.status).toBe(action === "reconcile" ? "completed" : "outcome_unknown");
    expect(f.store.getSession(f.codex)?.recoveryState).toBe(action === "reconcile" ? "blocked" : "idle");
    expect(f.store.getCommandReceipt("writer", original.start)?.state).toBe(action === "reconcile" ? "completed" : "outcome_unknown");
    expect(f.runtimeFactory).not.toHaveBeenCalled(); expect(f.runTurn).not.toHaveBeenCalled();
  });

  it.each(["revoked", "grant", "scope"])("freshly denies %s authority after an admitted command awaits through logical close", async (changed) => {
    let reads = 0; let release!: () => void; const barrier = new Promise<void>((yes) => { release = yes; });
    const request = vi.fn(async (_method: string, params: unknown) => { if (++reads === 2) await barrier; const id = (params as { threadId: string }).threadId;
      return { thread: { id, turns: [{ id: id.replace("native-session:", "native-turn:"), status: "completed" }] } }; });
    const f = await fixture({ verifiedManifestForInstance: manifest, existingCodexReader: (target) => existingReader(target, { request: request as unknown as AppServerClient["request"] }) });
    const original = f.unknown(); const bound = f.bindings.recoveryForSession(f.codex)!; const evidence = await bound.inspect(original);
    const originalReceipt = f.store.getCommandReceipt("writer", original.start);
    const pending = bound.reconcile({ ...original, authSubjectId: "writer", commandId: `admitted-denied-${changed}`, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    const denied = expect(pending).rejects.toMatchObject({ code: changed === "revoked" ? "DEVICE_REVOKED" : changed === "scope" ? "SCOPE_REQUIRED" : "FORBIDDEN" });
    await new Promise<void>((yes) => setImmediate(yes)); await f.host.closeAndWait(100);
    const draining = f.bindings.shutdownService.drain(Date.now() + 500);
    if (changed === "revoked") f.store.db.prepare("UPDATE devices SET revoked_at='2026-10-15T00:00:00Z' WHERE id='writer'").run();
    if (changed === "scope") f.store.db.prepare("UPDATE devices SET scopes_json='[\"session:read\"]' WHERE id='writer'").run();
    if (changed === "grant") f.denied.add(`writer:${f.codex}`);
    release(); await denied; expect(await draining).toBe(true);
    expect(f.store.getCommandReceipt("writer", `admitted-denied-${changed}`)?.state).toBe("failed");
    expect(f.store.getCommandReceipt("writer", original.start)).toEqual(originalReceipt);
    expect(f.store.getTurn(original.turnId)?.status).toBe("outcome_unknown"); expect(f.store.getSession(f.codex)?.recoveryState).toBe("blocked");
  });
});
