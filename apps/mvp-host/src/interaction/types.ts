import type { Interaction, QuestionAnswers, QuestionRequest } from "@flyx/mvp-protocol";
import { dispatchContextForTurn, type DispatchContext } from "../provider/types.js";
export type InteractionFence = Readonly<{
  sessionId: string;
  turnId: string;
  attemptId: string;
  runtimeGeneration: number;
  runtimeId: string;
  dispatchContext: DispatchContext;
}>;
export function interactionFence(context: DispatchContext): InteractionFence {
  const frozen = dispatchContextForTurn(context.flyxTurnId, context);
  return Object.freeze({ sessionId: frozen.sessionId, turnId: frozen.flyxTurnId, attemptId: frozen.attemptId, runtimeGeneration: frozen.runtimeGeneration, runtimeId: frozen.runtimeId, dispatchContext: frozen });
}
export type NativeInteractionMethod = "canUseTool/AskUserQuestion" | "item/tool/requestUserInput" | "canUseTool/approval" | "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
export type NativeQuestionRequest = {
  interactionId: string;
  turnId: string;
  nativeRequestId: string;
  nativeMethod: "canUseTool/AskUserQuestion" | "item/tool/requestUserInput";
  request: QuestionRequest;
  createdAt: string;
  expiresAt: string;
};
export type NativeQuestionDelivery = {
  kind: "local-delivery";
} | {
  kind: "not-dispatched";
  reason: string;
} | {
  kind: "unknown";
  reason: string;
};
export type InteractionRow = Interaction & {
  dispatchContext?: DispatchContext;
  attemptId?: string;
  runtimeGeneration?: number;
  runtimeId?: string;
  nativeRequestId?: string;
  nativeMethod?: NativeInteractionMethod;
  legacyApprovalId?: string;
  updatedAt: string;
};
export type InteractionReservationRow = {
  interactionId: string;
  authSubjectId: string;
  commandId: string;
  intentId: string;
  expectedVersion: number;
  answer: {
    action: "allow_once" | "deny";
  } | {
    answers: QuestionAnswers;
  };
  createdAt: string;
  updatedAt: string;
};
export type NativeInteractionEvidence = {
  kind: "local-delivery";
} | {
  kind: "native-ack";
  sourceId: string;
  nativeRequestId: string;
} | {
  kind: "not-dispatched";
  reason: string;
} | {
  kind: "unknown";
  reason: string;
};
export type InteractionEvidenceSample = {
  source: "native" | "fixture";
  provider: "claude" | "codex";
  method: NativeInteractionMethod;
  phase: "request" | "local-delivery" | "native-confirmation" | "expired" | "superseded";
  interactionDigest: string;
  nativeRequestDigest: string;
  requestDigest: string;
  answerDigest?: string;
  questionCount: number;
  adapterVersion: string;
  runtimeVersion: string;
};
export type QuestionContractEvidence = {
  source: "real-provider" | "fixture";
  provider: "claude" | "codex";
  method: "canUseTool/AskUserQuestion" | "item/tool/requestUserInput";
  phase: "native-answer-confirmed";
  evidenceId: string;
  adapterVersion: string;
  runtimeVersion: string;
};
