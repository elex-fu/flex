import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { AdapterEvent, DispatchContext } from "../provider/types.js";

class FakeAppServerClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: JsonObject }> = [];
  readonly responses: Array<{ id: JsonRpcId; result?: JsonObject; error?: { code: number; message: string } }> = [];
  closed = false;
  nativeTurnSequence = 0;
  readonly failures = new Map<string, number>();
  turnStart: (() => Promise<JsonObject>) | undefined;

  constructor(readonly handlers: AppServerClientHandlers, readonly startClient: () => void = () => {}) {}

  async start(): Promise<void> { this.startClient(); }

  async request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    this.requests.push({ method, params });
    const failures = this.failures.get(method) ?? 0;
    if (failures > 0) {
      this.failures.set(method, failures - 1);
      throw new Error(`injected ${method} failure`);
    }
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
    if (method === "turn/start") {
      if (this.turnStart) return await this.turnStart() as T;
      return { turn: { id: `codex-turn-${++this.nativeTurnSequence}`, status: "inProgress", items: [] } } as T;
    }
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

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }

const adapters: CodexAdapter[] = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.close();
});

function setup(options: { startFailures?: number; requestFailure?: string; rotateClientEachTurn?: boolean; onClient?: (client: FakeAppServerClient) => void; onEvent?: (event: AdapterEvent) => void } = {}) {
  const events: AdapterEvent[] = [];
  let client: FakeAppServerClient | undefined;
  let startFailures = options.startFailures ?? 0;
  const adapter = new CodexAdapter({
    workspace: resolve(process.cwd(), "../../packages/claude-fixtures"),
    executable: process.execPath,
    ...(options.rotateClientEachTurn !== undefined ? { rotateClientEachTurn: options.rotateClientEachTurn } : {}),
    onEvent: (event) => { events.push(event); options.onEvent?.(event); },
    clientFactory: (handlers) => {
      client = new FakeAppServerClient(handlers, () => {
        if (startFailures > 0) { startFailures -= 1; throw new Error("injected client startup failure"); }
      });
      if (options.requestFailure) client.failures.set(options.requestFailure, 1);
      options.onClient?.(client);
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
  it("keeps a malformed possible-send turn/start reply unknown without a fake terminal", async () => {
    const requested = deferred<void>(); const response = deferred<JsonObject>();
    const state = setup({ onClient: (client) => { client.turnStart = () => { requested.resolve(); return response.promise; }; } });
    const turn = state.adapter.runTurn("malformed-turn", "task"); await requested.promise; response.resolve({ turn: { status: "inProgress" } });
    expect(await turn).toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } }); expect(state.events.some((event) => event.kind === "turn_failed")).toBe(false);
  });
  it("quiesces per-attempt clients before returning native terminal and resumes on a new client", async () => {
    const stop = deferred<import("../lifecycle/managed-process-registry.js").ProcessStopResult>(); const stopping = deferred<void>();
    const firstBound = deferred<void>(); const nextBound = deferred<void>(); let original: FakeAppServerClient | undefined;
    const state = setup({ rotateClientEachTurn: true,
      onClient: (client) => { if (!original) { original = client; Object.assign(client, { closeAndWait: vi.fn(() => { client.closed = true; stopping.resolve(); return stop.promise; }) }); } },
      onEvent: (event) => { if (event.kind === "native_binding") (event.turnId === "first-managed-turn" ? firstBound : nextBound).resolve(); },
    });
    const first = state.adapter.runTurn("first-managed-turn", "task", undefined, context("first-managed-turn", 51)); await firstBound.promise;
    let finished = false; void first.then(() => { finished = true; }); complete(original!, "codex-turn-1"); await stopping.promise; expect(finished).toBe(false);
    expect(state.events.some((event) => event.kind === "turn_completed" && event.turnId === "first-managed-turn")).toBe(false);
    stop.resolve({ stopped: true, treeStopped: true, records: [] }); expect(await first).toMatchObject({ status: "completed", evidence: { kind: "native-terminal" } });
    const next = state.adapter.runTurn("second-managed-turn", "continue", "codex-thread-new", context("second-managed-turn", 52)); await nextBound.promise;
    expect(state.client).not.toBe(original); expect(state.client.requests.find((request) => request.method === "thread/resume")?.params.threadId).toBe("codex-thread-new");
    complete(original!, "codex-turn-1", "stale"); complete(state.client, "codex-turn-1", "new"); expect(await next).toMatchObject({ status: "completed" }); expect(state.events.find((event) => event.kind === "assistant_message" && event.turnId === "second-managed-turn")).toMatchObject({ text: "new" });
  });
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

    await expect(outcomePromise).resolves.toMatchObject({ status: "completed", providerSessionId: "codex-thread-new" });
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
    await expect(outcomePromise).resolves.toMatchObject({ status: "cancelled", providerSessionId: "persisted-thread" });
  });

  it("marks an active turn outcome unknown if app-server exits before a terminal event", async () => {
    const state = setup();
    const outcomePromise = state.adapter.runTurn("flyx-turn-crash", "keep working");
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    state.client.exit("simulated crash");
    await expect(outcomePromise).resolves.toMatchObject({ status: "outcome_unknown", providerSessionId: "codex-thread-new", error: "simulated crash" });
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
    await expect(outcomePromise).resolves.toMatchObject({
      status: "outcome_unknown",
      providerSessionId: "codex-thread-new",
      error: "Codex security policy failed: unexpected MCP server unexpected-server",
    });
    expect(state.client.closed).toBe(true);
    expect(state.events).toContainEqual(expect.objectContaining({ kind: "diagnostic", code: "CODEX_SECURITY_POLICY_FAILED" }));
  });
});

function context(turnId: string, generation: number): DispatchContext {
  return { hostOwnerId: "test-owner", hostOwnerGeneration: 7, sessionId: "flyx-session", flyxTurnId: turnId,
    runtimeId: "test-runtime", runtimeGeneration: generation, attemptId: `attempt-${generation}` };
}

function complete(client: FakeAppServerClient, turnId: string, text = "complete", threadId = "codex-thread-new"): void {
  const scope = { threadId, turnId };
  client.notification("item/agentMessage/delta", { ...scope, itemId: "reused-item", delta: text });
  client.notification("item/completed", { ...scope, item: { type: "agentMessage", id: "reused-item", text } });
  client.notification("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
}

describe("Codex Engine dispatch fence", () => {
  it.each(["client", "thread", "turn"])("fences %s preparation/start failure and the next successful streamed Turn", async (stage) => {
    const state = setup(stage === "client" ? { startFailures: 1 } : { requestFailure: stage === "thread" ? "thread/start" : "turn/start" });
    const firstContext = context("failed-turn", 41);
    await expect(state.adapter.runTurn(firstContext.flyxTurnId, "first", undefined, firstContext)).resolves.toMatchObject({ status: stage === "turn" ? "outcome_unknown" : "failed", evidence: { kind: stage === "turn" ? "unknown" : "not-dispatched" } });
    expect(state.events.some((event) => event.kind === "turn_failed")).toBe(false);
    expect(state.events.some((event) => event.kind === "diagnostic")).toBe(true);
    expect(state.events.every((event) => event.turnId === "failed-turn" && event.generation === 41 && JSON.stringify(event.dispatchContext) === JSON.stringify(firstContext))).toBe(true);
    const secondContext = context("successful-turn", 42);
    const next = state.adapter.runTurn(secondContext.flyxTurnId, "second", undefined, secondContext);
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start") && state.events.some((event) => event.kind === "native_binding"));
    complete(state.client, "codex-turn-1", "second reply");
    await expect(next).resolves.toMatchObject({ status: "completed" });
    const events = state.events.filter((event) => event.turnId === secondContext.flyxTurnId);
    expect(events.map((event) => event.kind)).toEqual(["session_init", "native_binding", "assistant_delta", "assistant_message", "turn_completed"]);
    expect(events.every((event) => event.generation === 42 && JSON.stringify(event.dispatchContext) === JSON.stringify(secondContext))).toBe(true);
  });

  it("rejects late native messages, nested terminal IDs and approval requests on a resumed thread", async () => {
    const state = setup();
    const first = state.adapter.runTurn("first-turn", "first", "shared-thread", context("first-turn", 4));
    await waitFor(() => state.events.some((event) => event.kind === "native_binding"));
    complete(state.client, "codex-turn-1", "first", "shared-thread");
    await first;
    const second = state.adapter.runTurn("second-turn", "second", "shared-thread", context("second-turn", 5));
    await waitFor(() => state.events.some((event) => event.kind === "native_binding" && event.turnId === "second-turn"));
    const before = state.events.length;
    state.client.notification("item/agentMessage/delta", { threadId: "shared-thread", turnId: "codex-turn-1", itemId: "reused-item", delta: "late" });
    state.client.notification("item/agentMessage/delta", { threadId: "shared-thread", itemId: "reused-item", delta: "unbound" });
    state.client.notification("turn/completed", { threadId: "shared-thread", turn: { id: "codex-turn-1", status: "failed" } });
    state.client.serverRequest(99, "item/commandExecution/requestApproval", { threadId: "shared-thread", turnId: "codex-turn-1", itemId: "reused-item", command: "echo late" });
    expect(state.events).toHaveLength(before);
    expect(state.client.responses).toContainEqual({ id: 99, error: { code: -32602, message: "No matching active Flyx turn" } });
    complete(state.client, "codex-turn-2", "second", "shared-thread");
    await expect(second).resolves.toMatchObject({ status: "completed" });
    expect(state.events.filter((event) => event.kind === "assistant_delta").map((event) => event.text)).toEqual(["first", "second"]);
  });

  it("waits for the start response to associate early callbacks with its native Turn", async () => {
    const state = setup();
    const first = state.adapter.runTurn("first-turn", "first", "shared-thread", context("first-turn", 8));
    await waitFor(() => state.events.some((event) => event.kind === "native_binding"));
    complete(state.client, "codex-turn-1", "first", "shared-thread");
    await first;
    let release!: (response: JsonObject) => void;
    const response = new Promise<JsonObject>((resolveResponse) => { release = resolveResponse; });
    state.client.turnStart = () => response;
    const mutableContext = { ...context("second-turn", 9) };
    const second = state.adapter.runTurn("second-turn", "second", "shared-thread", mutableContext);
    mutableContext.runtimeGeneration = 999;
    await waitFor(() => state.client.requests.filter((request) => request.method === "turn/start").length === 2);
    complete(state.client, "codex-turn-1", "late", "shared-thread");
    complete(state.client, "codex-turn-2", "early second", "shared-thread");
    expect(state.events.filter((event) => event.turnId === "second-turn").map((event) => event.kind)).toEqual(["session_init"]);
    release({ turn: { id: "codex-turn-2" } });
    await expect(second).resolves.toMatchObject({ status: "completed" });
    const events = state.events.filter((event) => event.turnId === "second-turn");
    expect(events.every((event) => event.generation === 9 && event.dispatchContext?.runtimeGeneration === 9)).toBe(true);
    expect(events.find((event) => event.kind === "assistant_message")).toMatchObject({ text: "early second" });
    expect(events.some((event) => event.kind === "assistant_message" && event.text === "late")).toBe(false);
  });

  it("ignores old client callbacks even if a replacement reuses the same native IDs", async () => {
    const state = setup();
    const first = state.adapter.runTurn("first-turn", "first", undefined, context("first-turn", 11));
    await waitFor(() => state.events.some((event) => event.kind === "native_binding"));
    const oldClient = state.client;
    oldClient.exit();
    await expect(first).resolves.toMatchObject({ status: "outcome_unknown" });
    const second = state.adapter.runTurn("second-turn", "second", undefined, context("second-turn", 12));
    await waitFor(() => state.events.some((event) => event.kind === "native_binding" && event.turnId === "second-turn"));
    complete(oldClient, "codex-turn-1", "old client");
    complete(state.client, "codex-turn-1", "new client");
    await expect(second).resolves.toMatchObject({ status: "completed" });
    expect(state.events.find((event) => event.kind === "assistant_message")).toMatchObject({ text: "new client", generation: 12 });
  });
});


it("attaches native-ack evidence when respondApproval resolves the RPC decision", async () => {
  const state = setup();
  const first = state.adapter.runTurn("approval-evidence-turn", "first", undefined, context("approval-evidence-turn", 23));
  await waitFor(() => state.events.some((event) => event.kind === "native_binding"));
  state.client.serverRequest(77, "item/commandExecution/requestApproval", { threadId: "codex-thread-new", turnId: "codex-turn-1", itemId: "approval-item", command: "echo ok" });
  const requested = state.events.find((event): event is Extract<AdapterEvent, { kind: "approval_requested" }> => event.kind === "approval_requested")!;
  expect(requested.request.dispatchContext).toMatchObject({ nativeRequestId: "codex-rpc:number:77", nativeMethod: "item/commandExecution/requestApproval" });
  expect(state.adapter.respondApproval(requested.request.approvalId, "allow_once")).toBe(true);
  expect(state.client.responses).toContainEqual({ id: 77, result: { decision: "accept" } });
  expect(state.events.find((event): event is Extract<AdapterEvent, { kind: "approval_resolved" }> => event.kind === "approval_resolved")).toMatchObject({
    approvalId: requested.request.approvalId,
    toolUseId: "approval-item",
    action: "allow_once",
    evidence: { kind: "native-ack", sourceId: "codex-rpc:number:77", nativeRequestId: "codex-rpc:number:77" },
    turnId: "approval-evidence-turn",
    generation: 23,
  });
  complete(state.client, "codex-turn-1", "done");
  await first;
});

it("requires native Turn binding when a resumed runtime reuses an approval RPC ID", async () => {
  const state = setup();
  const first = state.adapter.runTurn("first-approval-turn", "first", "shared-thread", context("first-approval-turn", 21));
  await waitFor(() => state.events.some((event) => event.kind === "native_binding"));
  state.client.serverRequest(91, "item/commandExecution/requestApproval", { threadId: "shared-thread", turnId: "codex-turn-1", itemId: "same-tool", command: "echo first" });
  complete(state.client, "codex-turn-1", "first", "shared-thread");
  await first;
  const second = state.adapter.runTurn("second-approval-turn", "second", "shared-thread", context("second-approval-turn", 22));
  await waitFor(() => state.events.some((event) => event.kind === "native_binding" && event.turnId === "second-approval-turn"));
  state.client.serverRequest(91, "item/commandExecution/requestApproval", { threadId: "shared-thread", turnId: "codex-turn-2", itemId: "same-tool", command: "echo second" });
  const before = state.events.length;
  state.client.notification("serverRequest/resolved", { threadId: "shared-thread", requestId: 91 });
  expect(state.events).toHaveLength(before);
  state.client.notification("serverRequest/resolved", { threadId: "shared-thread", turnId: "codex-turn-2", requestId: 91 });
  expect(state.events.at(-1)).toMatchObject({ kind: "approval_resolved", turnId: "second-approval-turn", generation: 22 });
  complete(state.client, "codex-turn-2", "second", "shared-thread");
  await second;
});
