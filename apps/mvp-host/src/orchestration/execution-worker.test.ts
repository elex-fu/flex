import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandEngine, hashCommandRequest } from "./command-engine.js";
import type { CommandRequest } from "./command-contract.js";
import { decideAcceptTurn, decideInterrupt } from "./decider.js";
import { ExecutionWorker, type ExecutionStage, type ExecutionWorkerOptions } from "./execution-worker.js";
import { SqliteStore } from "../storage/db.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { ProviderIngestion } from "./provider-ingestion.js";
import { RuntimeRegistry } from "../provider/runtime-registry.js";
import { fenceAdapterEvent } from "../provider/types.js";
import type { DispatchContext, ProviderAcceptance, ProviderAdapter, ProviderOutcome, ProviderRun } from "../provider/types.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const completed: ProviderOutcome = { status: "completed", providerSessionId: "native-session", evidence: { kind: "native-terminal", sourceId: "native-terminal-1" } };
const fixtures: Array<{ worker: ExecutionWorker; outcome: ReturnType<typeof deferred<ProviderOutcome>>; store: SqliteStore }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const value of fixtures.splice(0)) { value.worker.seal(); value.outcome.resolve(completed); await Promise.resolve(); value.store.close(); }
});
function fixture(options: { stage?: ExecutionWorkerOptions["stage"]; nativeAck?: boolean; wakeFails?: boolean; timeoutMs?: number } = {}) {
  const store = new SqliteStore();
  const session = store.createSession("/tmp/worker-fixture");
  const execution = new ExecutionStore(store);
  const outcome = deferred<ProviderOutcome>();
  const accepted = deferred<ProviderAcceptance>();
  const calls: Array<{ context: DispatchContext; prompt: string; resume?: string }> = [];
  let revoked = false;
  const adapter: ProviderAdapter = { provider: "claude", workspace: "/tmp/worker-fixture",
    status: async () => ({ provider: "claude", transport: "deterministic", adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace: "/tmp/worker-fixture", sandboxRequired: true }),
    preflight: async () => { throw new Error("No preflight is permitted in deterministic worker tests"); },
    runTurn: async () => { throw new Error("beginTurn must be used"); },
    beginTurn: (context, prompt, resume): ProviderRun => { calls.push({ context, prompt, ...(resume ? { resume } : {}) }); return {
      ...(options.nativeAck ? { accepted: accepted.promise } : {}), outcome: outcome.promise,
    }; },
    interrupt: vi.fn(async () => "accepted" as const), respondApproval: vi.fn(() => true),
  };
  const registry = new RuntimeRegistry(); registry.register("runtime", adapter);
  const resultOptions: ExecutionWorkerOptions = {
    owner: { id: "owner-one", generation: 1 }, sessionId: session.id,
    ...(options.stage ? { stage: options.stage } : {}), ...(options.timeoutMs ? { outcomeTimeoutMs: options.timeoutMs } : {}),
    revalidateDevice: () => { if (revoked) throw new Error("DEVICE_REVOKED"); }, drainIngestion: async () => {},
    onDispatch: (intent) => { if (intent.kind === "start_turn") store.commitEvent(session.id, "turn.started", { turnId: intent.turnId }, { turnId: intent.turnId!, turnStatus: "running", activityState: "running" }); },
    onStartOutcome: (intent, value) => { store.commitEvent(session.id, "turn.reconciled", { turnId: intent.turnId, outcome: value }, {
      turnId: intent.turnId!, turnStatus: value.status, activityState: value.status === "outcome_unknown" ? "outcome_unknown" : "idle",
      commandReceipt: { authSubjectId: intent.authSubjectId, commandId: intent.commandId, requestHash: intent.requestHash, state: value.status,
        response: { turnId: intent.turnId, ...value }, required: true },
    }); },
    onControlResult: (intent, value) => { store.commitEvent(session.id, "control.delivery", value, { commandReceipt: {
      authSubjectId: intent.authSubjectId, commandId: intent.commandId, requestHash: intent.requestHash,
      state: value.status === "outcome_unknown" ? "outcome_unknown" : value.status === "not_dispatched" ? "failed" : "accepted", response: value, required: true,
    } }); },
  };
  const worker = new ExecutionWorker(execution, registry, resultOptions);
  const engine = new CommandEngine(store, { wake: () => { if (options.wakeFails) throw new Error("injected wake failure"); worker.wake(); } });
  function request(commandId: string, method: string, payload: unknown): CommandRequest {
    return { authSubjectId: "device", commandId, method, requestHash: hashCommandRequest(method, payload), targetSessionId: session.id,
      dispatchBinding: { hostOwnerId: "owner-one", hostOwnerGeneration: 1, runtimeId: "runtime" } };
  }
  const start = (prompt = "actual prompt") => { const req = request("start", "session.startTurn", { prompt }); return engine.commitRequest(req, (facts, clock) => decideAcceptTurn(facts, req, { prompt }, clock)); };
  const interrupt = () => { const req = request("interrupt", "session.interrupt", {}); return engine.commitRequest(req, (facts, clock) => decideInterrupt(facts, req, clock)); };
  const value = { store, session, execution, outcome, accepted, adapter, registry, worker, engine, calls, start, interrupt,
    revoke: () => { revoked = true; }, resultOptions };
  fixtures.push(value); return value;
}

describe("durable execution dispatch windows", () => {
  it("keeps accepted prompt/context/hash/ordinal discoverable after wake fails and scans it exactly once", async () => {
    const f = fixture({ wakeFails: true }); const accepted = f.start("persisted prompt");
    const intent = accepted.intents[0]!;
    expect(f.execution.get(intent.id)).toMatchObject({ state: "pending", ordinal: 0, payload: { prompt: "persisted prompt" },
      requestHash: hashCommandRequest("session.startTurn", { prompt: "persisted prompt" }), dispatchContext: { attemptId: intent.attemptId, hostOwnerId: "owner-one" } });
    expect(f.calls).toHaveLength(0);
    f.worker.scan(); await f.worker.drainDispatch(); f.worker.scan();
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ prompt: "persisted prompt", context: intent.dispatchContext });
    f.outcome.resolve(completed); expect(await f.worker.drainOperations()).toBe(true);
    expect(f.execution.get(intent.id)).toMatchObject({ state: "settled", resultCode: "completed" });
  });

  it.each(["after_claim", "after_marker", "after_call", "after_ack", "before_settle"] as const)("restarts at %s without repeating a maybe-sent side effect", async (stage) => {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = fixture({ nativeAck: stage === "after_ack", stage: async (value) => { if (value === stage) { entered.resolve(); await release.promise; } } });
    const accepted = f.start();
    if (stage === "after_ack" || stage === "before_settle") await f.worker.drainDispatch();
    if (stage === "after_ack") f.accepted.resolve({ nativeSessionId: "native-session", nativeTurnId: "native-turn", sourceId: "native-turn" });
    if (stage === "before_settle") f.outcome.resolve(completed);
    await entered.promise;
    const state = f.execution.get(accepted.intents[0]!.id)!.state;
    expect(state).toBe(stage === "after_claim" ? "claimed" : stage === "after_ack" ? "acknowledged" : "dispatching");
    const calls = f.calls.length;
    f.worker.seal();
    const restarted = new ExecutionWorker(f.execution, new RuntimeRegistry(), { ...f.resultOptions, owner: { id: "owner-two", generation: 2 } });
    restarted.recover(); restarted.scan();
    expect(f.calls).toHaveLength(calls);
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe(stage === "after_claim" ? "settled" : "outcome_unknown");
    const response = f.store.getCommandReceipt("device", "start")?.response as { evidence: { kind: string } };
    expect(response.evidence.kind).toBe(stage === "after_claim" ? "not-dispatched" : "unknown");
    restarted.seal(); release.resolve(); await f.worker.drainDispatch();
  });

  it("leaves a never-dispatched old-owner pending context blocked instead of replacing its fence", async () => {
    const f = fixture({ wakeFails: true }); const accepted = f.start();
    const restarted = new ExecutionWorker(f.execution, f.registry, { ...f.resultOptions, owner: { id: "owner-two", generation: 2 } });
    restarted.recover(); expect(restarted.scan()).toBe(0); await restarted.drainDispatch();
    expect(f.execution.get(accepted.intents[0]!.id)).toMatchObject({ state: "pending", dispatchContext: { hostOwnerId: "owner-one", hostOwnerGeneration: 1 } });
    expect(f.calls).toHaveLength(0); restarted.seal();
  });

  it("revalidates a revoked queued device inside claim and sends nothing", async () => {
    const f = fixture({ wakeFails: true }); const accepted = f.start(); f.revoke(); f.worker.scan(); await f.worker.drainDispatch();
    expect(f.calls).toHaveLength(0);
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled");
    expect(f.store.getCommandReceipt("device", "start")?.response).toMatchObject({ status: "failed", evidence: { kind: "not-dispatched" } });
  });

  it("revalidates again after preparation, before the persisted dispatch marker", async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = fixture({ stage: async (stage) => { if (stage === "after_claim") { entered.resolve(); await release.promise; } } });
    const accepted = f.start(); await entered.promise; f.revoke(); release.resolve(); await f.worker.drainDispatch();
    expect(f.calls).toHaveLength(0); expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled");
  });

  it("revalidates after asynchronous marker hooks and sends nothing when the device was revoked", async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = fixture({ stage: async (stage) => { if (stage === "after_marker") { entered.resolve(); await release.promise; } } });
    const accepted = f.start(); await entered.promise; f.revoke(); release.resolve(); await f.worker.drainDispatch();
    expect(f.calls).toHaveLength(0); expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled");
    expect(f.store.getCommandReceipt("device", "start")?.response).toMatchObject({ evidence: { kind: "not-dispatched" } });
  });

  it("refuses an asynchronous authorizer inside the claim transaction", () => {
    const f = fixture({ wakeFails: true }); const accepted = f.start();
    expect(() => f.execution.claim(accepted.intents[0]!.id, { id: "owner-one", generation: 1 }, async () => {})).toThrow("DISPATCH_REVALIDATION_MUST_BE_SYNCHRONOUS");
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("pending"); expect(f.calls).toHaveLength(0);
  });

  it("dispatches interrupt independently while outcome is unresolved, without inventing a native ACK", async () => {
    const f = fixture(); const start = f.start(); await f.worker.drainDispatch();
    const control = f.interrupt(); await f.worker.drainDispatch();
    expect(f.adapter.interrupt).toHaveBeenCalledOnce(); expect(f.registry.isBusy("runtime")).toBe(true);
    expect(f.execution.get(start.intents[0]!.id)?.state).toBe("dispatching");
    expect(f.execution.get(control.intents[0]!.id)?.state).toBe("dispatching");
    expect(f.store.getCommandReceipt("device", "interrupt")?.response).toMatchObject({ evidence: { kind: "local-delivery" } });
    f.outcome.resolve({ status: "cancelled", evidence: { kind: "native-terminal", sourceId: "native-cancel" } });
    expect(await f.worker.drainOperations()).toBe(true);
  });

  it("keeps unconfirmed timeouts unknown and tracks the still-pending native producer for drain", async () => {
    vi.useFakeTimers(); const f = fixture({ timeoutMs: 100 }); const start = f.start(); await f.worker.drainDispatch();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.execution.get(start.intents[0]!.id)?.state).toBe("outcome_unknown"); expect(f.registry.isBusy("runtime")).toBe(true);
    const drained = f.worker.drainOperations(10); await vi.advanceTimersByTimeAsync(10); expect(await drained).toBe(false);
    f.worker.scan(); expect(f.calls).toHaveLength(1);
  });


  it("does not settle an undispatched interaction merely because its Turn reached a native terminal", async () => {
    const entered = deferred<void>(); const release = deferred<void>(); const terminal = deferred<void>();
    const f = fixture({ stage: async (stage, intent) => { if (stage === "before_claim" && intent.kind === "respond_question") { entered.resolve(); await release.promise; } } });
    const started = f.start(); await f.worker.drainDispatch(); const startIntent = started.intents[0]!;
    const handler = vi.fn(async () => ({ status: "delivered" as const, evidence: { kind: "local-delivery" as const } })); f.worker.registerControl("respond_question", handler);
    const request: CommandRequest = { authSubjectId: "device", commandId: "answer", method: "interaction.respond", targetSessionId: f.session.id,
      requestHash: hashCommandRequest("interaction.respond", { answers: ["yes"] }) };
    const accepted = f.engine.commitRequest(request, (_facts, clock) => ({ result: { status: "accepted" },
      events: [{ type: "interaction.response.accepted", payload: { turnId: startIntent.turnId } }], receipts: [{ ...request, state: "accepted", response: { turnId: startIntent.turnId } }],
      intents: [{ id: clock.id(), sessionId: f.session.id, turnId: startIntent.turnId!, authSubjectId: "device", commandId: "answer", ordinal: 0, actorKind: "device", kind: "respond_question",
        resourceId: "question", payload: { interactionId: "question", answers: ["yes"] }, requestHash: request.requestHash, runtimeGeneration: startIntent.runtimeGeneration,
        attemptId: startIntent.attemptId, nativeRequestId: "native-question", dispatchContext: startIntent.dispatchContext! }],
    }));
    await entered.promise;
    f.store.registerCommitHook((events) => { if (events.some((event) => event.type === "turn.reconciled")) terminal.resolve(); });
    f.outcome.resolve(completed); await terminal.promise;
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("pending"); expect(f.store.getCommandReceipt("device", "answer")?.state).toBe("accepted");
    f.store.commitEvent(f.session.id, "interaction.superseded", { interactionId: "question" }, { commandReceipt: { authSubjectId: "device", commandId: "answer", requestHash: request.requestHash,
      state: "failed", response: { evidence: { kind: "not-dispatched" }, reason: "turn_ended_before_reply" }, required: true } });
    release.resolve(); expect(await f.worker.drainOperations()).toBe(true); expect(handler).not.toHaveBeenCalled();
    expect(f.store.getCommandReceipt("device", "answer")?.response).toMatchObject({ evidence: { kind: "not-dispatched" } });
  });

  it("waits for the original runtime binding before delivering a control accepted during preparation", async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = fixture({ stage: async (stage, intent) => { if (stage === "after_claim" && intent.kind === "start_turn") { entered.resolve(); await release.promise; } } });
    f.start(); await entered.promise; const control = f.interrupt();
    expect(f.execution.get(control.intents[0]!.id)?.state).toBe("pending"); expect(f.adapter.interrupt).not.toHaveBeenCalled();
    release.resolve(); await f.worker.drainDispatch();
    expect(f.adapter.interrupt).toHaveBeenCalledOnce(); expect(f.store.getCommandReceipt("device", "interrupt")?.response).toMatchObject({ evidence: { kind: "local-delivery" } });
  });

  it("settles an actual native terminal even when an optional native ACK never arrives", async () => {
    const f = fixture({ nativeAck: true }); const accepted = f.start(); await f.worker.drainDispatch();
    f.outcome.resolve(completed); expect(await f.worker.drainOperations()).toBe(true);
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled");
    expect(f.execution.get(accepted.intents[0]!.id)?.nativeRequestId).toBeUndefined();
  });

  it("tracks a registered control's delivery commit and preserves its terminal service fact", async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = fixture(); f.start(); await f.worker.drainDispatch();
    const delivered = { status: "delivered" as const, evidence: { kind: "local-delivery" as const } };
    const handler = vi.fn(async () => delivered);
    f.worker.registerControl("interrupt_turn", handler, async (intent, outcome) => {
      entered.resolve(); await release.promise;
      f.store.commitEvent(f.session.id, "interaction.delivery", { intentId: intent.id, outcome }, { commandReceipt: {
        authSubjectId: intent.authSubjectId, commandId: intent.commandId, requestHash: intent.requestHash,
        state: "completed", response: { serviceDelivery: "local", outcome }, required: true,
      } });
    });
    const accepted = f.interrupt(); await entered.promise;
    expect(handler).toHaveBeenCalledOnce(); expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("dispatching");
    let drained = false; const drain = f.worker.drainDispatch().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    release.resolve(); await drain;
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled");
    expect(f.store.getCommandReceipt("device", "interrupt")?.response).toMatchObject({ serviceDelivery: "local", outcome: delivered });
  });

  it("drains accepted ingress even before its task has entered the operation registry", async () => {
    const entered = deferred<void>(); const release = deferred<void>(); const f = fixture();
    const ingress = new ProviderIngestion({ admit: () => true, handle: async () => { entered.resolve(); await release.promise; },
      failed: (error) => { throw error; }, track: (run) => f.worker.track("ingestion", run) });
    f.resultOptions.drainIngestion = () => ingress.drain();
    const context: DispatchContext = { hostOwnerId: "owner-one", hostOwnerGeneration: 1, sessionId: f.session.id, flyxTurnId: "turn",
      runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt" };
    void ingress.enqueue(fenceAdapterEvent(context, { kind: "assistant_delta", itemId: "item", text: "accepted before tracking" }));
    let drained = false; const drain = f.worker.drainOperations().then((value) => { drained = value; }); await entered.promise;
    expect(drained).toBe(false); release.resolve(); await drain; expect(drained).toBe(true); expect(ingress.size).toBe(0);
  });

  it("checks restore readiness inside claim and sends no queued external operation", async () => {
    const f = fixture({ wakeFails: true }); const accepted = f.start();
    f.resultOptions.assertWriteReady = () => { throw new Error("RESTORE_EXTERNAL_STATE_UNVERIFIED"); };
    f.worker.scan(); await f.worker.drainDispatch(); expect(f.calls).toHaveLength(0);
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled");
    expect(f.store.getCommandReceipt("device", "start")?.response).toMatchObject({ evidence: { kind: "not-dispatched" }, error: "RESTORE_EXTERNAL_STATE_UNVERIFIED" });
  });

  it("enforces admission budgets and stops new start dispatch during drain", async () => {
    const f = fixture({ wakeFails: true }); f.start();
    const limited = new ExecutionWorker(f.execution, f.registry, { ...f.resultOptions, maxPending: 1 });
    expect(() => limited.assertAdmission("control")).toThrow("EXECUTION_QUEUE_FULL"); limited.stopDispatch(); expect(limited.scan()).toBe(0);
    limited.stopAdmission(); expect(() => limited.assertAdmission("control")).toThrow("HOST_DRAINING"); limited.seal();
  });

  it("fences claim ownership before a marker can be written", () => {
    const f = fixture({ wakeFails: true }); const accepted = f.start(); const intent = accepted.intents[0]!;
    f.execution.claim(intent.id, { id: "owner-one", generation: 1 });
    expect(() => f.execution.transition({ id: intent.id, expectedStates: ["claimed"], state: "dispatching", expectedClaimOwnerId: "wrong-owner", expectedClaimOwnerGeneration: 1 })).toThrow("EXECUTION_INTENT_OWNER_MISMATCH");
    expect(f.execution.get(intent.id)?.state).toBe("claimed"); expect(f.calls).toHaveLength(0);
  });
});


function acceptOperations(f: ReturnType<typeof fixture>, commandId: string, count = 1, context = true) {
  const request: CommandRequest = { authSubjectId: "device", commandId, method: "worktree.create", requestHash: hashCommandRequest("worktree.create", { count }), targetSessionId: f.session.id };
  return f.engine.commitRequest(request, (_facts, clock) => ({ result: { status: "accepted" },
    events: [{ type: "operation.accepted", payload: { commandId, count } }], receipts: [{ ...request, state: "accepted", response: { status: "accepted" } }],
    intents: Array.from({ length: count }, (_, ordinal) => ({ id: clock.id(), sessionId: f.session.id, authSubjectId: request.authSubjectId, commandId,
      ordinal, actorKind: "device" as const, kind: "create_worktree", resourceId: commandId, payload: { destination: "/tmp/new-worktree", ordinal },
      requestHash: request.requestHash, runtimeGeneration: 1, attemptId: `${commandId}-attempt`,
      ...(context ? { dispatchContext: { hostOwnerId: "owner-one", hostOwnerGeneration: 1, sessionId: f.session.id, flyxTurnId: commandId,
        runtimeId: "runtime", runtimeGeneration: 1, attemptId: `${commandId}-attempt` } } : {}),
    })),
  }));
}

describe("registered durable operations", () => {
  it("persists the marker before a generic handler and leaves the control lane reachable while it runs", async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const f = fixture(); f.start(); await f.worker.drainDispatch();
    f.worker.registerOperation("create_worktree", async (intent) => {
      expect(f.execution.get(intent.id)?.state).toBe("dispatching"); entered.resolve(); await release.promise;
      return { status: "settled", resultCode: "WORKTREE_CREATED", result: { path: "/tmp/new-worktree" } };
    });
    const operation = acceptOperations(f, "create"); await entered.promise;
    const controlEntered = deferred<void>();
    f.worker.registerControl("interrupt_turn", async () => { controlEntered.resolve(); return { status: "delivered", evidence: { kind: "local-delivery" } }; });
    f.interrupt(); await controlEntered.promise;
    expect(f.store.getCommandReceipt("device", "create")?.state).toBe("accepted");
    release.resolve(); await f.worker.drainDispatch();
    expect(f.execution.get(operation.intents[0]!.id)?.state).toBe("settled");
    expect(f.store.getCommandReceipt("device", "create")?.response).toMatchObject({ resultCode: "WORKTREE_CREATED", result: { path: "/tmp/new-worktree" } });
    const event = f.store.listEvents(f.session.id).events.find((value) => value.type === "execution.operation.settled")!;
    const receipt = f.store.getCommandReceipt("device", "create")!;
    expect(receipt.sourceSequence).toBe(event.sequence);
    expect(f.store.listEventCommits(f.session.id).find((value) => value.id === receipt.commitId)).toMatchObject({ lastSequence: event.sequence });
  });

  it("does not settle sibling operations before all their individual effects have finished", async () => {
    const entered = [deferred<void>(), deferred<void>()]; const release = [deferred<void>(), deferred<void>()];
    const f = fixture();
    f.worker.registerOperation("create_worktree", async (intent) => { entered[intent.ordinal]!.resolve(); await release[intent.ordinal]!.promise; return { status: "settled", resultCode: `STEP_${intent.ordinal}` }; });
    const accepted = acceptOperations(f, "create-two", 2); await Promise.all(entered.map((value) => value.promise));
    const firstSettled = deferred<void>();
    f.store.registerCommitHook((events) => { if (events.some((value) => value.type === "execution.operation.settled")) firstSettled.resolve(); });
    release[0]!.resolve(); await firstSettled.promise;
    expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("settled"); expect(f.execution.get(accepted.intents[1]!.id)?.state).toBe("dispatching");
    expect(f.store.getCommandReceipt("device", "create-two")?.state).toBe("accepted");
    release[1]!.resolve(); await f.worker.drainDispatch(); expect(f.store.getCommandReceipt("device", "create-two")?.state).toBe("completed");
  });

  it("leaves a generic intent without its original owner binding pending", async () => {
    const f = fixture(); const handler = vi.fn(async () => ({ status: "settled" as const, resultCode: "DONE" }));
    f.worker.registerOperation("create_worktree", handler); const accepted = acceptOperations(f, "unbound", 1, false); await f.worker.drainDispatch();
    expect(handler).not.toHaveBeenCalled(); expect(f.execution.get(accepted.intents[0]!.id)?.state).toBe("pending");
  });

  it("does not overwrite a service handler's atomic settlement", async () => {
    const f = fixture();
    f.worker.registerOperation("create_worktree", async (intent) => {
      f.store.commitEvent(f.session.id, "worktree.published", { id: intent.resourceId }, { commandReceipt: { authSubjectId: intent.authSubjectId,
        commandId: intent.commandId, requestHash: intent.requestHash, state: "completed", response: { published: true }, required: true } });
      return { status: "settled", resultCode: "IGNORED_AFTER_SERVICE_COMMIT" };
    });
    acceptOperations(f, "published"); await f.worker.drainDispatch();
    expect(f.store.getCommandReceipt("device", "published")?.response).toEqual({ published: true });
    expect(f.store.listEvents(f.session.id).events.filter((event) => event.type === "execution.operation.settled")).toHaveLength(0);
  });
});
