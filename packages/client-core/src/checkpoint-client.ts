import {
  CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY,
  CheckpointGetDiffSchema, CheckpointGetTurnDiffSchema, CheckpointGetSessionDiffSchema, CheckpointGetFileSchema,
  CheckpointDiffPageSchema, CheckpointDiffFileSchema, CheckpointPreviewRevertSchema, CheckpointGetPreviewSchema, CheckpointPreviewPageSchema,
  CheckpointExecuteRevertSchema, CheckpointWorkspaceRestoreSchema, CheckpointRevertOperationQuerySchema, CheckpointInspectRevertSchema,
  CheckpointResumeVerifiedSchema, CheckpointRollbackToSafetySchema, CheckpointRevertOperationSchema, CheckpointRevertEvidenceSchema,
  type CheckpointDiffFile, type CheckpointDiffPage, type CheckpointPreviewPage, type CheckpointRevertOperation, type CheckpointRevertEvidence,
} from "@flyx/mvp-protocol";

export interface CheckpointClientOptions {
  request(method: string, payload: unknown, commandId?: string): Promise<unknown>;
  supports(capability: string): boolean;
}
export type CheckpointDiffRequest = Omit<ReturnType<typeof CheckpointGetDiffSchema.parse>, "layer" | "limit"> & { layer?: "workspace" | "index"; limit?: number };
export type CheckpointTurnDiffRequest = Omit<ReturnType<typeof CheckpointGetTurnDiffSchema.parse>, "layer" | "limit"> & { layer?: "workspace" | "index"; limit?: number };
export type CheckpointSessionDiffRequest = Omit<ReturnType<typeof CheckpointGetSessionDiffSchema.parse>, "layer" | "limit"> & { layer?: "workspace" | "index"; limit?: number };
export type CheckpointFileRequest = ReturnType<typeof CheckpointGetFileSchema.parse>;
export type CheckpointPreviewRequest = ReturnType<typeof CheckpointPreviewRevertSchema.parse>;
export type CheckpointPreviewPageRequest = Omit<ReturnType<typeof CheckpointGetPreviewSchema.parse>, "limit"> & { limit?: number };
export type CheckpointExecuteRequest = ReturnType<typeof CheckpointExecuteRevertSchema.parse>;
export type CheckpointOperationRequest = ReturnType<typeof CheckpointRevertOperationQuerySchema.parse>;
export type CheckpointRecoveryRequest = ReturnType<typeof CheckpointResumeVerifiedSchema.parse>;

/** Bind to the authenticated V2 Host RpcClient. Actor, paths, refs and leases never enter requests. */
export class CheckpointClient {
  constructor(private readonly options: CheckpointClientOptions) {}
  async getDiff(value: CheckpointDiffRequest): Promise<CheckpointDiffPage> {
    const input = CheckpointGetDiffSchema.parse(value);
    const result = this.diffPage(await this.request("checkpoint.getDiff", input), input.sessionId);
    this.equal(result.before.checkpointId, input.beforeCheckpointId); this.equal(result.after.checkpointId, input.afterCheckpointId); this.equal(result.layer, input.layer);
    return result;
  }
  async getTurnDiff(value: CheckpointTurnDiffRequest): Promise<CheckpointDiffPage> {
    const input = CheckpointGetTurnDiffSchema.parse(value), result = this.diffPage(await this.request("checkpoint.getTurnDiff", input), input.sessionId);
    for (const checkpoint of [result.before, result.after]) { this.equal(checkpoint.turnId, input.turnId); this.equal(checkpoint.attemptId, input.attemptId); }
    this.equal(result.layer, input.layer); return result;
  }
  async getSessionDiff(value: CheckpointSessionDiffRequest): Promise<CheckpointDiffPage> {
    const input = CheckpointGetSessionDiffSchema.parse(value), result = this.diffPage(await this.request("checkpoint.getSessionDiff", input), input.sessionId);
    this.equal(result.after.checkpointId, input.currentCheckpointId); this.equal(result.layer, input.layer); return result;
  }
  async getFile(value: CheckpointFileRequest): Promise<CheckpointDiffFile> {
    const input = CheckpointGetFileSchema.parse(value), result = CheckpointDiffFileSchema.parse(await this.request("checkpoint.getFile", input));
    this.equal(result.diffId, input.diffId); this.equal(result.file.fileId, input.fileId); this.paths(result); return result;
  }
  async previewRevert(value: CheckpointPreviewRequest): Promise<CheckpointPreviewPage> {
    const input = CheckpointPreviewRevertSchema.parse(value), result = this.previewPage(await this.request("checkpoint.previewRevert", input), input.sessionId);
    this.equal(result.checkpointId, input.checkpointId); this.equal(result.expectedSessionRevision, input.expectedSessionRevision); return result;
  }
  async getPreview(value: CheckpointPreviewPageRequest): Promise<CheckpointPreviewPage> {
    const input = CheckpointGetPreviewSchema.parse(value), result = this.previewPage(await this.request("checkpoint.getPreview", input), input.sessionId);
    this.equal(result.planId, input.planId); return result;
  }
  async executeRevert(value: CheckpointExecuteRequest): Promise<CheckpointRevertOperation> {
    const input = CheckpointExecuteRevertSchema.parse(value);
    this.require(CHECKPOINT_REVERT_CAPABILITY);
    const result = this.operation(await this.request("checkpoint.executeRevert", input, input.commandId), input.sessionId);
    this.equal(result.mode, "revert"); return result;
  }
  /** Explicit raw workspace restoration. The Host can return NEW_CONVERSATION_REQUIRED and keep recovery blocked. */
  async workspaceRestore(value: CheckpointExecuteRequest): Promise<CheckpointRevertOperation> {
    const input = CheckpointWorkspaceRestoreSchema.parse(value), result = this.operation(await this.request("checkpoint.workspaceRestore", input, input.commandId), input.sessionId);
    this.equal(result.mode, "workspaceRestore"); return result;
  }
  async getRevertOperation(value: CheckpointOperationRequest): Promise<CheckpointRevertOperation> {
    const input = CheckpointRevertOperationQuerySchema.parse(value), result = this.operation(await this.request("checkpoint.getRevertOperation", input), input.sessionId);
    this.equal(result.operationId, input.operationId); return result;
  }
  async inspectRevert(value: CheckpointOperationRequest): Promise<CheckpointRevertEvidence> {
    const input = CheckpointInspectRevertSchema.parse(value), result = CheckpointRevertEvidenceSchema.parse(await this.request("checkpoint.inspectRevert", input));
    this.equal(result.sessionId, input.sessionId); this.equal(result.operationId, input.operationId); return result;
  }
  async resumeVerified(value: CheckpointRecoveryRequest): Promise<CheckpointRevertOperation> {
    const input = CheckpointResumeVerifiedSchema.parse(value), result = this.operation(await this.request("checkpoint.resumeVerified", input, input.commandId), input.sessionId);
    this.equal(result.operationId, input.operationId); return result;
  }
  async rollbackToSafety(value: CheckpointRecoveryRequest): Promise<CheckpointRevertOperation> {
    const input = CheckpointRollbackToSafetySchema.parse(value), result = this.operation(await this.request("checkpoint.rollbackToSafety", input, input.commandId), input.sessionId);
    this.equal(result.parentOperationId, input.operationId); this.equal(result.mode, "workspaceRestore"); return result;
  }
  private async request(method: string, payload: unknown, commandId?: string): Promise<unknown> {
    this.require(CHECKPOINT_DIFF_CAPABILITY);
    return this.options.request(method, payload, commandId);
  }
  private require(capability: string): void { if (!this.options.supports(capability)) throw new Error("CHECKPOINT_CAPABILITY_REQUIRED"); }
  private equal(actual: unknown, expected: unknown): void { if (actual !== expected) throw new Error("CHECKPOINT_RESPONSE_SCOPE_MISMATCH"); }
  private diffPage(value: unknown, sessionId: string): CheckpointDiffPage {
    const result = CheckpointDiffPageSchema.parse(value);
    this.equal(result.before.sessionId, sessionId); this.equal(result.after.sessionId, sessionId); this.equal(result.before.workspaceId, result.after.workspaceId); this.paths(result); return result;
  }
  private previewPage(value: unknown, sessionId: string): CheckpointPreviewPage { const result = CheckpointPreviewPageSchema.parse(value); this.equal(result.sessionId, sessionId); this.paths(result); return result; }
  private operation(value: unknown, sessionId: string): CheckpointRevertOperation { const result = CheckpointRevertOperationSchema.parse(value); this.equal(result.sessionId, sessionId); return result; }
  private paths(value: unknown): void {
    if (Array.isArray(value)) { value.forEach((item) => this.paths(item)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "path" || key === "oldPath") && typeof item === "string") {
        if (!item || item.startsWith("/") || /^[a-z]:[\\/]/i.test(item) || item.includes("\0") || item.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("CHECKPOINT_RESPONSE_PATH_INVALID");
      } else this.paths(item);
    }
  }
}
