import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRelayServer, type RelayServer, type RelayServerOptions } from "./server.js";
import { RELAY_CLOSE } from "./relay-port.js";
import type { RouteRegistration } from "./route-registry.js";

const servers: RelayServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
});

interface Frame { binary: boolean; bytes: Buffer }
class Peer {
  readonly socket: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiting: Array<(frame: Frame) => void> = [];
  private readonly ready: Promise<void>;
  constructor(url: string, headers?: Record<string, string>) {
    this.socket = new WebSocket(url, { perMessageDeflate: false, ...(headers ? { headers } : {}) });
    sockets.push(this.socket);
    this.ready = new Promise((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
    this.socket.on("message", (data: RawData, binary) => {
      const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
      const frame = { binary, bytes };
      const waiter = this.waiting.shift();
      if (waiter) waiter(frame); else this.queue.push(frame);
    });
  }
  async next(): Promise<Frame> {
    await this.ready;
    const value = this.queue.shift();
    if (value) return value;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PEER_FRAME_TIMEOUT")), 3000);
      this.waiting.push(frame => { clearTimeout(timer); resolve(frame); });
    });
  }
  async text(): Promise<Record<string, unknown>> { const frame = await this.next(); expect(frame.binary).toBe(false); return JSON.parse(frame.bytes.toString("utf8")) as Record<string, unknown>; }
  send(data: Uint8Array | string): void { this.socket.send(data, { binary: typeof data !== "string", compress: false }); }
  ack(sequence: number): void { this.send(JSON.stringify({ type: "ack", sequence })); }
  closeEvent(): Promise<number> { return new Promise(resolve => this.socket.once("close", code => resolve(code))); }
}

async function start(options: RelayServerOptions = {}) {
  const events: unknown[] = [];
  const server = createRelayServer({ host: "127.0.0.1", port: 0, allowInsecureLoopback: true, logger: event => events.push(event), ...options });
  servers.push(server);
  const urls = await server.listen();
  const response = await fetch(`${urls.httpUrl}/v1/routes`, {
    method: "POST",
    ...(options.registrationToken ? { headers: { Authorization: `Bearer ${options.registrationToken}` } } : {}),
  });
  expect(response.status).toBe(201);
  const registration = await response.json() as RouteRegistration;
  const root = `${urls.websocketUrl}/v1/routes/${registration.routeId}`;
  const headers = { Authorization: `Bearer ${registration.relayCredential}` };
  return { server, events, ...urls, registration, root, headers };
}

async function connectPair(root: string, headers: Record<string, string>, control: Peer, generation = 1) {
  const client = new Peer(`${root}/client`);
  const greeting = await client.text();
  expect(greeting.type).toBe("client.connected");
  const connectionId = greeting.connectionId as string;
  expect(await control.text()).toEqual({ type: "connected", connectionId });
  const data = new Peer(`${root}/data/${connectionId}?generation=${generation}`, headers);
  const paired = { type: "data.paired", connectionId, generation };
  expect(await data.text()).toEqual(paired);
  expect(await client.text()).toEqual(paired);
  return { client, data, connectionId };
}

async function rejected(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers ? { headers } : {});
    sockets.push(socket);
    socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
    socket.once("open", () => reject(new Error("UNEXPECTED_UPGRADE")));
    socket.on("error", () => undefined);
  });
}

describe("Node Relay service over real WebSockets", () => {
  it("requires native TLS in production and confines the explicit plaintext fixture to loopback", () => {
    expect(() => createRelayServer()).toThrow("requires TLS");
    expect(() => createRelayServer({ host: "0.0.0.0", allowInsecureLoopback: true })).toThrow("requires TLS");
    expect(() => createRelayServer({ tls: {} })).toThrow("key and certificate");
  });

  it("registers hash-only routes and rejects missing credentials, noncanonical paths and browser registration", async () => {
    const { server, root, httpUrl, registration, headers, events } = await start({ allowedClientOrigins: ["https://app.example"] });
    const record = await server.registry.get(registration.routeId);
    expect(JSON.stringify(record)).not.toContain(registration.relayCredential);
    expect(await rejected(`${root}/control?generation=1`)).toBe(401);
    expect(await rejected(`${root}/control`, headers)).toBe(400);
    expect(await rejected(`${root}/control?generation=01`, headers)).toBe(400);
    expect(await rejected(`${root}/client?credential=${registration.relayCredential}`)).toBe(400);
    expect(await rejected(`${root}/client`, headers)).toBe(400);
    expect(await rejected(`${root}/client`, { Origin: "https://unexpected.example" })).toBe(403);
    expect(await rejected(`${root}/control?generation=1`, { ...headers, Origin: "https://unexpected.example" })).toBe(403);
    const crossOrigin = await fetch(`${httpUrl}/v1/routes`, { method: "POST", headers: { Origin: "https://unexpected.example" } });
    expect(crossOrigin.status).toBe(403);
    expect(JSON.stringify(events)).not.toContain(registration.relayCredential);
    expect(JSON.stringify(events)).not.toContain(registration.routeId);
    const metrics = await (await fetch(`${httpUrl}/metrics`)).text();
    expect(metrics).not.toContain(registration.routeId);
  });

  it("fails closed for browser origins unless a canonical HTTPS origin is configured", async () => {
    expect(() => createRelayServer({ host: "127.0.0.1", allowInsecureLoopback: true, allowedClientOrigins: ["https://app.example/"] })).toThrow("canonical HTTPS origins");
    expect(() => createRelayServer({ host: "127.0.0.1", allowInsecureLoopback: true, allowedClientOrigins: ["http://app.example"] })).toThrow("canonical HTTPS origins");
    const { root, headers } = await start({ allowedClientOrigins: ["https://app.example"] });
    const control = new Peer(`${root}/control?generation=1`, { ...headers, Origin: "https://app.example" });
    expect((await control.text()).type).toBe("registered");
    const client = new Peer(`${root}/client`, { Origin: "https://app.example" });
    expect((await client.text()).type).toBe("client.connected");
  });

  it("rejects browser clients when no exact Origin allowlist is configured", async () => {
    const { root } = await start();
    expect(await rejected(`${root}/client`, { Origin: "https://unexpected.example" })).toBe(403);
  });

  it("applies the Origin policy to credentialed control upgrades too", async () => {
    const { root, headers } = await start({ allowedClientOrigins: ["https://app.example"] });
    expect(await rejected(`${root}/control?generation=1`, { ...headers, Origin: "https://unexpected.example" })).toBe(403);
  });

  it("does not treat an explicitly empty Origin header as a native client", async () => {
    const { root } = await start({ allowedClientOrigins: ["https://app.example"] });
    expect(await rejected(`${root}/client`, { Origin: "" })).toBe(403);
  });

  it("does not treat an explicitly empty Origin header as absent on registration", async () => {
    const { httpUrl } = await start({ allowedClientOrigins: ["https://app.example"] });
    const registration = await fetch(`${httpUrl}/v1/routes`, { method: "POST", headers: { Origin: "" } });
    expect(registration.status).toBe(403);
  });

  it("optionally protects route creation with a strong Host-only registration token", async () => {
    const registrationToken = "R".repeat(43);
    const { httpUrl } = await start({ registrationToken });
    expect((await fetch(`${httpUrl}/v1/routes`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${httpUrl}/v1/routes`, {
      method: "POST", headers: { Authorization: `Bearer ${"X".repeat(43)}` },
    })).status).toBe(401);
    expect((await fetch(`${httpUrl}/v1/routes`, {
      method: "POST", headers: { Authorization: `Bearer ${registrationToken}` },
    })).status).toBe(201);
    expect(() => createRelayServer({ host: "127.0.0.1", allowInsecureLoopback: true, registrationToken: "weak" })).toThrow("256-bit base64url");
  });

  it("requires canonical secure configured Origins, except explicit loopback HTTP development", () => {
    expect(() => createRelayServer({ allowInsecureLoopback: true, allowedClientOrigins: ["http://public.example"] })).toThrow("canonical HTTPS origins");
    expect(() => createRelayServer({ allowInsecureLoopback: true, allowedClientOrigins: ["https://app.example/"] })).toThrow("canonical HTTPS origins");
    expect(() => createRelayServer({ allowInsecureLoopback: true, allowedClientOrigins: ["http://127.0.0.1:5173"] })).not.toThrow();
  });

  it("forwards only paired ciphertext, keeps two clients separate and supports control sync after outage", async () => {
    const { root, headers, server, events, httpUrl, registration } = await start();
    const control = new Peer(`${root}/control?generation=1`, headers);
    expect(await control.text()).toEqual({ type: "registered", connectionIds: [], generation: 1 });
    const first = await connectPair(root, headers, control);
    const second = await connectPair(root, headers, control);
    expect(first.client.socket.extensions).toBe("");
    const ciphertext = new TextEncoder().encode("opaque_TEST_PROMPT_MARKER_123");
    first.client.send(ciphertext);
    expect((await first.data.next()).bytes).toEqual(Buffer.from(ciphertext));
    first.data.ack(1);
    second.data.send(new Uint8Array([0, 1, 2, 255]));
    expect((await second.client.next()).bytes).toEqual(Buffer.from([0, 1, 2, 255]));
    second.client.ack(1);
    const closed = control.closeEvent();
    control.socket.close();
    await closed;
    const nextControl = new Peer(`${root}/control?generation=2`, headers);
    const synchronized = await nextControl.text();
    expect(synchronized).toEqual({ type: "registered", generation: 2, connectionIds: [first.connectionId, second.connectionId] });
    first.data.send(new Uint8Array([3]));
    expect((await first.client.next()).bytes).toEqual(Buffer.from([3]));
    first.client.ack(1);
    expect(first.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(JSON.stringify([...server.rooms.values()].map(room => room.snapshot()))).not.toContain("TEST_PROMPT_MARKER");
    expect(JSON.stringify(events)).not.toContain("TEST_PROMPT_MARKER");
    const metrics = await (await fetch(`${httpUrl}/metrics`)).text();
    expect(metrics).not.toContain("TEST_PROMPT_MARKER");
    expect(metrics).not.toContain(first.connectionId);
    expect(metrics).not.toContain(registration.routeId);
  });

  it("atomically replaces old-generation data and rejects replayed generation without closing its client", async () => {
    const { root, headers } = await start();
    const control = new Peer(`${root}/control?generation=10`, headers);
    await control.text();
    const active = await connectPair(root, headers, control, 10);
    const oldControlClosed = control.closeEvent();
    const newControl = new Peer(`${root}/control?generation=11`, headers);
    await newControl.text();
    expect(await oldControlClosed).toBe(RELAY_CLOSE.REPLACED);
    const staleData = new Peer(`${root}/data/${active.connectionId}?generation=10`, headers);
    expect(await staleData.closeEvent()).toBe(RELAY_CLOSE.STALE_GENERATION);
    const oldDataClosed = active.data.closeEvent();
    const replacement = new Peer(`${root}/data/${active.connectionId}?generation=11`, headers);
    expect((await replacement.text()).generation).toBe(11);
    expect((await active.client.text()).generation).toBe(11);
    expect(await oldDataClosed).toBe(RELAY_CLOSE.REPLACED);
    active.client.send(new Uint8Array([4]));
    expect((await replacement.next()).bytes).toEqual(Buffer.from([4]));
    expect(active.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a non-acking pair at 1MiB while another pair continues", async () => {
    const { root, headers } = await start();
    const control = new Peer(`${root}/control?generation=1`, headers);
    await control.text();
    const slow = await connectPair(root, headers, control);
    const healthy = await connectPair(root, headers, control);
    for (let index = 0; index < 4; index += 1) {
      slow.data.send(new Uint8Array(256 * 1024));
      expect((await slow.client.next()).bytes).toHaveLength(256 * 1024);
    }
    const slowClosed = slow.client.closeEvent();
    slow.data.send(new Uint8Array([1]));
    expect(await slowClosed).toBe(RELAY_CLOSE.RESYNC_REQUIRED);
    healthy.data.send(new Uint8Array([6]));
    expect((await healthy.client.next()).bytes).toEqual(Buffer.from([6]));
    healthy.client.ack(1);
    expect(healthy.client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("enforces registration quotas and individual inbound ciphertext limits", async () => {
    const { root, headers, httpUrl } = await start({ registrationsPerIpPerHour: 1 });
    expect((await fetch(`${httpUrl}/v1/routes`, { method: "POST" })).status).toBe(429);
    const control = new Peer(`${root}/control?generation=1`, headers);
    await control.text();
    const active = await connectPair(root, headers, control);
    const closed = active.client.closeEvent();
    active.client.send(new Uint8Array(264 * 1024));
    expect(await closed).toBe(1009);
  });
});
