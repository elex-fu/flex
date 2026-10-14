import type { AdapterEvent, DispatchContext, ProviderAdapter, ProviderControlOutcome } from "../provider/types.js";
import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
import { InteractionService } from "./interaction-service.js";
import { interactionFence, type NativeInteractionEvidence } from "./types.js";
/** Structural R06 contract keeps this module usable before worker construction. */
export type InteractionControlOutcome = ProviderControlOutcome;
export interface InteractionControlWorker {
  registerControl(kind: string, deliver: (intent: ExecutionIntentRow, context: DispatchContext) => Promise<InteractionControlOutcome> | InteractionControlOutcome, commit: (intent: ExecutionIntentRow, outcome: InteractionControlOutcome) => void): void;
}
/** Register before worker.start(): recovery uses the same synchronous settlement. */
export function registerInteractionControls(worker: InteractionControlWorker, service: InteractionService, resolveAdapter: (context: DispatchContext) => ProviderAdapter | undefined): void {
  const deliver = (intent: ExecutionIntentRow, context: DispatchContext): InteractionControlOutcome => {
    let row;
    try {
      row = service.validateDelivery(intent, interactionFence(context));
    }
    catch {
      return { status: "not_dispatched", evidence: { kind: "not-dispatched" }, error: "INTERACTION_DELIVERY_STALE" };
    }
    const adapter = resolveAdapter(context);
    if (!adapter)
      return { status: "not_dispatched", evidence: { kind: "not-dispatched" }, error: "NATIVE_RUNTIME_UNAVAILABLE" };
    const answer = service.interactions.reservation(row.interactionId)!.answer;
    try {
      const delivery = row.kind === "question" && "answers" in answer
        ? adapter.respondQuestion?.(row.interactionId, answer.answers) ?? { kind: "not-dispatched" as const, reason: "question_method_unavailable" }
        : row.kind === "approval" && "action" in answer
          ? adapter.respondApproval(row.legacyApprovalId ?? row.interactionId, answer.action)
            ? { kind: "local-delivery" as const } : { kind: "unknown" as const, reason: "approval_delivery_unconfirmed" }
          : { kind: "not-dispatched" as const, reason: "answer_kind_invalid" };
      return delivery.kind === "local-delivery" ? { status: "delivered", evidence: delivery }
        : delivery.kind === "unknown" ? { status: "outcome_unknown", evidence: delivery, error: delivery.reason }
          : { status: "not_dispatched", evidence: { kind: "not-dispatched" }, error: delivery.reason };
    }
    catch {
      return { status: "outcome_unknown", evidence: { kind: "unknown", reason: "native_delivery_unconfirmed" } };
    }
  };
  const settle = (intent: ExecutionIntentRow, outcome: InteractionControlOutcome): void => {
    const evidence: NativeInteractionEvidence = outcome.evidence.kind === "local-delivery" ? outcome.evidence
      : outcome.evidence.kind === "native-ack" && intent.nativeRequestId ? { ...outcome.evidence, nativeRequestId: intent.nativeRequestId }
        : outcome.evidence.kind === "not-dispatched" ? { kind: "not-dispatched", reason: outcome.error ?? "native_request_gone" }
          : { kind: "unknown", reason: outcome.evidence.kind === "unknown" ? outcome.evidence.reason : "control_delivery_unconfirmed" };
    // A native Turn terminal never confirms an interaction response.
    service.recordDelivery(intent.id, evidence);
  };
  worker.registerControl("respond_question", deliver, settle);
  worker.registerControl("respond_approval", deliver, settle);
}
/** Call only after the central ingestion queue has validated the source fence. */
export function ingestInteractionEvent(service: InteractionService, event: AdapterEvent): boolean {
  const binding = interactionFence(event.dispatchContext);
  if (event.kind === "question_requested") {
    service.ingestQuestion(binding, event.request);
    return true;
  }
  if (event.kind === "question_resolved") {
    service.resolveNative(event.interactionId, event.status, binding, event.evidence);
    return true;
  }
  if (event.kind === "approval_resolved") {
    const row = service.interactions.get(event.approvalId);
    if (!row)
      return false;
    const reservation = service.interactions.reservation(row.interactionId);
    if (event.action === "expired" || event.action === "aborted" || !reservation)
      service.resolveNative(row.interactionId, event.action === "expired" ? "expired" : "superseded", binding);
    else
      service.recordDelivery(reservation.intentId, { kind: "local-delivery" }, binding);
    return true;
  }
  if (event.kind !== "approval_requested")
    return false;
  const request = event.request;
  if (!request.dispatchContext?.nativeRequestId || !request.dispatchContext.nativeMethod)
    throw new Error("INTERACTION_NATIVE_BINDING_MISSING");
  const command = typeof request.input.command === "string" ? request.input.command.slice(0, 4096) : undefined;
  const files = Array.isArray(request.input.paths) ? request.input.paths.filter((path): path is string => typeof path === "string").slice(0, 32).map((path) => path.slice(0, 1024))
    : typeof request.input.file_path === "string" ? [request.input.file_path.slice(0, 1024)] : undefined;
  service.ingestApproval(binding, {
    interactionId: request.approvalId, ...request.dispatchContext,
    request: {
      toolName: request.toolName.slice(0, 128), ...(request.title ? { title: request.title.slice(0, 512) } : {}),
      ...(request.description ? { reason: request.description.slice(0, 2048) } : {}), ...(command ? { commandPreview: command } : {}), ...(files ? { filePreviews: files } : {})
    },
    createdAt: request.createdAt, expiresAt: new Date(Date.parse(request.createdAt) + 10 * 60000).toISOString(),
    approval: { approvalId: request.approvalId, sessionId: binding.sessionId, turnId: binding.turnId, toolUseId: request.toolUseId, version: 0, status: "pending", request, createdAt: request.createdAt }
  });
  return true;
}
