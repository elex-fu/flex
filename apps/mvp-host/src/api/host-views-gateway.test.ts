import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_CONTENT_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, OpenViewResponseSchema, TimelinePageSchema, TimelinePageContentSchema, TimelineUpdatedPayloadSchema, ContentChunkSchema, type TimelineContentReference } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { TimelineBackfill } from "../timeline/backfill.js";
import { applyViewsMigration } from "../timeline/host-views.js";
import type { ProviderAdapter } from "../provider/types.js";
import { ConnectionGateway, type DuplexTransport } from "./connection-gateway.js";

const HOST = "views-host"; const CAPS = [BOUNDED_CONTENT_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY];
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
type Sent = Record<string, any>;
class Transport implements DuplexTransport {
  readonly id = randomUUID(); readonly sent: Sent[] = []; readonly bytes: number[] = []; readonly closes: string[] = [];
  readonly incoming = new Set<(frame: string | Uint8Array) => void>(); readonly closing = new Set<(info: { code?: number; reason?: string }) => void>();
  private waiters: Array<{ test(frame: Sent): boolean; resolve(frame: Sent): void }> = []; private serial = 0;
  beforeSend?: (frame: Sent) => Promise<void>;
  constructor(readonly kind: "direct" | "relay", readonly generation = 11) {}
  async send(raw: string | Uint8Array) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw); const frame = JSON.parse(text) as Sent;
    await this.beforeSend?.(frame);
    this.sent.push(frame); this.bytes.push(Buffer.byteLength(text));
    for (const waiter of [...this.waiters]) if (waiter.test(frame)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(frame); }
  }
  close(_code?: number, reason?: string) { this.closes.push(reason ?? "closed"); for (const callback of this.closing) callback({ ...(reason ? { reason } : {}) }); }
  onMessage(fn: (frame: string | Uint8Array) => void) { this.incoming.add(fn); return () => { this.incoming.delete(fn); }; }
  onClose(fn: (info: { code?: number; reason?: string }) => void) { this.closing.add(fn); return () => { this.closing.delete(fn); }; }
  emit(frame: unknown) { for (const fn of this.incoming) fn(JSON.stringify(frame)); }
  wait(test: (frame: Sent) => boolean): Promise<Sent> { const old = this.sent.find(test); return old ? Promise.resolve(old) : new Promise((resolve) => this.waiters.push({ test, resolve })); }
  request(method: string, payload: unknown, legacy = false, idOverride?: string) { const id = idOverride ?? `rpc-${++this.serial}`; const result = this.wait((frame) => frame.type === "response" && frame.id === id); this.emit({ type: "request", id, method, payload, ...(legacy ? {} : { transportGeneration: this.generation }) }); return result; }
  hello(deviceId: string, capabilities = CAPS, requiredCapabilities?: string[]) { const result = this.wait((frame) => frame.type === "server.hello" || frame.type === "protocol.error"); this.emit({ type: "client.hello", hostId: HOST, deviceId, clientId: "views-client", protocol: { min: 2, max: 2 }, capabilities, ...(requiredCapabilities ? { requiredCapabilities } : {}), transportGeneration: this.generation }); return result; }
}
function fixture(kind: "direct" | "relay" = "direct", options: { migrated?: boolean; enabled?: boolean; scopes?: string[] } = {}) {
  const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
  if (options.migrated !== false) applyViewsMigration(store, owner);
  else store.db.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const status = { provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true as const };
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => status, preflight: async () => status, runTurn: vi.fn(async () => ({ status: "completed", providerSessionId: "fixture-native" } as const)), interrupt: vi.fn(async () => "already_terminal" as const), respondApproval: vi.fn(() => false) };
  const orchestrator = new SessionOrchestrator({ workspace, store, owner, adapter, enableViews: options.enabled ?? true });
  const devices = new DeviceRegistry(store, HOST); const device = devices.createBrowserDevice(options.scopes ? { scopes: options.scopes } : {});
  const gateway = new ConnectionGateway({ hostId: HOST, fingerprint: "sha256:" + "a".repeat(64), orchestrator, devices, bootstrap: () => orchestrator.bootstrap(), descriptor: () => ({ hostId: HOST }), confirmPairing: () => true, maxFrameBytes: 64 * 1024 });
  const transport = new Transport(kind); gateway.attach(transport, { deviceId: device.id });
  cleanup.push(() => { gateway.close(); devices.close(); orchestrator.close(); });
  const publish = (events: Array<{ type: string; payload?: unknown }>) => orchestrator.commandEngine.commitRequest({ authSubjectId: device.id, commandId: randomUUID(), method: "test.publish", requestHash: "fixture", targetSessionId: orchestrator.sessionId }, () => ({ result: {}, events: events.map((event) => ({ type: event.type, payload: event.payload ?? {} })) }));
  return { owner, store, orchestrator, adapter, devices, device, gateway, transport, publish };
}
async function read(transport: Transport, sessionId: string, ref: TimelineContentReference) {
  const parts: string[] = []; let offset = 0;
  for (;;) { const response = await transport.request("content.getChunk", { sessionId, ref: ref.ref, offset, maxBytes: 192 * 1024 }); expect(response.ok).toBe(true); const chunk = ContentChunkSchema.parse(response.payload); if (chunk.encoding !== "utf8") throw new Error("Expected public text"); parts.push(chunk.text); offset = chunk.nextOffset; if (!chunk.hasMore) break; }
  const text = parts.join(""); expect(Buffer.byteLength(text)).toBe(ref.bytes); expect(createHash("sha256").update(text).digest("hex")).toBe(ref.sha256); return text;
}
async function settle() { for (let index = 0; index < 4; index++) await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("owned Host canonical views through the real Gateway", () => {
  for (const kind of ["direct", "relay"] as const) it(`opens a 10k-source cold view and completes fixed-W catch-up over ${kind}`, async () => {
    const f = fixture(kind);
    for (let batch = 0; batch < 1_000; batch++) f.publish(Array.from({ length: 10 }, (_, offset) => { const seq = batch * 10 + offset + 1; return seq % 16 === 1 ? { type: "user.message.created", payload: { itemId: `item-${seq}`, text: `message ${seq}` } } : { type: "provider.heartbeat" }; }));
    const hello = await f.transport.hello(f.device.id); expect(hello.capabilities).toContain(TIMELINE_PROJECTION_CAPABILITY);
    const cold = OpenViewResponseSchema.parse((await f.transport.request("session.openView", { sessionId: f.orchestrator.sessionId, tailLimit: 20 })).payload);
    expect(cold.page.items).toHaveLength(20); expect(cold.page.hasOlder).toBe(true); expect(cold.watermark.sequence).toBe(10_000);
    expect(f.transport.sent.filter((frame) => frame.type === "event")).toEqual([]);
    const opened = OpenViewResponseSchema.parse((await f.transport.request("session.openView", { sessionId: f.orchestrator.sessionId, cursor: { epoch: cold.watermark.epoch, sequence: 0 } })).payload);
    let page = opened.page; let cursor = 0; const ids = new Set<string>();
    for (;;) {
      expect(page.coveredSourceRange?.fromExclusive).toBe(cursor);
      const items = page.pageRef ? TimelinePageContentSchema.parse(JSON.parse(await read(f.transport, f.orchestrator.sessionId, page.pageRef))).items : page.items;
      for (const item of items) ids.add(item.itemId);
      cursor = page.nextCursor!.sequence; if (cursor === opened.watermark.sequence) break;
      page = TimelinePageSchema.parse((await f.transport.request("timeline.getPage", { sessionId: f.orchestrator.sessionId, epoch: opened.watermark.epoch, direction: "after", afterSequence: cursor, upToSequence: opened.watermark.sequence })).payload);
    }
    expect(cursor).toBe(10_000); expect(ids.size).toBe(625);
    expect((await f.transport.request("session.subscribe", {})).error.code).toBe("SUBSCRIPTION_MODE_CONFLICT");
    f.publish([{ type: "provider.heartbeat" }]); const live = await f.transport.wait((frame) => frame.type === "event");
    expect(live.event.type).toBe("timeline.updated"); expect(TimelineUpdatedPayloadSchema.parse(live.event.payload).coveredSourceRange).toEqual({ fromExclusive: 10_000, through: 10_001 });
    f.transport.close(1001, "reconnect");
    const next = new Transport(kind, 12); f.gateway.attach(next, { deviceId: f.device.id }); await next.hello(f.device.id);
    const reopened = OpenViewResponseSchema.parse((await next.request("session.openView", { sessionId: f.orchestrator.sessionId, tailLimit: 20 })).payload);
    expect(reopened.page.items).toHaveLength(20); expect(reopened.watermark.sequence).toBe(10_001); expect(next.sent.filter((frame) => frame.type === "event")).toEqual([]);
    f.publish([{ type: "provider.heartbeat" }]); await next.wait((frame) => frame.type === "event");
    expect(f.transport.sent.filter((frame) => frame.type === "event")).toHaveLength(1);
    expect([...f.transport.bytes, ...next.bytes].every((bytes) => bytes <= 64 * 1024)).toBe(true);
  }, 20_000);

  for (const kind of ["direct", "relay"] as const) it(`keeps a 1MiB final and 300KiB Diff bounded through ${kind}`, async () => {
    const f = fixture(kind); await f.transport.hello(f.device.id);
    const opened = OpenViewResponseSchema.parse((await f.transport.request("session.openView", { sessionId: f.orchestrator.sessionId })).payload);
    const text = ("正文🚀\n\t\"" + f.orchestrator.workspace).repeat(100_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(text.split(f.orchestrator.workspace).join("."))).toBeGreaterThan(1024 * 1024);
    f.publish([{ type: "assistant.message.completed", payload: { itemId: "large", text } }]);
    const event = await f.transport.wait((frame) => frame.type === "event"); const live = TimelineUpdatedPayloadSchema.parse(event.event.payload);
    const item = live.items[0]!; if (!("ref" in item.content)) throw new Error("Expected large immutable body");
    expect(await read(f.transport, f.orchestrator.sessionId, item.content)).toBe(text.split(f.orchestrator.workspace).join("."));
    const diff = ("diff 文件🚀 \"\n" + f.orchestrator.workspace).repeat(20_000);
    expect(Buffer.byteLength(diff.split(f.orchestrator.workspace).join("."))).toBeGreaterThan(300 * 1024);
    vi.spyOn(f.orchestrator, "gitDiff").mockResolvedValue({ available: true, dirty: true, files: [], diff, truncated: false });
    const response = await f.transport.request("session.getDiff", { sessionId: f.orchestrator.sessionId }); expect(response.ok).toBe(true); expect(response.payload.diffRef).toBeDefined();
    expect(await read(f.transport, f.orchestrator.sessionId, response.payload.diffRef)).toBe(diff.split(f.orchestrator.workspace).join("."));
    expect((await f.transport.request("timeline.unsubscribe", { subscriptionId: opened.subscriptionId })).payload).toEqual({ removed: true });
    expect(f.transport.closes).toEqual([]); expect(f.transport.bytes.every((bytes) => bytes <= 64 * 1024)).toBe(true);
  });

  for (const kind of ["direct", "relay"] as const) it(`preserves an oversized complete batch and expired epoch errors over ${kind}`, async () => {
    const f = fixture(kind); await f.transport.hello(f.device.id);
    const first = OpenViewResponseSchema.parse((await f.transport.request("session.openView", { sessionId: f.orchestrator.sessionId })).payload);
    f.publish(Array.from({ length: 500 }, (_, index) => ({ type: "tool.call.started", payload: { itemId: `batch-tool-${index}`, toolName: "shell", input: { description: '\"\n🙂'.repeat(600) } } })));
    const notification = await f.transport.wait((frame) => frame.type === "event");
    const live = TimelineUpdatedPayloadSchema.parse(notification.event.payload);
    expect(live.coveredSourceRange).toEqual({ fromExclusive: 0, through: 500 });
    expect(live.pageRef?.itemCount).toBe(500); expect(live.items).toEqual([]); expect(live.boundaryComplete).toBe(true);
    const original = await read(f.transport, f.orchestrator.sessionId, live.pageRef!);
    const materialized = TimelinePageContentSchema.parse(JSON.parse(original));
    expect(materialized.items).toHaveLength(500); expect(materialized.epoch).toBe(first.watermark.epoch);
    expect(materialized.coveredSourceRange).toEqual(live.coveredSourceRange);
    const catchup = TimelinePageSchema.parse((await f.transport.request("timeline.getPage", { sessionId: f.orchestrator.sessionId, epoch: first.watermark.epoch, direction: "after", afterSequence: 0, upToSequence: 500 }, false, "request_" + "x".repeat(120))).payload);
    expect(catchup.nextCursor?.sequence).toBe(500); expect(catchup.pageRef?.itemCount).toBe(500);
    expect((await f.transport.request("timeline.getPage", { sessionId: f.orchestrator.sessionId, epoch: first.watermark.epoch, direction: "after", afterSequence: 3, upToSequence: 500 })).error.code).toBe("TIMELINE_COMMIT_BOUNDARY");
    f.publish([{ type: "tool.call.completed", payload: { itemId: "batch-tool-0", output: "later" } }]);
    expect(await read(f.transport, f.orchestrator.sessionId, live.pageRef!)).toBe(original);
    expect(materialized.items.find((item) => item.itemId === "batch-tool-0")!.status).toBe("running");
    const replacement = f.orchestrator.views!.projector.createEpoch(f.orchestrator.sessionId);
    const backfill = new TimelineBackfill(f.orchestrator.views!.projector); backfill.run(f.orchestrator.sessionId, { epoch: replacement.epoch });
    expect((await f.transport.request("timeline.getPage", { sessionId: f.orchestrator.sessionId, epoch: first.watermark.epoch, direction: "after", afterSequence: 0, upToSequence: 500 })).error.code).toBe("TIMELINE_CURSOR_EXPIRED");
    expect((await f.transport.request("timeline.subscribe", { sessionId: f.orchestrator.sessionId, epoch: replacement.epoch })).ok).toBe(true);
    expect(f.transport.closes).toEqual([]); expect(f.transport.bytes.every((bytes) => bytes <= 64 * 1024)).toBe(true);
  });

  it("sends openView's response before releasing held live notifications", async () => {
    const f = fixture(); await f.transport.hello(f.device.id);
    let enter!: () => void; let release!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }); const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.transport.beforeSend = async (frame) => { if (frame.type === "response" && frame.ok && frame.payload?.subscriptionId) { enter(); await barrier; } };
    const opening = f.transport.request("session.openView", { sessionId: f.orchestrator.sessionId }); await entered;
    f.publish([{ type: "provider.heartbeat" }]); await settle(); expect(f.transport.sent.filter((frame) => frame.type === "event")).toEqual([]);
    release(); const response = await opening; const event = await f.transport.wait((frame) => frame.type === "event");
    expect(f.transport.sent.indexOf(response)).toBeLessThan(f.transport.sent.indexOf(event));
    expect(TimelineUpdatedPayloadSchema.parse(event.event.payload).coveredSourceRange).toEqual({ fromExclusive: 0, through: 1 });
  });

  it("never sends a second RPC response when lease validation fails after the response barrier", async () => {
    const f = fixture(); const transport = new Transport("direct", 12); let current = true;
    f.gateway.attach(transport, { deviceId: f.device.id, assertCurrent: () => { if (!current) throw new Error("lease invalidated"); } });
    await transport.hello(f.device.id);
    transport.beforeSend = async (frame) => { if (frame.type === "response" && frame.ok) current = false; };
    const response = await transport.request("session.openView", { sessionId: f.orchestrator.sessionId }); expect(response.ok).toBe(true);
    await settle(); expect(transport.sent.filter((frame) => frame.type === "response" && frame.id === response.id)).toHaveLength(1);
    f.publish([{ type: "provider.heartbeat" }]); await settle(); expect(transport.sent.filter((frame) => frame.type === "event")).toEqual([]);
  });

  it("gates canonical capabilities on migration, feature admission and client negotiation", async () => {
    const missing = fixture("direct", { migrated: false }); const hello = await missing.transport.hello(missing.device.id);
    expect(hello.capabilities).not.toContain(TIMELINE_PROJECTION_CAPABILITY);
    expect((await missing.transport.request("session.openView", { sessionId: missing.orchestrator.sessionId })).error.code).toBe("CAPABILITY_REQUIRED");
    const disabled = fixture("direct", { enabled: false }); expect((await disabled.transport.hello(disabled.device.id)).capabilities).not.toContain(TIMELINE_PROJECTION_CAPABILITY);
    const legacy = fixture(); await legacy.transport.hello(legacy.device.id, [BOUNDED_CONTENT_CAPABILITY]);
    expect((await legacy.transport.request("session.openView", { sessionId: legacy.orchestrator.sessionId })).error.code).toBe("CAPABILITY_REQUIRED");
    legacy.publish([{ type: "user.message.created", payload: { itemId: "legacy", text: "legacy" } }]);
    expect((await legacy.transport.request("session.subscribe", {})).ok).toBe(true);
    expect(legacy.transport.sent.find((frame) => frame.type === "event")!.event.type).toBe("user.message.created");
    const dependency = fixture(); expect((await dependency.transport.hello(dependency.device.id, [TIMELINE_PROJECTION_CAPABILITY], [TIMELINE_PROJECTION_CAPABILITY])).error.code).toBe("CAPABILITY_UNSUPPORTED");
  });

  it("enforces read scope, strict method payloads and Session ownership for content references", async () => {
    const denied = fixture("direct", { scopes: ["host:read"] }); await denied.transport.hello(denied.device.id);
    expect((await denied.transport.request("session.openView", { sessionId: denied.orchestrator.sessionId })).error.code).toBe("FORBIDDEN");
    const f = fixture(); await f.transport.hello(f.device.id);
    expect((await f.transport.request("session.openView", { sessionId: f.orchestrator.sessionId, workspace: "/arbitrary" })).error.code).toBe("INVALID_REQUEST");
    expect((await f.transport.request("session.openView", { sessionId: "other-session" })).error.code).toBe("SESSION_NOT_FOUND");
    const other = f.store.createSession(f.orchestrator.workspace, "claude");
    const ref = f.orchestrator.views!.content.putBlob({ sessionId: other.id, format: "text/plain", text: "other session", workspace: f.orchestrator.workspace });
    expect((await f.transport.request("content.getChunk", { sessionId: f.orchestrator.sessionId, ref: ref.ref })).error.code).toBe("CONTENT_SCOPE_MISMATCH");
    expect((await f.transport.request("content.getChunk", { sessionId: other.id, ref: ref.ref })).error.code).toBe("SESSION_NOT_FOUND");
    const actorRef = f.orchestrator.views!.content.putBlob({ sessionId: f.orchestrator.sessionId, format: "text/plain", text: "actor only", subjectId: "another-device" });
    expect((await f.transport.request("content.getChunk", { sessionId: f.orchestrator.sessionId, ref: actorRef.ref })).error.code).toBe("CONTENT_SCOPE_MISMATCH");
    const reader = fixture("direct", { scopes: ["session:read"] }); await reader.transport.hello(reader.device.id);
    const scopeRef = reader.orchestrator.views!.content.putBlob({ sessionId: reader.orchestrator.sessionId, format: "text/plain", text: "admin only", requiredScope: "access:admin" });
    expect((await reader.transport.request("content.getChunk", { sessionId: reader.orchestrator.sessionId, ref: scopeRef.ref })).error.code).toBe("FORBIDDEN");
    expect(f.transport.closes).toEqual([]);
  });
});
