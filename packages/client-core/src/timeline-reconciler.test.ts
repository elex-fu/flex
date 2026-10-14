import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContentChunk, ContentChunkRequest, OpenViewResponse, ProjectedItem, SessionEvent, TimelineContentReference, TimelinePage, TimelinePageRequest } from "@flyx/mvp-protocol";
import { ClientError } from "./common.js";
import { SessionReplica } from "./session-replica.js";
import { TimelineReconciler, type TimelineReplicaApi } from "./timeline-reconciler.js";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const item = (id: string, displaySequence: number, revision = displaySequence, sessionId = "session-a"): ProjectedItem => ({ itemId: id, sessionId, kind: "assistant_message", status: "completed", displaySequence, revision, content: { inline: { text: `full ${revision}` } }, updatedAt: "now" });
const page = (from: number, through: number, items: ProjectedItem[] = [], epoch = "epoch-a"): TimelinePage => ({ epoch, projectorVersion: 1, upToSequence: through, items, coveredSourceRange: { fromExclusive: from, through }, nextCursor: { epoch, sequence: through }, hasOlder: false, hasNewer: false, boundaryComplete: true });
function view(sequence: number, items: ProjectedItem[] = [], sessionId = "session-a", epoch = "epoch-a"): OpenViewResponse {
  return { subscriptionId: `sub-${sessionId}`, sessionId, projectorVersion: 1, mode: "cold", watermark: { epoch, sequence }, page: { epoch, projectorVersion: 1, upToSequence: sequence, items, nextCursor: { epoch, sequence }, hasOlder: false, hasNewer: false, boundaryComplete: true }, snapshot: { session: { id: sessionId, activityState: "running", headSequence: sequence } }, interactions: { total: 0, directoryRevision: sequence, complete: true, items: [] }, catchUpComplete: true };
}
function live(entry: TimelinePage, sessionId = "session-a", subscriptionId = `sub-${sessionId}`): SessionEvent {
  return { id: `live-${entry.upToSequence}`, sessionId, sequence: entry.upToSequence, type: "timeline.updated", occurredAt: "now", payload: { ...entry, subscriptionId, snapshot: { session: { id: sessionId, activityState: "running", headSequence: entry.upToSequence } }, snapshotSequence: entry.upToSequence, interactions: { total: 0, directoryRevision: entry.upToSequence, complete: true, items: [] } } };
}
function apiWith(open: TimelineReplicaApi["openView"], changes: Partial<TimelineReplicaApi> = {}): TimelineReplicaApi {
  return { openView: open, getTimelinePage: async () => { throw new Error("unexpected historical query"); }, getContentChunk: async () => { throw new Error("unexpected content query"); }, unsubscribeTimeline: async () => ({}), ...changes };
}
function blob(value: unknown): { reference: TimelineContentReference; chunk: (request: ContentChunkRequest) => ContentChunk } {
  const bytes = Buffer.from(JSON.stringify(value)); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reference = { ref: `cnt_${sha256.slice(0, 32)}`, bytes: bytes.length, sha256, format: "application/json" };
  return { reference, chunk: (request) => { const nextOffset = Math.min(bytes.length, request.offset + request.maxBytes); return { sessionId: request.sessionId, ref: reference.ref, offset: request.offset, nextOffset, totalBytes: bytes.length, sha256, format: reference.format, hasMore: nextOffset < bytes.length, encoding: "base64", data: bytes.subarray(request.offset, nextOffset).toString("base64") }; } };
}

describe("canonical fixed-watermark reconciliation", () => {
  it("cold-loads the tail of 10,000 sources then catches every page to a fixed W before buffered live coverage", async () => {
    const replica = new SessionReplica(); const requests: TimelinePageRequest[] = []; let opening = 0; let reconciler!: TimelineReconciler;
    const api = apiWith(async () => {
      if (++opening === 1) { const tail = Array.from({ length: 50 }, (_, index) => item(`item-${9951 + index}`, 9951 + index)); const result = view(10_000, tail); result.page.hasOlder = true; return result; }
      reconciler.receive(live(page(12_000, 12_001)), 2);
      const result = view(12_000); result.mode = "catch_up"; result.page = { ...page(10_000, 10_100), hasNewer: true }; result.catchUpComplete = false; return result;
    }, { getTimelinePage: async (request) => { requests.push(request); if (request.direction !== "after") throw new Error("after expected"); const end = Math.min(request.afterSequence + 100, request.upToSequence); return { ...page(request.afterSequence, end, end === 12_000 ? [item("item-10000", 10_000, 12_000)] : []), hasNewer: end < request.upToSequence }; } });
    let generation = 1; reconciler = new TimelineReconciler(replica, { api, isCurrentTransport: (value) => value === generation });
    await reconciler.synchronize("session-a", 1);
    expect(replica.cursor?.sequence).toBe(10_000); expect(replica.getState().items).toHaveLength(50); expect(requests).toEqual([]);
    generation = 2; await reconciler.synchronize("session-a", 2);
    expect(requests).toHaveLength(19); expect(requests.every((request) => request.direction === "after" && request.upToSequence === 12_000)).toBe(true);
    expect(replica.cursor?.sequence).toBe(12_001); expect(replica.getState().items.at(-1)?.content).toEqual({ inline: { text: "full 12000" } });
    expect(replica.getState().sync).toBe("synced");
  });
  it("loads and verifies a huge page reference before exposing any items or claiming its cursor", async () => {
    const replica = new SessionReplica(); const items = Array.from({ length: 10_000 }, (_, index) => item(`item-${index + 1}`, index + 1));
    const content = blob({ epoch: "epoch-a", projectorVersion: 1, upToSequence: 10_000, items });
    const result = view(10_000); result.page.pageRef = { ...content.reference, itemCount: items.length };
    let chunks = 0; const observations: Array<{ count: number; cursor?: number }> = [];
    replica.onChange((state) => observations.push({ count: state.items.length, ...(state.sourceCursor ? { cursor: state.sourceCursor.sequence } : {}) }));
    const reconciler = new TimelineReconciler(replica, { api: apiWith(async () => result, { getContentChunk: async (request) => { chunks++; expect(replica.cursor).toBeUndefined(); expect(replica.getState().items).toHaveLength(0); return content.chunk(request); } }), isCurrentTransport: () => true });
    await reconciler.synchronize("session-a", 1);
    expect(chunks).toBeGreaterThan(10); expect(replica.getState().items).toHaveLength(10_000); expect(replica.cursor?.sequence).toBe(10_000);
    expect(observations.filter((state) => state.cursor === 10_000).every((state) => state.count === 10_000)).toBe(true);
  });
  it("does not consume a referenced page whose final bytes or outer identity fail verification", async () => {
    for (const corruptBytes of [true, false]) {
      const replica = new SessionReplica(); const content = blob({ epoch: "epoch-a", projectorVersion: 1, upToSequence: corruptBytes ? 5 : 4, items: [item("item", 1)] });
      const result = view(5); result.page.pageRef = { ...content.reference, itemCount: 1 };
      const reconciler = new TimelineReconciler(replica, { api: apiWith(async () => result, { getContentChunk: async (request) => { const chunk = content.chunk(request); return corruptBytes && chunk.encoding === "base64" ? { ...chunk, data: Buffer.alloc(chunk.nextOffset - chunk.offset, 65).toString("base64") } : chunk; } }), isCurrentTransport: () => true });
      await expect(reconciler.synchronize("session-a", 1)).rejects.toMatchObject({ code: "CONTENT_INTEGRITY_FAILED" });
      expect(replica.cursor).toBeUndefined(); expect(replica.getState()).toMatchObject({ items: [], sync: "resync_required", interactionsAuthoritative: false });
    }
  });
  it("discards a late page-reference chunk after selecting another session on the same socket", async () => {
    const replica = new SessionReplica(); const started = deferred<void>(); const blocked = deferred<void>();
    const content = blob({ epoch: "epoch-a", projectorVersion: 1, upToSequence: 5, items: [item("a", 1)] });
    const a = view(5); a.page.pageRef = { ...content.reference, itemCount: 1 };
    const reconciler = new TimelineReconciler(replica, { api: apiWith(async (request) => request.sessionId === "session-a" ? a : view(2, [item("b", 1, 1, "session-b")], "session-b"), { getContentChunk: async (request) => { started.resolve(); await blocked.promise; return content.chunk(request); } }), isCurrentTransport: () => true });
    const old = reconciler.synchronize("session-a", 1); const rejected = expect(old).rejects.toMatchObject({ code: "STALE_REPLICA_RESPONSE" });
    await started.promise; await reconciler.synchronize("session-b", 1); blocked.resolve(); await rejected;
    expect(replica.getState()).toMatchObject({ sessionId: "session-b", sync: "synced", items: [{ itemId: "b" }], sourceCursor: { sequence: 2 } });
  });
  it("fences a late same-session open response after transport generation changes", async () => {
    const oldResponse = deferred<OpenViewResponse>(); const replica = new SessionReplica(); let generation = 1; let calls = 0;
    const reconciler = new TimelineReconciler(replica, { api: apiWith(async () => ++calls === 1 ? oldResponse.promise : view(3, [item("new", 3)])), isCurrentTransport: (value) => generation === value });
    const old = reconciler.synchronize("session-a", 1); const rejected = expect(old).rejects.toMatchObject({ code: "STALE_REPLICA_RESPONSE" });
    generation = 2; await reconciler.synchronize("session-a", 2); oldResponse.resolve(view(2, [item("old", 2)])); await rejected;
    expect(replica.getState().items.map((entry) => entry.itemId)).toEqual(["new"]);
  });
  it("ignores raw duplicates and old subscriptions, applies no-item live batches, and stops on epoch/gap errors", async () => {
    const replica = new SessionReplica(); const reconciler = new TimelineReconciler(replica, { api: apiWith(async () => view(5, [item("item", 1)])), isCurrentTransport: (value) => value === 1 });
    await reconciler.synchronize("session-a", 1);
    reconciler.receive({ ...live(page(5, 6)), type: "assistant.message.delta", payload: { itemId: "item", text: "must not append" } }, 1);
    reconciler.receive(live(page(5, 6), "session-a", "old-subscription"), 1);
    reconciler.receive(live(page(5, 6)), 2);
    reconciler.receive(live(page(5, 6)), 1); reconciler.receive(live(page(5, 6)), 1);
    await reconciler.whenIdle(); expect(replica.cursor?.sequence).toBe(6); expect(replica.getState().items[0]?.content).toEqual({ inline: { text: "full 1" } });
    reconciler.receive(live(page(6, 7, [], "epoch-new")), 1); await reconciler.whenIdle();
    expect(replica.getState()).toMatchObject({ sync: "resync_required", sourceCursor: { sequence: 6 }, interactionsAuthoritative: false });
  });
  it("reopens cold after epoch invalidation and never repeats the openView subscription", async () => {
    const replica = new SessionReplica(); let calls = 0; const cursors: unknown[] = []; let unsubscribed = 0;
    const api = apiWith(async (request) => { cursors.push(request.cursor); if (++calls === 1) return view(5, [item("old", 1)]); if (request.cursor) throw new ClientError("EPOCH_MISMATCH", "retired"); return view(2, [item("new", 1)], "session-a", "epoch-new"); }, { unsubscribeTimeline: async () => { unsubscribed++; return {}; } });
    const reconciler = new TimelineReconciler(replica, { api, isCurrentTransport: () => true }); await reconciler.synchronize("session-a", 1); await reconciler.synchronize("session-a", 1);
    expect(cursors).toEqual([undefined, { epoch: "epoch-a", sequence: 5 }, undefined]); expect(unsubscribed).toBe(1); expect(replica.cursor).toEqual({ epoch: "epoch-new", sequence: 2 });
  });
  it("keeps pending interaction references independent of tail items and verifies their complete directory", async () => {
    const directory = { total: 1, directoryRevision: 9, complete: true, items: [{ approvalId: "older-approval", status: "pending" }] };
    const content = blob(directory); const result = view(9, [item("tail", 9)]); result.interactions = { total: 1, directoryRevision: 9, complete: false, items: [], ref: content.reference };
    const replica = new SessionReplica(); const reconciler = new TimelineReconciler(replica, { api: apiWith(async () => result, { getContentChunk: async (request) => content.chunk(request) }), isCurrentTransport: () => true });
    await reconciler.synchronize("session-a", 1); expect(replica.getState()).toMatchObject({ interactions: directory, interactionsAuthoritative: true, items: [{ itemId: "tail" }] });
  });
  it("allows migrated unknown historical boundaries only while catching up to authoritative W", async () => {
    const replica = new SessionReplica(); let calls = 0;
    const api = apiWith(async () => { const result = view(++calls === 1 ? 5 : 8); result.page.boundaryComplete = false; if (calls > 1) { result.mode = "catch_up"; result.page = { ...page(5, 6), boundaryComplete: false, hasNewer: true }; result.catchUpComplete = false; } return result; }, { getTimelinePage: async () => ({ ...page(6, 8), boundaryComplete: false }) });
    const reconciler = new TimelineReconciler(replica, { api, isCurrentTransport: () => true }); await reconciler.synchronize("session-a", 1); await reconciler.synchronize("session-a", 1);
    expect(replica.getState()).toMatchObject({ sync: "synced", interactionsAuthoritative: true, sourceCursor: { sequence: 8 } });
    reconciler.receive(live({ ...page(8, 9), boundaryComplete: false }), 1); await reconciler.whenIdle(); expect(replica.getState().sync).toBe("resync_required"); expect(replica.cursor?.sequence).toBe(8);
  });
  it("serializes referenced live pages arriving while the initial buffered page is loading", async () => {
    const replica = new SessionReplica(); const started = deferred<void>(); const blocked = deferred<void>();
    const content = blob({ epoch: "epoch-a", projectorVersion: 1, upToSequence: 6, coveredSourceRange: { fromExclusive: 5, through: 6 }, items: [item("reply", 1, 6)] });
    let reconciler!: TimelineReconciler;
    const api = apiWith(async () => { reconciler.receive(live({ ...page(5, 6), pageRef: { ...content.reference, itemCount: 1 } }), 1); return view(5); }, { getContentChunk: async (request) => { started.resolve(); await blocked.promise; return content.chunk(request); } });
    reconciler = new TimelineReconciler(replica, { api, isCurrentTransport: () => true }); const synchronizing = reconciler.synchronize("session-a", 1); await started.promise;
    reconciler.receive(live(page(6, 7, [item("reply", 1, 7)])), 1); blocked.resolve(); await synchronizing; await reconciler.whenIdle(); expect(replica.getState()).toMatchObject({ sync: "synced", sourceCursor: { sequence: 7 }, items: [{ revision: 7 }] });
  });
  it("does not accept a live buffer overflow as a successful cold load", async () => {
    const replica = new SessionReplica(); let reconciler!: TimelineReconciler;
    const api = apiWith(async () => { reconciler.receive(live(page(5, 6)), 1); reconciler.receive(live(page(6, 7)), 1); return view(5); });
    reconciler = new TimelineReconciler(replica, { api, maxBufferedPages: 1, isCurrentTransport: () => true }); await expect(reconciler.synchronize("session-a", 1)).rejects.toMatchObject({ code: "VIEW_RESYNC_REQUIRED" }); expect(replica.cursor).toBeUndefined(); expect(replica.getState().sync).toBe("resync_required");
  });

  it("merges verified ancillary metadata without replacing an inline body", async () => {
    const content = blob({ toolName: "old name", turnId: "turn-a" }); const projected = item("reply", 1); projected.metadataRef = content.reference; projected.metadata = { toolName: "Bash" };
    const replica = new SessionReplica(); const reconciler = new TimelineReconciler(replica, { api: apiWith(async () => view(5, [projected]), { getContentChunk: async (request) => content.chunk(request) }), isCurrentTransport: () => true });
    await reconciler.synchronize("session-a", 1); expect(await reconciler.resolveItemContent("reply")).toEqual({ toolName: "Bash", turnId: "turn-a", text: "full 1" });
  });

});
