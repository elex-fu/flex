import type { ClientErrorInfo, Unsubscribe } from "./types.js";

export class ClientError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ClientError";
  }
}

export function errorInfo(error: unknown): ClientErrorInfo {
  return { code: error instanceof ClientError ? error.code : "CONNECTION_FAILED", message: error instanceof Error ? error.message : "Connection failed" };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Signal<T> {
  private handlers = new Set<(value: T) => void>();
  subscribe(handler: (value: T) => void): Unsubscribe { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  emit(value: T): void { for (const handler of this.handlers) handler(value); }
  clear(): void { this.handlers.clear(); }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new ClientError("INVALID_PAYLOAD", "Commands must contain JSON values only");
}

export async function payloadHash(method: string, payload: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ method, payload }))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromBase64Url(value: string): Uint8Array {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function toBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function validateDirectUrl(value: string, allowInsecureLoopback = false): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:"))) {
    throw new ClientError("UNSAFE_ENDPOINT", "Direct endpoint must be an HTTPS origin; local HTTP requires explicit development configuration");
  }
  return url;
}

export function abortError(): ClientError { return new ClientError("CONNECTION_REPLACED", "Connection was replaced"); }
export function assertNotAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
