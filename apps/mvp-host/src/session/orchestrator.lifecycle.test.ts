import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import type { ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import type { NativeBoundaryAssessment } from "../lifecycle/native-execution-boundary.js";
import { SqliteStore } from "../storage/db.js";
import { HostViews } from "../timeline/host-views.js";
import { fenceAdapterEvent, type AdapterEventHandler, type AdapterStatus, type DispatchContext, type ProviderAdapter, type ProviderOutcome } from "../provider/types.js";
import { SessionOrchestrator } from "./orchestrator.js";

function barrier<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
const terminal: ProviderOutcome = { status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "fixture-result" } };
class ControlledAdapter implements ProviderAdapter {
  readonly provider = "claude" as const; readonly workspace = workspace;
  readonly started = barrier(); readonly stopping = barrier(); readonly stopAllowed = barrier<ProcessStopResult>(); readonly outcome = barrier<ProviderOutcome>();
  context: DispatchContext | undefined; onEvent: AdapterEventHandler | undefined; sealed = false; closeCalls = 0; stopped = false;
  async status(): Promise<AdapterStatus> { return { provider: this.provider, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", workspace, sandboxRequired: true }; }
  preflight(): Promise<AdapterStatus> { throw new Error("Real Provider preflight forbidden"); }
  async runTurn(_id: string, _prompt: string, _resume?: string, context?: DispatchContext) { this.context = context; this.started.resolve(); return this.outcome.promise; }
  async interrupt() { return "accepted" as const; }
  respondApproval() { return true; }
  async closeAndWait() { this.closeCalls++; this.stopping.resolve(); const result = await this.stopAllowed.promise; this.stopped = result.treeStopped; return result; }
  sealCallbacks() { this.sealed = true; }
  finish() { if (!this.sealed && this.context) this.onEvent?.(fenceAdapterEvent(this.context, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1, terminalEvidence: terminal.evidence })); this.outcome.resolve(terminal); }
}
const opened: Array<{ host: SessionOrchestrator; adapter: ControlledAdapter; store: SqliteStore }> = [];
afterEach(async () => { vi.useRealTimers(); for (const f of opened.splice(0)) { f.adapter.stopAllowed.resolve({ stopped: true, treeStopped: true, records: [] }); f.adapter.finish(); try { await f.host.closeAndWait(100); } catch { /* close-failure test keeps its original result */ } if (f.store.db.open) f.store.db.close(); } });
function fixture(afterTerminal?: () => Promise<void>, shared = false) {
  const owner = createTestHostOwner(); const store = new SqliteStore(); const adapter = new ControlledAdapter(); const selected = shared ? store.createSession(workspace, "claude") : undefined;
  const host = new SessionOrchestrator({ workspace, owner, store, adapter, canReleaseWorkspace: () => adapter.stopped, ...(afterTerminal ? { executionHooks: { afterTerminal } } : {}), ...(selected ? { sessionId: selected.id, ownsStore: false, recoverOnStart: false } : {}) });
  adapter.onEvent = (event) => host.ingestAdapterEvent(event); const f = { host, adapter, store }; opened.push(f); return f;
}

describe("actual Host lifecycle integration", () => {
  it("shares shutdown, keeps ingestion and Store open through terminal/checkpoint drain, and closes devices before Store", async () => {
    const checkpoint = barrier(); const checkpointStarted = barrier(); const calls: string[] = [];
    const f = fixture(async () => { calls.push("checkpoint"); checkpointStarted.resolve(); await checkpoint.promise; });
    const accepted = await f.host.startTurn("test-actor", "start", "task"); await f.adapter.started.promise;
    f.host.registerShutdownService({ drain: async () => { calls.push("reactor-drain"); }, close: async () => { calls.push("reactor-close"); } });
    f.host.registerTransportShutdown(async () => { expect(f.store.db.open).toBe(true); expect(f.store.getTurn(accepted.turnId)?.status).toBe("completed"); calls.push("devices"); });
    const original = f.store.close.bind(f.store); f.store.close = () => { calls.push("store"); expect(f.adapter.sealed).toBe(true); original(); };
    const first = f.host.closeAndWait(1000); expect(f.host.closeAndWait(1)).toBe(first); await f.adapter.stopping.promise;
    expect(f.store.db.open).toBe(true); await expect(f.host.startTurn("test-actor", "later", "late task")).rejects.toMatchObject({ code: "HOST_DRAINING" });
    f.adapter.stopAllowed.resolve({ stopped: true, treeStopped: true, records: [] }); f.adapter.finish(); await checkpointStarted.promise; expect(f.store.db.open).toBe(true); expect(f.host.workspaceLease).toBeDefined();
    checkpoint.resolve(); expect(await first).toMatchObject({ clean: true, producerStopped: true, state: "stopped" });
    expect(calls).toEqual(["checkpoint", "reactor-drain", "devices", "reactor-close", "store"]); expect(f.adapter.closeCalls).toBe(1); expect(f.store.db.open).toBe(false);
  });
  it("fences an unproved producer after deadline and durably blocks the gate before closing Store", async () => {
    vi.useFakeTimers(); const f = fixture(); const accepted = await f.host.startTurn("test-actor", "start", "task"); await f.adapter.started.promise;
    let finalState: unknown; const original = f.store.close.bind(f.store); f.store.close = () => { finalState = { session: f.store.getSession(f.host.sessionId), turn: f.store.getTurn(accepted.turnId), receipt: f.store.getCommandReceipt("test-actor", "start") }; original(); };
    const closing = f.host.closeAndWait(50); void closing.catch(() => {}); await f.adapter.stopping.promise; await vi.advanceTimersByTimeAsync(250);
    expect(await closing).toMatchObject({ clean: false, producerStopped: false, state: "recovery_required" }); expect(finalState).toMatchObject({ session: { recoveryState: "blocked" }, turn: { status: "outcome_unknown" }, receipt: { state: "outcome_unknown" } }); expect(() => f.host.owner.assertActive()).not.toThrow();
    f.adapter.stopAllowed.resolve({ stopped: false, treeStopped: false, records: [] }); f.adapter.finish(); await Promise.resolve(); await Promise.resolve(); expect(f.store.db.open).toBe(false); expect(f.adapter.sealed).toBe(true);
  });
  it("retains a deadline-blocked native preparer before closing Store and rejects its late readiness", async () => {
    vi.useFakeTimers(); const started = barrier(); const assessment = barrier<NativeBoundaryAssessment>(); const owner = createTestHostOwner(); const store = new SqliteStore();
    const host = new SessionOrchestrator({ workspace, owner, store, nativeBoundaryFactory: async () => { started.resolve(); return assessment.promise; } });
    const preparing = host.prepareNativeRuntime(); const lateReadiness = expect(preparing).rejects.toThrow("HOST_DRAINING"); await started.promise;
    let recoveryState: string | undefined; const closeStore = store.close.bind(store); store.close = () => { recoveryState = store.getSession(host.sessionId)?.recoveryState; closeStore(); };
    try {
      const closing = host.closeAndWait(50); const rejectedStop = expect(closing).rejects.toThrow("HOST_SHUTDOWN_DEADLINE"); await vi.advanceTimersByTimeAsync(250);
      await rejectedStop; expect(host.lifecycle.readiness).toBe("recovery_required"); expect(recoveryState).toBe("blocked"); expect(store.db.open).toBe(false); owner.assertActive();
    } finally {
      assessment.resolve({ ready: false, code: "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE", summary: { ready: false, code: "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE", platform: process.platform } });
      await lateReadiness; await host.closeAndWait().catch(() => {}); if (store.db.open) store.close();
    }
  });
  it("closes a shared idle Session runtime without closing the global Store or Host owner", async () => {
    const f = fixture(undefined, true); f.adapter.stopAllowed.resolve({ stopped: true, treeStopped: true, records: [] });
    const close = vi.spyOn(f.store, "close"); expect(await f.host.closeAndWait()).toMatchObject({ closed: true, clean: true, producerStopped: true }); expect(close).not.toHaveBeenCalled(); expect(f.store.db.open).toBe(true); f.host.owner.assertActive(); expect(f.store.getSession(f.host.sessionId)).toBeDefined();
  });
  it("reuses one Host projection and leaves shared views open when a Session runtime closes or construction fails", async () => {
    const owner = createTestHostOwner(); const store = new SqliteStore(); const selected = store.createSession(workspace, "claude");
    const views = new HostViews(store, owner, { resolveResource: (id) => id === selected.id ? { sessionId: id, workspace, source: { subscribe: () => () => {} }, readSnapshot: () => ({}) } : undefined });
    views.prepareStoredSessions(); const closeViews = vi.spyOn(views, "close"); const attach = vi.spyOn(Object.getPrototypeOf(views.projector) as typeof views.projector, "attach");
    const adapter = new ControlledAdapter(); const host = new SessionOrchestrator({ workspace, owner, store, sessionId: selected.id, ownsStore: false, recoverOnStart: false, adapter, hostViews: views });
    opened.push({ host, adapter, store }); expect(host.views).toBe(views); expect(host.ownsViews).toBe(false); expect(attach).not.toHaveBeenCalled();
    adapter.stopAllowed.resolve({ stopped: true, treeStopped: true, records: [] }); expect(await host.closeAndWait()).toMatchObject({ clean: true });
    expect(closeViews).not.toHaveBeenCalled(); expect(views.ready(selected.id)).toBe(true); owner.assertActive();
    const otherStore = new SqliteStore(); const other = otherStore.createSession(workspace, "claude");
    expect(() => new SessionOrchestrator({ workspace, owner, store: otherStore, sessionId: other.id, ownsStore: false, recoverOnStart: false, adapter: new ControlledAdapter(), hostViews: views })).toThrow("Shared Host views require the same Store and owner");
    expect(closeViews).not.toHaveBeenCalled(); expect(otherStore.db.open).toBe(true); expect(views.ready(selected.id)).toBe(true); otherStore.close(); views.close();
  });
  it("shares Store close failure and retains ownership instead of reporting a clean stop", async () => {
    const f = fixture(); f.adapter.stopAllowed.resolve({ stopped: true, treeStopped: true, records: [] }); f.store.close = () => { throw new Error("Store close failed"); };
    const closing = f.host.closeAndWait(); await expect(closing).rejects.toThrow("Store close failed"); expect(f.host.closeAndWait()).toBe(closing); expect(() => f.host.owner.assertActive()).not.toThrow(); expect(f.host.lifecycle.readiness).toBe("recovery_required");
  });
});
