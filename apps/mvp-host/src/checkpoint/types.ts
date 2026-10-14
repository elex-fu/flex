import type { CheckpointFileChange, CheckpointPreviewFile, CheckpointSummary } from "@flyx/mvp-protocol";

export const CHECKPOINT_POLICY_VERSION = 1;
export type CheckpointPhase = CheckpointSummary["phase"];
export type CheckpointLease = { workspaceId: string; leaseId: string; generation: number };
export type CheckpointContext = {
  sessionId: string; workspaceId: string; turnId?: string; attemptId?: string;
  lease: CheckpointLease; sessionRevision: number; epoch: string; runtimeGeneration: number;
  /** Obtained from the authoritative runtime, never from a preview RPC payload. */
  nativeHandle: unknown;
};
export type AfterCheckpointContext = CheckpointContext & {
  turnId: string; attemptId: string;
  evidence: { producerStopped: true; terminalCommitted: true; terminalSequence: number };
};
export type CheckpointEntry = {
  path: string; kind: "file" | "symlink" | "submodule" | "deleted" | "unsupported";
  tracked: boolean; mode?: string; oid?: string; sha256?: string; bytes?: number;
  unsupported?: string;
};
export type CheckpointStatusEntry = { path: string; originalPath?: string; index: string; worktree: string };
export type CheckpointFingerprint = {
  head?: string; branch?: string; indexDigest: string; workspaceDigest: string;
  pathDigest: string; digest: string;
};
export type CheckpointManifest = CheckpointSummary & {
  schemaVersion: 1; workspacePath: string; gitDirectory?: string;
  workspaceRef: string; indexRef: string; workspaceCommit?: string; indexCommit?: string;
  workspaceTree?: string; indexTree?: string; head?: string; headTree?: string; branch?: string;
  lease: CheckpointLease; sessionRevision: number; epoch: string; runtimeGeneration: number;
  nativeHandle: unknown; nativeHandleBinding: string;
  startedAt: string; completedAt?: string; additionalPaths?: string[];
  beforeSampling?: CheckpointFingerprint; afterSampling?: CheckpointFingerprint; samplingDigest?: string;
  entries: CheckpointEntry[]; statusEntries: CheckpointStatusEntry[];
  unsupported: Array<{ path?: string; reason: string }>;
  errorCode?: string;
};
export type GitCapture = Pick<CheckpointManifest,
  "gitDirectory" | "workspaceCommit" | "indexCommit" | "workspaceTree" | "indexTree" |
  "head" | "headTree" | "branch" | "beforeSampling" | "afterSampling" | "samplingDigest" |
  "workspaceDigest" | "indexDigest" | "entries" | "statusEntries" | "unsupported" |
  "samplingConsistency" | "status" | "warnings"
>;
export type CheckpointDiffEntry = CheckpointFileChange & { oldOid: string; newOid: string; position: number };
export type CheckpointDiffRecord = {
  diffId: string; sessionId: string; beforeCheckpointId: string; afterCheckpointId: string;
  layer: "workspace" | "index"; createdAt: string; entries: CheckpointDiffEntry[];
};
export type CheckpointPreviewAction = CheckpointPreviewFile & { targetMode?: string; targetOid?: string };
export type CheckpointPreviewPlan = {
  planId: string; sessionId: string; actorId: string; workspaceId: string;
  checkpointId: string; currentCheckpointId: string;
  createdAt: string; expiresAt: string; state: "active" | "consumed" | "expired" | "invalidated";
  expectedWorkspaceDigest: string; expectedIndexDigest: string;
  expectedSessionRevision: number; epoch: string; runtimeGeneration: number;
  lease: CheckpointLease; nativeHandle: unknown; nativeHandleBinding: string;
  activeTurnId?: string; policyVersion: number;
  actions: CheckpointPreviewAction[]; unsupported: Array<{ path?: string; reason: string }>;
};
export class CheckpointError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CheckpointError"; }
}
