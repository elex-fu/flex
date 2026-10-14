import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_CONTENT_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, InteractionSchema, type SessionEvent } from "@flyx/mvp-protocol";
import { createHostInteractionBindings, createHostInteractions, assertInteractionCapabilities } from "./host-interactions.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { SqliteStore } from "../storage/db.js";
import { FROZEN_V6_SCHEMA } from "../test-support/frozen-v6-schema.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { applyInteractionMigration } from "../storage/migrations/008-interactions.js";
import { DeviceRegistry } from "../auth/device-registry.js";
import { ConnectionGateway, type DuplexTransport } from "../api/connection-gateway.js";
import { RpcDispatcher, type RpcContext } from "../api/rpc-dispatcher.js";
import { assertMethodScope } from "../auth/connection-authorizer.js";
import { ExecutionWorker } from "../orchestration/execution-worker.js";
import { fenceAdapterEvent, type DispatchContext, type ProviderAdapter, type ProviderOutcome } from "../provider/types.js";
function barrier<T = void>() { let release!: (value: T) => void; const promise = new Promise<T>((yes) => { release = yes; }); return { promise, release }; }
const terminal: ProviderOutcome = { status: "completed", providerSessionId: "native-session", evidence: { kind: "native-terminal", sourceId: "native-terminal" } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse())
    await close();
  vi.restoreAllMocks();
});
function fixture(options: {
  migrated?: boolean;
  verification?: boolean;
  stage?: (stage: string, kind: string) => Promise<void> | void;
} = {}) {
  const owner = createTestHostOwner();
  const store = options.migrated === false
    ? new SqliteStore(":memory:", { mode: "test-fixture", fixtureSchema: FROZEN_V6_SCHEMA })
    : openOwned({ databasePath: ":memory:", owner });
  if (options.migrated === false) applyCatalogMigration(store.db);
  else applyInteractionMigration(store.db);
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const outcome = barrier<ProviderOutcome>();
  let context: DispatchContext | undefined;
  let host!: SessionOrchestrator;
  const status = { provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", workspace, sandboxRequired: true as const };
  const approvalDelivery = vi.fn((approvalId: string, action: "allow_once" | "deny") => {
    host.ingestAdapterEvent(fenceAdapterEvent(context!, { kind: "approval_resolved", approvalId, toolUseId: `native-${approvalId}`, action }));
    return true;
  });
  const questionDelivery = vi.fn(() => ({ kind: "local-delivery" as const }));
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: vi.fn(async () => status), preflight: async () => { throw new Error("No paid Provider preflight"); },
    runTurn: async () => { throw new Error("beginTurn required"); }, beginTurn: (value) => { context = value; return { outcome: outcome.promise }; },
    interrupt: vi.fn(async () => "accepted" as const), respondApproval: approvalDelivery, respondQuestion: questionDelivery,
    // A synthetic method cannot advertise a real native contract.
    structuredQuestionsAvailable: () => true,
  };
  const bindings = createHostInteractionBindings({ evidenceSource: "fixture", ...(options.verification ? { allowVerificationFlow: true } : {}) });
  const attention = vi.fn((events: readonly SessionEvent[]) => {
    for (const event of events)
      if (event.type === "interaction.requested") {
        expect(store.db.inTransaction).toBe(true);
        expect(store.db.prepare("SELECT status FROM interactions WHERE interaction_id=?").get((event.payload as {
          interactionId: string;
        }).interactionId)).toEqual({ status: "pending" });
      }
  });
  const constructor = {
    workspace, store, owner, adapter, canReleaseWorkspace: () => true, interactionEvents: bindings.interactionEvents,
    ...(options.migrated !== false ? { readViewInteractions: bindings.readViewInteractions } : {}),
    ...(options.stage ? { executionHooks: { stage: (stage: string, intent: {
          kind: string;
        }) => options.stage!(stage, intent.kind) } } : {}),
    executionSetup: (runtime: SessionOrchestrator) => { bindings.executionSetup(runtime); store.registerCommitHook(attention); },
  };
  host = new SessionOrchestrator(constructor);
  const devices = new DeviceRegistry(store, "interaction-host");
  const starter = devices.createBrowserDevice({ scopes: ["session:read", "session:write"] });
  const responder = devices.createBrowserDevice({ scopes: ["session:read", "approval:write"] });
  const second = devices.createBrowserDevice({ scopes: ["session:read", "approval:write"] });
  const reader = devices.createBrowserDevice({ scopes: ["session:read"] });
  const gateway = new ConnectionGateway({ hostId: "interaction-host", fingerprint: "sha256:" + "a".repeat(64), orchestrator: host, devices,
    bootstrap: () => host.bootstrap(), descriptor: () => ({ hostId: "interaction-host" }), confirmPairing: () => true, maxFrameBytes: 64 * 1024,
    interactions: (id) => id === host.sessionId ? bindings.interactions() : undefined, interactionCapabilities: bindings.capabilities });
  const start = async () => { const accepted = await host.startTurn(starter.id, "start", "fixture task"); await host.worker.drainDispatch(); return accepted.turnId; };
  const approval = async (id = "approval") => {
    host.ingestAdapterEvent(fenceAdapterEvent(context!, { kind: "approval_requested", request: {
        approvalId: id, turnId: context!.flyxTurnId, toolUseId: `native-${id}`, toolName: "Bash", input: { command: "npm test" }, title: "Run tests", description: "Verify the change", cwd: workspace,
        createdAt: new Date().toISOString(), dispatchContext: { nativeRequestId: `native-${id}`, nativeMethod: "canUseTool/approval" },
      } }));
    await host.ingestion.drain();
  };
  const question = async (id = "question") => {
    host.ingestAdapterEvent(fenceAdapterEvent(context!, { kind: "question_requested", request: { interactionId: id, turnId: context!.flyxTurnId,
        nativeRequestId: `native-${id}`, nativeMethod: "canUseTool/AskUserQuestion", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        request: { blocking: true, questions: [{ questionId: `host-q-${id}`, header: "Choice", question: "Pick one", options: [{ optionId: "host-option", label: "One", description: "First" }], multiSelect: false, allowFreeText: true, secret: false }] },
      } }));
    await host.ingestion.drain();
  };
  const finish = async () => {
    if (context && store.getActiveTurn(host.sessionId))
      host.ingestAdapterEvent(fenceAdapterEvent(context, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }));
    outcome.release(terminal);
    await host.worker.drainOperations();
  };
  cleanup.push(async () => { await finish(); gateway.close(); bindings.close(); devices.close(); host.close(); });
  return { host, store, owner, adapter, starter, responder, second, reader, gateway, bindings, attention, start, approval, question, finish, context: () => context!, questionDelivery, approvalDelivery };
}
type Sent = Record<string, any>;
class Transport implements DuplexTransport {
  readonly id = randomUUID();
  readonly generation = 11;
  readonly sent: Sent[] = [];
  readonly incoming = new Set<(frame: string | Uint8Array) => void>();
  readonly closing = new Set<(info: {
    code?: number;
    reason?: string;
  }) => void>();
  private sequence = 0;
  constructor(readonly kind: "direct" | "relay") { }
  async send(raw: string | Uint8Array) { this.sent.push(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))); }
  close(_code?: number, reason?: string) {
    for (const callback of this.closing)
      callback({ ...(reason ? { reason } : {}) });
  }
  onMessage(callback: (frame: string | Uint8Array) => void) { this.incoming.add(callback); return () => { this.incoming.delete(callback); }; }
  onClose(callback: (info: {
    code?: number;
    reason?: string;
  }) => void) { this.closing.add(callback); return () => { this.closing.delete(callback); }; }
  emit(frame: unknown) {
    for (const callback of this.incoming)
      callback(JSON.stringify(frame));
  }
  async wait(predicate: (frame: Sent) => boolean): Promise<Sent> {
    for (let i = 0; i < 200; i++) {
      const found = this.sent.find(predicate);
      if (found)
        return found;
      await new Promise<void>((yes) => setImmediate(yes));
    }
    throw new Error("Expected Gateway response");
  }
  hello(deviceId: string) { this.emit({ type: "client.hello", hostId: "interaction-host", deviceId, clientId: "interaction-test", protocol: { min: 2, max: 2 }, capabilities: [BOUNDED_CONTENT_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, INTERACTION_CAPABILITY], transportGeneration: this.generation }); return this.wait((frame) => frame.type === "server.hello"); }
  request(method: string, payload: unknown, commandId?: string) { const id = `rpc-${++this.sequence}`; this.emit({ type: "request", id, method, payload, ...(commandId ? { commandId } : {}), transportGeneration: this.generation }); return this.wait((frame) => frame.type === "response" && frame.id === id); }
}
async function connect(f: ReturnType<typeof fixture>, id: string, kind: "direct" | "relay" = "direct") { const transport = new Transport(kind); f.gateway.attach(transport, { deviceId: id }); await transport.hello(id); return transport; }
// Fixture answer fault tests use the trusted verification seam. They never negotiate or advertise a native contract.
function verificationAnswer(f: ReturnType<typeof fixture>, payload: unknown, commandId: string): Sent {
  const interactions = f.bindings.interactions()!;
  expect(interactions.service.questionCapability(f.host.sessionId)).toBe(false);
  return { ok: true, payload: interactions.rpc("question.respond", payload, { authSubjectId: f.responder.id, commandId }) };
}
describe("bounded Host interaction production connection", () => {
  for (const kind of ["direct", "relay"] as const)
    it(`keeps Access receipts outside the session:read business receipt namespace through ${kind} RPC`, async () => {
      const f = fixture({ migrated: false });
      const transport = await connect(f, f.reader.id, kind);
      for (const method of ["access.revokeSelf", "access.revokeDevice", "access.revokeAll", "access.revokeAllDevices", "access.pair", "access.refresh"]) {
        f.store.putCommandReceipt({ authSubjectId: f.reader.id, commandId: method, method, requestHash: method, state: "completed", response: { opaque: "credential-must-not-be-exposed" } });
        const response = await transport.request("command.getReceipt", { commandId: method });
        expect(response.ok).toBe(true);
        expect(response.payload).toEqual({ found: false, commandId: method });
      }
      f.store.putCommandReceipt({ authSubjectId: f.reader.id, commandId: "business", method: "session.interrupt", requestHash: "business", state: "completed", response: { status: "completed" } });
      expect((await transport.request("command.getReceipt", { commandId: "business" })).payload).toMatchObject({ found: true, method: "session.interrupt", response: { status: "completed" } });
      expect(JSON.stringify(transport.sent)).not.toContain("credential-must-not-be-exposed");
    });
  it("authorizes only exact catalog read and mutation methods before its optional dispatcher port", () => {
    const reader = new Set(["session:read"]);
    const writer = new Set(["session:write"]);
    for (const method of ["workspace.list", "provider.list", "session.list", "session.getSnapshot"]) {
      expect(() => assertMethodScope(reader, method)).not.toThrow();
      expect(() => assertMethodScope(writer, method)).toThrow("session:read");
    }
    for (const method of ["session.createNew", "session.rename", "session.archive", "session.unarchive", "session.closeRuntime"]) {
      expect(() => assertMethodScope(writer, method)).not.toThrow();
      expect(() => assertMethodScope(reader, method)).toThrow("session:write");
    }
    expect(() => assertMethodScope(new Set(["session:read", "session:write"]), "session.arbitraryMutation")).toThrow("not supported");
  });
  it("exports exact capability contracts and rejects v1 or unnegotiated structured responses", () => {
    const base = new Set([INTERACTION_CAPABILITY]);
    const questions = new Set([INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY]);
    expect(() => assertInteractionCapabilities("interaction.get", 2, base)).not.toThrow();
    expect(() => assertInteractionCapabilities("interaction.respondApproval", 2, base)).not.toThrow();
    expect(() => assertInteractionCapabilities("question.respond", 2, questions)).not.toThrow();
    expect(() => assertInteractionCapabilities("question.respond", 2, base)).toThrow("negotiated v2 capabilities");
    expect(() => assertInteractionCapabilities("interaction.get", 1, questions)).toThrow("negotiated v2 capabilities");
    expect(() => assertInteractionCapabilities("interaction.get", 2, new Set())).toThrow("negotiated v2 capabilities");
    expect(() => assertInteractionCapabilities("approval.respond", 1, new Set())).not.toThrow();
  });
  it("waits for centrally activated008 and never enables question capability from a synthetic Adapter", () => {
    const f = fixture({ migrated: false });
    expect(createHostInteractions(f.host)).toBeUndefined();
    expect(f.host.interactionRpcPort).toBeUndefined();
    expect(f.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get()).toBeUndefined();
    const ready = fixture({ verification: true });
    expect(ready.bindings.interactions()).toBeDefined();
    expect(ready.bindings.interactions()!.service.questionCapability(ready.host.sessionId)).toBe(false);
    expect(ready.bindings.capabilities()).toEqual([INTERACTION_CAPABILITY]);
  });
  it("routes strict concrete Session RPC through the catalog and enforces only its exact target scope", async () => {
    const f = fixture({ migrated: false });
    const scopes = new Set(["approval:write"]);
    const order: string[] = [];
    const authorize = vi.fn((method: string) => { order.push("method"); assertMethodScope(scopes, method); });
    const gate = vi.fn((sessionId: string, scope: string) => { order.push("target"); expect(sessionId).toBe("catalog-session"); expect(scopes.has(scope)).toBe(true); });
    const rpc = vi.fn(() => ({ status: "accepted", dispatchContext: { nativeRequestId: "private" } }));
    const resolvePort = vi.fn((sessionId: string) => { order.push("port"); expect(sessionId).toBe("catalog-session"); return { rpc }; });
    const catalog = vi.fn(async () => { order.push("catalog"); return { handled: false as const }; });
    const dispatcher = new RpcDispatcher({ orchestrator: f.host, bootstrap: () => ({}), descriptor: () => ({}), catalogPort: { dispatchCatalog: catalog, interactionsForSession: resolvePort } });
    const context: RpcContext = { subjectId: "approval-only-actor", assertAuthorized: authorize, assertSessionScope: gate, subscribe: async () => ({}), access: async () => ({}) };
    const answer = { sessionId: "catalog-session", interactionId: "question", expectedVersion: 1, answers: [{ questionId: "q", optionIds: ["o"] }] };
    expect(await dispatcher.dispatch({ id: "request", method: "question.respond", commandId: "answer", payload: answer }, context)).toEqual({ status: "accepted" });
    expect(order).toEqual(["method", "catalog", "target", "port"]);
    expect(gate).toHaveBeenLastCalledWith("catalog-session", "approval:write");
    expect(rpc).toHaveBeenLastCalledWith("question.respond", answer, { authSubjectId: "approval-only-actor", commandId: "answer" });
    expect(scopes.has("session:write")).toBe(false);
    expect(scopes.has("session:read")).toBe(false);
    scopes.add("session:read");
    await dispatcher.dispatch({ id: "read", method: "interaction.list", payload: { sessionId: "catalog-session" } }, context);
    expect(gate).toHaveBeenLastCalledWith("catalog-session", "session:read");
    expect(rpc).toHaveBeenLastCalledWith("interaction.list", { sessionId: "catalog-session" }, { authSubjectId: "approval-only-actor" });
    const called = resolvePort.mock.calls.length;
    await expect(dispatcher.dispatch({ id: "bad", method: "question.respond", commandId: "bad", payload: { ...answer, nativeRequestId: "private" } }, context)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(resolvePort).toHaveBeenCalledTimes(called);
    await expect(dispatcher.dispatch({ id: "bad", method: "question.respond", commandId: "bad", payload: answer }, { ...context, assertSessionScope: () => { throw new Error("SESSION_ACCESS_DENIED"); } })).rejects.toThrow("SESSION_ACCESS_DENIED");
    expect(resolvePort).toHaveBeenCalledTimes(called);
    const { assertSessionScope: _gate, ...ungated } = context;
    await expect(dispatcher.dispatch({ id: "ungated", method: "question.respond", commandId: "bad", payload: answer }, ungated)).rejects.toMatchObject({ code: "SESSION_SCOPE_REQUIRED" });
    expect(resolvePort).toHaveBeenCalledTimes(called);
  });
  it("dispatches catalog methods after authorization before the legacy Session check", async () => {
    const f = fixture({ migrated: false });
    const order: string[] = [];
    const dispatcher = new RpcDispatcher({ orchestrator: f.host, bootstrap: () => ({}), descriptor: () => ({}), catalogPort: { dispatchCatalog: async (frame) => { order.push("catalog"); expect(frame.payload).toEqual({ sessionId: "catalog-session" }); return { handled: true, payload: { sessionId: "catalog-session" } }; } } });
    const context: RpcContext = { subjectId: f.reader.id, assertAuthorized: (method) => { order.push("method"); assertMethodScope(new Set(["session:read"]), method); }, subscribe: async () => ({}), access: async () => ({}) };
    expect(await dispatcher.dispatch({ id: "catalog", method: "session.getEvents", payload: { sessionId: "catalog-session" } }, context)).toEqual({ sessionId: "catalog-session" });
    expect(order).toEqual(["method", "catalog"]);
  });
  it("attaches before worker.start and attention reads committed interaction projection in the same transaction", async () => {
    const original = ExecutionWorker.prototype.start;
    const register = ExecutionWorker.prototype.registerControl;
    let attached = false;
    const registered: string[] = [];
    vi.spyOn(ExecutionWorker.prototype, "registerControl").mockImplementation(function (this: ExecutionWorker, kind, deliver, commit) { registered.push(kind); return register.call(this, kind, deliver, commit); });
    const start = vi.spyOn(ExecutionWorker.prototype, "start").mockImplementation(function (this: ExecutionWorker) { attached = ["respond_question", "respond_approval"].every((kind) => registered.includes(kind)); expect(attached).toBe(true); return original.call(this); });
    const f = fixture();
    expect(start).toHaveBeenCalledOnce();
    expect(f.host.interactionRpcPort).toBeDefined();
    expect(attached).toBe(true);
    await f.start();
    await f.approval();
    expect(f.attention).toHaveBeenCalled();
    expect(f.bindings.interactions()!.service.interactions.get("approval")?.status).toBe("pending");
  });
  for (const kind of ["direct", "relay"] as const)
    it(`ingests native approval and delivers the same atomic reservation through scoped ${kind} RPC`, async () => {
      const f = fixture();
      await f.start();
      await f.approval();
      const transport = await connect(f, f.responder.id, kind);
      const listed = await transport.request("interaction.list", { sessionId: f.host.sessionId });
      expect(listed.ok).toBe(true);
      expect(listed.payload.interactions).toHaveLength(1);
      const current = InteractionSchema.parse((await transport.request("interaction.get", { sessionId: f.host.sessionId, interactionId: "approval" })).payload);
      expect(current.responseAvailable).toBe(true);
      expect(current.kind).toBe("approval");
      const result = await transport.request("interaction.respondApproval", { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: current.version, action: "allow_once" }, "answer");
      expect(result.ok).toBe(true);
      expect(result.payload.status).toBe("accepted");
      await f.host.worker.drainDispatch();
      await f.host.ingestion.drain();
      expect(f.approvalDelivery).toHaveBeenCalledOnce();
      expect(f.store.getCommandReceipt(f.responder.id, "answer")).toMatchObject({ state: "completed", response: { status: "delivered" } });
      expect(f.bindings.interactions()!.service.interactions.get("approval")).toMatchObject({ status: "delivered", deliveryState: "local_delivery" });
      expect(f.host.store.getActiveTurn(f.host.sessionId)?.status).toBe("running");
      expect(f.host.timeline(0).events.filter((event) => event.type === "approval.requested" || event.type === "approval.resolved")).toEqual([]);
      expect(JSON.stringify(transport.sent)).not.toContain("native-approval");
      expect(JSON.stringify(transport.sent)).not.toContain(f.owner.ownerId);
    });
  it("requires approval:write for both methods and rejects malformed, stale and foreign Session targets before mutation", async () => {
    const f = fixture({ verification: true });
    await f.start();
    await f.approval();
    await f.question();
    const reader = await connect(f, f.reader.id);
    const writer = await connect(f, f.responder.id);
    for (const method of ["question.respond", "interaction.respondApproval"])
      expect((await reader.request(method, {}, `denied-${method}`)).error.code).toBe("FORBIDDEN");
    const head = f.host.snapshot().session.headSequence;
    expect((await writer.request("interaction.respondApproval", { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: 99, action: "deny" }, "stale")).error.code).toBe("INTERACTION_VERSION_CONFLICT");
    const badAnswer = { sessionId: f.host.sessionId, interactionId: "question", expectedVersion: 0, answers: [{ questionId: "host-q-question", optionIds: ["One"] }] };
    expect((await writer.request("question.respond", badAnswer, "bad-answer")).error.code).toBe("CAPABILITY_REQUIRED");
    expect(() => verificationAnswer(f, badAnswer, "bad-answer")).toThrow("QUESTION_ANSWER_INVALID");
    expect((await writer.request("interaction.get", { sessionId: "foreign", interactionId: "approval" })).error.code).toBe("SESSION_NOT_FOUND");
    expect((await writer.request("interaction.get", { sessionId: f.host.sessionId, interactionId: "approval", extra: true })).error.code).toBe("INVALID_PARAMS");
    expect(f.host.snapshot().session.headSequence).toBe(head);
    expect(f.approvalDelivery).not.toHaveBeenCalled();
    expect(f.questionDelivery).not.toHaveBeenCalled();
  });
  it("uses first-device expectedVersion CAS and preserves legacy approval.respond compatibility", async () => {
    const f = fixture();
    await f.start();
    await f.approval();
    const a = await connect(f, f.responder.id);
    const b = await connect(f, f.second.id);
    const payload = { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: 0, action: "allow_once" };
    const responses = await Promise.all([a.request("interaction.respondApproval", payload, "answer"), b.request("interaction.respondApproval", { ...payload, action: "deny" }, "answer")]);
    expect(responses.map((response) => response.ok).sort()).toEqual([false, true]);
    await f.host.worker.drainDispatch();
    expect(f.approvalDelivery).toHaveBeenCalledOnce();
    await f.approval("legacy");
    expect(await f.host.respondApproval(f.responder.id, "legacy-answer", "legacy", "deny")).toEqual({ status: "accepted", approvalId: "legacy" });
    await f.host.worker.drainDispatch();
    expect(f.bindings.interactions()!.service.execution.reservation("legacy")?.intentId).toBe(f.bindings.interactions()!.service.interactions.reservation("legacy")?.intentId);
  });
  it("preserves a trusted V2 target request through the legacy approval façade", async () => {
    const f = fixture();
    await f.start();
    await f.approval();
    const request = { authSubjectId: f.responder.id, commandId: "catalog-answer", method: "approval.respond", requestHash: "f".repeat(64), requestFormatVersion: 2 as const, targetSessionId: f.host.sessionId };
    const before = f.host.snapshot().session.headSequence;
    await expect(f.host.respondApproval(f.responder.id, request.commandId, "approval", "deny", { ...request, targetSessionId: "foreign" })).rejects.toMatchObject({ code: "COMMAND_SCOPE_MISMATCH" });
    await expect(f.host.respondApproval(f.responder.id, request.commandId, "approval", "deny", { ...request, authSubjectId: f.second.id })).rejects.toMatchObject({ code: "COMMAND_SCOPE_MISMATCH" });
    expect(f.host.snapshot().session.headSequence).toBe(before);
    expect(f.approvalDelivery).not.toHaveBeenCalled();
    expect(await f.host.respondApproval(f.responder.id, request.commandId, "approval", "deny", request)).toEqual({ status: "accepted", approvalId: "approval" });
    expect(f.store.getCommandReceipt(f.responder.id, request.commandId)).toMatchObject({ requestHash: request.requestHash, requestFormatVersion: 2, targetSessionId: f.host.sessionId });
    expect(f.host.execution.forCommand(f.responder.id, request.commandId)[0]).toMatchObject({ requestHash: request.requestHash, requestFormatVersion: 2, dispatchContext: f.context() });
    await f.host.worker.drainDispatch();
    await f.host.respondApproval(f.responder.id, request.commandId, "approval", "deny", request);
    expect(f.approvalDelivery).toHaveBeenCalledOnce();
    await expect(f.host.respondApproval(f.responder.id, request.commandId, "approval", "deny", { ...request, requestHash: "e".repeat(64) })).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
  });
  it("keeps terminal containment and recovery-blocked Session history readable but inoperable", async () => {
    const f = fixture();
    await f.start();
    await f.approval();
    const transport = await connect(f, f.responder.id);
    f.store.db.prepare("UPDATE sessions SET recovery_state='blocked' WHERE id=?").run(f.host.sessionId);
    expect((await transport.request("interaction.get", { sessionId: f.host.sessionId, interactionId: "approval" })).payload.responseAvailable).toBe(false);
    expect((await transport.request("interaction.respondApproval", { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: 0, action: "deny" }, "blocked")).ok).toBe(false);
    expect(f.store.getCommandReceipt(f.responder.id, "blocked")).toBeUndefined();
    f.store.db.prepare("UPDATE sessions SET recovery_state='idle' WHERE id=?").run(f.host.sessionId);
    f.store.db.prepare("UPDATE turns SET status='completed' WHERE id=?").run(f.context().flyxTurnId);
    const before = f.host.snapshot().session.headSequence;
    expect((await transport.request("interaction.get", { sessionId: f.host.sessionId, interactionId: "approval" })).payload.responseAvailable).toBe(false);
    expect((await transport.request("interaction.respondApproval", { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: 0, action: "deny" }, "terminal")).ok).toBe(false);
    expect(f.store.getCommandReceipt(f.responder.id, "terminal")).toBeUndefined();
    expect(f.host.snapshot().session.headSequence).toBe(before);
    expect(f.approvalDelivery).not.toHaveBeenCalled();
  });
  it("settles a native request gone before delivery without a delivery claim", async () => {
    const f = fixture({ verification: true });
    await f.start();
    await f.question();
    delete f.adapter.respondQuestion;
    const transport = await connect(f, f.responder.id);
    const payload = { sessionId: f.host.sessionId, interactionId: "question", expectedVersion: 0, answers: [{ questionId: "host-q-question", optionIds: ["host-option"] }] };
    expect((await transport.request("question.respond", payload, "answer")).error.code).toBe("CAPABILITY_REQUIRED");
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toBeUndefined();
    expect(verificationAnswer(f, payload, "answer").ok).toBe(true);
    await f.host.worker.drainDispatch();
    expect(f.questionDelivery).not.toHaveBeenCalled();
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toMatchObject({ state: "failed", response: { status: "superseded", deliveryState: "none" } });
    expect(f.bindings.interactions()!.service.interactions.get("question")).toMatchObject({ status: "superseded", deliveryState: "none" });
  });
  it("keeps partial native delivery uncertain and never replays a receipt after the native call throws", async () => {
    const f = fixture({ verification: true });
    await f.start();
    await f.question();
    f.questionDelivery.mockImplementation(() => { throw new Error("stdin closed after partial write"); });
    const transport = await connect(f, f.responder.id);
    const payload = { sessionId: f.host.sessionId, interactionId: "question", expectedVersion: 0, answers: [{ questionId: "host-q-question", optionIds: ["host-option"] }] };
    expect((await transport.request("question.respond", payload, "answer")).error.code).toBe("CAPABILITY_REQUIRED");
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toBeUndefined();
    expect(verificationAnswer(f, payload, "answer").ok).toBe(true);
    await f.host.worker.drainDispatch();
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toMatchObject({ state: "outcome_unknown", response: { status: "outcome_unknown", deliveryState: "unconfirmed" } });
    expect(verificationAnswer(f, payload, "answer").payload.status).toBe("outcome_unknown");
    await f.host.worker.drainDispatch();
    expect(f.questionDelivery).toHaveBeenCalledOnce();
  });
  it("rolls back response source, receipt, reservation and intent without calling native delivery", async () => {
    const f = fixture();
    await f.start();
    await f.approval();
    const transport = await connect(f, f.responder.id);
    const before = f.host.snapshot().session;
    f.store.db.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON interaction_reservations BEGIN SELECT RAISE(ABORT,'reservation failure'); END");
    const response = await transport.request("interaction.respondApproval", { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: 0, action: "allow_once" }, "answer");
    expect(response.ok).toBe(false);
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toBeUndefined();
    expect(f.host.execution.forCommand(f.responder.id, "answer")).toEqual([]);
    expect(f.bindings.interactions()!.service.interactions.reservation("approval")).toBeUndefined();
    expect(f.host.snapshot().session).toEqual(before);
    expect(f.approvalDelivery).not.toHaveBeenCalled();
    f.store.db.exec("DROP TRIGGER fail_answer");
  });
  it("keeps a locally delivered question separate from Turn terminal and advertises no fixture contract", async () => {
    const f = fixture({ verification: true });
    await f.start();
    await f.question();
    const transport = await connect(f, f.responder.id);
    const current = InteractionSchema.parse((await transport.request("interaction.get", { sessionId: f.host.sessionId, interactionId: "question" })).payload);
    expect(current.responseAvailable).toBe(false);
    const payload = { sessionId: f.host.sessionId, interactionId: "question", expectedVersion: 0, answers: [{ questionId: "host-q-question", optionIds: ["host-option"] }] };
    expect((await transport.request("question.respond", payload, "answer")).error.code).toBe("CAPABILITY_REQUIRED");
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toBeUndefined();
    const result = verificationAnswer(f, payload, "answer");
    expect(result.ok).toBe(true);
    await f.host.worker.drainDispatch();
    expect(f.questionDelivery).toHaveBeenCalledOnce();
    expect(f.store.getCommandReceipt(f.responder.id, "answer")?.response).toMatchObject({ status: "delivered", deliveryState: "local_delivery" });
    expect(f.store.getActiveTurn(f.host.sessionId)?.status).toBe("running");
    expect(f.bindings.interactions()!.service.questionCapability(f.host.sessionId)).toBe(false);
  });
  it("makes terminal supersession canonical in the same commit and never delivers the queued obsolete answer", async () => {
    const entered = barrier();
    const release = barrier();
    const f = fixture({ stage: async (stage, kind) => {
        if (kind === "respond_approval" && stage === "before_claim") {
          entered.release();
          await release.promise;
        }
      } });
    cleanup.push(async () => { release.release(); });
    await f.start();
    await f.approval();
    const transport = await connect(f, f.responder.id);
    expect((await transport.request("interaction.respondApproval", { sessionId: f.host.sessionId, interactionId: "approval", expectedVersion: 0, action: "allow_once" }, "answer")).ok).toBe(true);
    await entered.promise;
    const before = f.host.snapshot().session.headSequence;
    f.host.ingestAdapterEvent(fenceAdapterEvent(f.context(), { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }));
    await f.host.ingestion.drain();
    const batch = f.host.timeline(before).events;
    expect(batch.map((event) => event.type)).toEqual(["interaction.superseded", "turn.completed"]);
    expect(f.host.store.listEventCommits(f.host.sessionId).at(-1)).toMatchObject({ firstSequence: before + 1, lastSequence: before + 2 });
    expect(f.store.getCommandReceipt(f.responder.id, "answer")).toMatchObject({ state: "failed", response: { status: "superseded" } });
    release.release();
    await f.host.worker.drainDispatch();
    expect(f.approvalDelivery).not.toHaveBeenCalled();
  });
  it("serves an authoritative paged directory and history reads do not inspect or start a Provider", async () => {
    const f = fixture();
    await f.start();
    for (let i = 0; i < 60; i++)
      await f.approval(`approval-${i}`);
    const transport = await connect(f, f.responder.id);
    const first = await transport.request("interaction.list", { sessionId: f.host.sessionId });
    expect(first.payload.interactions).toHaveLength(50);
    expect(first.payload.hasMore).toBe(true);
    const second = await transport.request("interaction.list", { sessionId: f.host.sessionId, afterInteractionId: first.payload.nextAfterInteractionId });
    expect(second.payload.interactions).toHaveLength(10);
    expect(second.payload.hasMore).toBe(false);
    const calls = f.adapter.status as ReturnType<typeof vi.fn>;
    expect(calls).not.toHaveBeenCalled();
    const view = await transport.request("session.openView", { sessionId: f.host.sessionId, tailLimit: 5 });
    expect(view.ok).toBe(true);
    expect(view.payload.interactions.total).toBe(60);
    expect(view.payload.interactions.directoryRevision).toBe(view.payload.watermark.sequence);
    expect(view.payload.interactions.complete ? view.payload.interactions.items.length : view.payload.interactions.ref).toBeTruthy();
    expect(JSON.stringify(view.payload)).not.toContain("native-approval");
    expect(calls).not.toHaveBeenCalled();
  });
});
