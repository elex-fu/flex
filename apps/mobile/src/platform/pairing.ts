import { decodeConnectionFragment } from "@flyx/mvp-protocol";
import { ClientError } from "@flyx/client-core";
import type { ClientStore, HostProfile } from "@flyx/client-core";

export async function parseNativePairing(input: string, store: ClientStore) {
  let value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new ClientError("INVALID_PAIRING_OFFER", "Pairing URL contains credentials");
    if (url.protocol === "flyx:") {
      if (url.hostname !== "pair" || !["", "/"].includes(url.pathname) || [...url.searchParams.keys()].some((key) => key !== "offer") || url.searchParams.getAll("offer").length > 1 || url.hash && url.searchParams.has("offer")) throw new ClientError("INVALID_PAIRING_OFFER", "Unsupported native pairing URL");
      value = url.hash || url.searchParams.get("offer") || "";
    } else {
      if (url.protocol !== "https:" || url.search || !url.hash) throw new ClientError("INVALID_PAIRING_OFFER", "Scan a complete HTTPS pairing offer");
      value = url.hash;
    }
  }
  const decoded = await decodeConnectionFragment(value);
  if (!decoded) throw new ClientError("INVALID_PAIRING_OFFER", "Native pairing requires the full pinned Host offer");
  const offer = decoded.offer;
  const previous = await store.getProfile(offer.hostId);
  if (previous && (previous.hostPublicKey !== offer.hostPublicKey || previous.signingPublicKey !== offer.signingPublicKey || previous.fingerprint !== offer.fingerprint)) throw new ClientError("IDENTITY_MISMATCH", "Pairing offer changes the saved Host identity");
  const profile: HostProfile = previous ?? { hostId: offer.hostId, label: "Flyx Host", hostPublicKey: offer.hostPublicKey, signingPublicKey: offer.signingPublicKey, fingerprint: offer.fingerprint, endpoints: [] };
  if (decoded.kind === "direct") {
    const direct = { id: "direct-offer", kind: "direct-https" as const, source: "manual" as const, baseUrl: decoded.offer.endpoint, availability: "unknown" as const };
    if (!profile.endpoints.some((endpoint) => endpoint.kind === "direct-https" && endpoint.baseUrl === direct.baseUrl)) profile.endpoints.push(direct);
  }
  return { decoded, profile, fragment: value };
}
