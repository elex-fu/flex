import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { SessionOrchestrator } from "./orchestrator.js";
import type { AdapterStatus, ProviderAdapter, ProviderOutcome } from "../provider/types.js";

const openOrchestrators: SessionOrchestrator[] = [];

afterEach(() => {
  while (openOrchestrators.length) openOrchestrators.pop()!.close();
});

class DeterministicAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly workspace: string;
  activeTurnId: string | undefined;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async status(): Promise<AdapterStatus> {
    return {
      provider: this.provider,
      transport: "deterministic",
      adapterVersion: "test",
      executable: "deterministic",
      runtimeVersion: "test",
      workspace: this.workspace,
      sandboxRequired: true,
    };
  }

  async preflight(): Promise<AdapterStatus> {
    return this.status();
  }

  async runTurn(turnId: string): Promise<ProviderOutcome> {
    this.activeTurnId = turnId;
    this.activeTurnId = undefined;
    return { status: "completed", providerSessionId: "deterministic-provider-session", evidence: { kind: "native-terminal", sourceId: turnId } };
  }

  async interrupt(): Promise<"unavailable"> {
    return "unavailable";
  }

  respondApproval(): boolean {
    return false;
  }
}

async function waitForIdle(orchestrator: SessionOrchestrator): Promise<void> {
  await orchestrator.worker.drainDispatch();
  expect(await orchestrator.worker.drainOperations()).toBe(true);
  expect(orchestrator.snapshot().session.activityState).toBe("idle");
  expect(orchestrator.snapshot().activeTurn).toBeUndefined();
}

describe("Session orchestration stability", () => {
  it("completes 30 deterministic Turns without duplicate active state or receipts", async () => {
    const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
    const adapter = new DeterministicAdapter(workspace);
    const orchestrator = new SessionOrchestrator({ canReleaseWorkspace: () => true,
      workspace,
      adapter,
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
