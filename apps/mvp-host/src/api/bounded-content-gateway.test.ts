import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_CONTENT_CAPABILITY, ContentChunkSchema, type ContentRef } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { SessionOrchestrator, OrchestratorError } from "../session/orchestrator.js";
import { CONTENT_SCHEMA_SQL } from "../storage/migrations/006-content.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { ContentStore } from "../content/content-store.js";
import { ConnectionGateway, type DuplexTransport } from "./connection-gateway.js";

const HOST_ID = "bounded-host";
const open: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of open.splice(0)) close(); });

type Sent = Record<string, any>;
class MemoryTransport implements DuplexTransport {
  readonly id = randomUUID();
  readonly generation = 11;
  readonly sent: Sent[] = [];
  readonly bytes: number[] = [];
  readonly closes: string[] = [];
  private listeners = new Set<(frame: string) => void>();
  private closeListeners = new Set<(info: { code?: number; reason?: string }) => void>();
  private waiters: Array<{ predicate(frame: Sent): boolean; resolve(frame: Sent): void }> = [];
  private serial = 0;
  constructor(readonly kind: "direct" | "relay") {}
  async send(frame: string | Uint8Array): Promise<void> {
    const encoded = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
    const json = JSON.parse(encoded) as Sent;
    this.sent.push(json); this.bytes.push(Buffer.byteLength(encoded));
    for (const waiter of [...this.waiters]) if (waiter.predicate(json)) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(json);
    }
  }
  close(code?: number, reason?: string): void { this.closes.push(reason ?? "closed"); for (const fn of this.closeListeners) fn({ ...(code ? { code } : {}), ...(reason ? { reason } : {}) }); }
  onMessage(fn: (frame: string | Uint8Array) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  onClose(fn: (info: { code?: number; reason?: string }) => void): () => void { this.closeListeners.add(fn); return () => { this.closeListeners.delete(fn); }; }
  emit(frame: Record<string, unknown>): void { for (const fn of this.listeners) fn(JSON.stringify(frame)); }
  wait(predicate: (frame: Sent) => boolean): Promise<Sent> {
    const existing = this.sent.find(predicate);
    return existing ? Promise.resolve(existing) : new Promise((resolvePromise) => { this.waiters.push({ predicate, resolve: resolvePromise }); });
  }
  request(method: string, payload: unknown, version: 1 | 2 = 2): Promise<Sent> {
    const id = "request-" + ++this.serial;
    const result = this.wait((frame) => frame.type === "response" && frame.id === id);
    this.emit({ type: "request", id, method, payload, ...(version === 2 ? { transportGeneration: this.generation } : {}) });
    return result;
  }
  hello(deviceId: string, capabilities = [BOUNDED_CONTENT_CAPABILITY]): Promise<Sent> {
    const result = this.wait((frame) => frame.type === "server.hello" || frame.type === "protocol.error");
    this.emit({ type: "client.hello", clientId: "bounded-client", deviceId, hostId: HOST_ID, protocol: { min: 2, max: 2 }, capabilities, transportGeneration: this.generation });
    return result;
  }
}
function fixture(kind: "direct" | "relay" = "direct", content = true, maxFrameBytes = 256 * 1024) {
  const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
  // Keep this compatibility suite's explicit pre-views admission, even when the central runner installs006 by default.
  store.db.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
  const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures"), store, owner });
  if (content) orchestrator.store.db.exec(CONTENT_SCHEMA_SQL);
  const devices = new DeviceRegistry(orchestrator.store, HOST_ID);
  const device = devices.createBrowserDevice();
  const contentStore = content ? new ContentStore(orchestrator.store.db) : undefined;
  const gateway = new ConnectionGateway({ hostId: HOST_ID, fingerprint: "sha256:" + "a".repeat(64), orchestrator, devices, bootstrap: () => ({ stable: true }), descriptor: () => ({ hostId: HOST_ID }), confirmPairing: () => true, maxFrameBytes, ...(contentStore ? { contentStore } : {}) });
  const transport = new MemoryTransport(kind);
  gateway.attach(transport, { deviceId: device.id });
  open.push(() => { gateway.close(); devices.close(); orchestrator.close(); });
  return { orchestrator, devices, device, gateway, transport, contentStore };
}
async function read(transport: MemoryTransport, sessionId: string, ref: ContentRef): Promise<string> {
  let offset = 0;
  const text: string[] = [];
  for (;;) {
    const response = await transport.request("content.getChunk", { sessionId, ref: ref.ref, offset, maxBytes: 192 * 1024 });
    expect(response.ok).toBe(true);
    const chunk = ContentChunkSchema.parse(response.payload);
    expect(chunk.encoding).toBe("utf8");
    if (chunk.encoding === "utf8") text.push(chunk.text);
    if (!chunk.hasMore) break;
    offset = chunk.nextOffset;
  }
  const body = text.join("");
  expect(Buffer.byteLength(body)).toBe(ref.bytes);
  expect(createHash("sha256").update(body).digest("hex")).toBe(ref.sha256);
  return body;
}

describe("bounded RPC results keep the authenticated connection alive", () => {
  for (const kind of ["direct", "relay"] as const) it("serves a 300 KiB Diff and 1 MiB final through " + kind + " below 64 KiB", async () => {
    const { orchestrator, transport, device } = fixture(kind, true, 64 * 1024);
    await transport.hello(device.id);
    const rawDiff = ("diff " + orchestrator.workspace + "/文件 \"🚀\n").repeat(5_000);
    vi.spyOn(orchestrator, "gitDiff").mockResolvedValue({ available: true, dirty: true, files: [{ path: "file", index: " ", worktree: "M" }], diff: rawDiff, truncated: false });
    const diff = await transport.request("session.getDiff", { sessionId: orchestrator.sessionId });
    expect(diff.ok).toBe(true);
    expect(diff.payload).toMatchObject({ diffTruncated: true, boundedContent: { truncated: true, requiresUpgrade: false } });
    expect(await read(transport, orchestrator.sessionId, diff.payload.diffRef)).toBe(rawDiff.split(orchestrator.workspace).join("."));
    const rawText = ("正文🚀\n\t\"").repeat(100_000);
    expect(Buffer.byteLength(rawText)).toBeGreaterThanOrEqual(1024 * 1024);
    orchestrator.store.commitEvent(orchestrator.sessionId, "assistant.message.completed", { itemId: "large-final", text: rawText });
    const page = await transport.request("session.getEvents", { sessionId: orchestrator.sessionId });
    expect(page.ok).toBe(true);
    const final = page.payload.events[0].payload;
    expect(final.textTruncated).toBe(true);
    expect(await read(transport, orchestrator.sessionId, final.textRef)).toBe(rawText);
    expect((await transport.request("host.bootstrap", {})).payload).toEqual({ stable: true });
    expect(transport.bytes.every((bytes) => bytes <= 64 * 1024)).toBe(true);
    expect(transport.closes).toEqual([]);
  });

  it("marks large legacy Diff and replay events explicitly without closing the socket", async () => {
    const { orchestrator, transport } = fixture("direct", false);
    vi.spyOn(orchestrator, "gitDiff").mockResolvedValue({ available: true, dirty: true, files: [], diff: "x".repeat(300 * 1024), truncated: false });
    const diff = await transport.request("session.getDiff", {}, 1);
    expect(diff.payload).toMatchObject({ diffTruncated: true, boundedContent: { truncated: true, requiresUpgrade: true } });
    orchestrator.store.commitEvent(orchestrator.sessionId, "assistant.message.completed", { itemId: "large-final", text: "x".repeat(1024 * 1024) });
    const subscribed = await transport.request("session.subscribe", {}, 1);
    expect(subscribed.ok).toBe(true);
    const event = transport.sent.find((frame) => frame.type === "event")!;
    expect(event.event.payload).toMatchObject({ textTruncated: true, boundedContent: { requiresUpgrade: true } });
    expect((await transport.request("host.bootstrap", {}, 1)).ok).toBe(true);
    expect(transport.bytes.every((bytes) => bytes <= 192 * 1024)).toBe(true);
    expect(transport.closes).toEqual([]);
  });

  it("buffers a 1 MiB live final during an unfinished historical replay without closing", async () => {
    const { orchestrator, transport, device } = fixture();
    await transport.hello(device.id);
    orchestrator.store.commitEvent(orchestrator.sessionId, "system", { itemId: "first", text: "history" });
    let publish!: (event: ReturnType<SessionOrchestrator["timeline"]>["events"][number]) => void;
    vi.spyOn(orchestrator, "subscribe").mockImplementation((handler) => { publish = handler; return () => {}; });
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const waiting = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const send = transport.send.bind(transport);
    vi.spyOn(transport, "send").mockImplementation(async (raw) => {
      await send(raw);
      const frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as Sent;
      if (frame.type === "event" && frame.event.sequence === 1) { entered(); await barrier; }
    });
    const subscribed = transport.request("session.subscribe", {});
    await waiting;
    const live = orchestrator.store.commitEvent(orchestrator.sessionId, "assistant.message.completed", { itemId: "large-live", text: "z".repeat(1024 * 1024) });
    publish(live);
    release();
    expect((await subscribed).ok).toBe(true);
    const final = transport.sent.find((frame) => frame.type === "event" && frame.event.sequence === live.sequence)!;
    expect(final.event.payload).toMatchObject({ textTruncated: true, boundedContent: { requiresUpgrade: false } });
    expect(await read(transport, orchestrator.sessionId, final.event.payload.textRef)).toHaveLength(1024 * 1024);
    expect(transport.closes).toEqual([]);
  });

  it("enforces cross-Session reference, negotiated capability and content scope admission", async () => {
    const { orchestrator, transport, device, devices, contentStore, gateway } = fixture();
    await transport.hello(device.id);
    const second = orchestrator.store.createSession(orchestrator.workspace, "claude");
    const foreign = contentStore!.putBlob({ sessionId: second.id, format: "text/plain", text: "other Session" });
    const cross = await transport.request("content.getChunk", { sessionId: orchestrator.sessionId, ref: foreign.ref });
    expect(cross).toMatchObject({ ok: false, error: { code: "CONTENT_SCOPE_MISMATCH" } });
    const admin = contentStore!.putBlob({ sessionId: orchestrator.sessionId, format: "text/plain", text: "admin directory", requiredScope: "access:admin" });
    const limited = devices.createBrowserDevice({ scopes: ["session:read"] });
    const limitedTransport = new MemoryTransport("direct");
    gateway.attach(limitedTransport, { deviceId: limited.id });
    await limitedTransport.hello(limited.id);
    expect(await limitedTransport.request("content.getChunk", { sessionId: orchestrator.sessionId, ref: admin.ref })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const legacy = new MemoryTransport("direct");
    gateway.attach(legacy, { deviceId: device.id });
    await legacy.hello(device.id, []);
    expect(await legacy.request("content.getChunk", { sessionId: orchestrator.sessionId, ref: admin.ref })).toMatchObject({ ok: false, error: { code: "CAPABILITY_REQUIRED" } });
    expect(transport.closes).toEqual([]);
    devices.revokeSelf(device.id);
    expect(transport.closes).toContain("DEVICE_REVOKED");
  });

  it("paginates old event queries by encoded bytes and references oversized source ranges", async () => {
    const { orchestrator, transport, device } = fixture("direct", true, 4 * 1024);
    await transport.hello(device.id);
    for (let i = 0; i < 20; i += 1) orchestrator.store.commitEvent(orchestrator.sessionId, "system", { itemId: String(i), text: "x".repeat(1_000) });
    let afterSequence = 0;
    const consumed: number[] = [];
    for (;;) {
      const response = await transport.request("session.getEvents", { afterSequence });
      expect(response.ok).toBe(true);
      const page = response.payload;
      expect(page.events.length).toBeGreaterThan(0);
      consumed.push(...page.events.map((event: Sent) => Number(event.sequence)));
      afterSequence = page.nextAfter;
      if (!page.hasMore) break;
    }
    expect(consumed).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const sourceRanges = Array.from({ length: 10_000 }, (_, i) => ({ fromExclusive: i, through: i + 1 }));
    orchestrator.store.commitEvent(orchestrator.sessionId, "system", { itemId: "huge-source-range", sourceRanges });
    const response = await transport.request("session.getEvents", { afterSequence });
    const body = response.payload.events[0].payload;
    expect(body.payloadRef).toBeDefined();
    expect(JSON.parse(await read(transport, orchestrator.sessionId, body.payloadRef))).toEqual({ itemId: "huge-source-range", sourceRanges });
    expect(response.payload).toMatchObject({ nextAfter: 21, hasMore: false });
    expect(transport.closes).toEqual([]);
  });

  it("returns a bounded public business error for large failures and retains the connection", async () => {
    const { orchestrator, transport, device } = fixture("direct", true, 4 * 1024);
    await transport.hello(device.id);
    vi.spyOn(orchestrator, "gitDiff").mockRejectedValue(new OrchestratorError("DIFF_UNAVAILABLE", orchestrator.workspace + "x".repeat(256 * 1024)));
    const error = await transport.request("session.getDiff", {});
    expect(error).toMatchObject({ ok: false, error: { code: "DIFF_UNAVAILABLE", details: { truncated: true } } });
    expect(JSON.stringify(error)).not.toContain(orchestrator.workspace);
    expect((await transport.request("host.bootstrap", {})).ok).toBe(true);
    expect(transport.closes).toEqual([]);
    expect(transport.bytes.every((bytes) => bytes <= 4 * 1024)).toBe(true);
  });

  it("budgets receipts, pending interactions, device directories and diagnostics", async () => {
    const { orchestrator, transport, device, devices } = fixture("direct", true, 4 * 1024);
    await transport.hello(device.id);
    orchestrator.store.putCommandReceipt({ authSubjectId: device.id, commandId: "large-receipt", method: "session.startTurn", requestHash: "hash", state: "completed", response: { result: "x".repeat(512 * 1024) } });
    const receipt = await transport.request("command.getReceipt", { commandId: "large-receipt" });
    expect(receipt.ok).toBe(true);
    expect(receipt.payload.response.resultRef).toBeDefined();
    const snapshot = orchestrator.publicSnapshot();
    vi.spyOn(orchestrator, "publicSnapshot").mockReturnValue({ ...snapshot, pendingApprovals: Array.from({ length: 200 }, (_, i) => ({ approvalId: String(i), sessionId: orchestrator.sessionId, turnId: "turn", toolUseId: "tool", version: 0, status: "pending", request: { input: "x".repeat(5_000) }, createdAt: "2026-10-14" })) });
    const pending = await transport.request("host.getSnapshot", {});
    expect(pending.ok).toBe(true); expect(pending.payload.payloadRef).toBeDefined();
    for (let i = 0; i < 100; i += 1) devices.createBrowserDevice({ displayName: "large directory entry".repeat(5) });
    const directory = await transport.request("access.listDevices", {});
    expect(directory.ok).toBe(true); expect(directory.payload.payloadRef).toBeDefined();
    const provider = { provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace: orchestrator.workspace, sandboxRequired: true as const };
    vi.spyOn(orchestrator, "gitStatus").mockResolvedValue({ available: true, dirty: false, files: [] });
    vi.spyOn(orchestrator, "providerStatus").mockResolvedValue({ ...provider, diagnostics: "d".repeat(300 * 1024) } as Awaited<ReturnType<SessionOrchestrator["providerStatus"]>>);
    const status = await transport.request("host.getStatus", {});
    expect(status.ok).toBe(true);
    expect(transport.bytes.every((bytes) => bytes <= 4 * 1024)).toBe(true);
    expect(transport.closes).toEqual([]);
  });
});
