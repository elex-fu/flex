import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../codex/app-server-client.js";
import { digest } from "../storage/recovery-store.js";
import type { NativeHandle } from "./native-history.js";
import { NativeHistoryReaderFactory, readClaudeTranscript, type NativeHistoryCodexConnection, type NativeHistoryManifest, type NativeHistoryInspectionRequest } from "./native-history-reader.js";
const handle: NativeHandle = { id: "binding", sessionId: "session", turnId: "turn", attemptId: "attempt", provider: "codex", providerInstanceId: "instance",
  nativeSessionId: "native-session", nativeTurnId: "native-turn", workspacePath: "/checkout/app", configurationFingerprint: "config", verifiedVersion: "verified-v1", revision: 1, updatedAt: "now",
  context: { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", attemptId: "attempt", runtimeId: "runtime", runtimeGeneration: 1 } };
const manifest: NativeHistoryManifest = { source: "real-provider", state: "verified", evidenceId: "real-acceptance", provider: "codex", providerInstanceId: "instance", configurationFingerprint: "config", verifiedVersions: ["verified-v1"], historyContract: "codex-thread-read-v1" };
function connection() {
  const request = vi.fn(async () => ({ thread: { id: "native-session", turns: [{ id: "native-turn", status: "completed" }] } }));
  const value: NativeHistoryCodexConnection = { source: "existing-connection", managed: true, sessionId: "session", providerInstanceId: "instance", configurationFingerprint: "config", runtimeVersion: "verified-v1", assertReadOnlyReady: () => {}, client: { request: request as unknown as AppServerClient["request"] } };
  return { request, value };
}
describe("explicit native history inspection", () => {
  it("requires original manifest before selecting or opening a reader", async () => {
    const existing = vi.fn(); const open = vi.fn();
    const reader = new NativeHistoryReaderFactory({ assertBinding: () => {}, verifiedManifestForHandle: () => undefined, existingCodexReader: existing, openInspectionHelper: open });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ state: "unknown" });
    expect(existing).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("only reads the exact original native Turn with thread/read and preserves checkout root", async () => {
    const client = connection(); const assertBinding = vi.fn();
    const reader = new NativeHistoryReaderFactory({ assertBinding, verifiedManifestForHandle: () => manifest, existingCodexReader: () => client.value });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ state: "terminal", status: "completed" });
    expect(client.request.mock.calls).toHaveLength(1);
    expect(client.request.mock.calls[0]).toEqual(["thread/read", { threadId: "native-session", includeTurns: true }, expect.any(Number)]);
    expect(assertBinding).toHaveBeenCalledWith(handle, "/checkout");
  });
  it("rejects another configuration or unmanaged connection without reading", async () => {
    const client = connection();
    const reader = new NativeHistoryReaderFactory({ assertBinding: () => {}, verifiedManifestForHandle: () => manifest, existingCodexReader: () => ({ ...client.value, configurationFingerprint: "other" }) });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ state: "unknown" }); expect(client.request).not.toHaveBeenCalled();
  });
  it("stops inspection helpers and rejects root exit as descendant stop proof", async () => {
    const client = connection(); const stop = vi.fn(async () => undefined);
    const opening = vi.fn(async (request: NativeHistoryInspectionRequest) => { expect(request.checkoutRoot).toBe("/checkout"); expect(request.allowedMethods).toEqual(["thread/read"]);
      return { connection: { ...client.value, source: "inspection-helper" as const }, launchId: "launch", launchDigest: "a".repeat(64), originalContextDigest: digest(handle.context), successorProcessRecordIds: ["inspection-process"], stop }; });
    const reader = new NativeHistoryReaderFactory({ assertBinding: () => {}, verifiedManifestForHandle: () => manifest, openInspectionHelper: opening, verifyInspectionHelper: () => true });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ state: "unknown", reason: "native_history_helper_stop_unverified", inspectionExecution: { state: "unknown" } }); expect(stop).toHaveBeenCalledTimes(1);
  });
  it("returns a terminal only after exact helper launch and tree stop evidence", async () => {
    const client = connection(); const launchDigest = "a".repeat(64);
    const reader = new NativeHistoryReaderFactory({ assertBinding: () => {}, verifiedManifestForHandle: () => manifest,
      openInspectionHelper: async () => ({ connection: { ...client.value, source: "inspection-helper" }, launchId: "launch", launchDigest, originalContextDigest: digest(handle.context), successorProcessRecordIds: ["inspection-process"],
        stop: async () => ({ kind: "process-tree-stopped", launchId: "launch", launchDigest, sourceId: "supervisor-stop", contractId: "pidns-v1" }) }), verifyInspectionHelper: () => true });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ state: "terminal" });
  });
  it("bounds a transport that ignores request timeout", async () => {
    const client = connection(); client.value.client.request = (() => new Promise(() => {})) as AppServerClient["request"];
    const reader = new NativeHistoryReaderFactory({ timeoutMs: 5, assertBinding: () => {}, verifiedManifestForHandle: () => manifest, existingCodexReader: () => client.value });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ state: "unknown" });
  });
  it("rejects changed manifest after a native read", async () => {
    const client = connection(); let calls = 0;
    const reader = new NativeHistoryReaderFactory({ assertBinding: () => {}, verifiedManifestForHandle: () => ++calls === 1 ? manifest : { ...manifest, evidenceId: "replaced" }, existingCodexReader: () => client.value });
    expect(await reader.inspect(handle, "/checkout")).toMatchObject({ reason: "native_history_manifest_changed" });
  });
  it("requires an exact trusted Claude SDK result anchor and rejects completion text", async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-claude-history-"));
    try {
      const path = join(root, "history.jsonl"); const result = { type: "result", uuid: "result", session_id: "native-session", subtype: "success", is_error: false };
      const claude = { ...handle, provider: "claude" as const };
      const source = { path, format: "claude-sdk-result-v1" as const, runtimeVersion: "verified-v1", sessionId: "session", providerInstanceId: "instance", configurationFingerprint: "config", anchor: { contextDigest: digest(handle.context), resultUuid: "result", resultDigest: digest(result) } };
      await writeFile(path, JSON.stringify({ type: "assistant", uuid: "result", message: "completed" }) + "\n");
      expect(await readClaudeTranscript(claude, source)).toMatchObject({ state: "unknown" });
      await writeFile(path, JSON.stringify(result) + "\n"); expect(await readClaudeTranscript(claude, source)).toMatchObject({ state: "terminal", status: "completed" });
      await writeFile(path, JSON.stringify(result) + "\n" + JSON.stringify(result) + "\n"); expect(await readClaudeTranscript(claude, source)).toMatchObject({ state: "unknown" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
