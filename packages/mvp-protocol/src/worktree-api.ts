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

// RPCs bind every operation to an existing Catalog Session. Paths and actor IDs
// are resolved by the Host and never accepted from a peer.
const SourceSession = z.string().min(1).max(128);
const CommandId = z.string().min(1).max(128);
export const WorktreeCreateRpcSchema = WorktreeCreateRequestSchema.omit({ kind: true }).extend({ sessionId: SourceSession }).strict();
export const WorktreeExistingRpcSchema = WorktreeExistingRequestSchema.omit({ kind: true }).extend({ sessionId: SourceSession }).strict();
export const WorktreeListRpcSchema = z.object({
  sessionId: SourceSession, afterWorktreeId: ManagedWorktreeIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const WorktreeOperationRpcSchema = WorktreeReconcileRequestSchema.extend({ sessionId: SourceSession }).strict();
export const WorktreeResumeRpcSchema = WorktreeResumeRequestSchema.extend({ sessionId: SourceSession }).strict();
export const WorktreeReceiptRpcSchema = z.object({ sessionId: SourceSession, commandId: CommandId }).strict();
export const WorktreeResultSchema = z.object({ operation: WorktreeOperationSchema, worktree: ManagedWorktreeSummarySchema, inspection: WorktreeInspectionSchema.optional() }).strict();
const ReceiptState = z.enum(["accepted", "completed", "failed", "cancelled", "outcome_unknown"]);
export const WorktreeCommandResultSchema = WorktreeResultSchema.extend({ commandId: CommandId, receiptState: ReceiptState, reused: z.boolean() }).strict();
export const WorktreeListResultSchema = z.object({
  worktrees: z.array(ManagedWorktreeSummarySchema).max(100), nextWorktreeId: ManagedWorktreeIdSchema.optional(),
}).strict();
export const WorktreeReceiptResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false), commandId: CommandId }).strict(),
  z.object({ found: z.literal(true), commandId: CommandId, method: z.enum(["worktree.create", "worktree.archive", "worktree.restore", "worktree.reconcile", "worktree.resume"]),
    state: ReceiptState, response: WorktreeResultSchema, updatedAt: z.string() }).strict(),
]);
export type WorktreeCreateRpc = z.infer<typeof WorktreeCreateRpcSchema>;
export type WorktreeExistingRpc = z.infer<typeof WorktreeExistingRpcSchema>;
export type WorktreeListRpc = z.infer<typeof WorktreeListRpcSchema>;
export type WorktreeOperationRpc = z.infer<typeof WorktreeOperationRpcSchema>;
export type WorktreeResumeRpc = z.infer<typeof WorktreeResumeRpcSchema>;
export type WorktreeReceiptRpc = z.infer<typeof WorktreeReceiptRpcSchema>;
export type WorktreeResult = z.infer<typeof WorktreeResultSchema>;
export type WorktreeCommandResult = z.infer<typeof WorktreeCommandResultSchema>;
export type WorktreeListResult = z.infer<typeof WorktreeListResultSchema>;
export type WorktreeReceiptResult = z.infer<typeof WorktreeReceiptResultSchema>;
