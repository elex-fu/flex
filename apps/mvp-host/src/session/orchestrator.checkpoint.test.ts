import { afterEach, describe, expect, it, vi } from "vitest";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionOrchestrator } from "./orchestrator.js";
import { CheckpointService } from "../checkpoint/checkpoint-service.js";
import { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { CheckpointGitDriver } from "../checkpoint/git-driver.js";
import { SqliteStore } from "../storage/db.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { applyCheckpointSchema } from "../storage/migrations/009-checkpoints.js";
import { temporaryRepository, userGitState, removeFixture } from "../checkpoint/test-support.js";
import { rawCheckpointGitRunner } from "../test-support/managed-git-fixtures.js";
import type { ProviderAdapter, ProviderOutcome } from "../provider/types.js";
import type { OrchestratorOptions } from "./orchestrator.js";

function barrier<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const known: ProviderOutcome = { status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "native-result" } };
const open: Array<{ host: SessionOrchestrator; root: string; outcome: ReturnType<typeof barrier<ProviderOutcome>> }> = [];
afterEach(async () => { for (const value of open.splice(0)) { value.host.close(); value.outcome.resolve(known); await Promise.resolve(); await removeFixture(value.root); } });
async function setup(options: { before?: () => Promise<void>; after?: () => Promise<void>; proof?: () => boolean; hook?: () => Promise<void>; gate?: () => void; unsupportedBefore?: boolean; stop?: () => Promise<import("../lifecycle/managed-process-registry.js").ProcessStopResult> } = {}) {
  const root = await temporaryRepository(); const outcome = barrier<ProviderOutcome>(); const calls: string[] = []; const blocked = vi.fn();
  let host!: SessionOrchestrator; let service!: CheckpointService; let checkpoints!: CheckpointStore;
  const driver = new CheckpointGitDriver(root, { runGit: rawCheckpointGitRunner() });
  const adapter: ProviderAdapter = { provider: "claude", workspace: root, status: async () => { throw new Error("not used"); }, preflight: async () => { throw new Error("no real Provider"); },
    runTurn: async () => { throw new Error("beginTurn required"); }, beginTurn: (_context, prompt) => { calls.push(prompt); return { outcome: outcome.promise }; },
    interrupt: async () => "accepted", respondApproval: () => true, ...(options.stop ? { closeTurnAndWait: options.stop } : {}) };
  const binding: NonNullable<OrchestratorOptions["checkpoints"]> = {
    service: {
      captureBefore: async (context) => { await options.before?.(); expect(host.workspaceLease).toBeDefined(); expect(calls).toHaveLength(0); const manifest = await service.captureBefore(context); return options.unsupportedBefore ? { ...manifest, status: "unsupported" as const } : manifest; },
      captureAfter: async (context) => {
        expect(host.workspaceLease).toBeDefined(); expect(host.store.getTurn(context.turnId)?.status).toBe("completed");
        const source = host.store.listEvents(host.sessionId).events.find((event) => event.sequence === context.evidence.terminalSequence);
        expect(source?.type).toBe("turn.reconciled"); expect(context.evidence).toMatchObject({ producerStopped: true, terminalCommitted: true });
        await options.after?.(); return service.captureAfter(context);
      },
    },
    contextFor: (_intent, context, lease) => {
      const session = host.store.getSession(host.sessionId)!;
      return { sessionId: context.sessionId, workspaceId: session.workspaceId, turnId: context.flyxTurnId, attemptId: context.attemptId,
        lease: { workspaceId: session.workspaceId, leaseId: lease.operationId, generation: host.owner.generation },
        sessionRevision: session.revision, epoch: "view-epoch", runtimeGeneration: context.runtimeGeneration, nativeHandle: { providerSessionId: session.providerSessionId ?? null } };
    },
  };
  host = new SessionOrchestrator({ workspace: root, adapter, checkpoints: binding, canReleaseWorkspace: options.proof ?? (() => true),
    onExecutionBlocked: blocked, ...(options.gate ? { assertWriteReady: options.gate } : {}), ...(options.hook ? { executionHooks: { afterTerminal: options.hook } } : {}),
    executionSetup: (value) => {
      applyCheckpointSchema(value.store.db); checkpoints = new CheckpointStore(value.store.db);
      service = new CheckpointService({ store: checkpoints, driverFor: () => driver, assertLease: (context) => {
        const lease = value.workspaceLease; if (!lease || lease.operationId !== context.lease.leaseId) throw new Error("lost lease"); lease.assertActive();
      } });
    },
  });
  open.push({ host, root, outcome }); return { host, root, outcome, calls, service, checkpoints, blocked };
}

describe("production checkpoint execution order", { timeout: 30_000 }, () => {
  it("captures exact before/after bytes under one lease with committed terminal and stop proof before release", async () => {
    const before = barrier(); const beforeRelease = barrier(); const after = barrier(); const afterRelease = barrier();
    const f = await setup({ before: async () => { before.resolve(); await beforeRelease.promise; }, after: async () => { after.resolve(); await afterRelease.promise; } });
    await writeFile(join(f.root, "tracked.txt"), "dirty before\n"); const user = await userGitState(f.root);
    const accepted = await f.host.startTurn("test-actor", "start", "edit"); await before.promise;
    expect(f.calls).toHaveLength(0); expect(f.host.execution.forCommand("test-actor", "start")[0]?.state).toBe("claimed");
    beforeRelease.resolve(); await f.host.worker.drainDispatch(); expect(f.calls).toEqual(["edit"]);
    const intent = f.host.execution.forCommand("test-actor", "start")[0]!;
    expect(f.checkpoints.findAttempt(f.host.sessionId, accepted.turnId, intent.attemptId, "before")?.status).toBe("complete");
    await writeFile(join(f.root, "tracked.txt"), "native after\n"); f.outcome.resolve(known); await after.promise;
    expect(f.host.store.getCommandReceipt("test-actor", "start")?.state).toBe("completed"); expect(f.host.workspaceLease).toBeDefined();
    await expect(f.host.startTurn("test-actor", "next", "next prompt")).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    afterRelease.resolve(); expect(await f.host.worker.drainOperations()).toBe(true); expect(f.host.workspaceLease).toBeUndefined();
    expect(await userGitState(f.root)).toEqual(user);
    const page = await f.service.getTurnDiff({ sessionId: f.host.sessionId, turnId: accepted.turnId, attemptId: intent.attemptId });
    const file = await f.service.getDiffFile({ sessionId: f.host.sessionId, diffId: page.diffId!, fileId: page.files[0]!.fileId });
    expect(file.before).toMatchObject({ text: "dirty before\n" }); expect(file.after).toMatchObject({ text: "native after\n" });
    const sources = f.host.store.listEvents(f.host.sessionId).events.filter((event) => event.type === "checkpoint.captured");
    expect(sources.map((event) => (event.payload as { phase: string }).phase)).toEqual(["before", "after"]); expect(JSON.stringify(sources)).not.toContain(f.root);
  });
  it("does not capture after or release a known native terminal when producer stop is unproved", async () => {
    const after = vi.fn(async () => {}); const f = await setup({ proof: () => false, after });
    const accepted = await f.host.startTurn("test-actor", "start", "edit"); await f.host.worker.drainDispatch(); f.outcome.resolve(known); expect(await f.host.worker.drainOperations()).toBe(true);
    const intent = f.host.execution.forCommand("test-actor", "start")[0]!;
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed"); expect(after).not.toHaveBeenCalled(); expect(f.host.workspaceLease).toBeDefined();
    expect(f.host.runtimes.isBusy(intent.dispatchContext!.runtimeId)).toBe(true); expect(f.host.runtimes.classify(intent.dispatchContext!, known).status).toBe("completed");
    expect(f.blocked).toHaveBeenCalledWith(expect.objectContaining({ id: intent.id }), "producer_stop_unverified");
  });
  it("retains a failed after-capture journal without rewriting the known Provider terminal", async () => {
    const f = await setup();
    f.host.store.db.exec(`CREATE TRIGGER fail_after_checkpoint BEFORE INSERT ON checkpoint_files
      WHEN (SELECT phase FROM checkpoint_captures WHERE checkpoint_id = NEW.checkpoint_id) = 'after'
      BEGIN SELECT RAISE(ABORT, 'injected after publication failure'); END;`);
    const accepted = await f.host.startTurn("test-actor", "start", "edit"); await f.host.worker.drainDispatch(); f.outcome.resolve(known); expect(await f.host.worker.drainOperations()).toBe(true);
    const intent = f.host.execution.forCommand("test-actor", "start")[0]!;
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed"); expect(f.host.store.getCommandReceipt("test-actor", "start")?.state).toBe("completed");
    expect(f.checkpoints.findAttempt(f.host.sessionId, accepted.turnId, intent.attemptId, "after")?.status).toBe("capturing"); expect(f.host.workspaceLease).toBeDefined();
    expect(f.blocked).toHaveBeenCalledWith(expect.objectContaining({ id: intent.id }), "checkpoint_completion_unverified");
  });
  it("drops late terminal-hook publication after the worker is sealed and the Store closes", async () => {
    const entered = barrier(); const release = barrier(); const f = await setup({ hook: async () => { entered.resolve(); await release.promise; } });
    await f.host.startTurn("test-actor", "start", "edit"); await f.host.worker.drainDispatch(); f.outcome.resolve(known); await entered.promise;
    const read = vi.spyOn(f.host.store, "getTurn"); f.host.close(); read.mockClear(); release.resolve(); expect(await f.host.worker.drainOperations()).toBe(true); expect(read).not.toHaveBeenCalled();
  });
  it("registers generic drivers and execution setup before scanning pre-existing pending intents", async () => {
    const root = await temporaryRepository(); const owner = createTestHostOwner(); const store = new SqliteStore(":memory:", { owner }); const session = store.createSession(await realpath(root));
    const request = { authSubjectId: "host-actor", commandId: "operation", method: "worktree.create", requestHash: hashCommandRequest("worktree.create", {}), targetSessionId: session.id };
    const context = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: session.id, flyxTurnId: "worktree", runtimeId: `claude:${session.id}`, runtimeGeneration: 1, attemptId: "attempt" };
    new CommandEngine(store).commitRequest(request, (_facts, clock) => ({ result: { status: "accepted" }, events: [{ type: "worktree.accepted", payload: {} }],
      receipts: [{ ...request, state: "accepted", response: {} }], intents: [{ id: clock.id(), sessionId: session.id, authSubjectId: request.authSubjectId, commandId: request.commandId,
        ordinal: 0, actorKind: "host", kind: "worktree.create", resourceId: "worktree", payload: { operationId: "op" }, requestHash: request.requestHash,
        runtimeGeneration: 1, attemptId: "attempt", dispatchContext: context }] }));
    let configured = false;
    const driver = vi.fn(async () => { expect(configured).toBe(true); return { status: "settled" as const, resultCode: "CREATED" }; });
    const outcome = barrier<ProviderOutcome>();
    const adapter: ProviderAdapter = { provider: "claude", workspace: root, status: async () => { throw new Error("unused"); }, preflight: async () => { throw new Error("unused"); },
      runTurn: async () => { throw new Error("no Provider call"); }, interrupt: async () => "accepted", respondApproval: () => true };
    const host = new SessionOrchestrator({ workspace: root, store, owner, adapter, genericOperations: { "worktree.create": driver }, executionSetup: () => { configured = true; } });
    open.push({ host, root, outcome }); await host.worker.drainDispatch();
    expect(driver).toHaveBeenCalledOnce(); expect(store.getCommandReceipt("host-actor", "operation")?.state).toBe("completed");
    expect(host.operationContext("resource", "new-attempt", 2)).toMatchObject({ hostOwnerId: owner.ownerId, sessionId: session.id, runtimeId: context.runtimeId, flyxTurnId: "resource", attemptId: "new-attempt", runtimeGeneration: 2 });
  });
  it("retains the trusted full-target v2 hash and rejects a different selected resource", async () => {
    const f = await setup(); const request = { authSubjectId: "test-actor", commandId: "v2", method: "session.startTurn", targetSessionId: f.host.sessionId,
      requestFormatVersion: 2 as const, requestHash: hashCommandRequest("session.startTurn", { target: { workspaceId: "default", sessionId: f.host.sessionId }, prompt: "edit" }) };
    const accepted = await f.host.startTurn("test-actor", "v2", "edit", request); await f.host.worker.drainDispatch();
    expect(f.host.store.getCommandReceipt("test-actor", "v2")).toMatchObject({ requestHash: request.requestHash, requestFormatVersion: 2, targetSessionId: f.host.sessionId });
    expect(f.host.execution.forCommand("test-actor", "v2")[0]).toMatchObject({ requestHash: request.requestHash, requestFormatVersion: 2, turnId: accepted.turnId });
    await expect(f.host.startTurn("test-actor", "v2", "edit", { ...request, targetSessionId: "another-session" })).rejects.toMatchObject({ code: "COMMAND_SCOPE_MISMATCH" });
    f.outcome.resolve(known); expect(await f.host.worker.drainOperations()).toBe(true);
  });
  it("rejects restored external-state writes before any accepted receipt or native dispatch", async () => {
    const f = await setup({ gate: () => { throw new Error("RESTORE_EXTERNAL_STATE_UNVERIFIED"); } });
    await expect(f.host.startTurn("test-actor", "blocked", "edit")).rejects.toMatchObject({ code: "RESTORE_EXTERNAL_STATE_UNVERIFIED" });
    expect(f.host.store.getCommandReceipt("test-actor", "blocked")).toBeUndefined(); expect(f.calls).toHaveLength(0);
  });
  it("waits for the original Turn close before after capture and preserves a known terminal on stop rejection", async () => {
    const stop = barrier<import("../lifecycle/managed-process-registry.js").ProcessStopResult>(); const after = vi.fn(async () => {});
    const f = await setup({ stop: () => stop.promise, after });
    const accepted = await f.host.startTurn("test-actor", "stop-before-after", "edit"); await f.host.worker.drainDispatch();
    f.outcome.resolve(known); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed"); expect(after).not.toHaveBeenCalled();
    stop.resolve({ stopped: false, treeStopped: false, records: [] }); await f.host.worker.drainOperations();
    expect(after).not.toHaveBeenCalled(); expect(f.host.workspaceLease).toBeDefined();
    expect(f.host.store.getCommandReceipt("test-actor", "stop-before-after")?.state).toBe("completed");
    expect(f.blocked).toHaveBeenCalledWith(expect.anything(), "producer_stop_unverified");
  });

  it("rejects an unusable before checkpoint before invoking the Provider prompt", async () => {
    const f = await setup({ unsupportedBefore: true });
    const accepted = await f.host.startTurn("test-actor", "unsupported-before", "must not run");
    expect(await f.host.worker.drainOperations()).toBe(true);
    expect(f.calls).toHaveLength(0); expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("failed");
    expect(f.host.store.getCommandReceipt("test-actor", "unsupported-before")?.state).toBe("failed");
    expect(f.host.workspaceLease).toBeUndefined();
  });

});
