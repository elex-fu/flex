import { createHash, randomUUID, type Hash } from "node:crypto";
import type Database from "better-sqlite3";
import { ContentChunkRequestSchema, ContentRefIdSchema, type ContentChunk, type ContentChunkRequest, type ContentRef } from "@flyx/mvp-protocol";
import { FrameBudget, utf8End } from "./frame-budget.js";
import { publicTextPart } from "./public-text.js";

export class ContentError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string) { super(message); this.name = "ContentError"; }
}
export interface ContentStoreOptions {
  workspaceForSession?(sessionId: string): string | readonly string[];
  now?(): string;
  maxStoredBytes?: number;
}
export interface ContentBlobInput {
  sessionId: string; itemId?: string; format: string; text: string; workspace?: string;
  requiredScope?: string; subjectId?: string;
}
export interface ContentBytesInput extends Omit<ContentBlobInput, "text"> { data: Uint8Array }
export interface ContentChunkOptions {
  budget?: FrameBudget;
  envelope?(chunk: ContentChunk): unknown;
  subjectId?: string;
  assertScope?(scope: string): void;
}
type StreamRow = {
  id: string; session_id: string; item_id: string; format: string; public_roots_json: string;
  pending_text: string; state: "open" | "finalized"; through_sequence: number; byte_length: number;
};
type RefRow = {
  id: string; session_id: string; kind: "blob" | "stream_prefix"; state: "ready" | "expired";
  stream_id: string | null; through_sequence: number | null; byte_length: number; sha256: string;
  format: string; encoding: "utf8" | "base64"; required_scope: string; subject_id: string | null;
};
type HashState = { sequence: number; bytes: number; hash: Hash };

/** Uses the owner's connection. All methods are synchronous and join outer write transactions. */
export class ContentStore {
  private readonly hashes = new Map<string, HashState>();
  private readonly timestamp: () => string;
  constructor(readonly db: Database.Database, private readonly options: ContentStoreOptions = {}) {
    this.timestamp = options.now ?? (() => new Date().toISOString());
  }
  static isAvailable(db: Database.Database): boolean {
    return (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('content_streams', 'content_segments', 'content_refs', 'content_pins', 'content_storage_state')").get() as { n: number }).n === 5;
  }
  beginStream(input: { sessionId: string; itemId: string; format: string; workspace?: string }): { streamId: string } {
    const streamId = `str_${randomUUID().replaceAll("-", "")}`;
    this.db.prepare("INSERT INTO content_streams(id, session_id, item_id, format, public_roots_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(streamId, input.sessionId, input.itemId, input.format, JSON.stringify(this.roots(input.sessionId, input.workspace)), this.timestamp());
    return { streamId };
  }
  appendSegment(input: { streamId: string; sourceSequence: number; text: string }): ContentRef {
    return this.writeSegment(input, false);
  }
  finalizeStream(input: { streamId: string; sourceSequence: number }): ContentRef {
    return this.writeSegment({ ...input, text: "" }, true);
  }
  putBlob(input: ContentBlobInput): ContentRef {
    const text = publicTextPart(input.text, this.roots(input.sessionId, input.workspace), true).text;
    const data = Buffer.from(text, "utf8");
    return this.putPublicBytes(input, data, "utf8");
  }
  /** Binary public representation replaces root bytes before hashing and base64 encoding. */
  putBytes(input: ContentBytesInput): ContentRef {
    return this.putPublicBytes(input, redactBytes(Buffer.from(input.data), this.roots(input.sessionId, input.workspace)), "base64");
  }
  private putPublicBytes(input: Omit<ContentBlobInput, "text">, data: Buffer, encoding: "utf8" | "base64"): ContentRef {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const scope = input.requiredScope ?? "session:read";
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id, byte_length, sha256, format FROM content_refs WHERE session_id = ? AND kind = 'blob' AND state = 'ready' AND sha256 = ? AND byte_length = ? AND format = ? AND required_scope = ? AND subject_id IS ? AND encoding = ? LIMIT 1`)
        .get(input.sessionId, sha256, data.length, input.format, scope, input.subjectId ?? null, encoding) as Pick<RefRow, "id" | "byte_length" | "sha256" | "format"> | undefined;
      if (existing) return descriptor(existing);
      this.checkCapacity(data.length);
      const ref = this.refId();
      this.db.prepare(`INSERT INTO content_refs(id, session_id, kind, byte_length, sha256, format, encoding, required_scope, subject_id, blob_data, created_at) VALUES (?, ?, 'blob', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ref, input.sessionId, data.length, sha256, input.format, encoding, scope, input.subjectId ?? null, data, this.timestamp());
      return { ref, bytes: data.length, sha256, format: input.format };
    })();
  }
  getRef(sessionId: string, ref: string): ContentRef { return descriptor(this.readyRef(sessionId, ref)); }

  getChunk(raw: ContentChunkRequest | unknown, options: ContentChunkOptions = {}): ContentChunk {
    const input = ContentChunkRequestSchema.parse(raw);
    const row = this.readyRef(input.sessionId, input.ref);
    if (row.subject_id !== null && row.subject_id !== options.subjectId) throw new ContentError("CONTENT_SCOPE_MISMATCH", "Content belongs to a different actor");
    if (options.assertScope) options.assertScope(row.required_scope);
    else if (row.required_scope !== "session:read") throw new ContentError("CONTENT_SCOPE_MISMATCH", "Content requires additional permission");
    if (row.encoding === "base64" && input.encoding !== "base64") throw new ContentError("CONTENT_ENCODING_INVALID", "Binary content requires base64 encoding");
    if (input.offset > row.byte_length) throw new ContentError("CONTENT_OFFSET_INVALID", "Content offset is outside this reference");
    const available = Math.min(input.maxBytes, row.byte_length - input.offset);
    const data = this.readRange(row, input.offset, Math.min(available + 4, row.byte_length - input.offset));
    if (input.encoding === "utf8" && data.length > 0 && (data[0]! & 0xc0) === 0x80) throw new ContentError("CONTENT_OFFSET_INVALID", "Content offset must align with UTF-8");
    const build = (count: number): ContentChunk => {
      const size = input.encoding === "utf8" ? utf8End(data, count) : count;
      const common = { sessionId: input.sessionId, ref: row.id, offset: input.offset, nextOffset: input.offset + size, totalBytes: row.byte_length, sha256: row.sha256, format: row.format, hasMore: input.offset + size < row.byte_length };
      return input.encoding === "utf8" ? { ...common, encoding: "utf8", text: data.subarray(0, size).toString("utf8") } : { ...common, encoding: "base64", data: data.subarray(0, size).toString("base64") };
    };
    const budget = options.budget ?? new FrameBudget();
    const wrap = options.envelope ?? ((chunk: ContentChunk) => ({ type: "response", id: "content", ok: true, payload: chunk, transportGeneration: Number.MAX_SAFE_INTEGER }));
    let low = 0;
    let high = available;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (budget.fits(wrap(build(middle)))) low = middle;
      else high = middle - 1;
    }
    const chunk = build(low);
    budget.assert(wrap(chunk));
    if (chunk.hasMore && chunk.nextOffset === input.offset) throw new ContentError("CONTENT_CHUNK_TOO_SMALL", "Chunk byte budget cannot hold the next character");
    return chunk;
  }

  /** Pins share the caller's transaction with the reference that creates its dependency. */
  pin(input: { sessionId: string; ref: string; ownerKind: "query" | "recovery" | "checkpoint" | "timeline" | "intent"; ownerId: string; expiresAt?: string }): string {
    this.readyRef(input.sessionId, input.ref);
    const id = `pin_${randomUUID().replaceAll("-", "")}`;
    const row = this.db.prepare(`INSERT INTO content_pins(id, session_id, ref_id, owner_kind, owner_id, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, ref_id, owner_kind, owner_id) DO UPDATE SET expires_at = excluded.expires_at RETURNING id`)
      .get(id, input.sessionId, input.ref, input.ownerKind, input.ownerId, input.expiresAt ?? null) as { id: string };
    return row.id;
  }
  unpin(ownerKind: string, ownerId: string): void { this.db.prepare("DELETE FROM content_pins WHERE owner_kind = ? AND owner_id = ?").run(ownerKind, ownerId); }
  /** Mark expired refs, then reclaim only bytes that no available prefix or live pin needs. */
  sweep(input: { createdBefore: string; now?: string }): { refsExpired: number; segmentsDeleted: number } {
    const now = input.now ?? this.timestamp();
    return this.db.transaction(() => {
      const before = this.storedBytes();
      this.db.prepare("DELETE FROM content_pins WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
      const marked = this.db.prepare(`UPDATE content_refs SET state = 'expired', blob_data = NULL WHERE state = 'ready' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM content_pins p WHERE p.ref_id = content_refs.id) AND NOT EXISTS (SELECT 1 FROM content_streams s WHERE s.id = content_refs.stream_id AND s.state = 'open')`).run(input.createdBefore);
      const deleted = this.db.prepare(`DELETE FROM content_segments WHERE NOT EXISTS (SELECT 1 FROM content_refs r WHERE r.stream_id = content_segments.stream_id AND r.state = 'ready' AND r.through_sequence >= content_segments.source_sequence AND r.byte_length >= content_segments.byte_end) AND NOT EXISTS (SELECT 1 FROM content_streams s WHERE s.id = content_segments.stream_id AND s.state = 'open')`).run();
      const remaining = this.db.prepare(`SELECT (SELECT COALESCE(SUM(length(data)), 0) FROM content_segments) + (SELECT COALESCE(SUM(length(blob_data)), 0) FROM content_refs) + (SELECT COALESCE(SUM(length(CAST(pending_text AS BLOB)) - 2), 0) FROM content_streams) AS bytes`).get() as { bytes: number };
      this.db.prepare("UPDATE content_storage_state SET stored_bytes = ? WHERE id = 1").run(Math.min(before, remaining.bytes));
      if (deleted.changes) this.hashes.clear();
      return { refsExpired: marked.changes, segmentsDeleted: deleted.changes };
    })();
  }
  /** Stable public delta for the old raw event stream after the projector has committed it. */
  publicDelta(sessionId: string, itemId: string, sequence: number): string | undefined {
    const ref = this.db.prepare(`SELECT r.id FROM content_refs r JOIN content_streams s ON s.id = r.stream_id WHERE r.session_id = ? AND s.item_id = ? AND r.through_sequence = ? ORDER BY r.byte_length DESC LIMIT 1`).get(sessionId, itemId, sequence) as { id: string } | undefined;
    if (!ref) return undefined;
    const parts: Buffer[] = [];
    for (const segment of this.db.prepare(`SELECT data FROM content_segments c JOIN content_refs r ON r.stream_id = c.stream_id WHERE r.id = ? AND c.source_sequence = ? AND c.byte_end <= r.byte_length ORDER BY c.byte_start`).iterate(ref.id, sequence) as Iterable<{ data: Buffer }>) parts.push(segment.data);
    return Buffer.concat(parts).toString("utf8");
  }

  private writeSegment(input: { streamId: string; sourceSequence: number; text: string }, final: boolean): ContentRef {
    return this.db.transaction(() => {
      const stream = this.db.prepare("SELECT * FROM content_streams WHERE id = ?").get(input.streamId) as StreamRow | undefined;
      if (!stream) throw new ContentError("CONTENT_NOT_FOUND", "Content stream does not exist");
      if (!Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 1) throw new ContentError("CONTENT_SEQUENCE_INVALID", "Invalid content source sequence");
      if (input.sourceSequence < stream.through_sequence || (input.sourceSequence === stream.through_sequence && !final)) throw new ContentError("CONTENT_SEQUENCE_INVALID", "Content source sequence must advance");
      if (stream.state !== "open") {
        const previous = this.db.prepare("SELECT id, byte_length, sha256, format FROM content_refs WHERE stream_id = ? AND through_sequence = ? ORDER BY byte_length DESC LIMIT 1").get(stream.id, input.sourceSequence) as RefRow | undefined;
        if (final && input.sourceSequence === stream.through_sequence && previous) return descriptor(previous);
        throw new ContentError("CONTENT_STREAM_CLOSED", "Content stream is finalized");
      }
      const part = publicTextPart((JSON.parse(stream.pending_text) as string) + input.text, JSON.parse(stream.public_roots_json) as string[], final);
      const data = Buffer.from(part.text, "utf8");
      this.checkCapacity(data.length + Buffer.byteLength(JSON.stringify(part.pending)) - Buffer.byteLength(stream.pending_text));
      const current = this.hashState(stream);
      const hash = current.hash.copy().update(data);
      const sha256 = hash.copy().digest("hex");
      if (data.length) this.db.prepare(`INSERT INTO content_segments(stream_id, source_sequence, byte_start, byte_end, data) VALUES (?, ?, ?, ?, ?)`).run(stream.id, input.sourceSequence, stream.byte_length, stream.byte_length + data.length, data);
      this.db.prepare("UPDATE content_streams SET pending_text = ?, state = ?, through_sequence = ?, byte_length = ? WHERE id = ?")
        .run(JSON.stringify(part.pending), final ? "finalized" : "open", input.sourceSequence, stream.byte_length + data.length, stream.id);
      const existing = this.db.prepare("SELECT id, byte_length, sha256, format FROM content_refs WHERE stream_id = ? AND through_sequence = ? AND byte_length = ?").get(stream.id, input.sourceSequence, stream.byte_length + data.length) as RefRow | undefined;
      if (existing) return descriptor(existing);
      const ref = this.refId();
      this.db.prepare(`INSERT INTO content_refs(id, session_id, kind, stream_id, through_sequence, byte_length, sha256, format, created_at) VALUES (?, ?, 'stream_prefix', ?, ?, ?, ?, ?, ?)`)
        .run(ref, stream.session_id, stream.id, input.sourceSequence, stream.byte_length + data.length, sha256, stream.format, this.timestamp());
      this.hashes.set(stream.id, { sequence: input.sourceSequence, bytes: stream.byte_length + data.length, hash });
      return { ref, bytes: stream.byte_length + data.length, sha256, format: stream.format };
    })();
  }
  private hashState(stream: StreamRow): HashState {
    const cached = this.hashes.get(stream.id);
    if (cached?.sequence === stream.through_sequence && cached.bytes === stream.byte_length) return cached;
    const hash = createHash("sha256");
    let bytes = 0;
    for (const segment of this.db.prepare("SELECT data FROM content_segments WHERE stream_id = ? ORDER BY byte_start").iterate(stream.id) as Iterable<{ data: Buffer }>) { hash.update(segment.data); bytes += segment.data.length; }
    if (bytes !== stream.byte_length) throw new ContentError("CONTENT_CORRUPT", "Content stream bytes are unavailable");
    return { sequence: stream.through_sequence, bytes, hash };
  }
  private readyRef(sessionId: string, ref: string): RefRow {
    if (!ContentRefIdSchema.safeParse(ref).success) throw new ContentError("CONTENT_NOT_FOUND", "Content reference does not exist");
    const row = this.db.prepare("SELECT id, session_id, kind, state, stream_id, through_sequence, byte_length, sha256, format, encoding, required_scope, subject_id FROM content_refs WHERE id = ?").get(ref) as RefRow | undefined;
    if (!row) throw new ContentError("CONTENT_NOT_FOUND", "Content reference does not exist");
    if (row.session_id !== sessionId) throw new ContentError("CONTENT_SCOPE_MISMATCH", "Content belongs to a different Session");
    if (row.state !== "ready") throw new ContentError("CONTENT_EXPIRED", "Content body has expired");
    return row;
  }
  private readRange(row: RefRow, offset: number, length: number): Buffer {
    if (length === 0) return Buffer.alloc(0);
    if (row.kind === "blob") return (this.db.prepare("SELECT substr(blob_data, ?, ?) AS data FROM content_refs WHERE id = ?").get(offset + 1, length, row.id) as { data: Buffer }).data;
    const result = Buffer.alloc(length);
    let written = 0;
    for (const segment of this.db.prepare(`SELECT substr(data, MAX(0, ? - byte_start) + 1, MIN(byte_end, ?) - MAX(byte_start, ?)) AS data FROM content_segments WHERE stream_id = ? AND source_sequence <= ? AND byte_end > ? AND byte_start < ? ORDER BY byte_start`).iterate(offset, offset + length, offset, row.stream_id, row.through_sequence, offset, offset + length) as Iterable<{ data: Buffer }>) { segment.data.copy(result, written); written += segment.data.length; }
    if (written !== length) throw new ContentError("CONTENT_CORRUPT", "Content reference bytes are unavailable");
    return result;
  }
  private roots(sessionId: string, workspace?: string): readonly string[] {
    const resolved = workspace ?? this.options.workspaceForSession?.(sessionId);
    return typeof resolved === "string" ? [resolved] : resolved ?? [];
  }
  private refId(): string { return `cnt_${randomUUID().replaceAll("-", "")}`; }
  private storedBytes(): number {
    return (this.db.prepare("SELECT stored_bytes AS bytes FROM content_storage_state WHERE id = 1").get() as { bytes: number }).bytes;
  }
  private checkCapacity(extra: number): void {
    const limit = this.options.maxStoredBytes ?? 512 * 1024 * 1024;
    if (this.storedBytes() + extra > limit) throw new ContentError("CONTENT_STORAGE_LIMIT", "Content storage limit reached");
    this.db.prepare("UPDATE content_storage_state SET stored_bytes = stored_bytes + ? WHERE id = 1").run(extra);
  }
}
function descriptor(row: Pick<RefRow, "id" | "byte_length" | "sha256" | "format">): ContentRef { return { ref: row.id, bytes: row.byte_length, sha256: row.sha256, format: row.format }; }
function redactBytes(data: Buffer, roots: readonly string[]): Buffer {
  const privateBytes = [...new Set(roots.filter(Boolean))].map((root) => Buffer.from(root)).sort((a, b) => b.length - a.length);
  const parts: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    let position = -1;
    let matched: Buffer | undefined;
    for (const root of privateBytes) {
      const next = data.indexOf(root, cursor);
      if (next !== -1 && (position === -1 || next < position)) { position = next; matched = root; }
    }
    if (!matched) break;
    parts.push(data.subarray(cursor, position), Buffer.from("."));
    cursor = position + matched.length;
  }
  if (cursor === 0) return data;
  parts.push(data.subarray(cursor));
  return Buffer.concat(parts);
}
