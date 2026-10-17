import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { adoptNodeChildProcess, failedChildHandle, MANAGED_CHILD_EVIDENCE_VERSION, MANAGED_CHILD_UNSPAWNED_EXIT, type ManagedChildExit } from "./managed-child-handle.js";

function fakeChild(options: { pid?: number | undefined; kill?: () => boolean } = {}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: options.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: options.kill ?? (() => true) });
  return child;
}

describe("narrow managed child handle", () => {
  it("adopts a real Node child and keeps versioned spawn/exit evidence for late listeners", async () => {
    const child = fakeChild({ pid: 5000000 }); const handle = adoptNodeChildProcess({ id: "process-1", child });
    expect(handle.id).toBe("process-1"); expect(handle.pid).toBe(5000000);
    expect(handle.rawEvidence()).toEqual([{ version: MANAGED_CHILD_EVIDENCE_VERSION, backend: "node_child_process", observation: "spawn", pid: 5000000 }]);
    child.emit("exit", 3, null);
    expect(await handle.exited).toEqual({ code: 3, signal: null });
    expect(handle.rawEvidence()).toEqual([
      { version: MANAGED_CHILD_EVIDENCE_VERSION, backend: "node_child_process", observation: "spawn", pid: 5000000 },
      { version: MANAGED_CHILD_EVIDENCE_VERSION, backend: "node_child_process", observation: "exit", pid: 5000000, exit: { code: 3, signal: null } },
    ]);
    // A listener attached after the observation still receives it exactly once.
    const replayed: ManagedChildExit[] = []; handle.on("exit", (exit) => replayed.push(exit));
    child.emit("exit", 0, null); child.emit("exit", 0, null);
    expect(replayed).toEqual([{ code: 3, signal: null }]);
    expect(handle.kill("SIGTERM")).toBe(false);
    expect(handle.rawEvidence()).toHaveLength(2);
  });
  it("replays a terminal observation to every later registration without inventing a new one", async () => {
    const child = fakeChild({ pid: 5000000 }); const handle = adoptNodeChildProcess({ id: "process-6", child });
    const first: ManagedChildExit[] = []; handle.on("exit", (exit) => first.push(exit));
    child.emit("exit", 7, null);
    const second: ManagedChildExit[] = []; handle.on("exit", (exit) => second.push(exit));
    const once: ManagedChildExit[] = []; handle.once("exit", (exit) => once.push(exit));
    expect(first).toEqual([{ code: 7, signal: null }]);
    expect(second).toEqual([{ code: 7, signal: null }]); expect(once).toEqual([{ code: 7, signal: null }]);
  });
  it("treats a no-PID spawn error as terminal without fabricating a normal exit", async () => {
    const child = fakeChild({ pid: undefined }); const handle = adoptNodeChildProcess({ id: "process-2", child });
    expect(handle.pid).toBeUndefined();
    const errors: Error[] = []; handle.on("error", (error) => errors.push(error));
    child.emit("error", new Error("ENOENT"));
    expect(errors.map((error) => error.message)).toEqual(["ENOENT"]);
    // A listener attached after the failure still observes the same error.
    const late: Error[] = []; handle.on("error", (error) => late.push(error));
    expect(late.map((error) => error.message)).toEqual(["ENOENT"]);
    expect(await handle.exited).toEqual(MANAGED_CHILD_UNSPAWNED_EXIT);
    expect(handle.rawEvidence()).toEqual([]);
    expect(handle.kill("SIGKILL")).toBe(false);
  });
  it("keeps a failed launch observable as an error, never as PID or raw evidence", async () => {
    const handle = failedChildHandle({ error: new Error("journal disk write failed") });
    expect(handle.pid).toBeUndefined();
    const errors: Error[] = []; handle.on("error", (error) => errors.push(error));
    expect(errors.map((error) => error.message)).toEqual(["journal disk write failed"]);
    expect(await handle.exited).toEqual({ code: null, signal: null });
    expect(handle.rawEvidence()).toEqual([]);
    expect(handle.kill("SIGTERM")).toBe(false);
    expect(await handle.waitForExit(0)).toEqual({ code: null, signal: null });
    handle.dispose();
  });
  it("bounds waitForExit and only reports an observed exit", async () => {
    const child = fakeChild({ pid: 5000000 }); const handle = adoptNodeChildProcess({ id: "process-3", child });
    expect(await handle.waitForExit(0)).toBeUndefined();
    const started = Date.now(); expect(await handle.waitForExit(20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    child.emit("exit", 0, null);
    expect(await handle.waitForExit(0)).toEqual({ code: 0, signal: null });
  });
  it("requests a signal without claiming exit proof and refuses recycled-PID or grouped kills", async () => {
    const kill = vi.fn(() => true); const child = fakeChild({ pid: 6000000, kill });
    const named = adoptNodeChildProcess({ id: "process-4", child }); named.kill("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGTERM"); expect(await named.waitForExit(0)).toBeUndefined();
    child.emit("exit", 0, null); expect(named.kill("SIGKILL")).toBe(false); expect(kill).toHaveBeenCalledTimes(1);
    // A grouped handle targets the original process group, never a recycled root PID.
    const grouped = adoptNodeChildProcess({ id: "process-5", child: fakeChild({ pid: 6_000_001 }), grouped: true });
    expect(grouped.kill("SIGKILL")).toBe(false);
    expect(await grouped.waitForExit(0)).toBeUndefined();
  });
});
