import type { DispatchContext } from "../provider/types.js";
import type { CheckpointPreviewContext, LeaseSuccession } from "./preview-service.js";
import type { CheckpointLease, CheckpointPreviewPlan } from "./types.js";

export type RevertStage = "validated" | "safety_captured" | "workspace_restored" | "provider_rewound" | "projection_committed" | "partial_failure";
export type RevertMode = "revert" | "workspaceRestore";
export type FileState = { kind: "absent" | "file" | "symlink" | "directory"; mode?: string; sha256?: string; bytes?: number; stamp?: string };
export type RootIdentity = { path: string; dev: string; ino: string };
export type RestoreCapabilities = { workspace: RootIdentity; gitDirectory: RootIdentity; gitEntry: FileState };
export type RestoreArtifact = { temporary?: FileState; owner?: FileState; sameInode?: boolean; ownerMatchesTarget?: boolean; lockOwner?: FileState; indexLock?: FileState; sameLockInode?: boolean };
export type RestoreInspection = { files: Record<string, FileState>; indexDigest: string; indexState: FileState; artifacts: Record<string, RestoreArtifact> };
export type RestoreTarget = FileState & { oid?: string };
export type NativeRevertPreparation = {
  supported: true;
  capability: { kind: "conversation-rewind" | "new-conversation"; evidenceId: string; driverVersion: string; verifiedVersion: string };
  originalBinding: string; targetBinding: string; boundary: unknown;
} | { supported: false; reason: string };
/** Request-token proof, not a transcript or a local delivery acknowledgement. */
export type NativeRevertProof = {
  state: "applied" | "not_applied" | "unknown"; requestId: string;
  originalBinding: string; targetBinding: string; proofId: string; observedAt: string;
  quiescent: boolean; pendingRequest: boolean; nativeHandle?: unknown;
};
export type NativeRevertRequest = { operationId: string; requestId: string; mode: RevertMode; originalHandle: unknown; preparation: Extract<NativeRevertPreparation, { supported: true }> };
export interface NativeRevertDriver {
  prepare(input: { mode: RevertMode; originalHandle: unknown; targetHandle: unknown; checkpointId: string; checkpointPhase: string }): Promise<NativeRevertPreparation>;
  apply(request: NativeRevertRequest): Promise<NativeRevertProof>;
  query(request: NativeRevertRequest): Promise<NativeRevertProof>;
}
export type RevertStepAttempt = { attemptId: string; dispatchAt: string; state: "dispatching" | "applied" | "outcome_unknown"; commandIntentId: string; lease: CheckpointLease; completedAt?: string; result?: unknown; errorCode?: string; inputBinding?: string; request?: NativeRevertRequest };
export type RevertStep = {
  stepId: string; ordinal: number; kind: "safety_capture" | "mkdir" | "workspace_file" | "index" | "provider" | "owned_cleanup";
  state: "pending" | "dispatching" | "applied" | "outcome_unknown";
  cleanup?: { originalStep: RevertStep; parentOperationId: string };
  fileId?: string; path?: string; target?: RestoreTarget; expected?: FileState; artifact?: RestoreArtifact;
  expectedIndexDigest?: string; desiredIndexDigest?: string;
  request?: NativeRevertRequest; attempts: RevertStepAttempt[]; result?: unknown;
};
export type RevertCommand = { actorId: string; commandId: string; requestHash: string; intentId: string; attemptId: string; dispatchContext: DispatchContext; kind: "execute" | "resume" | "rollback"; acceptedRevision: number };
export type RevertOperation = {
  operationId: string; sessionId: string; actorId: string; workspaceId: string; plan: CheckpointPreviewPlan;
  mode: RevertMode; stage: RevertStage; lastCompletedStage: Exclude<RevertStage, "partial_failure">;
  status: "queued" | "running" | "blocked" | "completed" | "rolled_back";
  revision: number; sessionRevision: number; gateRecoveryRevision: number;
  lease: CheckpointLease; capabilities: RestoreCapabilities;
  targetCheckpointId: string; currentCheckpointId: string; safetyCheckpointId?: string;
  nativePreparation: NativeRevertPreparation; nativeProof?: NativeRevertProof;
  commands: RevertCommand[]; steps: RevertStep[]; createdAt: string; updatedAt: string;
  workspaceProof?: { inspectionBinding: string; workspaceDigest: string; indexDigest: string; head?: string; branch?: string; observedAt: string };
  errorCode?: string; recoveryExpiresAt?: string; newEpoch?: string; parentOperationId?: string;
};
export type RevertRecoveryEvidence = {
  evidenceId: string; operationId: string; sessionId: string; actorId: string;
  operationRevision: number; sessionRevision: number; recoveryRevision: number;
  contextBinding: string; lease: CheckpointLease; inspection: RestoreInspection;
  head?: string; branch?: string; workspaceDigest?: string;
  nativeProof?: NativeRevertProof; quiescenceProofId: string;
  observedAt: string; expiresAt: string; consumedBy?: string;
};
export type RevertAcquisition = { context: CheckpointPreviewContext; succession?: LeaseSuccession };
export type RevertAcceptInput = { sessionId: string; actorId: string; commandId: string; planId: string; expectedSessionRevision: number; mode: RevertMode; confirmation: true };
export class RevertCrash extends Error { constructor(readonly boundary: string) { super(`Simulated crash at ${boundary}`); } }
