import {
  WORKTREE_CAPABILITY, WorktreeCreateRpcSchema, WorktreeExistingRpcSchema, WorktreeListRpcSchema,
  WorktreeOperationRpcSchema, WorktreeResumeRpcSchema, WorktreeReceiptRpcSchema, WorktreeCommandResultSchema,
  WorktreeListResultSchema, WorktreeReceiptResultSchema, WorktreeResultSchema,
  type WorktreeCommandResult, type WorktreeCreateRpc, type WorktreeExistingRpc, type WorktreeListResult,
  type WorktreeOperationRpc, type WorktreeResumeRpc, type WorktreeReceiptRpc, type WorktreeReceiptResult, type WorktreeResult,
} from "@flyx/mvp-protocol";
import { ClientError } from "./common.js";

export interface WorktreeRpcPort {
  supports(capability: string): boolean;
  request<T = unknown>(method: string, payload?: unknown, commandId?: string): Promise<T>;
}
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function parse<T>(schema: Schema<T>, value: unknown, code: "INVALID_PAYLOAD" | "INVALID_RPC_RESPONSE"): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new ClientError(code, "Managed worktree data is invalid"); return parsed.data;
}
function paired(result: WorktreeResult): WorktreeResult {
  if (result.operation.worktreeId !== result.worktree.worktreeId) throw new ClientError("INVALID_RPC_RESPONSE", "Worktree result refers to different resources");
  return result;
}
/** Explicit commands only. Unknown saved commands are inspected; this helper never retries or drains an Outbox. */
export class WorktreeClient {
  constructor(readonly rpc: WorktreeRpcPort) {}
  ready(): boolean { return this.rpc.supports(WORKTREE_CAPABILITY); }
  private requireCapability(): void { if (!this.ready()) throw new ClientError("CAPABILITY_REQUIRED", "Host does not support managed worktrees"); }
  async list(input: { sessionId: string; afterWorktreeId?: string; limit?: number }): Promise<WorktreeListResult> {
    this.requireCapability(); const payload = parse(WorktreeListRpcSchema, input, "INVALID_PAYLOAD");
    return parse(WorktreeListResultSchema, await this.rpc.request("worktree.list", payload), "INVALID_RPC_RESPONSE");
  }
  async getOperation(input: WorktreeOperationRpc): Promise<WorktreeResult> {
    this.requireCapability(); const payload = parse(WorktreeOperationRpcSchema, input, "INVALID_PAYLOAD");
    const result = paired(parse(WorktreeResultSchema, await this.rpc.request("worktree.getOperation", payload), "INVALID_RPC_RESPONSE"));
    if (result.operation.operationId !== payload.operationId) throw new ClientError("INVALID_RPC_RESPONSE", "Operation response does not match the requested operation");
    return result;
  }
  async getReceipt(input: WorktreeReceiptRpc): Promise<WorktreeReceiptResult> {
    this.requireCapability(); const payload = parse(WorktreeReceiptRpcSchema, input, "INVALID_PAYLOAD");
    const result = parse(WorktreeReceiptResultSchema, await this.rpc.request("worktree.getReceipt", payload), "INVALID_RPC_RESPONSE");
    if (result.commandId !== payload.commandId) throw new ClientError("INVALID_RPC_RESPONSE", "Receipt response does not match the original command");
    if (result.found) paired(result.response);
    return result;
  }
  async create(input: Omit<WorktreeCreateRpc, "ref" | "branchMode"> & { ref?: string; branchMode?: "detached" | "generated" }, commandId: string): Promise<WorktreeCommandResult> {
    return this.command("worktree.create", parse(WorktreeCreateRpcSchema, input, "INVALID_PAYLOAD"), commandId);
  }
  async archive(input: WorktreeExistingRpc, commandId: string): Promise<WorktreeCommandResult> { return this.command("worktree.archive", parse(WorktreeExistingRpcSchema, input, "INVALID_PAYLOAD"), commandId); }
  async restore(input: WorktreeExistingRpc, commandId: string): Promise<WorktreeCommandResult> { return this.command("worktree.restore", parse(WorktreeExistingRpcSchema, input, "INVALID_PAYLOAD"), commandId); }
  async reconcile(input: WorktreeOperationRpc, commandId: string): Promise<WorktreeCommandResult> { return this.command("worktree.reconcile", parse(WorktreeOperationRpcSchema, input, "INVALID_PAYLOAD"), commandId); }
  async resume(input: WorktreeResumeRpc, commandId: string): Promise<WorktreeCommandResult> { return this.command("worktree.resume", parse(WorktreeResumeRpcSchema, input, "INVALID_PAYLOAD"), commandId); }
  private async command(method: string, payload: WorktreeCreateRpc | WorktreeExistingRpc | WorktreeOperationRpc | WorktreeResumeRpc, commandId: string): Promise<WorktreeCommandResult> {
    this.requireCapability();
    if (!commandId || commandId.length > 128) throw new ClientError("INVALID_PAYLOAD", "A stable worktree command ID is required");
    const result = parse(WorktreeCommandResultSchema, await this.rpc.request(method, payload, commandId), "INVALID_RPC_RESPONSE"); paired(result);
    if (result.commandId !== commandId || "worktreeId" in payload && result.worktree.worktreeId !== payload.worktreeId
      || "operationId" in payload && result.operation.operationId !== payload.operationId
      || "repositoryId" in payload && result.worktree.repositoryId !== payload.repositoryId
      || ["worktree.create", "worktree.archive", "worktree.restore"].includes(method) && result.operation.kind !== method.slice(9)) throw new ClientError("INVALID_RPC_RESPONSE", "Worktree response does not match the original command");
    return result;
  }
}
