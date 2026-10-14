import type Database from "better-sqlite3";
export const VIEWS_SCHEMA_VERSION = 6;
export const VIEWS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  timeline_epochs: ["session_id", "epoch", "projector_version", "indexed_sequence", "state"],
  timeline_item_versions: ["session_id", "epoch", "item_id", "revision", "display_sequence", "kind", "status", "metadata_json", "content_ref", "updated_at"],
  timeline_item_sources: ["session_id", "epoch", "item_id", "source_sequence"],
  content_streams: ["id", "session_id", "item_id", "format", "public_roots_json", "pending_text", "state", "through_sequence", "byte_length", "created_at"],
  content_segments: ["stream_id", "source_sequence", "byte_start", "byte_end", "data"],
  content_refs: ["id", "session_id", "kind", "state", "stream_id", "through_sequence", "byte_length", "sha256", "format", "encoding", "required_scope", "subject_id", "blob_data", "created_at"],
  content_pins: ["id", "session_id", "ref_id", "owner_kind", "owner_id", "expires_at"],
  content_storage_state: ["id", "stored_bytes"],
};
export function validateViewsSchema(db: Database.Database): void {
  const fail = () => { throw new Error("Declared Timeline/content schema is invalid; offline repair is required"); };
  for (const [table, names] of Object.entries(VIEWS_REQUIRED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (names.some((name) => !columns.some((column) => column.name === name))) fail();
  }
  const keys: Record<string, string[]> = { timeline_epochs: ["session_id", "epoch"], timeline_item_versions: ["session_id", "epoch", "item_id", "revision"], timeline_item_sources: ["session_id", "epoch", "item_id", "source_sequence"], content_segments: ["stream_id", "source_sequence", "byte_start"], content_refs: ["id"], content_streams: ["id"], content_pins: ["id"] };
  for (const [table, key] of Object.entries(keys)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    if (columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name).join() !== key.join()) fail();
  }
  const normalize = (sql: string) => sql.toLowerCase().replace(/[\s"`\[\]]/g, "");
  const constraints: Record<string, string[]> = {
    timeline_epochs: ["CHECK (state IN ('building', 'active', 'retired'))"],
    timeline_item_versions: ["CHECK (display_sequence > 0 AND display_sequence <= revision)", "FOREIGN KEY (content_ref, session_id) REFERENCES content_refs(id, session_id)"],
    content_segments: ["CHECK (length(data) = byte_end - byte_start)"],
    content_refs: ["FOREIGN KEY (stream_id, session_id) REFERENCES content_streams(id, session_id)", "length(blob_data) = byte_length"],
    content_pins: ["FOREIGN KEY (ref_id, session_id) REFERENCES content_refs(id, session_id)"],
  };
  for (const [table, fragments] of Object.entries(constraints)) {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string };
    if (fragments.some((fragment) => !normalize(row.sql).includes(normalize(fragment)))) fail();
  }
  for (const [name, fragment] of [["one_active_timeline_epoch", "WHERE state = 'active'"], ["content_prefix_sequence", "(stream_id, through_sequence, byte_length) WHERE kind = 'stream_prefix'"]] as const) {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) as { sql: string } | undefined;
    if (!row || !normalize(row.sql).includes("uniqueindex") || !normalize(row.sql).includes(normalize(fragment))) fail();
  }
}
