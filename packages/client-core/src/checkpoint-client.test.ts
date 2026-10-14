import { describe, expect, it, vi } from "vitest";
import { CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, type CheckpointDiffPage, type CheckpointPreviewPage, type CheckpointRevertOperation } from "@flyx/mvp-protocol";
import { CheckpointClient } from "./checkpoint-client.js";
const digest = "a".repeat(64);
const summary = (checkpointId: string) => ({ checkpointId, sessionId: "session-1", workspaceId: "workspace-1", phase: "preview" as const, status: "complete" as const, policyVersion: 1, capturedAt: "2026-10-15T00:00:00Z", samplingConsistency: "stable" as const, unsupportedCount: 0, warnings: [] });
const diff: CheckpointDiffPage = { status: "available", diffId: "diff-1", before: summary("before"), after: summary("after"), layer: "workspace", attribution: "time_boundary_only", warnings: [], unsupportedCount: 0, unsupported: [], totalFiles: 1, files: [{ fileId: "file-1", path: "tracked.txt", status: "modified", oldMode: "100644", newMode: "100644" }] };
const preview: CheckpointPreviewPage = { planId: "plan-1", sessionId: "session-1", checkpointId: "before", expiresAt: "2026-10-15T00:00:00Z", expectedWorkspaceDigest: digest, expectedIndexDigest: digest, expectedSessionRevision: 3, epoch: "epoch-1", runtimeGeneration: 1, nativeHandleBinding: digest, supported: true, unsupportedCount: 0, unsupported: [], totalFiles: 1, files: [{ fileId: "file-1", path: "tracked.txt", layer: "workspace", action: "write" }] };
const operation: CheckpointRevertOperation = { operationId: "operation-1", sessionId: "session-1", checkpointId: "before", mode: "revert", stage: "validated", status: "queued", revision: 0, sessionRevision: 4, totalSteps: 3, appliedSteps: 0, recoveryRequired: true };
const command = { sessionId: "session-1", commandId: "command-1", planId: "plan-1", expectedSessionRevision: 3, confirmation: true as const };
function fixture(response: unknown, capabilities = [CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY] as string[]) { const request = vi.fn(async () => response); return { request, client: new CheckpointClient({ request, supports: (capability) => capabilities.includes(capability) }) }; }

describe("typed CheckpointClient boundary", () => {
  it("parses read defaults and verifies exact historical resource identities", async () => {
    const f = fixture(diff); expect(await f.client.getDiff({ sessionId: "session-1", beforeCheckpointId: "before", afterCheckpointId: "after" })).toEqual(diff);
    expect(f.request).toHaveBeenCalledWith("checkpoint.getDiff", { sessionId: "session-1", beforeCheckpointId: "before", afterCheckpointId: "after", layer: "workspace", limit: 100 }, undefined);
    await expect(f.client.getDiff({ sessionId: "session-other", beforeCheckpointId: "before", afterCheckpointId: "after" })).rejects.toThrow("CHECKPOINT_RESPONSE_SCOPE_MISMATCH");
    await expect(f.client.getDiff({ sessionId: "session-1", beforeCheckpointId: "different", afterCheckpointId: "after" })).rejects.toThrow("CHECKPOINT_RESPONSE_SCOPE_MISMATCH");
  });
  it("rejects absent negotiated capabilities before transport writes", async () => {
    const none = fixture(diff, []); await expect(none.client.getDiff({ sessionId: "session-1", beforeCheckpointId: "before", afterCheckpointId: "after" })).rejects.toThrow("CHECKPOINT_CAPABILITY_REQUIRED"); expect(none.request).not.toHaveBeenCalled();
    const basic = fixture(operation, [CHECKPOINT_DIFF_CAPABILITY]); await expect(basic.client.executeRevert(command)).rejects.toThrow("CHECKPOINT_CAPABILITY_REQUIRED"); expect(basic.request).not.toHaveBeenCalled();
  });
  it("sends one identical V2 body/envelope command ID without client actor, paths or leases", async () => {
    const f = fixture(operation); expect(await f.client.executeRevert(command)).toEqual(operation); expect(f.request).toHaveBeenCalledWith("checkpoint.executeRevert", command, command.commandId);
    await expect(f.client.executeRevert({ ...command, actorId: "injected", lease: "client" } as typeof command)).rejects.toBeDefined(); expect(f.request).toHaveBeenCalledTimes(1);
    const basic = fixture({ ...operation, mode: "workspaceRestore" }, [CHECKPOINT_DIFF_CAPABILITY]); await basic.client.workspaceRestore(command); expect(basic.request).toHaveBeenCalledWith("checkpoint.workspaceRestore", command, command.commandId);
  });
  it("rejects private manifest/native fields and unsafe public paths in responses", async () => {
    const privateResult = fixture({ ...operation, nativeHandle: { nativeSessionId: "secret" }, workspacePath: "/private/host" }); await expect(privateResult.client.executeRevert(command)).rejects.toBeDefined();
    const badPath = fixture({ ...diff, files: [{ ...diff.files[0], path: "/private/host" }] }); await expect(badPath.client.getDiff({ sessionId: "session-1", beforeCheckpointId: "before", afterCheckpointId: "after" })).rejects.toThrow("CHECKPOINT_RESPONSE_PATH_INVALID");
    const escaping = fixture({ ...diff, files: [{ ...diff.files[0], path: "folder/../private" }] }); await expect(escaping.client.getDiff({ sessionId: "session-1", beforeCheckpointId: "before", afterCheckpointId: "after" })).rejects.toThrow("CHECKPOINT_RESPONSE_PATH_INVALID");
  });
  it("binds preview and paginated plan results to the requested Session, target, revision and plan", async () => {
    const f = fixture(preview); expect(await f.client.previewRevert({ sessionId: "session-1", checkpointId: "before", expectedSessionRevision: 3 })).toEqual(preview);
    await expect(f.client.getPreview({ sessionId: "session-1", planId: "other" })).rejects.toThrow("CHECKPOINT_RESPONSE_SCOPE_MISMATCH");
    await expect(f.client.previewRevert({ sessionId: "session-1", checkpointId: "before", expectedSessionRevision: 4 })).rejects.toThrow("CHECKPOINT_RESPONSE_SCOPE_MISMATCH");
  });
  it("binds operation/recovery reads and explicit rollback results to original operation", async () => {
    const f = fixture(operation); await expect(f.client.getRevertOperation({ sessionId: "session-1", operationId: "wrong" })).rejects.toThrow("CHECKPOINT_RESPONSE_SCOPE_MISMATCH");
    const recovery = { sessionId: "session-1", operationId: "operation-1", commandId: "recovery-command", evidenceId: "evidence-1", expectedSessionRevision: 8, confirmation: true as const };
    const rollback = fixture({ ...operation, operationId: "rollback-1", parentOperationId: "operation-1", mode: "workspaceRestore" }); expect((await rollback.client.rollbackToSafety(recovery)).parentOperationId).toBe("operation-1"); expect(rollback.request).toHaveBeenCalledWith("checkpoint.rollbackToSafety", recovery, recovery.commandId);
    const evidence = fixture({ evidenceId: "evidence-1", operationId: "operation-1", sessionId: "other", expectedSessionRevision: 8, operationRevision: 3, expiresAt: "2026-10-15T00:00:00Z", resumable: false, safetyRollbackAvailable: true }); await expect(evidence.client.inspectRevert({ sessionId: "session-1", operationId: "operation-1" })).rejects.toThrow("CHECKPOINT_RESPONSE_SCOPE_MISMATCH");
  });
});
