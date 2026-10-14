import { describe, expect, it } from "vitest";
import { ClientError } from "./common.js";
import { CommandOutbox } from "./command-outbox.js";
import { MemoryClientStore } from "./host-profile-store.js";

describe("durable command outbox", () => {
  it("commits before send and recovers a lost response after client restart without resending", async () => {
    const store = new MemoryClientStore();
    let writes = 0;
    const first = new CommandOutbox(store, "host-a", async (method, _payload, commandId) => {
      expect(method).toBe("session.startTurn");
      expect((await store.getCommand(commandId!))?.state).toBe("sent");
      writes++;
      throw new ClientError("CONNECTION_CLOSED", "Lost accepted response");
    });
    await expect(first.execute("session.startTurn", { prompt: "one turn" }, "command-one")).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    expect((await store.getCommand("command-one"))?.state).toBe("receipt_unknown");
    const queries: string[] = [];
    const afterRestart = new CommandOutbox(store, "host-a", async (method) => {
      queries.push(method);
      return { found: true, commandId: "command-one", method: "session.startTurn", state: "accepted", response: { turnId: "turn-one" } };
    });
    await afterRestart.reconcile();
    expect(queries).toEqual(["command.getReceipt"]);
    expect(writes).toBe(1);
    expect(await afterRestart.retry("command-one")).toEqual({ turnId: "turn-one" });
    expect(queries).toHaveLength(1);
  });

  it("does not replay absent receipts on reconnect; explicit retry retains the same ID", async () => {
    const store = new MemoryClientStore();
    const first = new CommandOutbox(store, "host-a", async () => { throw new ClientError("REQUEST_TIMEOUT", "timeout"); });
    await expect(first.execute("session.interrupt", {}, "command-two")).rejects.toThrow();
    const sent: string[] = [];
    const resumed = new CommandOutbox(store, "host-a", async (method, _payload, id) => {
      if (method === "command.getReceipt") return { found: false, commandId: "command-two" };
      sent.push(id!);
      return { interrupted: true };
    });
    await resumed.reconcile();
    expect(sent).toEqual([]);
    await resumed.retry("command-two");
    expect(sent).toEqual(["command-two"]);
  });

  it("never retries outcome_unknown even when the user asks to retry", async () => {
    const store = new MemoryClientStore();
    const first = new CommandOutbox(store, "host-a", async () => { throw new ClientError("CONNECTION_CLOSED", "lost"); });
    await expect(first.execute("session.startTurn", { prompt: "side effect" }, "command-unknown")).rejects.toThrow();
    const methods: string[] = [];
    const resumed = new CommandOutbox(store, "host-a", async (method) => {
      methods.push(method);
      return { found: true, method: "session.startTurn", state: "outcome_unknown", response: { turnId: "unknown-turn" } };
    });
    await resumed.reconcile();
    await expect(resumed.retry("command-unknown")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await resumed.reconcile();
    expect(methods).toEqual(["command.getReceipt"]);
    expect((await store.getCommand("command-unknown"))?.outcomeUnknown).toBe(true);
  });

  it("fails closed when persistence fails and rejects reused IDs with different payloads", async () => {
    const broken = new MemoryClientStore();
    broken.putCommand = async () => { throw new ClientError("STORAGE_WRITE_FAILED", "disk full"); };
    let calls = 0;
    const outbox = new CommandOutbox(broken, "host-a", async () => { calls++; });
    await expect(outbox.execute("session.startTurn", { prompt: "never sent" })).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect(calls).toBe(0);
    const store = new MemoryClientStore();
    const working = new CommandOutbox(store, "host-a", async () => ({ accepted: true }));
    await working.execute("session.startTurn", { prompt: "first" }, "same-id");
    await expect(working.execute("session.startTurn", { prompt: "different" }, "same-id")).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
  });

  it("retains unknown access mutations for review without probing nonexistent receipts", async () => {
    const store = new MemoryClientStore();
    const outbox = new CommandOutbox(store, "host-a", async () => { throw new ClientError("CONNECTION_CLOSED", "lost"); });
    await expect(outbox.execute("access.revokeAll", {}, "access-one")).rejects.toThrow();
    let requests = 0;
    const resumed = new CommandOutbox(store, "host-a", async () => { requests++; });
    await resumed.reconcile();
    await expect(resumed.retry("access-one")).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    expect(requests).toBe(0);
  });
});
