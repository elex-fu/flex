import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyCommandExecutionMigration, validateCommandExecutionSchema } from "./004-command-execution.js";

function legacy() {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (3, 'legacy');
    CREATE TABLE sessions(id TEXT PRIMARY KEY);
    CREATE TABLE turns(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), auth_subject_id TEXT NOT NULL DEFAULT '', command_id TEXT NOT NULL);
    CREATE TABLE command_receipts(auth_subject_id TEXT NOT NULL, command_id TEXT NOT NULL, method TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(auth_subject_id, command_id));
    CREATE TABLE session_events(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, UNIQUE(session_id,sequence));
    CREATE TABLE approvals(approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL);
    INSERT INTO sessions VALUES ('session-1'), ('session-2');
    INSERT INTO turns VALUES ('turn-1', 'session-1', 'device-1', 'start-1');
    INSERT INTO turns VALUES ('turn-ambiguous-a', 'session-1', '', 'ambiguous'), ('turn-ambiguous-b', 'session-2', '', 'ambiguous');
    INSERT INTO command_receipts VALUES ('device-1', 'start-1', 'session.startTurn', '{"turnId":"turn-1","status":"accepted"}');
    INSERT INTO command_receipts VALUES ('device-old', 'ambiguous', 'session.startTurn', '{"status":"accepted"}');
    INSERT INTO command_receipts VALUES ('device-1', 'interrupt-1', 'session.interrupt', '{"turnId":"turn-1","status":"accepted"}');
    INSERT INTO command_receipts VALUES ('device-1', 'access-1', 'access.revokeDevice', '{"status":"completed"}');
    INSERT INTO session_events VALUES ('legacy-event', 'session-1', 1);
  `);
  return db;
}

describe("migration 004", () => {
  it("preserves legacy evidence and binds only receipts with an unambiguous target", () => {
    const db = legacy();
    try {
      applyCommandExecutionMigration(db, "2026-10-14T00:00:00.000Z");
      validateCommandExecutionSchema(db);
      const receipts = db.prepare("SELECT command_id, target_session_id, request_format_version FROM command_receipts ORDER BY command_id").all();
      expect(receipts).toEqual([
        { command_id: "access-1", target_session_id: null, request_format_version: 1 },
        { command_id: "ambiguous", target_session_id: null, request_format_version: 1 },
        { command_id: "interrupt-1", target_session_id: "session-1", request_format_version: 1 },
        { command_id: "start-1", target_session_id: "session-1", request_format_version: 1 },
      ]);
      expect(db.prepare("SELECT * FROM execution_intents").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM event_commits").all()).toEqual([]);
      expect(db.prepare("SELECT commit_id FROM session_events").get()).toEqual({ commit_id: null });
      expect(db.prepare("SELECT attempt_id, native_turn_id FROM turns WHERE id = 'turn-1'").get()).toEqual({ attempt_id: null, native_turn_id: null });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'managed_processes'").get()).toBeDefined();
      applyCommandExecutionMigration(db);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4").get()).toEqual({ n: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  it("rolls back the complete migration when legacy data cannot be decoded", () => {
    const db = legacy();
    try {
      db.prepare("UPDATE command_receipts SET response_json = 'bad-json' WHERE method = 'session.interrupt'").run();
      expect(() => applyCommandExecutionMigration(db)).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'execution_intents'").get()).toBeUndefined();
      expect((db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["id"]);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });
    } finally { db.close(); }
  });

  it("refuses a declared 004 database that is missing its command structure", () => {
    const db = legacy();
    try {
      db.prepare("INSERT INTO schema_migrations VALUES (4, 'damaged')").run();
      expect(() => applyCommandExecutionMigration(db)).toThrow("SCHEMA_INVALID");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'execution_intents'").get()).toBeUndefined();
    } finally { db.close(); }
  });
});
