import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { SessionOrchestrator } from "./orchestrator.js";
import { decideAcceptTurn } from "../orchestration/decider.js";
import type { ProviderAdapter, TurnOutcome } from "../provider/types.js";

const open: SessionOrchestrator[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
function fixture() {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const status = { provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true as const };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => status,
    runTurn: vi.fn(() => new Promise<TurnOutcome>(() => {})),
    interrupt: vi.fn(async () => "accepted" as const), respondApproval: vi.fn(() => true) };
  const orchestrator = new SessionOrchestrator({ canReleaseWorkspace: () => true, workspace, adapter }); open.push(orchestrator);
  return { orchestrator, adapter };
}
async function seedTurn(orchestrator: SessionOrchestrator) {
  const request = { actorKind: "host" as const, authSubjectId: "device-1", commandId: "start-1", method: "session.startTurn", requestHash: "start-hash", targetSessionId: orchestrator.sessionId,
    dispatchBinding: { hostOwnerId: orchestrator.owner.ownerId, hostOwnerGeneration: orchestrator.owner.generation, runtimeId: `claude:${orchestrator.sessionId}` } };
  orchestrator.commandEngine.commitRequest(request, (facts, clock) => decideAcceptTurn(facts, request, { turnId: "turn-1", prompt: "run command", generation: 1 }, clock));
  await orchestrator.worker.drainDispatch();
  return orchestrator.store.getTurn("turn-1")!;
}
async function seedApproval(orchestrator: SessionOrchestrator) {
  const turn = await seedTurn(orchestrator);
  orchestrator.store.commitEvent(orchestrator.sessionId, "approval.requested", { approvalId: "approval-1" }, {
    activityState: "waiting_approval", turnId: turn.id, turnStatus: "waiting_approval",
    approval: { approvalId: "approval-1", sessionId: orchestrator.sessionId, turnId: turn.id, toolUseId: "tool-1", version: 0,
      status: "pending", request: { toolName: "Bash", input: { command: "test" } }, createdAt: "2026-10-14T00:00:00.000Z" },
  });
}
function inject(orchestrator: SessionOrchestrator, table: string) {
  orchestrator.store.db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
}

describe("Orchestrator atomic dispatch", () => {
  it.each(["session_events", "timeline_items", "command_receipts", "execution_intents"])("calls no Adapter when accepted start %s persistence fails", async (table) => {
    const { orchestrator, adapter } = fixture();
    inject(orchestrator, table);
    await expect(orchestrator.startTurn("device-1", "start-1", "hello")).rejects.toThrow("injected write failure");
    expect(adapter.runTurn).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "start-1")).toBeUndefined();
    expect(orchestrator.snapshot().session).toMatchObject({ revision: 0, headSequence: 0, activityState: "idle" });
    expect(orchestrator.execution.list()).toHaveLength(0);
    expect(orchestrator.store.listEventCommits(orchestrator.sessionId)).toHaveLength(0);
  });

  it.each(["session_events", "timeline_items", "command_receipts", "execution_intents"])("fixes B02: no interrupt acceptance leaks when %s persistence fails", async (table) => {
    const { orchestrator, adapter } = fixture();
    await seedTurn(orchestrator);
    const before = orchestrator.snapshot();
    inject(orchestrator, table);
    await expect(orchestrator.interrupt("device-1", "interrupt-1")).rejects.toThrow("injected write failure");
    expect(adapter.interrupt).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "interrupt-1")).toBeUndefined();
    expect(orchestrator.snapshot()).toEqual(before);
    expect(orchestrator.store.getTurn("turn-1")?.status).toBe("running");
    expect(orchestrator.execution.list()).toHaveLength(1);
  });

  it.each(["session_events", "timeline_items", "command_receipts", "execution_intents", "approval_reservations"])("never delivers an approval when %s acceptance persistence fails", async (table) => {
    const { orchestrator, adapter } = fixture();
    await seedApproval(orchestrator);
    const before = orchestrator.snapshot();
    inject(orchestrator, table);
    await expect(orchestrator.respondApproval("device-1", "respond-1", "approval-1", "allow_once")).rejects.toThrow("injected write failure");
    expect(adapter.respondApproval).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")).toBeUndefined();
    expect(orchestrator.store.getApproval("approval-1")).toMatchObject({ status: "pending", version: 0 });
    expect(orchestrator.execution.reservation("approval-1")).toBeUndefined();
    expect(orchestrator.snapshot()).toEqual(before);
  });

  it("reserves accepted approval before delivery and reports local delivery after the Adapter result", async () => {
    const { orchestrator, adapter } = fixture();
    await seedApproval(orchestrator);
    const before = orchestrator.snapshot();
    adapter.respondApproval = vi.fn(() => {
      expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.state).toBe("accepted");
      expect(orchestrator.store.getApproval("approval-1")).toMatchObject({ status: "pending", version: 1 });
      expect(orchestrator.execution.reservation("approval-1")?.state).toBe("accepted");
      expect(orchestrator.execution.forCommand("device-1", "respond-1")[0]?.state).toBe("dispatching");
      return true;
    });
    const response = await orchestrator.respondApproval("device-1", "respond-1", "approval-1", "allow_once");
    expect(response).toEqual({ status: "accepted", approvalId: "approval-1" });
    await orchestrator.worker.drainDispatch();
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.response).toMatchObject({ status: "delivered", approvalId: "approval-1", deliveryState: "local_delivery" });
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.state).toBe("completed");
    expect(orchestrator.execution.reservation("approval-1")?.state).toBe("local_delivery");
    expect(orchestrator.execution.forCommand("device-1", "respond-1")[0]).toMatchObject({ state: "settled", resultCode: "completed" });
    expect(orchestrator.store.getApproval("approval-1")?.status).toBe("resolved");
    expect((await orchestrator.respondApproval("device-1", "respond-1", "approval-1", "allow_once")).status).toBe("delivered");
    expect(adapter.respondApproval).toHaveBeenCalledOnce();
  });

  it("keeps unconfirmed approval delivery unknown rather than completed", async () => {
    const { orchestrator, adapter } = fixture(); await seedApproval(orchestrator);
    adapter.respondApproval = vi.fn(() => false);
    expect(await orchestrator.respondApproval("device-1", "respond-1", "approval-1", "deny")).toEqual({ status: "accepted", approvalId: "approval-1" });
    await orchestrator.worker.drainDispatch();
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.state).toBe("outcome_unknown");
    expect(orchestrator.execution.reservation("approval-1")?.state).toBe("outcome_unknown");
    expect(orchestrator.execution.forCommand("device-1", "respond-1")[0]?.state).toBe("outcome_unknown");
    expect(orchestrator.store.getApproval("approval-1")?.status).toBe("pending");
    expect(orchestrator.snapshot().session.activityState).toBe("outcome_unknown");
  });

  it("delivers interrupt while the independently awaited Turn is still running", async () => {
    const { orchestrator, adapter } = fixture();
    let finish!: (outcome: TurnOutcome) => void;
    adapter.runTurn = vi.fn(() => new Promise<TurnOutcome>((resolveOutcome) => { finish = resolveOutcome; }));
    const start = await orchestrator.startTurn("device-1", "start-long", "hello");
    await orchestrator.worker.drainDispatch();
    expect(adapter.runTurn).toHaveBeenCalledOnce();
    const interrupt = await orchestrator.interrupt("device-1", "interrupt-long");
    expect(interrupt).toEqual({ status: "accepted", turnId: start.turnId });
    await orchestrator.worker.drainDispatch();
    expect(adapter.interrupt).toHaveBeenCalledOnce();
    const terminal = new Promise<void>((resolveTerminal) => {
      const unsubscribe = orchestrator.subscribe((event) => {
        if (event.type === "turn.reconciled") { unsubscribe(); resolveTerminal(); }
      });
    });
    finish({ status: "cancelled", evidence: { kind: "native-terminal", sourceId: "native-cancel" } });
    await terminal;
    expect(orchestrator.store.getCommandReceipt("device-1", "start-long")?.state).toBe("cancelled");
    expect(orchestrator.execution.list({ state: "settled" })).toHaveLength(2);
  });

  it("does not dispatch after a post-acceptance dispatch marker fails", async () => {
    const { orchestrator, adapter } = fixture(); await seedTurn(orchestrator);
    orchestrator.store.db.exec("CREATE TRIGGER fail_marker BEFORE UPDATE ON execution_intents WHEN NEW.state = 'dispatching' BEGIN SELECT RAISE(ABORT, 'dispatch marker failure'); END");
    expect(await orchestrator.interrupt("device-1", "interrupt-1")).toMatchObject({ status: "accepted", turnId: "turn-1" });
    await orchestrator.worker.drainDispatch();
    expect(adapter.interrupt).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "interrupt-1")?.state).toBe("failed");
    expect(orchestrator.execution.forCommand("device-1", "interrupt-1")[0]?.state).toBe("settled");
    expect(orchestrator.store.getCommandReceipt("device-1", "interrupt-1")?.response).toMatchObject({ status: "not_dispatched" });
  });
});
