import { describe, expect, it } from "vitest";
import { WORKTREE_CAPABILITY, type WorktreeCommandResult } from "@flyx/mvp-protocol";
import { WorktreeClient, type WorktreeRpcPort } from "./worktree-client.js";
const worktreeId = "wt_10000000-0000-4000-8000-000000000000";
const operationId = "20000000-0000-4000-8000-000000000000";
const evidenceId = "30000000-0000-4000-8000-000000000000";
function value(commandId = "stable-command", kind: "create" | "archive" | "restore" = "create"): WorktreeCommandResult {
  return { commandId, receiptState: "accepted", reused: false,
    operation: { operationId, worktreeId, kind, state: "pending", stage: "accepted", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" },
    worktree: { worktreeId, repositoryId: "repo-one", workspaceId: "registered-workspace", state: "creating", revision: 0, directoryName: worktreeId },
  };
}
class Rpc implements WorktreeRpcPort {
  supported = true; response: unknown = value(); error: Error | undefined;
  readonly calls: Array<{ method: string; payload: unknown; commandId?: string }> = [];
  supports(capability: string) { return this.supported && capability === WORKTREE_CAPABILITY; }
  async request<T>(method: string, payload?: unknown, commandId?: string): Promise<T> {
    this.calls.push({ method, payload, ...(commandId ? { commandId } : {}) });
    if (this.error) throw this.error; return this.response as T;
  }
}
function fixture() { const rpc = new Rpc(); return { rpc, client: new WorktreeClient(rpc) }; }

describe("typed explicit worktree client", () => {
  it("requires the negotiated server capability and rejects peer paths or invalid refs without sending", async () => {
    const f = fixture(); f.rpc.supported = false;
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one" }, "stable-command")).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
    expect(f.rpc.calls).toHaveLength(0); f.rpc.supported = true;
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one", ref: "--upload-pack=evil" }, "stable-command")).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one", path: "/private/host" } as never, "stable-command")).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(f.rpc.calls).toHaveLength(0);
  });
  it("normalizes create defaults, preserves the caller command ID, and sends exact archive/restore DTOs", async () => {
    const f = fixture(); expect(await f.client.create({ sessionId: "source", repositoryId: "repo-one" }, "stable-command")).toEqual(value());
    expect(f.rpc.calls[0]).toEqual({ method: "worktree.create", payload: { sessionId: "source", repositoryId: "repo-one", ref: "HEAD", branchMode: "detached" }, commandId: "stable-command" });
    f.rpc.response = value("archive", "archive"); await f.client.archive({ sessionId: "source", worktreeId, expectedRevision: 1 }, "archive");
    f.rpc.response = value("restore", "restore"); await f.client.restore({ sessionId: "source", worktreeId, expectedRevision: 2 }, "restore");
    expect(f.rpc.calls.slice(1).map((call) => call.method)).toEqual(["worktree.archive", "worktree.restore"]);
  });
  it("looks up saved unknown receipts without retransmitting and sends independent explicit recovery command IDs", async () => {
    const f = fixture(), original = value(); original.receiptState = "outcome_unknown"; original.operation.state = "outcome_unknown";
    const { commandId, receiptState, reused, ...response } = original;
    f.rpc.response = { found: true, commandId, method: "worktree.create", state: receiptState, response, updatedAt: "2026-10-15T00:00:01Z" };
    expect(await f.client.getReceipt({ sessionId: "source", commandId })).toMatchObject({ found: true, state: "outcome_unknown" });
    expect(f.rpc.calls).toEqual([{ method: "worktree.getReceipt", payload: { sessionId: "source", commandId } }]);
    f.rpc.response = value("inspect-command"); await f.client.reconcile({ sessionId: "source", operationId }, "inspect-command");
    f.rpc.response = value("resume-command"); await f.client.resume({ sessionId: "source", operationId, evidenceId }, "resume-command");
    expect(f.rpc.calls.slice(1)).toEqual([
      { method: "worktree.reconcile", payload: { sessionId: "source", operationId }, commandId: "inspect-command" },
      { method: "worktree.resume", payload: { sessionId: "source", operationId, evidenceId }, commandId: "resume-command" },
    ]);
  });
  it("validates public response shape and resource identity before exposing a receipt or operation", async () => {
    const f = fixture(); f.rpc.response = { ...value(), path: "/private/data" };
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one" }, "stable-command")).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    f.rpc.response = value("another-command");
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one" }, "stable-command")).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    f.rpc.response = { ...value(), worktree: { ...value().worktree, worktreeId: "wt_40000000-0000-4000-8000-000000000000" } };
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one" }, "stable-command")).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    f.rpc.response = { found: false, commandId: "other" };
    await expect(f.client.getReceipt({ sessionId: "source", commandId: "stable-command" })).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    const { commandId, receiptState, reused, ...result } = value(); f.rpc.response = result;
    await expect(f.client.getOperation({ sessionId: "source", operationId: "50000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
  });
  it("queries bounded public pages without commands and propagates transport failure without retry", async () => {
    const f = fixture(); f.rpc.response = { worktrees: [value().worktree], nextWorktreeId: worktreeId };
    expect(await f.client.list({ sessionId: "source", limit: 1 })).toEqual(f.rpc.response);
    expect(f.rpc.calls[0]).toEqual({ method: "worktree.list", payload: { sessionId: "source", limit: 1 } });
    f.rpc.error = new Error("connection lost");
    await expect(f.client.create({ sessionId: "source", repositoryId: "repo-one" }, "saved-command")).rejects.toThrow("connection lost");
    expect(f.rpc.calls.filter((call) => call.commandId === "saved-command")).toHaveLength(1);
  });
});
