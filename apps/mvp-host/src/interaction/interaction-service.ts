import { createHash } from "node:crypto";
import { InteractionRespondApprovalRequestSchema, QuestionRespondRequestSchema, InteractionSchema, QuestionRequestSchema, validateQuestionAnswers, encodedBytes, type Interaction, type InteractionResponse, type InteractionRespondApprovalRequest, type QuestionRespondRequest, } from "@flyx/mvp-protocol";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import type { CommandPlan, CommandRequest, ExecutionIntentRow, PlannedEvent } from "../orchestration/command-contract.js";
import type { ApprovalRow, EventCommitOptions, SqliteStore } from "../storage/db.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { InteractionStore, methodMatches } from "./interaction-store.js";
import type { InteractionEvidenceSample, InteractionFence, InteractionRow, NativeInteractionEvidence, NativeInteractionMethod, NativeQuestionRequest } from "./types.js";
import type { SessionEvent } from "@flyx/mvp-protocol";
export type InteractionSessionRoute = {
  provider: "claude" | "codex";
  workspaceId?: string;
  runtimeId?: string;
  adapterVersion?: string;
  runtimeVersion?: string;
};
export type InteractionServiceOptions = {
  resolveSession: (sessionId: string) => InteractionSessionRoute;
  questionCapability?: (sessionId: string) => boolean;
  hashRequest?: (method: string, parsedPayload: unknown, sessionId: string) => string;
  /** Only an explicit local verification harness may use this; it never advertises a capability. */
  allowVerificationFlow?: boolean;
  publish?: (event: SessionEvent) => void;
  evidenceSource?: "native" | "fixture";
  onEvidence?: (evidence: InteractionEvidenceSample) => void;
  now?: () => string;
};
/** No SDK, Git, process, or transport wait occurs inside a command decision. */
export class InteractionService {
  readonly interactions: InteractionStore;
  readonly execution: ExecutionStore;
  private readonly detach: () => void;
  private sealed = false;
  constructor(readonly engine: CommandEngine, private readonly options: InteractionServiceOptions) {
    this.interactions = new InteractionStore(engine.store.db);
    this.execution = new ExecutionStore(engine.store);
    this.detach = this.interactions.attach(engine.store);
  }
  /** Detach this lease and fence retained callbacks without settling any durable outcome. */
  seal(): void { if (this.sealed) return; this.sealed = true; this.detach(); }
  close(): void { this.seal(); }
  get store(): SqliteStore { return this.engine.store; }
  questionCapability(sessionId: string): boolean { return !this.sealed && this.options.evidenceSource !== "fixture" && this.options.questionCapability?.(sessionId) === true; }
  get(sessionId: string, interactionId: string): Interaction {
    this.assertOpen();
    const route = this.options.resolveSession(sessionId);
    const row = this.interactions.get(interactionId);
    if (!row || row.sessionId !== sessionId)
      throw new Error("INTERACTION_NOT_FOUND");
    const value = this.interactions.public(row);
    value.responseAvailable = this.responseAvailable(row, route);
    return value;
  }
  list(sessionId: string, afterInteractionId?: string): {
    interactions: Interaction[];
    hasMore: boolean;
    nextAfterInteractionId?: string;
  } {
    this.assertOpen();
    const route = this.options.resolveSession(sessionId);
    const rows = this.interactions.list(sessionId, { ...(afterInteractionId ? { afterInteractionId } : {}), limit: 51 });
    const interactions: Interaction[] = [];
    for (const row of rows) {
      const value = this.interactions.public(row);
      value.responseAvailable = this.responseAvailable(row, route);
      if (interactions.length >= 50 || encodedBytes({ interactions: [...interactions, value], hasMore: true }) > 48 * 1024)
        break;
      interactions.push(value);
    }
    const hasMore = interactions.length < rows.length;
    const last = interactions.at(-1);
    return { interactions, hasMore, ...(hasMore && last ? { nextAfterInteractionId: last.interactionId } : {}) };
  }
  ingestQuestion(binding: InteractionFence, native: NativeQuestionRequest): InteractionRow {
    this.assertOpen();
    if (!this.questionCapability(binding.sessionId) && !this.options.allowVerificationFlow)
      throw new Error("QUESTION_CONTRACT_UNVERIFIED");
    return this.ingest(binding, {
      interactionId: native.interactionId, kind: "question", request: QuestionRequestSchema.parse(native.request),
      nativeRequestId: native.nativeRequestId, nativeMethod: native.nativeMethod, createdAt: native.createdAt, expiresAt: native.expiresAt
    });
  }
  ingestApproval(binding: InteractionFence, input: {
    interactionId: string;
    nativeRequestId: string;
    nativeMethod: NativeInteractionMethod;
    request: Extract<Interaction, {
      kind: "approval";
    }>["request"];
    createdAt: string;
    expiresAt: string;
    approval?: ApprovalRow;
  }): InteractionRow {
    return this.ingest(binding, { ...input, kind: "approval" });
  }
  private ingest(binding: InteractionFence, input: {
    interactionId: string;
    kind: Interaction["kind"];
    request: Interaction["request"];
    nativeRequestId: string;
    nativeMethod: NativeInteractionMethod;
    createdAt: string;
    expiresAt: string;
    approval?: ApprovalRow;
  }): InteractionRow {
    this.assertOpen();
    const existing = this.interactions.get(input.interactionId);
    this.assertCurrentFence(binding);
    if (existing?.nativeRequestId) {
      if (existing.sessionId !== binding.sessionId || existing.turnId !== binding.turnId || existing.attemptId !== binding.attemptId
        || existing.nativeRequestId !== input.nativeRequestId || existing.nativeMethod !== input.nativeMethod
        || JSON.stringify(existing.request) !== JSON.stringify(input.request))
        throw new Error("INTERACTION_NATIVE_REQUEST_CHANGED");
      return existing;
    }
    const route = this.options.resolveSession(binding.sessionId);
    if (!methodMatches(input.kind, input.nativeMethod) || (route.provider === "codex") !== input.nativeMethod.startsWith("item/"))
      throw new Error("INTERACTION_NATIVE_METHOD_UNSUPPORTED");
    const value = InteractionSchema.parse({
      interactionId: input.interactionId, sessionId: binding.sessionId, turnId: binding.turnId,
      kind: input.kind, request: input.request, version: existing?.version ?? input.approval?.version ?? 0, status: "pending", deliveryState: "none", evidenceKind: "native_request",
      createdAt: input.createdAt, expiresAt: input.expiresAt, responseAvailable: input.kind === "approval" || this.questionCapability(binding.sessionId),
      allowedActions: input.kind === "question" ? ["answer"] : ["allow_once", "deny"]
    });
    const privateBinding = {
      ...binding, nativeRequestId: input.nativeRequestId, nativeMethod: input.nativeMethod,
      ...(input.approval ? { legacyApprovalId: input.approval.approvalId } : existing?.legacyApprovalId ? { legacyApprovalId: existing.legacyApprovalId } : {})
    };
    const committed = this.store.commitCommand({
      sessionId: binding.sessionId, occurredAt: this.now(), build: () => {
        this.assertCurrentFence(binding);
        return ({
          result: undefined, events: [{
              type: "interaction.requested", payload: { ...itemPayload(value, privateBinding.legacyApprovalId), interaction: value, dispatchContext: { binding: privateBinding } },
              options: {
                ...this.timeline(value, privateBinding.legacyApprovalId),
                ...(value.kind === "approval" || value.request.blocking ? { activityState: "waiting_approval" as const, turnId: binding.turnId, turnStatus: "waiting_approval" as const } : {}),
                ...(input.approval ? { approval: input.approval } : {})
              },
            }]
        });
      }
    })!;
    const row = this.interactions.get(value.interactionId)!;
    this.publish(committed.events);
    this.emitEvidence(row, "request");
    return row;
  }
  respondApproval(authSubjectId: string, commandId: string, value: unknown): InteractionResponse {
    const input = InteractionRespondApprovalRequestSchema.parse(value);
    return this.respond(authSubjectId, commandId, input, "interaction.respondApproval");
  }
  respondQuestion(authSubjectId: string, commandId: string, value: unknown): InteractionResponse {
    const input = QuestionRespondRequestSchema.parse(value);
    return this.respond(authSubjectId, commandId, input, "question.respond");
  }
  /** Old omitted-version requests may read current pending state only before any reservation. */
  respondLegacyApproval(authSubjectId: string, commandId: string, approvalId: string, action: "allow_once" | "deny", targetRequest?: CommandRequest): InteractionResponse {
    this.assertOpen();
    const row = this.interactions.get(approvalId);
    if (!row || row.kind !== "approval")
      throw new Error("APPROVAL_NOT_FOUND");
    return this.respond(authSubjectId, commandId, { sessionId: row.sessionId, interactionId: row.interactionId, expectedVersion: row.version, action }, "approval.respond", targetRequest);
  }
  private respond(authSubjectId: string, commandId: string, input: InteractionRespondApprovalRequest | QuestionRespondRequest, method: string, targetRequest?: CommandRequest): InteractionResponse {
    this.assertOpen();
    const route = this.options.resolveSession(input.sessionId);
    this.requireActor(authSubjectId, this.now());
    const payload = method === "approval.respond" && "action" in input ? { approvalId: input.interactionId, action: input.action } : input;
    if (targetRequest && (targetRequest.authSubjectId !== authSubjectId || targetRequest.commandId !== commandId || targetRequest.method !== method
      || targetRequest.targetSessionId !== input.sessionId || !targetRequest.requestHash || ![1, 2].includes(targetRequest.requestFormatVersion ?? 1)))
      throw new Error("COMMAND_SCOPE_MISMATCH");
    const requestFormatVersion = targetRequest?.requestFormatVersion ?? (method === "approval.respond" ? 1 : 2);
    const requestHash = targetRequest?.requestHash ?? (requestFormatVersion === 2 && this.options.hashRequest ? this.options.hashRequest(method, payload, input.sessionId) : hashCommandRequest(method, payload, requestFormatVersion === 2
      ? { requestFormatVersion: 2, targetSessionId: input.sessionId, ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}) } : undefined));
    const initial = this.interactions.get(input.interactionId);
    const committed = this.engine.commitRequest({ authSubjectId, commandId, method, requestHash, requestFormatVersion, targetSessionId: input.sessionId }, (facts, clock) => {
      this.requireActor(authSubjectId, clock.now());
      const row = this.interactions.get(input.interactionId);
      if (!row || row.sessionId !== input.sessionId)
        throw new Error("INTERACTION_NOT_FOUND");
      if (row.version !== input.expectedVersion)
        throw new Error("INTERACTION_VERSION_CONFLICT");
      if (row.status !== "pending" || this.interactions.reservation(row.interactionId) || (row.legacyApprovalId && facts.reservation))
        throw new Error("INTERACTION_RESPONDING");
      if (row.expiresAt <= clock.now())
        throw new Error("INTERACTION_EXPIRED");
      this.assertCurrentFence(fenceOf(row));
      if (row.kind === "question") {
        if (!("answers" in input) || (!this.questionCapability(row.sessionId) && !this.options.allowVerificationFlow))
          throw new Error("QUESTION_CONTRACT_UNVERIFIED");
        validateQuestionAnswers(row.request, input.answers);
      }
      else if (!("action" in input) || !row.allowedActions.includes(input.action))
        throw new Error("INTERACTION_ACTION_INVALID");
      const intentId = clock.id();
      const response: InteractionResponse = { interactionId: row.interactionId, version: row.version + 1, status: "accepted", deliveryState: "accepted" };
      const next = { ...this.interactions.public(row), status: "responding" as const, deliveryState: "accepted" as const, version: row.version + 1, responseAvailable: false };
      const answer = "answers" in input ? { answers: input.answers } : { action: input.action };
      return {
        result: response, expectedRevision: facts.session!.revision,
        receipts: [{ authSubjectId, commandId, method, requestHash, requestFormatVersion, targetSessionId: row.sessionId, state: "accepted", response }],
        intents: [{
            id: intentId, sessionId: row.sessionId, turnId: row.turnId, authSubjectId, commandId, ordinal: 0, actorKind: "device",
            kind: row.kind === "question" ? "respond_question" : "respond_approval", resourceId: row.interactionId,
            payload: { interactionId: row.interactionId, ...(row.legacyApprovalId ? { approvalId: row.legacyApprovalId } : {}), ...answer },
            requestHash, requestFormatVersion, runtimeGeneration: row.runtimeGeneration!, attemptId: row.attemptId!, nativeRequestId: row.nativeRequestId!, dispatchContext: row.dispatchContext!
          }],
        ...(row.legacyApprovalId && facts.approval && "action" in input ? {
          approvalReservations: [{
              approvalId: row.legacyApprovalId, expectedVersion: facts.approval.version,
              authSubjectId, commandId, action: input.action, intentId
            }]
        } : {}),
        events: [{ id: clock.id(), type: "interaction.response.accepted", payload: { ...itemPayload(next, row.legacyApprovalId), interactionId: row.interactionId, expectedVersion: row.version, interaction: next }, options: this.timeline(next) }],
      } satisfies CommandPlan<InteractionResponse>;
    }, initial?.legacyApprovalId ? { approvalId: initial.legacyApprovalId } : {});
    return committed.result;
  }
  /** Called by the short control lane after its durable dispatch marker, before native delivery. */
  validateDelivery(intent: ExecutionIntentRow, context: InteractionFence): InteractionRow {
    this.assertOpen();
    const row = this.interactions.forIntent(intent.id);
    if (!row || row.status !== "responding" || row.sessionId !== intent.sessionId || row.interactionId !== intent.resourceId
      || row.nativeRequestId !== intent.nativeRequestId || row.attemptId !== intent.attemptId || row.runtimeGeneration !== intent.runtimeGeneration)
      throw new Error("INTERACTION_DELIVERY_STALE");
    if (row.expiresAt <= this.now())
      throw new Error("INTERACTION_EXPIRED");
    this.assertSameFence(row, context);
    this.assertCurrentFence(context);
    if (row.kind === "question" && !this.questionCapability(row.sessionId) && !this.options.allowVerificationFlow)
      throw new Error("QUESTION_CONTRACT_UNVERIFIED");
    return row;
  }
  /** Delivery completion is a control fact, never a Turn terminal fact. */
  recordDelivery(intentId: string, evidence: NativeInteractionEvidence, context?: InteractionFence): boolean {
    if (this.sealed) return false;
    const initial = this.interactions.forIntent(intentId);
    if (!initial)
      return false;
    const committed = this.store.commitCommand({
      sessionId: initial.sessionId, occurredAt: this.now(), build: (facts) => {
        const row = this.interactions.forIntent(intentId)!;
        const reservation = this.interactions.reservation(row.interactionId)!;
        const receipt = this.store.getCommandReceipt(reservation.authSubjectId, reservation.commandId);
        if (!receipt)
          throw new Error("COMMAND_RECEIPT_NOT_FOUND");
        if (context)
          this.assertSameFence(row, context);
        if (row.status === "confirmed" || (row.status === "delivered" && evidence.kind !== "native-ack") || ((row.status === "expired" || row.status === "superseded") && evidence.kind !== "native-ack"))
          return undefined;
        if (evidence.kind === "native-ack") {
          if (!evidence.sourceId || evidence.nativeRequestId !== row.nativeRequestId)
            throw new Error("INTERACTION_NATIVE_EVIDENCE_INVALID");
          this.assertCurrentFence(fenceOf(row));
        }
        const status = evidence.kind === "native-ack" ? "confirmed" : evidence.kind === "local-delivery" ? "delivered"
          : evidence.kind === "not-dispatched" ? "superseded" : "outcome_unknown";
        const deliveryState = evidence.kind === "native-ack" ? "native_confirmation" : evidence.kind === "local-delivery" ? "local_delivery" : evidence.kind === "not-dispatched" ? "none" : "unconfirmed";
        const response: InteractionResponse = { interactionId: row.interactionId, version: row.version + 1, status, deliveryState };
        const next: Interaction = {
          ...this.interactions.public(row), version: row.version + 1, status, deliveryState, responseAvailable: false,
          evidenceKind: evidence.kind === "native-ack" ? "native_confirmation" as const : evidence.kind === "local-delivery" ? "local_delivery" as const : "unknown" as const
        };
        const approval = row.legacyApprovalId ? this.store.getApproval(row.legacyApprovalId) : undefined;
        const action = "action" in reservation.answer ? reservation.answer.action : undefined;
        const delivered = evidence.kind === "native-ack" || evidence.kind === "local-delivery";
        const otherInteractions = this.store.db.prepare("SELECT 1 FROM interactions WHERE session_id=? AND interaction_id<>? AND status IN ('pending','responding') LIMIT 1").get(row.sessionId, row.interactionId);
        const otherApprovals = facts.pendingApprovals.some((pending) => pending.approvalId !== row.legacyApprovalId);
        const options: EventCommitOptions = {
          ...this.timeline(next),
          ...(delivered && facts.activeTurn?.id === row.turnId ? {
            activityState: otherInteractions || otherApprovals ? "waiting_approval" as const : "running" as const,
            turnId: row.turnId, turnStatus: otherInteractions || otherApprovals ? "waiting_approval" as const : "running" as const
          } : {}),
          ...(row.legacyApprovalId ? {
            approvalDelivery: {
              approvalId: row.legacyApprovalId, authSubjectId: reservation.authSubjectId, commandId: reservation.commandId,
              state: evidence.kind === "native-ack" ? "native_confirmation" as const : evidence.kind === "local-delivery" ? "local_delivery" as const : evidence.kind === "not-dispatched" ? "aborted" as const : "outcome_unknown" as const
            }
          } : {}),
        };
        return {
          result: undefined, receiptUpdates: [{
              authSubjectId: reservation.authSubjectId, commandId: reservation.commandId, method: receipt.method,
              requestHash: receipt.requestHash, requestFormatVersion: receipt.requestFormatVersion ?? 1, targetSessionId: row.sessionId, required: true,
              state: evidence.kind === "unknown" ? "outcome_unknown" : evidence.kind === "not-dispatched" ? "failed" : "completed", response
            }],
          ...(delivered && approval?.status === "pending" && action ? { approvalResolutions: [{ approvalId: approval.approvalId, expectedVersion: approval.version, action }] } : {}),
          events: [{
              type: "interaction.delivery", payload: {
                ...itemPayload(next, row.legacyApprovalId), interactionId: row.interactionId, expectedVersion: row.version, status, deliveryState,
                ...(evidence.kind === "not-dispatched" || evidence.kind === "unknown" ? { reasonCode: safeReason(evidence.reason) } : {}), interaction: next, dispatchContext: { evidence }
              }, options
            }],
        };
      }
    });
    if (committed) {
      this.publish(committed.events);
      if (!this.sealed) this.emitEvidence(this.interactions.forIntent(intentId)!, evidence.kind === "native-ack" ? "native-confirmation" : evidence.kind === "local-delivery" ? "local-delivery" : "superseded");
    }
    return true;
  }
  resolveNative(interactionId: string, status: "expired" | "superseded" | "confirmed", binding: InteractionFence, evidence?: NativeInteractionEvidence): void {
    if (this.sealed) return;
    const row = this.interactions.get(interactionId);
    if (!row)
      throw new Error("INTERACTION_NOT_FOUND");
    this.assertSameFence(row, binding);
    if (status === "confirmed") {
      const reservation = this.interactions.reservation(interactionId);
      if (!reservation || evidence?.kind !== "native-ack")
        throw new Error("INTERACTION_NATIVE_EVIDENCE_INVALID");
      this.recordDelivery(reservation.intentId, evidence, binding);
    }
    else
      this.obsolete([row], status === "expired" ? "interaction.expired" : "interaction.superseded", status === "expired" ? "request_expired" : "native_request_gone");
  }
  expireDue(sessionId: string): number {
    if (this.sealed) return 0;
    let count = 0;
    for (;;) {
      if (this.sealed) return count;
      const rows = this.interactions.matchingOpen(sessionId, { expiresBefore: this.now() });
      if (!rows.length)
        return count;
      count += this.obsolete(rows, "interaction.expired", "request_expired");
    }
  }
  supersedeForRuntime(sessionId: string, old: Pick<InteractionFence, "attemptId" | "runtimeGeneration">, reason = "runtime_replaced"): number {
    if (this.sealed) return 0;
    let count = 0;
    for (;;) {
      if (this.sealed) return count;
      const rows = this.interactions.matchingOpen(sessionId, old);
      if (!rows.length)
        return count;
      count += this.obsolete(rows, "interaction.superseded", safeReason(reason));
    }
  }
  /** Call within the terminal/recovery decision to append canonical transitions to its same commit. */
  planSupersessionEvents(sessionId: string, filter: {
    turnId?: string;
    attemptId?: string;
    runtimeGeneration?: number;
  }, reason = "turn_no_longer_accepts_input"): PlannedEvent[] {
    if (this.sealed) return [];
    const rows = this.interactions.matchingOpen(sessionId, filter, 257);
    if (rows.length > 256)
      throw new Error("INTERACTION_BATCH_TOO_LARGE");
    return this.obsoleteEvents(rows, "interaction.superseded", safeReason(reason));
  }
  private obsolete(rows: InteractionRow[], type: "interaction.expired" | "interaction.superseded", reason: string): number {
    rows = rows.filter((row) => ["pending", "responding", "outcome_unknown"].includes(row.status));
    if (!rows.length)
      return 0;
    const sessionId = rows[0]!.sessionId;
    const committed = this.store.commitCommand({ sessionId, occurredAt: this.now(), build: () => ({ result: undefined, events: this.obsoleteEvents(rows, type, reason) }) })!;
    this.publish(committed.events);
    return rows.length;
  }
  private obsoleteEvents(rows: InteractionRow[], type: "interaction.expired" | "interaction.superseded", reason: string): PlannedEvent[] {
    return rows.map((row) => {
      const reserved = !!this.interactions.reservation(row.interactionId);
      const next: Interaction = {
        ...this.interactions.public(row), status: type === "interaction.expired" ? "expired" : "superseded",
        deliveryState: reserved ? "unconfirmed" : row.deliveryState, evidenceKind: reserved ? "unknown" : row.evidenceKind,
        version: row.version + 1, responseAvailable: false, reasonCode: reason
      };
      return { type, payload: { ...itemPayload(next, row.legacyApprovalId), interactionId: row.interactionId, expectedVersion: row.version, reasonCode: reason, interaction: next }, options: this.timeline(next) };
    });
  }
  private timeline(value: Interaction, legacyApprovalId?: string): EventCommitOptions {
    return {
      timeline: {
        itemId: itemId(value, legacyApprovalId ?? this.interactions.get(value.interactionId)?.legacyApprovalId), kind: value.kind === "approval" ? "approval" : "system",
        status: value.status, content: { ...value, ...(value.kind === "question" ? { message: "This Turn needs structured input from a question-capable client." } : {}) }
      }
    };
  }
  private responseAvailable(row: InteractionRow, route: InteractionSessionRoute): boolean {
    if (!row.responseAvailable || row.expiresAt <= this.now() || route.runtimeId !== row.runtimeId || (row.kind === "question" && !this.questionCapability(row.sessionId)))
      return false;
    try {
      this.assertCurrentFence(fenceOf(row));
      return true;
    }
    catch {
      return false;
    }
  }
  private requireActor(id: string, now: string): void {
    const device = this.store.getDevice(id);
    if (!device || device.revokedAt || (device.expiresAt && device.expiresAt <= now))
      throw new Error("DEVICE_REVOKED");
    if (!device.scopes.includes("approval:write"))
      throw new Error("SCOPE_REQUIRED");
  }
  private assertCurrentFence(binding: InteractionFence): void {
    this.assertOpen();
    const turn = this.store.getActiveTurn(binding.sessionId);
    const route = this.options.resolveSession(binding.sessionId);
    if (!turn || turn.id !== binding.turnId || turn.attemptId !== binding.attemptId || turn.generation !== binding.runtimeGeneration || route.runtimeId !== binding.runtimeId)
      throw new Error("INTERACTION_SUPERSEDED");
    if (turn.status === "outcome_unknown")
      throw new Error("RECOVERY_BLOCKED");
    if (["completed", "failed", "cancelled"].includes(turn.status))
      throw new Error("INTERACTION_SUPERSEDED");
  }
  private assertSameFence(row: InteractionRow, binding: InteractionFence): void {
    if (!row.dispatchContext || (["hostOwnerId", "hostOwnerGeneration", "sessionId", "flyxTurnId", "runtimeId", "runtimeGeneration", "attemptId"] as const).some((key) => row.dispatchContext![key] !== binding.dispatchContext[key]) || row.sessionId !== binding.sessionId || row.turnId !== binding.turnId || row.attemptId !== binding.attemptId || row.runtimeGeneration !== binding.runtimeGeneration || row.runtimeId !== binding.runtimeId)
      throw new Error("INTERACTION_DELIVERY_STALE");
  }
  private assertOpen(): void { if (this.sealed) throw new Error("INTERACTIONS_UNAVAILABLE"); }
  private publish(events: SessionEvent[]): void { for (const event of events) {
    if (this.sealed) return;
    try {
      this.options.publish?.(event);
    }
    catch { /* Durable replay restores notifications. */ }
  } }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private emitEvidence(row: InteractionRow, phase: InteractionEvidenceSample["phase"]): void {
    if (this.sealed || !row.nativeRequestId || !row.nativeMethod)
      return;
    const route = this.options.resolveSession(row.sessionId);
    const answer = this.interactions.reservation(row.interactionId)?.answer;
    const sample: InteractionEvidenceSample = {
      source: this.options.evidenceSource ?? "native", provider: route.provider, method: row.nativeMethod, phase,
      interactionDigest: digest(row.interactionId), nativeRequestDigest: digest(row.nativeRequestId), requestDigest: digest(row.request),
      ...(answer && (row.kind !== "question" || !row.request.questions.some((question) => question.secret)) ? { answerDigest: digest(answer) } : {}), questionCount: row.kind === "question" ? row.request.questions.length : 0,
      adapterVersion: route.adapterVersion ?? "unverified", runtimeVersion: route.runtimeVersion ?? "unverified"
    };
    try {
      this.options.onEvidence?.(sample);
    }
    catch { /* Evidence recorder cannot rewrite committed control facts. */ }
  }
}
export function fenceOf(row: InteractionRow): InteractionFence {
  if (!row.dispatchContext || !row.attemptId || !row.runtimeId || !row.runtimeGeneration || !row.nativeRequestId || !row.nativeMethod)
    throw new Error("INTERACTION_NATIVE_BINDING_MISSING");
  return { sessionId: row.sessionId, turnId: row.turnId, attemptId: row.attemptId, runtimeGeneration: row.runtimeGeneration, runtimeId: row.runtimeId, dispatchContext: row.dispatchContext };
}
function itemId(value: Interaction, legacyApprovalId?: string): string { return legacyApprovalId ? `approval-${legacyApprovalId}` : `interaction-${value.interactionId}`; }
function itemPayload(value: Interaction, legacyApprovalId?: string): Record<string, unknown> {
  return {
    itemId: itemId(value, legacyApprovalId), interactionId: value.interactionId, turnId: value.turnId, interactionKind: value.kind, status: value.status, request: value.request,
    ...(value.kind === "question" ? { message: "This Turn needs structured input from a question-capable client." } : {})
  };
}
function safeReason(reason: string): string { return /^[a-zA-Z0-9_:-]{1,128}$/.test(reason) ? reason : "delivery_unconfirmed"; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
