import { randomUUID } from "node:crypto";
import type { OpenViewRequest, OpenViewResponse, SessionEvent, TimelineInteractionSummary, TimelinePage, TimelineUpdatedPayload } from "@flyx/mvp-protocol";
import { publicValue } from "../api/public-projection.js";
import { JsonTimelineBudget, record, TimelineError, type CommitBoundary, type TimelineLeaseOwner, type TimelinePageBudget } from "./contracts.js";
import { TimelineQuery } from "./timeline-query.js";

export interface TimelineSource { subscribe(listener: (event: SessionEvent) => void): () => void }
export type TimelineDelivery = (event: SessionEvent) => Promise<void>;
export type TimelineSubscriptionOptions = {
  source: TimelineSource;
  readSnapshot(sessionId: string): unknown;
  assertOwnerCurrent?(owner: TimelineLeaseOwner): void;
  maximumBufferedCommits?: number;
  maximumBufferedBytes?: number;
  maximumSubscriptionsPerOwner?: number;
  budget?: TimelinePageBudget;
};
export type OpenedTimelineView = { response: OpenViewResponse; activate(): Promise<void>; cancel(): void };
type Pending = { commit: CommitBoundary; payload?: TimelineUpdatedPayload; bytes: number };
type Subscription = {
  id: string; sessionId: string; epoch: string; owner: TimelineLeaseOwner; deliver: TimelineDelivery;
  watermark: number; lastSent: number; holding: boolean; closed: boolean;
  pending: Map<number, Pending>; bufferedBytes: number; unsubscribe: () => void;
  draining?: Promise<void>;
  deferredReset?: "buffer_overflow" | "epoch_changed" | "delivery_failed" | "lease_expired";
};
type SnapshotFields = { snapshot: unknown; snapshotRef?: OpenViewResponse["snapshotRef"]; interactions: TimelineInteractionSummary };

/** Owns the listener-before-snapshot boundary and the response-before-live gate. */
export class TimelineSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly budget: TimelinePageBudget;
  constructor(readonly query: TimelineQuery, readonly options: TimelineSubscriptionOptions) {
    this.budget = options.budget ?? new JsonTimelineBudget();
  }
  get size(): number { return this.subscriptions.size; }

  openView(request: OpenViewRequest, owner: TimelineLeaseOwner, deliver: TimelineDelivery): OpenedTimelineView {
    this.options.assertOwnerCurrent?.(owner);
    const subscription = this.reserve(request.sessionId, owner, deliver);
    try {
      // reserve() has already installed the live listener. A commit visible in
      // this read snapshot is covered by W and is removed from the held queue.
      const capture = this.query.captureView(request.sessionId, request.tailLimit, () => this.options.readSnapshot(request.sessionId), request.cursor);
      subscription.epoch = capture.epoch.epoch;
      subscription.watermark = subscription.lastSent = capture.epoch.indexedSequence;
      for (const [end, pending] of subscription.pending) if (end <= subscription.watermark) {
        subscription.pending.delete(end); subscription.bufferedBytes -= pending.bytes;
      }
      const fields = this.snapshotFields(request.sessionId, capture.snapshot, capture.epoch.indexedSequence);
      let response: OpenViewResponse = {
        subscriptionId: subscription.id, sessionId: request.sessionId,
        projectorVersion: capture.epoch.projectorVersion,
        mode: request.cursor ? "catch_up" : "cold",
        watermark: { epoch: capture.epoch.epoch, sequence: capture.epoch.indexedSequence },
        page: capture.page, ...fields,
        catchUpComplete: !request.cursor || capture.page.nextCursor?.sequence === capture.epoch.indexedSequence,
      };
      if (!this.budget.fits(response)) response = { ...response, page: this.query.referencePage(request.sessionId, response.page) };
      if (!this.budget.fits(response)) throw new TimelineError("TIMELINE_BUDGET_TOO_SMALL", "Open-view envelope exceeds the byte budget");
      return {
        response,
        // Gateway calls this only after the response has been sent.
        activate: async () => {
          if (subscription.closed) {
            if (subscription.deferredReset) { const reason = subscription.deferredReset; delete subscription.deferredReset; await this.deliverReset(subscription, reason); }
            return;
          }
          this.requireOwner(subscription, owner);
          subscription.holding = false;
          await this.drain(subscription);
        },
        cancel: () => this.close(subscription),
      };
    } catch (error) { this.close(subscription); throw error; }
  }

  /** Re-establish a live subscription at a fresh fixed watermark. */
  subscribe(request: { sessionId: string; epoch: string }, owner: TimelineLeaseOwner, deliver: TimelineDelivery): OpenedTimelineView {
    return this.openView({ sessionId: request.sessionId, cursor: { epoch: request.epoch, sequence: this.query.activeEpoch(request.sessionId, request.epoch).indexedSequence }, tailLimit: 1 }, owner, deliver);
  }

  unsubscribe(subscriptionId: string, owner: TimelineLeaseOwner): { removed: boolean } {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return { removed: false };
    this.requireOwner(subscription, owner);
    this.close(subscription);
    return { removed: true };
  }

  cleanupOwner(owner: TimelineLeaseOwner): void {
    for (const subscription of this.subscriptions.values()) if (sameOwner(subscription.owner, owner)) this.close(subscription);
  }
  closeAll(): void { for (const subscription of this.subscriptions.values()) this.close(subscription); }

  private reserve(sessionId: string, owner: TimelineLeaseOwner, deliver: TimelineDelivery): Subscription {
    const owned = [...this.subscriptions.values()].filter((subscription) => sameOwner(subscription.owner, owner));
    for (const existing of owned) if (existing.sessionId === sessionId) this.close(existing);
    if (owned.filter((subscription) => !subscription.closed).length >= (this.options.maximumSubscriptionsPerOwner ?? 16)) throw new TimelineError("TIMELINE_SUBSCRIPTION_LIMIT", "Timeline subscription limit reached");
    const subscription: Subscription = {
      id: randomUUID(), sessionId, epoch: "", owner: { ...owner }, deliver,
      watermark: 0, lastSent: 0, holding: true, closed: false,
      pending: new Map(), bufferedBytes: 0, unsubscribe: () => {},
    };
    this.subscriptions.set(subscription.id, subscription);
    subscription.unsubscribe = this.options.source.subscribe((event) => this.onSource(subscription, event));
    if (subscription.closed) subscription.unsubscribe();
    return subscription;
  }

  private onSource(subscription: Subscription, event: SessionEvent): void {
    if (subscription.closed || event.sessionId !== subscription.sessionId) return;
    try { this.options.assertOwnerCurrent?.(subscription.owner); }
    catch { void this.reset(subscription, "lease_expired"); return; }
    try {
      const commit = this.query.boundaryAt(event.sessionId, event.sequence);
      // A multi-event transaction is exposed only after its final source
      // notification. Its explicit range preserves the full commit boundary.
      if (event.sequence !== commit.lastSequence || commit.lastSequence <= subscription.lastSent || subscription.pending.has(commit.lastSequence)) return;
      if (subscription.epoch && this.query.activeEpoch(subscription.sessionId).epoch !== subscription.epoch) {
        void this.reset(subscription, "epoch_changed"); return;
      }
      let pending: Pending = { commit, bytes: 64 };
      if (subscription.epoch) pending = this.materialize(subscription, commit);
      subscription.pending.set(commit.lastSequence, pending);
      subscription.bufferedBytes += pending.bytes;
      if (subscription.pending.size > (this.options.maximumBufferedCommits ?? 128) || subscription.bufferedBytes > (this.options.maximumBufferedBytes ?? 1024 * 1024)) {
        void this.reset(subscription, "buffer_overflow"); return;
      }
      if (!subscription.holding) void this.drain(subscription);
    } catch (error) {
      void this.reset(subscription, error instanceof TimelineError && error.code === "TIMELINE_CURSOR_EXPIRED" ? "epoch_changed" : "delivery_failed");
    }
  }

  private materialize(subscription: Subscription, commit: CommitBoundary): Pending {
    const capture = this.query.captureCommittedView(subscription.sessionId, subscription.epoch, commit, () => this.options.readSnapshot(subscription.sessionId));
    const fields = this.snapshotFields(subscription.sessionId, capture.snapshot, capture.epoch.indexedSequence);
    let payload: TimelineUpdatedPayload = { ...capture.page, subscriptionId: subscription.id, snapshotSequence: capture.epoch.indexedSequence, ...fields };
    if (!this.budget.fits(payload)) payload = { ...payload, ...this.query.referencePage(subscription.sessionId, capture.page) };
    if (!this.budget.fits(payload)) throw new TimelineError("TIMELINE_BUDGET_TOO_SMALL", "Live projection envelope exceeds the byte budget");
    return { commit, payload, bytes: Buffer.byteLength(JSON.stringify(payload)) };
  }

  private drain(subscription: Subscription): Promise<void> {
    if (subscription.draining) return subscription.draining;
    subscription.draining = (async () => {
      while (!subscription.closed && !subscription.holding && subscription.pending.size) {
        const end = Math.min(...subscription.pending.keys());
        let pending = subscription.pending.get(end)!;
        subscription.pending.delete(end); subscription.bufferedBytes -= pending.bytes;
        if (end <= subscription.lastSent) continue;
        try { this.options.assertOwnerCurrent?.(subscription.owner); }
        catch { await this.reset(subscription, "lease_expired"); return; }
        if (this.query.activeEpoch(subscription.sessionId).epoch !== subscription.epoch) { await this.reset(subscription, "epoch_changed"); return; }
        if (pending.commit.firstSequence - 1 !== subscription.lastSent) { await this.reset(subscription, "delivery_failed"); return; }
        if (!pending.payload) pending = this.materialize(subscription, pending.commit);
        await subscription.deliver({
          id: `${subscription.id}-${pending.commit.id}`, sessionId: subscription.sessionId,
          sequence: pending.commit.lastSequence, type: "timeline.updated",
          payload: pending.payload, occurredAt: new Date().toISOString(),
        });
        subscription.lastSent = end;
      }
    })().catch(async () => { await this.reset(subscription, "delivery_failed"); }).finally(() => {
      delete subscription.draining;
      // A commit can arrive after the last loop check but before this promise
      // releases its drain ownership. Recheck to avoid losing that wakeup.
      if (!subscription.closed && !subscription.holding && subscription.pending.size) void this.drain(subscription);
    });
    return subscription.draining;
  }

  private snapshotFields(sessionId: string, raw: unknown, sequence: number): SnapshotFields {
    const workspace = this.query.options.workspaceForSession(sessionId);
    const snapshot = record(publicValue(raw, workspace));
    const pendingApprovals = Array.isArray(snapshot.pendingApprovals) ? snapshot.pendingApprovals : [];
    const pendingInteractions = Array.isArray(snapshot.pendingInteractions) ? snapshot.pendingInteractions : [];
    // The migrated interaction directory is authoritative when present;
    // pendingApprovals remains the legacy fallback, not a second directory.
    const items = Array.isArray(snapshot.pendingInteractions) ? pendingInteractions : pendingApprovals;
    const directory: TimelineInteractionSummary = { total: items.length, directoryRevision: sequence, complete: true, items };
    const interactions: TimelineInteractionSummary = Buffer.byteLength(JSON.stringify(directory)) <= 24 * 1024
      ? directory
      : { total: items.length, directoryRevision: sequence, complete: false, items: [], ref: this.snapshotReference(sessionId, JSON.stringify(directory), workspace) };
    const base: Record<string, unknown> = { ...snapshot, ...(Array.isArray(snapshot.pendingApprovals) ? { pendingApprovals: [] } : {}), ...(Array.isArray(snapshot.pendingInteractions) ? { pendingInteractions: [] } : {}) };
    if (Buffer.byteLength(JSON.stringify(base)) <= 16 * 1024) return { snapshot: base, interactions };
    const ref = this.snapshotReference(sessionId, JSON.stringify(base), workspace);
    const session = record(base.session);
    return { snapshot: { session: { id: session.id, headSequence: sequence } }, snapshotRef: ref, interactions };
  }

  private snapshotReference(sessionId: string, text: string, workspace: string) {
    const ref = this.query.content.putBlob({ sessionId, format: "application/json", text, workspace });
    this.query.content.pin({ sessionId, ref: ref.ref, ownerKind: "query", ownerId: ref.ref, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
    return ref;
  }

  private async reset(subscription: Subscription, reason: "buffer_overflow" | "epoch_changed" | "delivery_failed" | "lease_expired"): Promise<void> {
    if (subscription.closed) return;
    this.close(subscription);
    if (subscription.holding) { subscription.deferredReset = reason; return; }
    await this.deliverReset(subscription, reason);
  }
  private async deliverReset(subscription: Subscription, reason: "buffer_overflow" | "epoch_changed" | "delivery_failed" | "lease_expired"): Promise<void> {
    try {
      await subscription.deliver({ id: randomUUID(), sessionId: subscription.sessionId, sequence: Math.max(1, subscription.lastSent), type: "timeline.reset", payload: { subscriptionId: subscription.id, epoch: subscription.epoch || "unavailable", reason }, occurredAt: new Date().toISOString() });
    } catch { /* Domain recovery never tears down a healthy RPC transport. */ }
  }
  private close(subscription: Subscription): void {
    if (subscription.closed) return;
    subscription.closed = true; subscription.unsubscribe(); subscription.pending.clear(); subscription.bufferedBytes = 0;
    this.subscriptions.delete(subscription.id);
  }
  private requireOwner(subscription: Subscription, owner: TimelineLeaseOwner): void {
    this.options.assertOwnerCurrent?.(owner);
    if (!sameOwner(subscription.owner, owner)) throw new TimelineError("TIMELINE_SUBSCRIPTION_FORBIDDEN", "Subscription belongs to another lease");
  }
}
function sameOwner(left: TimelineLeaseOwner, right: TimelineLeaseOwner): boolean {
  return left.subjectId === right.subjectId && left.leaseId === right.leaseId && left.generation === right.generation;
}
