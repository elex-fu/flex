import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../storage/db.js";
import { ConnectionAuthorizer, assertMethodScope, requiredScopeForMethod, validateScopes } from "./connection-authorizer.js";
import { DeviceRegistry } from "./device-registry.js";

describe("connection scope authorization", () => {
  const store = new SqliteStore();
  const devices = new DeviceRegistry(store, "scope-host");
  afterEach(() => devices.dispose());
  afterAll(() => store.close());

  it("keeps writes, approvals and device administration independently scoped", () => {
    const reader = { scopes: new Set(["host:read", "session:read", "access:self"]) };
    for (const method of ["host.bootstrap", "host.getStatus", "host.getDescriptor", "host.getSnapshot", "session.getEvents", "session.subscribe", "session.getDiff", "command.getReceipt", "access.refresh", "access.revokeSelf"]) {
      expect(() => assertMethodScope(reader, method)).not.toThrow();
    }
    for (const method of ["session.startTurn", "session.interrupt", "approval.respond", "access.listDevices", "access.revokeDevice", "access.revokeAll"]) {
      expect(() => assertMethodScope(reader, method)).toThrow("permission");
    }
    expect(() => assertMethodScope(new Set(["session:write"]), "approval.respond")).toThrow("approval:write");
    expect(() => assertMethodScope(new Set(["access:admin"]), "session.startTurn")).toThrow("session:write");
  });

  it("fails closed for unknown methods, prototype names, and pairing on an authenticated dispatcher", () => {
    const owner = { scopes: new Set(["host:read", "session:read", "session:write", "approval:write", "access:self", "access:admin"]) };
    for (const method of ["access.pair", "session.deleteEverything", "__proto__", "constructor", "toString"]) {
      expect(requiredScopeForMethod(method)).toBeUndefined();
      expect(() => assertMethodScope(owner, method)).toThrow("not supported");
    }
  });

  it("canonicalizes only the explicit legacy scope aliases and rejects aliases that collide", () => {
    expect(validateScopes([
      "host.read",
      "session.read",
      "session.control",
      "approval.respond",
      "access.admin",
    ])).toEqual(["host:read", "session:read", "session:write", "approval:write", "access:admin"]);
    expect(validateScopes(["session.write", "approval.write", "host.admin"]))
      .toEqual(["session:write", "approval:write", "access:admin"]);
    for (const scopes of [
      ["host:read", "host.read"],
      ["session.write", "session.control"],
      ["access.admin", "host.admin"],
      ["admin"],
      ["access"],
      ["admin:access"],
    ]) expect(() => validateScopes(scopes)).toThrow();
  });

  it("authorizes persisted alias scopes through their canonical permissions", () => {
    const device = devices.createBrowserDevice({ scopes: ["host.read", "session.control", "approval.respond", "host.admin"] });
    expect(device.scopes).toEqual(["host:read", "session:write", "approval:write", "access:admin"]);
    store.db.prepare("UPDATE devices SET scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["host.read", "session.control", "approval.respond", "host.admin"]), device.id);
    const lease = devices.openLease(device.id, { kind: "direct-https", generation: 2, protocolVersion: 2, close: () => undefined });
    const authorizer = new ConnectionAuthorizer(devices);
    for (const method of ["host.probe", "session.startTurn", "session.interrupt", "approval.respond", "access.listDevices"]) {
      expect(() => authorizer.authorize(lease.leaseId, method, 2)).not.toThrow();
    }
  });

  it("revalidates persisted scopes and revocation on every RPC, not only at handshake", () => {
    const device = devices.createBrowserDevice({ scopes: ["session:read", "session:write", "access:self"] });
    const lease = devices.openLease(device.id, { kind: "direct-https", generation: 1, protocolVersion: 2, close: () => undefined });
    const authorizer = new ConnectionAuthorizer(devices);
    expect(authorizer.authorize(lease.leaseId, "session.startTurn", 1).deviceId).toBe(device.id);
    store.db.prepare("UPDATE devices SET scopes_json = ? WHERE id = ?").run(JSON.stringify(["session:read", "access:self"]), device.id);
    expect(() => authorizer.authorize(lease.leaseId, "session.startTurn", 1)).toThrow("session:write");
    expect(store.listAccessAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "scope.denied", targetId: "session.startTurn", resultCode: "FORBIDDEN" })]));
    devices.revokeSelf(device.id);
    expect(() => authorizer.authorize(lease.leaseId, "session.getEvents", 1)).toThrow("no longer active");
  });
});
