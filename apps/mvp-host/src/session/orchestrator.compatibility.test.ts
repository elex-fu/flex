import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { SessionOrchestrator, type CommittedNativeStopRecorder } from "./orchestrator.js";
import type { AdapterStatus, DispatchContext, ProviderAdapter, ProviderOutcome } from "../provider/types.js";

function barrier<T = void>() { let release!: (value: T) => void; const promise = new Promise<T>((yes) => { release = yes; }); return { promise, release }; }
const complete: ProviderOutcome = { status: "completed", providerSessionId: "native-session", evidence: { kind: "native-terminal", sourceId: "native-result" } };
const notDispatched: ProviderOutcome = { status: "cancelled", evidence: { kind: "not-dispatched" } };

const open: Array<{ host: SessionOrchestrator; outcome: ReturnType<typeof barrier<ProviderOutcome>> }> = [];
afterEach(async () => {
  for (const value of open.splice(0)) { value.host.close(); value.outcome.release(complete); await Promise.resolve(); }
});

type RecorderMock = { afterCommittedNativeStop: ReturnType<typeof vi.fn<CommittedNativeStopRecorder["afterCommittedNativeStop"]>> };
function recorderMock(impl: CommittedNativeStopRecorder["afterCommittedNativeStop"] = async () => {}): RecorderMock {
  return { afterCommittedNativeStop: vi.fn(impl) };
}

type Fixture = ReturnType<typeof setup>;
function setup(input: { recorder?: CommittedNativeStopRecorder; canReleaseWorkspace?: (context: DispatchContext) => boolean } = {}) {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const outcome = barrier<ProviderOutcome>(); const calls: DispatchContext[] = [];
  const status: AdapterStatus = { provider: "claude", transport: "deterministic", adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => { throw new Error("No real preflight"); },
    runTurn: async () => { throw new Error("beginTurn required"); }, beginTurn: (context) => { calls.push(context); return { outcome: outcome.promise }; },
    interrupt: vi.fn(async () => "accepted" as const), respondApproval: vi.fn(() => true) };
  const host = new SessionOrchestrator({ workspace, adapter,
    canReleaseWorkspace: input.canReleaseWorkspace ?? (() => true),
    ...(input.recorder ? { compatibilityRecorder: input.recorder } : {}) });
  host.store.createDevice({ id: "device", hostId: "host", platform: "test", credentialKind: "browser-session", scopes: ["session:write", "approval:write"], credentialRevision: 0, createdAt: new Date().toISOString() });
  open.push({ host, outcome }); return { host, outcome, calls };
}

describe("compatibility recorder event source on the Turn terminal path", () => {
  it("feeds exactly one committed native-stop fact for a verified stop behind a terminal Turn", async () => {
    const recorder = recorderMock();
    const f = setup({ recorder });
    const accepted = await f.host.startTurn("device", "command", "actual prompt");
    await f.host.worker.drainDispatch();
    f.outcome.release(complete);
    expect(await f.host.worker.drainOperations()).toBe(true);
    const intent = f.host.execution.forCommand("device", "command")[0]!;
    expect(recorder.afterCommittedNativeStop).toHaveBeenCalledExactlyOnceWith(intent.dispatchContext);
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed");
    expect(f.host.workspaceLease).toBeUndefined();
  });
  it("does not feed the recorder when the native stop stays unproven", async () => {
    const recorder = recorderMock();
    const f = setup({ recorder, canReleaseWorkspace: () => false });
    const accepted = await f.host.startTurn("device", "command", "prompt");
    await f.host.worker.drainDispatch();
    f.outcome.release(complete);
    expect(await f.host.worker.drainOperations()).toBe(true);
    expect(recorder.afterCommittedNativeStop).not.toHaveBeenCalled();
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed");
    expect(f.host.workspaceLease).toBeDefined();
    expect(f.host.snapshot().session).toMatchObject({ activeTurnId: accepted.turnId, recoveryState: "blocked" });
  });
  it("leaves the terminal path completely unchanged without an injected recorder", async () => {
    const f = setup();
    const accepted = await f.host.startTurn("device", "command", "prompt");
    await f.host.worker.drainDispatch();
    f.outcome.release(complete);
    expect(await f.host.worker.drainOperations()).toBe(true);
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed");
    expect(f.host.workspaceLease).toBeUndefined();
    expect(f.host.snapshot().session).toMatchObject({ recoveryState: "idle", activityState: "idle" });
    expect(f.host.store.db.prepare("SELECT 1 FROM session_events WHERE session_id=? AND type='session.recovery.blocked'").get(f.host.sessionId)).toBeUndefined();
  });
  it("does not feed outcomes without a native terminal fact", async () => {
    const recorder = recorderMock();
    const f = setup({ recorder });
    const accepted = await f.host.startTurn("device", "command", "prompt");
    await f.host.worker.drainDispatch();
    f.outcome.release(notDispatched);
    expect(await f.host.worker.drainOperations()).toBe(true);
    expect(recorder.afterCommittedNativeStop).not.toHaveBeenCalled();
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("cancelled");
    expect(f.host.workspaceLease).toBeUndefined();
  });
  it("fails the scene closed when the recorder cannot verify its evidence chain", async () => {
    const recorder = recorderMock(async () => { throw new Error("COMPATIBILITY_NATIVE_BINDING_MISMATCH"); });
    const f = setup({ recorder });
    const accepted = await f.host.startTurn("device", "command", "prompt");
    const lease = f.host.workspaceLease!;
    await f.host.worker.drainDispatch();
    f.outcome.release(complete);
    expect(await f.host.worker.drainOperations()).toBe(true);
    expect(recorder.afterCommittedNativeStop).toHaveBeenCalledExactlyOnceWith(f.host.execution.forCommand("device", "command")[0]!.dispatchContext);
    // The Turn's own facts stay proven; only the compatibility chain is unverified.
    expect(f.host.store.getTurn(accepted.turnId)?.status).toBe("completed");
    expect(f.host.workspaceLease).toBe(lease);
    const blocked = f.host.store.db.prepare("SELECT payload_json FROM session_events WHERE session_id=? AND type='session.recovery.blocked' ORDER BY sequence DESC LIMIT 1")
      .get(f.host.sessionId) as { payload_json: string };
    expect(JSON.parse(blocked.payload_json)).toMatchObject({ turnId: accepted.turnId, reason: "compatibility_fact_unverified" });
    expect(f.host.snapshot().session).toMatchObject({ activeTurnId: accepted.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
    // The degraded flag from the unverified fact chain gates any new Turn first.
    await expect(f.host.startTurn("device", "second", "another prompt")).rejects.toMatchObject({ code: "HOST_DEGRADED" });
  });
});
