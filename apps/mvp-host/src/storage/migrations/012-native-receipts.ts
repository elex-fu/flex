import type Database from "better-sqlite3";
import { validateTableContracts } from "./schema-constraints.js";

export const NATIVE_RECEIPTS_SCHEMA_VERSION = 12;

/**
 * Original native terminal receipts (design §8.2). One row per immutable
 * Turn attempt, written synchronously when the Provider's actual result
 * message arrives — before the business terminal commit — so a Host that
 * crashes between receipt and commit still leaves a trusted anchor for
 * read-only recovery transcript verification. The row is never rewritten:
 * first receipt wins and a second differing result for the same attempt is a
 * binding contradiction the recovery reader resolves as unknown.
 */
export const NATIVE_RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS native_terminal_receipts (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
  native_session_id TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  result_uuid TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  interrupt_acknowledged INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS native_terminal_receipts_turn ON native_terminal_receipts(session_id, turn_id);
`;

export function validateNativeReceiptsSchema(db: Database.Database): void {
  validateTableContracts(db, {
    native_terminal_receipts: { columns: ["session_id","turn_id","attempt_id","provider","native_session_id","context_digest","result_uuid","result_digest","interrupt_acknowledged","recorded_at"], primaryKey: ["session_id","turn_id","attempt_id"], nullable: [] },
  });
}

/** Metadata only; receipts are written by the Orchestrator under its writer ownership. */
export function applyNativeReceiptsMigration(db: Database.Database, at = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=12").get()) { validateNativeReceiptsSchema(db); return; }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=11").get()) throw new Error("NATIVE_RECEIPTS_MIGRATION_REQUIRES_011");
    db.exec(NATIVE_RECEIPTS_SCHEMA_SQL);
    validateNativeReceiptsSchema(db);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(12,?)").run(at);
  })();
}
