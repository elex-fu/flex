import { afterEach, describe, expect, it, vi } from "vitest";
import { encodedBytes, QuestionRequestSchema, validateQuestionAnswers } from "@flyx/mvp-protocol";
import { parseClaudeQuestions, parseCodexQuestions, serializeQuestionAnswers, nativeAnswerEchoMatches, questionContractVerified, rpcRequestKey } from "./native-question-codec.js";
import { ClaudeQuestionBridge, CodexQuestionBridge, type QuestionBridgeEvent } from "./native-question-bridge.js";
import type { InteractionEvidenceSample, QuestionContractEvidence } from "./types.js";
const claude = { questions: [{ header: "Scope", question: "Choose scope", multiSelect: true, options: [{ label: "One", description: "First", preview: "<script>alert(1)</script>" }, { label: "Two", description: "Second" }] }] };
const codex = { threadId: "thread", turnId: "native-turn", itemId: "item", questions: [{ id: "native-question", header: "Scope", question: "Choose scope", isOther: true, options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }] };
function answer(mapping: ReturnType<typeof parseClaudeQuestions>, options = 1) { return [{ questionId: mapping.request.questions[0]!.questionId, optionIds: mapping.request.questions[0]!.options.slice(0, options).map((option) => option.optionId) }]; }
const active = { turnId: "turn", context: { runtimeGeneration: 3, attemptId: "attempt" }, threadId: "thread", codexTurnId: "native-turn" };
afterEach(() => vi.useRealTimers());
describe("strict native structured-question codecs", () => {
  it("maps stable Host IDs back to exact locked SDK question text and labels", () => {
    const map = parseClaudeQuestions("tool", claude, "attempt");
    expect(parseClaudeQuestions("tool", claude, "attempt")).toEqual(map);
    expect(parseClaudeQuestions("tool", claude, "other-attempt").request.questions[0]!.questionId).not.toBe(map.request.questions[0]!.questionId);
    expect(serializeQuestionAnswers(map, answer(map, 2))).toEqual({ questions: claude.questions, answers: { "Choose scope": "One, Two" } });
    expect(serializeQuestionAnswers(map, [{ questionId: map.request.questions[0]!.questionId, optionIds: [], text: "Custom" }])).toMatchObject({ answers: { "Choose scope": "Custom" } });
    expect(nativeAnswerEchoMatches(map, answer(map, 2), { answers: { "Choose scope": "One, Two" } })).toBe(true);
    expect(nativeAnswerEchoMatches(map, answer(map), { answers: { "Choose scope": "wrong" } })).toBe(false);
  });
  it("accepts only the exact Codex method, uses typed RPC IDs, and retains native question keys privately", () => {
    const { mapping } = parseCodexQuestions("item/tool/requestUserInput", 1, codex);
    expect(serializeQuestionAnswers(mapping, answer(mapping))).toEqual({ answers: { "native-question": { answers: ["One"] } } });
    expect(rpcRequestKey(1)).not.toBe(rpcRequestKey("1"));
    expect(parseCodexQuestions("item/tool/requestUserInput", 1, { ...codex, turnId: "other-turn" }).mapping.request.questions[0]!.questionId).not.toBe(mapping.request.questions[0]!.questionId);
    expect(() => parseCodexQuestions("tool/requestUserInput", 1, codex)).toThrow("QUESTION_NATIVE_METHOD_UNSUPPORTED");
    expect(() => parseCodexQuestions("item/tool/requestUserInput", null, codex)).toThrow("QUESTION_NATIVE_REQUEST_ID_INVALID");
    expect(() => parseCodexQuestions("item/tool/requestUserInput", 1, { ...codex, unknown: true })).toThrow();
  });
  it("rejects duplicate keys, pre-filled answers, ambiguous labels and client labels masquerading as IDs", () => {
    expect(() => parseClaudeQuestions("tool", { ...claude, questions: [...claude.questions, ...claude.questions] })).toThrow("QUESTION_NATIVE_KEYS_AMBIGUOUS");
    expect(() => parseClaudeQuestions("tool", { ...claude, answers: { "Choose scope": "One" } })).toThrow("QUESTION_NATIVE_PREANSWERED");
    expect(() => parseClaudeQuestions("tool", { questions: [{ ...claude.questions[0], options: [{ label: "One, Two", description: "" }, { label: "Three", description: "" }] }] })).toThrow("QUESTION_NATIVE_KEYS_AMBIGUOUS");
    const map = parseClaudeQuestions("tool", claude);
    expect(() => serializeQuestionAnswers(map, [{ questionId: map.request.questions[0]!.questionId, optionIds: ["One"] }])).toThrow("QUESTION_ANSWER_INVALID");
    expect(() => parseCodexQuestions("item/tool/requestUserInput", 1, { ...codex, questions: [...codex.questions, ...codex.questions] })).toThrow("QUESTION_NATIVE_KEYS_AMBIGUOUS");
  });
  it("enforces per-question and total UTF-8 request and answer bounds", () => {
    const { mapping } = parseCodexQuestions("item/tool/requestUserInput", 1, codex);
    const q = mapping.request.questions[0]!;
    expect(() => validateQuestionAnswers(mapping.request, [{ questionId: q.questionId, optionIds: [], text: "x".repeat(2049) }])).toThrow();
    expect(() => validateQuestionAnswers(mapping.request, [{ questionId: q.questionId, optionIds: q.options.map((choice) => choice.optionId) }])).toThrow("QUESTION_ANSWER_INVALID");
    expect(() => validateQuestionAnswers(mapping.request, [{ questionId: q.questionId, optionIds: [q.options[0]!.optionId], text: "Both" }])).toThrow();
    const large = { blocking: true, questions: Array.from({ length: 4 }, (_, index) => ({ ...q, questionId: `q-${index}`, question: "界".repeat(2048), options: Array.from({ length: 8 }, (_, ordinal) => ({ optionId: `o-${ordinal}`, label: "界".repeat(128), description: "界".repeat(512) })) })) };
    expect(encodedBytes(large)).toBeGreaterThan(32 * 1024);
    expect(QuestionRequestSchema.safeParse(large).success).toBe(false);
    const four = { blocking: true, questions: Array.from({ length: 4 }, (_, index) => ({ ...q, questionId: `q-${index}` })) };
    expect(() => validateQuestionAnswers(four, four.questions.map((question) => ({ questionId: question.questionId, optionIds: [], text: "界".repeat(2048) })))).toThrow();
  });
  it("serializes prototype-looking native keys as own data without prototype mutation", () => {
    const map = parseCodexQuestions("item/tool/requestUserInput", 1, { ...codex, questions: [{ ...codex.questions[0], id: "__proto__" }] }).mapping;
    const result = serializeQuestionAnswers(map, answer(map));
    expect(Object.hasOwn(result.answers as object, "__proto__")).toBe(true);
    expect(nativeAnswerEchoMatches(map, answer(map), result)).toBe(true);
  });
  it("requires actual source evidence for the exact Adapter/runtime version", () => {
    const evidence: QuestionContractEvidence = { source: "real-provider", provider: "codex", method: "item/tool/requestUserInput", phase: "native-answer-confirmed", evidenceId: "native-evidence", adapterVersion: "adapter", runtimeVersion: "runtime" };
    expect(questionContractVerified(evidence, "codex", "adapter", "runtime")).toBe(true);
    for (const change of [{ source: "fixture" as const }, { runtimeVersion: "old" }, { evidenceId: "" }])
      expect(questionContractVerified({ ...evidence, ...change }, "codex", "adapter", "runtime")).toBe(false);
    for (const version of ["", "unknown", "unavailable", "unverified"])
      expect(questionContractVerified({ ...evidence, runtimeVersion: version }, "codex", "adapter", version)).toBe(false);
  });
});
describe("native question delivery bridge", () => {
  it("resolves Claude updatedInput locally and confirms only a matching native answer echo", async () => {
    const events: QuestionBridgeEvent[] = [];
    const samples: InteractionEvidenceSample[] = [];
    const bridge = new ClaudeQuestionBridge({ provider: "claude", adapterVersion: "sdk", runtimeVersion: () => "runtime", current: () => active, emit: (_, event) => events.push(event), verificationMode: true, evidenceSource: "fixture", onEvidence: (sample) => samples.push(sample) });
    const response = bridge.request(active, "tool", claude, new AbortController().signal);
    const request = (events[0] as Extract<QuestionBridgeEvent, {
      kind: "question_requested";
    }>).request;
    expect(bridge.capability()).toBe(false);
    const answers = [{ questionId: request.request.questions[0]!.questionId, optionIds: [request.request.questions[0]!.options[1]!.optionId] }];
    expect(bridge.respond(request.interactionId, answers)).toEqual({ kind: "local-delivery" });
    expect(await response).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Choose scope": "Two" } } });
    bridge.observeToolResult(active, "tool", "source", "no echoed answers");
    expect(events).toHaveLength(1);
    bridge.observeToolResult(active, "tool", "source", JSON.stringify({ answers: { "Choose scope": "Two" } }));
    expect(events[1]).toMatchObject({ kind: "question_resolved", status: "confirmed", evidence: { kind: "native-ack", sourceId: "source" } });
    expect(samples.map((sample) => sample.phase)).toEqual(["request", "local-delivery", "native-confirmation"]);
    expect(JSON.stringify(samples)).not.toContain("Choose scope");
    expect(samples.every((sample) => sample.source === "fixture")).toBe(true);
  });
  it("fails closed by default, on missing IDs, stale contexts and native Turn mismatch", async () => {
    const emit = vi.fn();
    const bridge = new ClaudeQuestionBridge({ provider: "claude", adapterVersion: "sdk", runtimeVersion: () => "runtime", current: () => active, emit });
    await expect(bridge.request(active, "tool", claude, new AbortController().signal)).resolves.toMatchObject({ behavior: "deny" });
    expect(emit).not.toHaveBeenCalled();
    const codexBridge = new CodexQuestionBridge({ provider: "codex", adapterVersion: "adapter", runtimeVersion: () => "runtime", current: () => active, emit, verificationMode: true });
    expect(() => codexBridge.request(active, "item/tool/requestUserInput", 1, { ...codex, turnId: "wrong" })).toThrow("QUESTION_NATIVE_TURN_MISMATCH");
    expect(() => codexBridge.request(active, "item/tool/requestUserInput", undefined, codex)).toThrow("QUESTION_NATIVE_REQUEST_ID_INVALID");
  });
  it("never retries a possible Codex partial write or treats serverRequest/resolved as native answer confirmation", () => {
    const events: QuestionBridgeEvent[] = [];
    const bridge = new CodexQuestionBridge({ provider: "codex", adapterVersion: "adapter", runtimeVersion: () => "runtime", current: () => active, emit: (_, event) => events.push(event), verificationMode: true });
    const request = bridge.request(active, "item/tool/requestUserInput", 1, codex);
    const answers = [{ questionId: request.request.questions[0]!.questionId, optionIds: [request.request.questions[0]!.options[0]!.optionId] }];
    const write = vi.fn(() => false);
    expect(bridge.respond(request.interactionId, answers, write).kind).toBe("unknown");
    expect(bridge.respond(request.interactionId, answers, write).kind).toBe("unknown");
    expect(write).toHaveBeenCalledOnce();
    expect(bridge.nativeResolved(active, 1)).toBe(true);
    expect(events).toHaveLength(1);
    const second = bridge.request(active, "item/tool/requestUserInput", "1", codex);
    const next = [{ questionId: second.request.questions[0]!.questionId, optionIds: [second.request.questions[0]!.options[0]!.optionId] }];
    expect(bridge.respond(second.interactionId, next, () => true).kind).toBe("local-delivery");
    bridge.nativeResolved(active, "1");
    expect(events).toHaveLength(2);
    bridge.cancelTurn(active);
  });
  it("expires and supersedes native requests without fabricating an answer", async () => {
    vi.useFakeTimers();
    const events: QuestionBridgeEvent[] = [];
    const abort = new AbortController();
    const bridge = new ClaudeQuestionBridge({ provider: "claude", adapterVersion: "sdk", runtimeVersion: () => "runtime", current: () => active, emit: (_, event) => events.push(event), verificationMode: true });
    const response = bridge.request(active, "tool", claude, abort.signal);
    abort.abort();
    expect(await response).toMatchObject({ behavior: "deny" });
    expect(events.at(-1)).toMatchObject({ status: "superseded" });
    const codexBridge = new CodexQuestionBridge({ provider: "codex", adapterVersion: "adapter", runtimeVersion: () => "runtime", current: () => active, emit: (_, event) => events.push(event), verificationMode: true });
    const request = codexBridge.request(active, "item/tool/requestUserInput", 1, { ...codex, autoResolutionMs: 1 });
    vi.advanceTimersByTime(2);
    expect(events.at(-1)).toMatchObject({ status: "expired" });
    expect(codexBridge.respond(request.interactionId, [], () => true).kind).toBe("not-dispatched");
  });
  it("does not put secret answer digests in recorder hooks", () => {
    const samples: InteractionEvidenceSample[] = [];
    const bridge = new CodexQuestionBridge({ provider: "codex", adapterVersion: "adapter", runtimeVersion: () => "runtime", current: () => active, emit: () => { }, verificationMode: true, onEvidence: (sample) => samples.push(sample) });
    const request = bridge.request(active, "item/tool/requestUserInput", 1, { ...codex, questions: [{ ...codex.questions[0], isSecret: true, options: null }] });
    bridge.respond(request.interactionId, [{ questionId: request.request.questions[0]!.questionId, optionIds: [], text: "private secret" }], () => true);
    expect(samples.at(-1)?.answerDigest).toBeUndefined();
    expect(JSON.stringify(samples)).not.toContain("private secret");
    bridge.cancelTurn(active);
  });
});
