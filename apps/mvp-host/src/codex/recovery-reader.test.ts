import { describe, expect, it, vi } from "vitest";
import { inspectCodexNativeTurn, parseCodexTurnRead } from "./recovery-reader.js";
import { inspectClaudeTranscript } from "../provider/native-history.js";
import type { NativeHandle } from "../provider/native-history.js";

const handle: NativeHandle = { id: "binding", sessionId: "session", turnId: "turn", attemptId: "attempt", provider: "codex", providerInstanceId: "instance",
  nativeSessionId: "original-thread", nativeTurnId: "original-native-turn", workspacePath: "/fixture", configurationFingerprint: "policy", verifiedVersion: "fixture-v1",
  context: { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt" },
  revision: 0, updatedAt: "2026-10-15T00:00:00Z" };

describe("Codex read-only exact-Turn recovery", () => {
  it("reads the original thread without resume/start and chooses its exact Turn rather than the latest assistant", async () => {
    const request = vi.fn(async () => ({ thread: { id: "original-thread", turns: [
      { id: "original-native-turn", status: "interrupted", items: [] },
      { id: "latest-turn", status: "completed", items: [{ type: "agentMessage", text: "same prompt succeeded" }] },
    ] } }));
    const observation = await inspectCodexNativeTurn(handle, { client: { request: request as never }, verifiedVersions: ["fixture-v1"], readerVersion: "fixture-v1" });
    expect(observation).toMatchObject({ state: "terminal", status: "cancelled", nativeTurnId: "original-native-turn", evidence: { kind: "native-terminal", verifiedVersion: "fixture-v1" } });
    expect(request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId: "original-thread", includeTurns: true }, 15_000);
  });
  it.each(["completed", "failed", "interrupted"])("uses supported exact %s native status as terminal evidence", (status) => {
    expect(parseCodexTurnRead({ thread: { id: "original-thread", turns: [{ id: "original-native-turn", status }] } }, handle)).toMatchObject({ state: "terminal" });
  });
  it("preserves a running native state without converting transcript content into completion", () => {
    expect(parseCodexTurnRead({ thread: { id: "original-thread", turns: [{ id: "original-native-turn", status: "inProgress", items: [{ type: "agentMessage", text: "done" }] }] } }, handle)).toMatchObject({ state: "running" });
  });
  it.each([
    { thread: { id: "wrong-thread", turns: [{ id: "original-native-turn", status: "completed" }] } },
    { thread: { id: "original-thread", turns: [{ id: "latest-turn", status: "completed" }] } },
    { thread: { id: "original-thread", turns: [{ id: "original-native-turn", status: "completed" }, { id: "original-native-turn", status: "failed" }] } },
    { thread: { id: "original-thread", turns: [{ id: "original-native-turn", status: "success" }] } },
  ])("keeps mismatched/ambiguous/unsupported native facts unknown", (response) => {
    expect(parseCodexTurnRead(response, handle).state).toBe("unknown");
  });
  it("does not make a native call when the stored Provider version is unverified", async () => {
    const request = vi.fn();
    await expect(inspectCodexNativeTurn(handle, { client: { request }, verifiedVersions: [], readerVersion: "fixture-v1" })).resolves.toMatchObject({ state: "unknown", reason: "native_history_version_unverified" });
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps SDK assistant/system transcripts unknown and never invents a Claude native Turn", () => {
    const claude = { ...handle, provider: "claude" as const };
    delete claude.nativeTurnId;
    expect(inspectClaudeTranscript(claude, [{ type: "assistant", uuid: "native-message", text: "finished" }])).toMatchObject({ state: "unknown" });
  });
  it("also refuses an unverified current reader even when the original stored version was verified", async () => {
    const request = vi.fn();
    await expect(inspectCodexNativeTurn(handle, { client: { request }, verifiedVersions: ["fixture-v1"], readerVersion: "new-unverified-cli" })).resolves.toMatchObject({ state: "unknown", reason: "native_history_version_unverified" });
    expect(request).not.toHaveBeenCalled();
  });

});
