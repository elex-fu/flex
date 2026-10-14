import { z } from "zod";
import { ACCESS_RECEIPTS_CAPABILITY, type AccessCommandMethod } from "./access-command-receipts.js";
import { BOUNDED_CONTENT_CAPABILITY, RecoveryCapability, RecoveryInspectPayloadSchema, RecoveryReconcilePayloadSchema, RecoveryAcknowledgePayloadSchema, ContentChunkRequestSchema, TIMELINE_PROJECTION_CAPABILITY, OpenViewRequestSchema, TimelinePageRequestSchema, TimelineSubscribeRequestSchema, TimelineUnsubscribeRequestSchema, type OpenViewRequest, type TimelinePageRequest, type TimelineSubscribeRequest } from "@flyx/mvp-protocol";
import type { HostRecovery } from "../session/host-recovery.js";
import { assertInteractionCapabilities, parseInteractionRpcPayload, type InteractionRpcPort, type InteractionMethod } from "../interaction/host-interactions.js";
import { InteractionRpcError } from "../interaction/interaction-rpc.js";
import type { ContentStore } from "../content/content-store.js";
import type { HostViews } from "../timeline/host-views.js";
import type { TimelineLeaseOwner } from "../timeline/contracts.js";
import type { FrameBudget } from "../content/frame-budget.js";
import { OrchestratorError, type SessionOrchestrator } from "../session/orchestrator.js";
import { publicEvent, publicGitDiff, publicGitStatus, publicProviderStatus, publicSnapshot, publicValue } from "./public-projection.js";

const SessionId = z.string().min(1).max(128).optional();
const EventsPayload = z.object({ sessionId: SessionId, afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(200), upTo: z.number().int().nonnegative().optional() });
const SubscribePayload = z.object({ sessionId: SessionId, afterSequence: z.number().int().nonnegative().default(0) });

export interface RpcRequest {
  id: string;
  method: string;
  commandId?: string | undefined;
  payload: unknown;
}

export interface RpcContext {
  subjectId: string;
  protocolVersion?: number;
  leaseId?: string;
  transportGeneration?: number;
  capabilities?: ReadonlySet<string>;
  frameBudget?: FrameBudget;
  responseEnvelope?(payload: unknown): unknown;
  assertContentScope?(scope: string): void;
  assertSessionScope?(sessionId: string, scope: "session:read" | "session:write" | "approval:write"): void;
  viewOwner?(): TimelineLeaseOwner;
  openView?(request: OpenViewRequest): unknown;
  timelinePage?(request: TimelinePageRequest): unknown;
  timelineSubscribe?(request: TimelineSubscribeRequest): unknown;
  timelineUnsubscribe?(id: string): unknown;
  assertAuthorized(method: string): void;
  subscribe(afterSequence: number): Promise<unknown>;
  access(method: string, payload: unknown): Promise<unknown>;
  /** Bound by Gateway to its original actor, active lease, generation and negotiated v2 capabilities. */
  accessCommand?(method: AccessCommandMethod, payload: unknown, commandId: string): unknown | Promise<unknown>;
  accessReceipt?(payload: { commandId: string }): unknown | Promise<unknown>;
}

/** Reads from a stable legacy Session never require constructing a Provider runtime. */
export type LegacyHost = Readonly<Pick<SessionOrchestrator,
  "sessionId" | "workspace" | "store" | "bootstrap" | "snapshot" | "publicSnapshot" | "timeline" | "subscribe" | "providerStatus" | "gitStatus" | "gitDiff"
>> & Partial<Pick<SessionOrchestrator, "views" | "interactionRpcPort" | "recovery" | "startTurn" | "interrupt" | "respondApproval">>;
export type RecoveryRpcPort = Pick<HostRecovery, "inspect" | "reconcile" | "acknowledge">;
export type RpcDispatchResult = { handled: false } | { handled: true; payload: unknown };
export interface CatalogRpcPort {
  readonly ready?: boolean;
  capabilities?(): readonly string[];
  dispatchCatalog(frame: RpcRequest, context: RpcContext): Promise<RpcDispatchResult>;
  assertActorSession?(subjectId: string, sessionId: string, scope: "session:read" | "session:write" | "approval:write"): void;
  interactionsForSession?(sessionId: string): InteractionRpcPort | undefined;
}
/** Trusted local adapters expose exact method scopes and their own current readiness. */
export interface RpcDomainPort {
  readonly methodScopes: Readonly<Record<string, string>>;
  ready(): boolean;
  capabilities(): readonly string[];
  dispatch(frame: RpcRequest, context: RpcContext): Promise<RpcDispatchResult>;
}
export interface RpcDispatcherOptions {
  contentStore?: ContentStore;
  views?: HostViews;
  recovery?: RecoveryRpcPort;
  recoveryForSession?(sessionId: string): RecoveryRpcPort | undefined;
  catalogPort?: CatalogRpcPort;
  domainPorts?: readonly RpcDomainPort[];
  interactions?: InteractionRpcPort | ((sessionId: string) => InteractionRpcPort | undefined);
  orchestrator: LegacyHost;
  bootstrap(): unknown;
  descriptor(): unknown;
}

/** Admission must finish before any source read or command mutation. */
export function assertSynchronousAuthorization(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {});
    throw new OrchestratorError("AUTHORIZATION_ASYNC", "Authorization must be synchronous");
  }
}

/** Transport independent business dispatch. The Provider never receives a transport. */
export class RpcDispatcher {
  constructor(private readonly options: RpcDispatcherOptions) {}

  private recovery(context: RpcContext, sessionId: string): RecoveryRpcPort {
    if (context.protocolVersion !== undefined && context.protocolVersion !== 2 || !context.capabilities?.has(RecoveryCapability)) throw new OrchestratorError("CAPABILITY_REQUIRED", "Session recovery capability is required");
    const port = this.options.recoveryForSession ? this.options.recoveryForSession(sessionId) : sessionId === this.options.orchestrator.sessionId ? this.options.recovery ?? this.options.orchestrator.recovery : undefined;
    if (!port) throw new OrchestratorError("CAPABILITY_REQUIRED", "Session recovery is unavailable");
    return port;
  }

  async dispatch(frame: RpcRequest, context: RpcContext): Promise<unknown> {
    assertSynchronousAuthorization(context.assertAuthorized(frame.method) as unknown);
    // This namespace guard precedes Catalog, which also shares the receipt table.
    if (frame.method === "command.getReceipt") {
      const payload = z.object({ commandId: z.string().min(1).max(128) }).strict().parse(frame.payload);
      const receipt = this.options.orchestrator.store.getCommandReceipt(context.subjectId, payload.commandId);
      if (receipt?.method.startsWith("access.")) return { found: false, commandId: payload.commandId };
    }
    for (const port of this.options.domainPorts ?? []) {
      if (!Object.hasOwn(port.methodScopes, frame.method)) continue;
      if (context.protocolVersion !== 2 || port.ready() !== true) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host service is unavailable");
      try {
        const result = await port.dispatch(frame, context);
        if (result.handled) return publicValue(result.payload, this.options.orchestrator.workspace);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) throw new OrchestratorError(code, "Host service request rejected");
        throw error;
      }
    }
    if (this.options.catalogPort) {
      const result = await this.options.catalogPort.dispatchCatalog(frame, context);
      if (result.handled) return result.payload;
    }
    const { orchestrator } = this.options;
    const workspace = orchestrator.workspace;
    const authorizeSession = (id = orchestrator.sessionId, scope: "session:read" | "session:write" | "approval:write" = "session:read") => {
      if (context.assertSessionScope) assertSynchronousAuthorization(context.assertSessionScope(id, scope) as unknown);
      else if (this.options.catalogPort) throw new OrchestratorError("SESSION_SCOPE_REQUIRED", "Session authorization is unavailable");
      else if (id !== orchestrator.sessionId) throw new OrchestratorError("SESSION_NOT_FOUND", "Session does not exist");
      return id;
    };
    const checkSession = (id = orchestrator.sessionId, scope: "session:read" | "session:write" | "approval:write" = "session:read") => {
      if (id !== orchestrator.sessionId) throw new OrchestratorError("SESSION_NOT_FOUND", "Session does not exist");
      return authorizeSession(id, scope);
    };
    const rejectExplicitExecutionTarget = () => {
      if (frame.payload && typeof frame.payload === "object" && Object.hasOwn(frame.payload, "sessionId")) throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Explicit Session writes require Catalog routing");
    };
    const commandId = () => {
      if (!frame.commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "commandId is required");
      return frame.commandId;
    };
    const hostViews = this.options.views ?? orchestrator.views;
    const requireViews = (id?: string) => {
      if (context.protocolVersion !== undefined && context.protocolVersion !== 2 || !context.capabilities?.has(TIMELINE_PROJECTION_CAPABILITY) || !context.capabilities.has(BOUNDED_CONTENT_CAPABILITY) || !hostViews || id !== undefined && !hostViews.ready(authorizeSession(id))) throw new OrchestratorError("CAPABILITY_REQUIRED", "Canonical Timeline capability is required");
    };
    const dispatchInteraction = (method: InteractionMethod): unknown => {
      try {
        if (context.protocolVersion !== undefined) assertInteractionCapabilities(method, context.protocolVersion, context.capabilities ?? new Set());
        const payload = parseInteractionRpcPayload(method, frame.payload);
        const scope = method === "interaction.get" || method === "interaction.list" ? "session:read" : "approval:write";
        if (context.assertSessionScope) assertSynchronousAuthorization(context.assertSessionScope(payload.sessionId, scope) as unknown);
        else if (this.options.catalogPort || payload.sessionId !== orchestrator.sessionId) throw new OrchestratorError("SESSION_SCOPE_REQUIRED", "Session authorization is unavailable");
        const port = typeof this.options.interactions === "function" ? this.options.interactions(payload.sessionId) : this.options.interactions ?? this.options.catalogPort?.interactionsForSession?.(payload.sessionId) ?? orchestrator.interactionRpcPort;
        if (!port) throw new OrchestratorError("INTERACTIONS_UNAVAILABLE", "Typed interactions are unavailable");
        const targetWorkspace = orchestrator.store.getSession(payload.sessionId)?.workspacePath ?? workspace;
        return publicValue(port.rpc(method, payload, { authSubjectId: context.subjectId,
          ...(["interaction.respondApproval", "question.respond"].includes(method) ? { commandId: commandId() } : {}) }), targetWorkspace);
      }
      catch (error) { if (error instanceof InteractionRpcError) throw new OrchestratorError(error.code, error.message, error.retryable); throw error; }
    };
    const accessReceipts = () => context.protocolVersion === 2 && context.capabilities?.has(ACCESS_RECEIPTS_CAPABILITY);
    switch (frame.method) {
      case "access.getReceipt": {
        if (!accessReceipts() || !context.accessReceipt) throw new OrchestratorError("CAPABILITY_REQUIRED", "Access receipts require negotiated v2 support");
        const payload = z.object({ commandId: z.string().min(1).max(128) }).strict().parse(frame.payload);
        return publicValue(await context.accessReceipt(payload), workspace);
      }
      case "access.revokeSelf":
      case "access.revokeDevice":
      case "access.revokeAll":
      case "access.revokeAllDevices": {
        if (!accessReceipts()) return context.access(frame.method, frame.payload);
        if (!context.accessCommand) throw new OrchestratorError("CAPABILITY_REQUIRED", "Access receipts are unavailable");
        return publicValue(await context.accessCommand(frame.method, frame.payload, commandId()), workspace);
      }
      case "interaction.get":
      case "interaction.list":
      case "interaction.respondApproval":
      case "question.respond": return dispatchInteraction(frame.method);
      case "session.openView": { const request = OpenViewRequestSchema.parse(frame.payload); requireViews(request.sessionId); if (!context.openView) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.openView(request); }
      case "timeline.getPage": { const request = TimelinePageRequestSchema.parse(frame.payload); requireViews(request.sessionId); if (!context.timelinePage) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.timelinePage(request); }
      case "timeline.subscribe": { const request = TimelineSubscribeRequestSchema.parse(frame.payload); requireViews(request.sessionId); if (!context.timelineSubscribe) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.timelineSubscribe(request); }
      case "timeline.unsubscribe": requireViews(); if (!context.timelineUnsubscribe) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.timelineUnsubscribe(TimelineUnsubscribeRequestSchema.parse(frame.payload).subscriptionId);
      case "session.recovery.inspect": {
        const payload = RecoveryInspectPayloadSchema.parse(frame.payload);
        authorizeSession(payload.sessionId);
        const recovery = this.recovery(context, payload.sessionId);
        return recovery.inspect(payload);
      }
      case "session.recovery.reconcile": {
        const payload = RecoveryReconcilePayloadSchema.parse(frame.payload);
        authorizeSession(payload.sessionId, "session:write");
        const recovery = this.recovery(context, payload.sessionId);
        const { attemptId, ...request } = payload;
        return recovery.reconcile({ ...request, ...(attemptId ? { attemptId } : {}), authSubjectId: context.subjectId, commandId: commandId() });
      }
      case "session.recovery.acknowledge": {
        const payload = RecoveryAcknowledgePayloadSchema.parse(frame.payload);
        authorizeSession(payload.sessionId, "session:write");
        const recovery = this.recovery(context, payload.sessionId);
        const { attemptId, ...request } = payload;
        return recovery.acknowledge({ ...request, ...(attemptId ? { attemptId } : {}), authSubjectId: context.subjectId, commandId: commandId() });
      }
      case "host.bootstrap": return this.options.bootstrap();
      case "host.getDescriptor": return this.options.descriptor();
      case "host.getSnapshot":
      case "session.create": checkSession(); return publicSnapshot(orchestrator.publicSnapshot(), workspace);
      case "host.getStatus": {
        checkSession();
        const [provider, git] = await Promise.all([orchestrator.providerStatus(), orchestrator.gitStatus()]);
        return { provider: publicProviderStatus(provider, workspace), git: publicGitStatus(git, workspace), session: publicSnapshot(orchestrator.publicSnapshot(), workspace).session };
      }
      case "host.probe": {
        checkSession();
        const [provider, git] = await Promise.all([orchestrator.providerStatus(), orchestrator.gitStatus()]);
        return { bootstrap: this.options.bootstrap(), status: publicProviderStatus(provider, workspace), git: publicGitStatus(git, workspace) };
      }
      case "session.getEvents": {
        const payload = EventsPayload.parse(frame.payload);
        checkSession(payload.sessionId);
        const page = orchestrator.timeline(payload.afterSequence, payload.limit, payload.upTo);
        return { ...page, events: page.events.map((event) => {
          const raw = event.payload;
          if (event.type === "assistant.message.delta" && raw && typeof raw === "object" && "itemId" in raw && typeof raw.itemId === "string") {
            const text = this.options.contentStore?.publicDelta(event.sessionId, raw.itemId, event.sequence);
            if (text !== undefined) return publicEvent({ ...event, payload: { ...raw, text } }, workspace);
          }
          return publicEvent(event, workspace);
        }) };
      }
      case "session.getDiff": {
        const payload = z.object({ sessionId: SessionId }).parse(frame.payload);
        checkSession(payload.sessionId);
        return publicGitDiff(await orchestrator.gitDiff(), workspace);
      }
      case "content.getChunk": {
        if (!context.capabilities?.has(BOUNDED_CONTENT_CAPABILITY) || !this.options.contentStore) throw new OrchestratorError("CAPABILITY_REQUIRED", "Bounded content capability is required");
        const payload = ContentChunkRequestSchema.parse(frame.payload);
        authorizeSession(payload.sessionId);
        if (hostViews && context.viewOwner) hostViews.resource(payload.sessionId, context.viewOwner());
        else checkSession(payload.sessionId);
        return this.options.contentStore.getChunk(payload, {
          subjectId: context.subjectId,
          ...(context.frameBudget ? { budget: context.frameBudget } : {}),
          ...(context.responseEnvelope ? { envelope: context.responseEnvelope } : {}),
          ...(context.assertContentScope ? { assertScope: context.assertContentScope } : {}),
        });
      }
      case "command.getReceipt": {
        const payload = z.object({ commandId: z.string().min(1).max(128) }).parse(frame.payload);
        const receipt = orchestrator.store.getCommandReceipt(context.subjectId, payload.commandId);
        if (!receipt || receipt.method.startsWith("access.")) return { found: false, commandId: payload.commandId };
        if (receipt.targetSessionId) checkSession(receipt.targetSessionId);
        return { found: true, commandId: receipt.commandId, method: receipt.method, state: receipt.state, response: publicValue(receipt.response, workspace), updatedAt: receipt.updatedAt };
      }
      case "session.startTurn": {
        rejectExplicitExecutionTarget();
        const payload = z.object({ prompt: z.string().min(1).max(16 * 1024) }).parse(frame.payload);
        checkSession(orchestrator.sessionId, "session:write");
        if (!orchestrator.startTurn) throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Writes require Session routing");
        return orchestrator.startTurn(context.subjectId, commandId(), payload.prompt);
      }
      case "session.interrupt": {
        rejectExplicitExecutionTarget();
        checkSession(orchestrator.sessionId, "session:write");
        if (!orchestrator.interrupt) throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Writes require Session routing");
        return orchestrator.interrupt(context.subjectId, commandId());
      }
      case "approval.respond": {
        rejectExplicitExecutionTarget();
        const payload = z.object({ approvalId: z.string().min(1).max(128), action: z.enum(["allow_once", "deny"]) }).parse(frame.payload);
        checkSession(orchestrator.sessionId, "approval:write");
        if (!orchestrator.respondApproval) throw new OrchestratorError("SESSION_ROUTING_REQUIRED", "Writes require Session routing");
        return orchestrator.respondApproval(context.subjectId, commandId(), payload.approvalId, payload.action);
      }
      case "session.subscribe": {
        if (context.capabilities?.has(TIMELINE_PROJECTION_CAPABILITY)) throw new OrchestratorError("SUBSCRIPTION_MODE_CONFLICT", "Canonical clients use session.openView");
        const payload = SubscribePayload.parse(frame.payload);
        checkSession(payload.sessionId);
        return context.subscribe(payload.afterSequence);
      }
      default:
        if (frame.method.startsWith("access.")) return context.access(frame.method, frame.payload);
        throw new OrchestratorError("METHOD_NOT_FOUND", "Unknown RPC method");
    }
  }
}
