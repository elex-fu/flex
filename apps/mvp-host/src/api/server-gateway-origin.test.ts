import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ConnectivityConfig } from "../connectivity/config.js";
import { createHostServer, type HostServer } from "../server.js";
import { SessionOrchestrator } from "../session/orchestrator.js";

const PUBLIC_ORIGIN = "https://flyx-host.example.ts.net";
const HOSTED_ORIGIN = "https://app.flyx.example";
const LOCAL_ORIGIN = "http://127.0.0.1:4173";
const open: HostServer[] = [];

afterEach(async () => { while (open.length) await open.pop()!.stop(); });

async function server(): Promise<HostServer> {
  const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
  const connectivity: ConnectivityConfig = {
    mode: "auto",
    bindHost: "127.0.0.1",
    port: 4173,
    localOrigin: LOCAL_ORIGIN,
    publicBaseUrl: PUBLIC_ORIGIN,
    requireTailscaleServe: false,
    allowInsecureHttp: false,
    relayEnabled: false,
    hostedAppUrl: HOSTED_ORIGIN,
  };
  const host = createHostServer({ orchestrator, connectivity, port: 0, pairingConfirmation: () => true });
  open.push(host);
  await host.app.ready();
  return host;
}

describe("Host connection gateway origins", () => {
  it("accepts exact local and public origins while rejecting lookalikes", async () => {
    const host = await server();
    const local = await host.app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "127.0.0.1:4173", origin: LOCAL_ORIGIN } });
    const publicRequest = await host.app.inject({ method: "GET", url: "/.well-known/flyx-host", headers: { host: "flyx-host.example.ts.net", origin: PUBLIC_ORIGIN } });
    const hostile = await host.app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: "127.0.0.1:4173", origin: `${PUBLIC_ORIGIN}.evil.invalid` } });

    expect(local.statusCode).toBe(200);
    expect(publicRequest.statusCode).toBe(200);
    expect(hostile.statusCode).toBe(403);
    expect(hostile.json().error.code).toBe("ORIGIN_REJECTED");
  });

  it("grants hosted-app CORS only to descriptor, device-ticket, and websocket paths", async () => {
    const host = await server();
    const preflight = await host.app.inject({
      method: "OPTIONS",
      url: "/api/auth/device-ticket",
      headers: { host: "flyx-host.example.ts.net", origin: HOSTED_ORIGIN, "access-control-request-method": "POST" },
    });
    const forbidden = await host.app.inject({
      method: "GET", url: "/api/bootstrap", headers: { host: "flyx-host.example.ts.net", origin: HOSTED_ORIGIN },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(HOSTED_ORIGIN);
    expect(preflight.headers.vary).toContain("Origin");
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("invalidates a device ticket when its refresh credential rotates", async () => {
    const host = await server();
    const device = host.devices.createBrowserDevice();
    const first = host.devices.issueRefreshCredential(device.id, Buffer.alloc(32, 1).toString("base64url"));
    const response = await host.app.inject({
      method: "POST",
      url: "/api/auth/device-ticket",
      headers: { host: "flyx-host.example.ts.net", origin: HOSTED_ORIGIN, "content-type": "application/json" },
      payload: { refreshCredential: first.refreshCredential },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(HOSTED_ORIGIN);

    host.devices.refreshDeviceCredential({ refreshCredential: first.refreshCredential, proposedDevicePublicKey: Buffer.alloc(32, 2).toString("base64url") });
    const address = await host.start();
    const socketUrl = new URL("/api/ws", address);
    socketUrl.protocol = "ws:";
    socketUrl.searchParams.set("ticket", response.json().ticket as string);
    const socket = new WebSocket(socketUrl, { origin: HOSTED_ORIGIN });
    const closed = await new Promise<{ code: number; reason: string }>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("STALE_TICKET_CLOSE_TIMEOUT")), 3_000);
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        resolvePromise({ code, reason: reason.toString("utf8") });
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(closed).toEqual({ code: 1008, reason: "TICKET_INVALID" });
  });
});
