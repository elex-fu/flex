import type { RelayEnvironment } from "./runtime.js";

export function secureHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

export function jsonResponse(value: unknown, status = 200, retryAfterSeconds?: number): Response {
  const headers = secureHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (retryAfterSeconds !== undefined) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify(value), { status, headers });
}

export function errorResponse(code: string, status: number, retryAfterSeconds?: number): Response {
  return jsonResponse({ error: { code } }, status, retryAfterSeconds);
}

export function configNumber(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("RELAY_INVALID_CONFIG");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new Error("RELAY_INVALID_CONFIG");
  return number;
}

export function isSecureRequest(url: URL, env: RelayEnvironment): boolean {
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  return env.RELAY_ALLOW_INSECURE_LOCAL === "true"
    && (url.protocol === "http:" || url.protocol === "ws:")
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

export function isAllowedOrigin(origin: string | null, env: RelayEnvironment): boolean {
  // Node Host and native clients do not send an Origin header.
  if (origin === null) return true;
  const allowed = (env.RELAY_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && isSecureRequest(parsed, env);
  } catch {
    return false;
  }
}

export function bearerCredential(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null || header.length > 1024) return null;
  return /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(header)?.[1] ?? null;
}

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Always compare fixed-width digests; secret values are never included in errors. */
export async function sameSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export function metric(env: RelayEnvironment, event: string, count = 1, routeHash?: string): void {
  // These are finite, adapter-defined labels and aggregate counts, never request data.
  try { env.RELAY_METRICS?.writeDataPoint({ blobs: [event], doubles: [count], ...(routeHash ? { indexes: [routeHash] } : {}) }); } catch { /* best effort */ }
}
