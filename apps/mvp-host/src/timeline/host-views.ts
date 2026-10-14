import type { OpenViewRequest, TimelinePageRequest, TimelineSubscribeRequest } from "@flyx/mvp-protocol";
import { ContentStore } from "../content/content-store.js";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import type { SqliteStore } from "../storage/db.js";
import { CONTENT_SCHEMA_SQL } from "../storage/migrations/006-content.js";
import { TIMELINE_SCHEMA_SQL } from "../storage/migrations/006-timeline.js";
import { validateViewsSchema, VIEWS_SCHEMA_VERSION } from "../storage/migrations/006-views-schema.js";
import { TimelineBackfill } from "./backfill.js";
import { TimelineError, type TimelineLeaseOwner, type TimelinePageBudget } from "./contracts.js";
import { readEpoch, TimelineProjector, TIMELINE_PROJECTOR_VERSION } from "./projector.js";
import { TimelineQuery } from "./timeline-query.js";
import { TimelineSubscriptions, type TimelineDelivery, type TimelineSource } from "./timeline-subscriptions.js";
export { validateViewsSchema, VIEWS_SCHEMA_VERSION } from "../storage/migrations/006-views-schema.js";

export type ViewInteractionPage = { interactions: readonly unknown[]; hasMore: boolean; nextAfterInteractionId?: string };
export type ViewInteractionReader = (sessionId: string, afterInteractionId?: string) => ViewInteractionPage;
export type ViewResource = { sessionId: string; workspace: string; source: TimelineSource; readSnapshot(): unknown; readInteractions?(afterInteractionId?: string): ViewInteractionPage };
export type ViewResourceResolver = (sessionId: string) => ViewResource | undefined;
export type HostViewsOptions = { resolveResource: ViewResourceResolver; enabled?: boolean; assertSessionAccess?(owner: TimelineLeaseOwner, resource: ViewResource): void };

/** Prepare content DDL and every legacy epoch using the already-owned connection. */
export function applyViewsMigration(store: SqliteStore, owner: HostOwnerHandle): void {
  assertHostOwner(owner); owner.assertStorePath(store.db.name); store.assertWriterOwner();
  const declared = store.db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get(VIEWS_SCHEMA_VERSION);
  if (declared) validateViewsSchema(store.db);
  else store.db.transaction(() => { store.db.exec(CONTENT_SCHEMA_SQL); store.db.exec(TIMELINE_SCHEMA_SQL); validateViewsSchema(store.db); })();
  const workspaceForSession = (id: string) => {
    const session = store.getSession(id);
    if (!session) throw new TimelineError("SESSION_NOT_FOUND", "Session does not exist");
    return session.workspacePath;
  };
  const content = new ContentStore(store.db, { workspaceForSession });
  const projector = new TimelineProjector(store.db, content, { workspaceForSession });
  const sessions = store.db.prepare(`SELECT id, head_sequence FROM sessions`).all() as Array<{ id: string; head_sequence: number }>;
  for (const session of sessions) {
    const active = projector.activeEpoch(session.id);
    if (active?.projectorVersion === projector.version && active.indexedSequence === session.head_sequence) continue;
    const building = store.db.prepare(`SELECT epoch FROM timeline_epochs WHERE session_id = ? AND state = 'building' AND projector_version = ? ORDER BY rowid DESC LIMIT 1`).get(session.id, projector.version) as { epoch: string } | undefined;
    new TimelineBackfill(projector, () => owner.assertActive()).run(session.id, building ? { epoch: building.epoch } : {});
  }
  store.db.transaction(() => {
    owner.assertActive(); validateViewsSchema(store.db);
    store.db.prepare(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)`).run(VIEWS_SCHEMA_VERSION, new Date().toISOString());
  })();
}

/** One projection hook per Host; each connection owns only its subscriptions. */
export class HostViews {
  readonly content: ContentStore;
  readonly projector: TimelineProjector;
  private readonly detach: () => void;
  private readonly connections = new Set<HostViewConnection>();
  private closed = false;
  constructor(readonly store: SqliteStore, readonly owner: HostOwnerHandle, readonly options: HostViewsOptions) {
    assertHostOwner(owner); owner.assertStorePath(store.db.name); store.assertWriterOwner();
    validateViewsSchema(store.db);
    const workspaceForSession = (id: string) => {
      const session = store.getSession(id);
      if (!session) throw new TimelineError("SESSION_NOT_FOUND", "Session does not exist");
      return session.workspacePath;
    };
    this.content = new ContentStore(store.db, { workspaceForSession });
    this.projector = new TimelineProjector(store.db, this.content, { workspaceForSession });
    this.detach = this.projector.attach(store);
  }
  static isAvailable(store: SqliteStore): boolean {
    return Boolean(store.db.prepare(`SELECT 1 FROM schema_migrations WHERE version = ?`).get(VIEWS_SCHEMA_VERSION)) && ContentStore.isAvailable(store.db) && TimelineQuery.isAvailable(store.db);
  }
  prepareSession(id: string): void { this.resource(id); this.prepareStoredSession(id); }
  /** Recovering legacy facts can affect any persisted Session, even a closed view. */
  prepareStoredSessions(): void {
    this.owner.assertActive();
    const sessions = this.store.db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
    for (const session of sessions) this.prepareStoredSession(session.id);
  }
  private prepareStoredSession(id: string): void {
    const session = this.store.getSession(id)!; const epoch = this.projector.activeEpoch(id);
    if (!epoch || epoch.projectorVersion !== this.projector.version || epoch.indexedSequence !== session.headSequence) {
      const building = this.store.db.prepare(`SELECT epoch FROM timeline_epochs WHERE session_id = ? AND state = 'building' AND projector_version = ? ORDER BY rowid DESC LIMIT 1`).get(id, this.projector.version) as { epoch: string } | undefined;
      new TimelineBackfill(this.projector, () => this.owner.assertActive()).run(id, building ? { epoch: building.epoch } : {});
    }
  }
  ready(id: string): boolean {
    if (this.closed || this.options.enabled === false) return false;
    try { this.owner.assertActive(); } catch { return false; }
    if (!HostViews.isAvailable(this.store)) return false;
    const resource = this.options.resolveResource(id);
    const session = this.store.getSession(id); const epoch = readEpoch(this.store.db, id);
    return Boolean(resource && resource.sessionId === id && session && resource.workspace === session.workspacePath && epoch?.projectorVersion === TIMELINE_PROJECTOR_VERSION && epoch.indexedSequence === session.headSequence);
  }
  resource(id: string, owner?: TimelineLeaseOwner): ViewResource {
    if (this.closed) throw new TimelineError("TIMELINE_UNAVAILABLE", "Host views have closed");
    const resource = this.options.resolveResource(id); const session = this.store.getSession(id);
    if (!resource || resource.sessionId !== id || !session || session.workspacePath !== resource.workspace) throw new TimelineError("SESSION_NOT_FOUND", "Session does not exist");
    if (owner) this.options.assertSessionAccess?.(owner, resource);
    return resource;
  }
  connect(owner: TimelineLeaseOwner, budget: TimelinePageBudget, assertCurrent: () => void): HostViewConnection {
    if (this.closed) throw new TimelineError("TIMELINE_UNAVAILABLE", "Host views have closed");
    const connection = new HostViewConnection(this, owner, budget, assertCurrent, () => this.connections.delete(connection));
    this.connections.add(connection); return connection;
  }
  close(): void { if (this.closed) return; for (const connection of this.connections) connection.close(); this.closed = true; this.detach(); }
}

export class HostViewConnection {
  private readonly services = new Map<string, TimelineSubscriptions>();
  private closed = false;
  constructor(readonly host: HostViews, readonly owner: TimelineLeaseOwner, readonly budget: TimelinePageBudget, private readonly assertCurrent: () => void, private readonly onClose: () => void) {}
  openView(request: OpenViewRequest, deliver: TimelineDelivery) { return this.service(request.sessionId).openView(request, this.owner, deliver); }
  subscribe(request: TimelineSubscribeRequest, deliver: TimelineDelivery) { return this.service(request.sessionId).subscribe(request, this.owner, deliver); }
  getPage(request: TimelinePageRequest) { this.check(request.sessionId); return this.query().getPage(request); }
  unsubscribe(id: string) {
    this.assertCurrent();
    for (const service of this.services.values()) { const result = service.unsubscribe(id, this.owner); if (result.removed) return result; }
    return { removed: false };
  }
  get subscriptionCount(): number { return [...this.services.values()].reduce((sum, service) => sum + service.size, 0); }
  close(): void { if (this.closed) return; this.closed = true; for (const service of this.services.values()) service.cleanupOwner(this.owner); this.services.clear(); this.onClose(); }
  private check(id: string) {
    this.assertCurrent(); if (this.closed) throw new TimelineError("TIMELINE_UNAVAILABLE", "Timeline connection has closed");
    const resource = this.host.resource(id, this.owner);
    if (!this.host.ready(id)) throw new TimelineError("TIMELINE_UNAVAILABLE", "Timeline is not ready", true);
    return resource;
  }
  private query() { return new TimelineQuery(this.host.store.db, this.host.content, { workspaceForSession: (id) => this.host.resource(id, this.owner).workspace, budget: this.budget }); }
  private service(id: string) {
    const resource = this.check(id); let service = this.services.get(id);
    if (!service) {
      service = new TimelineSubscriptions(this.query(), { source: resource.source, readSnapshot: () => {
        const snapshot = resource.readSnapshot();
        if (!resource.readInteractions) return snapshot;
        const interactions: unknown[] = []; const cursors = new Set<string>(); let after: string | undefined;
        for (;;) {
          const page = resource.readInteractions(after); interactions.push(...page.interactions);
          if (!page.hasMore) break;
          const next = page.nextAfterInteractionId;
          if (!next || cursors.has(next)) throw new TimelineError("INTERACTION_DIRECTORY_INCOMPLETE", "Interaction directory could not be captured");
          cursors.add(next); after = next;
        }
        return { ...(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {}), pendingInteractions: interactions };
      }, assertOwnerCurrent: () => this.check(id), budget: this.budget });
      this.services.set(id, service);
    }
    return service;
  }
}
