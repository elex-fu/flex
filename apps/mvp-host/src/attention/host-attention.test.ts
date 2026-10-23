import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionListResponse, AttentionRoute } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { InteractionService } from "../interaction/interaction-service.js";
import { parseClaudeQuestions } from "../interaction/native-question-codec.js";
import { interactionFence } from "../interaction/types.js";
import { HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { CommandEngine } from "../orchestration/command-engine.js";
import { RecoveryService } from "../session/recovery-service.js";
import { RecoveryStore } from "../storage/recovery-store.js";
import { openOwned } from "../storage/open-store.js";
import type { SqliteStore } from "../storage/db.js";
import type { DispatchContext } from "../provider/types.js";
import { attentionRpc, createHostAttentionBindings, type HostAttention, type HostAttentionOptions } from "./host-attention.js";
import { EXPO_PUSH_SEND_ENDPOINT } from "./delivery-driver.js";
const hosts: HostAttention[] = [], services: InteractionService[] = [], devices: DeviceRegistry[] = [], stores: SqliteStore[] = [], owners: HostOwnerHandle[] = [], roots: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { await host.drain(Date.now() + 1000); host.seal(); }
  for (const service of services.splice(0)) service.close();
  for (const registry of devices.splice(0)) registry.close();
  for (const store of stores.splice(0)) store.close();
  for (const owner of owners.splice(0)) owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const date = "2026-10-15T00:00:00.000Z", hostId = "trusted-host", projectId = "b5b3b486-c5df-4352-a31c-1c6cfcc5b897";
async function fixture(overrides: Partial<HostAttentionOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "flyx-host-attention-")); roots.push(root);
  const databasePath = join(root, "host.sqlite"), coordinationDirectory = join(root, "owners");
  const owner = HostOwnerLock.acquire({ databasePath, coordinationDirectory }); owners.push(owner);
  const store = openOwned({ databasePath, owner }); stores.push(store); store.setHostIdentityMirror({ hostId, fingerprint: "trusted-fingerprint" });
  const session = store.createSession(join(root, "workspace"), "claude", "session");
  const registry = new DeviceRegistry(store, hostId, { now: () => Date.parse(date), revocationPollMs: 60000 }); devices.push(registry);
  const device = registry.createBrowserDevice({ scopes: ["session:read", "session:write", "access:self", "approval:write"] });
  const lease = registry.openLease(device.id, { kind: "direct", generation: 1, protocolVersion: 2, capabilities: ["attention-v1"], close: vi.fn() });
  const context = { leaseId: lease.leaseId, generation: 1 };
  const engine = new CommandEngine(store, { clock: { now: () => date, id: () => crypto.randomUUID() } });
  const accepted = store.acceptTurn({ authSubjectId: device.id, sessionId: session.id, turnId: "turn", commandId: "start", requestHash: "hash", prompt: "private prompt", generation: 1, attemptId: "attempt" });
  const nativeContext: DispatchContext = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: session.id, flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt" };
  const interaction = new InteractionService(engine, { resolveSession: () => ({ provider: "claude", workspaceId: "workspace", runtimeId: "runtime", adapterVersion: "fixture", runtimeVersion: "fixture" }), questionCapability: () => true, now: () => date }); services.push(interaction);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: { status: "ok", id: "ticket" } }), { status: 200 }));
  const acl = new Set([session.id]); const trackDelivery = vi.fn(async (work: () => Promise<void>) => work());
  const options: HostAttentionOptions = { store, owner, hostId, devices: registry, interactions: interaction,
    assertActorSession: (deviceId, sessionId) => { if (!acl.has(sessionId) || !store.getSession(sessionId) || !store.getDevice(deviceId) || store.getDevice(deviceId)?.revokedAt) throw new Error("FORBIDDEN"); },
    assertDeliveryReady: () => {}, trackDelivery, push: { enabled: true, projectId, fetch }, now: () => new Date(date), pollMs: 60000, ...overrides };
  const host = createHostAttentionBindings(options); hosts.push(host);
  async function start() { host.start(); await host.flush(); }
  async function enable() {
    await attentionRpc(host, context, "attention.registerPush", { platform: "expo", tokenType: "expo", token: "ExpoPushToken[private-token]", projectId });
    await attentionRpc(host, context, "attention.setPreferences", { mode: "all", pushEnabled: true, expectedRevision: 0 });
  }
  function question(id = "question") {
    const request = parseClaudeQuestions("native-request", { questions: [{ header: "Color", question: "private question", multiSelect: false, options: [{ label: "Red", description: "private description" }, { label: "Blue", description: "Second" }] }] }).request;
    return interaction.ingestQuestion(interactionFence(nativeContext), { interactionId: id, turnId: "turn", nativeRequestId: id + "-native", nativeMethod: "canUseTool/AskUserQuestion", request, createdAt: date, expiresAt: "2026-10-15T00:10:00.000Z" });
  }
  function complete(turnId = "turn") {
    return store.commitCommand({ sessionId: session.id, occurredAt: date, build: () => ({ result: undefined,
      events: [{ type: "turn.completed", payload: { turnId, prompt: "private prompt", nativeSessionId: "private native", path: root, diff: "private diff" }, options: { turnId, turnStatus: "completed", activityState: "idle" } }] }) })!;
  }
  function rows() { return store.db.prepare("SELECT * FROM attention_deliveries ORDER BY id").all() as Array<{ id: string; attention_id: string; state: string; attempts: number }>; }
  function facts() { return store.db.prepare("SELECT * FROM attention_facts ORDER BY ordinal").all() as Array<{ id: string; kind: string; version: number; source_event_id: string; source_commit_id: string; superseded_at: string | null }>; }
  return { root, databasePath, coordinationDirectory, owner, store, session, registry, device, context, engine, accepted, nativeContext, interaction, fetch, acl, options, host, start, enable, question, complete, rows, facts, trackDelivery };
}
function gate(store: SqliteStore, value = '"ready"') { store.db.prepare("INSERT INTO host_state(key,value_json,updated_at) VALUES('restore_readiness',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(value, date); }
function hold() { let release!: () => void; let enter!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { enter = resolve; }); return { barrier, release, enter, entered }; }
async function list(f: Awaited<ReturnType<typeof fixture>>) { return attentionRpc(f.host, f.context, "attention.list", {}) as Promise<AttentionListResponse>; }

describe("owned Host attention binding", () => {
  it("requires declared010 and exact shared Host/Interaction ownership, with no constructor DDL or sink calls", async () => {
    const f = await fixture(); const schema = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.host.capabilities()).toEqual([]); expect(f.host.rpc()).toBeUndefined();
    const second = createHostAttentionBindings(f.options); hosts.push(second);
    expect(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(() => createHostAttentionBindings({ ...f.options, owner: { ...f.owner } })).toThrow("verified Host owner");
    expect(() => createHostAttentionBindings({ ...f.options, hostId: "client-host" })).toThrow("ATTENTION_HOST_BINDING_INVALID");
    f.store.db.prepare("DELETE FROM schema_migrations WHERE version IN (10,11,12)").run();
    expect(() => createHostAttentionBindings(f.options)).toThrow("ATTENTION_SCHEMA_NOT_READY");
    f.store.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(10,?)").run(date);
    f.store.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(11,?)").run(date);
    f.store.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(12,?)").run(date);
    f.store.db.exec("DROP INDEX attention_one_active_push");
    expect(() => createHostAttentionBindings(f.options)).toThrow(/schema/i);
    expect(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='attention_one_active_push'").get()).toBeUndefined();
    expect(schema.length).toBeGreaterThan(50); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("projects the real Interaction hook before attention in one rollback boundary and only wakes after commit", async () => {
    const f = await fixture(); await f.start(); await f.enable(); f.question();
    expect(f.interaction.interactions.get("question")?.status).toBe("pending");
    expect(f.facts().map((item) => item.kind)).toEqual(["question"]); expect(f.rows().map((row) => row.state)).toEqual(["pending"]); expect(f.fetch).not.toHaveBeenCalled();
    const event = f.store.listEvents(f.session.id).events.at(-1)!;
    let during: Promise<void> | undefined;
    f.store.db.transaction(() => { during = f.host.postCommitWake(event); void during.catch(() => {}); })();
    await expect(during).rejects.toThrow("ATTENTION_POST_COMMIT_REQUIRED");
    const detach = f.store.registerCommitHook(() => { throw new Error("atomic failure"); });
    const head = f.store.getSession(f.session.id)!.headSequence;
    expect(() => f.question("rollback-question")).toThrow("atomic failure"); detach();
    expect(f.store.getSession(f.session.id)!.headSequence).toBe(head); expect(f.interaction.interactions.get("rollback-question")).toBeUndefined(); expect(f.facts()).toHaveLength(1);
    await f.host.postCommitWake(event);
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.trackDelivery).toHaveBeenCalled(); expect(f.rows()[0]?.state).toBe("accepted");
    const [url, init] = f.fetch.mock.calls[0]!; expect(url).toBe(EXPO_PUSH_SEND_ENDPOINT);
    const payload = JSON.parse(String(init!.body)); expect(payload.data).toMatchObject({ hostId, sessionId: f.session.id, interactionId: "question" });
    for (const secret of [f.root, "private question", "private prompt", "private native", "private diff"]) expect(JSON.stringify(payload.data)).not.toContain(secret);
    const before = f.store.db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get();
    const route = payload.data as AttentionRoute; expect(f.host.inspectRoute(f.context, route)).toMatchObject({ stale: false, interaction: { status: "pending", version: 0 } });
    f.interaction.supersedeForRuntime(f.session.id, { attemptId: "attempt", runtimeGeneration: 1 }, "turn_finished");
    expect(f.host.inspectRoute(f.context, route)).toMatchObject({ stale: true, interaction: { status: "superseded", version: 1 } });
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()).toEqual(before); await f.host.flush(); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("retains one first Interaction hook across real Session service close and reload", async () => {
    const f = await fixture(); await f.start(); f.interaction.close();
    const replacement = new InteractionService(f.engine, { resolveSession: () => ({ provider: "claude", runtimeId: "runtime", workspaceId: "workspace" }), questionCapability: () => true, now: () => date }); services.push(replacement);
    const request = parseClaudeQuestions("native-reloaded", { questions: [{ header: "Choice", question: "Pick", multiSelect: false, options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }] }).request;
    replacement.ingestQuestion(interactionFence(f.nativeContext), { interactionId: "reloaded", turnId: "turn", nativeRequestId: "native-reloaded", nativeMethod: "canUseTool/AskUserQuestion", request, createdAt: date, expiresAt: "2026-10-15T00:10:00.000Z" });
    expect(replacement.interactions.get("reloaded")).toMatchObject({ status: "pending", version: 0 }); expect(f.facts().map((fact) => fact.kind)).toEqual(["question"]);
    replacement.close(); f.complete();
    expect(replacement.interactions.get("reloaded")).toMatchObject({ status: "superseded", version: 1 }); expect(f.facts().map((fact) => fact.kind)).toEqual(["question", "completion"]);
    expect(f.store.db.prepare("SELECT 1 FROM interaction_delivery_evidence WHERE kind='native-ack'").get()).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("opens legacy approval reminders using fresh public status without native IDs or actions", async () => {
    const f = await fixture(); await f.start();
    f.store.commitCommand({ sessionId: f.session.id, occurredAt: date, build: () => ({ result: undefined, events: [{ type: "approval.requested", payload: { approvalId: "legacy", turnId: "turn" }, options: { turnId: "turn", turnStatus: "waiting_approval", approval: {
      approvalId: "legacy", sessionId: f.session.id, turnId: "turn", toolUseId: "private-tool", version: 0, status: "pending", request: { toolName: "Bash", workspacePath: f.root }, createdAt: date } } }] }) });
    const item = (await list(f)).items[0]!;
    const { kind: _kind, createdAt: _created, acknowledged: _ack, stale: _stale, deliveryState: _delivery, ...route } = item;
    const before = f.store.db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get();
    const view = f.host.inspectRoute(f.context, route); expect(view).toMatchObject({ stale: false, approval: { approvalId: "legacy", status: "pending", version: 0 } });
    expect(JSON.stringify(view)).not.toContain("private-tool"); expect(JSON.stringify(view)).not.toContain(f.root); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()).toEqual(before);
  });
  it("keeps unconfigured push unavailable without fetching or allowing client-selected projects", async () => {
    const f = await fixture({ push: { enabled: false, projectId } }); await f.start(); f.complete(); await f.host.flush();
    expect(f.host.capabilities()).toEqual(["attention-v1"]); expect((await list(f)).unavailable).toBe(true); expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.enable()).rejects.toThrow("PUSH_SINK_UNAVAILABLE");
    const configured = await fixture(); await configured.start();
    await expect(attentionRpc(configured.host, configured.context, "attention.registerPush", { platform: "expo", tokenType: "expo", token: "ExpoPushToken[x]", projectId: "12c52f5d-f3a0-402a-bfba-872cb81e8f1e" })).rejects.toThrow("PUSH_PROJECT_MISMATCH");
    expect(configured.store.db.prepare("SELECT COUNT(*) AS n FROM attention_push_subscriptions").get()).toEqual({ n: 0 });
  });
  it("uses saved current lease scopes/generation and Session ACL for Direct/Relay RPC instead of payload actors", async () => {
    const f = await fixture(); await f.start(); f.question();
    await expect(attentionRpc(f.host, { leaseId: f.context.leaseId } as never, "attention.list", {})).rejects.toThrow("ATTENTION_CONTEXT_INVALID");
    const legacy = f.registry.openLease(f.device.id, { kind: "direct", generation: 0, protocolVersion: 2, close: vi.fn() });
    await expect(attentionRpc(f.host, { leaseId: legacy.leaseId, generation: 0 }, "attention.list", {})).rejects.toThrow("ATTENTION_NOT_NEGOTIATED");
    await expect(attentionRpc(f.host, { ...f.context, generation: 99 }, "attention.list", {})).rejects.toThrow("STALE_GENERATION");
    const relay = f.registry.openLease(f.device.id, { kind: "relay", generation: 2, protocolVersion: 2, capabilities: ["attention-v1"], close: vi.fn() }); const context = { leaseId: relay.leaseId, generation: 2 };
    await expect(attentionRpc(f.host, context, "attention.list", { deviceId: "forged", scopes: ["session:read"] })).rejects.toThrow("INVALID_PARAMS");
    await expect(attentionRpc(f.host, context, "attention.getPreferences", { actor: "forged" })).rejects.toThrow("INVALID_PARAMS");
    f.acl.clear(); expect((await attentionRpc(f.host, context, "attention.list", {}) as AttentionListResponse).items).toEqual([]);
    await expect(attentionRpc(f.host, context, "attention.list", { sessionId: f.session.id })).rejects.toThrow("FORBIDDEN");
    f.acl.add(f.session.id); f.store.db.prepare("UPDATE devices SET scopes_json=? WHERE id=?").run(JSON.stringify(["access:self"]), f.device.id);
    await expect(attentionRpc(f.host, context, "attention.list", {})).rejects.toThrow("FORBIDDEN");
  });
  it("fences a cached RPC port when global Host admission closes", async () => {
    let ready = true; const f = await fixture({ assertDeliveryReady: () => { if (!ready) throw new Error("HOST_DRAINING"); } }); await f.start();
    const cached = f.host.rpc()!; ready = false; expect(f.host.rpc()).toBeUndefined(); expect(f.host.capabilities()).toEqual([]);
    await expect(cached.handle(f.context, "attention.setPreferences", { mode: "none", pushEnabled: false, expectedRevision: 0 })).rejects.toThrow("HOST_DRAINING");
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM attention_preferences").get()).toEqual({ n: 0 }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("fails closed for async Session authorization and Host admission callbacks", async () => {
    const f = await fixture({ assertActorSession: async () => { throw new Error("private async denial"); } }); await f.start(); f.question();
    expect(f.rows()).toEqual([]); expect((await list(f)).items).toEqual([]);
    const bad = await fixture({ assertDeliveryReady: async () => {} }); expect(() => bad.host.start()).toThrow("ATTENTION_ADMISSION_ASYNC"); expect(bad.host.capabilities()).toEqual([]); expect(bad.fetch).not.toHaveBeenCalled();
    const denied = await fixture({ assertDeliveryReady: () => false }); expect(() => denied.host.start()).toThrow("ATTENTION_ADMISSION_INVALID"); expect(denied.fetch).not.toHaveBeenCalled();
  });
  it("cleans lease-specific foreground presence and reads fresh Device/ACL just before delivery", async () => {
    const inApp = vi.fn(async () => "presented" as const); const f = await fixture({ inApp }); await f.start(); await f.enable();
    await attentionRpc(f.host, f.context, "attention.setPresence", { foreground: true, sessionId: f.session.id });
    f.host.disconnect(f.context); const committed = f.complete(); await f.host.postCommitWake(committed.commitId!);
    expect(inApp).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
    const denied = await fixture(); await denied.start(); await denied.enable(); denied.complete(); denied.acl.clear(); await denied.host.flush();
    expect(denied.fetch).not.toHaveBeenCalled(); expect(denied.rows()[0]?.state).toBe("cancelled");
  });
  it("blocks all restore projection, RPC admission, and sends", async () => {
    const f = await fixture(); await f.start(); await f.enable(); f.complete(); gate(f.store);
    const before = f.rows(); expect(f.host.capabilities()).toEqual([]); await expect(f.host.flush()).rejects.toThrow(/RESTORE_/); expect(f.fetch).not.toHaveBeenCalled();
    await expect(attentionRpc(f.host, f.context, "attention.setPreferences", { mode: "none", pushEnabled: false, expectedRevision: 1 })).rejects.toThrow(/RESTORE_/);
    const head = f.store.getSession(f.session.id)!.headSequence;
    expect(() => f.store.commitEvent(f.session.id, "source.event", {})).toThrow(/RESTORE_/);
    expect(f.store.getSession(f.session.id)!.headSequence).toBe(head); expect(f.rows()).toEqual(before); expect(f.host.rpc()).toBeUndefined(); await expect(list(f)).rejects.toThrow(/RESTORE_/);
  });
  it("fences settlement when restore appears during a send and never replays the unknown dispatch", async () => {
    const f = await fixture(); await f.start(); await f.enable(); const held = hold();
    f.fetch.mockImplementationOnce(async () => { held.enter(); await held.barrier; return new Response(JSON.stringify({ data: { status: "ok", id: "late-ticket" } })); });
    f.complete(); const sending = f.host.flush(); await held.entered; expect(f.rows()[0]?.state).toBe("dispatching");
    gate(f.store, "malformed"); held.release(); await expect(sending).rejects.toThrow("RESTORE_GATE_INVALID"); expect(f.rows()[0]?.state).toBe("dispatching");
    await expect(f.host.flush()).rejects.toThrow("RESTORE_GATE_INVALID"); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("requires aftercommit Device revocation, aborts in-flight sends, and preserves cancellation", async () => {
    const f = await fixture(); await f.start(); await f.enable(); const held = hold(); let signal: AbortSignal | undefined;
    f.fetch.mockImplementationOnce(async (_url, options) => { signal = options?.signal ?? undefined; held.enter(); await held.barrier; return new Response(JSON.stringify({ data: { status: "ok", id: "late-ticket" } })); });
    f.complete(); const sending = f.host.flush(); await held.entered;
    expect(() => f.host.onDeviceRevoked(f.device.id)).toThrow("ATTENTION_REVOCATION_UNCOMMITTED");
    f.store.db.transaction(() => { f.store.db.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run(date, f.device.id); expect(() => f.host.onDeviceRevoked(f.device.id)).toThrow("ATTENTION_POST_COMMIT_REQUIRED"); })();
    f.host.onDeviceRevoked(f.device.id); expect(signal?.aborted).toBe(true); held.release(); await sending;
    expect(f.rows()[0]?.state).toBe("cancelled"); expect(f.store.db.prepare("SELECT revoked_at FROM attention_push_subscriptions").get()).toEqual({ revoked_at: date }); await f.host.flush(); expect(f.fetch).toHaveBeenCalledOnce();
    await expect(list(f)).rejects.toThrow("DEVICE_REVOKED");
  });
  it("reopens the owned schema, recovers dispatching to unknown, and sends no historical or accepted reminder twice", async () => {
    const f = await fixture(); await f.start(); await f.enable(); f.complete(); await f.host.flush();
    f.store.createTurn({ sessionId: f.session.id, turnId: "second", commandId: "second", requestHash: "second", prompt: "second", generation: 2 }); f.complete("second");
    f.store.db.prepare("UPDATE attention_deliveries SET state='dispatching',attempts=1 WHERE state='pending'").run();
    const originalCommit = f.facts()[0]!.source_commit_id;
    await f.host.drain(Date.now() + 1000); f.host.seal(); f.interaction.close(); f.registry.close(); f.store.close(); f.owner.release();
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, coordinationDirectory: f.coordinationDirectory }); owners.push(owner);
    const store = openOwned({ databasePath: f.databasePath, owner }); stores.push(store);
    const registry = new DeviceRegistry(store, hostId, { now: () => Date.parse(date) }); devices.push(registry);
    const engine = new CommandEngine(store); const interaction = new InteractionService(engine, { resolveSession: () => ({ provider: "claude" }) }); services.push(interaction);
    const restarted = createHostAttentionBindings({ ...f.options, store, owner, devices: registry, interactions: interaction, assertActorSession: (deviceId, sessionId) => { if (!store.getSession(sessionId) || !store.getDevice(deviceId) || store.getDevice(deviceId)?.revokedAt) throw new Error("FORBIDDEN"); } }); hosts.push(restarted); restarted.start(); await restarted.flush();
    expect(f.fetch).toHaveBeenCalledOnce(); expect(store.db.prepare("SELECT state,attempts FROM attention_deliveries ORDER BY state").all()).toEqual([{ state: "accepted", attempts: 1 }, { state: "outcome_unknown", attempts: 1 }]);
    expect(store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 12 });
    const lease = registry.openLease(f.device.id, { kind: "relay", generation: 3, protocolVersion: 2, capabilities: ["attention-v1"], close: vi.fn() });
    const view = await attentionRpc(restarted, { leaseId: lease.leaseId, generation: 3 }, "attention.list", {}) as AttentionListResponse; expect(view.items).toHaveLength(2);
    await restarted.postCommitWake(originalCommit).catch(() => {}); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("drains deliveries before detaching final commit projection and fences late SQL after seal", async () => {
    const f = await fixture(); await f.start(); await f.enable(); const held = hold();
    f.fetch.mockImplementationOnce(async () => { held.enter(); await held.barrier; return new Response(JSON.stringify({ data: { status: "ok", id: "late-ticket" } })); });
    f.question(); const sending = f.host.flush(); void sending.catch(() => {}); await held.entered;
    expect(await f.host.drain(Date.now() + 5)).toBe(false); await expect(f.host.shutdownService.drain(Date.now() + 5)).rejects.toThrow("ATTENTION_DRAIN_TIMEOUT"); expect(f.host.capabilities()).toEqual([]); expect(f.host.rpc()).toBeUndefined();
    // Keep the committed source on the fixture clock: the attention store's
    // fixed `now` and retention would otherwise expire the pinned question fact
    // as soon as the wall clock moved past the fixture date.
    f.store.commitCommand({ sessionId: f.session.id, occurredAt: date, build: () => ({ result: undefined,
      events: [{ type: "session.recovery.required", payload: { turnId: "turn" }, options: { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" } }] }) });
    expect(f.facts().map((item) => item.kind)).toEqual(["question", "recovery_blocked"]);
    f.host.seal(); const before = f.rows(); held.release(); await expect(sending).rejects.toThrow("ATTENTION_SEALED"); expect(f.rows()).toEqual(before); expect(f.fetch).toHaveBeenCalledOnce();
    expect(await f.host.drain(Date.now() + 1000)).toBe(true);
  });
});

describe("actual R07 committed terminal attention", () => {
  it.each([true, false])("keeps native completion and process-stop gate separate (stopped=%s)", async (stopped) => {
    const f = await fixture(); await f.start(); f.question(); const recovery = new RecoveryStore(f.store);
    recovery.recordNativeBinding({ context: f.nativeContext, provider: "claude", providerInstanceId: "fixture-instance", nativeSessionId: "private-native-session", workspacePath: f.session.workspacePath, configurationFingerprint: "fixture-policy", verifiedVersion: "fixture-verified" }, date);
    f.store.db.prepare("INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at) VALUES('process',?,?,'runtime',1,'attempt',?,'turn',123,123,'process_group','root_exited',?)").run(f.owner.ownerId, f.owner.generation, f.session.id, date);
    f.store.commitEvent(f.session.id, "session.recovery.required", { turnId: "turn" }, { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    const service = new RecoveryService({ store: f.store, now: () => date,
      inspectExecution: async () => stopped ? { state: "stopped", workspaceState: "clear", evidence: { kind: "process-tree-stopped", sourceId: "private-stop", ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, resourceKeys: f.owner.resourceKeys } } : { state: "unknown", workspaceState: "unknown" },
      inspectNative: async () => ({ state: "terminal", status: "completed", nativeSessionId: "private-native-session", evidence: { kind: "native-terminal", sourceId: "private-terminal", verifiedVersion: "fixture-verified", dispatchContext: f.nativeContext } }) });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" });
    expect(evidence.nativeOutcome).toBe("completed");
    const result = await service.reconcile({ authSubjectId: f.device.id, commandId: "recover", sessionId: f.session.id, turnId: "turn", attemptId: "attempt", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision });
    expect(result).toMatchObject({ turnStatus: "completed", gate: stopped ? "released" : "blocked" });
    const fact = f.facts().find((item) => item.kind === "completion")!; expect(fact).toBeDefined();
    expect(f.store.db.prepare("SELECT type FROM session_events WHERE id=?").get(fact.source_event_id)).toEqual({ type: "turn.recovery.reconciled" });
    expect(f.store.getTurn("turn")?.status).toBe("completed"); expect(f.interaction.interactions.get("question")?.status).toBe("superseded");
    expect(f.store.db.prepare("SELECT 1 FROM interaction_delivery_evidence WHERE kind='native-ack'").get()).toBeUndefined();
    expect((await list(f)).items.find((item) => item.kind === "recovery_blocked")?.stale).toBe(stopped);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("never treats actual unknown acknowledgement or failed recovery as completion", async () => {
    const f = await fixture(); await f.start(); f.question(); const recovery = new RecoveryStore(f.store);
    recovery.recordNativeBinding({ context: f.nativeContext, provider: "claude", providerInstanceId: "fixture-instance", nativeSessionId: "private-native-session", workspacePath: f.session.workspacePath, configurationFingerprint: "fixture-policy", verifiedVersion: "fixture-verified" }, date);
    f.store.db.prepare("INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at) VALUES('process',?,?,'runtime',1,'attempt',?,'turn',123,123,'process_group','root_exited',?)").run(f.owner.ownerId, f.owner.generation, f.session.id, date);
    f.store.commitEvent(f.session.id, "turn.unknown", { turnId: "turn" }, { turnId: "turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    expect(f.facts().map((item) => item.kind)).toEqual(["question"]);
    const service = new RecoveryService({ store: f.store, now: () => date,
      inspectExecution: async () => ({ state: "stopped", workspaceState: "clear", evidence: { kind: "process-tree-stopped", sourceId: "private-stop", ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, resourceKeys: f.owner.resourceKeys } }),
      inspectNative: async () => ({ state: "unknown", reason: "no_native_terminal" }) });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: "turn", attemptId: "attempt" });
    const input = { authSubjectId: f.device.id, sessionId: f.session.id, turnId: "turn", attemptId: "attempt", evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision };
    expect(await service.reconcile({ ...input, commandId: "failed-recover" })).toMatchObject({ state: "blocked", gate: "blocked", turnStatus: "outcome_unknown" });
    const blocked = f.facts().find((item) => item.kind === "recovery_blocked")!;
    expect(f.store.db.prepare("SELECT type FROM session_events WHERE id=?").get(blocked.source_event_id)).toEqual({ type: "recovery.operation.failed" });
    expect(await service.acknowledge({ ...input, commandId: "acknowledge-stopped", acknowledgeUnknown: true })).toMatchObject({ gate: "released", turnStatus: "outcome_unknown" });
    expect(f.facts().some((item) => item.kind === "completion")).toBe(false); expect(f.interaction.interactions.get("question")?.status).toBe("superseded");
    expect(f.store.db.prepare("SELECT 1 FROM interaction_delivery_evidence WHERE kind='native-ack'").get()).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled();
    const head = f.store.getSession(f.session.id)!.headSequence;
    expect(() => f.store.commitEvent(f.session.id, "turn.recovery.reconciled", { turnId: "turn", turnStatus: "completed", gate: "released", nativeEvidence: { state: "unknown" } })).toThrow("ATTENTION_SOURCE_MISMATCH");
    expect(f.store.getSession(f.session.id)!.headSequence).toBe(head);
  });
});
