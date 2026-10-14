import { describe, expect, it } from "vitest";
import type { OpenViewResponse, ProjectedItem, TimelinePage } from "@flyx/mvp-protocol";
import { SessionReplica } from "./session-replica.js";

const item = (itemId: string, displaySequence: number, revision = displaySequence, sessionId = "session-a", text = itemId): ProjectedItem => ({ sessionId, itemId, kind: "assistant_message", status: "completed", displaySequence, revision, content: { inline: { text } }, updatedAt: "now" });
const page = (from: number, through: number, items: ProjectedItem[] = [], epoch = "epoch-a"): TimelinePage => ({ epoch, projectorVersion: 1, upToSequence: through, items, coveredSourceRange: { fromExclusive: from, through }, nextCursor: { epoch, sequence: through }, hasOlder: false, hasNewer: false, boundaryComplete: true });
const view = (sequence: number, items: ProjectedItem[] = [], sessionId = "session-a", epoch = "epoch-a"): OpenViewResponse => ({ sessionId, subscriptionId: "sub-a", projectorVersion: 1, mode: "cold", watermark: { epoch, sequence }, page: { epoch, projectorVersion: 1, upToSequence: sequence, items, nextCursor: { epoch, sequence }, hasOlder: false, hasNewer: false, boundaryComplete: true }, snapshot: { activeTurn: { id: "turn-a", status: "running" } }, interactions: { total: 0, directoryRevision: sequence, complete: true, items: [] }, catchUpComplete: true });

describe("canonical SessionReplica", () => {
  it("keeps stable display order, replaces full revisions, and separates historical window from consumed source", () => {
    const replica = new SessionReplica(); const fence = replica.begin("session-a", 1);
    replica.open(fence, view(10, [item("later", 8, 10, "session-a", "Hello"), item("earlier", 2)]));
    replica.cover(fence, page(10, 11, [item("later", 8, 11, "session-a", "Hello world")]));
    replica.before(fence, { epoch: "epoch-a", projectorVersion: 1, upToSequence: 11, items: [item("first", 1), item("later", 8, 9, "session-a", "stale")], hasOlder: false, hasNewer: false, boundaryComplete: true });
    const state = replica.getState();
    expect(state.items.map((entry) => entry.itemId)).toEqual(["first", "earlier", "later"]);
    expect(state.items.at(-1)?.content).toEqual({ inline: { text: "Hello world" } });
    expect(state.sourceCursor?.sequence).toBe(11);
    expect(state.loadedWindow.first).toEqual({ displaySequence: 1, itemId: "first" });
  });
  it("advances contiguous complete coverage even if the source batch produces no items", () => {
    const replica = new SessionReplica(); const fence = replica.begin("session-a", 1); replica.open(fence, view(5));
    replica.cover(fence, page(5, 10));
    expect(replica.cursor).toEqual({ epoch: "epoch-a", sequence: 10 });
    expect(replica.getState().items).toEqual([]);
    for (const invalid of [page(11, 12), { ...page(10, 12), boundaryComplete: false }, { ...page(10, 12), nextCursor: { epoch: "epoch-a", sequence: 11 } }]) expect(() => replica.cover(fence, invalid)).toThrow();
    expect(replica.cursor?.sequence).toBe(10);
  });
  it("rejects a malformed multi-item page atomically and does not change its cursor", () => {
    const replica = new SessionReplica(); const fence = replica.begin("session-a", 1); replica.open(fence, view(5, [item("original", 1)]));
    expect(() => replica.cover(fence, page(5, 7, [item("valid", 6), item("foreign", 7, 7, "session-b")]))).toThrow();
    expect(replica.getState().items.map((entry) => entry.itemId)).toEqual(["original"]);
    expect(replica.cursor?.sequence).toBe(5);
  });
  it("fences session, replica generation and transport replacement independently", () => {
    const replica = new SessionReplica(); const old = replica.begin("session-a", 1); replica.open(old, view(5));
    const sameSocket = replica.begin("session-b", 1); replica.open(sameSocket, view(2, [item("b", 1, 1, "session-b")], "session-b"));
    expect(replica.cover(old, page(5, 6, [item("late-a", 6)]))).toBe(false);
    const newTransport = replica.begin("session-b", 2);
    expect(replica.before(sameSocket, { ...page(1, 2), items: [item("late-b", 1, 1, "session-b")] })).toBe(false);
    expect(replica.currentFence()).toEqual(newTransport);
    expect(replica.getState().items.map((entry) => entry.itemId)).toEqual(["b"]);
  });
  it("rebases a cold epoch and never merges canonical pages into legacy mode", () => {
    const replica = new SessionReplica(); const fence = replica.begin("session-a", 1); replica.open(fence, view(5, [item("old", 1)]));
    expect(() => replica.cover(fence, page(5, 6, [], "epoch-b"))).toThrow();
    replica.open(fence, view(2, [item("new", 1)], "session-a", "epoch-b"));
    expect(replica.getState().items.map((entry) => entry.itemId)).toEqual(["new"]);
    expect(replica.cursor).toEqual({ epoch: "epoch-b", sequence: 2 });
    const legacy = replica.begin("session-a", 1, "legacy");
    expect(() => replica.open(legacy, view(5))).toThrowError(/legacy/);
  });
  it("shows cached items as stale but accepts authoritative interactions independently of the window", () => {
    const replica = new SessionReplica(); const fence = replica.begin("session-a", 1);
    replica.restoreCache(fence, { epoch: "epoch-a", projectorVersion: 1, sourceCursor: { epoch: "epoch-a", sequence: 5 }, items: [item("cached-approval", 1)], loadedWindow: { hasOlder: true } });
    expect(replica.getState()).toMatchObject({ stale: true, interactionsAuthoritative: false, sync: "catching_up" });
    const fresh = view(6, [item("tail", 6)]); fresh.interactions = { total: 1, directoryRevision: 6, complete: true, items: [{ approvalId: "outside-tail", turnId: "turn-a", status: "pending" }] };
    replica.open(fence, fresh);
    expect(replica.getState().interactions?.items).toEqual(fresh.interactions.items);
    expect(replica.getState().items.map((entry) => entry.itemId)).toEqual(["tail"]);
    expect(replica.restoreCache(fence, { epoch: "epoch-a", projectorVersion: 1, items: [item("late-cache", 1)], loadedWindow: { hasOlder: true } })).toBe(false);
  });
  it("uses snapshot and directory revisions without claiming their newer source coverage", () => {
    const replica = new SessionReplica(); const fence = replica.begin("session-a", 1); replica.open(fence, view(10));
    replica.live(fence, page(10, 11), { snapshot: { activity: "waiting" }, snapshotSequence: 30, interactions: { total: 1, directoryRevision: 30, complete: true, items: ["pending"] } });
    replica.live(fence, page(10, 11), { snapshot: { activity: "old" }, snapshotSequence: 20, interactions: { total: 0, directoryRevision: 20, complete: true, items: [] } });
    expect(replica.getState()).toMatchObject({ snapshot: { activity: "waiting" }, snapshotSequence: 30, interactions: { items: ["pending"] }, sourceCursor: { sequence: 11 } });
  });
});
