import { ClaudeAdapter } from "../claude/adapter.js";
import { CodexAdapter } from "../codex/adapter.js";
import { INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, InteractionGetRequestSchema, InteractionListRequestSchema, InteractionRespondApprovalRequestSchema, QuestionRespondRequestSchema, type SessionEvent } from "@flyx/mvp-protocol";
import { ZodError } from "zod";
import { OrchestratorError, type SessionOrchestrator } from "../session/orchestrator.js";
import type { AdapterEvent, DispatchContext, ProviderAdapter } from "../provider/types.js";
import type { CommandRequest, PlannedEvent } from "../orchestration/command-contract.js";
import type { ViewInteractionReader } from "../timeline/host-views.js";
import { validateInteractionSchema, INTERACTION_SCHEMA_VERSION } from "../storage/migrations/008-interactions.js";
import { InteractionService, type InteractionServiceOptions, type InteractionSessionRoute } from "./interaction-service.js";
import { ingestInteractionEvent, registerInteractionControls } from "./interaction-runtime.js";
import { INTERACTION_RPC_SCOPES, interactionRpc, InteractionRpcError } from "./interaction-rpc.js";
export type InteractionMethod = keyof typeof INTERACTION_RPC_SCOPES;
export type HostInteractionHooks = {
  rpcPort(): InteractionRpcPort | undefined;
  handle(event: AdapterEvent): boolean;
  companionEvents(sessionId: string, turnId: string, reason: string): PlannedEvent[];
  respondLegacyApproval(authSubjectId: string, commandId: string, approvalId: string, action: "allow_once" | "deny", targetRequest?: CommandRequest): {
    status: string;
    approvalId: string;
  };
};
export type InteractionRpcPort = {
  rpc(method: InteractionMethod, payload: unknown, actor: {
    authSubjectId: string;
    commandId?: string;
  }): unknown;
};
export type HostInteractionsOptions = Pick<InteractionServiceOptions, "hashRequest" | "now" | "onEvidence" | "allowVerificationFlow"> & {
  /** A catalog resolver is a pure read and must not load a Provider for history. */
  resolveSession?: (sessionId: string) => InteractionSessionRoute;
  resolveAdapter?: (context: DispatchContext) => ProviderAdapter | undefined;
  adapterForSession?: (sessionId: string) => ProviderAdapter | undefined;
  publish?: (event: SessionEvent) => void;
  evidenceSource?: "native" | "fixture";
};
/** No DDL here: the central migration chain exclusively activates version 008. */
export function interactionsReady(host: Pick<SessionOrchestrator, "store">): boolean {
  const declared = host.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(INTERACTION_SCHEMA_VERSION);
  if (!declared)
    return false;
  validateInteractionSchema(host.store.db);
  return true;
}
export function createHostInteractions(host: SessionOrchestrator, options: HostInteractionsOptions = {}): HostInteractions | undefined {
  return interactionsReady(host) ? new HostInteractions(host, options) : undefined;
}
/** Shared writer, immutable native fences, and the tracked short control lane. */
export class HostInteractions implements HostInteractionHooks, InteractionRpcPort {
  readonly service: InteractionService;
  private closed = false;
  constructor(readonly host: SessionOrchestrator, readonly options: HostInteractionsOptions = {}) {
    if (!interactionsReady(host))
      throw new InteractionRpcError("INTERACTIONS_UNAVAILABLE");
    const source = options.evidenceSource ?? (host.adapter instanceof ClaudeAdapter || host.adapter instanceof CodexAdapter ? "native" : "fixture");
    this.service = new InteractionService(host.commandEngine, {
      resolveSession: (id) => {
        const route = options.resolveSession?.(id) ?? this.defaultRoute(id);
        if (host.store.getSession(id)?.recoveryState === "blocked" || ["completed", "failed", "cancelled", "outcome_unknown"].includes(host.store.getActiveTurn(id)?.status ?? "")) {
          const { runtimeId: _runtime, ...blocked } = route;
          return blocked;
        }
        return route;
      },
      questionCapability: (id) => source === "native" && (options.adapterForSession?.(id) ?? (id === host.sessionId ? host.adapter : undefined))?.structuredQuestionsAvailable?.() === true,
      publish: options.publish ?? ((event) => host.publishCommittedEvent(event)), evidenceSource: source,
      ...(options.hashRequest ? { hashRequest: options.hashRequest } : {}), ...(options.now ? { now: options.now } : {}),
      ...(options.onEvidence ? { onEvidence: options.onEvidence } : {}), ...(options.allowVerificationFlow ? { allowVerificationFlow: true } : {}),
    });
    registerInteractionControls(host.worker, this.service, options.resolveAdapter ?? ((context) => host.runtimes.matches(context) ? host.adapter : undefined));
  }
  rpcPort(): InteractionRpcPort | undefined { return this.closed ? undefined : this; }
  capabilities(): readonly string[] {
    this.assertOpen();
    return [INTERACTION_CAPABILITY, ...(this.service.questionCapability(this.host.sessionId) ? [STRUCTURED_QUESTION_CAPABILITY] : [])];
  }
  close(): void {
    if (this.closed)
      return;
    this.closed = true;
    this.service.close();
  }
  handle(event: AdapterEvent): boolean { this.assertOpen(); return ingestInteractionEvent(this.service, event); }
  companionEvents(sessionId: string, turnId: string, reason: string): PlannedEvent[] {
    this.assertOpen();
    return this.service.planSupersessionEvents(sessionId, { turnId }, reason);
  }
  list(sessionId: string, after?: string): ReturnType<InteractionService["list"]> { this.assertOpen(); return this.service.list(sessionId, after); }
  rpc(method: InteractionMethod, payload: unknown, actor: {
    authSubjectId: string;
    commandId?: string;
  }): unknown {
    this.assertOpen();
    payload = parseInteractionRpcPayload(method, payload);
    if (method === "interaction.respondApproval" || method === "question.respond") {
      if ((payload as {
        sessionId: string;
      }).sessionId !== this.host.sessionId)
        throw new InteractionRpcError("SESSION_NOT_FOUND");
      if (!actor.commandId)
        throw new InteractionRpcError("COMMAND_ID_REQUIRED");
      this.assertControlAdmission(actor.authSubjectId, actor.commandId);
      return interactionRpc(this.service, method, payload, { authSubjectId: actor.authSubjectId, commandId: actor.commandId });
    }
    return interactionRpc(this.service, method, payload);
  }
  respondLegacyApproval(authSubjectId: string, commandId: string, approvalId: string, action: "allow_once" | "deny", targetRequest?: CommandRequest): {
    status: string;
    approvalId: string;
  } {
    this.assertOpen();
    if (this.service.interactions.get(approvalId)?.sessionId !== this.host.sessionId)
      throw new InteractionRpcError("APPROVAL_NOT_FOUND");
    this.assertControlAdmission(authSubjectId, commandId);
    try {
      const result = this.service.respondLegacyApproval(authSubjectId, commandId, approvalId, action, targetRequest);
      return { status: result.status, approvalId };
    }
    catch (error) {
      throw domainError(error);
    }
  }
  private assertControlAdmission(subject: string, command: string): void {
    // Identical durable receipts remain queryable; Engine admission still checks revocation and scope before reuse.
    if (!this.host.store.getCommandReceipt(subject, command))
      this.host.worker.assertAdmission("control");
  }
  private defaultRoute(sessionId: string): InteractionSessionRoute {
    if (sessionId !== this.host.sessionId)
      throw new InteractionRpcError("SESSION_NOT_FOUND");
    const turn = this.host.store.getActiveTurn(sessionId);
    const original = turn?.authSubjectId ? this.host.execution.forCommand(turn.authSubjectId, turn.commandId).find((intent) => intent.kind === "start_turn" && intent.attemptId === turn.attemptId)?.dispatchContext : undefined;
    return { provider: this.host.adapter.provider, ...(original && this.host.runtimes.matches(original) ? { runtimeId: original.runtimeId } : {}) };
  }
  private assertOpen(): void {
    if (this.closed || !this.host.store.db.open)
      throw new InteractionRpcError("INTERACTIONS_UNAVAILABLE");
    this.host.owner.assertActive();
  }
}
/** Compose these closures into the R04/R11 factory; executionSetup precedes attention attachment. */
export function createHostInteractionBindings(options: HostInteractionsOptions = {}) {
  let current: HostInteractions | undefined;
  const events: HostInteractionHooks = {
    rpcPort: () => current,
    handle: (event) => current?.handle(event) ?? false,
    companionEvents: (session, turn, reason) => current?.companionEvents(session, turn, reason) ?? [],
    respondLegacyApproval: (subject, command, approval, action, targetRequest) => {
      if (!current)
        throw new InteractionRpcError("INTERACTIONS_UNAVAILABLE");
      return current.respondLegacyApproval(subject, command, approval, action, targetRequest);
    },
  };
  const readViewInteractions: ViewInteractionReader = (session, after) => {
    if (!current)
      throw new InteractionRpcError("INTERACTIONS_UNAVAILABLE");
    return current.list(session, after);
  };
  return {
    executionSetup: (host: SessionOrchestrator) => {
      if (current?.host === host)
        return;
      if (current)
        throw new InteractionRpcError("INTERACTION_HOST_REPLACED");
      current = createHostInteractions(host, options);
    },
    interactionEvents: events, readViewInteractions, interactions: () => current,
    capabilities: (): readonly string[] => current?.capabilities() ?? [],
    companionEvents: events.companionEvents,
    supersedeInteractions: (sessionId: string, old: { attemptId: string; runtimeGeneration: number }, reason: string): number =>
      current?.service.supersedeForRuntime(sessionId, old, reason) ?? 0,
    close: () => { current?.close(); current = undefined; },
  };
}
function domainError(error: unknown): InteractionRpcError {
  if (error instanceof InteractionRpcError)
    return error;
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.message) ? error.message : "INTERACTION_FAILED";
  return new InteractionRpcError(code, ["INTERACTION_VERSION_CONFLICT", "INTERACTION_RESPONDING"].includes(code));
}
/** Resolve the concrete Session from the same strict payload used for its eventual command hash. */
export function parseInteractionRpcPayload(method: InteractionMethod, payload: unknown): {
  sessionId: string;
} {
  try {
    switch (method) {
      case "interaction.get": return InteractionGetRequestSchema.parse(payload);
      case "interaction.list": return InteractionListRequestSchema.parse(payload);
      case "interaction.respondApproval": return InteractionRespondApprovalRequestSchema.parse(payload);
      case "question.respond": return QuestionRespondRequestSchema.parse(payload);
      default: throw new InteractionRpcError("METHOD_NOT_FOUND");
    }
  }
  catch (error) {
    if (error instanceof ZodError)
      throw new InteractionRpcError("INVALID_PARAMS");
    throw error;
  }
}
/** The authenticated Gateway uses its actual v2 lease and negotiated capability set. */
export function assertInteractionCapabilities(method: string, protocolVersion: number, capabilities: ReadonlySet<string>): void {
  if (!Object.hasOwn(INTERACTION_RPC_SCOPES, method))
    return;
  if (protocolVersion !== 2 || !capabilities.has(INTERACTION_CAPABILITY)
    || (method === "question.respond" && !capabilities.has(STRUCTURED_QUESTION_CAPABILITY)))
    throw new OrchestratorError("CAPABILITY_REQUIRED", "Typed interactions require negotiated v2 capabilities");
}
