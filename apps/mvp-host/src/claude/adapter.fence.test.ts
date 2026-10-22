import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { CanUseTool, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "./adapter.js";
import { ManagedProcessRegistry } from "../lifecycle/managed-process-registry.js";
import type { AdapterEvent, DispatchContext } from "../provider/types.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

beforeEach(() => queryMock.mockReset());

const managed = {
  processRegistryFactory: (context: DispatchContext) => new ManagedProcessRegistry({ journal: { save() {} }, context: () => context }),
  executionBoundary: async () => ({ ready: true as const, proof: { verifiedPrivateReadBoundary: true as const, verifiedDescendantStop: true }, boundary: { spawn: (registry: ManagedProcessRegistry, request: import("../provider/managed-runtime.js").NativeSpawnRequest) => { const { command, args, ...options } = request; return registry.spawn(command, args, options); } } }),
};
const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
function context(turnId: string, generation: number): DispatchContext {
  return { hostOwnerId: "test-owner", hostOwnerGeneration: 3, sessionId: "test-session", flyxTurnId: turnId,
    runtimeId: "test-runtime", runtimeGeneration: generation, attemptId: `attempt-${generation}` };
}
function message(value: unknown): SDKMessage { return value as SDKMessage; }
function init(): SDKMessage {
  return message({ type: "system", subtype: "init", session_id: "native-session", claude_code_version: "test", model: "test", tools: [] });
}
function result(): SDKMessage {
  return message({ type: "result", uuid: "native-result-uuid", subtype: "success", session_id: "native-session", result: "done", total_cost_usd: 0.01, num_turns: 1 });
}
function fakeQuery(messages: SDKMessage[]): Query {
  return { async *[Symbol.asyncIterator]() { yield* messages; }, interrupt: vi.fn(async () => {}), close: vi.fn() } as unknown as Query;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("Claude Engine dispatch fence", () => {
  it("fences a synchronous query construction failure and the next streamed Turn", async () => {
    const events: AdapterEvent[] = [];
    const adapter = new ClaudeAdapter({ ...managed, workspace, onEvent: (event) => events.push(event) });
    queryMock.mockImplementationOnce(() => { throw new Error("injected query preparation failure"); });
    const firstContext = context("failed-turn", 31);
    await expect(adapter.runTurn("failed-turn", "first", undefined, firstContext)).resolves.toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } });
    expect(events).toContainEqual(expect.objectContaining({ kind: "diagnostic", code: "TURN_DISPATCH_UNCONFIRMED", turnId: "failed-turn", generation: 31, dispatchContext: firstContext }));
    queryMock.mockReturnValueOnce(fakeQuery([
      init(),
      message({ type: "stream_event", session_id: "native-session", event: { type: "message_start", message: { id: "shared-message" } } }),
      message({ type: "stream_event", session_id: "native-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "second" } } }),
      message({ type: "assistant", session_id: "native-session", uuid: "message-uuid", message: { id: "shared-message", content: [{ type: "text", text: "second" }] } }),
      result(),
    ]));
    const secondContext = context("successful-turn", 32);
    await expect(adapter.runTurn("successful-turn", "second", "native-session", secondContext)).resolves.toMatchObject({ status: "completed", providerSessionId: "native-session" });
    expect(queryMock.mock.calls[1]?.[0]?.options.resume).toBe("native-session");
    const secondEvents = events.filter((event) => event.turnId === "successful-turn");
    expect(secondEvents.map((event) => event.kind)).toEqual(["session_init", "assistant_delta", "assistant_message", "turn_completed"]);
    expect(secondEvents.every((event) => event.generation === 32 && JSON.stringify(event.dispatchContext) === JSON.stringify(secondContext))).toBe(true);
  });

  it("denies a stale SDK permission callback instead of attaching it to a new Turn", async () => {
    const events: AdapterEvent[] = [];
    const adapter = new ClaudeAdapter({ ...managed, workspace, onEvent: (event) => events.push(event) });
    queryMock.mockReturnValueOnce(fakeQuery([init(), result()]));
    await adapter.runTurn("first-turn", "first", undefined, context("first-turn", 4));
    const oldCanUseTool = queryMock.mock.calls[0]?.[0]?.options.canUseTool as CanUseTool;
    const release = deferred<void>();
    const started = deferred<void>();
    queryMock.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() { yield init(); started.resolve(); await release.promise; yield result(); },
      interrupt: vi.fn(async () => {}), close: vi.fn(),
    } as unknown as Query);
    const second = adapter.runTurn("second-turn", "second", "native-session", context("second-turn", 5));
    await started.promise;
    const before = events.length;
    await expect(oldCanUseTool("Bash", { command: "echo stale" }, { toolUseID: "reused-tool", requestId: "old-request", signal: new AbortController().signal })).resolves.toMatchObject({ behavior: "deny" });
    expect(events).toHaveLength(before);
    release.resolve();
    await expect(second).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps a late interrupt failure on the old captured context", async () => {
    const events: AdapterEvent[] = [];
    const adapter = new ClaudeAdapter({ ...managed, workspace, onEvent: (event) => events.push(event) });
    const oldRelease = deferred<void>();
    const oldStarted = deferred<void>();
    const interrupt = deferred<void>();
    queryMock.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() { yield init(); oldStarted.resolve(); await oldRelease.promise; yield result(); },
      interrupt: () => interrupt.promise, close: vi.fn(),
    } as unknown as Query);
    const firstContext = context("first-turn", 6);
    const first = adapter.runTurn("first-turn", "first", undefined, firstContext);
    await oldStarted.promise;
    const interrupted = adapter.interrupt();
    oldRelease.resolve();
    await first;
    const nextRelease = deferred<void>();
    const nextStarted = deferred<void>();
    queryMock.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() { yield init(); nextStarted.resolve(); await nextRelease.promise; yield result(); },
      interrupt: vi.fn(async () => {}), close: vi.fn(),
    } as unknown as Query);
    const second = adapter.runTurn("second-turn", "second", "native-session", context("second-turn", 7));
    await nextStarted.promise;
    interrupt.reject(new Error("late interrupt transport failure"));
    await expect(interrupted).resolves.toBe("unavailable");
    expect(events.find((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_FAILED")).toMatchObject({ turnId: "first-turn", generation: 6, dispatchContext: firstContext });
    nextRelease.resolve();
    await second;
  });
});
