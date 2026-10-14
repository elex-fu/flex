import { ProjectedItemSchema } from "@flyx/mvp-protocol";
import type { OpenViewResponse, ProjectedItem, TimelineCursor, TimelineInteractionSummary, TimelinePage } from "@flyx/mvp-protocol";
import { ClientError, errorInfo, Signal } from "./common.js";
import type { ClientErrorInfo, SyncState, Unsubscribe } from "./types.js";

export type ReplicaMode = "legacy" | "canonical";
export interface ReplicaFence { sessionId: string; replicaGeneration: number; transportGeneration: number }
export interface ReplicaWindow {
  first?: { displaySequence: number; itemId: string };
  last?: { displaySequence: number; itemId: string };
  nextBefore?: { displaySequence: number; itemId: string };
  hasOlder: boolean;
}
export interface SessionReplicaState {
  sessionId?: string;
  replicaGeneration: number;
  transportGeneration: number;
  mode: ReplicaMode;
  sync: SyncState;
  epoch?: string;
  projectorVersion?: number;
  sourceCursor?: TimelineCursor;
  items: ProjectedItem[];
  loadedWindow: ReplicaWindow;
  snapshot?: unknown;
  snapshotSequence?: number;
  interactions?: TimelineInteractionSummary;
  interactionsAuthoritative: boolean;
  stale: boolean;
  error?: ClientErrorInfo;
}

/** Canonical items and source coverage are separate: a tail is not a source replay. */
export class SessionReplica {
  private items = new Map<string, ProjectedItem>();
  private order: string[] = [];
  private state: Omit<SessionReplicaState, "items"> = {
    replicaGeneration: 0, transportGeneration: -1, mode: "canonical", sync: "unknown",
    loadedWindow: { hasOlder: false }, interactionsAuthoritative: false, stale: true,
  };
  private changes = new Signal<SessionReplicaState>();

  get cursor(): TimelineCursor | undefined { return this.state.sourceCursor ? { ...this.state.sourceCursor } : undefined; }
  getState(): SessionReplicaState { return structuredClone({ ...this.state, items: this.order.map((id) => this.items.get(id)!) }); }
  onChange(handler: (state: SessionReplicaState) => void): Unsubscribe { handler(this.getState()); return this.changes.subscribe(handler); }
  private emit(): void { this.changes.emit(this.getState()); }
  currentFence(): ReplicaFence | undefined {
    return this.state.sessionId ? { sessionId: this.state.sessionId, replicaGeneration: this.state.replicaGeneration, transportGeneration: this.state.transportGeneration } : undefined;
  }
  isCurrent(fence: ReplicaFence): boolean {
    return this.state.sessionId === fence.sessionId && this.state.replicaGeneration === fence.replicaGeneration && this.state.transportGeneration === fence.transportGeneration;
  }
  begin(sessionId: string, transportGeneration: number, mode: ReplicaMode = "canonical"): ReplicaFence {
    if (!sessionId || !Number.isSafeInteger(transportGeneration) || transportGeneration < 0) throw new ClientError("INVALID_REPLICA_SELECTION", "Invalid session selection");
    const changed = sessionId !== this.state.sessionId || mode !== this.state.mode;
    if (changed) {
      this.items.clear(); this.order = [];
      this.state = { replicaGeneration: this.state.replicaGeneration, transportGeneration, mode, sync: "unknown", loadedWindow: { hasOlder: false }, interactionsAuthoritative: false, stale: true };
    }
    this.state.sessionId = sessionId;
    this.state.mode = mode;
    this.state.transportGeneration = transportGeneration;
    this.state.replicaGeneration++;
    this.state.sync = "catching_up";
    this.state.stale = true;
    this.state.interactionsAuthoritative = false;
    delete this.state.error;
    this.emit();
    return this.currentFence()!;
  }
  invalidate(): void {
    this.state.replicaGeneration++;
    this.state.transportGeneration = -1;
    this.state.sync = "unknown";
    this.state.interactionsAuthoritative = false;
    this.state.stale = true;
    this.emit();
  }
  reset(): void {
    this.items.clear(); this.order = [];
    this.state = { replicaGeneration: this.state.replicaGeneration + 1, transportGeneration: -1, mode: "canonical", sync: "unknown", loadedWindow: { hasOlder: false }, interactionsAuthoritative: false, stale: true };
    this.emit();
  }
  fail(fence: ReplicaFence, error: unknown): void {
    if (!this.isCurrent(fence)) return;
    this.state.sync = "resync_required";
    this.state.stale = true;
    this.state.interactionsAuthoritative = false;
    this.state.error = errorInfo(error);
    this.emit();
  }
  markSynced(fence: ReplicaFence): boolean {
    if (!this.isCurrent(fence)) return false;
    this.state.sync = "synced"; this.state.stale = false; delete this.state.error; this.emit(); return true;
  }
  private requireCanonical(fence: ReplicaFence): boolean {
    if (!this.isCurrent(fence)) return false;
    if (this.state.mode !== "canonical") throw new ClientError("REPLICA_MODE_MISMATCH", "Canonical updates cannot enter a legacy replica");
    return true;
  }
  private validateItems(fence: ReplicaFence, page: TimelinePage): void {
    const seen = new Set<string>();
    for (const item of page.items) {
      if (item.sessionId !== fence.sessionId || item.revision > page.upToSequence || item.displaySequence > item.revision || seen.has(item.itemId)) {
        throw new ClientError("INVALID_TIMELINE_PAGE", "Timeline item does not belong to the page boundary");
      }
      if (item.sourceSeqRanges?.some((range) => range.end > item.revision)) throw new ClientError("INVALID_TIMELINE_PAGE", "Item source range exceeds its revision");
      seen.add(item.itemId);
      const existing = this.items.get(item.itemId);
      if (existing && existing.displaySequence !== item.displaySequence) throw new ClientError("INVALID_TIMELINE_PAGE", "Timeline display order changed for an existing item");
    }
  }
  private mergeItems(items: ProjectedItem[]): void {
    let orderChanged = false;
    for (const item of items) {
      const current = this.items.get(item.itemId);
      if (current && current.revision >= item.revision) continue;
      if (!current) orderChanged = true;
      this.items.set(item.itemId, structuredClone(item));
    }
    if (orderChanged) this.order = [...this.items.keys()].sort((left, right) => {
      const a = this.items.get(left)!; const b = this.items.get(right)!;
      return a.displaySequence - b.displaySequence || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
    });
    const first = this.items.get(this.order[0] ?? ""); const last = this.items.get(this.order.at(-1) ?? "");
    this.state.loadedWindow = {
      ...this.state.loadedWindow,
      ...(first ? { first: { displaySequence: first.displaySequence, itemId: first.itemId } } : {}),
      ...(last ? { last: { displaySequence: last.displaySequence, itemId: last.itemId } } : {}),
    };
  }
  /** Cached items may be displayed, but never grant runnable/Interaction authority. */
  restoreCache(fence: ReplicaFence, cache: Pick<SessionReplicaState, "epoch" | "projectorVersion" | "sourceCursor" | "items" | "loadedWindow">): boolean {
    if (!this.requireCanonical(fence) || this.state.sourceCursor || this.state.interactionsAuthoritative) return false;
    if (!cache.epoch || cache.projectorVersion === undefined) return false;
    if (cache.sourceCursor && cache.sourceCursor.epoch !== cache.epoch) return false;
    const items = cache.items.map((item) => ProjectedItemSchema.parse(item));
    const page = { epoch: cache.epoch, projectorVersion: cache.projectorVersion, upToSequence: cache.sourceCursor?.sequence ?? Number.MAX_SAFE_INTEGER, items } as TimelinePage;
    this.validateItems(fence, page);
    this.state.epoch = cache.epoch; this.state.projectorVersion = cache.projectorVersion;
    this.state.loadedWindow = structuredClone(cache.loadedWindow);
    if (cache.sourceCursor) this.state.sourceCursor = structuredClone(cache.sourceCursor);
    this.mergeItems(items); this.state.stale = true; this.emit(); return true;
  }
  open(fence: ReplicaFence, view: OpenViewResponse): boolean {
    if (!this.requireCanonical(fence)) return false;
    if (view.sessionId !== fence.sessionId || view.page.pageRef || view.snapshotRef || view.interactions.ref || !view.interactions.complete || view.watermark.epoch !== view.page.epoch || view.projectorVersion !== view.page.projectorVersion) {
      throw new ClientError("INVALID_OPEN_VIEW", "View is incomplete or belongs to another projection");
    }
    if (view.mode === "cold") {
      if (view.page.upToSequence !== view.watermark.sequence || view.page.nextCursor?.sequence !== view.watermark.sequence || view.page.nextCursor.epoch !== view.watermark.epoch || !view.catchUpComplete) throw new ClientError("INVALID_OPEN_VIEW", "Cold view does not represent its fixed watermark");
      // Validate before clearing so malformed views never partially alter state.
      const sameProjection = this.state.epoch === view.page.epoch && this.state.projectorVersion === view.projectorVersion;
      if (!sameProjection) { const previous = this.items; this.items = new Map(); try { this.validateItems(fence, view.page); } finally { this.items = previous; } }
      else this.validateItems(fence, view.page);
      this.items.clear(); this.order = [];
      this.state.epoch = view.page.epoch; this.state.projectorVersion = view.projectorVersion;
      this.state.sourceCursor = structuredClone(view.watermark);
      this.state.loadedWindow = { hasOlder: view.page.hasOlder, ...(view.page.nextBefore ? { nextBefore: structuredClone(view.page.nextBefore) } : {}) };
      this.mergeItems(view.page.items);
    } else {
      if (!this.state.sourceCursor || this.state.epoch !== view.page.epoch || this.state.projectorVersion !== view.projectorVersion) throw new ClientError("EPOCH_MISMATCH", "Catch-up view does not match the current replica");
      this.cover(fence, view.page, view.watermark.sequence, false);
    }
    this.state.snapshot = structuredClone(view.snapshot);
    this.state.snapshotSequence = view.watermark.sequence;
    this.state.interactions = structuredClone(view.interactions);
    this.state.interactionsAuthoritative = true;
    this.emit(); return true;
  }
  cover(fence: ReplicaFence, page: TimelinePage, watermark?: number, emit = true): boolean {
    if (!this.requireCanonical(fence)) return false;
    if (page.epoch !== this.state.epoch || page.projectorVersion !== this.state.projectorVersion) throw new ClientError("EPOCH_MISMATCH", "Timeline projection changed");
    if (page.pageRef) throw new ClientError("INCOMPLETE_TIMELINE_PAGE", "Referenced page has not been verified");
    const range = page.coveredSourceRange;
    const cursor = this.state.sourceCursor?.sequence;
    if (!range || cursor === undefined || (!page.boundaryComplete && watermark === undefined) || page.nextCursor?.epoch !== page.epoch || page.nextCursor.sequence !== range.through || page.upToSequence !== range.through || (watermark !== undefined && range.through > watermark)) {
      throw new ClientError("TIMELINE_GAP", "Timeline coverage is not a complete commit boundary");
    }
    if (range.through <= cursor) return false;
    if (range.fromExclusive !== cursor) throw new ClientError("TIMELINE_GAP", "Timeline source coverage is not continuous");
    this.validateItems(fence, page);
    this.mergeItems(page.items);
    this.state.sourceCursor = { epoch: page.epoch, sequence: range.through };
    if (emit) this.emit(); return true;
  }
  live(fence: ReplicaFence, page: TimelinePage, domain: { snapshot: unknown; snapshotSequence: number; interactions: TimelineInteractionSummary }): boolean {
    if (!this.requireCanonical(fence)) return false;
    const summary = domain.interactions;
    if (!summary.complete || summary.ref || summary.items.length !== summary.total || summary.directoryRevision !== domain.snapshotSequence || domain.snapshotSequence < page.upToSequence) throw new ClientError("INVALID_INTERACTION_SUMMARY", "Live domain snapshot is incomplete");
    const applied = this.cover(fence, page, undefined, false);
    if (domain.snapshotSequence >= (this.state.snapshotSequence ?? -1)) {
      this.state.snapshot = structuredClone(domain.snapshot); this.state.snapshotSequence = domain.snapshotSequence;
    }
    if (summary.directoryRevision >= (this.state.interactions?.directoryRevision ?? -1)) this.state.interactions = structuredClone(summary);
    this.state.interactionsAuthoritative = true;
    this.emit(); return applied;
  }
  before(fence: ReplicaFence, page: TimelinePage): boolean {
    if (!this.requireCanonical(fence)) return false;
    if (page.epoch !== this.state.epoch || page.projectorVersion !== this.state.projectorVersion || page.pageRef) throw new ClientError("INVALID_TIMELINE_PAGE", "Historical page does not match the loaded projection");
    this.validateItems(fence, page); this.mergeItems(page.items);
    this.state.loadedWindow = { ...this.state.loadedWindow, hasOlder: page.hasOlder, ...(page.nextBefore ? { nextBefore: structuredClone(page.nextBefore) } : {}) };
    this.emit(); return true;
  }
}
