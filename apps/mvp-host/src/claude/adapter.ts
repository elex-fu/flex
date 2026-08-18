import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
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
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEvent,
  AdapterEventHandler,
  AdapterStatus,
  ApprovalAction,
  ApprovalRequest,
  TurnOutcome,
} from "./types.js";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
const SDK_VERSION = readPackageVersion(sdkEntry);
const SAFE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] as const;
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
  generation: number;
  query: Query;
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
};

export type ClaudeAdapterOptions = {
  workspace: string;
  onEvent?: AdapterEventHandler;
  maxBudgetUsd?: number;
};

export class ClaudeAdapter {
  readonly workspace: string;
  private readonly onEvent: AdapterEventHandler | undefined;
  private readonly maxBudgetUsd: number;
  private readonly workspaceRealpathPromise: Promise<string>;
  private active: ActiveQuery | undefined;
  private generation = 0;

  constructor(options: ClaudeAdapterOptions) {
    this.workspace = options.workspace;
    this.onEvent = options.onEvent;
    this.maxBudgetUsd = options.maxBudgetUsd ?? 5;
    this.workspaceRealpathPromise = realpath(options.workspace);
  }

  async status(): Promise<AdapterStatus> {
    const workspace = await this.workspaceRealpathPromise;
    await stat(workspace);
    let claudeVersion = "unknown";
    const executable = process.env.FLYX_CLAUDE_EXECUTABLE ?? "claude";
    try {
      const result = await execFile(executable, ["--version"], { timeout: 5_000 });
      claudeVersion = result.stdout.trim() || result.stderr.trim() || "unknown";
    } catch (error) {
      this.emit({
        kind: "diagnostic",
        code: "CLAUDE_EXECUTABLE_UNAVAILABLE",
        message: "The system claude executable could not be inspected; the SDK bundled executable may still be used.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      sdkVersion: SDK_VERSION,
      claudeExecutable: process.env.FLYX_CLAUDE_EXECUTABLE ?? "sdk-bundled",
      claudeVersion,
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
    const probe = new ClaudeAdapter({ workspace: this.workspace, maxBudgetUsd: 0.25, onEvent: (event) => probeEvents.push(event) });
    const outcome = await probe.runTurn(
      `flyx-preflight-${randomUUID()}`,
      "Use only the Read tool to read README.md in the configured workspace, then reply exactly FLYX_HOST_READY. Do not use any other tool and do not modify files.",
    );
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

  async runTurn(turnId: string, prompt: string, resumeSessionId?: string): Promise<TurnOutcome> {
    if (this.active) throw new Error("CLAUDE_TURN_BUSY");
    const generation = ++this.generation;
    const active: ActiveQuery = {
      turnId,
      generation,
      query: undefined as never,
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

    const options = this.buildOptions(active, resumeSessionId);
    let resultMessage: Extract<SDKMessage, { type: "result" }> | undefined;
    let iteratorError: unknown;

    try {
      active.query = query({ prompt, options });
      active.timer = setTimeout(() => {
        void this.interrupt("turn_timeout");
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
      if (active.timer) clearTimeout(active.timer);
      this.cleanupApprovals(active, "aborted");
    }

    const providerSessionId = active.providerSessionId;
    if (resultMessage) {
      active.resultSeen = true;
      if (active.sessionIdChanged) {
        this.emit({
          kind: "turn_failed",
          subtype: "session_id_changed",
          errors: ["Claude reported more than one session id for one Flyx Turn"],
        });
        this.clearActive(active);
        return {
          status: "failed",
          ...(providerSessionId ? { providerSessionId } : {}),
          error: "Claude reported more than one session id for one Flyx Turn",
        };
      }
      // Claude Code may surface an acknowledged interrupt as a result message
      // instead of ending the async iterator without a result.  `aborted_*`
      // is the SDK's cancellation terminal boundary; it must not be exposed
      // to the phone as a generic provider failure.
      if (active.interruptRequested && active.interruptAcknowledged
        && (resultMessage.terminal_reason === "aborted_tools" || resultMessage.terminal_reason === "aborted_streaming")) {
        this.emit({ kind: "turn_cancelled", reason: resultMessage.terminal_reason });
        this.clearActive(active);
        return { status: "cancelled", ...(providerSessionId ? { providerSessionId } : {}) };
      }
      if (resultMessage.subtype === "success") {
        if (/not logged in|please run \/login/i.test(resultMessage.result)) {
          this.emit({ kind: "turn_failed", subtype: "auth_required", errors: ["Claude Code is not authenticated for this Host"] });
          this.clearActive(active);
          return {
            status: "failed",
            ...(providerSessionId ? { providerSessionId } : {}),
            error: "Claude Code is not authenticated for this Host",
          };
        }
        this.emit({
          kind: "turn_completed",
          result: truncate(resultMessage.result, MAX_TOOL_OUTPUT_BYTES),
          costUsd: resultMessage.total_cost_usd,
          numTurns: resultMessage.num_turns,
          ...(resultMessage.terminal_reason ? { terminalReason: resultMessage.terminal_reason } : {}),
        });
        this.clearActive(active);
        return { status: "completed", providerSessionId: providerSessionId ?? "" };
      }
      this.emit({
        kind: "turn_failed",
        subtype: resultMessage.subtype,
        errors: resultMessage.errors.map((error) => truncate(error, MAX_TOOL_OUTPUT_BYTES)),
        ...(resultMessage.terminal_reason ? { terminalReason: resultMessage.terminal_reason } : {}),
      });
      this.clearActive(active);
      return {
        status: "failed",
        ...(providerSessionId ? { providerSessionId } : {}),
        error: resultMessage.errors.join("; ") || resultMessage.subtype,
      };
    }

    // Once the SDK has acknowledged interrupt, an iterator ending without a
    // result is the provider's cancellation boundary.  An implementation may
    // surface that boundary as an iterator error; the absence of a result,
    // not the error wording, is what distinguishes it from a failed Turn.
    if (active.interruptRequested && active.interruptAcknowledged && !active.interruptTimedOut) {
      this.emit({ kind: "turn_cancelled", reason: "interrupt_confirmed" });
      this.clearActive(active);
      return { status: "cancelled", ...(providerSessionId ? { providerSessionId } : {}) };
    }

    const message = iteratorError instanceof Error ? iteratorError.message : "stream_ended_without_result";
    if (active.interruptTimedOut) {
      this.emit({ kind: "diagnostic", code: "INTERRUPT_UNCONFIRMED", message });
      this.clearActive(active);
      return {
        status: "outcome_unknown",
        ...(providerSessionId ? { providerSessionId } : {}),
        error: message,
      };
    }
    this.emit({ kind: "turn_failed", subtype: "stream_ended_without_result", errors: [message] });
    this.clearActive(active);
    return {
      status: "failed",
      ...(providerSessionId ? { providerSessionId } : {}),
      error: message,
    };
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
      setTimeout(() => {
        if (this.active === active && !active.resultSeen) {
          active.interruptTimedOut = true;
          this.emit({
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
      this.emit({
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
    this.emit({
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

  private buildOptions(active: ActiveQuery, resumeSessionId?: string) {
    const pathOverride = process.env.FLYX_CLAUDE_EXECUTABLE;
    return {
      cwd: this.workspace,
      ...(pathOverride ? { pathToClaudeCodeExecutable: pathOverride } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
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
      tools: [...SAFE_TOOLS],
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
      env: restrictedEnvironment(),
      canUseTool: this.canUseTool,
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

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const active = this.active;
    if (!active) return { behavior: "deny", message: "No active Flyx turn" };
    if (!SAFE_TOOLS.includes(toolName as (typeof SAFE_TOOLS)[number])) {
      return { behavior: "deny", message: "Tool is disabled by Flyx MVP" };
    }
    if (options.blockedPath && !(await this.isInsideWorkspace(options.blockedPath))) {
      return { behavior: "deny", message: "Requested path is outside the configured workspace" };
    }
    if (["Read", "Glob", "Grep", "Edit", "Write"].includes(toolName)) {
      const candidate = firstString(input.file_path, input.path);
      if (candidate && !(await this.isInsideWorkspace(candidate))) {
        return { behavior: "deny", message: "Workspace path is outside the configured root" };
      }
    }
    if (["Read", "Glob", "Grep"].includes(toolName)) {
      return { behavior: "allow", updatedInput: input, updatedPermissions: [] };
    }
    const encodedSize = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (encodedSize > MAX_APPROVAL_INPUT_BYTES) {
      return { behavior: "deny", message: "Flyx refused an oversized approval request" };
    }
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
    };
    this.emit({ kind: "approval_requested", request });
    return new Promise<PermissionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        active.pending.delete(approvalId);
        cleanup();
        this.emit({ kind: "approval_resolved", approvalId, toolUseId: options.toolUseID, action: "expired" });
        resolve({ behavior: "deny", message: "Flyx approval expired" });
      }, 10 * 60 * 1000);
      const abortHandler = () => {
        active.pending.delete(approvalId);
        clearTimeout(timeout);
        cleanup();
        this.emit({ kind: "approval_resolved", approvalId, toolUseId: options.toolUseID, action: "aborted" });
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
        this.emit({ kind: "diagnostic", code: "SESSION_ID_CHANGED", message: "Claude reported more than one session id" });
      }
      active.providerSessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.emit({
        kind: "session_init",
        providerSessionId: message.session_id,
        claudeCodeVersion: message.claude_code_version,
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
      this.emit({
        kind: "tool_progress",
        itemId,
        toolUseId,
        output: `Running ${message.tool_name} (${message.elapsed_time_seconds.toFixed(1)}s)`,
      });
      return undefined;
    }
    if (message.type === "system" && message.subtype === "permission_denied") {
      this.emit({
        kind: "diagnostic",
        code: "PERMISSION_DENIED",
        message: message.message,
        details: { toolName: message.tool_name, toolUseId: message.tool_use_id },
      });
      return undefined;
    }
    if (message.type === "result") return message;
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
        this.emit({ kind: "tool_started", itemId, toolUseId: block.id, toolName: block.name, input });
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
          if (appended.text) this.emit({ kind: "assistant_delta", itemId, text: appended.text });
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
        this.emit({ kind: "assistant_message", itemId, text: truncate(value.text, 1024 * 1024), ...(message.aborted ? { aborted: true } : {}) });
      }
      if (value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string") {
        const itemId = active.toolItems.get(value.id) ?? `tool-${value.id}`;
        active.toolItems.set(value.id, itemId);
        this.emit({ kind: "tool_started", itemId, toolUseId: value.id, toolName: value.name, input: isRecord(value.input) ? sanitizeRecordForDisplay(value.input, this.workspace) : {} });
      }
    });
  }

  private handleUserMessage(active: ActiveQuery, message: Extract<SDKMessage, { type: "user" }>): void {
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    content.forEach((block) => {
      const value = block as unknown as Record<string, unknown>;
      if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") return;
      const itemId = active.toolItems.get(value.tool_use_id) ?? `tool-${value.tool_use_id}`;
      const output = typeof value.content === "string" ? value.content : JSON.stringify(value.content ?? "");
      const isError = value.is_error === true;
      this.emit({
        kind: "tool_completed",
        itemId,
        toolUseId: value.tool_use_id,
        ...(isError ? { error: truncate(output, MAX_TOOL_OUTPUT_BYTES) } : { output: truncate(output, MAX_TOOL_OUTPUT_BYTES) }),
      });
    });
  }

  private cleanupApprovals(active: ActiveQuery, action: "aborted"): void {
    for (const [approvalId, pending] of active.pending) {
      active.pending.delete(approvalId);
      pending.cleanup();
      pending.reject(new Error(`Flyx approval ${action}`));
      this.emit({ kind: "approval_resolved", approvalId, toolUseId: pending.request.toolUseId, action });
    }
  }

  private clearActive(active: ActiveQuery): void {
    if (this.active === active) this.active = undefined;
  }

  private emit(event: AdapterEvent): void {
    const active = this.active;
    if (active && event.generation === undefined) {
      this.onEvent?.({ ...event, generation: active.generation, turnId: active.turnId });
      return;
    }
    this.onEvent?.(event);
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

function readPackageVersion(entry: string): string {
  let directory = dirname(entry);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: string };
      return String(packageJson.version ?? "unknown");
    } catch {
      directory = dirname(directory);
    }
  }
  return "unknown";
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
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
  return result;
}
