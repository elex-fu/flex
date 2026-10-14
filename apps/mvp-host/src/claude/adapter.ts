import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve as resolvePath, isAbsolute, basename, relative } from "node:path";
import { readFileSync } from "node:fs";
import {
  query,
  type CanUseTool,
  type HookInput,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SpawnOptions as SdkSpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  AdapterEventHandler,
  AdapterEventPayload,
  DispatchContext,
  AdapterStatus,
  ApprovalAction,
  ApprovalRequest,
  ProviderAdapter,
  TurnOutcome,
  ProviderControlOutcome,
  ProviderEvidence,
} from "./types.js";
import { ManagedRuntimeController, inspectNativeVersion, type ManagedRuntimeOptions, type PreparedNativeRuntime } from "../provider/managed-runtime.js";
import type { ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import { sameDispatchContext } from "../provider/runtime-registry.js";
import { dispatchContextForTurn, fenceAdapterEvent } from "./types.js";

import { ClaudeQuestionBridge } from "../interaction/native-question-bridge.js";
import { parseClaudeQuestions } from "../interaction/native-question-codec.js";
import type { InteractionEvidenceSample, NativeQuestionDelivery, QuestionContractEvidence } from "../interaction/types.js";
import type { QuestionAnswers } from "@flyx/mvp-protocol";

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
const SDK_PACKAGE = readPackageMetadata(sdkEntry);
const SDK_VERSION = SDK_PACKAGE.version;
const BUNDLED_CLAUDE_VERSION = SDK_PACKAGE.claudeCodeVersion;
const SAFE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "AskUserQuestion"] as const;
const MAX_APPROVAL_INPUT_BYTES = 128 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const MAX_ASSISTANT_MESSAGE_BYTES = 1024 * 1024;
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const INTERRUPT_CONFIRM_TIMEOUT_MS = 5_000;

type PendingApproval = {
  request: ApprovalRequest;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type ActiveQuery = {
  turnId: string;
  context: DispatchContext;
  query: Query;
  runtime: PreparedNativeRuntime;
  possibleDispatch: boolean;
  nativeTerminal?: ProviderEvidence | undefined;
  providerSessionId?: string;
  pending: Map<string, PendingApproval>;
  interruptRequested: boolean;
  interruptAcknowledged: boolean;
  interruptTimedOut: boolean;
  resultSeen: boolean;
  assistantItemId?: string;
  assistantText: Map<string, string>;
  assistantTruncated: Set<string>;
  toolItems: Map<string, string>;
  toolInputJson: Map<string, string>;
  sessionIdChanged: boolean;
  timer?: NodeJS.Timeout;
  interruptTimer?: NodeJS.Timeout;
};

export type ClaudeAdapterOptions = ManagedRuntimeOptions & {
  workspace: string;
  onEvent?: AdapterEventHandler;
  maxBudgetUsd?: number;
  questionContractEvidence?: QuestionContractEvidence;
  questionVerificationMode?: boolean;
  interactionEvidenceSource?: "native" | "fixture";
  onInteractionEvidence?: (evidence: InteractionEvidenceSample) => void;
  queryFactory?: typeof query;
  executable?: string;
  model?: string;
  environment?: Readonly<Record<string, string>>;
};

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly workspace: string;
  private readonly onEvent: AdapterEventHandler | undefined;
  private readonly maxBudgetUsd: number;
  private readonly workspaceRealpathPromise: Promise<string>;
  private active: ActiveQuery | undefined;
  private readonly questionBridge: ClaudeQuestionBridge<ActiveQuery>;
  private questionRuntimeVersion: string;
  private lastNativeTerminal: { context: DispatchContext; evidence: Extract<ProviderEvidence, { kind: "native-terminal" }> } | undefined;
  private readonly runtimes: ManagedRuntimeController;
  private readonly runtimeOptions: ManagedRuntimeOptions;
  private readonly queryFactory: typeof query;
  private readonly executableOverride: string | undefined;
  private readonly model: string | undefined;
  private readonly environment: Readonly<Record<string, string>> | undefined;
  private readonly probes = new Set<ClaudeAdapter>();
  private closing = false;
  private callbacksSealed = false;
  private closePromise: Promise<ProcessStopResult> | undefined;

  constructor(options: ClaudeAdapterOptions) {
    this.workspace = options.workspace;
    this.onEvent = options.onEvent;
    this.maxBudgetUsd = options.maxBudgetUsd ?? 5;
    this.questionRuntimeVersion = process.env.FLYX_CLAUDE_EXECUTABLE ? "unverified" : BUNDLED_CLAUDE_VERSION;
    this.questionBridge = new ClaudeQuestionBridge<ActiveQuery>({provider:"claude",adapterVersion:SDK_VERSION,runtimeVersion:()=>this.questionRuntimeVersion,
      current:()=>this.active,emit:(active,event)=>this.emit(active,event),
      ...(options.questionContractEvidence ? {contractEvidence:options.questionContractEvidence} : {}),
      ...(options.questionVerificationMode !== undefined ? {verificationMode:options.questionVerificationMode} : {}),
      ...(options.interactionEvidenceSource ? {evidenceSource:options.interactionEvidenceSource} : {}),
      ...(options.onInteractionEvidence ? {onEvidence:options.onInteractionEvidence} : {}),
    });
    this.workspaceRealpathPromise = realpath(options.workspace);
    this.runtimeOptions = options;
    this.runtimes = new ManagedRuntimeController(options);
    this.queryFactory = options.queryFactory ?? query;
    this.executableOverride = options.executable ?? process.env.FLYX_CLAUDE_EXECUTABLE;
    this.model = options.model; this.environment = options.environment ? Object.freeze({ ...options.environment }) : undefined;
    restrictedEnvironment(this.environment);
  }

  async status(): Promise<AdapterStatus> {
    const workspace = await this.workspaceRealpathPromise;
    await stat(workspace);
    const pathOverride = this.executableOverride;
    const executable = pathOverride ?? "sdk-bundled";
    let runtimeVersion = BUNDLED_CLAUDE_VERSION;
    let executableInspected = !pathOverride;
    if (pathOverride) {
      try {
        const runtime = await this.runtimes.prepare(this.runtimes.inspectionContext());
        runtimeVersion = await inspectNativeVersion(runtime, pathOverride, this.workspace, restrictedEnvironment(this.environment));
        executableInspected = true;
      } catch (error) {
        // status has no Turn dispatch identity; surface inspection failures
        // through its result rather than emitting an unfenced callback.
        throw new Error(`CLAUDE_EXECUTABLE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.questionRuntimeVersion = executableInspected ? runtimeVersion : "unverified";
    return {
      provider: this.provider,
      transport: "claude-agent-sdk",
      adapterVersion: SDK_VERSION,
      executable,
      runtimeVersion,
      workspace,
      sandboxRequired: true,
    };
  }

  /**
   * Run the small, read-only query required by the MVP startup contract.  A
   * normal Turn is not used because a readiness probe must not create a
   * Timeline item or a resumable user Session.  The probe still exercises
   * local authentication, the selected executable and the sandbox/tool
   * bridge by reading the fixture README.
   */
  async preflight(): Promise<AdapterStatus> {
    const status = await this.status();
    const probeEvents: AdapterEvent[] = [];
    const probe = new ClaudeAdapter({ ...this.runtimeOptions, workspace: this.workspace, queryFactory: this.queryFactory, maxBudgetUsd: 0.25, onEvent: (event) => probeEvents.push(event) });
    this.probes.add(probe);
    const probeContext = this.runtimes.inspectionContext();
    let outcome: TurnOutcome;
    try { outcome = await probe.runTurn(
      probeContext.flyxTurnId,
      "Use only the Read tool to read README.md in the configured workspace, then reply exactly FLYX_HOST_READY. Do not use any other tool and do not modify files.",
      undefined, probeContext,
    ); } finally { await probe.closeAndWait(); }
    if (outcome.status !== "completed") {
      throw new Error(`CLAUDE_PREFLIGHT_FAILED: ${outcome.status === "outcome_unknown" ? outcome.error : outcome.status === "failed" ? outcome.error : "unexpected cancellation"}`);
    }
    const probeText = probeEvents
      .filter((event): event is Extract<AdapterEvent, { kind: "assistant_message" }> => event.kind === "assistant_message")
      .map((event) => event.text)
      .join("\n");
    if (!probeEvents.some((event) => event.kind === "tool_started" && event.toolName === "Read")
      || !probeEvents.some((event) => event.kind === "tool_completed" && event.toolUseId)) {
      throw new Error("CLAUDE_PREFLIGHT_FAILED: Read tool bridge was not exercised");
    }
    if (!probeText.includes("FLYX_HOST_READY")) throw new Error("CLAUDE_PREFLIGHT_FAILED: readiness marker was not returned");
    return status;
  }

  get activeTurnId(): string | undefined {
    return this.active?.turnId;
  }

  async runTurn(turnId: string, prompt: string, resumeSessionId?: string, context?: DispatchContext): Promise<TurnOutcome> {
    if (this.closing) throw new Error("RUNTIME_CLOSING");
    if (this.active) throw new Error("CLAUDE_TURN_BUSY");
    const dispatchContext = dispatchContextForTurn(turnId, context);
    const active: ActiveQuery = {
      turnId,
      context: dispatchContext,
      query: undefined as never,
      runtime: undefined as never,
      possibleDispatch: false,
      pending: new Map(),
      interruptRequested: false,
      interruptAcknowledged: false,
      interruptTimedOut: false,
      resultSeen: false,
      assistantText: new Map(),
      assistantTruncated: new Set(),
      toolItems: new Map(),
      toolInputJson: new Map(),
      sessionIdChanged: false,
    };
    this.active = active;
    try { active.runtime = await this.runtimes.prepare(dispatchContext); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(active, { kind: "diagnostic", code: "TURN_NOT_DISPATCHED", message });
      this.clearActive(active);
      return { status: "failed", error: message, evidence: { kind: "not-dispatched" } };
    }

    let resultMessage: Extract<SDKMessage, { type: "result" }> | undefined;
    let iteratorError: unknown;

    try {
      active.possibleDispatch = true;
      active.query = this.queryFactory({ prompt, options: this.buildOptions(active, resumeSessionId) });
      active.timer = setTimeout(() => {
        if (this.active === active) void this.interrupt("turn_timeout");
      }, TURN_TIMEOUT_MS);
      try {
        for await (const message of active.query) {
          if (this.active !== active) continue;
          const maybeResult = this.handleMessage(active, message);
          if (maybeResult) resultMessage = maybeResult;
        }
      } catch (error) {
        iteratorError = error;
      }
    } catch (error) {
      iteratorError = error;
    } finally {
      active.resultSeen = true;
      if (active.timer) clearTimeout(active.timer);
      if (active.interruptTimer) clearTimeout(active.interruptTimer);
      this.cleanupApprovals(active, "aborted");
      try { active.query?.close?.(); } catch { /* The managed stop proof remains authoritative. */ }
      await active.runtime.closeAndWait();
    }

    const providerSessionId = active.providerSessionId;
    if (resultMessage && typeof resultMessage.uuid === "string" && resultMessage.uuid) {
      const evidence = { kind: "native-terminal" as const, sourceId: resultMessage.uuid };
      active.nativeTerminal = evidence;
      active.resultSeen = true;
      if (active.sessionIdChanged) {
        this.emit(active, { kind: "diagnostic", code: "SESSION_ID_CHANGED", message: "Claude reported more than one session id for one Flyx Turn" });
        this.clearActive(active);
        return { status: "outcome_unknown", ...(providerSessionId ? { providerSessionId } : {}), error: "Claude session identity changed", evidence: { kind: "unknown", reason: "session_id_changed" } };
      }
      // Claude Code may surface an acknowledged interrupt as a result message
      // instead of ending the async iterator without a result.  `aborted_*`
      // is the SDK's cancellation terminal boundary; it must not be exposed
      // to the phone as a generic provider failure.
      if (active.interruptRequested && active.interruptAcknowledged
        && (resultMessage.terminal_reason === "aborted_tools" || resultMessage.terminal_reason === "aborted_streaming")) {
        this.emit(active, { kind: "turn_cancelled", reason: resultMessage.terminal_reason, terminalEvidence: evidence });
        this.clearActive(active);
        return { status: "cancelled", ...(providerSessionId ? { providerSessionId } : {}), evidence };
      }
      if (resultMessage.subtype === "success") {
        if (/not logged in|please run \/login/i.test(resultMessage.result)) {
          this.emit(active, { kind: "turn_failed", subtype: "auth_required", errors: ["Claude Code is not authenticated for this Host"], terminalEvidence: evidence });
          this.clearActive(active);
          return {
            status: "failed",
            ...(providerSessionId ? { providerSessionId } : {}),
            error: "Claude Code is not authenticated for this Host",
            evidence,
          };
        }
        this.emit(active, {
          kind: "turn_completed",
          result: truncate(resultMessage.result, MAX_TOOL_OUTPUT_BYTES),
          costUsd: resultMessage.total_cost_usd,
          numTurns: resultMessage.num_turns,
          terminalEvidence: evidence,
          ...(resultMessage.terminal_reason ? { terminalReason: resultMessage.terminal_reason } : {}),
        });
        this.clearActive(active);
        return { status: "completed", providerSessionId: providerSessionId ?? "", evidence };
      }
      this.emit(active, {
        kind: "turn_failed",
        subtype: resultMessage.subtype,
        errors: resultMessage.errors.map((error) => truncate(error, MAX_TOOL_OUTPUT_BYTES)),
        terminalEvidence: evidence,
        ...(resultMessage.terminal_reason ? { terminalReason: resultMessage.terminal_reason } : {}),
      });
      this.clearActive(active);
      return {
        status: "failed",
        ...(providerSessionId ? { providerSessionId } : {}),
        error: resultMessage.errors.join("; ") || resultMessage.subtype,
        evidence,
      };
    }

    const message = iteratorError instanceof Error ? iteratorError.message : "stream_ended_without_result";
    // Interrupt delivery and iterator termination are not a native terminal fact.
    this.emit(active, { kind: "diagnostic", code: active.interruptRequested ? "INTERRUPT_UNCONFIRMED" : "TURN_DISPATCH_UNCONFIRMED", message });
    this.clearActive(active);
    return { status: "outcome_unknown", ...(providerSessionId ? { providerSessionId } : {}), error: message, evidence: { kind: "unknown", reason: message } };
  }

  async interrupt(reason = "user_interrupt"): Promise<"accepted" | "already_terminal" | "unavailable"> {
    const active = this.active;
    if (!active) return "unavailable";
    if (active.resultSeen) return "already_terminal";
    if (!active.query) return "unavailable";
    active.interruptRequested = true;
    this.cleanupApprovals(active, "aborted");
    try {
      await active.query.interrupt();
      active.interruptAcknowledged = true;
      active.interruptTimer = setTimeout(() => {
        if (this.active === active && !active.resultSeen) {
          active.interruptTimedOut = true;
          this.emit(active, {
            kind: "diagnostic",
            code: "INTERRUPT_UNCONFIRMED",
            message: `Claude did not reach a terminal state within ${INTERRUPT_CONFIRM_TIMEOUT_MS}ms`,
            details: { reason },
          });
          active.query.close?.();
        }
      }, INTERRUPT_CONFIRM_TIMEOUT_MS);
      return "accepted";
    } catch (error) {
      this.emit(active, {
        kind: "diagnostic",
        code: "INTERRUPT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
      return "unavailable";
    }
  }

  respondApproval(approvalId: string, action: ApprovalAction): boolean {
    const active = this.active;
    const pending = active?.pending.get(approvalId);
    if (!active || !pending) return false;
    active.pending.delete(approvalId);
    pending.cleanup();
    this.emit(active, {
      kind: "approval_resolved",
      approvalId,
      toolUseId: pending.request.toolUseId,
      action,
    });
    if (action === "allow_once") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.input,
        updatedPermissions: [],
        toolUseID: pending.request.toolUseId,
      });
    } else {
      pending.resolve({
        behavior: "deny",
        message: "Flyx mobile approval denied this tool request.",
        toolUseID: pending.request.toolUseId,
      });
    }
    return true;
  }

  respondQuestion(interactionId: string, answers: QuestionAnswers): NativeQuestionDelivery {
    return this.questionBridge.respond(interactionId,answers);
  }

  structuredQuestionsAvailable(): boolean { return this.questionBridge.capability(); }

  async deliverControl(context: DispatchContext, command: { kind: "interrupt_turn"; reason: string } | { kind: "respond_approval"; approvalId: string; action: ApprovalAction }): Promise<ProviderControlOutcome> {
    const active = this.active;
    if (!active || !sameDispatchContext(active.context, context)) {
      if (command.kind === "interrupt_turn" && this.lastNativeTerminal && sameDispatchContext(this.lastNativeTerminal.context, context)) return { status: "already_terminal", evidence: this.lastNativeTerminal.evidence };
      return { status: "not_dispatched", evidence: { kind: "not-dispatched" } };
    }
    if (command.kind === "respond_approval") {
      return this.respondApproval(command.approvalId, command.action) ? { status: "delivered", evidence: { kind: "local-delivery" } }
        : { status: "outcome_unknown", evidence: { kind: "unknown", reason: "APPROVAL_DELIVERY_UNCONFIRMED" } };
    }
    const result = await this.interrupt(command.reason);
    if (result === "accepted") return { status: "delivered", evidence: { kind: "local-delivery" } };
    if (result === "already_terminal" && active.nativeTerminal?.kind === "native-terminal") return { status: "already_terminal", evidence: active.nativeTerminal };
    return { status: "outcome_unknown", evidence: { kind: "unknown", reason: "INTERRUPT_DELIVERY_UNCONFIRMED" } };
  }
  close(): void { void this.closeAndWait().catch(() => {}); }
  closeAndWait(deadlineMs = 5_000): Promise<ProcessStopResult> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const active = this.active;
    if (active) {
      this.cleanupApprovals(active, "aborted");
      try { active.query?.close?.(); } catch { /* Managed producer proof is still required. */ }
    }
    this.closePromise = Promise.all([this.runtimes.closeAndWait(deadlineMs), ...[...this.probes].map((probe) => probe.closeAndWait(deadlineMs))]).then((results) => ({ stopped: results.every((result) => result.stopped), treeStopped: results.every((result) => result.treeStopped), records: results.flatMap((result) => result.records) }));
    return this.closePromise;
  }
  sealCallbacks(): void { this.callbacksSealed = true; for (const probe of this.probes) probe.sealCallbacks(); }
  sealProcessJournal(): void { this.runtimes.sealJournals(); for (const probe of this.probes) probe.sealProcessJournal(); }
  private buildOptions(active: ActiveQuery, resumeSessionId?: string) {
    const pathOverride = this.executableOverride;
    return {
      cwd: this.workspace,
      spawnClaudeCodeProcess: (request: SdkSpawnOptions): SpawnedProcess => active.runtime.spawn({ command: request.command, args: request.args, cwd: request.cwd ?? this.workspace, env: request.env, signal: request.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as SpawnedProcess,
      ...(pathOverride ? { pathToClaudeCodeExecutable: pathOverride } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(this.model ? { model: this.model } : {}),
      includePartialMessages: true,
      permissionMode: "default" as const,
      // Auth for a local Claude Code login is resolved from the user source. The
      // inline highest-priority layer clears user hooks, plugins, MCP and
      // permission defaults; Flyx then adds only its own invariant hook.
      settingSources: ["user"] as ["user"],
      settings: {
        permissions: { defaultMode: "default" as const, allow: [], deny: [] },
        enabledPlugins: {},
        hooks: {},
        mcpServers: {},
        additionalDirectories: [],
        disableAllHooks: true,
        disableAgentView: true,
        disableRemoteControl: true,
        disableWorkflows: true,
      },
      strictMcpConfig: true,
      persistSession: true,
      tools: [...SAFE_TOOLS].filter((tool) => tool !== "AskUserQuestion" || this.questionBridge.canHandle()),
      maxTurns: 20,
      maxBudgetUsd: this.maxBudgetUsd,
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [this.workspace] },
      },
      // Do not pass the Host's complete environment to a Claude child process.
      // In particular, arbitrary shell/API credentials must not become
      // readable by a model through Bash.  HOME is retained for the local
      // Claude login; the small explicit auth list covers the supported local
      // account/API modes without turning this into an environment passthrough.
      env: restrictedEnvironment(this.environment),
      canUseTool: ((toolName, input, toolOptions) => this.canUseTool(active, toolName, input, toolOptions)) as CanUseTool,
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [this.preToolUseHook],
            timeout: 5,
          },
        ],
      },
    };
  }

  private readonly preToolUseHook = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const toolName = input.tool_name;
    if (!SAFE_TOOLS.includes(toolName as (typeof SAFE_TOOLS)[number])) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: "Tool is not enabled by Flyx MVP",
        },
      };
    }
    if (toolName === "AskUserQuestion") {
      let valid = this.questionBridge.canHandle();
      try { parseClaudeQuestions(input.tool_use_id,input.tool_input); } catch { valid = false; }
      return {continue:true,hookSpecificOutput:{hookEventName:"PreToolUse" as const,
        permissionDecision:valid ? "ask" as const : "deny" as const,
        permissionDecisionReason:valid ? "A user answer is required" : "Structured questions are not verified or the native request is invalid"}};
    }
    if (["Read", "Glob", "Grep", "Edit", "Write"].includes(toolName)) {
      const inputRecord = isRecord(input.tool_input) ? input.tool_input : {};
      const candidate = firstString(inputRecord.file_path, inputRecord.path);
      if (candidate && !(await this.isInsideWorkspace(candidate))) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: "Workspace path is outside the configured root",
          },
        };
      }
    }
    return { continue: true };
  };

  private readonly canUseTool = async (active: ActiveQuery, toolName: Parameters<CanUseTool>[0], input: Parameters<CanUseTool>[1], options: Parameters<CanUseTool>[2]): Promise<PermissionResult> => {
    if (this.active !== active || active.resultSeen) return { behavior: "deny", message: "No active Flyx turn" };
    if (!SAFE_TOOLS.includes(toolName as (typeof SAFE_TOOLS)[number])) {
      return { behavior: "deny", message: "Tool is disabled by Flyx MVP" };
    }
    if (options.blockedPath && !(await this.isInsideWorkspace(options.blockedPath))) {
      return { behavior: "deny", message: "Requested path is outside the configured workspace" };
    }
    if (toolName === "AskUserQuestion") {
      return this.questionBridge.request(active,options.toolUseID,input,options.signal);
    }
    if (["Read", "Glob", "Grep", "Edit", "Write"].includes(toolName)) {
      const candidate = firstString(input.file_path, input.path);
      if (candidate && !(await this.isInsideWorkspace(candidate))) {
        return { behavior: "deny", message: "Workspace path is outside the configured root" };
      }
    }
    if (this.active !== active || active.resultSeen || options.signal.aborted) {
      return { behavior: "deny", message: "No active Flyx turn" };
    }
    if (["Read", "Glob", "Grep"].includes(toolName)) {
      return { behavior: "allow", updatedInput: input, updatedPermissions: [] };
    }
    const encodedSize = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (encodedSize > MAX_APPROVAL_INPUT_BYTES) {
      return { behavior: "deny", message: "Flyx refused an oversized approval request" };
    }
    if (!options.toolUseID) return {behavior:"deny",message:"Native approval request ID is missing"};
    const approvalId = randomUUID();
    const request: ApprovalRequest = {
      approvalId,
      turnId: active.turnId,
      toolUseId: options.toolUseID,
      toolName,
      input: truncateRecord(sanitizeRecordForDisplay(input, this.workspace)),
      ...(options.title ? { title: options.title } : {}),
      ...(options.description ? { description: options.description } : {}),
      cwd: ".",
      createdAt: new Date().toISOString(),
      dispatchContext: {nativeRequestId:options.toolUseID,nativeMethod:"canUseTool/approval"},
    };
    this.emit(active, { kind: "approval_requested", request });
    return new Promise<PermissionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        active.pending.delete(approvalId);
        cleanup();
        this.emit(active, { kind: "approval_resolved", approvalId, toolUseId: options.toolUseID, action: "expired" });
        resolve({ behavior: "deny", message: "Flyx approval expired" });
      }, 10 * 60 * 1000);
      const abortHandler = () => {
        active.pending.delete(approvalId);
        clearTimeout(timeout);
        cleanup();
        this.emit(active, { kind: "approval_resolved", approvalId, toolUseId: options.toolUseID, action: "aborted" });
        reject(new Error("Flyx approval aborted"));
      };
      const cleanup = () => options.signal.removeEventListener("abort", abortHandler);
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener("abort", abortHandler, { once: true });
      active.pending.set(approvalId, {
        request,
        input,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          cleanup();
        },
      });
    });
  };

  private handleMessage(active: ActiveQuery, message: SDKMessage): Extract<SDKMessage, { type: "result" }> | undefined {
    if (message.session_id) {
      if (active.providerSessionId && active.providerSessionId !== message.session_id) {
        active.sessionIdChanged = true;
        this.emit(active, { kind: "diagnostic", code: "SESSION_ID_CHANGED", message: "Claude reported more than one session id" });
      }
      active.providerSessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.emit(active, {
        kind: "session_init",
        provider: this.provider,
        providerSessionId: message.session_id,
        runtimeVersion: message.claude_code_version,
        model: message.model,
        tools: message.tools,
      });
      return undefined;
    }
    if (message.type === "stream_event") {
      this.handleStreamEvent(active, message.event as unknown as Record<string, unknown>);
      return undefined;
    }
    if (message.type === "assistant") {
      this.handleAssistantMessage(active, message);
      return undefined;
    }
    if (message.type === "user") {
      this.handleUserMessage(active, message);
      return undefined;
    }
    if (message.type === "tool_progress") {
      const toolUseId = message.tool_use_id;
      const itemId = active.toolItems.get(toolUseId) ?? `tool-${toolUseId}`;
      this.emit(active, {
        kind: "tool_progress",
        itemId,
        toolUseId,
        output: `Running ${message.tool_name} (${message.elapsed_time_seconds.toFixed(1)}s)`,
      });
      return undefined;
    }
    if (message.type === "system" && message.subtype === "permission_denied") {
      this.emit(active, {
        kind: "diagnostic",
        code: "PERMISSION_DENIED",
        message: message.message,
        details: { toolName: message.tool_name, toolUseId: message.tool_use_id },
      });
      return undefined;
    }
    if (message.type === "result") { active.nativeTerminal = typeof message.uuid === "string" && message.uuid ? { kind: "native-terminal", sourceId: message.uuid } : undefined; return message; }
    return undefined;
  }

  private handleStreamEvent(active: ActiveQuery, event: Record<string, unknown>): void {
    const eventType = typeof event.type === "string" ? event.type : "unknown";
    if (eventType === "message_start") {
      const message = isRecord(event.message) ? event.message : {};
      const messageId = typeof message.id === "string" ? message.id : randomUUID();
      active.assistantItemId = `assistant-${messageId}`;
      if (!active.assistantText.has(active.assistantItemId)) active.assistantText.set(active.assistantItemId, "");
      return;
    }
    if (eventType === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const itemId = `tool-${block.id}`;
        active.toolItems.set(block.id, itemId);
        const input = isRecord(block.input) ? sanitizeRecordForDisplay(block.input, this.workspace) : {};
        this.emit(active, { kind: "tool_started", itemId, toolUseId: block.id, toolName: block.name, input });
      }
      return;
    }
    if (eventType === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        const itemId = active.assistantItemId ?? `assistant-${active.turnId}`;
        const previous = active.assistantText.get(itemId) ?? "";
        if (!active.assistantTruncated.has(itemId)) {
          const appended = appendWithinLimit(previous, delta.text, MAX_ASSISTANT_MESSAGE_BYTES);
          active.assistantText.set(itemId, appended.next);
          if (appended.text) this.emit(active, { kind: "assistant_delta", itemId, text: appended.text });
          if (appended.truncated) active.assistantTruncated.add(itemId);
        }
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = String(event.index ?? "0");
        active.toolInputJson.set(index, (active.toolInputJson.get(index) ?? "") + delta.partial_json);
      }
      return;
    }
    if (eventType === "content_block_stop") {
      return;
    }
  }

  private handleAssistantMessage(active: ActiveQuery, message: Extract<SDKMessage, { type: "assistant" }>): void {
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    content.forEach((block, index) => {
      const value = block as unknown as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") {
        const rawId = typeof message.message.id === "string" ? message.message.id : message.uuid;
        const itemId = index === 0 ? `assistant-${rawId}` : `assistant-${rawId}-${index}`;
        this.emit(active, { kind: "assistant_message", itemId, text: truncate(value.text, 1024 * 1024), ...(message.aborted ? { aborted: true } : {}) });
      }
      if (value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string") {
        const itemId = active.toolItems.get(value.id) ?? `tool-${value.id}`;
        active.toolItems.set(value.id, itemId);
        this.emit(active, { kind: "tool_started", itemId, toolUseId: value.id, toolName: value.name, input: isRecord(value.input) ? sanitizeRecordForDisplay(value.input, this.workspace) : {} });
      }
    });
  }

  private handleUserMessage(active: ActiveQuery, message: Extract<SDKMessage, { type: "user" }>): void {
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    content.forEach((block) => {
      const value = block as unknown as Record<string, unknown>;
      if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") return;
      if (value.is_error !== true && typeof message.uuid === "string") {
        this.questionBridge.observeToolResult(active,value.tool_use_id,`claude:${message.uuid}`,value.content);
      }
      const itemId = active.toolItems.get(value.tool_use_id) ?? `tool-${value.tool_use_id}`;
      const output = typeof value.content === "string" ? value.content : JSON.stringify(value.content ?? "");
      const isError = value.is_error === true;
      this.emit(active, {
        kind: "tool_completed",
        itemId,
        toolUseId: value.tool_use_id,
        ...(isError ? { error: truncate(output, MAX_TOOL_OUTPUT_BYTES) } : { output: truncate(output, MAX_TOOL_OUTPUT_BYTES) }),
      });
    });
  }

  private cleanupApprovals(active: ActiveQuery, action: "aborted"): void {
    this.questionBridge.cancelTurn(active);
    for (const [approvalId, pending] of active.pending) {
      active.pending.delete(approvalId);
      pending.cleanup();
      pending.reject(new Error(`Flyx approval ${action}`));
      this.emit(active, { kind: "approval_resolved", approvalId, toolUseId: pending.request.toolUseId, action });
    }
  }

  private clearActive(active: ActiveQuery): void {
    if (active.nativeTerminal?.kind === "native-terminal" && !active.sessionIdChanged) this.lastNativeTerminal = { context: active.context, evidence: active.nativeTerminal };
    if (this.active === active) this.active = undefined;
  }

  private emit(active: ActiveQuery, event: AdapterEventPayload): void {
    if (!this.callbacksSealed) this.onEvent?.(fenceAdapterEvent(active.context, event));
  }

  private async isInsideWorkspace(candidate: string): Promise<boolean> {
    const root = await this.workspaceRealpathPromise;
    const resolved = await resolvePathForCheck(candidate, root);
    return resolved === root || resolved.startsWith(`${root}/`);
  }
}

export async function resolvePathForCheck(candidate: string, root: string): Promise<string> {
  // A path containing a parent segment is rejected before normalization.  If
  // it were normalized first, `workspace/sub/../outside` could look harmless
  // while still making the policy dependent on the caller's spelling.
  if (candidate.includes("\0") || candidate.split(/[\\/]+/).some((segment) => segment === "..")) return "";
  const absolute = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(root, candidate);
  let probe = absolute;
  const remainder: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(probe);
      return resolvePath(canonical, ...remainder);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return "";
      remainder.unshift(basename(probe));
      probe = parent;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function sanitizeForDisplay(value: unknown, workspace: string, key?: string, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    if (key && ["path", "file_path", "cwd", "directory", "filename"].includes(key) && isAbsolute(value)) {
      const relativePath = relative(workspace, resolvePath(value));
      return relativePath.startsWith("..") || isAbsolute(relativePath) ? "[outside workspace]" : relativePath || ".";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForDisplay(item, workspace, key, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeForDisplay(entryValue, workspace, entryKey, depth + 1)]));
}

function sanitizeRecordForDisplay(value: Record<string, unknown>, workspace: string): Record<string, unknown> {
  const sanitized = sanitizeForDisplay(value, workspace);
  return isRecord(sanitized) ? sanitized : {};
}

function truncate(value: string, maxBytes: number): string {
  const valueBytes = Buffer.byteLength(value, "utf8");
  if (valueBytes <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes - 32) result = result.slice(0, Math.max(0, result.length - 128));
  return `${result}… [truncated ${valueBytes - Buffer.byteLength(result, "utf8")} bytes]`;
}

function appendWithinLimit(current: string, delta: string, maxBytes: number): { next: string; text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBytes) return { next: current, text: "", truncated: true };
  const deltaBytes = Buffer.byteLength(delta, "utf8");
  if (currentBytes + deltaBytes <= maxBytes) return { next: current + delta, text: delta, truncated: false };
  const marker = "… [assistant message truncated]";
  const room = Math.max(0, maxBytes - currentBytes - Buffer.byteLength(marker, "utf8"));
  const visible = takeUtf8(delta, room);
  const text = `${visible}${marker}`;
  return { next: current + text, text, truncated: true };
}

function takeUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

function truncateRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(truncate(JSON.stringify(value), MAX_APPROVAL_INPUT_BYTES)) as Record<string, unknown>;
}

function readPackageMetadata(entry: string): { version: string; claudeCodeVersion: string } {
  let directory = dirname(entry);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        version?: string;
        claudeCodeVersion?: string;
      };
      return {
        version: String(packageJson.version ?? "unknown"),
        claudeCodeVersion: String(packageJson.claudeCodeVersion ?? "unknown"),
      };
    } catch {
      directory = dirname(directory);
    }
  }
  return { version: "unknown", claudeCodeVersion: "unknown" };
}

function restrictedEnvironment(overrides?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "COLORTERM",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ];
  const result: NodeJS.ProcessEnv = { CLAUDE_AGENT_SDK_CLIENT_APP: "flyx-mvp/0.0.1" };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR"].includes(name) || typeof value !== "string" || value.includes("\0")) throw new Error("PROVIDER_ENVIRONMENT_INVALID");
    result[name] = value;
  }
  return result;
}
