import { z } from "zod";
import { BOUNDED_CONTENT_CAPABILITY, ContentChunkRequestSchema, TIMELINE_PROJECTION_CAPABILITY, OpenViewRequestSchema, TimelinePageRequestSchema, TimelineSubscribeRequestSchema, TimelineUnsubscribeRequestSchema, type OpenViewRequest, type TimelinePageRequest, type TimelineSubscribeRequest } from "@flyx/mvp-protocol";
import type { ContentStore } from "../content/content-store.js";
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
  capabilities?: ReadonlySet<string>;
  frameBudget?: FrameBudget;
  responseEnvelope?(payload: unknown): unknown;
  assertContentScope?(scope: string): void;
  viewOwner?(): TimelineLeaseOwner;
  openView?(request: OpenViewRequest): unknown;
  timelinePage?(request: TimelinePageRequest): unknown;
  timelineSubscribe?(request: TimelineSubscribeRequest): unknown;
  timelineUnsubscribe?(id: string): unknown;
  assertAuthorized(method: string): void;
  subscribe(afterSequence: number): Promise<unknown>;
  access(method: string, payload: unknown): Promise<unknown>;
}

export interface RpcDispatcherOptions {
  contentStore?: ContentStore;
  orchestrator: SessionOrchestrator;
  bootstrap(): unknown;
  descriptor(): unknown;
}

/** Transport independent business dispatch. The Provider never receives a transport. */
export class RpcDispatcher {
  constructor(private readonly options: RpcDispatcherOptions) {}

  async dispatch(frame: RpcRequest, context: RpcContext): Promise<unknown> {
    context.assertAuthorized(frame.method);
    const { orchestrator } = this.options;
    const workspace = orchestrator.workspace;
    const checkSession = (id?: string) => {
      if (id && id !== orchestrator.sessionId) throw new OrchestratorError("SESSION_NOT_FOUND", "Session does not exist");
    };
    const commandId = () => {
      if (!frame.commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "commandId is required");
      return frame.commandId;
    };
    const requireViews = () => {
      if (!context.capabilities?.has(TIMELINE_PROJECTION_CAPABILITY) || !context.capabilities.has(BOUNDED_CONTENT_CAPABILITY) || !orchestrator.views?.ready(orchestrator.sessionId)) throw new OrchestratorError("CAPABILITY_REQUIRED", "Canonical Timeline capability is required");
    };
    switch (frame.method) {
      case "session.openView": requireViews(); if (!context.openView) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.openView(OpenViewRequestSchema.parse(frame.payload));
      case "timeline.getPage": requireViews(); if (!context.timelinePage) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.timelinePage(TimelinePageRequestSchema.parse(frame.payload));
      case "timeline.subscribe": requireViews(); if (!context.timelineSubscribe) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.timelineSubscribe(TimelineSubscribeRequestSchema.parse(frame.payload));
      case "timeline.unsubscribe": requireViews(); if (!context.timelineUnsubscribe) throw new OrchestratorError("CAPABILITY_REQUIRED", "Host views are unavailable"); return context.timelineUnsubscribe(TimelineUnsubscribeRequestSchema.parse(frame.payload).subscriptionId);
      case "host.bootstrap": return this.options.bootstrap();
      case "host.getDescriptor": return this.options.descriptor();
      case "host.getSnapshot":
      case "session.create": return publicSnapshot(orchestrator.publicSnapshot(), workspace);
      case "host.getStatus": {
        const [provider, git] = await Promise.all([orchestrator.providerStatus(), orchestrator.gitStatus()]);
        return { provider: publicProviderStatus(provider, workspace), git: publicGitStatus(git, workspace), session: publicSnapshot(orchestrator.publicSnapshot(), workspace).session };
      }
      case "host.probe": {
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
        if (orchestrator.views && context.viewOwner) orchestrator.views.resource(payload.sessionId, context.viewOwner());
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
        if (!receipt) return { found: false, commandId: payload.commandId };
        return { found: true, commandId: receipt.commandId, method: receipt.method, state: receipt.state, response: publicValue(receipt.response, workspace), updatedAt: receipt.updatedAt };
      }
      case "session.startTurn": {
        const payload = z.object({ prompt: z.string().min(1).max(16 * 1024) }).parse(frame.payload);
        return orchestrator.startTurn(context.subjectId, commandId(), payload.prompt);
      }
      case "session.interrupt": return orchestrator.interrupt(context.subjectId, commandId());
      case "approval.respond": {
        const payload = z.object({ approvalId: z.string().min(1).max(128), action: z.enum(["allow_once", "deny"]) }).parse(frame.payload);
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
