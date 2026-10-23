import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, type ClaudeNativeTerminalReceipt } from "./adapter.js";
import { ManagedProcessRegistry } from "../lifecycle/managed-process-registry.js";
import { digest } from "../storage/recovery-store.js";
import type { ManagedRuntimeOptions } from "../provider/managed-runtime.js";
import type { AdapterEvent, DispatchContext } from "../provider/types.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
beforeEach(() => queryMock.mockReset());

const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
const context: DispatchContext = { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 4, attemptId: "attempt" };

function message(value: unknown): SDKMessage { return value as SDKMessage; }

function query(result: () => SDKMessage): Query {
  return { async *[Symbol.asyncIterator]() {
    yield message({ type: "system", subtype: "init", session_id: "native-session", claude_code_version: "fixture", model: "fixture", tools: [] });
    yield result();
  }, interrupt: async () => {}, close: () => {} } as unknown as Query;
}

function managedFixture() {
  const boundarySpawn = vi.fn((): never => { throw new Error("Fixture must not spawn an OS process"); });
  const processSpawn = vi.fn((): never => { throw new Error("Fixture must not spawn an OS process"); });
  const options: ManagedRuntimeOptions = {
    executionBoundary: async () => ({ ready: true, proof: { verifiedPrivateReadBoundary: true, verifiedDescendantStop: true }, boundary: { spawn: boundarySpawn } }),
    processRegistryFactory: (fixed) => new ManagedProcessRegistry({ journal: { save() {} }, context: () => fixed, spawn: processSpawn }),
  };
  return { options, boundarySpawn, processSpawn };
}

describe("Claude adapter native terminal receipt", () => {
  it("journals the trusted receipt when the actual SDK result arrives", async () => {
    const resultMessage = { type: "result", subtype: "success", session_id: "native-session", uuid: "result-uuid", result: "done", total_cost_usd: 0, num_turns: 1 };
    queryMock.mockReturnValue(query(() => message(resultMessage)));
    const receipts: ClaudeNativeTerminalReceipt[] = [];
    const adapter = new ClaudeAdapter({ ...managedFixture().options, workspace, onEvent: () => {}, onNativeTerminalReceipt: (receipt) => receipts.push(receipt) });
    const turn = adapter.runTurn("turn", "task", undefined, context);
    await expect(turn).resolves.toMatchObject({ status: "completed", providerSessionId: "native-session" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      turnId: "turn", attemptId: "attempt", sessionId: "session", nativeSessionId: "native-session",
      contextDigest: digest(context), resultUuid: "result-uuid", resultDigest: digest(resultMessage),
    });
    // The receipt digest is the canonical recovery-store digest of the exact
    // SDK result message, independent of key order in the transcript line.
    expect(receipts[0]!.resultDigest).toBe(digest(JSON.parse(JSON.stringify(resultMessage))));
    expect(await adapter.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
  });

  it("survives a refused receipt write; the anchor is simply absent", async () => {
    queryMock.mockReturnValue(query(() => message({ type: "result", subtype: "success", session_id: "native-session", uuid: "result-uuid", result: "done", total_cost_usd: 0, num_turns: 1 })));
    const events: AdapterEvent[] = [];
    const adapter = new ClaudeAdapter({ ...managedFixture().options, workspace, onEvent: (event) => events.push(event), onNativeTerminalReceipt: () => { throw new Error("refused"); } });
    const turn = adapter.runTurn("turn", "task", undefined, context);
    await expect(turn).resolves.toMatchObject({ status: "completed", providerSessionId: "native-session" });
    expect(await adapter.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
  });

  it("emits no receipt when the result carries no native uuid; the turn stays unknown", async () => {
    queryMock.mockReturnValue(query(() => message({ type: "result", subtype: "success", session_id: "native-session", result: "done", total_cost_usd: 0, num_turns: 1 })));
    const receipts: ClaudeNativeTerminalReceipt[] = [];
    const adapter = new ClaudeAdapter({ ...managedFixture().options, workspace, onEvent: () => {}, onNativeTerminalReceipt: (receipt) => receipts.push(receipt) });
    const turn = adapter.runTurn("turn", "task", undefined, context);
    // Without a native uuid the SDK result is not a trusted terminal fact.
    await expect(turn).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(receipts).toHaveLength(0);
    expect(await adapter.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
  });

  it("records interrupt acknowledgement only after the SDK acknowledges the interrupt", async () => {
    const receipts: ClaudeNativeTerminalReceipt[] = [];
    queryMock.mockReturnValue({ async *[Symbol.asyncIterator]() {
      yield message({ type: "system", subtype: "init", session_id: "native-session", claude_code_version: "fixture", model: "fixture", tools: [] });
      // The SDK acknowledgement resolves before the terminal result surfaces.
      await new Promise((r) => setTimeout(r, 50));
      yield message({ type: "result", subtype: "success", terminal_reason: "aborted_tools", session_id: "native-session", uuid: "result-uuid", result: "", total_cost_usd: 0, num_turns: 1 });
    }, interrupt: async () => {}, close: () => {} } as unknown as Query);
    const adapter = new ClaudeAdapter({ ...managedFixture().options, workspace, onEvent: () => {}, onNativeTerminalReceipt: (receipt) => receipts.push(receipt) });
    const turn = adapter.runTurn("turn", "task", undefined, context);
    await new Promise((r) => setTimeout(r, 10));
    await expect(adapter.interrupt("host test")).resolves.toBe("accepted");
    await expect(turn).resolves.toMatchObject({ status: "cancelled" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.interruptAcknowledged).toBe(true);
    expect(await adapter.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
  });
});
