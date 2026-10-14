import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, CheckpointDiffPageSchema, CheckpointDiffFileSchema, CheckpointPreviewPageSchema, CheckpointRevertOperationSchema, CheckpointRevertEvidenceSchema, SessionNativeHandleSchema } from "@flyx/mvp-protocol";
import { FrameBudget } from "../content/frame-budget.js";
import { ManagedProcessRegistry, SqliteProcessJournal } from "../lifecycle/managed-process-registry.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { ExecutionWorker } from "../orchestration/execution-worker.js";
import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { DispatchContext } from "../provider/types.js";
import { RuntimeRegistry } from "../provider/runtime-registry.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import { SessionRegistry } from "../session/session-registry.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { openOwned } from "../storage/open-store.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { applyInteractionMigration } from "../storage/migrations/008-interactions.js";
import { applyCheckpointSchema, applyRevertSchema } from "../storage/migrations/009-checkpoints.js";
import { HostViews, applyViewsMigration } from "../timeline/host-views.js";
import { TimelineBackfill } from "../timeline/backfill.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { WorkspaceLease } from "../workspace/workspace-lease.js";
import { assertRestoreWriteReady } from "../operations/restore-service.js";
import { bindingDigest } from "./git-driver.js";
import { createHostCheckpoints, type CheckpointRpcContext, type HostCheckpointsOptions, type HostRevertPorts } from "./host-checkpoints.js";
import type { CheckpointPreviewContext } from "./preview-service.js";
import type { NativeRevertDriver, NativeRevertProof, NativeRevertRequest, RevertOperation } from "./revert-types.js";
import { fixtureGit, removeFixture, temporaryRepository, userGitState } from "./test-support.js";
import { stageRaw } from "./revert-test-support.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(input: { revert?: boolean; verified?: boolean; helper?: string } = {}) {
  const root = await temporaryRepository(); cleanups.push(() => removeFixture(root));
  const owner = createTestHostOwner(), store = openOwned({ databasePath: ":memory:", owner });
  cleanups.push(() => { store.close(); owner.release(); });
  applyViewsMigration(store, owner); applyCatalogMigration(store.db); applyInteractionMigration(store.db); applyCheckpointSchema(store.db); applyRevertSchema(store.db);
  store.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(9,?)").run(new Date().toISOString());
  const catalog = new CatalogStore(store); cleanups.push(() => catalog.dispose());
  const workspaces = new WorkspaceRegistry(catalog, { owner }); await workspaces.registerLocal({ workspaceId: "workspace-1", root });
  const providers = new ProviderInstanceRegistry(catalog); providers.registerLocal({ providerInstanceId: "provider-1", provider: "codex", executable: process.execPath });
  if (input.verified) providers.recordVerification("provider-1", { state: "verified", runtimeVersion: "fixture-native-v1", capabilities: ["workspaceWrite"] });
  const runtimeFactory = vi.fn(() => { throw new Error("History must not load a Provider"); });
  const registry = new SessionRegistry(catalog, workspaces, providers, { owner, runtimeFactory });
  const views = new HostViews(store, owner, { resolveResource: (id) => {
    const session = store.getSession(id); if (!session) return undefined;
    return { sessionId: id, workspace: session.workspacePath, source: { get headSequence() { return store.getSession(id)!.headSequence; }, getEvent: (sequence: number) => store.listEvents(id, sequence - 1, 1).events[0], subscribe: (listener) => registry.subscribe(id, listener) }, readSnapshot: () => registry.readSnapshot(id) };
  } }); cleanups.push(() => views.close());
  const session = registry.createNew({ authSubjectId: "device-1", commandId: "create-one" }, { workspaceId: "workspace-1", providerInstanceId: "provider-1", title: "First" }).summary;
  const second = registry.createNew({ authSubjectId: "device-1", commandId: "create-two" }, { workspaceId: "workspace-1", providerInstanceId: "provider-1", title: "Second" }).summary;
  const nativeHandle = SessionNativeHandleSchema.parse({ v: 1, provider: "codex", providerInstanceId: "provider-1", workspaceId: "workspace-1", nativeSessionId: "private-native-id", provenance: "native" }); catalog.setNativeHandle(session.sessionId, nativeHandle);
  store.createDevice({ id: "device-1", hostId: "host-1", platform: "test", credentialKind: "browser-session", credentialRevision: 1, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  store.createDevice({ id: "device-2", hostId: "host-1", platform: "test", credentialKind: "browser-session", credentialRevision: 1, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  let lease = WorkspaceLease.acquire({ workspace: root, owner, operationId: "real-checkout-lease" }); cleanups.push(() => lease.release());
  let actorAllowed = true, currentNativeHandle: unknown = nativeHandle, runtimeGeneration = 1;
  const authorize = vi.fn((id: string, actor: string, _scope: string) => { if (!actorAllowed || !["device-1", "device-2"].includes(actor) || id !== session.sessionId) throw Object.assign(new Error("private authorization detail"), { code: "SCOPE_REQUIRED" }); });
  const currentContext = (): CheckpointPreviewContext => ({ sessionId: session.sessionId, actorId: "device-1", workspaceId: session.workspaceId, lease: { workspaceId: session.workspaceId, leaseId: lease.operationId, generation: owner.generation }, sessionRevision: store.getSession(session.sessionId)!.revision, epoch: views.projector.activeEpoch(session.sessionId)!.epoch, runtimeGeneration, nativeHandle: currentNativeHandle });
  const nativeCalls: NativeRevertRequest[] = [], proofs = new Map<string, NativeRevertProof>();
  const proof = (request: NativeRevertRequest): NativeRevertProof => ({ state: "applied", requestId: request.requestId, originalBinding: request.preparation.originalBinding, targetBinding: request.preparation.targetBinding, proofId: randomUUID(), observedAt: new Date().toISOString(), quiescent: true, pendingRequest: false, nativeHandle });
  let timeout = false;
  const native: NativeRevertDriver = {
    prepare: async (value) => input.verified ? { supported: true, capability: { kind: value.mode === "revert" ? "conversation-rewind" : "new-conversation", evidenceId: "actual-test-version-evidence", driverVersion: "fixture-native-v1", verifiedVersion: "fixture-native-v1" }, originalBinding: bindingDigest(value.originalHandle), targetBinding: bindingDigest({ checkpointId: value.checkpointId, nativeHandle: value.targetHandle, phase: value.checkpointPhase }), boundary: { checkpointId: value.checkpointId } } : { supported: false, reason: "verified-native-capability-unavailable" },
    apply: async (request) => { nativeCalls.push(request); if (timeout) throw new Error("private-native-id timeout " + root); const result = proof(request); proofs.set(request.requestId, result); return result; },
    query: async (request) => proofs.get(request.requestId) ?? { ...proof(request), state: "not_applied" },
  };
  const projectSuccess = vi.fn((db, value) => {
    expect(db).toBe(store.db); expect(db.inTransaction).toBe(true);
    catalog.setNativeHandle(value.operation.sessionId, SessionNativeHandleSchema.parse(value.nativeProof.nativeHandle));
    views.projector.createEpoch(value.operation.sessionId, "building", value.epoch);
    new TimelineBackfill(views.projector, () => owner.assertActive()).run(value.operation.sessionId, { epoch: value.epoch });
    return { epoch: value.epoch, nativeHandleBinding: bindingDigest(value.nativeProof.nativeHandle) };
  });
  const spawn = vi.fn(), exit = vi.fn();
  const helperRegistries: ManagedProcessRegistry[] = [];
  cleanups.push(() => helperRegistries.forEach((entry) => entry.sealJournal()));
  const managedSpawn: NonNullable<NonNullable<HostCheckpointsOptions["restoreOptions"]>["spawnHelper"]> = (request) => {
    let context: DispatchContext = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: "checkpoint-helper-read", runtimeGeneration: 0, attemptId: randomUUID(), sessionId: session.sessionId, flyxTurnId: "checkpoint-helper-read" };
    if (request.purpose === "mutate") {
      const row = store.db.prepare("SELECT operation_json FROM checkpoint_revert_operations WHERE operation_id=?").get(request.operationId) as { operation_json: string };
      const original = JSON.parse(row.operation_json) as RevertOperation;
      const step = original.steps.find((value) => value.stepId === request.stepId)!;
      expect(step.state).toBe("dispatching"); const attempt = step.attempts.at(-1)!; expect(attempt.state).toBe("dispatching");
      context = original.commands.find((command) => command.intentId === attempt.commandIntentId)!.dispatchContext;
    }
    const registry = new ManagedProcessRegistry({ journal: new SqliteProcessJournal(store.db), context: () => context }); helperRegistries.push(registry);
    return registry.spawn(request.command, request.args, { env: request.env, stdio: ["pipe", "pipe", "pipe"] });
  };
  const ports: HostRevertPorts = { acquire: async () => ({ lease }), dispatchContextFor: (context, operationId, attemptId) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: context.sessionId, flyxTurnId: operationId, runtimeId: "trusted-runtime-1", runtimeGeneration: context.runtimeGeneration, attemptId }), native,
    proveQuiescence: async () => ({ proven: true, proofId: "fixture-stopped-original-process-tree" }), projectSuccess, assertRestoreWriteReady,
    verifiedNativeCapabilities: async () => input.verified ? [{ kind: "conversation-rewind", evidenceId: "actual-test-version-evidence", driverVersion: "fixture-native-v1", verifiedVersion: "fixture-native-v1" }] : [],
  };
  const options: HostCheckpointsOptions = { store, owner, registry, workspaces, views, authorizeSession: authorize,
    runtimeState: () => ({ lease, runtimeGeneration, nativeHandle: currentNativeHandle }), leaseForContext: () => lease,
    captureStateFor: () => ({ runtimeGeneration, nativeHandle: currentNativeHandle }),
    ...(input.revert ? { revert: ports, restoreOptions: { spawnHelper: managedSpawn, onSpawn: spawn, onExit: exit, ...(input.helper ? { pythonExecutable: input.helper } : {}) } } : {}),
  };
  const host = await createHostCheckpoints(options); cleanups.push(() => { host.seal(); });
  const rpcContext = (actor = "device-1"): CheckpointRpcContext => ({ subjectId: actor, protocolVersion: 2, capabilities: new Set([CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY]), assertAuthorized: () => {}, assertSessionScope: (id, scope) => authorize(id, actor, scope) });
  const rpc = async (method: string, payload: unknown, commandId?: string, context = rpcContext()) => {
    const result = await host.dispatchCheckpoint({ id: randomUUID(), method, payload, ...(commandId ? { commandId } : {}) }, context); if (!result.handled) throw new Error("NOT_HANDLED"); return result.payload;
  };
  const capture = () => host.checkpoints.captureCurrent(currentContext(), "preview");
  const targetAndPreview = async () => {
    await stageRaw(root, "tracked.txt", "target-index\n"); await writeFile(join(root, "tracked.txt"), "target-workspace\n"); const target = await capture();
    await stageRaw(root, "tracked.txt", "current-index\n"); await writeFile(join(root, "tracked.txt"), "current-workspace\n");
    const page = CheckpointPreviewPageSchema.parse(await rpc("checkpoint.previewRevert", { sessionId: session.sessionId, checkpointId: target.checkpointId, expectedSessionRevision: store.getSession(session.sessionId)!.revision })); return { target, page };
  };
  const worker = new ExecutionWorker(new ExecutionStore(store), new RuntimeRegistry(), { owner: { id: owner.ownerId, generation: owner.generation }, revalidateDevice: (intent) => authorize(intent.sessionId, intent.authSubjectId, "session:write"), assertWriteReady: () => assertRestoreWriteReady(store.db), onStartOutcome: () => {}, onControlResult: () => {}, drainIngestion: async () => {}, failed: (error) => { throw error; } });
  cleanups.push(() => worker.seal()); host.bindWorker(worker);
  return { root, owner, store, catalog, registry, views, workspaces, session, second, host, options, ports, projectSuccess, runtimeFactory, nativeCalls, spawn, exit, authorize, rpc, rpcContext, capture, currentContext, targetAndPreview, worker,
    setLease: (value: WorkspaceLease) => { lease = value; }, setActorAllowed: (value: boolean) => { actorAllowed = value; }, setNative: (value: unknown) => { currentNativeHandle = value; }, setRuntimeGeneration: (value: number) => { runtimeGeneration = value; }, setTimeout: (value: boolean) => { timeout = value; } };
}

describe("owned checkpoint production factory and RPC", () => {
  it("validates 008/009 without schema writes and preserves basic Diff when native/helper support is unavailable", async () => {
    const f = await fixture(); const before = f.store.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    const support = await f.host.capabilitiesForSession(f.session.sessionId, "device-1");
    expect(support).toEqual({ capabilities: [CHECKPOINT_DIFF_CAPABILITY], diff: true, preview: true, workspaceRestore: false, nativeRewind: false, unsupportedReason: "REVERT_UNAVAILABLE" }); expect(f.runtimeFactory).not.toHaveBeenCalled();
    expect(f.store.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    f.store.db.prepare("DELETE FROM schema_migrations WHERE version=9").run(); await expect(createHostCheckpoints(f.options)).rejects.toMatchObject({ code: "CHECKPOINT_SCHEMA_NOT_READY" });
    expect(f.store.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });
  it("serves stable historical staged/workspace Diff and bounded binary content through the actual shared ContentStore", async () => {
    const f = await fixture(); await stageRaw(f.root, "tracked.txt", "before-index\n"); await writeFile(join(f.root, "tracked.txt"), "before-workspace " + f.root + "\n");
    await writeFile(join(f.root, "binary.dat"), Buffer.alloc(20000, 0)); const before = await f.capture();
    await stageRaw(f.root, "tracked.txt", "after-index\n"); await writeFile(join(f.root, "tracked.txt"), "after-workspace\n"); await writeFile(join(f.root, "binary.dat"), Buffer.alloc(25000, 1)); const after = await f.capture();
    const state = await userGitState(f.root); const page = CheckpointDiffPageSchema.parse(await f.rpc("checkpoint.getDiff", { sessionId: f.session.sessionId, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId, limit: 1 }));
    expect(page.totalFiles).toBe(2); expect(page.nextCursor).toBeDefined();
    const rest = CheckpointDiffPageSchema.parse(await f.rpc("checkpoint.getDiff", { sessionId: f.session.sessionId, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId, cursor: page.nextCursor }));
    const files = [...page.files, ...rest.files]; const binary = files.find((file) => file.path === "binary.dat")!;
    const content = CheckpointDiffFileSchema.parse(await f.rpc("checkpoint.getFile", { sessionId: f.session.sessionId, diffId: page.diffId, fileId: binary.fileId }));
    expect(content.before.kind).toBe("contentRef"); if (content.before.kind !== "contentRef") throw new Error("CONTENT_REF_REQUIRED");
    const chunk = f.views.content.getChunk({ sessionId: f.session.sessionId, ref: content.before.contentRef.ref, offset: 0, maxBytes: 512, encoding: "base64" }); expect(chunk.nextOffset).toBe(512);
    const tracked = files.find((file) => file.path === "tracked.txt")!; const text = await f.rpc("checkpoint.getFile", { sessionId: f.session.sessionId, diffId: page.diffId, fileId: tracked.fileId }); expect(JSON.stringify(text)).not.toContain(f.root); expect(JSON.stringify(text)).not.toContain("private-native-id");
    await fixtureGit(f.root, ["commit", "-m", "HEAD moved independently"]); const moved = await userGitState(f.root);
    expect(await f.rpc("checkpoint.getDiff", { sessionId: f.session.sessionId, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId, limit: 1 })).toEqual(page);
    expect((await userGitState(f.root)).index).toEqual(moved.index); expect(state.head).not.toBe(moved.head); expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("enforces actor/session scope, strict V2 payloads and full envelope budgets without native dispatch", async () => {
    const f = await fixture(); const { target, page } = await f.targetAndPreview();
    await expect(f.rpc("checkpoint.getPreview", { sessionId: f.session.sessionId, planId: page.planId }, undefined, f.rpcContext("device-2"))).rejects.toMatchObject({ code: "PLAN_SCOPE_MISMATCH" });
    await expect(f.rpc("checkpoint.getPreview", { sessionId: f.second.sessionId, planId: page.planId })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(f.rpc("checkpoint.previewRevert", { sessionId: f.session.sessionId, checkpointId: target.checkpointId, expectedSessionRevision: page.expectedSessionRevision, actorId: "device-2", path: f.root })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(f.rpc("checkpoint.getPreview", { sessionId: f.session.sessionId, planId: page.planId }, undefined, { ...f.rpcContext(), protocolVersion: 1 })).rejects.toMatchObject({ code: "PROTOCOL_V2_REQUIRED" });
    await expect(f.rpc("checkpoint.getPreview", { sessionId: f.session.sessionId, planId: page.planId }, undefined, { ...f.rpcContext(), frameBudget: new FrameBudget({ responseBytes: 128 }), responseEnvelope: (payload) => ({ payload, escaping: "x".repeat(100) }) })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(await f.rpc("checkpoint.getPreview", { sessionId: f.session.sessionId, planId: page.planId })).toEqual(page); expect(f.nativeCalls).toEqual([]);
    await expect(f.host.dispatchCheckpoint({ id: "unknown", method: "toString", payload: {} }, f.rpcContext())).resolves.toEqual({ handled: false });
  });
  it("allows read-scoped preview while execution requires current write permission", async () => {
    const f = await fixture({ revert: true }); const target = await f.capture();
    f.store.db.prepare("UPDATE devices SET scopes_json=? WHERE id=?").run(JSON.stringify(["session:read"]), "device-2");
    const page = CheckpointPreviewPageSchema.parse(await f.rpc("checkpoint.previewRevert", { sessionId: f.session.sessionId, checkpointId: target.checkpointId, expectedSessionRevision: f.store.getSession(f.session.sessionId)!.revision }, undefined, f.rpcContext("device-2")));
    const command = { sessionId: f.session.sessionId, commandId: "read-only-cannot-restore", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    await expect(f.rpc("checkpoint.workspaceRestore", command, command.commandId, f.rpcContext("device-2"))).rejects.toMatchObject({ code: "SCOPE_REQUIRED" }); expect(f.store.getCommandReceipt("device-2", command.commandId)).toBeUndefined();
  });
  it("takes revision, active relation, epoch and actual lease from Host facts, rejecting a client-stale preview", async () => {
    const f = await fixture(); const target = await f.capture();
    await expect(f.rpc("checkpoint.previewRevert", { sessionId: f.session.sessionId, checkpointId: target.checkpointId, expectedSessionRevision: 0 })).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    const other = await temporaryRepository(); cleanups.push(() => removeFixture(other)); f.setLease(WorkspaceLease.acquire({ workspace: other, owner: f.owner }));
    await expect(f.rpc("checkpoint.previewRevert", { sessionId: f.session.sessionId, checkpointId: target.checkpointId, expectedSessionRevision: f.store.getSession(f.session.sessionId)!.revision })).rejects.toMatchObject({ code: "WORKSPACE_LEASE_STALE" });
    expect(f.store.db.prepare("SELECT count(*) AS n FROM checkpoint_preview_plans").get()).toEqual({ n: 0 });
  });
  it("does not advertise native rewind from a helper probe or mismatched native version", async () => {
    const f = await fixture({ revert: true }); const support = await f.host.capabilitiesForSession(f.session.sessionId, "device-1");
    expect(support.workspaceRestore).toBe(true); expect(support.nativeRewind).toBe(false); expect(support.capabilities).toEqual([CHECKPOINT_DIFF_CAPABILITY]);
    const { page } = await f.targetAndPreview(); const request = { sessionId: f.session.sessionId, commandId: "unsupported", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    await expect(f.rpc("checkpoint.executeRevert", request, request.commandId)).rejects.toMatchObject({ code: "PROVIDER_REWIND_UNSUPPORTED" }); expect(f.store.getCommandReceipt("device-1", request.commandId)).toBeUndefined(); expect(f.nativeCalls).toEqual([]);
    const unavailable = await fixture({ revert: true, helper: "/unavailable/flyx-helper" }); expect((await unavailable.host.capabilitiesForSession(unavailable.session.sessionId, "device-1")).unsupportedReason).toBe("CONTROLLED_RESTORE_UNAVAILABLE");
  });
  it("rejects preparation from a different native version even when discovery previously advertised support", async () => {
    const f = await fixture({ revert: true, verified: true }); const { page } = await f.targetAndPreview();
    const driver = f.ports.native!, original = driver.prepare.bind(driver);
    driver.prepare = async (input) => { const result = await original(input); return result.supported ? { ...result, capability: { ...result.capability, verifiedVersion: "different-runtime-version" } } : result; };
    const command = { sessionId: f.session.sessionId, commandId: "bad-native-version", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    await expect(f.rpc("checkpoint.executeRevert", command, command.commandId)).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNVERIFIED" }); expect(f.store.getCommandReceipt("device-1", command.commandId)).toBeUndefined(); expect(f.nativeCalls).toEqual([]);
    const provider = f.catalog.provider("provider-1")!; f.catalog.putProvider({ ...provider, verification: { ...provider.verification, runtimeVersion: "changed-registry-version" } }); expect((await f.host.capabilitiesForSession(f.session.sessionId, "device-1")).nativeRewind).toBe(false);
  });
  it("accepts V2 command, receipt, journal and original dispatch together, then runs through actual Worker and atomic Timeline epoch", async () => {
    const f = await fixture({ revert: true, verified: true }); expect((await f.host.capabilitiesForSession(f.session.sessionId, "device-1")).capabilities).toEqual([CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY]);
    const { page } = await f.targetAndPreview(); const published: string[] = []; f.registry.subscribe(f.session.sessionId, (event) => published.push(event.type)); const state = await userGitState(f.root); const command = { sessionId: f.session.sessionId, commandId: "execute-one", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    await expect(f.rpc("checkpoint.executeRevert", command)).rejects.toMatchObject({ code: "COMMAND_ID_REQUIRED" }); await expect(f.rpc("checkpoint.executeRevert", command, "different")).rejects.toMatchObject({ code: "COMMAND_ID_MISMATCH" });
    const accepted = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.executeRevert", command, command.commandId)); expect(accepted.status).toBe("queued"); expect(published).toEqual(["checkpoint.revert.accepted"]);
    const intent = new ExecutionStore(f.store).list({ sessionId: f.session.sessionId })[0]!; expect(intent.dispatchContext).toMatchObject({ hostOwnerId: f.owner.ownerId, sessionId: f.session.sessionId, flyxTurnId: accepted.operationId }); expect(f.store.getCommandReceipt("device-1", command.commandId)?.response).toEqual(accepted);
    expect((await userGitState(f.root)).index).toEqual(state.index); expect(f.worker.scan()).toBe(1); await f.worker.drainDispatch();
    const completed = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.getRevertOperation", { sessionId: f.session.sessionId, operationId: accepted.operationId })); expect(completed.status).toBe("completed");
    expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("target-workspace\n"); expect((await fixtureGit(f.root, ["show", ":tracked.txt"])).toString()).toBe("target-index\n"); expect((await userGitState(f.root)).head).toBe(state.head);
    expect(f.views.projector.activeEpoch(f.session.sessionId)?.epoch).toBe(completed.epoch); expect(f.projectSuccess).toHaveBeenCalledTimes(1); expect(f.spawn).toHaveBeenCalled(); expect(f.exit).toHaveBeenCalled(); expect(f.nativeCalls).toHaveLength(1);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM managed_processes WHERE turn_id=? AND session_id=? AND state='root_exited'").get(accepted.operationId, f.session.sessionId)).toMatchObject({ n: 2 });
    expect(JSON.stringify(completed)).not.toContain("private-native-id"); expect(JSON.stringify(completed)).not.toContain(f.root); expect(f.store.getCommandReceipt("device-1", command.commandId)?.state).toBe("completed"); expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("resumes a native timeout only through fresh inspection evidence and an explicit V2 command", async () => {
    const f = await fixture({ revert: true, verified: true }); const { page } = await f.targetAndPreview(); f.setTimeout(true);
    const command = { sessionId: f.session.sessionId, commandId: "native-timeout", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    const accepted = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.executeRevert", command, command.commandId)); f.worker.scan(); await f.worker.drainDispatch();
    const failed = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.getRevertOperation", { sessionId: f.session.sessionId, operationId: accepted.operationId })); expect(failed.status).toBe("blocked"); expect(f.worker.scan()).toBe(0);
    const evidence = CheckpointRevertEvidenceSchema.parse(await f.rpc("checkpoint.inspectRevert", { sessionId: f.session.sessionId, operationId: accepted.operationId })); expect(evidence.resumable).toBe(true); f.setTimeout(false);
    const recovery = { sessionId: f.session.sessionId, operationId: accepted.operationId, commandId: "resume-after-proof", evidenceId: evidence.evidenceId, expectedSessionRevision: evidence.expectedSessionRevision, confirmation: true };
    expect(CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.resumeVerified", recovery, recovery.commandId)).status).toBe("queued"); expect(f.worker.scan()).toBe(1); await f.worker.drainDispatch();
    expect(CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.getRevertOperation", { sessionId: f.session.sessionId, operationId: accepted.operationId })).status).toBe("completed"); expect(f.nativeCalls).toHaveLength(2); expect(f.store.getSession(f.session.sessionId)?.recoveryState).toBe("idle");
  });
  it("keeps an explicit workspaceRestore blocked when no new native conversation is proved, with scoped inspect and rollback RPCs", async () => {
    const f = await fixture({ revert: true }); const { page } = await f.targetAndPreview(); const command = { sessionId: f.session.sessionId, commandId: "workspace-only", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    const accepted = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.workspaceRestore", command, command.commandId)); f.worker.scan(); await f.worker.drainDispatch();
    const result = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.getRevertOperation", { sessionId: f.session.sessionId, operationId: accepted.operationId })); expect(result).toMatchObject({ status: "blocked", errorCode: "NEW_CONVERSATION_REQUIRED", recoveryRequired: true }); expect(f.store.getSession(f.session.sessionId)?.recoveryState).toBe("blocked");
    expect(() => f.store.createTurn({ sessionId: f.session.sessionId, turnId: randomUUID(), commandId: "blocked-new-turn", requestHash: "test", prompt: "must block", generation: 2 })).toThrow();
    const evidence = CheckpointRevertEvidenceSchema.parse(await f.rpc("checkpoint.inspectRevert", { sessionId: f.session.sessionId, operationId: accepted.operationId })); expect(evidence.safetyRollbackAvailable).toBe(true);
    await expect(f.rpc("checkpoint.resumeVerified", { sessionId: f.session.sessionId, operationId: accepted.operationId, commandId: "resume", evidenceId: evidence.evidenceId, expectedSessionRevision: evidence.expectedSessionRevision, confirmation: true }, "wrong")).rejects.toMatchObject({ code: "COMMAND_ID_MISMATCH" });
    const rollbackCommand = { sessionId: f.session.sessionId, operationId: accepted.operationId, commandId: "rollback", evidenceId: evidence.evidenceId, expectedSessionRevision: evidence.expectedSessionRevision, confirmation: true };
    const rollback = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.rollbackToSafety", rollbackCommand, rollbackCommand.commandId)); expect(rollback.parentOperationId).toBe(accepted.operationId); f.worker.scan(); await f.worker.drainDispatch();
    expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("current-workspace\n"); expect(f.store.getSession(f.session.sessionId)?.recoveryState).toBe("blocked");
  });
  it("rechecks restore-readiness and actor before queued external execution, preserving pending safety facts", async () => {
    const f = await fixture({ revert: true, verified: true }); const { page } = await f.targetAndPreview(); const command = { sessionId: f.session.sessionId, commandId: "restored-queue", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    const accepted = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.executeRevert", command, command.commandId));
    const execution = new ExecutionStore(f.store), pending = execution.list({ sessionId: f.session.sessionId })[0]!;
    execution.claim(pending.id, { id: f.owner.ownerId, generation: f.owner.generation }, () => {});
    const intent = execution.transition({ id: pending.id, expectedStates: ["claimed"], state: "dispatching", expectedClaimOwnerId: f.owner.ownerId, expectedClaimOwnerGeneration: f.owner.generation }, () => {});
    f.store.db.prepare("INSERT INTO host_state VALUES('restore_readiness','invalid',?)").run(new Date().toISOString());
    await expect(f.host.revert!.handleIntent(intent)).resolves.toMatchObject({ status: "outcome_unknown", result: { status: "blocked" } }); expect(f.nativeCalls).toEqual([]); expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("current-workspace\n");
    expect(f.host.revert!.getOperation({ sessionId: f.session.sessionId, actorId: "device-1", operationId: accepted.operationId }).recoveryRequired).toBe(true);
    f.setActorAllowed(false); await expect(f.rpc("checkpoint.getRevertOperation", { sessionId: f.session.sessionId, operationId: accepted.operationId })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
  });
  it("builds capture hooks from original Turn/dispatch and fences bad identities", async () => {
    const f = await fixture(); const turn = f.store.createTurn({ sessionId: f.session.sessionId, turnId: "turn-capture", commandId: "capture", requestHash: "capture", prompt: "test", generation: 1 });
    f.store.db.prepare("UPDATE turns SET attempt_id=? WHERE id=?").run("attempt-capture", turn.id);
    const dispatch = { hostOwnerId: f.owner.ownerId, hostOwnerGeneration: f.owner.generation, sessionId: f.session.sessionId, flyxTurnId: turn.id, runtimeId: "trusted-runtime-1", runtimeGeneration: 1, attemptId: "attempt-capture" };
    const intent: ExecutionIntentRow = { id: "intent-capture", sessionId: f.session.sessionId, turnId: turn.id, authSubjectId: "device-1", commandId: "capture", ordinal: 0, actorKind: "device", kind: "start_turn", resourceId: turn.id, payload: {}, requestHash: "capture", runtimeGeneration: 1, attemptId: dispatch.attemptId, dispatchContext: dispatch, state: "dispatching", sourceSequence: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const lease = f.options.leaseForContext(f.currentContext()); const context = f.host.executionBinding.contextFor(intent, dispatch, lease); expect(context.lease.leaseId).toBe(lease.operationId); expect(context.sessionRevision).toBe(f.store.getSession(f.session.sessionId)!.revision); expect(context.epoch).toBe(f.views.projector.activeEpoch(f.session.sessionId)!.epoch);
    expect(() => f.host.executionBinding.contextFor(intent, { ...dispatch, attemptId: "new-attempt" }, lease)).toThrow();
    const before = await f.host.executionBinding.service.captureBefore(context); expect(before.status).toBe("complete");
    await writeFile(join(f.root, "tracked.txt"), "after-turn-workspace\n");
    const terminal = f.store.commitEvent(f.session.sessionId, "turn.completed", { turnId: turn.id }, { turnId: turn.id, turnStatus: "completed", activityState: "idle" });
    const afterContext = f.host.executionBinding.contextFor(intent, dispatch, lease);
    const after = await f.host.executionBinding.service.captureAfter({ ...afterContext, evidence: { producerStopped: true, terminalCommitted: true, terminalSequence: terminal.sequence } }); expect(after.status).toBe("complete");
    const turnPage = CheckpointDiffPageSchema.parse(await f.rpc("checkpoint.getTurnDiff", { sessionId: f.session.sessionId, turnId: turn.id, attemptId: dispatch.attemptId })); expect(turnPage.before.checkpointId).toBe(before.checkpointId); expect(turnPage.after.checkpointId).toBe(after.checkpointId); expect(turnPage.totalFiles).toBe(1);
    const sessionPage = CheckpointDiffPageSchema.parse(await f.rpc("checkpoint.getSessionDiff", { sessionId: f.session.sessionId, currentCheckpointId: after.checkpointId })); expect(sessionPage.before.checkpointId).toBe(before.checkpointId); expect(sessionPage.after.checkpointId).toBe(after.checkpointId);
  });
  it("rejects async commit guards and fake epoch projection instead of false completion", async () => {
    const f = await fixture({ revert: true, verified: true }); const { page } = await f.targetAndPreview();
    const asyncHost = await createHostCheckpoints({ ...f.options, authorizeSession: (async () => {}) as unknown as HostCheckpointsOptions["authorizeSession"] }); cleanups.push(() => asyncHost.seal());
    await expect(asyncHost.dispatchCheckpoint({ id: "guard", method: "checkpoint.getPreview", payload: { sessionId: f.session.sessionId, planId: page.planId } }, f.rpcContext())).rejects.toMatchObject({ code: "CHECKPOINT_SYNC_GUARD_REQUIRED" });
    f.ports.projectSuccess = (_db, value) => ({ epoch: value.epoch, nativeHandleBinding: bindingDigest(value.nativeProof.nativeHandle) });
    const command = { sessionId: f.session.sessionId, commandId: "projection-fault", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true }; const accepted = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.executeRevert", command, command.commandId)); f.worker.scan(); await f.worker.drainDispatch();
    const result = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.getRevertOperation", { sessionId: f.session.sessionId, operationId: accepted.operationId })); expect(result.status).toBe("blocked"); expect(result.errorCode).toBe("REVERT_PROJECTION_FAILED"); expect(f.store.getCommandReceipt("device-1", command.commandId)?.state).toBe("outcome_unknown");
  });
  it("requires managed prelaunch support and keeps a failed launch marker without mutating files", async () => {
    const f = await fixture({ revert: true, verified: true }); const { page } = await f.targetAndPreview();
    await expect(createHostCheckpoints({ ...f.options, restoreOptions: { onSpawn: f.spawn, onExit: f.exit } })).rejects.toMatchObject({ code: "CHECKPOINT_HELPER_JOURNAL_REQUIRED" });
    const original = f.options.restoreOptions!.spawnHelper!;
    const guarded = await createHostCheckpoints({ ...f.options, restoreOptions: { ...f.options.restoreOptions, spawnHelper: (request) => { if (request.purpose === "mutate") throw new Error("prelaunch SQL journal failed"); return original(request); } } }); cleanups.push(() => guarded.seal());
    const command = { sessionId: f.session.sessionId, commandId: "helper-launch-failed", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    const result = await guarded.dispatchCheckpoint({ id: "launch", method: "checkpoint.executeRevert", commandId: command.commandId, payload: command }, f.rpcContext()); if (!result.handled) throw new Error("NOT_HANDLED"); const accepted = CheckpointRevertOperationSchema.parse(result.payload);
    guarded.bindWorker(f.worker); f.worker.scan(); await f.worker.drainDispatch();
    const operation = guarded.revert!.getOperation({ sessionId: f.session.sessionId, actorId: "device-1", operationId: accepted.operationId }); expect(operation.status).toBe("blocked"); expect(operation.safetyCheckpointId).toBeDefined(); expect(f.nativeCalls).toEqual([]); expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("current-workspace\n");
    expect(f.store.db.prepare("SELECT count(*) AS n FROM checkpoint_revert_step_attempts WHERE operation_id=? AND state='outcome_unknown'").get(accepted.operationId)).toEqual({ n: 1 });
  });
  it("seals both production services before closing the shared Store", async () => {
    const f = await fixture({ revert: true }); expect(await f.host.drain(1000)).toBe(true); f.host.seal();
    await expect(f.rpc("checkpoint.getPreview", { sessionId: f.session.sessionId, planId: "any" })).rejects.toMatchObject({ code: "CHECKPOINT_SEALED" }); expect(() => f.host.bindWorker(f.worker)).toThrow();
  });
});
