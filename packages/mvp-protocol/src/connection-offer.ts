import { z } from "zod";
import { ProtocolIdentifierSchema, ProtocolRangeSchema } from "./handshake.js";
import {
  base64UrlBytesSchema, canonicalJson, computeHostFingerprint, decodeBase64Url, encodeBase64Url,
  HostFingerprintSchema, IsoTimestampSchema, PublicKeySchema, RelayRouteIdSchema, validateConnectionUrl,
  type UrlSafetyOptions,
} from "./host-descriptor.js";

export const MAX_CONNECTION_OFFER_BYTES = 16 * 1024;
export const MAX_PAIRING_GRANT_LIFETIME_MS = 5 * 60 * 1000;
/** Pairing grants are exactly 256 random bits in canonical, unpadded base64url. */
export const PairingGrantSchema = base64UrlBytesSchema(32);
const offerIdentityShape = {
  v: z.literal(1),
  hostId: ProtocolIdentifierSchema,
  hostPublicKey: PublicKeySchema,
  signingPublicKey: PublicKeySchema,
  fingerprint: HostFingerprintSchema,
};

export const DirectPairingPayloadV1Schema = z.object({
  ...offerIdentityShape,
  endpoint: z.string().min(1).max(2048),
  grant: PairingGrantSchema,
  expiresAt: IsoTimestampSchema,
}).strict();
export type DirectPairingPayloadV1 = z.infer<typeof DirectPairingPayloadV1Schema>;

export const RelayPairingOfferV1Schema = z.object({
  ...offerIdentityShape,
  relay: z.object({ url: z.string().min(1).max(2048), routeId: RelayRouteIdSchema }).strict(),
  pairing: z.object({ grant: PairingGrantSchema, expiresAt: IsoTimestampSchema }).strict(),
  protocol: ProtocolRangeSchema,
}).strict();
export type RelayPairingOfferV1 = z.infer<typeof RelayPairingOfferV1Schema>;

export type ConnectionOffer =
  | { kind: "direct"; offer: DirectPairingPayloadV1 }
  | { kind: "relay"; offer: RelayPairingOfferV1 };

export interface DecodeConnectionOfferOptions extends UrlSafetyOptions {
  now?: number | Date;
  /** Bound even a syntactically valid forged offer to the grant's intended short window. */
  maxLifetimeMs?: number;
}

function encodeFragment(key: "pair" | "offer", payload: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  if (bytes.byteLength > MAX_CONNECTION_OFFER_BYTES) throw new Error("Connection offer is too large");
  return `#${key}=${encodeBase64Url(bytes)}`;
}

export function encodeDirectPairingFragment(payload: DirectPairingPayloadV1): string {
  const parsed = DirectPairingPayloadV1Schema.parse(payload);
  validateConnectionUrl(parsed.endpoint, "direct", { allowLoopbackHttp: true });
  return encodeFragment("pair", parsed);
}

export function encodeRelayPairingFragment(offer: RelayPairingOfferV1): string {
  const parsed = RelayPairingOfferV1Schema.parse(offer);
  validateConnectionUrl(parsed.relay.url, "relay");
  return encodeFragment("offer", parsed);
}

async function verifyOffer(offer: ConnectionOffer, options: DecodeConnectionOfferOptions): Promise<ConnectionOffer> {
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const expiresAt = Date.parse(offer.kind === "direct" ? offer.offer.expiresAt : offer.offer.pairing.expiresAt);
  if (!Number.isFinite(now) || expiresAt <= now || expiresAt - now > (options.maxLifetimeMs ?? MAX_PAIRING_GRANT_LIFETIME_MS)) {
    throw new Error("Pairing offer expired or outside its allowed lifetime");
  }
  validateConnectionUrl(offer.kind === "direct" ? offer.offer.endpoint : offer.offer.relay.url, offer.kind, options);
  const fingerprint = await computeHostFingerprint(offer.offer.hostPublicKey, offer.offer.signingPublicKey);
  if (fingerprint !== offer.offer.fingerprint) throw new Error("HOST_IDENTITY_MISMATCH");
  return offer;
}

/** Callers clear location.hash before awaiting this function so grants never linger in the address bar. */
export async function decodeConnectionFragment(
  fragment: string,
  options: DecodeConnectionOfferOptions = {},
): Promise<ConnectionOffer | null> {
  if (fragment === "" || fragment === "#") return null;
  const normalized = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!normalized.startsWith("pair=") && !normalized.startsWith("offer=")) {
    if (/(?:^|&)(?:pair|offer)=/.test(normalized)) throw new Error("Ambiguous pairing fragment");
    return null;
  }
  const match = /^(pair|offer)=([A-Za-z0-9_-]+)$/.exec(normalized);
  if (!match) throw new Error("Invalid pairing fragment");
  const encoded = match[2]!;
  if (encoded.length > Math.ceil(MAX_CONNECTION_OFFER_BYTES * 4 / 3)) throw new Error("Connection offer is too large");
  const bytes = decodeBase64Url(encoded);
  if (bytes.byteLength > MAX_CONNECTION_OFFER_BYTES) throw new Error("Connection offer is too large");
  let json: string;
  let value: unknown;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json) as unknown;
  } catch { throw new Error("Invalid connection offer JSON"); }
  // Reject duplicate properties, whitespace variants and alternative encodings of the same signed identity.
  if (canonicalJson(value) !== json) throw new Error("Connection offer must use canonical JSON");
  const offer: ConnectionOffer = match[1] === "pair"
    ? { kind: "direct", offer: DirectPairingPayloadV1Schema.parse(value) }
    : { kind: "relay", offer: RelayPairingOfferV1Schema.parse(value) };
  return verifyOffer(offer, options);
}

export async function decodeDirectPairingFragment(fragment: string, options?: DecodeConnectionOfferOptions): Promise<DirectPairingPayloadV1> {
  const decoded = await decodeConnectionFragment(fragment, options);
  if (decoded?.kind !== "direct") throw new Error("Expected a direct pairing fragment");
  return decoded.offer;
}

export async function decodeRelayPairingFragment(fragment: string, options?: DecodeConnectionOfferOptions): Promise<RelayPairingOfferV1> {
  const decoded = await decodeConnectionFragment(fragment, options);
  if (decoded?.kind !== "relay") throw new Error("Expected a relay pairing fragment");
  return decoded.offer;
}
