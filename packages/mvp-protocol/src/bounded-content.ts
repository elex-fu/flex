import { z } from "zod";

export const BOUNDED_CONTENT_CAPABILITY = "bounded-content-v1";
export const ContentRefIdSchema = z.string().regex(/^cnt_[a-f0-9]{32}$/);
export const ContentRefSchema = z.object({
  ref: ContentRefIdSchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.string().min(1).max(128),
}).strict();
export type ContentRef = z.infer<typeof ContentRefSchema>;

export const ContentChunkRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  ref: ContentRefIdSchema,
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  maxBytes: z.number().int().min(1).max(192 * 1024).default(64 * 1024),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
}).strict();
export type ContentChunkRequest = z.infer<typeof ContentChunkRequestSchema>;

const ChunkMetadata = z.object({
  sessionId: z.string().min(1).max(128), ref: ContentRefIdSchema,
  offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.string().min(1).max(128), hasMore: z.boolean(),
});
export const ContentChunkSchema = z.discriminatedUnion("encoding", [
  ChunkMetadata.extend({ encoding: z.literal("utf8"), text: z.string() }).strict(),
  ChunkMetadata.extend({ encoding: z.literal("base64"), data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]).refine((chunk) => chunk.offset <= chunk.nextOffset && chunk.nextOffset <= chunk.totalBytes && chunk.hasMore === (chunk.nextOffset < chunk.totalBytes) && (!chunk.hasMore || chunk.nextOffset > chunk.offset), "Invalid chunk offsets")
  .refine((chunk) => (chunk.encoding === "utf8" ? new TextEncoder().encode(chunk.text).length : chunk.data.length / 4 * 3 - (chunk.data.endsWith("==") ? 2 : chunk.data.endsWith("=") ? 1 : 0)) === chunk.nextOffset - chunk.offset, "Chunk length does not match offsets");
export type ContentChunk = z.infer<typeof ContentChunkSchema>;

/** Legacy objects retain their preview fields and carry this explicit marker. */
export const BoundedContentMarkerSchema = z.object({
  truncated: z.literal(true), requiresUpgrade: z.boolean(),
  originalBytes: z.number().int().nonnegative(),
}).strict();
export type BoundedContentMarker = z.infer<typeof BoundedContentMarkerSchema>;
