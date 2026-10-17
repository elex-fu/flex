import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
import { SqliteStore } from "../storage/db.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { WorktreeScheduler } from "./worktree-scheduler.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
const flush = () => new Promise<void>((yes) => setImmediate(yes));
const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

type SeedInput = { kind?: string; ownerId?: string; ownerGeneration?: number; bound?: boolean; claimed?: boolean };
function fixture() {
  const store = new SqliteStore(); stores.push(store);
  const session = store.createSession("/tmp/scheduler-fixture");
  const execution = new ExecutionStore(store);
  const owner = { id: "owner-one", generation: 1 };
  let counter = 0;
  // Commits a real receipt plus a durable execution intent for the same command, exactly like the accept path.
  const seed = (input: SeedInput = {}): ExecutionIntentRow => {
    const ordinal = ++counter;
    const commandId = "command-" + ordinal, intentId = "intent-" + ordinal;
    const kind = input.kind ?? "worktree.create";
    const resourceId = "worktree-" + ordinal;
    const attemptId = "attempt-" + ordinal;
    const requestHash = "hash-" + ordinal;
    const dispatchContext = input.bound === false ? undefined : {
      hostOwnerId: input.ownerId ?? owner.id, hostOwnerGeneration: input.ownerGeneration ?? owner.generation,
      sessionId: session.id, flyxTurnId: resourceId, runtimeId: "runtime-one", runtimeGeneration: 1, attemptId,
    };
    const committed = store.commitCommand({ sessionId: session.id, build: () => ({
      result: undefined,
      events: [{ type: "worktree.accepted", payload: { intentId } }],
      receipts: [{ authSubjectId: "device", commandId, method: kind, requestHash, requestFormatVersion: 1, targetSessionId: session.id, state: "accepted", response: {} }],
      intents: [{ id: intentId, sessionId: session.id, authSubjectId: "device", commandId, ordinal: 0, actorKind: "device", kind, resourceId,
        payload: { operationId: "operation-" + ordinal }, requestHash, requestFormatVersion: 1, runtimeGeneration: 1, attemptId,
        ...(dispatchContext ? { dispatchContext } : {}) }],
    }) })!;
    const intent = committed.intents[0]!;
    if (input.claimed) {
      if (!dispatchContext) throw new Error("fixture claimed intents need a bound context");
      execution.claim(intent.id, { id: dispatchContext.hostOwnerId, generation: dispatchContext.hostOwnerGeneration });
    }
    return execution.get(intent.id)!;
  };
  const calls: string[] = [];
  const errors: Array<{ intent: ExecutionIntentRow; error: unknown }> = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const failures = new Map<string, unknown>();
  let observer: ((intent: ExecutionIntentRow, error: unknown) => void) | undefined;
  const dispatch = async (intentId: string): Promise<unknown> => {
    calls.push(intentId);
    const gate = gates.get(intentId); if (gate) await gate.promise;
    const failure = failures.get(intentId); if (failure) throw failure;
    execution.transition({ id: intentId, expectedStates: ["pending"], state: "settled", resultCode: "WORKTREE_SETTLED" });
    return "settled";
  };
  const make = (options: { limit?: number; methods?: readonly string[] } = {}) => new WorktreeScheduler({
    store: execution, owner, dispatch,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.methods !== undefined ? { methods: options.methods } : {}),
    onDispatchError: (intent, error) => { errors.push({ intent, error }); observer?.(intent, error); },
  });
  return { store, session, execution, owner, seed, make, calls, errors, gates, failures,
    gate: (intentId: string) => { const value = deferred(); gates.set(intentId, value); return value; },
    fail: (intentId: string, error: unknown) => { failures.set(intentId, error); },
    observe: (value: (intent: ExecutionIntentRow, error: unknown) => void) => { observer = value; } };
}

describe("bounded worktree intent scheduler", () => {
  it("dispatches a committed pending intent on the post-commit wake", async () => {
    const f = fixture(), scheduler = f.make(), intent = f.seed();
    scheduler.accepted(intent);
    expect(f.calls).toHaveLength(0); expect(scheduler.active).toBe(1); expect(scheduler.queued).toBe(0);
    await flush();
    expect(f.calls).toEqual([intent.id]);
    expect(await scheduler.drain(100)).toBe(true);
    expect(f.execution.get(intent.id)?.state).toBe("settled");
  });

  it("dedupes repeated startup scans and wakes without dispatching twice", async () => {
    const f = fixture(), scheduler = f.make({ limit: 1 }), intent = f.seed();
    const gate = f.gate(intent.id);
    expect(scheduler.scan()).toBe(1);
    expect(scheduler.scan()).toBe(0);
    scheduler.accepted(intent);
    await flush();
    expect(f.calls).toEqual([intent.id]); expect(scheduler.active).toBe(1); expect(scheduler.queued).toBe(0);
    gate.resolve(); await flush();
    expect(scheduler.scan()).toBe(0);
    expect(f.calls).toEqual([intent.id]);
  });

  it("keeps accepted work queued behind the bounded permit", async () => {
    const f = fixture(), scheduler = f.make({ limit: 2 });
    const first = f.seed(), second = f.seed(), third = f.seed();
    for (const intent of [first, second, third]) f.gate(intent.id);
    expect(scheduler.scan()).toBe(3);
    await flush();
    expect(f.calls).toEqual([first.id, second.id]);
    expect(scheduler.active).toBe(2); expect(scheduler.queued).toBe(1);
    expect(f.execution.get(third.id)?.state).toBe("pending");
    f.gates.get(first.id)!.resolve(); await flush();
    expect(f.calls).toEqual([first.id, second.id, third.id]);
    expect(scheduler.active).toBe(2); expect(scheduler.queued).toBe(0);
    f.gates.get(second.id)!.resolve(); f.gates.get(third.id)!.resolve();
    expect(await scheduler.drain(100)).toBe(true);
    expect(scheduler.active).toBe(0);
  });

  it("never dispatches old owner/generation, foreign methods, unbound or already claimed intents", async () => {
    const f = fixture(), scheduler = f.make();
    const foreignOwner = f.seed({ ownerId: "owner-two" }), oldGeneration = f.seed({ ownerGeneration: 0 });
    const foreignMethod = f.seed({ kind: "start_turn" }), unbound = f.seed({ bound: false }), claimed = f.seed({ claimed: true });
    expect(scheduler.scan()).toBe(0);
    for (const intent of [foreignOwner, oldGeneration, foreignMethod, unbound, claimed]) scheduler.accepted(intent);
    await flush();
    expect(f.calls).toEqual([]); expect(scheduler.queued).toBe(0); expect(scheduler.active).toBe(0);
    expect(f.execution.get(foreignOwner.id)?.state).toBe("pending");
    expect(f.execution.get(oldGeneration.id)?.state).toBe("pending");
    expect(f.execution.get(unbound.id)?.state).toBe("pending");
    expect(f.execution.get(claimed.id)?.state).toBe("claimed");
  });

  it("rejects an invalid permit budget and dispatches only the configured methods", async () => {
    const f = fixture();
    expect(() => f.make({ limit: 0 })).toThrow("WORKTREE_SCHEDULER_LIMIT_INVALID");
    expect(() => f.make({ limit: 1.5 })).toThrow("WORKTREE_SCHEDULER_LIMIT_INVALID");
    const scheduler = f.make({ methods: ["worktree.resume"] });
    const create = f.seed(), resume = f.seed({ kind: "worktree.resume" });
    expect(scheduler.scan()).toBe(1);
    await flush();
    expect(f.calls).toEqual([resume.id]);
    expect(f.execution.get(create.id)?.state).toBe("pending");
  });

  it("fences late wake and scan at seal and drains only running dispatches", async () => {
    const f = fixture(), scheduler = f.make({ limit: 1 });
    const running = f.seed(), left = f.seed();
    const gate = f.gate(running.id);
    expect(scheduler.scan()).toBe(2);
    expect(scheduler.active).toBe(1); expect(scheduler.queued).toBe(1);
    scheduler.seal(); scheduler.seal();
    expect(scheduler.isSealed).toBe(true); expect(scheduler.queued).toBe(0);
    scheduler.accepted(left);
    expect(scheduler.scan()).toBe(0);
    expect(await scheduler.drain(10)).toBe(false);
    gate.resolve();
    expect(await scheduler.drain(100)).toBe(true);
    expect(f.calls).toEqual([running.id]);
    expect(f.execution.get(running.id)?.state).toBe("settled");
    expect(f.execution.get(left.id)?.state).toBe("pending");
  });

  it("keeps the durable pending row and frees the permit when dispatch fails", async () => {
    const f = fixture(), scheduler = f.make({ limit: 1 });
    const failing = f.seed(), next = f.seed(), failure = new Error("WORKTREE_DISPATCH_BUSY");
    f.fail(failing.id, failure);
    expect(scheduler.scan()).toBe(2);
    expect(await scheduler.drain(100)).toBe(true);
    expect(f.calls).toEqual([failing.id, next.id]);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toMatchObject({ intent: { id: failing.id }, error: failure });
    expect(f.execution.get(failing.id)?.state).toBe("pending");
    expect(f.execution.get(failing.id)?.resultCode).toBeUndefined();
    expect(f.store.getCommandReceipt(failing.authSubjectId, failing.commandId)?.state).toBe("accepted");
    expect(f.execution.get(next.id)?.state).toBe("settled");
  });

  it("keeps the permit moving when the failure observer itself throws", async () => {
    const f = fixture(), scheduler = f.make({ limit: 1 });
    const failing = f.seed(), next = f.seed();
    f.fail(failing.id, new Error("boom"));
    f.observe(() => { throw new Error("observer fault"); });
    scheduler.accepted(failing); scheduler.accepted(next);
    expect(await scheduler.drain(100)).toBe(true);
    expect(f.calls).toEqual([failing.id, next.id]);
    expect(f.execution.get(next.id)?.state).toBe("settled");
  });
});
