import { z } from "zod";
export const WORKTREE_CAPABILITY = "managed-worktrees-v1";
export const ManagedWorktreeIdSchema = z.string().regex(/^wt_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const WorktreeRefSchema = z.string().max(256).refine((ref) => {
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref) || ref === "HEAD") return true;
  return /^refs\/(?:heads|tags|remotes)\/[A-Za-z0-9._/-]+$/.test(ref)
    && !ref.includes("..") && !ref.includes("//") && !ref.includes("@{")
    && ref.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
    && !ref.endsWith(".") && !ref.endsWith("/");
}, "Worktree ref must be a validated registered repository ref");
export const WorktreeCreateRequestSchema = z.object({
  kind: z.literal("create"), repositoryId: z.string().min(1).max(128), ref: WorktreeRefSchema.default("HEAD"),
  branchMode: z.enum(["detached", "generated"]).default("detached"),
}).strict();
export const WorktreeExistingRequestSchema = z.object({
  kind: z.enum(["archive", "restore"]), worktreeId: ManagedWorktreeIdSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export const WorktreeRequestSchema = z.union([WorktreeCreateRequestSchema, WorktreeExistingRequestSchema]);
export type WorktreeRequest = z.infer<typeof WorktreeRequestSchema>;
export const ManagedWorktreeSummarySchema = z.object({
  worktreeId: ManagedWorktreeIdSchema, repositoryId: z.string(), workspaceId: z.string(),
  state: z.enum(["creating", "active", "archiving", "archived", "restoring", "blocked"]),
  revision: z.number().int().nonnegative(), directoryName: ManagedWorktreeIdSchema,
  headCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  branchName: z.string().max(128).optional(), snapshotId: z.string().uuid().optional(),
}).strict();
export type ManagedWorktreeSummary = z.infer<typeof ManagedWorktreeSummarySchema>;
export const WorktreeOperationSchema = z.object({
  operationId: z.string().uuid(), worktreeId: ManagedWorktreeIdSchema, kind: z.enum(["create", "archive", "restore"]),
  state: z.enum(["pending", "running", "completed", "failed", "outcome_unknown"]),
  stage: z.string().min(1).max(64), errorCode: z.string().max(128).optional(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type WorktreeOperation = z.infer<typeof WorktreeOperationSchema>;
export const WorktreeReconcileRequestSchema = z.object({ operationId: z.string().uuid() }).strict();
export const WorktreeResumeRequestSchema = z.object({ operationId: z.string().uuid(), evidenceId: z.string().uuid() }).strict();
export const WorktreeInspectionSchema = z.object({
  evidenceId: z.string().uuid(), operationId: z.string().uuid(), canResume: z.boolean(),
  producerStopped: z.boolean(), observed: z.enum(["absent", "partial", "complete", "conflict"]),
  expiresAt: z.string(), errorCode: z.string().max(128).optional(),
}).strict();
export type WorktreeInspection = z.infer<typeof WorktreeInspectionSchema>;
