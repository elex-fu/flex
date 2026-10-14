import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../storage/db.js";
import { openReadOnly } from "../storage/open-store.js";
import { DeviceRegistry, type DeviceRegistryOptions } from "../auth/device-registry.js";
import { AccessCommandReceipts, ACCESS_RECEIPTS_CAPABILITY, accessCommandRequestHash, type AccessReceiptContext, type AccessRevocationEvent } from "./access-command-receipts.js";

const stores: SqliteStore[] = [], registries: DeviceRegistry[] = [], directories: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z")); });
afterEach(() => { for (const devices of registries.splice(0)) devices.dispose(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture(options: DeviceRegistryOptions = {}) {
  const store = new SqliteStore(":memory:"); stores.push(store);
  const devices = new DeviceRegistry(store, "host-access-receipts", { recoverLeases: false, ...options }); registries.push(devices);
  const events: Array<{ event: AccessRevocationEvent; inTransaction: boolean; receiptPresent: boolean }> = [];
  const service = new AccessCommandReceipts(devices, { onRevoked: (event) => { events.push({ event, inTransaction: store.db.inTransaction, receiptPresent: !!store.getCommandReceipt(event.actorId, event.commandId) }); } });
  const device = (scopes = ["access:self", "access:admin"], protocolVersion = 2, capability = true) => {
    const record = devices.createBrowserDevice({ scopes });
    const close = vi.fn();
    const lease = devices.openLease(record.id, { kind: "fixture-direct", generation: 4, protocolVersion, capabilities: capability ? [ACCESS_RECEIPTS_CAPABILITY] : [], close });
    const context: AccessReceiptContext = { subjectId: record.id, leaseId: lease.leaseId, transportGeneration: 4, protocolVersion, capabilities: new Set(capability ? [ACCESS_RECEIPTS_CAPABILITY] : []) };
    return { record, lease, close, context };
  };
  const actor = device(), target = device(["access:self"]);
  const request = (commandId = "revoke-1", targetId = target.record.id) => ({ method: "access.revokeDevice", commandId, payload: { deviceId: targetId } });
  return { store, devices, service, events, device, actor, target, request };
}
function count(store: SqliteStore, table: string): number { return (store.db.prepare("SELECT count(*) AS count FROM " + table).get() as { count: number }).count; }

describe("scoped atomic access command receipts", () => {
  it("commits credential/auth/lease revocation and exact original actor receipt together before socket or attention publication", () => {
    const f = fixture();
    f.store.createAuthSession(createHash("sha256").update("cookie").digest("hex"), new Date(Date.now() + 60_000).toISOString(), "target-browser-auth");
    f.devices.bindAuthSession("target-browser-auth", f.target.record.id);
    const observed: boolean[] = [];
    f.target.close.mockImplementation(() => { observed.push(!f.store.db.inTransaction && !!f.store.getCommandReceipt(f.actor.record.id, "revoke-1") && !!f.devices.getDevice(f.target.record.id)?.revokedAt); });
    expect(f.service.ready()).toBe(true);
    expect(f.service.command(f.request(), f.actor.context)).toEqual({ ok: true, revoked: true });
    expect(observed).toEqual([true]); expect(f.target.close).toHaveBeenCalledWith(4401, "DEVICE_REVOKED");
    expect(f.store.getAuthSession("target-browser-auth")?.revokedAt).toBeDefined(); expect(f.store.getProtocolSession(f.target.lease.leaseId)?.disconnectedAt).toBeDefined();
    const receipt = f.service.getReceipt({ commandId: "revoke-1" }, f.actor.context);
    expect(receipt).toMatchObject({ found: true, commandId: "revoke-1", method: "access.revokeDevice", state: "completed", response: { ok: true, revoked: true } });
    expect(f.events).toMatchObject([{ inTransaction: false, receiptPresent: true, event: { actorId: f.actor.record.id, deviceId: f.target.record.id, revokedCount: 1 } }]);
    expect(f.store.getCommandReceipt(f.actor.record.id, "revoke-1")).toMatchObject({ requestFormatVersion: 2, requestHash: accessCommandRequestHash("access.revokeDevice", { deviceId: f.target.record.id }) });
    expect(f.store.getCommandReceipt(f.actor.lease.sessionId, "revoke-1")).toBeUndefined(); expect(count(f.store, "sessions")).toBe(0); expect(count(f.store, "session_events")).toBe(0); expect(count(f.store, "event_commits")).toBe(0);
  });

  it("holds all nested transaction callbacks until the outer credential transaction commits", () => {
    const f = fixture();
    f.devices.credentialTransaction(() => {
      expect(f.service.command(f.request(), f.actor.context)).toEqual({ ok: true, revoked: true });
      expect(f.store.getCommandReceipt(f.actor.record.id, "revoke-1")).toBeDefined(); expect(f.devices.getDevice(f.target.record.id)?.revokedAt).toBeDefined();
      expect(f.target.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
      expect(() => f.service.getReceipt({ commandId: "revoke-1" }, f.actor.context)).toThrow("outer transaction to commit");
    });
    expect(f.target.close).toHaveBeenCalledTimes(1); expect(f.events).toHaveLength(1); expect(f.events[0]?.inTransaction).toBe(false);
  });

  it("rolls credentials, auth sessions, leases, audits and receipt back when an outer commit fails", () => {
    const f = fixture(), auditBefore = count(f.store, "access_audit_events");
    f.store.createAuthSession("cookie-hash", new Date(Date.now() + 60_000).toISOString(), "auth-rollback"); f.devices.bindAuthSession("auth-rollback", f.target.record.id);
    expect(() => f.devices.credentialTransaction(() => { f.service.command(f.request(), f.actor.context); expect(f.target.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]); throw new Error("outer failure"); })).toThrow("outer failure");
    expect(f.devices.getDevice(f.target.record.id)?.revokedAt).toBeUndefined(); expect(f.store.getAuthSession("auth-rollback")?.revokedAt).toBeUndefined(); expect(f.store.getProtocolSession(f.target.lease.leaseId)?.disconnectedAt).toBeUndefined();
    expect(f.store.getCommandReceipt(f.actor.record.id, "revoke-1")).toBeUndefined(); expect(count(f.store, "access_audit_events")).toBe(auditBefore); expect(f.devices.assertLease(f.target.lease.leaseId).deviceId).toBe(f.target.record.id); expect(f.target.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });

  it("rolls the credential mutation back on actual receipt SQL insertion failure", () => {
    const f = fixture();
    f.store.db.exec("CREATE TRIGGER fail_access_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;");
    expect(() => f.service.command(f.request(), f.actor.context)).toThrow("receipt write failed");
    expect(f.devices.getDevice(f.target.record.id)?.revokedAt).toBeUndefined(); expect(f.store.getProtocolSession(f.target.lease.leaseId)?.disconnectedAt).toBeUndefined(); expect(count(f.store, "command_receipts")).toBe(0); expect(f.target.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });

  it("rejects unmanaged outer SQLite transactions and asynchronous work before publication", () => {
    const f = fixture();
    expect(() => f.store.db.transaction(() => f.service.command(f.request(), f.actor.context))()).toThrow("outer commit boundary");
    expect(() => f.store.db.transaction(() => f.devices.revokeDevice(f.actor.record.id, f.target.record.id))()).toThrow("outer commit boundary");
    expect(() => f.devices.credentialTransaction(() => { f.service.command(f.request(), f.actor.context); return Promise.resolve(); })).toThrow("synchronous");
    expect(f.devices.getDevice(f.target.record.id)?.revokedAt).toBeUndefined(); expect(count(f.store, "command_receipts")).toBe(0); expect(f.target.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });

  it("deduplicates the full same request and rejects another payload or format without further credential mutation", () => {
    const f = fixture(), second = f.device(["access:self"]);
    const first = f.service.command(f.request(), f.actor.context), auditAfter = count(f.store, "access_audit_events");
    expect(f.service.command(f.request(), f.actor.context)).toEqual(first); expect(f.events).toHaveLength(1); expect(f.target.close).toHaveBeenCalledTimes(1); expect(count(f.store, "access_audit_events")).toBe(auditAfter);
    expect(() => f.service.command(f.request("revoke-1", second.record.id), f.actor.context)).toThrow("another request"); expect(f.devices.getDevice(second.record.id)?.revokedAt).toBeUndefined();
    f.store.putCommandReceipt({ authSubjectId: f.actor.record.id, commandId: "format-1", method: "access.revokeDevice", requestHash: accessCommandRequestHash("access.revokeDevice", { deviceId: second.record.id }), requestFormatVersion: 1, state: "completed", response: { ok: true } });
    expect(() => f.service.command(f.request("format-1", second.record.id), f.actor.context)).toThrow("another request"); expect(f.devices.getDevice(second.record.id)?.revokedAt).toBeUndefined();
  });

  it("reports saved unknown/accepted access facts without replaying credential mutations", () => {
    const f = fixture();
    for (const state of ["accepted", "outcome_unknown"] as const) {
      const commandId = "saved-" + state, response = { status: state, source: "original-access-operation" };
      f.store.putCommandReceipt({ authSubjectId: f.actor.record.id, commandId, method: "access.revokeDevice", requestHash: accessCommandRequestHash("access.revokeDevice", { deviceId: f.target.record.id }), requestFormatVersion: 2, state, response });
      expect(f.service.getReceipt({ commandId }, f.actor.context)).toMatchObject({ found: true, commandId, method: "access.revokeDevice", state, response });
      expect(f.service.command(f.request(commandId), f.actor.context)).toEqual(response);
    }
    expect(f.devices.getDevice(f.target.record.id)?.revokedAt).toBeUndefined(); expect(f.target.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });

  it("preserves an actor's credential and connection when self-revocation's outer transaction rolls back", () => {
    const f = fixture();
    expect(() => f.devices.credentialTransaction(() => { f.service.command({ method: "access.revokeSelf", commandId: "self-rollback", payload: {} }, f.actor.context); expect(f.actor.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]); throw new Error("self rollback"); })).toThrow("self rollback");
    expect(f.devices.getDevice(f.actor.record.id)?.revokedAt).toBeUndefined(); expect(f.devices.assertLease(f.actor.lease.leaseId).deviceId).toBe(f.actor.record.id); expect(f.store.getCommandReceipt(f.actor.record.id, "self-rollback")).toBeUndefined(); expect(f.actor.close).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
  });

  it("looks up only the active original actor and rejects payload actor selectors", () => {
    const f = fixture(), other = f.device(); f.service.command(f.request(), f.actor.context);
    expect(f.service.getReceipt({ commandId: "revoke-1" }, other.context)).toEqual({ found: false, commandId: "revoke-1" });
    expect(() => f.service.getReceipt({ commandId: "revoke-1", actorId: f.actor.record.id }, other.context)).toThrow("payload is invalid");
    expect(() => f.service.getReceipt({ commandId: "revoke-1" }, { ...other.context, subjectId: f.actor.record.id })).toThrow("authenticated actor");
    expect(() => f.service.command({ ...f.request(), payload: { deviceId: f.target.record.id, actorId: f.actor.record.id } }, other.context)).toThrow("payload is invalid");
  });

  it("rechecks access:self and the original operation scope from current credentials before any receipt replay", () => {
    const f = fixture(); f.service.command(f.request(), f.actor.context);
    f.store.db.prepare("UPDATE devices SET scopes_json = ? WHERE id = ?").run(JSON.stringify(["access:self"]), f.actor.record.id);
    expect(() => f.service.getReceipt({ commandId: "revoke-1" }, f.actor.context)).toThrow("access:admin"); expect(() => f.service.command(f.request(), f.actor.context)).toThrow("access:admin");
    f.store.db.prepare("UPDATE devices SET scopes_json = ? WHERE id = ?").run(JSON.stringify(["access:admin"]), f.actor.record.id);
    expect(() => f.service.getReceipt({ commandId: "revoke-1" }, f.actor.context)).toThrow("access:self");
    const selfOnly = f.device(["access:self"]);
    expect(() => f.service.command(f.request("self-peer"), selfOnly.context)).toThrow("access:admin");
  });

  it("requires actual v2 negotiation, saved capability and current transport generation", () => {
    const f = fixture(), legacy = f.device(undefined, 1), noCap = f.device(undefined, 2, false);
    expect(() => f.service.command(f.request(), legacy.context)).toThrow("protocol version 2"); expect(() => f.service.getReceipt({ commandId: "missing" }, { ...legacy.context, protocolVersion: 2 })).toThrow("protocol version 2");
    expect(() => f.service.command(f.request(), { ...noCap.context, capabilities: new Set([ACCESS_RECEIPTS_CAPABILITY]) })).toThrow("capability is required");
    expect(() => f.service.getReceipt({ commandId: "missing" }, { ...f.actor.context, capabilities: new Set() })).toThrow("capability is required");
    expect(() => f.service.command(f.request(), { ...f.actor.context, transportGeneration: 3 })).toThrow("Transport generation"); expect(count(f.store, "command_receipts")).toBe(0); expect(f.devices.getDevice(f.target.record.id)?.revokedAt).toBeUndefined();
  });

  it("persists self-revocation proof before connection loss without restoring the revoked actor for lookup", () => {
    const f = fixture();
    const credential = f.devices.issueRefreshCredential(f.actor.record.id, Buffer.alloc(32, 9).toString("base64url"));
    const lease = f.devices.openLease(f.actor.record.id, { kind: "fixture-direct", generation: 5, protocolVersion: 2, capabilities: [ACCESS_RECEIPTS_CAPABILITY], close: () => { expect(f.store.db.inTransaction).toBe(false); expect(f.store.getCommandReceipt(f.actor.record.id, "self-revoke")?.state).toBe("completed"); } });
    const context = { ...f.actor.context, leaseId: lease.leaseId, transportGeneration: 5 };
    expect(f.service.command({ method: "access.revokeSelf", commandId: "self-revoke", payload: {} }, context)).toEqual({ ok: true, revoked: true });
    expect(f.devices.getDevice(f.actor.record.id)?.revokedAt).toBeDefined(); expect(f.store.getProtocolSession(lease.leaseId)?.closeCode).toBe("DEVICE_REVOKED");
    expect(() => f.service.getReceipt({ commandId: "self-revoke" }, context)).toThrow(); expect(() => f.devices.authenticateRefreshCredential(credential.refreshCredential)).toThrow("invalid or expired");
    const rePaired = f.device(); expect(f.service.getReceipt({ commandId: "self-revoke" }, rePaired.context)).toEqual({ found: false, commandId: "self-revoke" }); expect(f.devices.getDevice(f.actor.record.id)?.revokedAt).toBeDefined();
  });

  for (const method of ["access.revokeAll", "access.revokeAllDevices"]) it("atomically revokes all and preserves exact alias receipt for " + method, () => {
    const f = fixture();
    expect(f.service.command({ method, commandId: "all-revoke", payload: {} }, f.actor.context)).toEqual({ revoked: 2 }); expect(f.actor.close).toHaveBeenCalledTimes(1); expect(f.target.close).toHaveBeenCalledTimes(1);
    expect(f.store.getCommandReceipt(f.actor.record.id, "all-revoke")).toMatchObject({ method, state: "completed", response: { revoked: 2 }, requestHash: accessCommandRequestHash(method as "access.revokeAll", {}) });
    expect(f.events).toMatchObject([{ inTransaction: false, receiptPresent: true, event: { allDevices: true, revokedCount: 2 } }]); expect(() => f.service.getReceipt({ commandId: "all-revoke" }, f.actor.context)).toThrow();
  });

  it("never places pair/refresh in business receipts or exposes their credential response", () => {
    const f = fixture();
    for (const method of ["access.pair", "access.refresh"]) {
      expect(() => f.service.command({ method, commandId: method, payload: {} }, f.actor.context)).toThrow("payload is invalid");
      f.store.putCommandReceipt({ authSubjectId: f.actor.record.id, commandId: method, method, requestHash: "legacy", state: "completed", response: { refreshCredential: "never-return-this" } });
      expect(f.service.getReceipt({ commandId: method }, f.actor.context)).toEqual({ found: false, commandId: method });
    }
    expect(f.events).toEqual([]); expect(f.devices.getDevice(f.actor.record.id)?.revokedAt).toBeUndefined();
  });

  it("rejects missing receipt schema/read-only readiness and isolates post-commit hook failures", () => {
    const failures: unknown[] = [], f = fixture({ onCredentialEffectError: (error) => { failures.push(error); } });
    const service = new AccessCommandReceipts(f.devices, { onRevoked: () => { throw new Error("attention publication failed"); } });
    expect(service.command(f.request(), f.actor.context)).toEqual({ ok: true, revoked: true }); expect(failures).toHaveLength(1); expect(f.store.getCommandReceipt(f.actor.record.id, "revoke-1")?.state).toBe("completed"); expect(f.target.close).toHaveBeenCalledTimes(1);
    f.store.db.exec("DROP TABLE command_receipts"); expect(service.ready()).toBe(false); expect(() => service.getReceipt({ commandId: "revoke-1" }, f.actor.context)).toThrow("unavailable");
    const directory = mkdtempSync(join(tmpdir(), "flyx-access-readonly-")); directories.push(directory); const file = join(directory, "host.sqlite"), write = new SqliteStore(file); stores.push(write); write.close();
    const read = openReadOnly(file); stores.push(read); const devices = new DeviceRegistry(read, "host-access-readonly", { recoverLeases: false }); registries.push(devices); expect(new AccessCommandReceipts(devices).ready()).toBe(false);
  });
});
