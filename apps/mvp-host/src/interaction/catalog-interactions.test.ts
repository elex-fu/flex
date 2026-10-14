import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, type Interaction } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { AccessError } from "../auth/connection-authorizer.js";
import { createHostAttentionBindings } from "../attention/host-attention.js";
import { createHostCatalogBindings } from "../catalog/host-catalog.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { ExecutionWorker } from "../orchestration/execution-worker.js";
import { InteractionStore } from "./interaction-store.js";
import { fenceAdapterEvent, type DispatchContext, type ProviderAdapter, type ProviderOutcome } from "../provider/types.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import type { SessionRuntimeContext } from "../session/session-registry.js";
import { openOwned } from "../storage/open-store.js";
import { createCatalogInteractionBindings, type CatalogInteractionBindings, type CatalogInteractionsOptions } from "./catalog-interactions.js";
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
  await close(); vi.restoreAllMocks(); });
function barrier<T = void>() { let release!: (value: T) => void; const promise = new Promise<T>((resolve) => { release = resolve; }); return { promise, release }; }
const terminal: ProviderOutcome = { status: "completed", providerSessionId: "fixture-native", evidence: { kind: "native-terminal", sourceId: "fixture-terminal" } };
async function fixture(change: {
  admission?: CatalogInteractionsOptions["assertAdmission"];
  block?: ReturnType<typeof barrier<void>>;
  entered?: ReturnType<typeof barrier<void>>;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-catalog-interactions-"))), checkout = join(root, "checkout"), workspace = join(checkout, "app");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", checkout]);
  const owner = createTestHostOwner(), store = openOwned({ databasePath: ":memory:", owner });
  cleanup.push(() => { store.close(); owner.release(); });
  store.setHostIdentityMirror({ hostId: "interaction-catalog", fingerprint: "trusted-fingerprint" });
  const devices = new DeviceRegistry(store, "interaction-catalog"), starter = devices.createBrowserDevice(), approver = devices.createBrowserDevice({ scopes: ["approval:write"] }), reader = devices.createBrowserDevice({ scopes: ["session:read"] });
  cleanup.push(() => devices.close());
  const denied = new Set<string>(), active = { admission: true };
  let bindings!: CatalogInteractionBindings;
  const runtimes: Array<{
    host: SessionOrchestrator;
    context: SessionRuntimeContext;
    outcome: ReturnType<typeof barrier<ProviderOutcome>>;
    native?: DispatchContext;
    adapter: ProviderAdapter;
    deliver: ReturnType<typeof vi.fn<(id: string) => boolean>>;
  }> = [];
  const runtimeFactory = vi.fn<(context: SessionRuntimeContext) => void>(() => { });
  const catalog = await createHostCatalogBindings({ store, owner, configuration: {
      workspaces: [{ workspaceId: "workspace", root: workspace, capabilities: ["streamingText", "workspaceWrite", "interrupt", "interactiveApprovals", "structuredQuestions"] }],
      providerInstances: [{ providerInstanceId: "provider", provider: "claude", executable: process.execPath, policyCapabilities: ["streamingText", "workspaceWrite", "interrupt", "interactiveApprovals", "structuredQuestions"] }],
    }, initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" },
    readViewInteractions: (id, after) => bindings.readViewInteractions(id, after),
    assertSessionAccess: (actor, target) => { if (denied.has(actor) || denied.has(target.session.sessionId))
      throw new AccessError("FORBIDDEN", "Session grant denied"); },
    runtimeFactory: (context, services) => {
      runtimeFactory(context);
      const outcome = barrier<ProviderOutcome>();
      let native: DispatchContext | undefined;
      const deliver = vi.fn((_id: string) => true);
      const adapter: ProviderAdapter = { provider: "claude", workspace, status: vi.fn(async () => { throw new Error("No Provider status call"); }), preflight: vi.fn(async () => { throw new Error("No Provider preflight"); }), runTurn: async () => { throw new Error("beginTurn required"); },
        beginTurn: (original) => { native = original; const entry = runtimes.find((entry) => entry.host.runtimeId === original.runtimeId); if (entry)
          entry.native = original; return { outcome: outcome.promise }; },
        interrupt: async () => "accepted", respondApproval: deliver, structuredQuestionsAvailable: () => true,
      };
      const options = bindings.runtimeOptions(context);
      const host = new SessionOrchestrator({ ...options, store, owner, sessionId: context.session.sessionId, runtimeId: context.runtimeId, ownsStore: false, recoverOnStart: false, workspace, checkoutRoot: checkout, adapter, ...(services.views ? { hostViews: services.views } : {}), canReleaseWorkspace: () => true,
        executionHooks: change.block ? { stage: async (stage, intent) => { if (stage === "after_marker" && intent.kind === "respond_approval") {
            change.entered?.release();
            await change.block!.promise;
          } } } : {},
      });
      runtimes.push({ host, context, outcome, adapter, deliver, ...(native ? { native } : {}) });
      return host;
    },
  });
  const hook = vi.spyOn(store, "registerCommitHook"), before = store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
  bindings = createCatalogInteractionBindings({ catalog, assertAdmission: change.admission ?? (() => { if (!active.admission)
      throw new Error("HOST_DRAINING"); }) });
  expect(store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  catalog.providers.recordVerification("provider", { state: "verified", runtimeVersion: "fixture", capabilities: ["streamingText", "workspaceWrite", "interrupt", "interactiveApprovals", "structuredQuestions"] });
  const first = catalog.legacySessionId, second = catalog.registry.createNew({ authSubjectId: starter.id, commandId: "second" }, { workspaceId: "workspace", providerInstanceId: "provider", title: "Second" }).summary.sessionId;
  const start = async (sessionId = first) => { const host = await catalog.registry.ensureLoaded(sessionId) as SessionOrchestrator; const response = await host.startTurn(starter.id, `start-${host.runtimeId}`, "fixture work"); await host.worker.drainDispatch(); const runtime = runtimes.find((entry) => entry.host === host)!; expect(runtime.native).toBeDefined(); return { ...runtime, turnId: response.turnId }; };
  const approval = async (runtime: Awaited<ReturnType<typeof start>>, id: string) => { runtime.host.ingestAdapterEvent(fenceAdapterEvent(runtime.native!, { kind: "approval_requested", request: { approvalId: id, turnId: runtime.turnId, toolUseId: `native-${id}`, toolName: "Bash", input: { command: `cat ${workspace}/safe.txt` }, cwd: workspace, createdAt: new Date().toISOString(), dispatchContext: { nativeRequestId: `native-${id}`, nativeMethod: "canUseTool/approval" } } })); await runtime.host.ingestion.drain(); };
  const finish = async (runtime: typeof runtimes[number]) => { if (runtime.native && store.getActiveTurn(runtime.host.sessionId)) {
    runtime.host.ingestAdapterEvent(fenceAdapterEvent(runtime.native, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }));
    await runtime.host.ingestion.drain();
  } runtime.outcome.release(terminal); await runtime.host.worker.drainOperations(); };
  cleanup.push(async () => { change.block?.release(); if (store.db.open) for (const runtime of runtimes) {
    await finish(runtime);
    await runtime.host.closeAndWait();
  } await bindings.shutdownService.drain(Date.now() + 1000); bindings.shutdownService.close(); if (store.db.open) await catalog.closeAndWait(); });
  return { root, workspace, store, owner, devices, starter, approver, reader, catalog, first, second, bindings, active, hook, runtimeFactory, denied, runtimes, start, approval, finish };
}
function response(id: string, sessionId: string) { return { sessionId, interactionId: id, expectedVersion: 0, action: "deny" as const }; }
describe("Catalog interaction bindings", () => {
  it("anchors pure SQL10 metadata before Attention without loading a Provider or creating another projection hook", async () => {
    const f = await fixture();
    const ensure = vi.spyOn(f.catalog.registry, "ensureLoaded");
    expect(f.bindings.interactionCapabilities()).toEqual([INTERACTION_CAPABILITY]);
    expect(f.hook).toHaveBeenCalledOnce();
    expect(f.bindings.service.list(f.second)).toEqual({ interactions: [], hasMore: false });
    expect(f.bindings.readViewInteractions(f.second)).toEqual({ interactions: [], hasMore: false });
    const attention = createHostAttentionBindings({ store: f.store, owner: f.owner, hostId: "interaction-catalog", devices: f.devices, interactions: f.bindings.service, readInteraction: f.bindings.readInteraction,
      assertActorSession: (actor, id) => f.catalog.assertActorSession(actor, id, "session:read"), assertDeliveryReady: () => { }, trackDelivery: (work) => work(), pollMs: 60000 });
    cleanup.push(async () => { await attention.drain(Date.now() + 1000); attention.seal(); });
    expect(f.hook).toHaveBeenCalledTimes(2);
    expect(ensure).not.toHaveBeenCalled();
    expect(f.runtimeFactory).not.toHaveBeenCalled();
    const a = await f.start();
    await f.approval(a, "approval");
    expect(f.bindings.readInteraction(f.first, "approval")).toMatchObject({ status: "pending", responseAvailable: false, request: { commandPreview: "cat ./safe.txt" } });
    expect(f.catalog.readViewInteractions(f.first).interactions).toEqual([expect.objectContaining({ responseAvailable: true, request: expect.objectContaining({ commandPreview: "cat ./safe.txt" }) })]);
    expect((f.catalog.interactionsForSession(f.first)!.rpc("interaction.get", { sessionId: f.first, interactionId: "approval" }, { authSubjectId: f.reader.id }) as Interaction).responseAvailable).toBe(true);
    expect(f.store.db.prepare("SELECT kind FROM attention_facts WHERE interaction_id='approval'").get()).toEqual({ kind: "approval" });
    expect(f.hook).toHaveBeenCalledTimes(2);
    expect(() => f.bindings.service.respondApproval(f.approver.id, "metadata-answer", response("approval", f.first))).toThrow("INTERACTION_METADATA_ONLY");
    expect(f.store.getCommandReceipt(f.approver.id, "metadata-answer")).toBeUndefined();
    expect(a.deliver).not.toHaveBeenCalled();
  });
  it("pages the current directory without RPC actors or Provider loads and makes blocked metadata inoperable", async () => {
    const f = await fixture(), a = await f.start();
    for (let index = 0; index < 51; index++) await f.approval(a, `directory-${index}`);
    const ensure = vi.spyOn(f.catalog.registry, "ensureLoaded"), rpc = vi.spyOn(a.host.interactionRpcPort!, "rpc");
    const page = f.catalog.readViewInteractions(f.first);
    expect(page).toMatchObject({ hasMore: true, nextAfterInteractionId: expect.any(String) });
    expect(page.interactions).toHaveLength(50);
    expect(page.interactions.every((item) => (item as Interaction).responseAvailable)).toBe(true);
    const tail = f.bindings.readViewInteractions(f.first, page.nextAfterInteractionId);
    expect(tail).toMatchObject({ hasMore: false }); expect(tail.interactions).toHaveLength(1);
    expect(new Set([...page.interactions, ...tail.interactions].map((item) => (item as Interaction).interactionId)).size).toBe(51);
    expect(() => f.bindings.readViewInteractions(f.second, page.nextAfterInteractionId)).toThrow("INTERACTION_CURSOR_INVALID");
    f.store.db.prepare("UPDATE sessions SET recovery_state='blocked' WHERE id=?").run(f.first);
    expect(f.bindings.readViewInteractions(f.first).interactions.every((item) => !(item as Interaction).responseAvailable)).toBe(true);
    f.store.db.prepare("UPDATE sessions SET recovery_state='idle' WHERE id=?").run(f.first);
    f.active.admission = false;
    expect(f.bindings.readViewInteractions(f.first).interactions.every((item) => !(item as Interaction).responseAvailable)).toBe(true);
    f.active.admission = true;
    expect(ensure).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled(); expect(f.runtimeFactory).toHaveBeenCalledOnce();
    expect(a.adapter.status).not.toHaveBeenCalled(); expect(a.adapter.preflight).not.toHaveBeenCalled();
  });
  it("uses actual per-Session worker delivery and full target hashes while the global metadata service remains the same anchor", async () => {
    const f = await fixture(), service = f.bindings.service;
    const a = await f.start();
    await f.approval(a, "first");
    const port = a.host.interactionRpcPort!, request = response("first", f.first);
    expect(port.rpc("interaction.respondApproval", request, { authSubjectId: f.approver.id, commandId: "first-answer" })).toMatchObject({ status: "accepted", deliveryState: "accepted" });
    expect(f.store.getCommandReceipt(f.approver.id, "first-answer")).toMatchObject({ requestFormatVersion: 2, targetSessionId: f.first, requestHash: f.catalog.registry.hashRequest("interaction.respondApproval", request, f.first) });
    await a.host.worker.drainDispatch();
    expect(a.deliver).toHaveBeenCalledOnce();
    expect(f.bindings.readInteraction(f.first, "first")).toMatchObject({ version: 2, status: "delivered", deliveryState: "local_delivery", responseAvailable: false });
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM interaction_reservations WHERE interaction_id='first'").get()).toEqual({ n: 1 });
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM interaction_delivery_evidence WHERE interaction_id='first'").get()).toEqual({ n: 1 });
    await f.finish(a);
    const b = await f.start(f.second);
    await f.approval(b, "second");
    expect(() => port.rpc("interaction.respondApproval", response("second", f.second), { authSubjectId: f.approver.id, commandId: "cross" })).toThrow("SESSION_NOT_FOUND");
    expect(b.host.interactionRpcPort!.rpc("interaction.respondApproval", response("second", f.second), { authSubjectId: f.approver.id, commandId: "second-answer" })).toMatchObject({ status: "accepted" });
    await b.host.worker.drainDispatch();
    expect(b.deliver).toHaveBeenCalledOnce();
    expect(f.bindings.readInteraction(f.second, "second").version).toBe(2);
    expect(f.bindings.service).toBe(service);
    expect(f.hook).toHaveBeenCalledOnce();
    expect(f.store.db.pragma("foreign_key_check")).toEqual([]);
  });
  it("does not promote a fixture method or Catalog version claim into a structured question capability", async () => {
    const f = await fixture(), a = await f.start();
    expect(a.adapter.structuredQuestionsAvailable?.()).toBe(true);
    expect(f.bindings.interactionCapabilities()).toEqual([INTERACTION_CAPABILITY]);
    await f.approval(a, "approval");
    expect(() => a.host.interactionRpcPort!.rpc("question.respond", { sessionId: f.first, interactionId: "question", expectedVersion: 0, answers: [{ questionId: "q", optionIds: ["one"] }] }, { authSubjectId: f.approver.id, commandId: "unverified" })).toThrow("PROVIDER_CAPABILITY_UNVERIFIED");
    a.host.ingestAdapterEvent(fenceAdapterEvent(a.native!, { kind: "question_requested", request: { interactionId: "question", turnId: a.turnId, nativeRequestId: "native-question", nativeMethod: "canUseTool/AskUserQuestion", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), request: { blocking: true, questions: [{ questionId: "q", header: "Pick", question: "Pick one", options: [{ optionId: "one", label: "One", description: "First" }], multiSelect: false, allowFreeText: false, secret: false }] } } }));
    await a.host.ingestion.drain();
    expect(() => f.bindings.readInteraction(f.first, "question")).toThrow("INTERACTION_NOT_FOUND");
    expect(f.store.getTurn(a.turnId)?.status).toBe("outcome_unknown");
    expect(f.bindings.readInteraction(f.first, "approval")).toMatchObject({ status: "superseded", responseAvailable: false });
    expect(f.bindings.interactionCapabilities()).not.toContain(STRUCTURED_QUESTION_CAPABILITY);
    expect(f.store.getCommandReceipt(f.approver.id, "unverified")).toBeUndefined();
    expect(a.deliver).not.toHaveBeenCalled();
    for (const runtime of f.runtimes) {
      expect(runtime.adapter.status).not.toHaveBeenCalled();
      expect(runtime.adapter.preflight).not.toHaveBeenCalled();
    }
  });
  it("rechecks actor, target ACL, current policy and Host admission before accepting a cached runtime response", async () => {
    const f = await fixture(), a = await f.start();
    await f.approval(a, "approval");
    const port = a.host.interactionRpcPort!;
    f.denied.add(f.approver.id);
    expect(() => port.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "denied" })).toThrow("Session grant denied");
    f.denied.clear();
    f.active.admission = false;
    expect(() => port.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "draining" })).toThrow("HOST_DRAINING");
    expect((port.rpc("interaction.get", { sessionId: f.first, interactionId: "approval" }, { authSubjectId: f.reader.id }) as Interaction).responseAvailable).toBe(false);
    f.active.admission = true;
    const provider = f.catalog.providers.get("provider")!;
    f.catalog.catalog.putProvider({ ...provider, policyVersion: provider.policyVersion + 1 });
    expect(() => port.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "changed" })).toThrow("INTERACTION_RESOURCE_MISMATCH");
    f.catalog.catalog.putProvider(provider);
    f.devices.revokeDevice(f.starter.id, f.approver.id);
    expect(() => port.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "revoked" })).toThrow();
    for (const id of ["denied", "draining", "changed", "revoked"])
      expect(f.store.getCommandReceipt(f.approver.id, id)).toBeUndefined();
    expect(a.deliver).not.toHaveBeenCalled();
  });
  it("checks fresh authorization again after the worker marker and never calls a revoked native responder", async () => {
    const entered = barrier(), block = barrier(), f = await fixture({ entered, block }), a = await f.start();
    await f.approval(a, "approval");
    a.host.interactionRpcPort!.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "answer" });
    await entered.promise;
    f.devices.revokeDevice(f.starter.id, f.approver.id);
    block.release();
    await a.host.worker.drainDispatch();
    expect(a.deliver).not.toHaveBeenCalled();
    expect(f.store.getCommandReceipt(f.approver.id, "answer")?.state).not.toBe("completed");
    expect(f.bindings.readInteraction(f.first, "approval").deliveryState).not.toBe("native_confirmation");
  });
  it("keeps one hook and original metadata through two loaded runtimes, close/reload, and compound terminal supersession", async () => {
    const f = await fixture(), service = f.bindings.service, a = await f.start();
    await f.approval(a, "old");
    const cached = a.host.interactionRpcPort!;
    const before = f.store.getSession(f.first)!.headSequence;
    await f.finish(a);
    expect(f.store.listEvents(f.first, before).events.map((event) => event.type)).toEqual(["interaction.superseded", "turn.completed"]);
    expect(f.bindings.readInteraction(f.first, "old")).toMatchObject({ version: 1, status: "superseded" });
    const b = await f.start(f.second);
    await f.approval(b, "second");
    await f.catalog.registry.closeRuntime(f.first);
    expect(f.bindings.service).toBe(service);
    expect(f.bindings.readInteraction(f.second, "second").status).toBe("pending");
    expect(f.hook).toHaveBeenCalledOnce();
    const reloaded = await f.catalog.registry.ensureLoaded(f.first);
    expect(reloaded).not.toBe(a.host);
    expect(() => cached.rpc("interaction.respondApproval", response("old", f.first), { authSubjectId: f.approver.id, commandId: "old-retry" })).toThrow("INTERACTION_RUNTIME_BINDING_INVALID");
    expect(f.bindings.readInteraction(f.first, "old").version).toBe(1);
    expect(f.hook).toHaveBeenCalledOnce();
    expect(f.bindings.service).toBe(service);
  });
  it("keeps recovery companions and projection live during drain and detaches only after every runtime is sealed", async () => {
    const f = await fixture(), a = await f.start();
    await f.approval(a, "approval");
    await f.bindings.shutdownService.drain(Date.now() + 1000);
    expect(f.bindings.interactionCapabilities()).toEqual([]);
    expect(() => f.bindings.shutdownService.close()).toThrow("INTERACTION_RUNTIME_NOT_DRAINED");
    const companions = f.bindings.companionEvents(f.first, a.turnId, "recovery_acknowledged");
    const committed = f.store.commitCommand({ sessionId: f.first, build: () => ({ result: undefined, events: [...companions, { type: "test.recovery.compound", payload: { turnId: a.turnId } }] }) })!;
    f.catalog.registry.publishCommittedEvents(committed.events);
    expect(f.bindings.readInteraction(f.first, "approval")).toMatchObject({ status: "superseded", version: 1 });
    expect(f.bindings.supersedeInteractions(f.first, { attemptId: a.native!.attemptId, runtimeGeneration: a.native!.runtimeGeneration }, "again")).toBe(0);
    await f.finish(a);
    await a.host.closeAndWait();
    f.bindings.shutdownService.close();
    f.bindings.shutdownService.close();
    expect(f.store.db.open).toBe(true);
    expect(f.bindings.interactionCapabilities()).toEqual([]);
    expect(() => f.bindings.readInteraction(f.first, "approval")).toThrow("INTERACTIONS_UNAVAILABLE");
  });
  it("force-seals an unsealed held runtime and fences retained settlement and source hooks across Store closure", async () => {
    const registered = vi.spyOn(ExecutionWorker.prototype, "registerControl"), entered = barrier(), block = barrier();
    const f = await fixture({ entered, block }), a = await f.start();
    await f.approval(a, "approval");
    const port = a.host.interactionRpcPort!, hooks = f.bindings.runtimeOptions(a.context), control = registered.mock.calls.find(([kind]) => kind === "respond_approval");
    if (!control?.[2]) throw new Error("Fixture control settlement missing");
    const [_, deliver, settle] = control;
    port.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "held-answer" });
    await entered.promise;
    const intent = a.host.execution.forCommand(f.approver.id, "held-answer").find((value) => value.kind === "respond_approval")!;
    const before = { receipt: f.store.getCommandReceipt(f.approver.id, "held-answer"), intent: a.host.execution.get(intent.id), row: f.bindings.service.interactions.get("approval") };
    expect(before.row).toMatchObject({ status: "responding", version: 1, deliveryState: "accepted" });
    expect(a.host.worker.isSealed).toBe(false);
    const source = fenceAdapterEvent(a.native!, { kind: "approval_resolved", approvalId: "approval", toolUseId: "native-approval", action: "deny" });
    const sql = vi.spyOn(f.store.db, "prepare"), transaction = vi.spyOn(f.store.db, "transaction"), publication = vi.spyOn(a.host, "publishCommittedEvent"), catalogPublication = vi.spyOn(f.catalog.registry, "publishCommittedEvents");
    const projection = vi.spyOn(InteractionStore.prototype, "projectCommittedBatch");
    f.bindings.shutdownService.seal();
    f.bindings.shutdownService.seal();
    expect(a.host.worker.isSealed).toBe(false);
    expect(a.host.interactionRpcPort).toBeUndefined();
    const late = () => {
      expect(f.bindings.interactionCapabilities()).toEqual([]);
      expect(hooks.interactionEvents!.handle(source)).toBe(true);
      expect(hooks.interactionEvents!.handle(fenceAdapterEvent(a.native!, { kind: "turn_completed", result: "late", costUsd: 0, numTurns: 1 }))).toBe(true);
      expect(hooks.interactionEvents!.companionEvents(f.first, a.turnId, "late")).toEqual([]);
      expect(f.bindings.supersedeInteractions(f.first, { attemptId: a.native!.attemptId, runtimeGeneration: a.native!.runtimeGeneration }, "late")).toBe(0);
      expect(deliver(intent, a.native!)).toMatchObject({ status: "not_dispatched" });
      expect(settle(intent, { status: "delivered", evidence: { kind: "local-delivery" } })).toBeUndefined();
      expect(f.bindings.service.recordDelivery(intent.id, { kind: "native-ack", sourceId: "late-proof", nativeRequestId: "native-approval" })).toBe(false);
      expect(f.bindings.service.planSupersessionEvents(f.first, { turnId: a.turnId })).toEqual([]);
      expect(f.bindings.service.expireDue(f.first)).toBe(0);
      expect(() => f.bindings.service.get(f.first, "approval")).toThrow("INTERACTIONS_UNAVAILABLE");
      expect(() => f.bindings.service.list(f.first)).toThrow("INTERACTIONS_UNAVAILABLE");
      expect(() => f.bindings.readInteraction(f.first, "approval")).toThrow("INTERACTIONS_UNAVAILABLE");
      expect(() => f.bindings.readViewInteractions(f.first)).toThrow("INTERACTIONS_UNAVAILABLE");
      expect(() => port.rpc("interaction.get", { sessionId: f.first, interactionId: "approval" }, { authSubjectId: f.reader.id })).toThrow("INTERACTIONS_UNAVAILABLE");
      expect(() => port.rpc("interaction.respondApproval", response("approval", f.first), { authSubjectId: f.approver.id, commandId: "late-answer" })).toThrow("INTERACTIONS_UNAVAILABLE");
      expect(() => hooks.revalidateDevice!(intent)).toThrow("INTERACTIONS_UNAVAILABLE");
      f.bindings.shutdownService.close();
    };
    late();
    expect(sql).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); expect(publication).not.toHaveBeenCalled(); expect(catalogPublication).not.toHaveBeenCalled(); expect(a.deliver).not.toHaveBeenCalled();
    sql.mockRestore(); transaction.mockRestore();
    expect({ receipt: f.store.getCommandReceipt(f.approver.id, "held-answer"), intent: a.host.execution.get(intent.id), row: f.bindings.service.interactions.get("approval") }).toEqual(before);
    // Runtime fencing is a separate lifecycle action; the interaction seal claimed no stop proof.
    const closing = a.host.closeAndWait(10);
    block.release();
    a.outcome.release({ status: "outcome_unknown", error: "fixture_stop_unproven", evidence: { kind: "unknown", reason: "fixture_stop_unproven" } });
    await closing; await f.catalog.closeAndWait(10);
    expect(projection).not.toHaveBeenCalled();
    publication.mockClear(); catalogPublication.mockClear();
    const closedSql = vi.spyOn(f.store.db, "prepare"), closedTransaction = vi.spyOn(f.store.db, "transaction");
    f.store.close();
    expect(f.store.db.open).toBe(false);
    late();
    expect(closedSql).not.toHaveBeenCalled(); expect(closedTransaction).not.toHaveBeenCalled(); expect(publication).not.toHaveBeenCalled(); expect(catalogPublication).not.toHaveBeenCalled(); expect(a.deliver).not.toHaveBeenCalled();
  });
  it("rejects forged runtime ownership/target contexts and future schema without preparing a Native runtime", async () => {
    const f = await fixture(), resource = f.catalog.registry.resolve(f.first), context: SessionRuntimeContext = { ...resource, store: f.store, owner: f.owner, runtimeId: "runtime", ownsStore: false, recoverOnStart: false };
    expect(() => f.bindings.runtimeOptions({ ...context, owner: { ...f.owner } })).toThrow("INTERACTION_RUNTIME_BINDING_INVALID");
    expect(() => f.bindings.runtimeOptions({ ...context, session: { ...context.session, providerInstanceId: "foreign" } })).toThrow("INTERACTION_RUNTIME_BINDING_INVALID");
    const options = f.bindings.runtimeOptions(context);
    expect(f.bindings.runtimeOptions(context)).toBe(options);
    f.store.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(11,?)").run(new Date().toISOString());
    expect(f.bindings.interactionCapabilities()).toEqual([]);
    expect(() => createCatalogInteractionBindings({ catalog: f.catalog, assertAdmission: () => { } })).toThrow();
    f.store.db.prepare("DELETE FROM schema_migrations WHERE version=11").run();
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
});
