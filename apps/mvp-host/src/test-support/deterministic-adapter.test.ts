import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DeterministicAdapter } from "./deterministic-adapter.js";
import type { AdapterEvent, DispatchContext } from "../provider/types.js";

function context(turnId: string, generation: number): DispatchContext {
  return { hostOwnerId: "test-owner", hostOwnerGeneration: 2, sessionId: "test-session", flyxTurnId: turnId,
    runtimeId: "test-runtime", runtimeGeneration: generation, attemptId: `attempt-${generation}` };
}

describe("deterministic Adapter dispatch contract", () => {
  it("uses Engine generations for scenario preparation failure and the next streamed Turn", async () => {
    const events: AdapterEvent[] = [];
    const adapter = new DeterministicAdapter({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures"), onEvent: (event) => events.push(event) });
    const failedContext = context("failed-turn", 71);
    await expect(adapter.runTurn("failed-turn", "scenario:missing", undefined, failedContext)).resolves.toMatchObject({ status: "failed" });
    expect(events).toEqual([expect.objectContaining({ kind: "turn_failed", turnId: "failed-turn", generation: 71, dispatchContext: failedContext })]);
    const successfulContext = context("successful-turn", 72);
    await expect(adapter.runTurn("successful-turn", "scenario:text", "native-session", successfulContext)).resolves.toMatchObject({ status: "completed" });
    const nextEvents = events.filter((event) => event.turnId === "successful-turn");
    expect(nextEvents.map((event) => event.kind)).toEqual(["session_init", "assistant_delta", "assistant_delta", "assistant_message", "turn_completed"]);
    expect(nextEvents.every((event) => event.generation === 72 && JSON.stringify(event.dispatchContext) === JSON.stringify(successfulContext))).toBe(true);
  });
});
