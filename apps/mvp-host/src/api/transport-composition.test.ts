import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AttentionCapability, BOUNDED_CONTENT_CAPABILITY, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, INTERACTION_CAPABILITY, OpenViewResponseSchema, RecoveryCapability, SESSION_CATALOG_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, WORKTREE_CAPABILITY, type SessionEvent } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { AccessError } from "../auth/connection-authorizer.js";
import { createHostAttentionBindings } from "../attention/host-attention.js";
import { createHostCatalogBindings } from "../catalog/host-catalog.js";
import { generateHostIdentity, getHostIdentityMirror } from "../identity/host-identity.js";
import { InteractionService } from "../interaction/interaction-service.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { CommandEngine } from "../orchestration/command-engine.js";
import { createHostServer } from "../server.js";
import { HostRecovery } from "../session/host-recovery.js";
import { createHostOperations, hostDiagnosticsRpc, HOST_DIAGNOSTICS_RPC_SCOPES } from "../operations/host-operations.js";
import { openOwned } from "../storage/open-store.js";
import { ConnectionGateway, type ConnectionGatewayOptions, type DuplexTransport } from "./connection-gateway.js";
import { AccessCommandReceipts, ACCESS_RECEIPTS_CAPABILITY } from "./access-command-receipts.js";
import type { SnapshotCoordinator } from "../operations/operation-files.js";
import type { RpcDomainPort } from "./rpc-dispatcher.js";
const HOST = "b097b6ad-95a3-4006-9829-0164b2221223";
const CAPS = [SESSION_CATALOG_CAPABILITY, BOUNDED_CONTENT_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, ACCESS_RECEIPTS_CAPABILITY, RecoveryCapability, AttentionCapability, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY];
type Frame = Record<string, unknown>;
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
  await close(); vi.restoreAllMocks(); });
function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function tick() { for (let index = 0; index < 3; index++)
  await new Promise<void>((resolve) => setImmediate(resolve)); }
class MemoryTransport implements DuplexTransport {
  readonly id = randomUUID();
  readonly kind = "direct" as const;
  readonly frames: Frame[] = [];
  readonly closed = barrier();
  readonly reasons: string[] = [];
  readonly messages = new Set<(frame: string | Uint8Array) => void>();
  readonly closes = new Set<(info: {
    code?: number;
    reason?: string;
  }) => void>();
  private readonly waiters = new Set<{
    matches(frame: Frame): boolean;
    resolve(frame: Frame): void;
  }>();
  private sequence = 0;
  hold?: (frame: Frame) => Promise<void>;
  constructor(readonly generation = 3) { }
  async send(raw: string | Uint8Array) { const frame = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")) as Frame; await this.hold?.(frame); this.frames.push(frame); for (const waiter of this.waiters)
    if (waiter.matches(frame)) {
      this.waiters.delete(waiter);
      waiter.resolve(frame);
    } }
  close(code?: number, reason?: string) { if (this.reasons.length)
    return; this.reasons.push(reason ?? "closed"); for (const close of this.closes)
    close({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }); this.closed.release(); }
  onMessage(handler: (frame: string | Uint8Array) => void) { this.messages.add(handler); return () => { this.messages.delete(handler); }; }
  onClose(handler: (info: {
    code?: number;
    reason?: string;
  }) => void) { this.closes.add(handler); return () => { this.closes.delete(handler); }; }
  emit(frame: unknown) { for (const handler of this.messages)
    handler(JSON.stringify(frame)); }
  wait(matches: (frame: Frame) => boolean) { const prior = this.frames.find(matches); if (prior)
    return Promise.resolve(prior); return new Promise<Frame>((resolve) => { this.waiters.add({ matches, resolve }); }); }
  hello(deviceId: string, capabilities = CAPS) { const result = this.wait((frame) => frame.type === "server.hello" || frame.type === "protocol.error"); this.emit({ type: "client.hello", hostId: HOST, deviceId, clientId: this.id, protocol: { min: 2, max: 2 }, transportGeneration: this.generation, capabilities }); return result; }
  request(method: string, payload: unknown = {}, commandId?: string) { const id = `request-${++this.sequence}`; const result = this.wait((frame) => frame.type === "response" && frame.id === id); this.emit({ type: "request", id, method, payload, transportGeneration: this.generation, ...(commandId ? { commandId } : {}) }); return result; }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-transport-composition-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"), workspace = join(checkout, "app");
  mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", checkout]);
  const owner = createTestHostOwner(), store = openOwned({ databasePath: ":memory:", owner });
  cleanup.push(() => { store.close(); owner.release(); });
  const identity = generateHostIdentity({ hostId: HOST });
  store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const devices = new DeviceRegistry(store, HOST);
  cleanup.push(() => devices.close());
  const actor = devices.createBrowserDevice(), restricted = devices.createBrowserDevice({ scopes: ["session:read"] });
  const denied = new Set<string>();
  const runtimeFactory = vi.fn(() => { throw new Error("Transport reads must not construct a Provider"); });
  const catalog = await createHostCatalogBindings({ store, owner, configuration: { workspaces: [{ workspaceId: "workspace", root: workspace }], providerInstances: [{ providerInstanceId: "provider", provider: "claude", executable: process.execPath, policyCapabilities: ["streamingText", "interactiveApprovals"] }] }, initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" }, runtimeFactory,
    assertSessionAccess: (_actor, target) => { if (denied.has(target.session.sessionId))
      throw new AccessError("FORBIDDEN", "Session grant changed"); } });
  cleanup.push(() => catalog.closeAndWait());
  const second = catalog.registry.createNew({ authSubjectId: actor.id, commandId: "create-second" }, { workspaceId: "workspace", providerInstanceId: "provider", title: "Second" }).summary.sessionId;
  const first = catalog.legacySessionId;
  const interactions = new InteractionService(new CommandEngine(store), { resolveSession: (id) => { const resource = catalog.registry.resolve(id); return { provider: resource.session.provider, workspaceId: resource.workspace.workspaceId }; }, evidenceSource: "fixture" });
  cleanup.push(() => interactions.close());
  const accessReceipts = new AccessCommandReceipts(devices);
  const options: ConnectionGatewayOptions = { hostId: HOST, fingerprint: identity.fingerprint, orchestrator: catalog.legacyHost, catalogPort: catalog, views: catalog.views!, devices, accessReceipts,
    interactionCapabilities: () => [INTERACTION_CAPABILITY], bootstrap: () => catalog.bootstrap(), descriptor: () => ({ hostId: HOST }), confirmPairing: () => true, maxFrameBytes: 64 * 1024 };
  const gateways: ConnectionGateway[] = [];
  cleanup.push(() => { for (const gateway of gateways)
    gateway.close(); });
  const gateway = (change: Partial<ConnectionGatewayOptions> = {}) => { const gateway = new ConnectionGateway({ ...options, ...change }); gateways.push(gateway); return gateway; };
  const connect = async (gateway: ConnectionGateway, device = actor, capabilities = CAPS) => { const transport = new MemoryTransport(); gateway.attach(transport, { deviceId: device.id }); const hello = await transport.hello(device.id, capabilities); return { transport, hello }; };
  const publish = (id: string, text: string) => { const committed = store.commitCommand({ sessionId: id, build: () => ({ result: undefined, events: [{ type: "assistant.message.completed", payload: { itemId: randomUUID(), text } }] }) })!; catalog.registry.publishCommittedEvents(committed.events); return committed; };
  return { root, workspace, store, owner, identity, devices, actor, restricted, catalog, first, second, interactions, accessReceipts, runtimeFactory, denied, options, gateway, connect, publish };
}
function payload(frame: Frame): Record<string, unknown> { expect(frame.ok).toBe(true); return frame.payload as Record<string, unknown>; }
function code(frame: Frame): string { expect(frame.ok).toBe(false); return (frame.error as {
  code: string;
}).code; }
class SocketClient {
  readonly frames: Frame[] = [];
  private sequence = 0;
  private readonly waiters = new Set<{
    matches(frame: Frame): boolean;
    resolve(frame: Frame): void;
  }>();
  constructor(readonly socket: WebSocket, readonly generation = 8) { socket.on("message", (raw) => { const frame = JSON.parse(raw.toString()) as Frame; this.frames.push(frame); for (const waiter of this.waiters)
    if (waiter.matches(frame)) {
      this.waiters.delete(waiter);
      waiter.resolve(frame);
    } }); }
  wait(matches: (frame: Frame) => boolean) { const prior = this.frames.find(matches); if (prior)
    return Promise.resolve(prior); return new Promise<Frame>((resolve) => this.waiters.add({ matches, resolve })); }
  hello(deviceId: string) { const result = this.wait((frame) => frame.type === "server.hello"); this.socket.send(JSON.stringify({ type: "client.hello", hostId: HOST, deviceId, clientId: randomUUID(), protocol: { min: 2, max: 2 }, capabilities: CAPS, transportGeneration: this.generation })); return result; }
  request(method: string, value: unknown = {}, commandId?: string) { const id = `socket-${++this.sequence}`; const result = this.wait((frame) => frame.type === "response" && frame.id === id); this.socket.send(JSON.stringify({ type: "request", id, method, payload: value, transportGeneration: this.generation, ...(commandId ? { commandId } : {}) })); return result; }
}
async function openSocket(address: string, ticket: string) { const url = new URL("/api/ws", address); url.protocol = "ws:"; url.searchParams.set("ticket", ticket); const socket = new WebSocket(url, { origin: address }); const client = new SocketClient(socket); await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }); cleanup.push(() => socket.terminate()); return client; }
describe("Host transport service composition", () => {
  it("uses the structural read-only Catalog facade for two Sessions and fresh typed directories without loading a Provider", async () => {
    const f = await fixture(), gateway = f.gateway(), { transport, hello } = await f.connect(gateway);
    expect(hello.capabilities).toEqual(expect.arrayContaining([SESSION_CATALOG_CAPABILITY, INTERACTION_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, ACCESS_RECEIPTS_CAPABILITY]));
    for (const cap of [STRUCTURED_QUESTION_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY, AttentionCapability, RecoveryCapability])
      expect(hello.capabilities).not.toContain(cap);
    const saved = f.store.getProtocolSession(String(hello.leaseId))!;
    expect(saved).toMatchObject({ deviceId: f.actor.id, protocolVersion: 2, transportGeneration: transport.generation });
    expect(saved.capabilities).not.toContain(STRUCTURED_QUESTION_CAPABILITY);
    expect((payload(await transport.request("session.list"))!.sessions as unknown[])).toHaveLength(2);
    expect(payload(await transport.request("session.getSnapshot", { sessionId: f.second })).session).toMatchObject({ sessionId: f.second });
    expect(payload(await transport.request("interaction.list", { sessionId: f.second }))).toEqual({ interactions: [], hasMore: false });
    expect(code(await transport.request("question.respond", { sessionId: f.second, interactionId: "question", expectedVersion: 0, answers: [] }, "question"))).toBe("CAPABILITY_REQUIRED");
    expect(f.store.getCommandReceipt(f.actor.id, "question")).toBeUndefined();
    f.denied.add(f.second);
    expect(code(await transport.request("session.getSnapshot", { sessionId: f.second }))).toBe("FORBIDDEN");
    expect(code(await transport.request("interaction.list", { sessionId: f.second }))).toBe("FORBIDDEN");
    expect(payload(await transport.request("host.getSnapshot")).session).toMatchObject({ id: f.first });
    expect(f.runtimeFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(transport.frames)).not.toContain(f.root);
  });
  it("never aliases a foreign read or explicit V2 write onto the legacy default when Catalog routing is absent", async () => {
    const f = await fixture(), { catalogPort: _catalog, ...options } = f.options;
    const gateway = new ConnectionGateway({ ...options, assertSessionScope: f.catalog.assertActorSession.bind(f.catalog) }); cleanup.push(() => gateway.close());
    const { transport } = await f.connect(gateway), timeline = vi.spyOn(f.catalog.legacyHost, "timeline");
    expect(code(await transport.request("session.getEvents", { sessionId: f.second }))).toBe("SESSION_NOT_FOUND");
    expect(timeline).not.toHaveBeenCalled();
    expect(code(await transport.request("session.startTurn", { sessionId: f.second, prompt: "must not use default" }, "no-catalog-write"))).toBe("SESSION_ROUTING_REQUIRED");
    expect(f.store.getCommandReceipt(f.actor.id, "no-catalog-write")).toBeUndefined();
    expect(OpenViewResponseSchema.parse(payload(await transport.request("session.openView", { sessionId: f.second }))).sessionId).toBe(f.second);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it("binds exact generic method scopes to the saved actor/lease and advertises only a currently ready injected domain", async () => {
    const f = await fixture();
    let ready = false;
    const dispatch = vi.fn<RpcDomainPort["dispatch"]>(async (frame, context) => { if (!context.capabilities?.has(CHECKPOINT_DIFF_CAPABILITY))
      throw new AccessError("CAPABILITY_REQUIRED", "Diff was not negotiated"); context.assertSessionScope!(String((frame.payload as {
      sessionId: string;
    }).sessionId), "session:read"); return { handled: true, payload: { actor: context.subjectId, leaseId: context.leaseId, protocolVersion: context.protocolVersion, generation: context.transportGeneration } }; });
    const port: RpcDomainPort = { ready: () => ready, capabilities: () => [CHECKPOINT_DIFF_CAPABILITY], methodScopes: { "checkpoint.getDiff": "session:read" }, dispatch };
    const gateway = f.gateway({ domainPorts: [port] });
    expect((await f.connect(gateway)).hello.capabilities).not.toContain(CHECKPOINT_DIFF_CAPABILITY);
    ready = true;
    const { transport, hello } = await f.connect(gateway);
    expect(hello.capabilities).toContain(CHECKPOINT_DIFF_CAPABILITY);
    expect(hello.capabilities).not.toContain(CHECKPOINT_REVERT_CAPABILITY);
    expect(payload(await transport.request("checkpoint.getDiff", { sessionId: f.second }))).toEqual({ actor: f.actor.id, leaseId: hello.leaseId, protocolVersion: 2, generation: transport.generation });
    expect(code(await transport.request("checkpoint.unregistered", { sessionId: f.second }))).toBe("METHOD_NOT_FOUND");
    f.denied.add(f.second);
    expect(code(await transport.request("checkpoint.getDiff", { sessionId: f.second }))).toBe("FORBIDDEN");
    ready = false;
    expect(gateway.capabilities()).not.toContain(CHECKPOINT_DIFF_CAPABILITY);
    expect(code(await transport.request("checkpoint.getDiff", { sessionId: f.first }))).toBe("CAPABILITY_REQUIRED");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("rejects an asynchronous target authorizer before selecting or mutating an Interaction port", async () => {
    const f = await fixture(), answer = vi.fn(() => ({ status: "accepted" }));
    const gateway = f.gateway({ assertSessionScope: async () => { throw new Error("late denial"); }, interactions: () => ({ rpc: answer }) });
    const { transport } = await f.connect(gateway);
    expect(code(await transport.request("interaction.respondApproval", { sessionId: f.second, interactionId: "approval", expectedVersion: 0, action: "deny" }, "async-auth"))).toBe("AUTHORIZATION_ASYNC");
    expect(answer).not.toHaveBeenCalled();
    expect(f.store.getCommandReceipt(f.actor.id, "async-auth")).toBeUndefined();
  });
  it("keeps approval-only grants valid while fencing the exact Session and command envelope", async () => {
    const f = await fixture(), approver = f.devices.createBrowserDevice({ scopes: ["approval:write"] });
    const answer = vi.fn((method: string, value: unknown, actor: {
      authSubjectId: string;
      commandId?: string;
    }) => ({ status: "accepted", method, value, actor }));
    const gateway = f.gateway({ interactions: () => ({ rpc: answer }) }), { transport } = await f.connect(gateway, approver);
    const request = { sessionId: f.second, interactionId: "approval", expectedVersion: 0, action: "deny" as const };
    expect(payload(await transport.request("interaction.respondApproval", request, "approval-command"))).toMatchObject({ status: "accepted", value: request, actor: { authSubjectId: approver.id, commandId: "approval-command" } });
    expect(code(await transport.request("interaction.get", { sessionId: f.second, interactionId: "approval" }))).toBe("FORBIDDEN");
    expect(code(await transport.request("interaction.respondApproval", request))).toBe("COMMAND_ID_REQUIRED");
    f.denied.add(f.second);
    expect(code(await transport.request("interaction.respondApproval", request, "blocked"))).toBe("FORBIDDEN");
    expect(answer).toHaveBeenCalledOnce();
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("revalidates all admitted Session scopes after an asynchronous service read before returning its body", async () => {
    const f = await fixture(), entered = barrier(), release = barrier();
    cleanup.push(() => release.release());
    const port: RpcDomainPort = { ready: () => true, capabilities: () => [CHECKPOINT_DIFF_CAPABILITY], methodScopes: { "checkpoint.getDiff": "session:read" },
      dispatch: async (_frame, context) => { context.assertSessionScope!(f.second, "session:read"); entered.release(); await release.promise; return { handled: true, payload: { body: "body from revoked target grant" } }; } };
    const gateway = f.gateway({ domainPorts: [port] }), { transport } = await f.connect(gateway);
    const response = transport.request("checkpoint.getDiff", { sessionId: f.second });
    await entered.promise;
    f.denied.add(f.second);
    release.release();
    expect(code(await response)).toBe("FORBIDDEN");
    expect(JSON.stringify(transport.frames)).not.toContain("body from revoked target grant");
  });
  it("admits scoped diagnostics from exact injected methods without querying a Provider", async () => {
    const f = await fixture();
    const operations = createHostOperations({ store: f.store, owner: f.owner }, { identityDirectory: join(f.root, "identity"), applicationVersion: "transport-test" });
    const dispatch = vi.fn<RpcDomainPort["dispatch"]>(async (frame, context) => { const principal = f.devices.assertLease(context.leaseId!, context.transportGeneration); return { handled: true, payload: hostDiagnosticsRpc(operations, frame.method, frame.payload, principal.scopes) }; });
    const port: RpcDomainPort = { methodScopes: HOST_DIAGNOSTICS_RPC_SCOPES, ready: () => f.store.db.open, capabilities: () => [], dispatch };
    const gateway = f.gateway({ domainPorts: [port] });
    const { transport } = await f.connect(gateway, f.restricted);
    expect(code(await transport.request("host.doctor"))).toBe("FORBIDDEN");
    expect(dispatch).not.toHaveBeenCalled();
    const reader = f.devices.createBrowserDevice({ scopes: ["host:read"] }), allowed = (await f.connect(gateway, reader)).transport;
    expect(payload(await allowed.request("host.doctor"))).toHaveProperty("schema");
    expect(code(await allowed.request("host.doctor", { arbitrary: true }))).toBe("INVALID_REQUEST");
    expect(code(await allowed.request("host.doctorPrivate"))).toBe("METHOD_NOT_FOUND");
    expect(JSON.stringify(allowed.frames)).not.toContain(f.root);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("routes unloaded Session recovery through the scoped binder and never falls back to a cached legacy recovery", async () => {
    const f = await fixture();
    let available = true;
    f.store.createTurn({ sessionId: f.second, prompt: "unloaded interrupted work", turnId: "recovery-turn", generation: 1, authSubjectId: f.actor.id, commandId: "old-start", requestHash: "old-start" });
    const recovery = new HostRecovery({ store: f.store, owner: f.owner, sessionId: f.second, workspace: f.workspace, provider: "claude" });
    const inspect = vi.spyOn(recovery, "inspect"), binder = vi.fn((id: string) => { f.catalog.registry.resolve(id); return available && id === f.second ? recovery : undefined; });
    const legacyInspect = vi.fn(recovery.inspect.bind(recovery));
    const gateway = f.gateway({ recoveryForSession: binder, recoveryCapabilities: () => available ? [RecoveryCapability] : [], recovery: { inspect: legacyInspect, reconcile: recovery.reconcile.bind(recovery), acknowledge: recovery.acknowledge.bind(recovery) } });
    const { transport, hello } = await f.connect(gateway, f.restricted);
    expect(hello.capabilities).toContain(RecoveryCapability);
    expect(payload(await transport.request("session.recovery.inspect", { sessionId: f.second, turnId: "recovery-turn" }))).toMatchObject({ sessionId: f.second, nativeState: "unknown", processState: "unknown" });
    expect(code(await transport.request("session.recovery.reconcile", { sessionId: f.second, turnId: "recovery-turn", evidenceId: "missing", expectedRecoveryRevision: 0 }, "recover"))).toBe("FORBIDDEN");
    f.denied.add(f.second);
    expect(code(await transport.request("session.recovery.inspect", { sessionId: f.second, turnId: "recovery-turn" }))).toBe("FORBIDDEN");
    expect(inspect).toHaveBeenCalledOnce();
    f.denied.clear();
    available = false;
    expect(gateway.capabilities()).not.toContain(RecoveryCapability);
    expect(code(await transport.request("session.recovery.inspect", { sessionId: f.second, turnId: "recovery-turn" }))).toBe("CAPABILITY_REQUIRED");
    expect(legacyInspect).not.toHaveBeenCalled();
    expect(f.runtimeFactory).not.toHaveBeenCalled();
    expect(f.store.getCommandReceipt(f.restricted.id, "recover")).toBeUndefined();
  });
  it("checks each selected Session for canonical pages, content and live delivery after an ACL change", async () => {
    const f = await fixture(), gateway = f.gateway(), { transport } = await f.connect(gateway);
    f.publish(f.first, "first only");
    f.publish(f.second, "second only");
    const a = OpenViewResponseSchema.parse(payload(await transport.request("session.openView", { sessionId: f.first })));
    const b = OpenViewResponseSchema.parse(payload(await transport.request("session.openView", { sessionId: f.second })));
    expect(a.page.items.every((item) => item.sessionId === f.first)).toBe(true);
    expect(b.page.items.every((item) => item.sessionId === f.second)).toBe(true);
    const content = f.catalog.views!.content.putBlob({ sessionId: f.second, format: "text/plain", text: "second private body", workspace: f.workspace });
    expect(payload(await transport.request("content.getChunk", { sessionId: f.second, ref: content.ref, offset: 0 })).text).toBe("second private body");
    expect(code(await transport.request("content.getChunk", { sessionId: f.first, ref: content.ref, offset: 0 }))).toBe("CONTENT_SCOPE_MISMATCH");
    f.denied.add(f.second);
    expect(code(await transport.request("timeline.getPage", { sessionId: f.second, epoch: b.watermark.epoch, direction: "after", afterSequence: 0, upToSequence: b.watermark.sequence }))).toBe("FORBIDDEN");
    expect(code(await transport.request("content.getChunk", { sessionId: f.second, ref: content.ref, offset: 0 }))).toBe("FORBIDDEN");
    const before = transport.frames.filter((frame) => frame.type === "event" && frame.sessionId === f.second).length;
    f.publish(f.second, "must not leak after grant changed");
    f.publish(f.first, "first still authorized");
    await transport.wait((frame) => frame.type === "event" && frame.sessionId === f.first);
    await tick();
    expect(transport.frames.filter((frame) => frame.type === "event" && frame.sessionId === f.second)).toHaveLength(before);
    expect(JSON.stringify(transport.frames)).not.toContain("must not leak");
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("never spills a multi-Session authorized directory into a single-Session reusable content reference", async () => {
    const f = await fixture(), put = vi.spyOn(f.catalog.views!.content, "putBlob");
    const port: RpcDomainPort = { ready: () => true, capabilities: () => [], methodScopes: { "session.list": "session:read" },
      dispatch: async (_frame, context) => { context.assertSessionScope!(f.first, "session:read"); context.assertSessionScope!(f.second, "session:read"); return { handled: true, payload: { directory: "private second Session metadata ".repeat(12000) } }; } };
    const gateway = f.gateway({ domainPorts: [port] }), { transport } = await f.connect(gateway);
    const response = payload(await transport.request("session.list"));
    expect(response.boundedContent).toMatchObject({ truncated: true, requiresUpgrade: true });
    expect(response).not.toHaveProperty("directoryRef");
    expect(response).not.toHaveProperty("payloadRef");
    expect(put).not.toHaveBeenCalled();
  });
  it("rechecks Session ACL at queued callback delivery rather than retaining a stale admitted resource", async () => {
    const f = await fixture(), gateway = f.gateway(), { transport } = await f.connect(gateway);
    await transport.request("session.openView", { sessionId: f.first });
    await transport.request("session.openView", { sessionId: f.second });
    const entered = barrier(), release = barrier();
    cleanup.push(() => release.release());
    transport.hold = async (frame) => { if (frame.type === "event" && frame.sessionId === f.first) {
      entered.release();
      await release.promise;
    } };
    f.publish(f.first, "block outbound");
    await entered.promise;
    f.publish(f.second, "queued second body");
    await tick();
    f.denied.add(f.second);
    release.release();
    await transport.closed.promise;
    expect(transport.frames.some((frame) => frame.type === "event" && frame.sessionId === f.second)).toBe(false);
    expect(JSON.stringify(transport.frames)).not.toContain("queued second body");
  });
  it("uses real Attention readiness and stored negotiation and disconnects the original lease after admission closes", async () => {
    const f = await fixture();
    let admission = true;
    const attention = createHostAttentionBindings({ store: f.store, owner: f.owner, hostId: HOST, devices: f.devices, interactions: f.interactions,
      assertActorSession: (actor, id) => f.catalog.assertActorSession(actor, id, "session:read"), assertDeliveryReady: () => { if (!admission)
        throw new Error("HOST_DRAINING"); }, trackDelivery: (work) => work(), pollMs: 60000 });
    cleanup.push(async () => { await attention.drain(Date.now() + 1000); attention.seal(); });
    const gateway = f.gateway({ attention });
    expect(gateway.capabilities()).not.toContain(AttentionCapability);
    attention.start();
    await attention.flush();
    const { transport, hello } = await f.connect(gateway);
    expect(hello.capabilities).toContain(AttentionCapability);
    expect(payload(await transport.request("attention.list"))).toMatchObject({ items: [], unavailable: true });
    expect(code(await transport.request("attention.registerPush", { platform: "expo", tokenType: "expo", token: "ExpoPushToken[test]", projectId: randomUUID() }))).toBe("PUSH_SINK_UNAVAILABLE");
    expect(payload(await transport.request("attention.setPresence", { foreground: true, sessionId: f.second }))).toEqual({ foreground: true });
    const disconnect = vi.spyOn(attention, "disconnect");
    f.store.db.prepare("UPDATE protocol_sessions SET capability_json=? WHERE id=?").run("[]", hello.leaseId);
    expect(code(await transport.request("attention.getPreferences"))).toBe("ATTENTION_NOT_NEGOTIATED");
    admission = false;
    expect(gateway.capabilities()).not.toContain(AttentionCapability);
    transport.close(1001, "Host draining");
    expect(disconnect).toHaveBeenCalledWith({ leaseId: hello.leaseId, generation: transport.generation });
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("persists exact V2 Access receipts over a real WebSocket and keeps shared registry ownership with the global lifecycle", async () => {
    const f = await fixture();
    let server!: ReturnType<typeof createHostServer>;
    const shutdown = vi.fn(async () => { await server.closeTransports(); return { stopped: true, recoveryRequired: false }; });
    server = createHostServer({ ...f.options, orchestrator: f.catalog.legacyHost, identity: f.identity, devices: f.devices, lifecycle: { shutdown }, port: 0, pairingConfirmation: () => true });
    cleanup.push(() => server.stop());
    const address = await server.start();
    const credential = f.devices.issueRefreshCredential(f.actor.id, Buffer.alloc(32, 7).toString("base64url"));
    const ticket = await server.app.inject({ method: "POST", url: "/api/auth/device-ticket", payload: { refreshCredential: credential.refreshCredential } });
    expect(ticket.statusCode).toBe(200);
    const client = await openSocket(address, String(ticket.json().ticket));
    const hello = await client.hello(f.actor.id);
    expect(f.store.getProtocolSession(String(hello.leaseId))).toMatchObject({ deviceId: f.actor.id, protocolVersion: 2, transportGeneration: client.generation });
    const observer = f.devices.createBrowserDevice(), observerCredential = f.devices.issueRefreshCredential(observer.id, Buffer.alloc(32, 8).toString("base64url"));
    const observerClient = await openSocket(address, server.auth.issueDeviceTicket(observerCredential.refreshCredential).ticket);
    await observerClient.hello(observer.id);
    const observerClosed = new Promise<number>((resolve) => observerClient.socket.once("close", resolve));
    const result = payload(await client.request("access.revokeDevice", { deviceId: f.restricted.id }, "revoke-target"));
    expect(result).toEqual({ ok: true, revoked: true });
    const receipt = f.store.getCommandReceipt(f.actor.id, "revoke-target")!;
    expect(receipt).toMatchObject({ requestFormatVersion: 2, state: "completed", method: "access.revokeDevice" });
    expect(receipt.targetSessionId).toBeUndefined();
    expect(payload(await client.request("command.getReceipt", { commandId: "revoke-target" }))).toEqual({ found: false, commandId: "revoke-target" });
    expect(payload(await client.request("access.getReceipt", { commandId: "revoke-target" }))).toMatchObject({ found: true, response: result });
    expect(payload(await client.request("access.revokeDevice", { deviceId: f.restricted.id }, "revoke-target"))).toEqual(result);
    const closed = new Promise<{
      code: number;
      reason: string;
    }>((resolve) => client.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    expect(payload(await client.request("access.revokeSelf", {}, "revoke-self"))).toEqual({ ok: true, revoked: true });
    expect(await closed).toEqual({ code: 4401, reason: "DEVICE_REVOKED" });
    expect(f.store.getCommandReceipt(f.actor.id, "revoke-self")?.state).toBe("completed");
    expect(observerClient.socket.readyState).toBe(WebSocket.OPEN);
    await server.stop();
    await server.stop();
    await observerClosed;
    expect(observerClient.socket.readyState).toBe(WebSocket.CLOSED);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(f.store.db.open).toBe(true);
    expect(f.devices.createBrowserDevice().hostId).toBe(HOST);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("forwards the shared snapshot lane and original persisted identity pin to actual Relay registration", async () => {
    const f = await fixture();
    const laneEntered = vi.fn(), fallbackEntered = vi.fn();
    const snapshotLane: SnapshotCoordinator = async <T>(work: () => Promise<T>) => { laneEntered(); f.owner.assertActive(); expect(f.store.db.open).toBe(true); return work(); };
    const fallbackLane: SnapshotCoordinator = async <T>(work: () => Promise<T>) => { fallbackEntered(); return work(); };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { expect(f.store.db.inTransaction).toBe(false); throw new Error("unpaid offline Relay fixture"); });
    const server = createHostServer({ ...f.options, identity: f.identity, devices: f.devices, snapshotLane, lifecycle: { shutdown: async () => ({ stopped: true, recoveryRequired: false }) }, identityDirectory: join(f.root, "identity"),
      connectivity: { mode: "relay", bindHost: "127.0.0.1", port: 4173, localOrigin: "http://127.0.0.1:4173", allowInsecureHttp: false, requireTailscaleServe: false, relayEnabled: true, relayUrl: "wss://relay.example", hostedAppUrl: "https://app.example" }, relayOptions: { withSnapshot: fallbackLane, fetch } });
    cleanup.push(() => server.stop());
    await server.app.ready();
    await server.relay!.start();
    expect(laneEntered).toHaveBeenCalled();
    expect(fallbackEntered).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    await server.relay!.stop();
    f.store.rotateHostIdentityMirror({ hostId: HOST, fingerprint: "rotated" }, getHostIdentityMirror(f.identity));
    await expect(server.relay!.start()).rejects.toMatchObject({ code: "RELAY_IDENTITY_CHANGED" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.runtimeFactory).not.toHaveBeenCalled();
    f.store.rotateHostIdentityMirror(getHostIdentityMirror(f.identity), { hostId: HOST, fingerprint: "rotated" });
  });
  it("rolls browser grant/device/session and logout mutations back without publishing socket closure", async () => {
    const f = await fixture();
    const server = createHostServer({ ...f.options, identity: f.identity, devices: f.devices, lifecycle: { shutdown: async () => ({ stopped: true, recoveryRequired: false }) }, pairingConfirmation: () => true });
    cleanup.push(() => server.stop());
    await server.app.ready();
    const grant = server.auth.pairingUrlToken;
    f.store.db.exec("CREATE TRIGGER browser_device_failure BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT,'device insertion failed'); END");
    expect((await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: grant } })).statusCode).toBe(403);
    expect(f.store.hasActivePairingGrant(createHash("sha256").update(grant).digest("hex"))).toBe(true);
    f.store.db.exec("DROP TRIGGER browser_device_failure");
    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: grant } });
    expect(exchange.statusCode).toBe(200);
    const credential = String(exchange.json().credential);
    f.store.db.exec("CREATE TRIGGER browser_session_failure BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT,'session insertion failed'); END");
    expect((await server.app.inject({ method: "POST", url: "/api/auth/browser-session", payload: { credential } })).statusCode).toBe(403);
    f.store.db.exec("DROP TRIGGER browser_session_failure");
    const browser = await server.app.inject({ method: "POST", url: "/api/auth/browser-session", payload: { credential } });
    expect(browser.statusCode).toBe(200);
    const cookies = browser.headers["set-cookie"], cookie = String(Array.isArray(cookies) ? cookies[0] : cookies).split(";")[0]!, raw = cookie.slice("flyx_session=".length);
    const auth = f.store.findAuthSession(createHash("sha256").update(raw).digest("hex"))!, device = f.devices.getDeviceForAuthSession(auth.id)!;
    const close = vi.fn(() => { expect(f.store.db.inTransaction).toBe(false); expect(f.store.getAuthSession(auth.id)?.revokedAt).toBeDefined(); expect(f.devices.getDevice(device.id)?.revokedAt).toBeDefined(); });
    const lease = f.devices.openLease(device.id, { kind: "direct", generation: 1, protocolVersion: 1, authSessionId: auth.id, close });
    f.store.db.exec(`CREATE TRIGGER browser_logout_failure BEFORE UPDATE OF revoked_at ON devices WHEN OLD.id='${device.id}' BEGIN SELECT RAISE(ABORT,'device revoke failed'); END`);
    const ticket = server.auth.issueTicket(auth.id);
    expect((await server.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(500);
    expect(f.store.getAuthSession(auth.id)?.revokedAt).toBeUndefined();
    expect(f.devices.getDevice(device.id)?.revokedAt).toBeUndefined();
    expect(f.devices.assertLease(lease.leaseId).deviceId).toBe(device.id);
    expect(close).not.toHaveBeenCalled();
    expect(server.auth.consumeTicket(ticket)?.deviceId).toBe(device.id);
    f.store.db.exec("DROP TRIGGER browser_logout_failure");
    const outstanding = server.auth.issueTicket(auth.id);
    expect((await server.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(200);
    expect(close).toHaveBeenCalledOnce();
    expect(server.auth.consumeTicket(outstanding)).toBeUndefined();
  });
});
