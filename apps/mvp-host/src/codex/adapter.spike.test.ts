import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAdapter } from "./adapter.js";
import type { AdapterEvent } from "../provider/types.js";

const realIt = process.env.RUN_REAL_CODEX_SPIKE === "1" ? it : it.skip;
const realFlowIt = process.env.RUN_REAL_CODEX_FLOW === "1" ? it : it.skip;

realIt("runs and resumes a real Codex app-server thread", async () => {
  const events: AdapterEvent[] = [];
  const adapter = new CodexAdapter({
    workspace: resolve(process.cwd(), "../../packages/claude-fixtures"),
    onEvent: (event) => events.push(event),
  });
  try {
    const status = await adapter.preflight();
    expect(status.provider).toBe("codex");

    const first = await adapter.runTurn(
      "real-codex-turn-1",
      "Reply with exactly FLYX_CODEX_READY. Do not use tools and do not modify files.",
    );
    expect(first.status).toBe("completed");
    if (first.status !== "completed") return;
    expect(events.some((event) => event.kind === "assistant_message" && event.text.includes("FLYX_CODEX_READY"))).toBe(true);

    const second = await adapter.runTurn(
      "real-codex-turn-2",
      "Reply with exactly FLYX_CODEX_RESUMED. Do not use tools and do not modify files.",
      first.providerSessionId,
    );
    expect(second).toEqual({ status: "completed", providerSessionId: first.providerSessionId });
    expect(events.some((event) => event.kind === "assistant_message" && event.text.includes("FLYX_CODEX_RESUMED"))).toBe(true);
  } finally {
    adapter.close();
  }
}, 300_000);

realFlowIt("executes an approved real Codex command inside an isolated workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flyx-codex-flow-"));
  const events: AdapterEvent[] = [];
  let adapter!: CodexAdapter;
  adapter = new CodexAdapter({
    workspace,
    onEvent: (event) => {
      events.push(event);
      if (event.kind === "approval_requested") adapter.respondApproval(event.request.approvalId, "allow_once");
    },
  });
  try {
    await adapter.preflight();
    const outcome = await adapter.runTurn(
      "real-codex-flow-turn",
      "Use the shell exactly once to run `printf FLYX_CODEX_WRITE_OK > flyx-codex-proof.txt` in the current workspace. Do not use any other tool. Then reply with exactly FLYX_CODEX_FLOW_DONE.",
    );
    expect(outcome.status).toBe("completed");
    expect(await readFile(join(workspace, "flyx-codex-proof.txt"), "utf8")).toBe("FLYX_CODEX_WRITE_OK");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool_started", toolName: "Bash" }),
      expect.objectContaining({ kind: "approval_requested", request: expect.objectContaining({ toolName: "Bash" }) }),
      expect.objectContaining({ kind: "assistant_message", text: expect.stringContaining("FLYX_CODEX_FLOW_DONE") }),
    ]));
  } finally {
    adapter.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 240_000);
