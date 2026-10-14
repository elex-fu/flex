import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson, computeHostFingerprint, decodeBase64Url, encodeBase64Url,
  hostDescriptorSigningBytes, validateConnectionUrl, verifyHostDescriptor,
  type UnsignedHostDescriptorV1,
} from "./index.js";

async function fixture() {
  const noise = generateKeyPairSync("x25519");
  const signing = generateKeyPairSync("ed25519");
  const hostPublicKey = noise.publicKey.export({ format: "jwk" }).x!;
  const signingPublicKey = signing.publicKey.export({ format: "jwk" }).x!;
  const fingerprint = await computeHostFingerprint(hostPublicKey, signingPublicKey);
  const unsigned: UnsignedHostDescriptorV1 = {
    v: 1, hostId: "host-1", hostPublicKey, signingPublicKey, fingerprint,
    protocol: { min: 1, max: 2 }, endpoints: [{ id: "tailnet", kind: "direct-https", source: "tailscale", baseUrl: "https://host.tailnet.ts.net" }],
    issuedAt: "2026-09-08T10:00:00Z", expiresAt: "2026-09-08T10:05:00Z", nonce: "abcdefghijklmnop",
  };
  const descriptor = { ...unsigned, signature: encodeBase64Url(sign(null, hostDescriptorSigningBytes(unsigned), signing.privateKey)) };
  return { unsigned, descriptor, signing, pinned: { hostId: unsigned.hostId, hostPublicKey, signingPublicKey, fingerprint } };
}

describe("host descriptor identity", () => {
  const now = Date.parse("2026-09-08T10:01:00Z");

  it("verifies a Node-signed Ed25519 descriptor with browser WebCrypto", async () => {
    const { descriptor, pinned } = await fixture();
    expect(await verifyHostDescriptor(descriptor, pinned, { now })).toEqual(descriptor);
    // Property order cannot affect the signed input.
    expect(await verifyHostDescriptor(Object.fromEntries(Object.entries(descriptor).reverse()), pinned, { now })).toEqual(descriptor);
  });

  it("binds both public keys into the fingerprint", async () => {
    const { descriptor } = await fixture();
    const changed = encodeBase64Url(new Uint8Array(32).fill(3));
    expect(await computeHostFingerprint(changed, descriptor.signingPublicKey)).not.toBe(descriptor.fingerprint);
    expect(await computeHostFingerprint(descriptor.hostPublicKey, changed)).not.toBe(descriptor.fingerprint);
  });

  it("fails key substitutions, endpoint tampering, wrong signatures and expired descriptors", async () => {
    const { descriptor, pinned } = await fixture();
    await expect(verifyHostDescriptor(descriptor, { ...pinned, hostPublicKey: encodeBase64Url(new Uint8Array(32)) }, { now })).rejects.toThrow("HOST_IDENTITY_MISMATCH");
    await expect(verifyHostDescriptor({ ...descriptor, endpoints: [] }, pinned, { now })).rejects.toThrow("HOST_DESCRIPTOR_SIGNATURE_INVALID");
    await expect(verifyHostDescriptor({ ...descriptor, signature: encodeBase64Url(new Uint8Array(64)) }, pinned, { now })).rejects.toThrow("HOST_DESCRIPTOR_SIGNATURE_INVALID");
    await expect(verifyHostDescriptor(descriptor, pinned, { now: Date.parse(descriptor.expiresAt) })).rejects.toThrow("HOST_DESCRIPTOR_EXPIRED");
    await expect(verifyHostDescriptor(descriptor, pinned, { now: now - 10 * 60_000 })).rejects.toThrow("HOST_DESCRIPTOR_EXPIRED");
  });

  it("rejects a descriptor even with valid signature if it downgrades an endpoint", async () => {
    const { unsigned, signing, pinned } = await fixture();
    const local: UnsignedHostDescriptorV1 = { ...unsigned, endpoints: [{ id: "local", kind: "direct-https", source: "manual", baseUrl: "http://127.0.0.1:4173" }] };
    const descriptor = { ...local, signature: encodeBase64Url(sign(null, hostDescriptorSigningBytes(local), signing.privateKey)) };
    await expect(verifyHostDescriptor(descriptor, pinned, { now })).rejects.toThrow(/HTTPS/);
    expect(await verifyHostDescriptor(descriptor, pinned, { now, allowLoopbackHttp: true })).toEqual(descriptor);
  });

  it("uses canonical encodings and rejects values that JSON would silently alter", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: true }, x: [2, 1] })).toBe('{"a":{"b":true,"d":2},"x":[2,1],"z":1}');
    for (const value of [undefined, NaN, { missing: undefined }, new Date(), new Array(2)]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycles/);
    expect(decodeBase64Url("_w")).toEqual(new Uint8Array([255]));
    for (const value of ["_x", "_w==", "+w", "A"]) expect(() => decodeBase64Url(value)).toThrow();
  });

  it("rejects unsafe, ambiguous or non-origin URLs", () => {
    for (const url of [
      "javascript:alert(1)", "http://public.example", "https://user:pass@host.test", "https://@host.test",
      "https://host.test/?grant=secret", "https://host.test/#", "https://host.test/?", "https://host.test/path", "https:\\host.test",
    ]) expect(() => validateConnectionUrl(url, "direct")).toThrow();
    expect(validateConnectionUrl("https://host.test/", "direct")).toBe("https://host.test");
    expect(() => validateConnectionUrl("ws://127.0.0.1", "relay", { allowLoopbackHttp: true })).toThrow();
  });

  it("rejects non-192-bit route locators before descriptor signature verification", async () => {
    const { descriptor, pinned } = await fixture();
    const relay = { id: "relay", kind: "relay-wss", relayUrl: "wss://relay.example", routeId: "r".repeat(33) };
    await expect(verifyHostDescriptor({ ...descriptor, endpoints: [relay] }, pinned, { now })).rejects.toThrow();
  });
});
