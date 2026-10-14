import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@flyx/mvp-protocol";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { DeviceRegistry } from "../auth/device-registry.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { HostViews } from "../timeline/host-views.js";
import { fenceAdapterEvent, type DispatchContext, type ProviderAdapter, type ProviderOutcome } from "../provider/types.js";
import { createHostInteractionBindings } from "./host-interactions.js";
import { InteractionStore, retainInteractionProjection } from "./interaction-store.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse())
  await cleanup(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const owner = createTestHostOwner();
  const store = openOwned({ databasePath: ":memory:", owner });
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const first = store.createSession(workspace, "claude", "first");
  const second = store.createSession(workspace, "claude", "second");
  const register = vi.spyOn(store, "registerCommitHook");
  const project = vi.spyOn(InteractionStore.prototype, "projectCommittedBatch");
  const anchor = retainInteractionProjection(store);
  const views = new HostViews(store, owner, { resolveResource: () => undefined });
  views.prepareStoredSessions();
  const attention = vi.fn((events: readonly SessionEvent[]) => {
    for (const event of events)
      if (event.type.startsWith("interaction.")) {
        const payload = event.payload as {
          interactionId: string;
          interaction: {
            status: string;
            version: number;
          };
        };
        const row = store.db.prepare("SELECT status,version FROM interactions WHERE interaction_id=?").get(payload.interactionId);
        expect(store.db.inTransaction).toBe(true);
        expect(row).toEqual({ status: payload.interaction.status, version: payload.interaction.version });
      }
  });
  const detachAttention = store.registerCommitHook(attention);
  const registrations = register.mock.calls.length;
  const devices = new DeviceRegistry(store, "shared-interactions", { recoverLeases: false });
  const actor = devices.createBrowserDevice({ scopes: ["session:read", "session:write", "approval:write"] });
  const runtimes: Array<{
    close(): Promise<void>;
  }> = [];
  function load(sessionId: string) {
    const outcome = deferred<ProviderOutcome>();
    let context: DispatchContext | undefined;
    let finished = false;
    const delivery = vi.fn(() => true);
    const adapter: ProviderAdapter = { provider: "claude", workspace,
      status: vi.fn(async () => ({ provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "fixture", executable: "fixture", runtimeVersion: "fixture", workspace, sandboxRequired: true as const })),
      preflight: async () => { throw new Error("No native Provider preflight in fixture"); }, runTurn: async () => { throw new Error("beginTurn required"); },
      beginTurn: (original) => { context = original; return { outcome: outcome.promise }; }, interrupt: async () => "accepted", respondApproval: delivery,
    };
    const bindings = createHostInteractionBindings({ evidenceSource: "fixture" });
    const host: SessionOrchestrator = new SessionOrchestrator({ store, owner, sessionId, ownsStore: false, recoverOnStart: false, runtimeId: `runtime-${sessionId}-${runtimes.length}`,
      workspace, checkoutRoot: workspace, hostViews: views, adapter, canReleaseWorkspace: () => true,
      interactionEvents: bindings.interactionEvents, executionSetup: bindings.executionSetup,
      recovery: { companionEvents: bindings.companionEvents, supersedeInteractions: bindings.supersedeInteractions },
    });
    const finish = async () => {
      if (finished)
        return;
      finished = true;
      if (context && store.getActiveTurn(sessionId))
        host.ingestAdapterEvent(fenceAdapterEvent(context, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }));
      outcome.resolve({ status: "completed", providerSessionId: `native-${sessionId}`, evidence: { kind: "native-terminal", sourceId: `terminal-${sessionId}` } });
      await host.worker.drainOperations();
      await host.ingestion.drain();
    };
    const runtime = { host, bindings, delivery, adapter, context: () => context!,
      start: async (commandId: string) => { const result = await host.startTurn(actor.id, commandId, "fixture work"); await host.worker.drainDispatch(); return result.turnId; },
      request: async (id: string) => {
        host.ingestAdapterEvent(fenceAdapterEvent(context!, { kind: "approval_requested", request: { approvalId: id, turnId: context!.flyxTurnId, toolUseId: `private-${id}`, toolName: "Bash", input: { command: "npm test" }, cwd: workspace,
            createdAt: new Date().toISOString(), dispatchContext: { nativeRequestId: `private-${id}`, nativeMethod: "canUseTool/approval" } } }));
        await host.ingestion.drain();
      },
      respond: (id: string, commandId: string) => bindings.interactions()!.rpc("interaction.respondApproval", { sessionId, interactionId: id, expectedVersion: 0, action: "deny" }, { authSubjectId: actor.id, commandId }),
      finish,
      close: async () => { await finish(); await host.close(); bindings.close(); },
    };
    runtimes.push(runtime);
    return runtime;
  }
  cleanups.push(async () => { for (const runtime of runtimes.slice().reverse())
    await runtime.close(); detachAttention(); views.close(); anchor(); devices.dispose(); store.close(); owner.release(); });
  return { store, owner, first, second, register, project, registrations, anchor, attention, load, actor };
}
describe("shared production Interaction projection lease", () => {
  it("projects one reservation and delivery with two loaded selected-Session runtimes on the same writer", async () => {
    const f = fixture();
    const a = f.load(f.first.id);
    const b = f.load(f.second.id);
    expect(a.host.store).toBe(b.host.store);
    expect(f.register).toHaveBeenCalledTimes(f.registrations);
    await a.start("start-first");
    await a.request("first-approval");
    const calls = f.project.mock.calls.length;
    expect(a.respond("first-approval", "answer-first")).toMatchObject({ status: "accepted" });
    expect(f.project).toHaveBeenCalledTimes(calls + 1);
    expect(a.bindings.interactions()!.service.interactions.get("first-approval")).toMatchObject({ version: 1, status: "responding" });
    expect(f.store.db.prepare("SELECT count(*) AS count FROM interaction_reservations").get()).toEqual({ count: 1 });
    await a.host.worker.drainDispatch();
    expect(a.delivery).toHaveBeenCalledOnce();
    expect(b.delivery).not.toHaveBeenCalled();
    expect(a.bindings.interactions()!.service.interactions.get("first-approval")).toMatchObject({ version: 2, status: "delivered", deliveryState: "local_delivery" });
    expect(f.store.db.prepare("SELECT count(*) AS count FROM interaction_delivery_evidence").get()).toEqual({ count: 1 });
    expect(f.store.getCommandReceipt(f.actor.id, "answer-first")).toMatchObject({ state: "completed", response: { status: "delivered" } });
    expect(f.attention).toHaveBeenCalled();
    expect(f.store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("keeps the other Session's projector after child close and preserves Host attention order through unload/reload", async () => {
    const f = fixture();
    const a = f.load(f.first.id);
    const b = f.load(f.second.id);
    await a.start("start-first");
    await a.request("first-approval");
    a.respond("first-approval", "answer-first");
    await a.host.worker.drainDispatch();
    await a.close();
    a.bindings.close();
    expect(f.store.db.open).toBe(true);
    expect(() => f.owner.assertActive()).not.toThrow();
    await b.start("start-second");
    await b.request("second-approval");
    expect(b.respond("second-approval", "answer-second")).toMatchObject({ status: "accepted" });
    await b.host.worker.drainDispatch();
    expect(b.delivery).toHaveBeenCalledOnce();
    expect(b.bindings.interactions()!.service.interactions.get("second-approval")).toMatchObject({ version: 2, status: "delivered" });
    await b.close();
    b.bindings.close();
    const before = f.register.mock.calls.length;
    const reloaded = f.load(f.first.id);
    await reloaded.start("reload-first");
    await reloaded.request("reloaded-approval");
    reloaded.respond("reloaded-approval", "answer-reloaded");
    await reloaded.host.worker.drainDispatch();
    expect(reloaded.delivery).toHaveBeenCalledOnce();
    expect(f.register).toHaveBeenCalledTimes(before);
    expect(f.attention).toHaveBeenCalled();
    const directory = new InteractionStore(f.store.db);
    const historyRegistrations = f.register.mock.calls.length;
    expect(directory.get("first-approval")?.status).toBe("delivered");
    expect(directory.list(f.second.id, { openOnly: false })).toHaveLength(1);
    expect(f.register).toHaveBeenCalledTimes(historyRegistrations);
  });
  it("releases the final Host projection lease idempotently and treats independent connections separately", () => {
    const f = fixture();
    const second = retainInteractionProjection(f.store);
    second();
    second();
    expect(f.register).toHaveBeenCalledTimes(f.registrations);
    const foreignOwner = createTestHostOwner();
    const foreign = openOwned({ databasePath: ":memory:", owner: foreignOwner });
    const foreignRegister = vi.spyOn(foreign, "registerCommitHook");
    const releaseForeign = retainInteractionProjection(foreign);
    expect(foreignRegister).toHaveBeenCalledOnce();
    expect(() => new InteractionStore(f.store.db).attach(foreign)).toThrow("INTERACTION_CONNECTION_MISMATCH");
    releaseForeign();
    releaseForeign();
    foreign.close();
    foreignOwner.release();
    f.anchor();
    f.anchor();
    const restored = retainInteractionProjection(f.store);
    expect(f.register).toHaveBeenCalledTimes(f.registrations + 1);
    restored();
  });
});
