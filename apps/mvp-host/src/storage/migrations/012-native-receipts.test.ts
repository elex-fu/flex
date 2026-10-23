import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_V10_SCHEMA } from "../../test-support/frozen-v10-schema.js";
import { NativeTerminalReceiptError, NativeTerminalReceiptStore, type NativeTerminalReceipt } from "../native-receipt-store.js";
import { applyExecutionActivationMigration } from "./011-execution-activation.js";
import { applyNativeReceiptsMigration } from "./012-native-receipts.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "./schema-version.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flyx-native-receipts-")); roots.push(root);
  const data = join(root, "data"); mkdirSync(data, { mode: 0o700 });
  return join(data, "host.sqlite");
}
const timestamp = "2026-10-24T00:00:00.000Z";
const hex = (value: string) => value.repeat(64);

function seedV11(path: string): Database.Database {
  const db = new Database(path);
  db.exec(FROZEN_V10_SCHEMA);
  applyExecutionActivationMigration(db, timestamp);
  expect(inspectSchema(db).version).toBe(11);
  return db;
}

describe("native receipts migration 012", () => {
  it("upgrades a pinned v11 file to the current schema with the receipts table", () => {
    const path = fixture();
    const db = seedV11(path);
    try {
      applyNativeReceiptsMigration(db, timestamp);
      expect(inspectSchema(db).version).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(SUPPORTED_SCHEMA_VERSION).toBe(12);
      expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual(Array.from({ length: SUPPORTED_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
      expect(db.prepare("SELECT applied_at FROM schema_migrations WHERE version=12").get()).toEqual({ applied_at: timestamp });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // Idempotent re-run validates instead of rewriting.
      applyNativeReceiptsMigration(db, "2026-10-24T01:00:00.000Z");
      expect(db.prepare("SELECT applied_at FROM schema_migrations WHERE version=12").get()).toEqual({ applied_at: timestamp });
    } finally { db.close(); }
  });

  it("refuses to install without the ordered v11 marker", () => {
    const path = fixture();
    const db = new Database(path);
    try {
      db.exec(FROZEN_V10_SCHEMA);
      expect(() => applyNativeReceiptsMigration(db, timestamp)).toThrow("NATIVE_RECEIPTS_MIGRATION_REQUIRES_011");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='native_terminal_receipts'").get()).toBeUndefined();
    } finally { db.close(); }
  });

  it("rejects provider values outside the claude/codex contract", () => {
    const path = fixture();
    const db = seedV11(path);
    try {
      applyNativeReceiptsMigration(db, timestamp);
      expect(() => db.prepare(`INSERT INTO native_terminal_receipts
        (session_id,turn_id,attempt_id,provider,native_session_id,context_digest,result_uuid,result_digest,interrupt_acknowledged,recorded_at)
        VALUES('s','t','a','gemini','n',?,'u',?,0,?)`).run(hex("c"), hex("r"), timestamp)).toThrow(/CHECK/);
    } finally { db.close(); }
  });
});

describe("native terminal receipt store", () => {
  function store(): { db: Database.Database; receipts: NativeTerminalReceiptStore } {
    const path = fixture();
    const db = seedV11(path);
    applyNativeReceiptsMigration(db, timestamp);
    return { db, receipts: new NativeTerminalReceiptStore(db) };
  }
  const receipt = (overrides?: Partial<NativeTerminalReceipt>): NativeTerminalReceipt => ({
    sessionId: "session-1", turnId: "turn-1", attemptId: "attempt-1", provider: "claude",
    nativeSessionId: "native-1", contextDigest: hex("c"), resultUuid: "result-uuid", resultDigest: hex("d"),
    ...overrides,
  });

  it("round-trips a valid receipt with the immutable attempt key", () => {
    const { db, receipts } = store();
    try {
      receipts.record(receipt(), timestamp);
      expect(receipts.find("session-1", "turn-1", "attempt-1")).toEqual(receipt());
      expect(receipts.find("session-1", "turn-1", "attempt-2")).toBeUndefined();
      expect(db.prepare("SELECT recorded_at,interrupt_acknowledged FROM native_terminal_receipts").get())
        .toEqual({ recorded_at: timestamp, interrupt_acknowledged: 0 });
    } finally { db.close(); }
  });

  it("keeps the interrupt acknowledgement flag and validates it on read", () => {
    const { db, receipts } = store();
    try {
      receipts.record(receipt({ interruptAcknowledged: true }), timestamp);
      expect(receipts.find("session-1", "turn-1", "attempt-1")?.interruptAcknowledged).toBe(true);
    } finally { db.close(); }
  });

  it("first receipt per immutable attempt wins; a differing later result never overwrites", () => {
    const { db, receipts } = store();
    try {
      receipts.record(receipt(), timestamp);
      receipts.record(receipt({ resultUuid: "later-uuid", resultDigest: hex("9") }), "2026-10-24T02:00:00.000Z");
      expect(receipts.find("session-1", "turn-1", "attempt-1")).toEqual(receipt());
      // A new attempt for the same turn records independently.
      receipts.record(receipt({ attemptId: "attempt-2", resultUuid: "second-attempt" }));
      expect(receipts.find("session-1", "turn-1", "attempt-2")?.resultUuid).toBe("second-attempt");
    } finally { db.close(); }
  });

  it("refuses malformed receipts without writing", () => {
    const { db, receipts } = store();
    try {
      for (const invalid of [receipt({ provider: "gemini" as "claude" }), receipt({ sessionId: "" }),
        receipt({ resultUuid: "x".repeat(257) }), receipt({ contextDigest: "not-hex" }), receipt({ resultDigest: "" })]) {
        expect(() => receipts.record(invalid, timestamp)).toThrow(NativeTerminalReceiptError);
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM native_terminal_receipts").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("returns undefined instead of trusting a corrupted row", () => {
    const { db, receipts } = store();
    try {
      receipts.record(receipt(), timestamp);
      db.prepare("UPDATE native_terminal_receipts SET result_digest='corrupted'").run();
      expect(receipts.find("session-1", "turn-1", "attempt-1")).toBeUndefined();
    } finally { db.close(); }
  });
});
