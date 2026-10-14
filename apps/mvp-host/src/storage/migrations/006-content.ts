/** Run with the Timeline 006 migration on the existing owned SQLite connection. */
export const CONTENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS content_streams (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  item_id TEXT NOT NULL,
  format TEXT NOT NULL,
  public_roots_json TEXT NOT NULL,
  pending_text TEXT NOT NULL DEFAULT '""',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'finalized')),
  through_sequence INTEGER NOT NULL DEFAULT 0,
  byte_length INTEGER NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (id, session_id)
);
CREATE INDEX IF NOT EXISTS content_streams_item ON content_streams(session_id, item_id);
CREATE TABLE IF NOT EXISTS content_segments (
  stream_id TEXT NOT NULL REFERENCES content_streams(id),
  source_sequence INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (stream_id, source_sequence, byte_start),
  CHECK (byte_start >= 0 AND byte_end > byte_start),
  CHECK (length(data) = byte_end - byte_start)
);
CREATE INDEX IF NOT EXISTS content_segments_offset ON content_segments(stream_id, byte_end);
CREATE TABLE IF NOT EXISTS content_refs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'stream_prefix')),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'expired')),
  stream_id TEXT,
  through_sequence INTEGER,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'utf8' CHECK (encoding IN ('utf8', 'base64')),
  required_scope TEXT NOT NULL DEFAULT 'session:read',
  subject_id TEXT,
  blob_data BLOB,
  created_at TEXT NOT NULL,
  UNIQUE (id, session_id),
  FOREIGN KEY (stream_id, session_id) REFERENCES content_streams(id, session_id),
  CHECK (
    (kind = 'blob' AND stream_id IS NULL AND through_sequence IS NULL AND (
      (state = 'ready' AND blob_data IS NOT NULL AND length(blob_data) = byte_length)
      OR (state = 'expired' AND blob_data IS NULL)
    )) OR
    (kind = 'stream_prefix' AND stream_id IS NOT NULL AND through_sequence IS NOT NULL AND blob_data IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS content_prefix_sequence ON content_refs(stream_id, through_sequence, byte_length) WHERE kind = 'stream_prefix';
CREATE INDEX IF NOT EXISTS content_blob_hash ON content_refs(session_id, sha256, byte_length, format, required_scope, subject_id) WHERE kind = 'blob' AND state = 'ready';
CREATE TABLE IF NOT EXISTS content_storage_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0)
);
INSERT OR IGNORE INTO content_storage_state(id, stored_bytes)
  SELECT 1, (SELECT COALESCE(SUM(length(data)), 0) FROM content_segments)
    + (SELECT COALESCE(SUM(length(blob_data)), 0) FROM content_refs)
    + (SELECT COALESCE(SUM(length(CAST(pending_text AS BLOB)) - 2), 0) FROM content_streams);
CREATE TABLE IF NOT EXISTS content_pins (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('query', 'recovery', 'checkpoint', 'timeline', 'intent')),
  owner_id TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (ref_id, session_id) REFERENCES content_refs(id, session_id),
  UNIQUE (session_id, ref_id, owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS content_pins_owner ON content_pins(owner_kind, owner_id);
`;
