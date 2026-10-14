import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { CodexAdapter } from "./adapter.js";
import type {
  AppServerClient,
  AppServerClientHandlers,
  AppServerNotification,
  AppServerRequest,
  JsonObject,
  JsonRpcId,
} from "./app-server-client.js";
import type { AdapterEvent } from "../provider/types.js";

class FakeAppServerClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: JsonObject }> = [];
  readonly responses: Array<{ id: JsonRpcId; result?: JsonObject; error?: { code: number; message: string } }> = [];
  closed = false;

  constructor(readonly handlers: AppServerClientHandlers) {}

  async start(): Promise<void> {}

  async request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          mcp_servers: { "fixture-mcp": { command: "fixture", enabled: true } },
          plugins: { "fixture-plugin@example": { enabled: true } },
        },
      } as T;
    }
    if (method === "account/read") return { account: { type: "chatgpt" }, requiresOpenaiAuth: true } as T;
    if (method === "thread/start") return { thread: { id: "codex-thread-new" } } as T;
    if (method === "thread/resume") return { thread: { id: params.threadId } } as T;
    if (method === "turn/start") return { turn: { id: "codex-turn-1", status: "inProgress", items: [] } } as T;
    return {} as T;
  }

  notify(): void {}

  respond(id: JsonRpcId, result: JsonObject): boolean {
    this.responses.push({ id, result });
    return true;
  }

  respondError(id: JsonRpcId, code: number, message: string): boolean {
    this.responses.push({ id, error: { code, message } });
    return true;
  }

  close(): void { this.closed = true; }

  notification(method: string, params: JsonObject): void {
    const notification: AppServerNotification = { method, params };
    this.handlers.onNotification(notification);
  }

  serverRequest(id: JsonRpcId, method: string, params: JsonObject): void {
    const request: AppServerRequest = { id, method, params };
    this.handlers.onRequest(request);
  }

  exit(message = "fake app-server exited"): void {
    this.handlers.onExit(new Error(message));
  }
}

const adapters: CodexAdapter[] = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.close();
});

function setup() {
  const events: AdapterEvent[] = [];
  let client: FakeAppServerClient | undefined;
  const adapter = new CodexAdapter({
    workspace: resolve(process.cwd(), "../../packages/claude-fixtures"),
    executable: process.execPath,
    onEvent: (event) => events.push(event),
    clientFactory: (handlers) => {
      client = new FakeAppServerClient(handlers);
      return client;
    },
  });
  adapters.push(adapter);
  return { adapter, events, get client() { return client!; } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("condition was not reached");
}

describe("CodexAdapter", () => {
  it("preflights the executable, app-server handshake and local account", async () => {
    const state = setup();
    const status = await state.adapter.preflight();
    expect(status).toMatchObject({ provider: "codex", transport: "codex-app-server", executable: process.execPath });
    expect(status.runtimeVersion).toContain("v");
    expect(state.client.requests.map((request) => request.method)).toContain("config/read");
    expect(state.client.requests.map((request) => request.method)).toContain("account/read");
  });

  it("applies a fail-closed minimal-tool policy to new Codex threads", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-policy", "inspect the project");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    const methods = state.client.requests.map((request) => request.method);
    expect(methods.indexOf("config/read")).toBeLessThan(methods.indexOf("thread/start"));
    const params = state.client.requests.find((request) => request.method === "thread/start")!.params;
    expect(params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      config: {
        allow_login_shell: false,
        web_search: "disabled",
        agents: { enabled: false },
        features: { apps: false, multi_agent: false, plugins: false, computer_use: false },
        mcp_servers: { "fixture-mcp": { enabled: false } },
        plugins: { "fixture-plugin@example": { enabled: false } },
        tools: { view_image: false, web_search: false },
      },
    });
    const sessionInit = state.events.find((event) => event.kind === "session_init");
    expect(sessionInit).toMatchObject({ kind: "session_init", tools: ["commandExecution", "fileChange"] });
    state.client.notification("turn/completed", {
      threadId: "codex-thread-new",
      turn: { id: "codex-turn-1", status: "completed", items: [] },
    });
    await expect(outcomePromise).resolves.toMatchObject({ status: "completed" });
  });

  it("maps a streamed turn and tool lifecycle into provider-neutral events", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-1", "run tests");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    const scope = { threadId: "codex-thread-new", turnId: "codex-turn-1" };
    state.client.notification("item/started", {
      ...scope,
      startedAtMs: Date.now(),
      item: { type: "commandExecution", id: "command-1", command: "pnpm test", cwd: state.adapter.workspace, status: "inProgress" },
    });
    state.client.notification("item/commandExecution/outputDelta", { ...scope, itemId: "command-1", delta: "tests running" });
    state.client.notification("item/completed", {
      ...scope,
      startedAtMs: Date.now(),
      item: { type: "commandExecution", id: "command-1", command: "pnpm test", cwd: state.adapter.workspace, status: "completed", aggregatedOutput: "all passed", exitCode: 0 },
    });
    state.client.notification("item/agentMessage/delta", { ...scope, itemId: "answer-1", delta: "done" });
    state.client.notification("item/completed", { ...scope, startedAtMs: Date.now(), item: { type: "agentMessage", id: "answer-1", text: "done" } });
    state.client.notification("turn/completed", { threadId: scope.threadId, turn: { id: scope.turnId, status: "completed", items: [] } });

    await expect(outcomePromise).resolves.toEqual({ status: "completed", providerSessionId: "codex-thread-new" });
    expect(state.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session_init", provider: "codex", providerSessionId: "codex-thread-new" }),
      expect.objectContaining({ kind: "tool_started", toolName: "Bash" }),
      expect.objectContaining({ kind: "tool_progress", output: "tests running" }),
      expect.objectContaining({ kind: "tool_completed", output: "all passed" }),
      expect.objectContaining({ kind: "assistant_delta", text: "done" }),
      expect.objectContaining({ kind: "assistant_message", text: "done" }),
      expect.objectContaining({ kind: "turn_completed", result: "done" }),
    ]));
  });

  it("round-trips command approval decisions to the originating JSON-RPC request", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-approval", "install dependency");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    state.client.serverRequest(77, "item/commandExecution/requestApproval", {
      threadId: "codex-thread-new",
      turnId: "codex-turn-1",
      itemId: "command-approval",
      startedAtMs: Date.now(),
      command: "pnpm install",
      cwd: state.adapter.workspace,
      reason: "dependency install",
    });
    const approval = state.events.find((event): event is Extract<AdapterEvent, { kind: "approval_requested" }> => event.kind === "approval_requested");
    expect(approval?.request).toMatchObject({ toolName: "Bash", toolUseId: "command-approval" });
    expect(state.adapter.respondApproval(approval!.request.approvalId, "allow_once")).toBe(true);
    expect(state.client.responses).toContainEqual({ id: 77, result: { decision: "accept" } });

    state.client.notification("turn/completed", { threadId: "codex-thread-new", turn: { id: "codex-turn-1", status: "completed", items: [] } });
    await expect(outcomePromise).resolves.toMatchObject({ status: "completed" });
  });

  it("declines an approval that targets a path outside the configured workspace", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-outside", "write outside");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    state.client.serverRequest(78, "item/commandExecution/requestApproval", {
      threadId: "codex-thread-new",
      turnId: "codex-turn-1",
      itemId: "command-outside",
      startedAtMs: Date.now(),
      command: "touch /tmp/not-allowed",
      cwd: "/tmp",
    });
    expect(state.client.responses).toContainEqual({ id: 78, result: { decision: "decline" } });
    expect(state.events.some((event) => event.kind === "approval_requested")).toBe(false);
    expect(state.events).toContainEqual(expect.objectContaining({ kind: "diagnostic", code: "CODEX_APPROVAL_OUTSIDE_WORKSPACE" }));
    state.client.notification("turn/completed", { threadId: "codex-thread-new", turn: { id: "codex-turn-1", status: "failed", error: { message: "declined" }, items: [] } });
    await expect(outcomePromise).resolves.toMatchObject({ status: "failed" });
  });

  it("resumes a persisted thread and confirms interruption at turn/completed", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-resume", "continue", "persisted-thread");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    expect(state.client.requests.find((request) => request.method === "thread/resume")?.params.threadId).toBe("persisted-thread");
    await expect(state.adapter.interrupt()).resolves.toBe("accepted");
    expect(state.client.requests).toContainEqual({ method: "turn/interrupt", params: { threadId: "persisted-thread", turnId: "codex-turn-1" } });
    state.client.notification("turn/completed", { threadId: "persisted-thread", turn: { id: "codex-turn-1", status: "interrupted", items: [] } });
    await expect(outcomePromise).resolves.toEqual({ status: "cancelled", providerSessionId: "persisted-thread" });
  });

  it("marks an active turn outcome unknown if app-server exits before a terminal event", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-crash", "keep working");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    state.client.exit("simulated crash");
    await expect(outcomePromise).resolves.toEqual({ status: "outcome_unknown", providerSessionId: "codex-thread-new", error: "simulated crash" });
    expect(state.events).toContainEqual(expect.objectContaining({ kind: "diagnostic", code: "CODEX_APP_SERVER_EXITED" }));
  });

  it("contains an unexpected MCP server at runtime and marks the outcome unknown", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-mcp-violation", "inspect the project");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    state.client.notification("mcpServer/startupStatus/updated", {
      threadId: "codex-thread-new",
      name: "unexpected-server",
      status: "starting",
    });
    await expect(outcomePromise).resolves.toEqual({
      status: "outcome_unknown",
      providerSessionId: "codex-thread-new",
      error: "Codex security policy failed: unexpected MCP server unexpected-server",
    });
    expect(state.client.closed).toBe(true);
    expect(state.events).toContainEqual(expect.objectContaining({ kind: "diagnostic", code: "CODEX_SECURITY_POLICY_FAILED" }));
  });
});
