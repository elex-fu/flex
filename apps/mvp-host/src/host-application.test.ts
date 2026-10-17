import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_CONTENT_CAPABILITY, SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, AttentionCapability, RecoveryCapability, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY, OpenViewResponseSchema } from "@flyx/mvp-protocol";
import { ACCESS_RECEIPTS_CAPABILITY } from "./api/access-command-receipts.js";
import { parseConnectivityConfig } from "./connectivity/config.js";
import { createHostApplication } from "./host-application.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "./identity/host-identity.js";
import { HostOwnerLock } from "./lifecycle/host-owner.js";
import { SqliteProcessJournal } from "./lifecycle/managed-process-registry.js";
import { openOwned } from "./storage/open-store.js";
import { FROZEN_V6_SCHEMA } from "./test-support/frozen-v6-schema.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Frame = Record<string, unknown>;
const CAPS = [SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY,
  INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, AttentionCapability, RecoveryCapability, ACCESS_RECEIPTS_CAPABILITY,
  CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY];

async function fixture(pairingConfirmation: () => boolean | Promise<boolean> = () => true, legacyHistory = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-host-application-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data"), workspace = join(root, "workspace"); mkdirSync(data); mkdirSync(workspace);
  const databasePath = join(data, "host.sqlite"), identityDirectory = join(data, "identity");
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
  if (legacyHistory) {
    const raw = new Database(databasePath);
    try {
      raw.exec(FROZEN_V6_SCHEMA);
      raw.prepare("INSERT INTO content_storage_state(id,stored_bytes) VALUES(1,0)").run();
      for (const [index, provider] of (["claude", "codex"] as const).entries()) {
        const id = index === 0 ? "original-claude" : "newer-codex", at = `2026-10-${13 + index}T00:00:00.000Z`;
        raw.prepare("INSERT INTO sessions(id,workspace_id,workspace_path,provider,provider_session_id,status,activity_state,head_sequence,created_at,updated_at) VALUES(?,'default',?,?,?,'active','idle',1,?,?)")
          .run(id, workspace, provider, `private-native-${provider}`, at, at);
        raw.prepare("INSERT INTO session_events(id,session_id,sequence,type,payload_json,occurred_at) VALUES(?,?,1,'assistant.message.completed',?,?)")
          .run(`event-${provider}`, id, JSON.stringify({ itemId: `item-${provider}`, text: `saved ${provider} history` }), at);
      }
    } finally { raw.close(); }
  }
  const store = openOwned({ databasePath, owner });
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const application = await createHostApplication({ store, owner, identity,
    configuration: legacyHistory ? { legacyDefaultSessionId: "original-claude" } : { workspaces: [{ workspaceId: "workspace", root: workspace }],
      providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable: join(root, "does-not-exist"), policyCapabilities: ["workspaceWrite", "interrupt", "structuredQuestions"] }] },
    ...(!legacyHistory ? { initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" } } : {}),
    server: { pairingConfirmation, port: 0, webRoot: join(root, "no-web-build"),
      connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1", PORT: "4173" }) },
  });
  cleanup.push(async () => { try { await application.stop(); } catch { /* An unknown original producer deliberately retains ownership. */ } });
  return { root, databasePath, identityDirectory, owner, store, identity, application, sessionId: application.catalog.legacySessionId };
}

class SocketClient {
  private readonly frames: Frame[] = [];
  private readonly waiters = new Set<{ match(frame: Frame): boolean; resolve(frame: Frame): void }>();
  private sequence = 0;
  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame; this.frames.push(frame);
      for (const waiter of this.waiters) if (waiter.match(frame)) { this.waiters.delete(waiter); waiter.resolve(frame); }
    });
  }
  wait(match: (frame: Frame) => boolean): Promise<Frame> {
    const prior = this.frames.find(match); if (prior) return Promise.resolve(prior);
    return new Promise<Frame>((resolve) => this.waiters.add({ match, resolve }));
  }
  hello(hostId: string, deviceId: string) {
    const result = this.wait((frame) => frame.type === "server.hello");
    this.socket.send(JSON.stringify({ type: "client.hello", clientId: randomUUID(), deviceId, hostId,
      protocol: { min: 2, max: 2 }, transportGeneration: 3, capabilities: CAPS })); return result;
  }
  request(method: string, payload: unknown = {}, commandId?: string) {
    const id = `request-${++this.sequence}`, result = this.wait((frame) => frame.type === "response" && frame.id === id);
    this.socket.send(JSON.stringify({ type: "request", id, method, payload, transportGeneration: 3, ...(commandId ? { commandId } : {}) })); return result;
  }
}
async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const address = await f.application.start(), server = f.application.server;
  const credential = await server.auth.exchangePairingToken(server.auth.pairingUrlToken, "application-test");
  const cookie = server.auth.createBrowserSession(credential), subject = server.auth.sessionSubject(cookie)!;
  const deviceId = f.application.devices.getDeviceForAuthSession(subject)!.id;
  const url = new URL("/api/ws", address); url.protocol = "ws:"; url.searchParams.set("ticket", server.auth.issueTicket(subject));
  const socket = new WebSocket(url, { origin: address }), client = new SocketClient(socket);
  cleanup.push(() => socket.terminate());
  await new Promise<void>((yes, no) => { socket.once("open", yes); socket.once("error", no); });
  return { client, hello: await client.hello(f.identity.hostId, deviceId), deviceId };
}
function payload(frame: Frame): Record<string, unknown> { expect(frame.ok).toBe(true); return frame.payload as Record<string, unknown>; }

describe("production Host application graph", { timeout: 10000 }, () => {
  it("creates one complete read-only default and serves actual typed history without Git or an installed Provider", async () => {
    const f = await fixture(), { client, hello, deviceId } = await connect(f);
    expect(hello.capabilities).toEqual(expect.arrayContaining([SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY,
      BOUNDED_CONTENT_CAPABILITY, INTERACTION_CAPABILITY, ACCESS_RECEIPTS_CAPABILITY, RecoveryCapability, AttentionCapability]));
    for (const capability of [STRUCTURED_QUESTION_CAPABILITY, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY]) expect(hello.capabilities).not.toContain(capability);
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions s JOIN session_catalog c ON s.id=c.session_id").get()).toEqual({ count: 1 });
    expect(f.application.catalog.bootstrap().capabilities.interrupt).toBe(false);
    expect(payload(await client.request("session.list")).sessions).toHaveLength(1);
    expect(payload(await client.request("session.getSnapshot", { sessionId: f.sessionId })).session).toMatchObject({ sessionId: f.sessionId });
    expect(OpenViewResponseSchema.parse(payload(await client.request("session.openView", { sessionId: f.sessionId }))).sessionId).toBe(f.sessionId);
    expect(payload(await client.request("interaction.list", { sessionId: f.sessionId }))).toEqual({ interactions: [], hasMore: false });
    expect(payload(await client.request("host.doctor"))).toMatchObject({
      readiness: { status: "blocked", reasonCodes: expect.arrayContaining(["NATIVE_EXECUTION_UNVERIFIED"]) }, schema: { writable: false },
    });
    const write = await client.request("session.startTurn", { sessionId: f.sessionId, prompt: "must remain gated" }, "unverified-turn");
    expect(write.ok).toBe(false); expect((write.error as { code: string }).code).toBe("WORKSPACE_NOT_VERIFIED");
    expect(f.store.getCommandReceipt(deviceId, "unverified-turn")).toBeUndefined();
    expect(f.store.getActiveTurn(f.sessionId)).toBeUndefined();
    expect(f.application.catalog.registry.loaded(f.sessionId)).toBeUndefined();
    expect(await f.application.queryReadiness()).toMatchObject({ ready: false });
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM managed_processes").get()).toEqual({ count: 0 });
    const original = f.application.lifecycle.closeAndWait(); expect(f.application.lifecycle.closeAndWait()).toBe(original);
    expect(await original).toMatchObject({ closed: true, producerStopped: true, clean: true });
    expect(f.owner.retainedReason).toBeUndefined();
  });

  it("serves migrated Claude/Codex histories through the real Gateway while the original legacy default remains pinned", async () => {
    const f = await fixture(() => true, true), { client } = await connect(f);
    const listed = payload(await client.request("session.list"));
    expect(listed.sessions).toHaveLength(2);
    expect(f.application.catalog.legacySessionId).toBe("original-claude");
    for (const provider of ["claude", "codex"] as const) {
      const sessionId = provider === "claude" ? "original-claude" : "newer-codex";
      const snapshot = payload(await client.request("session.getSnapshot", { sessionId }));
      expect(snapshot.session).toMatchObject({ sessionId, provider, nativeSessionAvailable: true, residency: "unloaded" });
      const opened = OpenViewResponseSchema.parse(payload(await client.request("session.openView", { sessionId })));
      expect(opened.sessionId).toBe(sessionId);
      expect(opened.page.items.some((item) => item.itemId === `item-${provider}`)).toBe(true);
      expect(JSON.stringify([snapshot, opened])).not.toContain("private-native-");
      expect(JSON.stringify([snapshot, opened])).not.toContain(f.root);
      expect(f.application.catalog.registry.loaded(sessionId)).toBeUndefined();
    }
    expect(f.application.catalog.legacyHost.snapshot().session).toMatchObject({ id: "original-claude", provider: "claude" });
    expect(f.application.catalog.bootstrap().capabilities.streamingText).toBe(false);
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM managed_processes").get()).toEqual({ count: 0 });
    expect(await f.application.stop()).toBeUndefined();
    expect(f.store.db.open).toBe(false); expect(f.owner.retainedReason).toBeUndefined();
  });

  it("retains the original unknown launch while historical services remain readable and shutdown closes the Store", async () => {
    const f = await fixture();
    new SqliteProcessJournal(f.store.db).save({ id: "original-query", hostOwnerId: "original-owner", hostOwnerGeneration: 17,
      runtimeId: "original-query-runtime", runtimeGeneration: 4, attemptId: "original-attempt", state: "unknown", treeControl: "unavailable" });
    const { client, hello, deviceId } = await connect(f);
    expect(f.application.startupReadiness().ready).toBe(false);
    expect(f.owner.retainedReason).toBeUndefined();
    expect(hello.capabilities).toContain(SESSION_CATALOG_CAPABILITY); expect(hello.capabilities).not.toContain(AttentionCapability);
    expect(payload(await client.request("session.getSnapshot", { sessionId: f.sessionId })).session).toMatchObject({ sessionId: f.sessionId });
    const rename = await client.request("session.rename", { sessionId: f.sessionId, expectedRevision: 0, title: "denied" }, "retained-owner-write");
    expect(rename.ok).toBe(false); expect((rename.error as { code: string }).code).toMatch(/HOST_RECOVERY_REQUIRED|UNAVAILABLE|UNVERIFIED/);
    expect(f.store.getCommandReceipt(deviceId, "retained-owner-write")).toBeUndefined();
    expect(f.store.db.prepare("SELECT owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,state FROM managed_processes WHERE id='original-query'").get())
      .toEqual({ owner_id: "original-owner", owner_generation: 17, runtime_id: "original-query-runtime", runtime_generation: 4, attempt_id: "original-attempt", state: "unknown" });
    await expect(f.application.stop()).rejects.toMatchObject({ code: "SHUTDOWN_RECOVERY_REQUIRED" });
    expect(f.store.db.open).toBe(false); expect(f.owner.retainedReason).toBeTruthy();
  });

  it("fences credentials and device callbacks before Store close even when the physical transport close stalls", async () => {
    let approve!: (value: boolean) => void;
    const approval = new Promise<boolean>((yes) => { approve = yes; });
    let confirmations = 0;
    const f = await fixture(() => ++confirmations === 1 ? true : approval);
    let release!: () => void;
    const held = new Promise<void>((yes) => { release = yes; });
    f.application.server.app.addHook("onClose", async () => held);
    await connect(f);
    const pairing = f.application.server.auth.exchangePairingToken(f.application.server.auth.activeQrPairingToken(), "delayed-pair");
    void pairing.catch(() => {});
    try {
      await expect(f.application.lifecycle.closeAndWait(25)).rejects.toThrow("HOST_SHUTDOWN_DEADLINE");
      expect(f.store.db.open).toBe(false); expect(f.owner.retainedReason).toBeTruthy();
      const stopResult = await Promise.race([
        f.application.stop().then(() => "unexpected clean stop", (error: Error) => error.message),
        new Promise<string>((resolve) => setImmediate(() => resolve("still waiting for physical close"))),
      ]);
      expect(stopResult).toBe("HOST_SHUTDOWN_DEADLINE");
      const prepare = vi.spyOn(f.store.db, "prepare");
      try {
        approve(true); await expect(pairing).rejects.toMatchObject({ code: "HOST_SHUTDOWN" });
        f.application.devices.expireLeases();
        expect(() => f.application.server.getPairingUrl()).toThrow("Host transports are closed");
        expect(() => f.application.server.auth.issueTicket("closed-session")).toThrow("Host authentication is closed");
        expect(prepare).not.toHaveBeenCalled();
        release(); await held;
      } finally { prepare.mockRestore(); }
    } finally {
      approve(false); release(); await f.application.server.app.close();
    }
  });
});
