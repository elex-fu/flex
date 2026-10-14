import { afterEach, describe, expect, it } from "vitest";
import { OpenViewResponseSchema, TimelineUpdatedPayloadSchema, type SessionEvent } from "@flyx/mvp-protocol";
import { JsonTimelineBudget, type TimelineLeaseOwner } from "./contracts.js";
import { TimelineFixture } from "./test-support.js";
import { TimelineSubscriptions } from "./timeline-subscriptions.js";

const fixtures: TimelineFixture[] = [];
function fixture() { const value = new TimelineFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });
const owner: TimelineLeaseOwner = { subjectId: "device-a", leaseId: "lease-a", generation: 7 };
async function settle() { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("timeline subscription snapshot boundary", () => {
  it("registers before the snapshot, deduplicates <=W, and holds >W until the response is delivered", async () => {
    const f = fixture(); f.commit([{ type: "user.message.created", payload: { itemId: "first", text: "first" } }]);
    f.source.onSubscribe = () => f.commit([{ type: "provider.heartbeat" }]);
    const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot() });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    expect(opened.response.watermark.sequence).toBe(2);
    expect(opened.response.mode).toBe("cold");
    expect(OpenViewResponseSchema.safeParse(opened.response).success).toBe(true);
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "after W" } }]);
    expect(sent).toEqual([]);
    await opened.activate();
    expect(sent.map((event) => event.sequence)).toEqual([3]);
    const payload = TimelineUpdatedPayloadSchema.parse(sent[0]!.payload);
    expect(payload.coveredSourceRange).toEqual({ fromExclusive: 2, through: 3 });
    expect(payload.snapshotSequence).toBe(3);
    expect(payload.subscriptionId).toBe(opened.response.subscriptionId);
    service.cleanupOwner(owner);
    expect(service.size).toBe(0); expect(f.source.listeners.size).toBe(0);
  });

  it("delivers a commit that arrives while an empty activation drain releases ownership", async () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot() });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    const activation = opened.activate();
    f.commit([{ type: "provider.heartbeat" }]);
    await activation; await settle();
    expect(sent.map((event) => event.sequence)).toEqual([2]);
    service.closeAll();
  });

  it("starts old-cache catch-up at its cursor and sends only new live facts after fixed W", async () => {
    const f = fixture();
    for (let index = 0; index < 6; index++) f.commit([{ type: "provider.heartbeat" }]);
    const q = f.query({ sourcePageLimit: 2 }); const epoch = q.activeEpoch(f.session.id).epoch;
    const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(q, { source: f.source, readSnapshot: () => f.snapshot() });
    const opened = service.openView({ sessionId: f.session.id, cursor: { epoch, sequence: 1 }, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    expect(opened.response.mode).toBe("catch_up"); expect(opened.response.watermark.sequence).toBe(6);
    expect(opened.response.page.coveredSourceRange).toEqual({ fromExclusive: 1, through: 3 });
    expect(opened.response.catchUpComplete).toBe(false);
    await opened.activate(); expect(sent).toEqual([]);
    f.commit([{ type: "provider.heartbeat" }, { type: "turn.started" }]);
    await settle();
    expect(sent).toHaveLength(1);
    expect(TimelineUpdatedPayloadSchema.parse(sent[0]!.payload)).toMatchObject({ coveredSourceRange: { fromExclusive: 6, through: 8 }, items: [], nextCursor: { epoch, sequence: 8 } });
    service.closeAll();
  });

  it("declares a newer snapshot watermark when a committed source notification is delayed", async () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot() });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    await opened.activate();
    const first = f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "old" } }], { publish: false });
    const second = f.commit([{ type: "assistant.message.completed", payload: { itemId: "assistant", text: "new" } }], { publish: false });
    f.source.publish(first); f.source.publish(second); await settle();
    const payload = TimelineUpdatedPayloadSchema.parse(sent[0]!.payload);
    expect(payload.upToSequence).toBe(2); expect(payload.snapshotSequence).toBe(3);
    expect(payload.items[0]!.revision).toBe(2);
    if (!("ref" in payload.items[0]!.content)) throw new Error("Expected body ref");
    expect(f.text(payload.items[0]!.content.ref)).toBe("old");
    expect(TimelineUpdatedPayloadSchema.parse(sent[1]!.payload).coveredSourceRange).toEqual({ fromExclusive: 2, through: 3 });
    service.closeAll();
  });

  it("binds each subscription to its actor, lease generation and Session and cleans all listeners on disconnect", async () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot() });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async () => {});
    expect(() => service.unsubscribe(opened.response.subscriptionId, { ...owner, subjectId: "device-b" })).toThrow("another lease");
    expect(() => service.unsubscribe(opened.response.subscriptionId, { ...owner, generation: 8 })).toThrow("another lease");
    expect(service.size).toBe(1);
    service.cleanupOwner({ ...owner, generation: 8 }); expect(service.size).toBe(1);
    service.cleanupOwner(owner); expect(service.size).toBe(0); expect(f.source.listeners.size).toBe(0);
    await opened.activate();
  });

  it("bounds held live buffers and resets the timeline domain when they overflow", async () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot(), maximumBufferedCommits: 2 });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    for (let index = 0; index < 3; index++) f.commit([{ type: "provider.heartbeat" }]);
    await settle(); await opened.activate();
    expect(sent.map((event) => event.type)).toEqual(["timeline.reset"]);
    expect(sent[0]!.payload).toMatchObject({ reason: "buffer_overflow", subscriptionId: opened.response.subscriptionId });
    expect(service.size).toBe(0); expect(f.source.listeners.size).toBe(0);
  });

  it("bounds encoded buffer bytes and expires a lease without retaining its subscription", async () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    let current = true; const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot(), maximumBufferedBytes: 400, assertOwnerCurrent: () => { if (!current) throw new Error("lease expired"); } });
    const first = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    f.commit([{ type: "provider.heartbeat" }]); await settle();
    expect(sent).toEqual([]);
    await first.activate();
    expect(sent[0]!.payload).toMatchObject({ reason: "buffer_overflow" });
    expect(service.size).toBe(0);
    const next = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async (event) => { sent.push(event); });
    current = false;
    f.commit([{ type: "provider.heartbeat" }]); await settle();
    await next.activate();
    expect(sent[1]!.payload).toMatchObject({ reason: "lease_expired" });
    expect(service.size).toBe(0);
  });

  it("replaces a repeated openView listener for the same lease and Session", () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot() });
    const first = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async () => {});
    const next = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async () => {});
    expect(first.response.subscriptionId).not.toBe(next.response.subscriptionId);
    expect(service.size).toBe(1); expect(f.source.listeners.size).toBe(1);
    service.closeAll();
  });

  it("keeps pending interactions independent of the tail window and references large summaries and snapshots", () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const q = f.query({ budget: new JsonTimelineBudget(8 * 1024) });
    const pending = Array.from({ length: 80 }, (_, index) => ({ id: `approval-${index}`, body: "🙂\n\"".repeat(1_000) }));
    const service = new TimelineSubscriptions(q, { source: f.source, budget: new JsonTimelineBudget(8 * 1024), readSnapshot: () => ({ ...f.snapshot(), pendingApprovals: pending, activeTurn: { prompt: "x".repeat(1024 * 1024 + 1) } }) });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, owner, async () => {});
    const response = OpenViewResponseSchema.parse(opened.response);
    expect(response.page.items).toEqual([]);
    expect(response.interactions.total).toBe(80); expect(response.interactions.complete).toBe(false);
    const directory = JSON.parse(f.text(response.interactions.ref!.ref)) as { total: number; directoryRevision: number; complete: boolean; items: unknown[] };
    expect(directory).toMatchObject({ total: 80, directoryRevision: 1, complete: true }); expect(directory.items).toHaveLength(80);
    expect((JSON.parse(f.text(response.snapshotRef!.ref)) as { activeTurn: { prompt: string } }).activeTurn.prompt.length).toBeGreaterThan(1024 * 1024);
    service.closeAll();
  });
});
