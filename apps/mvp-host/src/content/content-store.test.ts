import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ContentChunkSchema, type ContentChunk, type ContentRef } from "@flyx/mvp-protocol";
import { CONTENT_SCHEMA_SQL } from "../storage/migrations/006-content.js";
import { ContentStore, type ContentStoreOptions } from "./content-store.js";
import { FrameBudget } from "./frame-budget.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });
function fixture(options: ContentStoreOptions = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('session-a'), ('session-b');");
  db.exec(CONTENT_SCHEMA_SQL);
  open.push(db);
  return { db, store: new ContentStore(db, { now: () => "2026-10-01T00:00:00.000Z", ...options }) };
}
function read(store: ContentStore, ref: ContentRef, maxBytes = 13, budget = new FrameBudget(), encoding: "utf8" | "base64" = "utf8"): Buffer {
  let offset = 0;
  const pieces: Buffer[] = [];
  for (;;) {
    const envelope = (payload: ContentChunk) => ({ type: "response", id: "id".repeat(64), ok: true, payload, transportGeneration: Number.MAX_SAFE_INTEGER });
    const chunk = store.getChunk({ sessionId: "session-a", ref: ref.ref, offset, maxBytes, encoding }, { budget, envelope });
    ContentChunkSchema.parse(chunk);
    expect(budget.bytes(envelope(chunk))).toBeLessThanOrEqual(budget.limit);
    expect(chunk.offset).toBe(offset);
    pieces.push(chunk.encoding === "utf8" ? Buffer.from(chunk.text) : Buffer.from(chunk.data, "base64"));
    if (!chunk.hasMore) break;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset;
  }
  const result = Buffer.concat(pieces);
  expect(result.length).toBe(ref.bytes);
  expect(createHash("sha256").update(result).digest("hex")).toBe(ref.sha256);
  return result;
}

describe("ContentStore immutable public content", () => {
  it("redacts split roots and Unicode before storing/hash/chunks, while old prefixes stay fixed", () => {
    const workspace = "/private/work/a/a";
    const { db, store } = fixture();
    const { streamId } = store.beginStream({ sessionId: "session-a", itemId: "assistant", format: "text/plain", workspace });
    const first = store.appendSegment({ streamId, sourceSequence: 1, text: "start /private/wo" });
    expect(read(store, first).toString()).toBe("start ");
    const second = store.appendSegment({ streamId, sourceSequence: 2, text: "rk/a/a/文件 \ud83d" });
    const third = new ContentStore(db).appendSegment({ streamId, sourceSequence: 3, text: "\ude80 end /private/" });
    const final = store.finalizeStream({ streamId, sourceSequence: 4 });
    expect(read(store, second).toString()).toBe("start ./文件 ");
    expect(read(store, third).toString()).toBe("start ./文件 🚀 end ");
    expect(read(store, final).toString()).toBe("start ./文件 🚀 end /private/");
    expect(read(store, first).toString()).toBe("start ");
    const raw = db.prepare("SELECT data FROM content_segments WHERE stream_id = ? ORDER BY byte_start").all(streamId) as Array<{ data: Buffer }>;
    expect(Buffer.concat(raw.map((row) => row.data)).toString()).not.toContain(workspace);
  });

  it("flushes a suffix at the same source sequence without mutating a published prefix", () => {
    const { db, store } = fixture();
    const { streamId } = store.beginStream({ sessionId: "session-a", itemId: "final-delta", format: "text/plain", workspace: "/root/secret" });
    const prefix = store.appendSegment({ streamId, sourceSequence: 1, text: "complete /root/" });
    const final = store.finalizeStream({ streamId, sourceSequence: 1 });
    expect(read(store, prefix).toString()).toBe("complete ");
    expect(read(store, final).toString()).toBe("complete /root/");
    expect(store.finalizeStream({ streamId, sourceSequence: 1 })).toEqual(final);
    expect(db.prepare("SELECT count(*) AS n FROM content_segments").get()).toEqual({ n: 2 });
  });

  it("uses exact envelope bytes for escaped JSON, Chinese, emoji and base64 chunks", () => {
    const { store } = fixture();
    const body = ('中文🚀\n\t"\\').repeat(3_000);
    const ref = store.putBlob({ sessionId: "session-a", format: "text/plain", text: body });
    const budget = new FrameBudget({ maxFrameBytes: 2_048, responseBytes: 1_536 });
    expect(read(store, ref, 192 * 1024, budget).toString()).toBe(body);
    expect(read(store, ref, 192 * 1024, budget, "base64").toString()).toBe(body);
    expect(() => store.getChunk({ sessionId: "session-a", ref: ref.ref, offset: 1, maxBytes: 64 })).toThrow(/align with UTF-8/);
  });

  it("publishes binary bytes with a fixed public hash and explicit base64 encoding", () => {
    const { store } = fixture();
    const body = Buffer.concat([Buffer.from([0xff, 0, 0x80]), Buffer.from("/private/work/file"), Buffer.from([1, 2, 3])]);
    const expected = Buffer.concat([Buffer.from([0xff, 0, 0x80]), Buffer.from("./file"), Buffer.from([1, 2, 3])]);
    const ref = store.putBytes({ sessionId: "session-a", format: "application/octet-stream", data: body, workspace: "/private/work" });
    expect(read(store, ref, 3, new FrameBudget(), "base64")).toEqual(expected);
    expect(() => store.getChunk({ sessionId: "session-a", ref: ref.ref })).toThrow(/requires base64/);
  });

  it("joins the source transaction and recovers hash state after rollback and reopening", () => {
    const { db, store } = fixture();
    const { streamId } = store.beginStream({ sessionId: "session-a", itemId: "item", format: "text/plain" });
    const first = store.appendSegment({ streamId, sourceSequence: 1, text: "first " });
    let failed: ContentRef | undefined;
    expect(() => db.transaction(() => {
      failed = store.appendSegment({ streamId, sourceSequence: 2, text: "bad suffix" });
      store.pin({ sessionId: "session-a", ref: failed.ref, ownerKind: "recovery", ownerId: "turn-1" });
      throw new Error("projection failure");
    })()).toThrow("projection failure");
    expect(() => store.getRef("session-a", failed!.ref)).toThrow(/does not exist/);
    expect(db.prepare("SELECT count(*) AS n FROM content_pins").get()).toEqual({ n: 0 });
    const after = store.appendSegment({ streamId, sourceSequence: 2, text: "good suffix" });
    const reopened = new ContentStore(db);
    const final = reopened.finalizeStream({ streamId, sourceSequence: 3 });
    expect(read(reopened, first).toString()).toBe("first ");
    expect(read(reopened, after).toString()).toBe("first good suffix");
    expect(read(reopened, final).toString()).toBe("first good suffix");
  });

  it("stores only each new segment once across 1,000 prefix revisions", () => {
    const { db, store } = fixture();
    const { streamId } = store.beginStream({ sessionId: "session-a", itemId: "long-answer", format: "text/plain" });
    let ref!: ContentRef;
    for (let sequence = 1; sequence <= 1_000; sequence += 1) ref = store.appendSegment({ streamId, sourceSequence: sequence, text: "x".repeat(100) });
    expect(db.prepare("SELECT count(*) AS n, SUM(length(data)) AS bytes FROM content_segments").get()).toEqual({ n: 1_000, bytes: 100_000 });
    expect(db.prepare("SELECT count(*) AS n, SUM(length(blob_data)) AS bytes FROM content_refs").get()).toEqual({ n: 1_000, bytes: null });
    expect(db.prepare("SELECT stored_bytes AS bytes FROM content_storage_state").get()).toEqual({ bytes: 100_000 });
    expect(read(store, ref, 64 * 1024).toString()).toHaveLength(100_000);
  });

  it("keeps pinned prefixes and metadata, expires unpinned bodies, and reclaims only unused segments", () => {
    const { db, store } = fixture();
    const { streamId } = store.beginStream({ sessionId: "session-a", itemId: "item", format: "text/plain" });
    const first = store.appendSegment({ streamId, sourceSequence: 1, text: "A" });
    const second = store.appendSegment({ streamId, sourceSequence: 2, text: "B" });
    store.finalizeStream({ streamId, sourceSequence: 3 });
    store.pin({ sessionId: "session-a", ref: first.ref, ownerKind: "query", ownerId: "view-1", expiresAt: "2026-10-15T00:00:00.000Z" });
    expect(store.sweep({ createdBefore: "2026-10-10", now: "2026-10-14" })).toEqual({ refsExpired: 2, segmentsDeleted: 1 });
    expect(read(store, first).toString()).toBe("A");
    expect(() => store.getChunk({ sessionId: "session-a", ref: second.ref })).toThrow(/expired/);
    expect(db.prepare("SELECT id, state, byte_length, sha256 FROM content_refs WHERE id = ?").get(second.ref)).toEqual({ id: second.ref, state: "expired", byte_length: 2, sha256: second.sha256 });
    expect(store.sweep({ createdBefore: "2026-10-10", now: "2026-10-16" })).toEqual({ refsExpired: 1, segmentsDeleted: 1 });
    expect(() => store.getRef("session-a", first.ref)).toThrow(/expired/);
    expect(db.prepare("SELECT stored_bytes AS bytes FROM content_storage_state").get()).toEqual({ bytes: 0 });
  });

  it("protects open streams, checkpoint/recovery pins and admission when storage is full", () => {
    const { db, store } = fixture({ maxStoredBytes: 8 });
    const first = store.putBlob({ sessionId: "session-a", format: "text/plain", text: "1234" });
    store.pin({ sessionId: "session-a", ref: first.ref, ownerKind: "checkpoint", ownerId: "diff-1" });
    const { streamId } = store.beginStream({ sessionId: "session-a", itemId: "item", format: "text/plain" });
    const active = store.appendSegment({ streamId, sourceSequence: 1, text: "abcd" });
    expect(() => store.putBlob({ sessionId: "session-a", format: "text/plain", text: "too much" })).toThrow(/storage limit/);
    expect(store.sweep({ createdBefore: "2026-10-10" }).refsExpired).toBe(0);
    expect(read(store, active).toString()).toBe("abcd");
    expect(db.prepare("SELECT stored_bytes AS bytes FROM content_storage_state").get()).toEqual({ bytes: 8 });
    store.unpin("checkpoint", "diff-1");
    store.sweep({ createdBefore: "2026-10-10" });
    expect(store.putBlob({ sessionId: "session-a", format: "text/plain", text: "free" }).bytes).toBe(4);
  });

  it("checks Session, actor and original scope before body access and rejects arbitrary paths", () => {
    const { store } = fixture();
    const ref = store.putBlob({ sessionId: "session-a", format: "text/plain", text: "private receipt", subjectId: "device-a", requiredScope: "access:admin" });
    expect(() => store.getChunk({ sessionId: "session-b", ref: ref.ref }, { subjectId: "device-a", assertScope: () => {} })).toThrow(/different Session/);
    expect(() => store.getChunk({ sessionId: "session-a", ref: ref.ref }, { subjectId: "device-b", assertScope: () => {} })).toThrow(/different actor/);
    expect(() => store.getChunk({ sessionId: "session-a", ref: ref.ref }, { subjectId: "device-a" })).toThrow(/additional permission/);
    expect(() => store.getRef("session-a", "/etc/passwd")).toThrow(/does not exist/);
    expect(() => store.getChunk({ sessionId: "session-a", ref: ref.ref }, { subjectId: "device-a", assertScope: () => { throw new Error("denied"); } })).toThrow("denied");
  });
});
