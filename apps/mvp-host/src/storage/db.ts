import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HostOwnerLock, assertHostOwner, canonicalPath, createTestHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { inspectSchema, StoreSchemaError, validateV3Schema } from "./migrations/schema-version.js";
import type { ProviderId, RpcError, Session, SessionEvent, TimelineItem, Turn } from "@flyx/mvp-protocol";

export type SessionRow = Session & {
  workspacePath: string;
  baselineHead?: string;
  baselineDirty?: boolean;
  baselineStatus?: unknown;
  baselineCapturedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TurnRow = Turn & {
  /**
   * The subject which submitted the startTurn command.  It is deliberately
   * kept in the host database (and never exposed by the public snapshot) so
   * recovery can update exactly the matching command receipt.  A nullable
   * value is used for legacy rows created before this column was introduced.
   */
  authSubjectId?: string;
  providerSessionId?: string;
  requestHash: string;
  generation: number;
  createdAt: string;
};

export type ApprovalStatus = "pending" | "resolved" | "superseded";

export type ApprovalRow = {
  approvalId: string;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  version: number;
  status: ApprovalStatus;
  action?: string;
  request: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
};

export type CommandReceiptState =
  | "accepted"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export type CommandReceiptRow = {
  authSubjectId: string;
  commandId: string;
  method: string;
  requestHash: string;
  state: CommandReceiptState;
  response: unknown;
  createdAt: string;
  updatedAt: string;
};

export type TimelineUpsert = {
  itemId: string;
  kind: TimelineItem["kind"];
  status: string;
  content: unknown;
  revision?: number;
};

export type EventCommitOptions = {
  timeline?: TimelineUpsert;
  activityState?: Session["activityState"];
  turnId?: string;
  turnStatus?: Turn["status"];
  providerSessionId?: string;
  approval?: ApprovalRow;
  /**
   * Update the existing command receipt in the same transaction as the event
   * and projection.  This prevents a terminal event from being visible while
   * its command still appears to be accepted after a crash.
   */
  commandReceipt?: CommandReceiptUpdate | undefined;
  /** Same invariant when one domain transition settles multiple commands. */
  commandReceipts?: CommandReceiptUpdate[];
};

export type CommandReceiptUpdate = {
  authSubjectId: string;
  commandId: string;
  state: CommandReceiptState;
  response: unknown;
  /** Refuse to update a receipt belonging to a different request. */
  requestHash?: string;
  /** Missing receipts are corruption for normal terminal events. */
  required?: boolean;
};

export type AcceptedTurn = {
  turn: TurnRow;
  receipt: CommandReceiptRow;
  events: SessionEvent[];
};

export type ApprovalResolutionCommit = {
  approval: ApprovalRow;
  event: SessionEvent;
  receipt?: CommandReceiptRow;
};

export type Snapshot = {
  session: SessionRow;
  activeTurn?: TurnRow;
  pendingApprovals: ApprovalRow[];
};

export type HostIdentityMirror = { hostId: string; fingerprint: string };

export type DeviceRecord = {
  id: string;
  hostId: string;
  displayName?: string;
  platform: string;
  credentialKind: "noise-static-key" | "browser-session";
  publicKey?: string;
  scopes: string[];
  /** Monotonic fence for refresh credentials and tickets derived from them. */
  credentialRevision: number;
  createdAt: string;
  lastSeenAt?: string;
  expiresAt?: string;
  revokedAt?: string;
};

export type AuthSessionRecord = {
  id: string;
  expiresAt: string;
  deviceId?: string;
  revokedAt?: string;
};

export type PairingGrantRecord = {
  id: string;
  hostId?: string;
  requestedScopes?: string[];
  expiresAt: string;
  approvedAt?: string;
  consumedAt?: string;
  deviceId?: string;
};

export type ProtocolSessionRecord = {
  id: string;
  deviceId: string;
  protocolVersion: number;
  transportKind: string;
  transportGeneration: number;
  capabilities: string[];
  connectedAt: string;
  expiresAt: string;
  authSessionId?: string;
  disconnectedAt?: string;
  closeCode?: string;
};

export type AccessAuditEvent = {
  id: string;
  deviceId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  transportKind?: string;
  occurredAt: string;
  resultCode: string;
};

const SCHEMA = `
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
  credential_revision INTEGER NOT NULL DEFAULT 0,
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
`;

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SqliteStoreOptions = {
  mode?: "owned" | "readonly" | "maintenance" | "management" | "test-fixture";
  owner?: HostOwnerHandle;
};

export class SqliteStore {
  readonly db: Database.Database;
  readonly mode: NonNullable<SqliteStoreOptions["mode"]>;
  private readonly ownerHandle: HostOwnerHandle | undefined;
  private readonly releaseOwnerOnClose: boolean;

  constructor(filePath = ":memory:", options: SqliteStoreOptions = {}) {
    // Preserve legacy file-backed unit fixtures which intentionally open two
    // raw stores to exercise SQLite CAS. Every file-backed Orchestrator still
    // supplies a real owner, including under Vitest.
    this.mode = options.mode ?? (filePath !== ":memory:" && process.env.NODE_ENV === "test" ? "test-fixture" : "owned");
    if (this.mode === "test-fixture" && process.env.NODE_ENV !== "test") throw new Error("Raw file-backed fixtures are only allowed under NODE_ENV=test");
    const isWriter = this.mode === "owned" || this.mode === "maintenance";
    this.ownerHandle = isWriter ? options.owner ?? (filePath === ":memory:" ? createTestHostOwner() : HostOwnerLock.acquire({ databasePath: filePath, mode: this.mode === "maintenance" ? "maintenance" : "host" })) : undefined;
    this.releaseOwnerOnClose = isWriter && !options.owner;
    try {
      if (this.ownerHandle) {
        assertHostOwner(this.ownerHandle);
        this.ownerHandle.assertStorePath(filePath);
        if (this.mode === "maintenance" && this.ownerHandle.mode !== "maintenance") throw new Error("Offline maintenance owner required");
      }
      const connectionPath = this.ownerHandle?.databasePath ?? (filePath === ":memory:" ? filePath : canonicalPath(filePath));
      this.db = new Database(connectionPath, { readonly: this.mode === "readonly", fileMustExist: this.mode === "readonly" || this.mode === "management", timeout: this.mode === "management" ? 1_000 : 5_000 });
      try {
        this.ownerHandle?.assertStorePath(connectionPath);
        const schema = inspectSchema(this.db);
        if (this.mode === "readonly" || this.mode === "management") {
          if (this.mode === "management" && schema.version < 3) throw new StoreSchemaError("SCHEMA_INVALID", "Local revocation requires the current schema; migrate the offline Host first.");
          return;
        }
        this.ownerHandle?.assertActive();
        // journal_mode cannot change within a transaction. The version gate
        // above runs before this or any other writable SQLite operation.
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = FULL");
        this.db.pragma("foreign_keys = ON");
        this.db.transaction(() => {
          this.db.exec(SCHEMA);
          this.migrateSchema();
          validateV3Schema(this.db);
        })();
      } catch (error) {
        this.db.close();
        throw error;
      }
    } catch (error) {
      if (this.releaseOwnerOnClose) this.ownerHandle?.release();
      throw error;
    }
  }

  /** Business write admission; management connection only permits its local revocation path. */
  assertWriterOwner(): void {
    if (this.mode === "readonly" || this.mode === "management") throw new Error("HOST_OWNER_REQUIRED");
    this.ownerHandle?.assertActive();
  }

  close(): void {
    if (this.db.open) this.db.close();
    if (this.releaseOwnerOnClose) this.ownerHandle?.release();
  }

  /**
   * Keep the MVP database forward compatible with stores created before the
   * turn -> command receipt ownership link was added.  SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, therefore inspect the table first.  Legacy
   * rows get an empty subject and are handled conservatively by recovery.
   */
  private migrateSchema(): void {
    // Baseline and all compatible SQL-only migrations share the writer's
    // transaction. No version marker can survive a failed migration.
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(now());
    const columns = this.db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "auth_subject_id")) {
      this.db.exec("ALTER TABLE turns ADD COLUMN auth_subject_id TEXT NOT NULL DEFAULT ''");
    }
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "baseline_head")) this.db.exec("ALTER TABLE sessions ADD COLUMN baseline_head TEXT");
    if (!sessionColumns.some((column) => column.name === "baseline_dirty")) this.db.exec("ALTER TABLE sessions ADD COLUMN baseline_dirty INTEGER");
    if (!sessionColumns.some((column) => column.name === "baseline_status_json")) this.db.exec("ALTER TABLE sessions ADD COLUMN baseline_status_json TEXT");
    if (!sessionColumns.some((column) => column.name === "baseline_captured_at")) this.db.exec("ALTER TABLE sessions ADD COLUMN baseline_captured_at TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS turns_receipt_lookup ON turns(auth_subject_id, command_id)");
    const authColumns = this.db.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>;
    if (!authColumns.some((column) => column.name === "device_id")) this.db.exec("ALTER TABLE auth_sessions ADD COLUMN device_id TEXT REFERENCES devices(id)");
    const deviceColumns = this.db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    if (!deviceColumns.some((column) => column.name === "credential_revision")) {
      this.db.exec("ALTER TABLE devices ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0");
    }
    const grantColumns = this.db.prepare("PRAGMA table_info(pairing_grants)").all() as Array<{ name: string }>;
    const grantAdditions = [
      ["host_id", "TEXT"],
      ["requested_scopes", "TEXT"],
      ["approved_at", "TEXT"],
      ["device_id", "TEXT REFERENCES devices(id)"],
    ] as const;
    for (const [name, type] of grantAdditions) {
      if (!grantColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE pairing_grants ADD COLUMN ${name} ${type}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS auth_sessions_device ON auth_sessions(device_id)");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(now());
  }

  private upsertTimelineInternal(sessionId: string, input: TimelineUpsert, updatedAt: string): void {
    const revision = input.revision ?? ((this.db.prepare(`
      SELECT revision FROM timeline_items WHERE session_id = ? AND item_id = ?
    `).get(sessionId, input.itemId) as { revision: number } | undefined)?.revision ?? -1) + 1;
    this.db.prepare(`
      INSERT INTO timeline_items (session_id, item_id, kind, status, revision, content_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, item_id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        revision = excluded.revision,
        content_json = excluded.content_json,
        updated_at = excluded.updated_at
      WHERE excluded.revision >= timeline_items.revision
    `).run(sessionId, input.itemId, input.kind, input.status, revision, json(input.content), updatedAt);
  }

  private insertApprovalInternal(approval: ApprovalRow): void {
    this.db.prepare(`
      INSERT INTO approvals (approval_id, session_id, turn_id, tool_use_id, version, status, action, request_json, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO NOTHING
    `).run(
      approval.approvalId,
      approval.sessionId,
      approval.turnId,
      approval.toolUseId,
      approval.version,
      approval.status,
      approval.action ?? null,
      json(approval.request),
      approval.createdAt,
      approval.resolvedAt ?? null,
    );
  }

  createSession(workspacePath: string, provider: ProviderId = "claude", id = randomUUID()): SessionRow {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO sessions (id, workspace_id, workspace_path, provider, status, activity_state, head_sequence, created_at, updated_at)
      VALUES (?, 'default', ?, ?, 'active', 'idle', 0, ?, ?)
    `).run(id, workspacePath, provider, timestamp, timestamp);
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as RawSession | undefined;
    return row ? toSession(row) : undefined;
  }

  getCurrentSession(): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() as RawSession | undefined;
    return row ? toSession(row) : undefined;
  }

  setSessionBaseline(sessionId: string, baseline: { head?: string; dirty: boolean; files: unknown }): void {
    this.db.prepare(`
      UPDATE sessions SET baseline_head = ?, baseline_dirty = ?, baseline_status_json = ?, baseline_captured_at = ?, updated_at = ?
      WHERE id = ?
    `).run(baseline.head ?? null, baseline.dirty ? 1 : 0, json(baseline.files), now(), now(), sessionId);
  }

  getSessionBaseline(sessionId: string): { head?: string; dirty: boolean; files: unknown; capturedAt?: string } | undefined {
    const row = this.db.prepare(`
      SELECT baseline_head, baseline_dirty, baseline_status_json, baseline_captured_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as { baseline_head: string | null; baseline_dirty: number | null; baseline_status_json: string | null; baseline_captured_at: string | null } | undefined;
    if (!row || row.baseline_status_json === null) return undefined;
    return {
      ...(row.baseline_head ? { head: row.baseline_head } : {}),
      dirty: row.baseline_dirty === 1,
      files: parse(row.baseline_status_json),
      ...(row.baseline_captured_at ? { capturedAt: row.baseline_captured_at } : {}),
    };
  }

  getSnapshot(sessionId: string): Snapshot | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const turn = this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'outcome_unknown')
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as RawTurn | undefined;
    const approvals = this.db.prepare(`
      SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC
    `).all(sessionId) as RawApproval[];
    return {
      session,
      ...(turn ? { activeTurn: toTurn(turn) } : {}),
      pendingApprovals: approvals.map(toApproval),
    };
  }

  getTurn(turnId: string): TurnRow | undefined {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as RawTurn | undefined;
    return row ? toTurn(row) : undefined;
  }

  getActiveTurn(sessionId: string): TurnRow | undefined {
    const row = this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'outcome_unknown')
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as RawTurn | undefined;
    return row ? toTurn(row) : undefined;
  }

  createTurn(input: {
    sessionId: string;
    turnId: string;
    authSubjectId?: string;
    commandId: string;
    requestHash: string;
    prompt: string;
    generation: number;
  }): TurnRow {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO turns (id, session_id, auth_subject_id, command_id, request_hash, status, prompt, generation, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(input.turnId, input.sessionId, input.authSubjectId ?? "", input.commandId, input.requestHash, input.prompt, input.generation, timestamp);
    return this.getTurn(input.turnId)!;
  }

  acceptTurn(input: {
    authSubjectId: string;
    sessionId: string;
    turnId: string;
    commandId: string;
    requestHash: string;
    prompt: string;
    generation: number;
  }): AcceptedTurn {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const session = this.db.prepare("SELECT id, head_sequence FROM sessions WHERE id = ?")
        .get(input.sessionId) as { id: string; head_sequence: number } | undefined;
      if (!session) throw new Error("SESSION_NOT_FOUND");
      const active = this.db.prepare(`
        SELECT id FROM turns WHERE session_id = ?
          AND status IN ('queued', 'running', 'waiting_approval', 'interrupting', 'outcome_unknown') LIMIT 1
      `).get(input.sessionId) as { id: string } | undefined;
      if (active) throw new Error("TURN_BUSY");
      this.db.prepare(`
        INSERT INTO turns (id, session_id, auth_subject_id, command_id, request_hash, status, prompt, generation, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(input.turnId, input.sessionId, input.authSubjectId, input.commandId, input.requestHash, input.prompt, input.generation, timestamp);

      const first = this.appendEventInternal(input.sessionId, "user.message.created", {
        turnId: input.turnId,
        itemId: `user-${input.turnId}`,
        text: input.prompt,
      }, timestamp);
      this.upsertTimelineInternal(input.sessionId, {
        itemId: `user-${input.turnId}`,
        kind: "user_message",
        status: "completed",
        content: { turnId: input.turnId, text: input.prompt },
      }, timestamp);
      const second = this.appendEventInternal(input.sessionId, "turn.requested", {
        turnId: input.turnId,
        commandId: input.commandId,
      }, timestamp);
      const response = { turnId: input.turnId, status: "accepted" };
      this.db.prepare(`
        INSERT INTO command_receipts (auth_subject_id, command_id, method, request_hash, state, response_json, created_at, updated_at)
        VALUES (?, ?, 'session.startTurn', ?, 'accepted', ?, ?, ?)
      `).run(input.authSubjectId, input.commandId, input.requestHash, json(response), timestamp, timestamp);
      this.db.prepare("UPDATE sessions SET activity_state = 'running', updated_at = ? WHERE id = ?")
        .run(timestamp, input.sessionId);
      return {
        turn: this.getTurn(input.turnId)!,
        receipt: this.getCommandReceipt(input.authSubjectId, input.commandId)!,
        events: [first, second],
      } satisfies AcceptedTurn;
    });
    return transaction() as AcceptedTurn;
  }

  commitEvent(sessionId: string, type: string, payload: unknown, options: EventCommitOptions = {}): SessionEvent {
    const occurredAt = now();
    const transaction = this.db.transaction(() => {
      return this.appendEventWithProjectionInternal(sessionId, type, payload, options, occurredAt);
    });
    return transaction() as SessionEvent;
  }

  /**
   * Append an event and update every requested projection while already
   * inside the caller's SQLite transaction.  Approval resolution, terminal
   * state and command receipt code all use this helper so a crash cannot
   * expose only part of one state transition.
   */
  private appendEventWithProjectionInternal(
    sessionId: string,
    type: string,
    payload: unknown,
    options: EventCommitOptions,
    occurredAt: string,
  ): SessionEvent {
    const row = this.db.prepare("SELECT head_sequence FROM sessions WHERE id = ?")
      .get(sessionId) as { head_sequence: number } | undefined;
    if (!row) throw new Error("SESSION_NOT_FOUND");
    const sequence = row.head_sequence + 1;
    const eventId = randomUUID();
    this.db.prepare(`
      INSERT INTO session_events (id, session_id, sequence, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, sessionId, sequence, type, json(payload), occurredAt);
    if (options.timeline) this.upsertTimelineInternal(sessionId, options.timeline, occurredAt);
    if (options.providerSessionId) {
      this.db.prepare("UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?")
        .run(options.providerSessionId, occurredAt, sessionId);
    }
    if (options.activityState) {
      this.db.prepare("UPDATE sessions SET activity_state = ?, updated_at = ? WHERE id = ?")
        .run(options.activityState, occurredAt, sessionId);
    }
    if (options.turnId && options.turnStatus) {
      const finished = ["completed", "failed", "cancelled", "outcome_unknown"].includes(options.turnStatus)
        ? occurredAt
        : null;
      this.db.prepare(`
        UPDATE turns SET status = ?,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          finished_at = COALESCE(?, finished_at), provider_session_id = COALESCE(?, provider_session_id)
        WHERE id = ?
      `).run(options.turnStatus, options.turnStatus, occurredAt, finished, options.providerSessionId ?? null, options.turnId);
    }
    if (options.approval) this.insertApprovalInternal(options.approval);
    if (options.commandReceipt) this.updateCommandReceiptInternal(options.commandReceipt, occurredAt);
    for (const receipt of options.commandReceipts ?? []) {
      this.updateCommandReceiptInternal(receipt, occurredAt);
    }
    // Host-restart recovery has a stronger, explicit receipt update below
    // (including reason=host_restart); do not let the generic terminal helper
    // consume that accepted control receipt first.
    if (type !== "session.recovery.required" && options.turnId && options.turnStatus && ["completed", "failed", "cancelled", "outcome_unknown"].includes(options.turnStatus)) {
      this.finalizeInterruptReceiptsInternal(sessionId, options.turnId, options.turnStatus, occurredAt);
    }
    this.db.prepare("UPDATE sessions SET head_sequence = ?, updated_at = ? WHERE id = ?")
      .run(sequence, occurredAt, sessionId);
    return { id: eventId, sessionId, sequence, type, payload, occurredAt } satisfies SessionEvent;
  }

  upsertTimeline(sessionId: string, input: TimelineUpsert): TimelineItem {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.upsertTimelineInternal(sessionId, input, timestamp);
      return this.getTimelineItem(sessionId, input.itemId)!;
    });
    return transaction() as TimelineItem;
  }

  getTimelineItem(sessionId: string, itemId: string): TimelineItem | undefined {
    const row = this.db.prepare("SELECT * FROM timeline_items WHERE session_id = ? AND item_id = ?")
      .get(sessionId, itemId) as RawTimeline | undefined;
    return row ? toTimeline(row) : undefined;
  }

  listEvents(sessionId: string, after = 0, limit = 200, upTo?: number): { events: SessionEvent[]; upTo: number; nextAfter?: number; hasMore: boolean } {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    const upper = upTo ?? session.headSequence;
    const rows = this.db.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC LIMIT ?
    `).all(sessionId, after, upper, limit) as RawEvent[];
    const events = rows.map(toEvent);
    const nextAfter = events.length > 0 ? events[events.length - 1]!.sequence : after;
    return { events, upTo: upper, ...(events.length ? { nextAfter } : {}), hasMore: nextAfter < upper };
  }

  listTimeline(sessionId: string): TimelineItem[] {
    const rows = this.db.prepare("SELECT * FROM timeline_items WHERE session_id = ? ORDER BY updated_at ASC")
      .all(sessionId) as RawTimeline[];
    return rows.map(toTimeline);
  }

  insertApproval(approval: ApprovalRow): void {
    const transaction = this.db.transaction(() => this.insertApprovalInternal(approval));
    transaction();
  }

  getApproval(approvalId: string): ApprovalRow | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as RawApproval | undefined;
    return row ? toApproval(row) : undefined;
  }

  resolveApproval(approvalId: string, expectedVersion: number, action: string): ApprovalRow | undefined {
    const resolvedAt = now();
    const transaction = this.db.transaction(() => {
      return this.resolveApprovalInternal(approvalId, expectedVersion, action, resolvedAt);
    });
    return transaction() as ApprovalRow | undefined;
  }

  /**
   * Resolve an approval using a version CAS and append its canonical
   * `approval.resolved` event, Timeline projection and optional command
   * receipt in one SQLite transaction.  The event/options builder runs after
   * the CAS, while the transaction is still open, so activity state can be
   * derived from the authoritative set of remaining pending approvals.
   */
  resolveApprovalAndCommit(input: {
    approvalId: string;
    expectedVersion: number;
    action: string;
    event: {
      sessionId: string;
      type: string;
      build: (approval: ApprovalRow, pendingApprovals: ApprovalRow[]) => {
        payload: unknown;
        options?: Omit<EventCommitOptions, "approval">;
      };
    };
    receipt?: Omit<CommandReceiptUpdate, "required"> & { method: string; requestHash: string };
  }): ApprovalResolutionCommit | undefined {
    const resolvedAt = now();
    const transaction = this.db.transaction(() => {
      const current = this.getApproval(input.approvalId);
      if (!current || current.sessionId !== input.event.sessionId) return undefined;
      const resolved = this.resolveApprovalInternal(input.approvalId, input.expectedVersion, input.action, resolvedAt);
      if (!resolved) return undefined;
      const pending = this.db.prepare(`
        SELECT * FROM approvals
        WHERE session_id = ? AND turn_id = ? AND status = 'pending'
        ORDER BY created_at ASC
      `).all(resolved.sessionId, resolved.turnId) as RawApproval[];
      const built = input.event.build(resolved, pending.map(toApproval));
      const event = this.appendEventWithProjectionInternal(
        input.event.sessionId,
        input.event.type,
        built.payload,
        built.options ?? {},
        resolvedAt,
      );
      let receipt: CommandReceiptRow | undefined;
      if (input.receipt) {
        this.insertCommandReceiptInternal({
          authSubjectId: input.receipt.authSubjectId,
          commandId: input.receipt.commandId,
          method: input.receipt.method,
          requestHash: input.receipt.requestHash,
          state: input.receipt.state,
          response: input.receipt.response,
        }, resolvedAt);
        receipt = this.getCommandReceipt(input.receipt.authSubjectId, input.receipt.commandId);
      }
      return { approval: resolved, event, ...(receipt ? { receipt } : {}) } satisfies ApprovalResolutionCommit;
    });
    return transaction() as ApprovalResolutionCommit | undefined;
  }

  private resolveApprovalInternal(
    approvalId: string,
    expectedVersion: number,
    action: string,
    resolvedAt: string,
  ): ApprovalRow | undefined {
    const result = this.db.prepare(`
      UPDATE approvals SET status = 'resolved', action = ?, version = version + 1, resolved_at = ?
      WHERE approval_id = ? AND status = 'pending' AND version = ?
    `).run(action, resolvedAt, approvalId, expectedVersion);
    if (result.changes !== 1) return undefined;
    return this.getApproval(approvalId);
  }

  supersedePendingApprovals(sessionId: string, turnId?: string): number {
    const where = turnId ? "session_id = ? AND turn_id = ?" : "session_id = ?";
    const args = turnId ? [sessionId, turnId] : [sessionId];
    const result = this.db.prepare(`
      UPDATE approvals SET status = 'superseded', version = version + 1, resolved_at = ?
      WHERE ${where} AND status = 'pending'
    `).run(now(), ...args);
    return result.changes;
  }

  recoverActiveTurns(): Array<{ sessionId: string; turnId: string }> {
    const rows = this.db.prepare(`
      SELECT session_id, id, auth_subject_id, command_id, request_hash, status
      FROM turns
      WHERE status IN ('queued', 'running', 'waiting_approval', 'interrupting')
      ORDER BY created_at ASC
    `).all() as Array<{
      session_id: string;
      id: string;
      auth_subject_id: string;
      command_id: string;
      request_hash: string;
      status: Turn["status"];
    }>;
    if (rows.length === 0) return [];
    const timestamp = now();
    const recovered: Array<{ sessionId: string; turnId: string }> = [];
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        // Re-check the status inside the transaction.  This makes a second
        // recovery call idempotent and avoids rewriting a Turn that another
        // writer completed between the initial read and BEGIN.
        const changed = this.db.prepare(`
          UPDATE turns SET status = 'outcome_unknown', finished_at = ?
          WHERE id = ? AND status IN ('queued', 'running', 'waiting_approval', 'interrupting')
        `).run(timestamp, row.id);
        if (changed.changes !== 1) continue;
        recovered.push({ sessionId: row.session_id, turnId: row.id });

        const pending = this.db.prepare(`
          SELECT * FROM approvals WHERE turn_id = ? AND status = 'pending'
          ORDER BY created_at ASC
        `).all(row.id) as RawApproval[];
        this.db.prepare(`
          UPDATE approvals SET status = 'superseded', version = version + 1, resolved_at = ?
          WHERE turn_id = ? AND status = 'pending'
        `).run(timestamp, row.id);
        for (const rawApproval of pending) {
          const approval = toApproval(rawApproval);
          const rawTimeline = this.db.prepare(`
            SELECT * FROM timeline_items WHERE session_id = ? AND item_id = ?
          `).get(row.session_id, `approval-${approval.approvalId}`) as RawTimeline | undefined;
          const previous = rawTimeline ? parse<Record<string, unknown>>(rawTimeline.content_json) : approval.request;
          this.upsertTimelineInternal(row.session_id, {
            itemId: `approval-${approval.approvalId}`,
            kind: "approval",
            status: "superseded",
            content: { ...previous, approvalId: approval.approvalId, status: "superseded", action: "aborted", reason: "host_restart" },
          }, timestamp);
        }
        this.db.prepare(`
          UPDATE sessions SET activity_state = 'outcome_unknown', updated_at = ?
          WHERE id = ?
        `).run(timestamp, row.session_id);

        const recoveryMessage = "Host restarted while this Turn was executing; result is unknown and it was not replayed.";
        const recoveryPayload = {
          turnId: row.id,
          commandId: row.command_id,
          previousStatus: row.status,
          reason: "host_restart",
          pendingApprovalIds: pending.map((approval) => approval.approval_id),
          message: recoveryMessage,
        };
        this.appendEventWithProjectionInternal(row.session_id, "session.recovery.required", recoveryPayload, {
          activityState: "outcome_unknown",
          turnId: row.id,
          turnStatus: "outcome_unknown",
          timeline: {
            itemId: `recovery-${row.id}`,
            kind: "error",
            status: "outcome_unknown",
            content: {
              ...recoveryPayload,
            },
          },
        }, timestamp);

        // New Turns carry the exact auth subject, so only that receipt is
        // transitioned.  A legacy row has no subject; update a receipt only
        // when command_id identifies exactly one startTurn receipt rather than
        // risking corruption of another client's historical command.
        let receiptSubject = row.auth_subject_id;
        if (!receiptSubject) {
          const candidates = this.db.prepare(`
            SELECT auth_subject_id FROM command_receipts
            WHERE command_id = ? AND method = 'session.startTurn'
          `).all(row.command_id) as Array<{ auth_subject_id: string }>;
          if (candidates.length === 1) receiptSubject = candidates[0]!.auth_subject_id;
        }
        if (receiptSubject) {
          const existing = this.getCommandReceipt(receiptSubject, row.command_id);
          const response = { turnId: row.id, status: "outcome_unknown", reason: "host_restart" };
          if (existing) {
            // Do not silently replace a receipt with a different request hash.
            // An active Turn and a mismatched receipt indicate corruption;
            // rolling back recovery is safer than claiming a false outcome.
            if (existing.requestHash !== row.request_hash) throw new Error("COMMAND_ID_REUSED");
            this.updateCommandReceiptInternal({
              authSubjectId: receiptSubject,
              commandId: row.command_id,
              state: "outcome_unknown",
              response,
              requestHash: row.request_hash,
              required: true,
            }, timestamp);
          } else {
            this.insertCommandReceiptInternal({
              authSubjectId: receiptSubject,
              commandId: row.command_id,
              method: "session.startTurn",
              requestHash: row.request_hash,
              state: "outcome_unknown",
              response,
            }, timestamp);
          }
        }
        // An interrupt accepted before the crash belongs to this same Turn;
        // leave no control receipt permanently stuck at accepted after the
        // recovery transition.
        for (const controlReceipt of this.listAcceptedReceiptsForTurn(row.id)) {
          this.updateCommandReceiptInternal({
            authSubjectId: controlReceipt.authSubjectId,
            commandId: controlReceipt.commandId,
            state: "outcome_unknown",
            response: { status: "outcome_unknown", turnId: row.id, reason: "host_restart" },
            requestHash: controlReceipt.requestHash,
            required: true,
          }, timestamp);
        }
      }
    });
    transaction();
    return recovered;
  }

  getCommandReceipt(authSubjectId: string, commandId: string): CommandReceiptRow | undefined {
    const row = this.db.prepare(`
      SELECT * FROM command_receipts WHERE auth_subject_id = ? AND command_id = ?
    `).get(authSubjectId, commandId) as RawReceipt | undefined;
    return row ? toReceipt(row) : undefined;
  }

  /** Return accepted control receipts whose canonical response points at a Turn. */
  listAcceptedReceiptsForTurn(turnId: string, method = "session.interrupt"): CommandReceiptRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM command_receipts WHERE method = ? AND state = 'accepted' ORDER BY created_at ASC
    `).all(method) as RawReceipt[];
    return rows
      .map(toReceipt)
      .filter((receipt) => isRecord(receipt.response) && receipt.response.turnId === turnId);
  }

  private insertCommandReceiptInternal(
    input: Omit<CommandReceiptRow, "createdAt" | "updatedAt">,
    timestamp: string,
  ): void {
    this.db.prepare(`
      INSERT INTO command_receipts (auth_subject_id, command_id, method, request_hash, state, response_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.authSubjectId,
      input.commandId,
      input.method,
      input.requestHash,
      input.state,
      json(input.response),
      timestamp,
      timestamp,
    );
  }

  private updateCommandReceiptInternal(input: CommandReceiptUpdate, timestamp: string): void {
    const existing = this.db.prepare(`
      SELECT request_hash FROM command_receipts WHERE auth_subject_id = ? AND command_id = ?
    `).get(input.authSubjectId, input.commandId) as { request_hash: string } | undefined;
    if (!existing) {
      if (input.required) throw new Error("COMMAND_RECEIPT_NOT_FOUND");
      return;
    }
    if (input.requestHash && existing.request_hash !== input.requestHash) {
      throw new Error("COMMAND_ID_REUSED");
    }
    this.db.prepare(`
      UPDATE command_receipts SET state = ?, response_json = ?, updated_at = ?
      WHERE auth_subject_id = ? AND command_id = ?
    `).run(input.state, json(input.response), timestamp, input.authSubjectId, input.commandId);
  }

  putCommandReceipt(input: Omit<CommandReceiptRow, "createdAt" | "updatedAt">): CommandReceiptRow {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const existing = this.getCommandReceipt(input.authSubjectId, input.commandId);
      if (!existing) {
        this.insertCommandReceiptInternal(input, timestamp);
      } else {
        if (existing.method !== input.method || existing.requestHash !== input.requestHash) {
          throw new Error("COMMAND_ID_REUSED");
        }
        this.db.prepare(`
          UPDATE command_receipts SET state = ?, response_json = ?, updated_at = ?
          WHERE auth_subject_id = ? AND command_id = ?
        `).run(input.state, json(input.response), timestamp, input.authSubjectId, input.commandId);
      }
    });
    transaction();
    return this.getCommandReceipt(input.authSubjectId, input.commandId)!;
  }

  updateCommandReceipt(authSubjectId: string, commandId: string, state: CommandReceiptState, response: unknown): CommandReceiptRow {
    const timestamp = now();
    this.updateCommandReceiptInternal({ authSubjectId, commandId, state, response, required: true }, timestamp);
    return this.getCommandReceipt(authSubjectId, commandId)!;
  }

  createAuthSession(tokenHash: string, expiresAt: string, id: string = randomUUID()): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO auth_sessions (id, token_hash, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, tokenHash, timestamp, expiresAt, timestamp);
  }

  findAuthSession(tokenHash: string): AuthSessionRecord | undefined {
    const row = this.db.prepare("SELECT id, expires_at, revoked_at, device_id FROM auth_sessions WHERE token_hash = ?")
      .get(tokenHash) as RawAuthSession | undefined;
    return row ? toAuthSession(row) : undefined;
  }

  getAuthSession(id: string): AuthSessionRecord | undefined {
    const row = this.db.prepare("SELECT id, expires_at, revoked_at, device_id FROM auth_sessions WHERE id = ?")
      .get(id) as RawAuthSession | undefined;
    return row ? toAuthSession(row) : undefined;
  }

  revokeAuthSession(id: string): void {
    this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(now(), id);
  }

  updateLastSeen(id: string): void {
    this.db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  createPairingGrant(tokenHash: string, expiresAt: string, id: string = randomUUID(), metadata: { hostId?: string; scopes?: string[] } = {}): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO pairing_grants (id, token_hash, created_at, expires_at, consumed_at, host_id, requested_scopes)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(token_hash) DO NOTHING
    `).run(id, tokenHash, timestamp, expiresAt, metadata.hostId ?? null, metadata.scopes ? json(metadata.scopes) : null);
  }

  hasActivePairingGrant(tokenHash: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS active FROM pairing_grants
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      LIMIT 1
    `).get(tokenHash, now()) as { active: number } | undefined;
    return Boolean(row);
  }

  consumePairingGrant(tokenHash: string): boolean {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE pairing_grants SET consumed_at = ?, confirmed_at = ?, approved_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(timestamp, timestamp, timestamp, tokenHash, timestamp);
    return result.changes === 1;
  }

  getPairingGrant(tokenHash: string): PairingGrantRecord | undefined {
    const row = this.db.prepare(`
      SELECT id, host_id, requested_scopes, expires_at, approved_at, consumed_at, device_id
      FROM pairing_grants WHERE token_hash = ?
    `).get(tokenHash) as RawPairingGrant | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      ...(row.host_id ? { hostId: row.host_id } : {}),
      ...(row.requested_scopes ? { requestedScopes: parse<string[]>(row.requested_scopes) } : {}),
      expiresAt: row.expires_at,
      ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
      ...(row.device_id ? { deviceId: row.device_id } : {}),
    };
  }

  /** The caller invokes this only after local confirmation; approval, consume
   * and registration share one transaction so a failed insert never burns a grant. */
  createDeviceFromPairingGrant(tokenHash: string, device: DeviceRecord): boolean {
    return this.db.transaction(() => {
      const grant = this.getPairingGrant(tokenHash);
      if (grant?.requestedScopes && device.scopes.some((scope) => !grant.requestedScopes!.includes(scope))) throw new Error("PAIRING_SCOPE_INVALID");
      const result = this.db.prepare(`
        UPDATE pairing_grants SET confirmed_at = ?, approved_at = ?, consumed_at = ?, host_id = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
          AND (host_id IS NULL OR host_id = ?)
      `).run(device.createdAt, device.createdAt, device.createdAt, device.hostId, tokenHash, device.createdAt, device.hostId);
      if (result.changes !== 1) return false;
      this.createDevice(device);
      this.db.prepare("UPDATE pairing_grants SET device_id = ? WHERE token_hash = ?").run(device.id, tokenHash);
      return true;
    })();
  }

  getHostIdentityMirror(): HostIdentityMirror | undefined {
    const row = this.db.prepare("SELECT value_json FROM host_state WHERE key = 'host_identity'").get() as { value_json: string } | undefined;
    if (!row) return undefined;
    const value = parse<unknown>(row.value_json);
    if (!isRecord(value) || typeof value.hostId !== "string" || !value.hostId || typeof value.fingerprint !== "string" || !value.fingerprint) {
      throw new Error("HOST_IDENTITY_MISMATCH");
    }
    return { hostId: value.hostId, fingerprint: value.fingerprint };
  }

  setHostIdentityMirror(value: HostIdentityMirror): void {
    if (!value.hostId || !value.fingerprint) throw new Error("HOST_IDENTITY_MISMATCH");
    this.db.transaction(() => {
      const previous = this.getHostIdentityMirror();
      if (previous && (previous.hostId !== value.hostId || previous.fingerprint !== value.fingerprint)) throw new Error("HOST_IDENTITY_MISMATCH");
      this.db.prepare("INSERT OR IGNORE INTO host_state (key, value_json, updated_at) VALUES ('host_identity', ?, ?)").run(json(value), now());
      const persisted = this.getHostIdentityMirror();
      if (!persisted || persisted.hostId !== value.hostId || persisted.fingerprint !== value.fingerprint) {
        throw new Error("HOST_IDENTITY_MISMATCH");
      }
    })();
  }

  /** Explicit local key rotation. The expected mirror fences concurrent rotations. */
  rotateHostIdentityMirror(value: HostIdentityMirror, expectedPrevious?: HostIdentityMirror): void {
    if (!value.hostId || !value.fingerprint || (expectedPrevious && (
      !expectedPrevious.hostId || !expectedPrevious.fingerprint || value.hostId !== expectedPrevious.hostId
    ))) {
      throw new Error("HOST_IDENTITY_MISMATCH");
    }
    this.db.transaction(() => {
      const previous = this.getHostIdentityMirror();
      if (expectedPrevious && (!previous || previous.hostId !== expectedPrevious.hostId || previous.fingerprint !== expectedPrevious.fingerprint)) {
        throw new Error("HOST_IDENTITY_MISMATCH");
      }
      this.db.prepare(`
        INSERT INTO host_state (key, value_json, updated_at) VALUES ('host_identity', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(json(value), now());
    })();
  }

  createDevice(device: DeviceRecord): void {
    this.db.prepare(`
      INSERT INTO devices (id, host_id, display_name, platform, credential_kind, public_key, scopes_json, credential_revision, created_at, last_seen_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(device.id, device.hostId, device.displayName ?? null, device.platform, device.credentialKind, device.publicKey ?? null,
      json(device.scopes), device.credentialRevision, device.createdAt, device.lastSeenAt ?? null, device.expiresAt ?? null, device.revokedAt ?? null);
  }

  getDevice(id: string): DeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as RawDevice | undefined;
    return row ? toDevice(row) : undefined;
  }

  listDevices(hostId: string): DeviceRecord[] {
    return (this.db.prepare("SELECT * FROM devices WHERE host_id = ? ORDER BY created_at, id").all(hostId) as RawDevice[]).map(toDevice);
  }

  findDeviceByPublicKey(hostId: string, publicKey: string): DeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE host_id = ? AND public_key = ?").get(hostId, publicKey) as RawDevice | undefined;
    return row ? toDevice(row) : undefined;
  }

  findDeviceByCredentialHash(hostId: string, credentialHash: string): DeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE host_id = ? AND credential_hash = ?").get(hostId, credentialHash) as RawDevice | undefined;
    return row ? toDevice(row) : undefined;
  }

  bindAuthSession(id: string, deviceId: string, timestamp = now()): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE auth_sessions SET device_id = ?
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
          AND (device_id IS NULL OR device_id = ?)
          AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?))
      `).run(deviceId, id, timestamp, deviceId, deviceId, timestamp);
      if (result.changes !== 1) return false;
      this.migrateAuthSubject(id, deviceId);
      return true;
    })();
  }

  /**
   * Re-key v1 command ownership from a browser auth-session id to its stable
   * device id. This runs with auth-session binding so retries cannot observe a
   * mapped device while its durable receipt still lives in the old namespace.
   */
  private migrateAuthSubject(authSessionId: string, deviceId: string): void {
    if (authSessionId === deviceId) return;
    const legacy = this.db.prepare(`
      SELECT * FROM command_receipts WHERE auth_subject_id = ? ORDER BY created_at, command_id
    `).all(authSessionId) as RawReceipt[];
    for (const row of legacy) {
      const current = this.db.prepare(`
        SELECT method, request_hash FROM command_receipts WHERE auth_subject_id = ? AND command_id = ?
      `).get(deviceId, row.command_id) as { method: string; request_hash: string } | undefined;
      if (current && (current.method !== row.method || current.request_hash !== row.request_hash)) {
        throw new Error("COMMAND_ID_REUSED");
      }
      if (current) {
        this.db.prepare("DELETE FROM command_receipts WHERE auth_subject_id = ? AND command_id = ?")
          .run(authSessionId, row.command_id);
      } else {
        this.db.prepare(`
          UPDATE command_receipts SET auth_subject_id = ? WHERE auth_subject_id = ? AND command_id = ?
        `).run(deviceId, authSessionId, row.command_id);
      }
    }
    this.db.prepare("UPDATE turns SET auth_subject_id = ? WHERE auth_subject_id = ?").run(deviceId, authSessionId);
  }

  createProtocolSession(record: ProtocolSessionRecord): void {
    this.db.prepare(`
      INSERT INTO protocol_sessions (id, device_id, protocol_version, transport_kind, transport_generation, capability_json, connected_at, expires_at, auth_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.deviceId, record.protocolVersion, record.transportKind, record.transportGeneration,
      json(record.capabilities), record.connectedAt, record.expiresAt, record.authSessionId ?? null);
  }

  getProtocolSession(id: string): ProtocolSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM protocol_sessions WHERE id = ?").get(id) as RawProtocolSession | undefined;
    return row ? toProtocolSession(row) : undefined;
  }

  listActiveProtocolSessions(hostId: string): ProtocolSessionRecord[] {
    return (this.db.prepare(`
      SELECT protocol_sessions.* FROM protocol_sessions JOIN devices ON devices.id = protocol_sessions.device_id
      WHERE devices.host_id = ? AND disconnected_at IS NULL ORDER BY connected_at
    `).all(hostId) as RawProtocolSession[]).map(toProtocolSession);
  }

  disconnectProtocolSession(id: string, closeCode: string, timestamp = now()): boolean {
    return this.db.prepare("UPDATE protocol_sessions SET disconnected_at = ?, close_code = ? WHERE id = ? AND disconnected_at IS NULL")
      .run(timestamp, closeCode, id).changes === 1;
  }

  recordAccessAudit(event: Omit<AccessAuditEvent, "id"> & { id?: string }): void {
    this.db.prepare(`
      INSERT INTO access_audit_events (id, device_id, action, target_type, target_id, transport_kind, occurred_at, result_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id ?? randomUUID(), event.deviceId ?? null, event.action, event.targetType ?? null, event.targetId ?? null,
      event.transportKind ?? null, event.occurredAt, event.resultCode);
  }

  listAccessAudit(limit = 100): AccessAuditEvent[] {
    return (this.db.prepare("SELECT * FROM access_audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(10_000, limit))) as RawAccessAudit[]).map((row) => ({
        id: row.id,
        ...(row.device_id ? { deviceId: row.device_id } : {}),
        action: row.action,
        ...(row.target_type ? { targetType: row.target_type } : {}),
        ...(row.target_id ? { targetId: row.target_id } : {}),
        ...(row.transport_kind ? { transportKind: row.transport_kind } : {}),
        occurredAt: row.occurred_at,
        resultCode: row.result_code,
      }));
  }

  private appendEventInternal(sessionId: string, type: string, payload: unknown, occurredAt: string): SessionEvent {
    const row = this.db.prepare("SELECT head_sequence FROM sessions WHERE id = ?")
      .get(sessionId) as { head_sequence: number } | undefined;
    if (!row) throw new Error("SESSION_NOT_FOUND");
    const event = { id: randomUUID(), sessionId, sequence: row.head_sequence + 1, type, payload, occurredAt } satisfies SessionEvent;
    this.db.prepare(`
      INSERT INTO session_events (id, session_id, sequence, type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, sessionId, event.sequence, type, json(payload), occurredAt);
    this.db.prepare("UPDATE sessions SET head_sequence = ?, updated_at = ? WHERE id = ?")
      .run(event.sequence, occurredAt, sessionId);
    return event;
  }

  private finalizeInterruptReceiptsInternal(
    _sessionId: string,
    turnId: string,
    turnStatus: Turn["status"],
    timestamp: string,
  ): void {
    const rows = this.db.prepare(`
      SELECT auth_subject_id, command_id, response_json
      FROM command_receipts
      WHERE method = 'session.interrupt' AND state = 'accepted'
    `).all() as Array<{ auth_subject_id: string; command_id: string; response_json: string }>;
    for (const row of rows) {
      const response = parse<Record<string, unknown>>(row.response_json);
      if (response.turnId !== turnId) continue;
      const state: CommandReceiptState = turnStatus === "outcome_unknown"
        ? "outcome_unknown"
        : turnStatus === "cancelled"
          ? "cancelled"
          : "completed";
      const responseStatus = turnStatus === "outcome_unknown"
        ? "outcome_unknown"
        : turnStatus === "cancelled"
          ? "cancelled"
          : "already_terminal";
      this.db.prepare(`
        UPDATE command_receipts SET state = ?, response_json = ?, updated_at = ?
        WHERE auth_subject_id = ? AND command_id = ? AND state = 'accepted'
      `).run(state, json({ ...response, status: responseStatus }), timestamp, row.auth_subject_id, row.command_id);
    }
  }
}

type RawSession = {
  id: string; workspace_id: "default"; workspace_path: string; provider: ProviderId; provider_session_id: string | null;
  baseline_head: string | null; baseline_dirty: number | null; baseline_status_json: string | null; baseline_captured_at: string | null;
  status: Session["status"]; activity_state: Session["activityState"]; head_sequence: number; created_at: string; updated_at: string;
};
type RawTurn = {
  id: string; session_id: string; auth_subject_id: string; command_id: string; request_hash: string; status: Turn["status"]; prompt: string;
  provider_session_id: string | null; generation: number; started_at: string | null; finished_at: string | null; created_at: string;
};
type RawEvent = { id: string; session_id: string; sequence: number; type: string; payload_json: string; occurred_at: string };
type RawTimeline = { session_id: string; item_id: string; kind: TimelineItem["kind"]; status: string; revision: number; content_json: string; updated_at: string };
type RawApproval = { approval_id: string; session_id: string; turn_id: string; tool_use_id: string; version: number; status: ApprovalStatus; action: string | null; request_json: string; created_at: string; resolved_at: string | null };
type RawReceipt = { auth_subject_id: string; command_id: string; method: string; request_hash: string; state: CommandReceiptState; response_json: string; created_at: string; updated_at: string };
type RawAuthSession = { id: string; expires_at: string; revoked_at: string | null; device_id: string | null };
type RawPairingGrant = { id: string; host_id: string | null; requested_scopes: string | null; expires_at: string; approved_at: string | null; consumed_at: string | null; device_id: string | null };
type RawDevice = {
  id: string; host_id: string; display_name: string | null; platform: string; credential_kind: DeviceRecord["credentialKind"];
  public_key: string | null; scopes_json: string; credential_revision: number; created_at: string; last_seen_at: string | null; expires_at: string | null; revoked_at: string | null;
};
type RawProtocolSession = {
  id: string; device_id: string; protocol_version: number; transport_kind: string; transport_generation: number;
  capability_json: string; connected_at: string; expires_at: string; auth_session_id: string | null; disconnected_at: string | null; close_code: string | null;
};
type RawAccessAudit = {
  id: string; device_id: string | null; action: string; target_type: string | null; target_id: string | null;
  transport_kind: string | null; occurred_at: string; result_code: string;
};

function toAuthSession(row: RawAuthSession): AuthSessionRecord {
  return {
    id: row.id,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.device_id ? { deviceId: row.device_id } : {}),
  };
}

function toDevice(row: RawDevice): DeviceRecord {
  return {
    id: row.id,
    hostId: row.host_id,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    platform: row.platform,
    credentialKind: row.credential_kind,
    ...(row.public_key ? { publicKey: row.public_key } : {}),
    scopes: parse<string[]>(row.scopes_json),
    credentialRevision: row.credential_revision,
    createdAt: row.created_at,
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function toProtocolSession(row: RawProtocolSession): ProtocolSessionRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    protocolVersion: row.protocol_version,
    transportKind: row.transport_kind,
    transportGeneration: row.transport_generation,
    capabilities: parse<string[]>(row.capability_json),
    connectedAt: row.connected_at,
    expiresAt: row.expires_at,
    ...(row.auth_session_id ? { authSessionId: row.auth_session_id } : {}),
    ...(row.disconnected_at ? { disconnectedAt: row.disconnected_at } : {}),
    ...(row.close_code ? { closeCode: row.close_code } : {}),
  };
}

function toSession(row: RawSession): SessionRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    ...(row.baseline_head ? { baselineHead: row.baseline_head } : {}),
    ...(row.baseline_dirty !== null ? { baselineDirty: row.baseline_dirty === 1 } : {}),
    ...(row.baseline_status_json ? { baselineStatus: parse(row.baseline_status_json) } : {}),
    ...(row.baseline_captured_at ? { baselineCapturedAt: row.baseline_captured_at } : {}),
    status: row.status,
    activityState: row.activity_state,
    headSequence: row.head_sequence,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTurn(row: RawTurn): TurnRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.auth_subject_id ? { authSubjectId: row.auth_subject_id } : {}),
    commandId: row.command_id,
    status: row.status,
    prompt: row.prompt,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    requestHash: row.request_hash,
    generation: row.generation,
    createdAt: row.created_at,
  };
}

function toEvent(row: RawEvent): SessionEvent {
  return { id: row.id, sessionId: row.session_id, sequence: row.sequence, type: row.type, payload: parse(row.payload_json), occurredAt: row.occurred_at };
}

function toTimeline(row: RawTimeline): TimelineItem {
  return { sessionId: row.session_id, itemId: row.item_id, kind: row.kind, status: row.status, revision: row.revision, content: parse(row.content_json), updatedAt: row.updated_at };
}

function toApproval(row: RawApproval): ApprovalRow {
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    toolUseId: row.tool_use_id,
    version: row.version,
    status: row.status,
    ...(row.action ? { action: row.action } : {}),
    request: parse(row.request_json),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

function toReceipt(row: RawReceipt): CommandReceiptRow {
  return {
    authSubjectId: row.auth_subject_id,
    commandId: row.command_id,
    method: row.method,
    requestHash: row.request_hash,
    state: row.state,
    response: parse(row.response_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function asRpcError(error: unknown, fallbackCode = "INTERNAL_ERROR"): RpcError {
  if (error instanceof Error && error.message === "SESSION_NOT_FOUND") {
    return { code: "SESSION_NOT_FOUND", message: "Session does not exist", retryable: false };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
