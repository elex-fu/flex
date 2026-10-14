import { describe, expect, it } from "vitest";
import { ReplicaCache } from "./cache-store.js";
import { ClientError } from "./common.js";
import { MemoryClientStore } from "./host-profile-store.js";
import { DraftStore } from "./draft-store.js";
import { deferred } from "./platform-test-support.js";
import type { ReplicaCacheKey, ReplicaCacheRecord } from "./types.js";

const key = (sessionId = "session-a"): ReplicaCacheKey => ({ hostId: "host-a", fingerprint: "pin-a", sessionId, epoch: "epoch-a", projectorVersion: 1 });
const record = (revision = 1): ReplicaCacheRecord<{ items: string[] }> => ({ ...key(), revision, value: { items: ["cached"] }, cachedAt: 100, expiresAt: 1_000, byteLength: 20 });

describe("stale replica cache", () => {
  it("labels restored text stale and lets an authoritative revision replace it", async () => {
    const store = new MemoryClientStore();
    await store.putReplicaCache(record());
    const cache = new ReplicaCache<{ items: string[] }>(store, { now: () => 200 });
    const selection = cache.select(key());
    expect(await cache.load(selection)).toMatchObject({ stale: true, value: { items: ["cached"] }, replicaGeneration: selection.generation });
    expect(cache.acceptLive(selection, 2)).toBe(true);
    expect(await cache.load(selection)).toBeUndefined();
    expect(await cache.save(selection, 2, { items: ["live"] })).toBe(true);
    expect((await store.getReplicaCache(key()))?.value).toEqual({ items: ["live"] });
    expect(await cache.save(selection, 1, { items: ["old"] })).toBe(false);
  });

  it("drops cache reads that arrive after live data or a different session generation", async () => {
    const pending = deferred<ReplicaCacheRecord | undefined>();
    class SlowStore extends MemoryClientStore { override getReplicaCache(): Promise<ReplicaCacheRecord | undefined> { return pending.promise; } }
    const cache = new ReplicaCache(new SlowStore(), { now: () => 200 });
    const selection = cache.select(key());
    const read = cache.load(selection);
    cache.acceptLive(selection, 2);
    pending.resolve(record());
    expect(await read).toBeUndefined();
    const later = deferred<ReplicaCacheRecord | undefined>();
    class LaterStore extends MemoryClientStore { override getReplicaCache(): Promise<ReplicaCacheRecord | undefined> { return later.promise; } }
    const switched = new ReplicaCache(new LaterStore(), { now: () => 200 });
    const old = switched.select(key());
    const oldRead = switched.load(old);
    const current = switched.select(key("session-b"));
    later.resolve(record());
    expect(await oldRead).toBeUndefined();
    expect(switched.isCurrent(current)).toBe(true);
    expect(await switched.save(old, 9, { items: ["wrong-session"] })).toBe(false);
  });

  it("keeps a delayed lower revision from replacing a newer disk entry", async () => {
    const older = deferred<void>();
    class SlowWriteStore extends MemoryClientStore {
      override async putReplicaCache(value: ReplicaCacheRecord): Promise<boolean> { if (value.revision === 1) await older.promise; return super.putReplicaCache(value); }
    }
    const store = new SlowWriteStore();
    const cache = new ReplicaCache(store, { now: () => 200 });
    const selection = cache.select(key());
    const old = cache.save(selection, 1, { text: "old" });
    expect(await cache.save(selection, 2, { text: "new" })).toBe(true);
    older.resolve();
    expect(await old).toBe(false);
    expect((await store.getReplicaCache(key()))?.value).toEqual({ text: "new" });
  });

  it("reports cache write failure without propagating it as a command/storage failure", async () => {
    const errors: ClientError[] = [];
    const store = new MemoryClientStore({ beforeWrite: (operation) => { if (operation === "replicaCache") throw new ClientError("STORAGE_WRITE_FAILED", "quota full"); } });
    const cache = new ReplicaCache(store, { onError: (error) => errors.push(error) });
    expect(await cache.save(cache.select(key()), 1, { text: "conversation" })).toBe(false);
    expect(errors[0]?.code).toBe("CACHE_UNAVAILABLE");
    expect(await store.getReplicaCache(key())).toBeUndefined();
  });

  it("expires readable text/content metadata and applies a per-Host capacity limit", async () => {
    let now = 0;
    const store = new MemoryClientStore();
    const cache = new ReplicaCache<string>(store, { now: () => now, retentionMs: 100, maxBytes: 12 });
    const a = cache.select(key());
    await cache.save(a, 1, "123456");
    await cache.saveContentMetadata(a, { contentId: "content-a", hash: "hash", byteLength: 100 });
    now = 1;
    const b = cache.select(key("session-b"));
    await cache.save(b, 1, "abcdef");
    expect(await store.getReplicaCache(key())).toBeUndefined();
    expect(await store.getReplicaCache(key("session-b"))).toBeDefined();
    now = 101;
    await cache.prune("host-a");
    expect(await store.listReplicaCaches("host-a")).toEqual([]);
    expect(await store.listContentMetadata("host-a")).toEqual([]);
    expect(await cache.load(b)).toBeUndefined();
  });

  it("keeps draft deletion guards distinct for same-millisecond edits", async () => {
    const store = new MemoryClientStore();
    const drafts = new DraftStore(store, () => 10);
    const draftKey = { hostId: "host-a", sessionId: "session-a" };
    const [first, second] = await Promise.all([drafts.save(draftKey, "first"), drafts.save(draftKey, "second")]);
    expect(second.updatedAt).toBe(first.updatedAt + 1);
    await drafts.handoff({ hostId: "host-a", commandId: "command-a", method: "session.startTurn", payload: { prompt: "first" }, payloadHash: "hash", state: "queued", createdAt: "now" }, draftKey, first.updatedAt);
    expect((await drafts.get(draftKey))?.text).toBe("second");
  });
});
