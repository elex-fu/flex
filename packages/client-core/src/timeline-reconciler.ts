import {
  ContentChunkSchema, OpenViewResponseSchema, TimelineInteractionSummarySchema, TimelinePageContentSchema,
  TimelinePageSchema, TimelineResetPayloadSchema, TimelineUpdatedPayloadSchema,
} from "@flyx/mvp-protocol";
import type {
  ContentChunk, ContentChunkRequest, OpenViewRequest, OpenViewResponse, SessionEvent,
  TimelineContentReference, TimelinePage, TimelinePageRequest, TimelineUpdatedPayload,
} from "@flyx/mvp-protocol";
import { ClientError } from "./common.js";
import { SessionReplica, type ReplicaFence } from "./session-replica.js";

export interface TimelineReplicaApi {
  openView(request: OpenViewRequest): Promise<OpenViewResponse>;
  getTimelinePage(request: TimelinePageRequest): Promise<TimelinePage>;
  getContentChunk(request: ContentChunkRequest): Promise<ContentChunk>;
  unsubscribeTimeline(request: { subscriptionId: string }): Promise<unknown>;
}
export interface TimelineReconcilerOptions {
  api: TimelineReplicaApi;
  isCurrentTransport: (generation: number) => boolean;
  maxBufferedPages?: number;
  maxReferenceBytes?: number;
  onBegin?: (fence: ReplicaFence) => Promise<void> | void;
}

/** Consumes canonical pages only. The legacy SyncEngine has a separate event route. */
export class TimelineReconciler {
  private fence: ReplicaFence | undefined;
  private subscriptionId: string | undefined;
  private opening = false;
  private buffer: SessionEvent[] = [];
  private processing: Promise<void> = Promise.resolve();
  private liveFailure: ClientError | undefined;
  constructor(readonly replica: SessionReplica, private options: TimelineReconcilerOptions) {}
  private current(fence: ReplicaFence): boolean { return this.replica.isCurrent(fence) && this.options.isCurrentTransport(fence.transportGeneration); }
  private assertCurrent(fence: ReplicaFence): void { if (!this.current(fence)) throw new ClientError("STALE_REPLICA_RESPONSE", "Session selection changed while loading its view"); if (this.liveFailure) throw this.liveFailure; }
  invalidate(): void { this.fence = undefined; this.subscriptionId = undefined; this.opening = false; this.buffer = []; this.liveFailure = undefined; this.replica.invalidate(); }
  reset(): void { this.fence = undefined; this.subscriptionId = undefined; this.opening = false; this.buffer = []; this.liveFailure = undefined; this.replica.reset(); }

  selectLegacy(sessionId: string, transportGeneration: number): void {
    this.fence = this.replica.begin(sessionId, transportGeneration, "legacy");
    this.subscriptionId = undefined; this.buffer = []; this.opening = false; this.liveFailure = undefined;
  }
  async synchronize(sessionId: string, transportGeneration: number, tailLimit = 50): Promise<void> {
    const previousSubscription = this.subscriptionId;
    const fence = this.replica.begin(sessionId, transportGeneration);
    this.fence = fence; this.subscriptionId = undefined; this.buffer = []; this.opening = true; this.liveFailure = undefined; this.processing = Promise.resolve();
    try {
      if (this.options.onBegin) await this.options.onBegin(fence);
      if (previousSubscription) await this.options.api.unsubscribeTimeline({ subscriptionId: previousSubscription }).catch(() => {});
      this.assertCurrent(fence);
      const cursor = this.replica.cursor;
      let view: OpenViewResponse;
      try { view = await this.options.api.openView({ sessionId, tailLimit, ...(cursor ? { cursor } : {}) }); }
      catch (error) {
        if (!(error instanceof ClientError) || !["EPOCH_MISMATCH", "CURSOR_EXPIRED"].includes(error.code) || !cursor) throw error;
        this.assertCurrent(fence);
        view = await this.options.api.openView({ sessionId, tailLimit });
      }
      this.assertCurrent(fence);
      view = OpenViewResponseSchema.parse(view);
      if (view.sessionId !== sessionId) throw new ClientError("INVALID_OPEN_VIEW", "Host returned a view for another session");
      this.subscriptionId = view.subscriptionId;
      const complete = await this.materializeView(view, fence);
      this.assertCurrent(fence);
      this.replica.open(fence, complete);
      const watermark = view.watermark.sequence;
      while ((this.replica.cursor?.sequence ?? -1) < watermark) {
        this.assertCurrent(fence);
        const afterSequence = this.replica.cursor!.sequence;
        const page = await this.options.api.getTimelinePage({ sessionId, epoch: view.watermark.epoch, direction: "after", afterSequence, upToSequence: watermark });
        const loaded = await this.materializePage(TimelinePageSchema.parse(page), fence);
        this.assertCurrent(fence);
        if (!this.replica.cover(fence, loaded, watermark)) throw new ClientError("TIMELINE_GAP", "Catch-up page did not advance its source cursor");
      }
      this.assertCurrent(fence);
      if (this.replica.cursor?.sequence !== watermark) throw new ClientError("TIMELINE_GAP", "View did not reach its fixed watermark");
      this.opening = false;
      this.processing = this.processing.then(() => this.drain(fence));
      await this.processing;
      this.assertCurrent(fence);
      this.replica.markSynced(fence);
    } catch (error) {
      if (this.current(fence)) { this.opening = false; this.liveFailure = error instanceof ClientError ? error : new ClientError("INVALID_TIMELINE_RESPONSE", "Host returned an invalid timeline response"); this.replica.fail(fence, this.liveFailure); }
      throw error;
    }
  }
  receive(event: SessionEvent, transportGeneration: number): void {
    const fence = this.fence;
    if (!fence || this.liveFailure || !this.current(fence) || fence.transportGeneration !== transportGeneration || fence.sessionId !== event.sessionId || !["timeline.updated", "timeline.reset"].includes(event.type)) return;
    if (this.buffer.length >= (this.options.maxBufferedPages ?? 4096)) {
      this.liveFailure = new ClientError("VIEW_RESYNC_REQUIRED", "Timeline live buffer exceeded its limit"); this.replica.fail(fence, this.liveFailure); this.buffer = []; return;
    }
    this.buffer.push(event);
    if (!this.opening) this.processing = this.processing.then(() => this.drain(fence)).catch((error: unknown) => { if (this.current(fence)) { this.liveFailure = error instanceof ClientError ? error : new ClientError("INVALID_TIMELINE_UPDATE", "Host returned an invalid timeline update"); this.replica.fail(fence, this.liveFailure); } });
  }
  whenIdle(): Promise<void> { return this.processing; }
  private async drain(fence: ReplicaFence): Promise<void> {
    while (this.buffer.length && this.current(fence)) {
      const event = this.buffer.shift()!;
      if (event.type === "timeline.reset") {
        const payload = TimelineResetPayloadSchema.parse(event.payload);
        if (payload.subscriptionId !== this.subscriptionId) continue;
        throw new ClientError("VIEW_RESYNC_REQUIRED", "Host invalidated its timeline subscription", { reason: payload.reason });
      }
      const payload = TimelineUpdatedPayloadSchema.parse(event.payload);
      if (payload.subscriptionId !== this.subscriptionId) continue;
      const { subscriptionId: _subscriptionId, snapshot, snapshotRef, snapshotSequence, interactions, ...page } = payload;
      if (event.sequence !== page.upToSequence) throw new ClientError("TIMELINE_GAP", "Live envelope does not match its source boundary");
      const [loaded, domain] = await Promise.all([
        this.materializePage(page, fence), this.materializeDomain({ snapshot, ...(snapshotRef ? { snapshotRef } : {}), interactions }, fence),
      ]);
      this.assertCurrent(fence);
      this.replica.live(fence, loaded, { ...domain, snapshotSequence });
    }
  }
  async loadOlder(limit = 50): Promise<void> {
    const fence = this.fence; if (!fence) throw new ClientError("NO_SESSION_SELECTED", "Select a session first");
    this.assertCurrent(fence);
    const state = this.replica.getState(); const before = state.loadedWindow.nextBefore ?? state.loadedWindow.first;
    if (!state.loadedWindow.hasOlder || !before || !state.epoch) return;
    const page = await this.options.api.getTimelinePage({ sessionId: fence.sessionId, epoch: state.epoch, direction: "before", beforeDisplaySequence: before.displaySequence, beforeItemId: before.itemId, limit });
    const loaded = await this.materializePage(TimelinePageSchema.parse(page), fence);
    this.assertCurrent(fence); this.replica.before(fence, loaded);
  }
  async readContent(reference: TimelineContentReference, sessionId?: string): Promise<Uint8Array> {
    const fence = this.fence; if (!fence) throw new ClientError("NO_SESSION_SELECTED", "Select a session first");
    if (sessionId !== undefined && sessionId !== fence.sessionId) throw new ClientError("STALE_REPLICA_RESPONSE", "Content belongs to another session selection");
    return this.readReference(reference, fence);
  }
  async resolveItemContent(itemId: string): Promise<unknown> {
    const fence = this.fence; if (!fence) throw new ClientError("NO_SESSION_SELECTED", "Select a session first");
    this.assertCurrent(fence);
    const item = this.replica.getState().items.find((entry) => entry.itemId === itemId);
    if (!item) throw new ClientError("TIMELINE_ITEM_NOT_FOUND", "Timeline item is outside the loaded window");
    const baseMetadata = item.metadataRef ? await this.readJson(item.metadataRef, fence) : {};
    const metadata = item.metadata ?? {};
    let content: unknown;
    if ("inline" in item.content) content = item.content.inline;
    else if (item.contentField) content = { [item.contentField]: new TextDecoder("utf-8", { fatal: true }).decode(await this.readReference(item.content, fence)) };
    else content = await this.readJson(item.content, fence);
    this.assertCurrent(fence);
    if (this.replica.getState().items.find((entry) => entry.itemId === itemId)?.revision !== item.revision) throw new ClientError("STALE_REPLICA_RESPONSE", "Timeline item changed while its content was loading");
    const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    return record(content) ? { ...(record(baseMetadata) ? baseMetadata : {}), ...metadata, ...content } : content;
  }
  private async readReference(reference: TimelineContentReference, fence: ReplicaFence): Promise<Uint8Array> {
    this.assertCurrent(fence);
    if (reference.bytes > (this.options.maxReferenceBytes ?? 32 * 1024 * 1024)) throw new ClientError("CONTENT_TOO_LARGE", "Referenced content exceeds the local loading limit");
    const bytes = new Uint8Array(reference.bytes);
    let offset = 0;
    do {
      const chunk = ContentChunkSchema.parse(await this.options.api.getContentChunk({ sessionId: fence.sessionId, ref: reference.ref, offset, maxBytes: 64 * 1024, encoding: "base64" }));
      this.assertCurrent(fence);
      if (chunk.sessionId !== fence.sessionId || chunk.ref !== reference.ref || chunk.offset !== offset || chunk.totalBytes !== reference.bytes || chunk.sha256 !== reference.sha256 || (reference.format !== undefined && chunk.format !== reference.format)) throw new ClientError("CONTENT_INTEGRITY_FAILED", "Content chunk does not match its immutable reference");
      let part: Uint8Array;
      if (chunk.encoding === "utf8") part = new TextEncoder().encode(chunk.text);
      else { const decoded = atob(chunk.data); part = Uint8Array.from(decoded, (character) => character.charCodeAt(0)); }
      if (part.byteLength !== chunk.nextOffset - offset || (chunk.hasMore && chunk.nextOffset <= offset)) throw new ClientError("CONTENT_INTEGRITY_FAILED", "Content chunk byte coverage is invalid");
      bytes.set(part, offset); offset = chunk.nextOffset;
      if (!chunk.hasMore) break;
    } while (offset < reference.bytes);
    if (offset !== reference.bytes) throw new ClientError("CONTENT_INTEGRITY_FAILED", "Referenced content is incomplete");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    this.assertCurrent(fence);
    if (hash !== reference.sha256) throw new ClientError("CONTENT_INTEGRITY_FAILED", "Referenced content hash does not match");
    return bytes;
  }
  private async readJson(reference: TimelineContentReference, fence: ReplicaFence): Promise<unknown> {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.readReference(reference, fence))) as unknown; }
    catch (error) { if (error instanceof ClientError) throw error; throw new ClientError("INVALID_REFERENCED_CONTENT", "Referenced content is not valid JSON UTF-8"); }
  }
  private async materializePage(page: TimelinePage, fence: ReplicaFence): Promise<TimelinePage> {
    this.assertCurrent(fence);
    if (!page.pageRef) return page;
    const body = TimelinePageContentSchema.parse(await this.readJson(page.pageRef, fence));
    const range = page.coveredSourceRange; const bodyRange = body.coveredSourceRange;
    if (body.epoch !== page.epoch || body.projectorVersion !== page.projectorVersion || body.upToSequence !== page.upToSequence || body.items.length !== page.pageRef.itemCount || range?.fromExclusive !== bodyRange?.fromExclusive || range?.through !== bodyRange?.through) throw new ClientError("CONTENT_INTEGRITY_FAILED", "Referenced page does not match its outer boundary");
    const { pageRef: _pageRef, ...inline } = page;
    return TimelinePageSchema.parse({ ...inline, items: body.items });
  }
  private async materializeDomain(domain: Pick<TimelineUpdatedPayload, "snapshot" | "snapshotRef" | "interactions">, fence: ReplicaFence): Promise<{ snapshot: unknown; interactions: TimelineUpdatedPayload["interactions"] }> {
    const [snapshot, interactions] = await Promise.all([
      domain.snapshotRef ? this.readJson(domain.snapshotRef, fence) : Promise.resolve(domain.snapshot),
      domain.interactions.ref ? this.readJson(domain.interactions.ref, fence) : Promise.resolve(domain.interactions),
    ]);
    this.assertCurrent(fence);
    const loaded = TimelineInteractionSummarySchema.parse(interactions);
    if (!loaded.complete || loaded.ref || loaded.total !== domain.interactions.total || loaded.directoryRevision !== domain.interactions.directoryRevision || loaded.items.length !== loaded.total) throw new ClientError("INVALID_INTERACTION_SUMMARY", "Pending interactions are incomplete or belong to another revision");
    return { snapshot, interactions: loaded };
  }
  private async materializeView(view: OpenViewResponse, fence: ReplicaFence): Promise<OpenViewResponse> {
    const [page, domain] = await Promise.all([this.materializePage(view.page, fence), this.materializeDomain(view, fence)]);
    this.assertCurrent(fence);
    const { snapshotRef: _snapshotRef, ...inline } = view;
    return OpenViewResponseSchema.parse({ ...inline, page, ...domain });
  }
}
