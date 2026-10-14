import { afterEach, describe, expect, it } from "vitest";
import { TimelinePageContentSchema, TimelinePageSchema } from "@flyx/mvp-protocol";
import { JsonTimelineBudget } from "./contracts.js";
import { TimelineSubscriptions } from "./timeline-subscriptions.js";
import { TimelineFixture } from "./test-support.js";

const fixtures: TimelineFixture[] = [];
function fixture() { const value = new TimelineFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

describe("Timeline source-range paging", () => {
  it("consumes 10,000 source facts across fixed-W pages without skipping events or importing later versions", () => {
    const f = fixture();
    for (let batch = 0; batch < 1_000; batch++) f.commit(Array.from({ length: 10 }, (_, offset) => {
      const sequence = batch * 10 + offset + 1;
      return sequence % 16 === 1
        ? { type: "user.message.created", payload: { itemId: `item-${sequence}`, text: `message ${sequence}` } }
        : { type: "provider.heartbeat", payload: {} };
    }), { publish: false });
    const q = f.query({ sourcePageLimit: 137 }); const epoch = q.activeEpoch(f.session.id).epoch;
    const tail = q.tail(f.session.id, 40);
    expect(tail.items).toHaveLength(40); expect(tail.hasOlder).toBe(true);
    expect(tail.nextCursor?.sequence).toBe(10_000);
    const sent: unknown[] = [];
    const service = new TimelineSubscriptions(q, { source: f.source, readSnapshot: () => f.snapshot() });
    const lease = { subjectId: "device", leaseId: "lease", generation: 1 };
    const cold = service.openView({ sessionId: f.session.id, tailLimit: 40 }, lease, async (event) => { sent.push(event); });
    expect(cold.response.page.items).toHaveLength(40); expect(cold.response.watermark.sequence).toBe(10_000);
    expect(sent).toEqual([]);
    const cached = service.openView({ sessionId: f.session.id, cursor: { epoch, sequence: 0 }, tailLimit: 40 }, lease, async (event) => { sent.push(event); });
    expect(cached.response.mode).toBe("catch_up"); expect(cached.response.catchUpComplete).toBe(false);
    expect(cached.response.watermark.sequence).toBe(10_000);
    f.commit([{ type: "user.message.created", payload: { itemId: "item-1", text: "newer than W" } }]);
    let cursor = 0; let pages = 0; const ids = new Set<string>();
    while (cursor < 10_000) {
      const page = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: cursor, upToSequence: 10_000 });
      expect(TimelinePageSchema.safeParse(page).success).toBe(true);
      expect(page.coveredSourceRange?.fromExclusive).toBe(cursor);
      expect(page.nextCursor!.sequence).toBeGreaterThan(cursor);
      for (const item of page.items) {
        ids.add(item.itemId);
        if (item.itemId === "item-1" && "ref" in item.content) expect(f.text(item.content.ref)).toBe("message 1");
        expect(item.revision).toBeLessThanOrEqual(page.upToSequence);
      }
      cursor = page.nextCursor!.sequence; pages++;
      expect(page.hasNewer).toBe(cursor < 10_000);
    }
    expect(cursor).toBe(10_000); expect(pages).toBeGreaterThan(50); expect(ids.size).toBe(625);
    cached.cancel(); expect(f.source.listeners.size).toBe(0);
  }, 30_000);

  it("advances coverage over facts that create no visible items", () => {
    const f = fixture(); f.commit(Array.from({ length: 11 }, () => ({ type: "turn.started" })));
    const q = f.query({ sourcePageLimit: 3 }); const epoch = q.activeEpoch(f.session.id).epoch;
    const page = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 11 });
    expect(page.items).toEqual([]); expect(page.coveredSourceRange).toEqual({ fromExclusive: 0, through: 11 });
    expect(page.nextCursor?.sequence).toBe(11);
    expect(() => q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 2, upToSequence: 11 })).toThrow("complete source commit");
  });

  it("preserves an oversized complete business batch behind an immutable pageRef", () => {
    const f = fixture();
    f.commit(Array.from({ length: 200 }, (_, index) => ({ type: "tool.call.started", payload: { itemId: `tool-${index}`, toolName: "shell", input: { description: '\"\n🙂'.repeat(600) } } })));
    const wrap = (payload: unknown) => ({ type: "response", id: "x".repeat(128), ok: true, transportGeneration: Number.MAX_SAFE_INTEGER, payload });
    const budget = new JsonTimelineBudget(8 * 1024, wrap);
    const q = f.query({ sourcePageLimit: 10, budget }); const epoch = q.activeEpoch(f.session.id).epoch;
    const page = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 200 });
    expect(page.items).toEqual([]); expect(page.pageRef?.itemCount).toBe(200);
    expect(page.coveredSourceRange).toEqual({ fromExclusive: 0, through: 200 });
    expect(budget.fits(page)).toBe(true);
    const blob = TimelinePageContentSchema.parse(JSON.parse(f.text(page.pageRef!.ref)));
    expect(blob.items).toHaveLength(200); expect(blob.coveredSourceRange).toEqual(page.coveredSourceRange);
    expect(blob.epoch).toBe(epoch); expect(blob.upToSequence).toBe(200);
    const fixed = page.pageRef!.ref;
    f.commit([{ type: "tool.call.completed", payload: { itemId: "tool-0", output: "later" } }]);
    expect(TimelinePageContentSchema.parse(JSON.parse(f.text(fixed))).items[0]!.status).toBe("running");
  });

  it("before uses stable composite display order and returns its actual newer watermark without consuming it", () => {
    const f = fixture();
    f.commit([{ type: "tool.call.started", payload: { itemId: "first", toolName: "shell" } }]);
    f.commit([{ type: "assistant.message.completed", payload: { itemId: "second", text: "answer" } }]);
    f.commit([{ type: "tool.call.completed", payload: { itemId: "first", output: "done" } }]);
    const q = f.query(); const epoch = q.activeEpoch(f.session.id).epoch;
    const page = q.getPage({ sessionId: f.session.id, epoch, direction: "before", beforeDisplaySequence: 2, beforeItemId: "second", limit: 1 });
    expect(page.items.map((item) => [item.itemId, item.displaySequence, item.revision])).toEqual([["first", 1, 3]]);
    expect(page.upToSequence).toBe(3); expect(page.nextCursor).toBeUndefined();
    expect(page.nextBefore).toEqual({ displaySequence: 1, itemId: "first" });
  });

  it("inlines bounded public bodies while preserving immutable stored revisions", () => {
    const f = fixture();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", turnId: "turn", text: "Hello" } }]);
    const q = f.query({ maximumInlineContentBytes: 2 * 1024 }); const epoch = q.activeEpoch(f.session.id).epoch;
    f.commit([{ type: "assistant.message.completed", payload: { itemId: "assistant", turnId: "turn", text: "later" } }]);
    const page = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 1 });
    expect(page.items[0]!.content).toEqual({ inline: { turnId: "turn", text: "Hello" } });
    expect(page.items[0]!.contentField).toBeUndefined();
    expect((f.db.prepare(`SELECT content_ref FROM timeline_item_versions WHERE revision = 1`).get() as { content_ref: string }).content_ref).toBeTruthy();
    expect(TimelinePageSchema.safeParse(page).success).toBe(true);
  });

  it("reuses large immutable metadata refs while inlining a small body", () => {
    const f = fixture();
    f.commit([{ type: "tool.call.started", payload: { itemId: "tool", toolName: "shell", input: { description: "x".repeat(20_000) } } }]);
    f.commit([{ type: "tool.call.progress", payload: { itemId: "tool", outputDelta: "ok" } }]);
    const q = f.query({ maximumInlineContentBytes: 2 * 1024 });
    const item = q.tail(f.session.id).items[0]!;
    expect(item.content).toEqual({ inline: { output: "ok" } }); expect(item.metadataRef).toBeDefined();
    expect((JSON.parse(f.text(item.metadataRef!.ref)) as { toolName: string }).toolName).toBe("shell");
    f.commit([{ type: "tool.call.completed", payload: { itemId: "tool", status: "completed", output: "done" } }]);
    const terminal = q.tail(f.session.id).items[0]!;
    expect(terminal.metadataRef?.ref).toBe(item.metadataRef?.ref);
    expect(terminal.content).toEqual({ inline: { status: "completed", output: "done" } });
    expect((f.db.prepare(`SELECT count(*) AS n FROM content_refs WHERE kind = 'blob' AND format = 'application/json'`).get() as { n: number }).n).toBe(1);
  });

  it("moves a long interleaved provenance list to a scoped immutable ref", () => {
    const f = fixture();
    for (let index = 0; index < 40; index++) {
      f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "x" } }]);
      f.commit([{ type: "provider.heartbeat" }]);
    }
    const item = f.query().tail(f.session.id).items[0]!;
    expect(item.sourceSeqRanges).toBeUndefined(); expect(item.sourceSeqRangesRef?.count).toBe(40);
    expect(JSON.parse(f.text(item.sourceSeqRangesRef!.ref))).toHaveLength(40);
    expect(() => f.content.getChunk({ sessionId: "another-session", ref: item.sourceSeqRangesRef!.ref, offset: 0 })).toThrow();
  });
});
