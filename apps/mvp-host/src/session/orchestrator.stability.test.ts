import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { ClaudeAdapter } from "../claude/adapter.js";
import { SessionOrchestrator } from "./orchestrator.js";

const openOrchestrators: SessionOrchestrator[] = [];

afterEach(() => {
  while (openOrchestrators.length) openOrchestrators.pop()!.close();
});

class DeterministicAdapter {
  readonly workspace: string;
  activeTurnId: string | undefined;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async runTurn(turnId: string): Promise<{ status: "completed"; providerSessionId: string }> {
    this.activeTurnId = turnId;
    this.activeTurnId = undefined;
    return { status: "completed", providerSessionId: "deterministic-provider-session" };
  }

  async interrupt(): Promise<"unavailable"> {
    return "unavailable";
  }

  respondApproval(): boolean {
    return false;
  }
}

async function waitForIdle(orchestrator: SessionOrchestrator): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (orchestrator.snapshot().session.activityState === "idle" && !orchestrator.snapshot().activeTurn) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("orchestrator did not become idle");
}

describe("Session orchestration stability", () => {
  it("completes 30 deterministic Turns without duplicate active state or receipts", async () => {
    const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
    const adapter = new DeterministicAdapter(workspace);
    const orchestrator = new SessionOrchestrator({
      workspace,
      adapter: adapter as unknown as ClaudeAdapter,
    });
    openOrchestrators.push(orchestrator);

    for (let index = 0; index < 30; index += 1) {
      const commandId = `stability-command-${index}`;
      const response = await orchestrator.startTurn("browser-stability", commandId, `deterministic prompt ${index}`);
      expect(response.status).toBe("accepted");
      await waitForIdle(orchestrator);
      expect(orchestrator.store.getCommandReceipt("browser-stability", commandId)?.state).toBe("completed");
    }

    const events = orchestrator.timeline().events;
    expect(events.filter((event) => event.type === "user.message.created")).toHaveLength(30);
    expect(events.filter((event) => event.type === "turn.requested")).toHaveLength(30);
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(30);
    expect(events.filter((event) => event.type === "turn.reconciled")).toHaveLength(30);
    expect(orchestrator.snapshot().session.activityState).toBe("idle");
    expect(orchestrator.snapshot().activeTurn).toBeUndefined();
    expect(orchestrator.timelineItems().filter((item) => item.kind === "user_message")).toHaveLength(30);
  });
});
