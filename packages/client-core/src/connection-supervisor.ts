import { abortError, ClientError, errorInfo, Signal } from "./common.js";
import type { ClientErrorInfo, ClientTransport, ConnectionEndpoint, ConnectionState, Unsubscribe } from "./types.js";

export interface SupervisorState {
  connection: ConnectionState;
  transportGeneration: number;
  endpointId?: string;
  transportKind?: "direct" | "relay";
  error?: ClientErrorInfo;
}
export interface SupervisorOptions {
  endpoints: () => ConnectionEndpoint[];
  preferredEndpointId?: () => string | undefined;
  connect: (endpoint: ConnectionEndpoint, generation: number, signal: AbortSignal) => Promise<ClientTransport>;
  activate: (transport: ClientTransport, endpoint: ConnectionEndpoint, signal: AbortSignal) => Promise<void>;
  probe?: (endpoint: ConnectionEndpoint, signal: AbortSignal) => Promise<number>;
  endpointChanged?: (endpoint: ConnectionEndpoint) => void;
  canUpgrade?: () => boolean;
  ping: (nonce: string) => Promise<void>;
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  random?: () => number;
  heartbeatMs?: number;
  probeMs?: number;
  allowLoopback?: boolean;
}

const terminalErrors = new Set(["PAIRING_REQUIRED", "AUTHENTICATION_REQUIRED", "DEVICE_REVOKED", "CREDENTIAL_EXPIRED", "IDENTITY_MISMATCH", "PROTOCOL_UNSUPPORTED", "UNSAFE_ENDPOINT"]);
export class ConnectionSupervisor {
  private state: SupervisorState = { connection: "idle", transportGeneration: 0 };
  private changed = new Signal<SupervisorState>();
  private transport: ClientTransport | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private pendingPing: { nonce: string; sentAt: number } | undefined;
  private missedHeartbeats = 0;
  private probes = new Map<string, number>();
  private probing = false;
  private onlineHandler = () => { if (this.running && this.state.connection !== "online" && this.state.connection !== "authenticating") void this.reconnect(); };
  constructor(private options: SupervisorOptions) {}
  getState(): SupervisorState { return { ...this.state }; }
  get generation(): number { return this.state.transportGeneration; }
  onState(handler: (state: SupervisorState) => void): Unsubscribe { handler(this.getState()); return this.changed.subscribe(handler); }
  private update(patch: Partial<SupervisorState>): void { this.state = { ...this.state, ...patch }; this.changed.emit(this.getState()); }
  private publishEndpoint(endpoint: ConnectionEndpoint): void { this.options.endpointChanged?.({ ...endpoint }); }
  private cancelTimers(): void { clearTimeout(this.retryTimer); clearInterval(this.heartbeatTimer); clearInterval(this.probeTimer); this.retryTimer = undefined; this.heartbeatTimer = undefined; this.probeTimer = undefined; }
  private invalidate(): void {
    // Fence callbacks before aborting/closing a transport; close may be synchronous.
    this.update({ transportGeneration: this.generation + 1 });
    this.controller?.abort();
    this.controller = undefined;
    const old = this.transport;
    this.transport = undefined;
    this.cancelTimers();
    this.pendingPing = undefined;
    this.missedHeartbeats = 0;
    old?.close(1000, "CONNECTION_REPLACED");
  }
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.options.onlineTarget?.addEventListener("online", this.onlineHandler);
    await this.connect();
  }
  stop(): void {
    this.running = false;
    this.options.onlineTarget?.removeEventListener("online", this.onlineHandler);
    this.invalidate();
    this.update({ connection: "closed" });
  }
  async reconnect(endpointId?: string): Promise<void> {
    if (!this.running) return this.start();
    await this.connect(endpointId);
  }
  private orderedEndpoints(preferred?: string): ConnectionEndpoint[] {
    const explicit = preferred ?? this.options.preferredEndpointId?.();
    return this.options.endpoints().filter((endpoint) => {
      try {
        const value = endpoint.kind === "relay-wss" ? endpoint.relayUrl : endpoint.baseUrl;
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return false;
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (endpoint.kind === "relay-wss") return url.protocol === "wss:";
        return url.protocol === "https:" || this.options.allowLoopback === true && loopback && url.protocol === "http:";
      } catch { return false; }
    }).sort((a, b) => {
      const score = (endpoint: ConnectionEndpoint) => (endpoint.availability === "unavailable" ? 20 : 0) + (endpoint.id === explicit ? -10 : endpoint.id === this.state.endpointId && endpoint.availability !== "unavailable" ? -5 : endpoint.kind === "direct-https" && endpoint.source !== "manual" ? 0 : endpoint.kind === "relay-wss" ? 1 : 2);
      return score(a) - score(b);
    });
  }
  private async connect(preferred?: string): Promise<void> {
    this.invalidate();
    let generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const isCurrent = () => this.running && this.controller === controller && !controller.signal.aborted;
    this.update({ connection: this.attempt ? "reconnecting" : "connecting" });
    let lastError: unknown = new ClientError("NO_ENDPOINT", "No secure Host endpoint is available");
    let sawRetryable = false;
    let candidateIndex = 0;
    for (const endpoint of this.orderedEndpoints(preferred)) {
      if (!isCurrent()) return;
      if (candidateIndex++ > 0) { generation = this.generation + 1; this.update({ transportGeneration: generation }); }
      const startedAt = Date.now();
      let transport: ClientTransport | undefined;
      let transportClosed = false;
      try {
        transport = await this.options.connect(endpoint, generation, controller.signal);
        if (!isCurrent()) { transport.close(1000, "CONNECTION_REPLACED"); return; }
        this.transport = transport;
        this.update({ connection: "authenticating", endpointId: endpoint.id, transportKind: transport.kind });
        const currentTransport = transport;
        transport.onClose(() => {
          transportClosed = true;
          if (!isCurrent() || this.transport !== currentTransport) return;
          endpoint.availability = "unavailable";
          this.publishEndpoint(endpoint);
          if (this.state.connection === "online" || this.state.connection === "degraded") {
            this.update({ connection: "degraded" });
            void this.connect();
          }
        });
        await this.options.activate(transport, endpoint, controller.signal);
        if (!isCurrent()) { transport.close(1000, "CONNECTION_REPLACED"); return; }
        if (this.transport !== transport || transportClosed) throw abortError();
        endpoint.availability = "available";
        endpoint.lastRttMs = Date.now() - startedAt;
        this.publishEndpoint(endpoint);
        this.attempt = 0;
        delete this.state.error;
        this.update({ connection: "online" });
        this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, this.options.heartbeatMs ?? 15_000);
        this.probeTimer = setInterval(() => { void this.probePreferred(); }, this.options.probeMs ?? 30_000);
        return;
      } catch (error) {
        this.transport = undefined;
        transport?.close(1000, "CONNECTION_FAILED");
        if (!isCurrent()) return;
        lastError = error;
        const code = errorInfo(error).code;
        if (code === "AUTH_REFRESHED") {
          // Pair/refresh rotates the lease which carried the response. The
          // replacement credential is already durable, so reconnect this same
          // endpoint immediately instead of marking it bad or falling back.
          endpoint.availability = "available";
          this.publishEndpoint(endpoint);
          return this.connect(endpoint.id);
        }
        if (!terminalErrors.has(code)) sawRetryable = true;
        endpoint.availability = "unavailable";
        this.publishEndpoint(endpoint);
        if (code === "IDENTITY_MISMATCH") { sawRetryable = false; break; }
      }
    }
    if (!isCurrent()) return;
    this.update({ connection: sawRetryable ? "reconnecting" : "failed", error: errorInfo(lastError) });
    if (!sawRetryable) return;
    const maximum = Math.min(30_000, 500 * 2 ** Math.min(this.attempt++, 8));
    const delay = Math.floor((this.options.random ?? Math.random)() * maximum);
    this.retryTimer = setTimeout(() => { if (isCurrent()) void this.connect(); }, delay);
  }
  private async heartbeat(): Promise<void> {
    if (!this.running || this.state.connection !== "online") return;
    if (this.pendingPing && ++this.missedHeartbeats >= 2) {
      const endpoint = this.options.endpoints().find((value) => value.id === this.state.endpointId);
      if (endpoint) { endpoint.availability = "unavailable"; this.publishEndpoint(endpoint); }
      this.update({ connection: "degraded", error: { code: "HEARTBEAT_TIMEOUT", message: "Host heartbeat timed out" } });
      await this.connect();
      return;
    }
    if (this.pendingPing) return;
    const nonce = crypto.randomUUID();
    this.pendingPing = { nonce, sentAt: Date.now() };
    try { await this.options.ping(nonce); }
    catch { await this.connect(); }
  }
  receivedPong(nonce: string): void {
    if (this.pendingPing?.nonce !== nonce) return;
    const endpoint = this.options.endpoints().find((value) => value.id === this.state.endpointId);
    if (endpoint) { endpoint.lastRttMs = Date.now() - this.pendingPing.sentAt; this.publishEndpoint(endpoint); }
    this.pendingPing = undefined;
    this.missedHeartbeats = 0;
  }
  private async probePreferred(): Promise<void> {
    if (this.probing || !this.options.probe || this.state.transportKind !== "relay" || this.state.connection !== "online") return;
    this.probing = true;
    const generation = this.generation;
    const signal = this.controller?.signal;
    try {
      if (!signal) return;
      for (const endpoint of this.orderedEndpoints().filter((candidate) => candidate.kind === "direct-https")) {
        try {
          const rtt = await this.options.probe(endpoint, signal);
          if (generation !== this.generation) return;
          const count = (this.probes.get(endpoint.id) ?? 0) + 1;
          this.probes.set(endpoint.id, count);
          endpoint.availability = "available";
          endpoint.lastRttMs = rtt;
          this.publishEndpoint(endpoint);
          const currentRtt = this.options.endpoints().find((candidate) => candidate.id === this.state.endpointId)?.lastRttMs;
          const beneficial = this.options.preferredEndpointId?.() === endpoint.id || currentRtt !== undefined && currentRtt - rtt >= 40;
          if (count >= 3 && beneficial && (this.options.canUpgrade?.() ?? true)) { await this.connect(endpoint.id); return; }
        } catch { this.probes.set(endpoint.id, 0); }
      }
    } finally { this.probing = false; }
  }
}
