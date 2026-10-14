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
    expect(queries).toHaveLength(2);
  });

  it("never replays a possibly dispatched operation even after an absent receipt", async () => {
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
    await expect(resumed.retry("command-two")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(sent).toEqual([]);
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
    expect(methods).toEqual(["command.getReceipt", "command.getReceipt", "command.getReceipt"]);
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

  it("updates accepted and outcome-unknown operations through queries, never mutation replay", async () => {
    const store = new MemoryClientStore();
    await new CommandOutbox(store, "host-a", async () => ({ turnId: "turn" })).execute("session.startTurn", { prompt: "one" }, "review");
    const methods: string[] = [];
    let state = "outcome_unknown";
    const outbox = new CommandOutbox(store, "host-a", async (method) => {
      methods.push(method); return { found: true, method: "session.startTurn", state, response: { turnId: "turn", status: state } };
    });
    await outbox.reconcile(); expect((await store.getCommand("review"))?.outcomeUnknown).toBe(true);
    state = "completed";
    await outbox.reconcile();
    expect(await store.getCommand("review")).toMatchObject({ state: "terminal", result: { status: "completed" } });
    expect((await store.getCommand("review"))?.outcomeUnknown).toBeUndefined();
    expect(methods).toEqual(["command.getReceipt", "command.getReceipt"]);
    await expect(outbox.retry("review")).resolves.toMatchObject({ status: "completed" });
    expect(methods).toHaveLength(2);
  });

  it("only a durable never-dispatched queued command may be explicitly sent", async () => {
    const store = new MemoryClientStore();
    await store.putCommand({ commandId: "draft", hostId: "host-a", method: "session.startTurn", payloadHash: "hash",
      payload: { prompt: "draft" }, createdAt: new Date().toISOString(), state: "queued", dispatchState: "not_dispatched" });
    const methods: string[] = [];
    const outbox = new CommandOutbox(store, "host-a", async (method, _payload, id) => {
      methods.push(method);
      if (method === "command.getReceipt") return { found: false };
      expect(id).toBe("draft"); expect((await store.getCommand(id!))?.dispatchState).toBe("possibly_dispatched");
      return { status: "accepted" };
    });
    await outbox.reconcile(); expect(methods).toEqual(["command.getReceipt"]);
    await outbox.retry("draft"); expect(methods).toEqual(["command.getReceipt", "command.getReceipt", "session.startTurn"]);
  });

  it("coalesces receipt queries and keeps ephemeral authorization out of the outbox", async () => {
    const store = new MemoryClientStore();
    await new CommandOutbox(store, "host-a", async () => ({})).execute("session.interrupt", {}, "coalesce");
    let finish!: (receipt: unknown) => void; let count = 0;
    const outbox = new CommandOutbox(store, "host-a", async () => { count++; return new Promise((resolve) => { finish = resolve; }); });
    const a = outbox.queryReceipt("coalesce"); const b = outbox.queryReceipt("coalesce");
    await Promise.resolve(); await Promise.resolve();
    finish({ found: true, state: "completed" }); await Promise.all([a, b]); expect(count).toBe(1);
    await expect(outbox.execute("access.refresh", {})).rejects.toMatchObject({ code: "EPHEMERAL_ACCESS_OPERATION" });
    expect((await store.listCommands("host-a"))).toHaveLength(1);
  });
});


describe("outbox directly selects access receipts", () => {
  it("uses actor-scoped access.getReceipt without a sender bridge and coalesces pending queries", async () => {
    const store = new MemoryClientStore(); await store.putCommand({ commandId: "access-one", hostId: "host-a", method: "access.revokeDevice", payloadHash: "hash", payload: { deviceId: "other" }, createdAt: "now", state: "accepted", dispatchState: "possibly_dispatched" });
    const methods: string[] = []; let resolve!: (value: unknown) => void;
    const outbox = new CommandOutbox(store, "host-a", async (method, payload, commandId) => { methods.push(method); expect(payload).toEqual({ commandId: "access-one" }); expect(commandId).toBeUndefined(); return new Promise((done) => { resolve = done; }); }, { supportsAccessReceipts: () => true });
    const first = outbox.queryReceipt("access-one"), second = outbox.queryReceipt("access-one"); await expect.poll(() => methods.length).toBe(1); resolve({ found: true, commandId: "access-one", method: "access.revokeDevice", state: "completed", response: { revoked: true } }); await Promise.all([first, second]); expect(methods).toEqual(["access.getReceipt"]); expect((await store.getCommand("access-one"))?.state).toBe("terminal");
  });
  it("does not convert missing capability into queried absence or dispatch", async () => {
    const store = new MemoryClientStore(); const stored = { commandId: "queued-access", hostId: "host-a", method: "access.revokeDevice", payloadHash: "hash", payload: {}, createdAt: "now", state: "queued" as const, dispatchState: "not_dispatched" as const }; await store.putCommand(stored);
    let calls = 0; const outbox = new CommandOutbox(store, "host-a", async () => { calls++; }, { supportsAccessReceipts: () => false }); await outbox.reconcile(); await expect(outbox.queryReceipt("queued-access")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" }); await expect(outbox.retry("queued-access")).rejects.toMatchObject({ code: "REVIEW_REQUIRED" }); expect(calls).toBe(0); expect(await store.getCommand("queued-access")).toEqual(stored);
  });
});


describe("strict catalog mutation receipts", () => {
  it("uses the bound receipt state instead of Session status", async () => {
    const store = new MemoryClientStore(); let state = "accepted", calls = 0;
    const outbox = new CommandOutbox(store, "host-a", async (_method, _payload, commandId) => { calls++; return { session: { sessionId: "new-session", status: "active" }, receipt: { commandId, state } }; });
    await outbox.execute("session.createNew", { workspaceId: "workspace-a", providerInstanceId: "provider-a" }, "create-a"); expect((await store.getCommand("create-a"))?.state).toBe("accepted");
    for (const terminal of ["completed", "failed", "cancelled"]) {
      state = terminal;
      await outbox.execute("session.rename", { sessionId: "session-b", title: "Title" }, `rename-${terminal}`);
      expect(await store.getCommand(`rename-${terminal}`)).toMatchObject({ state: "terminal", dispatchState: "possibly_dispatched", result: { receipt: { state: terminal } } });
      await outbox.queryReceipt(`rename-${terminal}`);
    }
    state = "outcome_unknown"; await expect(outbox.execute("session.closeRuntime", { sessionId: "session-b" }, "close-a")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); expect(await store.getCommand("close-a")).toMatchObject({ state: "receipt_unknown", outcomeUnknown: true, dispatchState: "possibly_dispatched" }); expect(calls).toBe(5);
  });
  it("retains possible dispatch after a missing, foreign, or malformed receipt and only permits read-only outcome review", async () => {
    for (const receipt of [undefined, { commandId: "other", state: "completed" }, { commandId: "archive-a", state: "active" }, { commandId: "archive-a" }]) {
      const store = new MemoryClientStore(); const methods: string[] = [];
      const outbox = new CommandOutbox(store, "host-a", async (method) => { methods.push(method); if (method === "command.getReceipt") return { found: false }; return { session: { sessionId: "session-a", status: "archived" }, ...(receipt ? { receipt } : {}) }; });
      await expect(outbox.execute("session.archive", { sessionId: "session-a" }, "archive-a")).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" }); expect(await store.getCommand("archive-a")).toMatchObject({ state: "receipt_unknown", dispatchState: "possibly_dispatched" });
      await expect(outbox.retry("archive-a")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); expect(methods).toEqual(["session.archive", "command.getReceipt"]);
    }
  });
  it("keeps existing non-catalog response contracts unchanged", async () => {
    const store = new MemoryClientStore(); await new CommandOutbox(store, "host-a", async () => ({ status: "completed" })).execute("session.startTurn", { prompt: "task" }, "start-old"); expect((await store.getCommand("start-old"))?.state).toBe("accepted");
  });
});
