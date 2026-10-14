import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./db.js";
import { RecoveryStore } from "./recovery-store.js";
import { RecoveryService } from "../session/recovery-service.js";
import type { DispatchContext } from "../provider/types.js";

const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(provider: "claude" | "codex" = "codex") {
  const store = new SqliteStore(); stores.push(store);
  const session = store.createSession("/fixture", provider);
  store.acceptTurn({ authSubjectId: "device", sessionId: session.id, turnId: "turn", commandId: "command", requestHash: "hash", prompt: "x", generation: 1, attemptId: "attempt" });
  const context: DispatchContext = { hostOwnerId: "owner", hostOwnerGeneration: 3, sessionId: session.id, flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt" };
  const recovery = new RecoveryStore(store);
  const binding = { context, provider, providerInstanceId: "instance", nativeSessionId: "native-session", workspacePath: "/fixture", configurationFingerprint: "policy-fingerprint", verifiedVersion: "fixture-v1" };
  return { store, session, context, recovery, binding };
}

describe("durable original native identity", () => {
  it("persists native session immediately, then adds one native Turn without manufacturing a new handle", () => {
    const f = fixture();
    const sessionHandle = f.recovery.recordNativeBinding(f.binding);
    expect(sessionHandle.nativeTurnId).toBeUndefined();
    expect(f.store.getTurn("turn")?.providerSessionId).toBe("native-session");
    const revision = f.store.getSession(f.session.id)!.recoveryRevision;
    expect(f.recovery.recordNativeBinding(f.binding)).toEqual(sessionHandle);
    expect(f.store.getSession(f.session.id)!.recoveryRevision).toBe(revision);
    const turnHandle = f.recovery.recordNativeBinding({ ...f.binding, nativeTurnId: "native-turn" });
    expect(turnHandle).toMatchObject({ id: sessionHandle.id, nativeTurnId: "native-turn", revision: 1 });
    expect(f.store.getTurn("turn")?.nativeTurnId).toBe("native-turn");
    expect(f.recovery.target(f.session.id, "turn", "attempt").nativeHandle?.id).toBe(sessionHandle.id);
  });
  it.each(["attempt", "generation", "owner", "workspace", "policy", "native-session", "native-turn"])("rejects %s binding replacement without changing durable facts", (part) => {
    const f = fixture();
    f.recovery.recordNativeBinding({ ...f.binding, nativeTurnId: "native-turn" });
    const before = f.recovery.target(f.session.id, "turn", "attempt");
    const changed = { ...f.binding, context: { ...f.context }, nativeTurnId: "native-turn" };
    if (part === "attempt") changed.context.attemptId = "other-attempt";
    if (part === "generation") changed.context.runtimeGeneration = 2;
    if (part === "owner") changed.context.hostOwnerId = "other-owner";
    if (part === "workspace") changed.workspacePath = "/outside";
    if (part === "policy") changed.configurationFingerprint = "different-policy";
    if (part === "native-session") changed.nativeSessionId = "different-native-session";
    if (part === "native-turn") changed.nativeTurnId = "different-native-turn";
    expect(() => f.recovery.recordNativeBinding(changed)).toThrow();
    expect(f.recovery.target(f.session.id, "turn", "attempt")).toEqual(before);
  });
  it("keeps a Claude native session binding without an invented native Turn or transcript terminal proof", async () => {
    const f = fixture("claude");
    f.recovery.recordNativeBinding(f.binding);
    f.store.commitEvent(f.session.id, "turn.unknown", {}, { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    const service = new RecoveryService({ store: f.store, inspectNative: async () => ({ state: "terminal", nativeSessionId: "native-session", nativeTurnId: "invented-turn", status: "completed",
      evidence: { kind: "native-terminal", sourceId: "transcript-last-message", verifiedVersion: "fixture-v1" } }) });
    expect((await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" })).nativeState).toBe("unknown");
    expect(f.recovery.nativeHandle("turn", "attempt")?.nativeTurnId).toBeUndefined();
  });
  it("uses the R06 durable dispatch context before native initialization and keeps the spawn window blocked", async () => {
    const f = fixture();
    const columns = f.store.db.prepare("PRAGMA table_info(execution_intents)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "dispatch_context_json")) f.store.db.exec("ALTER TABLE execution_intents ADD COLUMN dispatch_context_json TEXT");
    f.store.db.prepare("UPDATE execution_intents SET dispatch_context_json = ? WHERE turn_id = 'turn' AND kind = 'start_turn'").run(JSON.stringify(f.context));
    f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,tree_control,state,updated_at)
      VALUES('launching','owner',3,'runtime',1,'attempt',?,'turn','process_group','launching','2026-10-15')`).run(f.session.id);
    f.store.commitEvent(f.session.id, "turn.unknown", {}, { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    expect(f.recovery.target(f.session.id, "turn", "attempt").context).toEqual(f.context);
    const service = new RecoveryService({ store: f.store });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" });
    expect(evidence).toMatchObject({ processState: "unknown", nativeState: "unknown" });
    expect(evidence.nextSteps).not.toContain("acknowledge");
    f.store.db.prepare("UPDATE managed_processes SET state = 'stopped' WHERE id = 'launching'").run();
    const stopped = await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" });
    expect(stopped).toMatchObject({ processState: "stopped", workspaceState: "unknown" });
    expect(stopped.nextSteps).not.toContain("acknowledge");
  });
  it("can reconcile a fenced live SDK terminal result without inventing a Claude native Turn ID", async () => {
    const f = fixture("claude");
    f.recovery.recordNativeBinding(f.binding);
    f.store.commitEvent(f.session.id, "turn.unknown", {}, { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    const service = new RecoveryService({ store: f.store, inspectNative: async () => ({ state: "terminal", nativeSessionId: "native-session", status: "completed",
      evidence: { kind: "native-terminal", sourceId: "fenced-sdk-result", verifiedVersion: "fixture-v1", dispatchContext: f.context } }) });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" });
    expect(evidence.nativeState).toBe("terminal");
    await expect(service.reconcile({ authSubjectId: "device", commandId: "recovery", sessionId: f.session.id, turnId: "turn", attemptId: "attempt",
      evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision })).resolves.toMatchObject({ turnStatus: "completed", gate: "blocked" });
    expect(f.recovery.nativeHandle("turn", "attempt")?.nativeTurnId).toBeUndefined();
    expect(f.store.getTurn("turn")?.nativeTurnId).toBeUndefined();
  });

  it("keeps the original native identity immutable across asynchronous inspection callbacks", async () => {
    const f = fixture();
    f.recovery.recordNativeBinding({ ...f.binding, nativeTurnId: "native-turn" });
    f.store.commitEvent(f.session.id, "turn.unknown", {}, { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    const service = new RecoveryService({ store: f.store, inspectNative: async (handle) => {
      (handle as { nativeTurnId?: string }).nativeTurnId = "latest-unrelated-turn";
      return { state: "terminal", nativeSessionId: "native-session", nativeTurnId: "latest-unrelated-turn", status: "completed",
        evidence: { kind: "native-terminal", sourceId: "wrong-result", verifiedVersion: "fixture-v1" } };
    } });
    expect((await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" })).nativeState).toBe("unknown");
    expect(f.recovery.nativeHandle("turn", "attempt")?.nativeTurnId).toBe("native-turn");
    expect(f.store.getTurn("turn")?.status).toBe("outcome_unknown");
  });

});
