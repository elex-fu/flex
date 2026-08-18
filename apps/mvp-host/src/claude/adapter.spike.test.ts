import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ClaudeAdapter } from "./adapter.js";
import type { AdapterEvent } from "./types.js";

describe("Claude Agent SDK P0 contract", () => {
  it("runs a real no-tool query and exposes a structured terminal event", async () => {
    if (process.env.RUN_REAL_CLAUDE_SPIKE !== "1") return;
    const events: AdapterEvent[] = [];
    const adapter = new ClaudeAdapter({
      workspace: resolve(process.cwd(), "../../packages/claude-fixtures"),
      onEvent: (event) => events.push(event),
      maxBudgetUsd: 0.25,
    });
    const outcome = await adapter.runTurn("spike-turn", "Reply with exactly FLYX_P0_OK. Do not use any tools.");
    expect(["completed", "failed"]).toContain(outcome.status);
    expect(events.some((event) => event.kind === "session_init")).toBe(true);
    expect(events.some((event) => event.kind === "turn_completed" || event.kind === "turn_failed")).toBe(true);
    expect(events.filter((event) => event.kind === "assistant_message").some((event) => /not logged in/i.test(event.text))).toBe(false);
    if (outcome.status === "completed") {
      expect(outcome.providerSessionId).toBeTruthy();
      const followUp = await adapter.runTurn("spike-follow-up", "Reply with exactly FLYX_RESUME_OK. Do not use any tools.", outcome.providerSessionId);
      expect(["completed", "failed"]).toContain(followUp.status);
      expect(followUp.providerSessionId).toBe(outcome.providerSessionId);
    }
  }, 180_000);
});
