import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { AttentionRouteSchema, type AttentionKind, type AttentionPreferences, type AttentionRegisterPushRequest, type AttentionRoute, type AttentionDeliveryState, type SessionEvent } from "@flyx/mvp-protocol";
export class AttentionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "AttentionError"; }
}
export type AttentionCommit = {
  id: string;
  sessionId: string;
  firstSequence: number;
  lastSequence: number;
};
export interface AttentionCommitSource {
  readonly db: Database.Database;
  registerCommitHook(hook: (events: readonly SessionEvent[], commit: AttentionCommit) => void): () => void;
}
export { ATTENTION_SCHEMA_VERSION, ATTENTION_SCHEMA_SQL, applyAttentionSchema } from "../storage/migrations/010-attention.js";
export type AttentionFact = {
  ordinal: number;
  id: string;
  host_id: string;
  session_id: string;
  turn_id: string | null;
  interaction_id: string | null;
  version: number;
  kind: AttentionKind;
  source_event_id: string;
  source_commit_id: string;
  source_sequence: number;
  created_at: string;
  expires_at: string;
  superseded_at: string | null;
};
export type PushSubscription = {
  id: string;
  host_id: string;
  device_id: string;
  platform: "expo";
  token: string;
  token_hash: string;
  project_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
export type AttentionDelivery = {
  id: string;
  attention_id: string;
  device_id: string;
  surface: "in_app" | "push";
  state: AttentionDeliveryState;
  attempts: number;
  next_attempt_at: string;
  provider_receipt_id: string | null;
  result_code: string | null;
  created_at: string;
  updated_at: string;
};
export type AttentionBudgets = {
  maxFacts: number;
  maxDeliveries: number;
  maxSubscriptions: number;
  retentionMs: number;
  maxAttempts: number;
};
const defaults: AttentionBudgets = { maxFacts: 10000, maxDeliveries: 50000, maxSubscriptions: 256, retentionMs: 24 * 60 * 60000, maxAttempts: 3 };
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integer(value: unknown, fallback = 0): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback; }
export class AttentionStore {
  readonly budgets: AttentionBudgets;
  constructor(readonly db: Database.Database, readonly hostId: string, options: Partial<AttentionBudgets> = {}) {
    this.budgets = { ...defaults, ...options };
    if (!hostId || Object.values(this.budgets).some((value) => !Number.isSafeInteger(value) || value < 1) || this.budgets.retentionMs > 30 * 24 * 60 * 60000)
      throw new AttentionError("ATTENTION_CONFIGURATION_INVALID");
  }
  private table(name: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  private count(table: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM " + table).get() as {
      n: number;
    }).n;
  }
  transaction<T>(work: () => T): T { return this.db.transaction(work)(); }
  device(deviceId: string, now: string): {
    scopes: Set<string>;
    expiresAt?: string;
  } {
    const device = this.db.prepare("SELECT host_id,scopes_json,revoked_at,expires_at FROM devices WHERE id=?").get(deviceId) as {
      host_id: string;
      scopes_json: string;
      revoked_at: string | null;
      expires_at: string | null;
    } | undefined;
    if (!device || device.host_id !== this.hostId || device.revoked_at || (device.expires_at && device.expires_at <= now))
      throw new AttentionError("DEVICE_REVOKED");
    let scopes: unknown;
    try {
      scopes = JSON.parse(device.scopes_json);
    }
    catch {
      throw new AttentionError("ATTENTION_DEVICE_INVALID");
    }
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string"))
      throw new AttentionError("ATTENTION_DEVICE_INVALID");
    return { scopes: new Set(scopes), ...(device.expires_at ? { expiresAt: device.expires_at } : {}) };
  }
  devices(now: string): string[] {
    return (this.db.prepare("SELECT id FROM devices WHERE host_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY id").all(this.hostId, now) as Array<{
      id: string;
    }>).map((row) => row.id);
  }
  projectCommitted(events: readonly SessionEvent[], commit: AttentionCommit): void {
    if (!this.db.inTransaction)
      throw new AttentionError("ATTENTION_COMMIT_CONTEXT_REQUIRED");
    const boundary = this.db.prepare("SELECT session_id,first_sequence,last_sequence FROM event_commits WHERE id=?").get(commit.id) as {
      session_id: string;
      first_sequence: number;
      last_sequence: number;
    } | undefined;
    if (!boundary || boundary.session_id !== commit.sessionId || boundary.first_sequence !== commit.firstSequence || boundary.last_sequence !== commit.lastSequence)
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    const rows = this.db.prepare("SELECT * FROM session_events WHERE commit_id=? ORDER BY sequence").all(commit.id) as Array<{
      id: string;
      session_id: string;
      sequence: number;
      type: string;
      payload_json: string;
      occurred_at: string;
    }>;
    if (rows.length !== events.length || rows.length !== commit.lastSequence - commit.firstSequence + 1 || rows.some((row, index) => row.id !== events[index]?.id || row.session_id !== commit.sessionId || row.sequence !== commit.firstSequence + index))
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      }
      catch {
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
      }
      this.projectEvent({ id: row.id, sessionId: row.session_id, sequence: row.sequence, type: row.type, payload, occurredAt: row.occurred_at }, commit);
    }
  }
  private projectEvent(event: SessionEvent, commit: AttentionCommit): void {
    const payload = record(event.payload);
    const reconciledStatus = event.type === "turn.reconciled" ? record(payload.outcome).status : undefined;
    for (const [type, key] of [["interaction.requested", "interactionId"], ["approval.requested", "approvalId"], ["turn.completed", "turnId"]])
      if (event.type === type && typeof payload[key!] !== "string")
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    if (reconciledStatus === "completed" && typeof payload.turnId !== "string")
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    if (event.type.startsWith("interaction.") && !this.table("interactions"))
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    let kind: AttentionKind | undefined, turnId: string | undefined, interactionId: string | undefined, version = 0;
    let expiry = Date.parse(event.occurredAt) + this.budgets.retentionMs;
    if (!Number.isFinite(expiry))
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    if (event.type.startsWith("interaction.") && typeof payload.interactionId === "string" && this.table("interactions")) {
      const item = this.db.prepare("SELECT interaction_id,session_id,turn_id,kind,version,status,expires_at FROM interactions WHERE interaction_id=?").get(payload.interactionId) as {
        interaction_id: string;
        session_id: string;
        turn_id: string;
        kind: "question" | "approval";
        version: number;
        status: string;
        expires_at: string;
      } | undefined;
      if (!item || item.session_id !== event.sessionId)
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
      this.supersedeInteraction(item.interaction_id, item.version, item.status, event.occurredAt);
      if (event.type === "interaction.requested" && item.status === "pending") {
        kind = item.kind;
        turnId = item.turn_id;
        interactionId = item.interaction_id;
        version = item.version;
        expiry = Math.min(expiry, Date.parse(item.expires_at));
      }
    }
    else if (event.type === "approval.requested" && typeof payload.approvalId === "string") {
      const item = this.db.prepare("SELECT session_id,turn_id,version,status FROM approvals WHERE approval_id=?").get(payload.approvalId) as {
        session_id: string;
        turn_id: string;
        version: number;
        status: string;
      } | undefined;
      if (!item || item.session_id !== event.sessionId || item.status !== "pending")
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
      kind = "approval";
      turnId = item.turn_id;
      interactionId = payload.approvalId;
      version = item.version;
      expiry = Math.min(expiry, Date.parse(event.occurredAt) + 10 * 60000);
    }
    else if (event.type === "approval.resolved" && typeof payload.approvalId === "string") {
      this.supersedeInteraction(payload.approvalId, 0, "resolved", event.occurredAt);
    }
    else if ((event.type === "turn.completed" || reconciledStatus === "completed") && typeof payload.turnId === "string") {
      const turn = this.db.prepare("SELECT session_id,status,generation FROM turns WHERE id=?").get(payload.turnId) as {
        session_id: string;
        status: string;
        generation: number;
      } | undefined;
      if (!turn || turn.session_id !== event.sessionId || turn.status !== "completed")
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
      kind = "completion";
      turnId = payload.turnId;
      version = integer(turn.generation);
      const first = this.db.prepare("SELECT occurred_at FROM session_events WHERE session_id=? AND (type='turn.completed' OR (type='turn.reconciled' AND json_extract(payload_json,'$.outcome.status')='completed')) AND json_extract(payload_json,'$.turnId')=? ORDER BY sequence LIMIT 1").get(event.sessionId, turnId) as {
        occurred_at: string | null;
      };
      if (first?.occurred_at)
        expiry = Date.parse(first.occurred_at) + this.budgets.retentionMs;
      this.supersedeTurnInteractions(turnId, event.occurredAt);
    }
    else if (["session.recovery.required", "session.recovery.blocked", "host.event_persist_failed", "execution.control.unknown"].includes(event.type) || reconciledStatus === "outcome_unknown") {
      const session = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(event.sessionId) as Record<string, unknown> | undefined;
      if (!session)
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
      if (!["outcome_unknown", "runtime_unavailable"].includes(String(session.activity_state)) && session.recovery_state !== "blocked") {
        if (event.type === "execution.control.unknown" || reconciledStatus === "outcome_unknown")
          return;
        throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
      }
      kind = "recovery_blocked";
      turnId = typeof payload.turnId === "string" ? payload.turnId : typeof session.active_turn_id === "string" ? session.active_turn_id : undefined;
      version = integer(session.recovery_revision, integer(payload.recoveryRevision));
      if (turnId) {
        const turn = this.db.prepare("SELECT session_id FROM turns WHERE id=?").get(turnId) as {
          session_id: string;
        } | undefined;
        if (turn?.session_id === event.sessionId)
          this.supersedeTurnInteractions(turnId, event.occurredAt);
        else
          turnId = undefined;
      }
    }
    else if ((["turn.failed", "turn.cancelled"].includes(event.type) || ["failed", "cancelled"].includes(String(reconciledStatus))) && typeof payload.turnId === "string") {
      this.supersedeTurnInteractions(payload.turnId, event.occurredAt);
    }
    if (!kind || expiry <= Date.parse(event.occurredAt))
      return;
    const id = hash([this.hostId, kind, event.sessionId, turnId ?? null, interactionId ?? null, version]);
    if (this.get(id))
      return;
    this.expire(event.occurredAt);
    if (this.count("attention_facts") >= this.budgets.maxFacts)
      throw new AttentionError("ATTENTION_BUDGET_EXCEEDED");
    if (!Number.isFinite(expiry))
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    const expiresAt = new Date(expiry).toISOString();
    AttentionRouteSchema.parse({ v: 1, hostId: this.hostId, attentionId: id, sessionId: event.sessionId, ...(turnId ? { turnId } : {}), ...(interactionId ? { interactionId } : {}), version, expiresAt });
    this.db.prepare("INSERT INTO attention_facts(id,host_id,session_id,turn_id,interaction_id,version,kind,source_event_id,source_commit_id,source_sequence,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, this.hostId, event.sessionId, turnId ?? null, interactionId ?? null, version, kind, event.id, commit.id, event.sequence, event.occurredAt, expiresAt);
  }
  private supersedeInteraction(id: string, version: number, status: string, now: string): void {
    this.db.prepare("UPDATE attention_facts SET superseded_at=? WHERE interaction_id=? AND superseded_at IS NULL AND (version<>? OR ?<>'pending')").run(now, id, version, status);
    this.db.prepare("UPDATE attention_deliveries SET state='cancelled',result_code='ATTENTION_SUPERSEDED',updated_at=? WHERE state IN ('pending','unavailable') AND attention_id IN (SELECT id FROM attention_facts WHERE interaction_id=? AND superseded_at IS NOT NULL)").run(now, id);
  }
  private supersedeTurnInteractions(id: string, now: string): void {
    this.db.prepare("UPDATE attention_facts SET superseded_at=? WHERE turn_id=? AND kind IN ('approval','question') AND superseded_at IS NULL").run(now, id);
    this.db.prepare("UPDATE attention_deliveries SET state='cancelled',result_code='ATTENTION_SUPERSEDED',updated_at=? WHERE state IN ('pending','unavailable') AND attention_id IN (SELECT id FROM attention_facts WHERE turn_id=? AND superseded_at IS NOT NULL)").run(now, id);
  }
  get(id: string): AttentionFact | undefined { return this.db.prepare("SELECT * FROM attention_facts WHERE id=? AND host_id=?").get(id, this.hostId) as AttentionFact | undefined; }
  factsForCommit(commitId: string): AttentionFact[] { return this.db.prepare("SELECT * FROM attention_facts WHERE source_commit_id=? AND host_id=? ORDER BY ordinal").all(commitId, this.hostId) as AttentionFact[]; }
  facts(after = 0, limit = 1000, sessionId?: string): AttentionFact[] { return this.db.prepare("SELECT * FROM attention_facts WHERE host_id=? AND ordinal>?" + (sessionId ? " AND session_id=?" : "") + " ORDER BY ordinal LIMIT ?").all(this.hostId, after, ...(sessionId ? [sessionId] : []), limit) as AttentionFact[]; }
  route(fact: AttentionFact): AttentionRoute { return AttentionRouteSchema.parse({ v: 1, hostId: fact.host_id, attentionId: fact.id, sessionId: fact.session_id, ...(fact.turn_id ? { turnId: fact.turn_id } : {}), ...(fact.interaction_id ? { interactionId: fact.interaction_id } : {}), version: fact.version, expiresAt: fact.expires_at }); }
  isCurrent(fact: AttentionFact, now: string): boolean {
    if (fact.expires_at <= now || fact.superseded_at)
      return false;
    if (fact.interaction_id) {
      if (this.table("interactions")) {
        const item = this.db.prepare("SELECT session_id,turn_id,version,status,expires_at FROM interactions WHERE interaction_id=?").get(fact.interaction_id) as {
          session_id: string;
          turn_id: string;
          version: number;
          status: string;
          expires_at: string;
        } | undefined;
        if (item)
          return item.session_id === fact.session_id && item.turn_id === fact.turn_id && item.version === fact.version && item.status === "pending" && item.expires_at > now;
      }
      const item = this.db.prepare("SELECT session_id,turn_id,version,status FROM approvals WHERE approval_id=?").get(fact.interaction_id) as {
        session_id: string;
        turn_id: string;
        version: number;
        status: string;
      } | undefined;
      return Boolean(item && item.session_id === fact.session_id && item.turn_id === fact.turn_id && item.version === fact.version && item.status === "pending");
    }
    if (fact.kind === "recovery_blocked") {
      const session = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(fact.session_id) as Record<string, unknown> | undefined;
      return Boolean(session && (["outcome_unknown", "runtime_unavailable"].includes(String(session.activity_state)) || session.recovery_state === "blocked") && integer(session.recovery_revision, fact.version) === fact.version);
    }
    return true;
  }
  acknowledged(attentionId: string, deviceId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM attention_acknowledgements WHERE attention_id=? AND device_id=?").get(attentionId, deviceId)); }
  acknowledge(fact: AttentionFact, deviceId: string, version: number, now: string): void {
    if (version !== fact.version)
      throw new AttentionError("ATTENTION_VERSION_CONFLICT");
    this.db.prepare("INSERT OR IGNORE INTO attention_acknowledgements(attention_id,device_id,version,acknowledged_at) VALUES(?,?,?,?)").run(fact.id, deviceId, version, now);
    this.db.prepare("UPDATE attention_deliveries SET state='cancelled',result_code='ATTENTION_ACKNOWLEDGED',updated_at=? WHERE attention_id=? AND device_id=? AND state IN ('pending','unavailable')").run(now, fact.id, deviceId);
  }
  preferences(deviceId: string): AttentionPreferences {
    const row = this.db.prepare("SELECT mode,push_enabled,revision FROM attention_preferences WHERE device_id=?").get(deviceId) as {
      mode: AttentionPreferences["mode"];
      push_enabled: number;
      revision: number;
    } | undefined;
    return row ? { mode: row.mode, pushEnabled: Boolean(row.push_enabled), revision: row.revision } : { mode: "all", pushEnabled: false, revision: 0 };
  }
  setPreferences(deviceId: string, value: Omit<AttentionPreferences, "revision">, expectedRevision: number): AttentionPreferences {
    if (this.preferences(deviceId).revision !== expectedRevision)
      throw new AttentionError("ATTENTION_PREFERENCES_CONFLICT");
    const next = { ...value, revision: expectedRevision + 1 };
    this.db.prepare("INSERT INTO attention_preferences(device_id,mode,push_enabled,revision) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET mode=excluded.mode,push_enabled=excluded.push_enabled,revision=excluded.revision").run(deviceId, next.mode, Number(next.pushEnabled), next.revision);
    return next;
  }
  register(deviceId: string, request: AttentionRegisterPushRequest, now: string): PushSubscription {
    const device = this.device(deviceId, now);
    const desired = request.expiresAt ? new Date(Date.parse(request.expiresAt)).toISOString() : new Date(Date.parse(now) + 30 * 24 * 60 * 60000).toISOString();
    if (desired <= now || Date.parse(desired) > Date.parse(now) + 90 * 24 * 60 * 60000)
      throw new AttentionError("PUSH_EXPIRY_INVALID");
    const expiresAt = device.expiresAt && device.expiresAt < desired ? device.expiresAt : desired;
    const tokenHash = hash(request.token);
    const existing = this.db.prepare("SELECT * FROM attention_push_subscriptions WHERE host_id=? AND device_id=? AND token_hash=? AND project_id=?").get(this.hostId, deviceId, tokenHash, request.projectId) as PushSubscription | undefined;
    if (!existing && this.count("attention_push_subscriptions") >= this.budgets.maxSubscriptions)
      throw new AttentionError("PUSH_SUBSCRIPTION_BUDGET_EXCEEDED");
    this.db.prepare("UPDATE attention_push_subscriptions SET revoked_at=? WHERE host_id=? AND device_id=? AND revoked_at IS NULL").run(now, this.hostId, deviceId);
    const id = existing?.id ?? randomUUID();
    this.db.prepare("INSERT INTO attention_push_subscriptions(id,host_id,device_id,platform,token,token_hash,project_id,created_at,expires_at) VALUES(?,?,?,'expo',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at,revoked_at=NULL").run(id, this.hostId, deviceId, request.token, tokenHash, request.projectId, existing?.created_at ?? now, expiresAt);
    return this.subscription(deviceId, now)!;
  }
  subscription(deviceId: string, now: string): PushSubscription | undefined { return this.db.prepare("SELECT * FROM attention_push_subscriptions WHERE host_id=? AND device_id=? AND revoked_at IS NULL AND expires_at>?").get(this.hostId, deviceId, now) as PushSubscription | undefined; }
  unregister(deviceId: string, subscriptionId: string, now: string): void {
    const row = this.db.prepare("SELECT device_id,host_id FROM attention_push_subscriptions WHERE id=?").get(subscriptionId) as {
      device_id: string;
      host_id: string;
    } | undefined;
    if (!row || row.device_id !== deviceId || row.host_id !== this.hostId)
      throw new AttentionError("PUSH_SUBSCRIPTION_NOT_FOUND");
    this.db.prepare("UPDATE attention_push_subscriptions SET revoked_at=? WHERE id=?").run(now, subscriptionId);
  }
  delivery(attentionId: string, deviceId: string): AttentionDelivery | undefined { return this.db.prepare("SELECT * FROM attention_deliveries WHERE attention_id=? AND device_id=?").get(attentionId, deviceId) as AttentionDelivery | undefined; }
  enqueue(fact: AttentionFact, deviceId: string, surface: "in_app" | "push", now: string): boolean {
    if (this.delivery(fact.id, deviceId) || this.acknowledged(fact.id, deviceId))
      return true;
    if (this.count("attention_deliveries") >= this.budgets.maxDeliveries)
      return false;
    this.db.prepare("INSERT OR IGNORE INTO attention_deliveries(id,attention_id,device_id,surface,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?)").run(hash([fact.id, deviceId]), fact.id, deviceId, surface, now, now, now);
    return true;
  }
  ready(now: string, limit: number): AttentionDelivery[] { return this.db.prepare("SELECT * FROM attention_deliveries WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at,id LIMIT ?").all(now, limit) as AttentionDelivery[]; }
  claim(job: AttentionDelivery, surface: "in_app" | "push", now: string): AttentionDelivery | undefined {
    const changed = this.db.prepare("UPDATE attention_deliveries SET state='dispatching',surface=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending' AND attempts<?").run(surface, now, job.id, this.budgets.maxAttempts);
    if (changed.changes !== 1)
      return undefined;
    return this.db.prepare("SELECT * FROM attention_deliveries WHERE id=?").get(job.id) as AttentionDelivery;
  }
  settle(job: AttentionDelivery, state: AttentionDeliveryState, resultCode: string, now: string, receiptId?: string, nextAttemptAt?: string): void {
    this.db.prepare("UPDATE attention_deliveries SET state=?,result_code=?,provider_receipt_id=COALESCE(?,provider_receipt_id),next_attempt_at=?,updated_at=? WHERE id=? AND state='dispatching' AND attempts=?").run(state, resultCode, receiptId ?? null, nextAttemptAt ?? now, now, job.id, job.attempts);
  }
  cancel(job: AttentionDelivery, reason: string, now: string): void { this.db.prepare("UPDATE attention_deliveries SET state='cancelled',result_code=?,updated_at=? WHERE id=? AND state IN ('pending','dispatching','unavailable')").run(reason, now, job.id); }
  retryUnavailable(deviceId: string, now: string): void { this.db.prepare("UPDATE attention_deliveries SET state='pending',attempts=0,next_attempt_at=?,updated_at=? WHERE device_id=? AND (state='unavailable' OR (state='cancelled' AND result_code='ATTENTION_PREFERENCES_DISABLED'))").run(now, now, deviceId); }
  recoverDispatches(now: string): number { return this.db.prepare("UPDATE attention_deliveries SET state='outcome_unknown',result_code='PUSH_DISPATCH_UNCONFIRMED',updated_at=? WHERE state='dispatching'").run(now).changes; }
  invalidateDevice(deviceId: string, now: string): void {
    this.db.prepare("UPDATE attention_push_subscriptions SET revoked_at=COALESCE(revoked_at,?) WHERE host_id=? AND device_id=?").run(now, this.hostId, deviceId);
    this.db.prepare("UPDATE attention_deliveries SET state='cancelled',result_code='DEVICE_REVOKED',updated_at=? WHERE device_id=? AND state IN ('pending','dispatching','unavailable','outcome_unknown')").run(now, deviceId);
  }
  setRuntimeCode(key: string, code: string, now: string): void { this.db.prepare("INSERT INTO attention_runtime_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, code, now); }
  expire(now: string): void {
    this.db.prepare("UPDATE attention_push_subscriptions SET revoked_at=? WHERE revoked_at IS NULL AND expires_at<=?").run(now, now);
    this.db.prepare("DELETE FROM attention_facts WHERE expires_at<=?").run(now);
    this.db.prepare("DELETE FROM attention_push_subscriptions WHERE revoked_at IS NOT NULL AND expires_at<=?").run(now);
  }
}
