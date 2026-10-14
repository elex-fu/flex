import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { CodexAdapter } from "./adapter.js";
import type { AppServerClient, AppServerClientHandlers, JsonObject, JsonRpcId } from "./app-server-client.js";
import type { AdapterEvent, DispatchContext } from "../provider/types.js";
class Client implements AppServerClient {
  readonly replies: Array<{
    id: JsonRpcId;
    result?: JsonObject;
    error?: number;
  }> = [];
  started = false;
  write = true;
  constructor(readonly handlers: AppServerClientHandlers) { }
  async start() { }
  notify() { }
  close() { }
  async request<T = JsonObject>(method: string): Promise<T> { if (method === "config/read")
    return { config: {} } as T; if (method === "thread/start")
    return { thread: { id: "thread" } } as T; if (method === "turn/start") {
    this.started = true;
    return { turn: { id: "native-turn", status: "inProgress", items: [] } } as T;
  } return {} as T; }
  respond(id: JsonRpcId, result: JsonObject): boolean { this.replies.push({ id, result }); return this.write; }
  respondError(id: JsonRpcId, error: number): boolean { this.replies.push({ id, error }); return true; }
  question(id: JsonRpcId, method = "item/tool/requestUserInput", extra: JsonObject = {}) { this.handlers.onRequest({ id, method, params: { threadId: "thread", turnId: "native-turn", itemId: "item", questions: [{ id: "q", header: "Choice", question: "Pick one", options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }], ...extra } }); }
  finish() { this.handlers.onNotification({ method: "turn/completed", params: { threadId: "thread", turn: { id: "native-turn", status: "completed" } } }); }
}
const adapters: CodexAdapter[] = [];
afterEach(() => { while (adapters.length)
  adapters.pop()!.close(); });
const context: DispatchContext = { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 7, attemptId: "attempt" };
async function setup(verify = false) { let client!: Client; const events: AdapterEvent[] = []; const adapter = new CodexAdapter({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures"), executable: process.execPath, questionVerificationMode: verify, onEvent: (event) => events.push(event), clientFactory: (handlers) => { client = new Client(handlers); return client; } }); adapters.push(adapter); const turn = adapter.runTurn("turn", "task", undefined, context); for (let i = 0; i < 100 && !events.some((event) => event.kind === "native_binding"); i++)
  await new Promise((r) => setTimeout(r, 1)); expect(client.started).toBe(true); return { adapter, client, turn, events }; }
describe("Codex native requestUserInput production branch", () => {
  it("fails closed for unverified contracts and unrecognized aliases", async () => {
    const f = await setup();
    f.client.question(1);
    expect(f.client.replies.at(-1)).toMatchObject({ id: 1, error: -32602 });
    expect(f.adapter.structuredQuestionsAvailable()).toBe(false);
    expect(f.events.some((event) => event.kind === "question_requested")).toBe(false);
    f.client.question(2, "tool/requestUserInput");
    expect(f.client.replies.at(-1)).toMatchObject({ id: 2, error: -32601 });
    f.client.finish();
    await f.turn;
  });
  it("routes strict native options with the original source fence and records local delivery only", async () => {
    const f = await setup(true);
    f.client.question(1);
    const event = f.events.find((event): event is Extract<AdapterEvent, {
      kind: "question_requested";
    }> => event.kind === "question_requested")!;
    expect(event).toMatchObject({ generation: 7, dispatchContext: context });
    const q = event.request.request.questions[0]!;
    expect(f.adapter.respondQuestion(event.request.interactionId, [{ questionId: q.questionId, optionIds: [q.options[1]!.optionId] }])).toEqual({ kind: "local-delivery" });
    expect(f.client.replies.at(-1)).toEqual({ id: 1, result: { answers: { q: { answers: ["Two"] } } } });
    f.client.handlers.onNotification({ method: "serverRequest/resolved", params: { threadId: "thread", turnId: "native-turn", requestId: 1 } });
    expect(f.events.some((event) => event.kind === "question_resolved" && event.status === "confirmed")).toBe(false);
    expect(f.adapter.respondQuestion(event.request.interactionId, [{ questionId: q.questionId, optionIds: [q.options[1]!.optionId] }]).kind).toBe("not-dispatched");
    expect(f.adapter.structuredQuestionsAvailable()).toBe(false);
    f.client.finish();
    await f.turn;
  });
  it("does not retry an uncertain native transport write", async () => {
    const f = await setup(true);
    f.client.question(1);
    const event = f.events.find((event): event is Extract<AdapterEvent, {
      kind: "question_requested";
    }> => event.kind === "question_requested")!;
    const q = event.request.request.questions[0]!;
    f.client.write = false;
    const answers = [{ questionId: q.questionId, optionIds: [q.options[0]!.optionId] }];
    expect(f.adapter.respondQuestion(event.request.interactionId, answers).kind).toBe("unknown");
    const count = f.client.replies.length;
    expect(f.adapter.respondQuestion(event.request.interactionId, answers).kind).toBe("unknown");
    expect(f.client.replies).toHaveLength(count);
    f.client.finish();
    await f.turn;
  });
});
