import { RelayRoom } from "../relay-room.js";
import { RELAY_CLOSE, RelayError } from "../relay-port.js";
import type { RelayLimits, RelayRoomSnapshot, RelaySocket, RelaySocketAttachment } from "../relay-port.js";
import { randomRelayId, ROUTE_ID_PATTERN, RouteRegistry } from "../route-registry.js";
import type { RelayRouteRecord, RelayRouteStore } from "../route-registry.js";
import { bearerCredential, configNumber, errorResponse, isAllowedOrigin, isSecureRequest, jsonResponse, metric, secureHeaders, sha256 } from "./http.js";
import { parseUpgradePath } from "./path.js";
import { defaultRuntime } from "./runtime.js";
import type { CloudflareRuntime, HibernatingSocket, ObjectState, RelayEnvironment } from "./runtime.js";

interface WindowCount { window: number; count: number }
interface Ingress { second: number; frames: number; bytes: number }
interface StoredAttachment { v: 1; relay: RelaySocketAttachment; ingress: Ingress }
interface BoundSocket { socket: HibernatingSocket; port: RelaySocket; ingress: Ingress }
interface RouteBudget { connections: WindowCount; bytes: WindowCount }

/** One route, one hibernating Durable Object. No payload enters object storage. */
export class RelayRouteObject {
  private readonly ready: Promise<void>;
  private readonly sockets = new Map<string, BoundSocket>();
  private readonly socketIds = new Map<HibernatingSocket, string>();
  private readonly limits: Partial<RelayLimits>;
  private record: RelayRouteRecord | null = null;
  private room: RelayRoom | null = null;
  private fence = 0;
  private metricRouteHash: string | undefined;
  private nextAlarmAt: number | null = null;
  private budget: RouteBudget = { connections: { window: -1, count: 0 }, bytes: { window: -1, count: 0 } };

  constructor(
    private readonly state: ObjectState,
    private readonly env: RelayEnvironment,
    private readonly runtime: CloudflareRuntime = defaultRuntime,
  ) {
    this.limits = {
      maxClientsPerRoute: configNumber(env.RELAY_MAX_CLIENTS_PER_ROUTE, 32, 512),
      maxRouteConnectionsPerMinute: configNumber(env.RELAY_MAX_CONNECTS_PER_ROUTE_MINUTE, 120, 10_000),
      maxSocketMessagesPerSecond: configNumber(env.RELAY_MAX_FRAMES_PER_SOCKET_SECOND, 128, 1000),
      maxSocketBytesPerSecond: configNumber(env.RELAY_MAX_BYTES_PER_SOCKET_SECOND, 1_048_576, 8_388_608),
      maxRouteBytesPerSecond: configNumber(env.RELAY_MAX_ROUTE_BYTES_PER_SECOND, 8_388_608, 67_108_864),
      dataIdleTimeoutMs: configNumber(env.RELAY_IDLE_TIMEOUT_MS, 90_000, 3_600_000),
      pairTimeoutMs: configNumber(env.RELAY_PENDING_TIMEOUT_MS, 15_000, 60_000),
      maxUnackedFrames: 256,
    };
    state.setHibernatableWebSocketEventTimeout?.(5000);
    this.ready = state.blockConcurrencyWhile(async () => {
      this.record = await state.storage.get<RelayRouteRecord>("route") ?? null;
      const snapshot = await state.storage.get<RelayRoomSnapshot>("room");
      this.budget = await state.storage.get<RouteBudget>("budget") ?? this.budget;
      this.nextAlarmAt = await state.storage.getAlarm();
      if (!this.record) {
        for (const socket of state.getWebSockets()) this.closeNative(socket, RELAY_CLOSE.UNAUTHORIZED, "UNAUTHORIZED");
        return;
      }
      this.metricRouteHash = (await sha256(this.record.routeId)).slice(0, 24);
      this.makeRoom(snapshot);
      for (const socket of state.getWebSockets()) {
        if (socket.readyState !== 1) continue;
        try {
          const attachment = socket.deserializeAttachment() as StoredAttachment | null;
          if (!attachment || attachment.v !== 1 || !attachment.relay
            || !this.validIngress(attachment.ingress)) throw new Error("INVALID_ATTACHMENT");
          const port = this.bind(socket, attachment.relay.socketId, attachment.ingress);
          this.room!.restoreSocket(port, attachment.relay);
        } catch {
          this.closeNative(socket, RELAY_CLOSE.BAD_FRAME, "BAD_FRAME");
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.state.blockConcurrencyWhile(async () => {
      try { return await this.handle(request); } catch (error) {
        await this.sync();
        if (error instanceof RelayError) return errorResponse(error.reason, error.statusCode);
        metric(this.env, "internal_error_total");
        return errorResponse("RELAY_UNAVAILABLE", 503);
      }
    });
  }

  async webSocketMessage(socket: HibernatingSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    await this.state.blockConcurrencyWhile(async () => {
      const socketId = this.socketIds.get(socket);
      const bound = socketId ? this.sockets.get(socketId) : undefined;
      if (!socketId || !bound || !this.room) {
        this.closeNative(socket, RELAY_CLOSE.BAD_FRAME, "BAD_FRAME");
        return;
      }
      try {
        const frame = typeof message === "string" ? message : new Uint8Array(message);
        const size = typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
        const current = this.room.attachment(socketId);
        // Handshake senders wait for data.paired. Do not allow ciphertext to sit
        // in a RAM-only pending queue that would vanish during hibernation.
        if (typeof frame !== "string" && current?.role === "client" && current.generation === 0) {
          this.closeNative(socket, RELAY_CLOSE.BAD_FRAME, "DATA_NOT_PAIRED");
          await this.room.detach(socketId);
        } else if (!this.consumeIngress(bound, size)) {
          this.closeNative(socket, RELAY_CLOSE.RATE_LIMITED, "RATE_LIMITED");
          await this.room.detach(socketId);
        } else {
          await this.room.receive(socketId, frame);
        }
      } catch {
        this.closeNative(socket, RELAY_CLOSE.BAD_FRAME, "BAD_FRAME");
        await this.room.detach(socketId);
      }
      await this.sync();
    });
  }

  async webSocketClose(socket: HibernatingSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.detach(socket);
  }

  async webSocketError(socket: HibernatingSocket, _error: unknown): Promise<void> {
    await this.detach(socket);
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.state.blockConcurrencyWhile(async () => {
      this.nextAlarmAt = null;
      await this.room?.tick(this.runtime.now());
      this.emitGauges();
      await this.sync();
    });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "relay.internal") {
      if (request.method === "POST" && url.pathname === "/initialize") {
        if (this.record) return errorResponse("ROUTE_EXISTS", 409);
        const value: unknown = await request.json();
        if (!this.validRecord(value)) return errorResponse("INVALID_ROUTE", 400);
        this.record = value;
        await this.state.storage.put("route", value);
        this.metricRouteHash = (await sha256(value.routeId)).slice(0, 24);
        this.makeRoom();
        return jsonResponse({ created: true }, 201);
      }
      if (request.method === "GET" && url.pathname === "/record") {
        return this.record ? jsonResponse(this.record) : errorResponse("NOT_FOUND", 404);
      }
      if (request.method === "DELETE" && url.pathname === "/record") {
        this.room?.dispose();
        this.room = null;
        this.record = null;
        await this.state.storage.delete("route");
        await this.state.storage.delete("room");
        await this.state.storage.delete("budget");
        await this.state.storage.deleteAlarm();
        this.nextAlarmAt = null;
        return jsonResponse({ deleted: true });
      }
      return errorResponse("NOT_FOUND", 404);
    }
    if (!isSecureRequest(url, this.env)) return errorResponse("TLS_REQUIRED", 426);
    if (!isAllowedOrigin(request.headers.get("Origin"), this.env)) return errorResponse("ORIGIN_REJECTED", 403);
    const path = request.method === "GET" ? parseUpgradePath(url) : null;
    if (!path || !this.room || !this.record || path.routeId !== this.record.routeId) return errorResponse("NOT_FOUND", 404);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return errorResponse("WEBSOCKET_REQUIRED", 426);
    let principal;
    if (path.role === "client") {
      if (request.headers.has("Authorization") || request.headers.has("Sec-WebSocket-Protocol")) {
        return errorResponse("CLIENT_CREDENTIAL_FORBIDDEN", 400);
      }
    } else {
      const credential = bearerCredential(request);
      principal = credential ? await new RouteRegistry({ store: this.localStore() }).authenticate(path.routeId, credential) : null;
      if (!principal) return errorResponse("UNAUTHORIZED", 401);
    }
    if (!this.consumeConnection()) return errorResponse("RATE_LIMITED", 429, 60);
    await this.state.storage.put("budget", this.budget);
    // Persist the authenticated monotonic fence before sending registered or
    // closing a replaced control connection; a crash cannot restore the old one.
    if (path.role === "control") {
      if (path.generation <= this.fence) return errorResponse("STALE_GENERATION", 409);
      this.fence = path.generation;
      await this.state.storage.put("room", { ...this.room.snapshot(), controlGeneration: this.fence, sockets: [] });
    }
    const pair = this.runtime.createPair();
    const socketId = randomRelayId();
    this.state.acceptWebSocket(pair.server, [path.role]);
    const port = this.bind(pair.server, socketId, { second: -1, frames: 0, bytes: 0 });
    try {
      if (path.role === "client") await this.room.attachClient(port);
      else if (path.role === "control") await this.room.attachControl(port, principal!, path.generation);
      else await this.room.attachData(port, principal!, path.connectionId, path.generation);
    } catch (error) {
      this.closeNative(pair.server, RELAY_CLOSE.BAD_FRAME, "CONNECT_REJECTED");
      throw error;
    }
    await this.sync();
    return this.runtime.upgrade(pair.client, secureHeaders());
  }

  private makeRoom(snapshot?: RelayRoomSnapshot): void {
    this.fence = snapshot?.controlGeneration ?? 0;
    this.room = new RelayRoom({
      routeId: this.record!.routeId,
      now: () => this.runtime.now(),
      limits: this.limits,
      ...(snapshot ? { snapshot } : {}),
      observer: { record: (sample) => {
        metric(this.env, `${sample.name}${sample.direction ? `.${sample.direction}` : ""}${sample.reason ? `.${sample.reason}` : ""}`, sample.value, this.metricRouteHash);
      } },
    });
  }

  private bind(socket: HibernatingSocket, id: string, ingress: Ingress): RelaySocket {
    const close = (code: number, reason: string) => this.closeNative(socket, code, reason);
    const port: RelaySocket = {
      id,
      get bufferedAmount() { return socket.bufferedAmount ?? 0; },
      send: (frame) => socket.send(frame),
      close,
    };
    this.sockets.set(id, { socket, port, ingress });
    this.socketIds.set(socket, id);
    return port;
  }

  private async detach(socket: HibernatingSocket): Promise<void> {
    await this.ready;
    await this.state.blockConcurrencyWhile(async () => {
      const id = this.socketIds.get(socket);
      if (id) await this.room?.detach(id);
      this.closeNative(socket, 1000, "CLOSED");
      await this.sync();
    });
  }

  private closeNative(socket: HibernatingSocket, code: number, reason: string): void {
    // getWebSockets() may include CLOSING sockets; this tombstone prevents a
    // delayed close/restart from restoring an obsolete role or generation.
    try { socket.serializeAttachment({ v: 1, closed: true }); } catch { /* Already detached. */ }
    try { socket.close(code, reason); } catch { /* Already closed. */ }
  }

  private async sync(): Promise<void> {
    if (!this.room) return;
    const snapshot = this.room.snapshot();
    const liveIds = new Set(snapshot.sockets.map((attachment) => attachment.socketId));
    for (const [id, bound] of this.sockets) {
      if (!liveIds.has(id)) {
        this.sockets.delete(id);
        this.socketIds.delete(bound.socket);
      }
    }
    for (const relay of snapshot.sockets) {
      const bound = this.sockets.get(relay.socketId);
      if (!bound) continue;
      const attachment: StoredAttachment = { v: 1, relay, ingress: bound.ingress };
      if (new TextEncoder().encode(JSON.stringify(attachment)).byteLength > 16_000) {
        this.closeNative(bound.socket, RELAY_CLOSE.RESYNC_REQUIRED, "RESYNC_REQUIRED");
        await this.room.detach(relay.socketId);
      } else bound.socket.serializeAttachment(attachment);
    }
    const current = this.room.snapshot();
    this.fence = Math.max(this.fence, current.controlGeneration);
    // Snapshot fields are protocol metadata; never persist its socket list.
    await this.state.storage.put("room", { ...current, controlGeneration: this.fence, sockets: [] });
    await this.state.storage.put("budget", this.budget);
    if (current.sockets.length > 0) {
      const nextAlarm = this.runtime.now() + Math.min(10_000, this.room.limits.pairTimeoutMs);
      if (this.nextAlarmAt === null || nextAlarm < this.nextAlarmAt) {
        this.nextAlarmAt = nextAlarm;
        await this.state.storage.setAlarm(nextAlarm);
      }
    } else {
      this.nextAlarmAt = null;
      await this.state.storage.deleteAlarm();
    }
  }

  private consumeConnection(): boolean {
    const minute = Math.floor(this.runtime.now() / 60_000);
    if (this.budget.connections.window !== minute) this.budget.connections = { window: minute, count: 0 };
    if (this.budget.connections.count >= this.room!.limits.maxRouteConnectionsPerMinute) return false;
    this.budget.connections.count += 1;
    return true;
  }

  private emitGauges(): void {
    const sockets = this.room?.snapshot().sockets ?? [];
    const controls = sockets.filter((socket) => socket.role === "control").length;
    metric(this.env, "routes_online", controls > 0 ? 1 : 0, this.metricRouteHash);
    metric(this.env, "control_connections", controls, this.metricRouteHash);
    metric(this.env, "client_connections", sockets.filter((socket) => socket.role === "client").length, this.metricRouteHash);
    metric(this.env, "pairs_active", sockets.filter((socket) => socket.role === "data").length, this.metricRouteHash);
  }

  private consumeIngress(bound: BoundSocket, bytes: number): boolean {
    const second = Math.floor(this.runtime.now() / 1000);
    if (bound.ingress.second !== second) bound.ingress = { second, frames: 0, bytes: 0 };
    if (this.budget.bytes.window !== second) this.budget.bytes = { window: second, count: 0 };
    bound.ingress.frames += 1;
    bound.ingress.bytes += bytes;
    this.budget.bytes.count += bytes;
    return bound.ingress.frames <= this.room!.limits.maxSocketMessagesPerSecond
      && bound.ingress.bytes <= this.room!.limits.maxSocketBytesPerSecond
      && this.budget.bytes.count <= this.room!.limits.maxRouteBytesPerSecond;
  }

  private localStore(): RelayRouteStore {
    return {
      get: async (routeId) => this.record?.routeId === routeId ? this.record : null,
      put: async () => { throw new Error("ROUTE_EXISTS"); },
      delete: async () => { throw new Error("UNSUPPORTED"); },
    };
  }

  private validRecord(value: unknown): value is RelayRouteRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as RelayRouteRecord;
    return typeof record.routeId === "string" && ROUTE_ID_PATTERN.test(record.routeId)
      && typeof record.credentialHash === "string" && /^[a-f0-9]{64}$/.test(record.credentialHash)
      && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
      && Object.keys(record).every((key) => ["routeId", "credentialHash", "createdAt"].includes(key));
  }

  private validIngress(value: Ingress | undefined): value is Ingress {
    return !!value && Number.isSafeInteger(value.second) && value.second >= -1
      && Number.isSafeInteger(value.frames) && value.frames >= 0
      && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
  }
}
