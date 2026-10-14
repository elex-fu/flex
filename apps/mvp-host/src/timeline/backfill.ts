import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { ProjectedItemSchema, type SessionEvent } from "@flyx/mvp-protocol";
import { TimelineError, type ContentReference } from "./contracts.js";
import { readEpoch, toProjectedItem, type ItemVersionRow, type TimelineEpoch, TimelineProjector } from "./projector.js";

export type BackfillProgress = { epoch: string; indexedSequence: number; targetSequence: number; switched: boolean };

/** Resumable chunks build a new epoch; only a validated current epoch is visible. */
export class TimelineBackfill {
  constructor(private readonly projector: TimelineProjector) {}

  begin(sessionId: string, epoch?: string): TimelineEpoch {
    return this.projector.db.transaction(() => this.projector.createEpoch(sessionId, "building", epoch))();
  }

  step(sessionId: string, epochId: string, batchSize = 500): BackfillProgress {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new RangeError("Invalid backfill batch size");
    const db = this.projector.db;
    const progress = db.transaction(() => {
      const epoch = this.requireBuilding(sessionId, epochId);
      const target = this.head(sessionId);
      const rows = db.prepare(`SELECT id, session_id, sequence, type, payload_json, occurred_at FROM session_events WHERE session_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`)
        .all(sessionId, epoch.indexedSequence, target, batchSize) as Array<{ id: string; session_id: string; sequence: number; type: string; payload_json: string; occurred_at: string }>;
      const events: SessionEvent[] = rows.map((row) => ({ id: row.id, sessionId: row.session_id, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload_json) as unknown, occurredAt: row.occurred_at }));
      this.projector.projectCommittedBatch(events, epochId);
      return { epoch: epochId, indexedSequence: readEpoch(db, sessionId, epochId)!.indexedSequence, targetSequence: target, switched: false };
    })();
    if (progress.indexedSequence === progress.targetSequence) progress.switched = this.validateAndActivate(sessionId, epochId);
    return progress;
  }

  run(sessionId: string, options: { epoch?: string; batchSize?: number } = {}): BackfillProgress {
    const epoch = options.epoch ? this.requireBuilding(sessionId, options.epoch) : this.begin(sessionId);
    for (;;) {
      const progress = this.step(sessionId, epoch.epoch, options.batchSize);
      if (progress.switched) return progress;
      if (progress.indexedSequence < progress.targetSequence && this.projector.db.prepare(`SELECT 1 FROM session_events WHERE session_id = ? AND sequence = ?`).get(sessionId, progress.indexedSequence + 1) === undefined) throw new TimelineError("TIMELINE_SOURCE_GAP", "Backfill source coverage has a gap");
    }
  }

  validateAndActivate(sessionId: string, epochId: string): boolean {
    const db = this.projector.db;
    return db.transaction(() => {
      const epoch = this.requireBuilding(sessionId, epochId);
      const target = this.head(sessionId);
      // A source commit may have arrived since the last chunk; catch it up
      // before switching, without a long-lived cross-RPC read transaction.
      if (epoch.indexedSequence !== target) return false;
      this.validate(db, epoch);
      db.prepare(`UPDATE timeline_epochs SET state = 'retired' WHERE session_id = ? AND state = 'active'`).run(sessionId);
      const switched = db.prepare(`UPDATE timeline_epochs SET state = 'active' WHERE session_id = ? AND epoch = ? AND state = 'building' AND indexed_sequence = ?`).run(sessionId, epochId, target);
      if (switched.changes !== 1) throw new TimelineError("TIMELINE_BACKFILL_CONFLICT", "Timeline activation was superseded");
      return true;
    })();
  }

  private validate(db: Database.Database, epoch: TimelineEpoch): void {
    const coverage = db.prepare(`SELECT count(*) AS count, min(sequence) AS first, max(sequence) AS last FROM session_events WHERE session_id = ? AND sequence <= ?`)
      .get(epoch.sessionId, epoch.indexedSequence) as { count: number; first: number | null; last: number | null };
    if (coverage.count !== epoch.indexedSequence || (coverage.count && (coverage.first !== 1 || coverage.last !== epoch.indexedSequence))) throw new TimelineError("TIMELINE_SOURCE_GAP", "Backfill source coverage has a gap");
    if (db.prepare(`SELECT 1 FROM session_events s JOIN event_commits c ON c.id = s.commit_id WHERE s.session_id = ? AND (c.session_id <> s.session_id OR s.sequence < c.first_sequence OR s.sequence > c.last_sequence) LIMIT 1`).get(epoch.sessionId)
      || db.prepare(`SELECT 1 FROM event_commits c WHERE c.session_id = ? AND (c.last_sequence > ? OR (SELECT count(*) FROM session_events s WHERE s.commit_id = c.id AND s.session_id = c.session_id) <> c.last_sequence - c.first_sequence + 1) LIMIT 1`).get(epoch.sessionId, epoch.indexedSequence)) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Source commit boundary is inconsistent");
    if (db.prepare(`SELECT 1 FROM timeline_item_versions WHERE session_id = ? AND epoch = ? GROUP BY item_id HAVING min(display_sequence) <> max(display_sequence) OR min(display_sequence) <> min(revision) LIMIT 1`).get(epoch.sessionId, epoch.epoch)) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Item ordering is inconsistent");
    if ((db.prepare(`PRAGMA foreign_key_check(timeline_item_versions)`).all() as unknown[]).length || (db.prepare(`PRAGMA foreign_key_check(timeline_item_sources)`).all() as unknown[]).length) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Projection references are inconsistent");
    if (db.prepare(`SELECT 1 FROM timeline_item_versions v LEFT JOIN timeline_item_sources s ON s.session_id = v.session_id AND s.epoch = v.epoch AND s.item_id = v.item_id AND s.source_sequence = v.revision WHERE v.session_id = ? AND v.epoch = ? AND s.source_sequence IS NULL LIMIT 1`).get(epoch.sessionId, epoch.epoch)) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Projection source reference is missing");
    const refs = new Set<string>();
    const rows = db.prepare(`SELECT * FROM timeline_item_versions WHERE session_id = ? AND epoch = ? ORDER BY revision`).iterate(epoch.sessionId, epoch.epoch) as Iterable<ItemVersionRow>;
    for (const row of rows) {
      const item = toProjectedItem(row);
      if (!ProjectedItemSchema.safeParse(item).success) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Projection version is malformed");
      if (("ref" in item.content ? item.content.ref : null) !== row.content_ref) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Projection content ownership is inconsistent");
      if ("ref" in item.content) { this.validateRef(db, epoch.sessionId, item.content); refs.add(item.content.ref); }
      if (item.metadataRef) { this.validateRef(db, epoch.sessionId, item.metadataRef); refs.add(item.metadataRef.ref); }
    }
    this.validateContentHashes(db, refs);
  }

  private validateContentHashes(db: Database.Database, refs: Set<string>): void {
    type RefRow = { kind: string; stream_id: string | null; through_sequence: number | null; byte_length: number; sha256: string; blob_data: Buffer | null };
    const streams = new Map<string, RefRow[]>();
    for (const ref of refs) {
      const row = db.prepare(`SELECT kind, stream_id, through_sequence, byte_length, sha256, blob_data FROM content_refs WHERE id = ?`).get(ref) as RefRow;
      if (row.kind === "blob") {
        if (!row.blob_data || row.blob_data.length !== row.byte_length || createHash("sha256").update(row.blob_data).digest("hex") !== row.sha256) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Immutable blob checksum is inconsistent");
      } else {
        const group = streams.get(row.stream_id!) ?? [];
        group.push(row); streams.set(row.stream_id!, group);
      }
    }
    // Validate each stream in one pass, with incremental prefix hashes. This
    // checks all historical revisions without rereading every full prefix.
    for (const [streamId, prefixes] of streams) {
      prefixes.sort((a, b) => a.byte_length - b.byte_length || a.through_sequence! - b.through_sequence!);
      const iterator = (db.prepare(`SELECT source_sequence, byte_start, byte_end, data FROM content_segments WHERE stream_id = ? AND byte_start < ? ORDER BY byte_start`).iterate(streamId, prefixes[prefixes.length - 1]!.byte_length) as Iterable<{ source_sequence: number; byte_start: number; byte_end: number; data: Buffer }>)[Symbol.iterator]();
      let segment = iterator.next(); let bytes = 0; let sequence = 0; const hash = createHash("sha256");
      for (const prefix of prefixes) {
        while (!segment.done && segment.value.byte_end <= prefix.byte_length) {
          const value = segment.value;
          if (value.byte_start !== bytes || value.data.length !== value.byte_end - value.byte_start) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Stream content coverage has a gap");
          hash.update(value.data); bytes = value.byte_end; sequence = value.source_sequence; segment = iterator.next();
        }
        if (bytes !== prefix.byte_length || sequence > prefix.through_sequence! || hash.copy().digest("hex") !== prefix.sha256) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Immutable stream checksum is inconsistent");
      }
      iterator.return?.();
    }
  }

  private validateRef(db: Database.Database, sessionId: string, ref: ContentReference): void {
    const row = db.prepare(`SELECT byte_length, sha256, state, format FROM content_refs WHERE id = ? AND session_id = ?`).get(ref.ref, sessionId) as { byte_length: number; sha256: string; state: string; format: string } | undefined;
    if (!row || row.state !== "ready" || row.byte_length !== ref.bytes || row.sha256 !== ref.sha256 || (ref.format !== undefined && row.format !== ref.format)) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Immutable content reference is inconsistent");
  }
  private requireBuilding(sessionId: string, epochId: string): TimelineEpoch {
    const epoch = readEpoch(this.projector.db, sessionId, epochId);
    if (!epoch || epoch.state !== "building" || epoch.projectorVersion !== this.projector.version) throw new TimelineError("TIMELINE_BACKFILL_INVALID", "Expected the current building epoch");
    return epoch;
  }
  private head(sessionId: string): number {
    const row = this.projector.db.prepare(`SELECT head_sequence FROM sessions WHERE id = ?`).get(sessionId) as { head_sequence: number } | undefined;
    if (!row) throw new TimelineError("SESSION_NOT_FOUND", "Session does not exist");
    return row.head_sequence;
  }
}
