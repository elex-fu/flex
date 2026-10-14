import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../codex/app-server-client.js";
import type { ProcessIdentity, ProcessInspector } from "../lifecycle/process-inspector.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import type { AdapterEventPayload, AdapterStatus, DispatchContext, ProviderAdapter, ProviderOutcome } from "../provider/types.js";
import { fenceAdapterEvent } from "../provider/types.js";
import { SessionOrchestrator } from "./orchestrator.js";

it.each(["completed", "outcome_unknown"] as const)("retires legacy pending approvals in the same committed terminal batch (%s)", async (status) => {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  let context!: DispatchContext; let finish!: (outcome: ProviderOutcome) => void;
  const outcome = new Promise<ProviderOutcome>((yes) => { finish = yes; });
  const adapter: ProviderAdapter = { provider: "claude", workspace,
    status: async () => { throw new Error("No Provider status call"); }, preflight: async () => { throw new Error("No paid preflight"); },
    runTurn: async (_id, _prompt, _resume, fixed) => { context = fixed!; return outcome; }, interrupt: async () => "unavailable", respondApproval: () => false };
  const host = new SessionOrchestrator({ workspace, adapter, canReleaseWorkspace: () => true });
  try {
    const accepted = await host.startTurn("fixture-actor", "legacy-start", "task"); await host.worker.drainDispatch();
    host.ingestAdapterEvent(fenceAdapterEvent(context, { kind: "approval_requested", request: { approvalId: "legacy-pending",
      turnId: accepted.turnId, toolUseId: "legacy-tool", toolName: "Bash", input: { command: "fixture" }, cwd: workspace,
      createdAt: new Date().toISOString() } }));
    await host.ingestion.drain(); expect(host.snapshot().pendingApprovals).toHaveLength(1);
    finish(status === "completed" ? { status, providerSessionId: "fixture-native", evidence: { kind: "native-terminal", sourceId: "fixture-result" } }
      : { status, error: "DISPATCH_OUTCOME_UNPROVEN", evidence: { kind: "unknown", reason: "DISPATCH_OUTCOME_UNPROVEN" } });
    await host.worker.drainOperations();
    expect(host.store.getApproval("legacy-pending")).toMatchObject({ status: "superseded", version: 1 });
    expect(host.snapshot().pendingApprovals).toEqual([]);
    expect(host.store.getTimelineItem(host.sessionId, "approval-legacy-pending")?.status).toBe("superseded");
    const rows = host.store.db.prepare("SELECT type,commit_id FROM session_events WHERE session_id=? AND type IN ('approval.superseded','turn.reconciled') ORDER BY sequence")
      .all(host.sessionId) as Array<{ type: string; commit_id: string }>;
    expect(rows.map((row) => row.type)).toEqual(["approval.superseded", "turn.reconciled"]);
    expect(rows[0]!.commit_id).toBe(rows[1]!.commit_id);
    expect(host.store.getCommandReceipt("fixture-actor", "legacy-start")?.state).toBe(status);
    if (status === "outcome_unknown") {
      expect(host.snapshot().session.recoveryState).toBe("blocked");
      await expect(host.respondApproval("fixture-actor", "late-answer", "legacy-pending", "allow_once")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
      expect(host.store.getCommandReceipt("fixture-actor", "late-answer")).toBeUndefined();
    }
  } finally {
    finish({ status: "outcome_unknown", error: "fixture cleanup", evidence: { kind: "unknown", reason: "fixture cleanup" } });
    await host.worker.drainOperations(); await host.closeAndWait();
  }
});

it("the actual Orchestrator ingests fenced native bindings before terminal and retains a visible gate for unproved descendants", async () => {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  let context: DispatchContext | undefined;
  let finish!: (outcome: ProviderOutcome) => void;
  const outcome = new Promise<ProviderOutcome>((yes) => { finish = yes; });
  const status: AdapterStatus = { provider: "codex", workspace, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "verified-test", sandboxRequired: true };
  const adapter: ProviderAdapter = { provider: "codex", workspace, status: async () => status, preflight: async () => { throw new Error("No real Provider call"); },
    runTurn: async (_turnId, _prompt, _resume, original) => { context = original; return outcome; }, interrupt: async () => "unavailable", respondApproval: () => false };
  const client: Pick<AppServerClient, "request"> = { request: async <T>(): Promise<T> => ({ thread: { id: "native-session", turns: [{ id: "native-original", status: "completed" }] } }) as T };
  const host = new SessionOrchestrator({ workspace, adapter, recovery: { resolveResource: () => ({ provider: "codex", providerInstanceId: "instance", workspacePath: workspace,
    configurationFingerprint: "exact-config", verifiedVersions: ["verified-test"], readerVersion: "verified-test" }), codexReader: () => client } });
  try {
    const accepted = await host.startTurn("device", "start-command", "original prompt");
    for (let step = 0; !context && step < 20; step++) await new Promise<void>((yes) => setImmediate(yes));
    if (!context) throw new Error("Original dispatch context missing");
    const emit = (payload: AdapterEventPayload) => host.ingestAdapterEvent(fenceAdapterEvent(context!, payload));
    emit({ kind: "session_init", provider: "codex", providerSessionId: "native-session", runtimeVersion: "verified-test", model: "fixture", tools: [] });
    emit({ kind: "native_binding", nativeSessionId: "native-session", nativeTurnId: "native-original" });
    await host.ingestion.drain();
    expect(host.recovery.recovery.nativeHandle(accepted.turnId, context.attemptId)).toMatchObject({ context, nativeTurnId: "native-original", configurationFingerprint: "exact-config", verifiedVersion: "verified-test" });
    expect(host.workspaceLease?.operationId).toBe(accepted.turnId);
    emit({ kind: "turn_completed", result: "original complete", costUsd: 0, numTurns: 1 });
    await host.ingestion.drain();
    finish({ status: "completed", providerSessionId: "native-session", evidence: { kind: "native-terminal", sourceId: "native-original" } });
    await host.worker.drainOperations();
    expect(host.snapshot().session).toMatchObject({ activeTurnId: accepted.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
    expect(host.store.getTurn(accepted.turnId)?.status).toBe("completed");
    expect(host.runtimes.matches(context)).toBe(true);
    expect(host.store.listEvents(host.sessionId).events).toContainEqual(expect.objectContaining({ type: "session.recovery.blocked", payload: expect.objectContaining({ turnId: accepted.turnId, attemptId: context.attemptId }) }));
    await expect(host.startTurn("device", "new-command", "new prompt")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    const completedTurn = host.store.getTurn(accepted.turnId);
    await expect(host.interrupt("device", "old-interrupt")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    await expect(host.respondApproval("device", "old-approval-response", "original-approval", "allow_once")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    expect(host.store.getTurn(accepted.turnId)).toEqual(completedTurn);
    expect(host.execution.forCommand("device", "old-interrupt")).toEqual([]);
    expect(host.execution.forCommand("device", "old-approval-response")).toEqual([]);

    const previous = host.recovery.recovery.nativeHandle(accepted.turnId, context.attemptId);
    emit({ kind: "native_binding", nativeSessionId: "late-other-session", nativeTurnId: "late-other-turn" });
    await host.ingestion.drain();
    expect(host.recovery.recovery.nativeHandle(accepted.turnId, context.attemptId)).toEqual(previous);
  } finally { finish({ status: "outcome_unknown", error: "test cleanup", evidence: { kind: "unknown", reason: "cleanup" } }); await host.worker.drainOperations(); host.close(); }
});

it("a failed after-terminal capture preserves the known result and durably restores original recovery blockage", async () => {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  let context: DispatchContext | undefined; let finish!: (outcome: ProviderOutcome) => void;
  const outcome = new Promise<ProviderOutcome>((yes) => { finish = yes; });
  const status: AdapterStatus = { provider: "claude", workspace, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", sandboxRequired: true };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => status,
    runTurn: async (_turnId, _prompt, _resume, original) => { context = original; return outcome; }, interrupt: async () => "unavailable", respondApproval: () => false };
  const host = new SessionOrchestrator({ workspace, adapter, canReleaseWorkspace: () => true,
    executionHooks: { afterTerminal: () => { throw new Error("CHECKPOINT_CAPTURE_FAILED"); } } });
  try {
    const accepted = await host.startTurn("device", "capture-start", "original prompt"); await host.worker.drainDispatch();
    if (!context) throw new Error("Original context missing");
    host.ingestAdapterEvent(fenceAdapterEvent(context, { kind: "turn_completed", result: "native done", costUsd: 0, numTurns: 1 })); await host.ingestion.drain();
    expect(host.store.getTurn(accepted.turnId)?.status).toBe("completed");
    finish({ status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "native-result" } }); await host.worker.drainOperations();
    expect(host.snapshot().session).toMatchObject({ activeTurnId: accepted.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
    expect(host.store.getTurn(accepted.turnId)?.status).toBe("completed"); expect(host.store.getCommandReceipt("device", "capture-start")?.state).toBe("completed");
    expect(host.runtimes.matches(context)).toBe(true); expect(host.workspaceLease).toBeDefined();
    await expect(host.startTurn("device", "later", "next prompt")).rejects.toThrow();
  } finally { finish({ status: "outcome_unknown", error: "cleanup", evidence: { kind: "unknown", reason: "cleanup" } }); await host.worker.drainOperations(); host.close(); }
});

it("late cleanup callbacks cannot restore an old gate after its runtime was released or a newer Turn ran", async () => {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const contexts: DispatchContext[] = [];
  const finishes: Array<(outcome: ProviderOutcome) => void> = [];
  const status: AdapterStatus = { provider: "claude", workspace, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", sandboxRequired: true };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => status,
    runTurn: async (_turnId, _prompt, _resume, context) => { if (!context) throw new Error("Original context required"); contexts.push(context); return new Promise<ProviderOutcome>((yes) => finishes.push(yes)); },
    interrupt: async () => "unavailable", respondApproval: () => false };
  const host = new SessionOrchestrator({ workspace, adapter, canReleaseWorkspace: () => true });
  const done: ProviderOutcome = { status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "captured-result" } };
  try {
    const first = await host.startTurn("device", "first", "first prompt"); await host.worker.drainDispatch();
    const original = host.execution.forCommand("device", "first")[0]!;
    const complete = async (index: number) => { host.ingestAdapterEvent(fenceAdapterEvent(contexts[index]!, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }));
      await host.ingestion.drain(); finishes[index]!(done); await host.worker.drainOperations(); };
    await complete(0);
    const releasedRevision = host.snapshot().session.recoveryRevision;
    host.markExecutionBlocked(original, "late_capture_failure");
    expect(host.snapshot().session).toMatchObject({ recoveryState: "idle", recoveryRevision: releasedRevision });
    expect(host.workspaceLease).toBeUndefined();
    const second = await host.startTurn("device", "second", "second prompt"); await host.worker.drainDispatch();
    host.markExecutionBlocked(original, "late_capture_failure");
    expect(host.snapshot().session).toMatchObject({ activeTurnId: second.turnId, recoveryState: "idle" });
    await complete(1);
    const laterRevision = host.snapshot().session.recoveryRevision;
    host.markExecutionBlocked(original, "late_capture_failure");
    expect(host.snapshot().session).toMatchObject({ recoveryState: "idle", recoveryRevision: laterRevision });
    expect(host.snapshot().session.activeTurnId).toBeUndefined();
    expect(host.store.getTurn(first.turnId)?.status).toBe("completed"); expect(host.store.getTurn(second.turnId)?.status).toBe("completed");
    expect(host.store.listEvents(host.sessionId).events.some((event) => event.type === "session.recovery.blocked")).toBe(false);
  } finally { finishes.forEach((finish) => finish(done)); await host.worker.drainOperations(); host.close(); }
});

it.each([false, true])("explicit stopped-execution acknowledgment permits a future Turn and preserves unknown history (release fault: %s)", async (releaseFault) => {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const identity: ProcessIdentity = { pid: 123, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "42" } };
  const inspector: ProcessInspector = { currentIdentity: () => identity, inspect: () => ({ state: "exited", reason: "original birth exited" }) };
  const contexts: DispatchContext[] = []; const finishes: Array<(outcome: ProviderOutcome) => void> = [];
  const status: AdapterStatus = { provider: "claude", workspace, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", sandboxRequired: true };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => status,
    runTurn: async (_turnId, _prompt, _resume, context) => { if (!context) throw new Error("Original context required"); contexts.push(context); return new Promise<ProviderOutcome>((yes) => finishes.push(yes)); },
    interrupt: async () => "unavailable", respondApproval: () => false };
  const host = new SessionOrchestrator({ workspace, adapter, canReleaseWorkspace: (context) => context.runtimeGeneration > 1,
    recovery: { processInspector: inspector, inspectWorkspace: async () => "clear",
      inspectBoundary: async (_record, original) => ({ state: "stopped", sourceId: "original-descendants-stopped", contractId: "verified-test-container", identityDigest: processIdentityDigest(original) }) } });
  const done: ProviderOutcome = { status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "captured-result" } };
  host.store.createDevice({ id: "device", hostId: "host", platform: "test", credentialKind: "browser-session", scopes: ["session:write"], credentialRevision: 0, createdAt: new Date().toISOString() });
  try {
    const first = await host.startTurn("device", "unknown-first", "possibly dispatched prompt"); await host.worker.drainDispatch();
    const original = contexts[0]!;
    finishes[0]!({ status: "outcome_unknown", error: "response lost after possible send", evidence: { kind: "unknown", reason: "response lost after possible send" } });
    await host.worker.drainOperations();
    host.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
      VALUES('original-process',?,?,?,?,?,?,?,123,123,'process_group','root_exited','now')`)
      .run(original.hostOwnerId, original.hostOwnerGeneration, original.runtimeId, original.runtimeGeneration, original.attemptId, original.sessionId, original.flyxTurnId);
    host.store.db.prepare("INSERT INTO managed_process_identities(process_id,identity_json) VALUES('original-process',?)").run(JSON.stringify(identity));
    const target = { sessionId: host.sessionId, turnId: first.turnId, attemptId: original.attemptId };
    let inspected = await host.recovery.inspect(target);
    expect(inspected).toMatchObject({ processState: "stopped", nativeState: "unknown", workspaceState: "clear" });
    if (releaseFault) {
      const clear = vi.spyOn(host.workspaceLease!, "clearRetention").mockImplementation(() => { throw new Error("Original lease clear failed"); });
      await expect(host.recovery.acknowledge({ ...target, authSubjectId: "device", commandId: "first-release-failed", evidenceId: inspected.evidenceId,
        expectedRecoveryRevision: inspected.recoveryRevision, acknowledgeUnknown: true })).rejects.toMatchObject({ code: "RECOVERY_RELEASE_PROOF_INVALID" });
      expect(host.snapshot().session).toMatchObject({ activeTurnId: first.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
      expect(host.runtimes.matches(original)).toBe(true); expect(host.workspaceLease).toBeDefined();
      expect(host.store.getTurn(first.turnId)?.status).toBe("outcome_unknown");
      await expect(host.startTurn("device", "release-not-ready", "new prompt")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
      clear.mockRestore();
      inspected = await host.recovery.inspect(target);
    }
    const recovered = await host.recovery.acknowledge({ ...target, authSubjectId: "device", commandId: "acknowledge-original",
      evidenceId: inspected.evidenceId, expectedRecoveryRevision: inspected.recoveryRevision, acknowledgeUnknown: true });
    expect(recovered).toMatchObject({ gate: "released", turnStatus: "outcome_unknown" });
    expect(host.store.getTurn(first.turnId)?.status).toBe("outcome_unknown");
    expect(host.store.getCommandReceipt("device", "unknown-first")?.state).toBe("outcome_unknown");
    expect(host.runtimes.matches(original)).toBe(false); expect(host.workspaceLease).toBeUndefined();
    const next = await host.startTurn("device", "new-prompt", "explicit new prompt"); await host.worker.drainDispatch();
    expect(next.status).toBe("accepted"); expect(contexts[1]?.runtimeGeneration).toBeGreaterThan(original.runtimeGeneration);
    host.ingestAdapterEvent(fenceAdapterEvent(contexts[1]!, { kind: "turn_completed", result: "new done", costUsd: 0, numTurns: 1 })); await host.ingestion.drain();
    finishes[1]!(done); await host.worker.drainOperations();
    expect(host.store.getTurn(first.turnId)?.status).toBe("outcome_unknown"); expect(host.store.getTurn(next.turnId)?.status).toBe("completed");
  } finally { finishes.forEach((finish) => finish(done)); await host.worker.drainOperations(); host.close(); }
});
