import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../storage/db.js";
import { DeviceRegistry, REFRESH_CREDENTIAL_TTL_MS, type DeviceRegistryOptions } from "./device-registry.js";

const HOST_ID = "host-auth-tests";
const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const stores: SqliteStore[] = [];
const registries: DeviceRegistry[] = [];
const directories: string[] = [];

function registry(options: DeviceRegistryOptions = {}, path = ":memory:", hostId = HOST_ID): DeviceRegistry {
  const store = new SqliteStore(path);
  stores.push(store);
  const devices = new DeviceRegistry(store, hostId, options);
  registries.push(devices);
  return devices;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "flyx-auth-test-"));
  directories.push(directory);
  return join(directory, "host.sqlite");
}

async function paired(devices: DeviceRegistry, byte = 1, scopes?: string[]) {
  const grant = devices.createPairingGrant(scopes ? { scopes } : {});
  const device = await devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(byte) }, () => true);
  return { device, grant };
}

function open(devices: DeviceRegistry, deviceId: string, close = vi.fn()) {
  const lease = devices.openLease(deviceId, { kind: "relay-wss", protocolVersion: 2, generation: 4, close });
  return { lease, close };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
});

afterEach(() => {
  for (const devices of registries.splice(0)) devices.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("confirmed device pairing", () => {
  it("consumes a grant exactly once across two SQLite connections and pending confirmations", async () => {
    const path = databasePath();
    const first = registry({}, path);
    const second = registry({ recoverLeases: false }, path);
    const grant = first.createPairingGrant();
    let approveFirst!: (approved: boolean) => void;
    let approveSecond!: (approved: boolean) => void;
    const a = first.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, () => new Promise<boolean>((resolve) => { approveFirst = resolve; }));
    const b = second.pair({ grant: grant.grant, proposedDevicePublicKey: key(2) }, () => new Promise<boolean>((resolve) => { approveSecond = resolve; }));
    approveFirst(true);
    approveSecond(true);
    const results = await Promise.allSettled([a, b]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const devices = first.listDevices();
    expect(devices).toHaveLength(1);
    expect(first.store.getPairingGrant(hash(grant.grant))).toMatchObject({
      hostId: HOST_ID, deviceId: devices[0]!.id, approvedAt: expect.any(String), consumedAt: expect.any(String),
    });
    expect(second.authenticatePublicKey(devices[0]!.publicKey!).id).toBe(devices[0]!.id);
  });

  it("rejects an invalid grant before confirmation, and rechecks expiry after confirmation", async () => {
    const devices = registry();
    const confirm = vi.fn(() => true);
    await expect(devices.pair({ grant: "garbage", proposedDevicePublicKey: key(1) }, confirm)).rejects.toMatchObject({ code: "PAIRING_INVALID" });
    expect(confirm).not.toHaveBeenCalled();
    const grant = devices.createPairingGrant({ ttlMs: 10 });
    await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, () => {
      vi.setSystemTime(Date.now() + 10);
      return true;
    })).rejects.toMatchObject({ code: "PAIRING_INVALID" });
    expect(devices.listDevices()).toHaveLength(0);
    expect(devices.store.getPairingGrant(hash(grant.grant))?.consumedAt).toBeUndefined();
  });

  it("does not consume denied grants or accept a host-scoped grant for another Host", async () => {
    const path = databasePath();
    const devices = registry({}, path);
    const otherHost = registry({}, path, "other-host");
    const grant = devices.createPairingGrant();
    await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, () => false)).rejects.toMatchObject({ code: "PAIRING_DENIED" });
    const confirm = vi.fn(() => true);
    await expect(otherHost.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, confirm)).rejects.toMatchObject({ code: "PAIRING_INVALID" });
    expect(confirm).not.toHaveBeenCalled();
    expect(devices.store.getPairingGrant(hash(grant.grant))?.consumedAt).toBeUndefined();
    await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, confirm)).resolves.toMatchObject({ hostId: HOST_ID });
  });

  it("rolls back approval and consumption when device persistence fails", async () => {
    const devices = registry();
    const grant = devices.createPairingGrant();
    devices.store.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
    await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, () => true)).rejects.toThrow("injected persistence failure");
    expect(devices.store.getPairingGrant(hash(grant.grant))).not.toHaveProperty("consumedAt");
    expect(devices.store.getPairingGrant(hash(grant.grant))).not.toHaveProperty("approvedAt");
    devices.store.db.exec("DROP TRIGGER injected_failure");
    await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1) }, () => true)).resolves.toMatchObject({ publicKey: key(1) });
  });

  it("cannot escalate a grant's scopes and shows the approved subset in the confirmation", async () => {
    const devices = registry();
    const grant = devices.createPairingGrant({ scopes: ["host:read", "session:read"] });
    const confirm = vi.fn(() => true);
    await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1), scopes: ["access:admin"] }, confirm)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(confirm).not.toHaveBeenCalled();
    const device = await devices.pair({ grant: grant.grant, proposedDevicePublicKey: key(1), scopes: ["session:read"], deviceInfo: { displayName: "Read only phone", platform: "ios" } }, confirm);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Read only phone", platform: "ios", scopes: ["session:read"] }));
    expect(device.scopes).toEqual(["session:read"]);
    expect(() => devices.createPairingGrant({ scopes: ["unknown:permission"] })).toThrow("unsupported permission");
  });

  it("does not revive a consumed or expired grant when a static startup token is reused", () => {
    const devices = registry();
    const tokenHash = hash("old configured startup token");
    devices.store.createPairingGrant(tokenHash, new Date(Date.now() + 10).toISOString());
    expect(devices.store.consumePairingGrant(tokenHash)).toBe(true);
    devices.store.createPairingGrant(tokenHash, new Date(Date.now() + 60_000).toISOString());
    expect(devices.store.hasActivePairingGrant(tokenHash)).toBe(false);
    const expiredHash = hash("expired configured startup token");
    devices.store.createPairingGrant(expiredHash, new Date(Date.now() - 1).toISOString());
    devices.store.createPairingGrant(expiredHash, new Date(Date.now() + 60_000).toISOString());
    expect(devices.store.hasActivePairingGrant(expiredHash)).toBe(false);
  });

  it("rejects malformed and noncanonical device keys before granting access", async () => {
    const devices = registry();
    const grant = devices.createPairingGrant();
    const confirm = vi.fn(() => true);
    for (const publicKey of ["short", key(1) + "=", key(0), Buffer.alloc(31, 1).toString("base64url")]) {
      await expect(devices.pair({ grant: grant.grant, proposedDevicePublicKey: publicKey }, confirm)).rejects.toMatchObject({ code: "DEVICE_KEY_INVALID" });
    }
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("browser authentication and lease lifetime", () => {
  it("migrates a v1 browser session once without resurrecting a revoked mapped device", () => {
    const devices = registry();
    devices.store.createAuthSession(hash("cookie"), new Date(Date.now() + 60_000).toISOString(), "browser-auth");
    const first = devices.ensureBrowserSessionDevice("browser-auth");
    expect(devices.ensureBrowserSessionDevice("browser-auth").id).toBe(first.id);
    expect(devices.listDevices()).toHaveLength(1);
    expect(devices.getDeviceForAuthSession("browser-auth")?.id).toBe(first.id);
    devices.revokeSelf(first.id);
    expect(devices.getDeviceForAuthSession("browser-auth")).toBeUndefined();
    expect(() => devices.ensureBrowserSessionDevice("browser-auth")).toThrow();
    expect(devices.listDevices()).toHaveLength(1);
  });

  it("re-keys persisted v1 receipts and Turn ownership to the stable device for idempotent retries", () => {
    const devices = registry();
    const authSessionId = "legacy-browser-auth";
    const commandId = "persisted-v1-command";
    const requestHash = "persisted-v1-request-hash";
    devices.store.createAuthSession(hash("legacy cookie"), new Date(Date.now() + 60_000).toISOString(), authSessionId);
    const session = devices.store.createSession("/tmp/legacy-workspace");
    devices.store.createTurn({
      authSubjectId: authSessionId,
      sessionId: session.id,
      turnId: "persisted-v1-turn",
      commandId,
      requestHash,
      prompt: "must execute once",
      generation: 1,
    });
    const response = { turnId: "persisted-v1-turn", status: "accepted" };
    devices.store.putCommandReceipt({
      authSubjectId: authSessionId,
      commandId,
      method: "session.startTurn",
      requestHash,
      state: "accepted",
      response,
    });

    const device = devices.ensureBrowserSessionDevice(authSessionId);
    expect(devices.store.getCommandReceipt(authSessionId, commandId)).toBeUndefined();
    expect(devices.store.getCommandReceipt(device.id, commandId)).toMatchObject({ requestHash, response });
    expect(devices.store.getTurn("persisted-v1-turn")?.authSubjectId).toBe(device.id);

    // Re-running the upgrade (including after restart) keeps one canonical
    // receipt rather than creating a second execution namespace.
    expect(devices.ensureBrowserSessionDevice(authSessionId).id).toBe(device.id);
    expect(devices.store.db.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE command_id = ?")
      .get(commandId)).toEqual({ count: 1 });
  });

  it("links an already approved direct grant without consuming it twice", () => {
    const devices = registry();
    const grant = devices.createPairingGrant();
    expect(() => devices.createBrowserDevice({ pairingGrant: grant.grant })).toThrow("not approved");
    expect(devices.listDevices()).toHaveLength(0);
    expect(devices.store.consumePairingGrant(hash(grant.grant))).toBe(true);
    const device = devices.createBrowserDevice({ pairingGrant: grant.grant });
    expect(devices.store.getPairingGrant(hash(grant.grant))?.deviceId).toBe(device.id);
    expect(() => devices.createBrowserDevice({ pairingGrant: grant.grant })).toThrow("already been registered");
    expect(devices.listDevices()).toHaveLength(1);
  });

  it("inherits the approved grant's permissions for the direct browser exchange", () => {
    const devices = registry();
    const grant = devices.createPairingGrant({ scopes: ["host:read"] });
    expect(devices.store.consumePairingGrant(hash(grant.grant))).toBe(true);
    expect(() => devices.createBrowserDevice({ pairingGrant: grant.grant, scopes: ["access:admin"] })).toThrow("increase");
    expect(devices.listDevices()).toHaveLength(0);
    expect(devices.createBrowserDevice({ pairingGrant: grant.grant }).scopes).toEqual(["host:read"]);
  });

  it("will not remap an auth session or open a browser lease from revoked authorization", () => {
    const devices = registry();
    const first = devices.createBrowserDevice();
    const second = devices.createBrowserDevice();
    devices.store.createAuthSession(hash("cookie"), new Date(Date.now() + 60_000).toISOString(), "browser-auth");
    devices.bindAuthSession("browser-auth", first.id);
    expect(() => devices.bindAuthSession("browser-auth", second.id)).toThrow("another device");
    devices.revokeAuthSession("browser-auth");
    expect(() => devices.openLease(first.id, { kind: "direct-https", protocolVersion: 2, generation: 1, authSessionId: "browser-auth", close: vi.fn() })).toThrow("no longer active");
    expect(devices.getDeviceForAuthSession("browser-auth")).toBeUndefined();
  });

  it("expires idle browser sockets at the auth expiry and refuses reconnect at the exact boundary", () => {
    const devices = registry({ leaseTtlMs: 60_000 });
    const device = devices.createBrowserDevice();
    const expiresAt = new Date(Date.now() + 500).toISOString();
    devices.store.createAuthSession(hash("cookie"), expiresAt, "browser-auth");
    devices.bindAuthSession("browser-auth", device.id);
    const close = vi.fn();
    const lease = devices.openLease(device.id, { kind: "direct-https", protocolVersion: 2, generation: 1, authSessionId: "browser-auth", close });
    expect(lease.expiresAt).toBe(expiresAt);
    vi.advanceTimersByTime(500);
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(4401, "LEASE_EXPIRED");
    expect(devices.store.getProtocolSession(lease.leaseId)).toMatchObject({ disconnectedAt: expiresAt, closeCode: "LEASE_EXPIRED" });
    expect(() => devices.openLease(device.id, { kind: "direct-https", protocolVersion: 2, generation: 2, authSessionId: "browser-auth", close })).toThrow("no longer active");
  });

  it("immediately closes every lease for a revoked device while preserving other devices", async () => {
    const devices = registry();
    const { device: admin } = await paired(devices, 1);
    const { device: phone } = await paired(devices, 2);
    const first = open(devices, phone.id);
    const second = open(devices, phone.id);
    const unaffected = open(devices, admin.id);
    expect(devices.revokeDevice(admin.id, phone.id)).toBe(true);
    expect(first.close).toHaveBeenCalledWith(4401, "DEVICE_REVOKED");
    expect(second.close).toHaveBeenCalledWith(4401, "DEVICE_REVOKED");
    expect(unaffected.close).not.toHaveBeenCalled();
    expect(() => devices.authenticatePublicKey(key(2))).toThrow("revoked");
    expect(() => open(devices, phone.id)).toThrow("revoked");
    expect(devices.assertLease(unaffected.lease.leaseId).deviceId).toBe(admin.id);
  });

  it("revokes only the logged-out browser session's sockets immediately", () => {
    const devices = registry();
    const device = devices.createBrowserDevice();
    const make = (id: string) => {
      devices.store.createAuthSession(hash(id), new Date(Date.now() + 60_000).toISOString(), id);
      devices.bindAuthSession(id, device.id);
      const close = vi.fn();
      const lease = devices.openLease(device.id, { kind: "direct-https", protocolVersion: 2, generation: 1, authSessionId: id, close });
      return { lease, close };
    };
    const first = make("browser-1");
    const second = make("browser-2");
    devices.revokeAuthSession("browser-1");
    expect(first.close).toHaveBeenCalledWith(4401, "AUTH_REVOKED");
    expect(second.close).not.toHaveBeenCalled();
    expect(devices.assertLease(second.lease.leaseId).deviceId).toBe(device.id);
  });

  it("closes sockets after a committed cross-process local revocation", async () => {
    const path = databasePath();
    const host = registry({}, path);
    const localCli = registry({ recoverLeases: false }, path);
    const { device } = await paired(host);
    const { close } = open(host, device.id);
    localCli.revokeFromLocal(device.id);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(close).toHaveBeenCalledWith(4401, "DEVICE_REVOKED");
  });

  it("fences stale generations and refresh cannot extend a browser auth lifetime", () => {
    const devices = registry({ leaseTtlMs: 1_000 });
    const device = devices.createBrowserDevice();
    devices.store.createAuthSession(hash("cookie"), new Date(Date.now() + 1_500).toISOString(), "browser-auth");
    devices.bindAuthSession("browser-auth", device.id);
    const close = vi.fn();
    const lease = devices.openLease(device.id, { kind: "direct-https", protocolVersion: 2, generation: 4, authSessionId: "browser-auth", close });
    vi.advanceTimersByTime(500);
    const renewed = devices.refreshLease(lease.leaseId);
    expect(renewed.expiresAt).toBe(devices.store.getAuthSession("browser-auth")?.expiresAt);
    expect(() => devices.assertLease(lease.leaseId, 3)).toThrow("generation");
    expect(close).toHaveBeenCalledWith(4409, "STALE_GENERATION");
    expect(() => devices.assertLease(lease.leaseId, 4)).toThrow("no longer active");
  });

  it("invalidates orphaned persisted leases on Host restart", async () => {
    const path = databasePath();
    const previous = registry({}, path);
    const { device } = await paired(previous);
    const { lease, close } = open(previous, device.id);
    const restarted = registry({}, path);
    expect(restarted.store.getProtocolSession(lease.leaseId)).toMatchObject({ closeCode: "HOST_RESTART", disconnectedAt: expect.any(String) });
    expect(() => restarted.assertLease(lease.leaseId)).toThrow("no longer active");
    previous.expireLeases();
    expect(close).toHaveBeenCalledOnce();
    expect(open(restarted, device.id).lease.deviceId).toBe(device.id);
  });

  it("revoke-all invalidates grants and legacy auth sessions as well as all devices", () => {
    const devices = registry();
    const admin = devices.createBrowserDevice();
    const phone = devices.createBrowserDevice();
    const grant = devices.createPairingGrant();
    devices.store.createAuthSession(hash("legacy cookie"), new Date(Date.now() + 60_000).toISOString(), "legacy-auth");
    const { close } = open(devices, phone.id);
    expect(devices.revokeAll(admin.id)).toBe(2);
    expect(close).toHaveBeenCalledWith(4401, "DEVICE_REVOKED");
    expect(devices.store.hasActivePairingGrant(hash(grant.grant))).toBe(false);
    expect(devices.store.getAuthSession("legacy-auth")?.revokedAt).toBeDefined();
    expect(() => devices.ensureBrowserSessionDevice("legacy-auth")).toThrow("no longer active");
    expect(devices.revokeAllFromLocal()).toBe(0);
  });

  it("does not let self-only devices revoke peers, administer access, or rotate without access:self", () => {
    const devices = registry();
    const self = devices.createBrowserDevice({ scopes: ["access:self"] });
    const peer = devices.createBrowserDevice();
    expect(() => devices.revokeDevice(self.id, peer.id)).toThrow("access:admin");
    expect(() => devices.revokeAll(self.id)).toThrow("access:admin");
    expect(devices.revokeSelf(self.id)).toBe(true);
    expect(devices.getDevice(peer.id)?.revokedAt).toBeUndefined();
    const readonly = devices.createBrowserDevice({ scopes: ["host:read"] });
    expect(() => devices.issueRefreshCredential(readonly.id, key(9))).toThrow("access:self");
  });
});

describe("rotating browser refresh credentials", () => {
  it("rebinds a stable device to a new memory-only key, consumes old tokens, and closes old leases", async () => {
    const devices = registry();
    const { device, grant } = await paired(devices);
    const initial = devices.issueRefreshCredential(device.id);
    const { lease, close } = open(devices, device.id);
    const next = devices.refreshDeviceCredential({ refreshCredential: initial.refreshCredential, proposedDevicePublicKey: key(2) });
    expect(next.deviceId).toBe(device.id);
    expect(next.scopes).toEqual(device.scopes);
    expect(next.refreshCredential).not.toBe(initial.refreshCredential);
    expect(devices.authenticateRefreshCredential(next.refreshCredential).id).toBe(device.id);
    expect(() => devices.authenticateRefreshCredential(initial.refreshCredential)).toThrow("invalid or expired");
    expect(close).toHaveBeenCalledWith(4401, "CREDENTIAL_ROTATED");
    expect(devices.store.getProtocolSession(lease.leaseId)?.disconnectedAt).toBeDefined();
    expect(() => devices.authenticatePublicKey(key(1))).toThrow("not registered");
    expect(devices.authenticatePublicKey(key(2)).id).toBe(device.id);
    expect(() => devices.refreshDeviceCredential({ refreshCredential: initial.refreshCredential, proposedDevicePublicKey: key(3) })).toThrow("invalid or expired");
    const stored = devices.store.db.prepare("SELECT credential_hash FROM devices WHERE id = ?").get(device.id) as { credential_hash: string };
    expect(stored.credential_hash).toBe(hash(next.refreshCredential));
    const audit = JSON.stringify(devices.store.listAccessAudit());
    for (const secret of [initial.refreshCredential, next.refreshCredential, grant.grant, key(1), key(2)]) expect(audit).not.toContain(secret);
  });

  it("uses a refresh compare-and-set even when another connection rotates between lookup and update", async () => {
    const path = databasePath();
    const first = registry({}, path);
    const second = registry({ recoverLeases: false }, path);
    const { device } = await paired(first);
    const initial = first.issueRefreshCredential(device.id);
    const lookup = first.store.findDeviceByCredentialHash.bind(first.store);
    let winner: ReturnType<DeviceRegistry["refreshDeviceCredential"]> | undefined;
    vi.spyOn(first.store, "findDeviceByCredentialHash").mockImplementationOnce((hostId, tokenHash) => {
      const stale = lookup(hostId, tokenHash);
      winner = second.refreshDeviceCredential({ refreshCredential: initial.refreshCredential, proposedDevicePublicKey: key(2) });
      return stale;
    });
    expect(() => first.refreshDeviceCredential({ refreshCredential: initial.refreshCredential, proposedDevicePublicKey: key(3) })).toThrow("invalid or expired");
    expect(first.authenticatePublicKey(key(2)).id).toBe(device.id);
    expect(() => first.authenticatePublicKey(key(3))).toThrow("not registered");
    expect(first.refreshDeviceCredential({ refreshCredential: winner!.refreshCredential, proposedDevicePublicKey: key(4) }).deviceId).toBe(device.id);
  });

  it("rejects a persisted device-ticket revision after another process rotates its token", async () => {
    const path = databasePath();
    const host = registry({}, path);
    const peer = registry({ recoverLeases: false }, path);
    const { device } = await paired(host);
    const initial = host.issueRefreshCredential(device.id);
    const ticket = host.authenticateRefreshCredential(initial.refreshCredential);
    expect(ticket.credentialRevision).toBe(initial.credentialRevision);
    expect(host.assertCredentialRevision(ticket.id, ticket.credentialRevision).id).toBe(device.id);

    const rotated = peer.refreshDeviceCredential({
      refreshCredential: initial.refreshCredential,
      proposedDevicePublicKey: key(2),
    });
    expect(rotated.credentialRevision).toBe(ticket.credentialRevision + 1);
    expect(() => host.assertCredentialRevision(ticket.id, ticket.credentialRevision)).toThrow("credential has changed");
    expect(host.assertCredentialRevision(ticket.id, rotated.credentialRevision).id).toBe(device.id);
  });

  it("rejects expired or revoked refresh tokens and the corresponding expired static key", async () => {
    const devices = registry();
    const first = await paired(devices, 1);
    const credential = devices.issueRefreshCredential(first.device.id);
    vi.advanceTimersByTime(REFRESH_CREDENTIAL_TTL_MS);
    expect(() => devices.authenticateRefreshCredential(credential.refreshCredential)).toThrow("invalid or expired");
    expect(() => devices.refreshDeviceCredential({ refreshCredential: credential.refreshCredential, proposedDevicePublicKey: key(2) })).toThrow("invalid or expired");
    expect(() => devices.authenticatePublicKey(key(1))).toThrow("expired");
    const second = await paired(devices, 3);
    const revokedCredential = devices.issueRefreshCredential(second.device.id);
    devices.revokeSelf(second.device.id);
    expect(() => devices.authenticateRefreshCredential(revokedCredential.refreshCredential)).toThrow("invalid or expired");
    expect(() => devices.refreshDeviceCredential({ refreshCredential: revokedCredential.refreshCredential, proposedDevicePublicKey: key(4) })).toThrow("invalid or expired");
  });

  it("does not consume a refresh token or close its lease if the proposed key is already owned", async () => {
    const devices = registry();
    const first = await paired(devices, 1);
    await paired(devices, 2);
    const token = devices.issueRefreshCredential(first.device.id);
    const { lease, close } = open(devices, first.device.id);
    expect(() => devices.refreshDeviceCredential({ refreshCredential: token.refreshCredential, proposedDevicePublicKey: key(2) })).toThrow("another device");
    expect(close).not.toHaveBeenCalled();
    expect(devices.assertLease(lease.leaseId).deviceId).toBe(first.device.id);
    expect(devices.refreshDeviceCredential({ refreshCredential: token.refreshCredential, proposedDevicePublicKey: key(3) }).deviceId).toBe(first.device.id);
  });
});

describe("identity mirror persistence", () => {
  it("adds device metadata without losing existing v1 cookies or grants", () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE pairing_grants (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, confirmed_at TEXT, consumed_at TEXT);
    `);
    const createdAt = new Date(Date.now()).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    legacy.prepare("INSERT INTO auth_sessions (id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("old-auth", hash("old cookie"), createdAt, expiresAt, createdAt);
    legacy.prepare("INSERT INTO pairing_grants (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)").run("old-grant", hash("old grant"), createdAt, expiresAt);
    legacy.close();
    const devices = registry({}, path);
    expect(devices.store.findAuthSession(hash("old cookie"))).toEqual({ id: "old-auth", expiresAt });
    expect(devices.store.getPairingGrant(hash("old grant"))).toEqual({ id: "old-grant", expiresAt });
    expect(devices.store.hasActivePairingGrant(hash("old grant"))).toBe(true);
    const device = devices.ensureBrowserSessionDevice("old-auth");
    expect(devices.store.findAuthSession(hash("old cookie"))?.deviceId).toBe(device.id);
    const reloaded = registry({ recoverLeases: false }, path);
    expect(reloaded.getDeviceForAuthSession("old-auth")?.id).toBe(device.id);
  });

  it("accepts an identical mirror but requires explicit CAS to replace it", () => {
    const devices = registry();
    const original = { hostId: HOST_ID, fingerprint: "fingerprint-1" };
    const next = { hostId: HOST_ID, fingerprint: "fingerprint-2" };
    expect(devices.store.getHostIdentityMirror()).toBeUndefined();
    devices.store.setHostIdentityMirror(original);
    devices.store.setHostIdentityMirror(original);
    expect(() => devices.store.setHostIdentityMirror(next)).toThrow("HOST_IDENTITY_MISMATCH");
    devices.store.rotateHostIdentityMirror(next, original);
    expect(() => devices.store.rotateHostIdentityMirror(original, original)).toThrow("HOST_IDENTITY_MISMATCH");
    expect(devices.store.getHostIdentityMirror()).toEqual(next);
  });

  it("keeps the stable Host ID when rotation uses its concurrency fence", () => {
    const devices = registry();
    const original = { hostId: HOST_ID, fingerprint: "fingerprint-1" };
    devices.store.setHostIdentityMirror(original);
    expect(() => devices.store.rotateHostIdentityMirror(
      { hostId: "different-host", fingerprint: "fingerprint-2" },
      original,
    )).toThrow("HOST_IDENTITY_MISMATCH");
    expect(devices.store.getHostIdentityMirror()).toEqual(original);
  });
});
