import { describe, expect, it } from "vitest";
import { SqliteStore } from "./db.js";

describe("SQLite MVP store", () => {
  it("commits the accepted turn, user projection and sequence atomically", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    const accepted = store.acceptTurn({
      authSubjectId: "browser-1",
      sessionId: session.id,
      turnId: "turn-1",
      commandId: "cmd-1",
      requestHash: "hash-1",
      prompt: "hello",
      generation: 1,
    });
    expect(accepted.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(store.getSession(session.id)?.headSequence).toBe(2);
    expect(store.getTimelineItem(session.id, "user-turn-1")?.content).toEqual({ turnId: "turn-1", text: "hello" });
    expect(store.getCommandReceipt("browser-1", "cmd-1")?.response).toEqual({ turnId: "turn-1", status: "accepted" });
    expect(() => store.acceptTurn({ ...accepted.turn, authSubjectId: "browser-1", turnId: "turn-2", commandId: "cmd-2", requestHash: "hash-2", generation: 2 })).toThrow("TURN_BUSY");
    store.close();
  });

  it("persists a Session Git baseline without exposing it as a provider field", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    store.setSessionBaseline(session.id, { head: "abc123", dirty: true, files: [{ path: "README.md" }] });
    expect(store.getSessionBaseline(session.id)).toMatchObject({ head: "abc123", dirty: true, files: [{ path: "README.md" }] });
    expect(store.getSession(session.id)?.baselineHead).toBe("abc123");
    store.close();
  });

  it("uses version CAS for approvals and suppresses stale responses", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    store.createTurn({ sessionId: session.id, turnId: "turn-1", commandId: "cmd-1", requestHash: "hash", prompt: "x", generation: 1 });
    store.insertApproval({ approvalId: "approval-1", sessionId: session.id, turnId: "turn-1", toolUseId: "tool-1", version: 0, status: "pending", request: { toolName: "Bash" }, createdAt: new Date().toISOString() });
    expect(store.resolveApproval("approval-1", 0, "allow_once")?.status).toBe("resolved");
    expect(store.resolveApproval("approval-1", 0, "deny")).toBeUndefined();
    store.close();
  });

  it("resolves an approval, canonical event, timeline and command receipt atomically", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    store.createTurn({
      sessionId: session.id,
      turnId: "turn-atomic",
      authSubjectId: "browser-atomic",
      commandId: "cmd-atomic",
      requestHash: "hash-atomic",
      prompt: "run the test",
      generation: 1,
    });
    store.insertApproval({
      approvalId: "approval-atomic",
      sessionId: session.id,
      turnId: "turn-atomic",
      toolUseId: "tool-atomic",
      version: 0,
      status: "pending",
      request: { toolName: "Bash", input: { command: "npm test" } },
      createdAt: new Date().toISOString(),
    });

    const committed = store.resolveApprovalAndCommit({
      approvalId: "approval-atomic",
      expectedVersion: 0,
      action: "allow_once",
      event: {
        sessionId: session.id,
        type: "approval.resolved",
        build: (approval, pending) => ({
          payload: { approvalId: approval.approvalId, action: approval.action, pending: pending.length },
          options: {
            activityState: "running",
            turnId: approval.turnId,
            turnStatus: "running",
            timeline: {
              itemId: `approval-${approval.approvalId}`,
              kind: "approval",
              status: "resolved",
              content: { approvalId: approval.approvalId, action: approval.action },
            },
          },
        }),
      },
      receipt: {
        authSubjectId: "browser-atomic",
        commandId: "approval-command-atomic",
        method: "approval.respond",
        requestHash: "approval-hash",
        state: "completed",
        response: { status: "resolved", approvalId: "approval-atomic" },
      },
    });

    expect(committed?.event.type).toBe("approval.resolved");
    expect(committed?.event.sequence).toBe(1);
    expect(store.getApproval("approval-atomic")?.status).toBe("resolved");
    expect(store.getTimelineItem(session.id, "approval-approval-atomic")?.status).toBe("resolved");
    expect(store.getCommandReceipt("browser-atomic", "approval-command-atomic")?.state).toBe("completed");
    // A stale CAS must leave every projection untouched, including sequence.
    expect(store.resolveApprovalAndCommit({
      approvalId: "approval-atomic",
      expectedVersion: 0,
      action: "deny",
      event: {
        sessionId: session.id,
        type: "approval.resolved",
        build: () => ({ payload: {}, options: {} }),
      },
    })).toBeUndefined();
    expect(store.getSession(session.id)?.headSequence).toBe(1);
    store.close();
  });

  it("rolls back the approval CAS if event or receipt persistence fails", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    store.createTurn({ sessionId: session.id, turnId: "turn-rollback", commandId: "cmd-rollback", requestHash: "hash", prompt: "x", generation: 1 });
    store.insertApproval({ approvalId: "approval-rollback", sessionId: session.id, turnId: "turn-rollback", toolUseId: "tool-rollback", version: 0, status: "pending", request: { toolName: "Edit" }, createdAt: new Date().toISOString() });
    expect(() => store.resolveApprovalAndCommit({
      approvalId: "approval-rollback",
      expectedVersion: 0,
      action: "allow_once",
      event: {
        sessionId: session.id,
        type: "approval.resolved",
        build: () => { throw new Error("injected event failure"); },
      },
      receipt: {
        authSubjectId: "browser-rollback",
        commandId: "approval-command-rollback",
        method: "approval.respond",
        requestHash: "hash-approval",
        state: "completed",
        response: { status: "resolved" },
      },
    })).toThrow("injected event failure");
    expect(store.getApproval("approval-rollback")?.status).toBe("pending");
    expect(store.getSession(session.id)?.headSequence).toBe(0);
    expect(store.getCommandReceipt("browser-rollback", "approval-command-rollback")).toBeUndefined();
    store.close();
  });

  it("commits a terminal Turn projection and start receipt together", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    const accepted = store.acceptTurn({
      authSubjectId: "browser-terminal",
      sessionId: session.id,
      turnId: "turn-terminal",
      commandId: "cmd-terminal",
      requestHash: "hash-terminal",
      prompt: "finish",
      generation: 1,
    });
    store.putCommandReceipt({
      authSubjectId: "browser-terminal",
      commandId: "interrupt-terminal",
      method: "session.interrupt",
      requestHash: "interrupt-hash",
      state: "accepted",
      response: { status: "accepted", turnId: accepted.turn.id },
    });
    const event = store.commitEvent(session.id, "turn.completed", { turnId: accepted.turn.id }, {
      activityState: "idle",
      turnId: accepted.turn.id,
      turnStatus: "completed",
      commandReceipt: {
        authSubjectId: "browser-terminal",
        commandId: "cmd-terminal",
        requestHash: "hash-terminal",
        state: "completed",
        response: { turnId: accepted.turn.id, status: "completed" },
        required: true,
      },
      commandReceipts: [{
        authSubjectId: "browser-terminal",
        commandId: "interrupt-terminal",
        requestHash: "interrupt-hash",
        state: "completed",
        response: { status: "completed", turnId: accepted.turn.id },
        required: true,
      }],
      timeline: { itemId: "result-turn-terminal", kind: "system", status: "completed", content: { ok: true } },
    });
    expect(event.sequence).toBe(3); // user.message + turn.requested + terminal
    expect(store.getTurn("turn-terminal")?.status).toBe("completed");
    expect(store.getCommandReceipt("browser-terminal", "cmd-terminal")?.state).toBe("completed");
    expect(store.getCommandReceipt("browser-terminal", "interrupt-terminal")?.state).toBe("completed");
    expect(store.getTimelineItem(session.id, "result-turn-terminal")?.status).toBe("completed");
    store.close();
  });

  it("marks an in-flight turn outcome_unknown after a clean store reopen", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    store.createTurn({ sessionId: session.id, turnId: "turn-1", commandId: "cmd-1", requestHash: "hash", prompt: "x", generation: 1 });
    store.commitEvent(session.id, "turn.started", { turnId: "turn-1" }, { activityState: "running", turnId: "turn-1", turnStatus: "running" });
    expect(store.recoverActiveTurns()).toEqual([{ sessionId: session.id, turnId: "turn-1" }]);
    expect(store.getSnapshot(session.id)?.session.activityState).toBe("outcome_unknown");
    expect(store.getTurn("turn-1")?.status).toBe("outcome_unknown");
    expect(store.listEvents(session.id).events.map((event) => event.type)).toContain("session.recovery.required");
    expect(store.getTimelineItem(session.id, "recovery-turn-1")?.status).toBe("outcome_unknown");
    store.close();
  });

  it("marks the exact startTurn receipt outcome_unknown during recovery", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    const accepted = store.acceptTurn({
      authSubjectId: "browser-recovery",
      sessionId: session.id,
      turnId: "turn-recovery",
      commandId: "cmd-recovery",
      requestHash: "hash-recovery",
      prompt: "do work",
      generation: 1,
    });
    store.putCommandReceipt({
      authSubjectId: "browser-recovery",
      commandId: "interrupt-recovery",
      method: "session.interrupt",
      requestHash: "interrupt-recovery-hash",
      state: "accepted",
      response: { status: "accepted", turnId: accepted.turn.id },
    });
    store.commitEvent(session.id, "turn.started", { turnId: accepted.turn.id }, {
      activityState: "running",
      turnId: accepted.turn.id,
      turnStatus: "running",
    });
    expect(store.recoverActiveTurns()).toEqual([{ sessionId: session.id, turnId: accepted.turn.id }]);
    expect(store.getCommandReceipt("browser-recovery", "cmd-recovery")).toMatchObject({
      state: "outcome_unknown",
      response: { turnId: "turn-recovery", status: "outcome_unknown", reason: "host_restart" },
    });
    expect(store.getCommandReceipt("browser-recovery", "interrupt-recovery")).toMatchObject({
      state: "outcome_unknown",
      response: { turnId: "turn-recovery", status: "outcome_unknown", reason: "host_restart" },
    });
    // Recovery is idempotent and does not append a second recovery event.
    expect(store.recoverActiveTurns()).toEqual([]);
    expect(store.listEvents(session.id).events.filter((event) => event.type === "session.recovery.required")).toHaveLength(1);
    store.close();
  });

  it("supersedes pending approval projections during recovery", () => {
    const store = new SqliteStore();
    const session = store.createSession("/tmp/fixture");
    store.createTurn({
      sessionId: session.id,
      turnId: "turn-approval-recovery",
      authSubjectId: "browser-approval-recovery",
      commandId: "cmd-approval-recovery",
      requestHash: "hash-approval-recovery",
      prompt: "run a command",
      generation: 1,
    });
    store.insertApproval({
      approvalId: "approval-recovery",
      sessionId: session.id,
      turnId: "turn-approval-recovery",
      toolUseId: "tool-recovery",
      version: 0,
      status: "pending",
      request: { toolName: "Bash", input: { command: "npm test" } },
      createdAt: new Date().toISOString(),
    });
    store.commitEvent(session.id, "approval.requested", { approvalId: "approval-recovery" }, {
      activityState: "waiting_approval",
      turnId: "turn-approval-recovery",
      turnStatus: "waiting_approval",
      timeline: {
        itemId: "approval-approval-recovery",
        kind: "approval",
        status: "pending",
        content: { approvalId: "approval-recovery", status: "pending" },
      },
    });
    expect(store.recoverActiveTurns()).toEqual([{ sessionId: session.id, turnId: "turn-approval-recovery" }]);
    expect(store.getApproval("approval-recovery")?.status).toBe("superseded");
    expect(store.getTimelineItem(session.id, "approval-approval-recovery")).toMatchObject({ status: "superseded", content: { reason: "host_restart" } });
    store.close();
  });
});
