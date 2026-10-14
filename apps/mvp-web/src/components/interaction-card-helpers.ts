import { InteractionRespondApprovalRequestSchema, QuestionRespondRequestSchema, validateQuestionAnswers, type Interaction, type QuestionRespondRequest, type InteractionRespondApprovalRequest, type InteractionQuestion } from "@flyx/mvp-protocol";
export type InteractionReadiness = {
  online: boolean;
  synced: boolean;
  authoritative: boolean;
  approvalWrite: boolean;
  sourceRevision?: number;
  now?: string;
};
export type QuestionDraft = Record<string, {
  optionIds: string[];
  text: string;
}>;
export function interactionReadiness(value: Interaction, state: InteractionReadiness): {
  ready: boolean;
  reason: string;
} {
  if (!state.online || !state.synced || !state.authoritative)
    return { ready: false, reason: "Reconnect and refresh this request before responding." };
  if (!state.approvalWrite)
    return { ready: false, reason: "This device cannot respond to requests." };
  if (Date.parse(value.expiresAt) <= Date.parse(state.now ?? new Date().toISOString()))
    return { ready: false, reason: "This request has expired." };
  if (value.status !== "pending")
    return { ready: false, reason: interactionStatusLabel(value.status) };
  if (!value.responseAvailable)
    return { ready: false, reason: "This request cannot receive a response in the current runtime." };
  return { ready: true, reason: "" };
}
export function interactionStatusLabel(status: Interaction["status"] | "accepted"): string {
  return {
    pending: "Waiting for a response", accepted: "Response reserved for delivery", responding: "Response reserved for delivery", delivered: "Response delivered locally; native confirmation pending",
    confirmed: "Native response confirmed", expired: "This request has expired", superseded: "This request has been superseded", outcome_unknown: "Response delivery is unconfirmed; refresh to inspect"
  }[status];
}
export function emptyQuestionDraft(value: Extract<Interaction, {
  kind: "question";
}>): QuestionDraft {
  return Object.fromEntries(value.request.questions.map((question) => [question.questionId, { optionIds: [], text: "" }]));
}
export function toggleQuestionOption(question: InteractionQuestion, previous: {
  optionIds: string[];
  text: string;
}, optionId: string): {
  optionIds: string[];
  text: string;
} {
  if (!question.options.some((option) => option.optionId === optionId))
    throw new Error("QUESTION_ANSWER_INVALID");
  const selected = question.multiSelect ? previous.optionIds.includes(optionId) ? previous.optionIds.filter((id) => id !== optionId) : [...previous.optionIds, optionId] : [optionId];
  return { optionIds: question.options.filter((option) => selected.includes(option.optionId)).map((option) => option.optionId), text: "" };
}
export function buildQuestionResponse(value: Extract<Interaction, {
  kind: "question";
}>, draft: QuestionDraft): QuestionRespondRequest {
  const answers = value.request.questions.map((question) => {
    const answer = draft[question.questionId];
    return { questionId: question.questionId, optionIds: answer?.text ? [] : answer?.optionIds ?? [], ...(answer?.text ? { text: answer.text } : {}) };
  });
  return QuestionRespondRequestSchema.parse({ sessionId: value.sessionId, interactionId: value.interactionId, expectedVersion: value.version, answers: validateQuestionAnswers(value.request, answers) });
}
export function buildApprovalResponse(value: Extract<Interaction, {
  kind: "approval";
}>, action: "allow_once" | "deny"): InteractionRespondApprovalRequest {
  if (!value.allowedActions.includes(action))
    throw new Error("INTERACTION_ACTION_INVALID");
  return InteractionRespondApprovalRequestSchema.parse({ sessionId: value.sessionId, interactionId: value.interactionId, expectedVersion: value.version, action });
}
