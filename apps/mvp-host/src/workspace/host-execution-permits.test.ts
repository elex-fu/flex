import { describe, expect, it } from "vitest";
import { HostExecutionPermits } from "./host-execution-permits.js";

describe("Host task permits", () => {
  it("defaults to two real tasks and reserves capacity until explicit stopped evidence", async () => {
    const permits = new HostExecutionPermits();
    const first = await permits.acquire("one"), second = await permits.acquire("two");
    let dispatched = false;
    const waiting = permits.acquire("three").then((permit) => { dispatched = true; return permit; });
    await Promise.resolve(); expect(permits.active).toBe(2); expect(permits.queued).toBe(1);
    expect(first.release({ producerStopped: false })).toBe(false);
    first.retain("stop unknown"); await Promise.resolve(); expect(dispatched).toBe(false);
    expect(await permits.drain(1)).toBe(false);
    expect(first.release({ producerStopped: true })).toBe(true);
    const third = await waiting; expect(dispatched).toBe(true); expect(permits.active).toBe(2);
    first.release({ producerStopped: true }); expect(permits.active).toBe(2);
    second.release({ producerStopped: true }); third.release({ producerStopped: true });
    expect(await permits.drain(1)).toBe(true);
  });
  it("cancels only its own queued waiter and preserves FIFO for remaining executions", async () => {
    const permits = new HostExecutionPermits({ limit: 1 }), held = await permits.acquire("held");
    const cancelled = new AbortController(), next = new AbortController();
    const firstWait = permits.acquire("cancel", { signal: cancelled.signal });
    const rejection = expect(firstWait).rejects.toThrow("HOST_EXECUTION_PERMIT_CANCELLED");
    const secondWait = permits.acquire("next", { signal: next.signal });
    cancelled.abort(); await rejection; expect(permits.queued).toBe(1);
    held.release({ producerStopped: true }); const granted = await secondWait;
    next.abort(); expect(permits.active).toBe(1);
    granted.release({ producerStopped: true }); expect(permits.active).toBe(0);
  });
  it("seals admission without returning active capacity and rejects duplicate identities", async () => {
    const permits = new HostExecutionPermits({ limit: 1 }), held = await permits.acquire("held");
    await expect(permits.acquire("held")).rejects.toThrow("DUPLICATE");
    const waiting = permits.acquire("waiting"), rejected = expect(waiting).rejects.toThrow("SEALED");
    await expect(permits.acquire("waiting")).rejects.toThrow("DUPLICATE");
    permits.seal(); permits.seal(); await rejected;
    expect(permits.active).toBe(1); expect(permits.queued).toBe(0);
    await expect(permits.acquire("later")).rejects.toThrow("SEALED");
    expect(await permits.drain(1)).toBe(false);
    held.release({ producerStopped: true }); expect(await permits.drain(1)).toBe(true);
  });
});
