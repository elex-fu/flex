import { describe, expect, it, vi } from "vitest";
import { RuntimeRegistry } from "./runtime-registry.js";
import { dispatchContextForTurn, fenceAdapterEvent } from "./types.js";
import type { ProviderAdapter, TurnOutcome } from "./types.js";

const context = dispatchContextForTurn("turn", { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt" });
function adapter(outcome: TurnOutcome): ProviderAdapter { return { provider: "claude", workspace: "/tmp/test", status: async () => { throw new Error("not called"); }, preflight: async () => { throw new Error("not called"); }, runTurn: async () => outcome,
  interrupt: async () => "accepted", respondApproval: vi.fn(() => true) }; }

describe("runtime evidence and ownership", () => {
  it.each(["completed", "failed", "cancelled"] as const)("does not treat an unproven %s return as a native terminal", async (status) => {
    const registry = new RuntimeRegistry(); registry.register("runtime", adapter(status === "completed" ? { status, providerSessionId: "native" } : status === "failed" ? { status, error: "stream lost" } : { status }));
    const outcome = await registry.begin(context, { prompt: "actual" }).outcome;
    expect(outcome).toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } }); registry.finish(context, outcome); expect(registry.isBusy("runtime")).toBe(true);
  });
  it("accepts explicit not-dispatched proof and then releases only that runtime binding", async () => {
    const registry = new RuntimeRegistry(); registry.register("runtime", adapter({ status: "failed", error: "prepare", evidence: { kind: "not-dispatched" } }));
    const outcome = await registry.begin(context, { prompt: "actual" }).outcome; expect(outcome.evidence.kind).toBe("not-dispatched"); registry.finish(context, outcome); expect(registry.isBusy("runtime")).toBe(false);
  });
  it("ignores late ACKs and terminal observations with a different attempt", async () => {
    let settle!: (outcome: TurnOutcome) => void;
    const driver = adapter({ status: "failed", error: "unused" }); driver.runTurn = () => new Promise((resolve) => { settle = resolve; });
    const registry = new RuntimeRegistry(); registry.register("runtime", driver); const run = registry.begin(context, { prompt: "actual" });
    registry.observe(fenceAdapterEvent({ ...context, attemptId: "old-attempt" }, { kind: "turn_completed", result: "late", costUsd: 0, numTurns: 1 }));
    settle({ status: "completed", providerSessionId: "native" }); expect((await run.outcome).status).toBe("outcome_unknown");
  });
  it("clears an unknown binding only through explicit verified recovery for its original context", async () => {
    const registry = new RuntimeRegistry(); registry.register("runtime", adapter({ status: "outcome_unknown", error: "possible send" }));
    const run = registry.begin(context, { prompt: "actual" }); registry.finish(context, await run.outcome);
    const verified = { status: "completed" as const, providerSessionId: "native", evidence: { kind: "native-terminal" as const, sourceId: "recovery-native-result" } };
    registry.finish(context, verified); expect(registry.isBusy("runtime")).toBe(true);
    expect(() => registry.reconcileVerified({ ...context, attemptId: "wrong-attempt" }, verified)).toThrow("RUNTIME_RECOVERY_CONTEXT_MISMATCH");
    expect(() => registry.reconcileVerified(context, { status: "outcome_unknown", error: "unverified", evidence: { kind: "unknown", reason: "unverified" } })).toThrow("RUNTIME_RECOVERY_EVIDENCE_REQUIRED");
    registry.reconcileVerified(context, verified); expect(registry.isBusy("runtime")).toBe(false);
  });
  it("keeps a known business outcome separate from an independently retained execution binding", async () => {
    const known = { status: "completed" as const, providerSessionId: "native", evidence: { kind: "native-terminal" as const, sourceId: "native-result" } };
    const registry = new RuntimeRegistry(); registry.register("runtime", adapter(known)); registry.begin(context, { prompt: "actual" });
    registry.retainBinding(context); expect(registry.classify(context, known).status).toBe("completed");
    registry.finish(context, known); expect(registry.isBusy("runtime")).toBe(true); expect(registry.matches(context)).toBe(true);
    registry.reconcileVerified(context, known); expect(registry.isBusy("runtime")).toBe(false);
  });
  it("does not let a recovered old outcome reject the next attempt's ACK or retain its binding", async () => {
    const settlements: Array<(outcome: TurnOutcome) => void> = [];
    const driver: ProviderAdapter = { ...adapter({ status: "failed", error: "unused" }), provider: "codex" };
    driver.runTurn = () => new Promise((resolve) => { settlements.push(resolve); });
    const registry = new RuntimeRegistry(); registry.register("runtime", driver);
    const oldRun = registry.begin(context, { prompt: "old" }); void oldRun.accepted?.catch(() => undefined);
    registry.retainUnknown(context);
    const known = { status: "completed" as const, providerSessionId: "native", evidence: { kind: "native-terminal" as const, sourceId: "verified-result" } };
    registry.reconcileVerified(context, known);
    const next = dispatchContextForTurn("next-turn", { ...context, flyxTurnId: "next-turn", attemptId: "next-attempt", runtimeGeneration: 2 });
    const nextRun = registry.begin(next, { prompt: "next" });
    const nextAccepted = expect(nextRun.accepted).resolves.toMatchObject({ nativeSessionId: "next-native-session", nativeTurnId: "next-native-turn" });
    settlements[0]!(known);
    expect(await oldRun.outcome).toMatchObject({ status: "outcome_unknown", error: "RUNTIME_CONTEXT_CHANGED" });
    registry.retainBinding(context); registry.retainUnknown(context);
    registry.observe(fenceAdapterEvent(next, { kind: "native_binding", nativeSessionId: "next-native-session", nativeTurnId: "next-native-turn" }));
    await nextAccepted;
    settlements[1]!(known);
    const nextOutcome = await nextRun.outcome; expect(nextOutcome.status).toBe("completed");
    registry.finish(next, nextOutcome); expect(registry.isBusy("runtime")).toBe(false);
  });
  it("records an actual terminal event and keeps boolean approval delivery at local evidence", async () => {
    let settle!: (outcome: TurnOutcome) => void;
    const driver = adapter({ status: "failed", error: "unused" }); driver.runTurn = () => new Promise((resolve) => { settle = resolve; });
    const registry = new RuntimeRegistry(); registry.register("runtime", driver); const run = registry.begin(context, { prompt: "actual" });
    expect(await registry.control(context, { kind: "respond_approval", approvalId: "approval", action: "allow_once" })).toEqual({ status: "delivered", evidence: { kind: "local-delivery" } });
    registry.observe(fenceAdapterEvent(context, { kind: "turn_completed", result: "actual terminal", costUsd: 0, numTurns: 1 }));
    settle({ status: "completed", providerSessionId: "native" }); expect((await run.outcome).evidence.kind).toBe("native-terminal");
  });
});
