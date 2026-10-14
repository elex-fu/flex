import { ATTENTION_MAX_PAGE_BYTES, AttentionAcknowledgeRequestSchema, AttentionListRequestSchema, AttentionListResponseSchema, AttentionMethodScopes, AttentionPreferencesSchema, AttentionPresenceRequestSchema, AttentionRegisterPushRequestSchema, AttentionSetPreferencesRequestSchema, AttentionSubscriptionSchema, AttentionUnregisterPushRequestSchema, type AttentionRoute, type AttentionListResponse, type AttentionSummary, } from "@flyx/mvp-protocol";
import { AttentionError, AttentionStore, type AttentionCommitSource, type AttentionFact, type AttentionDelivery } from "./store.js";
import { DisabledAttentionDriver, type AttentionDeliveryDriver, type AttentionDeliveryResult } from "./delivery-driver.js";
export type AttentionPrincipal = {
  deviceId: string;
  hostId: string;
  scopes: ReadonlySet<string>;
  leaseId?: string;
};
export interface AttentionServiceOptions {
  store: AttentionStore;
  driver?: AttentionDeliveryDriver;
  now?: () => Date;
  authorizeSession?: (deviceId: string, sessionId: string) => boolean;
  inApp?: (deviceId: string, payload: AttentionRoute) => Promise<"presented" | "unavailable">;
  wakeup?: () => void | Promise<void>;
}
export class AttentionService {
  readonly store: AttentionStore;
  private readonly driver: AttentionDeliveryDriver;
  private readonly now: () => Date;
  private readonly presence = new Map<string, Map<string, {
    foreground: boolean;
    sessionId?: string;
  }>>();
  private readonly inFlight = new Map<string, Set<AbortController>>();
  private draining: Promise<void> | undefined;
  constructor(private readonly options: AttentionServiceOptions) { this.store = options.store; this.driver = options.driver ?? new DisabledAttentionDriver(); this.now = options.now ?? (() => new Date()); }
  private timestamp(): string { return this.now().toISOString(); }
  private requireOutsideTransaction(): void {
    if (this.store.db.inTransaction)
      throw new AttentionError("ATTENTION_POST_COMMIT_REQUIRED");
  }
  private authorize(principal: AttentionPrincipal, scope: string): void {
    if (principal.hostId !== this.store.hostId)
      throw new AttentionError("ATTENTION_HOST_MISMATCH");
    const current = this.store.device(principal.deviceId, this.timestamp());
    if (!principal.scopes.has(scope) || !current.scopes.has(scope))
      throw new AttentionError("FORBIDDEN");
  }
  private sessionAllowed(deviceId: string, sessionId: string): boolean { return this.options.authorizeSession?.(deviceId, sessionId) ?? true; }
  private eligible(deviceId: string, fact: AttentionFact): boolean {
    try {
      return this.store.device(deviceId, this.timestamp()).scopes.has("session:read") && this.sessionAllowed(deviceId, fact.session_id);
    }
    catch {
      return false;
    }
  }
  private surface(deviceId: string, fact: AttentionFact): "in_app" | "push" {
    const active = [...(this.presence.get(deviceId)?.values() ?? [])].some((value) => value.foreground && (!value.sessionId || value.sessionId === fact.session_id));
    return active && this.options.inApp ? "in_app" : "push";
  }
  bindCommittedSource(source: AttentionCommitSource): () => void {
    if (source.db !== this.store.db)
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    return source.registerCommitHook((events, commit) => {
      this.store.projectCommitted(events, commit);
      this.enqueueFacts(this.store.factsForCommit(commit.id), this.timestamp());
    });
  }
  /** Called by the Engine's successful post-commit publication/lifecycle wake path. */
  async notifyCommitted(commitId: string): Promise<void> {
    this.requireOutsideTransaction();
    if (!this.store.db.prepare("SELECT 1 FROM event_commits WHERE id=?").get(commitId))
      throw new AttentionError("ATTENTION_SOURCE_MISMATCH");
    if (this.store.factsForCommit(commitId).length === 0)
      return;
    await this.wakeup();
  }
  private async wakeup(): Promise<void> {
    try {
      await this.options.wakeup?.();
    }
    catch {
      if (this.store.db.open)
        this.store.setRuntimeCode("wakeup", "ATTENTION_WAKEUP_UNAVAILABLE", this.timestamp());
    }
  }
  private async catchUpDevice(deviceId: string): Promise<void> {
    this.enqueueOutstanding(deviceId);
    await this.wakeup();
  }
  private enqueueFacts(facts: readonly AttentionFact[], now: string, devices?: readonly string[]): void {
    if (facts.length === 0)
      return;
    const audience = devices ?? this.store.devices(now);
    for (const fact of facts) {
      if (!this.store.isCurrent(fact, now))
        continue;
      for (const deviceId of audience) {
        if (!this.eligible(deviceId, fact))
          continue;
        const pref = this.store.preferences(deviceId);
        if (pref.mode === "none" || pref.mode === "interactions" && !["approval", "question"].includes(fact.kind))
          continue;
        if (!this.store.enqueue(fact, deviceId, this.surface(deviceId, fact), now))
          this.store.setRuntimeCode("queue", "ATTENTION_QUEUE_BUDGET_EXCEEDED", now);
      }
    }
  }
  /** Startup/device-registration catch-up; streaming commits enqueue only their own facts. */
  enqueueOutstanding(deviceId?: string): void {
    this.requireOutsideTransaction();
    const now = this.timestamp();
    this.store.transaction(() => {
      this.store.expire(now);
      const devices = deviceId ? [deviceId] : this.store.devices(now);
      let after = 0;
      for (;;) {
        const facts = this.store.facts(after, 256);
        if (facts.length === 0)
          break;
        this.enqueueFacts(facts, now, devices);
        after = facts.at(-1)!.ordinal;
      }
    });
  }
  async handleRpc(principal: AttentionPrincipal, method: string, payload: unknown = {}): Promise<unknown> {
    const scope = Object.hasOwn(AttentionMethodScopes, method) ? AttentionMethodScopes[method as keyof typeof AttentionMethodScopes] : undefined;
    if (!scope)
      throw new AttentionError("METHOD_NOT_FOUND");
    this.authorize(principal, scope);
    const now = this.timestamp();
    switch (method) {
      case "attention.registerPush": {
        const request = AttentionRegisterPushRequestSchema.parse(payload);
        const sub = this.store.transaction(() => { this.store.expire(now); const value = this.store.register(principal.deviceId, request, now); this.store.retryUnavailable(principal.deviceId, now); return value; });
        await this.catchUpDevice(principal.deviceId);
        return AttentionSubscriptionSchema.parse({ subscriptionId: sub.id, platform: sub.platform, projectId: sub.project_id, status: "active", expiresAt: sub.expires_at });
      }
      case "attention.unregisterPush": {
        const request = AttentionUnregisterPushRequestSchema.parse(payload);
        this.store.transaction(() => this.store.unregister(principal.deviceId, request.subscriptionId, now));
        return { subscriptionId: request.subscriptionId, status: "revoked" };
      }
      case "attention.getPreferences": return AttentionPreferencesSchema.parse(this.store.preferences(principal.deviceId));
      case "attention.setPreferences": {
        const request = AttentionSetPreferencesRequestSchema.parse(payload);
        const result = this.store.transaction(() => { const value = this.store.setPreferences(principal.deviceId, { mode: request.mode, pushEnabled: request.pushEnabled }, request.expectedRevision); this.store.retryUnavailable(principal.deviceId, now); return value; });
        await this.catchUpDevice(principal.deviceId);
        return result;
      }
      case "attention.setPresence": {
        const request = AttentionPresenceRequestSchema.parse(payload);
        if (request.sessionId && !this.sessionAllowed(principal.deviceId, request.sessionId))
          throw new AttentionError("FORBIDDEN");
        let leases = this.presence.get(principal.deviceId);
        if (!leases) {
          leases = new Map();
          this.presence.set(principal.deviceId, leases);
        }
        leases.set(principal.leaseId ?? principal.deviceId, { foreground: request.foreground, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
        this.store.retryUnavailable(principal.deviceId, now);
        await this.catchUpDevice(principal.deviceId);
        return { foreground: request.foreground };
      }
      case "attention.list": return this.list(principal, payload);
      case "attention.acknowledge": {
        this.authorize(principal, "session:read");
        const request = AttentionAcknowledgeRequestSchema.parse(payload);
        const fact = this.store.get(request.attentionId);
        if (!fact || !this.sessionAllowed(principal.deviceId, fact.session_id))
          throw new AttentionError("ATTENTION_NOT_FOUND");
        this.store.transaction(() => this.store.acknowledge(fact, principal.deviceId, request.expectedVersion, now));
        return { attentionId: fact.id, version: fact.version, acknowledged: true, stale: !this.store.isCurrent(fact, now) };
      }
    }
  }
  private list(principal: AttentionPrincipal, payload: unknown): AttentionListResponse {
    const request = AttentionListRequestSchema.parse(payload), now = this.timestamp();
    if (request.sessionId && !this.sessionAllowed(principal.deviceId, request.sessionId))
      throw new AttentionError("FORBIDDEN");
    const items: AttentionSummary[] = [];
    let nextAfter = request.after, hasMore = false;
    const scanned = this.store.facts(request.after, 1000, request.sessionId);
    for (const fact of scanned) {
      if (!this.sessionAllowed(principal.deviceId, fact.session_id) || fact.expires_at <= now) {
        nextAfter = fact.ordinal;
        continue;
      }
      const acknowledged = this.store.acknowledged(fact.id, principal.deviceId);
      if (acknowledged && !request.includeAcknowledged) {
        nextAfter = fact.ordinal;
        continue;
      }
      const item: AttentionSummary = { ...this.store.route(fact), kind: fact.kind, createdAt: fact.created_at, acknowledged, stale: !this.store.isCurrent(fact, now), deliveryState: this.store.delivery(fact.id, principal.deviceId)?.state ?? "none" };
      if (items.length >= request.limit || Buffer.byteLength(JSON.stringify({ items: [...items, item], nextAfter: fact.ordinal, hasMore: true, unavailable: !this.driver.configured })) > ATTENTION_MAX_PAGE_BYTES) {
        hasMore = true;
        break;
      }
      items.push(item);
      nextAfter = fact.ordinal;
    }
    if (!hasMore && scanned.length === 1000)
      hasMore = this.store.facts(nextAfter, 1, request.sessionId).length > 0;
    return AttentionListResponseSchema.parse({ items, nextAfter, hasMore, unavailable: !this.driver.configured });
  }
  disconnect(principal: AttentionPrincipal): void {
    const leases = this.presence.get(principal.deviceId);
    leases?.delete(principal.leaseId ?? principal.deviceId);
    if (leases?.size === 0)
      this.presence.delete(principal.deviceId);
  }
  /** Server revocation calls this after its credential transaction commits. */
  onDeviceRevoked(deviceId: string): void {
    this.requireOutsideTransaction();
    const row = this.store.db.prepare("SELECT revoked_at,host_id FROM devices WHERE id=?").get(deviceId) as {
      revoked_at: string | null;
      host_id: string;
    } | undefined;
    if (row && row.host_id !== this.store.hostId)
      throw new AttentionError("ATTENTION_HOST_MISMATCH");
    if (row && row.host_id === this.store.hostId && !row.revoked_at)
      throw new AttentionError("ATTENTION_REVOCATION_UNCOMMITTED");
    this.store.transaction(() => this.store.invalidateDevice(deviceId, this.timestamp()));
    for (const controller of this.inFlight.get(deviceId) ?? [])
      controller.abort();
    this.presence.delete(deviceId);
  }
  recoverPendingDispatches(): number { this.requireOutsideTransaction(); return this.store.transaction(() => this.store.recoverDispatches(this.timestamp())); }
  async drain(limit = 32): Promise<void> {
    this.requireOutsideTransaction();
    if (this.draining)
      return this.draining;
    const work = this.runDrain(limit);
    this.draining = work;
    try {
      await work;
    }
    finally {
      if (this.draining === work)
        this.draining = undefined;
    }
  }
  abortDeliveries(): void {
    for (const controllers of this.inFlight.values())
      for (const controller of controllers)
        controller.abort();
  }
  async awaitIdle(): Promise<void> { await this.draining; }
  private async runDrain(limit: number): Promise<void> {
    this.requireOutsideTransaction();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AttentionError("ATTENTION_LIMIT_INVALID");
    this.store.transaction(() => this.store.expire(this.timestamp()));
    for (const pending of this.store.ready(this.timestamp(), limit)) {
      const fact = this.store.get(pending.attention_id), now = this.timestamp();
      if (!fact || !this.eligible(pending.device_id, fact)) {
        this.store.cancel(pending, "DEVICE_REVOKED", now);
        continue;
      }
      if (!this.store.isCurrent(fact, now) || this.store.acknowledged(fact.id, pending.device_id)) {
        this.store.cancel(pending, "ATTENTION_STALE", now);
        continue;
      }
      const pref = this.store.preferences(pending.device_id);
      if (pref.mode === "none" || pref.mode === "interactions" && !["approval", "question"].includes(fact.kind)) {
        this.store.cancel(pending, "ATTENTION_PREFERENCES_DISABLED", now);
        continue;
      }
      const surface = this.surface(pending.device_id, fact), job = this.store.transaction(() => this.store.claim(pending, surface, now));
      if (!job)
        continue;
      const controller = new AbortController();
      let active = this.inFlight.get(job.device_id);
      if (!active) {
        active = new Set();
        this.inFlight.set(job.device_id, active);
      }
      active.add(controller);
      let result: AttentionDeliveryResult;
      let invalidateSubscriptionId: string | undefined;
      try {
        const route = this.store.route(fact);
        if (surface === "in_app") {
          const state = await this.options.inApp?.(job.device_id, route);
          result = state === "presented" ? { status: "presented", code: "IN_APP_PRESENTED" } : { status: "unavailable", code: "IN_APP_UNAVAILABLE" };
        }
        else {
          const subscription = this.store.subscription(job.device_id, now);
          result = !pref.pushEnabled ? { status: "unavailable", code: "PUSH_PREFERENCES_DISABLED" } : !subscription ? { status: "unavailable", code: "PUSH_SUBSCRIPTION_UNAVAILABLE" } : await this.driver.send(subscription, route, controller.signal);
          if ("invalidateSubscription" in result && result.invalidateSubscription && subscription)
            invalidateSubscriptionId = subscription.id;
        }
      }
      catch {
        result = { status: "outcome_unknown", code: "ATTENTION_DISPATCH_UNCONFIRMED" };
      }
      finally {
        active.delete(controller);
        if (active.size === 0)
          this.inFlight.delete(job.device_id);
      }
      if (!this.eligible(job.device_id, fact)) {
        this.store.cancel(job, "DEVICE_REVOKED", this.timestamp());
        continue;
      }
      if (!this.store.isCurrent(fact, this.timestamp()) || this.store.acknowledged(fact.id, job.device_id)) {
        this.store.cancel(job, "ATTENTION_STALE", this.timestamp());
        continue;
      }
      this.store.transaction(() => {
        if (invalidateSubscriptionId)
          this.store.unregister(job.device_id, invalidateSubscriptionId, this.timestamp());
        this.persistResult(job, result);
      });
    }
  }
  private persistResult(job: AttentionDelivery, result: AttentionDeliveryResult): void {
    const now = this.timestamp();
    if (result.status === "retryable") {
      const state = job.attempts < this.store.budgets.maxAttempts ? "pending" : "unavailable";
      this.store.settle(job, state, result.code, now, undefined, new Date(this.now().getTime() + 1000 * 2 ** job.attempts).toISOString());
    }
    else
      this.store.settle(job, result.status, result.code, now, result.status === "accepted" ? result.receiptId : undefined);
  }
}
