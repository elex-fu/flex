import { ClientError } from "./common.js";
import { replicaStorageKey } from "./host-profile-store.js";
import type { ClientStore, ContentMetadata, ContentMetadataKey, ReplicaCacheKey, ReplicaCacheRecord } from "./types.js";

export interface CacheSelection { readonly key: ReplicaCacheKey; readonly generation: number }
export interface CachedReplica<T = unknown> extends ReplicaCacheRecord<T> { stale: true; replicaGeneration: number }
export interface ReplicaCacheOptions {
  /** Ordinary local storage contains readable conversation text. */
  retentionMs?: number;
  maxBytes?: number;
  now?: () => number;
  onError?: (error: ClientError) => void;
}
/** Cache errors affect presentation only. They do not invalidate a transport. */
export class ReplicaCache<T = unknown> {
  private selection: CacheSelection | undefined;
  private generation = 0;
  private liveRevision: number | undefined;
  private now: () => number;
  readonly retentionMs: number;
  readonly maxBytes: number;
  constructor(private store: ClientStore, private options: ReplicaCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(0, options.retentionMs ?? 24 * 60 * 60_000);
    this.maxBytes = Math.max(0, options.maxBytes ?? 10 * 1024 * 1024);
  }
  select(key: ReplicaCacheKey): CacheSelection {
    this.selection = { key: structuredClone(key), generation: ++this.generation };
    this.liveRevision = undefined;
    return structuredClone(this.selection);
  }
  invalidate(): void { this.generation++; this.selection = undefined; this.liveRevision = undefined; }
  isCurrent(selection: CacheSelection): boolean { return this.selection?.generation === selection.generation && replicaStorageKey(this.selection.key) === replicaStorageKey(selection.key); }
  acceptLive(selection: CacheSelection, revision: number): boolean {
    if (!this.isCurrent(selection) || !Number.isSafeInteger(revision) || revision < 0 || this.liveRevision !== undefined && revision < this.liveRevision) return false;
    this.liveRevision = revision;
    return true;
  }
  private failed(error: unknown): void { this.options.onError?.(new ClientError("CACHE_UNAVAILABLE", "Local conversation cache is unavailable", error)); }
  async load(selection: CacheSelection): Promise<CachedReplica<T> | undefined> {
    if (!this.isCurrent(selection) || this.liveRevision !== undefined) return undefined;
    try {
      const record = await this.store.getReplicaCache(selection.key);
      if (!record || replicaStorageKey(record) !== replicaStorageKey(selection.key) || !this.isCurrent(selection) || this.liveRevision !== undefined) return undefined;
      if (record.expiresAt <= this.now() || this.retentionMs === 0 || this.maxBytes === 0) { await this.store.deleteReplicaCache(selection.key); return undefined; }
      // Cached authority (idle, approvals, deletion) is never restored by this helper.
      return { ...record, value: record.value as T, stale: true, replicaGeneration: selection.generation };
    } catch (error) { this.failed(error); return undefined; }
  }
  async save(selection: CacheSelection, revision: number, value: T): Promise<boolean> {
    if (!this.acceptLive(selection, revision)) return false;
    try {
      const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (this.retentionMs === 0 || byteLength > this.maxBytes) { await this.store.deleteReplicaCache(selection.key); return false; }
      const cachedAt = this.now();
      const stored = await this.store.putReplicaCache({ ...selection.key, revision, value, cachedAt, expiresAt: cachedAt + this.retentionMs, byteLength });
      await this.prune(selection.key.hostId);
      return stored && this.isCurrent(selection) && this.liveRevision === revision;
    } catch (error) { this.failed(error); return false; }
  }
  async getContentMetadata(selection: CacheSelection, contentId: string): Promise<ContentMetadata | undefined> {
    if (!this.isCurrent(selection)) return undefined;
    try {
      const key: ContentMetadataKey = { ...selection.key, contentId };
      const value = await this.store.getContentMetadata(key);
      if (!this.isCurrent(selection) || !value) return undefined;
      if (value.expiresAt <= this.now()) { await this.store.deleteContentMetadata(key); return undefined; }
      return value;
    } catch (error) { this.failed(error); return undefined; }
  }
  async saveContentMetadata(selection: CacheSelection, content: Pick<ContentMetadata, "contentId" | "hash" | "byteLength">): Promise<boolean> {
    if (!this.isCurrent(selection) || this.retentionMs === 0) return false;
    try {
      const cachedAt = this.now();
      await this.store.putContentMetadata({ ...selection.key, ...content, cachedAt, expiresAt: cachedAt + this.retentionMs });
      await this.prune(selection.key.hostId);
      return this.isCurrent(selection);
    } catch (error) { this.failed(error); return false; }
  }
  /** Expiry and capacity cover all sessions for this Host. Oldest entries go first. */
  async prune(hostId: string): Promise<void> {
    const now = this.now();
    const records = (await this.store.listReplicaCaches(hostId)).sort((a, b) => a.cachedAt - b.cachedAt);
    let bytes = records.reduce((total, record) => total + record.byteLength, 0);
    for (const record of records) {
      if (record.expiresAt > now && bytes <= this.maxBytes && this.retentionMs !== 0) continue;
      await this.store.deleteReplicaCache(record);
      bytes -= record.byteLength;
    }
    for (const record of await this.store.listContentMetadata(hostId)) if (record.expiresAt <= now || this.retentionMs === 0) await this.store.deleteContentMetadata(record);
  }
  async clear(hostId: string): Promise<void> {
    try {
      for (const record of await this.store.listReplicaCaches(hostId)) await this.store.deleteReplicaCache(record);
      for (const record of await this.store.listContentMetadata(hostId)) await this.store.deleteContentMetadata(record);
    } catch (error) { this.failed(error); }
  }
}
