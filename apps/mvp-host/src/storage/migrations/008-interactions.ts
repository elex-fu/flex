import type Database from "better-sqlite3";
import { validateTableContracts } from "./schema-constraints.js";
export const INTERACTION_SCHEMA_VERSION = 8;
export const INTERACTION_SCHEMA = `
CREATE TABLE interactions (
 interaction_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id),
 turn_id TEXT NOT NULL REFERENCES turns(id),
 kind TEXT NOT NULL CHECK(kind IN ('approval','question')),
 attempt_id TEXT,
 runtime_id TEXT,
 runtime_generation INTEGER,
 native_request_id TEXT,
 native_method TEXT,
 dispatch_context_json TEXT,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
 status TEXT NOT NULL CHECK(status IN ('pending','responding','delivered','confirmed','expired','superseded','outcome_unknown')),
 delivery_state TEXT NOT NULL CHECK(delivery_state IN ('none','accepted','local_delivery','native_confirmation','unconfirmed','legacy')),
 evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('native_request','local_delivery','native_confirmation','legacy','unknown')),
 request_json TEXT NOT NULL,
 allowed_actions_json TEXT NOT NULL,
 reason_code TEXT,
 legacy_approval_id TEXT UNIQUE REFERENCES approvals(approval_id),
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(session_id,attempt_id,native_method,native_request_id)
);
CREATE INDEX interactions_session_status ON interactions(session_id,status,created_at,interaction_id);
CREATE INDEX interactions_runtime ON interactions(session_id,attempt_id,runtime_generation,status);
CREATE TABLE interaction_reservations (
 interaction_id TEXT PRIMARY KEY REFERENCES interactions(interaction_id),
 auth_subject_id TEXT NOT NULL,
 command_id TEXT NOT NULL,
 intent_id TEXT NOT NULL UNIQUE REFERENCES execution_intents(id),
 expected_version INTEGER NOT NULL,
 answer_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(auth_subject_id,command_id) REFERENCES command_receipts(auth_subject_id,command_id) ON UPDATE CASCADE
);
CREATE TABLE interaction_delivery_evidence (
 id TEXT PRIMARY KEY,
 interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id),
 kind TEXT NOT NULL CHECK(kind IN ('local-delivery','native-ack','not-dispatched','unknown','legacy')),
 source_id TEXT,
 evidence_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 CHECK(kind <> 'native-ack' OR source_id IS NOT NULL)
);
`;
export function validateInteractionSchema(db: Database.Database): void {
  const required: Record<string, string[]> = {
    interactions: ["interaction_id", "session_id", "turn_id", "kind", "attempt_id", "runtime_id", "runtime_generation", "native_request_id", "native_method", "dispatch_context_json", "version", "status", "delivery_state", "evidence_kind", "request_json", "allowed_actions_json", "reason_code", "legacy_approval_id", "expires_at", "created_at", "updated_at"],
    interaction_reservations: ["interaction_id", "auth_subject_id", "command_id", "intent_id", "expected_version", "answer_json", "created_at", "updated_at"],
    interaction_delivery_evidence: ["id", "interaction_id", "kind", "source_id", "evidence_json", "created_at"],
  };
  for (const [table, names] of Object.entries(required)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (names.some((name) => !columns.some((column) => column.name === name)))
      throw new Error(`SCHEMA_INVALID: migration 008 table ${table}`);
  }
  validateTableContracts(db, {
    interactions: { columns: required.interactions!, primaryKey: ["interaction_id"], nullable: ["attempt_id","runtime_id","runtime_generation","native_request_id","native_method","dispatch_context_json","reason_code","legacy_approval_id"], unique: [["legacy_approval_id"],["session_id","attempt_id","native_method","native_request_id"]], constraints: ["CHECK(kind IN ('approval','question'))", "CHECK(version >= 0)", "CHECK(status IN ('pending','responding','delivered','confirmed','expired','superseded','outcome_unknown'))", "CHECK(delivery_state IN ('none','accepted','local_delivery','native_confirmation','unconfirmed','legacy'))", "CHECK(evidence_kind IN ('native_request','local_delivery','native_confirmation','legacy','unknown'))"], foreignKeys: [{ columns: ["session_id"], parent: "sessions", target: ["id"] }, { columns: ["turn_id"], parent: "turns", target: ["id"] }, { columns: ["legacy_approval_id"], parent: "approvals", target: ["approval_id"] }] },
    interaction_reservations: { columns: required.interaction_reservations!, primaryKey: ["interaction_id"], unique: [["intent_id"]], foreignKeys: [{ columns: ["interaction_id"], parent: "interactions", target: ["interaction_id"] }, { columns: ["intent_id"], parent: "execution_intents", target: ["id"] }, { columns: ["auth_subject_id","command_id"], parent: "command_receipts", target: ["auth_subject_id","command_id"], onUpdate: "CASCADE" }] },
    interaction_delivery_evidence: { columns: required.interaction_delivery_evidence!, primaryKey: ["id"], nullable: ["source_id"], constraints: ["CHECK(kind IN ('local-delivery','native-ack','not-dispatched','unknown','legacy'))", "CHECK(kind <> 'native-ack' OR source_id IS NOT NULL)"], foreignKeys: [{ columns: ["interaction_id"], parent: "interactions", target: ["interaction_id"] }] },
  });
}
/** Legacy local resolution stays legacy evidence; no native ACK or new delivery intent is invented. */
export function applyInteractionMigration(db: Database.Database, occurredAt = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get()) {
      validateInteractionSchema(db);
      return;
    }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get()) throw new Error("INTERACTION_MIGRATION_REQUIRES_007");
    db.exec(INTERACTION_SCHEMA);
    const approvals = db.prepare("SELECT * FROM approvals ORDER BY created_at, approval_id").all() as Array<{
      approval_id: string;
      session_id: string;
      turn_id: string;
      version: number;
      status: string;
      request_json: string;
      created_at: string;
    }>;
    for (const approval of approvals) {
      const request = JSON.parse(approval.request_json) as Record<string, unknown>;
      const status = approval.status === "pending" ? "pending" : approval.status === "superseded" ? "superseded" : "delivered";
      const title = typeof request.title === "string" ? request.title.slice(0, 512) : undefined;
      const toolName = typeof request.toolName === "string" ? request.toolName.slice(0, 128) || "Legacy tool" : "Legacy tool";
      const legacyRequest = { toolName, ...(title ? { title } : {}) };
      db.prepare(`INSERT INTO interactions(interaction_id,session_id,turn_id,kind,version,status,delivery_state,evidence_kind,request_json,allowed_actions_json,legacy_approval_id,expires_at,created_at,updated_at)
    VALUES(?,?,?,'approval',?,?, 'legacy','legacy',?,?,?, ?,?,?)`).run(approval.approval_id, approval.session_id, approval.turn_id, approval.version, status, JSON.stringify(legacyRequest), JSON.stringify(["allow_once", "deny"]), approval.approval_id, new Date(Date.parse(approval.created_at) + 10 * 60 * 1000).toISOString(), approval.created_at, occurredAt);
      const reservation = db.prepare("SELECT * FROM approval_reservations WHERE approval_id=?").get(approval.approval_id) as {
        auth_subject_id: string;
        command_id: string;
        intent_id: string;
        expected_version: number;
        action: string;
        state: string;
        created_at: string;
        updated_at: string;
      } | undefined;
      if (reservation) {
        const reservedStatus = reservation.state === "accepted" ? "responding" : reservation.state === "outcome_unknown" ? "outcome_unknown"
          : reservation.state === "aborted" ? "superseded" : "delivered";
        db.prepare("UPDATE interactions SET status=?,version=MAX(version,?),delivery_state='legacy',evidence_kind='legacy' WHERE interaction_id=?")
          .run(reservedStatus, reservation.expected_version + 1, approval.approval_id);
        db.prepare(`INSERT INTO interaction_reservations(interaction_id,auth_subject_id,command_id,intent_id,expected_version,answer_json,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)`).run(approval.approval_id, reservation.auth_subject_id, reservation.command_id, reservation.intent_id, reservation.expected_version, JSON.stringify({ action: reservation.action }), reservation.created_at, reservation.updated_at);
      }
      db.prepare("INSERT INTO interaction_delivery_evidence(id,interaction_id,kind,evidence_json,created_at) VALUES(?,?,'legacy',?,?)")
        .run(`legacy:${approval.approval_id}`, approval.approval_id, JSON.stringify({
        originalStatus: approval.status,
        ...(reservation ? { originalDeliveryState: reservation.state } : {}), nativeConfirmation: false
      }), occurredAt);
    }
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(8,?)").run(occurredAt);
    validateInteractionSchema(db);
  })();
}
