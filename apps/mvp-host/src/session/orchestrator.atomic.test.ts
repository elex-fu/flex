import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { SessionOrchestrator } from "./orchestrator.js";
import type { ProviderAdapter } from "../provider/types.js";

const open: SessionOrchestrator[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
function fixture() {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const status = { provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true as const };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => status,
    runTurn: vi.fn(async () => ({ status: "completed", providerSessionId: "native" } as const)),
    interrupt: vi.fn(async () => "accepted" as const), respondApproval: vi.fn(() => true) };
  const orchestrator = new SessionOrchestrator({ workspace, adapter }); open.push(orchestrator);
  return { orchestrator, adapter };
}
function seedTurn(orchestrator: SessionOrchestrator) {
  return orchestrator.store.acceptTurn({ authSubjectId: "device-1", commandId: "start-1", requestHash: "start-hash",
    sessionId: orchestrator.sessionId, turnId: "turn-1", prompt: "run command", generation: 1 }).turn;
}
function seedApproval(orchestrator: SessionOrchestrator) {
  const turn = seedTurn(orchestrator);
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
    seedTurn(orchestrator);
    inject(orchestrator, table);
    await expect(orchestrator.interrupt("device-1", "interrupt-1")).rejects.toThrow("injected write failure");
    expect(adapter.interrupt).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "interrupt-1")).toBeUndefined();
    expect(orchestrator.snapshot().session).toMatchObject({ revision: 1, headSequence: 2, activityState: "running" });
    expect(orchestrator.store.getTurn("turn-1")?.status).toBe("queued");
    expect(orchestrator.execution.list()).toHaveLength(1);
  });

  it.each(["session_events", "timeline_items", "command_receipts", "execution_intents", "approval_reservations"])("never delivers an approval when %s acceptance persistence fails", async (table) => {
    const { orchestrator, adapter } = fixture();
    seedApproval(orchestrator);
    inject(orchestrator, table);
    await expect(orchestrator.respondApproval("device-1", "respond-1", "approval-1", "allow_once")).rejects.toThrow("injected write failure");
    expect(adapter.respondApproval).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")).toBeUndefined();
    expect(orchestrator.store.getApproval("approval-1")).toMatchObject({ status: "pending", version: 0 });
    expect(orchestrator.execution.reservation("approval-1")).toBeUndefined();
    expect(orchestrator.snapshot().session).toMatchObject({ revision: 2, headSequence: 3, activityState: "waiting_approval" });
  });

  it("reserves accepted approval before delivery and reports local delivery after the Adapter result", async () => {
    const { orchestrator, adapter } = fixture();
    seedApproval(orchestrator);
    adapter.respondApproval = vi.fn(() => {
      expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.state).toBe("accepted");
      expect(orchestrator.store.getApproval("approval-1")).toMatchObject({ status: "pending", version: 1 });
      expect(orchestrator.execution.reservation("approval-1")?.state).toBe("accepted");
      expect(orchestrator.execution.forCommand("device-1", "respond-1")[0]?.state).toBe("dispatching");
      return true;
    });
    const response = await orchestrator.respondApproval("device-1", "respond-1", "approval-1", "allow_once");
    expect(response).toEqual({ status: "delivered", approvalId: "approval-1", deliveryState: "local_delivery" });
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.state).toBe("completed");
    expect(orchestrator.execution.reservation("approval-1")?.state).toBe("local_delivery");
    expect(orchestrator.execution.forCommand("device-1", "respond-1")[0]).toMatchObject({ state: "settled", resultCode: "completed" });
    expect(orchestrator.store.getApproval("approval-1")?.status).toBe("resolved");
    expect((await orchestrator.respondApproval("device-1", "respond-1", "approval-1", "allow_once")).status).toBe("delivered");
    expect(adapter.respondApproval).toHaveBeenCalledOnce();
  });

  it("keeps unconfirmed approval delivery unknown rather than completed", async () => {
    const { orchestrator, adapter } = fixture(); seedApproval(orchestrator);
    adapter.respondApproval = vi.fn(() => false);
    await expect(orchestrator.respondApproval("device-1", "respond-1", "approval-1", "deny")).rejects.toMatchObject({ code: "APPROVAL_NOT_ACTIVE" });
    expect(orchestrator.store.getCommandReceipt("device-1", "respond-1")?.state).toBe("outcome_unknown");
    expect(orchestrator.execution.reservation("approval-1")?.state).toBe("outcome_unknown");
    expect(orchestrator.execution.forCommand("device-1", "respond-1")[0]?.state).toBe("outcome_unknown");
    expect(orchestrator.store.getApproval("approval-1")?.status).toBe("pending");
    expect(orchestrator.snapshot().session.activityState).toBe("outcome_unknown");
  });

  it("delivers interrupt while the independently awaited Turn is still running", async () => {
    const { orchestrator, adapter } = fixture();
    let finish!: (outcome: { status: "cancelled" }) => void;
    adapter.runTurn = vi.fn(() => new Promise<{ status: "cancelled" }>((resolveOutcome) => { finish = resolveOutcome; }));
    const start = await orchestrator.startTurn("device-1", "start-long", "hello");
    expect(adapter.runTurn).toHaveBeenCalledOnce();
    const interrupt = await orchestrator.interrupt("device-1", "interrupt-long");
    expect(interrupt).toEqual({ status: "accepted", turnId: start.turnId });
    expect(adapter.interrupt).toHaveBeenCalledOnce();
    const terminal = new Promise<void>((resolveTerminal) => {
      const unsubscribe = orchestrator.subscribe((event) => {
        if (event.type === "turn.reconciled") { unsubscribe(); resolveTerminal(); }
      });
    });
    finish({ status: "cancelled" });
    await terminal;
    expect(orchestrator.store.getCommandReceipt("device-1", "start-long")?.state).toBe("cancelled");
    expect(orchestrator.execution.list({ state: "settled" })).toHaveLength(2);
  });

  it("does not dispatch after a post-acceptance dispatch marker fails", async () => {
    const { orchestrator, adapter } = fixture(); seedTurn(orchestrator);
    orchestrator.store.db.exec("CREATE TRIGGER fail_marker BEFORE UPDATE ON execution_intents WHEN NEW.state = 'dispatching' BEGIN SELECT RAISE(ABORT, 'dispatch marker failure'); END");
    await expect(orchestrator.interrupt("device-1", "interrupt-1")).rejects.toThrow("dispatch marker failure");
    expect(adapter.interrupt).not.toHaveBeenCalled();
    expect(orchestrator.store.getCommandReceipt("device-1", "interrupt-1")?.state).toBe("accepted");
    expect(orchestrator.execution.forCommand("device-1", "interrupt-1")[0]?.state).toBe("claimed");
  });
});
