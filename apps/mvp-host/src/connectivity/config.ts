import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

export type ConnectivityMode = "local" | "tailscale" | "relay" | "auto";

export interface ConnectivityConfig {
  mode: ConnectivityMode;
  bindHost: "127.0.0.1";
  port: number;
  localOrigin: string;
  publicBaseUrl?: string;
  requireTailscaleServe: boolean;
  allowInsecureHttp: boolean;
  relayEnabled: boolean;
  relayUrl?: string;
  hostedAppUrl?: string;
  relayRegistrationToken?: string;
}

type Environment = Record<string, string | undefined>;

export function parseConnectivityConfig(env: Environment = process.env): ConnectivityConfig {
  const requireServe = flag(env.FLYX_REQUIRE_TAILSCALE_SERVE, "FLYX_REQUIRE_TAILSCALE_SERVE");
  const mode = env.FLYX_CONNECTIVITY_MODE || (requireServe ? "tailscale" : "local");
  if (mode !== "local" && mode !== "tailscale" && mode !== "relay" && mode !== "auto") {
    throw new Error("FLYX_CONNECTIVITY_MODE must be local, tailscale, relay, or auto");
  }
  const portText = env.PORT || "4173";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  if (env.FLYX_BIND && !["127.0.0.1", "::1", "localhost"].includes(env.FLYX_BIND)) {
    throw new Error("Flyx Host must bind to loopback; expose it with Tailscale Serve or Flyx Relay");
  }
  const port = Number(portText);
  const publicBaseUrl = env.FLYX_PUBLIC_BASE_URL
    ? validateHttpsOrigin(env.FLYX_PUBLIC_BASE_URL, "FLYX_PUBLIC_BASE_URL") : undefined;
  const hostedAppUrl = env.FLYX_HOSTED_APP_URL
    ? validateHttpsOrigin(env.FLYX_HOSTED_APP_URL, "FLYX_HOSTED_APP_URL") : undefined;
  const relayUrl = env.FLYX_RELAY_URL
    ? validateOrigin(env.FLYX_RELAY_URL, "wss:", "FLYX_RELAY_URL") : undefined;
  const relayEnabled = flag(env.FLYX_RELAY_ENABLED, "FLYX_RELAY_ENABLED");
  const allowInsecureHttp = flag(env.FLYX_ALLOW_INSECURE_HTTP, "FLYX_ALLOW_INSECURE_HTTP");
  if (relayEnabled && (!relayUrl || !hostedAppUrl)) {
    throw new Error("FLYX_RELAY_ENABLED=1 requires FLYX_RELAY_URL and FLYX_HOSTED_APP_URL");
  }
  if (mode === "relay" && !relayEnabled) {
    throw new Error("Relay mode requires the explicit FLYX_RELAY_ENABLED=1 feature flag");
  }
  if (allowInsecureHttp && (mode !== "local" || publicBaseUrl || relayEnabled || requireServe)) {
    throw new Error("FLYX_ALLOW_INSECURE_HTTP=1 is restricted to local mode without remote endpoints");
  }
  return {
    mode, bindHost: "127.0.0.1", port, localOrigin: `http://127.0.0.1:${port}`,
    requireTailscaleServe: requireServe || mode === "tailscale", allowInsecureHttp, relayEnabled,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(hostedAppUrl ? { hostedAppUrl } : {}),
    ...(relayUrl ? { relayUrl } : {}),
    ...(env.FLYX_RELAY_REGISTRATION_TOKEN ? { relayRegistrationToken: env.FLYX_RELAY_REGISTRATION_TOKEN } : {}),
  };
}

export function validateHttpsOrigin(value: string, label = "Public URL"): string {
  return validateOrigin(value, "https:", label);
}

function validateOrigin(value: string, protocol: "https:" | "wss:", label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a ${protocol.slice(0, -1).toUpperCase()} origin`); }
  // Reject raw delimiters too: URL normalizes an empty query/fragment and dot
  // segments. Configuration must never silently turn a supplied URL into one
  // with different routing or credential semantics.
  const authority = value.match(/^[a-z]+:\/\/([^/?#]+)(\/?)$/i);
  if (!authority || /[\s\\]/.test(value) || authority[1]?.includes("@") || url.protocol !== protocol
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be a ${protocol.slice(0, -1).toUpperCase()} origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function flag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 0 or 1`);
}

export type TailscaleServeErrorCode = "TAILSCALE_UNAVAILABLE" | "TAILSCALE_NOT_CONFIGURED" | "TAILSCALE_INVALID_CONFIG" | "TAILSCALE_AMBIGUOUS";

export class TailscaleServeError extends Error {
  constructor(readonly code: TailscaleServeErrorCode, message: string) {
    super(message);
    this.name = "TailscaleServeError";
  }
}

export async function readTailscaleServeStatus(): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFileCallback)("tailscale", ["serve", "status", "--json"], {
      timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8",
    }));
  } catch {
    throw new TailscaleServeError("TAILSCALE_UNAVAILABLE", "Tailscale Serve status is unavailable; check the local tailscale CLI and daemon");
  }
  try { return JSON.parse(stdout) as unknown; } catch {
    throw new TailscaleServeError("TAILSCALE_INVALID_CONFIG", "Tailscale Serve returned invalid JSON; HTTPS routing could not be verified");
  }
}

export async function resolveConnectivityConfig(
  config: ConnectivityConfig,
  readStatus: () => Promise<unknown> = readTailscaleServeStatus,
): Promise<ConnectivityConfig> {
  if (!config.requireTailscaleServe && config.mode !== "auto") return config;
  try {
    const publicBaseUrl = validateTailscaleServeStatus(await readStatus(), {
      port: config.port, ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    });
    return { ...config, publicBaseUrl };
  } catch (error) {
    // Auto may fall back only when Serve is absent. A discovered unsafe or
    // ambiguous configuration must not quietly advertise a different endpoint.
    if (!config.requireTailscaleServe && !config.publicBaseUrl && error instanceof TailscaleServeError
        && (error.code === "TAILSCALE_UNAVAILABLE" || error.code === "TAILSCALE_NOT_CONFIGURED")) return config;
    throw error;
  }
}

type JsonRecord = Record<string, unknown>;
type ServeEndpoint = { authority: string; origin: string; listener: JsonRecord; handlers: JsonRecord };

/** Parses the actual ipn.ServeConfig shape, not the human-readable status text.
 * Schema: https://github.com/tailscale/tailscale/blob/main/ipn/serve.go
 */
export function validateTailscaleServeStatus(status: unknown, options: { port: number; publicBaseUrl?: string }): string {
  if (status === null) throw noServe();
  const root = record(status, "Serve status");
  const configs: JsonRecord[] = [root];
  for (const value of Object.values(optionalRecord(root.Foreground, "Foreground"))) {
    const foreground = record(value, "Foreground entry");
    if (Object.keys(optionalRecord(foreground.Foreground, "Nested Foreground")).length) invalid("Nested foreground Serve configs are unsupported");
    configs.push(foreground);
  }
  const funnelAuthorities = new Set<string>();
  const endpoints: ServeEndpoint[] = [];
  for (const config of configs) {
    for (const [authority, enabled] of Object.entries(optionalRecord(config.AllowFunnel, "AllowFunnel"))) {
      if (typeof enabled !== "boolean") invalid("Serve Funnel flags must be boolean");
      if (enabled) funnelAuthorities.add(authority.toLowerCase());
    }
    const tcp = optionalRecord(config.TCP, "TCP");
    for (const [authority, value] of Object.entries(optionalRecord(config.Web, "Web"))) {
      const match = /^([a-z0-9.-]+):(\d+)$/i.exec(authority);
      if (!match || !match[1] || !match[2] || Number(match[2]) < 1 || Number(match[2]) > 65_535) {
        invalid("Serve Web keys must be explicit FQDN:port listeners");
      }
      const endpoint = record(value, "Web entry");
      endpoints.push({
        authority: authority.toLowerCase(), origin: new URL(`https://${authority}`).origin,
        listener: optionalRecord(tcp[match[2]!], "TCP listener"),
        handlers: optionalRecord(endpoint.Handlers, "Handlers"),
      });
    }
  }
  if (!endpoints.length) {
    if (configs.some((config) => Object.keys(optionalRecord(config.TCP, "TCP")).length > 0)) {
      invalid("Serve has no HTTPS Web listener for Flyx; raw TCP forwarding is not supported");
    }
    throw noServe();
  }
  const expected = `http://127.0.0.1:${options.port}`;
  const explicitOrigin = options.publicBaseUrl ? validateHttpsOrigin(options.publicBaseUrl) : undefined;
  const matching = endpoints.filter((entry) => explicitOrigin
    ? entry.origin === explicitOrigin : proxyOrigin(entry.handlers["/"]) === expected);
  if (!matching.length) invalid("No Serve HTTPS root proxy matches the configured public origin and loopback Host port");
  // Every route exposing this Host must remain tailnet-only HTTPS, including
  // aliases that are not selected as the advertised origin.
  const exposingHost = endpoints.filter((entry) => Object.values(entry.handlers).some((handler) => proxyOrigin(handler) === expected));
  for (const entry of new Set([...matching, ...exposingHost])) {
    const hostname = new URL(entry.origin).hostname;
    if (!isMagicDnsFqdn(hostname)) invalid("Serve must use a full MagicDNS device.tailnet.ts.net hostname");
    if (funnelAuthorities.has(entry.authority)) invalid("Flyx cannot use a Tailscale Funnel endpoint; configure tailnet-only Serve");
    if (entry.listener.HTTPS !== true || entry.listener.HTTP === true || entry.listener.TCPForward || entry.listener.TerminateTLS) {
      invalid("Flyx requires a Serve HTTPS listener without plaintext HTTP or raw TCP forwarding");
    }
    if (proxyOrigin(entry.handlers["/"]) !== expected) invalid("Serve root proxy must target the current http://127.0.0.1:PORT Host");
    for (const handler of Object.values(entry.handlers)) {
      if (proxyOrigin(handler) !== expected) invalid("Serve path overrides must not route Flyx pages or API requests to another target");
    }
  }
  const origins = [...new Set(matching.map((entry) => entry.origin))];
  if (origins.length !== 1) {
    throw new TailscaleServeError("TAILSCALE_AMBIGUOUS", "Multiple Serve origins match Flyx; set FLYX_PUBLIC_BASE_URL explicitly");
  }
  return origins[0]!;
}

function proxyOrigin(handler: unknown): string | undefined {
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) return undefined;
  const value = handler as JsonRecord;
  if (typeof value.Proxy !== "string" || value.Path || value.Text || value.Redirect) return undefined;
  try {
    const raw = value.Proxy;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(raw)) return undefined;
    const url = new URL(raw);
    return url.origin;
  } catch { return undefined; }
}

function isMagicDnsFqdn(hostname: string): boolean {
  return hostname.length <= 253 && hostname.endsWith(".ts.net") && hostname.split(".").length >= 4
    && hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function optionalRecord(value: unknown, label: string): JsonRecord {
  return value === undefined || value === null ? {} : record(value, label);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be a JSON object`);
  return value as JsonRecord;
}

function invalid(message: string): never {
  throw new TailscaleServeError("TAILSCALE_INVALID_CONFIG", message);
}

function noServe(): TailscaleServeError {
  return new TailscaleServeError("TAILSCALE_NOT_CONFIGURED", "No Tailscale Serve HTTPS endpoint is configured for Flyx");
}
