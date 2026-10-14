import { RouteRegistry } from "../route-registry.js";
import { bearerCredential, errorResponse, isAllowedOrigin, isSecureRequest, jsonResponse, metric, sameSecret, sha256 } from "./http.js";
import { parseUpgradePath } from "./path.js";
import type { QuotaKind } from "./quota.js";
import { NamespaceRouteStore } from "./route-store.js";
import { stubFor } from "./runtime.js";
import type { RelayEnvironment } from "./runtime.js";

export { RelayRouteObject } from "./route.js";
export { RelayQuotaObject } from "./quota.js";

async function consumeQuota(env: RelayEnvironment, key: string, kind: QuotaKind): Promise<Response | null> {
  const response = await stubFor(env.RELAY_QUOTAS, key).fetch(new Request("https://quota.internal/consume", {
    method: "POST", body: JSON.stringify({ kind }),
  }));
  if (response.status === 429) {
    metric(env, "connect_rejected_total.rate_limited");
    return errorResponse("RATE_LIMITED", 429, Number(response.headers.get("Retry-After")) || 60);
  }
  return response.ok ? null : errorResponse("QUOTA_UNAVAILABLE", 503);
}

async function handle(request: Request, env: RelayEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (!isSecureRequest(url, env)) return errorResponse("TLS_REQUIRED", 426);
  if (url.username || url.password || url.hash) return errorResponse("INVALID_URL", 400);
  if (request.method === "GET" && url.pathname === "/healthz" && !url.search) {
    return jsonResponse({ v: 1, status: "ok" });
  }
  const isRegistration = request.method === "POST" && url.pathname === "/v1/routes" && !url.search;
  const path = request.method === "GET" ? parseUpgradePath(url) : null;
  if (!isRegistration && !path) return errorResponse("NOT_FOUND", 404);
  // Route registration returns the Host credential exactly once. It is a
  // native Host operation and must never be exposed to browser JavaScript,
  // even when anonymous registration is intentionally enabled.
  if (isRegistration && request.headers.has("Origin")) return errorResponse("ORIGIN_REJECTED", 403);
  if (!isAllowedOrigin(request.headers.get("Origin"), env)) return errorResponse("ORIGIN_REJECTED", 403);

  // CF-Connecting-IP is supplied by Cloudflare, never X-Forwarded-For. Local mode
  // deliberately shares one quota bucket. Production requires the edge header.
  const sourceIp = request.headers.get("CF-Connecting-IP")
    ?? (env.RELAY_ALLOW_INSECURE_LOCAL === "true" ? "local" : null);
  if (!sourceIp || sourceIp.length > 64) return errorResponse("SOURCE_UNAVAILABLE", 503);
  const ipKey = `ip:${await sha256(sourceIp)}`;

  if (isRegistration) {
    const token = env.RELAY_REGISTRATION_TOKEN;
    if (token) {
      const credential = bearerCredential(request);
      if (!credential || !(await sameSecret(credential, token))) return errorResponse("UNAUTHORIZED", 401);
    } else if (env.RELAY_ALLOW_ANONYMOUS_REGISTRATION !== "true") {
      return errorResponse("REGISTRATION_DISABLED", 403);
    }
    const ipQuota = await consumeQuota(env, ipKey, "register-ip");
    if (ipQuota) return ipQuota;
    const globalQuota = await consumeQuota(env, "global-registration", "register-global");
    if (globalQuota) return globalQuota;
    const registry = new RouteRegistry({ store: new NamespaceRouteStore(env.RELAY_ROOMS) });
    const registration = await registry.create();
    metric(env, "routes_created_total");
    return jsonResponse(registration, 201);
  }

  if (!path) return errorResponse("NOT_FOUND", 404);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return errorResponse("WEBSOCKET_REQUIRED", 426);
  if (path.role === "client") {
    // Browsers never need the Host Relay credential. Rejecting both common
    // credential carriers prevents an accidental Host secret from being
    // reflected into a client-side connection setup or proxy trace.
    if (request.headers.has("Authorization") || request.headers.has("Sec-WebSocket-Protocol")) {
      return errorResponse("CLIENT_CREDENTIAL_FORBIDDEN", 400);
    }
  } else if (!bearerCredential(request)) return errorResponse("UNAUTHORIZED", 401);
  const ipQuota = await consumeQuota(env, ipKey, "connect-ip");
  if (ipQuota) return ipQuota;
  const headers = new Headers(request.headers);
  // Never negotiate compression on an encrypted tunnel. The upgrade response
  // also omits Sec-WebSocket-Extensions.
  headers.delete("Sec-WebSocket-Extensions");
  const response = await stubFor(env.RELAY_ROOMS, path.routeId).fetch(new Request(request, { headers }));
  metric(env, response.status === 101 ? `upgrade_total.${path.role}` : "connect_rejected_total.route");
  return response;
}

export default {
  async fetch(request: Request, env: RelayEnvironment): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      metric(env, "internal_error_total");
      return errorResponse("RELAY_UNAVAILABLE", 503);
    }
  },
};
