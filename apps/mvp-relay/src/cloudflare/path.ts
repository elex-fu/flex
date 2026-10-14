import { parseRelaySocketUrl } from "@flyx/mvp-protocol";
import type { RelaySocketTarget } from "@flyx/mvp-protocol";

/** Normalize explicitly enabled local HTTP for the shared TLS-only parser. */
export function parseUpgradePath(url: URL): RelaySocketTarget | null {
  const normalized = new URL(url);
  if (normalized.protocol === "http:") normalized.protocol = "https:";
  try { return parseRelaySocketUrl(normalized); } catch { return null; }
}
