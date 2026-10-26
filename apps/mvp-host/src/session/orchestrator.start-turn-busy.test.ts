import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator } from "./orchestrator.js";
import { temporaryRepository, removeFixture } from "../checkpoint/test-support.js";
import { rawGitServiceRunner } from "../test-support/managed-git-fixtures.js";
import type { ProviderAdapter, ProviderOutcome } from "../provider/types.js";

const open: Array<{ host: SessionOrchestrator; root: string }> = [];
afterEach(async () => { for (const f of open.splice(0)) { await f.host.closeAndWait().catch(() => {}); await removeFixture(f.root); } });

/** A finalization that pauses inside the post-turn hook: the checkout lease stays held while the hook is pending. */
function gatedFixture(gate: Promise<void>, entered: { promise: Promise<void> }) {
  return fixture({ executionHooks: { afterTerminal: () => { entered.resolve(); return gate; } }, startTurnBusyWaitMs: 5_000 });
}
async function fixture(overrides: Partial<ConstructorParameters<typeof SessionOrchestrator>[0]> = {}) {
  const root = await temporaryRepository(); let helpersStopped = true;
  const begin = vi.fn();
  const outcome: ProviderOutcome = { status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "fixture-native-result" } };
  const adapter: ProviderAdapter = { provider: "claude", workspace: root,
    status: async () => { throw new Error("No Provider status query"); }, preflight: async () => { throw new Error("No Provider launch"); },
    runTurn: async () => outcome, beginTurn: () => { begin(); return { outcome: Promise.resolve(outcome) }; },
    interrupt: async () => "accepted", respondApproval: () => true };
  const host = new SessionOrchestrator({ workspace: root, adapter, gitRunner: rawGitServiceRunner(),
    canReleaseWorkspace: () => true, canReleaseAdditionalProducers: () => helpersStopped, ...overrides });
  host.store.createDevice({ id: "actor", hostId: "test-host", platform: "test", credentialKind: "browser-session",
    credentialRevision: 0, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  open.push({ host, root });
  return { host, begin, setHelpersStopped: (value: boolean) => { helpersStopped = value; } };
}

describe("startTurn while a post-turn finalization is in flight", { timeout: 30_000 }, () => {
  it("waits for the in-flight finalization instead of rejecting WORKSPACE_BUSY and dropping the follow-up", async () => {
    // scene-claude-interactive-r12: the follow-up startTurn landed while
    // finalizeTurnInternal was still holding the checkout lease for the
    // post-turn checkpoint, threw WORKSPACE_BUSY before any receipt/turn/event
    // existed, and the client treated that rejection as terminal — the prompt
    // was silently lost. startTurn must wait for the finalization instead.
    let releaseHook!: () => void; const gate = new Promise<void>((resolve) => { releaseHook = resolve; });
    let signalHook!: () => void; const entered = { promise: new Promise<void>((resolve) => { signalHook = resolve; }), resolve: () => signalHook() };
    const f = await gatedFixture(gate, entered);
    await f.host.startTurn("actor", "first-task", "run-one");
    await vi.waitFor(() => expect(f.begin).toHaveBeenCalledOnce());
    await entered.promise; // finalization is now paused inside the post-turn hook
    expect(f.host.workspaceLease).toBeDefined(); // ... and still holds the lease
    const startedAt = Date.now();
    const followUp = f.host.startTurn("actor", "follow-up", "run-two");
    await new Promise((resolve) => setTimeout(resolve, 150)); // settle into the busy wait, not the rejection path
    releaseHook(); // the finalization finishes and releases the lease
    await followUp; // the follow-up proceeds instead of being dropped
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await f.host.worker.drainDispatch(); await f.host.worker.drainOperations();
    expect(f.begin).toHaveBeenCalledTimes(2); // both prompts actually dispatched
  });
  it("still rejects WORKSPACE_BUSY promptly when the lease is retained with no finalization in flight", async () => {
    // A genuinely retained lease (preview helper stop unknown) must keep the
    // immediate rejection: the wait only covers in-flight finalizations.
    const f = await fixture(); // default startTurnBusyWaitMs: the early break must not lean on the deadline
    const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    f.setHelpersStopped(false); expect(f.host.releaseCheckpointLease(lease.operationId)).toBe(false);
    const startedAt = Date.now();
    await expect(f.host.startTurn("actor", "blocked-new-task", "run")).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    f.setHelpersStopped(true); expect(f.host.releaseCheckpointLease(lease.operationId)).toBe(true);
  });
});
