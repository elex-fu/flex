import { randomBytes } from "node:crypto";
import { buildRelaySocketUrl, parseRelayControlMessage, MAX_RELAY_CONTROL_FRAME_BYTES, MAX_RELAY_CIPHERTEXT_FRAME_BYTES } from "@flyx/mvp-protocol";
import { HostRelayTransport, type SecureRelayConnection } from "./relay-transport.js";
import { createNodeRelaySocket, sendRelaySocket, type RelaySocket, type RelaySocketFactory } from "./relay-socket.js";
import { loadOrRegisterRelayRoute, reserveRelayGeneration, RelayRegistrationError, type RelayRegistration, type RelayRegistrationOptions } from "./relay-registration.js";

export type HostRelayState = "stopped" | "connecting" | "registering" | "online" | "backoff" | "draining";

export interface HostRelaySupervisorOptions extends RelayRegistrationOptions {
  hostId: string;
  hostStaticKey: Uint8Array;
  protocol: { min: number; max: number };
  onConnection: (connection: SecureRelayConnection) => void | Promise<void>;
  onState?: (state: HostRelayState, reason?: string) => void;
  socketFactory?: RelaySocketFactory;
  now?: () => number;
  random?: () => number;
  heartbeatIntervalMs?: number;
  livenessTimeoutMs?: number;
  openTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxDataConnections?: number;
}

interface ControlAttempt {
  socket: RelaySocket;
  generation: number;
  unlisten: Array<() => void>;
  deadline: ReturnType<typeof setTimeout>;
  lastSeenAt: number;
  pendingPings: Set<string>;
}

/** Owns outbound reachability only; session orchestration and device authorization stay in the gateway. */
export class HostRelaySupervisor {
  private status: HostRelayState = "stopped";
  private route: RelayRegistration | undefined;
  private running = false;
  private epoch = 0;
  private registrationAbort: AbortController | undefined;
  private control: ControlAttempt | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private readonly desiredIds = new Set<string>();
  private readonly data = new Map<string, HostRelayTransport>();
  private readonly dataRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dataAttempts = new Map<string, number>();
  private readonly socketFactory: RelaySocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: HostRelaySupervisorOptions) {
    this.socketFactory = options.socketFactory ?? createNodeRelaySocket;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get state(): HostRelayState { return this.status; }
  /** Contains a secret. Use only the routeId/relayUrl fields when constructing offers. */
  get registration(): Readonly<RelayRegistration> | undefined { return this.route; }
  get dataConnectionCount(): number { return this.data.size; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    this.route = undefined;
    this.registrationAbort = new AbortController();
    await this.registerAndConnect(epoch, true);
  }

  private async registerAndConnect(epoch: number, initial = false): Promise<void> {
    if (!this.running || this.epoch !== epoch) return;
    this.transition("connecting");
    try {
      const route = await loadOrRegisterRelayRoute({ ...this.options, ...(this.registrationAbort ? { signal: this.registrationAbort.signal } : {}) });
      if (!this.running || this.epoch !== epoch) return;
      this.route = route;
      await this.connectControl(epoch);
    } catch (error) {
      if (!this.running || this.epoch !== epoch) return;
      if (error instanceof RelayRegistrationError && ["RELAY_REGISTRATION_UNREACHABLE", "RELAY_REGISTRATION_FAILED"].includes(error.code)) {
        this.scheduleReconnect(error.code);
        return;
      }
      this.running = false;
      this.transition("stopped", "RELAY_START_FAILED");
      if (initial) throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.status === "stopped") return;
    this.running = false;
    this.epoch += 1;
    this.transition("draining");
    this.registrationAbort?.abort();
    this.registrationAbort = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.clearControl();
    for (const timer of this.dataRetries.values()) clearTimeout(timer);
    this.dataRetries.clear();
    this.desiredIds.clear();
    for (const transport of this.data.values()) transport.close(1000, "HOST_RELAY_STOPPED");
    this.data.clear();
    this.dataAttempts.clear();
    this.attempts = 0;
    this.transition("stopped");
  }

  private transition(next: HostRelayState, reason?: string): void {
    this.status = next;
    this.options.onState?.(next, reason);
  }

  private async connectControl(epoch: number): Promise<void> {
    if (!this.running || this.epoch !== epoch || !this.route) return;
    this.transition("connecting");
    try {
      const registration = await reserveRelayGeneration(this.options.registrationPath, this.route, this.now());
      if (!this.running || this.epoch !== epoch) return;
      this.route = registration;
      const socket = this.socketFactory(this.socketUrl("control", registration.generation), {
        headers: { authorization: `Bearer ${registration.relayCredential}` }, maxFrameBytes: MAX_RELAY_CONTROL_FRAME_BYTES,
      });
      const control: ControlAttempt = {
        socket, generation: registration.generation, unlisten: [], lastSeenAt: this.now(), pendingPings: new Set(),
        deadline: setTimeout(() => this.failControl(control, "RELAY_CONTROL_OPEN_TIMEOUT"), this.options.openTimeoutMs ?? 15_000),
      };
      control.deadline.unref?.();
      this.control = control;
      control.unlisten.push(
        socket.onOpen(() => { if (this.control === control) this.transition("registering"); }),
        socket.onMessage((frame) => this.receiveControl(control, frame)),
        socket.onClose(() => this.failControl(control, "RELAY_CONTROL_CLOSED")),
        socket.onError(() => this.failControl(control, "RELAY_CONTROL_FAILED")),
      );
    } catch { if (this.running && this.epoch === epoch) this.scheduleReconnect("RELAY_CONTROL_CONNECT_FAILED"); }
  }

  private socketUrl(role: "control" | "data", generation: number, connectionId?: string): string {
    const route = this.route!;
    // Production protocol builders deliberately reject plaintext; the test-only escape is loopback constrained by registration.
    const base = new URL(route.relayUrl);
    const insecure = base.protocol === "ws:";
    if (insecure) base.protocol = "wss:";
    const result = new URL(buildRelaySocketUrl(base.origin, role === "control"
      ? { role, routeId: route.routeId, generation }
      : { role, routeId: route.routeId, generation, connectionId: connectionId! }));
    if (insecure) result.protocol = "ws:";
    return result.toString();
  }

  private receiveControl(control: ControlAttempt, frame: string | Uint8Array): void {
    if (!this.running || this.control !== control) return;
    try {
      if (typeof frame !== "string" || Buffer.byteLength(frame) > MAX_RELAY_CONTROL_FRAME_BYTES) throw new Error("INVALID_CONTROL_FRAME");
      const message = parseRelayControlMessage(frame);
      if (message.type === "error") { this.failControl(control, "RELAY_CONTROL_REJECTED"); return; }
      if (message.type === "pong") {
        if (!control.pendingPings.delete(message.nonce)) throw new Error("INVALID_CONTROL_PONG");
      }
      control.lastSeenAt = this.now();
      if (message.type === "registered") {
        if (this.status !== "registering" || (message.generation !== undefined && message.generation !== control.generation)) {
          throw new Error("INVALID_CONTROL_REGISTRATION");
        }
        if (message.connectionIds.length > (this.options.maxDataConnections ?? 64)) throw new Error("RELAY_CLIENT_LIMIT");
        clearTimeout(control.deadline);
        this.attempts = 0;
        this.transition("online");
        this.syncConnections(message.connectionIds);
        this.startHeartbeat(control);
      } else if (message.type === "connected") {
        if (this.status !== "online") throw new Error("CONTROL_NOT_REGISTERED");
        if (!this.desiredIds.has(message.connectionId) && this.desiredIds.size >= (this.options.maxDataConnections ?? 64)) throw new Error("RELAY_CLIENT_LIMIT");
        this.desiredIds.add(message.connectionId);
        this.attachData(message.connectionId);
      } else if (message.type === "disconnected") {
        this.desiredIds.delete(message.connectionId);
        this.cancelDataRetry(message.connectionId);
        this.data.get(message.connectionId)?.close(1000, "RELAY_CLIENT_DISCONNECTED");
      } else if (message.type === "ping") {
        void this.sendControl(control, { type: "pong", nonce: message.nonce });
      }
    } catch { this.failControl(control, "RELAY_CONTROL_PROTOCOL_ERROR"); }
  }

  private syncConnections(connectionIds: string[]): void {
    const current = new Set(connectionIds);
    for (const id of this.desiredIds) {
      if (!current.has(id)) {
        this.desiredIds.delete(id);
        this.cancelDataRetry(id);
        this.data.get(id)?.close(1000, "RELAY_CLIENT_DISCONNECTED");
      }
    }
    for (const id of current) {
      this.desiredIds.add(id);
      const transport = this.data.get(id);
      if (transport && !transport.ready && transport.generation !== this.control?.generation) {
        transport.close(1000, "RELAY_GENERATION_REPLACED");
        this.cancelDataRetry(id);
      }
      this.attachData(id);
    }
  }

  private attachData(connectionId: string): void {
    if (!this.running || this.status !== "online" || !this.control || !this.route
      || !this.desiredIds.has(connectionId) || this.data.has(connectionId) || this.dataRetries.has(connectionId)) return;
    const generation = this.control.generation;
    try {
      const socket = this.socketFactory(this.socketUrl("data", generation, connectionId), {
        headers: { authorization: `Bearer ${this.route.relayCredential}` }, maxFrameBytes: MAX_RELAY_CIPHERTEXT_FRAME_BYTES,
      });
      const transport = new HostRelayTransport({
        socket, connectionId, generation, hostId: this.options.hostId, routeId: this.route.routeId,
        hostStaticKey: this.options.hostStaticKey, protocol: this.options.protocol,
        onConnection: async (connection) => {
          if (this.data.get(connectionId) !== transport || !this.running) { transport.close(1000, "RELAY_GENERATION_REPLACED"); return; }
          this.dataAttempts.delete(connectionId);
          await this.options.onConnection(connection);
        },
        ...(this.options.openTimeoutMs !== undefined ? { openTimeoutMs: this.options.openTimeoutMs } : {}),
        ...(this.options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: this.options.handshakeTimeoutMs } : {}),
      });
      this.data.set(connectionId, transport);
      transport.onClose(() => {
        if (this.data.get(connectionId) !== transport) return;
        this.data.delete(connectionId);
        this.scheduleDataRetry(connectionId);
      });
    } catch { this.scheduleDataRetry(connectionId); }
  }

  private scheduleDataRetry(connectionId: string): void {
    if (!this.running || this.status !== "online" || !this.desiredIds.has(connectionId) || this.dataRetries.has(connectionId)) return;
    const attempt = this.dataAttempts.get(connectionId) ?? 0;
    this.dataAttempts.set(connectionId, attempt + 1);
    const timer = setTimeout(() => {
      this.dataRetries.delete(connectionId);
      this.attachData(connectionId);
    }, this.jitter(attempt));
    timer.unref?.();
    this.dataRetries.set(connectionId, timer);
  }

  private cancelDataRetry(connectionId: string): void {
    const timer = this.dataRetries.get(connectionId);
    if (timer) clearTimeout(timer);
    this.dataRetries.delete(connectionId);
    this.dataAttempts.delete(connectionId);
  }

  private startHeartbeat(control: ControlAttempt): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.control !== control) return;
      if (this.now() - control.lastSeenAt >= (this.options.livenessTimeoutMs ?? 30_000)) {
        this.failControl(control, "RELAY_CONTROL_LIVENESS_TIMEOUT");
        return;
      }
      const nonce = randomBytes(12).toString("base64url");
      control.pendingPings.add(nonce);
      if (control.pendingPings.size > 3) control.pendingPings.delete(control.pendingPings.values().next().value!);
      void this.sendControl(control, { type: "ping", nonce });
    }, this.options.heartbeatIntervalMs ?? 10_000);
    this.heartbeatTimer.unref?.();
  }

  private async sendControl(control: ControlAttempt, frame: { type: "ping" | "pong"; nonce: string }): Promise<void> {
    if (this.control !== control) return;
    if (control.socket.bufferedAmount > MAX_RELAY_CONTROL_FRAME_BYTES) { this.failControl(control, "RELAY_CONTROL_BACKPRESSURE"); return; }
    try { await sendRelaySocket(control.socket, JSON.stringify(frame)); }
    catch { this.failControl(control, "RELAY_CONTROL_SEND_FAILED"); }
  }

  private failControl(control: ControlAttempt, reason: string): void {
    if (this.control !== control) return;
    this.clearControl();
    if (this.running) this.scheduleReconnect(reason);
  }

  private clearControl(): void {
    const control = this.control;
    this.control = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (!control) return;
    clearTimeout(control.deadline);
    for (const off of control.unlisten) off();
    try { control.socket.close(1000, "RELAY_CONTROL_REPLACED"); } catch { /* already disconnected */ }
    control.socket.terminate();
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.retryTimer) return;
    this.transition("backoff", reason);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.route) void this.connectControl(this.epoch);
      else void this.registerAndConnect(this.epoch);
    }, this.jitter(this.attempts++));
    this.retryTimer.unref?.();
  }

  private jitter(attempt: number): number {
    return Math.floor(Math.max(0, Math.min(this.random(), 1)) * Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 15)));
  }
}
