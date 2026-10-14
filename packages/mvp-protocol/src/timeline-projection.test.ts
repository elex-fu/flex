import { describe, expect, it } from "vitest";
import { TimelinePageContentSchema, TimelinePageSchema, TimelineUpdatedPayloadSchema, OpenViewResponseSchema, ProjectedItemSchema } from "./timeline-projection.js";

const page = { epoch: "epoch", projectorVersion: 1, upToSequence: 4, coveredSourceRange: { fromExclusive: 0, through: 4 }, items: [], nextCursor: { epoch: "epoch", sequence: 4 }, hasOlder: false, hasNewer: false, boundaryComplete: true };
describe("canonical timeline protocol", () => {
  it("accepts explicit no-item source coverage and a strict immutable page wrapper", () => {
    expect(TimelinePageSchema.parse(page).nextCursor?.sequence).toBe(4);
    expect(TimelinePageContentSchema.parse({ epoch: "epoch", projectorVersion: 1, upToSequence: 4, coveredSourceRange: page.coveredSourceRange, items: [] }).items).toEqual([]);
  });
  it("rejects forged coverage, mismatched epochs and fields outside the contract", () => {
    expect(TimelinePageSchema.safeParse({ ...page, nextCursor: { epoch: "other", sequence: 4 } }).success).toBe(false);
    expect(TimelinePageSchema.safeParse({ ...page, coveredSourceRange: { fromExclusive: 0, through: 3 } }).success).toBe(false);
    expect(TimelinePageSchema.safeParse({ ...page, nextCursor: { epoch: "epoch", sequence: 3 } }).success).toBe(false);
    expect(TimelinePageContentSchema.safeParse({ epoch: "epoch", projectorVersion: 1, upToSequence: 4, items: [], nextCursor: page.nextCursor }).success).toBe(false);
  });
  it("requires source range representations to be bounded and exclusive", () => {
    const item = { sessionId: "session", itemId: "item", kind: "system", status: "info", revision: 1, displaySequence: 1, content: { inline: {} }, updatedAt: "now", sourceSeqRanges: [{ start: 1, end: 1 }] };
    expect(ProjectedItemSchema.safeParse(item).success).toBe(true);
    expect(ProjectedItemSchema.safeParse({ ...item, sourceSeqRangesRef: { ref: "content", bytes: 2, sha256: "0".repeat(64), count: 1 } }).success).toBe(false);
    expect(ProjectedItemSchema.safeParse({ ...item, sourceSeqRanges: Array.from({ length: 33 }, () => ({ start: 1, end: 1 })) }).success).toBe(false);
  });
  it("rejects open views that claim completion before their fixed watermark", () => {
    const view = { subscriptionId: "sub", sessionId: "session", projectorVersion: 1, mode: "cold", watermark: { epoch: "epoch", sequence: 4 }, page, snapshot: {}, interactions: { total: 0, directoryRevision: 4, complete: true, items: [] }, catchUpComplete: true };
    expect(OpenViewResponseSchema.safeParse(view).success).toBe(true);
    expect(OpenViewResponseSchema.safeParse({ ...view, watermark: { epoch: "epoch", sequence: 5 } }).success).toBe(false);
    expect(OpenViewResponseSchema.safeParse({ ...view, projectorVersion: 2 }).success).toBe(false);
  });
  it("keeps authoritative live snapshots at an explicit source boundary", () => {
    const payload = { ...page, subscriptionId: "sub", snapshot: {}, snapshotSequence: 4, interactions: { total: 0, directoryRevision: 4, complete: true, items: [] } };
    expect(TimelineUpdatedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(TimelineUpdatedPayloadSchema.safeParse({ ...payload, snapshotSequence: 3 }).success).toBe(false);
  });
});
