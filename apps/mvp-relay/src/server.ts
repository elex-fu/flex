import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { parseRelaySocketUrl, type RelaySocketTarget } from "@flyx/mvp-protocol";
import { KeyedRateLimiter } from "./rate-limit.js";
import { RelayRoom } from "./relay-room.js";
import { RelayMetrics } from "./metrics.js";
import { DEFAULT_RELAY_LIMITS, RELAY_CLOSE, RelayError, type RelayHostPrincipal, type RelayLimits, type RelayMetric, type RelaySocket } from "./relay-port.js";
import { MemoryRelayRouteStore, RouteRegistry, type RelayRouteStore } from "./route-registry.js";

export interface RelayServerOptions {
  host?: string;
  port?: number;
  tls?: HttpsServerOptions;
  /** Development fixtures only. Plain HTTP is never permitted on a public bind. */
  allowInsecureLoopback?: boolean;
  routeStore?: RelayRouteStore;
  roomLimits?: Partial<RelayLimits>;
  maxRooms?: number;
  maxConnectionsPerIp?: number;
  maxConnections?: number;
  connectionsPerIpPerMinute?: number;
  registrationsPerIpPerHour?: number;
  registrationsPerHour?: number;
  /** Optional 256-bit base64url secret used only for Host route creation. */
  registrationToken?: string;
  allowedClientOrigins?: readonly string[];
  metricsToken?: string;
  onMetric?: (metric: RelayMetric) => void;
  /** Log events have only a bounded event code. No requests/errors/payloads are passed. */
  logger?: (event: { event: "listening" | "request_rejected" | "socket_rejected" | "internal_error" | "stopped"; code: string }) => void;
  now?: () => number;
  tickIntervalMs?: number;
}

export interface RelayServer {
  readonly registry: RouteRegistry;
  readonly metrics: RelayMetrics;
  readonly rooms: ReadonlyMap<string, RelayRoom>;
  listen(): Promise<{ httpUrl: string; websocketUrl: string }>;
  close(): Promise<void>;
}

function loopback(host: string): boolean { return ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"].includes(host); }
function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}
function bearer(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (headerCount(request, "authorization") !== 1 || !authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return null;
  return authorization.slice(7);
}
function textEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function rawBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const host = options.host ?? "127.0.0.1";
  const secure = !!options.tls;
  if (!secure && (!options.allowInsecureLoopback || !loopback(host))) throw new Error("Relay requires TLS; plaintext is allowed only with explicit loopback development mode");
  if (secure && (!options.tls?.key || !options.tls?.cert)) throw new Error("Relay TLS requires a key and certificate");
  if (options.registrationToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.registrationToken)) {
    throw new Error("Relay registration token must be a 256-bit base64url secret");
  }
  const allowedClientOrigins = new Set<string>();
  for (const value of options.allowedClientOrigins ?? []) {
    let origin: URL;
    try { origin = new URL(value); } catch { throw new Error("Relay client origins must be canonical HTTPS origins"); }
    const localHttp = options.allowInsecureLoopback && origin.protocol === "http:" && loopback(origin.hostname);
    if (origin.origin !== value || (origin.protocol !== "https:" && !localHttp)) {
      throw new Error("Relay client origins must be canonical HTTPS origins");
    }
    allowedClientOrigins.add(value);
  }
  const now = options.now ?? Date.now;
  const registry = new RouteRegistry({ store: options.routeStore ?? new MemoryRelayRouteStore(), now });
  const rooms = new Map<string, RelayRoom>();
  const metrics = new RelayMetrics();
  const registrationLimits = new KeyedRateLimiter(options.registrationsPerIpPerHour ?? 5, 3_600_000);
  const globalRegistrationLimit = new KeyedRateLimiter(options.registrationsPerHour ?? 100, 3_600_000, 1);
  const connectionLimits = new KeyedRateLimiter(options.connectionsPerIpPerMinute ?? 120, 60_000);
  const authenticationLimits = new KeyedRateLimiter(60, 60_000);
  const credentialLimits = new KeyedRateLimiter(240, 60_000);
  const ipConnections = new Map<string, number>();
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: Math.max(DEFAULT_RELAY_LIMITS.maxCiphertextFrameBytes, DEFAULT_RELAY_LIMITS.maxControlFrameBytes), clientTracking: true });
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const log = (event: Parameters<NonNullable<RelayServerOptions["logger"]>>[0]["event"], code: string): void => {
    try { options.logger?.({ event, code }); } catch { /* Diagnostic observer is isolated. */ }
  };
  const record = (routeKey: string, metric: RelayMetric): void => {
    metrics.record(routeKey, metric);
    try { options.onMetric?.(metric); } catch { /* Diagnostic observer is isolated. */ }
  };
  const json = (response: ServerResponse, statusCode: number, value: unknown): void => {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(secure ? { "strict-transport-security": "max-age=31536000" } : {}) });
    response.end(JSON.stringify(value));
  };
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const ip = request.socket.remoteAddress ?? "unknown";
    if (closed) return json(response, 503, { error: "SHUTDOWN" });
    if (request.url === "/healthz" && request.method === "GET") return json(response, 200, { status: "ok", protocolVersion: 1 });
    if (request.url === "/metrics" && request.method === "GET") {
      if (!loopback(ip) && (!options.metricsToken || !textEqual(request.headers.authorization ?? "", `Bearer ${options.metricsToken}`))) return json(response, 403, { error: "FORBIDDEN" });
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
      response.end(metrics.render());
      return;
    }
    if (request.url !== "/v1/routes" || request.method !== "POST") return json(response, 404, { error: "NOT_FOUND" });
    // Registration is Host-to-Relay; browser code never receives the credential.
    if (headerCount(request, "origin") !== 0) return json(response, 403, { error: "ORIGIN_FORBIDDEN" });
    if (options.registrationToken) {
      const credential = bearer(request);
      if (!credential || !textEqual(credential, options.registrationToken)) {
        record("http", { name: "connect_rejected_total", value: 1, reason: "UNAUTHORIZED" });
        log("request_rejected", "UNAUTHORIZED");
        return json(response, 401, { error: "UNAUTHORIZED" });
      }
    }
    if (!registrationLimits.consume(ip, now()) || !globalRegistrationLimit.consume("global", now())) {
      record("http", { name: "connect_rejected_total", value: 1, reason: "RATE_LIMITED" });
      log("request_rejected", "RATE_LIMITED");
      return json(response, 429, { error: "RATE_LIMITED" });
    }
    let bytes = 0;
    for await (const chunk of request) {
      bytes += (chunk as Buffer).length;
      if (bytes > 1024) { json(response, 413, { error: "FRAME_TOO_LARGE" }); return; }
    }
    try { json(response, 201, await registry.create()); }
    catch { log("internal_error", "ROUTE_REGISTRATION_FAILED"); json(response, 503, { error: "ROUTE_REGISTRATION_FAILED" }); }
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void handler(request, response).catch(() => {
      log("internal_error", "REQUEST_FAILED");
      if (!response.headersSent) json(response, 500, { error: "REQUEST_FAILED" });
      else response.destroy();
    });
  };
  const server = options.tls ? createHttpsServer({ ...options.tls, minVersion: "TLSv1.2" }, onRequest) : createHttpServer(onRequest);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;

  const rejectUpgrade = (socket: Socket, status: number, reason: string): void => {
    log("socket_rejected", reason);
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 429 ? "Too Many Requests" : "Rejected"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const upgrade = async (request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    const ip = request.socket.remoteAddress ?? "unknown";
    if (closed) return rejectUpgrade(socket, 503, "SHUTDOWN");
    if (!connectionLimits.consume(ip, now()) || (ipConnections.get(ip) ?? 0) >= (options.maxConnectionsPerIp ?? 128)
      || webSockets.clients.size >= (options.maxConnections ?? 4096)) return rejectUpgrade(socket, 429, "RATE_LIMITED");
    let target: RelaySocketTarget;
    try {
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new Error("PATH_INVALID");
      // The transport is already validated above; parse only the public canonical path.
      target = parseRelaySocketUrl(new URL(request.url, "https://relay.invalid"));
    } catch { return rejectUpgrade(socket, 400, "INVALID_PATH"); }
    const originCount = headerCount(request, "origin");
    const origin = request.headers.origin;
    // Native Host/client implementations omit Origin. Any browser-supplied
    // Origin must match the explicit HTTPS allowlist, regardless of role.
    if (originCount !== 0 && (originCount !== 1 || !origin || !allowedClientOrigins.has(origin))) {
      return rejectUpgrade(socket, 403, "ORIGIN_FORBIDDEN");
    }
    let principal: RelayHostPrincipal | null = null;
    if (target.role === "client") {
      if (request.headers.authorization || request.headers["sec-websocket-protocol"]) return rejectUpgrade(socket, 400, "CLIENT_CREDENTIAL_FORBIDDEN");
      if (!(await registry.get(target.routeId))) return rejectUpgrade(socket, 404, "ROUTE_UNAVAILABLE");
    } else {
      if (!authenticationLimits.consume(`${ip}:${target.routeId}`, now())) return rejectUpgrade(socket, 429, "RATE_LIMITED");
      const credential = bearer(request);
      principal = credential ? await registry.authenticate(target.routeId, credential) : null;
      if (!principal) return rejectUpgrade(socket, 401, "UNAUTHORIZED");
      if (!credentialLimits.consume(target.routeId, now())) return rejectUpgrade(socket, 429, "RATE_LIMITED");
    }
    let room = rooms.get(target.routeId);
    if (!room) {
      if (rooms.size >= (options.maxRooms ?? 10_000)) return rejectUpgrade(socket, 429, "QUOTA_EXCEEDED");
      const routeKey = target.routeId;
      room = new RelayRoom({ routeId: routeKey, now, ...(options.roomLimits ? { limits: options.roomLimits } : {}), observer: { record: metric => record(routeKey, metric) } });
      rooms.set(routeKey, room);
    }
    const activeRoom = room;
    // Concurrent async auth must reserve the IP slot atomically immediately before upgrade.
    if ((ipConnections.get(ip) ?? 0) >= (options.maxConnectionsPerIp ?? 128)
      || webSockets.clients.size >= (options.maxConnections ?? 4096)) return rejectUpgrade(socket, 429, "QUOTA_EXCEEDED");
    ipConnections.set(ip, (ipConnections.get(ip) ?? 0) + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (ipConnections.get(ip) ?? 1) - 1;
      if (left <= 0) ipConnections.delete(ip); else ipConnections.set(ip, left);
    };
    socket.once("close", release);
    webSockets.handleUpgrade(request, socket, head, ws => {
      const id = randomUUID();
      const transport: RelaySocket = {
        id, get bufferedAmount() { return ws.bufferedAmount; },
        send(frame) {
          return new Promise<void>((resolve, reject) => {
            if (ws.readyState !== WebSocket.OPEN) { reject(new Error("SOCKET_CLOSED")); return; }
            ws.send(frame, { binary: typeof frame !== "string", compress: false }, error => error ? reject(new Error("SOCKET_SEND_FAILED")) : resolve());
          });
        },
        close(code, reason) { ws.close(code, reason); const kill = setTimeout(() => ws.terminate(), 1000); kill.unref(); },
      };
      let incoming = Promise.resolve();
      let incomingBytes = 0;
      let incomingFrames = 0;
      ws.on("message", (data, isBinary) => {
        const bytes = rawBytes(data);
        if (incomingBytes + bytes.byteLength > activeRoom.limits.maxBufferedBytes || incomingFrames >= activeRoom.limits.maxUnackedFrames) {
          ws.close(RELAY_CLOSE.RESYNC_REQUIRED, "RESYNC_REQUIRED");
          void activeRoom.detach(id);
          return;
        }
        const frame = isBinary ? bytes : Buffer.from(bytes).toString("utf8");
        incomingBytes += bytes.byteLength;
        incomingFrames += 1;
        incoming = incoming.then(() => activeRoom.receive(id, frame))
          .catch(() => { ws.close(RELAY_CLOSE.BAD_FRAME, "BAD_FRAME"); })
          .finally(() => { incomingBytes -= bytes.byteLength; incomingFrames -= 1; });
      });
      ws.on("pong", () => { if (target.role !== "control") activeRoom.touch(id); });
      ws.on("error", () => { void activeRoom.detach(id); });
      ws.on("close", () => { release(); void activeRoom.detach(id); });
      const attach = target.role === "client" ? activeRoom.attachClient(transport)
        : target.role === "control" ? activeRoom.attachControl(transport, principal!, target.generation)
          : activeRoom.attachData(transport, principal!, target.connectionId, target.generation);
      void attach.catch(error => {
        if (!(error instanceof RelayError)) log("internal_error", "ATTACH_FAILED");
        ws.close(error instanceof RelayError ? RELAY_CLOSE[error.reason] : RELAY_CLOSE.BAD_FRAME, error instanceof RelayError ? error.reason : "ATTACH_FAILED");
      });
    });
  };
  server.on("upgrade", (request, socket, head) => {
    const timer = setTimeout(() => socket.destroy(), 15_000);
    timer.unref();
    void upgrade(request, socket as Socket, head).catch(() => rejectUpgrade(socket as Socket, 500, "UPGRADE_FAILED")).finally(() => clearTimeout(timer));
  });
  server.on("clientError", (_error, socket) => { if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });

  return {
    registry, metrics, rooms,
    listen() {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error("RELAY_STOPPED"));
        server.once("error", reject);
        server.listen(options.port ?? 4483, host, () => {
          server.off("error", reject);
          interval = setInterval(() => {
            for (const room of rooms.values()) void room.tick().catch(() => log("internal_error", "ROOM_TICK_FAILED"));
            // Native ping detects half-open TCP even when encrypted application traffic is idle.
            for (const socket of webSockets.clients) if (socket.readyState === WebSocket.OPEN) socket.ping();
          }, options.tickIntervalMs ?? 10_000);
          interval.unref();
          const address = server.address() as AddressInfo;
          const hostname = address.family === "IPv6" ? `[${address.address}]` : address.address;
          const origin = `${hostname}:${address.port}`;
          log("listening", secure ? "TLS" : "LOOPBACK_DEVELOPMENT");
          resolve({ httpUrl: `${secure ? "https" : "http"}://${origin}`, websocketUrl: `${secure ? "wss" : "ws"}://${origin}` });
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (interval) clearInterval(interval);
      for (const room of rooms.values()) room.dispose();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>(resolve => webSockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      log("stopped", "SHUTDOWN");
    },
  };
}
