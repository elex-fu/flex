import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHostServer } from "./server.js";
import { SessionOrchestrator } from "./session/orchestrator.js";

const openServers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => { while (openServers.length) await openServers.pop()!.stop(); });

describe("MVP HTTP pairing surface", () => {
  it("exchanges a one-time pairing token for an HttpOnly session and ticket", async () => {
    const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
    const server = createHostServer({ orchestrator, pairingConfirmation: () => true });
    openServers.push(server);
    await server.app.ready();
    const before = await server.app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(before.statusCode).toBe(200);
    expect(before.json().pairingRequired).toBe(true);
    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    expect(exchange.statusCode).toBe(200);
    const credential = exchange.json().credential as string;
    const browser = await server.app.inject({ method: "POST", url: "/api/auth/browser-session", payload: { credential } });
    expect(browser.statusCode).toBe(200);
    const setCookie = browser.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0]!.split(";", 1)[0] : String(setCookie).split(";", 1)[0];
    expect(cookie).toContain("flyx_session=");
    expect(String(setCookie)).toContain("HttpOnly");
    expect(String(setCookie)).toContain("Secure");
    expect(String(setCookie)).toContain("SameSite=Strict");
    const after = await server.app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie } });
    expect(after.json().pairingRequired).toBe(false);
    const ticket = await server.app.inject({ method: "POST", url: "/api/auth/websocket-ticket", headers: { cookie } });
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().ticket).toEqual(expect.any(String));
    const logout = await server.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers["set-cookie"])).toContain("flyx_session=");
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    const afterLogout = await server.app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie } });
    expect(afterLogout.json().pairingRequired).toBe(true);
    const ticketAfterLogout = await server.app.inject({ method: "POST", url: "/api/auth/websocket-ticket", headers: { cookie } });
    expect(ticketAfterLogout.statusCode).toBe(401);
    const replay = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    expect(replay.statusCode).toBe(403);
  });

  it("rate-limits repeated invalid pairing attempts", async () => {
    const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
    const server = createHostServer({ orchestrator, pairingConfirmation: () => true });
    openServers.push(server);
    await server.app.ready();
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: "invalid-token" } }));
    }
    expect(responses.slice(0, 5).every((response) => response.statusCode === 403)).toBe(true);
    expect(responses[5]?.statusCode).toBe(429);
    expect(responses[5]?.json().error.code).toBe("PAIRING_RATE_LIMITED");
  });

  it("serves an anonymous pairing QR SVG without local paths, rotating consumed grants", async () => {
    const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
    const orchestrator = new SessionOrchestrator({ workspace });
    const server = createHostServer({ orchestrator, pairingConfirmation: () => true });
    openServers.push(server);
    await server.app.ready();
    // The phone has no credential yet, so the QR must be reachable anonymously.
    const qr = await server.app.inject({ method: "GET", url: "/api/pairing/qrcode", headers: { host: "127.0.0.1:4173" } });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers["content-type"]).toContain("image/svg+xml");
    expect(qr.body).toContain("<svg");
    // Only the pairing URL is encoded; no absolute local path may leak.
    expect(qr.body).not.toContain(workspace);
    expect(qr.body).not.toContain("claude-fixtures");
    // After the startup grant is consumed, the endpoint rotates to a fresh
    // active grant instead of rendering a dead QR.
    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    expect(exchange.statusCode).toBe(200);
    const rotated = await server.app.inject({ method: "GET", url: "/api/pairing/qrcode", headers: { host: "127.0.0.1:4173" } });
    expect(rotated.statusCode).toBe(200);
    const exchangedToken = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.activeQrPairingToken() } });
    expect(exchangedToken.statusCode).toBe(200);
  });

  it("does not expose the absolute workspace path in diagnostics", async () => {
    const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
    const server = createHostServer({ orchestrator, pairingConfirmation: () => true });
    openServers.push(server);
    await server.app.ready();
    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    const browser = await server.app.inject({ method: "POST", url: "/api/auth/browser-session", payload: { credential: exchange.json().credential } });
    const setCookie = browser.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0]!.split(";", 1)[0] : String(setCookie).split(";", 1)[0];
    const status = await server.app.inject({ method: "GET", url: "/api/status", headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().provider.workspace).toBe("claude-fixtures");
    expect(status.json().provider.workspace).not.toContain("/");
  });

  it("requires the Host pairing confirmation callback", async () => {
    const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
    const server = createHostServer({ orchestrator, pairingConfirmation: () => false });
    openServers.push(server);
    await server.app.ready();
    const exchange = await server.app.inject({ method: "POST", url: "/api/pairing/exchange", payload: { token: server.auth.pairingUrlToken } });
    expect(exchange.statusCode).toBe(403);
    expect(exchange.json().error.code).toBe("PAIRING_DENIED");
  });

  it("refuses a non-loopback bind", async () => {
    const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
    const server = createHostServer({ orchestrator, host: "0.0.0.0" });
    openServers.push(server);
    await expect(server.start()).rejects.toMatchObject({ code: "HOST_BIND_FORBIDDEN" });
  });

  it("serves a newly built static asset without restarting the Host", async () => {
    const webRoot = await mkdtemp(resolve(process.cwd(), "../../.flyx-web-test-"));
    try {
      await mkdir(resolve(webRoot, "assets"), { recursive: true });
      await writeFile(resolve(webRoot, "index.html"), "<html><body>test</body></html>");
      const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
      const server = createHostServer({ orchestrator, webRoot });
      openServers.push(server);
      await server.app.ready();
      await writeFile(resolve(webRoot, "assets/new-hash.js"), "window.__FLYX_DYNAMIC_ASSET__ = true;");
      const asset = await server.app.inject({ method: "GET", url: "/assets/new-hash.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain("__FLYX_DYNAMIC_ASSET__");
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
