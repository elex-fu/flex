import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeHostFingerprint, verifyHostDescriptor } from "@flyx/mvp-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_IDENTITY_FILENAME,
  HostIdentityError,
  createHostDescriptor,
  generateHostIdentity,
  getHostIdentityMirror,
  loadOrCreateHostIdentity,
  publicHostIdentity,
  rotateHostIdentity,
  type HostIdentityFileV1,
  type HostIdentityMirror,
  type RotateHostIdentityOptions,
} from "./host-identity.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-identity-"));
  temporaryDirectories.push(root);
  const directory = join(root, "identity");
  return { root, directory, path: join(directory, HOST_IDENTITY_FILENAME) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persistent Host identity", () => {
  it("creates owner-only private state and reuses precisely the same identity after restart", async () => {
    const files = await fixture();
    const first = await loadOrCreateHostIdentity(files);
    const mirror = getHostIdentityMirror(first);
    const second = await loadOrCreateHostIdentity({ ...files, expectedMirror: mirror });

    expect(second).toEqual(first);
    expect((await lstat(files.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(files.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(files.directory)).toEqual([HOST_IDENTITY_FILENAME]);
    expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(first);
    expect(mirror).toEqual({ hostId: first.hostId, fingerprint: first.fingerprint });
    expect(Object.keys(publicHostIdentity(first)).sort()).toEqual(["fingerprint", "hostId", "hostPublicKey", "signingPublicKey"]);
  });

  it("agrees with the browser fingerprint and binds both independent public keys", async () => {
    const identity = generateHostIdentity();
    const other = generateHostIdentity();
    expect(identity.fingerprint).toBe(await computeHostFingerprint(identity.x25519PublicKey, identity.ed25519PublicKey));
    expect(identity.fingerprint).not.toBe(await computeHostFingerprint(identity.x25519PublicKey, other.ed25519PublicKey));
    expect(identity.fingerprint).not.toBe(await computeHostFingerprint(other.x25519PublicKey, identity.ed25519PublicKey));
    expect(Buffer.from(identity.x25519SecretKey, "base64url")).toHaveLength(32);
    expect(Buffer.from(identity.ed25519SecretKey, "base64url")).toHaveLength(32);
  });

  it("does not generate a replacement when a mirrored identity file disappears", async () => {
    const files = await fixture();
    const original = await loadOrCreateHostIdentity(files);
    await unlink(files.path);
    await expect(loadOrCreateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(original) })).rejects.toMatchObject({ code: "IDENTITY_MISSING" });
    expect(await readdir(files.directory)).toEqual([]);
  });

  it("does not recreate an absent private directory when a database mirror exists", async () => {
    const files = await fixture();
    await expect(loadOrCreateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(generateHostIdentity()) })).rejects.toMatchObject({ code: "IDENTITY_MISSING" });
    await expect(lstat(files.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["hostId", "fingerprint"] as const)("fails closed if the database %s mirror differs", async (field) => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    const other = generateHostIdentity();
    const mirror = { ...getHostIdentityMirror(identity), [field]: other[field] };
    await expect(loadOrCreateHostIdentity({ ...files, expectedMirror: mirror })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(identity);
  });

  it("publishes one complete identity across concurrent creators without overwriting a winner", async () => {
    const files = await fixture();
    const results = await Promise.all(Array.from({ length: 24 }, () => loadOrCreateHostIdentity(files)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(results[0]);
    expect(await readdir(files.directory)).toEqual([HOST_IDENTITY_FILENAME]);
    expect((await lstat(files.path)).nlink).toBe(1);
  });

  it.each(["x25519SecretKey", "ed25519SecretKey", "x25519PublicKey", "ed25519PublicKey", "fingerprint"] as const)("rejects corrupted %s without logging private content", async (field) => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    const corrupt = { ...identity, [field]: generateHostIdentity()[field] };
    await writeFile(files.path, JSON.stringify(corrupt));
    let failure: unknown;
    try {
      await loadOrCreateHostIdentity(files);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HostIdentityError);
    expect(failure).toMatchObject({ code: "IDENTITY_INVALID" });
    expect(String(failure)).not.toContain(identity.x25519SecretKey);
    expect(String(failure)).not.toContain(identity.ed25519SecretKey);
    expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(corrupt);
  });

  it("rejects a preexisting truncated file instead of treating it as a new Host", async () => {
    const files = await fixture();
    await loadOrCreateHostIdentity(files);
    const malformed = '{"x25519SecretKey":"SECRET_PARSE_MARKER"';
    await writeFile(files.path, malformed);
    await expect(loadOrCreateHostIdentity(files)).rejects.toMatchObject({ code: "IDENTITY_INVALID" });
    expect(await readFile(files.path, "utf8")).toBe(malformed);
  });

  it("bounds oversized identity data before parsing", async () => {
    const files = await fixture();
    await loadOrCreateHostIdentity(files);
    await writeFile(files.path, "x".repeat(16 * 1024 + 1));
    await expect(loadOrCreateHostIdentity(files)).rejects.toMatchObject({ code: "IDENTITY_INVALID" });
  });

  it.each(["directory", "path"] as const)("refuses an unsafe %s mode without silently repairing it", async (field) => {
    const files = await fixture();
    await loadOrCreateHostIdentity(files);
    const mode = field === "directory" ? 0o755 : 0o644;
    await chmod(files[field], mode);
    await expect(loadOrCreateHostIdentity(files)).rejects.toMatchObject({ code: "IDENTITY_PERMISSIONS" });
    expect((await lstat(files[field])).mode & 0o777).toBe(mode);
  });

  it("refuses a symlink for the canonical identity file", async () => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    const target = join(files.root, "outside.json");
    await writeFile(target, JSON.stringify(identity), { mode: 0o600 });
    await unlink(files.path);
    await symlink(target, files.path);
    await expect(loadOrCreateHostIdentity(files)).rejects.toMatchObject({ code: "IDENTITY_UNSAFE_PATH" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(identity);
  });

  it("refuses a symlink for the private directory", async () => {
    const files = await fixture();
    await loadOrCreateHostIdentity(files);
    const linkedDirectory = join(files.root, "linked");
    await symlink(files.directory, linkedDirectory);
    await expect(loadOrCreateHostIdentity({ directory: linkedDirectory })).rejects.toMatchObject({ code: "IDENTITY_UNSAFE_PATH" });
  });
});

describe("explicit Host key rotation", () => {
  it("keeps Host ID, replaces both keys, and revokes/CASes public state before publishing", async () => {
    const files = await fixture();
    const previous = await loadOrCreateHostIdentity(files);
    let committedMirror: HostIdentityMirror | undefined;
    const beforeCommit = vi.fn(async (next: HostIdentityMirror, old: HostIdentityMirror) => {
      expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(previous);
      expect(old).toEqual(getHostIdentityMirror(previous));
      expect(Object.keys(next).sort()).toEqual(["fingerprint", "hostId"]);
      committedMirror = next;
    });
    const next = await rotateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(previous), authorization: { kind: "local" }, beforeCommit });

    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(next.hostId).toBe(previous.hostId);
    expect(next.fingerprint).not.toBe(previous.fingerprint);
    expect(next.x25519PublicKey).not.toBe(previous.x25519PublicKey);
    expect(next.ed25519PublicKey).not.toBe(previous.ed25519PublicKey);
    expect(next.x25519SecretKey).not.toBe(previous.x25519SecretKey);
    expect(next.ed25519SecretKey).not.toBe(previous.ed25519SecretKey);
    expect(await loadOrCreateHostIdentity({ ...files, expectedMirror: committedMirror! })).toEqual(next);
    await expect(loadOrCreateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(previous) })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(await readdir(files.directory)).toEqual([HOST_IDENTITY_FILENAME]);
    expect((await lstat(files.path)).mode & 0o777).toBe(0o600);
  });

  it("never rotates automatically or accepts a missing authorization/revocation hook", async () => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    for (const invalid of [
      { authorization: undefined, beforeCommit: vi.fn() },
      { authorization: { kind: "authorized-device", deviceId: "" }, beforeCommit: vi.fn() },
      { authorization: { kind: "local" }, beforeCommit: undefined },
    ]) {
      await expect(rotateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(identity), ...invalid } as unknown as RotateHostIdentityOptions)).rejects.toMatchObject({ code: "IDENTITY_ROTATION_UNAUTHORIZED" });
    }
    expect(await loadOrCreateHostIdentity(files)).toEqual(identity);
  });

  it("leaves the original key intact if revocation or mirror persistence fails", async () => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    await expect(rotateHostIdentity({
      ...files,
      expectedMirror: getHostIdentityMirror(identity),
      authorization: { kind: "authorized-device", deviceId: "trusted-device" },
      beforeCommit: () => { throw new Error("database unavailable"); },
    })).rejects.toMatchObject({ code: "IDENTITY_IO_ERROR" });
    expect(await loadOrCreateHostIdentity(files)).toEqual(identity);
    expect(await readdir(files.directory)).toEqual([HOST_IDENTITY_FILENAME]);
  });

  it("fails closed after a mirror commit succeeds but key publication cannot finish", async () => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    let updatedMirror: HostIdentityMirror | undefined;
    await expect(rotateHostIdentity({
      ...files,
      expectedMirror: getHostIdentityMirror(identity),
      authorization: { kind: "local" },
      beforeCommit: (next) => {
        updatedMirror = next;
        throw new Error("injected crash before identity rename");
      },
    })).rejects.toMatchObject({ code: "IDENTITY_IO_ERROR" });
    await expect(loadOrCreateHostIdentity({ ...files, expectedMirror: updatedMirror! })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(identity);
  });

  it("rejects competing rotations while one holds the commit lock", async () => {
    const files = await fixture();
    const identity = await loadOrCreateHostIdentity(files);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const committed = new Promise<void>((resolve) => { entered = resolve; });
    const first = rotateHostIdentity({
      ...files,
      expectedMirror: getHostIdentityMirror(identity),
      authorization: { kind: "local" },
      beforeCommit: async () => { entered(); await pending; },
    });
    await committed;
    const secondHook = vi.fn();
    await expect(rotateHostIdentity({
      ...files,
      expectedMirror: getHostIdentityMirror(identity),
      authorization: { kind: "local" },
      beforeCommit: secondHook,
    })).rejects.toMatchObject({ code: "IDENTITY_BUSY" });
    expect(secondHook).not.toHaveBeenCalled();
    release();
    const next = await first;
    expect(await loadOrCreateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(next) })).toEqual(next);
  });

  it("rejects stale expected mirrors without running revocation", async () => {
    const files = await fixture();
    const original = await loadOrCreateHostIdentity(files);
    const beforeCommit = vi.fn();
    await expect(rotateHostIdentity({ ...files, expectedMirror: getHostIdentityMirror(generateHostIdentity()), authorization: { kind: "local" }, beforeCommit })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(await loadOrCreateHostIdentity(files)).toEqual(original);
  });

  it("does not overwrite an identity replaced while the revocation hook is awaiting I/O", async () => {
    const files = await fixture();
    const original = await loadOrCreateHostIdentity(files);
    const replacement = generateHostIdentity({ hostId: original.hostId });
    await expect(rotateHostIdentity({
      ...files,
      expectedMirror: getHostIdentityMirror(original),
      authorization: { kind: "local" },
      beforeCommit: async () => {
        await writeFile(files.path, `${JSON.stringify(replacement)}\n`);
      },
    })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(JSON.parse(await readFile(files.path, "utf8"))).toEqual(replacement);
    expect(await readdir(files.directory)).toEqual([HOST_IDENTITY_FILENAME]);
  });

  it("requires a persisted expected identity even for an explicit local rotation", async () => {
    const files = await fixture();
    const original = await loadOrCreateHostIdentity(files);
    const beforeCommit = vi.fn();
    await expect(rotateHostIdentity({ ...files, authorization: { kind: "local" }, beforeCommit } as unknown as RotateHostIdentityOptions)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(await loadOrCreateHostIdentity(files)).toEqual(original);
  });
});

describe("signed Host descriptors", () => {
  function descriptor(identity: HostIdentityFileV1) {
    return createHostDescriptor(identity, {
      protocol: { min: 1, max: 2 },
      endpoints: [
        { id: "tailnet", kind: "direct-https", source: "tailscale", baseUrl: "https://host.example.ts.net" },
        { id: "relay", kind: "relay-wss", relayUrl: "wss://relay.example", routeId: "a".repeat(32) },
      ],
    });
  }

  it("verifies Node Ed25519 signatures with the browser-compatible verifier", async () => {
    const identity = generateHostIdentity();
    const signed = descriptor(identity);
    expect(await verifyHostDescriptor(signed, publicHostIdentity(identity))).toEqual(signed);
    expect(Buffer.from(signed.signature, "base64url")).toHaveLength(64);
    expect(JSON.stringify(signed)).not.toContain(identity.x25519SecretKey);
    expect(JSON.stringify(signed)).not.toContain(identity.ed25519SecretKey);
  });

  it("detects endpoint and protocol tampering", async () => {
    const identity = generateHostIdentity();
    const signed = descriptor(identity);
    await expect(verifyHostDescriptor({ ...signed, endpoints: [{ id: "evil", kind: "direct-https", source: "manual", baseUrl: "https://attacker.example" }] }, publicHostIdentity(identity))).rejects.toThrow();
    await expect(verifyHostDescriptor({ ...signed, protocol: { min: 1, max: 9 } }, publicHostIdentity(identity))).rejects.toThrow();
  });

  it("rejects a replacement signing key even if the attacker signs the same encryption key", async () => {
    const trusted = generateHostIdentity();
    const attacker = generateHostIdentity();
    const replacement: HostIdentityFileV1 = {
      ...trusted,
      ed25519PublicKey: attacker.ed25519PublicKey,
      ed25519SecretKey: attacker.ed25519SecretKey,
      fingerprint: await computeHostFingerprint(trusted.x25519PublicKey, attacker.ed25519PublicKey),
    };
    const malicious = descriptor(replacement);
    await expect(verifyHostDescriptor(malicious, publicHostIdentity(trusted))).rejects.toThrow();
  });

  it("rejects a signed but expired descriptor", async () => {
    const identity = generateHostIdentity();
    const signed = createHostDescriptor(identity, {
      protocol: { min: 1, max: 2 },
      endpoints: [{ id: "direct", kind: "direct-https", source: "manual", baseUrl: "https://host.example" }],
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:05:00.000Z",
    });
    await expect(verifyHostDescriptor(signed, publicHostIdentity(identity))).rejects.toThrow();
  });
});
