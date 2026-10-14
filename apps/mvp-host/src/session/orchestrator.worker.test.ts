import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionOrchestrator } from "./orchestrator.js";
import type { AdapterStatus, DispatchContext, ProviderAdapter, ProviderOutcome } from "../provider/types.js";
import type { ExecutionWorkerOptions } from "../orchestration/execution-worker.js";

function barrier<T = void>() { let release!: (value: T) => void; const promise = new Promise<T>((yes) => { release = yes; }); return { promise, release }; }
const complete: ProviderOutcome = { status: "completed", providerSessionId: "native-session", evidence: { kind: "native-terminal", sourceId: "native-result" } };
const cleanup: string[] = [];
const open: Array<{ host: SessionOrchestrator; outcome: ReturnType<typeof barrier<ProviderOutcome>> }> = [];
afterEach(async () => { for (const value of open.splice(0)) { value.host.close(); value.outcome.release(complete); await Promise.resolve(); } for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup(hooks: Pick<ExecutionWorkerOptions, "stage" | "afterTerminal" | "beforeDispatch"> = {}, canReleaseWorkspace: (context: DispatchContext) => boolean = () => true, disk = false) {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const outcome = barrier<ProviderOutcome>(); const calls: DispatchContext[] = [];
  const status: AdapterStatus = { provider: "claude", transport: "deterministic", adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => { throw new Error("No real preflight"); },
    runTurn: async () => { throw new Error("beginTurn required"); }, beginTurn: (context) => { calls.push(context); return { outcome: outcome.promise }; },
    interrupt: vi.fn(async () => "accepted" as const), respondApproval: vi.fn(() => true) };
  const directory = disk ? mkdtempSync(join(tmpdir(), "flyx-r06-gates-")) : undefined;
  if (directory) cleanup.push(directory);
  const host = new SessionOrchestrator({ workspace, adapter, executionHooks: hooks, canReleaseWorkspace,
    ...(directory ? { databasePath: join(directory, "state", "host.sqlite"), coordinationDirectory: join(directory, "coordination") } : {}) });
  host.store.createDevice({ id: "device", hostId: "host", platform: "test", credentialKind: "browser-session", scopes: ["session:write", "approval:write"], credentialRevision: 0, createdAt: new Date().toISOString() });
  open.push({ host, outcome }); return { host, outcome, calls, adapter };
}

describe("production Orchestrator worker path", () => {
  it("accepts before dispatch, then rejects a queued revoked device without calling the Provider", async () => {
    const entered = barrier(); const release = barrier();
    const f = setup({ stage: async (stage) => { if (stage === "before_claim") { entered.release(); await release.promise; } } });
    const accepted = await f.host.startTurn("device", "command", "actual prompt"); await entered.promise;
    const intent = f.host.execution.forCommand("device", "command")[0]!;
    expect(intent).toMatchObject({ state: "pending", actorKind: "device", payload: { prompt: "actual prompt" }, dispatchContext: { hostOwnerId: f.host.owner.ownerId, attemptId: intent.attemptId } });
    f.host.store.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), "device");
    release.release(); await f.host.worker.drainDispatch();
    expect(f.calls).toHaveLength(0); expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("failed");
    expect(f.host.store.getCommandReceipt("device", "command")?.response).toMatchObject({ evidence: { kind: "not-dispatched" } });
    expect(f.host.workspaceLease).toBeUndefined();
  });
  it("records only local approval delivery while the start outcome is still independently awaited", async () => {
    const f = setup(); const accepted = await f.host.startTurn("device", "command", "prompt"); await f.host.worker.drainDispatch();
    f.host.store.commitEvent(f.host.sessionId, "approval.requested", {}, { turnId: accepted.turnId, turnStatus: "waiting_approval", activityState: "waiting_approval",
      approval: { approvalId: "approval", sessionId: f.host.sessionId, turnId: accepted.turnId, toolUseId: "tool", version: 0, status: "pending",
        request: { turnId: accepted.turnId, toolName: "Bash", input: {} }, createdAt: new Date().toISOString() } });
    expect(await f.host.respondApproval("device", "respond", "approval", "allow_once")).toEqual({ status: "accepted", approvalId: "approval" });
    await f.host.worker.drainDispatch();
    expect(f.adapter.respondApproval).toHaveBeenCalledOnce();
    expect(f.host.store.getCommandReceipt("device", "respond")?.response).toMatchObject({ status: "delivered", deliveryState: "local_delivery", evidence: { kind: "local-delivery" } });
    expect(f.host.execution.forCommand("device", "command")[0]?.state).toBe("dispatching");
    expect(f.host.execution.reservation("approval")?.state).toBe("local_delivery");
    f.outcome.release(complete); expect(await f.host.worker.drainOperations()).toBe(true);
  });
  it("holds the checkout lease through after-terminal capture and tracks the capture for drain", async () => {
    const entered = barrier(); const release = barrier();
    const f = setup({ afterTerminal: async () => { entered.release(); await release.promise; } });
    await f.host.startTurn("device", "command", "prompt"); await f.host.worker.drainDispatch(); f.outcome.release(complete); await entered.promise;
    expect(f.host.workspaceLease).toBeDefined();
    let drained = false; const drain = f.host.worker.drainOperations().then((result) => { drained = result; }); await Promise.resolve(); expect(drained).toBe(false);
    release.release(); await drain; expect(drained).toBe(true); expect(f.host.workspaceLease).toBeUndefined();
  });
  it.each(["preparation_failure", "native_terminal"] as const)("retains checkout and owner gates for an unproved process tree after %s", async (phase) => {
    const f = setup(phase === "preparation_failure" ? { beforeDispatch: () => { throw new Error("PRE_DISPATCH_TREE_UNPROVEN"); } } : {}, () => false, true);
    const accepted = await f.host.startTurn("device", "command", "prompt");
    const lease = f.host.workspaceLease!; const release = vi.spyOn(lease, "release"); const retain = vi.spyOn(lease, "retain");
    await f.host.worker.drainDispatch();
    if (phase === "native_terminal") f.outcome.release(complete);
    expect(await f.host.worker.drainOperations()).toBe(true);
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe(phase === "native_terminal" ? "completed" : "failed");
    expect(f.calls).toHaveLength(phase === "native_terminal" ? 1 : 0);
    expect(f.host.workspaceLease).toBe(lease); expect(release).not.toHaveBeenCalled(); expect(retain).toHaveBeenCalledWith("producer_stop_unverified");
    expect(f.host.owner.retainedReason).toBe("producer_stop_unverified");
    expect(f.host.snapshot().session).toMatchObject({ activeTurnId: accepted.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
    expect(lease.operationId).toBe(accepted.turnId);
    await expect(f.host.startTurn("device", "second", "another prompt")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
  });
  it("retains an unproven Provider outcome and rejects a new Turn without releasing the checkout", async () => {
    const f = setup(); await f.host.startTurn("device", "command", "prompt"); await f.host.worker.drainDispatch();
    const lease = f.host.workspaceLease!; const release = vi.spyOn(lease, "release"); const retain = vi.spyOn(lease, "retain");
    f.outcome.release({ status: "outcome_unknown", error: "stdio ended after possible send", evidence: { kind: "unknown", reason: "stdio ended after possible send" } });
    expect(await f.host.worker.drainOperations()).toBe(true); expect(f.host.snapshot().session.activityState).toBe("outcome_unknown"); expect(f.host.workspaceLease).toBe(lease); expect(release).not.toHaveBeenCalled(); expect(retain).toHaveBeenCalledWith("turn_outcome_unverified");
    await expect(f.host.startTurn("device", "new-command", "new prompt")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" }); expect(f.calls).toHaveLength(1);
  });
});
