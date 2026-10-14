import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecoveryCapability } from "@flyx/mvp-protocol";
import type { RecoveryEvidence } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { SqliteStore } from "../storage/db.js";
import { RecoveryStore } from "../storage/recovery-store.js";
import type { DispatchContext, ProviderAdapter } from "../provider/types.js";
import type { AppServerClient } from "../codex/app-server-client.js";
import { ConnectionGateway, type DuplexTransport } from "./connection-gateway.js";

class MemoryTransport implements DuplexTransport {
  readonly id = randomUUID(); readonly kind = "direct" as const; readonly generation = 1;
  readonly sent: Array<Record<string, unknown>> = []; readonly closes: string[] = [];
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  async send(data: string | Uint8Array): Promise<void> { this.sent.push(JSON.parse(String(data)) as Record<string, unknown>); }
  close(_code?: number, reason?: string): void { this.closes.push(reason ?? "closed"); }
  onMessage(handler: (data: string | Uint8Array) => void) { this.messages.add(handler); return () => this.messages.delete(handler); }
  onClose() { return () => {}; }
  emit(frame: Record<string, unknown>) { for (const handler of this.messages) handler(JSON.stringify(frame)); }
}
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));
function fixture(scopes = ["session:read", "session:write"]) {
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const owner = createTestHostOwner(); const store = new SqliteStore();
  const devices = new DeviceRegistry(store, "host-test");
  const original = devices.createBrowserDevice(); const actor = devices.createBrowserDevice({ scopes });
  const session = store.createSession(workspace, "codex");
  store.acceptTurn({ authSubjectId: original.id, sessionId: session.id, turnId: "original-turn", commandId: "original-command", requestHash: "original-hash", prompt: "original prompt", generation: 1, attemptId: "original-attempt" });
  const context: DispatchContext = { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: session.id,
    flyxTurnId: "original-turn", runtimeId: "original-runtime", runtimeGeneration: 1, attemptId: "original-attempt" };
  new RecoveryStore(store).recordNativeBinding({ context, provider: "codex", providerInstanceId: "private-instance", nativeSessionId: "private-native-session", nativeTurnId: "private-native-turn", workspacePath: workspace, configurationFingerprint: "verified-private-policy", verifiedVersion: "verified-test" });
  store.commitEvent(session.id, "turn.unknown", {}, { turnId: "original-turn", turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
  const adapter: ProviderAdapter = { provider: "codex", workspace, status: async () => { throw new Error("No Provider status call"); }, preflight: async () => { throw new Error("No paid preflight"); }, runTurn: async () => { throw new Error("No user execution"); }, interrupt: async () => "unavailable", respondApproval: () => false };
  const reads: string[] = [];
  const client: Pick<AppServerClient, "request"> = { request: async <T>(method: string): Promise<T> => { reads.push(method); return { thread: { id: "private-native-session", turns: [{ id: "private-native-turn", status: "completed" }] } } as T; } };
  const host = new SessionOrchestrator({ workspace, store, owner, adapter, recoverOnStart: false,
    recovery: { resolveResource: () => ({ provider: "codex", providerInstanceId: "private-instance", workspacePath: workspace, configurationFingerprint: "verified-private-policy", verifiedVersions: ["verified-test"], readerVersion: "verified-test" }), codexReader: () => client } });
  const gateway = new ConnectionGateway({ hostId: "host-test", fingerprint: `sha256:${"a".repeat(64)}`, orchestrator: host, devices,
    bootstrap: () => host.bootstrap(), descriptor: () => ({ hostId: "host-test" }), confirmPairing: () => true, maxFrameBytes: 2048, responseBudgetBytes: 2048 });
  const transport = new MemoryTransport(); gateway.attach(transport, { deviceId: actor.id });
  cleanup.push(() => { gateway.close(); devices.close(); host.close(); });
  const hello = (capabilities = [RecoveryCapability] as string[]) => transport.emit({ type: "client.hello", clientId: "test", hostId: "host-test", protocol: { min: 2, max: 2 }, capabilities, transportGeneration: 1 });
  const target = { sessionId: session.id, turnId: "original-turn", attemptId: "original-attempt" };
  const request = (id: string, method: string, payload: unknown, commandId?: string) => transport.emit({ type: "request", id, method, payload, ...(commandId ? { commandId } : {}), transportGeneration: 1 });
  return { host, store, devices, gateway, transport, actor, original, hello, request, target, reads };
}
async function response(transport: MemoryTransport, id: string) {
  for (let step = 0; step < 20; step++) {
    await new Promise<void>((yes) => setImmediate(yes));
    const frame = transport.sent.find((frame) => frame.type === "response" && frame.id === id);
    if (frame) return frame;
  }
  throw new Error(`Missing response ${id}`);
}

describe("actual Gateway Session recovery admission", () => {
  it("negotiates recovery and settles original actor receipts while unproved process stop visibly blocks new prompts", async () => {
    const f = fixture(); f.hello(); f.request("inspect", "session.recovery.inspect", f.target);
    const inspected = await response(f.transport, "inspect"); expect(inspected.ok).toBe(true);
    const evidence = inspected.payload as RecoveryEvidence;
    expect(evidence).toMatchObject({ nativeState: "terminal", processState: "unknown" });
    f.request("reconcile", "session.recovery.reconcile", { ...f.target, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision }, "recovery-command");
    expect(await response(f.transport, "reconcile")).toMatchObject({ ok: true, payload: { gate: "blocked", turnStatus: "completed" } });
    expect(f.store.getCommandReceipt(f.original.id, "original-command")?.state).toBe("completed");
    expect(f.store.getCommandReceipt(f.actor.id, "recovery-command")?.method).toBe("session.recovery.reconcile");
    expect(f.store.getCommandReceipt(f.actor.id, "original-command")).toBeUndefined();
    f.request("new-turn", "session.startTurn", { prompt: "new prompt" }, "new-command");
    expect(await response(f.transport, "new-turn")).toMatchObject({ ok: false, error: { code: "RECOVERY_BLOCKED" } });
    const completedTurn = f.store.getTurn(f.target.turnId);
    f.request("old-interrupt", "session.interrupt", {}, "old-interrupt-command");
    expect(await response(f.transport, "old-interrupt")).toMatchObject({ ok: false, error: { code: "RECOVERY_BLOCKED" } });
    expect(f.store.getCommandReceipt(f.actor.id, "old-interrupt-command")).toBeUndefined();
    expect(f.host.execution.forCommand(f.actor.id, "old-interrupt-command")).toEqual([]);
    expect(f.store.getTurn(f.target.turnId)).toEqual(completedTurn);
    expect(f.transport.closes).toEqual([]);
    const output = JSON.stringify(f.transport.sent);
    expect(output).not.toContain("private-native-session"); expect(output).not.toContain("private-native-turn"); expect(output).not.toContain("verified-private-policy"); expect(output).not.toContain(f.host.workspace);
    expect(f.transport.sent.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= 2048)).toBe(true);
    expect(f.reads).toEqual(["thread/read", "thread/read"]);
  });

  it("enforces Session read/write scopes before recovery markers and refuses client-supplied conclusions", async () => {
    const f = fixture(["session:read"]); f.hello(); f.request("inspect", "session.recovery.inspect", f.target);
    const evidence = (await response(f.transport, "inspect")).payload as RecoveryEvidence;
    const payload = { ...f.target, evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision };
    f.request("forbidden", "session.recovery.reconcile", payload, "forbidden-command");
    expect(await response(f.transport, "forbidden")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(f.store.getCommandReceipt(f.actor.id, "forbidden-command")).toBeUndefined();
    f.request("injected", "session.recovery.inspect", { ...f.target, treeStopped: true });
    expect(await response(f.transport, "injected")).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    f.request("implicit-latest", "session.recovery.inspect", { turnId: "original-turn" });
    expect(await response(f.transport, "implicit-latest")).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("requires negotiated capability and exact original Session/attempt identity", async () => {
    const f = fixture(); f.hello([]); f.request("unnegotiated", "session.recovery.inspect", f.target);
    expect(await response(f.transport, "unnegotiated")).toMatchObject({ ok: false, error: { code: "CAPABILITY_REQUIRED" } });
    const exact = fixture(); exact.hello(); exact.request("wrong-session", "session.recovery.inspect", { ...exact.target, sessionId: "latest-other" });
    expect(await response(exact.transport, "wrong-session")).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    exact.request("wrong-attempt", "session.recovery.inspect", { ...exact.target, attemptId: "newer-attempt" });
    expect(await response(exact.transport, "wrong-attempt")).toMatchObject({ ok: false, error: { code: "RECOVERY_ATTEMPT_MISMATCH" } });
  });
});
