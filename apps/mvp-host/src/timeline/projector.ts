import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectedItem, SessionEvent } from "@flyx/mvp-protocol";
import { publicValue } from "../api/public-projection.js";
import { inTransaction, record, TimelineError, type ContentReference, type TimelineCommitStore, type TimelineContentStore } from "./contracts.js";

export const TIMELINE_PROJECTOR_VERSION = 3;
export type TimelineEpoch = { sessionId: string; epoch: string; projectorVersion: number; indexedSequence: number; state: "building" | "active" | "retired" };
export type ItemVersionRow = {
  session_id: string; epoch: string; item_id: string; revision: number;
  display_sequence: number; kind: ProjectedItem["kind"]; status: string;
  metadata_json: string; content_ref: string | null; updated_at: string;
};
type StoredContent = {
  inline: Record<string, unknown>;
  metadataRef?: ContentReference;
  bodyRef?: ContentReference;
  bodyField?: "text" | "output" | "message";
  streamId?: string;
};
type ItemChange = {
  itemId: string; kind: ProjectedItem["kind"]; status: string;
  metadata: Record<string, unknown>; mode?: "append" | "replace";
  field?: "text" | "output" | "message"; text?: string;
};
export type TimelineProjectorOptions = {
  workspaceForSession(sessionId: string): string;
  projectorVersion?: number;
  maximumMetadataBytes?: number;
};

/** All writes run on the source-event connection, inside its commit transaction. */
export class TimelineProjector {
  readonly version: number;
  constructor(readonly db: Database.Database, readonly content: TimelineContentStore, readonly options: TimelineProjectorOptions) {
    this.version = options.projectorVersion ?? TIMELINE_PROJECTOR_VERSION;
  }

  attach(store: TimelineCommitStore): () => void {
    if (store.db !== this.db) throw new TimelineError("TIMELINE_CONNECTION_MISMATCH", "Projection must share the event transaction");
    return store.registerCommitHook((events) => this.projectCommittedBatch(events));
  }

  activeEpoch(sessionId: string): TimelineEpoch | undefined {
    return readEpoch(this.db, sessionId);
  }

  createEpoch(sessionId: string, state: "building" | "active" = "building", epoch: string = randomUUID()): TimelineEpoch {
    this.db.prepare(`INSERT INTO timeline_epochs(session_id, epoch, projector_version, indexed_sequence, state) VALUES (?, ?, ?, 0, ?)`)
      .run(sessionId, epoch, this.version, state);
    return { sessionId, epoch, projectorVersion: this.version, indexedSequence: 0, state };
  }

  projectCommittedBatch(events: readonly SessionEvent[], epochId?: string): void {
    if (events.length === 0) return;
    inTransaction(this.db, () => {
      const sessionId = events[0]!.sessionId;
      if (events.some((event) => event.sessionId !== sessionId)) throw new TimelineError("TIMELINE_INVALID_BATCH", "A projection batch belongs to one Session");
      let epoch = epochId ? readEpoch(this.db, sessionId, epochId) : this.activeEpoch(sessionId);
      if (!epoch) {
        if (epochId || events[0]!.sequence !== 1) throw new TimelineError("TIMELINE_BACKFILL_REQUIRED", "Timeline must be rebuilt before publishing");
        epoch = this.createEpoch(sessionId, "active");
      }
      if (epoch.state === "retired" || epoch.projectorVersion !== this.version) throw new TimelineError("TIMELINE_CURSOR_EXPIRED", "Projection epoch is unavailable");
      let indexed = epoch.indexedSequence;
      for (const event of events) {
        // Replayed, identical source facts are idempotent during resumable backfill.
        if (event.sequence <= indexed) continue;
        if (event.sequence !== indexed + 1) throw new TimelineError("TIMELINE_SOURCE_GAP", "Projection source coverage has a gap");
        this.projectEvent(epoch, event);
        indexed = event.sequence;
      }
      this.db.prepare(`UPDATE timeline_epochs SET indexed_sequence = ? WHERE session_id = ? AND epoch = ?`).run(indexed, sessionId, epoch.epoch);
    });
  }

  private projectEvent(epoch: TimelineEpoch, event: SessionEvent): void {
    const change = normalizeEvent(event);
    if (change) this.projectItem(epoch, event, change);
    // Legacy restart recovery settled approvals as one durable source fact.
    // Project every affected card at that same revision so no stale pending
    // approval survives a rebuilt historical window.
    const payload = record(event.payload);
    if (event.type === "session.recovery.required" && Array.isArray(payload.pendingApprovalIds)) {
      for (const approvalId of new Set(payload.pendingApprovalIds.filter((value): value is string => typeof value === "string"))) {
        this.projectItem(epoch, event, { itemId: `approval-${approvalId}`, kind: "approval", status: "superseded", metadata: { approvalId, status: "superseded", action: "aborted", reason: payload.reason ?? "host_restart", ...(payload.turnId ? { turnId: payload.turnId } : {}) } });
      }
    }
  }

  private projectItem(epoch: TimelineEpoch, event: SessionEvent, change: ItemChange): void {
    const previous = this.db.prepare(`SELECT * FROM timeline_item_versions WHERE session_id = ? AND epoch = ? AND item_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(event.sessionId, epoch.epoch, change.itemId) as ItemVersionRow | undefined;
    const prior = previous ? JSON.parse(previous.metadata_json) as StoredContent : { inline: {} };
    // A late streaming callback cannot turn an already-completed message back
    // into an unfinished prefix, but still advances global source coverage.
    if (change.kind === "assistant_message" && change.mode === "append" && previous && previous.status !== "streaming") return;
    if (change.kind === "tool_call" && change.status === "running" && previous && ["completed", "failed"].includes(previous.status)) return;
    const workspace = this.options.workspaceForSession(event.sessionId);
    const inherited = prior.metadataRef ? { ...record(JSON.parse(readReferenceText(this.db, prior.metadataRef.ref))), ...prior.inline } : prior.inline;
    const metadata = record(publicValue({ ...inherited, ...change.metadata }, workspace));
    const stored: StoredContent = { inline: metadata };
    if (Buffer.byteLength(JSON.stringify(metadata)) > (this.options.maximumMetadataBytes ?? 8 * 1024)) {
      // Keep a large immutable metadata base and a bounded shallow overlay.
      // Lifecycle changes must not copy a long request/input into every version.
      const patch = { ...prior.inline };
      const updates = record(publicValue(change.metadata, workspace));
      for (const [key, value] of Object.entries(updates)) if (JSON.stringify(value) !== JSON.stringify(inherited[key])) patch[key] = value;
      if (prior.metadataRef && Buffer.byteLength(JSON.stringify(patch)) <= (this.options.maximumMetadataBytes ?? 8 * 1024)) {
        stored.inline = patch; stored.metadataRef = prior.metadataRef;
      } else {
        stored.inline = {};
        stored.metadataRef = this.content.putBlob({ sessionId: event.sessionId, itemId: change.itemId, format: "application/json", text: JSON.stringify(metadata), workspace });
      }
    }
    if (change.mode === "append") {
      let streamId = prior.streamId;
      if (!streamId) {
        streamId = this.content.beginStream({ sessionId: event.sessionId, itemId: change.itemId, format: "text/plain", workspace }).streamId;
        // Switching from a cumulative tool snapshot to explicit deltas seeds
        // once from that immutable snapshot. Normal deltas never copy a prefix.
        if (prior.bodyRef) this.content.appendSegment({ streamId, sourceSequence: event.sequence - 1, text: readReferenceText(this.db, prior.bodyRef.ref) });
      }
      stored.streamId = streamId;
      stored.bodyField = change.field!;
      stored.bodyRef = this.content.appendSegment({ streamId, sourceSequence: event.sequence, text: change.text ?? "" });
      if (change.status !== "running" && change.status !== "streaming") {
        stored.bodyRef = this.content.finalizeStream({ streamId, sourceSequence: event.sequence });
        delete stored.streamId;
      }
    } else if (change.mode === "replace") {
      if (prior.streamId) this.content.finalizeStream({ streamId: prior.streamId, sourceSequence: event.sequence });
      stored.bodyField = change.field!;
      stored.bodyRef = this.content.putBlob({ sessionId: event.sessionId, itemId: change.itemId, format: "text/plain", text: change.text ?? "", workspace });
    } else {
      if (prior.bodyRef) stored.bodyRef = prior.bodyRef;
      if (prior.bodyField) stored.bodyField = prior.bodyField;
      if (prior.streamId) stored.streamId = prior.streamId;
      if (change.status !== "running" && change.status !== "streaming" && stored.streamId) {
        stored.bodyRef = this.content.finalizeStream({ streamId: stored.streamId, sourceSequence: event.sequence });
        delete stored.streamId;
      }
    }
    for (const ref of [stored.bodyRef, stored.metadataRef]) if (ref) this.content.pin({ sessionId: event.sessionId, ref: ref.ref, ownerKind: "timeline", ownerId: `${event.sessionId}:${epoch.epoch}` });
    this.db.prepare(`INSERT INTO timeline_item_versions(session_id, epoch, item_id, revision, display_sequence, kind, status, metadata_json, content_ref, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.sessionId, epoch.epoch, change.itemId, event.sequence, previous?.display_sequence ?? event.sequence, change.kind, change.status, JSON.stringify(stored), stored.bodyRef?.ref ?? null, event.occurredAt);
    this.db.prepare(`INSERT INTO timeline_item_sources(session_id, epoch, item_id, source_sequence) VALUES (?, ?, ?, ?)`)
      .run(event.sessionId, epoch.epoch, change.itemId, event.sequence);
  }
}

export function readEpoch(db: Database.Database, sessionId: string, epoch?: string): TimelineEpoch | undefined {
  const row = (epoch
    ? db.prepare(`SELECT * FROM timeline_epochs WHERE session_id = ? AND epoch = ?`).get(sessionId, epoch)
    : db.prepare(`SELECT * FROM timeline_epochs WHERE session_id = ? AND state = 'active'`).get(sessionId)) as {
      session_id: string; epoch: string; projector_version: number; indexed_sequence: number; state: TimelineEpoch["state"];
    } | undefined;
  return row && { sessionId: row.session_id, epoch: row.epoch, projectorVersion: row.projector_version, indexedSequence: row.indexed_sequence, state: row.state };
}

export function toProjectedItem(row: ItemVersionRow): ProjectedItem {
  const stored = JSON.parse(row.metadata_json) as StoredContent;
  return {
    sessionId: row.session_id, itemId: row.item_id, kind: row.kind, status: row.status,
    revision: row.revision, displaySequence: row.display_sequence, updatedAt: row.updated_at,
    content: stored.bodyRef ?? { inline: stored.inline },
    ...(stored.bodyField ? { contentField: stored.bodyField, metadata: stored.inline } : {}),
    ...(stored.metadataRef ? { metadataRef: stored.metadataRef } : {}),
  };
}

/** Read only when a semantic replace-to-append transition needs a new stream. */
export function readReferenceText(db: Database.Database, ref: string): string {
  const row = db.prepare(`SELECT kind, state, stream_id, through_sequence, byte_length, blob_data FROM content_refs WHERE id = ?`).get(ref) as {
    kind: string; state: string; stream_id: string | null; through_sequence: number | null; byte_length: number; blob_data: Buffer | null;
  } | undefined;
  if (!row || row.state !== "ready") throw new TimelineError("CONTENT_REF_EXPIRED", "Projection content has expired");
  if (row.kind === "blob") return row.blob_data!.toString("utf8");
  const segments = db.prepare(`SELECT data FROM content_segments WHERE stream_id = ? AND source_sequence <= ? AND byte_start < ? ORDER BY byte_start`)
    .all(row.stream_id, row.through_sequence, row.byte_length) as Array<{ data: Buffer }>;
  return Buffer.concat(segments.map((segment) => segment.data)).subarray(0, row.byte_length).toString("utf8");
}

function normalizeEvent(event: SessionEvent): ItemChange | undefined {
  const payload = record(event.payload);
  const itemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
  const metadata = { ...payload };
  delete metadata.text; delete metadata.output; delete metadata.outputDelta;
  delete metadata.itemId; delete metadata.kind; delete metadata.generation;
  delete metadata.dispatchContext;
  const text = typeof payload.text === "string" ? payload.text : "";
  if (event.type.startsWith("interaction.")) {
    const interaction = record(payload.interaction);
    const kind = payload.interactionKind ?? interaction.kind ?? payload.kind;
    if (kind !== "approval" && kind !== "question") return undefined;
    const status = typeof payload.status === "string" ? payload.status : typeof interaction.status === "string" ? interaction.status
      : event.type === "interaction.requested" ? "pending"
      : event.type === "interaction.response.accepted" ? "response_accepted"
      : event.type.endsWith("expired") ? "expired"
      : event.type.endsWith("superseded") ? "superseded" : "delivering";
    return { itemId: itemId ?? `interaction-${String(payload.interactionId ?? payload.id ?? interaction.id ?? event.id)}`, kind, status, metadata: { ...metadata, interactionKind: kind }, ...(typeof payload.text === "string" ? { mode: "replace", field: "text", text } as const : {}) };
  }
  switch (event.type) {
    case "user.message.created": return { itemId: itemId ?? `user-${String(payload.turnId ?? event.id)}`, kind: "user_message", status: "completed", metadata, mode: "replace", field: "text", text };
    case "assistant.message.delta": return itemId ? { itemId, kind: "assistant_message", status: "streaming", metadata, mode: "append", field: "text", text } : undefined;
    case "assistant.message.completed": return itemId ? { itemId, kind: "assistant_message", status: payload.aborted ? "aborted" : "completed", metadata, mode: "replace", field: "text", text } : undefined;
    case "tool.call.started": return itemId ? { itemId, kind: "tool_call", status: "running", metadata } : undefined;
    case "tool.call.progress":
    case "tool.call.completed": {
      if (!itemId) return undefined;
      const status = event.type.endsWith("completed") ? (payload.error ? "failed" : "completed") : "running";
      if (typeof payload.output === "string") return { itemId, kind: "tool_call", status, metadata, mode: "replace", field: "output", text: payload.output };
      if (typeof payload.outputDelta === "string") return { itemId, kind: "tool_call", status, metadata, mode: "append", field: "output", text: payload.outputDelta };
      return { itemId, kind: "tool_call", status, metadata };
    }
    case "approval.requested":
    case "approval.resolved": return { itemId: itemId ?? `approval-${String(payload.approvalId ?? event.id)}`, kind: "approval", status: String(payload.status ?? (event.type.endsWith("requested") ? "pending" : "resolved")), metadata };
    case "question.requested":
    case "question.resolved": return { itemId: itemId ?? `question-${String(payload.interactionId ?? payload.questionId ?? event.id)}`, kind: "question", status: event.type.endsWith("requested") ? "pending" : "resolved", metadata };
    case "provider.session.init": return { itemId: itemId ?? `system-session-${createHash("sha256").update(`${event.sessionId}:${String(payload.providerSessionId ?? event.id)}`).digest("hex").slice(0, 32)}`, kind: "system", status: "info", metadata: { ...metadata, message: `${payload.provider === "codex" ? "Codex" : "Claude"} session initialized` } };
    case "diagnostic": return { itemId: itemId ?? `diagnostic-${event.id}`, kind: "system", status: "diagnostic", metadata };
    case "turn.completed": {
      delete metadata.result;
      return { itemId: itemId ?? `result-${String(payload.turnId ?? event.id)}`, kind: "system", status: "completed", metadata, mode: "replace", field: "message", text: typeof payload.result === "string" ? payload.result : "Turn completed" };
    }
    case "turn.cancelled": return { itemId: itemId ?? `result-${String(payload.turnId ?? event.id)}`, kind: "system", status: "cancelled", metadata: { ...metadata, message: "Turn cancelled" } };
    case "turn.failed":
    case "host.event_persist_failed": return { itemId: itemId ?? `error-${String(payload.turnId ?? event.id)}`, kind: "error", status: "failed", metadata };
    case "turn.interrupt.requested": return { itemId: itemId ?? `interrupt-${String(payload.turnId ?? event.id)}`, kind: "system", status: "requested", metadata: { ...metadata, message: "Interrupt requested" } };
    case "turn.interrupt.unavailable": return { itemId: itemId ?? `error-${event.id}`, kind: "error", status: "error", metadata: { ...metadata, message: "Provider interrupt could not be confirmed" } };
    case "approval.resolve.unavailable": return { itemId: itemId ?? `error-${event.id}`, kind: "error", status: "error", metadata: { ...metadata, message: "Approval resolution could not be confirmed" } };
    case "session.recovery.required": return { itemId: itemId ?? `recovery-${String(payload.turnId ?? event.id)}`, kind: "error", status: "outcome_unknown", metadata: { ...metadata, message: typeof payload.message === "string" ? payload.message : "Session outcome requires recovery" } };
    case "turn.reconciled": return payload.outcome === "failed" ? { itemId: itemId ?? `error-${event.id}`, kind: "error", status: "failed", metadata: { ...metadata, message: "Provider execution failed" } } : undefined;
    default: return undefined;
  }
}
