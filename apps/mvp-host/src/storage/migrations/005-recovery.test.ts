import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../db.js";
import { applyRecoveryMigration, validateRecoverySchema } from "./005-recovery.js";

const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function store() { const value = new SqliteStore(); stores.push(value); return value; }
function remove005(value: SqliteStore) {
  value.db.exec(`DROP TABLE recovery_operations; DROP TABLE recovery_evidence; DROP TABLE native_turn_bindings;
    ALTER TABLE sessions DROP COLUMN active_turn_id; ALTER TABLE sessions DROP COLUMN recovery_state; ALTER TABLE sessions DROP COLUMN recovery_revision;
    DELETE FROM schema_migrations WHERE version = 5; DROP INDEX one_active_turn_per_session;
    CREATE UNIQUE INDEX one_active_turn_per_session ON turns(session_id) WHERE status IN ('queued','running','waiting_approval','interrupting','outcome_unknown');`);
}

describe("migration 005 explicit active relation", () => {
  it("conservatively binds legacy unknown as blocked without fabricating native/attempt evidence", () => {
    const value = store();
    const session = value.createSession("/fixture");
    value.createTurn({ sessionId: session.id, turnId: "legacy-unknown", commandId: "legacy-command", requestHash: "hash", prompt: "legacy", generation: 8 });
    value.commitEvent(session.id, "turn.unknown", {}, { turnId: "legacy-unknown", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    remove005(value);
    applyRecoveryMigration(value.db);
    expect(value.getSession(session.id)).toMatchObject({ activeTurnId: "legacy-unknown", recoveryState: "blocked", recoveryRevision: 1 });
    expect(value.getActiveTurn(session.id)?.id).toBe("legacy-unknown");
    expect(value.getTurn("legacy-unknown")?.attemptId).toBeUndefined();
    expect(value.db.prepare("SELECT COUNT(*) AS count FROM native_turn_bindings").get()).toEqual({ count: 0 });
    applyRecoveryMigration(value.db);
    expect(value.getSession(session.id)?.recoveryRevision).toBe(1);
    validateRecoverySchema(value.db);
  });
  it("rolls back ambiguous legacy active backfill instead of selecting the newest unknown row", () => {
    const value = store();
    const session = value.createSession("/fixture");
    remove005(value);
    value.db.exec("DROP INDEX one_active_turn_per_session");
    const insert = value.db.prepare("INSERT INTO turns(id,session_id,auth_subject_id,command_id,request_hash,status,prompt,generation,created_at) VALUES(?,?,'','legacy','hash','outcome_unknown','x',1,'2026-10-15')");
    insert.run("unknown-one", session.id); insert.run("unknown-two", session.id);
    expect(() => applyRecoveryMigration(value.db)).toThrow("LEGACY_ACTIVE_TURN_AMBIGUOUS");
    expect(value.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get()).toBeUndefined();
    expect((value.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).some((column) => column.name === "active_turn_id")).toBe(false);
  });
  it("validates declared migration shape rather than trusting a version marker", () => {
    const value = store();
    value.db.exec("DROP TABLE recovery_operations");
    expect(() => applyRecoveryMigration(value.db)).toThrow("SCHEMA_INVALID");
  });
});
