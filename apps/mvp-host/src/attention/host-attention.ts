import { z, ZodError } from "zod";
import { AttentionCapability, AttentionMethodScopes, AttentionRegisterPushRequestSchema, AttentionPresenceRequestSchema, AttentionRouteSchema, InteractionSchema, type Interaction, type AttentionRoute, type SessionEvent } from "@flyx/mvp-protocol";
import type { DeviceRegistry, ConnectionPrincipal } from "../auth/device-registry.js";
import type { InteractionService } from "../interaction/interaction-service.js";
import { retainInteractionProjection } from "../interaction/interaction-store.js";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { assertRestoreWriteReady } from "../operations/restore-service.js";
import type { SqliteStore } from "../storage/db.js";
import { inspectSchema } from "../storage/migrations/schema-version.js";
import { ATTENTION_SCHEMA_VERSION } from "../storage/migrations/010-attention.js";
import { AttentionService, type AttentionPrincipal } from "./attention-service.js";
import { AttentionError, AttentionStore, type AttentionBudgets } from "./store.js";
import { DisabledAttentionDriver, ExpoAttentionDriver, EXPO_PUSH_SEND_ENDPOINT, type AttentionDeliveryDriver, type ExpoAttentionDriverOptions } from "./delivery-driver.js";

export type AttentionLeaseContext = { leaseId: string; generation: number };
export type HostAttentionRpc = {
  handle(context: AttentionLeaseContext, method: string, payload: unknown): Promise<unknown>;
  disconnect(context: AttentionLeaseContext): void;
};
export type HostAttentionOptions = {
  store: SqliteStore;
  owner: HostOwnerHandle;
  hostId: string;
  devices: DeviceRegistry;
  /** Construct InteractionService first: its projector must precede attention. */
  interactions: InteractionService;
  /** Fresh global R13 metadata reader for a reloaded Session; no ensureLoaded/SDK. */
  readInteraction?: (sessionId: string, interactionId: string) => Interaction;
  /** Catalog.assertActorSession(deviceId, sessionId, "session:read"); no runtime load. */
  assertActorSession(deviceId: string, sessionId: string): void;
  /** Fresh Host admission check, called immediately before every external send. */
  assertDeliveryReady(): void;
  /** host.trackOperation("producer", work), shared globally across Sessions. */
  trackDelivery(work: () => Promise<void>): Promise<void>;
  /** Trusted local configuration only. The destination is fixed by the Host. */
  push?: Omit<ExpoAttentionDriverOptions, "endpoint" | "now">;
  inApp?: (deviceId: string, route: AttentionRoute) => Promise<"presented" | "unavailable">;
  now?: () => Date;
  budgets?: Partial<AttentionBudgets>;
  pollMs?: number;
};

function assertSynchronous(value: unknown, code: string): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {}); throw new AttentionError(code);
  }
  if (value !== undefined) throw new AttentionError(code.replace("_ASYNC", "_INVALID"));
}

/** All existing service SQL paths, including late send results, use one guard. */
class OwnedAttentionStore extends AttentionStore {
  constructor(options: HostAttentionOptions, private readonly writeReady: () => void, private readonly deliveryReady: () => void) {
    super(options.store.db, options.hostId, options.budgets);
  }
  override transaction<T>(work: () => T): T { this.writeReady(); return super.transaction(() => { this.writeReady(); return work(); }); }
  override projectCommitted(...args: Parameters<AttentionStore["projectCommitted"]>) { this.writeReady(); return super.projectCommitted(...args); }
  override acknowledge(...args: Parameters<AttentionStore["acknowledge"]>) { this.writeReady(); return super.acknowledge(...args); }
  override setPreferences(...args: Parameters<AttentionStore["setPreferences"]>) { this.writeReady(); return super.setPreferences(...args); }
  override register(...args: Parameters<AttentionStore["register"]>) { this.writeReady(); return super.register(...args); }
  override unregister(...args: Parameters<AttentionStore["unregister"]>) { this.writeReady(); return super.unregister(...args); }
  override enqueue(...args: Parameters<AttentionStore["enqueue"]>) { this.writeReady(); return super.enqueue(...args); }
  override claim(...args: Parameters<AttentionStore["claim"]>) { this.deliveryReady(); return super.claim(...args); }
  override settle(...args: Parameters<AttentionStore["settle"]>) { this.writeReady(); return super.settle(...args); }
  override cancel(...args: Parameters<AttentionStore["cancel"]>) { this.writeReady(); return super.cancel(...args); }
  override retryUnavailable(...args: Parameters<AttentionStore["retryUnavailable"]>) { this.writeReady(); return super.retryUnavailable(...args); }
  override recoverDispatches(...args: Parameters<AttentionStore["recoverDispatches"]>) { this.writeReady(); return super.recoverDispatches(...args); }
  override invalidateDevice(...args: Parameters<AttentionStore["invalidateDevice"]>) { this.writeReady(); return super.invalidateDevice(...args); }
  override setRuntimeCode(...args: Parameters<AttentionStore["setRuntimeCode"]>) { this.writeReady(); return super.setRuntimeCode(...args); }
  override expire(...args: Parameters<AttentionStore["expire"]>) { this.writeReady(); return super.expire(...args); }
}

/** Global owned binding; construction installs no schema and invokes no sink. */
export class HostAttention {
  private state: "prepared" | "running" | "draining" | "sealed" = "prepared";
  private readonly attentionStore: OwnedAttentionStore;
  private readonly service: AttentionService;
  private readonly detach: () => void;
  private readonly releaseInteraction: () => void;
  private readonly leases = new Map<string, { context: AttentionLeaseContext; principal: AttentionPrincipal }>();
  private readonly now: () => Date;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingFlush: Promise<void> | undefined;
  /** registerShutdownService(this.shutdownService) on the global Host/Catalog. */
  readonly shutdownService = { drain: async (deadlineMs: number): Promise<void> => {
    if (!await this.drain(deadlineMs)) throw new AttentionError("ATTENTION_DRAIN_TIMEOUT");
  }, close: (): void => this.seal() };
  private readonly port: HostAttentionRpc = { handle: (context, method, payload) => this.handle(context, method, payload), disconnect: (context) => this.disconnect(context) };
  constructor(private readonly options: HostAttentionOptions) {
    this.now = options.now ?? (() => new Date()); this.pollMs = options.pollMs ?? 1000;
    assertHostOwner(options.owner); options.owner.assertStorePath(options.store.db.name); options.store.assertWriterOwner();
    if (options.owner.mode === "maintenance" || options.owner.recoveryOnly || options.devices.store !== options.store || options.devices.hostId !== options.hostId
      || options.interactions.store !== options.store || options.store.getHostIdentityMirror()?.hostId !== options.hostId) throw new AttentionError("ATTENTION_HOST_BINDING_INVALID");
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 10 || this.pollMs > 60000) throw new AttentionError("ATTENTION_CONFIGURATION_INVALID");
    if (inspectSchema(options.store.db).version < ATTENTION_SCHEMA_VERSION) throw new AttentionError("ATTENTION_SCHEMA_NOT_READY");
    this.attentionStore = new OwnedAttentionStore(options, () => this.assertWriteReady(), () => this.assertDeliveryReady());
    const sink: AttentionDeliveryDriver = options.push?.enabled
      ? new ExpoAttentionDriver({ ...options.push, endpoint: EXPO_PUSH_SEND_ENDPOINT, now: this.now }) : new DisabledAttentionDriver();
    const driver: AttentionDeliveryDriver = { configured: sink.configured, send: async (subscription, route, signal) => {
      this.assertSendReady(subscription.device_id, route);
      return sink.send(subscription, route, signal);
    } };
    this.service = new AttentionService({ store: this.attentionStore, driver, now: this.now,
      authorizeSession: (deviceId, sessionId) => this.sessionAllowed(deviceId, sessionId), wakeup: () => this.wake(),
      ...(options.inApp ? { inApp: async (deviceId: string, route: AttentionRoute) => {
        this.assertSendReady(deviceId, route); this.pruneLeases();
        if (![...this.leases.values()].some((lease) => lease.principal.deviceId === deviceId)) return "unavailable" as const;
        return options.inApp!(deviceId, route);
      } } : {}) });
    // Retain the same first hook even when individual Session services reload.
    this.releaseInteraction = retainInteractionProjection(options.store);
    try { this.detach = this.service.bindCommittedSource(options.store); }
    catch (error) { this.releaseInteraction(); throw error; }
  }
  private assertWriteReady(): void {
    if (this.state === "sealed") throw new AttentionError("ATTENTION_SEALED");
    assertHostOwner(this.options.owner); this.options.store.assertWriterOwner(); assertRestoreWriteReady(this.options.store.db);
    if (this.options.owner.recoveryOnly || this.options.store.getHostIdentityMirror()?.hostId !== this.options.hostId) throw new AttentionError("ATTENTION_HOST_BINDING_INVALID");
  }
  private assertDeliveryReady(): void {
    this.assertWriteReady();
    if (this.state !== "running") throw new AttentionError("ATTENTION_DELIVERY_CLOSED");
    if (this.options.owner.retainedReason) throw new AttentionError("ATTENTION_DELIVERY_CLOSED");
    const readiness: unknown = this.options.assertDeliveryReady(); assertSynchronous(readiness, "ATTENTION_ADMISSION_ASYNC");
  }
  private sessionAllowed(deviceId: string, sessionId: string): boolean {
    try { const authorization: unknown = this.options.assertActorSession(deviceId, sessionId); assertSynchronous(authorization, "ATTENTION_SESSION_ACL_ASYNC"); return true; } catch { return false; }
  }
  private assertSendReady(deviceId: string, route: AttentionRoute): void {
    this.assertDeliveryReady();
    const device = this.attentionStore.device(deviceId, this.now().toISOString());
    const fact = this.attentionStore.get(route.attentionId);
    if (route.hostId !== this.options.hostId || !device.scopes.has("session:read") || !this.sessionAllowed(deviceId, route.sessionId)
      || !fact || fact.session_id !== route.sessionId || fact.version !== route.version || !this.attentionStore.isCurrent(fact, this.now().toISOString())) throw new AttentionError("ATTENTION_DELIVERY_STALE");
  }
  private principal(context: AttentionLeaseContext): ConnectionPrincipal {
    if (this.state !== "running") throw new AttentionError("ATTENTION_RPC_CLOSED");
    this.assertDeliveryReady();
    if (typeof context.leaseId !== "string" || !context.leaseId || !Number.isSafeInteger(context.generation) || context.generation < 0) throw new AttentionError("ATTENTION_CONTEXT_INVALID");
    const current = this.options.devices.assertLease(context.leaseId, context.generation);
    if (current.hostId !== this.options.hostId) throw new AttentionError("ATTENTION_HOST_MISMATCH");
    if (!this.options.store.getProtocolSession(context.leaseId)?.capabilities.includes(AttentionCapability)) throw new AttentionError("ATTENTION_NOT_NEGOTIATED");
    return current;
  }
  rpc(): HostAttentionRpc | undefined { try { this.assertDeliveryReady(); return this.port; } catch { return undefined; } }
  capabilities(): string[] {
    try { this.assertDeliveryReady(); return [AttentionCapability]; } catch { return []; }
  }
  async handle(context: AttentionLeaseContext, method: string, payload: unknown): Promise<unknown> {
    try {
      if (!Object.hasOwn(AttentionMethodScopes, method)) throw new AttentionError("METHOD_NOT_FOUND");
      const principal = this.principal(context);
      if (!principal.scopes.has(AttentionMethodScopes[method as keyof typeof AttentionMethodScopes])) throw new AttentionError("FORBIDDEN");
      if (!["attention.list", "attention.getPreferences"].includes(method)) this.assertWriteReady();
      if (method === "attention.getPreferences") z.object({}).strict().parse(payload);
      if (method === "attention.registerPush") {
        const request = AttentionRegisterPushRequestSchema.parse(payload);
        if (!this.options.push?.enabled) throw new AttentionError("PUSH_SINK_UNAVAILABLE");
        if (request.projectId !== this.options.push.projectId) throw new AttentionError("PUSH_PROJECT_MISMATCH");
      }
      if (method === "attention.setPresence") {
        const request = AttentionPresenceRequestSchema.parse(payload);
        if (request.sessionId && !this.sessionAllowed(principal.deviceId, request.sessionId)) throw new AttentionError("FORBIDDEN");
        this.pruneLeases();
        if (!this.leases.has(context.leaseId) && this.leases.size >= 1024) throw new AttentionError("ATTENTION_LEASE_BUDGET_EXCEEDED");
        this.leases.set(context.leaseId, { context: { ...context }, principal });
      }
      return await this.service.handleRpc(principal, method, payload);
    } catch (error) {
      if (error instanceof AttentionError) throw error;
      if (error instanceof ZodError) throw new AttentionError("INVALID_PARAMS");
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "ATTENTION_FAILED";
      throw new AttentionError(/^[A-Z][A-Z0-9_]{1,95}$/.test(code) ? code : "ATTENTION_FAILED");
    }
  }
  /** A reminder opens fresh authorized facts; it never executes its old action. */
  inspectRoute(context: AttentionLeaseContext, value: unknown) {
    const route = AttentionRouteSchema.parse(value), principal = this.principal(context);
    if (route.hostId !== this.options.hostId) throw new AttentionError("ATTENTION_HOST_MISMATCH");
    if (!principal.scopes.has("session:read") || !this.sessionAllowed(principal.deviceId, route.sessionId)) throw new AttentionError("FORBIDDEN");
    const fact = this.attentionStore.get(route.attentionId);
    if (!fact || fact.session_id !== route.sessionId || fact.version !== route.version || (fact.turn_id ?? undefined) !== route.turnId
      || (fact.interaction_id ?? undefined) !== route.interactionId) throw new AttentionError("ATTENTION_NOT_FOUND");
    const session = this.options.store.getSession(route.sessionId);
    if (!session) throw new AttentionError("ATTENTION_NOT_FOUND");
    const interaction = fact.interaction_id && this.options.interactions.interactions.get(fact.interaction_id)
      ? InteractionSchema.parse(this.options.readInteraction ? this.options.readInteraction(route.sessionId, fact.interaction_id) : this.options.interactions.get(route.sessionId, fact.interaction_id)) : undefined;
    const legacy = fact.interaction_id && !interaction ? this.options.store.getApproval(fact.interaction_id) : undefined;
    const approval = legacy?.sessionId === route.sessionId ? { approvalId: legacy.approvalId, status: legacy.status, version: legacy.version } : undefined;
    return { route: this.attentionStore.route(fact), stale: !this.attentionStore.isCurrent(fact, this.now().toISOString()),
      session: { sessionId: session.id, activityState: session.activityState, recoveryState: session.recoveryState, recoveryRevision: session.recoveryRevision,
        ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}) }, ...(interaction ? { interaction } : {}), ...(approval ? { approval } : {}) };
  }
  disconnect(context: AttentionLeaseContext): void {
    const saved = this.leases.get(context.leaseId);
    if (!saved || saved.context.generation !== context.generation) return;
    this.service.disconnect(saved.principal); this.leases.delete(context.leaseId);
  }
  private pruneLeases(): void {
    for (const { context } of this.leases.values()) {
      try { this.options.devices.assertLease(context.leaseId, context.generation); } catch { this.disconnect(context); }
    }
  }
  /** Safe only after the Device credential/revocation transaction has committed. */
  onDeviceRevoked(deviceId: string): void {
    this.assertWriteReady(); this.service.onDeviceRevoked(deviceId);
    for (const { context, principal } of this.leases.values()) if (principal.deviceId === deviceId) this.disconnect(context);
  }
  /** Publish path only: the fact and its queue were already written by the hook. */
  async postCommitWake(source: string | SessionEvent): Promise<void> {
    this.assertWriteReady();
    if (this.options.store.db.inTransaction) throw new AttentionError("ATTENTION_POST_COMMIT_REQUIRED");
    const row = typeof source === "string" ? { commit_id: source } : this.options.store.db.prepare("SELECT commit_id FROM session_events WHERE id=? AND session_id=? AND sequence=?").get(source.id, source.sessionId, source.sequence) as { commit_id: string | null } | undefined;
    if (!row?.commit_id) throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    await this.service.notifyCommitted(row.commit_id);
  }
  /** Does not replay old source batches or manufacture new reminders on restart. */
  start(): void {
    if (this.state !== "prepared") throw new AttentionError("ATTENTION_START_INVALID");
    this.assertWriteReady(); const readiness: unknown = this.options.assertDeliveryReady(); assertSynchronous(readiness, "ATTENTION_ADMISSION_ASYNC"); this.service.recoverPendingDispatches(); this.state = "running";
    this.timer = setInterval(() => { void this.wake().catch(() => {}); }, this.pollMs); this.timer.unref();
    void this.wake().catch(() => {});
  }
  private wake(): Promise<void> { return this.state === "running" ? this.flush() : Promise.resolve(); }
  /** Bounded worker tick; failures remain durable and never retry unknown sends. */
  flush(limit = 32): Promise<void> {
    if (this.pendingFlush) return this.pendingFlush;
    const work = Promise.resolve().then(() => {
      this.assertDeliveryReady(); this.pruneLeases();
      return this.options.trackDelivery(() => { this.assertDeliveryReady(); return this.service.drain(limit); });
    });
    this.pendingFlush = work;
    void work.finally(() => { if (this.pendingFlush === work) this.pendingFlush = undefined; }).catch(() => {});
    return work;
  }
  /** Stop sends, keep the projector through the Host's final unknown commits. */
  async drain(deadlineMs: number): Promise<boolean> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new AttentionError("ATTENTION_DEADLINE_INVALID");
    if (this.state !== "sealed") this.state = "draining";
    if (this.timer) clearInterval(this.timer); this.timer = undefined; this.service.abortDeliveries();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = Promise.all([this.pendingFlush?.catch(() => {}), this.service.awaitIdle().catch(() => {})]).then(() => true);
    try { return await Promise.race([idle, new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs - Date.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  /** Called after the final Engine commits and before shared Store/owner close. */
  seal(): void {
    if (this.state === "sealed") return;
    this.state = "sealed"; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.service.abortDeliveries(); this.detach(); this.releaseInteraction();
    for (const { context } of this.leases.values()) this.disconnect(context);
  }
}
export function createHostAttentionBindings(options: HostAttentionOptions): HostAttention { return new HostAttention(options); }
export function attentionRpc(host: HostAttention, context: AttentionLeaseContext, method: string, payload: unknown): Promise<unknown> { return host.handle(context, method, payload); }
