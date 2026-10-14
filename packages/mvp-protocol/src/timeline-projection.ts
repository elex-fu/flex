import { z } from "zod";

export const TIMELINE_PROJECTION_CAPABILITY = "timeline-projection-v1" as const;
const Identifier = z.string().min(1).max(256);
const Sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TimelineCursorSchema = z.object({ epoch: Identifier, sequence: Sequence }).strict();
export type TimelineCursor = z.infer<typeof TimelineCursorSchema>;
export const CoveredSourceRangeSchema = z.object({ fromExclusive: Sequence, through: Sequence }).strict()
  .refine((range) => range.through >= range.fromExclusive, "Invalid source coverage");
export type CoveredSourceRange = z.infer<typeof CoveredSourceRangeSchema>;
export const TimelineContentReferenceSchema = z.object({
  ref: Identifier, bytes: Sequence, format: z.string().min(1).max(128).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type TimelineContentReference = z.infer<typeof TimelineContentReferenceSchema>;
export const ProjectedItemSchema = z.object({
  sessionId: Identifier,
  itemId: Identifier,
  kind: z.enum(["user_message", "assistant_message", "tool_call", "approval", "question", "error", "system"]),
  status: z.string().min(1).max(128),
  revision: Sequence.positive(),
  displaySequence: Sequence.positive(),
  sourceSeqRanges: z.array(z.object({ start: Sequence, end: Sequence }).strict()
    .refine((range) => range.end >= range.start, "Invalid item source range")).max(32).optional(),
  sourceSeqRangesRef: TimelineContentReferenceSchema.extend({ count: Sequence }).strict().optional(),
  content: z.union([z.object({ inline: z.unknown() }).strict(), TimelineContentReferenceSchema]),
  // A body ref contains UTF-8 text for this field; metadata contains the rest
  // of the public content object. With no field, the ref contains JSON.
  contentField: z.enum(["text", "output", "message"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  metadataRef: TimelineContentReferenceSchema.optional(),
  updatedAt: z.string().min(1).max(64),
}).strict().refine((item) => !(item.sourceSeqRanges && item.sourceSeqRangesRef), "Choose one source range representation")
  .refine((item) => item.displaySequence <= item.revision, "Display order cannot follow the item revision")
  .refine((item) => !item.sourceSeqRanges || item.sourceSeqRanges.every((range) => range.start > 0 && range.end <= item.revision), "Item sources exceed its revision");
export type ProjectedItem = z.infer<typeof ProjectedItemSchema>;
export const TimelinePageReferenceSchema = TimelineContentReferenceSchema.extend({ itemCount: Sequence }).strict();
export const TimelinePageSchema = z.object({
  epoch: Identifier,
  projectorVersion: z.number().int().positive(),
  upToSequence: Sequence,
  items: z.array(ProjectedItemSchema),
  coveredSourceRange: CoveredSourceRangeSchema.optional(),
  pageRef: TimelinePageReferenceSchema.optional(),
  nextCursor: TimelineCursorSchema.optional(),
  nextBefore: z.object({ displaySequence: Sequence, itemId: Identifier }).strict().optional(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
  // False for pre-migration events whose atomic boundaries are unknown.
  boundaryComplete: z.boolean(),
}).strict().refine((page) => !page.pageRef || page.items.length === 0, "A referenced page must be loaded before applying coverage")
  .refine((page) => !page.nextCursor || page.nextCursor.epoch === page.epoch, "Cursor epoch mismatch")
  .refine((page) => !page.coveredSourceRange || page.coveredSourceRange.through === page.upToSequence, "Coverage boundary mismatch")
  .refine((page) => !page.coveredSourceRange || page.nextCursor?.sequence === page.upToSequence, "Covered pages require their consumption cursor")
  .refine((page) => page.items.every((item) => item.revision <= page.upToSequence), "Item revision exceeds the page watermark");
export type TimelinePage = z.infer<typeof TimelinePageSchema>;
export const TimelinePageContentSchema = z.object({
  epoch: Identifier, projectorVersion: z.number().int().positive(), upToSequence: Sequence,
  coveredSourceRange: CoveredSourceRangeSchema.optional(), items: z.array(ProjectedItemSchema),
}).strict().refine((page) => !page.coveredSourceRange || page.coveredSourceRange.through === page.upToSequence, "Coverage boundary mismatch")
  .refine((page) => page.items.every((item) => item.revision <= page.upToSequence), "Item revision exceeds the page watermark");
export type TimelinePageContent = z.infer<typeof TimelinePageContentSchema>;
export const TimelineAfterPageRequestSchema = z.object({
  sessionId: Identifier, epoch: Identifier, direction: z.literal("after"),
  afterSequence: Sequence, upToSequence: Sequence,
}).strict().refine((request) => request.upToSequence >= request.afterSequence, "Cursor exceeds fixed watermark");
export const TimelineBeforePageRequestSchema = z.object({
  sessionId: Identifier, epoch: Identifier, direction: z.literal("before"),
  beforeDisplaySequence: Sequence, beforeItemId: Identifier.optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export const TimelinePageRequestSchema = z.union([TimelineAfterPageRequestSchema, TimelineBeforePageRequestSchema]);
export type TimelinePageRequest = z.infer<typeof TimelinePageRequestSchema>;
export const OpenViewRequestSchema = z.object({
  sessionId: Identifier, cursor: TimelineCursorSchema.optional(),
  tailLimit: z.number().int().min(1).max(200).default(50),
}).strict();
export type OpenViewRequest = z.infer<typeof OpenViewRequestSchema>;
export const TimelineSubscribeRequestSchema = z.object({ sessionId: Identifier, epoch: Identifier }).strict();
export type TimelineSubscribeRequest = z.infer<typeof TimelineSubscribeRequestSchema>;
export const TimelineUnsubscribeRequestSchema = z.object({ subscriptionId: Identifier }).strict();
export type TimelineUnsubscribeRequest = z.infer<typeof TimelineUnsubscribeRequestSchema>;
export const TimelineInteractionSummarySchema = z.object({
  total: Sequence, directoryRevision: Sequence, complete: z.boolean(),
  items: z.array(z.unknown()), ref: TimelineContentReferenceSchema.optional(),
}).strict().refine((summary) => !summary.ref || summary.items.length === 0, "Referenced interaction summary is incomplete until loaded");
export type TimelineInteractionSummary = z.infer<typeof TimelineInteractionSummarySchema>;
export const OpenViewResponseSchema = z.object({
  subscriptionId: Identifier, sessionId: Identifier, projectorVersion: z.number().int().positive(),
  mode: z.enum(["cold", "catch_up"]), watermark: TimelineCursorSchema,
  page: TimelinePageSchema, snapshot: z.unknown(),
  snapshotRef: TimelineContentReferenceSchema.optional(),
  interactions: TimelineInteractionSummarySchema,
  catchUpComplete: z.boolean(),
}).strict().refine((view) => view.watermark.epoch === view.page.epoch && view.projectorVersion === view.page.projectorVersion, "View projection identity mismatch")
  .refine((view) => view.page.upToSequence <= view.watermark.sequence, "Page exceeds the fixed view watermark")
  .refine((view) => !view.catchUpComplete || view.page.nextCursor?.sequence === view.watermark.sequence, "Catch-up completion requires the fixed watermark")
  .refine((view) => view.mode !== "cold" || (view.catchUpComplete && !view.page.hasNewer), "Cold views start at the authoritative watermark")
  .refine((view) => view.interactions.directoryRevision === view.watermark.sequence, "Interaction snapshot watermark mismatch")
  .refine((view) => view.page.items.every((item) => item.sessionId === view.sessionId), "View items belong to another Session");
export type OpenViewResponse = z.infer<typeof OpenViewResponseSchema>;
// Re-subscribe captures a fresh watermark using the identical listener gate.
export const TimelineSubscribeResponseSchema = OpenViewResponseSchema;
export type TimelineSubscribeResponse = OpenViewResponse;
export const TimelineUnsubscribeResponseSchema = z.object({ removed: z.boolean() }).strict();
export type TimelineUnsubscribeResponse = z.infer<typeof TimelineUnsubscribeResponseSchema>;
export const TimelineUpdatedPayloadSchema = TimelinePageSchema.safeExtend({
  subscriptionId: Identifier,
  snapshot: z.unknown(), snapshotRef: TimelineContentReferenceSchema.optional(),
  snapshotSequence: Sequence, interactions: TimelineInteractionSummarySchema,
}).refine((payload) => payload.snapshotSequence >= payload.upToSequence, "Snapshot predates covered source boundary")
  .refine((payload) => payload.interactions.directoryRevision === payload.snapshotSequence, "Interaction snapshot watermark mismatch");
export type TimelineUpdatedPayload = z.infer<typeof TimelineUpdatedPayloadSchema>;
export const TimelineResetPayloadSchema = z.object({
  subscriptionId: Identifier, epoch: Identifier,
  reason: z.enum(["buffer_overflow", "epoch_changed", "delivery_failed", "lease_expired"]),
}).strict();
