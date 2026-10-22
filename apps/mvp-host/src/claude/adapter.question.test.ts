import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { CanUseTool, Query, SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "./adapter.js";
import { ManagedProcessRegistry } from "../lifecycle/managed-process-registry.js";
import type { ManagedRuntimeOptions } from "../provider/managed-runtime.js";
import type { AdapterEvent, DispatchContext } from "../provider/types.js";
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
beforeEach(() => queryMock.mockReset());
const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
const context: DispatchContext = { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 4, attemptId: "attempt" };
const input = { questions: [{ header: "Choice", question: "Pick one", multiSelect: false, options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }] };
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function message(value: unknown): SDKMessage { return value as SDKMessage; }
function query(release: ReturnType<typeof deferred>, started: ReturnType<typeof deferred>, echo?: () => SDKMessage): Query { return { async *[Symbol.asyncIterator]() { yield message({ type: "system", subtype: "init", session_id: "native", claude_code_version: "fixture", model: "fixture", tools: [] }); started.resolve(); await release.promise; if (echo)
    yield echo(); yield message({ type: "result", subtype: "success", session_id: "native", result: "done", total_cost_usd: 0, num_turns: 1 }); }, interrupt: async () => { }, close: () => { } } as unknown as Query; }
function managedFixture() {
  const boundarySpawn = vi.fn((): never => { throw new Error("Fixture must not spawn an OS process"); });
  const processSpawn = vi.fn((): never => { throw new Error("Fixture must not spawn an OS process"); });
  const registries: ManagedProcessRegistry[] = [];
  const options: ManagedRuntimeOptions = {
    executionBoundary: async () => ({ ready: true, proof: { verifiedPrivateReadBoundary: true, verifiedDescendantStop: true }, boundary: { spawn: boundarySpawn } }),
    processRegistryFactory: (fixed) => {
      expect(fixed).toEqual(context);
      const registry = new ManagedProcessRegistry({ journal: { save() {} }, context: () => fixed, spawn: processSpawn });
      registries.push(registry); return registry;
    },
  };
  return { options, boundarySpawn, processSpawn, registries };
}
describe("Claude structured question production hooks", () => {
  it("omits AskUserQuestion and denies its hooks until a real-version contract is verified", async () => {
    const started = deferred();
    const release = deferred();
    queryMock.mockReturnValue(query(release, started));
    const managed = managedFixture();
    const adapter = new ClaudeAdapter({ ...managed.options, workspace });
    const turn = adapter.runTurn("turn", "task", undefined, context);
    await started.promise;
    const options = queryMock.mock.calls[0]![0].options as Options;
    expect(options.tools).not.toContain("AskUserQuestion");
    expect(adapter.structuredQuestionsAvailable()).toBe(false);
    const permission = options.canUseTool as CanUseTool;
    await expect(permission("AskUserQuestion", input, { toolUseID: "tool", signal: new AbortController().signal } as Parameters<CanUseTool>[2])).resolves.toMatchObject({ behavior: "deny" });
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    await expect(hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "tool", tool_input: input } as never, "tool", { signal: new AbortController().signal })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    release.resolve();
    await turn;
    expect(await adapter.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
    expect(managed.boundarySpawn).not.toHaveBeenCalled(); expect(managed.processSpawn).not.toHaveBeenCalled();
  });
  it("routes captured native questions through updatedInput and requires native tool-result proof", async () => {
    const events: AdapterEvent[] = [];
    const started = deferred();
    const release = deferred();
    queryMock.mockReturnValue(query(release, started, () => message({ type: "user", session_id: "native", uuid: "native-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: JSON.stringify({ answers: { "Pick one": "Two" } }) }] } })));
    const managed = managedFixture();
    const adapter = new ClaudeAdapter({ ...managed.options, workspace, questionVerificationMode: true, interactionEvidenceSource: "fixture", onEvent: (event) => events.push(event) });
    const turn = adapter.runTurn("turn", "task", undefined, context);
    await started.promise;
    const options = queryMock.mock.calls[0]![0].options as Options;
    expect(options.tools).toContain("AskUserQuestion");
    expect(adapter.structuredQuestionsAvailable()).toBe(false);
    const permission = (options.canUseTool as CanUseTool)("AskUserQuestion", input, { toolUseID: "tool", signal: new AbortController().signal } as Parameters<CanUseTool>[2]);
    const event = events.find((event): event is Extract<AdapterEvent, {
      kind: "question_requested";
    }> => event.kind === "question_requested")!;
    expect(event).toMatchObject({ dispatchContext: context, generation: 4, turnId: "turn" });
    const q = event.request.request.questions[0]!;
    expect(adapter.respondQuestion(event.request.interactionId, [{ questionId: q.questionId, optionIds: [q.options[1]!.optionId] }])).toEqual({ kind: "local-delivery" });
    await expect(permission).resolves.toMatchObject({ behavior: "allow", updatedInput: { answers: { "Pick one": "Two" } } });
    expect(events.some((event) => event.kind === "question_resolved")).toBe(false);
    release.resolve();
    await turn;
    expect(await adapter.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
    expect(managed.boundarySpawn).not.toHaveBeenCalled(); expect(managed.processSpawn).not.toHaveBeenCalled();
    expect(events.find((event) => event.kind === "question_resolved")).toMatchObject({ status: "confirmed", dispatchContext: context, evidence: { sourceId: "claude:native-result" } });
  });
});
