import type Database from "better-sqlite3";
import type { ProjectedItem, TimelinePage, TimelinePageRequest } from "@flyx/mvp-protocol";
import { inTransaction, JsonTimelineBudget, TimelineError, type CommitBoundary, type TimelineContentStore, type TimelinePageBudget } from "./contracts.js";
import { readEpoch, readReferenceText, toProjectedItem, type ItemVersionRow, type TimelineEpoch } from "./projector.js";

export type TimelineQueryOptions = {
  workspaceForSession(sessionId: string): string;
  sourcePageLimit?: number;
  maximumInlineContentBytes?: number;
  budget?: TimelinePageBudget;
};
export type CapturedView<T> = { snapshot: T; page: TimelinePage; epoch: TimelineEpoch };

export class TimelineQuery {
  private readonly budget: TimelinePageBudget;
  private readonly sourceLimit: number;
  constructor(readonly db: Database.Database, readonly content: TimelineContentStore, readonly options: TimelineQueryOptions) {
    this.budget = options.budget ?? new JsonTimelineBudget();
    this.sourceLimit = options.sourcePageLimit ?? 200;
    if (!Number.isSafeInteger(this.sourceLimit) || this.sourceLimit < 1 || this.sourceLimit > 10_000) throw new RangeError("Invalid source page limit");
  }

  static isAvailable(db: Database.Database): boolean {
    return (db.prepare(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('timeline_epochs', 'timeline_item_versions', 'timeline_item_sources')`).get() as { count: number }).count === 3;
  }

  activeEpoch(sessionId: string, epochId?: string): TimelineEpoch {
    const epoch = readEpoch(this.db, sessionId);
    if (!epoch) throw new TimelineError("TIMELINE_BACKFILL_REQUIRED", "Timeline is not ready", true);
    if (epochId && epochId !== epoch.epoch) throw new TimelineError("TIMELINE_CURSOR_EXPIRED", "Timeline epoch has changed");
    return epoch;
  }

  /** No transaction remains open while the caller sends the response. */
  captureView<T>(sessionId: string, tailLimit: number, readSnapshot: () => T, cursor?: { epoch: string; sequence: number }): CapturedView<T> {
    const captured = inTransaction(this.db, () => {
      const snapshot = readSnapshot();
      const epoch = this.currentEpoch(sessionId, cursor?.epoch);
      if (cursor && cursor.sequence > epoch.indexedSequence) throw new TimelineError("SEQUENCE_AHEAD", "Timeline cursor is ahead of this Host");
      const page = cursor
        ? this.afterRaw(sessionId, epoch, cursor.sequence, epoch.indexedSequence)
        : this.tailRaw(sessionId, epoch, tailLimit);
      return { snapshot, epoch, page };
    });
    return { ...captured, page: this.boundPage(sessionId, captured.page) };
  }

  getPage(request: TimelinePageRequest): TimelinePage {
    const page = inTransaction(this.db, () => {
      const epoch = this.currentEpoch(request.sessionId, request.epoch);
      return request.direction === "after"
        ? this.afterRaw(request.sessionId, epoch, request.afterSequence, request.upToSequence)
        : this.beforeRaw(request.sessionId, epoch, request.beforeDisplaySequence, request.beforeItemId, request.limit);
    });
    return this.boundPage(request.sessionId, page);
  }

  tail(sessionId: string, limit = 50): TimelinePage {
    const page = inTransaction(this.db, () => this.tailRaw(sessionId, this.currentEpoch(sessionId), limit));
    return this.boundPage(sessionId, page);
  }

  /** Publish a complete durable batch, including batches with no visible Item. */
  committedPage(sessionId: string, epochId: string, commit: CommitBoundary): TimelinePage {
    const page = inTransaction(this.db, () => {
      const epoch = this.currentEpoch(sessionId, epochId);
      if (commit.lastSequence > epoch.indexedSequence) throw new TimelineError("TIMELINE_NOT_INDEXED", "Commit projection is unavailable", true);
      return this.makeAfter(sessionId, epoch, commit.firstSequence - 1, commit.lastSequence, commit.lastSequence);
    });
    return this.boundPage(sessionId, page);
  }

  captureCommittedView<T>(sessionId: string, epochId: string, commit: CommitBoundary, readSnapshot: () => T): CapturedView<T> {
    const captured = inTransaction(this.db, () => {
      const snapshot = readSnapshot();
      const epoch = this.currentEpoch(sessionId, epochId);
      if (commit.lastSequence > epoch.indexedSequence) throw new TimelineError("TIMELINE_NOT_INDEXED", "Commit projection is unavailable", true);
      return { snapshot, epoch, page: this.makeAfter(sessionId, epoch, commit.firstSequence - 1, commit.lastSequence, commit.lastSequence) };
    });
    return { ...captured, page: this.boundPage(sessionId, captured.page) };
  }

  boundaryAt(sessionId: string, sequence: number): CommitBoundary {
    const row = this.db.prepare(`SELECT id, first_sequence, last_sequence FROM event_commits WHERE session_id = ? AND first_sequence <= ? AND last_sequence >= ? LIMIT 1`)
      .get(sessionId, sequence, sequence) as { id: string; first_sequence: number; last_sequence: number } | undefined;
    return row ? { id: row.id, sessionId, firstSequence: row.first_sequence, lastSequence: row.last_sequence }
      : { id: `legacy-${sessionId}-${sequence}`, sessionId, firstSequence: sequence, lastSequence: sequence };
  }

  private currentEpoch(sessionId: string, epochId?: string): TimelineEpoch {
    const epoch = this.activeEpoch(sessionId, epochId);
    const session = this.db.prepare(`SELECT head_sequence FROM sessions WHERE id = ?`).get(sessionId) as { head_sequence: number } | undefined;
    if (!session) throw new TimelineError("SESSION_NOT_FOUND", "Session does not exist");
    if (epoch.indexedSequence !== session.head_sequence) throw new TimelineError("TIMELINE_NOT_INDEXED", "Timeline source coverage is incomplete", true);
    return epoch;
  }

  private afterRaw(sessionId: string, epoch: TimelineEpoch, after: number, target: number): TimelinePage {
    if (after < 0 || target < after || target > epoch.indexedSequence || !Number.isSafeInteger(after) || !Number.isSafeInteger(target)) throw new TimelineError("SEQUENCE_AHEAD", "Invalid Timeline source cursor");
    this.assertBoundary(sessionId, after);
    this.assertBoundary(sessionId, target);
    let end = Math.min(after + this.sourceLimit, target);
    if (end < target) {
      const containing = this.db.prepare(`SELECT first_sequence, last_sequence FROM event_commits WHERE session_id = ? AND first_sequence <= ? AND last_sequence > ? LIMIT 1`)
        .get(sessionId, end, end) as { first_sequence: number; last_sequence: number } | undefined;
      if (containing) end = containing.first_sequence > after + 1 ? containing.first_sequence - 1 : containing.last_sequence;
    }
    return this.makeAfter(sessionId, epoch, after, end, target);
  }

  private makeAfter(sessionId: string, epoch: TimelineEpoch, after: number, end: number, target: number): TimelinePage {
    const sources = this.db.prepare(`SELECT count(*) AS count FROM session_events WHERE session_id = ? AND sequence > ? AND sequence <= ?`)
      .get(sessionId, after, end) as { count: number };
    if (sources.count !== end - after) throw new TimelineError("TIMELINE_SOURCE_GAP", "Timeline source coverage has a gap");
    const rows = this.db.prepare(`
      SELECT v.* FROM timeline_item_versions v
      WHERE v.session_id = ? AND v.epoch = ? AND v.revision > ? AND v.revision <= ?
        AND v.revision = (SELECT max(latest.revision) FROM timeline_item_versions latest
          WHERE latest.session_id = v.session_id AND latest.epoch = v.epoch AND latest.item_id = v.item_id AND latest.revision <= ?)
      ORDER BY v.display_sequence, v.item_id
    `).all(sessionId, epoch.epoch, after, end, end) as ItemVersionRow[];
    return {
      epoch: epoch.epoch, projectorVersion: epoch.projectorVersion, upToSequence: end,
      coveredSourceRange: { fromExclusive: after, through: end },
      items: rows.map((row) => this.itemWithSources(row)),
      nextCursor: { epoch: epoch.epoch, sequence: end },
      hasOlder: false, hasNewer: end < target,
      boundaryComplete: this.knownBoundaries(sessionId, after, end),
    };
  }

  private tailRaw(sessionId: string, epoch: TimelineEpoch, limit: number): TimelinePage {
    this.assertLimit(limit);
    const rows = this.windowRows(sessionId, epoch, ``, [], limit + 1);
    const hasOlder = rows.length > limit;
    const chosen = rows.slice(0, limit).reverse();
    return {
      epoch: epoch.epoch, projectorVersion: epoch.projectorVersion, upToSequence: epoch.indexedSequence,
      items: chosen.map((row) => this.itemWithSources(row)),
      nextCursor: { epoch: epoch.epoch, sequence: epoch.indexedSequence },
      ...(chosen[0] ? { nextBefore: { displaySequence: chosen[0].display_sequence, itemId: chosen[0].item_id } } : {}),
      hasOlder, hasNewer: false, boundaryComplete: this.knownBoundaries(sessionId, 0, epoch.indexedSequence),
    };
  }

  private beforeRaw(sessionId: string, epoch: TimelineEpoch, before: number, itemId: string | undefined, limit: number): TimelinePage {
    this.assertLimit(limit);
    const clause = itemId ? `AND (v.display_sequence < ? OR (v.display_sequence = ? AND v.item_id < ?))` : `AND v.display_sequence < ?`;
    const args = itemId ? [before, before, itemId] : [before];
    const rows = this.windowRows(sessionId, epoch, clause, args, limit + 1);
    const chosen = rows.slice(0, limit).reverse();
    return {
      epoch: epoch.epoch, projectorVersion: epoch.projectorVersion, upToSequence: epoch.indexedSequence,
      items: chosen.map((row) => this.itemWithSources(row)),
      ...(chosen[0] ? { nextBefore: { displaySequence: chosen[0].display_sequence, itemId: chosen[0].item_id } } : {}),
      // Before never changes the global source consumption cursor.
      hasOlder: rows.length > limit, hasNewer: false,
      boundaryComplete: this.knownBoundaries(sessionId, 0, epoch.indexedSequence),
    };
  }

  private windowRows(sessionId: string, epoch: TimelineEpoch, clause: string, args: (string | number)[], limit: number): ItemVersionRow[] {
    return this.db.prepare(`SELECT v.* FROM timeline_item_versions v
      WHERE v.session_id = ? AND v.epoch = ? AND v.revision <= ? ${clause}
        AND v.revision = (SELECT max(latest.revision) FROM timeline_item_versions latest
          WHERE latest.session_id = v.session_id AND latest.epoch = v.epoch AND latest.item_id = v.item_id AND latest.revision <= ?)
      ORDER BY v.display_sequence DESC, v.item_id DESC LIMIT ?`)
      .all(sessionId, epoch.epoch, epoch.indexedSequence, ...args, epoch.indexedSequence, limit) as ItemVersionRow[];
  }

  private itemWithSources(row: ItemVersionRow): ProjectedItem {
    let item = toProjectedItem(row);
    if ("ref" in item.content && item.contentField && item.content.bytes <= (this.options.maximumInlineContentBytes ?? 2 * 1024)) {
      const text = readReferenceText(this.db, item.content.ref);
      const { contentField, metadata, ...rest } = item;
      item = { ...rest, content: { inline: { ...metadata, [contentField]: text } } };
    }
    const ranges: Array<{ start: number; end: number }> = [];
    const sequences = this.db.prepare(`SELECT source_sequence FROM timeline_item_sources WHERE session_id = ? AND epoch = ? AND item_id = ? AND source_sequence <= ? ORDER BY source_sequence`)
      .iterate(row.session_id, row.epoch, row.item_id, row.revision) as Iterable<{ source_sequence: number }>;
    for (const source of sequences) {
      const last = ranges[ranges.length - 1];
      if (last && last.end + 1 === source.source_sequence) last.end = source.source_sequence;
      else ranges.push({ start: source.source_sequence, end: source.source_sequence });
    }
    // Conversion to a reference happens after the read snapshot closes.
    return { ...item, sourceSeqRanges: ranges };
  }

  referencePage(sessionId: string, page: TimelinePage): TimelinePage { return this.boundPage(sessionId, page, true); }

  private boundPage(sessionId: string, raw: TimelinePage, force = false): TimelinePage {
    const page = { ...raw, items: raw.items.map((item) => {
      if (!item.sourceSeqRanges || item.sourceSeqRanges.length <= 32) return item;
      const ref = this.content.putBlob({ sessionId, itemId: item.itemId, format: "application/json", text: JSON.stringify(item.sourceSeqRanges), workspace: this.options.workspaceForSession(sessionId) });
      this.pinQueryReference(sessionId, ref.ref);
      const { sourceSeqRanges, ...rest } = item;
      return { ...rest, sourceSeqRangesRef: { ...ref, count: sourceSeqRanges.length } };
    }) };
    if (!force && this.budget.fits(page)) return page;
    if (page.pageRef) return page;
    const blob = {
      epoch: page.epoch, projectorVersion: page.projectorVersion, upToSequence: page.upToSequence,
      ...(page.coveredSourceRange ? { coveredSourceRange: page.coveredSourceRange } : {}), items: page.items,
    };
    const ref = this.content.putBlob({ sessionId, format: "application/json", text: JSON.stringify(blob), workspace: this.options.workspaceForSession(sessionId) });
    this.pinQueryReference(sessionId, ref.ref);
    const referenced = { ...page, items: [], pageRef: { ...ref, itemCount: page.items.length } };
    if (!this.budget.fits(referenced)) throw new TimelineError("TIMELINE_BUDGET_TOO_SMALL", "Timeline page envelope exceeds the byte budget");
    return referenced;
  }

  private pinQueryReference(sessionId: string, ref: string): void {
    this.content.pin({ sessionId, ref, ownerKind: "query", ownerId: ref, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  }

  private knownBoundaries(sessionId: string, after: number, through: number): boolean {
    return !this.db.prepare(`SELECT 1 FROM session_events WHERE session_id = ? AND sequence > ? AND sequence <= ? AND commit_id IS NULL LIMIT 1`).get(sessionId, after, through);
  }
  private assertBoundary(sessionId: string, sequence: number): void {
    if (this.db.prepare(`SELECT 1 FROM event_commits WHERE session_id = ? AND first_sequence <= ? AND last_sequence > ? LIMIT 1`).get(sessionId, sequence, sequence)) throw new TimelineError("TIMELINE_COMMIT_BOUNDARY", "Cursor must end at a complete source commit");
  }
  private assertLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TimelineError("INVALID_REQUEST", "Timeline window limit is invalid");
  }
}
