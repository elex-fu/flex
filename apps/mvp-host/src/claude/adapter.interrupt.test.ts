import { describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ClaudeAdapter } from "./adapter.js";
import type { AdapterEvent } from "./types.js";

describe("Claude Agent SDK interrupt contract", () => {
  it("does not report cancellation before the query reaches a terminal state", async () => {
    if (process.env.RUN_REAL_INTERRUPT !== "1") return;
    const source = resolve(process.cwd(), "../../packages/claude-fixtures");
    const workspace = await mkdtemp(resolve(tmpdir(), "flyx-claude-interrupt-"));
    await cp(source, workspace, { recursive: true });
    const events: AdapterEvent[] = [];
    let adapter: ClaudeAdapter;
    let interruptPromise: Promise<unknown> | undefined;
    adapter = new ClaudeAdapter({
      workspace,
      maxBudgetUsd: 1,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "approval_requested") setTimeout(() => { adapter.respondApproval(event.request.approvalId, "allow_once"); }, 0);
        if (event.kind === "tool_started" && typeof event.input.command === "string" && !interruptPromise) {
          interruptPromise = new Promise((resolveResult) => setTimeout(() => { void adapter.interrupt("test_interrupt").then(resolveResult); }, 1_000));
        }
      },
    });
    try {
      const outcome = await adapter.runTurn("interrupt-turn", "Run node scripts/slow.js 30 and report its output. Use only the workspace.");
      const interruptResult = await interruptPromise;
      expect(interruptResult).toBe("accepted");
      expect(outcome.status).toBe("cancelled");
      expect(events.some((event) => event.kind === "turn_cancelled")).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 240_000);
});
