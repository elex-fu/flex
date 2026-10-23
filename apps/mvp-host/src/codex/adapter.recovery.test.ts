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
import type { AdapterEvent, DispatchContext } from "../provider/types.js";

class FakeAppServerClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: JsonObject }> = [];
  closed = false;
  turnStart: (() => Promise<JsonObject>) | undefined;

  constructor(readonly handlers: AppServerClientHandlers) {}

  async start(): Promise<void> {}

  async request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === "config/read") {
      return { config: { mcp_servers: {}, plugins: {} } } as T;
    }
    if (method === "account/read") return { account: { type: "chatgpt" }, requiresOpenaiAuth: true } as T;
    if (method === "thread/start") return { thread: { id: "codex-thread-new" } } as T;
    if (method === "thread/resume") return { thread: { id: params.threadId } } as T;
    if (method === "turn/start") {
      if (this.turnStart) return await this.turnStart() as T;
      return { turn: { id: "codex-turn-1", status: "inProgress", items: [] } } as T;
    }
    return {} as T;
  }

  notify(): void {}

  respond(_id: JsonRpcId, _result: JsonObject): boolean { return true; }

  respondError(_id: JsonRpcId, _code: number, _message: string): boolean { return true; }

  close(): void { this.closed = true; }

  notification(method: string, params: JsonObject): void {
    const notification: AppServerNotification = { method, params };
    this.handlers.onNotification(notification);
  }

  serverRequest(id: JsonRpcId, method: string, params: JsonObject): void {
    const request: AppServerRequest = { id, method, params };
    this.handlers.onRequest(request);
  }
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }

const adapters: CodexAdapter[] = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.close();
});

function setup(options: { onClient?: (client: FakeAppServerClient) => void } = {}) {
  const events: AdapterEvent[] = [];
  let client: FakeAppServerClient | undefined;
  const adapter = new CodexAdapter({
    workspace: resolve(process.cwd(), "../../packages/claude-fixtures"),
    executable: process.execPath,
    onEvent: (event) => { events.push(event); },
    clientFactory: (handlers) => {
      client = new FakeAppServerClient(handlers);
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

describe("CodexAdapter recovery reader", () => {
  it("stays undefined before a verified runtime version and a live connection", async () => {
    const state = setup();
    // No status() yet: the runtime version is unknown.
    expect(state.adapter.codexRecoveryReader(context("reader-turn", 1))).toBeUndefined();
    const status = await state.adapter.status();
    expect(status.runtimeVersion).toContain("v");
    // Version verified, but no live app-server connection exists yet.
    expect(state.adapter.codexRecoveryReader(context("reader-turn", 1))).toBeUndefined();
  });

  it("serves read-only requests over the live connection and fails closed after retirement", async () => {
    const turnStart = deferred<JsonObject>();
    const state = setup({ onClient: (client) => { client.turnStart = () => turnStart.promise; } });
    const status = await state.adapter.status();
    const dispatch = context("recovery-probe", 9);
    const turn = state.adapter.runTurn("recovery-probe", "task", undefined, dispatch);
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    const reader = state.adapter.codexRecoveryReader(dispatch);
    expect(reader).toBeDefined();
    expect(reader!.runtimeVersion).toBe(status.runtimeVersion);
    // The guarded reader routes a read-only request to the live client.
    expect(await reader!.client.request("thread/info", { threadId: "codex-thread-new" })).toEqual({});
    expect(state.client.requests.find((request) => request.method === "thread/info")?.params)
      .toEqual({ threadId: "codex-thread-new" });
    // Let the turn complete without rotation so the connection stays live.
    turnStart.resolve({ turn: { id: "codex-turn-1", status: "inProgress", items: [] } });
    complete(state.client, "codex-turn-1");
    await expect(turn).resolves.toMatchObject({ status: "completed" });
    // Retiring the Host connection fails the captured reader closed and removes the port.
    await state.adapter.closeAndWait();
    await expect(reader!.client.request("thread/info", { threadId: "codex-thread-new" }))
      .rejects.toThrow("CODEX_RECOVERY_CONNECTION_RETIRED");
    expect(state.adapter.codexRecoveryReader(dispatch)).toBeUndefined();
  });

  it("stays unavailable once callbacks are sealed", async () => {
    const turnStart = deferred<JsonObject>();
    const state = setup({ onClient: (client) => { client.turnStart = () => turnStart.promise; } });
    await state.adapter.status();
    const dispatch = context("sealed-turn", 10);
    const turn = state.adapter.runTurn("sealed-turn", "task", undefined, dispatch);
    await waitFor(() => state.client.requests.some((request) => request.method === "turn/start"));
    expect(state.adapter.codexRecoveryReader(dispatch)).toBeDefined();
    state.adapter.sealCallbacks();
    expect(state.adapter.codexRecoveryReader(dispatch)).toBeUndefined();
    turnStart.resolve({ turn: { id: "codex-turn-1", status: "inProgress", items: [] } });
    complete(state.client, "codex-turn-1");
    await expect(turn).resolves.toMatchObject({ status: "completed" });
  });
});
