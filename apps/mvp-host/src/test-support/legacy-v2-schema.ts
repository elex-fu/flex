// Pinned baseline 63599da DDL with the v3 credential revision column omitted.
// This fixture never executes the current writer or removes a declared newer migration.
export const LEGACY_V2_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS host_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  display_name TEXT,
  platform TEXT NOT NULL,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('noise-static-key', 'browser-session')),
  public_key TEXT,
  credential_hash TEXT,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS device_host_public_key
  ON devices(host_id, public_key) WHERE public_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS device_refresh_credential
  ON devices(credential_hash) WHERE credential_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS protocol_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  protocol_version INTEGER NOT NULL,
  transport_kind TEXT NOT NULL,
  transport_generation INTEGER NOT NULL,
  capability_json TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  auth_session_id TEXT REFERENCES auth_sessions(id),
  disconnected_at TEXT,
  close_code TEXT
);

CREATE INDEX IF NOT EXISTS active_device_protocol_sessions
  ON protocol_sessions(device_id) WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS access_audit_events (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  transport_kind TEXT,
  occurred_at TEXT NOT NULL,
  result_code TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS access_audit_by_time ON access_audit_events(occurred_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  workspace_path TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  provider_session_id TEXT,
  baseline_head TEXT,
  baseline_dirty INTEGER,
  baseline_status_json TEXT,
  baseline_captured_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  activity_state TEXT NOT NULL CHECK (activity_state IN ('idle', 'running', 'waiting_approval', 'interrupting', 'outcome_unknown', 'runtime_unavailable')),
  head_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  auth_subject_id TEXT NOT NULL DEFAULT '',
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'completed', 'failed', 'cancelled', 'outcome_unknown')),
  prompt TEXT NOT NULL,
  provider_session_id TEXT,
  generation INTEGER NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn_per_session
  ON turns(session_id)
  WHERE status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'outcome_unknown');

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS timeline_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_message', 'tool_call', 'approval', 'error', 'system')),
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  content_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'superseded')),
  action TEXT,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_approval_per_tool
  ON approvals(turn_id, tool_use_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS command_receipts (
  auth_subject_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (auth_subject_id, command_id)
);

INSERT INTO schema_migrations(version,applied_at) VALUES(1,'legacy-fixture'),(2,'legacy-fixture');
`;
