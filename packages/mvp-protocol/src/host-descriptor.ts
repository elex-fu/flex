import { z } from "zod";
import { ProtocolIdentifierSchema, ProtocolRangeSchema, RelayRouteIdSchema } from "./handshake.js";

export { RelayRouteIdSchema } from "./handshake.js";

export const MAX_HOST_DESCRIPTOR_BYTES = 32 * 1024;
export const MAX_DESCRIPTOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const HOST_DESCRIPTOR_CLOCK_SKEW_MS = 60_000;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid canonical base64url");
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Invalid canonical base64url");
  }
  if (encodeBase64Url(bytes) !== encoded) throw new Error("Invalid canonical base64url");
  return bytes;
}

export function base64UrlBytesSchema(length: number) {
  // Bound the string before atob so schema validation cannot allocate based on
  // an attacker-controlled oversized key, signature, grant, or credential.
  const encodedLength = Math.ceil(length * 4 / 3);
  return z.string().length(encodedLength).refine((value) => {
    // Zod refinements can still run after another continuable string issue.
    if (value.length !== encodedLength) return false;
    try { return decodeBase64Url(value).byteLength === length; } catch { return false; }
  }, `Expected canonical base64url encoding of ${length} bytes`);
}

export const PublicKeySchema = base64UrlBytesSchema(32);
export const HostFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const DescriptorSignatureSchema = base64UrlBytesSchema(64);
export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export interface UrlSafetyOptions { allowLoopbackHttp?: boolean }

/** URLs in offers are configuration, never an authority to downgrade transport security. */
export function validateConnectionUrl(value: string, kind: "direct" | "relay", options: UrlSafetyOptions = {}): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid connection URL"); }
  if (url.username || url.password || /[?#]/.test(value) || /^[a-z]+:\/\/[^/]*@/i.test(value)) {
    throw new Error("Connection URL must not contain credentials, query, or fragment");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) throw new Error("Invalid connection URL");
  if (!url.hostname || /[\u0000-\u0020\u007f]/.test(value) || value.includes("\\")) throw new Error("Invalid connection URL");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (kind === "relay") {
    if (url.protocol !== "wss:") throw new Error("Relay URL must use WSS");
    if (url.pathname !== "/") throw new Error("Relay URL must be an origin");
  } else {
    if (url.protocol !== "https:" && !(options.allowLoopbackHttp === true && loopback && url.protocol === "http:")) {
      throw new Error("Direct URL must use HTTPS");
    }
    if (url.pathname !== "/") throw new Error("Direct URL must be an origin");
  }
  return url.origin;
}

// Loopback HTTP can be represented in a signed local descriptor, but consumers still opt in during verification.
const DirectUrlSchema = z.string().max(2048).refine((value) => {
  try { validateConnectionUrl(value, "direct", { allowLoopbackHttp: true }); return true; } catch { return false; }
}, "Invalid direct origin");
const RelayUrlSchema = z.string().max(2048).refine((value) => {
  try { validateConnectionUrl(value, "relay"); return true; } catch { return false; }
}, "Invalid secure relay origin");

export const AdvertisedEndpointSchema = z.discriminatedUnion("kind", [
  z.object({
    id: ProtocolIdentifierSchema,
    kind: z.literal("direct-https"),
    source: z.enum(["tailscale", "lan", "manual"]),
    baseUrl: DirectUrlSchema,
  }).strict(),
  z.object({
    id: ProtocolIdentifierSchema,
    kind: z.literal("relay-wss"),
    relayUrl: RelayUrlSchema,
    routeId: RelayRouteIdSchema,
  }).strict(),
]);
export type AdvertisedEndpoint = z.infer<typeof AdvertisedEndpointSchema>;

export const UnsignedHostDescriptorV1Schema = z.object({
  v: z.literal(1),
  hostId: ProtocolIdentifierSchema,
  hostPublicKey: PublicKeySchema,
  signingPublicKey: PublicKeySchema,
  fingerprint: HostFingerprintSchema,
  protocol: ProtocolRangeSchema,
  endpoints: z.array(AdvertisedEndpointSchema).max(16).refine(
    (endpoints) => new Set(endpoints.map((endpoint) => endpoint.id)).size === endpoints.length,
    "Endpoint IDs must be unique",
  ),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  nonce: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type UnsignedHostDescriptorV1 = z.infer<typeof UnsignedHostDescriptorV1Schema>;
export const HostDescriptorV1Schema = UnsignedHostDescriptorV1Schema.extend({ signature: DescriptorSignatureSchema });
export type HostDescriptorV1 = z.infer<typeof HostDescriptorV1Schema>;

/** Canonical JSON uses sorted UTF-16 object keys, preserves array order and rejects lossy JSON values. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Canonical JSON requires finite numbers");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new Error("Canonical JSON requires JSON values");
    if (active.has(item)) throw new Error("Canonical JSON does not allow cycles");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const entries: string[] = [];
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) throw new Error("Canonical JSON does not allow sparse arrays");
          entries.push(encode(item[index]));
        }
        return `[${entries.join(",")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Canonical JSON requires plain objects");
      if (Object.getOwnPropertySymbols(item).length !== 0) throw new Error("Canonical JSON does not allow symbol keys");
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${encode(object[key])}`).join(",")}}`;
    } finally { active.delete(item); }
  };
  return encode(value);
}

export async function computeHostFingerprint(hostPublicKey: string, signingPublicKey: string): Promise<string> {
  PublicKeySchema.parse(hostPublicKey);
  PublicKeySchema.parse(signingPublicKey);
  const payload = new TextEncoder().encode(canonicalJson({ v: 1, hostPublicKey, signingPublicKey }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export const hostIdentityFingerprint = computeHostFingerprint;

export function hostDescriptorSigningBytes(descriptor: UnsignedHostDescriptorV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(UnsignedHostDescriptorV1Schema.parse(descriptor)));
}

export interface PinnedHostIdentity {
  hostId?: string;
  hostPublicKey: string;
  signingPublicKey: string;
  fingerprint?: string;
}
export interface VerifyHostDescriptorOptions extends UrlSafetyOptions {
  now?: number | Date;
  clockSkewMs?: number;
  maxLifetimeMs?: number;
}

export async function verifyHostDescriptor(
  input: unknown,
  pinned: PinnedHostIdentity,
  options: VerifyHostDescriptorOptions = {},
): Promise<HostDescriptorV1> {
  const descriptor = HostDescriptorV1Schema.parse(input);
  if (descriptor.hostPublicKey !== pinned.hostPublicKey || descriptor.signingPublicKey !== pinned.signingPublicKey ||
      (pinned.hostId !== undefined && descriptor.hostId !== pinned.hostId)) throw new Error("HOST_IDENTITY_MISMATCH");
  const fingerprint = await computeHostFingerprint(descriptor.hostPublicKey, descriptor.signingPublicKey);
  if (descriptor.fingerprint !== fingerprint || (pinned.fingerprint !== undefined && pinned.fingerprint !== fingerprint)) {
    throw new Error("HOST_IDENTITY_MISMATCH");
  }
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const issuedAt = Date.parse(descriptor.issuedAt);
  const expiresAt = Date.parse(descriptor.expiresAt);
  if (!Number.isFinite(now) || issuedAt > now + (options.clockSkewMs ?? HOST_DESCRIPTOR_CLOCK_SKEW_MS) ||
      expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > (options.maxLifetimeMs ?? MAX_DESCRIPTOR_LIFETIME_MS)) {
    throw new Error("HOST_DESCRIPTOR_EXPIRED");
  }
  for (const endpoint of descriptor.endpoints) {
    validateConnectionUrl(endpoint.kind === "direct-https" ? endpoint.baseUrl : endpoint.relayUrl,
      endpoint.kind === "direct-https" ? "direct" : "relay", options);
  }
  const { signature, ...unsigned } = descriptor;
  const bytes = hostDescriptorSigningBytes(unsigned);
  if (bytes.byteLength > MAX_HOST_DESCRIPTOR_BYTES) throw new Error("HOST_DESCRIPTOR_TOO_LARGE");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(decodeBase64Url(pinned.signingPublicKey)), "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", key, new Uint8Array(decodeBase64Url(signature)), new Uint8Array(bytes));
  if (!valid) throw new Error("HOST_DESCRIPTOR_SIGNATURE_INVALID");
  return descriptor;
}
