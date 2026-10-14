import { z } from "zod";

const Id = z.string().min(1).max(256);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Path = z.string().min(1).max(4096);
export const CHECKPOINT_DIFF_CAPABILITY = "checkpoint-diff-v1" as const;
export const CheckpointStatusSchema = z.enum(["capturing", "complete", "unsupported", "raced", "failed", "legacy_inexact"]);
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;
export const CheckpointSummarySchema = z.object({
  checkpointId: Id, sessionId: Id, workspaceId: Id,
  phase: z.enum(["session_baseline", "before", "after", "preview", "safety"]),
  turnId: Id.optional(), attemptId: Id.optional(),
  status: CheckpointStatusSchema, policyVersion: z.number().int().positive(),
  capturedAt: z.string(), workspaceDigest: Digest.optional(), indexDigest: Digest.optional(),
  samplingConsistency: z.enum(["stable", "raced", "unavailable"]), unsupportedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(256)).max(32),
}).strict();
export type CheckpointSummary = z.infer<typeof CheckpointSummarySchema>;
export const CheckpointUnsupportedSchema = z.object({ path: Path.optional(), reason: z.string().max(256) }).strict();
export const CheckpointFileChangeSchema = z.object({
  fileId: Id, path: Path, oldPath: Path.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unsupported"]),
  oldMode: z.string().regex(/^[0-7]{6}$/), newMode: z.string().regex(/^[0-7]{6}$/),
  binary: z.boolean().optional(), unsupported: z.string().max(256).optional(),
}).strict();
export type CheckpointFileChange = z.infer<typeof CheckpointFileChangeSchema>;
export const CheckpointGetDiffSchema = z.object({
  sessionId: Id, beforeCheckpointId: Id, afterCheckpointId: Id,
  layer: z.enum(["workspace", "index"]).default("workspace"),
  cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).default(100),
}).strict();
export const CheckpointGetTurnDiffSchema = z.object({
  sessionId: Id, turnId: Id, attemptId: Id,
  layer: z.enum(["workspace", "index"]).default("workspace"),
  cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).default(100),
}).strict();
export const CheckpointGetSessionDiffSchema = z.object({
  sessionId: Id, currentCheckpointId: Id,
  layer: z.enum(["workspace", "index"]).default("workspace"),
  cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).default(100),
}).strict();
export const CheckpointGetFileSchema = z.object({ sessionId: Id, diffId: Id, fileId: Id }).strict();
export const CheckpointDiffPageSchema = z.object({
  status: z.enum(["available", "unavailable"]), diffId: Id.optional(),
  before: CheckpointSummarySchema, after: CheckpointSummarySchema,
  layer: z.enum(["workspace", "index"]),
  attribution: z.literal("time_boundary_only"), warnings: z.array(z.string().max(256)).max(32),
  unsupportedCount: z.number().int().nonnegative(), unsupported: z.array(CheckpointUnsupportedSchema).max(64),
  totalFiles: z.number().int().nonnegative(), files: z.array(CheckpointFileChangeSchema).max(200),
  nextCursor: z.string().max(2048).optional(), unavailableReason: z.string().max(256).optional(),
}).strict();
export type CheckpointDiffPage = z.infer<typeof CheckpointDiffPageSchema>;
export const CheckpointContentRefSchema = z.object({ ref: Id, bytes: z.number().int().nonnegative(), sha256: Digest, format: z.string().max(128) }).strict();
export type CheckpointContentRef = z.infer<typeof CheckpointContentRefSchema>;
export const CheckpointFileContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("text"), bytes: z.number().int().nonnegative(), sha256: Digest, text: z.string().max(32768) }).strict(),
  z.object({ kind: z.literal("contentRef"), binary: z.boolean(), encoding: z.enum(["utf8", "base64"]), contentRef: CheckpointContentRefSchema }).strict(),
  z.object({ kind: z.literal("unsupported"), reason: z.string().max(256) }).strict(),
]);
export type CheckpointFileContent = z.infer<typeof CheckpointFileContentSchema>;
export const CheckpointDiffFileSchema = z.object({
  diffId: Id, file: CheckpointFileChangeSchema,
  before: CheckpointFileContentSchema, after: CheckpointFileContentSchema,
  patch: CheckpointFileContentSchema,
}).strict();
export type CheckpointDiffFile = z.infer<typeof CheckpointDiffFileSchema>;
export const CheckpointPreviewRevertSchema = z.object({
  sessionId: Id, checkpointId: Id, expectedSessionRevision: z.number().int().nonnegative(),
}).strict();
export const CheckpointPreviewFileSchema = z.object({
  fileId: Id, path: Path, layer: z.enum(["workspace", "index"]),
  action: z.enum(["write", "delete", "unsupported"]), reason: z.string().max(256).optional(),
}).strict();
export type CheckpointPreviewFile = z.infer<typeof CheckpointPreviewFileSchema>;
export const CheckpointPreviewPageSchema = z.object({
  planId: Id, sessionId: Id, checkpointId: Id, expiresAt: z.string(),
  expectedWorkspaceDigest: Digest, expectedIndexDigest: Digest,
  expectedSessionRevision: z.number().int().nonnegative(), epoch: Id,
  runtimeGeneration: z.number().int().nonnegative(), nativeHandleBinding: Digest,
  supported: z.boolean(), unsupportedCount: z.number().int().nonnegative(), unsupported: z.array(CheckpointUnsupportedSchema).max(64),
  totalFiles: z.number().int().nonnegative(), files: z.array(CheckpointPreviewFileSchema).max(200),
  nextCursor: z.string().max(2048).optional(),
}).strict();
export type CheckpointPreviewPage = z.infer<typeof CheckpointPreviewPageSchema>;
export const CheckpointGetPreviewSchema = z.object({ sessionId: Id, planId: Id, cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).default(100) }).strict();
