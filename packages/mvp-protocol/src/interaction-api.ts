import { z } from "zod";
/** Typed directory and approval responses; only offered by an activated Host interaction service. */
export const INTERACTION_CAPABILITY = "typed-interactions-v1";
/** Additional native structured question response contract; fixtures never enable advertisement. */
export const STRUCTURED_QUESTION_CAPABILITY = "structured-question-v1";
export const INTERACTION_MAX_REQUEST_BYTES = 32 * 1024;
export const INTERACTION_MAX_ANSWER_BYTES = 16 * 1024;
export const INTERACTION_MAX_QUESTIONS = 4;
export const INTERACTION_MAX_OPTIONS = 8;
export const INTERACTION_MAX_ANSWER_CHARS = 2048;
const id = z.string().min(1).max(256);
const text = (maximum: number) => z.string().min(1).max(maximum);
export const InteractionStatusSchema = z.enum(["pending", "responding", "delivered", "confirmed", "expired", "superseded", "outcome_unknown"]);
export type InteractionStatus = z.infer<typeof InteractionStatusSchema>;
export const InteractionDeliveryStateSchema = z.enum(["none", "accepted", "local_delivery", "native_confirmation", "unconfirmed", "legacy"]);
export type InteractionDeliveryState = z.infer<typeof InteractionDeliveryStateSchema>;
export const QuestionOptionSchema = z.object({ optionId: id, label: text(128), description: z.string().max(512), preview: z.string().max(2048).optional() }).strict();
export const InteractionQuestionSchema = z.object({
  questionId: id, header: text(64), question: text(2048),
  options: z.array(QuestionOptionSchema).max(INTERACTION_MAX_OPTIONS),
  multiSelect: z.boolean(), allowFreeText: z.boolean(), secret: z.boolean().default(false),
}).strict().superRefine((question, context) => {
  if (!question.allowFreeText && question.options.length === 0)
    context.addIssue({ code: "custom", message: "Question has no permitted answer" });
  if (new Set(question.options.map((option) => option.optionId)).size !== question.options.length)
    context.addIssue({ code: "custom", message: "Duplicate option IDs" });
});
export const QuestionRequestSchema = z.object({ blocking: z.boolean().default(true), questions: z.array(InteractionQuestionSchema).min(1).max(INTERACTION_MAX_QUESTIONS) }).strict()
  .superRefine((request, context) => {
  if (new Set(request.questions.map((question) => question.questionId)).size !== request.questions.length)
    context.addIssue({ code: "custom", message: "Duplicate question IDs" });
  if (encodedBytes(request) > INTERACTION_MAX_REQUEST_BYTES)
    context.addIssue({ code: "custom", message: "Question request exceeds encoded budget" });
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;
export type InteractionQuestion = z.infer<typeof InteractionQuestionSchema>;
export const ApprovalInteractionRequestSchema = z.object({
  toolName: text(128), title: z.string().max(512).optional(), reason: z.string().max(2048).optional(),
  commandPreview: z.string().max(4096).optional(), filePreviews: z.array(z.string().max(1024)).max(32).optional(),
}).strict().refine((request) => encodedBytes(request) <= INTERACTION_MAX_REQUEST_BYTES, "Approval request exceeds encoded budget");
const common = z.object({
  interactionId: id, sessionId: id, turnId: id, version: z.number().int().nonnegative(),
  status: InteractionStatusSchema, deliveryState: InteractionDeliveryStateSchema,
  evidenceKind: z.enum(["native_request", "local_delivery", "native_confirmation", "legacy", "unknown"]),
  createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  responseAvailable: z.boolean(), reasonCode: z.string().max(128).optional(),
});
export const InteractionSchema = z.discriminatedUnion("kind", [
  common.extend({ kind: z.literal("approval"), request: ApprovalInteractionRequestSchema, allowedActions: z.array(z.enum(["allow_once", "deny"])).min(1).max(2) }).strict(),
  common.extend({ kind: z.literal("question"), request: QuestionRequestSchema, allowedActions: z.tuple([z.literal("answer")]) }).strict(),
]);
export type Interaction = z.infer<typeof InteractionSchema>;
export const QuestionAnswerSchema = z.object({
  questionId: id, optionIds: z.array(id).max(INTERACTION_MAX_OPTIONS), text: text(INTERACTION_MAX_ANSWER_CHARS).optional(),
}).strict().superRefine((answer, context) => {
  if (new Set(answer.optionIds).size !== answer.optionIds.length)
    context.addIssue({ code: "custom", message: "Duplicate selected options" });
  if ((answer.optionIds.length === 0) === (answer.text === undefined))
    context.addIssue({ code: "custom", message: "Choose options or supply one free-text answer" });
});
export const QuestionAnswersSchema = z.array(QuestionAnswerSchema).min(1).max(INTERACTION_MAX_QUESTIONS)
  .refine((answers) => encodedBytes(answers) <= INTERACTION_MAX_ANSWER_BYTES, "Answers exceed encoded budget");
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type QuestionAnswers = z.infer<typeof QuestionAnswersSchema>;
export const InteractionGetRequestSchema = z.object({ sessionId: id, interactionId: id }).strict();
export const InteractionListResponseSchema = z.object({ interactions: z.array(InteractionSchema).max(50), hasMore: z.boolean(), nextAfterInteractionId: id.optional() }).strict();
export const InteractionListRequestSchema = z.object({ sessionId: id, afterInteractionId: id.optional() }).strict();
export const InteractionRespondApprovalRequestSchema = z.object({
  sessionId: id, interactionId: id,
  expectedVersion: z.number().int().nonnegative(), action: z.enum(["allow_once", "deny"])
}).strict();
export const QuestionRespondRequestSchema = z.object({
  sessionId: id, interactionId: id,
  expectedVersion: z.number().int().nonnegative(), answers: QuestionAnswersSchema
}).strict();
export const InteractionResponseSchema = z.object({
  interactionId: id, version: z.number().int().nonnegative(),
  status: z.enum(["accepted", "delivered", "confirmed", "expired", "superseded", "outcome_unknown"]),
  deliveryState: InteractionDeliveryStateSchema
}).strict();
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;
export type InteractionRespondApprovalRequest = z.infer<typeof InteractionRespondApprovalRequestSchema>;
export type QuestionRespondRequest = z.infer<typeof QuestionRespondRequestSchema>;
/** Shared Host and UI validation. Native option labels are never accepted as IDs. */
export function validateQuestionAnswers(request: QuestionRequest, value: unknown): QuestionAnswers {
  const answers = QuestionAnswersSchema.parse(value);
  if (answers.length !== request.questions.length || new Set(answers.map((answer) => answer.questionId)).size !== answers.length)
    throw new Error("QUESTION_ANSWER_SET_INVALID");
  for (const question of request.questions) {
    const answer = answers.find((candidate) => candidate.questionId === question.questionId);
    if (!answer)
      throw new Error("QUESTION_ANSWER_SET_INVALID");
    if ((!question.multiSelect && answer.optionIds.length > 1)
      || answer.optionIds.some((optionId) => !question.options.some((option) => option.optionId === optionId))
      || (answer.text !== undefined && (!question.allowFreeText || !answer.text.trim())))
      throw new Error("QUESTION_ANSWER_INVALID");
  }
  return answers;
}
export function encodedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
