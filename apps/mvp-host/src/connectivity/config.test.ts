import { describe, expect, it, vi } from "vitest";
import { parseConnectivityConfig, resolveConnectivityConfig, TailscaleServeError, validateHttpsOrigin, validateTailscaleServeStatus } from "./config.js";

const origin = "https://workstation.tailnet.ts.net";

function serve({ hostname = "workstation.tailnet.ts.net", listenerPort = 443, hostPort = 4173,
  proxy = `http://127.0.0.1:${hostPort}`, https = true, funnel = false }: {
    hostname?: string; listenerPort?: number; hostPort?: number; proxy?: string; https?: boolean; funnel?: boolean;
  } = {}) {
  const authority = `${hostname}:${listenerPort}`;
  return {
    TCP: { [listenerPort]: https ? { HTTPS: true } : { HTTP: true } },
    Web: { [authority]: { Handlers: { "/": { Proxy: proxy } } } },
    AllowFunnel: { [authority]: funnel },
  };
}

describe("connectivity configuration", () => {
  it("retains loopback default and interprets the legacy Serve requirement", () => {
    expect(parseConnectivityConfig({})).toMatchObject({ mode: "local", localOrigin: "http://127.0.0.1:4173", relayEnabled: false });
    expect(parseConnectivityConfig({ FLYX_REQUIRE_TAILSCALE_SERVE: "1", PORT: "8080" }))
      .toMatchObject({ mode: "tailscale", requireTailscaleServe: true, port: 8080 });
  });

  it.each(["http://workstation.tailnet.ts.net", "https://user:secret@example.com", "https://@example.com",
    "https://example.com/app", "https://example.com/a/..", "https://example.com?", "https://example.com#",
    "https://example.com/?secret=1", "https://example.com/#pair=secret", " https://example.com", "https://example.com\\"])
  ("rejects non-origin or insecure public URLs: %s", (value) => {
    expect(() => validateHttpsOrigin(value)).toThrow();
  });

  it("normalizes harmless origin spelling only", () => {
    expect(validateHttpsOrigin("https://Workstation.tailnet.ts.net:443/")).toBe(origin);
    expect(validateHttpsOrigin("https://workstation.tailnet.ts.net:8443")).toBe(`${origin}:8443`);
  });

  it.each(["0", "-1", "65536", "4.5", " 4173 ", "1e3", "abc"])("rejects invalid ports: %s", (PORT) => {
    expect(() => parseConnectivityConfig({ PORT })).toThrow("PORT");
  });

  it("requires explicit relay opt-in and secure endpoints", () => {
    expect(() => parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "relay" })).toThrow("feature flag");
    expect(() => parseConnectivityConfig({ FLYX_RELAY_ENABLED: "1" })).toThrow("requires");
    expect(() => parseConnectivityConfig({ FLYX_RELAY_URL: "ws://127.0.0.1:8787" })).toThrow("WSS");
    expect(parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "relay", FLYX_RELAY_ENABLED: "1",
      FLYX_RELAY_URL: "wss://relay.example.com", FLYX_HOSTED_APP_URL: "https://app.example.com" }))
      .toMatchObject({ relayEnabled: true, relayUrl: "wss://relay.example.com", hostedAppUrl: "https://app.example.com" });
  });

  it("restricts insecure HTTP to local-only debugging", () => {
    expect(() => parseConnectivityConfig({ FLYX_BIND: "0.0.0.0" })).toThrow("loopback");
    expect(() => parseConnectivityConfig({ FLYX_ALLOW_INSECURE_HTTP: "1", FLYX_CONNECTIVITY_MODE: "auto" })).toThrow("local mode");
    expect(() => parseConnectivityConfig({ FLYX_ALLOW_INSECURE_HTTP: "1", FLYX_PUBLIC_BASE_URL: origin })).toThrow("local mode");
    expect(parseConnectivityConfig({ FLYX_ALLOW_INSECURE_HTTP: "1" }).allowInsecureHttp).toBe(true);
    expect(() => parseConnectivityConfig({ FLYX_REQUIRE_TAILSCALE_SERVE: "true" })).toThrow("0 or 1");
  });
});

describe("actual Tailscale Serve JSON validation", () => {
  it("discovers one correct listener, including foreground Serve", () => {
    expect(validateTailscaleServeStatus(serve(), { port: 4173 })).toBe(origin);
    expect(validateTailscaleServeStatus({ Foreground: { "session-123": serve({ listenerPort: 8443 }) } }, { port: 4173 }))
      .toBe(`${origin}:8443`);
  });

  it.each([serve({ hostPort: 3000 }), serve({ proxy: "http://192.168.1.2:4173" }),
    serve({ proxy: "http://localhost:4173" }), serve({ proxy: "http://127.0.0.1:4173/api" }),
    serve({ proxy: "https://127.0.0.1:4173" }), serve({ hostname: "workstation" }),
    serve({ hostname: "workstation.example.com" }), serve({ https: false }), serve({ funnel: true })])
  ("rejects an unsafe or mismatched listener", (status) => {
    expect(() => validateTailscaleServeStatus(status, { port: 4173, publicBaseUrl: origin })).toThrow();
  });

  it("rejects malformed JSON structures and listener types", () => {
    for (const status of ["Available within your tailnet", [], { Web: [] }, { Web: { "workstation.tailnet.ts.net": {} } },
      { ...serve(), TCP: { 443: { HTTPS: "true" } } }, { ...serve(), AllowFunnel: { "workstation.tailnet.ts.net:443": "false" } },
      { TCP: { 443: { TCPForward: "127.0.0.1:4173" } } }]) {
      expect(() => validateTailscaleServeStatus(status, { port: 4173 })).toThrow();
    }
  });

  it("refuses discovery ambiguity but accepts an explicit validated listener", () => {
    const first = serve();
    const second = serve({ listenerPort: 8443 });
    const both = { TCP: { ...first.TCP, ...second.TCP }, Web: { ...first.Web, ...second.Web } };
    expect(() => validateTailscaleServeStatus(both, { port: 4173 })).toThrow("Multiple Serve origins");
    expect(validateTailscaleServeStatus(both, { port: 4173, publicBaseUrl: origin })).toBe(origin);
  });

  it("rejects unsafe aliases and routing overrides even with a pinned valid origin", () => {
    const primary = serve();
    const alias = serve({ listenerPort: 8443, funnel: true });
    expect(() => validateTailscaleServeStatus({ ...primary, Foreground: { unsafe: alias } }, { port: 4173, publicBaseUrl: origin }))
      .toThrow("Funnel");
    const status = serve();
    Object.assign(status.Web["workstation.tailnet.ts.net:443"]!.Handlers, { "/api": { Proxy: "http://127.0.0.1:3000" } });
    expect(() => validateTailscaleServeStatus(status, { port: 4173 })).toThrow("path overrides");
  });

  it("reads status only for requested modes and fails closed on unsafe auto discovery", async () => {
    const readStatus = vi.fn(async () => serve());
    await resolveConnectivityConfig(parseConnectivityConfig({}), readStatus);
    expect(readStatus).not.toHaveBeenCalled();
    expect(await resolveConnectivityConfig(parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "tailscale" }), readStatus))
      .toMatchObject({ publicBaseUrl: origin });
    const auto = parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "auto" });
    expect(await resolveConnectivityConfig(auto, async () => null)).toBe(auto);
    expect(await resolveConnectivityConfig(auto, async () => { throw new TailscaleServeError("TAILSCALE_UNAVAILABLE", "offline"); })).toBe(auto);
    await expect(resolveConnectivityConfig(auto, async () => serve({ funnel: true }))).rejects.toThrow("Funnel");
    await expect(resolveConnectivityConfig(auto, async () => serve({ hostPort: 9999 }))).rejects.toThrow("No Serve");
    await expect(resolveConnectivityConfig(parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "tailscale" }), async () => null))
      .rejects.toThrow("No Tailscale Serve");
  });
});
