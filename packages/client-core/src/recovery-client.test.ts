import { describe, expect, it, vi } from "vitest";
import { createRecoveryClient, RecoveryClient } from "./recovery-client.js";
const original = { sessionId: "session-original", turnId: "turn-original", attemptId: "attempt-original" };
const write = { ...original, evidenceId: "evidence", expectedRecoveryRevision: 3 };
const evidence = { ...original, evidenceId: "evidence", recoveryRevision: 3, observedAt: "now", expiresAt: "later", processState: "unknown", workspaceState: "unknown", nativeState: "unknown", nextSteps: ["inspect"] };
const operation = { ...original, operationId: "operation", state: "completed", gate: "blocked", turnStatus: "completed", recoveryRevision: 3 };
describe("typed original execution recovery client", () => {
  it("binds the shared client capability and durable command methods without losing their receiver", async () => {
    const port = {
      negotiated: true,
      calls: [] as Array<{ method: string; commandId?: string }>,
      supportsCapability(capability: string) { return this.negotiated && capability === "session-recovery-v1"; },
      async request(method: string) { this.calls.push({ method }); return evidence; },
      async command(method: string, _payload: unknown, commandId?: string) { this.calls.push({ method, ...(commandId ? { commandId } : {}) }); return operation; },
    };
    const client = createRecoveryClient(port);
    expect(await client.inspect(original)).toEqual(evidence);
    expect(await client.reconcile(write, "recovery-write")).toEqual(operation);
    expect(port.calls).toEqual([{ method: "session.recovery.inspect" }, { method: "session.recovery.reconcile", commandId: "recovery-write" }]);
    port.negotiated = false;
    await expect(client.inspect(original)).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
    expect(port.calls).toHaveLength(2);
  });
  it("requires negotiated capability and exact original response identity", async () => {
    const request = vi.fn(async () => evidence); const command = vi.fn(async () => operation);
    const client = new RecoveryClient({ supports: () => false, request, command });
    await expect(client.inspect(original)).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" }); expect(request).not.toHaveBeenCalled();
    const wrong = new RecoveryClient({ supports: () => true, request: async () => ({ ...evidence, turnId: "current-latest" }), command });
    await expect(wrong.inspect(original)).rejects.toMatchObject({ code: "RECOVERY_RESPONSE_IDENTITY_MISMATCH" });
  });
  it("uses separate explicit recovery command IDs and never retries a possibly sent operation", async () => {
    const command = vi.fn(async () => { throw new Error("response lost after possible send"); });
    const client = new RecoveryClient({ supports: () => true, request: async () => evidence, command });
    await expect(client.reconcile(write, "recover-original" )).rejects.toThrow("response lost");
    expect(command).toHaveBeenCalledExactlyOnceWith("session.recovery.reconcile", write, "recover-original");
    await expect(client.acknowledge({ ...write, acknowledgeUnknown: true }, "")).rejects.toMatchObject({ code: "COMMAND_ID_REQUIRED" });
    expect(command).toHaveBeenCalledTimes(1);
  });
  it("rejects injected stop conclusions and stale recovery responses", async () => {
    const command = vi.fn(async () => ({ ...operation, recoveryRevision: 2 }));
    const client = new RecoveryClient({ supports: () => true, request: async () => evidence, command });
    await expect(client.reconcile({ ...write, treeStopped: true } as typeof write, "recover")).rejects.toThrow(); expect(command).not.toHaveBeenCalled();
    await expect(client.reconcile(write, "recover")).rejects.toMatchObject({ code: "RECOVERY_RESPONSE_STALE" });
  });
});
