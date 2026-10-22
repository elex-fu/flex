import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator } from "./orchestrator.js";
import { HostExecutionPermits } from "../workspace/host-execution-permits.js";
import { temporaryRepository, removeFixture } from "../checkpoint/test-support.js";
import { rawGitServiceRunner } from "../test-support/managed-git-fixtures.js";
import type { ProviderAdapter } from "../provider/types.js";

const fixtures: Array<{ host: SessionOrchestrator; root: string }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.host.closeAndWait(1000); await removeFixture(f.root); } });

describe("Host task permits at the Native dispatch boundary", () => {
  it("cancels an accepted task waiting for capacity without invoking its prompt or acquiring checkout", async () => {
    const root = await temporaryRepository(), permits = new HostExecutionPermits({ limit: 1 });
    const other = await permits.acquire("other-running-attempt"), run = vi.fn(async () => ({ status: "completed" as const, providerSessionId: "native-session", evidence: { kind: "native-terminal" as const, sourceId: "result" } }));
    const adapter: ProviderAdapter = { provider: "claude", workspace: root, status: async () => { throw new Error("unused"); }, preflight: async () => { throw new Error("unused"); },
      runTurn: run, interrupt: async () => "accepted", respondApproval: () => false };
    const host = new SessionOrchestrator({ workspace: root, adapter, executionPermits: permits, gitRunner: rawGitServiceRunner(), canReleaseWorkspace: () => true });
    fixtures.push({ host, root });
    const start = await host.startTurn("actor", "queued-start", "must never dispatch");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(permits.queued).toBe(1); expect(host.workspaceLease).toBeUndefined();
    expect(await host.interrupt("actor", "queued-interrupt")).toEqual({ status: "cancelled", turnId: start.turnId });
    expect(await host.worker.drainOperations(1000)).toBe(true);
    expect(run).not.toHaveBeenCalled(); expect(permits.queued).toBe(0); expect(permits.active).toBe(1);
    expect(host.store.getTurn(start.turnId)?.status).toBe("cancelled");
    expect(host.store.getCommandReceipt("actor", "queued-start")?.state).toBe("cancelled");
    expect(host.store.getCommandReceipt("actor", "queued-interrupt")?.state).toBe("completed");
    // The durable turn.cancelled event settles the queued intent with the
    // terminal result; the pre-dispatch cancellation is observable from the
    // receipt's not-dispatched evidence and the untouched prompt.
    expect(host.execution.forCommand("actor", "queued-start")[0]).toMatchObject({ state: "settled", resultCode: "cancelled" });
    other.release({ producerStopped: true });
  });
});
