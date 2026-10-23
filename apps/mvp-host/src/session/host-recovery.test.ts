import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../codex/app-server-client.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "../lifecycle/managed-stop-contract.js";
import { MANAGED_PROCESS_IDENTITY_SCHEMA } from "../lifecycle/managed-process-registry.js";
import type { ProcessIdentity, ProcessInspector } from "../lifecycle/process-inspector.js";
import { fenceAdapterEvent, type DispatchContext, type ProviderId } from "../provider/types.js";
import { SqliteStore } from "../storage/db.js";
import { digest } from "../storage/recovery-store.js";
import { CommandEngine } from "../orchestration/command-engine.js";
import { decideAcceptTurn } from "../orchestration/decider.js";
import { RecoveryService } from "./recovery-service.js";
import { HostRecovery, type HostRecoveryOptions } from "./host-recovery.js";

const stores: SqliteStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const identity: ProcessIdentity = { pid: 123, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "42" } };
const inspector: ProcessInspector = { currentIdentity: () => identity, inspect: () => ({ state: "exited", reason: "verified original exited" }) };
function fixture(provider: ProviderId = "codex", extra: Partial<HostRecoveryOptions> = {}) {
  const owner = createTestHostOwner();
  const store = new SqliteStore(); stores.push(store);
  const workspace = "/original-checkout";
  const session = store.createSession(workspace, provider);
  const accepted = store.acceptTurn({ authSubjectId: "original-device", sessionId: session.id, turnId: "original-turn", commandId: "start", requestHash: "original-hash", prompt: "original prompt", generation: 1, attemptId: "original-attempt" });
  const context: DispatchContext = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: session.id,
    flyxTurnId: accepted.turn.id, runtimeId: "original-runtime", runtimeGeneration: 1, attemptId: "original-attempt" };
  const client = { request: vi.fn(async () => ({ thread: { id: "native-session", turns: [{ id: "native-turn", status: "completed" }, { id: "latest-other", status: "failed" }] } })) };
  const recovery = new HostRecovery({ store, owner, sessionId: session.id, workspace, provider,
    resolveResource: () => ({ provider, providerInstanceId: "provider-instance", workspacePath: workspace, configurationFingerprint: "configured-policy", verifiedVersions: ["verified-v1"], readerVersion: "verified-v1" }),
    codexReader: () => client as unknown as Pick<AppServerClient, "request">, assertCommandAuthorized: () => {}, ...extra });
  const init = fenceAdapterEvent(context, { kind: "session_init", provider, providerSessionId: "native-session", runtimeVersion: "verified-v1", model: "test", tools: [] });
  recovery.recordNativeEvent(init);
  if (provider === "codex") recovery.recordNativeEvent(fenceAdapterEvent(context, { kind: "native_binding", nativeSessionId: "native-session", nativeTurnId: "native-turn" }));
  const unknown = () => store.commitEvent(session.id, "turn.unknown", { turnId: context.flyxTurnId }, { turnId: context.flyxTurnId, turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
  const input = async (commandId = "recover") => {
    const evidence = await recovery.inspect({ sessionId: session.id, turnId: context.flyxTurnId, attemptId: context.attemptId });
    return { authSubjectId: "recovery-device", commandId, sessionId: session.id, turnId: context.flyxTurnId, attemptId: context.attemptId, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision };
  };
  const process = (state = "root_exited") => {
    store.db.exec(MANAGED_PROCESS_IDENTITY_SCHEMA);
    store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
      VALUES('original-process',?,?,?,?,?,?,?,123,123,'process_group',?,'now')`)
      .run(owner.ownerId, owner.generation, context.runtimeId, 1, context.attemptId, session.id, context.flyxTurnId, state);
    store.db.prepare("INSERT INTO managed_process_identities(process_id,identity_json) VALUES('original-process',?)").run(JSON.stringify(identity));
  };
  return { store, owner, session, context, recovery, init, client, input, process, unknown };
}

describe("production Host recovery factory", () => {
  it("releases a bound ordinary macOS stop without upgrading its guarantee, and rejects a changed launch", async () => {
    const f = fixture("codex", { inspectWorkspace: async () => "clear" }); f.process("stopped"); f.unknown();
    const original = { pid: 123, platform: "darwin" as const };
    f.store.db.prepare("UPDATE managed_process_identities SET identity_json=?").run(JSON.stringify(original));
    f.store.db.prepare("INSERT INTO managed_process_boundaries(process_id,proof_json,launch_digest) VALUES('original-process',?,?)")
      .run(JSON.stringify({ platform: "darwin", managedStopContractId: MACOS_MANAGED_STOP_CONTRACT }), "a".repeat(64));
    const stop = { kind: "managed-group-stop", version: 1, contractId: MACOS_MANAGED_STOP_CONTRACT, sourceId: "original-process:managed-group-stop/v1",
      identityDigest: processIdentityDigest(original), launchDigest: "a".repeat(64), processGroup: 123, rootExitObserved: true, groupAbsent: true, observedAt: new Date().toISOString() };
    f.store.db.prepare("INSERT INTO managed_process_stop_proofs(process_id,proof_json) VALUES('original-process',?)").run(JSON.stringify(stop));
    const view = await f.recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" });
    expect(view).toMatchObject({ processState: "stopped", processStopScope: "managed_process_group", workspaceState: "clear", nativeState: "terminal" });
    const result = await f.recovery.reconcile(await f.input());
    expect(result.gate).toBe("released"); expect(result.turnStatus).toBe("completed");
    f.store.db.prepare("UPDATE managed_process_boundaries SET launch_digest=?").run("b".repeat(64));
    expect((await f.recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" })).processState).toBe("unknown");
  });
  it("persists exact fenced native handles and rejects a late original binding after activity changed", () => {
    const f = fixture();
    expect(f.recovery.recovery.nativeHandle("original-turn", "original-attempt")).toMatchObject({ nativeSessionId: "native-session", nativeTurnId: "native-turn", context: f.context, verifiedVersion: "verified-v1", configurationFingerprint: "configured-policy" });
    f.store.db.prepare("UPDATE sessions SET active_turn_id=NULL WHERE id=?").run(f.session.id);
    const before = f.recovery.recovery.nativeHandle("original-turn", "original-attempt");
    expect(() => f.recovery.recordNativeEvent(fenceAdapterEvent(f.context, { kind: "native_binding", nativeSessionId: "latest-session", nativeTurnId: "latest-turn" }))).toThrow("RECOVERY_CONTEXT_MISMATCH");
    expect(f.recovery.recovery.nativeHandle("original-turn", "original-attempt")).toEqual(before);
  });

  it("does not promote a runtime version probe into verified native recovery", async () => {
    const f = fixture("codex", { resolveResource: () => ({ provider: "codex", providerInstanceId: "instance", workspacePath: "/original-checkout", configurationFingerprint: "policy", verifiedVersions: [], readerVersion: "verified-v1" }) });
    f.unknown();
    const evidence = await f.recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" });
    expect(evidence.nativeState).toBe("unknown");
    expect(f.recovery.recovery.nativeHandle("original-turn", "original-attempt")?.verifiedVersion).toBe("unknown");
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it("recovers the original native Turn while process-unproved completion retains durable activity and admission", async () => {
    const onBlocked = vi.fn(); const runtime = vi.fn();
    const f = fixture("codex", { onBlocked, reconcileRuntime: runtime }); f.unknown();
    const result = await f.recovery.reconcile(await f.input());
    expect(result).toMatchObject({ state: "completed", turnStatus: "completed", gate: "blocked" });
    expect(f.client.request).toHaveBeenCalledWith("thread/read", { threadId: "native-session", includeTurns: true }, 15000);
    expect(f.store.getSession(f.session.id)).toMatchObject({ activeTurnId: "original-turn", recoveryState: "blocked", activityState: "outcome_unknown" });
    expect(f.store.getCommandReceipt("original-device", "start")?.state).toBe("completed");
    expect(() => f.recovery.assertAdmission()).toThrow("RECOVERY_BLOCKED");
    expect(onBlocked).toHaveBeenCalledWith(f.context, "producer_stop_unverified");
    expect(runtime).not.toHaveBeenCalled();
  });

  it("protects a live terminal transaction before active association can be cleared", () => {
    const f = fixture();
    f.store.db.transaction(() => {
      expect(f.recovery.protectTerminal(f.context)).toBe(true);
      f.store.commitEvent(f.session.id, "turn.completed", {}, { turnId: "original-turn", turnStatus: "completed", activityState: "outcome_unknown" });
    })();
    expect(f.store.getTurn("original-turn")?.status).toBe("completed");
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("original-turn");
    expect(() => f.recovery.assertAdmission()).toThrow("RECOVERY_BLOCKED");
  });

  it("uses an original captured SDK result, never a transcript ending or invented Claude native Turn ID", async () => {
    const f = fixture("claude");
    f.store.db.transaction(() => {
      f.recovery.protectTerminal(f.context);
      f.store.commitEvent(f.session.id, "turn.completed", fenceAdapterEvent(f.context, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }), { turnId: "original-turn", turnStatus: "completed", activityState: "outcome_unknown" });
    })();
    const evidence = await f.recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" });
    expect(evidence).toMatchObject({ nativeState: "terminal", nativeOutcome: "completed", processState: "unknown" });
    expect(f.recovery.recovery.nativeHandle("original-turn", "original-attempt")?.nativeTurnId).toBeUndefined();
    const transcript = fixture("claude"); transcript.unknown();
    transcript.store.commitEvent(transcript.session.id, "assistant.message.completed", { turnId: "original-turn", text: "Done" });
    expect((await transcript.recovery.inspect({ sessionId: transcript.session.id, turnId: "original-turn" })).nativeState).toBe("unknown");
  });

  it("keeps recorded stopped/root-exited processes unknown without birth and verified descendant boundaries", async () => {
    const f = fixture("claude", { processInspector: inspector }); f.process("stopped"); f.unknown();
    expect((await f.recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" })).processState).toBe("unknown");
    f.store.db.prepare("UPDATE managed_process_identities SET identity_json=?").run(JSON.stringify({ pid: 123, platform: "darwin" }));
    expect((await f.recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" })).processState).toBe("unknown");
  });

  it("permits explicit unknown acknowledgement only with exact birth/tree/workspace proof and preserves unknown history", async () => {
    const boundary = vi.fn(async (_record, original) => ({ state: "stopped" as const, sourceId: "verified-boundary-source", contractId: "verified-container", identityDigest: processIdentityDigest(original) }));
    const stoppedRuntime = vi.fn((original, proof) => {
      expect(f.store.db.inTransaction).toBe(false);
      expect(f.store.getSession(f.session.id)?.recoveryState).toBe("idle");
      expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
      expect(original).toEqual(f.context); expect(proof.kind).toBe("execution-stopped");
    });
    const f = fixture("claude", { processInspector: inspector, inspectBoundary: boundary, inspectWorkspace: async () => "clear", reconcileStoppedRuntime: stoppedRuntime }); f.process(); f.unknown();
    const input = await f.input();
    const result = await f.recovery.acknowledge({ ...input, acknowledgeUnknown: true });
    expect(result.gate).toBe("released");
    expect(stoppedRuntime).toHaveBeenCalledExactlyOnceWith(f.context, expect.objectContaining({ kind: "execution-stopped", evidenceId: input.evidenceId, operationId: result.operationId }));
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.getActiveTurn(f.session.id)).toBeUndefined();
    f.recovery.assertAdmission();
    const proof = f.recovery.recovery.releaseProof(input.evidenceId, ["workspace:/original-checkout"])!;
    expect(f.recovery.recovery.verifyReleaseProof(proof, { resourceKey: "workspace:/original-checkout", ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, purpose: "workspace:original-turn" })).toBe(true);
    f.store.db.prepare("UPDATE managed_processes SET updated_at='changed' WHERE id='original-process'").run();
    expect(f.recovery.recovery.verifyReleaseProof(proof, { resourceKey: "workspace:/original-checkout", ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, purpose: "workspace:original-turn" })).toBe(false);
  });
  it("reloads original immutable native boundary/birth facts and rejects stale launch metadata before gate release", async () => {
    const f = fixture("claude", { processInspector: inspector, inspectWorkspace: async () => "clear" }); f.process(); f.unknown();
    const proof = { version: 1, boundaryId: "12345678-1234-1234-1234-123456789abc", platform: "linux", backend: "linux_bubblewrap", kernelRelease: "fixture", backendVersion: "fixture", backendDigest: "a".repeat(64), policyDigest: "b".repeat(64), evidenceDigest: "c".repeat(64), verifiedPrivateReadBoundary: true, verifiedPrivateWriteBoundary: true, verifiedChildInheritance: true, treeIsolation: "linux_pid_namespace", verifiedDescendantStop: true };
    f.store.db.prepare("INSERT INTO managed_process_boundaries(process_id,proof_json,launch_digest) VALUES('original-process',?,?)").run(JSON.stringify(proof), "d".repeat(64));
    const input = await f.input();
    expect(f.recovery.recovery.evidence(input.evidenceId)?.execution.state).toBe("stopped");
    f.store.db.prepare("UPDATE managed_process_boundaries SET launch_digest=? WHERE process_id='original-process'").run("e".repeat(64));
    await expect(f.recovery.acknowledge({ ...input, acknowledgeUnknown: true })).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
    expect(f.store.getSession(f.session.id)?.recoveryState).toBe("blocked");
  });

  it("rechecks the recovery actor after asynchronous native inspection and leaves the original result untouched on revocation", async () => {
    const f = fixture(); f.unknown();
    f.store.createDevice({ id: "recoverer", hostId: "host", platform: "test", credentialKind: "browser-session", scopes: ["session:read", "session:write"], credentialRevision: 0, createdAt: new Date().toISOString() });
    let waiting = false; let release!: () => void;
    const barrier = new Promise<void>((yes) => { release = yes; });
    const reader: Pick<AppServerClient, "request"> = { request: async <T>(): Promise<T> => { if (waiting) await barrier; return { thread: { id: "native-session", turns: [{ id: "native-turn", status: "completed" }] } } as T; } };
    const recovery = new HostRecovery({ store: f.store, owner: f.owner, sessionId: f.session.id, workspace: "/original-checkout", provider: "codex",
      resolveResource: () => ({ provider: "codex", providerInstanceId: "provider-instance", workspacePath: "/original-checkout", configurationFingerprint: "configured-policy", verifiedVersions: ["verified-v1"], readerVersion: "verified-v1" }), codexReader: () => reader });
    const evidence = await recovery.inspect({ sessionId: f.session.id, turnId: "original-turn" }); const originalReceipt = f.store.getCommandReceipt("original-device", "start");
    waiting = true;
    const pending = recovery.reconcile({ authSubjectId: "recoverer", commandId: "revoked-recovery", sessionId: f.session.id, turnId: "original-turn", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    await new Promise<void>((yes) => setImmediate(yes));
    expect(f.store.getCommandReceipt("recoverer", "revoked-recovery")?.state).toBe("accepted");
    f.store.db.prepare("UPDATE devices SET revoked_at='revoked' WHERE id='recoverer'").run(); release();
    await expect(pending).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("original-device", "start")).toEqual(originalReceipt);
    expect(f.store.getSession(f.session.id)?.recoveryState).toBe("blocked");
  });

  it("commits interaction companion events atomically and does not claim approval delivery from a native terminal", async () => {
    const f = fixture(); f.unknown();
    f.store.commitCommand({ sessionId: f.session.id, build: () => ({ result: undefined,
      events: [{ type: "approval.response.unknown", payload: { turnId: "original-turn", approvalId: "approval" } }],
      receipts: [{ authSubjectId: "original-device", commandId: "approve", method: "approval.respond", requestHash: "approve-hash", targetSessionId: f.session.id, requestFormatVersion: 2, state: "outcome_unknown", response: { deliveryState: "unconfirmed" } }],
      intents: [{ id: "approval-intent", sessionId: f.session.id, turnId: "original-turn", authSubjectId: "original-device", commandId: "approve", ordinal: 0, actorKind: "device", kind: "respond_approval", resourceId: "approval", payload: {}, requestHash: "approve-hash", requestFormatVersion: 2, runtimeGeneration: 1, attemptId: "original-attempt" }] }) });
    f.store.db.prepare("UPDATE execution_intents SET state='outcome_unknown' WHERE id='approval-intent'").run();
    const companion = vi.fn(() => [{ type: "interaction.superseded", payload: { turnId: "original-turn", deliveryState: "unconfirmed" } }]);
    const service = new RecoveryService({ store: f.store, inspectNative: async () => ({ state: "terminal", nativeSessionId: "native-session", nativeTurnId: "native-turn", status: "completed", evidence: { kind: "native-terminal", sourceId: "original-native-source", verifiedVersion: "verified-v1" } }), companionEvents: companion });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: "original-turn" });
    const input = { authSubjectId: "recoverer", commandId: "with-companions", sessionId: f.session.id, turnId: "original-turn", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision };
    f.store.db.exec("CREATE TRIGGER recovery_companion_fault BEFORE INSERT ON session_events WHEN NEW.type='turn.recovery.reconciled' BEGIN SELECT RAISE(ABORT,'companion settlement fault'); END");
    await expect(service.reconcile(input)).rejects.toThrow("companion settlement fault");
    expect(f.store.listEvents(f.session.id).events.filter((event) => event.type === "interaction.superseded")).toEqual([]);
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    f.store.db.exec("DROP TRIGGER recovery_companion_fault");
    await service.reconcile(input);
    const events = f.store.listEvents(f.session.id).events.slice(-2);
    expect(events.map((event) => event.type)).toEqual(["interaction.superseded", "turn.recovery.reconciled"]);
    expect(companion).toHaveBeenCalledWith(f.session.id, "original-turn", "recovery_reconciled");
    expect(f.store.getCommandReceipt("original-device", "approve")).toMatchObject({ state: "outcome_unknown", response: { deliveryState: "unconfirmed" } });
    expect(f.store.db.prepare("SELECT state FROM execution_intents WHERE id='approval-intent'").get()).toEqual({ state: "outcome_unknown" });
  });

  it("returns an old settled recovery command without retargeting current activity or ownership callbacks", async () => {
    const afterRecovery = vi.fn();
    const f = fixture("claude", { processInspector: inspector, inspectBoundary: async (_record, original) => ({ state: "stopped", sourceId: "tree", contractId: "container", identityDigest: processIdentityDigest(original) }), inspectWorkspace: async () => "clear", afterRecovery });
    f.process(); f.unknown(); const input = await f.input();
    const result = await f.recovery.acknowledge({ ...input, acknowledgeUnknown: true });
    f.store.acceptTurn({ authSubjectId: "original-device", sessionId: f.session.id, turnId: "new-turn", commandId: "new-start", requestHash: "new-hash", prompt: "new prompt", generation: 2, attemptId: "new-attempt" });
    expect(await f.recovery.acknowledge({ ...input, acknowledgeUnknown: true })).toEqual(result);
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("new-turn"); expect(afterRecovery).toHaveBeenCalledTimes(1);
  });
  it.each(["failed", "cancelled"] as const)("releases %s not-dispatched preparation only after exact committed Engine facts and independent stop proof", async (status) => {
    const owner = createTestHostOwner(); const store = new SqliteStore(); stores.push(store);
    const session = store.createSession("/preparation-checkout", "claude");
    const request = { authSubjectId: "original-actor", commandId: "never-dispatched-start", method: "session.startTurn", requestHash: "original-hash", requestFormatVersion: 2 as const,
      targetSessionId: session.id, actorKind: "host" as const, dispatchBinding: { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: "preparation-runtime" } };
    const accepted = new CommandEngine(store).commitRequest(request, (facts, clock) => decideAcceptTurn(facts, request, { prompt: "original prompt", turnId: "preparation-turn" }, clock));
    const context = accepted.intents[0]!.dispatchContext!;
    const runtime = vi.fn((_context, outcome) => { expect(store.db.inTransaction).toBe(false); expect(store.getSession(session.id)?.recoveryState).toBe("idle"); expect(outcome.state).toBe("not_dispatched"); });
    const recovery = new HostRecovery({ store, owner, sessionId: session.id, workspace: "/preparation-checkout", provider: "claude", assertCommandAuthorized: () => {}, inspectWorkspace: async () => "clear", reconcileRuntime: runtime });
    store.db.transaction(() => {
      recovery.protectTerminal(context);
      store.commitEvent(session.id, "turn.reconciled", { turnId: context.flyxTurnId, outcome: { status, evidence: { kind: "not-dispatched" } } }, { turnId: context.flyxTurnId, turnStatus: status, activityState: "outcome_unknown",
        commandReceipt: { authSubjectId: "original-actor", commandId: request.commandId, state: status, requestHash: "original-hash", required: true, response: { turnId: context.flyxTurnId, status, evidence: { kind: "not-dispatched" } } } });
    })();
    const finishedAt = store.getTurn(context.flyxTurnId)?.finishedAt;
    store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,tree_control,state,updated_at)
      VALUES('preparation-process',?,?,?,?,?,?,?,'unavailable','not_spawned','now')`).run(context.hostOwnerId, context.hostOwnerGeneration, context.runtimeId, context.runtimeGeneration, context.attemptId, session.id, context.flyxTurnId);
    const evidence = await recovery.inspect({ sessionId: session.id, turnId: context.flyxTurnId, attemptId: context.attemptId });
    expect(evidence).toMatchObject({ nativeState: "unknown", processState: "stopped", workspaceState: "clear", committedOutcome: { status, source: "not-dispatched" } }); expect(evidence.nextSteps).toContain("reconcile");
    const originalIntent = store.db.prepare("SELECT result_json FROM execution_intents WHERE id=?").get(accepted.intents[0]!.id) as { result_json: string };
    store.db.prepare("UPDATE execution_intents SET result_json=? WHERE id=?").run(JSON.stringify({ turnId: context.flyxTurnId, status, evidence: { kind: "unknown" } }), accepted.intents[0]!.id);
    await expect(recovery.reconcile({ authSubjectId: "recoverer", commandId: "reject-partial-proof", sessionId: session.id, turnId: context.flyxTurnId, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision })).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
    expect(runtime).not.toHaveBeenCalled(); expect(store.getSession(session.id)?.recoveryState).toBe("blocked");
    store.db.prepare("UPDATE execution_intents SET result_json=? WHERE id=?").run(originalIntent.result_json, accepted.intents[0]!.id);
    const result = await recovery.reconcile({ authSubjectId: "recoverer", commandId: "release-preparation", sessionId: session.id, turnId: context.flyxTurnId, attemptId: context.attemptId, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    expect(result).toMatchObject({ gate: "released", turnStatus: status }); expect(store.getTurn(context.flyxTurnId)).toMatchObject({ status, finishedAt });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM native_turn_bindings").get()).toEqual({ n: 0 }); expect(runtime).toHaveBeenCalledExactlyOnceWith(context, expect.objectContaining({ state: "not_dispatched", status }));
    expect(store.getCommandReceipt("original-actor", request.commandId)).toMatchObject({ state: status, response: { evidence: { kind: "not-dispatched" }, executionStopped: true } });
  });
});
