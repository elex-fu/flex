import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AdapterEventPayload,
  DispatchContext,
  AdapterEventHandler,
  AdapterStatus,
  ApprovalAction,
  ApprovalRequest,
  ProviderAdapter,
  TurnOutcome,
} from "../provider/types.js";
import { dispatchContextForTurn, fenceAdapterEvent } from "../provider/types.js";
import {
  StdioAppServerClient,
  type AppServerClient,
  type AppServerClientFactory,
  type AppServerNotification,
  type AppServerRequest,
  type JsonObject,
  type JsonRpcId,
} from "./app-server-client.js";

const execFile = promisify(execFileCallback);
const ADAPTER_VERSION = "codex-app-server-v1";
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const INTERRUPT_CONFIRM_TIMEOUT_MS = 5_000;
const MAX_DISCOVERED_INTEGRATIONS = 512;
const MAX_TRACKED_REQUEST_IDS = 4096;
const FORBIDDEN_ITEM_TYPES = new Set([
  "collabAgentToolCall",
  "dynamicToolCall",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "subAgentActivity",
  "webSearch",
]);

const APP_SERVER_SECURITY_ARGS = [
  "app-server",
  "-c", "features.apps=false",
  "-c", "features.browser_use=false",
  "-c", "features.browser_use_external=false",
  "-c", "features.browser_use_full_cdp_access=false",
  "-c", "features.computer_use=false",
  "-c", "features.goals=false",
  "-c", "features.hooks=false",
  "-c", "features.js_repl=false",
  "-c", "features.memories=false",
  "-c", "features.multi_agent=false",
  "-c", "features.plugins=false",
  "-c", "features.remote_control=false",
  "-c", "features.remote_plugin=false",
  "-c", "features.shell_snapshot=false",
  "-c", "features.skill_mcp_dependency_install=false",
  "-c", "features.tool_suggest=false",
  "-c", "features.workspace_dependencies=false",
  "-c", "agents.enabled=false",
  "-c", "allow_login_shell=false",
  "-c", "include_apps_instructions=false",
  "-c", "include_collaboration_mode_instructions=false",
  "-c", "notify=[]",
  "-c", "shell_environment_policy.ignore_default_excludes=false",
  "-c", 'shell_environment_policy.inherit="core"',
  "-c", "tools.view_image=false",
  "-c", "tools.web_search=false",
  "-c", 'web_search="disabled"',
  "--listen", "stdio://",
] as const;

type PendingApproval = {
  rpcId: JsonRpcId;
  toolUseId: string;
};

type ActiveTurn = {
  turnId: string;
  context: DispatchContext;
  threadId: string;
  client?: AppServerClient;
  starting: boolean;
  deferred: Array<{ notification: AppServerNotification } | { request: AppServerRequest }>;
  codexTurnId?: string;
  pending: Map<string, PendingApproval>;
  pendingByRpcId: Map<string, string>;
  unambiguousRequestIds: Set<string>;
  assistantText: Map<string, string>;
  toolOutput: Map<string, string>;
  items: Map<string, JsonObject>;
  lastAssistantText: string;
  errors: string[];
  interruptRequested: boolean;
  terminal: boolean;
  timer?: NodeJS.Timeout;
  interruptTimer?: NodeJS.Timeout;
  resolve(outcome: TurnOutcome): void;
};

export type CodexAdapterOptions = {
  workspace: string;
  onEvent?: AdapterEventHandler;
  executable?: string;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  turnTimeoutMs?: number;
  clientFactory?: AppServerClientFactory;
};

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly workspace: string;
  private readonly onEvent: AdapterEventHandler | undefined;
  private readonly executable: string;
  private readonly model: string | undefined;
  private readonly effort: CodexAdapterOptions["effort"];
  private readonly turnTimeoutMs: number;
  private readonly clientFactory: AppServerClientFactory;
  private readonly workspaceRealpathPromise: Promise<string>;
  private client: AppServerClient | undefined;
  private runtimePolicyPromise: Promise<JsonObject> | undefined;
  private loadedThreadId: string | undefined;
  private readonly unexpectedMcpThreads = new Map<string, string>();
  private readonly observedRequestIds = new Set<string>();
  private active: ActiveTurn | undefined;
  private runtimeVersion = "unknown";

  constructor(options: CodexAdapterOptions) {
    this.workspace = options.workspace;
    this.onEvent = options.onEvent;
    this.executable = options.executable ?? process.env.FLYX_CODEX_EXECUTABLE ?? "codex";
    this.model = options.model ?? process.env.FLYX_CODEX_MODEL;
    this.effort = options.effort ?? parseEffort(process.env.FLYX_CODEX_EFFORT);
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.workspaceRealpathPromise = realpath(options.workspace);
    this.clientFactory = options.clientFactory ?? ((handlers) => new StdioAppServerClient({
      executable: this.executable,
      cwd: this.workspace,
      env: restrictedEnvironment(),
      args: APP_SERVER_SECURITY_ARGS,
      handlers,
    }));
  }

  async status(): Promise<AdapterStatus> {
    const workspace = await this.workspaceRealpathPromise;
    await stat(workspace);
    try {
      const result = await execFile(this.executable, ["--version"], { timeout: 5_000 });
      this.runtimeVersion = result.stdout.trim() || result.stderr.trim() || "unknown";
    } catch (error) {
      throw new Error(`CODEX_EXECUTABLE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      provider: this.provider,
      transport: "codex-app-server",
      adapterVersion: ADAPTER_VERSION,
      executable: this.executable,
      runtimeVersion: this.runtimeVersion,
      workspace,
      sandboxRequired: true,
    };
  }

  async preflight(): Promise<AdapterStatus> {
    const status = await this.status();
    const client = await this.ensureClient();
    await this.ensureRuntimePolicy(client);
    const account = await client.request<JsonObject>("account/read", { refreshToken: false }, 15_000);
    if (account.requiresOpenaiAuth === true && !isRecord(account.account)) {
      throw new Error("CODEX_PREFLIGHT_FAILED: Codex is not authenticated on this Host");
    }
    return status;
  }

  async runTurn(turnId: string, prompt: string, resumeSessionId?: string, context?: DispatchContext): Promise<TurnOutcome> {
    if (this.active) throw new Error("CODEX_TURN_BUSY");
    const dispatchContext = dispatchContextForTurn(turnId, context);
    let settle!: (outcome: TurnOutcome) => void;
    const completion = new Promise<TurnOutcome>((resolvePromise) => { settle = resolvePromise; });
    // Install the dispatch identity before client/thread preparation can fail.
    const active: ActiveTurn = {
      turnId,
      context: dispatchContext,
      threadId: resumeSessionId ?? "",
      starting: false,
      deferred: [],
      pending: new Map(),
      pendingByRpcId: new Map(),
      unambiguousRequestIds: new Set(),
      assistantText: new Map(),
      toolOutput: new Map(),
      items: new Map(),
      lastAssistantText: "",
      errors: [],
      interruptRequested: false,
      terminal: false,
      resolve: settle,
    };
    this.active = active;
    let client: AppServerClient;
    try {
      client = await this.ensureClient();
      active.client = client;
    } catch (error) {
      this.failStart(active, "client_start_failed", error);
      return completion;
    }
    try {
      active.threadId = await this.loadThread(client, resumeSessionId);
      if (this.client !== client) throw new Error("Codex app-server exited during thread preparation");
    } catch (error) {
      this.failStart(active, "thread_start_failed", error);
      return completion;
    }
    if (active.terminal || this.active !== active) return completion;
    this.emit(active, {
      kind: "session_init",
      provider: this.provider,
      providerSessionId: active.threadId,
      runtimeVersion: this.runtimeVersion,
      model: this.model ?? "configured-default",
      tools: ["commandExecution", "fileChange"],
    });
    active.timer = setTimeout(() => void this.timeoutTurn(active), this.turnTimeoutMs);
    active.starting = true;
    try {
      const response = await client.request<JsonObject>("turn/start", {
        threadId: active.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: this.workspace,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      });
      if (!active.terminal && this.active === active) {
        const returnedTurn = isRecord(response.turn) ? response.turn : {};
        if (typeof returnedTurn.id !== "string" || !returnedTurn.id) throw new Error("Codex app-server returned no turn id");
        active.codexTurnId = returnedTurn.id;
        active.starting = false;
        this.emit(active, { kind: "native_binding", nativeSessionId: active.threadId, nativeTurnId: returnedTurn.id });
        for (const callback of active.deferred.splice(0)) {
          if (active.terminal) break;
          if ("notification" in callback) this.handleNotification(client, callback.notification);
          else this.handleRequest(client, callback.request);
        }
      }
    } catch (error) {
      this.failStart(active, "turn_start_failed", error);
    }
    return completion;
  }

  private failStart(active: ActiveTurn, subtype: string, error: unknown): void {
    if (active.terminal) return;
    const message = error instanceof Error ? error.message : String(error);
    this.emit(active, { kind: "turn_failed", subtype, errors: [truncate(message, MAX_OUTPUT_BYTES)] });
    this.finish(active, { status: "failed", ...(active.threadId ? { providerSessionId: active.threadId } : {}), error: message });
  }

  async interrupt(reason = "user_interrupt"): Promise<"accepted" | "already_terminal" | "unavailable"> {
    const active = this.active;
    if (!active) return "unavailable";
    if (active.terminal) return "already_terminal";
    if (!active.codexTurnId) await waitFor(() => active.codexTurnId !== undefined || active.terminal, 2_000);
    if (!active.codexTurnId || !this.client || active.terminal) return active.terminal ? "already_terminal" : "unavailable";
    active.interruptRequested = true;
    try {
      await this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.codexTurnId }, 10_000);
      if (active.terminal || this.active !== active) return "already_terminal";
      active.interruptTimer = setTimeout(() => {
        if (this.active !== active || active.terminal) return;
        this.emit(active, { kind: "diagnostic", code: "INTERRUPT_UNCONFIRMED", message: `Codex did not report a terminal state after interrupt`, details: { reason } });
        this.finish(active, { status: "outcome_unknown", providerSessionId: active.threadId, error: "Codex interrupt was not confirmed" });
      }, INTERRUPT_CONFIRM_TIMEOUT_MS);
      return "accepted";
    } catch (error) {
      this.emit(active, { kind: "diagnostic", code: "INTERRUPT_FAILED", message: error instanceof Error ? error.message : String(error) });
      return "unavailable";
    }
  }

  respondApproval(approvalId: string, action: ApprovalAction): boolean {
    const active = this.active;
    const pending = active?.pending.get(approvalId);
    if (!active || !pending || !this.client) return false;
    if (!this.client.respond(pending.rpcId, { decision: action === "allow_once" ? "accept" : "decline" })) return false;
    active.pending.delete(approvalId);
    active.pendingByRpcId.delete(rpcIdKey(pending.rpcId));
    this.emit(active, { kind: "approval_resolved", approvalId, toolUseId: pending.toolUseId, action });
    return true;
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
    this.runtimePolicyPromise = undefined;
    this.loadedThreadId = undefined;
    this.unexpectedMcpThreads.clear();
    this.observedRequestIds.clear();
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) {
      await this.client.start();
      return this.client;
    }
    let client!: AppServerClient;
    client = this.clientFactory({
      onNotification: (notification) => this.handleNotification(client, notification),
      onRequest: (request) => this.handleRequest(client, request),
      onExit: (error) => this.handleExit(client, error),
    });
    this.client = client;
    this.observedRequestIds.clear();
    try {
      await client.start();
      return client;
    } catch (error) {
      if (this.client === client) this.client = undefined;
      client.close();
      throw error;
    }
  }

  private async loadThread(client: AppServerClient, resumeSessionId?: string): Promise<string> {
    if (resumeSessionId && this.loadedThreadId === resumeSessionId) return resumeSessionId;
    const config = await this.ensureRuntimePolicy(client);
    const common = {
      cwd: this.workspace,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      config,
      ...(this.model ? { model: this.model } : {}),
    };
    const response = resumeSessionId
      ? await client.request<JsonObject>("thread/resume", { threadId: resumeSessionId, ...common })
      : await client.request<JsonObject>("thread/start", common);
    const thread = isRecord(response.thread) ? response.thread : {};
    if (typeof thread.id !== "string" || !thread.id) throw new Error("Codex app-server returned no thread id");
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const unexpectedMcp = this.unexpectedMcpThreads.get(thread.id);
    if (unexpectedMcp) {
      this.unexpectedMcpThreads.delete(thread.id);
      if (this.client === client) this.client = undefined;
      this.runtimePolicyPromise = undefined;
      this.loadedThreadId = undefined;
      client.close();
      throw new Error(`CODEX_SECURITY_POLICY_FAILED: unexpected MCP server started (${unexpectedMcp})`);
    }
    this.loadedThreadId = thread.id;
    return thread.id;
  }

  private ensureRuntimePolicy(client: AppServerClient): Promise<JsonObject> {
    if (!this.runtimePolicyPromise) {
      const pending = this.discoverRuntimePolicy(client);
      this.runtimePolicyPromise = pending;
      void pending.catch(() => {
        if (this.runtimePolicyPromise === pending) this.runtimePolicyPromise = undefined;
      });
    }
    return this.runtimePolicyPromise;
  }

  private async discoverRuntimePolicy(client: AppServerClient): Promise<JsonObject> {
    const response = await client.request<JsonObject>("config/read", { cwd: this.workspace, includeLayers: false }, 15_000);
    if (!isRecord(response.config)) throw new Error("CODEX_POLICY_DISCOVERY_FAILED: config/read returned no config");
    const mcpServers = disabledIntegrationMap(response.config.mcp_servers, "MCP server");
    const plugins = disabledIntegrationMap(response.config.plugins, "plugin");
    return {
      web_search: "disabled",
      notify: [],
      allow_login_shell: false,
      include_apps_instructions: false,
      include_collaboration_mode_instructions: false,
      agents: { enabled: false },
      features: {
        apps: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        computer_use: false,
        goals: false,
        hooks: false,
        js_repl: false,
        memories: false,
        multi_agent: false,
        plugins: false,
        remote_control: false,
        remote_plugin: false,
        shell_snapshot: false,
        skill_mcp_dependency_install: false,
        tool_suggest: false,
        workspace_dependencies: false,
      },
      mcp_servers: mcpServers,
      plugins,
      shell_environment_policy: {
        inherit: "core",
        ignore_default_excludes: false,
        filters: {
          HOME: "include",
          LANG: "include",
          LC_ALL: "include",
          LC_CTYPE: "include",
          LOGNAME: "include",
          PATH: "include",
          SHELL: "include",
          TEMP: "include",
          TERM: "include",
          TMP: "include",
          TMPDIR: "include",
          USER: "include",
        },
      },
      tools: { view_image: false, web_search: false },
    };
  }

  private handleNotification(client: AppServerClient, notification: AppServerNotification): void {
    if (this.client !== client) return;
    if (notification.method === "mcpServer/startupStatus/updated") {
      const threadId = stringValue(notification.params.threadId, "unknown-thread");
      const name = stringValue(notification.params.name, "unknown-MCP");
      const status = stringValue(notification.params.status, "unknown");
      if (status === "starting" || status === "ready") {
        this.unexpectedMcpThreads.set(threadId, name);
        const active = this.active;
        if (active?.threadId === threadId && !active.terminal) {
          this.unexpectedMcpThreads.delete(threadId);
          this.emit(active, { kind: "diagnostic", code: "CODEX_SECURITY_POLICY_FAILED", message: `Unexpected MCP server started: ${name}` });
          this.finish(active, {
            status: "outcome_unknown",
            providerSessionId: active.threadId,
            error: `Codex security policy failed: unexpected MCP server ${name}`,
          });
          const client = this.client;
          this.client = undefined;
          this.runtimePolicyPromise = undefined;
          this.loadedThreadId = undefined;
          client?.close();
        }
      }
      return;
    }
    const active = this.active;
    if (!active || active.client !== client || active.terminal) return;
    const { method, params } = notification;
    // A resumed thread is shared by many Turns. Bind callbacks using the
    // native Turn returned by this dispatch, including nested terminal IDs.
    const turn = isRecord(params.turn) ? params.turn : {};
    const nativeTurnId = typeof params.turnId === "string" ? params.turnId : typeof turn.id === "string" ? turn.id : undefined;
    if (params.threadId !== active.threadId) return;
    if (method === "serverRequest/resolved") {
      if (nativeTurnId !== undefined && nativeTurnId !== active.codexTurnId) return;
      // A request ID is a native fence only while it has one known origin
      // on this client. Reused IDs require an explicit native Turn ID.
      if (nativeTurnId === undefined && !active.unambiguousRequestIds.has(rpcIdKey(params.requestId))) return;
    } else {
      if (!nativeTurnId) return;
      if (active.starting && !active.codexTurnId) {
        this.deferCallback(active, { notification });
        return;
      }
      if (nativeTurnId !== active.codexTurnId) return;
    }
    if (method === "turn/started") return;
    if (method === "item/agentMessage/delta") {
      const itemId = stringValue(params.itemId, `assistant-${active.turnId}`);
      const delta = stringValue(params.delta, "");
      if (!delta) return;
      const appended = appendWithinLimit(active.assistantText.get(itemId) ?? "", delta, MAX_MESSAGE_BYTES);
      active.assistantText.set(itemId, appended.next);
      if (appended.text) this.emit(active, { kind: "assistant_delta", itemId, text: appended.text });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = stringValue(params.itemId, `tool-${active.turnId}`);
      const delta = stringValue(params.delta, "");
      const output = truncate((active.toolOutput.get(itemId) ?? "") + delta, MAX_OUTPUT_BYTES);
      active.toolOutput.set(itemId, output);
      if (delta) this.emit(active, { kind: "tool_progress", itemId, toolUseId: itemId, output });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params.item) ? params.item : {};
      this.handleItem(active, item, method === "item/completed");
      return;
    }
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return;
      const approvalId = active.pendingByRpcId.get(rpcIdKey(requestId));
      if (!approvalId) return;
      const pending = active.pending.get(approvalId);
      active.pending.delete(approvalId);
      active.pendingByRpcId.delete(rpcIdKey(requestId));
      if (pending) this.emit(active, { kind: "approval_resolved", approvalId, toolUseId: pending.toolUseId, action: "aborted" });
      return;
    }
    if (method === "error") {
      const error = isRecord(params.error) ? params.error : {};
      const message = truncate(stringValue(error.message, "Codex turn error"), MAX_OUTPUT_BYTES);
      if (params.willRetry !== true) active.errors.push(message);
      this.emit(active, { kind: "diagnostic", code: "CODEX_TURN_ERROR", message, details: { willRetry: params.willRetry === true } });
      return;
    }
    if (method === "turn/completed") this.handleTurnCompleted(active, params);
  }

  private handleItem(active: ActiveTurn, item: JsonObject, completed: boolean): void {
    const id = stringValue(item.id, `item-${active.turnId}`);
    const type = stringValue(item.type, "unknown");
    if (FORBIDDEN_ITEM_TYPES.has(type)) {
      this.emit(active, { kind: "diagnostic", code: "CODEX_SECURITY_POLICY_FAILED", message: `Forbidden Codex item type: ${type}` });
      this.finish(active, {
        status: "outcome_unknown",
        providerSessionId: active.threadId,
        error: `Codex security policy failed: forbidden item type ${type}`,
      });
      const client = this.client;
      this.client = undefined;
      this.runtimePolicyPromise = undefined;
      this.loadedThreadId = undefined;
      client?.close();
      return;
    }
    active.items.set(id, item);
    if (type === "agentMessage") {
      if (!completed) return;
      const text = truncate(stringValue(item.text, active.assistantText.get(id) ?? ""), MAX_MESSAGE_BYTES);
      active.assistantText.set(id, text);
      active.lastAssistantText = text;
      this.emit(active, { kind: "assistant_message", itemId: id, text });
      return;
    }
    if (type === "plan") {
      if (completed) this.emit(active, { kind: "assistant_message", itemId: `plan-${id}`, text: truncate(stringValue(item.text, ""), MAX_MESSAGE_BYTES) });
      return;
    }
    const descriptor = toolDescriptor(type, item, this.workspace);
    if (!descriptor) return;
    if (!completed) {
      this.emit(active, { kind: "tool_started", itemId: id, toolUseId: id, toolName: descriptor.name, input: descriptor.input });
      return;
    }
    const status = stringValue(item.status, "completed");
    const output = descriptor.output;
    if (status === "failed" || status === "declined") {
      this.emit(active, { kind: "tool_completed", itemId: id, toolUseId: id, error: truncate(output || status, MAX_OUTPUT_BYTES) });
    } else {
      this.emit(active, { kind: "tool_completed", itemId: id, toolUseId: id, ...(output ? { output: truncate(output, MAX_OUTPUT_BYTES) } : {}) });
    }
  }

  private handleRequest(client: AppServerClient, request: AppServerRequest): void {
    if (this.client !== client) return;
    const active = this.active;
    if (active && active.client === client && !active.terminal && active.starting && !active.codexTurnId
      && request.params.threadId === active.threadId && typeof request.params.turnId === "string") {
      this.deferCallback(active, { request });
      return;
    }
    if (!active || active.client !== client || active.terminal || request.params.threadId !== active.threadId
      || !active.codexTurnId || request.params.turnId !== active.codexTurnId) {
      client.respondError(request.id, -32602, "No matching active Flyx turn");
      return;
    }
    if (request.method !== "item/commandExecution/requestApproval" && request.method !== "item/fileChange/requestApproval") {
      this.client?.respondError(request.id, -32601, "Flyx MVP does not support this interactive request");
      this.emit(active, { kind: "diagnostic", code: "UNSUPPORTED_CODEX_REQUEST", message: `Unsupported Codex request: ${request.method}` });
      return;
    }
    const toolUseId = stringValue(request.params.itemId, `codex-request-${String(request.id)}`);
    const rawApprovalId = typeof request.params.approvalId === "string" ? request.params.approvalId : String(request.id);
    const approvalId = `codex-${createHash("sha256").update(`${active.turnId}:${rawApprovalId}`).digest("hex")}`;
    if (active.pending.has(approvalId)) return;
    const isCommand = request.method.includes("commandExecution");
    const sourceItem = active.items.get(toolUseId);
    if (!approvalRequestIsInsideWorkspace(request.params, sourceItem, this.workspace)) {
      this.client?.respond(request.id, { decision: "decline" });
      this.emit(active, { kind: "diagnostic", code: "CODEX_APPROVAL_OUTSIDE_WORKSPACE", message: "Codex requested access outside the configured workspace" });
      return;
    }
    const rawInput = isCommand
      ? {
        command: sanitizeText(stringValue(request.params.command, ""), this.workspace),
        cwd: sanitizePath(stringValue(request.params.cwd, this.workspace), this.workspace),
        ...(Array.isArray(request.params.commandActions) ? { commandActions: sanitizeValue(request.params.commandActions, this.workspace) } : {}),
      }
      : {
        changes: sourceItem && Array.isArray(sourceItem.changes)
          ? sanitizeValue(sourceItem.changes, this.workspace)
          : "Review the proposed file changes in the Timeline",
        ...(request.params.grantRoot ? { grantRoot: sanitizePath(String(request.params.grantRoot), this.workspace) } : {}),
      };
    const requestInput = boundedRecord(rawInput, MAX_OUTPUT_BYTES);
    const approval: ApprovalRequest = {
      approvalId,
      turnId: active.turnId,
      toolUseId,
      toolName: isCommand ? "Bash" : "ApplyPatch",
      input: requestInput,
      title: isCommand ? "Allow Codex command?" : "Allow Codex file changes?",
      ...(typeof request.params.reason === "string" ? { description: truncate(request.params.reason, 4 * 1024) } : {}),
      cwd: ".",
      createdAt: new Date().toISOString(),
    };
    const requestKey = rpcIdKey(request.id);
    if (!this.observedRequestIds.has(requestKey) && this.observedRequestIds.size < MAX_TRACKED_REQUEST_IDS) {
      this.observedRequestIds.add(requestKey);
      active.unambiguousRequestIds.add(requestKey);
    }
    active.pending.set(approvalId, { rpcId: request.id, toolUseId });
    active.pendingByRpcId.set(requestKey, approvalId);
    this.emit(active, { kind: "approval_requested", request: approval });
  }

  private handleTurnCompleted(active: ActiveTurn, params: JsonObject): void {
    if (active.terminal) return;
    const turn = isRecord(params.turn) ? params.turn : {};
    const status = stringValue(turn.status, "failed");
    if (status === "completed") {
      const result = active.lastAssistantText || "Codex turn completed";
      this.emit(active, { kind: "turn_completed", result, costUsd: 0, numTurns: 1, terminalReason: status });
      this.finish(active, { status: "completed", providerSessionId: active.threadId });
      return;
    }
    if (status === "interrupted") {
      this.emit(active, { kind: "turn_cancelled", reason: active.interruptRequested ? "interrupt_confirmed" : "codex_interrupted" });
      this.finish(active, { status: "cancelled", providerSessionId: active.threadId });
      return;
    }
    const turnError = isRecord(turn.error) ? turn.error : {};
    const message = stringValue(turnError.message, active.errors.join("; ") || `Codex turn ended with status ${status}`);
    this.emit(active, { kind: "turn_failed", subtype: stringValue(turnError.codexErrorInfo, "codex_failed"), errors: [truncate(message, MAX_OUTPUT_BYTES)], terminalReason: status });
    this.finish(active, { status: "failed", providerSessionId: active.threadId, error: message });
  }

  private handleExit(client: AppServerClient, error: Error): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.runtimePolicyPromise = undefined;
    this.loadedThreadId = undefined;
    this.unexpectedMcpThreads.clear();
    const active = this.active;
    if (!active || active.terminal || !active.starting && !active.codexTurnId) return;
    this.emit(active, { kind: "diagnostic", code: "CODEX_APP_SERVER_EXITED", message: truncate(error.message, MAX_OUTPUT_BYTES) });
    this.finish(active, { status: "outcome_unknown", providerSessionId: active.threadId, error: error.message });
  }

  private async timeoutTurn(active: ActiveTurn): Promise<void> {
    if (this.active !== active || active.terminal) return;
    const interrupted = await this.interrupt("turn_timeout");
    if (interrupted === "accepted" || this.active !== active || active.terminal) return;
    this.emit(active, { kind: "diagnostic", code: "TURN_TIMEOUT", message: "Codex turn timed out and could not be interrupted" });
    this.finish(active, { status: "outcome_unknown", providerSessionId: active.threadId, error: "Codex turn timed out" });
  }

  private finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (active.terminal) return;
    active.terminal = true;
    if (active.timer) clearTimeout(active.timer);
    if (active.interruptTimer) clearTimeout(active.interruptTimer);
    for (const [approvalId, pending] of active.pending) {
      this.emit(active, { kind: "approval_resolved", approvalId, toolUseId: pending.toolUseId, action: "aborted" });
    }
    active.pending.clear();
    active.pendingByRpcId.clear();
    active.unambiguousRequestIds.clear();
    active.deferred.length = 0;
    if (this.active === active) this.active = undefined;
    active.resolve(outcome);
  }

  private deferCallback(active: ActiveTurn, callback: ActiveTurn["deferred"][number]): void {
    if (active.deferred.length >= 1024) {
      this.emit(active, { kind: "diagnostic", code: "CODEX_NATIVE_BINDING_OVERFLOW", message: "Codex did not bind a native Turn before its callback buffer filled" });
      this.finish(active, { status: "outcome_unknown", providerSessionId: active.threadId, error: "Codex native Turn binding was not confirmed" });
      return;
    }
    active.deferred.push(callback);
  }

  private emit(active: ActiveTurn, event: AdapterEventPayload): void {
    this.onEvent?.(fenceAdapterEvent(active.context, event));
  }

}

function toolDescriptor(type: string, item: JsonObject, workspace: string): { name: string; input: JsonObject; output: string } | undefined {
  if (type === "commandExecution") {
    return {
      name: "Bash",
      input: boundedRecord({
        command: sanitizeText(stringValue(item.command, ""), workspace),
        cwd: sanitizePath(stringValue(item.cwd, workspace), workspace),
      }, MAX_OUTPUT_BYTES),
      output: stringValue(item.aggregatedOutput, ""),
    };
  }
  if (type === "fileChange") {
    const changes = sanitizeValue(Array.isArray(item.changes) ? item.changes : [], workspace);
    return { name: "ApplyPatch", input: boundedRecord({ changes }, MAX_OUTPUT_BYTES), output: JSON.stringify(changes) };
  }
  if (type === "contextCompaction") return { name: "ContextCompaction", input: {}, output: "Context compacted" };
  return undefined;
}

function parseEffort(value: string | undefined): CodexAdapterOptions["effort"] {
  if (value === undefined || value === "") return undefined;
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) {
    return value as NonNullable<CodexAdapterOptions["effort"]>;
  }
  throw new Error(`FLYX_CODEX_EFFORT is invalid: ${value}`);
}

function approvalRequestIsInsideWorkspace(params: JsonObject, item: JsonObject | undefined, workspace: string): boolean {
  const candidates: string[] = [];
  if (typeof params.cwd === "string") candidates.push(params.cwd);
  if (typeof params.grantRoot === "string") candidates.push(params.grantRoot);
  collectPathFields(params.commandActions, candidates);
  collectPathFields(item?.changes, candidates);
  return candidates.every((candidate) => {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workspace, candidate);
    const relativePath = relative(workspace, absolute);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function collectPathFields(value: unknown, output: string[], depth = 0): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPathFields(item, output, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (["path", "cwd", "file_path", "grantRoot"].includes(key) && typeof item === "string") output.push(item);
    else collectPathFields(item, output, depth + 1);
  }
}

function boundedRecord(value: JsonObject, maxBytes: number): JsonObject {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return value;
  return { truncated: true, preview: truncate(encoded, maxBytes) };
}

function disabledIntegrationMap(value: unknown, label: string): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error(`CODEX_POLICY_DISCOVERY_FAILED: ${label} configuration is invalid`);
  const entries = Object.entries(value);
  if (entries.length > MAX_DISCOVERED_INTEGRATIONS) {
    throw new Error(`CODEX_POLICY_DISCOVERY_FAILED: too many configured ${label}s`);
  }
  return Object.fromEntries(entries.map(([name, config]) => {
    if (!name || Buffer.byteLength(name, "utf8") > 512 || !isRecord(config)) {
      throw new Error(`CODEX_POLICY_DISCOVERY_FAILED: invalid ${label} entry`);
    }
    return [name, { enabled: false }];
  }));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "TERM",
    "CODEX_HOME", "OPENAI_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function sanitizeValue(value: unknown, workspace: string, key?: string, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    if (key && ["path", "cwd", "file_path", "directory"].includes(key)) return sanitizePath(value, workspace);
    return sanitizeText(value, workspace);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, workspace, key, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeValue(entryValue, workspace, entryKey, depth + 1)]));
}

function sanitizePath(value: string, workspace: string): string {
  if (!isAbsolute(value)) return value;
  const relativePath = relative(workspace, resolve(value));
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? "[outside workspace]" : relativePath || ".";
}

function sanitizeText(value: string, workspace: string): string {
  return value.split(workspace).join(".");
}

function appendWithinLimit(current: string, delta: string, maxBytes: number): { next: string; text: string } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBytes) return { next: current, text: "" };
  if (currentBytes + Buffer.byteLength(delta, "utf8") <= maxBytes) return { next: current + delta, text: delta };
  const marker = "… [assistant message truncated]";
  const room = Math.max(0, maxBytes - currentBytes - Buffer.byteLength(marker, "utf8"));
  const visible = takeUtf8(delta, room);
  return { next: current + visible + marker, text: visible + marker };
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${takeUtf8(value, Math.max(0, maxBytes - 20))}… [truncated]`;
}

function takeUtf8(value: string, maxBytes: number): string {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcIdKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}
