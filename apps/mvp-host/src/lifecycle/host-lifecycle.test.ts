import { describe, expect, it, vi } from "vitest";
import { HostLifecycle, type HostLifecycleHooks } from "./host-lifecycle.js";
import { OperationRegistry } from "./operation-registry.js";

function fixture(stopped = true) {
  const calls: string[] = [];
  const hooks: HostLifecycleHooks = {
    stopAdmission() { calls.push("admission"); }, stopDispatch() { calls.push("dispatch"); },
    async stopProducers() { calls.push("producers"); return { stopped }; },
    async drainIngestion() { calls.push("ingestion"); return true; },
    async drainOperations() { calls.push("operations"); return true; },
    fenceCallbacks() { calls.push("fence"); },
    recordUnknown() { calls.push("unknown"); }, retainOwnership() { calls.push("retain"); },
    async closeTransports() { calls.push("transports"); }, closeStore() { calls.push("store"); },
    releaseOwnership() { calls.push("release"); },
  };
  return { calls, hooks, lifecycle: new HostLifecycle(hooks) };
}

describe("HostLifecycle", () => {
  it("shares shutdown and keeps Store after terminal ingestion and checkpoint work", async () => {
    const { calls, lifecycle } = fixture();
    lifecycle.markReady(true);
    const first = lifecycle.shutdown();
    expect(lifecycle.shutdown()).toBe(first);
    expect(() => lifecycle.assertWritable()).toThrow("HOST_NOT_WRITABLE");
    expect(await first).toEqual({ stopped: true, recoveryRequired: false });
    expect(calls).toEqual(["admission", "dispatch", "producers", "ingestion", "operations", "fence", "transports", "store", "release"]);
  });
  it("retains execution ownership when descendants cannot be proved stopped", async () => {
    const { calls, lifecycle } = fixture(false);
    expect(await lifecycle.shutdown()).toEqual({ stopped: false, recoveryRequired: true });
    expect(calls.indexOf("unknown")).toBeLessThan(calls.indexOf("store"));
    expect(calls).toContain("retain"); expect(calls).not.toContain("release");
    expect(lifecycle.readiness).toBe("recovery_required");
  });
  it("close failure is shared and never reports a successful shutdown", async () => {
    const { calls, hooks } = fixture();
    hooks.closeStore = () => { calls.push("store"); throw new Error("disk"); };
    const lifecycle = new HostLifecycle(hooks);
    const first = lifecycle.shutdown();
    await expect(first).rejects.toThrow("disk");
    await expect(lifecycle.shutdown()).rejects.toThrow("disk");
    expect(calls).not.toContain("release"); expect(lifecycle.readiness).toBe("recovery_required");
  });
  it("attempts Store close and preserves ownership when the pre-Store seal fails", async () => {
    const { calls, hooks } = fixture();
    hooks.sealJournal = () => { calls.push("seal"); throw new Error("journal fence failed"); };
    const lifecycle = new HostLifecycle(hooks);
    await expect(lifecycle.shutdown()).rejects.toThrow("journal fence failed");
    expect(calls.indexOf("seal")).toBeLessThan(calls.indexOf("store"));
    expect(calls.filter((call) => call === "store")).toHaveLength(1);
    expect(calls).toContain("retain"); expect(calls).not.toContain("release");
    expect(lifecycle.readiness).toBe("recovery_required");
  });

  it("bounds an SDK stop hook which never resolves", async () => {
    vi.useFakeTimers();
    try {
      const { hooks, calls } = fixture();
      hooks.stopProducers = () => new Promise(() => {});
      const lifecycle = new HostLifecycle(hooks, 50);
      const shutdown = lifecycle.shutdown();
      await vi.advanceTimersByTimeAsync(50);
      expect(await shutdown).toEqual({ stopped: false, recoveryRequired: true });
      expect(calls).toContain("store"); expect(calls).not.toContain("release");
    } finally { vi.useRealTimers(); }
  });
});

describe("OperationRegistry", () => {
  it("drains work registered by terminal callbacks without blocking the control lane", async () => {
    const operations = new OperationRegistry();
    let finish!: () => void;
    const producer = operations.track("producer", () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(await operations.track("control", async () => "interrupt")).toBe("interrupt");
    operations.beginDrain();
    await expect(operations.track("producer", async () => {})).rejects.toThrow("HOST_DRAINING");
    let terminalDone!: () => void;
    void producer.then(() => operations.track("ingestion", () => new Promise<void>((resolve) => { terminalDone = resolve; })));
    finish(); await producer; await Promise.resolve();
    const draining = operations.drain(["producer", "ingestion", "checkpoint"], 1_000);
    terminalDone(); expect(await draining).toBe(true); expect(operations.size).toBe(0);
    operations.seal();
    await expect(operations.track("ingestion", async () => {})).rejects.toThrow("HOST_DRAINING");
  });
});
