import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { ClaudeAdapter } from "../claude/adapter.js";
import { SessionOrchestrator } from "./orchestrator.js";
import { DeterministicAdapter } from "../test-support/deterministic-adapter.js";

const openOrchestrators: SessionOrchestrator[] = [];

afterEach(() => {
  while (openOrchestrators.length) openOrchestrators.pop()!.close();
});

function createOrchestrator(): { orchestrator: SessionOrchestrator; adapter: DeterministicAdapter } {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  let ref: SessionOrchestrator | undefined;
  const adapter = new DeterministicAdapter({
    workspace,
    onEvent: (event) => ref?.ingestAdapterEvent(event),
  });
  const orchestrator = new SessionOrchestrator({
    workspace,
    adapter: adapter as unknown as ClaudeAdapter,
  });
  ref = orchestrator;
  openOrchestrators.push(orchestrator);
  return { orchestrator, adapter };
}

async function waitForIdle(orchestrator: SessionOrchestrator): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = orchestrator.snapshot();
    if (snapshot.session.activityState === "idle" && !snapshot.activeTurn) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("orchestrator did not become idle");
}

// Scenario 10 of the MVP acceptance matrix: replaying the same commandId must
// create exactly one Turn and return the original receipt instead of a second
// execution.
describe("duplicate commandId handling (deterministic adapter)", () => {
  it("replays the original receipt and never creates a second Turn", async () => {
    const { orchestrator } = createOrchestrator();
    const commandId = "dup-command-e2e-1";
    const first = await orchestrator.startTurn("browser-dup", commandId, "scenario:text");
    expect(first.status).toBe("accepted");
    await waitForIdle(orchestrator);

    const replay = await orchestrator.startTurn("browser-dup", commandId, "scenario:text");
    // The receipt now carries the terminal response; the fencing property is
    // that the replay resolves to the same Turn, never a second execution.
    expect((replay as { turnId?: string }).turnId).toBe((first as { turnId?: string }).turnId);

    // Exactly one Turn for the command: the replay must not have re-executed.
    const events = orchestrator.timeline().events;
    expect(events.filter((event) => event.type === "turn.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(orchestrator.timelineItems().filter((item) => item.kind === "user_message")).toHaveLength(1);
    expect(orchestrator.store.getCommandReceipt("browser-dup", commandId)?.state).toBe("completed");
  });

  it("rejects a commandId reused with a different request", async () => {
    const { orchestrator } = createOrchestrator();
    const commandId = "dup-command-e2e-2";
    await orchestrator.startTurn("browser-dup", commandId, "scenario:text");
    await waitForIdle(orchestrator);
    await expect(orchestrator.startTurn("browser-dup", commandId, "scenario:tool")).rejects.toMatchObject({
      code: "COMMAND_ID_REUSED",
    });
  });
});
