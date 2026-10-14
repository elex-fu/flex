import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostOwnerLock, assertWorkspacePrivacy, createTestHostOwner, type HostOwnerHandle, type OwnershipRecoveryProof } from "./host-owner.js";
import { SystemProcessInspector, type ProcessInspector } from "./process-inspector.js";

const directories: string[] = [];
const owners: HostOwnerHandle[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) { try { owner.release(); } catch { /* Tests deliberately replace/retain locks. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flyx-owner-test-"));
  directories.push(root);
  const data = join(root, "data");
  const identity = join(data, "identity");
  mkdirSync(identity, { recursive: true, mode: 0o700 });
  return { root, data, identity, databasePath: join(data, "host.sqlite"), coordinationDirectory: join(root, "coordination") };
}

function acquire(options: Parameters<typeof HostOwnerLock.acquire>[0]) {
  const owner = HostOwnerLock.acquire(options);
  owners.push(owner);
  return owner;
}

const inspector = (state: "alive" | "exited" | "unknown"): ProcessInspector => ({
  currentIdentity: () => ({ pid: 42, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "123" } }),
  inspect: () => ({ state, reason: `test_${state}` }),
});

describe("Host ownership", () => {
  it("blocks canonical DB and identity symlink aliases and releases partial acquisitions", () => {
    const f = fixture();
    writeFileSync(f.databasePath, "");
    symlinkSync(f.data, join(f.root, "alias"));
    const first = acquire({ ...f, identityDirectory: f.identity });
    expect(() => acquire({ databasePath: join(f.root, "alias", "host.sqlite"), identityDirectory: f.identity, coordinationDirectory: f.coordinationDirectory })).toThrow("Another Host");
    expect(() => acquire({ databasePath: join(f.data, "second.sqlite"), identityDirectory: join(f.root, "alias", "identity"), coordinationDirectory: f.coordinationDirectory })).toThrow("Another Host");
    const third = acquire({ databasePath: join(f.data, "second.sqlite"), identityDirectory: join(f.root, "different-identity"), coordinationDirectory: f.coordinationDirectory });
    expect(third.ownerId).not.toBe(first.ownerId);
    first.release();
    expect(() => first.assertActive()).toThrow("released");
  });

  it("never uses heartbeat expiry to reclaim an alive or unverified PID", () => {
    const f = fixture();
    const first = acquire({ ...f, identityDirectory: f.identity, inspector: inspector("alive") });
    first.heartbeat();
    for (const file of readdirSync(f.coordinationDirectory)) {
      const path = join(f.coordinationDirectory, file);
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      record.heartbeatAt = "1970-01-01T00:00:00.000Z";
      writeFileSync(path, JSON.stringify(record));
    }
    expect(() => acquire({ ...f, identityDirectory: f.identity, mode: "maintenance", reclaimStale: true, inspector: inspector("alive") })).toThrow("cannot be proven exited");
    expect(() => acquire({ ...f, identityDirectory: f.identity, mode: "maintenance", reclaimStale: true, inspector: inspector("unknown") })).toThrow("cannot be proven exited");
    expect(() => acquire({ ...f, identityDirectory: f.identity, reclaimStale: true })).toThrow("offline maintenance");
    first.assertActive();
  });

  it("requires explicit offline reclamation and stale release cannot delete a successor", () => {
    const f = fixture();
    const first = acquire({ ...f, identityDirectory: f.identity, inspector: inspector("exited") });
    expect(() => acquire({ ...f, identityDirectory: f.identity, inspector: inspector("exited") })).toThrow("Another Host");
    const successor = acquire({ ...f, identityDirectory: f.identity, mode: "maintenance", reclaimStale: true, inspector: inspector("exited") });
    expect(() => first.release()).toThrow("release could not verify");
    successor.assertActive();
  });

  it("checks lock-file identity as well as ownerId before release", () => {
    const f = fixture();
    const owner = acquire({ ...f, identityDirectory: f.identity });
    const lock = join(f.coordinationDirectory, readdirSync(f.coordinationDirectory).find((path) => path.endsWith(".owner"))!);
    const replacement = `${lock}.replacement`;
    const contents = readFileSync(lock, "utf8");
    writeFileSync(replacement, contents, { mode: 0o600 });
    renameSync(replacement, lock);
    expect(() => owner.release()).toThrow("release could not verify");
    expect(readFileSync(lock, "utf8")).toBe(contents);
  });

  it("retains resources even after the Host process has exited when producer stop is unknown", () => {
    const f = fixture();
    const owner = acquire({ ...f, identityDirectory: f.identity, inspector: inspector("exited") });
    owner.retain("provider_exit_unverified");
    expect(owner.retainedReason).toBe("provider_exit_unverified");
    expect(() => owner.release()).toThrow("remains retained");
    expect(() => acquire({ ...f, identityDirectory: f.identity, mode: "maintenance", reclaimStale: true, inspector: inspector("exited") })).toThrow("execution could not be proven stopped");
  });

  it("keeps explicit test owners separate from file-backed Hosts", () => {
    const owner = createTestHostOwner();
    owner.assertStorePath(":memory:");
    expect(() => owner.assertStorePath("/tmp/real-host.sqlite")).toThrow("only open an in-memory");
    owner.release();
    expect(() => owner.assertActive()).toThrow("released");
  });

  it("clears retained ownership only with exact resources and a trusted committed-evidence verifier", () => {
    const f = fixture();
    const owner = acquire({ ...f, identityDirectory: f.identity });
    owner.retain("provider_tree_unknown");
    const proof: OwnershipRecoveryProof = { ownerId: owner.ownerId, ownerGeneration: owner.generation,
      evidenceId: "evidence", turnId: "turn", attemptId: "attempt", resourceKeys: owner.resourceKeys };
    expect(() => owner.clearRetention({ ...proof, resourceKeys: ["wrong-checkout"] }, () => true)).toThrow("exact retained resources");
    expect(() => owner.clearRetention({ ...proof, ownerGeneration: owner.generation + 1 }, () => true)).toThrow("did not prove");
    expect(() => owner.clearRetention(proof, () => false)).toThrow("did not prove");
    expect(owner.retainedReason).toBe("provider_tree_unknown");
    owner.clearRetention(proof, (_, context) => context.ownerId === owner.ownerId && context.retainedReason === "provider_tree_unknown");
    expect(owner.retainedReason).toBeUndefined();
    owner.release();
  });

  it("requires both committed execution-stop evidence and the original Host exit for offline retained reclaim", () => {
    const f = fixture();
    const previous = acquire({ ...f, identityDirectory: f.identity, inspector: inspector("exited") });
    previous.retain("producer_stop_unknown");
    const proof: OwnershipRecoveryProof = { ownerId: previous.ownerId, ownerGeneration: previous.generation,
      evidenceId: "offline-evidence", turnId: "turn", attemptId: "attempt", resourceKeys: previous.resourceKeys };
    const options = { ...f, identityDirectory: f.identity, mode: "maintenance" as const, reclaimStale: true };
    expect(() => acquire({ ...options, inspector: inspector("exited"), recovery: { proof, verifyProof: () => false } })).toThrow("did not prove");
    expect(() => acquire({ ...options, inspector: inspector("alive"), recovery: { proof, verifyProof: () => true } })).toThrow("cannot be proven exited");
    expect(() => acquire({ ...options, inspector: inspector("unknown"), recovery: { proof, verifyProof: () => true } })).toThrow("cannot be proven exited");
    const maintenance = acquire({ ...options, inspector: inspector("exited"), recovery: { proof, verifyProof: () => true } });
    maintenance.assertActive();
  });

  it("rejects a dangling DB alias before SQLite can create an unowned target", () => {
    const f = fixture();
    const alias = join(f.data, "alias.sqlite");
    symlinkSync("missing-target.sqlite", alias);
    expect(() => acquire({ databasePath: alias, identityDirectory: f.identity, coordinationDirectory: f.coordinationDirectory })).toThrow("dangling symbolic link");
  });

  it("rejects canonical private-directory overlap with the actual configured workspace", () => {
    const f = fixture();
    const workspace = join(f.root, "workspace");
    mkdirSync(workspace);
    symlinkSync(workspace, join(f.root, "workspace-alias"));
    expect(() => assertWorkspacePrivacy(workspace, [join(f.root, "workspace-alias", "identity")])).toThrow("overlaps");
    expect(() => assertWorkspacePrivacy(workspace, [f.root])).toThrow("overlaps");
    expect(() => assertWorkspacePrivacy(workspace, [f.data])).not.toThrow();
  });
});

describe("process inspection", () => {
  it("treats EPERM and unsupported macOS birth identity as unknown", () => {
    const denied = new SystemProcessInspector({ platform: "darwin", signal: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } });
    expect(denied.inspect({ pid: 10, platform: "darwin" })).toEqual({ state: "unknown", reason: "permission_denied" });
    const mac = new SystemProcessInspector({ platform: "darwin", signal: () => {} });
    expect(mac.currentIdentity().birth).toBeUndefined();
    expect(mac.inspect({ pid: 10, platform: "darwin" }).state).toBe("unknown");
    const exited = new SystemProcessInspector({ platform: "darwin", signal: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });
    expect(exited.inspect({ pid: 10, platform: "darwin" }).state).toBe("exited");
  });

  it("distinguishes a verified live Linux birth from PID reuse or failed identity inspection", () => {
    let startTicks = "1234";
    const read = (path: string) => path.endsWith("boot_id") ? "12345678-1234-1234-1234-123456789abc" : `10 (process (with spaces)) ${["S", ...Array<string>(18).fill("0"), startTicks].join(" ")}`;
    const linux = new SystemProcessInspector({ platform: "linux", pid: 10, signal: () => {}, read });
    const identity = linux.currentIdentity();
    expect(linux.inspect(identity).state).toBe("alive");
    startTicks = "9999";
    expect(linux.inspect(identity)).toEqual({ state: "exited", reason: "recorded_process_exited_pid_reused" });
    const unverifiable = new SystemProcessInspector({ platform: "linux", signal: () => {}, read: () => { throw new Error("no proc access"); } });
    expect(unverifiable.inspect(identity).state).toBe("unknown");
    expect(linux.inspect({ ...identity, birth: { kind: "linux", bootId: "invalid", startTicks: "1234" } })).toEqual({ state: "unknown", reason: "process_birth_invalid" });
  });
});
