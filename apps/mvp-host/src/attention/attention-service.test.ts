import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionRoute, SessionEvent } from "@flyx/mvp-protocol";
import { AttentionService, type AttentionPrincipal } from "./attention-service.js";
import { applyAttentionSchema, AttentionStore, type AttentionCommit, type AttentionCommitSource } from "./store.js";
import type { AttentionDeliveryDriver } from "./delivery-driver.js";
const resources: Database.Database[] = [];
afterEach(() => {
  for (const db of resources.splice(0))
    db.close();
});
const date = "2026-10-15T00:00:00.000Z";
const projectId = "b5b3b486-c5df-4352-a31c-1c6cfcc5b897";
function setup(options: Partial<ConstructorParameters<typeof AttentionStore>[2]> = {}) {
  const db = new Database(":memory:");
  resources.push(db);
  db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,activity_state TEXT,recovery_revision INTEGER DEFAULT 0);CREATE TABLE turns(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),status TEXT,generation INTEGER);CREATE TABLE devices(id TEXT PRIMARY KEY,host_id TEXT,scopes_json TEXT,revoked_at TEXT,expires_at TEXT);CREATE TABLE approvals(approval_id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,version INTEGER,status TEXT);CREATE TABLE interactions(interaction_id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,kind TEXT,version INTEGER,status TEXT,expires_at TEXT);CREATE TABLE event_commits(id TEXT PRIMARY KEY,session_id TEXT,first_sequence INTEGER,last_sequence INTEGER);CREATE TABLE session_events(id TEXT PRIMARY KEY,session_id TEXT,sequence INTEGER,type TEXT,payload_json TEXT,occurred_at TEXT,commit_id TEXT REFERENCES event_commits(id),UNIQUE(session_id,sequence));");
  db.prepare("INSERT INTO sessions VALUES('s1','idle',0)").run();
  for (const id of ["device1", "device2"])
    db.prepare("INSERT INTO devices VALUES(?,'host1',?,NULL,NULL)").run(id, JSON.stringify(["session:read", "access:self"]));
  applyAttentionSchema(db);
  const store = new AttentionStore(db, "host1", options);
  let clock = Date.parse(date), sequence = 0, serial = 0;
  const callbacks = new Set<(events: readonly SessionEvent[], commit: AttentionCommit) => void>();
  const source: AttentionCommitSource = { db, registerCommitHook: (hook) => { callbacks.add(hook); return () => callbacks.delete(hook); } };
  const native: AttentionRoute[] = [];
  const driver: AttentionDeliveryDriver = { configured: true, send: vi.fn<AttentionDeliveryDriver["send"]>(async (_subscription, payload) => { native.push(payload); return { status: "accepted", receiptId: "receipt-" + native.length, code: "PUSH_SERVICE_ACCEPTED" }; }) };
  const service = new AttentionService({ store, driver, now: () => new Date(clock) });
  service.bindCommittedSource(source);
  function commit(type: string, payload: unknown, mutate: () => void = () => undefined) {
    const id = "commit-" + (++serial);
    const event: SessionEvent = { id: "event-" + serial, sessionId: "s1", sequence: sequence + 1, type, payload, occurredAt: new Date(clock).toISOString() };
    const boundary = { id, sessionId: "s1", firstSequence: event.sequence, lastSequence: event.sequence };
    db.transaction(() => {
      mutate();
      db.prepare("INSERT INTO event_commits VALUES(?,?,?,?)").run(id, "s1", event.sequence, event.sequence);
      db.prepare("INSERT INTO session_events VALUES(?,?,?,?,?,?,?)").run(event.id, "s1", event.sequence, type, JSON.stringify(payload), event.occurredAt, id);
      for (const hook of callbacks)
        hook([event], boundary);
    })();
    sequence = event.sequence;
    return boundary;
  }
  function completed(id = "turn1") { return commit("turn.completed", { turnId: id, prompt: "private prompt", reason: "private reason", path: "/private/workspace", diff: "private diff" }, () => db.prepare("INSERT OR REPLACE INTO turns VALUES(?,'s1','completed',1)").run(id)); }
  function question(id = "question1", version = 0) {
    return commit("interaction.requested", { interactionId: id, question: "private question", request: { secret: "private value" } }, () => {
      db.prepare("INSERT OR IGNORE INTO turns VALUES('turn-question','s1','waiting_approval',1)").run();
      db.prepare("INSERT INTO interactions VALUES(?,'s1','turn-question','question',?,'pending',?) ON CONFLICT(interaction_id) DO UPDATE SET version=excluded.version,status='pending'").run(id, version, new Date(clock + 60000).toISOString());
    });
  }
  const principal = (id = "device1"): AttentionPrincipal => ({ deviceId: id, hostId: "host1", scopes: new Set(["session:read", "access:self"]), leaseId: "lease-" + id });
  async function enable(id = "device1") {
    await service.handleRpc(principal(id), "attention.registerPush", { platform: "expo", tokenType: "expo", token: "ExpoPushToken[" + id + "]", projectId });
    await service.handleRpc(principal(id), "attention.setPreferences", { mode: "all", pushEnabled: true, expectedRevision: 0 });
  }
  return { db, store, source, service, native, driver, commit, completed, question, principal, enable, setClock: (value: number) => { clock = value; }, clock: () => clock };
}
describe("committed attention facts", () => {
  it("rolls back attention with the source transaction and never invokes a driver", async () => {
    const f = setup();
    const errorHook = f.source.registerCommitHook(() => { throw new Error("injected commit failure"); });
    expect(() => f.completed()).toThrow("injected commit failure");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_events").get()).toEqual({ n: 0 });
    expect(f.store.facts()).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM attention_deliveries").get()).toEqual({ n: 0 });
    await f.service.drain();
    expect(f.native).toEqual([]);
    errorHook();
  });
  it("rejects arbitrary/optimistic facts, source mismatches and driver wake during a transaction", async () => {
    const f = setup();
    expect(() => f.store.projectCommitted([], { id: "missing", sessionId: "s1", firstSequence: 1, lastSequence: 1 })).toThrow("ATTENTION_COMMIT_CONTEXT_REQUIRED");
    expect(() => f.commit("turn.completed", { turnId: "still-running" }, () => f.db.prepare("INSERT INTO turns VALUES('still-running','s1','running',1)").run())).toThrow("ATTENTION_SOURCE_MISMATCH");
    expect(f.store.facts()).toEqual([]);
    const boundary = f.completed();
    let rejected: Promise<void> | undefined;
    f.db.transaction(() => { rejected = f.service.notifyCommitted(boundary.id); void rejected.catch(() => undefined); })();
    await expect(rejected).rejects.toThrow("ATTENTION_POST_COMMIT_REQUIRED");
    expect(f.native).toEqual([]);
  });
  it("projects only committed pending questions, approvals, completion and recovery blocks", () => {
    const f = setup();
    f.question();
    f.completed();
    f.commit("approval.requested", { approvalId: "approval1", turnId: "turn-approval" }, () => {
      f.db.prepare("INSERT INTO turns VALUES('turn-approval','s1','waiting_approval',1)").run();
      f.db.prepare("INSERT INTO approvals VALUES('approval1','s1','turn-approval',0,'pending')").run();
    });
    f.commit("session.recovery.required", { turnId: "turn-unknown", recoveryRevision: 2, reason: "private failure" }, () => {
      f.db.prepare("INSERT INTO turns VALUES('turn-unknown','s1','outcome_unknown',1)").run();
      f.db.prepare("UPDATE sessions SET activity_state='outcome_unknown',recovery_revision=2 WHERE id='s1'").run();
    });
    expect(f.store.facts().map((fact) => fact.kind)).toEqual(["question", "completion", "approval", "recovery_blocked"]);
  });
  it("uses canonical reconciled completion and blocked control facts after authoritative projection", () => {
    const f = setup();
    f.commit("turn.reconciled", { turnId: "turn-reconciled", outcome: { status: "completed", providerSessionId: "native-session", evidence: { kind: "native-terminal", sourceId: "native-result" } } }, () => f.db.prepare("INSERT INTO turns VALUES('turn-reconciled','s1','completed',2)").run());
    f.commit("turn.reconciled", { turnId: "turn-unknown", outcome: { status: "outcome_unknown" } }, () => {
      f.db.prepare("INSERT INTO turns VALUES('turn-unknown','s1','outcome_unknown',3)").run();
      f.db.prepare("UPDATE sessions SET activity_state='outcome_unknown',recovery_revision=3 WHERE id='s1'").run();
    });
    f.commit("execution.control.unknown", { turnId: "turn-unknown", intentId: "private-intent", evidence: { secret: "private evidence" } });
    expect(f.store.facts().map((fact) => ({ kind: fact.kind, version: fact.version }))).toEqual([{ kind: "completion", version: 2 }, { kind: "recovery_blocked", version: 3 }]);
    expect(f.store.isCurrent(f.store.facts()[1]!, date)).toBe(true);
    f.db.prepare("UPDATE sessions SET recovery_revision=4 WHERE id='s1'").run();
    expect(f.store.isCurrent(f.store.facts()[1]!, date)).toBe(false);
  });
  it("persists a deduplicated queue before a failed wakeup and never repeats accepted delivery", async () => {
    const f = setup();
    await f.enable();
    const failure = new AttentionService({ store: f.store, driver: f.driver, now: () => new Date(f.clock()), wakeup: () => { throw new Error("private wake reason"); } });
    const boundary = f.completed();
    await failure.notifyCommitted(boundary.id);
    expect(f.store.ready(date, 10).length).toBe(2);
    expect(f.native).toEqual([]);
    await failure.drain();
    expect(f.native).toHaveLength(1);
    f.commit("turn.completed", { turnId: "turn1" });
    await failure.notifyCommitted(boundary.id);
    await failure.drain();
    expect(f.native).toHaveLength(1);
    expect(f.store.facts()).toHaveLength(1);
  });
  it("catches up a later authorized device and keeps its queue when the scheduler wake fails", async () => {
    const f = setup();
    f.completed();
    f.db.prepare("INSERT INTO devices VALUES('device3','host1',?,NULL,NULL)").run(JSON.stringify(["session:read", "access:self"]));
    const wakeup = vi.fn(async () => { throw new Error("private scheduler failure"); });
    const service = new AttentionService({ store: f.store, driver: f.driver, now: () => new Date(f.clock()), wakeup });
    await service.handleRpc(f.principal("device3"), "attention.registerPush", { platform: "expo", tokenType: "expo", token: "ExpoPushToken[device3]", projectId });
    await service.handleRpc(f.principal("device3"), "attention.setPreferences", { mode: "none", pushEnabled: true, expectedRevision: 0 });
    await service.drain();
    expect(f.native).toEqual([]);
    const fact = f.store.facts()[0]!;
    expect(f.store.delivery(fact.id, "device3")?.state).toBe("cancelled");
    await service.handleRpc(f.principal("device3"), "attention.setPreferences", { mode: "all", pushEnabled: true, expectedRevision: 1 });
    expect(wakeup).toHaveBeenCalledTimes(3);
    expect(f.store.delivery(fact.id, "device3")?.state).toBe("pending");
    expect(f.db.prepare("SELECT value FROM attention_runtime_state WHERE key='wakeup'").get()).toEqual({ value: "ATTENTION_WAKEUP_UNAVAILABLE" });
    await service.drain();
    expect(f.native).toHaveLength(1);
    expect(f.store.facts()).toHaveLength(1);
  });
  it("retains the fact when foreground/background presence or preferences suppress delivery", async () => {
    const f = setup();
    const inApp: AttentionRoute[] = [];
    const service = new AttentionService({ store: f.store, driver: f.driver, now: () => new Date(f.clock()), inApp: async (_id, payload) => { inApp.push(payload); return "presented"; } });
    await service.handleRpc(f.principal(), "attention.setPresence", { foreground: true, sessionId: "s1" });
    f.completed();
    await service.drain();
    expect(inApp).toHaveLength(1);
    expect(f.native).toEqual([]);
    await service.handleRpc(f.principal(), "attention.setPresence", { foreground: false });
    await service.drain();
    expect(inApp).toHaveLength(1);
    const list = await service.handleRpc(f.principal(), "attention.list", {}) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);
    expect(f.store.facts()).toHaveLength(1);
  });
  it("keeps unknown dispatches queryable and never automatically repeats them after restart", async () => {
    const f = setup();
    await f.enable();
    f.completed();
    f.service.enqueueOutstanding();
    const job = f.store.ready(date, 10).find((row) => row.device_id === "device1")!;
    f.store.claim(job, "push", date);
    expect(f.service.recoverPendingDispatches()).toBe(1);
    await f.service.drain();
    expect(f.native).toEqual([]);
    expect(f.store.delivery(job.attention_id, "device1")?.state).toBe("outcome_unknown");
  });
});
describe("attention authorization, privacy and retention", () => {
  it("binds registration/list/ack/preferences to Host and device scopes", async () => {
    const f = setup();
    f.question();
    await expect(f.service.handleRpc({ ...f.principal(), hostId: "other" }, "attention.list", {})).rejects.toThrow("ATTENTION_HOST_MISMATCH");
    await expect(f.service.handleRpc({ ...f.principal(), scopes: new Set() }, "attention.list", {})).rejects.toThrow("FORBIDDEN");
    await expect(f.service.handleRpc(f.principal(), "attention.registerPush", { platform: "expo", tokenType: "expo", token: "ExpoPushToken[device]", projectId, deviceId: "device2" })).rejects.toThrow();
    const fact = f.store.facts()[0]!;
    await expect(f.service.handleRpc(f.principal(), "attention.acknowledge", { attentionId: fact.id, expectedVersion: 1 })).rejects.toThrow("ATTENTION_VERSION_CONFLICT");
    await f.service.handleRpc(f.principal(), "attention.acknowledge", { attentionId: fact.id, expectedVersion: 0 });
    expect(f.store.acknowledged(fact.id, "device1")).toBe(true);
    expect(f.store.acknowledged(fact.id, "device2")).toBe(false);
  });
  it("uses fresh stored scopes for read and delivery after a credential change", async () => {
    const f = setup();
    await f.enable();
    f.completed();
    f.db.prepare("UPDATE devices SET scopes_json=? WHERE id='device1'").run(JSON.stringify(["access:self"]));
    await expect(f.service.handleRpc(f.principal(), "attention.list", {})).rejects.toThrow("FORBIDDEN");
    await f.service.drain();
    expect(f.native).toEqual([]);
    expect(f.store.delivery(f.store.facts()[0]!.id, "device1")?.state).toBe("cancelled");
    expect(f.store.facts()).toHaveLength(1);
  });
  it("invalidates revoked subscriptions and fences a late send result", async () => {
    const f = setup();
    await f.enable();
    f.completed();
    let release!: () => void, started!: () => void;
    const startedBarrier = new Promise<void>((done) => { started = done; });
    const barrier = new Promise<void>((done) => { release = done; });
    const driver: AttentionDeliveryDriver = { configured: true, send: async () => { started(); await barrier; return { status: "accepted", receiptId: "receipt", code: "PUSH_SERVICE_ACCEPTED" }; } };
    const service = new AttentionService({ store: f.store, driver, now: () => new Date(f.clock()) });
    const pending = service.drain();
    await startedBarrier;
    f.db.prepare("UPDATE devices SET revoked_at=? WHERE id='device1'").run(date);
    service.onDeviceRevoked("device1");
    release();
    await pending;
    expect(f.store.subscription("device1", date)).toBeUndefined();
    expect(f.store.delivery(f.store.facts()[0]!.id, "device1")?.state).toBe("cancelled");
    await expect(service.handleRpc(f.principal(), "attention.list", {})).rejects.toThrow("DEVICE_REVOKED");
  });
  it("uses only the minimal payload and exposes stale interaction versions through read facts", async () => {
    const f = setup();
    await f.enable();
    const first = f.question();
    await f.service.notifyCommitted(first.id);
    await f.service.drain();
    expect(f.native).toHaveLength(1);
    expect(Object.keys(f.native[0]!).sort()).toEqual(["attentionId", "expiresAt", "hostId", "interactionId", "sessionId", "turnId", "v", "version"].sort());
    for (const text of ["private question", "private value", "/private", "reason", "diff"])
      expect(JSON.stringify(f.native)).not.toContain(text);
    f.question("question1", 1);
    const list = await f.service.handleRpc(f.principal(), "attention.list", {}) as {
      items: Array<{
        version: number;
        stale: boolean;
      }>;
    };
    expect(list.items.find((item) => item.version === 0)?.stale).toBe(true);
    expect(list.items.find((item) => item.version === 1)?.stale).toBe(false);
  });
  it("reports disabled sink unavailable and preserves unread facts", async () => {
    const f = setup();
    await f.enable();
    f.completed();
    const service = new AttentionService({ store: f.store, now: () => new Date(f.clock()) });
    await service.drain();
    const result = await service.handleRpc(f.principal(), "attention.list", {}) as {
      unavailable: boolean;
      items: Array<{
        deliveryState: string;
      }>;
    };
    expect(result.unavailable).toBe(true);
    expect(result.items[0]?.deliveryState).toBe("unavailable");
    expect(f.store.facts()).toHaveLength(1);
    expect(f.native).toEqual([]);
  });
  it("bounds encoded pages, source retention and queues without dropping the source fact", async () => {
    const f = setup({ maxDeliveries: 1 });
    for (let index = 0; index < 60; index++)
      f.completed("turn" + index);
    f.service.enqueueOutstanding();
    expect(f.store.ready(date, 100)).toHaveLength(1);
    expect(f.store.facts()).toHaveLength(60);
    const page = await f.service.handleRpc(f.principal(), "attention.list", { limit: 50 }) as {
      items: unknown[];
      hasMore: boolean;
    };
    expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24 * 1024);
    f.setClock(f.clock() + 25 * 60 * 60000);
    f.service.enqueueOutstanding();
    expect(f.store.facts()).toEqual([]);
    f.commit("turn.completed", { turnId: "turn0" });
    f.service.enqueueOutstanding();
    expect(f.store.facts()).toEqual([]);
  });
  it("rolls back source commits if the configured fact budget is exhausted", () => {
    const f = setup({ maxFacts: 1 });
    f.completed("a");
    expect(() => f.completed("b")).toThrow("ATTENTION_BUDGET_EXCEEDED");
    expect(f.store.facts()).toHaveLength(1);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM session_events").get()).toEqual({ n: 1 });
  });
});
