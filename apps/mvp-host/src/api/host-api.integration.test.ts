import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import WebSocket from "ws";
import { DEVICE_SCOPES } from "../auth/connection-authorizer.js";
import { DeviceRegistry } from "../auth/device-registry.js";
import type { ConnectivityConfig } from "../connectivity/config.js";
import { generateHostIdentity } from "../identity/host-identity.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { createHostServer, type HostServer } from "../server.js";
import { DeterministicAdapter } from "../test-support/deterministic-adapter.js";
import { ConnectionGateway, type DuplexTransport } from "./connection-gateway.js";

const WORKSPACE = resolve(process.cwd(), "../../packages/claude-fixtures");

type JsonFrame = Record<string, unknown>;
type CloseInfo = { code?: number; reason?: string };

/** A transport with the same ordering and callback shape as the production
 * transports, while keeping gateway tests independent of a real socket. */
class MemoryTransport implements DuplexTransport {
  readonly id = randomUUID();
  readonly sent: string[] = [];
  readonly closes: CloseInfo[] = [];
  private readonly messageHandlers = new Set<(frame: string | Uint8Array) => void>();
  private readonly closeHandlers = new Set<(info: CloseInfo) => void>();
  private isClosed = false;

  constructor(readonly kind: "direct" | "relay", readonly generation: number) {}

  async send(frame: string | Uint8Array): Promise<void> {
    this.sent.push(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
  }

  close(code = 1000, reason = "CLOSED"): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const close = { code, reason };
    this.closes.push(close);
    for (const handler of this.closeHandlers) handler(close);
  }

  onMessage(handler: (frame: string | Uint8Array) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (info: CloseInfo) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  receive(frame: JsonFrame | string | Uint8Array): void {
    const encoded = typeof frame === "string" || frame instanceof Uint8Array ? frame : JSON.stringify(frame);
    for (const handler of this.messageHandlers) handler(encoded);
  }

  frames(): JsonFrame[] { return this.sent.map((frame) => JSON.parse(frame) as JsonFrame); }
}

type GatewayFixture = {
  orchestrator: SessionOrchestrator;
  adapter: DeterministicAdapter;
  identity: ReturnType<typeof generateHostIdentity>;
  devices: DeviceRegistry;
  gateway: ConnectionGateway;
  device: NonNullable<ReturnType<DeviceRegistry["getDevice"]>>;
  stop: () => void;
};

function randomPublicKey(): string {
  return randomBytes(32).toString("base64url");
}

type ReadyGateway = GatewayFixture;

async function readyGateway(scopes: readonly string[] = DEVICE_SCOPES): Promise<ReadyGateway> {
  // Keep construction and cleanup synchronous for the test runner; pairing is
  // awaited here at the one async boundary required by DeviceRegistry.
  let orchestratorRef: SessionOrchestrator | undefined;
  const adapter = new DeterministicAdapter({ workspace: WORKSPACE, onEvent: (event) => orchestratorRef?.ingestAdapterEvent(event) });
  const orchestrator = new SessionOrchestrator({ workspace: WORKSPACE, adapter });
  orchestratorRef = orchestrator;
  const identity = generateHostIdentity();
  const devices = new DeviceRegistry(orchestrator.store, identity.hostId);
  const grant = devices.createPairingGrant({ scopes: [...scopes] });
  const device = await devices.pair({ grant: grant.grant, proposedDevicePublicKey: randomPublicKey(), deviceInfo: { displayName: "API test", platform: "test" } }, () => true);
  const gateway = new ConnectionGateway({
    hostId: identity.hostId,
    fingerprint: identity.fingerprint,
    orchestrator,
    devices,
    bootstrap: () => orchestrator.bootstrap(),
    descriptor: () => ({ hostId: identity.hostId, fingerprint: identity.fingerprint }),
    assertIdentity: () => undefined,
    confirmPairing: () => true,
  });
  return {
    orchestrator, adapter, identity, devices, gateway, device,
    stop: () => { gateway.close(); devices.close(); orchestrator.close(); },
  };
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!predicate(value)) {
    if (Date.now() >= deadline) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 5));
    value = read();
  }
  return value;
}

async function waitForFrame(transport: MemoryTransport, predicate: (frame: JsonFrame) => boolean, timeoutMs = 3_000): Promise<JsonFrame> {
  return waitFor(() => transport.frames(), (frames) => frames.some(predicate), timeoutMs).then((frames) => frames.find(predicate)!);
}

async function sendV2Hello(fixture: ReadyGateway, transport: MemoryTransport) {
  fixture.gateway.attach(transport, { deviceId: fixture.device.id });
  transport.receive({
    type: "client.hello",
    clientId: "api-test-client",
    deviceId: fixture.device.id,
    hostId: fixture.identity.hostId,
    protocol: { min: 2, max: 2 },
    capabilities: ["heartbeat", "transport-neutral-rpc"],
    transportGeneration: transport.generation,
  });
  return waitForFrame(transport, (frame) => frame.type === "server.hello");
}

function localConnectivity(overrides: Partial<ConnectivityConfig> = {}): ConnectivityConfig {
  return {
    mode: "local",
    bindHost: "127.0.0.1",
    port: 4173,
    localOrigin: "http://127.0.0.1:4173",
    requireTailscaleServe: false,
    allowInsecureHttp: true,
    relayEnabled: false,
    ...overrides,
  };
}

function createDeterministicServer(connectivity: ConnectivityConfig, options: { port?: number } = {}): { server: HostServer; orchestrator: SessionOrchestrator; adapter: DeterministicAdapter } {
  let orchestratorRef: SessionOrchestrator | undefined;
  const adapter = new DeterministicAdapter({ workspace: WORKSPACE, onEvent: (event) => orchestratorRef?.ingestAdapterEvent(event) });
  const orchestrator = new SessionOrchestrator({ workspace: WORKSPACE, adapter, canReleaseWorkspace: () => true });
  orchestratorRef = orchestrator;
  const server = createHostServer({ orchestrator, pairingConfirmation: () => true, connectivity, ...(options.port === undefined ? {} : { port: options.port }) });
  return { server, orchestrator, adapter };
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (typeof value === "string" ? value : "").split(";", 1)[0] ?? "";
}

async function openWebSocket(url: string, origin: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { origin } });
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(new Error("TEST_WS_OPEN_FAILED"));
    socket.once("open", resolve);
    socket.once("error", fail);
  });
  return socket;
}

async function waitForSocketFrame(socket: WebSocket, predicate: (frame: JsonFrame) => boolean, timeoutMs = 3_000): Promise<JsonFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("TEST_WS_FRAME_TIMEOUT")); }, timeoutMs);
    const receive = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as JsonFrame;
      if (!predicate(frame)) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(frame);
    };
    socket.on("message", receive);
  });
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.close();
  });
}

const openResources: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (openResources.length) await openResources.pop()!(); });

describe("Host HTTP and Direct v1 API", () => {
  it("pairs over HTTP, upgrades to Direct v1, and exposes receipts plus timeline events", async () => {
    const { server, orchestrator } = createDeterministicServer(localConnectivity(), { port: 0 });
    openResources.push(() => server.stop());
    const address = await server.start();

    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    expect(exchange.statusCode).toBe(200);
    const browser = await server.app.inject({ method: "POST", url: "/api/auth/browser-session", payload: { credential: exchange.json().credential } });
    expect(browser.statusCode).toBe(200);
    const cookie = cookieFrom(browser);
    expect(cookie).toContain("flyx_session=");
    const ticketResponse = await server.app.inject({ method: "POST", url: "/api/auth/websocket-ticket", headers: { cookie } });
    expect(ticketResponse.statusCode).toBe(200);

    const socket = await openWebSocket(`${address}/api/ws?ticket=${encodeURIComponent(ticketResponse.json().ticket)}`, address);
    openResources.push(() => closeWebSocket(socket));
    socket.send(JSON.stringify({ type: "request", id: "v1-snapshot", method: "host.getSnapshot", payload: {} }));
    const snapshot = await waitForSocketFrame(socket, (frame) => frame.type === "response" && frame.id === "v1-snapshot");
    expect(snapshot).toMatchObject({ type: "response", id: "v1-snapshot", ok: true });
    expect(snapshot).not.toHaveProperty("transportGeneration");

    socket.send(JSON.stringify({ type: "request", id: "v1-start", method: "session.startTurn", commandId: "v1-command", payload: { prompt: "scenario:text" } }));
    const accepted = await waitForSocketFrame(socket, (frame) => frame.type === "response" && frame.id === "v1-start");
    expect(accepted).toMatchObject({ type: "response", id: "v1-start", ok: true, payload: { status: "accepted" } });
    expect(accepted).not.toHaveProperty("transportGeneration");

    const deviceId = server.devices.listDevices()[0]!.id;
    await waitFor(() => server.devices.store.getCommandReceipt(deviceId, "v1-command"), (receipt) => receipt?.state === "completed");
    socket.send(JSON.stringify({ type: "request", id: "v1-receipt", method: "command.getReceipt", payload: { commandId: "v1-command" } }));
    const receipt = await waitForSocketFrame(socket, (frame) => frame.type === "response" && frame.id === "v1-receipt");
    expect(receipt).toMatchObject({ type: "response", id: "v1-receipt", ok: true, payload: { found: true, commandId: "v1-command", method: "session.startTurn", state: "completed" } });

    socket.send(JSON.stringify({ type: "request", id: "v1-events", method: "session.getEvents", payload: { sessionId: orchestrator.sessionId, afterSequence: 0, limit: 200 } }));
    const events = await waitForSocketFrame(socket, (frame) => frame.type === "response" && frame.id === "v1-events");
    expect(events).toMatchObject({ type: "response", id: "v1-events", ok: true });
    const payload = events.payload as { events: Array<{ sequence: number; type: string; payload: unknown }> };
    expect(payload.events.length).toBeGreaterThan(0);
    expect(payload.events.map((event) => event.sequence)).toEqual([...payload.events].map((event) => event.sequence).sort((a, b) => a - b));
    expect(payload.events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(JSON.stringify(payload.events)).not.toContain(WORKSPACE);
  });
});

describe("Host v2 gateway", () => {
  it("negotiates hello, echoes the transport generation, streams a resumed timeline, and rejects stale generations", async () => {
    const fixture = await readyGateway();
    openResources.push(fixture.stop);
    const transport = new MemoryTransport("relay", 7);
    const hello = await sendV2Hello(fixture, transport);
    expect(hello).toMatchObject({ type: "server.hello", hostId: fixture.identity.hostId, hostFingerprint: fixture.identity.fingerprint, protocolVersion: 2, transportGeneration: 7 });
    expect((hello.capabilities as string[])).toContain("timeline-resume");

    transport.receive({ type: "request", id: "v2-snapshot", method: "host.getSnapshot", payload: {}, transportGeneration: 7 });
    const snapshot = await waitForFrame(transport, (frame) => frame.type === "response" && frame.id === "v2-snapshot");
    expect(snapshot).toMatchObject({ type: "response", id: "v2-snapshot", ok: true, transportGeneration: 7 });

    transport.receive({ type: "request", id: "v2-start", method: "session.startTurn", commandId: "v2-command", payload: { prompt: "scenario:text" }, transportGeneration: 7 });
    const accepted = await waitForFrame(transport, (frame) => frame.type === "response" && frame.id === "v2-start");
    expect(accepted).toMatchObject({ type: "response", id: "v2-start", ok: true, payload: { status: "accepted" }, transportGeneration: 7 });
    await waitFor(() => fixture.orchestrator.store.getCommandReceipt(fixture.device.id, "v2-command"), (receipt) => receipt?.state === "completed");

    transport.receive({ type: "request", id: "v2-receipt", method: "command.getReceipt", payload: { commandId: "v2-command" }, transportGeneration: 7 });
    const receipt = await waitForFrame(transport, (frame) => frame.type === "response" && frame.id === "v2-receipt");
    expect(receipt).toMatchObject({ type: "response", id: "v2-receipt", ok: true, payload: { found: true, state: "completed" }, transportGeneration: 7 });

    transport.receive({ type: "request", id: "v2-subscribe", method: "session.subscribe", payload: { sessionId: fixture.orchestrator.sessionId, afterSequence: 0 }, transportGeneration: 7 });
    const subscribed = await waitForFrame(transport, (frame) => frame.type === "response" && frame.id === "v2-subscribe");
    expect(subscribed).toMatchObject({ type: "response", id: "v2-subscribe", ok: true, transportGeneration: 7 });
    const events = transport.frames().filter((frame) => frame.type === "event");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((frame) => frame.transportGeneration === 7)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(WORKSPACE);

    // The gateway serializes inbound frames; let the subscription's final
    // response settle before injecting the next physical frame.
    await new Promise((resolve) => setImmediate(resolve));
    transport.receive({ type: "request", id: "stale", method: "host.getSnapshot", payload: {}, transportGeneration: 8 });
    await waitFor(() => transport.closes, (closes) => closes.some((close) => close.reason === "STALE_GENERATION"));
    expect(transport.closes.at(-1)).toMatchObject({ code: 1008, reason: "STALE_GENERATION" });
  });

  it("rejects a hello for another Host identity before opening a lease", async () => {
    const fixture = await readyGateway();
    openResources.push(fixture.stop);
    const transport = new MemoryTransport("relay", 1);
    fixture.gateway.attach(transport, { deviceId: fixture.device.id });
    transport.receive({
      type: "client.hello", clientId: "api-test-client", deviceId: fixture.device.id,
      hostId: randomUUID(), protocol: { min: 2, max: 2 }, capabilities: [], transportGeneration: 1,
    });
    await waitFor(() => transport.closes, (closes) => closes.length > 0);
    expect(transport.closes[0]).toMatchObject({ code: 1008, reason: "HOST_IDENTITY_MISMATCH" });
    expect(fixture.devices.store.listActiveProtocolSessions(fixture.identity.hostId)).toHaveLength(0);
  });

  it("enforces device scopes and audits denied RPC methods", async () => {
    const fixture = await readyGateway(["host:read"]);
    openResources.push(fixture.stop);
    const transport = new MemoryTransport("relay", 2);
    await sendV2Hello(fixture, transport);
    transport.receive({ type: "request", id: "forbidden", method: "session.startTurn", commandId: "scope-command", payload: { prompt: "scenario:text" }, transportGeneration: 2 });
    const denied = await waitForFrame(transport, (frame) => frame.type === "response" && frame.id === "forbidden");
    expect(denied).toMatchObject({ type: "response", id: "forbidden", ok: false, error: { code: "FORBIDDEN" }, transportGeneration: 2 });
    expect(fixture.orchestrator.store.getCommandReceipt(fixture.device.id, "scope-command")).toBeUndefined();
    expect(fixture.orchestrator.store.listAccessAudit().some((entry) => entry.action === "scope.denied" && entry.targetId === "session.startTurn")).toBe(true);
  });

  it("closes active leases when a device is revoked or its refresh credential rotates", async () => {
    const fixture = await readyGateway();
    openResources.push(fixture.stop);
    const initialCredential = fixture.devices.issueRefreshCredential(fixture.device.id, randomPublicKey());
    const transport = new MemoryTransport("relay", 3);
    await sendV2Hello(fixture, transport);
    const leaseId = (transport.frames().find((frame) => frame.type === "server.hello")!.leaseId as string);
    expect(fixture.devices.store.getProtocolSession(leaseId)?.disconnectedAt).toBeUndefined();

    const rotated = fixture.devices.refreshDeviceCredential({ refreshCredential: initialCredential.refreshCredential, proposedDevicePublicKey: randomPublicKey() });
    await waitFor(() => transport.closes, (closes) => closes.some((close) => close.reason === "CREDENTIAL_ROTATED"));
    expect(transport.closes.at(-1)).toMatchObject({ code: 4401, reason: "CREDENTIAL_ROTATED" });
    expect(fixture.devices.store.getProtocolSession(leaseId)).toMatchObject({ closeCode: "CREDENTIAL_ROTATED" });
    expect(() => fixture.devices.authenticateRefreshCredential(initialCredential.refreshCredential)).toThrow(/Refresh credential is invalid or expired/);
    expect(fixture.devices.authenticateRefreshCredential(rotated.refreshCredential).id).toBe(fixture.device.id);

    // A fresh lease must still be closed by explicit device revocation.
    const second = new MemoryTransport("relay", 4);
    await sendV2Hello(fixture, second);
    const secondLeaseId = second.frames().find((frame) => frame.type === "server.hello")!.leaseId as string;
    expect(fixture.devices.revokeFromLocal(fixture.device.id)).toBe(true);
    await waitFor(() => second.closes, (closes) => closes.some((close) => close.reason === "DEVICE_REVOKED"));
    expect(second.closes.at(-1)).toMatchObject({ code: 4401, reason: "DEVICE_REVOKED" });
    expect(fixture.devices.store.getProtocolSession(secondLeaseId)).toMatchObject({ closeCode: "DEVICE_REVOKED" });
  });
});

describe("Host Origin/CORS, identity, and QR locality", () => {
  it("allows only exact configured origins and emits CORS headers for the hosted app routes", async () => {
    const connectivity = localConnectivity({
      mode: "tailscale",
      allowInsecureHttp: false,
      requireTailscaleServe: true,
      publicBaseUrl: "https://host.example",
      hostedAppUrl: "https://app.example",
    });
    const { server } = createDeterministicServer(connectivity);
    openResources.push(() => server.stop());
    await server.app.ready();

    const direct = await server.app.inject({ method: "GET", url: "/.well-known/flyx-host", headers: { host: "host.example", origin: "https://host.example" } });
    expect(direct.statusCode).toBe(200);
    expect(direct.headers["access-control-allow-origin"]).toBeUndefined();

    const hosted = await server.app.inject({ method: "GET", url: "/.well-known/flyx-host", headers: { host: "host.example", origin: "https://app.example" } });
    expect(hosted.statusCode).toBe(200);
    expect(hosted.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(hosted.headers.vary).toContain("Origin");

    const preflight = await server.app.inject({ method: "OPTIONS", url: "/api/auth/device-ticket", headers: { host: "host.example", origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(preflight.headers["access-control-allow-methods"]).toContain("POST");

    for (const origin of ["https://app.example.evil", "https://app.example/path", "https://app.example?x=1"]) {
      const rejected = await server.app.inject({ method: "GET", url: "/.well-known/flyx-host", headers: { host: "host.example", origin } });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.code).toBe("ORIGIN_REJECTED");
    }
    const bootstrapFromHostedOrigin = await server.app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "host.example", origin: "https://app.example" } });
    expect(bootstrapFromHostedOrigin.statusCode).toBe(403);
    expect(bootstrapFromHostedOrigin.json().error.code).toBe("ORIGIN_REJECTED");
  });

  it("fails closed after the persisted Host identity mirror changes", async () => {
    const connectivity = localConnectivity({ publicBaseUrl: "https://host.example", allowInsecureHttp: false, mode: "tailscale", requireTailscaleServe: true });
    const { server, orchestrator } = createDeterministicServer(connectivity);
    openResources.push(() => server.stop());
    await server.app.ready();
    const previous = orchestrator.store.getHostIdentityMirror();
    orchestrator.store.rotateHostIdentityMirror({ hostId: previous!.hostId, fingerprint: `sha256:${"0".repeat(64)}` }, previous);
    const response = await server.app.inject({ method: "GET", url: "/.well-known/flyx-host", headers: { host: "host.example" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(() => server.getPairingUrl()).toThrow(/Host identity changed/);
  });

  it("keeps the QR endpoint anonymous only for an unforwarded loopback request", async () => {
    const { server } = createDeterministicServer(localConnectivity());
    openResources.push(() => server.stop());
    await server.app.ready();
    const local = await server.app.inject({ method: "GET", url: "/api/pairing/qrcode", headers: { host: "127.0.0.1:4173" } });
    expect(local.statusCode).toBe(200);
    expect(local.headers["content-type"]).toContain("image/svg+xml");
    expect(local.body).not.toContain(WORKSPACE);

    const forwardedAnonymous = await server.app.inject({ method: "GET", url: "/api/pairing/qrcode", headers: { host: "127.0.0.1:4173", "x-forwarded-for": "10.20.30.40" } });
    expect(forwardedAnonymous.statusCode).toBe(401);
    expect(forwardedAnonymous.json().error.code).toBe("UNAUTHENTICATED");

    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    const browser = await server.app.inject({ method: "POST", url: "/api/auth/browser-session", payload: { credential: exchange.json().credential } });
    const forwardedAuthenticated = await server.app.inject({ method: "GET", url: "/api/pairing/qrcode", headers: { host: "127.0.0.1:4173", "x-forwarded-for": "10.20.30.40", cookie: cookieFrom(browser) } });
    expect(forwardedAuthenticated.statusCode).toBe(200);
  });
});
