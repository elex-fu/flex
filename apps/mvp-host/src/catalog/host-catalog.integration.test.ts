import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_CONTENT_CAPABILITY, SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, CatalogMutationResponseSchema, SessionSnapshotV2Schema, type SessionEvent, type CatalogMutationResponse } from "@flyx/mvp-protocol";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { SqliteStore } from "../storage/db.js";
import { FROZEN_V6_SCHEMA } from "../test-support/frozen-v6-schema.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { applyInteractionMigration } from "../storage/migrations/008-interactions.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn, decideInterrupt } from "../orchestration/decider.js";
import type { CommandRequest } from "../orchestration/command-contract.js";
import type { SessionRuntimeContext, RuntimeCloseReport } from "../session/session-registry.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { ClaudeAdapter } from "../claude/adapter.js";
import type { NativeBoundaryAssessment } from "../lifecycle/native-execution-boundary.js";
import type { ProviderAdapter } from "../provider/types.js";
import { JsonTimelineBudget } from "../timeline/contracts.js";
import { createHostCatalogBindings, HostCatalog, type CatalogExecutionRuntime, type CatalogRpcContext, type HostCatalogOptions } from "./host-catalog.js";
const clean: RuntimeCloseReport = { closed: true, producerStopped: true, clean: true, state: "stopped" };
const roots: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
    await close(); for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class EngineRuntime implements CatalogExecutionRuntime {
    readonly ownsStore = false;
    readonly recoverOnStart = false;
    readonly requestFormatVersions = [1, 2];
    readonly store;
    readonly owner;
    readonly sessionId;
    readonly runtimeId;
    readonly listeners = new Set<(event: SessionEvent) => void>();
    readonly engine: CommandEngine;
    readonly closeAndWait = vi.fn(async () => clean);
    constructor(readonly context: SessionRuntimeContext) {
        this.store = context.store;
        this.owner = context.owner;
        this.sessionId = context.session.sessionId;
        this.runtimeId = context.runtimeId;
        this.engine = new CommandEngine(this.store, { publish: (event) => { for (const listener of this.listeners)
                listener(event); } });
    }
    subscribe(listener: (event: SessionEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private request(actor: string, commandId: string, method: string, payload: unknown, trusted?: CommandRequest): CommandRequest {
        return { ...(trusted ?? { authSubjectId: actor, commandId, method, requestHash: hashCommandRequest(method, payload), requestFormatVersion: 1, targetSessionId: this.sessionId }), actorKind: "device", dispatchBinding: { hostOwnerId: this.owner.ownerId, hostOwnerGeneration: this.owner.generation, runtimeId: this.runtimeId } };
    }
    startTurn = vi.fn(async (actor: string, commandId: string, prompt: string, trusted?: CommandRequest) => { const request = this.request(actor, commandId, "session.startTurn", { prompt }, trusted); return this.engine.commitRequest(request, (facts, clock) => decideAcceptTurn(facts, request, { prompt }, clock)).result; });
    interrupt = vi.fn(async (actor: string, commandId: string, trusted?: CommandRequest) => { const request = this.request(actor, commandId, "session.interrupt", {}, trusted); return this.engine.commitRequest(request, (facts, clock) => decideInterrupt(facts, request, clock)).result; });
    respondApproval = vi.fn(async (actor: string, commandId: string, approvalId: string, action: "allow_once" | "deny", trusted?: CommandRequest) => {
        const request = this.request(actor, commandId, "approval.respond", { approvalId, action }, trusted);
        const result = { approvalId, status: "already_terminal" };
        return this.engine.commitRequest(request, () => ({ result, receipts: [{ ...request, state: "completed", response: result }] })).result;
    });
}
async function fixture(options: Partial<HostCatalogOptions> = {}, withInteractions = false, actualDefault = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-host-catalog-")));
    roots.push(root);
    const checkout = join(root, "checkout");
    const providerRoot = join(checkout, "app");
    mkdirSync(providerRoot, { recursive: true });
    execFileSync("git", ["init", "--quiet", checkout]);
    const owner = createTestHostOwner();
    const store = openOwned({ databasePath: ":memory:", owner });
    cleanup.push(() => { if (store.db.open)
        store.close(); try {
        owner.release();
    }
    catch { /* Explicit unknown fixtures retain their in-memory owner. */ } });
    store.setHostIdentityMirror({ hostId: "host-one", fingerprint: "a".repeat(64) });
    for (const [id, scopes, hostId] of [["writer", ["session:read", "session:write", "approval:write"], "host-one"], ["reader", ["session:read"], "host-one"], ["approver", ["approval:write"], "host-one"], ["foreign-host", ["session:read", "session:write"], "another-host"]] as const)
        store.createDevice({ id, scopes: [...scopes], hostId, platform: "test", credentialKind: "browser-session", credentialRevision: 1, createdAt: new Date().toISOString() });
    applyCatalogMigration(store.db);
    if (withInteractions)
        applyInteractionMigration(store.db);
    const runtimeFactory = vi.fn((context: SessionRuntimeContext) => new EngineRuntime(context));
    const configuration = { workspaces: [{ workspaceId: "workspace-one", root: providerRoot }], providerInstances: (["claude", "codex"] as const).map((provider) => ({ providerInstanceId: `instance-${provider}`, provider, executable: process.execPath, policyCapabilities: ["streamingText", "workspaceWrite", "interrupt", "interactiveApprovals", "gitDiff"] })) };
    const host = await createHostCatalogBindings({ store, owner, configuration, initialLegacySession: { workspaceId: "workspace-one", providerInstanceId: "instance-claude", title: "Default" }, ...(actualDefault ? {} : { runtimeFactory }), ...options });
    cleanup.push(async () => { await host.closeAndWait(50); });
    for (const provider of ["claude", "codex"] as const)
        host.providers.recordVerification(`instance-${provider}`, { state: "verified", runtimeVersion: "fixture-1", capabilities: ["streamingText", "workspaceWrite", "interrupt", "interactiveApprovals", "gitDiff"] });
    const context = (subjectId = "writer", change: Partial<CatalogRpcContext> = {}): CatalogRpcContext => ({ subjectId, capabilities: new Set([SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY]), assertAuthorized: () => { }, assertSessionScope: (id, scope) => host.assertActorSession(subjectId, id, scope), subscribe: async () => ({}), access: async () => ({}), ...change });
    const rpc = async (method: string, payload: unknown = {}, commandId?: string, ctx = context()) => { const result = await host.dispatchCatalog({ id: "request", method, payload, ...(commandId ? { commandId } : {}) }, ctx); expect(result.handled).toBe(true); return result.handled ? result.payload : undefined; };
    const create = async (commandId: string, provider = "codex") => CatalogMutationResponseSchema.parse(await rpc("session.createNew", { workspaceId: "workspace-one", providerInstanceId: `instance-${provider}`, title: commandId }, commandId));
    return { root, checkout, providerRoot, host, owner, store, configuration, runtimeFactory, context, rpc, create };
}
describe("production Host catalog binding", () => {
    it("keeps access command receipts private when called directly through the catalog port", async () => {
        const f = await fixture();
        f.store.putCommandReceipt({ authSubjectId: "reader", commandId: "access-private", method: "access.deviceRevoke", requestHash: "private-hash", state: "completed", response: { credential: "private-response" } });
        expect(await f.rpc("command.getReceipt", { commandId: "access-private" }, undefined, f.context("reader")))
            .toEqual({ found: false, commandId: "access-private" });
    });
    it("rejects foreign View interactions and applies restore/policy gates before selecting a response port", async () => {
        const foreign={interactionId:"foreign-interaction",sessionId:"foreign-session",turnId:"foreign-turn",kind:"approval" as const,version:1,status:"pending" as const,deliveryState:"none" as const,evidenceKind:"native_request" as const,request:{toolName:"Edit"},allowedActions:["deny" as const],createdAt:new Date().toISOString(),expiresAt:"2099-01-01T00:00:00.000Z",responseAvailable:true};
        const response=vi.fn(()=>({status:"accepted"}));
        const f=await fixture({readViewInteractions:()=>({interactions:[foreign],hasMore:false}),interactionsForSession:()=>({rpc:response})},true);
        const id=f.host.legacySessionId;
        expect(()=>f.host.readViewInteractions(id)).toThrow("SESSION_SCOPE_MISMATCH");
        const port=f.host.interactionsForSession(id)!;
        expect(()=>port.rpc("question.respond",{sessionId:id,interactionId:"question",expectedVersion:1,answers:[]},{authSubjectId:"approver",commandId:"question"})).toThrow("PROVIDER_CAPABILITY_UNVERIFIED");
        f.store.db.prepare("INSERT INTO host_state VALUES('restore_readiness',?,?)").run("{}",new Date().toISOString());
        expect(()=>port.rpc("interaction.respondApproval",{sessionId:id,interactionId:"approval",expectedVersion:1,action:"deny"},{authSubjectId:"approver",commandId:"approval"})).toThrow("RESTORE_EXTERNAL_STATE_UNVERIFIED");
        expect(response).not.toHaveBeenCalled();expect(f.runtimeFactory).not.toHaveBeenCalled();
    });
    it("routes two Providers and fixed legacy history through one writer without loading runtimes", async () => {
        const f = await fixture();
        const defaultId = f.host.legacySessionId;
        const second = await f.create("new-codex");
        expect(second.session.provider).toBe("codex");
        expect(second.receipt).toEqual({ commandId: "new-codex", targetSessionId: second.session.sessionId, state: "completed" });
        const before = f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get();
        const legacy = await f.rpc("session.create") as {
            session: {
                id: string;
                workspaceId: string;
            };
        };
        expect(legacy.session).toMatchObject({ id: defaultId, workspaceId: "default" });
        expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual(before);
        expect(SessionSnapshotV2Schema.parse(await f.rpc("session.getSnapshot", { sessionId: second.session.sessionId })).session.sessionId).toBe(second.session.sessionId);
        expect((await f.rpc("session.list") as {
            sessions: unknown[];
        }).sessions).toHaveLength(2);
        expect(await f.rpc("workspace.list")).toMatchObject({ workspaces: [{ workspaceId: "workspace-one" }] });
        expect(await f.rpc("provider.list")).toMatchObject({ providerInstances: [{ provider: "claude" }, { provider: "codex" }] });
        expect(f.host.workspaces.require("workspace-one")).toMatchObject({ canonicalRoot: f.providerRoot, worktreeRoot: f.checkout });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.host.capabilities()).toContain(SESSION_CATALOG_CAPABILITY);
        expect(JSON.stringify(await f.rpc("session.getSnapshot", { sessionId: second.session.sessionId }))).not.toContain(f.providerRoot);
    });
    it("fails closed on missing capability, concrete grants, wrong Host, revoked and insufficient actors", async () => {
        const f = await fixture();
        const id = f.host.legacySessionId;
        await expect(f.rpc("session.getSnapshot", { sessionId: id }, undefined, f.context("writer", { capabilities: new Set() }))).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
        const noTarget = f.context();
        delete noTarget.assertSessionScope;
        await expect(f.rpc("session.getSnapshot", { sessionId: id }, undefined, noTarget)).rejects.toMatchObject({ code: "SESSION_SCOPE_REQUIRED" });
        await expect(f.rpc("session.getSnapshot", { sessionId: id }, undefined, f.context("foreign-host"))).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
        await expect(f.rpc("session.rename", { sessionId: id, expectedRevision: 1, title: "No" }, "reader-write", f.context("reader"))).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
        f.store.db.prepare("UPDATE devices SET revoked_at=? WHERE id='writer'").run(new Date().toISOString());
        await expect(f.rpc("session.getSnapshot", { sessionId: id })).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.store.getCommandReceipt("reader", "reader-write")).toBeUndefined();
    });
    it("uses one parsed V2 binding for acceptance and returns an identical prior receipt without loading", async () => {
        const f = await fixture();
        const second = (await f.create("second")).session;
        const events: SessionEvent[] = [];
        f.host.registry.subscribe(second.sessionId, (event) => events.push(event));
        const input = { sessionId: second.sessionId, expectedRevision: second.revision, prompt: "only codex", clientMessageId: "persistent-message" };
        const result = await f.rpc("session.startTurn", input, "start-second") as {
            sessionId: string;
            turnId: string;
            receipt: {
                state: string;
            };
        };
        expect(result.sessionId).toBe(second.sessionId);
        expect(result.receipt.state).toBe("accepted");
        expect(f.store.getTurn(result.turnId)?.sessionId).toBe(second.sessionId);
        expect(f.store.getActiveTurn(f.host.legacySessionId)).toBeUndefined();
        expect(f.store.getCommandReceipt("writer", "start-second")).toMatchObject({ requestFormatVersion: 2, requestHash: f.host.registry.hashRequest("session.startTurn", input, second.sessionId), targetSessionId: second.sessionId });
        expect(events.every((event) => event.sessionId === second.sessionId)).toBe(true);
        expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
        expect(await f.rpc("session.startTurn", input, "start-second")).toEqual(result);
        expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
        await expect(f.rpc("session.startTurn", { ...input, sessionId: f.host.legacySessionId }, "start-second")).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
        await expect(f.rpc("session.startTurn", { ...input, prompt: "changed" }, "start-second")).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    });
    it("reads persisted terminal receipts for unloaded/archived targets and never crosses V1 hashes", async () => {
        const f = await fixture();
        const second = (await f.create("second")).session;
        const input = { sessionId: second.sessionId, prompt: "original" };
        f.store.putCommandReceipt({ authSubjectId: "writer", commandId: "known", method: "session.startTurn", requestFormatVersion: 2, targetSessionId: second.sessionId, requestHash: f.host.registry.hashRequest("session.startTurn", input, second.sessionId), state: "completed", response: { status: "completed" } });
        await f.rpc("session.archive", { sessionId: second.sessionId, expectedRevision: f.host.registry.get(second.sessionId).revision }, "archive");
        expect(await f.rpc("session.startTurn", input, "known")).toMatchObject({ sessionId: second.sessionId, status: "completed", receipt: { state: "completed" } });
        f.store.putCommandReceipt({ authSubjectId: "writer", commandId: "legacy", method: "session.startTurn", requestFormatVersion: 1, targetSessionId: second.sessionId, requestHash: hashCommandRequest("session.startTurn", { prompt: "original" }), state: "completed", response: { status: "completed" } });
        await expect(f.rpc("session.startTurn", input, "legacy")).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
    });
    it("rechecks actor authority after an awaited shared load and rejects client paths/extra payload fields", async () => {
        const gate = barrier<CatalogExecutionRuntime>();
        let captured!: SessionRuntimeContext;
        const f = await fixture({ runtimeFactory: (context) => { captured = context; return gate.promise; } });
        const id = f.host.legacySessionId;
        const pending = f.rpc("session.interrupt", { sessionId: id }, "wait");
        const denied = expect(pending).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
        await tick();
        f.store.db.prepare("UPDATE devices SET revoked_at=? WHERE id='writer'").run(new Date().toISOString());
        gate.resolve(new EngineRuntime(captured));
        await denied;
        const fresh = await fixture();
        await expect(fresh.rpc("session.startTurn", { sessionId: fresh.host.legacySessionId, prompt: "hello", cwd: "/arbitrary-client" }, "path")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
        expect(fresh.runtimeFactory).not.toHaveBeenCalled();
    });
    it("journals accepted runtime-close before its effect, reports unknown stop, and never replays it", async () => {
        const f = await fixture();
        const id = f.host.legacySessionId;
        const runtime = await f.host.registry.ensureLoaded(id) as EngineRuntime;
        const stopped = barrier<RuntimeCloseReport>();
        runtime.closeAndWait.mockImplementation(() => stopped.promise);
        const input = { sessionId: id, expectedRevision: f.host.registry.get(id).revision };
        const close = f.rpc("session.closeRuntime", input, "close-runtime");
        await tick();
        expect(f.store.getCommandReceipt("writer", "close-runtime")?.state).toBe("accepted");
        expect(f.host.catalog.runtimeCloseForSession(id)?.state).toBe("accepted");
        expect(await f.rpc("session.closeRuntime", input, "close-runtime")).toMatchObject({ receipt: { state: "accepted" } });
        expect(runtime.closeAndWait).toHaveBeenCalledTimes(1);
        stopped.resolve({ closed: true, producerStopped: false, clean: false, state: "recovery_required" });
        expect(await close).toMatchObject({ session: { residency: "blocked" }, receipt: { state: "outcome_unknown" } });
        expect(await f.rpc("session.closeRuntime", input, "close-runtime")).toMatchObject({ receipt: { state: "outcome_unknown" } });
        expect(runtime.closeAndWait).toHaveBeenCalledTimes(1);
        await expect(f.host.registry.ensureLoaded(id)).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    });
    it("blocks all restored writes/loads while history remains readable and never closes the shared writer", async () => {
        const f = await fixture();
        const id = f.host.legacySessionId;
        f.store.db.prepare("INSERT INTO host_state VALUES('restore_readiness',?,?)").run(JSON.stringify({ state: "ready" }), new Date().toISOString());
        expect(SessionSnapshotV2Schema.parse(await f.rpc("session.getSnapshot", { sessionId: id })).session.residency).toBe("blocked");
        await expect(f.rpc("session.rename", { sessionId: id, expectedRevision: 1, title: "blocked" }, "restore")).rejects.toMatchObject({ code: "RESTORE_EXTERNAL_STATE_UNVERIFIED" });
        await expect(f.host.registry.ensureLoaded(id)).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        const close = vi.spyOn(f.store, "close");
        await f.host.closeAndWait();
        expect(close).not.toHaveBeenCalled();
        f.owner.assertActive();
    });
    it("requires Provider capability evidence and approval authority does not require session:write", async () => {
        const f = await fixture();
        const id = f.host.legacySessionId;
        f.host.providers.recordVerification("instance-claude", { state: "unverified", capabilities: [] });
        await expect(f.rpc("session.startTurn", { sessionId: id, prompt: "hello" }, "unverified")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNVERIFIED" });
        expect(f.store.getCommandReceipt("writer", "unverified")).toBeUndefined();
        f.host.providers.recordVerification("instance-claude", { state: "verified", runtimeVersion: "fixture", capabilities: ["interactiveApprovals"] });
        expect(await f.rpc("approval.respond", { sessionId: id, approvalId: "old", action: "deny" }, "approval-only", f.context("approver"))).toMatchObject({ sessionId: id, receipt: { state: "completed" } });
    });
    it("opens Views and reads Interaction directories for unloaded Sessions without starting a Provider", async () => {
        const f = await fixture({}, true);
        const second = (await f.create("history")).session;
        const id = second.sessionId;
        f.store.commitEvent(id, "assistant.message.completed", { itemId: "saved", text: `history ${f.providerRoot}`, dispatchContext: { nativeRequestId: "private-request" } }, { providerSessionId: "private-conversation" });
        const viewOwner = { subjectId: "writer", leaseId: "lease-one", generation: 1 };
        const connection = f.host.views!.connect(viewOwner, new JsonTimelineBudget(), () => f.host.assertActorSession("writer", id, "session:read"));
        cleanup.push(() => connection.close());
        const context = f.context("writer", { viewOwner: () => viewOwner, openView: (request) => connection.openView(request, async () => { }).response });
        const opened = await f.rpc("session.openView", { sessionId: id, tailLimit: 20 }, undefined, context) as {
            snapshot: unknown;
        };
        expect(opened.snapshot).toMatchObject({ session: { sessionId: id, nativeSessionAvailable: true }, pendingInteractions: [] });
        expect(await f.host.interactionsForSession(id)!.rpc("interaction.list", { sessionId: id }, { authSubjectId: "writer" })).toEqual({ interactions: [], hasMore: false });
        expect(JSON.stringify(opened)).not.toContain("private-conversation");
        expect(JSON.stringify(opened)).not.toContain("private-request");
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        await f.rpc("session.archive", { sessionId: id, expectedRevision: f.host.registry.get(id).revision }, "archive-history");
        expect(f.host.views!.ready(id)).toBe(true);
    });
    it("constructs the actual shared Orchestrator with the global Views and closes only its Session", async () => {
        let runtime: SessionOrchestrator | undefined;
        const f = await fixture({ runtimeFactory: (context, services) => {
                const adapter: ProviderAdapter = { provider: context.session.provider, workspace: context.workspace.canonicalRoot, status: async () => ({ provider: context.session.provider, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", workspace: context.workspace.canonicalRoot, sandboxRequired: true }), preflight: async () => { throw new Error("Paid preflight forbidden"); }, runTurn: async () => { throw new Error("Real Provider forbidden"); }, interrupt: async () => "already_terminal", respondApproval: () => false };
                runtime = new SessionOrchestrator({ owner: context.owner, store: context.store, sessionId: context.session.sessionId, ownsStore: false, recoverOnStart: false, runtimeId: context.runtimeId, workspace: context.workspace.canonicalRoot, checkoutRoot: context.workspace.worktreeRoot, provider: context.session.provider, adapter, ...(services.views ? { hostViews: services.views } : {}) });
                return runtime;
            } });
        const loaded = await f.host.registry.ensureLoaded(f.host.legacySessionId);
        expect(loaded).toBe(runtime);
        expect(runtime!.views).toBe(f.host.views);
        expect(runtime!.checkoutRoot).toBe(f.checkout);
        expect(await f.rpc("session.closeRuntime", { sessionId: f.host.legacySessionId, expectedRevision: f.host.registry.get(f.host.legacySessionId).revision }, "real-close")).toMatchObject({ session: { residency: "unloaded" }, receipt: { state: "completed" } });
        expect(f.store.db.open).toBe(true);
        expect(f.host.views!.ready(f.host.legacySessionId)).toBe(true);
        f.owner.assertActive();
    });
    it("keeps the Server/Gateway legacy facade read-only and delegates global lifecycle without a default worker", async () => {
        const f = await fixture();
        const legacy = f.host.legacyHost;
        expect(legacy.sessionId).toBe(f.host.legacySessionId);
        expect(legacy.workspace).toBe(f.providerRoot);
        expect(legacy.checkoutRoot).toBe(f.checkout);
        expect(legacy.publicSnapshot().session.workspaceId).toBe("default");
        expect(legacy.snapshot().session.id).toBe(f.host.legacySessionId);
        expect((await legacy.providerStatus()).runtimeVersion).toBe("fixture-1");
        await legacy.gitStatus();
        legacy.timeline();
        await expect(legacy.startTurn("writer", "fallback", "hello")).rejects.toMatchObject({ code: "SESSION_ROUTING_REQUIRED" });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        const closeTransport = vi.fn(async () => { expect(f.store.db.open).toBe(true); });
        legacy.registerTransportShutdown(closeTransport);
        const first = legacy.closeAndWait();
        expect(legacy.closeAndWait()).toBe(first);
        expect(await first).toMatchObject({ clean: true });
        expect(closeTransport).toHaveBeenCalledTimes(1);
        expect(f.store.db.open).toBe(true);
    });
    it("rejects a foreign runtime without stopping the other Session or closing the shared writer", async () => {
        let first: EngineRuntime | undefined;
        const f = await fixture({ runtimeFactory: (context) => first ??= new EngineRuntime(context) });
        await f.host.registry.ensureLoaded(f.host.legacySessionId);
        const second = (await f.create("second")).session;
        await expect(f.host.registry.ensureLoaded(second.sessionId)).rejects.toMatchObject({ code: "CATALOG_RUNTIME_BINDING_INVALID" });
        expect(first!.closeAndWait).not.toHaveBeenCalled();
        expect(f.host.registry.loaded(f.host.legacySessionId)).toBe(first);
        expect(f.host.catalog.requireSession(second.sessionId).residency).toBe("blocked");
        expect(f.store.db.open).toBe(true);
        f.owner.assertActive();
    });
    it("uses the actual unpaid native preparation path, journals a bounded close during loading and keeps a late result blocked", async () => {
        const prepared = barrier<NativeBoundaryAssessment>();
        const started = barrier<void>();
        const preflight = vi.spyOn(ClaudeAdapter.prototype, "preflight").mockImplementation(async () => { throw new Error("Paid preflight forbidden"); });
        const f = await fixture({ runtimeCloseDeadlineMs: 5, runtimeOptions: () => ({ nativeBoundaryFactory: async () => { started.resolve(); return prepared.promise; } }) }, false, true);
        const id = f.host.legacySessionId;
        const loading = f.rpc("session.interrupt", { sessionId: id }, "preparing");
        const rejected = expect(loading).rejects.toThrow();
        await started.promise;
        try {
            const close = await f.rpc("session.closeRuntime", { sessionId: id, expectedRevision: f.host.registry.get(id).revision }, "bounded-close") as CatalogMutationResponse;
            expect(close.receipt.state).toBe("outcome_unknown");
            expect(close.session.residency).toBe("blocked");
            expect(f.host.catalog.runtimeCloseForSession(id)?.runtimeId).toBeTypeOf("string");
            expect(preflight).not.toHaveBeenCalled();
            expect(f.store.db.open).toBe(true);
        }
        finally {
            prepared.resolve({ ready: false, code: "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE", summary: { ready: false, code: "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE", platform: process.platform } });
            await rejected;
            preflight.mockRestore();
        }
        expect(f.host.catalog.runtimeCloseForSession(id)?.state).toBe("outcome_unknown");
        await expect(f.host.registry.ensureLoaded(id)).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    });
    it("rejects a duplicate graph and bounds an uncertain global drain", async () => {
        const f = await fixture({ globalServices: [{ drain: () => new Promise(() => { }), seal: vi.fn() }] });
        await expect(createHostCatalogBindings({ store: f.store, owner: f.owner, configuration: f.configuration })).rejects.toMatchObject({ code: "CATALOG_ALREADY_OPEN" });
        const closing = f.host.closeAndWait(5);
        expect(f.host.closeAndWait(5000)).toBe(closing);
        expect(await closing).toContainEqual(expect.objectContaining({ clean: false, state: "recovery_required" }));
        expect(f.host.capabilities()).toEqual([]);
        expect(f.store.db.open).toBe(true);
    });
    it("does not advertise or install007 until the central runner declares its validated shape", async () => {
        const owner = createTestHostOwner();
        const store = new SqliteStore(":memory:", { mode: "test-fixture", fixtureSchema: FROZEN_V6_SCHEMA });
        cleanup.push(() => { store.close(); owner.release(); });
        const before = store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
        await expect(createHostCatalogBindings({ owner, store, configuration: {} })).rejects.toMatchObject({ code: "CATALOG_SCHEMA_UNAVAILABLE" });
        expect(store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    });
});
