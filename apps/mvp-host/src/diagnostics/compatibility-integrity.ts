import { canonicalJson } from "@flyx/mvp-protocol";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { publicHostIdentity, type HostIdentityFileV1 } from "../identity/host-identity.js";

export type CompatibilityHostIdentity = ReturnType<typeof publicHostIdentity>;
export type SignedCompatibilityPayload<T> = T & { host: CompatibilityHostIdentity; digest: string; signature: string };
export const compatibilityCanonicalJson = canonicalJson;
export function compatibilityDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
const bytes = (digest: string) => Buffer.from("flyx-compatibility-v2\n" + digest, "utf8");
export function signCompatibilityPayload<T extends Record<string, unknown>>(payload: T, identity: HostIdentityFileV1): SignedCompatibilityPayload<T> {
  const host = publicHostIdentity(identity);
  const unsigned = { ...payload, host };
  const digest = compatibilityDigest(unsigned);
  const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: identity.ed25519PublicKey, d: identity.ed25519SecretKey } });
  return { ...unsigned, digest, signature: sign(null, bytes(digest), key).toString("base64url") };
}
/** Expected identity is a caller-pinned trust anchor when consuming a controlled run. */
export function verifyCompatibilityPayload(value: unknown, expected?: Partial<CompatibilityHostIdentity>): value is SignedCompatibilityPayload<Record<string, unknown>> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const { digest, signature, host, ...payload } = value as SignedCompatibilityPayload<Record<string, unknown>>;
    if (!host || !/^[a-f0-9]{64}$/.test(digest) || !/^[A-Za-z0-9_-]{86}$/.test(signature)
      || !/^[A-Za-z0-9_-]{43}$/.test(host.hostPublicKey) || !/^[A-Za-z0-9_-]{43}$/.test(host.signingPublicKey)
      || !/^[a-f0-9-]{36}$/.test(host.hostId)) return false;
    if (host.fingerprint !== "sha256:" + compatibilityDigest({ v: 1, hostPublicKey: host.hostPublicKey, signingPublicKey: host.signingPublicKey })) return false;
    if (expected && Object.entries(expected).some(([key, item]) => host[key as keyof CompatibilityHostIdentity] !== item)) return false;
    if (compatibilityDigest({ ...payload, host }) !== digest) return false;
    const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: host.signingPublicKey } });
    return verify(null, bytes(digest), key, Buffer.from(signature, "base64url"));
  } catch { return false; }
}
