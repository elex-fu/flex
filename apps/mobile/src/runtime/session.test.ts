import { describe, expect, it, vi } from "vitest";
import { ClientError } from "@flyx/client-core";
import type { DraftCommandOptions, DraftKey } from "@flyx/client-core";
import { SESSION_CATALOG_CAPABILITY, type SessionSummaryV2 } from "@flyx/mvp-protocol";
import { nativeSessionClient, readSessionSnapshot, sendTaskFromDraft, sessionCanCompose, sessionIsIdle } from "./session";

const summary = (sessionId = "session-a", activityState: SessionSummaryV2["activityState"] = "idle"): SessionSummaryV2 => ({
  sessionId, workspaceId: "workspace-a", providerInstanceId: "provider-a", provider: "claude", title: "A", status: "active", activityState,
  headSequence: 1, revision: 1, residency: "loaded", nativeSessionAvailable: true, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
});
const snapshot = (sessionId = "session-a", activity: SessionSummaryV2["activityState"] = "idle") => ({ session: summary(sessionId, activity), pendingApprovals: [] });
function port(enabled = true) {
  let response: unknown = { sessionId: "session-a", turnId: "turn-a", status: "accepted", receipt: { commandId: "native-command", targetSessionId: "session-a", state: "accepted" } };
  const order: string[] = [];
  const request = vi.fn(async (_method: string, _value?: unknown) => ({ sessions: [summary()] }));
  const atomic = vi.fn(async (_method: string, _value: unknown, _key: DraftKey, options?: DraftCommandOptions) => {
    order.push("persist"); options?.onPersisted?.({ commandId: options.commandId!, hostId: "host-a", method: "session.startTurn", payloadHash: "hash", payload: _value, createdAt: "now", state: "queued", dispatchState: "not_dispatched" }); order.push("response"); return response;
  });
  const client: Parameters<typeof sendTaskFromDraft>[0] = {
    supportsCapability: (name) => enabled && name === SESSION_CATALOG_CAPABILITY,
    request: <T>(method: string, value?: unknown) => request(method, value) as Promise<T>,
    commandFromDraft: <T>(method: string, value: unknown, key: DraftKey, options?: DraftCommandOptions) => atomic(method, value, key, options) as Promise<T>,
  };
  return { client, request, atomic, order, reply: (value: unknown) => { response = value; } };
}
const key = { hostId: "host-a", sessionId: "session-a" };
const input = { sessionId: "session-a", prompt: "Task", clientMessageId: "message-a" };

describe("native authoritative session selection", () => {
  it("accepts the full canonical DTO and the explicit legacy facade", () => {
    expect(readSessionSnapshot({ ...snapshot("session-a", "waiting_approval"), activeTurn: { id: "turn-a", sessionId: "session-a", commandId: "turn-command", status: "running", prompt: "Task" } }, "session-a")).toEqual({ sessionId: "session-a", activityState: "waiting_approval", activeTurnId: "turn-a" });
    expect(sessionIsIdle({ session: { id: "session-a", activityState: "idle" } }, "session-a")).toBe(true);
    expect(sessionIsIdle(snapshot("session-a", "running"), "session-a")).toBe(false);
  });
  it("rejects incomplete canonical data, ambiguity, or a foreign Session/Turn", () => {
    expect(sessionIsIdle(snapshot("session-b"), "session-a")).toBe(false);
    expect(sessionIsIdle({ ...snapshot(), session: { ...summary(), id: "session-b" } }, "session-a")).toBe(false);
    expect(sessionIsIdle({ session: { sessionId: "session-a", activityState: "idle" } }, "session-a")).toBe(false);
    expect(sessionIsIdle({ session: { activityState: "idle" } }, "session-a")).toBe(false);
    expect(sessionIsIdle({ ...snapshot(), activeTurn: { id: "turn-b", sessionId: "session-b", commandId: "turn-command", status: "running", prompt: "Task" } }, "session-a")).toBe(false);
    expect(sessionIsIdle({ session: { id: "session-a", activityState: "idle" }, activeTurn: { id: "turn-b", sessionId: "session-b" } }, "session-a")).toBe(false);
  });
  it("blocks archived/recovery-gated/closing idle snapshots without inventing first-runtime readiness", () => {
    expect(sessionCanCompose(snapshot(), "session-a")).toBe(true);
    expect(sessionCanCompose({ ...snapshot(), session: { ...summary(), residency: "unloaded", nativeSessionAvailable: false } }, "session-a")).toBe(true);
    for (const change of [{ status: "archived" }, { residency: "blocked" }, { residency: "closing" }]) {
      const value = { ...snapshot(), session: { ...summary(), ...change } };
      expect(sessionIsIdle(value, "session-a")).toBe(true);
      expect(sessionCanCompose(value, "session-a")).toBe(false);
    }
    expect(sessionCanCompose(snapshot("session-b"), "session-a")).toBe(false);
  });
  it("requires no active Turn even if idle is reported, including the explicit legacy facade", () => {
    for (const status of ["queued", "running", "waiting_approval", "interrupting", "outcome_unknown"]) {
      expect(sessionCanCompose({ ...snapshot(), activeTurn: { id: "turn-a", sessionId: "session-a", commandId: "command-a", prompt: "Task", status } }, "session-a")).toBe(false);
    }
    expect(sessionCanCompose({ ...snapshot(), activeTurn: { id: "turn-a", sessionId: "session-a", commandId: "command-a", prompt: "Task", status: "completed" } }, "session-a")).toBe(true);
    expect(sessionCanCompose({ session: { id: "session-a", activityState: "idle" }, activeTurn: { id: "turn-a", status: "running" } }, "session-a")).toBe(false);
    expect(sessionCanCompose({ session: { id: "session-a", activityState: "idle" } }, "session-a")).toBe(true);
  });
  it("reads through the public negotiated SessionClient port and never probes a missing catalog", async () => {
    const enabled = port(), command = vi.fn();
    expect((await nativeSessionClient({ ...enabled.client, command: <T>() => command() as Promise<T> }).list({ limit: 1 })).sessions[0]?.sessionId).toBe("session-a");
    const unsupported = port(false);
    await expect(nativeSessionClient({ ...unsupported.client, command: <T>() => command() as Promise<T> }).list()).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(unsupported.request).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
  });
  it("keeps command identity and the persisted callback on the atomic draft port", async () => {
    const f = port();
    await sendTaskFromDraft(f.client, input, key, { commandId: "native-command", draftUpdatedAt: 42, onPersisted: (command) => { expect(command.dispatchState).toBe("not_dispatched"); f.order.push("clear visible draft"); } });
    expect(f.order).toEqual(["persist", "clear visible draft", "response"]);
    expect(f.atomic).toHaveBeenCalledWith("session.startTurn", input, key, expect.objectContaining({ commandId: "native-command", draftUpdatedAt: 42 }));
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects invalid input/target before persistence and retains the draft when storage fails", async () => {
    const f = port(), persisted = vi.fn();
    await expect(sendTaskFromDraft(f.client, { ...input, prompt: "" }, key, {})).rejects.toThrow();
    await expect(sendTaskFromDraft(f.client, { ...input, sessionId: "session-b" }, key, {})).rejects.toMatchObject({ code: "DRAFT_SESSION_MISMATCH" });
    expect(f.atomic).not.toHaveBeenCalled();
    f.atomic.mockRejectedValue(new ClientError("STORAGE_WRITE_FAILED", "storage unavailable"));
    await expect(sendTaskFromDraft(f.client, input, key, { commandId: "native-command", onPersisted: persisted })).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect(persisted).not.toHaveBeenCalled();
  });
  it("does not accept a typed response for another command or Session after persistence", async () => {
    const f = port();
    f.reply({ sessionId: "session-a", status: "accepted", receipt: { commandId: "other-command", targetSessionId: "session-a", state: "accepted" } });
    await expect(sendTaskFromDraft(f.client, input, key, { commandId: "native-command" })).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    f.reply({ sessionId: "session-b", status: "accepted", receipt: { commandId: "native-command", targetSessionId: "session-b", state: "accepted" } });
    await expect(sendTaskFromDraft(f.client, input, key, { commandId: "native-command" })).rejects.toMatchObject({ code: "SESSION_TARGET_MISMATCH" });
    expect(f.atomic).toHaveBeenCalledTimes(2); expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps explicit legacy execution on the same atomic port without inventing a V2 receipt", async () => {
    const f = port(false); f.reply({ turnId: "legacy-turn", status: "accepted" });
    await expect(sendTaskFromDraft(f.client, input, key, { commandId: "native-command" })).resolves.toMatchObject({ turnId: "legacy-turn" });
    expect(f.atomic).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
  });
});
