import { createHash } from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { validateQuestionAnswers, encodedBytes, type QuestionAnswers } from "@flyx/mvp-protocol";
import { parseClaudeQuestions, parseCodexQuestions, serializeQuestionAnswers, nativeAnswerEchoMatches, stableQuestionId, rpcRequestKey, questionContractVerified, type NativeQuestionMap } from "./native-question-codec.js";
import type { InteractionEvidenceSample, NativeQuestionDelivery, NativeQuestionRequest, NativeInteractionEvidence, QuestionContractEvidence } from "./types.js";
export type QuestionRuntime = {
  turnId: string;
  context: {
    runtimeGeneration: number;
    attemptId: string;
  };
};
export type QuestionBridgeEvent = {
  kind: "question_requested";
  request: NativeQuestionRequest;
} | {
  kind: "question_resolved";
  interactionId: string;
  status: "expired" | "superseded" | "confirmed";
  evidence?: NativeInteractionEvidence;
};
export type QuestionBridgeOptions<T extends QuestionRuntime> = {
  provider: "claude" | "codex";
  adapterVersion: string;
  runtimeVersion: () => string;
  contractEvidence?: QuestionContractEvidence;
  verificationMode?: boolean;
  evidenceSource?: "native" | "fixture";
  onEvidence?: (evidence: InteractionEvidenceSample) => void;
  current: () => T | undefined;
  emit: (active: T, event: QuestionBridgeEvent) => void;
  now?: () => string;
};
const MAX_PENDING = 8;
const MAX_PENDING_BYTES = 256 * 1024;
class QuestionBridgeBase<T extends QuestionRuntime> {
  constructor(protected readonly options: QuestionBridgeOptions<T>) { }
  capability(): boolean { return this.options.evidenceSource !== "fixture" && questionContractVerified(this.options.contractEvidence, this.options.provider, this.options.adapterVersion, this.options.runtimeVersion()); }
  canHandle(): boolean { return this.capability() || this.options.verificationMode === true; }
  protected now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  protected current(active: T): boolean { return this.options.current() === active; }
  protected sample(request: NativeQuestionRequest, mapping: NativeQuestionMap, phase: InteractionEvidenceSample["phase"], answers?: QuestionAnswers): void {
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const sample: InteractionEvidenceSample = {
      source: this.options.evidenceSource ?? "native", provider: this.options.provider, method: mapping.method, phase,
      interactionDigest: digest(request.interactionId), nativeRequestDigest: digest(mapping.nativeRequestId), requestDigest: digest(mapping.request),
      ...(answers && !mapping.request.questions.some((question) => question.secret) ? { answerDigest: digest(answers) } : {}), questionCount: mapping.request.questions.length,
      adapterVersion: this.options.adapterVersion, runtimeVersion: this.options.runtimeVersion()
    };
    try {
      this.options.onEvidence?.(sample);
    }
    catch { /* A recorder failure never invents native delivery failure. */ }
  }
}
type ClaudeEntry<T extends QuestionRuntime> = {
  active: T;
  mapping: NativeQuestionMap;
  request: NativeQuestionRequest;
  resolve: (result: PermissionResult) => void;
  cleanup: () => void;
  answers?: QuestionAnswers;
};
export class ClaudeQuestionBridge<T extends QuestionRuntime> extends QuestionBridgeBase<T> {
  private readonly pending = new Map<string, ClaudeEntry<T>>();
  private readonly delivered = new Map<string, ClaudeEntry<T>>();
  request(active: T, nativeRequestId: string, input: unknown, signal: AbortSignal): Promise<PermissionResult> {
    if (signal.aborted || !this.canHandle() || !this.current(active))
      return Promise.resolve({ behavior: "deny", message: "Structured questions are not verified for this runtime" });
    let mapping: NativeQuestionMap;
    try {
      mapping = parseClaudeQuestions(nativeRequestId, input, active.context.attemptId);
    }
    catch {
      return Promise.resolve({ behavior: "deny", message: "Flyx refused an invalid structured question" });
    }
    const interactionId = stableQuestionId("interaction", active.turnId, active.context.runtimeGeneration, nativeRequestId);
    if (this.pending.has(interactionId) || this.delivered.has(interactionId))
      return Promise.resolve({ behavior: "deny", message: "Native question ID was already used" });
    if (this.pending.size + this.delivered.size >= MAX_PENDING || [...this.pending.values(), ...this.delivered.values()].reduce((sum, entry) => sum + encodedBytes(entry.mapping.request), 0) + encodedBytes(mapping.request) > MAX_PENDING_BYTES)
      return Promise.resolve({ behavior: "deny", message: "Structured question queue budget exceeded" });
    const createdAt = this.now();
    const request: NativeQuestionRequest = {
      interactionId, turnId: active.turnId, nativeRequestId, nativeMethod: "canUseTool/AskUserQuestion", request: mapping.request,
      createdAt, expiresAt: new Date(Date.parse(createdAt) + 10 * 60 * 1000).toISOString()
    };
    return new Promise<PermissionResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remove = () => { if (timer)
        clearTimeout(timer); signal.removeEventListener("abort", abort); };
      const cancel = (status: "expired" | "superseded") => {
        if (!this.pending.delete(interactionId))
          return;
        remove();
        this.options.emit(active, { kind: "question_resolved", interactionId, status });
        this.sample(request, mapping, status);
        resolve({ behavior: "deny", message: status === "expired" ? "Flyx question expired" : "Flyx question was superseded" });
      };
      const abort = () => cancel("superseded");
      const entry: ClaudeEntry<T> = { active, mapping, request, resolve, cleanup: remove };
      this.pending.set(interactionId, entry);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => cancel("expired"), Math.max(0, Date.parse(request.expiresAt) - Date.parse(this.now())));
      this.options.emit(active, { kind: "question_requested", request });
      this.sample(request, mapping, "request");
    });
  }
  respond(interactionId: string, value: unknown): NativeQuestionDelivery {
    const entry = this.pending.get(interactionId);
    if (!entry || !this.current(entry.active))
      return { kind: "not-dispatched", reason: "native_request_gone" };
    if (entry.request.expiresAt <= this.now())
      return { kind: "not-dispatched", reason: "request_expired" };
    let answers: QuestionAnswers;
    let updatedInput: Record<string, unknown>;
    try {
      answers = validateQuestionAnswers(entry.mapping.request, value);
      updatedInput = serializeQuestionAnswers(entry.mapping, answers);
    }
    catch {
      return { kind: "not-dispatched", reason: "answer_invalid" };
    }
    this.pending.delete(interactionId);
    entry.cleanup();
    entry.answers = answers;
    this.delivered.set(interactionId, entry);
    // Permission Promise resolution is local delivery. Only a later native
    // tool-result echo with the matching request proves receipt of the answers.
    entry.resolve({ behavior: "allow", updatedInput, updatedPermissions: [], toolUseID: entry.mapping.nativeRequestId });
    this.sample(entry.request, entry.mapping, "local-delivery", answers);
    return { kind: "local-delivery" };
  }
  observeToolResult(active: T, toolUseId: string, sourceId: string, content: unknown): void {
    if (!this.current(active) || !toolUseId || !sourceId)
      return;
    const found = [...this.delivered.entries()].find(([, entry]) => entry.active === active && entry.mapping.nativeRequestId === toolUseId);
    if (!found)
      return;
    const [interactionId, entry] = found;
    let echo: unknown = content;
    try {
      if (typeof content === "string")
        echo = JSON.parse(content) as unknown;
    }
    catch {
      return;
    }
    if (!entry.answers || !nativeAnswerEchoMatches(entry.mapping, entry.answers, echo))
      return;
    this.delivered.delete(interactionId);
    this.options.emit(active, { kind: "question_resolved", interactionId, status: "confirmed", evidence: { kind: "native-ack", nativeRequestId: toolUseId, sourceId } });
    this.sample(entry.request, entry.mapping, "native-confirmation", entry.answers);
  }
  cancelTurn(active: T): void {
    for (const [id, entry] of this.pending) {
      if (entry.active !== active)
        continue;
      this.pending.delete(id);
      entry.cleanup();
      entry.resolve({ behavior: "deny", message: "Flyx question was superseded" });
      this.options.emit(active, { kind: "question_resolved", interactionId: id, status: "superseded" });
    }
    for (const [id, entry] of this.delivered)
      if (entry.active === active)
        this.delivered.delete(id);
  }
}
type CodexRuntime = QuestionRuntime & {
  threadId: string;
  codexTurnId?: string;
};
type CodexEntry<T extends CodexRuntime> = {
  active: T;
  mapping: NativeQuestionMap;
  request: NativeQuestionRequest;
  rpcId: string | number;
  timer: ReturnType<typeof setTimeout>;
  attempted: boolean;
};
export class CodexQuestionBridge<T extends CodexRuntime> extends QuestionBridgeBase<T> {
  private readonly pending = new Map<string, CodexEntry<T>>();
  private readonly delivered = new Map<string, CodexEntry<T>>();
  private readonly byRpc = new Map<string, string>();
  request(active: T, method: string, rpcId: unknown, params: unknown): NativeQuestionRequest {
    if (!this.canHandle() || !this.current(active))
      throw new Error("QUESTION_CONTRACT_UNVERIFIED");
    const parsed = parseCodexQuestions(method, rpcId, params);
    if (parsed.params.threadId !== active.threadId || !active.codexTurnId || parsed.params.turnId !== active.codexTurnId)
      throw new Error("QUESTION_NATIVE_TURN_MISMATCH");
    const interactionId = stableQuestionId("interaction", active.turnId, active.context.runtimeGeneration, parsed.mapping.nativeRequestId);
    const old = this.pending.get(interactionId) ?? this.delivered.get(interactionId);
    if (old) {
      if (JSON.stringify(old.mapping.request) !== JSON.stringify(parsed.mapping.request))
        throw new Error("QUESTION_NATIVE_REQUEST_CHANGED");
      return old.request;
    }
    if (this.pending.size + this.delivered.size >= MAX_PENDING || [...this.pending.values(), ...this.delivered.values()].reduce((sum, entry) => sum + encodedBytes(entry.mapping.request), 0) + encodedBytes(parsed.mapping.request) > MAX_PENDING_BYTES)
      throw new Error("QUESTION_QUEUE_FULL");
    const createdAt = this.now();
    const request: NativeQuestionRequest = {
      interactionId, turnId: active.turnId, nativeRequestId: parsed.mapping.nativeRequestId, nativeMethod: "item/tool/requestUserInput",
      request: parsed.mapping.request, createdAt, expiresAt: new Date(Date.parse(createdAt) + parsed.ttlMs).toISOString()
    };
    const timer = setTimeout(() => {
      const entry = this.pending.get(interactionId);
      if (!entry)
        return;
      this.pending.delete(interactionId);
      this.byRpc.delete(rpcRequestKey(entry.rpcId));
      this.options.emit(active, { kind: "question_resolved", interactionId, status: "expired" });
      this.sample(request, parsed.mapping, "expired");
    }, parsed.ttlMs);
    const entry: CodexEntry<T> = { active, mapping: parsed.mapping, request, rpcId: rpcId as string | number, timer, attempted: false };
    this.pending.set(interactionId, entry);
    this.byRpc.set(rpcRequestKey(rpcId), interactionId);
    this.options.emit(active, { kind: "question_requested", request });
    this.sample(request, parsed.mapping, "request");
    return request;
  }
  respond(interactionId: string, value: unknown, write: (rpcId: string | number, result: Record<string, unknown>) => boolean): NativeQuestionDelivery {
    const entry = this.pending.get(interactionId);
    if (!entry || !this.current(entry.active))
      return { kind: "not-dispatched", reason: "native_request_gone" };
    if (entry.request.expiresAt <= this.now())
      return { kind: "not-dispatched", reason: "request_expired" };
    if (entry.attempted)
      return { kind: "unknown", reason: "delivery_already_attempted" };
    let result: Record<string, unknown>;
    let answers: QuestionAnswers;
    try {
      answers = validateQuestionAnswers(entry.mapping.request, value);
      result = serializeQuestionAnswers(entry.mapping, answers);
    }
    catch {
      return { kind: "not-dispatched", reason: "answer_invalid" };
    }
    // Set the attempt fence before crossing the native transport boundary.
    entry.attempted = true;
    let written = false;
    try {
      written = write(entry.rpcId, result);
    }
    catch {
      return { kind: "unknown", reason: "transport_write_unconfirmed" };
    }
    if (!written)
      return { kind: "unknown", reason: "transport_write_unconfirmed" };
    clearTimeout(entry.timer);
    this.pending.delete(interactionId);
    this.delivered.set(interactionId, entry);
    this.sample(entry.request, entry.mapping, "local-delivery", answers);
    return { kind: "local-delivery" };
  }
  nativeResolved(active: T, rpcId: unknown): boolean {
    let key: string;
    try {
      key = rpcRequestKey(rpcId);
    }
    catch {
      return false;
    }
    const interactionId = this.byRpc.get(key);
    if (!interactionId)
      return false;
    const entry = this.pending.get(interactionId) ?? this.delivered.get(interactionId);
    if (!entry || entry.active !== active)
      return false;
    clearTimeout(entry.timer);
    this.byRpc.delete(key);
    this.pending.delete(interactionId);
    this.delivered.delete(interactionId);
    // serverRequest/resolved has no answer echo. It can expire/cancel a
    // request, so it must never upgrade a locally written answer to confirmed.
    if (!entry.attempted)
      this.options.emit(active, { kind: "question_resolved", interactionId, status: "superseded" });
    return true;
  }
  cancelTurn(active: T): void {
    for (const [id, entry] of [...this.pending, ...this.delivered]) {
      if (entry.active !== active)
        continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.delivered.delete(id);
      this.byRpc.delete(rpcRequestKey(entry.rpcId));
      if (!entry.attempted)
        this.options.emit(active, { kind: "question_resolved", interactionId: id, status: "superseded" });
    }
  }
}
