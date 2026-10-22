import { describe, expect, it, vi } from "vitest";
import type { ClientState, PendingCommand } from "@flyx/client-core";
import { reviewNativeReceipt, type NativeReceiptPort } from "./receipt-review";

function fixture(method = "session.recovery.acknowledge") {
  const connection: ClientState = { connection: "online", sync: "synced", transportGeneration: 1, pairingRequired: false, profile: { hostId: "host", label: "Host", hostPublicKey: "public", signingPublicKey: "sign", fingerprint: "fingerprint", endpoints: [] } };
  const replica = { sessionId: "original-session", replicaGeneration: 1, activity: "outcome_unknown" };
  const command: PendingCommand = { commandId: "original-command", hostId: "host", method, payloadHash: "hash", payload: { sessionId: "original-session" }, createdAt: "2026-10-22", state: "terminal", result: { gate: "released" } };
  const queryCommandReceipt = vi.fn(async (_commandId: string) => command);
  const retrySynchronization = vi.fn(async () => { replica.replicaGeneration++; replica.activity = "idle"; });
  const port: NativeReceiptPort = { getState: () => connection, replica: { getState: () => replica }, queryCommandReceipt, retrySynchronization };
  return { connection, replica, command, port, queryCommandReceipt, retrySynchronization };
}
describe("native original receipt review", () => {
  it("refreshes authoritative recovery state after finding the original receipt, without executing a command", async () => {
    const f = fixture(); expect(f.replica.activity).toBe("outcome_unknown");
    expect(await reviewNativeReceipt(f.port, "original-command", () => true)).toBe(f.command);
    expect(f.queryCommandReceipt).toHaveBeenCalledExactlyOnceWith("original-command");
    expect(f.retrySynchronization).toHaveBeenCalledOnce(); expect(f.replica.activity).toBe("idle");
  });
  it.each(["host", "session", "transport", "replica", "selected"])("ignores receipt authority after %s changes", async (change) => {
    const f = fixture(); let finish!: (value: PendingCommand) => void; let selected = true;
    f.queryCommandReceipt.mockImplementation(() => new Promise((yes) => { finish = yes; }));
    const pending = reviewNativeReceipt(f.port, "original-command", () => selected);
    if (change === "host") f.connection.profile = { ...f.connection.profile!, hostId: "new-host" };
    if (change === "session") f.replica.sessionId = "new-session";
    if (change === "transport") f.connection.transportGeneration++;
    if (change === "replica") f.replica.replicaGeneration++;
    if (change === "selected") selected = false;
    finish(f.command); expect(await pending).toBeUndefined(); expect(f.retrySynchronization).not.toHaveBeenCalled();
  });
  it("keeps an unknown result unknown while using only receipt and snapshot reads", async () => {
    const f = fixture(); f.command.outcomeUnknown = true; f.command.state = "receipt_unknown";
    f.retrySynchronization.mockImplementation(async () => { f.replica.replicaGeneration++; });
    const command = await reviewNativeReceipt(f.port, "original-command", () => true);
    expect(command?.outcomeUnknown).toBe(true); expect(f.replica.activity).toBe("outcome_unknown");
    expect(f.queryCommandReceipt).toHaveBeenCalledOnce(); expect(f.retrySynchronization).toHaveBeenCalledOnce();
  });
});
