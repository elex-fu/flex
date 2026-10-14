import type Database from "better-sqlite3";

/** The content tables in migration 006 must be installed before version rows. */
export const TIMELINE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS timeline_epochs (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  projector_version INTEGER NOT NULL CHECK (projector_version > 0),
  indexed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (indexed_sequence >= 0),
  state TEXT NOT NULL CHECK (state IN ('building', 'active', 'retired')),
  PRIMARY KEY (session_id, epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_timeline_epoch
  ON timeline_epochs(session_id) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS timeline_item_versions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  display_sequence INTEGER NOT NULL CHECK (display_sequence > 0 AND display_sequence <= revision),
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_message', 'tool_call', 'approval', 'question', 'error', 'system')),
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  content_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id, revision),
  FOREIGN KEY (session_id, epoch) REFERENCES timeline_epochs(session_id, epoch) ON DELETE CASCADE,
  FOREIGN KEY (content_ref, session_id) REFERENCES content_refs(id, session_id)
);
CREATE INDEX IF NOT EXISTS timeline_versions_after
  ON timeline_item_versions(session_id, epoch, revision, item_id);
CREATE INDEX IF NOT EXISTS timeline_versions_display
  ON timeline_item_versions(session_id, epoch, display_sequence, item_id, revision);
CREATE TABLE IF NOT EXISTS timeline_item_sources (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id, source_sequence),
  FOREIGN KEY (session_id, epoch, item_id, source_sequence)
    REFERENCES timeline_item_versions(session_id, epoch, item_id, revision) ON DELETE CASCADE
);
`;

export function installTimelineSchema(db: Database.Database): void {
  db.exec(TIMELINE_SCHEMA_SQL);
}
