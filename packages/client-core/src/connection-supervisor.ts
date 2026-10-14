import { abortError, ClientError, errorInfo, Signal } from "./common.js";
import { createBrowserPlatformSignals, systemMonotonicClock } from "./platform.js";
import type { ClockTimer, MonotonicClock, PlatformSignal, PlatformSignals } from "./platform.js";
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
  /** Kept for existing shells. New shells inject all lifecycle facts together. */
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  platformSignals?: PlatformSignals;
  clock?: MonotonicClock;
  random?: () => number;
  heartbeatMs?: number;
  probeMs?: number;
  stableWindowMs?: number;
  suspensionThresholdMs?: number;
  probeDeadlineMs?: number;
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
  private leaseStable = false;
  private retryTimer: ClockTimer | undefined;
  private heartbeatTimer: ClockTimer | undefined;
  private probeTimer: ClockTimer | undefined;
  private stableTimer: ClockTimer | undefined;
  private pendingPing: { nonce: string; sentAt: number; generation: number } | undefined;
  private leaseProbe: { generation: number; finish: (ok: boolean) => void; timer: ClockTimer } | undefined;
  private missedHeartbeats = 0;
  private probes = new Map<string, number>();
  private probingGeneration: number | undefined;
  private activeWork: Promise<void> | undefined;
  private replacementQueued = false;
  private hiddenAt: number | undefined;
  private platform: PlatformSignals;
  private clock: MonotonicClock;
  private offPlatform: Unsubscribe | undefined;
  constructor(private options: SupervisorOptions) {
    this.clock = options.clock ?? options.platformSignals?.clock ?? systemMonotonicClock;
    this.platform = options.platformSignals ?? createBrowserPlatformSignals({ clock: this.clock, ...(options.onlineTarget ? { onlineTarget: options.onlineTarget } : {}) });
  }
  getState(): SupervisorState { return { ...this.state }; }
  get generation(): number { return this.state.transportGeneration; }
  onState(handler: (state: SupervisorState) => void): Unsubscribe { handler(this.getState()); return this.changed.subscribe(handler); }
  private update(patch: Partial<SupervisorState>): void { this.state = { ...this.state, ...patch }; this.changed.emit(this.getState()); }
  private publishEndpoint(endpoint: ConnectionEndpoint): void { this.options.endpointChanged?.({ ...endpoint }); }
  private cancelTimers(): void {
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    if (this.stableTimer !== undefined) this.clock.clearTimeout(this.stableTimer);
    if (this.heartbeatTimer !== undefined) this.clock.clearInterval(this.heartbeatTimer);
    if (this.probeTimer !== undefined) this.clock.clearInterval(this.probeTimer);
    this.retryTimer = this.stableTimer = this.heartbeatTimer = this.probeTimer = undefined;
  }
  private invalidate(): void {
    // Fence callbacks before abort/close, which can synchronously call listeners.
    this.update({ transportGeneration: this.generation + 1 });
    this.controller?.abort();
    this.controller = undefined;
    const old = this.transport;
    this.transport = undefined;
    this.cancelTimers();
    if (this.leaseProbe) { this.clock.clearTimeout(this.leaseProbe.timer); this.leaseProbe.finish(false); this.leaseProbe = undefined; }
    this.pendingPing = undefined;
    this.missedHeartbeats = 0;
    this.leaseStable = false;
    this.probes.clear();
    old?.close(1000, "CONNECTION_REPLACED");
  }
  async start(): Promise<void> {
    if (this.running) return this.activeWork;
    this.running = true;
    this.offPlatform = this.platform.subscribe((signal) => this.platformChanged(signal));
    this.hiddenAt = this.platform.getState().visibility === "hidden" ? this.clock.now() : undefined;
    await this.wake("connect");
  }
  stop(): void {
    this.running = false;
    this.offPlatform?.();
    this.offPlatform = undefined;
    this.activeWork = undefined;
    this.replacementQueued = false;
    this.hiddenAt = undefined;
    this.invalidate();
    this.update({ connection: "closed" });
  }
  async reconnect(endpointId?: string): Promise<void> {
    if (!this.running) return this.start();
    await this.wake("connect", endpointId);
  }
  private waitOnline(): void {
    if (this.state.error?.code !== "OFFLINE" || this.controller) this.invalidate();
    // Offline time consumes neither retry attempts nor a retry timer.
    this.activeWork = undefined;
    this.replacementQueued = false;
    this.update({ connection: "reconnecting", error: { code: "OFFLINE", message: "Waiting for a network connection" } });
  }
  private platformChanged(signal: PlatformSignal): void {
    if (!this.running) return;
    if (signal.type === "offline") { this.waitOnline(); return; }
    if (signal.type === "visibility" && signal.visibility === "hidden") {
      this.hiddenAt ??= this.clock.now();
      if (this.stableTimer !== undefined) this.clock.clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
      return;
    }
    if (this.platform.getState().visibility === "hidden") return;
    if (signal.type === "online") {
      if (this.state.connection !== "online") void this.wake("connect");
      return;
    }
    const suspendedFor = this.hiddenAt === undefined ? 0 : Math.max(0, this.clock.now() - this.hiddenAt);
    this.hiddenAt = undefined;
    if (terminalErrors.has(this.state.error?.code ?? "") && this.state.connection === "failed") return;
    void this.wake(suspendedFor >= (this.options.suspensionThresholdMs ?? 60_000) ? "connect" : "probe");
  }
  /** One entry point for online, retry, lifecycle, heartbeat and endpoint upgrades. */
  private wake(mode: "connect" | "probe", preferred?: string): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (!this.platform.getState().online) { this.waitOnline(); return Promise.resolve(); }
    if (this.activeWork) return this.activeWork;
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const work = Promise.resolve().then(async () => {
      if (!this.running || !this.platform.getState().online) return;
      if (mode === "probe" && this.transport && this.state.connection === "online") await this.probeCurrentLease();
      else await this.connect(preferred);
    }).finally(() => {
      if (this.activeWork !== work) return;
      this.activeWork = undefined;
      if (this.replacementQueued) { this.replacementQueued = false; void this.wake("connect"); }
    });
    this.activeWork = work;
    return work;
  }
  private replaceFailedLease(error?: ClientErrorInfo): void {
    if (!this.running) return;
    if (!this.leaseStable) this.attempt++;
    this.update({ connection: "degraded", ...(error ? { error } : {}) });
    this.invalidate();
    if (this.activeWork) this.replacementQueued = true;
    else void this.wake("connect");
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
    if (!this.running || !this.platform.getState().online) { if (this.running) this.waitOnline(); return; }
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
      const startedAt = this.clock.now();
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
          if (this.state.connection === "online" || this.state.connection === "degraded") this.replaceFailedLease();
        });
        await this.options.activate(transport, endpoint, controller.signal);
        if (!isCurrent()) { transport.close(1000, "CONNECTION_REPLACED"); return; }
        if (this.transport !== transport || transportClosed) throw abortError();
        endpoint.availability = "available";
        endpoint.lastRttMs = Math.max(0, this.clock.now() - startedAt);
        this.publishEndpoint(endpoint);
        delete this.state.error;
        this.update({ connection: "online" });
        if (!isCurrent()) return;
        this.scheduleStableReset(generation);
        this.heartbeatTimer = this.clock.setInterval(() => { void this.heartbeat(); }, this.options.heartbeatMs ?? 15_000);
        this.probeTimer = this.clock.setInterval(() => { void this.probePreferred(); }, this.options.probeMs ?? 30_000);
        return;
      } catch (error) {
        // A late failure must not erase a replacement transport.
        if (this.transport === transport) this.transport = undefined;
        transport?.close(1000, "CONNECTION_FAILED");
        if (!isCurrent()) return;
        lastError = error;
        const code = errorInfo(error).code;
        if (code === "AUTH_REFRESHED") {
          // The rotated credential is durable; the response's lease is retired.
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
    if (!this.platform.getState().online) { this.waitOnline(); return; }
    this.update({ connection: sawRetryable ? "reconnecting" : "failed", error: errorInfo(lastError) });
    if (!sawRetryable) return;
    const maximum = Math.min(30_000, 500 * 2 ** Math.min(this.attempt++, 8));
    const random = Math.max(0, Math.min(1, (this.options.random ?? Math.random)()));
    this.retryTimer = this.clock.setTimeout(() => { if (isCurrent()) void this.wake("connect"); }, Math.floor(random * maximum));
  }
  private scheduleStableReset(generation: number): void {
    if (this.stableTimer !== undefined) this.clock.clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    if (this.platform.getState().visibility === "hidden") return;
    this.stableTimer = this.clock.setTimeout(() => {
      this.stableTimer = undefined;
      if (this.running && generation === this.generation && this.state.connection === "online" && this.platform.getState().visibility === "visible") { this.attempt = 0; this.leaseStable = true; }
    }, this.options.stableWindowMs ?? 30_000);
  }
  private async probeCurrentLease(): Promise<void> {
    const generation = this.generation;
    const nonce = crypto.randomUUID();
    const acknowledged = new Promise<boolean>((finish) => {
      const timer = this.clock.setTimeout(() => finish(false), this.options.probeDeadlineMs ?? 5_000);
      this.leaseProbe = { generation, finish, timer };
    });
    this.pendingPing = { nonce, sentAt: this.clock.now(), generation };
    void this.options.ping(nonce).catch(() => { if (this.leaseProbe?.generation === generation) this.leaseProbe.finish(false); });
    const ok = await acknowledged;
    if (this.leaseProbe?.generation === generation) { this.clock.clearTimeout(this.leaseProbe.timer); this.leaseProbe = undefined; }
    if (!this.running || generation !== this.generation) return;
    if (ok) { this.scheduleStableReset(generation); return; }
    if (!this.leaseStable) this.attempt++;
    this.update({ connection: "degraded", error: { code: "HEARTBEAT_TIMEOUT", message: "Host lease probe timed out" } });
    await this.connect();
  }
  private async heartbeat(): Promise<void> {
    if (!this.running || this.state.connection !== "online" || this.platform.getState().visibility === "hidden" || this.leaseProbe) return;
    if (this.pendingPing && ++this.missedHeartbeats >= 2) {
      const endpoint = this.options.endpoints().find((value) => value.id === this.state.endpointId);
      if (endpoint) { endpoint.availability = "unavailable"; this.publishEndpoint(endpoint); }
      this.replaceFailedLease({ code: "HEARTBEAT_TIMEOUT", message: "Host heartbeat timed out" });
      return;
    }
    if (this.pendingPing) return;
    const nonce = crypto.randomUUID();
    const generation = this.generation;
    this.pendingPing = { nonce, sentAt: this.clock.now(), generation };
    try { await this.options.ping(nonce); }
    catch { if (this.running && generation === this.generation) this.replaceFailedLease(); }
  }
  receivedPong(nonce: string): void {
    if (this.pendingPing?.nonce !== nonce || this.pendingPing.generation !== this.generation) return;
    const endpoint = this.options.endpoints().find((value) => value.id === this.state.endpointId);
    if (endpoint) { endpoint.lastRttMs = Math.max(0, this.clock.now() - this.pendingPing.sentAt); this.publishEndpoint(endpoint); }
    this.pendingPing = undefined;
    this.missedHeartbeats = 0;
    this.leaseProbe?.finish(true);
  }
  private async probePreferred(): Promise<void> {
    if (this.probingGeneration !== undefined || !this.options.probe || this.state.transportKind !== "relay" || this.state.connection !== "online" || this.platform.getState().visibility === "hidden" || this.activeWork) return;
    const generation = this.generation;
    this.probingGeneration = generation;
    const signal = this.controller?.signal;
    try {
      if (!signal) return;
      for (const endpoint of this.orderedEndpoints().filter((candidate) => candidate.kind === "direct-https")) {
        try {
          const rtt = await this.options.probe(endpoint, signal);
          if (generation !== this.generation || signal.aborted) return;
          const count = (this.probes.get(endpoint.id) ?? 0) + 1;
          this.probes.set(endpoint.id, count);
          endpoint.availability = "available";
          endpoint.lastRttMs = rtt;
          this.publishEndpoint(endpoint);
          const currentRtt = this.options.endpoints().find((candidate) => candidate.id === this.state.endpointId)?.lastRttMs;
          const beneficial = this.options.preferredEndpointId?.() === endpoint.id || currentRtt !== undefined && currentRtt - rtt >= 40;
          if (count >= 3 && beneficial && (this.options.canUpgrade?.() ?? true)) { await this.wake("connect", endpoint.id); return; }
        } catch { if (generation === this.generation) this.probes.set(endpoint.id, 0); }
      }
    } finally { if (this.probingGeneration === generation) this.probingGeneration = undefined; }
  }
}
