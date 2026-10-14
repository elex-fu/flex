import { describe, expect, it } from "vitest";
import { MemoryClientStore } from "@flyx/client-core";
import { computeHostFingerprint, encodeBase64Url, encodeDirectPairingFragment } from "@flyx/mvp-protocol";
import { parseNativePairing } from "./pairing";
async function offer() {
  const hostPublicKey = encodeBase64Url(new Uint8Array(32).fill(1)), signingPublicKey = encodeBase64Url(new Uint8Array(32).fill(2));
  return { v: 1 as const, hostId: "host-a", hostPublicKey, signingPublicKey, fingerprint: await computeHostFingerprint(hostPublicKey, signingPublicKey), endpoint: "https://host.example", grant: encodeBase64Url(new Uint8Array(32).fill(3)), expiresAt: new Date(Date.now() + 60_000).toISOString() };
}
describe("native full pinned pairing offers", () => {
  it("accepts QR/deep-link offers and refuses saved pin replacement", async () => {
    const store = new MemoryClientStore(), fragment = encodeDirectPairingFragment(await offer());
    const parsed = await parseNativePairing("https://host.example/" + fragment, store);
    expect(parsed.profile.endpoints[0]).toMatchObject({ kind: "direct-https", baseUrl: "https://host.example" });
    expect((await parseNativePairing("flyx://pair?offer=" + encodeURIComponent(fragment), store)).profile.fingerprint).toBe(parsed.profile.fingerprint);
    await store.putProfile({ ...parsed.profile, signingPublicKey: encodeBase64Url(new Uint8Array(32).fill(4)) });
    await expect(parseNativePairing(fragment, store)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
  it("rejects bare grants, ambiguous links, unsafe endpoints and expired offers", async () => {
    const store = new MemoryClientStore(), value = await offer(), fragment = encodeDirectPairingFragment(value);
    await expect(parseNativePairing(value.grant, store)).rejects.toMatchObject({ code: "INVALID_PAIRING_OFFER" });
    await expect(parseNativePairing("flyx://pair?offer=" + encodeURIComponent(fragment) + fragment, store)).rejects.toMatchObject({ code: "INVALID_PAIRING_OFFER" });
    await expect(parseNativePairing("http://host.example/" + fragment, store)).rejects.toMatchObject({ code: "INVALID_PAIRING_OFFER" });
    await expect(parseNativePairing(encodeDirectPairingFragment({ ...value, expiresAt: new Date(Date.now() - 1).toISOString() }), store)).rejects.toThrow(/expired/);
    await expect(parseNativePairing(encodeDirectPairingFragment({ ...value, fingerprint: "sha256:" + "a".repeat(64) }), store)).rejects.toThrow("HOST_IDENTITY_MISMATCH");
  });
});
