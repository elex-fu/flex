import { dispatchContextForTurn } from "../provider/types.js";
import type { CommandFacts, CommandPlan, CommandRequest, DecisionClock, ExecutionIntentInput, NewTurn } from "./command-contract.js";

function requireSession(facts: CommandFacts) {
  if (!facts.session) throw new Error("SESSION_NOT_FOUND");
  return facts.session;
}
function receipt(request: CommandRequest, state: "accepted" | "completed", response: unknown) {
  return { ...request, requestFormatVersion: request.requestFormatVersion ?? 1, state, response };
}
function intent(request: CommandRequest, turn: { id: string; generation: number; attemptId?: string }, clock: DecisionClock,
  kind: ExecutionIntentInput["kind"], resourceId: string, payload: unknown): ExecutionIntentInput {
  if (!request.targetSessionId) throw new Error("SESSION_NOT_FOUND");
  const attemptId = turn.attemptId ?? clock.id();
  return { id: clock.id(), sessionId: request.targetSessionId, turnId: turn.id,
    authSubjectId: request.authSubjectId, commandId: request.commandId, ordinal: 0, actorKind: request.actorKind ?? "device",
    kind, resourceId, payload, requestHash: request.requestHash, requestFormatVersion: request.requestFormatVersion ?? 1,
    runtimeGeneration: turn.generation, attemptId,
    ...(request.dispatchBinding ? { dispatchContext: dispatchContextForTurn(turn.id, {
      ...request.dispatchBinding, sessionId: request.targetSessionId, flyxTurnId: turn.id,
      runtimeGeneration: turn.generation, attemptId,
    }) } : {}) };
}

/** Pure: injected clock/IDs and durable facts are its only inputs. */
export function decideAcceptTurn(facts: CommandFacts, request: CommandRequest, input: {
  prompt: string; turnId?: string; generation?: number; attemptId?: string;
}, clock: DecisionClock): CommandPlan<{ turnId: string; status: "accepted" }> {
  const session = requireSession(facts);
  if (facts.activeTurn || session.activityState !== "idle") throw new Error("TURN_BUSY");
  const turnId = input.turnId ?? clock.id();
  const turn: NewTurn = { sessionId: session.id, turnId, authSubjectId: request.authSubjectId,
    commandId: request.commandId, requestHash: request.requestHash, prompt: input.prompt,
    generation: input.generation ?? facts.runtimeGeneration + 1, attemptId: input.attemptId ?? clock.id() };
  const response = { turnId, status: "accepted" } as const;
  const start = intent(request, { id: turnId, generation: turn.generation, ...(turn.attemptId ? { attemptId: turn.attemptId } : {}) }, clock,
    "start_turn", turnId, { turnId, prompt: input.prompt, ...(session.providerSessionId ? { resumeSessionId: session.providerSessionId } : {}) });
  return { result: response, expectedRevision: session.revision, turns: [turn], receipts: [receipt(request, "accepted", response)], intents: [start], events: [
    { id: clock.id(), type: "user.message.created", payload: { turnId, itemId: `user-${turnId}`, text: input.prompt }, options: {
      timeline: { itemId: `user-${turnId}`, kind: "user_message", status: "completed", content: { turnId, text: input.prompt } },
    } },
    { id: clock.id(), type: "turn.requested", payload: { turnId, commandId: request.commandId }, options: { activityState: "running" } },
  ] };
}

export function decideInterrupt(facts: CommandFacts, request: CommandRequest, clock: DecisionClock): CommandPlan<{ status: string; turnId?: string }> {
  const session = requireSession(facts);
  const turn = facts.activeTurn;
  if (!turn) {
    const response = { status: "already_terminal" };
    return { result: response, expectedRevision: session.revision, receipts: [receipt(request, "completed", response)] };
  }
  const original = facts.intents.find((value) => value.kind === "start_turn" && value.turnId === turn.id && value.attemptId === turn.attemptId
    && value.runtimeGeneration === turn.generation && ["pending", "claimed"].includes(value.state));
  const binding = request.dispatchBinding, dispatch = original?.dispatchContext;
  // Only a still-pending task (waiting for host capacity, before its claim)
  // is cancelled here. A claimed intent is already in preparation: its
  // interrupt rides the original control lane and is delivered to the
  // original runtime binding instead of cancelling the task.
  if (original && binding && dispatch && dispatch.hostOwnerId === binding.hostOwnerId && dispatch.hostOwnerGeneration === binding.hostOwnerGeneration
    && dispatch.runtimeId === binding.runtimeId && dispatch.sessionId === session.id && dispatch.flyxTurnId === turn.id
    && original.state === "pending") {
    const response = { status: "cancelled", turnId: turn.id };
    return { result: response, expectedRevision: session.revision, receipts: [receipt(request, "completed", response)],
      receiptUpdates: [{ authSubjectId: original.authSubjectId, commandId: original.commandId, requestHash: original.requestHash,
        state: "cancelled", response: { turnId: turn.id, status: "cancelled", evidence: { kind: "not-dispatched" } }, required: true }],
      events: [{ id: clock.id(), type: "turn.cancelled", payload: { turnId: turn.id, reason: "cancelled_before_dispatch", evidence: { kind: "not-dispatched" } },
        options: { activityState: "idle", turnId: turn.id, turnStatus: "cancelled" } }],
    };
  }
  const response = { status: "accepted", turnId: turn.id };
  return { result: response, expectedRevision: session.revision, receipts: [receipt(request, "accepted", response)],
    intents: [intent(request, turn, clock, "interrupt_turn", turn.id, { turnId: turn.id, reason: "user_interrupt" })], events: [
      { id: clock.id(), type: "turn.interrupt.requested", payload: { turnId: turn.id, commandId: request.commandId }, options: {
        activityState: "interrupting", turnId: turn.id, turnStatus: "interrupting", timeline: {
          itemId: `interrupt-${turn.id}`, kind: "system", status: "requested", content: { turnId: turn.id, message: "Interrupt requested" },
        },
      } },
    ] };
}

export function decideApprovalReservation(facts: CommandFacts, request: CommandRequest,
  input: { approvalId: string; action: "allow_once" | "deny" }, clock: DecisionClock): CommandPlan<{ status: "accepted"; approvalId: string }> {
  const session = requireSession(facts);
  const approval = facts.approval;
  if (!approval || approval.sessionId !== session.id) throw new Error("APPROVAL_NOT_FOUND");
  if (approval.status !== "pending") throw new Error("ALREADY_RESOLVED");
  if (facts.reservation) throw new Error("INTERACTION_RESPONDING");
  const turn = facts.activeTurn;
  if (!turn || turn.id !== approval.turnId || turn.status === "outcome_unknown") throw new Error("APPROVAL_NOT_ACTIVE");
  const response = { status: "accepted", approvalId: approval.approvalId } as const;
  const delivery = intent(request, turn, clock, "respond_approval", approval.approvalId,
    { approvalId: approval.approvalId, turnId: approval.turnId, toolUseId: approval.toolUseId, action: input.action });
  delivery.nativeRequestId = approval.toolUseId;
  return { result: response, expectedRevision: session.revision, receipts: [receipt(request, "accepted", response)], intents: [delivery],
    approvalReservations: [{ approvalId: approval.approvalId, expectedVersion: approval.version,
      authSubjectId: request.authSubjectId, commandId: request.commandId, action: input.action, intentId: delivery.id }],
    events: [{ id: clock.id(), type: "approval.response.accepted", payload: { approvalId: approval.approvalId, turnId: approval.turnId,
      action: input.action, status: "accepted", itemId: `approval-${approval.approvalId}` }, options: {
      timeline: { itemId: `approval-${approval.approvalId}`, kind: "approval", status: "responding",
        content: { ...approval.request, approvalId: approval.approvalId, action: input.action, status: "responding", deliveryState: "accepted" } },
    } }],
  };
}
