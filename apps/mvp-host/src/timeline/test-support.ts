import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { SessionEvent } from "@flyx/mvp-protocol";
import { SqliteStore } from "../storage/db.js";
import { CONTENT_SCHEMA_SQL } from "../storage/migrations/006-content.js";
import { installTimelineSchema } from "../storage/migrations/006-timeline.js";
import { ContentStore } from "../content/content-store.js";
import type { CommitBoundary, TimelineCommitStore } from "./contracts.js";
import { TimelineProjector } from "./projector.js";
import { TimelineQuery, type TimelineQueryOptions } from "./timeline-query.js";
import type { TimelineSource } from "./timeline-subscriptions.js";

export class TestTimelineSource implements TimelineSource {
  readonly listeners = new Set<(event: SessionEvent) => void>();
  onSubscribe?: () => void;
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener); this.onSubscribe?.();
    return () => { this.listeners.delete(listener); };
  }
  publish(events: readonly SessionEvent[]): void { for (const event of events) for (const listener of this.listeners) listener(event); }
}

/** Minimal synchronous source-commit driver for the exported production hook. */
export class TimelineFixture implements TimelineCommitStore {
  readonly store = new SqliteStore();
  readonly db: Database.Database = this.store.db;
  readonly source = new TestTimelineSource();
  readonly session = this.store.createSession("/tmp/fixture", "claude", "00000000-0000-0000-0000-000000000001");
  readonly content: ContentStore;
  readonly projector: TimelineProjector;
  private readonly hooks = new Set<(events: readonly SessionEvent[], commit: CommitBoundary) => void>();
  private readonly detach: () => void;
  constructor() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_commits(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL, UNIQUE(session_id, first_sequence), UNIQUE(session_id, last_sequence), CHECK(last_sequence >= first_sequence));`);
    if (!(this.db.prepare("PRAGMA table_info(session_events)").all() as Array<{ name: string }>).some((column) => column.name === "commit_id")) this.db.exec(`ALTER TABLE session_events ADD COLUMN commit_id TEXT REFERENCES event_commits(id)`);
    this.db.exec(CONTENT_SCHEMA_SQL);
    installTimelineSchema(this.db);
    this.content = new ContentStore(this.db, { workspaceForSession: () => "/tmp/fixture" });
    this.projector = new TimelineProjector(this.db, this.content, { workspaceForSession: () => "/tmp/fixture" });
    this.detach = this.projector.attach(this);
  }
  registerCommitHook(hook: (events: readonly SessionEvent[], commit: CommitBoundary) => void): () => void {
    this.hooks.add(hook); return () => { this.hooks.delete(hook); };
  }
  stopProjecting(): void { this.detach(); }
  query(options: Omit<TimelineQueryOptions, "workspaceForSession"> = {}): TimelineQuery { return new TimelineQuery(this.db, this.content, { workspaceForSession: () => "/tmp/fixture", maximumInlineContentBytes: 0, ...options }); }
  snapshot() { return { session: this.store.getSession(this.session.id)!, pendingApprovals: [] }; }
  commit(inputs: Array<{ type: string; payload?: unknown }>, options: { legacy?: boolean; publish?: boolean } = {}): SessionEvent[] {
    const events = this.db.transaction(() => {
      const first = this.store.getSession(this.session.id)!.headSequence + 1;
      const commit: CommitBoundary = { id: randomUUID(), sessionId: this.session.id, firstSequence: first, lastSequence: first + inputs.length - 1 };
      if (!options.legacy) this.db.prepare(`INSERT INTO event_commits(id, session_id, first_sequence, last_sequence) VALUES (?, ?, ?, ?)`).run(commit.id, commit.sessionId, first, commit.lastSequence);
      const events = inputs.map((input, index) => ({ id: randomUUID(), sessionId: this.session.id, sequence: first + index, type: input.type, payload: input.payload ?? {}, occurredAt: "2026-10-14T00:00:00.000Z" }));
      for (const event of events) this.db.prepare(`INSERT INTO session_events(id, session_id, sequence, type, payload_json, occurred_at, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.id, event.sessionId, event.sequence, event.type, JSON.stringify(event.payload), event.occurredAt, options.legacy ? null : commit.id);
      this.db.prepare(`UPDATE sessions SET head_sequence = ? WHERE id = ?`).run(commit.lastSequence, this.session.id);
      for (const hook of this.hooks) hook(events, commit);
      return events;
    })();
    if (options.publish !== false) this.source.publish(events);
    return events;
  }
  text(ref: string): string {
    let offset = 0;
    const parts: string[] = [];
    for (;;) {
      const chunk = this.content.getChunk({ sessionId: this.session.id, ref, offset, maxBytes: 64 * 1024 });
      if (chunk.encoding !== "utf8") throw new Error("Expected text reference");
      parts.push(chunk.text); offset = chunk.nextOffset;
      if (!chunk.hasMore) return parts.join("");
    }
  }
  close(): void { this.store.close(); }
}
