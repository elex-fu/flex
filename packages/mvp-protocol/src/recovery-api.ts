import { z } from "zod";

export const RecoveryCapability = "session-recovery-v1" as const;

const resourceId = z.string().min(1).max(256);
export const RecoveryInspectPayloadSchema = z.object({
  sessionId: resourceId,
  turnId: resourceId,
  attemptId: resourceId.optional(),
}).strict();
export const RecoveryReconcilePayloadSchema = RecoveryInspectPayloadSchema.extend({
  evidenceId: resourceId,
  expectedRecoveryRevision: z.number().int().nonnegative(),
}).strict();
export const RecoveryAcknowledgePayloadSchema = RecoveryReconcilePayloadSchema.extend({
  acknowledgeUnknown: z.literal(true),
}).strict();

export const RecoveryEvidenceSchema = z.object({
  evidenceId: resourceId,
  sessionId: resourceId,
  turnId: resourceId,
  attemptId: resourceId.optional(),
  recoveryRevision: z.number().int().nonnegative(),
  observedAt: z.string(),
  expiresAt: z.string(),
  processState: z.enum(["stopped", "running", "unknown"]),
  workspaceState: z.enum(["clear", "held", "unknown"]),
  nativeState: z.enum(["terminal", "running", "unknown"]),
  nativeOutcome: z.enum(["completed", "failed", "cancelled"]).optional(),
  committedOutcome: z.object({ status: z.enum(["failed", "cancelled"]), source: z.literal("not-dispatched") }).strict().optional(),
  nextSteps: z.array(z.enum(["inspect", "reconcile", "acknowledge", "local_inspection"])).max(4),
}).strict();

export const RecoveryOperationSchema = z.object({
  operationId: resourceId,
  sessionId: resourceId,
  turnId: resourceId,
  attemptId: resourceId.optional(),
  state: z.enum(["accepted", "completed", "blocked", "failed"]),
  gate: z.enum(["released", "blocked", "unchanged"]),
  turnStatus: z.enum(["queued", "running", "waiting_approval", "interrupting", "completed", "failed", "cancelled", "outcome_unknown"]),
  recoveryRevision: z.number().int().nonnegative(),
}).strict();

export type RecoveryInspectPayload = z.infer<typeof RecoveryInspectPayloadSchema>;
export type RecoveryReconcilePayload = z.infer<typeof RecoveryReconcilePayloadSchema>;
export type RecoveryAcknowledgePayload = z.infer<typeof RecoveryAcknowledgePayloadSchema>;
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;
export type RecoveryOperation = z.infer<typeof RecoveryOperationSchema>;

export type RecoveryRpcContract = {
  "session.recovery.inspect": { payload: RecoveryInspectPayload; response: RecoveryEvidence };
  "session.recovery.reconcile": { payload: RecoveryReconcilePayload; response: RecoveryOperation };
  "session.recovery.acknowledge": { payload: RecoveryAcknowledgePayload; response: RecoveryOperation };
};
export type RecoveryRpcMethod = keyof RecoveryRpcContract;
