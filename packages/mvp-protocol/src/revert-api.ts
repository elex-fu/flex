import { z } from "zod";
const Id = z.string().min(1).max(256);
const Revision = z.number().int().nonnegative();
export const CHECKPOINT_REVERT_CAPABILITY = "checkpoint-revert-v1" as const;
export const CheckpointExecuteRevertSchema = z.object({ sessionId: Id, commandId: Id, planId: Id, expectedSessionRevision: Revision, confirmation: z.literal(true) }).strict();
export const CheckpointWorkspaceRestoreSchema = CheckpointExecuteRevertSchema;
export const CheckpointRevertOperationQuerySchema = z.object({ sessionId: Id, operationId: Id }).strict();
export const CheckpointInspectRevertSchema = CheckpointRevertOperationQuerySchema;
export const CheckpointResumeVerifiedSchema = z.object({ sessionId: Id, operationId: Id, commandId: Id, evidenceId: Id, expectedSessionRevision: Revision, confirmation: z.literal(true) }).strict();
export const CheckpointRollbackToSafetySchema = CheckpointResumeVerifiedSchema;
export const CheckpointRevertOperationSchema = z.object({
  operationId: Id, sessionId: Id, checkpointId: Id, mode: z.enum(["revert", "workspaceRestore"]),
  stage: z.enum(["validated", "safety_captured", "workspace_restored", "provider_rewound", "projection_committed", "partial_failure"]),
  status: z.enum(["queued", "running", "blocked", "completed", "rolled_back"]),
  revision: Revision, sessionRevision: Revision, totalSteps: Revision, appliedSteps: Revision,
  safetyCheckpointId: Id.optional(), errorCode: z.string().max(128).optional(), epoch: Id.optional(),
  recoveryRequired: z.boolean(), parentOperationId: Id.optional(),
}).strict();
export type CheckpointRevertOperation = z.infer<typeof CheckpointRevertOperationSchema>;
export const CheckpointRevertEvidenceSchema = z.object({
  evidenceId: Id, operationId: Id, sessionId: Id, expectedSessionRevision: Revision,
  operationRevision: Revision, expiresAt: z.string(), resumable: z.boolean(),
  safetyRollbackAvailable: z.boolean(), reason: z.string().max(128).optional(),
}).strict();
export type CheckpointRevertEvidence = z.infer<typeof CheckpointRevertEvidenceSchema>;
