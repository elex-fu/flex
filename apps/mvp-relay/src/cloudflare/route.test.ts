import { describe, expect, it } from "vitest";
import { credentialVerifier } from "../route-registry.js";
import type { RouteRegistration } from "../route-registry.js";
import { RelayQuotaObject } from "./quota.js";
import { RelayRouteObject } from "./route.js";
import { MemoryState } from "./test-support.js";
import type { CloudflareRuntime, HibernatingSocket, ObjectNamespace, RelayEnvironment } from "./runtime.js";
import worker from "./worker.js";

class FakeSocket implements HibernatingSocket {
  readyState = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  attachment: unknown = null;
  send(frame: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("CLOSED");
    this.sent.push(typeof frame === "string" ? frame : new Uint8Array(frame).slice());
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
  }
  serializeAttachment(value: unknown): void {
    if (JSON.stringify(value).length > 16_384) throw new Error("ATTACHMENT_TOO_BIG");
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown { return structuredClone(this.attachment); }
  control(type: string): Record<string, unknown> | undefined {
    return this.sent.filter((frame): frame is string => typeof frame === "string").map((frame) => JSON.parse(frame) as Record<string, unknown>).reverse().find((frame) => frame.type === type);
  }
}

function harness(config: Partial<RelayEnvironment> = {}) {
  let now = 1_000_000;
  const states = new Map<string, MemoryState>();
  const objects = new Map<string, RelayRouteObject>();
  const quotas = new Map<string, RelayQuotaObject>();
  const telemetry: unknown[] = [];
  const pairs: Array<{ client: FakeSocket; server: FakeSocket }> = [];
  const runtime: CloudflareRuntime = {
    now: () => now,
    createPair() {
      const pair = { client: new FakeSocket(), server: new FakeSocket() };
      pairs.push(pair);
      return pair;
    },
    upgrade(_client, headers) {
      const response = new Response(null, { headers });
      Object.defineProperty(response, "status", { value: 101 });
      return response;
    },
  };
  const rooms: ObjectNamespace = {
    idFromName: (name) => name,
    get: (key) => ({ fetch: (request) => room(String(key)).fetch(request) }),
  };
  const quotaNamespace: ObjectNamespace = {
    idFromName: (name) => name,
    get: (key) => ({ fetch: (request) => {
      const name = String(key);
      if (!quotas.has(name)) quotas.set(name, new RelayQuotaObject(new MemoryState(), env, () => now));
      return quotas.get(name)!.fetch(request);
    } }),
  };
  const env: RelayEnvironment = {
    RELAY_ROOMS: rooms,
    RELAY_QUOTAS: quotaNamespace,
    RELAY_ALLOW_ANONYMOUS_REGISTRATION: "true",
    RELAY_ALLOWED_ORIGINS: "https://app.flyx.example",
    RELAY_METRICS: { writeDataPoint: (event) => { telemetry.push(event); } },
    ...config,
  };
  function room(id: string): RelayRouteObject {
    if (!states.has(id)) states.set(id, new MemoryState());
    if (!objects.has(id)) objects.set(id, new RelayRouteObject(states.get(id)!, env, runtime));
    return objects.get(id)!;
  }
  const request = (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("CF-Connecting-IP", "203.0.113.7");
    return worker.fetch(new Request(`https://relay.flyx.example${path}`, { ...options, headers }), env);
  };
  async function register(): Promise<RouteRegistration> {
    const response = await request("/v1/routes", { method: "POST" });
    expect(response.status).toBe(201);
    return response.json() as Promise<RouteRegistration>;
  }
  async function connect(route: RouteRegistration, role: "control" | "client" | "data", generation = 1, connectionId?: string): Promise<FakeSocket> {
    const suffix = role === "client" ? "client" : role === "control" ? `control?generation=${generation}` : `data/${connectionId}?generation=${generation}`;
    const headers: Record<string, string> = { Upgrade: "websocket", "Sec-WebSocket-Extensions": "permessage-deflate" };
    if (role === "client") headers.Origin = "https://app.flyx.example";
    else headers.Authorization = `Bearer ${route.relayCredential}`;
    const response = await request(`/v1/routes/${route.routeId}/${suffix}`, { headers });
    expect(response.status).toBe(101);
    expect(response.headers.has("Sec-WebSocket-Extensions")).toBe(false);
    return pairs.at(-1)!.server;
  }
  return { env, states, telemetry, request, register, connect, room,
    advance(ms: number) { now += ms; },
    hibernate(id: string) { objects.delete(id); return room(id); },
  };
}

describe("Cloudflare Relay contract", () => {
  it("returns the credential only on creation and never overwrites a registered verifier", async () => {
    const app = harness();
    const registration = await app.register();
    const saved = app.states.get(registration.routeId)!.storage.values;
    expect(saved.get("route")).toEqual({ routeId: registration.routeId, credentialHash: await credentialVerifier(registration.relayCredential), createdAt: expect.any(Number) });
    expect(JSON.stringify([...saved])).not.toContain(registration.relayCredential);
    const duplicate = await app.room(registration.routeId).fetch(new Request("https://relay.internal/initialize", {
      method: "POST", body: JSON.stringify({ routeId: registration.routeId, credentialHash: "0".repeat(64), createdAt: 1 }),
    }));
    expect(duplicate.status).toBe(409);
    const bad = await app.request(`/v1/routes/${registration.routeId}/control?generation=1`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${"A".repeat(43)}` } });
    expect(bad.status).toBe(401);
    expect((await app.request("/record")).status).toBe(404);
    expect((await app.request(`/v1/routes/${registration.routeId}/client?credential=${registration.relayCredential}`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
  });

  it("rehydrates ciphertext pairs and ACK bounds without leaking payload or credentials", async () => {
    const app = harness();
    const route = await app.register();
    await app.connect(route, "control");
    const client = await app.connect(route, "client");
    const other = await app.connect(route, "client");
    const connectionId = String(client.control("client.connected")!.connectionId);
    const data = await app.connect(route, "data", 1, connectionId);
    const bytes = new TextEncoder().encode("KNOWN_CIPHERTEXT_SENTINEL");
    await app.room(route.routeId).webSocketMessage(data, bytes.buffer);
    expect(client.sent.at(-1)).toEqual(bytes);
    expect(other.sent.some((frame) => typeof frame !== "string")).toBe(false);
    const serialized = JSON.stringify([client.attachment, data.attachment, [...app.states.get(route.routeId)!.storage.values], app.telemetry]);
    expect(serialized).not.toContain("KNOWN_CIPHERTEXT_SENTINEL");
    expect(serialized).not.toContain(route.relayCredential);
    expect(JSON.stringify(app.telemetry)).not.toContain(route.routeId);
    await app.hibernate(route.routeId).webSocketMessage(client, JSON.stringify({ type: "ack", sequence: 1 }));
    expect(client.readyState).toBe(1);
    await app.hibernate(route.routeId).webSocketMessage(client, bytes.buffer);
    expect(data.sent.at(-1)).toEqual(bytes);
    const record = app.states.get(route.routeId)!.storage.values.get("room") as { sockets: unknown[] };
    expect(record.sockets).toEqual([]);
  });

  it("retains generation fences across hibernation and ignores replaced socket close events", async () => {
    const app = harness();
    const route = await app.register();
    const oldControl = await app.connect(route, "control", 1);
    const client = await app.connect(route, "client");
    const current = await app.connect(route, "control", 2);
    expect(current.control("registered")!.connectionIds).toEqual([client.control("client.connected")!.connectionId]);
    await app.room(route.routeId).webSocketClose(oldControl, 1000, "attacker-controlled-close-reason", true);
    expect(current.readyState).toBe(1);
    app.hibernate(route.routeId);
    const stale = await app.request(`/v1/routes/${route.routeId}/control?generation=2`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${route.relayCredential}` } });
    expect(stale.status).toBe(409);
    await app.room(route.routeId).webSocketClose(current, 1000, "done", true);
    app.hibernate(route.routeId);
    const older = await app.request(`/v1/routes/${route.routeId}/control?generation=1`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${route.relayCredential}` } });
    expect(older.status).toBe(409);
    expect(JSON.stringify(app.telemetry)).not.toContain("attacker-controlled");
  });

  it("preserves outstanding heartbeat challenges through hibernation", async () => {
    const app = harness();
    const route = await app.register();
    const control = await app.connect(route, "control");
    app.advance(10_000);
    await app.room(route.routeId).alarm();
    const ping = control.control("ping")!;
    expect(ping.type).toBe("ping");
    await app.hibernate(route.routeId).webSocketMessage(control, JSON.stringify({ type: "pong", nonce: ping.nonce }));
    expect(control.readyState).toBe(1);
  });

  it("keeps route connection quotas across hibernation", async () => {
    const app = harness({ RELAY_MAX_CONNECTS_PER_ROUTE_MINUTE: "2" });
    const route = await app.register();
    await app.connect(route, "control");
    await app.connect(route, "client");
    app.hibernate(route.routeId);
    const response = await app.request(`/v1/routes/${route.routeId}/client`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(429);
  });

  it("keeps the 1 MiB ACK budget across hibernation and isolates a slow client", async () => {
    const app = harness({ RELAY_MAX_BYTES_PER_SOCKET_SECOND: "8388608" });
    const route = await app.register();
    const control = await app.connect(route, "control");
    const slow = await app.connect(route, "client");
    const healthy = await app.connect(route, "client");
    const data = await app.connect(route, "data", 1, String(slow.control("client.connected")!.connectionId));
    const bytes = new Uint8Array(262_144);
    for (let index = 0; index < 4; index += 1) {
      await app.hibernate(route.routeId).webSocketMessage(data, bytes.buffer);
      expect(slow.readyState).toBe(1);
    }
    await app.hibernate(route.routeId).webSocketMessage(data, new Uint8Array([1]).buffer);
    expect(slow.closes[0]!.reason).toBe("RESYNC_REQUIRED");
    expect(healthy.readyState).toBe(1);
    expect(control.readyState).toBe(1);
  });

  it("keeps ingress limits across hibernation and rejects corrupt attachments", async () => {
    const app = harness({ RELAY_MAX_FRAMES_PER_SOCKET_SECOND: "2" });
    const route = await app.register();
    const control = await app.connect(route, "control");
    const ping = JSON.stringify({ type: "ping", nonce: "hello" });
    await app.hibernate(route.routeId).webSocketMessage(control, ping);
    await app.hibernate(route.routeId).webSocketMessage(control, ping);
    await app.hibernate(route.routeId).webSocketMessage(control, ping);
    expect(control.closes[0]!.reason).toBe("RATE_LIMITED");
    const other = await app.connect(route, "client");
    other.attachment = { v: 1, relay: { role: "data", socketId: "bad" } };
    await app.hibernate(route.routeId).webSocketMessage(other, ping);
    expect(other.closes[0]!.reason).toBe("BAD_FRAME");
  });

  it("closes an unpaired sender and does not postpone idle alarms when another socket is busy", async () => {
    const app = harness();
    const route = await app.register();
    const control = await app.connect(route, "control");
    const unpaired = await app.connect(route, "client");
    const state = app.states.get(route.routeId)!;
    const alarm = state.storage.alarm;
    app.advance(9000);
    await app.room(route.routeId).webSocketMessage(control, JSON.stringify({ type: "ping", nonce: "heartbeat" }));
    expect(state.storage.alarm).toBe(alarm);
    await app.hibernate(route.routeId).webSocketMessage(unpaired, new Uint8Array([1, 2, 3]).buffer);
    expect(unpaired.readyState).toBe(3);
    expect(unpaired.closes[0]!.reason).toBe("DATA_NOT_PAIRED");
  });

  it("disables creation by default and rejects cross-origin upgrades at the edge", async () => {
    const app = harness({ RELAY_ALLOW_ANONYMOUS_REGISTRATION: "false" });
    expect((await app.request("/v1/routes", { method: "POST" })).status).toBe(403);
    const browserRegistration = await harness().request("/v1/routes", {
      method: "POST", headers: { Origin: "https://app.flyx.example" },
    });
    expect(browserRegistration.status).toBe(403);
    const emptyOriginRegistration = await harness().request("/v1/routes", {
      method: "POST", headers: { Origin: "" },
    });
    expect(emptyOriginRegistration.status).toBe(403);
    const wrongOrigin = await app.request(`/v1/routes/${"a".repeat(32)}/client`, { headers: { Upgrade: "websocket", Origin: "https://evil.example" } });
    expect(wrongOrigin.status).toBe(403);
  });

  it("rejects host credentials and subprotocols on client upgrades", async () => {
    const app = harness();
    const route = await app.register();
    const authorization = `Bearer ${route.relayCredential}`;
    const withCredential = await app.request(`/v1/routes/${route.routeId}/client`, {
      headers: { Upgrade: "websocket", Authorization: authorization },
    });
    expect(withCredential.status).toBe(400);
    expect(await withCredential.json()).toEqual({ error: { code: "CLIENT_CREDENTIAL_FORBIDDEN" } });
    const withSubprotocol = await app.request(`/v1/routes/${route.routeId}/client`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "flyx-relay-host" },
    });
    expect(withSubprotocol.status).toBe(400);
    expect(await withSubprotocol.json()).toEqual({ error: { code: "CLIENT_CREDENTIAL_FORBIDDEN" } });
  });
});
