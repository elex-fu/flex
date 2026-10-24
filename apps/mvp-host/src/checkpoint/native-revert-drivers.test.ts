import Database from "better-sqlite3";
import { SessionNativeHandleSchema, type SessionNativeHandle } from "@flyx/mvp-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { bindingDigest } from "./git-driver.js";
import { ClaudeNativeRevertDriver, CodexNativeRevertDriver, NATIVE_REVERT_DRIVER_VERSION, ProviderNativeRevertDriver } from "./native-revert-drivers.js";
import type { ManagedNativeRevertPort, NativeHistoryRevertProof, NativeRevertHandle, NativeRevertHistory, NativeRevertMutation, NativeRevertMutationJournal, NativeRevertMutationReceipt, NativeRevertProvider, TrustedNativeRevertCapability } from "./native-revert-drivers.js";
import type { NativeRevertRequest } from "./revert-types.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** Real SQL uniqueness survives replacing the driver/journal instance; the fake
 * helper below tests the RPC contract without issuing paid Provider requests. */
class Journal implements NativeRevertMutationJournal {
  constructor(readonly db: Database.Database) {}
  async claim(mutation: NativeRevertMutation): Promise<"claimed" | "existing"> {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT mutation FROM requests WHERE operation_id=? OR request_id=?").all(mutation.operationId, mutation.requestId) as { mutation: string }[];
      if (rows.some((row) => bindingDigest(JSON.parse(row.mutation)) !== bindingDigest(mutation))) throw new Error("NATIVE_REQUEST_REBOUND");
      if (rows.length) return "existing";
      this.db.prepare("INSERT INTO requests(operation_id,request_id,mutation) VALUES(?,?,?)").run(mutation.operationId, mutation.requestId, JSON.stringify(mutation));
      return "claimed";
    })();
  }
  async get(operationId: string, requestId: string) {
    const row = this.db.prepare("SELECT operation_id,request_id,mutation,receipt FROM requests WHERE operation_id=? OR request_id=?").get(operationId, requestId) as { operation_id: string; request_id: string; mutation: string; receipt: string | null } | undefined;
    if (row && (row.operation_id !== operationId || row.request_id !== requestId)) throw new Error("NATIVE_REQUEST_REBOUND");
    return row ? { mutation: JSON.parse(row.mutation) as NativeRevertMutation, ...(row.receipt ? { receipt: JSON.parse(row.receipt) as NativeRevertMutationReceipt } : {}) } : undefined;
  }
  async record(mutation: NativeRevertMutation, receipt: NativeRevertMutationReceipt) {
    const row = await this.get(mutation.operationId, mutation.requestId);
    if (!row || bindingDigest(row.mutation) !== bindingDigest(mutation)) throw new Error("NATIVE_REQUEST_REBOUND");
    this.db.prepare("UPDATE requests SET receipt=? WHERE operation_id=? AND request_id=?").run(JSON.stringify(receipt), mutation.operationId, mutation.requestId);
  }
}

function fixture(provider: NativeRevertProvider = "codex") {
  const db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE requests(operation_id TEXT UNIQUE NOT NULL,request_id TEXT UNIQUE NOT NULL,mutation TEXT NOT NULL,receipt TEXT)");
  const original: NativeRevertHandle = { provider, providerInstanceId: `${provider}-1`, workspaceId: "workspace", nativeSessionId: "native-original", workspacePath: "/workspace", configurationFingerprint: "config-sha", verifiedVersion: "locked-native-v1", nativeTurnId: "t3", nativeMessageId: "m3" };
  const target: NativeRevertHandle = { ...original, nativeTurnId: "t2", nativeMessageId: "m2", nativeBeforeMessageId: "m1" };
  const binding: SessionNativeHandle = { v: 1, provider, providerInstanceId: original.providerInstanceId, workspaceId: original.workspaceId, nativeSessionId: original.nativeSessionId, provenance: "native" };
  let capability: TrustedNativeRevertCapability | undefined = { provider, providerInstanceId: original.providerInstanceId,
    configurationFingerprint: original.configurationFingerprint, verifiedVersion: original.verifiedVersion, evidenceId: "trusted-version-evidence",
    driverVersion: NATIVE_REVERT_DRIVER_VERSION, managedBoundaryVersion: "boundary-v1", operations: ["conversation-rewind", "new-conversation"] };
  const histories = new Map<string, NativeRevertHistory>();
  const snapshot = (nativeSessionId: string, ids: string[], digests = ids.map((id) => `content-${id}`)): NativeRevertHistory => ({ provider, nativeSessionId, verifiedVersion: original.verifiedVersion, sourceId: `disk-${nativeSessionId}`, entries: ids.map((id, i) => ({ id, digest: digests[i]! })), quiescent: true, pendingRequest: false });
  histories.set(original.nativeSessionId, snapshot(original.nativeSessionId, provider === "codex" ? ["t1", "t2", "t3"] : ["m1", "m2", "m3"]));
  const calls: NativeRevertMutation[] = [];
  let reads = 0, queries = 0;
  let receipt: NativeRevertMutationReceipt | undefined;
  let lost = false, queryOverride: ((mutation: NativeRevertMutation) => NativeRevertMutationReceipt) | undefined;
  const reply = (mutation: NativeRevertMutation, changes: Partial<NativeRevertMutationReceipt> = {}): NativeRevertMutationReceipt => ({ operationId: mutation.operationId, requestId: mutation.requestId, requestDigest: mutation.requestDigest, sourceId: "managed-helper-stop", state: "completed", quiescent: true, pendingRequest: false, ...changes });
  const port: ManagedNativeRevertPort = {
    kind: "managed-native-revert", boundaryVersion: "boundary-v1",
    async read(handle) { reads++; const result = histories.get(handle.nativeSessionId); if (!result) throw new Error("missing native history"); return structuredClone(result); },
    async execute(mutation) {
      calls.push(structuredClone(mutation));
      if (mutation.command.method === "thread/revert") {
        const history = histories.get(original.nativeSessionId)!;
        history.entries = history.entries.slice(0, history.entries.findIndex((entry) => entry.id === mutation.command.beforeTurnId));
        receipt = reply(mutation);
      } else {
        const next = { ...original, nativeSessionId: "native-new" };
        const entries = histories.get(original.nativeSessionId)!.entries, command = mutation.command;
        const retained = command.method === "forkSession" ? entries.slice(0, entries.findIndex((entry) => entry.id === command.upToMessageId) + 1) : [];
        histories.set(next.nativeSessionId, snapshot(next.nativeSessionId, retained.map((_, i) => `remapped-${i}`), retained.map((entry) => entry.digest)));
        receipt = reply(mutation, { nativeHandle: next });
      }
      if (lost) throw new Error("response_lost");
      return receipt;
    },
    async query(mutation) { queries++; return queryOverride?.(mutation) ?? receipt ?? reply(mutation, { state: "unknown" }); },
  };
  const journal = new Journal(db);
  const options = { resolveHandle: (_binding: SessionNativeHandle, context: { role: "original" | "target" }) => context.role === "original" ? original : target, capability: () => capability, port, journal, now: () => new Date("2026-10-22T10:00:00Z") };
  const driver = provider === "codex" ? new CodexNativeRevertDriver(options) : new ClaudeNativeRevertDriver(options);
  async function request(mode: "revert" | "workspaceRestore" = "revert", phase = "after"): Promise<NativeRevertRequest> {
    const preparation = await driver.prepare({ mode, originalHandle: binding, targetHandle: binding, checkpointId: "cp-real", checkpointPhase: phase });
    if (!preparation.supported) throw new Error(preparation.reason);
    return { operationId: "operation-original", requestId: "request-original", mode, originalHandle: binding, preparation };
  }
  return { db, original, target, binding, histories, driver, options, port, journal, calls, request, reply,
    get reads() { return reads; }, get queries() { return queries; },
    setCapability(value: TrustedNativeRevertCapability | undefined) { capability = value; },
    get capability() { return capability!; },
    loseResponse() { lost = true; }, queryWith(value: typeof queryOverride) { queryOverride = value; } };
}

describe("Provider native revert proof contract", () => {
  it("derives the Codex revert boundary turn from exact native before/after boundaries", async () => {
    const before = fixture(), after = fixture();
    expect((await before.driver.apply(await before.request("revert", "before"))).state).toBe("applied");
    expect(before.calls[0]!.command).toEqual({ method: "thread/revert", threadId: "native-original", beforeTurnId: "t2" });
    expect((await after.driver.apply(await after.request())).state).toBe("applied");
    expect(after.calls[0]!.command).toEqual({ method: "thread/revert", threadId: "native-original", beforeTurnId: "t3" });
  });
  it("queries the original Codex step after response loss and never rolls back twice across driver recreation", async () => {
    const f = fixture(), request = await f.request(); f.loseResponse();
    f.queryWith((mutation) => f.reply(mutation, { state: "unknown" }));
    const proof = await f.driver.apply(request);
    expect(proof.state).toBe("applied"); expect(proof.requestId).toBe(request.requestId);
    expect((proof as NativeHistoryRevertProof).nativeHistoryHandle!.nativeTurnId).toBe("t2");
    expect(SessionNativeHandleSchema.safeParse(proof.nativeHandle).success).toBe(true);
    const restarted = new CodexNativeRevertDriver({ ...f.options, journal: new Journal(f.db) });
    expect((await restarted.apply(structuredClone(request))).state).toBe("applied");
    expect(f.calls).toHaveLength(1); expect(f.queries).toBeGreaterThan(1);
  });
  it("does not infer application from a stopped helper while original history remains unchanged", async () => {
    const f = fixture(), request = await f.request();
    await f.journal.claim({ operationId: request.operationId, requestId: request.requestId, requestDigest: bindingDigest(request), originalHandle: f.original, command: { method: "thread/revert", threadId: "native-original", beforeTurnId: "t3" } });
    expect((await f.driver.query(request)).state).toBe("unknown");
    expect((await f.driver.apply(request)).state).toBe("unknown"); expect(f.calls).toHaveLength(0);
  });
  it("keeps pending native helper operations unknown even if target history already matches", async () => {
    const f = fixture(), request = await f.request(); f.loseResponse();
    f.queryWith((mutation) => f.reply(mutation, { state: "unknown", quiescent: false, pendingRequest: true }));
    const result = await f.driver.apply(request);
    expect(result.state).toBe("unknown"); expect(result.pendingRequest).toBe(true);
    await f.driver.apply(request); expect(f.calls).toHaveLength(1);
  });
  it("rejects a different prefix with the same native Turn count", async () => {
    const f = fixture(), request = await f.request();
    await f.driver.apply(request);
    f.histories.get("native-original")!.entries = [{ id: "t1", digest: "external-change" }, { id: "t2", digest: "content-t2" }];
    expect((await f.driver.query(request)).state).toBe("unknown"); expect(f.calls).toHaveLength(1);
  });
  it("never sends when preparation changed or the immutable identity was reused", async () => {
    const f = fixture(), request = await f.request();
    await f.driver.apply(request);
    await expect(f.driver.apply({ ...request, requestId: "replacement-request" })).rejects.toThrow("NATIVE_REQUEST_REBOUND");
    await expect(f.driver.apply({ ...request, operationId: "replacement-operation" })).rejects.toThrow("NATIVE_REQUEST_REBOUND");
    const changed = structuredClone(request); changed.preparation.targetBinding = "wrong-target";
    await expect(f.driver.apply(changed)).rejects.toThrow("exact native request"); expect(f.calls).toHaveLength(1);
  });
  it("requires exact trusted version, configuration and managed boundary before reading native history", async () => {
    const f = fixture(); f.setCapability({ ...f.capability, verifiedVersion: "other-version" });
    expect(await f.driver.prepare({ mode: "revert", originalHandle: f.binding, targetHandle: f.binding, checkpointId: "cp", checkpointPhase: "after" })).toMatchObject({ supported: false });
    expect(f.reads).toBe(0);
    const missing = new ProviderNativeRevertDriver({});
    expect(await missing.prepare({ mode: "revert", originalHandle: f.binding, targetHandle: f.binding, checkpointId: "cp", checkpointPhase: "after" })).toMatchObject({ supported: false });
  });
  it("invalidates a prepared transition if trusted capability evidence changes before apply", async () => {
    const f = fixture(), request = await f.request(); f.setCapability({ ...f.capability, evidenceId: "replacement-evidence" });
    await expect(f.driver.apply(request)).rejects.toThrow("exact native request"); expect(f.calls).toHaveLength(0);
  });
  it("blocks stale or duplicate native anchors without using Flyx Turn ordinals", async () => {
    const f = fixture(); f.target.nativeTurnId = "flyx-turn-2";
    await expect(f.request()).rejects.toThrow("persisted native boundary");
    f.target.nativeTurnId = "t2"; f.histories.get("native-original")!.entries = [{ id: "t2", digest: "a" }, { id: "t2", digest: "b" }];
    await expect(f.request()).rejects.toThrow("malformed persisted history"); expect(f.calls).toHaveLength(0);
  });
  it("queries are read-only and cannot authorize an unjournalled request", async () => {
    const f = fixture(), request = await f.request();
    expect((await f.driver.query(request)).state).toBe("unknown"); expect(f.queries).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it("concurrent apply calls consume one durable send authorization", async () => {
    const f = fixture(), request = await f.request();
    await Promise.all([f.driver.apply(request), f.driver.apply(structuredClone(request))]);
    expect(f.calls).toHaveLength(1);
    expect((await f.driver.query(request)).state).toBe("applied");
  });
  it("does not mix private native metadata from a different canonical workspace", async () => {
    const f = fixture(); f.target.workspaceId = "different-workspace";
    await expect(f.request()).rejects.toThrow("different canonical Session binding"); expect(f.calls).toHaveLength(0);
  });
  it("a not_dispatched proof is read-only and never authorizes a second native mutation", async () => {
    const f = fixture(), request = await f.request();
    await f.journal.claim({ operationId: request.operationId, requestId: request.requestId, requestDigest: bindingDigest(request), originalHandle: f.original, command: { method: "thread/revert", threadId: "native-original", beforeTurnId: "t3" } });
    f.queryWith((mutation) => f.reply(mutation, { state: "not_dispatched" }));
    expect((await f.driver.apply(request)).state).toBe("not_applied"); expect(f.calls).toHaveLength(0);
  });
  it("does not accept a helper receipt rebound to a different native request", async () => {
    const f = fixture(), request = await f.request();
    f.queryWith((mutation) => f.reply(mutation, { requestId: "unrelated" }));
    expect((await f.driver.apply(request)).state).toBe("unknown"); expect(f.calls).toHaveLength(1);
  });
  it("forks Claude at the inclusive real message and verifies semantic prefix despite UUID remapping", async () => {
    const f = fixture("claude"), request = await f.request();
    const proof = await f.driver.apply(request);
    expect(f.calls[0]!.command).toEqual({ method: "forkSession", sessionId: "native-original", upToMessageId: "m2" });
    expect(proof.state).toBe("applied"); expect((proof.nativeHandle as NativeRevertHandle).nativeSessionId).toBe("native-new");
    expect((proof as NativeHistoryRevertProof).nativeHistoryHandle).toMatchObject({ nativeMessageId: "remapped-1", nativeBeforeMessageId: "remapped-0" });
    expect((proof as NativeHistoryRevertProof).nativeHistoryHandle!.nativeTurnId).toBeUndefined();
    expect(SessionNativeHandleSchema.safeParse(proof.nativeHandle).success).toBe(true);
    expect(f.histories.get("native-original")!.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
  });
  it("uses the actual preceding Claude message for before checkpoints", async () => {
    const f = fixture("claude");
    expect((await f.driver.apply(await f.request("revert", "before"))).state).toBe("applied");
    expect(f.calls[0]!.command).toMatchObject({ method: "forkSession", upToMessageId: "m1" });
  });
  it("lost Claude fork response stays unknown when original fork cannot be uniquely located", async () => {
    const f = fixture("claude"), request = await f.request(); f.loseResponse();
    f.queryWith((mutation) => f.reply(mutation, { state: "unknown" }));
    expect((await f.driver.apply(request)).state).toBe("unknown");
    expect((await f.driver.query(request)).state).toBe("unknown");
    await f.driver.apply(request); expect(f.calls).toHaveLength(1);
    expect(f.histories.has("native-new")).toBe(true); // Candidate existence is insufficient.
  });
  it("a stored completed fork receipt cannot become a not_dispatched proof", async () => {
    const f = fixture("claude"), request = await f.request();
    expect((await f.driver.apply(request)).state).toBe("applied");
    f.queryWith((mutation) => f.reply(mutation, { state: "not_dispatched" }));
    expect((await f.driver.query(request)).state).toBe("unknown"); expect(f.calls).toHaveLength(1);
  });
  it("requires both exact fork content and preserved original conversation", async () => {
    const f = fixture("claude"), request = await f.request(); await f.driver.apply(request);
    f.histories.get("native-new")!.entries = [{ id: "remapped-0", digest: "wrong-content" }];
    expect((await f.driver.query(request)).state).toBe("unknown");
    const g = fixture("claude"), other = await g.request(); await g.driver.apply(other);
    g.histories.get("native-original")!.entries = [];
    expect((await g.driver.query(other)).state).toBe("unknown");
  });
  it.each(["claude", "codex"] as const)("workspaceRestore creates a verified empty %s conversation", async (provider) => {
    const f = fixture(provider), request = await f.request("workspaceRestore");
    const proof = await f.driver.apply(request);
    expect(proof.state).toBe("applied"); expect((proof.nativeHandle as NativeRevertHandle).nativeSessionId).not.toBe(f.original.nativeSessionId);
    expect((proof as NativeHistoryRevertProof).nativeHistoryHandle).toMatchObject({ historyContinuity: "discontinuous" });
    expect((proof as NativeHistoryRevertProof).nativeHistoryHandle!.nativeTurnId).toBeUndefined();
    expect((proof as NativeHistoryRevertProof).nativeHistoryHandle!.nativeMessageId).toBeUndefined();
    expect(SessionNativeHandleSchema.safeParse(proof.nativeHandle).success).toBe(true);
    expect(f.calls[0]!.command).toEqual({ method: "newConversation", provider });
    expect(f.histories.get("native-original")!.entries).toHaveLength(3);
  });
});
