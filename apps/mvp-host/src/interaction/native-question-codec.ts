import { createHash } from "node:crypto";
import { z } from "zod";
import { QuestionRequestSchema, validateQuestionAnswers, encodedBytes, INTERACTION_MAX_REQUEST_BYTES, type QuestionAnswers, type QuestionRequest } from "@flyx/mvp-protocol";
import type { NativeInteractionMethod, QuestionContractEvidence } from "./types.js";
const short = z.string().min(1).max(256);
const option = z.object({ label: z.string().min(1).max(128), description: z.string().max(512) }).strict();
const claudeOption = option.extend({ preview: z.string().max(2048).optional() }).strict();
const claudeQuestion = z.object({ question: z.string().min(1).max(2048), header: z.string().min(1).max(12), options: z.array(claudeOption).min(2).max(4), multiSelect: z.boolean() }).strict();
const claudeInput = z.object({
  questions: z.array(claudeQuestion).min(1).max(4), answers: z.record(z.string(), z.string().max(2048)).optional(),
  annotations: z.record(z.string(), z.object({ preview: z.string().max(2048).optional(), notes: z.string().max(2048).optional() }).strict()).optional()
}).strict();
const codexQuestion = z.object({
  id: short, header: z.string().min(1).max(64), question: z.string().min(1).max(2048),
  isOther: z.boolean().optional(), isSecret: z.boolean().optional(), options: z.array(option).max(8).nullable().optional()
}).strict();
export const CodexQuestionParamsSchema = z.object({
  threadId: short, turnId: short, itemId: short, questions: z.array(codexQuestion).min(1).max(4),
  isBlocking: z.boolean().optional(), autoResolutionMs: z.number().int().nonnegative().nullable().optional()
}).strict();
export type NativeQuestionMap = {
  method: "canUseTool/AskUserQuestion" | "item/tool/requestUserInput";
  nativeRequestId: string;
  request: QuestionRequest;
  questions: Array<{
    questionId: string;
    nativeKey: string;
    options: Array<{
      optionId: string;
      label: string;
    }>;
  }>;
  claudeQuestions?: z.infer<typeof claudeInput>["questions"];
};
export function stableQuestionId(namespace: string, ...parts: Array<string | number>): string {
  return `${namespace}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}
export function rpcRequestKey(id: unknown): string {
  if (typeof id === "string" && id.length > 0 && id.length <= 256)
    return `string:${id}`;
  if (typeof id === "number" && Number.isSafeInteger(id))
    return `number:${id}`;
  throw new Error("QUESTION_NATIVE_REQUEST_ID_INVALID");
}
function nativeBudget(value: unknown): void { if (encodedBytes(value) > INTERACTION_MAX_REQUEST_BYTES)
  throw new Error("QUESTION_NATIVE_REQUEST_TOO_LARGE"); }
function unique(values: string[]): void { if (new Set(values).size !== values.length)
  throw new Error("QUESTION_NATIVE_KEYS_AMBIGUOUS"); }
/** Locked SDK 0.3.220 sdk-tools.d.ts: answers are keyed by full question text. */
export function parseClaudeQuestions(nativeRequestId: string, input: unknown, scope = nativeRequestId): NativeQuestionMap {
  short.parse(nativeRequestId);
  nativeBudget(input);
  const parsed = claudeInput.parse(input);
  if (parsed.answers && Object.values(parsed.answers).some((answer) => answer.length))
    throw new Error("QUESTION_NATIVE_PREANSWERED");
  unique(parsed.questions.map((question) => question.question));
  const mappings = parsed.questions.map((question, index) => {
    unique(question.options.map((choice) => choice.label));
    if (question.multiSelect && question.options.some((choice) => choice.label.includes(",")))
      throw new Error("QUESTION_NATIVE_KEYS_AMBIGUOUS");
    const questionId = stableQuestionId("q", scope, nativeRequestId, index);
    const choices = question.options.map((choice, ordinal) => ({ ...choice, optionId: stableQuestionId("o", scope, nativeRequestId, index, ordinal) }));
    return {
      public: { questionId, header: question.header, question: question.question, options: choices, multiSelect: question.multiSelect, allowFreeText: true, secret: false },
      private: { questionId, nativeKey: question.question, options: choices.map((choice) => ({ optionId: choice.optionId, label: choice.label })) }
    };
  });
  return {
    method: "canUseTool/AskUserQuestion", nativeRequestId, request: QuestionRequestSchema.parse({ blocking: true, questions: mappings.map((mapping) => mapping.public) }),
    questions: mappings.map((mapping) => mapping.private), claudeQuestions: parsed.questions
  };
}
/** Only the exact documented app-server method and known params shape are accepted. */
export function parseCodexQuestions(method: string, rpcId: unknown, params: unknown): {
  mapping: NativeQuestionMap;
  params: z.infer<typeof CodexQuestionParamsSchema>;
  ttlMs: number;
} {
  if (method !== "item/tool/requestUserInput")
    throw new Error("QUESTION_NATIVE_METHOD_UNSUPPORTED");
  const nativeRequestId = `codex-rpc:${rpcRequestKey(rpcId)}`;
  nativeBudget(params);
  const parsed = CodexQuestionParamsSchema.parse(params);
  unique(parsed.questions.map((question) => question.id));
  const mappings = parsed.questions.map((question, index) => {
    const options = question.options ?? [];
    unique(options.map((choice) => choice.label));
    const questionId = stableQuestionId("q", parsed.threadId, parsed.turnId, parsed.itemId, nativeRequestId, question.id, index);
    const choices = options.map((choice, ordinal) => ({ ...choice, optionId: stableQuestionId("o", parsed.threadId, parsed.turnId, parsed.itemId, nativeRequestId, question.id, index, ordinal) }));
    return {
      public: { questionId, header: question.header, question: question.question, options: choices, multiSelect: false, allowFreeText: question.isOther === true || choices.length === 0, secret: question.isSecret === true },
      private: { questionId, nativeKey: question.id, options: choices.map((choice) => ({ optionId: choice.optionId, label: choice.label })) }
    };
  });
  return {
    mapping: {
      method: "item/tool/requestUserInput", nativeRequestId, request: QuestionRequestSchema.parse({ blocking: parsed.isBlocking ?? true, questions: mappings.map((mapping) => mapping.public) }),
      questions: mappings.map((mapping) => mapping.private)
    }, params: parsed, ttlMs: Math.min(10 * 60 * 1000, parsed.autoResolutionMs ?? 10 * 60 * 1000)
  };
}
export function serializeQuestionAnswers(mapping: NativeQuestionMap, value: unknown): Record<string, unknown> {
  const answers = validateQuestionAnswers(mapping.request, value);
  const native = mapping.questions.map((question) => {
    const answer = answers.find((candidate) => candidate.questionId === question.questionId)!;
    const labels = answer.optionIds.map((optionId) => question.options.find((choice) => choice.optionId === optionId)!.label);
    return [question.nativeKey, answer.text !== undefined ? [answer.text] : labels] as const;
  });
  return mapping.method === "canUseTool/AskUserQuestion"
    ? { questions: mapping.claudeQuestions!, answers: Object.fromEntries(native.map(([key, values]) => [key, values.join(", ")])) }
    : { answers: Object.fromEntries(native.map(([key, values]) => [key, { answers: values }])) };
}
export function nativeAnswerEchoMatches(mapping: NativeQuestionMap, answers: QuestionAnswers, echo: unknown): boolean {
  if (!isRecord(echo) || !isRecord(echo.answers))
    return false;
  const actual = echo.answers;
  const expected = serializeQuestionAnswers(mapping, answers).answers;
  if (!isRecord(expected) || Object.keys(expected).length !== Object.keys(actual).length)
    return false;
  return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && JSON.stringify(actual[key]) === JSON.stringify(value));
}
export function questionContractVerified(evidence: QuestionContractEvidence | undefined, provider: "claude" | "codex", adapterVersion: string, runtimeVersion: string): boolean {
  return !!evidence && evidence.source === "real-provider" && evidence.phase === "native-answer-confirmed" && evidence.provider === provider
    && evidence.method === (provider === "claude" ? "canUseTool/AskUserQuestion" : "item/tool/requestUserInput") && !!evidence.evidenceId
    && !["", "unverified", "unknown", "unavailable"].includes(adapterVersion) && !["", "unverified", "unknown", "unavailable"].includes(runtimeVersion) && evidence.adapterVersion === adapterVersion && evidence.runtimeVersion === runtimeVersion;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
