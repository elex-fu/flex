import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { DeviceRegistry } from "../auth/device-registry.js";
import { assertMethodScope } from "../auth/connection-authorizer.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import type { ProviderAdapter } from "../provider/types.js";
import { RpcDispatcher, type RpcContext } from "./rpc-dispatcher.js";
import { AccessCommandReceipts, ACCESS_RECEIPTS_CAPABILITY, accessCommandRequestHash, type AccessCommandMethod, type AccessReceiptContext } from "./access-command-receipts.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse())
  await close(); });
function fixture(protocolVersion = 2, capability = true) {
  const owner = createTestHostOwner();
  const store = openOwned({ databasePath: ":memory:", owner });
  const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
  const session = store.createSession(workspace, "claude");
  const adapter: ProviderAdapter = { provider: "claude", workspace, status: async () => { throw new Error("No Provider inspection"); }, preflight: async () => { throw new Error("No paid preflight"); }, runTurn: async () => { throw new Error("No paid Turn"); }, interrupt: async () => "unavailable", respondApproval: () => false };
  const host = new SessionOrchestrator({ store, owner, sessionId: session.id, ownsStore: false, recoverOnStart: false, workspace, adapter });
  const devices = new DeviceRegistry(store, "access-dispatcher", { recoverLeases: false });
  const actor = devices.createBrowserDevice({ scopes: ["access:self", "access:admin", "session:read"] });
  const target = devices.createBrowserDevice({ scopes: ["access:self"] });
  const closed = vi.fn(() => { expect(store.db.inTransaction).toBe(false); if (devices.getDevice(target.id)?.revokedAt)
    expect(store.getCommandReceipt(actor.id, "revoke")?.state).toBe("completed"); });
  devices.openLease(target.id, { kind: "direct", generation: 9, protocolVersion: 2, close: closed });
  const capabilities = new Set(capability ? [ACCESS_RECEIPTS_CAPABILITY] : []);
  const lease = devices.openLease(actor.id, { kind: "direct", generation: 4, protocolVersion, capabilities: [...capabilities], close() { } });
  const trusted: AccessReceiptContext = { subjectId: actor.id, leaseId: lease.leaseId, transportGeneration: 4, protocolVersion, capabilities };
  const receipts = new AccessCommandReceipts(devices);
  const legacy = vi.fn(async () => ({ legacy: true }));
  const command = vi.fn((method: AccessCommandMethod, payload: unknown, commandId: string) => receipts.command({ method, payload, commandId }, trusted));
  const query = vi.fn((payload: {
    commandId: string;
  }) => receipts.getReceipt(payload, trusted));
  const context: RpcContext = { subjectId: actor.id, protocolVersion, capabilities, assertAuthorized: (method) => { const current = devices.assertLease(lease.leaseId, 4); assertMethodScope(current.scopes, method); }, subscribe: async () => ({}), access: legacy, accessCommand: command, accessReceipt: query };
  const dispatcher = new RpcDispatcher({ orchestrator: host, bootstrap: () => ({}), descriptor: () => ({}) });
  const dispatch = (method: string, payload: unknown, commandId?: string, bound = context) => dispatcher.dispatch({ id: "rpc", method, payload, ...(commandId ? { commandId } : {}) }, bound);
  cleanups.push(async () => { devices.dispose(); await host.close(); store.close(); owner.release(); });
  return { store, actor, target, devices, closed, trusted, context, command, query, legacy, dispatch };
}
describe("trusted Access receipt Dispatcher ports", () => {
  it("preserves exact command identity and commits credential revocation before returning a projected dedicated receipt", async () => {
    const f = fixture();
    const before = f.store.db.prepare("SELECT count(*) AS count FROM session_events").get();
    expect(await f.dispatch("access.revokeDevice", { deviceId: f.target.id }, "revoke")).toEqual({ ok: true, revoked: true });
    expect(f.command).toHaveBeenCalledWith("access.revokeDevice", { deviceId: f.target.id }, "revoke");
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.legacy).not.toHaveBeenCalled();
    expect(await f.dispatch("access.getReceipt", { commandId: "revoke" })).toMatchObject({ found: true, commandId: "revoke", method: "access.revokeDevice", state: "completed", response: { ok: true, revoked: true } });
    expect(await f.dispatch("command.getReceipt", { commandId: "revoke" })).toEqual({ found: false, commandId: "revoke" });
    expect(f.store.getCommandReceipt(f.actor.id, "revoke")?.targetSessionId).toBeUndefined();
    expect(f.store.db.prepare("SELECT count(*) AS count FROM session_events").get()).toEqual(before);
    const value = await f.dispatch("access.getReceipt", { commandId: "revoke" });
    expect(JSON.stringify(value)).not.toContain("requestHash");
    expect(JSON.stringify(value)).not.toContain(f.actor.id);
  });
  it("requires actual v2, negotiated capability, bound ports and a command header while retaining legacy Access behavior", async () => {
    const f = fixture();
    await expect(f.dispatch("access.revokeDevice", { deviceId: f.target.id })).rejects.toMatchObject({ code: "COMMAND_ID_REQUIRED" });
    expect(f.command).not.toHaveBeenCalled();
    const { accessCommand: _command, accessReceipt: _receipt, ...unbound } = f.context;
    await expect(f.dispatch("access.revokeDevice", { deviceId: f.target.id }, "missing", unbound)).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
    await expect(f.dispatch("access.getReceipt", { commandId: "missing" }, undefined, unbound)).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
    const v1 = fixture(1, true);
    expect(await v1.dispatch("access.revokeDevice", { deviceId: v1.target.id }, "legacy")).toEqual({ legacy: true });
    expect(v1.legacy).toHaveBeenCalledOnce();
    expect(v1.command).not.toHaveBeenCalled();
    await expect(v1.dispatch("access.getReceipt", { commandId: "legacy" })).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
    const ordinaryV2 = fixture(2, false);
    expect(await ordinaryV2.dispatch("access.revokeDevice", { deviceId: ordinaryV2.target.id }, "legacy-v2")).toEqual({ legacy: true });
    expect(ordinaryV2.command).not.toHaveBeenCalled();
    await expect(f.dispatch("access.getReceipt", { commandId: "bad", actorId: "payload-actor" })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
    await expect(f.dispatch("access.revokeDevice", { deviceId: f.target.id, actorId: "payload-actor" }, "bad")).rejects.toMatchObject({ code: "PROTOCOL_INVALID" });
    expect(f.devices.getDevice(f.target.id)?.revokedAt).toBeUndefined();
  });
  it("revalidates current original actor scope, saved capability and generation instead of trusting the port caller", async () => {
    const f = fixture();
    await f.dispatch("access.revokeDevice", { deviceId: f.target.id }, "revoke");
    f.store.db.prepare("UPDATE devices SET scopes_json=? WHERE id=?").run(JSON.stringify(["session:read"]), f.actor.id);
    await expect(f.dispatch("access.getReceipt", { commandId: "revoke" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    f.store.db.prepare("UPDATE devices SET scopes_json=? WHERE id=?").run(JSON.stringify(["access:self"]), f.actor.id);
    await expect(f.dispatch("access.getReceipt", { commandId: "revoke" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    f.store.db.prepare("UPDATE devices SET scopes_json=? WHERE id=?").run(JSON.stringify(["access:self", "access:admin"]), f.actor.id);
    f.trusted.transportGeneration = 3;
    await expect(f.dispatch("access.getReceipt", { commandId: "revoke" })).rejects.toThrow("Transport generation");
    f.trusted.transportGeneration = 4;
    const noSavedCapability = fixture(2, false);
    noSavedCapability.trusted.capabilities = new Set([ACCESS_RECEIPTS_CAPABILITY]);
    await expect(noSavedCapability.dispatch("access.getReceipt", { commandId: "missing" }, undefined, { ...noSavedCapability.context, capabilities: noSavedCapability.trusted.capabilities })).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
  });
  it("keeps receipt insertion failure atomic and returns saved unknown state without replaying revocation", async () => {
    const f = fixture();
    f.store.db.exec("CREATE TRIGGER fail BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    await expect(f.dispatch("access.revokeDevice", { deviceId: f.target.id }, "revoke")).rejects.toThrow("receipt failure");
    expect(f.devices.getDevice(f.target.id)?.revokedAt).toBeUndefined();
    expect(f.store.getCommandReceipt(f.actor.id, "revoke")).toBeUndefined();
    expect(f.closed).not.toHaveBeenCalled();
    f.store.db.exec("DROP TRIGGER fail");
    f.store.putCommandReceipt({ authSubjectId: f.actor.id, commandId: "unknown", method: "access.revokeDevice", requestHash: accessCommandRequestHash("access.revokeDevice", { deviceId: f.target.id }), requestFormatVersion: 2, state: "outcome_unknown", response: { status: "outcome_unknown", dispatchContext: { nativeRequestId: "private-original-request" } } });
    expect(await f.dispatch("access.revokeDevice", { deviceId: f.target.id }, "unknown")).toEqual({ status: "outcome_unknown" });
    expect(await f.dispatch("access.getReceipt", { commandId: "unknown" })).toMatchObject({ found: true, state: "outcome_unknown", response: { status: "outcome_unknown" } });
    expect(f.devices.getDevice(f.target.id)?.revokedAt).toBeUndefined();
    expect(f.closed).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
  });
});
