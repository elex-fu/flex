import { describe, expect, it } from "vitest";
import {
  canonicalJson, computeHostFingerprint, decodeConnectionFragment, decodeDirectPairingFragment, decodeRelayPairingFragment,
  encodeBase64Url, encodeDirectPairingFragment, encodeRelayPairingFragment,
  type DirectPairingPayloadV1, type RelayPairingOfferV1,
} from "./index.js";

const now = Date.parse("2026-09-08T10:00:00Z");
async function fixtures() {
  const identity = {
    v: 1 as const, hostId: "host-1", hostPublicKey: encodeBase64Url(new Uint8Array(32).fill(1)), signingPublicKey: encodeBase64Url(new Uint8Array(32).fill(2)),
  };
  const fingerprint = await computeHostFingerprint(identity.hostPublicKey, identity.signingPublicKey);
  const grant = encodeBase64Url(new Uint8Array(32).fill(3));
  const expiresAt = "2026-09-08T10:05:00Z";
  const direct: DirectPairingPayloadV1 = { ...identity, fingerprint, endpoint: "https://host.tailnet.ts.net", grant, expiresAt };
  const relay: RelayPairingOfferV1 = { ...identity, fingerprint, relay: { url: "wss://relay.flyx.example", routeId: "r".repeat(32) }, pairing: { grant, expiresAt }, protocol: { min: 2, max: 2 } };
  return { direct, relay };
}

const rawFragment = (payload: unknown, key = "pair") => `#${key}=${encodeBase64Url(new TextEncoder().encode(canonicalJson(payload)))}`;

describe("pairing offer fragments", () => {
  it("round trips canonical Direct and Relay offers without query grants", async () => {
    const { direct, relay } = await fixtures();
    const directFragment = encodeDirectPairingFragment(direct);
    const relayFragment = encodeRelayPairingFragment(relay);
    expect(directFragment.startsWith("#pair=")).toBe(true);
    expect(relayFragment.startsWith("#offer=")).toBe(true);
    expect(await decodeDirectPairingFragment(directFragment, { now })).toEqual(direct);
    expect(await decodeRelayPairingFragment(relayFragment, { now })).toEqual(relay);
    expect(await decodeConnectionFragment("#settings", { now })).toBeNull();
    expect(await decodeConnectionFragment("", { now })).toBeNull();
  });

  it("is deterministic regardless of object insertion order", async () => {
    const { direct } = await fixtures();
    expect(encodeDirectPairingFragment(Object.fromEntries(Object.entries(direct).reverse()) as DirectPairingPayloadV1)).toBe(encodeDirectPairingFragment(direct));
  });

  it("rejects expired and excessively long-lived offers", async () => {
    const { direct } = await fixtures();
    await expect(decodeDirectPairingFragment(encodeDirectPairingFragment(direct), { now: Date.parse(direct.expiresAt) })).rejects.toThrow(/expired/);
    await expect(decodeDirectPairingFragment(rawFragment({ ...direct, expiresAt: "2026-09-09T10:00:00Z" }), { now })).rejects.toThrow(/lifetime/);
  });

  it("rejects fingerprint deception, insecure relay and unsafe endpoints", async () => {
    const { direct, relay } = await fixtures();
    await expect(decodeConnectionFragment(rawFragment({ ...direct, fingerprint: `sha256:${"0".repeat(64)}` }), { now })).rejects.toThrow("HOST_IDENTITY_MISMATCH");
    await expect(decodeConnectionFragment(rawFragment({ ...relay, relay: { ...relay.relay, url: "ws://relay.example" } }, "offer"), { now })).rejects.toThrow(/WSS/);
    for (const endpoint of ["https://user@host.example", "https://host.example?grant=secret", "javascript:alert(1)"]) {
      await expect(decodeConnectionFragment(rawFragment({ ...direct, endpoint }), { now })).rejects.toThrow();
    }
  });

  it("requires explicit local HTTP opt-in and never extends it to remote HTTP", async () => {
    const { direct } = await fixtures();
    const fragment = rawFragment({ ...direct, endpoint: "http://127.0.0.1:4173" });
    await expect(decodeConnectionFragment(fragment, { now })).rejects.toThrow(/HTTPS/);
    expect((await decodeConnectionFragment(fragment, { now, allowLoopbackHttp: true }))?.kind).toBe("direct");
    await expect(decodeConnectionFragment(rawFragment({ ...direct, endpoint: "http://remote.test" }), { now, allowLoopbackHttp: true })).rejects.toThrow(/HTTPS/);
  });

  it("rejects ambiguous, noncanonical, oversized and duplicate-property payloads", async () => {
    const { direct } = await fixtures();
    const encoded = encodeDirectPairingFragment(direct);
    for (const fragment of [`${encoded}&offer=bad`, `#settings=true&${encoded.slice(1)}`, "#pair=%%%", `#pair=${"a".repeat(30_000)}`]) {
      await expect(decodeConnectionFragment(fragment, { now })).rejects.toThrow();
    }
    const whitespace = `#pair=${encodeBase64Url(new TextEncoder().encode(JSON.stringify(direct, null, 2)))}`;
    await expect(decodeConnectionFragment(whitespace, { now })).rejects.toThrow(/canonical/);
    const duplicate = `#pair=${encodeBase64Url(new TextEncoder().encode(canonicalJson(direct).replace('{', '{"v":1,')))}`;
    await expect(decodeConnectionFragment(duplicate, { now })).rejects.toThrow(/canonical/);
  });

  it("requires fixed-size canonical random grants and 192-bit Relay route IDs", async () => {
    const { direct, relay } = await fixtures();
    // A 43-character token can be syntactically base64url while having
    // non-zero discarded bits, so decode/re-encode validation is required.
    await expect(decodeConnectionFragment(rawFragment({ ...direct, grant: `${direct.grant.slice(0, -1)}_` }), { now })).rejects.toThrow();
    await expect(decodeConnectionFragment(rawFragment({ ...direct, grant: encodeBase64Url(new Uint8Array(31)) }), { now })).rejects.toThrow();
    for (const routeId of ["r".repeat(31), "r".repeat(33), `${"r".repeat(31)}+`]) {
      await expect(decodeConnectionFragment(rawFragment({ ...relay, relay: { ...relay.relay, routeId } }, "offer"), { now })).rejects.toThrow();
    }
  });
});
