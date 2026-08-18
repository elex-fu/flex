import { describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ClaudeAdapter } from "./adapter.js";
import type { AdapterEvent } from "./types.js";

describe("Claude Agent SDK approval/tool flow", () => {
  it("can approve a real fixture edit and observe the test result", async () => {
    if (process.env.RUN_REAL_CLAUDE_FLOW !== "1") return;
    const source = resolve(process.cwd(), "../../packages/claude-fixtures");
    const workspace = await mkdtemp(resolve(tmpdir(), "flyx-claude-flow-"));
    await cp(source, workspace, { recursive: true, filter: (path) => !path.includes("node_modules") && !path.includes(".git") });
    const events: AdapterEvent[] = [];
    let adapter: ClaudeAdapter;
    adapter = new ClaudeAdapter({
      workspace,
      maxBudgetUsd: 1,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "approval_requested") setTimeout(() => { adapter.respondApproval(event.request.approvalId, "allow_once"); }, 0);
      },
    });
    try {
      const outcome = await adapter.runTurn("flow-turn", "Inspect the fixture. Fix the retry bug so maxRetries=0 performs the initial attempt, then run npm test. Use only the available workspace and do not use the network.");
      expect(outcome.status).toBe("completed");
      expect(events.some((event) => event.kind === "approval_requested")).toBe(true);
      const approvedCommands = events.filter((event): event is Extract<AdapterEvent, { kind: "approval_requested" }> => event.kind === "approval_requested").map((event) => event.request.input.command).filter((value): value is string => typeof value === "string");
      expect(approvedCommands.some((command) => command.startsWith("rtk "))).toBe(false);
      expect(events.some((event) => event.kind === "tool_started")).toBe(true);
      expect(events.some((event) => event.kind === "tool_completed" && !event.error)).toBe(true);
      const sourceAfter = await readFile(resolve(workspace, "src/retry.js"), "utf8");
      expect(sourceAfter).not.toContain("attempt < maxRetries");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});
