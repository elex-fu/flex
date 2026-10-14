/** Frozen schema6 from f74b1c2, captured before activating007–010. Legacy migration fixtures must not strip newer markers. */
export const FROZEN_V6_SCHEMA = String.raw`
CREATE TABLE access_audit_events (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  transport_kind TEXT,
  occurred_at TEXT NOT NULL,
  result_code TEXT NOT NULL
);
CREATE TABLE approval_reservations (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
        auth_subject_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        intent_id TEXT NOT NULL UNIQUE REFERENCES execution_intents(id),
        expected_version INTEGER NOT NULL,
        action TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'local_delivery', 'native_confirmation', 'outcome_unknown', 'aborted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (auth_subject_id, command_id) REFERENCES command_receipts(auth_subject_id, command_id) ON UPDATE CASCADE
      );
CREATE TABLE approvals (
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
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
, device_id TEXT REFERENCES devices(id));
CREATE TABLE command_receipts (
  auth_subject_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, target_session_id TEXT REFERENCES sessions(id), request_format_version INTEGER NOT NULL DEFAULT 1 CHECK (request_format_version IN (1, 2)), commit_id TEXT REFERENCES event_commits(id), source_sequence INTEGER,
  PRIMARY KEY (auth_subject_id, command_id)
);
CREATE TABLE content_pins (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('query', 'recovery', 'checkpoint', 'timeline', 'intent')),
  owner_id TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (ref_id, session_id) REFERENCES content_refs(id, session_id),
  UNIQUE (session_id, ref_id, owner_kind, owner_id)
);
CREATE TABLE content_refs (
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
CREATE TABLE content_segments (
  stream_id TEXT NOT NULL REFERENCES content_streams(id),
  source_sequence INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (stream_id, source_sequence, byte_start),
  CHECK (byte_start >= 0 AND byte_end > byte_start),
  CHECK (length(data) = byte_end - byte_start)
);
CREATE TABLE content_storage_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0)
);
CREATE TABLE content_streams (
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
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  display_name TEXT,
  platform TEXT NOT NULL,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('noise-static-key', 'browser-session')),
  public_key TEXT,
  credential_hash TEXT,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE TABLE event_commits (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        CHECK (first_sequence > 0 AND last_sequence >= first_sequence),
        UNIQUE (session_id, first_sequence),
        UNIQUE (session_id, last_sequence),
        UNIQUE (id, session_id)
      );
CREATE TABLE execution_intents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        turn_id TEXT REFERENCES turns(id),
        auth_subject_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('device', 'host')),
        kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dispatch_context_json TEXT,
        request_hash TEXT NOT NULL,
        request_format_version INTEGER NOT NULL DEFAULT 1 CHECK (request_format_version IN (1, 2)),
        source_sequence INTEGER NOT NULL,
        commit_id TEXT NOT NULL,
        runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
        attempt_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'dispatching', 'acknowledged', 'settled', 'outcome_unknown')),
        claim_owner_id TEXT,
        claim_owner_generation INTEGER,
        native_request_id TEXT,
        result_code TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (auth_subject_id, command_id, ordinal),
        FOREIGN KEY (auth_subject_id, command_id) REFERENCES command_receipts(auth_subject_id, command_id) ON UPDATE CASCADE,
        FOREIGN KEY (commit_id, session_id) REFERENCES event_commits(id, session_id),
        FOREIGN KEY (session_id, source_sequence) REFERENCES session_events(session_id, sequence),
        CHECK (state <> 'settled' OR result_code IS NOT NULL)
      );
CREATE TABLE host_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE managed_process_boundaries (
  process_id TEXT PRIMARY KEY REFERENCES managed_processes(id),
  proof_json TEXT NOT NULL,
  launch_digest TEXT NOT NULL
);
CREATE TABLE managed_process_identities (
  process_id TEXT PRIMARY KEY REFERENCES managed_processes(id),
  identity_json TEXT NOT NULL
);
CREATE TABLE managed_process_stop_proofs (
  process_id TEXT PRIMARY KEY REFERENCES managed_processes(id),
  proof_json TEXT NOT NULL
);
CREATE TABLE managed_processes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  pid INTEGER,
  process_group INTEGER,
  tree_control TEXT NOT NULL CHECK(tree_control IN ('process_group','unavailable')),
  state TEXT NOT NULL CHECK(state IN ('launching','running','root_exited','stopped','not_spawned','unknown')),
  error_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE native_turn_bindings (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), provider_instance_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL, native_turn_id TEXT, workspace_path TEXT NOT NULL,
        configuration_fingerprint TEXT NOT NULL, verified_version TEXT NOT NULL, context_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(turn_id,attempt_id)
      );
CREATE TABLE pairing_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  consumed_at TEXT
, host_id TEXT, requested_scopes TEXT, approved_at TEXT, device_id TEXT REFERENCES devices(id));
CREATE TABLE protocol_sessions (
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
CREATE TABLE recovery_evidence (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT, recovery_revision INTEGER NOT NULL, facts_fingerprint TEXT NOT NULL, evidence_json TEXT NOT NULL,
        observed_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
CREATE TABLE recovery_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        attempt_id TEXT, auth_subject_id TEXT NOT NULL, command_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('reconcile','acknowledge')), request_hash TEXT NOT NULL,
        evidence_id TEXT NOT NULL REFERENCES recovery_evidence(id),
        phase TEXT NOT NULL CHECK(phase IN ('marked','checking','completed','blocked','failed')),
        result_json TEXT, completed_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(auth_subject_id,command_id),
        FOREIGN KEY(auth_subject_id,command_id) REFERENCES command_receipts(auth_subject_id,command_id)
      );
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL, commit_id TEXT REFERENCES event_commits(id),
  UNIQUE (session_id, sequence)
);
CREATE TABLE sessions (
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
, revision INTEGER NOT NULL DEFAULT 0, active_turn_id TEXT REFERENCES turns(id), recovery_state TEXT NOT NULL DEFAULT 'idle' CHECK (recovery_state IN ('idle','blocked')), recovery_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE timeline_epochs (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  projector_version INTEGER NOT NULL CHECK (projector_version > 0),
  indexed_sequence INTEGER NOT NULL DEFAULT 0 CHECK (indexed_sequence >= 0),
  state TEXT NOT NULL CHECK (state IN ('building', 'active', 'retired')),
  PRIMARY KEY (session_id, epoch)
);
CREATE TABLE timeline_item_sources (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id, source_sequence),
  FOREIGN KEY (session_id, epoch, item_id, source_sequence)
    REFERENCES timeline_item_versions(session_id, epoch, item_id, revision) ON DELETE CASCADE
);
CREATE TABLE timeline_item_versions (
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
CREATE TABLE timeline_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_message', 'tool_call', 'approval', 'error', 'system')),
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  content_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, item_id)
);
CREATE TABLE turns (
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
, attempt_id TEXT, native_turn_id TEXT);
CREATE INDEX access_audit_by_time ON access_audit_events(occurred_at);
CREATE INDEX active_device_protocol_sessions
  ON protocol_sessions(device_id) WHERE disconnected_at IS NULL;
CREATE INDEX auth_sessions_device ON auth_sessions(device_id);
CREATE INDEX content_blob_hash ON content_refs(session_id, sha256, byte_length, format, required_scope, subject_id) WHERE kind = 'blob' AND state = 'ready';
CREATE INDEX content_pins_owner ON content_pins(owner_kind, owner_id);
CREATE UNIQUE INDEX content_prefix_sequence ON content_refs(stream_id, through_sequence, byte_length) WHERE kind = 'stream_prefix';
CREATE INDEX content_segments_offset ON content_segments(stream_id, byte_end);
CREATE INDEX content_streams_item ON content_streams(session_id, item_id);
CREATE UNIQUE INDEX device_host_public_key
  ON devices(host_id, public_key) WHERE public_key IS NOT NULL;
CREATE UNIQUE INDEX device_refresh_credential
  ON devices(credential_hash) WHERE credential_hash IS NOT NULL;
CREATE UNIQUE INDEX event_session_sequence ON session_events(session_id, sequence);
CREATE INDEX execution_intents_pending ON execution_intents(state, session_id, source_sequence, id);
CREATE INDEX execution_intents_turn ON execution_intents(session_id, turn_id, state);
CREATE INDEX managed_processes_owner ON managed_processes(owner_id, state);
CREATE UNIQUE INDEX one_active_timeline_epoch
  ON timeline_epochs(session_id) WHERE state = 'active';
CREATE UNIQUE INDEX one_active_turn_per_session ON turns(session_id)
      WHERE status IN ('queued','running','waiting_approval','interrupting');
CREATE UNIQUE INDEX one_pending_approval_per_tool
  ON approvals(turn_id, tool_use_id)
  WHERE status = 'pending';
CREATE INDEX recovery_evidence_target ON recovery_evidence(session_id,turn_id,observed_at);
CREATE INDEX recovery_operations_target ON recovery_operations(session_id,turn_id,phase);
CREATE INDEX timeline_versions_after
  ON timeline_item_versions(session_id, epoch, revision, item_id);
CREATE INDEX timeline_versions_display
  ON timeline_item_versions(session_id, epoch, display_sequence, item_id, revision);
CREATE INDEX turns_receipt_lookup ON turns(auth_subject_id, command_id);
INSERT INTO schema_migrations VALUES(1, 'frozen-v6');
INSERT INTO schema_migrations VALUES(2, 'frozen-v6');
INSERT INTO schema_migrations VALUES(3, 'frozen-v6');
INSERT INTO schema_migrations VALUES(4, 'frozen-v6');
INSERT INTO schema_migrations VALUES(5, 'frozen-v6');
INSERT INTO schema_migrations VALUES(6, 'frozen-v6');
`;
