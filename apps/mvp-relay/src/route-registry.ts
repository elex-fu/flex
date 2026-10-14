import type { RelayHostPrincipal } from "./relay-port.js";

export interface RelayRouteRecord { routeId: string; credentialHash: string; createdAt: number }
export interface RelayRouteStore {
  get(routeId: string): Promise<RelayRouteRecord | null>;
  /** Must insert only; replacing the verifier would silently transfer route ownership. */
  put(record: RelayRouteRecord): Promise<void>;
  delete(routeId: string): Promise<void>;
}
export interface RouteRegistration { v: 1; routeId: string; relayCredential: string }

export const ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const RELAY_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomRelayId(crypto: Crypto = globalThis.crypto, bytes = 24): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function credentialVerifier(credential: string, crypto: Crypto = globalThis.crypto): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function equalVerifier(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 64; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export class RouteRegistry {
  private readonly crypto: Crypto;
  private readonly now: () => number;
  constructor(private readonly options: { store: RelayRouteStore; crypto?: Crypto; now?: () => number }) {
    this.crypto = options.crypto ?? globalThis.crypto;
    this.now = options.now ?? Date.now;
  }

  async create(): Promise<RouteRegistration> {
    const routeId = randomRelayId(this.crypto, 24);
    const relayCredential = randomRelayId(this.crypto, 32);
    await this.options.store.put({ routeId, credentialHash: await credentialVerifier(relayCredential, this.crypto), createdAt: this.now() });
    return { v: 1, routeId, relayCredential };
  }

  async get(routeId: string): Promise<RelayRouteRecord | null> {
    if (!ROUTE_ID_PATTERN.test(routeId)) return null;
    return this.options.store.get(routeId);
  }

  async authenticate(routeId: string, credential: string): Promise<RelayHostPrincipal | null> {
    if (!ROUTE_ID_PATTERN.test(routeId) || !RELAY_CREDENTIAL_PATTERN.test(credential)) return null;
    const record = await this.options.store.get(routeId);
    // Hash even a nonexistent route to avoid an obvious verifier timing oracle.
    const verifier = await credentialVerifier(credential, this.crypto);
    if (!equalVerifier(verifier, record?.credentialHash ?? "0".repeat(64)) || !record) return null;
    return { routeId };
  }
}

export class MemoryRelayRouteStore implements RelayRouteStore {
  private readonly records = new Map<string, RelayRouteRecord>();
  constructor(private readonly maxRoutes = 10_000) {}
  async get(routeId: string): Promise<RelayRouteRecord | null> { return this.records.get(routeId) ?? null; }
  async put(record: RelayRouteRecord): Promise<void> {
    if (this.records.has(record.routeId)) throw new Error("ROUTE_EXISTS");
    if (this.records.size >= this.maxRoutes) throw new Error("ROUTE_QUOTA_EXCEEDED");
    this.records.set(record.routeId, { ...record });
  }
  async delete(routeId: string): Promise<void> { this.records.delete(routeId); }
}
