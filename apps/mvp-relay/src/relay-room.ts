import { RelayControlMessageSchema, RelayDataMessageSchema } from "@flyx/mvp-protocol";
import {
  DEFAULT_RELAY_LIMITS, RELAY_CLOSE, RelayError,
  type RelayHostPrincipal, type RelayLimits, type RelayObserver, type RelayPort,
  type RelayReason, type RelayRoomSnapshot, type RelaySocket, type RelaySocketAttachment,
} from "./relay-port.js";
import { TokenBucket } from "./rate-limit.js";
import { randomRelayId, ROUTE_ID_PATTERN } from "./route-registry.js";

interface SocketState {
  socket: RelaySocket;
  attachment: RelaySocketAttachment;
  queue: Promise<void>;
  queuedBytes: number;
  unackedBytes: number;
  messages: TokenBucket;
  bytes: TokenBucket;
}

interface Pair {
  connectionId: string;
  clientId?: string;
  dataId?: string;
  generation: number;
  createdAt: number;
}

export interface RelayRoomOptions {
  routeId: string;
  now?: () => number;
  randomId?: () => string;
  limits?: Partial<RelayLimits>;
  observer?: RelayObserver;
  snapshot?: RelayRoomSnapshot;
}

/** Runtime-neutral live rendezvous. Only routing metadata survives hibernation. */
export class RelayRoom implements RelayPort {
  readonly limits: Readonly<RelayLimits>;
  private readonly sockets = new Map<string, SocketState>();
  private readonly pairs = new Map<string, Pair>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly routeBytes: TokenBucket;
  private readonly routeConnections: TokenBucket;
  private controlId: string | undefined;
  private controlGeneration = 0;
  private lastPingAt = 0;
  private outstandingPing: string | undefined;
  private disposed = false;

  constructor(private readonly options: RelayRoomOptions) {
    if (!ROUTE_ID_PATTERN.test(options.routeId)) throw new RelayError("UNAUTHORIZED");
    this.limits = Object.freeze({ ...DEFAULT_RELAY_LIMITS, ...options.limits });
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_RELAY_LIMIT");
    }
    // Leave room for envelope fields in Cloudflare's 16 KiB socket attachment.
    if (this.limits.maxUnackedFrames > 256 || this.limits.maxBufferedBytes > 1024 * 1024
      || this.limits.maxControlFrameBytes > DEFAULT_RELAY_LIMITS.maxControlFrameBytes
      || this.limits.maxCiphertextFrameBytes > DEFAULT_RELAY_LIMITS.maxCiphertextFrameBytes) throw new Error("UNSAFE_RELAY_BUFFER_LIMIT");
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomRelayId());
    this.routeBytes = new TokenBucket(this.limits.maxRouteBytesPerSecond, 1000, this.now());
    this.routeConnections = new TokenBucket(this.limits.maxRouteConnectionsPerMinute, 60_000, this.now());
    if (options.snapshot) {
      if (options.snapshot.v !== 1 || options.snapshot.routeId !== options.routeId
        || !Number.isSafeInteger(options.snapshot.controlGeneration) || options.snapshot.controlGeneration < 0) throw new Error("INVALID_RELAY_SNAPSHOT");
      this.controlGeneration = options.snapshot.controlGeneration;
      this.lastPingAt = options.snapshot.lastPingAt ?? 0;
      this.outstandingPing = options.snapshot.outstandingPing;
    }
  }

  async attachControl(socket: RelaySocket, principal: RelayHostPrincipal, generation: number): Promise<void> {
    this.authorize(socket, principal);
    this.checkGeneration(socket, generation);
    if (generation <= this.controlGeneration) return this.reject(socket, "STALE_GENERATION", 409);
    this.consumeConnection(socket);
    const previousId = this.controlId;
    const state = this.add(socket, "control", generation);
    // Set the winner before closing the old socket; a delayed old close cannot detach it.
    this.controlGeneration = generation;
    this.controlId = socket.id;
    this.lastPingAt = this.now();
    this.outstandingPing = undefined;
    if (previousId) this.closeOne(previousId, "REPLACED");
    this.gauges();
    await this.send(state, JSON.stringify({ type: "registered", connectionIds: [...this.pairs.values()].filter(pair => pair.clientId).map(pair => pair.connectionId), generation }));
  }

  async attachClient(socket: RelaySocket): Promise<string> {
    this.consumeConnection(socket);
    if (this.pairs.size >= this.limits.maxClientsPerRoute) return this.reject(socket, "QUOTA_EXCEEDED", 429);
    const connectionId = this.randomId();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(connectionId) || this.pairs.has(connectionId)) return this.reject(socket, "BAD_FRAME");
    const state = this.add(socket, "client", 0, connectionId);
    this.pairs.set(connectionId, { connectionId, clientId: socket.id, generation: 0, createdAt: this.now() });
    this.gauges();
    await this.send(state, JSON.stringify({ type: "client.connected", connectionId }));
    await this.notify({ type: "connected", connectionId });
    return connectionId;
  }

  async attachData(socket: RelaySocket, principal: RelayHostPrincipal, connectionId: string, generation: number): Promise<void> {
    this.authorize(socket, principal);
    this.checkGeneration(socket, generation);
    const pair = this.pairs.get(connectionId);
    if (!pair?.clientId || !this.controlId || generation !== this.controlGeneration
      || generation < pair.generation || (pair.dataId && generation <= pair.generation)) return this.reject(socket, "STALE_GENERATION", 409);
    this.consumeConnection(socket);
    const previousId = pair.dataId;
    const state = this.add(socket, "data", generation, connectionId);
    pair.dataId = socket.id;
    pair.generation = generation;
    const client = this.sockets.get(pair.clientId)!;
    client.attachment.generation = generation;
    if (previousId) this.closeOne(previousId, "REPLACED");
    const greeting = JSON.stringify({ type: "data.paired", connectionId, generation });
    const sentToHost = this.send(state, greeting);
    const sentToClient = this.send(client, greeting);
    this.gauges();
    this.record({ name: "pair_duration_ms", value: Math.max(0, this.now() - pair.createdAt) });
    await Promise.all([sentToHost, sentToClient]);
  }

  async receive(socketId: string, frame: string | Uint8Array): Promise<void> {
    const state = this.sockets.get(socketId);
    if (!state) return;
    const size = typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
    const limit = typeof frame === "string" ? this.limits.maxControlFrameBytes : this.limits.maxCiphertextFrameBytes;
    if (size > limit) return this.closeConnection(socketId, "FRAME_TOO_LARGE");
    if (!state.messages.consume(1, this.now()) || !state.bytes.consume(size, this.now()) || !this.routeBytes.consume(size, this.now())) {
      return this.closeConnection(socketId, "RATE_LIMITED");
    }
    if (state.attachment.role === "control") {
      if (typeof frame !== "string") return this.closeConnection(socketId, "BAD_FRAME");
      let raw: unknown;
      try { raw = JSON.parse(frame); } catch { return this.closeConnection(socketId, "BAD_FRAME"); }
      const parsed = RelayControlMessageSchema.safeParse(raw);
      if (!parsed.success) return this.closeConnection(socketId, "BAD_FRAME");
      if (parsed.data.type === "ping") {
        this.touch(socketId);
        await this.send(state, JSON.stringify({ type: "pong", nonce: parsed.data.nonce }));
      } else if (parsed.data.type === "pong" && parsed.data.nonce === this.outstandingPing) {
        this.touch(socketId);
        this.outstandingPing = undefined;
      } else return this.closeConnection(socketId, "BAD_FRAME");
      return;
    }
    if (typeof frame === "string") {
      let raw: unknown;
      try { raw = JSON.parse(frame); } catch { return this.closeConnection(socketId, "BAD_FRAME"); }
      const parsed = RelayDataMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type !== "ack") return this.closeConnection(socketId, "BAD_FRAME");
      const sequence = parsed.data.sequence;
      if (sequence >= state.attachment.nextSequence) return this.closeConnection(socketId, "BAD_FRAME");
      if (sequence > state.attachment.lastAckSequence) {
        while (state.attachment.unacked[0] && state.attachment.unacked[0].sequence <= sequence) {
          state.unackedBytes -= state.attachment.unacked.shift()!.bytes;
        }
        state.attachment.lastAckSequence = sequence;
      }
      this.touch(socketId);
      return;
    }
    this.touch(socketId);
    const pair = this.pairs.get(state.attachment.connectionId!);
    if (!pair) return this.closeConnection(socketId, "PEER_CLOSED");
    if (state.attachment.role === "client") {
      const data = pair.dataId ? this.sockets.get(pair.dataId) : undefined;
      if (data) return this.forward(data, frame, "client_to_host");
      // Clients must wait for data.paired. Buffering here would lose ciphertext
      // across Durable Object hibernation, since payload persistence is forbidden.
      return this.closeConnection(socketId, "BAD_FRAME");
    } else {
      const client = pair.clientId ? this.sockets.get(pair.clientId) : undefined;
      if (client) await this.forward(client, frame, "host_to_client");
      else this.closeConnection(socketId, "PEER_CLOSED");
    }
  }

  touch(socketId: string): void {
    const state = this.sockets.get(socketId);
    if (state) state.attachment.lastSeenAt = this.now();
  }

  async detach(socketId: string): Promise<void> {
    if (!this.sockets.has(socketId)) return;
    this.closeConnection(socketId, "PEER_CLOSED");
  }

  async tick(now = this.now()): Promise<void> {
    for (const [id, state] of [...this.sockets]) {
      const timeout = state.attachment.role === "control" ? this.limits.controlIdleTimeoutMs : this.limits.dataIdleTimeoutMs;
      if (now - state.attachment.lastSeenAt >= timeout) this.closeConnection(id, "TIMEOUT");
    }
    for (const pair of [...this.pairs.values()]) {
      if (!pair.dataId && now - pair.createdAt >= this.limits.pairTimeoutMs && pair.clientId) this.closeConnection(pair.clientId, "TIMEOUT");
    }
    if (this.controlId && now - this.lastPingAt >= this.limits.controlHeartbeatIntervalMs) {
      this.lastPingAt = now;
      // Do not replace the challenge until acknowledged: a late valid pong stays valid.
      // Protocol identifiers must begin with an alphanumeric character, while
      // an unpadded base64url random value may begin with '-' or '_'. Prefixing
      // keeps the full entropy and prevents intermittent invalid heartbeats.
      this.outstandingPing ??= `p.${this.randomId()}`;
      await this.notify({ type: "ping", nonce: this.outstandingPing });
    }
  }

  attachment(socketId: string): RelaySocketAttachment | undefined {
    const attachment = this.sockets.get(socketId)?.attachment;
    return attachment ? { ...attachment, unacked: attachment.unacked.map(value => ({ ...value })) } : undefined;
  }

  snapshot(): RelayRoomSnapshot {
    return { v: 1, routeId: this.options.routeId, controlGeneration: this.controlGeneration,
      lastPingAt: this.lastPingAt, ...(this.outstandingPing ? { outstandingPing: this.outstandingPing } : {}),
      sockets: [...this.sockets.keys()].map(id => this.attachment(id)!) };
  }

  restoreSocket(socket: RelaySocket, attachment: RelaySocketAttachment): void {
    if (this.disposed || this.sockets.has(socket.id) || !this.validAttachment(socket, attachment)) return this.reject(socket, "BAD_FRAME");
    const state = this.add(socket, attachment.role, attachment.generation, attachment.connectionId);
    state.attachment = { ...attachment, unacked: attachment.unacked.map(value => ({ ...value })) };
    state.unackedBytes = attachment.unacked.reduce((sum, value) => sum + value.bytes, 0);
    if (attachment.role === "control") {
      if (this.controlId || attachment.generation < this.controlGeneration) { this.closeOne(socket.id, "STALE_GENERATION"); return; }
      this.controlId = socket.id;
      this.controlGeneration = Math.max(this.controlGeneration, attachment.generation);
      this.lastPingAt ||= this.now();
    } else {
      const connectionId = attachment.connectionId!;
      const pair = this.pairs.get(connectionId) ?? { connectionId, generation: attachment.generation, createdAt: attachment.attachedAt };
      if (attachment.role === "client") {
        if (pair.clientId) { this.closeOne(socket.id, "BAD_FRAME"); return; }
        pair.clientId = socket.id;
        pair.createdAt = attachment.attachedAt;
      } else {
        if (pair.dataId) { this.closeOne(socket.id, "BAD_FRAME"); return; }
        pair.dataId = socket.id;
      }
      pair.generation = Math.max(pair.generation, attachment.generation);
      this.pairs.set(connectionId, pair);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.sockets.keys()]) this.closeOne(id, "SHUTDOWN");
    this.pairs.clear();
    this.controlId = undefined;
    this.gauges();
  }

  private validAttachment(socket: RelaySocket, attachment: RelaySocketAttachment): boolean {
    if (attachment.v !== 1 || attachment.socketId !== socket.id || !["control", "client", "data"].includes(attachment.role)
      || !Number.isSafeInteger(attachment.generation) || attachment.generation < (attachment.role === "client" ? 0 : 1)
      || !Number.isFinite(attachment.attachedAt) || !Number.isFinite(attachment.lastSeenAt)
      || !Number.isSafeInteger(attachment.nextSequence) || attachment.nextSequence < 1
      || !Number.isSafeInteger(attachment.lastAckSequence) || attachment.lastAckSequence < 0
      || attachment.lastAckSequence >= attachment.nextSequence || !Array.isArray(attachment.unacked)
      || attachment.unacked.length > this.limits.maxUnackedFrames
      || (attachment.role !== "control" && !/^[A-Za-z0-9_-]{16,128}$/.test(attachment.connectionId ?? ""))) return false;
    let previous = attachment.lastAckSequence;
    let bytes = 0;
    for (const item of attachment.unacked) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence !== previous + 1 || item.sequence >= attachment.nextSequence
        || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > this.limits.maxCiphertextFrameBytes) return false;
      previous = item.sequence;
      bytes += item.bytes;
    }
    return previous === attachment.nextSequence - 1 && bytes <= this.limits.maxBufferedBytes;
  }

  private authorize(socket: RelaySocket, principal: RelayHostPrincipal): void {
    if (principal.routeId !== this.options.routeId) this.reject(socket, "UNAUTHORIZED", 401);
  }

  private checkGeneration(socket: RelaySocket, generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) this.reject(socket, "BAD_FRAME");
  }

  private consumeConnection(socket: RelaySocket): void {
    if (this.disposed) this.reject(socket, "SHUTDOWN", 503);
    if (!this.routeConnections.consume(1, this.now())) this.reject(socket, "RATE_LIMITED", 429);
    if (this.sockets.has(socket.id)) this.reject(socket, "BAD_FRAME");
  }

  private add(socket: RelaySocket, role: RelaySocketAttachment["role"], generation: number, connectionId?: string): SocketState {
    const now = this.now();
    const state: SocketState = {
      socket, attachment: { v: 1, socketId: socket.id, role, generation, attachedAt: now, lastSeenAt: now, nextSequence: 1, lastAckSequence: 0, unacked: [], ...(connectionId ? { connectionId } : {}) },
      queue: Promise.resolve(), queuedBytes: 0, unackedBytes: 0,
      messages: new TokenBucket(this.limits.maxSocketMessagesPerSecond, 1000, now),
      bytes: new TokenBucket(this.limits.maxSocketBytesPerSecond, 1000, now),
    };
    this.sockets.set(socket.id, state);
    return state;
  }

  private async forward(target: SocketState, frame: Uint8Array, direction: "client_to_host" | "host_to_client"): Promise<void> {
    await this.send(target, frame);
    if (this.sockets.has(target.socket.id)) this.record({ name: "bytes_forwarded", value: frame.byteLength, direction });
  }

  private send(state: SocketState, frame: string | Uint8Array): Promise<void> {
    if (!this.sockets.has(state.socket.id)) return Promise.resolve();
    const size = typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
    const ciphertext = typeof frame !== "string";
    if (size > (ciphertext ? this.limits.maxCiphertextFrameBytes : this.limits.maxControlFrameBytes)) {
      this.closeConnection(state.socket.id, "FRAME_TOO_LARGE");
      return Promise.resolve();
    }
    if (state.queuedBytes + state.socket.bufferedAmount + size > this.limits.maxBufferedBytes
      || (ciphertext && (state.unackedBytes + size > this.limits.maxBufferedBytes || state.attachment.unacked.length >= this.limits.maxUnackedFrames))) {
      this.closeConnection(state.socket.id, "RESYNC_REQUIRED");
      return Promise.resolve();
    }
    if (ciphertext) {
      if (state.attachment.nextSequence >= Number.MAX_SAFE_INTEGER) { this.closeConnection(state.socket.id, "RESYNC_REQUIRED"); return Promise.resolve(); }
      state.attachment.unacked.push({ sequence: state.attachment.nextSequence++, bytes: size });
      state.unackedBytes += size;
    }
    state.queuedBytes += size;
    state.queue = state.queue.then(async () => {
      if (this.sockets.get(state.socket.id) !== state) return;
      if (state.socket.bufferedAmount + size > this.limits.maxBufferedBytes) { this.closeConnection(state.socket.id, "RESYNC_REQUIRED"); return; }
      await state.socket.send(frame);
    }).catch(() => { this.closeConnection(state.socket.id, "PEER_CLOSED"); }).finally(() => { state.queuedBytes -= size; });
    return state.queue;
  }

  private async notify(message: unknown): Promise<void> {
    const control = this.controlId ? this.sockets.get(this.controlId) : undefined;
    if (control) await this.send(control, JSON.stringify(message));
  }

  private closeConnection(socketId: string, reason: RelayReason): void {
    const state = this.sockets.get(socketId);
    if (!state) return;
    if (reason === "RESYNC_REQUIRED") this.record({ name: "backpressure_close_total", value: 1 });
    if (state.attachment.role === "control") {
      if (this.controlId === socketId) this.controlId = undefined;
      this.closeOne(socketId, reason);
    } else {
      const pair = this.pairs.get(state.attachment.connectionId!);
      if (pair) {
        this.pairs.delete(pair.connectionId);
        if (pair.clientId) this.closeOne(pair.clientId, reason);
        if (pair.dataId) this.closeOne(pair.dataId, reason);
        void this.notify({ type: "disconnected", connectionId: pair.connectionId });
      } else this.closeOne(socketId, reason);
    }
    this.gauges();
  }

  private closeOne(socketId: string, reason: RelayReason): void {
    const state = this.sockets.get(socketId);
    if (!state) return;
    this.sockets.delete(socketId);
    try { state.socket.close(RELAY_CLOSE[reason], reason); } catch { /* Already closed. */ }
    this.record({ name: "socket_closed_total", value: 1, reason });
  }

  private reject(socket: RelaySocket, reason: RelayReason, statusCode = 400): never {
    this.record({ name: "connect_rejected_total", value: 1, reason });
    try { socket.close(RELAY_CLOSE[reason], reason); } catch { /* Already closed. */ }
    throw new RelayError(reason, statusCode);
  }

  private gauges(): void {
    this.record({ name: "routes_online", value: this.controlId ? 1 : 0 });
    this.record({ name: "control_connections", value: this.controlId ? 1 : 0 });
    this.record({ name: "client_connections", value: [...this.pairs.values()].filter(pair => pair.clientId).length });
    this.record({ name: "pairs_active", value: [...this.pairs.values()].filter(pair => pair.clientId && pair.dataId).length });
  }

  private record(metric: Parameters<RelayObserver["record"]>[0]): void {
    try { this.options.observer?.record(metric); } catch { /* Diagnostics must not break forwarding. */ }
  }
}
