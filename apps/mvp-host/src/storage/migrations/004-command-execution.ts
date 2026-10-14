import type Database from "better-sqlite3";
import { MANAGED_PROCESS_SCHEMA } from "./004-managed-process-schema.js";

export const COMMAND_EXECUTION_SCHEMA_VERSION = 4;
export const COMMAND_EXECUTION_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  sessions: ["revision"],
  turns: ["attempt_id", "native_turn_id"],
  command_receipts: ["target_session_id", "request_format_version", "commit_id", "source_sequence"],
  session_events: ["commit_id"],
  event_commits: ["id", "session_id", "first_sequence", "last_sequence"],
  execution_intents: ["id", "session_id", "turn_id", "auth_subject_id", "command_id", "ordinal", "actor_kind", "kind", "resource_id", "payload_json", "request_hash", "request_format_version", "source_sequence", "commit_id", "runtime_generation", "attempt_id", "state", "claim_owner_id", "claim_owner_generation", "native_request_id", "result_code", "result_json", "created_at", "updated_at"],
  managed_processes: ["id", "owner_id", "owner_generation", "runtime_id", "runtime_generation", "attempt_id", "session_id", "turn_id", "pid", "process_group", "tree_control", "state", "error_code", "updated_at"],
  approval_reservations: ["approval_id", "auth_subject_id", "command_id", "intent_id", "expected_version", "action", "state", "created_at", "updated_at"],
};

export function validateCommandExecutionSchema(db: Database.Database): void {
  for (const [table, expected] of Object.entries(COMMAND_EXECUTION_REQUIRED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (expected.some((name) => !columns.some((column) => column.name === name))) {
      throw new Error(`SCHEMA_INVALID: migration 004 table ${table}`);
    }
  }
}

/** Called only by the owned writer's migration transaction. No native side effects. */
export function applyCommandExecutionMigration(db: Database.Database, appliedAt = new Date().toISOString()): void {
  db.transaction(() => {
    const declared = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    if (declared) { validateCommandExecutionSchema(db); return; }
    db.exec(`
      ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE turns ADD COLUMN attempt_id TEXT;
      ALTER TABLE turns ADD COLUMN native_turn_id TEXT;
      ALTER TABLE command_receipts ADD COLUMN target_session_id TEXT REFERENCES sessions(id);
      ALTER TABLE command_receipts ADD COLUMN request_format_version INTEGER NOT NULL DEFAULT 1 CHECK (request_format_version IN (1, 2));
      ALTER TABLE command_receipts ADD COLUMN commit_id TEXT REFERENCES event_commits(id);
      ALTER TABLE command_receipts ADD COLUMN source_sequence INTEGER;
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
      ALTER TABLE session_events ADD COLUMN commit_id TEXT REFERENCES event_commits(id);
      CREATE UNIQUE INDEX event_session_sequence ON session_events(session_id, sequence);
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
      CREATE INDEX execution_intents_pending ON execution_intents(state, session_id, source_sequence, id);
      CREATE INDEX execution_intents_turn ON execution_intents(session_id, turn_id, state);
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
    `);
    db.exec(MANAGED_PROCESS_SCHEMA);
    // Bind only unambiguous legacy facts; do not manufacture dispatch intents,
    // attempt IDs, native ACKs, or atomic event boundaries for old accepted rows.
    const receipts = db.prepare("SELECT auth_subject_id, command_id, method, response_json FROM command_receipts").all() as Array<{ auth_subject_id: string; command_id: string; method: string; response_json: string }>;
    for (const receipt of receipts) {
      let target: string | undefined;
      if (receipt.method === "session.startTurn") {
        const rows = db.prepare("SELECT DISTINCT session_id FROM turns WHERE command_id = ? AND (auth_subject_id = ? OR auth_subject_id = '')").all(receipt.command_id, receipt.auth_subject_id) as Array<{ session_id: string }>;
        if (rows.length === 1) target = rows[0]!.session_id;
      } else if (receipt.method === "session.interrupt" || receipt.method === "approval.respond") {
        const response = JSON.parse(receipt.response_json) as { turnId?: unknown; approvalId?: unknown } | null;
        if (typeof response?.turnId === "string") target = (db.prepare("SELECT session_id FROM turns WHERE id = ?").get(response.turnId) as { session_id: string } | undefined)?.session_id;
        else if (typeof response?.approvalId === "string") target = (db.prepare("SELECT session_id FROM approvals WHERE approval_id = ?").get(response.approvalId) as { session_id: string } | undefined)?.session_id;
      }
      if (target) db.prepare("UPDATE command_receipts SET target_session_id = ? WHERE auth_subject_id = ? AND command_id = ?").run(target, receipt.auth_subject_id, receipt.command_id);
    }
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(appliedAt);
    validateCommandExecutionSchema(db);
  })();
}
