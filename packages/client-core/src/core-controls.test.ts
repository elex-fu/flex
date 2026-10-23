import { describe, expect, it, vi } from "vitest";
import { CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, RecoveryCapability, SESSION_CATALOG_CAPABILITY, WORKTREE_CAPABILITY, type RecoveryEvidence, type SessionSnapshotV2, type SessionSummaryV2, type WorktreeResult } from "@flyx/mvp-protocol";
import { CoreControls, checkpointReferences, recoveryWritePayload, worktreeSessionCommandId, type CoreControlPort, type CoreSelection } from "./core-controls.js";
import { MemoryClientStore } from "./host-profile-store.js";
import { CommandOutbox } from "./command-outbox.js";
import { ClientError } from "./common.js";
import type { ClientState } from "./types.js";

const now = Date.parse("2026-10-22T00:00:00Z");
const original = "00000000-0000-4000-8000-000000000001";
const summary = (sessionId = "session", workspaceId = "workspace"): SessionSummaryV2 => ({ sessionId, workspaceId, providerInstanceId: "provider", provider: "claude", title: "Session", status: "active", activityState: "idle", revision: 3, headSequence: 1, residency: "unloaded", nativeSessionAvailable: false, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
const evidence: RecoveryEvidence = { evidenceId: "original-evidence", sessionId: "session", turnId: "original-turn", attemptId: "original-attempt", recoveryRevision: 11, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), processState: "stopped", workspaceState: "clear", nativeState: "unknown", nextSteps: ["inspect", "acknowledge"] };
const worktree: WorktreeResult = { worktree: { worktreeId: `wt_${original}`, workspaceId: "isolated-workspace", repositoryId: "repository", state: "active", revision: 1, directoryName: `wt_${original}` }, operation: { operationId: original, worktreeId: `wt_${original}`, kind: "create", state: "completed", stage: "published", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } };
const selection: CoreSelection = { hostId: "host", sessionId: "session", transportGeneration: 1, replicaGeneration: 1 };
function fixture() {
  const store = new MemoryClientStore();
  const state: ClientState = { connection: "online", sync: "synced", transportGeneration: 1, pairingRequired: false, profile: { hostId: "host", label: "Host", hostPublicKey: "pub", signingPublicKey: "sign", fingerprint: "fingerprint", endpoints: [] } };
  let snapshot: SessionSnapshotV2 = { session: summary(), pendingApprovals: [] };
  const handlers = new Map<string, (payload: unknown, id?: string) => unknown | Promise<unknown>>();
  const remote = new Map<string, { method: string; response: unknown }>();
  const request = vi.fn(async (method: string, payload: unknown = {}, id?: string): Promise<unknown> => {
    if (handlers.has(method)) return handlers.get(method)!(payload, id);
    const input = payload as Record<string, string>;
    switch (method) {
      case "session.list": return { sessions: [summary()] };
      case "workspace.list": return { workspaces: [{ workspaceId: "workspace", repositoryId: "repository", label: "Workspace", state: "active", kind: "local" }] };
      case "provider.list": return { providerInstances: [{ providerInstanceId: "provider", provider: "claude", state: "configured", verification: { state: "verified" } }] };
      case "session.getSnapshot": return structuredClone(snapshot);
      case "session.recovery.inspect": return structuredClone(evidence);
      case "session.recovery.acknowledge": return { operationId: "recovery-operation", sessionId: "session", turnId: "original-turn", attemptId: "original-attempt", state: "completed", gate: "released", turnStatus: "failed", recoveryRevision: 12 };
      case "worktree.create": return { ...worktree, commandId: id, receiptState: "completed", reused: false };
      case "worktree.list": return { worktrees: [worktree.worktree] };
      case "worktree.getOperation": return worktree;
      case "worktree.getReceipt": return { found: true, commandId: input.commandId, method: "worktree.create", state: "completed", response: worktree, updatedAt: new Date(now).toISOString() };
      case "session.createNew": { const session = summary("created-session", input.workspaceId); return { session, receipt: { commandId: id, targetSessionId: session.sessionId, state: "completed" } }; }
      case "command.getReceipt": { const item = remote.get(input.commandId!); return item ? { found: true, commandId: input.commandId, method: item.method, state: "completed", response: item.response } : { found: false }; }
      default: throw new Error(`Unexpected method ${method}`);
    }
  });
  const outbox = new CommandOutbox(store, "host", async (method, payload, id) => { const result = await request(method, payload, id); if (id) remote.set(id, { method, response: result }); return result; });
  const capabilities = new Set<string>([SESSION_CATALOG_CAPABILITY, RecoveryCapability, WORKTREE_CAPABILITY, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY]);
  const port: CoreControlPort = { store, supportsCapability: (name) => capabilities.has(name), getState: () => structuredClone(state), request: <T>(method: string, payload?: unknown) => request(method, payload) as Promise<T>, command: <T>(method: string, payload?: unknown, id?: string) => outbox.execute<T>(method, payload, id), queryCommandReceipt: (id) => outbox.queryReceipt(id), retrySynchronization: vi.fn(async () => {}) };
  let generated = 0;
  const controller = () => { const controls = new CoreControls(port, { commandId: () => generated++ ? `command-${generated}` : original, now: () => now }); controls.select(selection); return controls; };
  return { controller, port, store, state, request, handlers, remote, capabilities, setSnapshot: (value: SessionSnapshotV2) => { snapshot = value; } };
}

describe("core product controls", () => {
  it("resource discovery and metadata selection never dispatch a Provider command", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    expect(controls.getState().workspaces).toHaveLength(1); expect(controls.getState().providers).toHaveLength(1);
    expect(f.request.mock.calls.every(([method]) => ["session.list", "workspace.list", "provider.list", "session.getSnapshot"].includes(method))).toBe(true);
    expect(await f.store.listCommands("host")).toEqual([]);
  });
  it("ignores a late catalog response after Session, replica or transport selection changes", async () => {
    for (const changed of [{ sessionId: "another" }, { replicaGeneration: 2 }, { transportGeneration: 2 }]) {
      const f = fixture(), controls = f.controller(); let resolve!: (value: unknown) => void;
      f.handlers.set("session.list", () => new Promise((done) => { resolve = done; }));
      const loading = controls.refresh(); controls.select({ ...selection, ...changed });
      resolve({ sessions: [summary()] }); await loading;
      expect(controls.getState().sessions).toEqual([]); expect(controls.getState().snapshot).toBeUndefined();
    }
  });
  it("does not let an old recovery inspection or cached/older snapshot restore write authority", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    controls.acceptSnapshot({ session: { ...summary(), revision: 10, activityState: "outcome_unknown" }, pendingApprovals: [] });
    controls.acceptSnapshot({ session: { ...summary(), revision: 9 }, pendingApprovals: [] });
    expect(controls.getState().snapshot?.session.activityState).toBe("outcome_unknown");
    let resolve!: (value: unknown) => void;
    f.handlers.set("session.recovery.inspect", () => new Promise((done) => { resolve = done; }));
    const pending = controls.inspectRecovery({ sessionId: "session", turnId: "original-turn" });
    controls.select({ ...selection, replicaGeneration: 2 }); resolve(evidence); await pending;
    expect(controls.getState().recovery).toBeUndefined();
  });
  it("preserves original attempt, evidence ID and revision and demands explicit unknown acknowledgement", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh(); await controls.inspectRecovery({ sessionId: "session", turnId: "original-turn" });
    await controls.recover("acknowledge", false);
    expect((await f.store.listCommands("host"))).toHaveLength(0);
    await controls.recover("acknowledge", true);
    const write = f.request.mock.calls.find(([method]) => method === "session.recovery.acknowledge");
    expect(write?.[1]).toEqual({ sessionId: "session", turnId: "original-turn", attemptId: "original-attempt", evidenceId: "original-evidence", expectedRecoveryRevision: 11, acknowledgeUnknown: true });
    expect(f.port.retrySynchronization).toHaveBeenCalledOnce();
  });
  it("renders the refreshed authority even when an operation claims its recovery gate was released", async () => {
    const f = fixture(), controls = f.controller();
    f.setSnapshot({ session: { ...summary(), activityState: "outcome_unknown" }, activeTurn: { id: "original-turn", sessionId: "session", commandId: "turn-command", prompt: "Task", status: "outcome_unknown" }, pendingApprovals: [] });
    await controls.refresh(); await controls.inspectRecovery(); await controls.recover("acknowledge", true);
    expect(controls.getState().recoveryOperation?.gate).toBe("released");
    expect(controls.getState().snapshot?.session.activityState).toBe("outcome_unknown");
    expect(f.request.mock.calls.filter(([method]) => method === "session.getSnapshot")).toHaveLength(2);
  });
  it("rejects expired evidence and actions absent from nextSteps before a write", () => {
    expect(() => recoveryWritePayload(evidence, "reconcile", false, now)).toThrow("not offered");
    expect(() => recoveryWritePayload({ ...evidence, expiresAt: new Date(now).toISOString() }, "acknowledge", true, now)).toThrow("expired");
    expect(() => recoveryWritePayload(evidence, "acknowledge", false, now)).toThrow("Explicitly acknowledge");
  });
  it("does not apply consent from an older rendered evidence or an unseen replica generation", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    await controls.inspectRecovery({ sessionId: "session", turnId: "original-turn" });
    await controls.recover("acknowledge", true, "previously-rendered-evidence");
    expect(controls.getState().error).toContain("evidence changed");
    const replica = { sessionId: "session", replicaGeneration: 2 };
    Object.assign(f.port, { replica: { getState: () => replica } });
    await controls.createSession("workspace", "provider", "Fresh");
    expect(controls.getState().error).toContain("connection changed");
    expect(await f.store.listCommands("host")).toEqual([]);
  });
  it("keeps an unknown recovery write in the Outbox and refuses to repeat the same action", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    const both = { ...evidence, nextSteps: ["inspect", "reconcile", "acknowledge"] };
    f.handlers.set("session.recovery.inspect", () => both);
    f.handlers.set("session.recovery.acknowledge", () => { throw new ClientError("REQUEST_TIMEOUT", "Lost response"); });
    await controls.inspectRecovery({ sessionId: "session", turnId: "original-turn" }); await controls.recover("acknowledge", true);
    await controls.inspectRecovery({ sessionId: "session", turnId: "original-turn" }); await controls.recover("acknowledge", true);
    const commands = await f.store.listCommands("host");
    expect(commands).toHaveLength(1); expect(commands[0]?.state).toBe("receipt_unknown");
    expect(f.request.mock.calls.filter(([method]) => method === "session.recovery.acknowledge")).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === "session.recovery.reconcile")).toBe(false);
  });
  it("continues Worktree creation using two stable original receipts across controller recreation", async () => {
    const f = fixture(); let controls = f.controller(); await controls.refresh(); await controls.createWorktree("repository", "HEAD");
    expect((await f.store.listCommands("host"))).toHaveLength(1);
    controls = f.controller(); await controls.refresh(); await controls.checkWorktree(original);
    const created = await controls.continueWorktree(original, "provider", "Isolated");
    expect(created?.sessionId).toBe("created-session");
    const sessionId = worktreeSessionCommandId(original);
    expect((await f.store.getCommand(sessionId))?.payload).toEqual({ workspaceId: "isolated-workspace", providerInstanceId: "provider", title: "Isolated" });
    controls = f.controller(); await controls.refresh(); await controls.checkWorktree(original); await controls.continueWorktree(original, "different-provider", "Different title");
    expect(f.request.mock.calls.filter(([method]) => method === "session.createNew")).toHaveLength(1);
    expect((await f.store.listCommands("host"))).toHaveLength(2);
  });
  it("never creates another Session when the original Worktree Session response and receipt are missing", async () => {
    const f = fixture(); let controls = f.controller(); await controls.refresh(); await controls.createWorktree("repository", "HEAD"); await controls.checkWorktree(original);
    f.handlers.set("session.createNew", () => { throw new ClientError("REQUEST_TIMEOUT", "Lost response"); });
    await controls.continueWorktree(original, "provider", "Isolated");
    controls = f.controller(); await controls.refresh(); await controls.checkWorktree(original); await controls.continueWorktree(original, "other", "New");
    expect(f.request.mock.calls.filter(([method]) => method === "session.createNew")).toHaveLength(1);
    const command = await f.store.getCommand(worktreeSessionCommandId(original)); expect(command?.outcomeUnknown).toBe(true);
    expect((await f.store.listCommands("host"))).toHaveLength(2);
  });
  it("does not dispatch Worktree continuation after a selection switch during receipt review", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh(); await controls.createWorktree("repository", "HEAD"); await controls.checkWorktree(original);
    let finish!: (value: unknown) => void;
    const oldGet = f.port.store.getCommand.bind(f.port.store);
    f.port.store.getCommand = async (id) => { if (id === worktreeSessionCommandId(original)) await new Promise((done) => { finish = done; }); return oldGet(id); };
    const continuing = controls.continueWorktree(original, "provider", "Isolated");
    controls.select({ ...selection, sessionId: "another" }); finish(undefined); await continuing;
    expect(f.request.mock.calls.some(([method]) => method === "session.createNew")).toBe(false);
  });
  it("derives natural task boundaries from only complete typed summaries for the selected Session", () => {
    const checkpoint = { checkpointId: "checkpoint", sessionId: "session", workspaceId: "workspace", phase: "after", turnId: "turn", attemptId: "attempt", status: "raced", policyVersion: 1, capturedAt: new Date(now).toISOString(), samplingConsistency: "raced", unsupportedCount: 1, warnings: ["Concurrent changes"] };
    const result = checkpointReferences([{ sessionId: "session", metadata: { ...checkpoint, message: "Checkpoint captured" }, content: { inline: {} } }, { sessionId: "other", content: { ...checkpoint, checkpointId: "foreign" } }, { sessionId: "session", content: { turnId: "incomplete", attemptId: "fake" } }], "session");
    expect(result).toEqual([checkpoint]);
  });
  it("requires every preview page, explicit confirmation and current negotiated revert support", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    const preview = { planId: "plan", sessionId: "session", checkpointId: "before", expiresAt: new Date(now + 60_000).toISOString(), expectedWorkspaceDigest: "a".repeat(64), expectedIndexDigest: "b".repeat(64), expectedSessionRevision: 3, epoch: "epoch", runtimeGeneration: 1, nativeHandleBinding: "c".repeat(64), supported: true, unsupportedCount: 0, unsupported: [], totalFiles: 2, files: [], nextCursor: "next-page" };
    f.handlers.set("checkpoint.previewRevert", () => preview);
    f.handlers.set("checkpoint.getPreview", () => { const { nextCursor: _cursor, ...page } = preview; return page; });
    await controls.previewRevert("before"); await controls.executeRevert(true);
    expect((await f.store.listCommands("host"))).toHaveLength(0);
    await controls.morePreview(); await controls.executeRevert(false);
    expect((await f.store.listCommands("host"))).toHaveLength(0);
    f.capabilities.delete(CHECKPOINT_REVERT_CAPABILITY); await controls.executeRevert(true);
    expect(controls.getState().error).toContain("complete Provider and workspace revert");
    expect((await f.store.listCommands("host"))).toHaveLength(0);
  });
  it("shows Host revert progress and retains one unknown revert command until receipt inspection", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    f.handlers.set("checkpoint.previewRevert", () => ({ planId: "plan", sessionId: "session", checkpointId: "before", expiresAt: new Date(now + 60_000).toISOString(), expectedWorkspaceDigest: "a".repeat(64), expectedIndexDigest: "b".repeat(64), expectedSessionRevision: 3, epoch: "epoch", runtimeGeneration: 1, nativeHandleBinding: "c".repeat(64), supported: true, unsupportedCount: 0, unsupported: [], totalFiles: 0, files: [] }));
    f.handlers.set("checkpoint.executeRevert", () => { throw new ClientError("REQUEST_TIMEOUT", "Uncertain native response"); });
    await controls.previewRevert("before"); await controls.executeRevert(true); await controls.executeRevert(true);
    expect(f.request.mock.calls.filter(([method]) => method === "checkpoint.executeRevert")).toHaveLength(1);
    const commands = await f.store.listCommands("host"); expect(commands).toHaveLength(1); expect(commands[0]?.dispatchState).toBe("possibly_dispatched");
    const operation = { operationId: "revert", sessionId: "session", checkpointId: "before", mode: "revert", stage: "partial_failure", status: "blocked", revision: 2, sessionRevision: 4, totalSteps: 3, appliedSteps: 1, recoveryRequired: true, safetyCheckpointId: "safety" };
    f.handlers.set("checkpoint.getRevertOperation", () => operation);
    f.handlers.set("checkpoint.inspectRevert", () => ({ evidenceId: "revert-evidence", operationId: "revert", sessionId: "session", expectedSessionRevision: 4, operationRevision: 2, expiresAt: new Date(now + 60_000).toISOString(), resumable: false, safetyRollbackAvailable: true, reason: "NATIVE_OUTCOME_UNKNOWN" }));
    await controls.inspectRevert("revert");
    expect(controls.getState().revert?.appliedSteps).toBe(1); expect(controls.getState().revertEvidence?.safetyRollbackAvailable).toBe(true);
    f.handlers.set("checkpoint.rollbackToSafety", () => ({ ...operation, operationId: "safety-restore", parentOperationId: "revert", mode: "workspaceRestore" }));
    await controls.recoverRevert("rollbackToSafety", true);
    const recovery = f.request.mock.calls.find(([method]) => method === "checkpoint.rollbackToSafety");
    expect(recovery?.[1]).toMatchObject({ operationId: "revert", evidenceId: "revert-evidence", expectedSessionRevision: 4, confirmation: true });
    expect(f.request.mock.calls.filter(([method]) => method === "checkpoint.executeRevert")).toHaveLength(1);
  });
  it("gates unsupported capabilities and refuses unregistered repository paths without writing", async () => {
    const f = fixture(), controls = f.controller(); f.capabilities.clear(); await controls.refresh();
    expect(controls.getState().error).toContain("catalog");
    await controls.createWorktree("/arbitrary/path", "HEAD"); expect(controls.getState().error).toContain("registered repository");
    expect(await f.store.listCommands("host")).toEqual([]);
  });
  const activeTurnSnapshot = (): SessionSnapshotV2 => ({ session: { ...summary(), activityState: "running" }, activeTurn: { id: "original-turn", sessionId: "session", commandId: "turn-command", status: "running", prompt: "Task" }, pendingApprovals: [] });
  const interruptResponse = (id?: string) => ({ sessionId: "session", turnId: "original-turn", status: "accepted", receipt: { commandId: id, targetSessionId: "session", state: "completed" } });
  it("interrupts the active Turn through the Outbox with the shown revision and refreshes authority", async () => {
    const f = fixture(), controls = f.controller(); f.setSnapshot(activeTurnSnapshot()); await controls.refresh();
    f.handlers.set("session.interrupt", (_payload: unknown, id?: string) => interruptResponse(id));
    await controls.interrupt();
    const write = f.request.mock.calls.find(([method]) => method === "session.interrupt");
    expect(write?.[1]).toEqual({ sessionId: "session", expectedRevision: 3 });
    expect(write?.[2]).toBe(original);
    expect(f.port.retrySynchronization).toHaveBeenCalled();
    expect(controls.getState().error).toBeUndefined();
  });
  it("refuses a second interrupt while the original command receipt is still pending", async () => {
    const f = fixture(), controls = f.controller(); f.setSnapshot(activeTurnSnapshot()); await controls.refresh();
    await f.store.putCommand({ commandId: "original-interrupt", hostId: "host", method: "session.interrupt", payloadHash: "hash", payload: { sessionId: "session" }, createdAt: new Date(now).toISOString(), state: "sent" });
    await controls.interrupt();
    expect(controls.getState().error).toContain("original command receipt");
    expect(f.request.mock.calls.some(([method]) => method === "session.interrupt")).toBe(false);
    expect((await f.store.listCommands("host"))).toHaveLength(1);
  });
  it("requires an interruptible active Turn before any write", async () => {
    const f = fixture(), controls = f.controller(); await controls.refresh();
    await controls.interrupt();
    expect(controls.getState().error).toContain("active Turn");
    f.setSnapshot({ ...activeTurnSnapshot(), session: { ...summary(), activityState: "outcome_unknown" } }); await controls.refresh();
    await controls.interrupt();
    expect(controls.getState().error).toContain("active Turn");
    expect(await f.store.listCommands("host")).toEqual([]);
  });
  it("keeps interrupt on the negotiated Session catalog only, so pre-catalog Hosts need the legacy command", async () => {
    const f = fixture(), controls = f.controller(); f.setSnapshot(activeTurnSnapshot()); await controls.refresh();
    f.capabilities.delete(SESSION_CATALOG_CAPABILITY);
    await controls.interrupt();
    expect(controls.getState().error).toContain("Session catalog");
    expect(f.request.mock.calls.some(([method]) => method === "session.interrupt")).toBe(false);
    expect(await f.store.listCommands("host")).toEqual([]);
  });
  it("isolates a late interrupt response after the selection changed", async () => {
    const f = fixture(), controls = f.controller(); f.setSnapshot(activeTurnSnapshot()); await controls.refresh();
    let finish!: (value: unknown) => void;
    f.handlers.set("session.interrupt", () => new Promise((done) => { finish = done; }));
    const pending = controls.interrupt();
    await vi.waitFor(() => { if (typeof finish !== "function") throw new Error("interrupt was not dispatched"); });
    controls.select({ ...selection, replicaGeneration: 2 });
    finish(interruptResponse()); await pending;
    expect(controls.getState().error).toBeUndefined();
    expect(controls.getState().snapshot).toBeUndefined();
    expect(f.request.mock.calls.filter(([method]) => method === "session.interrupt")).toHaveLength(1);
  });
});
