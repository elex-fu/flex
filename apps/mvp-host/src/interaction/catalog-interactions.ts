import { INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, InteractionSchema, InteractionListResponseSchema, type Interaction } from "@flyx/mvp-protocol";
import { publicValue } from "../api/public-projection.js";
import { ClaudeAdapter } from "../claude/adapter.js";
import { CodexAdapter } from "../codex/adapter.js";
import type { HostCatalog, CatalogRuntimeOptions } from "../catalog/host-catalog.js";
import { assertHostOwner } from "../lifecycle/host-owner.js";
import { CommandEngine } from "../orchestration/command-engine.js";
import type { PlannedEvent } from "../orchestration/command-contract.js";
import type { DispatchContext, ProviderAdapter } from "../provider/types.js";
import { catalogRecoveryConfigurationFingerprint } from "../session/catalog-recovery.js";
import type { SessionOrchestrator } from "../session/orchestrator.js";
import type { SessionRuntimeContext } from "../session/session-registry.js";
import type { ViewInteractionReader } from "../timeline/host-views.js";
import { inspectSchema } from "../storage/migrations/schema-version.js";
import { validateInteractionSchema, INTERACTION_SCHEMA_VERSION } from "../storage/migrations/008-interactions.js";
import { createHostInteractionBindings, parseInteractionRpcPayload, type HostInteractionHooks, type InteractionMethod, type InteractionRpcPort } from "./host-interactions.js";
import { InteractionRpcError } from "./interaction-rpc.js";
import { InteractionService } from "./interaction-service.js";
export type CatalogInteractionsOptions = {
  catalog: HostCatalog;
  /** Fresh synchronous global write admission; metadata history does not require it. */
  assertAdmission(): void;
};
export type CatalogInteractionRuntimeOptions = Pick<CatalogRuntimeOptions, "executionSetup" | "interactionEvents" | "revalidateDevice">;
type Identity = Readonly<{
  sessionId: string;
  workspaceId: string;
  providerInstanceId: string;
  provider: "claude" | "codex";
  workspace: string;
  checkoutRoot: string;
  fingerprint: string;
  runtimeId: string;
  ownerId: string;
  ownerGeneration: number;
}>;
type RuntimeEntry = {
  identity: Identity;
  bindings: ReturnType<typeof createHostInteractionBindings>;
  host?: SessionOrchestrator;
  port: InteractionRpcPort;
  options: CatalogInteractionRuntimeOptions;
  closed: boolean;
};
function synchronous(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => { });
    throw new InteractionRpcError("INTERACTION_ADMISSION_ASYNC");
  }
}
/** One metadata anchor and immutable lazy runtime bindings; this factory performs no DDL or Native preparation. */
export class CatalogInteractionBindings {
  readonly service: InteractionService;
  private state: "active" | "draining" | "closed" = "active";
  private readonly runtimes = new Map<string, RuntimeEntry>();
  readonly shutdownService = {
    drain: async (absoluteDeadlineMs: number): Promise<void> => {
      if (!Number.isFinite(absoluteDeadlineMs) || absoluteDeadlineMs < 0)
        throw new InteractionRpcError("INTERACTION_DEADLINE_INVALID");
      if (this.state !== "closed")
        this.state = "draining";
      // There is no global delivery worker. Per-Session R06 controls drain with their original runtime.
    },
    close: (): void => {
      if (this.state === "closed")
        return;
      if (this.state !== "draining" || [...this.runtimes.values()].some((entry) => entry.host && !entry.host.worker.isSealed))
        throw new InteractionRpcError("INTERACTION_RUNTIME_NOT_DRAINED");
      this.shutdownService.seal();
    },
    /** Fence callbacks and release projection leases; this makes no worker or producer stop claim. */
    seal: (): void => {
      if (this.state === "closed") return;
      this.state = "closed";
      for (const entry of this.runtimes.values()) {
        entry.closed = true;
        entry.bindings.close();
      }
      this.runtimes.clear();
      this.service.seal();
    },
  };
  constructor(private readonly options: CatalogInteractionsOptions) {
    this.assertSource();
    this.service = new InteractionService(new CommandEngine(options.catalog.store, {
      admission: () => { throw new InteractionRpcError("INTERACTION_METADATA_ONLY"); },
    }), {
      resolveSession: (id) => { this.assertSource(); const target = this.resource(id); return { provider: target.session.provider, workspaceId: target.workspace.workspaceId }; },
      questionCapability: () => false,
      hashRequest: (method, payload, id) => options.catalog.registry.hashRequest(method, payload, id),
      publish: (event) => { if (this.state !== "closed") options.catalog.registry.publishCommittedEvents([event]); },
    });
  }
  readonly readInteraction = (sessionId: string, interactionId: string): Interaction => {
    this.assertSource();
    const target = this.resource(sessionId);
    return InteractionSchema.parse(publicValue(publicValue(this.service.get(sessionId, interactionId), target.workspace.canonicalRoot), target.workspace.worktreeRoot));
  };
  /** Canonical views already authorize their selected Session; this reader never manufactures an actor. */
  readonly readViewInteractions: ViewInteractionReader = (sessionId, afterInteractionId) => {
    this.assertSource();
    const target = this.resource(sessionId), loaded = this.options.catalog.registry.loaded(sessionId);
    const entry = loaded?.runtimeId ? this.runtimes.get(loaded.runtimeId) : undefined;
    let page: ReturnType<InteractionService["list"]> | undefined;
    if (entry?.host === loaded && entry?.identity.sessionId === sessionId && this.answerAdmission(entry)) {
      // The existing service rechecks each row's original Turn/attempt/generation fence.
      page = entry.bindings.interactions()?.service.list(sessionId, afterInteractionId);
    }
    const value = entry && page ? this.publicAvailability(entry, page) : this.service.list(sessionId, afterInteractionId);
    const parsed = InteractionListResponseSchema.parse(publicValue(publicValue(value, target.workspace.canonicalRoot), target.workspace.worktreeRoot));
    return { interactions: parsed.interactions, hasMore: parsed.hasMore, ...(parsed.nextAfterInteractionId !== undefined ? { nextAfterInteractionId: parsed.nextAfterInteractionId } : {}) };
  };
  readonly companionEvents = (sessionId: string, turnId: string, reason: string): PlannedEvent[] => {
    if (this.state === "closed") return [];
    this.assertSource();
    this.resource(sessionId);
    const turn = this.options.catalog.store.getTurn(turnId);
    if (!turn || turn.sessionId !== sessionId)
      throw new InteractionRpcError("INTERACTION_TURN_MISMATCH");
    return this.service.planSupersessionEvents(sessionId, { turnId }, reason);
  };
  readonly supersedeInteractions = (sessionId: string, old: {
    attemptId: string;
    runtimeGeneration: number;
  }, reason: string): number => {
    if (this.state === "closed") return 0;
    this.assertSource();
    this.resource(sessionId);
    if (!old.attemptId || !Number.isSafeInteger(old.runtimeGeneration) || old.runtimeGeneration < 1)
      throw new InteractionRpcError("INTERACTION_CONTEXT_INVALID");
    return this.service.supersedeForRuntime(sessionId, old, reason);
  };
  readonly interactionCapabilities = (): readonly string[] => {
    try {
      this.assertSource();
      if (this.state !== "active" || !this.options.catalog.ready)
        return [];
      return [INTERACTION_CAPABILITY, ...([...this.runtimes.values()].some((entry) => this.questionReady(entry) && this.answerAdmission(entry)) ? [STRUCTURED_QUESTION_CAPABILITY] : [])];
    }
    catch {
      return [];
    }
  };
  readonly runtimeOptions = (context: SessionRuntimeContext): CatalogInteractionRuntimeOptions => {
    this.assertSource();
    if (this.state !== "active")
      throw new InteractionRpcError("INTERACTIONS_UNAVAILABLE");
    const identity = this.capture(context), previous = this.runtimes.get(identity.runtimeId);
    if (previous) {
      if (JSON.stringify(previous.identity) !== JSON.stringify(identity))
        throw new InteractionRpcError("INTERACTION_RUNTIME_BINDING_INVALID");
      return previous.options;
    }
    let entry!: RuntimeEntry;
    const bindings = createHostInteractionBindings({
      resolveSession: (id) => { this.assertEntry(entry); if (id !== identity.sessionId)
        throw new InteractionRpcError("SESSION_NOT_FOUND"); return { provider: identity.provider, workspaceId: identity.workspaceId, runtimeId: identity.runtimeId }; },
      adapterForSession: (id) => id === identity.sessionId && this.questionReady(entry) ? entry.host?.adapter : undefined,
      resolveAdapter: (original) => this.adapter(entry, original),
      publish: (event) => { if (this.state !== "closed" && !entry.closed) entry.host?.publishCommittedEvent(event); },
      hashRequest: (method, payload, id) => { this.assertEntry(entry); if (id !== identity.sessionId)
        throw new InteractionRpcError("SESSION_NOT_FOUND"); return this.options.catalog.registry.hashRequest(method, payload, id); },
    });
    const port: InteractionRpcPort = { rpc: (method, raw, actor) => {
        const payload = parseInteractionRpcPayload(method, raw);
        if (payload.sessionId !== identity.sessionId)
          throw new InteractionRpcError("SESSION_NOT_FOUND");
        this.assertEntry(entry);
        const read = method === "interaction.get" || method === "interaction.list";
        this.options.catalog.assertActorSession(actor.authSubjectId, identity.sessionId, read ? "session:read" : "approval:write");
        if (!read)
          this.authorizeAnswer(entry, method, actor.authSubjectId);
        const result = bindings.interactions()!.rpc(method, payload, actor);
        if (read)
          return this.publicAvailability(entry, result);
        return result;
      } };
    const hooks: HostInteractionHooks = {
      rpcPort: () => entry.closed || !bindings.interactions() ? undefined : port,
      handle: (event) => {
        // Consume late callbacks so ingestion cannot fall through to a legacy SQL writer.
        if (this.state === "closed" || entry.closed) return true;
        this.assertEntry(entry); this.assertOriginal(entry, event.dispatchContext, true);
        return bindings.interactionEvents.handle(event);
      },
      companionEvents: this.companionEvents,
      respondLegacyApproval: (actor, command, approval, action, request) => {
        this.authorizeAnswer(entry, "interaction.respondApproval", actor);
        if (this.service.interactions.get(approval)?.sessionId !== identity.sessionId)
          throw new InteractionRpcError("APPROVAL_NOT_FOUND");
        return bindings.interactionEvents.respondLegacyApproval(actor, command, approval, action, request);
      },
    };
    const runtimeOptions: CatalogInteractionRuntimeOptions = {
      interactionEvents: hooks,
      executionSetup: (host) => {
        this.assertEntry(entry, host);
        if (entry.host) {
          if (entry.host !== host)
            throw new InteractionRpcError("INTERACTION_RUNTIME_BINDING_INVALID");
          return;
        }
        entry.host = host;
        try {
          bindings.executionSetup(host);
        }
        catch (error) {
          delete entry.host;
          this.runtimes.delete(identity.runtimeId);
          throw error;
        }
        host.registerShutdownService({ drain: async () => { }, close: () => { if (entry.closed)
            return; bindings.close(); entry.closed = true; this.runtimes.delete(identity.runtimeId); } });
      },
      revalidateDevice: (intent) => {
        this.assertEntry(entry);
        synchronous(this.options.assertAdmission() as unknown);
        if (!intent.dispatchContext || intent.sessionId !== identity.sessionId)
          throw new InteractionRpcError("INTERACTION_CONTEXT_INVALID");
        this.assertOriginal(entry, intent.dispatchContext, intent.kind.startsWith("respond_"));
        if (intent.actorKind === "device")
          this.options.catalog.assertActorSession(intent.authSubjectId, identity.sessionId, intent.kind.startsWith("respond_") ? "approval:write" : "session:write");
        if (intent.kind === "respond_approval" || intent.kind === "respond_question")
          this.authorizeAnswer(entry, intent.kind === "respond_question" ? "question.respond" : "interaction.respondApproval", intent.authSubjectId);
      },
    };
    entry = { identity, bindings, port, options: runtimeOptions, closed: false };
    this.runtimes.set(identity.runtimeId, entry);
    return runtimeOptions;
  };
  private assertSource(): void {
    const host = this.options.catalog;
    if (this.state === "closed" || !host.store.db.open || host.registry.store !== host.store)
      throw new InteractionRpcError("INTERACTIONS_UNAVAILABLE");
    assertHostOwner(host.owner);
    host.owner.assertStorePath(host.store.db.name);
    host.store.assertWriterOwner();
    if (inspectSchema(host.store.db).version < INTERACTION_SCHEMA_VERSION)
      throw new InteractionRpcError("INTERACTIONS_SCHEMA_NOT_READY");
    validateInteractionSchema(host.store.db);
  }
  private resource(sessionId: string) {
    const host = this.options.catalog;
    host.owner.assertActive();
    const target = host.registry.resolve(sessionId), raw = host.store.getSession(sessionId);
    if (!raw || raw.workspaceId !== target.workspace.workspaceId || raw.workspacePath !== target.workspace.canonicalRoot || raw.provider !== target.providerInstance.provider || target.session.providerInstanceId !== target.providerInstance.providerInstanceId || target.session.workspaceId !== target.workspace.workspaceId || target.session.provider !== raw.provider)
      throw new InteractionRpcError("INTERACTION_RESOURCE_MISMATCH");
    return target;
  }
  private capture(context: SessionRuntimeContext): Identity {
    const host = this.options.catalog, current = this.resource(context.session.sessionId);
    if (context.store !== host.store || context.owner !== host.owner || context.ownsStore !== false || context.recoverOnStart !== false || !context.runtimeId
      || context.session.workspaceId !== current.workspace.workspaceId || context.workspace.workspaceId !== current.workspace.workspaceId || context.session.providerInstanceId !== current.session.providerInstanceId || context.session.provider !== current.session.provider || context.providerInstance.providerInstanceId !== current.providerInstance.providerInstanceId || context.workspace.canonicalRoot !== current.workspace.canonicalRoot || context.workspace.worktreeRoot !== current.workspace.worktreeRoot || catalogRecoveryConfigurationFingerprint(context) !== catalogRecoveryConfigurationFingerprint(current))
      throw new InteractionRpcError("INTERACTION_RUNTIME_BINDING_INVALID");
    return Object.freeze({ sessionId: current.session.sessionId, workspaceId: current.workspace.workspaceId, providerInstanceId: current.providerInstance.providerInstanceId, provider: current.providerInstance.provider, workspace: current.workspace.canonicalRoot, checkoutRoot: current.workspace.worktreeRoot, fingerprint: catalogRecoveryConfigurationFingerprint(current), runtimeId: context.runtimeId, ownerId: host.owner.ownerId, ownerGeneration: host.owner.generation });
  }
  private assertEntry(entry: RuntimeEntry, constructing?: SessionOrchestrator): void {
    this.assertSource();
    if (entry.closed || this.runtimes.get(entry.identity.runtimeId) !== entry)
      throw new InteractionRpcError("INTERACTION_RUNTIME_BINDING_INVALID");
    const target = this.resource(entry.identity.sessionId);
    if (catalogRecoveryConfigurationFingerprint(target) !== entry.identity.fingerprint)
      throw new InteractionRpcError("INTERACTION_RESOURCE_MISMATCH");
    const host = constructing ?? entry.host;
    if (!host || host.store !== this.options.catalog.store || host.owner !== this.options.catalog.owner || host.owner.ownerId !== entry.identity.ownerId || host.owner.generation !== entry.identity.ownerGeneration || host.sessionId !== entry.identity.sessionId || host.runtimeId !== entry.identity.runtimeId || host.workspace !== entry.identity.workspace || host.checkoutRoot !== entry.identity.checkoutRoot || host.adapter.provider !== target.providerInstance.provider || host.adapter.workspace !== entry.identity.workspace || host.ownsStore || host.recoverOnStart)
      throw new InteractionRpcError("INTERACTION_RUNTIME_BINDING_INVALID");
    const loaded = this.options.catalog.registry.loaded(entry.identity.sessionId);
    if (!constructing && (loaded !== host || host.worker.isSealed))
      throw new InteractionRpcError("INTERACTION_RUNTIME_BINDING_INVALID");
  }
  private assertOriginal(entry: RuntimeEntry, original: DispatchContext, active = false): void {
    const id = entry.identity;
    if (original.hostOwnerId !== id.ownerId || original.hostOwnerGeneration !== id.ownerGeneration || original.sessionId !== id.sessionId || original.runtimeId !== id.runtimeId || active && !entry.host?.runtimes.matches(original))
      throw new InteractionRpcError("INTERACTION_CONTEXT_INVALID");
  }
  private adapter(entry: RuntimeEntry, original: DispatchContext): ProviderAdapter | undefined {
    try {
      this.assertEntry(entry);
      this.assertOriginal(entry, original, true);
      return entry.host?.adapter;
    }
    catch {
      return undefined;
    }
  }
  private effective(entry: RuntimeEntry, capability: "interactiveApprovals" | "structuredQuestions"): boolean {
    const target = this.resource(entry.identity.sessionId);
    return this.options.catalog.providers.effectiveCapabilities(target.providerInstance.providerInstanceId, { adapter: [capability], workspace: target.workspace.capabilities, deviceScopes: ["approval:write"] }).includes(capability);
  }
  private questionReady(entry: RuntimeEntry): boolean {
    try {
      this.assertEntry(entry);
      const adapter = entry.host!.adapter;
      return (adapter instanceof ClaudeAdapter || adapter instanceof CodexAdapter) && this.effective(entry, "structuredQuestions") && adapter.structuredQuestionsAvailable?.() === true;
    }
    catch {
      return false;
    }
  }
  private answerAdmission(entry: RuntimeEntry): boolean {
    try {
      this.assertEntry(entry);
      if (this.state !== "active")
        return false;
      synchronous(this.options.assertAdmission() as unknown);
      const target = this.options.catalog.registry.resolveExecutionContext(entry.identity.sessionId), raw = this.options.catalog.store.getSession(entry.identity.sessionId)!;
      if (target.session.status !== "active" || target.session.residency !== "loaded" || raw.recoveryState === "blocked" || this.options.catalog.catalog.runtimeCloseForSession(entry.identity.sessionId))
        return false;
      entry.host!.worker.assertAdmission("control");
      return true;
    }
    catch {
      return false;
    }
  }
  private authorizeAnswer(entry: RuntimeEntry, method: InteractionMethod, actor: string): void {
    this.assertEntry(entry);
    synchronous(this.options.assertAdmission() as unknown);
    this.options.catalog.assertActorSession(actor, entry.identity.sessionId, "approval:write");
    if (!this.answerAdmission(entry))
      throw new InteractionRpcError("INTERACTION_RESPONSE_UNAVAILABLE");
    if (method === "question.respond" ? !this.questionReady(entry) : !this.effective(entry, "interactiveApprovals"))
      throw new InteractionRpcError("PROVIDER_CAPABILITY_UNVERIFIED");
  }
  private publicAvailability(entry: RuntimeEntry, value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    if ("interactions" in value && Array.isArray(value.interactions))
      return { ...value, interactions: value.interactions.map((item: unknown) => this.publicAvailability(entry, item)) };
    if ("responseAvailable" in value && "kind" in value)
      return { ...value, responseAvailable: value.responseAvailable === true && this.answerAdmission(entry) && (value.kind === "question" ? this.questionReady(entry) : this.effective(entry, "interactiveApprovals")) };
    return value;
  }
}
export function createCatalogInteractionBindings(options: CatalogInteractionsOptions): CatalogInteractionBindings { return new CatalogInteractionBindings(options); }
