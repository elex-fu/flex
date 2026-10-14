import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionWorker } from "../orchestration/execution-worker.js";
import { RuntimeRegistry } from "../provider/runtime-registry.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStore, type ApprovalRow } from "../storage/db.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn, decideApprovalReservation } from "../orchestration/decider.js";
import { applyInteractionMigration } from "../storage/migrations/008-interactions.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { FROZEN_V6_SCHEMA } from "../test-support/frozen-v6-schema.js";
import { InteractionService } from "./interaction-service.js";
import { interactionFence } from "./types.js";
import { parseClaudeQuestions } from "./native-question-codec.js";
import { interactionRpc, InteractionRpcError } from "./interaction-rpc.js";
import { ingestInteractionEvent, registerInteractionControls, type InteractionControlWorker, type InteractionControlOutcome } from "./interaction-runtime.js";
import type { DispatchContext, ProviderAdapter, TurnOutcome } from "../provider/types.js";
import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
const stores: SqliteStore[] = [];
const services: InteractionService[] = [];
afterEach(() => { while (services.length)
  services.pop()!.close(); while (stores.length)
  stores.pop()!.close(); });
function setup(migrate = true) {
  const store = migrate ? new SqliteStore() : new SqliteStore(":memory:", { mode: "test-fixture", fixtureSchema: FROZEN_V6_SCHEMA });
  if (!migrate) applyCatalogMigration(store.db);
  stores.push(store);
  const session = store.createSession("/tmp/fixture", "claude", "session");
  let now = "2026-10-15T00:00:00.000Z";
  let runtimeId = "runtime";
  let seq = 0;
  const wake = vi.fn();
  const publish = vi.fn();
  const engine = new CommandEngine(store, { clock: { now: () => now, id: () => `id-${++seq}` }, wake, publish });
  for (const id of ["device-a", "device-b"])
    store.createDevice({ id, hostId: "host", platform: "test", credentialKind: "browser-session", scopes: ["session:read", "approval:write"], credentialRevision: 1, createdAt: now });
  const request = { authSubjectId: "device-a", commandId: "start", method: "session.startTurn", targetSessionId: session.id, requestHash: hashCommandRequest("session.startTurn", { prompt: "task" }) };
  const accepted = engine.commitRequest(request, (facts, clock) => decideAcceptTurn(facts, request, { prompt: "task" }, clock));
  const turn = store.getTurn(accepted.result.turnId)!;
  const context: DispatchContext = { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: session.id, flyxTurnId: turn.id, runtimeId, runtimeGeneration: turn.generation, attemptId: turn.attemptId! };
  if (migrate)
    applyInteractionMigration(store.db, now);
  const makeService = () => { const service = new InteractionService(engine, { resolveSession: () => ({ provider: "claude", workspaceId: "workspace", runtimeId, adapterVersion: "sdk", runtimeVersion: "native" }), questionCapability: () => true, now: () => now, publish }); services.push(service); return service; };
  const service = migrate ? makeService() : undefined;
  const mapping = parseClaudeQuestions("native-tool", { questions: [{ header: "Color", question: "Pick a color", multiSelect: false, options: [{ label: "Red", description: "First" }, { label: "Blue", description: "Second" }] }] });
  const native = { interactionId: "question", turnId: turn.id, nativeRequestId: "native-tool", nativeMethod: "canUseTool/AskUserQuestion" as const, request: mapping.request, createdAt: now, expiresAt: "2026-10-15T00:10:00.000Z" };
  const input = { sessionId: session.id, interactionId: native.interactionId, expectedVersion: 0, answers: [{ questionId: mapping.request.questions[0]!.questionId, optionIds: [mapping.request.questions[0]!.options[0]!.optionId] }] };
  const ingest = () => service!.ingestQuestion(interactionFence(context), native);
  wake.mockClear();
  publish.mockClear();
  return { store, session, engine, service: service!, turn, context, native, input, mapping, ingest, wake, publish, makeService, setNow: (value: string) => { now = value; }, setRuntime: (value: string) => { runtimeId = value; } };
}
function count(store: SqliteStore, table: string): number { return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
  n: number;
}).n; }
function snapshot(store: SqliteStore) { return { counts: Object.fromEntries(["session_events", "event_commits", "timeline_items", "command_receipts", "execution_intents", "interactions", "interaction_reservations", "interaction_delivery_evidence"].map((table) => [table, count(store, table)])), session: store.getSession("session"), interactions: store.db.prepare("SELECT * FROM interactions").all() }; }
function intent(f: ReturnType<typeof setup>, command = "answer") { return f.service.execution.forCommand("device-a", command)[0]!; }
function approval(f: ReturnType<typeof setup>, id = "approval"): ApprovalRow { return { approvalId: id, sessionId: f.session.id, turnId: f.turn.id, toolUseId: "native-approval", version: 0, status: "pending", request: { toolName: "Bash", title: "Run tests" }, createdAt: f.native.createdAt }; }
describe("typed atomic Interaction service", () => {
  it.each(["completed", "failed", "cancelled"] as const)("retires requests for an actual committed R07 %s source without confirming possibly delivered control", (status) => {
    const f = setup(); f.ingest(); f.service.respondQuestion("device-a", "answer", f.input);
    const accepted = intent(f); f.service.execution.claim(accepted.id, { id: "owner", generation: 1 }); f.service.execution.transition({ id: accepted.id, expectedStates: ["claimed"], state: "dispatching" });
    f.store.commitEvent(f.session.id, "turn.recovery.reconciled", { turnId: f.turn.id, turnStatus: status, attemptId: f.context.attemptId, gate: "blocked" }, { turnId: f.turn.id, turnStatus: status });
    expect(f.service.interactions.get("question")).toMatchObject({ version: 2, status: "superseded", deliveryState: "unconfirmed" });
    expect(f.store.getCommandReceipt("device-a", "answer")).toMatchObject({ state: "outcome_unknown", response: { status: "superseded" } });
    expect(f.store.db.prepare("SELECT count(*) AS n FROM interaction_delivery_evidence WHERE kind='native-ack'").get()).toEqual({ n: 0 });
  });
  it("retires actual R07 acknowledgement of unknown outcome while preserving unconfirmed control evidence", () => {
    const f = setup(); f.ingest(); f.service.respondQuestion("device-a", "answer", f.input);
    const accepted = intent(f); f.service.execution.claim(accepted.id, { id: "owner", generation: 1 }); f.service.execution.transition({ id: accepted.id, expectedStates: ["claimed"], state: "dispatching" });
    f.store.commitEvent(f.session.id, "turn.recovery.acknowledged", { turnId: f.turn.id, turnStatus: "outcome_unknown", outcomePreserved: "outcome_unknown", attemptId: f.context.attemptId, gate: "released" }, { turnId: f.turn.id, turnStatus: "outcome_unknown" });
    expect(f.service.interactions.get("question")).toMatchObject({ version: 2, status: "superseded", deliveryState: "unconfirmed" });
    expect(f.store.getCommandReceipt("device-a", "answer")?.state).toBe("outcome_unknown"); expect(f.service.execution.get(accepted.id)?.state).toBe("outcome_unknown");
    expect(f.store.db.prepare("SELECT count(*) AS n FROM interaction_delivery_evidence WHERE kind='native-ack'").get()).toEqual({ n: 0 });
  });
  it("does not retire a request for mismatched durable outcome, attempt or a failed recovery operation", () => {
    const f = setup(); f.ingest();
    f.store.commitEvent(f.session.id, "turn.recovery.reconciled", { turnId: f.turn.id, turnStatus: "completed", attemptId: f.context.attemptId });
    expect(f.service.interactions.get("question")).toMatchObject({ version: 0, status: "pending" });
    f.store.commitEvent(f.session.id, "turn.recovery.reconciled", { turnId: f.turn.id, turnStatus: "completed", attemptId: "another-attempt" }, { turnId: f.turn.id, turnStatus: "completed" });
    expect(f.service.interactions.get("question")).toMatchObject({ version: 0, status: "pending" });
    f.store.commitEvent(f.session.id, "recovery.operation.failed", { turnId: f.turn.id, gate: "blocked" });
    expect(f.service.interactions.get("question")).toMatchObject({ version: 0, status: "pending" });
  });
  it("projects canonical recovery companions once before the genuine source and keeps one commit boundary", () => {
    const f = setup(); f.ingest(); f.service.respondQuestion("device-a", "answer", f.input); const before = f.store.getSession(f.session.id)!.headSequence;
    const committed = f.store.commitCommand({ sessionId: f.session.id, build: () => ({ result: undefined, events: [
      ...f.service.planSupersessionEvents(f.session.id, { turnId: f.turn.id }, "recovery_reconciled"),
      { type: "turn.recovery.reconciled", payload: { turnId: f.turn.id, turnStatus: "completed", attemptId: f.context.attemptId, gate: "blocked" }, options: { turnId: f.turn.id, turnStatus: "completed" } }
    ] }) })!;
    expect(committed.events.map((event) => event.type)).toEqual(["interaction.superseded", "turn.recovery.reconciled"]);
    expect(f.service.interactions.get("question")).toMatchObject({ version: 2, status: "superseded" });
    expect(f.store.listEventCommits(f.session.id).at(-1)).toMatchObject({ firstSequence: before + 1, lastSequence: before + 2 });
  });

  it("gives only the first device a reservation, receipt, and durable typed intent", async () => {
    const f = setup();
    f.ingest();
    const before = f.store.getSession(f.session.id)!.revision;
    const results = await Promise.allSettled([Promise.resolve().then(() => f.service.respondQuestion("device-a", "answer", f.input)), Promise.resolve().then(() => f.service.respondQuestion("device-b", "answer", f.input))]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("INTERACTION_VERSION_CONFLICT");
    expect(f.service.interactions.get("question")).toMatchObject({ status: "responding", version: 1, deliveryState: "accepted" });
    expect(f.store.getCommandReceipt("device-a", "answer")).toMatchObject({ state: "accepted", method: "question.respond", requestFormatVersion: 2 });
    expect(f.store.getCommandReceipt("device-b", "answer")).toBeUndefined();
    expect(f.service.execution.forCommand("device-a", "answer")).toHaveLength(1);
    expect(intent(f)).toMatchObject({ kind: "respond_question", payload: { interactionId: "question", answers: f.input.answers }, ordinal: 0, attemptId: f.context.attemptId, runtimeGeneration: f.context.runtimeGeneration, nativeRequestId: "native-tool", dispatchContext: f.context, state: "pending" });
    expect(f.service.interactions.get("question")!.dispatchContext).toEqual(f.context);
    expect(f.store.getSession(f.session.id)!.revision).toBe(before + 1);
    expect(f.wake).toHaveBeenCalledOnce();
    expect(f.store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it.each(["session_events", "event_commits", "timeline_items", "command_receipts", "execution_intents", "interaction_reservations", "interactions"])("rolls back all acceptance facts when %s fails", (table) => {
    const f = setup();
    f.ingest();
    const before = snapshot(f.store);
    f.wake.mockClear();
    f.publish.mockClear();
    const operation = table === "interactions" ? "UPDATE" : "INSERT";
    f.store.db.exec(`CREATE TRIGGER fail BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'atomic failure'); END`);
    expect(() => f.service.respondQuestion("device-a", "answer", f.input)).toThrow("atomic failure");
    expect(snapshot(f.store)).toEqual(before);
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("rejects stale versions, unavailable native bindings, unknown methods, expiry and replaced runtimes", () => {
    const f = setup();
    f.ingest();
    expect(() => f.service.respondQuestion("device-a", "stale", { ...f.input, expectedVersion: 99 })).toThrow("INTERACTION_VERSION_CONFLICT");
    expect(() => f.service.ingestQuestion(interactionFence(f.context), { ...f.native, interactionId: "bad", nativeMethod: "unknown" as never })).toThrow("INTERACTION_NATIVE_METHOD_UNSUPPORTED");
    expect(() => f.service.ingestQuestion(interactionFence(f.context), { ...f.native, interactionId: "missing", nativeRequestId: "" })).toThrow("INTERACTION_NATIVE_BINDING_INVALID");
    f.setRuntime("new-runtime");
    expect(f.service.get("session", "question").responseAvailable).toBe(false);
    expect(() => f.service.respondQuestion("device-a", "replaced", f.input)).toThrow("INTERACTION_SUPERSEDED");
    f.setRuntime("runtime");
    f.setNow("2026-10-15T00:11:00.000Z");
    expect(() => f.service.respondQuestion("device-a", "expired", f.input)).toThrow("INTERACTION_EXPIRED");
    expect(f.service.expireDue("session")).toBe(1);
    expect(f.service.interactions.get("question")?.status).toBe("expired");
  });
  it("checks approval:write and revocation before receipt reuse", () => {
    const f = setup();
    f.ingest();
    f.store.db.prepare("UPDATE devices SET scopes_json='[]' WHERE id=?").run("device-b");
    expect(() => f.service.respondQuestion("device-b", "blocked", f.input)).toThrow("SCOPE_REQUIRED");
    const response = f.service.respondQuestion("device-a", "answer", f.input);
    expect(f.service.respondQuestion("device-a", "answer", f.input)).toEqual(response);
    f.store.db.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run(f.native.createdAt, "device-a");
    expect(() => f.service.respondQuestion("device-a", "answer", f.input)).toThrow("DEVICE_REVOKED");
  });
  it("records local delivery and only matching native evidence confirms it; the Turn stays active", () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const delivered = intent(f);
    f.service.recordDelivery(delivered.id, { kind: "local-delivery" }, interactionFence(f.context));
    expect(f.service.interactions.get("question")).toMatchObject({ status: "delivered", deliveryState: "local_delivery", version: 2 });
    expect(f.store.getCommandReceipt("device-a", "answer")).toMatchObject({ state: "completed", response: { status: "delivered" } });
    expect(f.store.getActiveTurn("session")?.status).toBe("running");
    expect(() => f.service.recordDelivery(delivered.id, { kind: "native-ack", nativeRequestId: "wrong", sourceId: "native-result" })).toThrow("INTERACTION_NATIVE_EVIDENCE_INVALID");
    f.service.recordDelivery(delivered.id, { kind: "native-ack", nativeRequestId: "native-tool", sourceId: "native-result" }, interactionFence(f.context));
    expect(f.service.interactions.get("question")).toMatchObject({ status: "confirmed", deliveryState: "native_confirmation", version: 3 });
    expect(f.service.respondQuestion("device-a", "answer", f.input)).toMatchObject({ status: "confirmed" });
  });
  it("rolls back receipt, intent, evidence and projection if delivery persistence fails", () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const before = snapshot(f.store);
    f.store.db.exec("CREATE TRIGGER fail BEFORE INSERT ON interaction_delivery_evidence BEGIN SELECT RAISE(ABORT,'delivery failure'); END");
    expect(() => f.service.recordDelivery(intent(f).id, { kind: "local-delivery" })).toThrow("delivery failure");
    expect(snapshot(f.store)).toEqual(before);
    expect(f.service.execution.get(intent(f).id)?.state).toBe("pending");
  });
  it.each(["not-dispatched", "unknown"] as const)("persists %s without fabricating success", (kind) => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    f.service.recordDelivery(intent(f).id, { kind, reason: "native_request_gone" });
    expect(f.service.interactions.get("question")?.status).toBe(kind === "unknown" ? "outcome_unknown" : "superseded");
    expect(f.store.getCommandReceipt("device-a", "answer")?.state).toBe(kind === "unknown" ? "outcome_unknown" : "failed");
    expect(f.service.respondQuestion("device-a", "answer", f.input).status).toBe(kind === "unknown" ? "outcome_unknown" : "superseded");
  });
  it("restarts from accepted and unknown receipts without re-answering, and terminal proof cannot confirm control delivery", () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const id = intent(f).id;
    f.service.execution.claim(id, { id: "owner", generation: 1 });
    f.service.execution.transition({ id, expectedStates: ["claimed"], state: "dispatching" });
    f.service.close();
    const restored = f.makeService();
    expect(restored.respondQuestion("device-a", "answer", f.input)).toMatchObject({ status: "accepted" });
    restored.recordDelivery(id, { kind: "unknown", reason: "host_restarted" });
    expect(restored.respondQuestion("device-a", "answer", f.input)).toMatchObject({ status: "outcome_unknown" });
    f.store.commitEvent("session", "turn.completed", { turnId: f.turn.id }, { turnId: f.turn.id, turnStatus: "completed", activityState: "idle" });
    expect(restored.interactions.get("question")).toMatchObject({ status: "superseded", deliveryState: "unconfirmed" });
    expect(f.store.getCommandReceipt("device-a", "answer")?.state).toBe("outcome_unknown");
    expect(f.store.db.prepare("SELECT * FROM interaction_delivery_evidence WHERE kind='native-ack'").all()).toEqual([]);
  });
  it("typed and omitted-version legacy approvals share the same first-device reservation", () => {
    const f = setup();
    const row = approval(f);
    f.service.ingestApproval(interactionFence(f.context), { interactionId: row.approvalId, nativeRequestId: row.toolUseId, nativeMethod: "canUseTool/approval", request: { toolName: "Bash" }, createdAt: row.createdAt, expiresAt: f.native.expiresAt, approval: row });
    expect(f.service.respondLegacyApproval("device-a", "approve", row.approvalId, "allow_once")).toMatchObject({ status: "accepted" });
    expect(() => f.service.respondApproval("device-b", "approve", { sessionId: "session", interactionId: row.approvalId, expectedVersion: 0, action: "deny" })).toThrow("INTERACTION_VERSION_CONFLICT");
    expect(() => f.service.respondLegacyApproval("device-b", "second", row.approvalId, "deny")).toThrow("INTERACTION_RESPONDING");
    expect(f.service.respondLegacyApproval("device-a", "approve", row.approvalId, "allow_once")).toMatchObject({ status: "accepted" });
    expect(f.service.execution.reservation(row.approvalId)!.intentId).toBe(f.service.interactions.reservation(row.approvalId)!.intentId);
  });
  it("settles canonical native approval resolution and ignores the worker duplicate", () => {
    const f = setup();
    const row = approval(f);
    f.service.ingestApproval(interactionFence(f.context), { interactionId: row.approvalId, nativeRequestId: row.toolUseId, nativeMethod: "canUseTool/approval", request: { toolName: "Bash" }, createdAt: row.createdAt, expiresAt: f.native.expiresAt, approval: row });
    f.service.respondLegacyApproval("device-a", "approve", row.approvalId, "allow_once");
    const delivery = f.service.execution.forCommand("device-a", "approve")[0]!;
    ingestInteractionEvent(f.service, { kind: "approval_resolved", approvalId: row.approvalId, toolUseId: row.toolUseId, action: "allow_once", dispatchContext: f.context, turnId: f.turn.id, generation: f.turn.generation });
    expect(f.store.getCommandReceipt("device-a", "approve")?.state).toBe("completed");
    expect(f.service.interactions.get(row.approvalId)?.status).toBe("delivered");
    const before = f.store.getSession("session")!.revision;
    f.service.recordDelivery(delivery.id, { kind: "local-delivery" });
    expect(f.store.getSession("session")!.revision).toBe(before);
  });
  it("adds one canonical supersession per interaction in a compound terminal commit", () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const batch = f.store.commitCommand({
      sessionId: "session", occurredAt: f.native.createdAt, build: () => ({
        result: undefined, events: [
          ...f.service.planSupersessionEvents("session", { turnId: f.turn.id }), { type: "turn.completed", payload: { turnId: f.turn.id }, options: { turnId: f.turn.id, turnStatus: "completed", activityState: "idle" } },
        ]
      })
    })!;
    expect(batch.events.map((event) => event.type)).toEqual(["interaction.superseded", "turn.completed"]);
    const source = batch.events[0]!.payload as {
      interaction: {
        deliveryState: string;
      };
    };
    expect(source.interaction.deliveryState).toBe("unconfirmed");
    expect(f.service.interactions.get("question")).toMatchObject({ status: "superseded", deliveryState: "unconfirmed", evidenceKind: "unknown", version: 2 });
  });
  it("uses the worker delivery callback and synchronous recovery settlement without an adapter call on stale state", async () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const calls = new Map<string, {
      deliver: (intent: ExecutionIntentRow, context: DispatchContext) => InteractionControlOutcome | Promise<InteractionControlOutcome>;
      commit: (intent: ExecutionIntentRow, result: InteractionControlOutcome) => void;
    }>();
    const worker: InteractionControlWorker = { registerControl: (kind, deliver, commit) => { calls.set(kind, { deliver, commit }); } };
    const answer = vi.fn(() => ({ kind: "local-delivery" as const }));
    const adapter = { respondQuestion: answer } as unknown as ProviderAdapter;
    registerInteractionControls(worker, f.service, () => adapter);
    const handler = calls.get("respond_question")!;
    const current = intent(f);
    f.setRuntime("replaced");
    const gone = await handler.deliver(current, f.context);
    expect(gone.status).toBe("not_dispatched");
    expect(answer).not.toHaveBeenCalled();
    expect(handler.commit(current, gone)).toBeUndefined();
    expect(f.store.getCommandReceipt("device-a", "answer")?.state).toBe("failed");
  });
  it("persists the accepted receipt, typed payload and possible-sent marker for a cold SQLite reader", async () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const delivery = intent(f);
    f.service.execution.claim(delivery.id, { id: "owner", generation: 1 });
    f.service.execution.transition({ id: delivery.id, expectedStates: ["claimed"], state: "dispatching" });
    const directory = await mkdtemp(join(tmpdir(), "flyx-interaction-cold-"));
    try {
      const path = join(directory, "cold.sqlite");
      await f.store.db.backup(path);
      const cold = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const receipt = cold.prepare("SELECT state,response_json FROM command_receipts WHERE auth_subject_id='device-a' AND command_id='answer'").get() as {
          state: string;
          response_json: string;
        };
        const persisted = cold.prepare("SELECT state,payload_json,dispatch_context_json FROM execution_intents WHERE id=?").get(delivery.id) as {
          state: string;
          payload_json: string;
          dispatch_context_json: string;
        };
        expect(receipt.state).toBe("accepted");
        expect(JSON.parse(receipt.response_json)).toMatchObject({ status: "accepted" });
        expect(persisted.state).toBe("dispatching");
        expect(JSON.parse(persisted.payload_json)).toEqual({ interactionId: "question", answers: f.input.answers });
        expect(JSON.parse(persisted.dispatch_context_json)).toEqual(f.context);
        expect(cold.prepare("SELECT intent_id FROM interaction_reservations WHERE interaction_id='question'").get()).toEqual({ intent_id: delivery.id });
      }
      finally {
        cold.close();
      }
    }
    finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("uses the real R06 worker dispatch marker and control settlement while a native Turn stays unresolved", async () => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const delivery = intent(f);
    const registry = new RuntimeRegistry();
    let release!: () => void;
    const native = new Promise<TurnOutcome>((resolve) => { release = () => resolve({ status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "native-terminal" } }); });
    const answer = vi.fn(() => ({ kind: "local-delivery" as const }));
    const adapter = { provider: "claude", workspace: "/tmp/fixture", runTurn: () => native, respondQuestion: answer } as unknown as ProviderAdapter;
    registry.register("runtime", adapter);
    const run = registry.begin(f.context, { prompt: "ongoing task" });
    const fallback = vi.fn();
    const failures = vi.fn();
    const worker = new ExecutionWorker(f.service.execution, registry, {
      owner: { id: "owner", generation: 1 }, revalidateDevice: () => { }, drainIngestion: async () => { }, onStartOutcome: () => { }, onControlResult: fallback, failed: failures,
      stage: (stage, value) => { if (stage === "after_marker") {
        expect(f.service.execution.get(value.id)?.state).toBe("dispatching");
        expect(answer).not.toHaveBeenCalled();
      } }
    });
    registerInteractionControls(worker, f.service, () => adapter);
    try {
      expect(worker.scan()).toBe(1);
      await worker.drainDispatch();
      expect(answer).toHaveBeenCalledOnce();
      expect(fallback).not.toHaveBeenCalled();
      expect(failures).not.toHaveBeenCalled();
      expect(f.service.execution.get(delivery.id)?.state).toBe("settled");
      expect(f.store.getCommandReceipt("device-a", "answer")).toMatchObject({ state: "completed", response: { status: "delivered" } });
      expect(registry.isBusy("runtime")).toBe(true);
      expect(f.store.getActiveTurn("session")?.status).toBe("running");
    }
    finally {
      worker.seal();
      release();
      await run.outcome;
    }
  });
  it.each(["claimed", "dispatching"] as const)("uses synchronous real worker recovery for %s answers without calling the Provider", (state) => {
    const f = setup();
    f.ingest();
    f.service.respondQuestion("device-a", "answer", f.input);
    const delivery = intent(f);
    f.service.execution.claim(delivery.id, { id: "owner", generation: 1 });
    if (state === "dispatching")
      f.service.execution.transition({ id: delivery.id, expectedStates: ["claimed"], state: "dispatching" });
    const answer = vi.fn();
    const fallback = vi.fn();
    const worker = new ExecutionWorker(f.service.execution, new RuntimeRegistry(), { owner: { id: "new-owner", generation: 2 }, revalidateDevice: () => { }, drainIngestion: async () => { }, onStartOutcome: () => { }, onControlResult: fallback });
    registerInteractionControls(worker, f.service, () => ({ respondQuestion: answer } as unknown as ProviderAdapter));
    try {
      expect(() => worker.recover()).not.toThrow();
      expect(worker.scan()).toBe(0);
      expect(answer).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
      expect(f.store.getCommandReceipt("device-a", "answer")?.state).toBe(state === "claimed" ? "failed" : "outcome_unknown");
      expect(f.service.execution.get(delivery.id)?.state).toBe(state === "claimed" ? "settled" : "outcome_unknown");
      expect(f.service.respondQuestion("device-a", "answer", f.input).status).toBe(state === "claimed" ? "superseded" : "outcome_unknown");
    }
    finally {
      worker.seal();
    }
  });
  it("routes canonical native requests once and exposes only bounded public RPC data", () => {
    const f = setup();
    expect(ingestInteractionEvent(f.service, { kind: "question_requested", request: f.native, dispatchContext: f.context, turnId: f.turn.id, generation: f.turn.generation })).toBe(true);
    const result = interactionRpc(f.service, "interaction.get", { sessionId: "session", interactionId: "question" });
    expect(result).toMatchObject({ responseAvailable: true, kind: "question" });
    expect(JSON.stringify(result)).not.toContain("native-tool");
    expect(JSON.stringify(result)).not.toContain("hostOwner");
    expect(() => interactionRpc(f.service, "unknown" as never, f.input, { authSubjectId: "device-a", commandId: "answer" })).toThrow("METHOD_NOT_FOUND");
    expect(() => interactionRpc(f.service, "question.respond", { ...f.input, extra: "unsafe" }, { authSubjectId: "device-a", commandId: "answer" })).toThrow(InteractionRpcError);
  });
});
describe("migration 008 preserves legacy evidence", () => {
  it("imports a reserved approval and its original intent without manufacturing native confirmation", () => {
    const f = setup(false);
    const row = approval(f);
    f.store.commitEvent("session", "approval.requested", { approvalId: row.approvalId }, { approval: row });
    const request = { authSubjectId: "device-a", commandId: "old-response", method: "approval.respond", targetSessionId: "session", requestHash: hashCommandRequest("approval.respond", { approvalId: row.approvalId, action: "allow_once" }) };
    const commit = f.engine.commitRequest(request, (facts, clock) => decideApprovalReservation(facts, request, { approvalId: row.approvalId, action: "allow_once" }, clock), { approvalId: row.approvalId });
    const before = count(f.store, "execution_intents");
    applyInteractionMigration(f.store.db, f.native.createdAt);
    const service = f.makeService();
    expect(service.interactions.get(row.approvalId)).toMatchObject({ status: "responding", evidenceKind: "legacy", deliveryState: "legacy", responseAvailable: false, version: 1 });
    expect(service.interactions.reservation(row.approvalId)?.intentId).toBe(commit.intents[0]!.id);
    expect(count(f.store, "execution_intents")).toBe(before);
    expect(f.store.db.prepare("SELECT kind,evidence_json FROM interaction_delivery_evidence").all()).toEqual([{ kind: "legacy", evidence_json: JSON.stringify({ originalStatus: "pending", originalDeliveryState: "accepted", nativeConfirmation: false }) }]);
    expect(() => service.respondLegacyApproval("device-b", "new", row.approvalId, "deny")).toThrow("INTERACTION_RESPONDING");
  });
  it("keeps old locally resolved approvals as legacy and rolls back DDL on malformed old evidence", () => {
    const f = setup(false);
    const row = approval(f);
    f.store.commitEvent("session", "approval.requested", { approvalId: row.approvalId }, { approval: row });
    f.store.resolveApproval(row.approvalId, 0, "allow_once");
    applyInteractionMigration(f.store.db, f.native.createdAt);
    expect(f.makeService().interactions.get(row.approvalId)).toMatchObject({ status: "delivered", evidenceKind: "legacy", deliveryState: "legacy", responseAvailable: false });
    const broken = setup(false);
    const bad = approval(broken);
    broken.store.commitEvent("session", "approval.requested", { approvalId: bad.approvalId }, { approval: bad });
    broken.store.db.prepare("UPDATE approvals SET request_json='{' WHERE approval_id=?").run(bad.approvalId);
    expect(() => applyInteractionMigration(broken.store.db)).toThrow();
    expect(broken.store.db.prepare("SELECT name FROM sqlite_master WHERE name='interactions'").get()).toBeUndefined();
    expect(broken.store.db.prepare("SELECT version FROM schema_migrations WHERE version=8").get()).toBeUndefined();
  });
});
