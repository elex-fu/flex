import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../storage/db.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { CommandEngine, hashCommandRequest } from "./command-engine.js";
import { decideAcceptTurn, decideInterrupt } from "./decider.js";
import type { CommandRequest, DecisionClock } from "./command-contract.js";

const stores: SqliteStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
function fixture() {
  const store = new SqliteStore(); stores.push(store);
  const session = store.createSession("/tmp/fixture", "claude", "session-1");
  const request: CommandRequest = { authSubjectId: "device-1", commandId: "command-1", method: "session.startTurn",
    targetSessionId: session.id, requestHash: hashCommandRequest("session.startTurn", { prompt: "hello" }), requestFormatVersion: 1 };
  let ordinal = 0;
  const clock: DecisionClock = { now: () => "2026-10-14T00:00:00.000Z", id: () => `id-${++ordinal}` };
  return { store, session, request, clock, execution: new ExecutionStore(store) };
}
function injectInsertFailure(store: SqliteStore, table: string) {
  store.db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
}
function counts(store: SqliteStore) {
  return Object.fromEntries(["turns", "session_events", "event_commits", "timeline_items", "command_receipts", "execution_intents"].map((table) =>
    [table, (store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
}

describe("atomic CommandEngine", () => {
  it("commits a pure decision, all source events, receipt, prompt intent, and one revision", () => {
    const { store, session, request, clock, execution } = fixture();
    const publish = vi.fn(); const wake = vi.fn();
    store.registerCommitHook((events, boundary) => {
      expect(store.db.inTransaction).toBe(true);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(boundary).toMatchObject({ sessionId: session.id, firstSequence: 1, lastSequence: 2 });
      expect(store.getCommandReceipt(request.authSubjectId, request.commandId)?.state).toBe("accepted");
      expect(execution.forCommand(request.authSubjectId, request.commandId)).toHaveLength(1);
      expect(publish).not.toHaveBeenCalled();
    });
    const engine = new CommandEngine(store, { clock, publish, wake });
    const committed = engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied));
    const turn = store.getTurn(committed.result.turnId)!;
    expect(store.getSession(session.id)).toMatchObject({ revision: 1, headSequence: 2, activityState: "running" });
    expect(committed.intents[0]).toMatchObject({ state: "pending", kind: "start_turn", resourceId: turn.id,
      payload: { turnId: turn.id, prompt: "hello" }, ordinal: 0, requestHash: request.requestHash, requestFormatVersion: 1,
      attemptId: turn.attemptId, runtimeGeneration: 1, sourceSequence: 2, commitId: committed.commitId,
      createdAt: clock.now(), updatedAt: clock.now() });
    expect(store.getCommandReceipt(request.authSubjectId, request.commandId)).toMatchObject({ targetSessionId: session.id,
      requestFormatVersion: 1, commitId: committed.commitId, sourceSequence: 2 });
    expect(publish).toHaveBeenCalledTimes(2); expect(wake).toHaveBeenCalledOnce();
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["turns", "session_events", "event_commits", "timeline_items", "command_receipts", "execution_intents"])("rolls back every fact when %s persistence fails", (table) => {
    const { store, session, request, clock } = fixture();
    const publish = vi.fn(); const wake = vi.fn();
    const engine = new CommandEngine(store, { clock, publish, wake });
    injectInsertFailure(store, table);
    expect(() => engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied))).toThrow("injected write failure");
    expect(Object.values(counts(store))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(store.getSession(session.id)).toMatchObject({ revision: 0, headSequence: 0, activityState: "idle" });
    expect(publish).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
  });

  it.each(["session_events", "event_commits", "timeline_items", "command_receipts", "execution_intents"])("rolls back terminal event, receipt, and intent when %s fails", (table) => {
    const { store, request, clock, session, execution } = fixture();
    const accepted = new CommandEngine(store, { clock }).commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied));
    const operation = table === "command_receipts" || table === "execution_intents" ? "UPDATE" : "INSERT";
    store.db.exec(`CREATE TRIGGER fail_terminal BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'terminal failure'); END`);
    expect(() => store.commitEvent(session.id, "turn.completed", { turnId: accepted.result.turnId }, {
      activityState: "idle", turnId: accepted.result.turnId, turnStatus: "completed",
      timeline: { itemId: "terminal-result", kind: "system", status: "completed", content: { message: "done" } },
      commandReceipt: { authSubjectId: request.authSubjectId, commandId: request.commandId, requestHash: request.requestHash,
        state: "completed", response: { status: "completed" }, required: true },
    })).toThrow("terminal failure");
    expect(store.getSession(session.id)).toMatchObject({ revision: 1, headSequence: 2, activityState: "running" });
    expect(store.getTurn(accepted.result.turnId)?.status).toBe("queued");
    expect(store.getTimelineItem(session.id, "terminal-result")).toBeUndefined();
    expect(store.getCommandReceipt(request.authSubjectId, request.commandId)?.state).toBe("accepted");
    expect(execution.get(accepted.intents[0]!.id)?.state).toBe("pending");
    expect(store.listEventCommits(session.id)).toHaveLength(1);
  });

  it("rejects an async decision or projection hook before committing facts", () => {
    const { store, session, request, clock } = fixture();
    const asyncBuilder = (() => Promise.resolve({ result: undefined })) as unknown as Parameters<SqliteStore["commitCommand"]>[0]["build"];
    expect(() => store.commitCommand({ sessionId: session.id, build: asyncBuilder })).toThrow("SYNCHRONOUS_COMMIT_REQUIRED");
    store.registerProjectionHook(async () => undefined);
    expect(() => new CommandEngine(store, { clock }).commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied))).toThrow("SYNCHRONOUS_COMMIT_REQUIRED");
    expect(Object.values(counts(store))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rolls back batch projection extensions and refuses stale session revisions", () => {
    const { store, session, request, clock } = fixture();
    const remove = store.registerCommitHook(() => { throw new Error("projector failed"); });
    const engine = new CommandEngine(store, { clock });
    expect(() => engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied))).toThrow("projector failed");
    expect(Object.values(counts(store))).toEqual([0, 0, 0, 0, 0, 0]);
    remove();
    store.commitEvent(session.id, "diagnostic", {});
    expect(() => engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied), { expectedRevision: 0 })).toThrow("SESSION_REVISION_CONFLICT");
    expect(store.getSession(session.id)).toMatchObject({ revision: 1, headSequence: 1 });
    expect(store.getCommandReceipt(request.authSubjectId, request.commandId)).toBeUndefined();
  });

  it("reuses only the same device, method, hash version and resource binding", () => {
    const { store, request, clock } = fixture();
    const engine = new CommandEngine(store, { clock });
    const first = engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied));
    const decide = vi.fn();
    expect(engine.commitRequest(request, decide).result).toEqual(first.result);
    expect(decide).not.toHaveBeenCalled();
    expect(store.getSession(request.targetSessionId!)?.revision).toBe(1);
    store.createSession("/tmp/fixture", "claude", "session-2");
    for (const changed of [{ method: "session.interrupt" }, { requestHash: "changed" }, { requestFormatVersion: 2 as const }, { targetSessionId: "session-2" }]) {
      expect(() => engine.commitRequest({ ...request, ...changed }, decide)).toThrow("COMMAND_ID_REUSED");
    }
    store.putCommandReceipt({ authSubjectId: "other-device", commandId: request.commandId, method: "session.interrupt",
      requestHash: "other-hash", state: "completed", response: { status: "already_terminal" } });
    expect(store.getCommandReceipt("other-device", request.commandId)?.method).toBe("session.interrupt");
    expect(hashCommandRequest(request.method, { prompt: "hello" }, { requestFormatVersion: 2, targetSessionId: "session-1" })).not.toBe(request.requestHash);
  });

  it("checks admission before receipt reuse and retains pending intents after wake/publication failure", () => {
    const { store, request, clock, execution } = fixture();
    let revoked = false;
    const engine = new CommandEngine(store, { clock, admission: () => { if (revoked) throw new Error("DEVICE_REVOKED"); },
      publish: () => { throw new Error("disconnected"); }, wake: () => { throw new Error("queue full"); } });
    engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied));
    expect(execution.list({ state: "pending" })).toHaveLength(1);
    expect(store.getCommandReceipt(request.authSubjectId, request.commandId)?.state).toBe("accepted");
    revoked = true;
    expect(() => engine.commitRequest(request, vi.fn())).toThrow("DEVICE_REVOKED");
  });

  it("records interrupt receipt, event, projection and intent in the same boundary", () => {
    const { store, request, clock, session } = fixture();
    const engine = new CommandEngine(store, { clock });
    const started = engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied));
    const interrupt = { ...request, commandId: "interrupt-1", method: "session.interrupt", requestHash: "interrupt-hash" };
    const accepted = engine.commitRequest(interrupt, (facts, supplied) => decideInterrupt(facts, interrupt, supplied));
    expect(accepted.result).toEqual({ status: "accepted", turnId: started.result.turnId });
    expect(store.getSession(session.id)).toMatchObject({ headSequence: 3, revision: 2, activityState: "interrupting" });
    expect(accepted.intents[0]).toMatchObject({ kind: "interrupt_turn", state: "pending", payload: { turnId: started.result.turnId, reason: "user_interrupt" }, sourceSequence: 3 });
    expect(store.listEventCommits(session.id).map((item) => [item.firstSequence, item.lastSequence])).toEqual([[1, 2], [3, 3]]);
    store.commitEvent(session.id, "turn.cancelled", { turnId: started.result.turnId }, { turnId: started.result.turnId, turnStatus: "cancelled", activityState: "idle",
      commandReceipt: { authSubjectId: request.authSubjectId, commandId: request.commandId, requestHash: request.requestHash, state: "cancelled", response: {}, required: true } });
    expect(new ExecutionStore(store).list({ state: "settled" })).toHaveLength(2);
  });

  it("fences durable intent transitions and records an unknown result without redispatch", () => {
    const { store, request, clock, execution } = fixture();
    const engine = new CommandEngine(store, { clock });
    const accepted = engine.commitRequest(request, (facts, supplied) => decideAcceptTurn(facts, request, { prompt: "hello" }, supplied));
    const id = accepted.intents[0]!.id;
    execution.claim(id, { id: "owner", generation: 3 });
    expect(() => execution.transition({ id, expectedStates: ["claimed"], state: "dispatching", attemptId: "stale" })).toThrow("EXECUTION_INTENT_FENCE_MISMATCH");
    execution.transition({ id, expectedStates: ["claimed"], state: "dispatching", attemptId: accepted.intents[0]!.attemptId });
    execution.transition({ id, expectedStates: ["dispatching"], state: "outcome_unknown", resultCode: "transport_closed" });
    expect(() => execution.claim(id, { id: "new-owner", generation: 4 })).toThrow("EXECUTION_INTENT_STATE_CONFLICT");
    expect(execution.get(id)?.state).toBe("outcome_unknown");
  });

  it("accepts multiple same-kind intents by ordinal and enforces the receipt and source foreign keys", () => {
    const { store, session, request, clock } = fixture();
    const engine = new CommandEngine(store, { clock });
    const accepted = engine.commitRequest(request, (facts, supplied) => {
      const plan = decideAcceptTurn(facts, request, { prompt: "hello" }, supplied);
      const first = plan.intents![0]!;
      plan.intents!.push({ ...first, id: supplied.id(), ordinal: 1 });
      return plan;
    });
    expect(accepted.intents.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(() => store.db.prepare("DELETE FROM command_receipts WHERE auth_subject_id = ? AND command_id = ?").run(request.authSubjectId, request.commandId)).toThrow();
    expect(() => store.db.prepare("UPDATE execution_intents SET source_sequence = 999 WHERE id = ?").run(accepted.intents[0]!.id)).toThrow();
    expect(store.listEventCommits(session.id)).toHaveLength(1);
  });
});
