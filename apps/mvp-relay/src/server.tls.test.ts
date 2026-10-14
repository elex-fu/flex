import { afterEach, describe, expect, it } from "vitest";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { createRelayServer, type RelayServer } from "./server.js";
import type { RouteRegistration } from "./route-registry.js";
import { RELAY_TEST_TLS } from "./test-support/tls-fixture.js";

const servers: RelayServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
});

function requestJson(url: string, options: { method: string; headers?: Record<string, string> } = { method: "GET" }): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ...options, ca: RELAY_TEST_TLS.cert }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function open(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { ca: RELAY_TEST_TLS.cert, perMessageDeflate: false, ...(headers ? { headers } : {}) });
    sockets.push(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedStatus(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { ca: RELAY_TEST_TLS.cert, perMessageDeflate: false, ...(headers ? { headers } : {}) });
    sockets.push(socket);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => reject(new Error("UNEXPECTED_UPGRADE")));
    socket.once("error", error => reject(error));
  });
}

describe("Node Relay TLS boundary", () => {
  it("serves HTTPS/WSS, authenticates control upgrades, and rejects bad credentials", async () => {
    const server = createRelayServer({ host: "127.0.0.1", port: 0, tls: RELAY_TEST_TLS });
    servers.push(server);
    const urls = await server.listen();
    const health = await requestJson(`${urls.httpUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers["strict-transport-security"]).toContain("max-age=31536000");

    const registrationResponse = await requestJson(`${urls.httpUrl}/v1/routes`, { method: "POST" });
    expect(registrationResponse.status).toBe(201);
    const registration = JSON.parse(registrationResponse.body) as RouteRegistration;
    const root = `${urls.websocketUrl}/v1/routes/${registration.routeId}`;
    const auth = { Authorization: `Bearer ${registration.relayCredential}` };
    const control = await open(`${root}/control?generation=1`, auth);
    const registered = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("REGISTERED_TIMEOUT")), 3000);
      control.once("message", data => { clearTimeout(timer); resolve(JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as Record<string, unknown>); });
    });
    expect(registered).toEqual({ type: "registered", connectionIds: [], generation: 1 });
    expect(await rejectedStatus(`${root}/control?generation=2`, { Authorization: `Bearer ${"A".repeat(43)}` })).toBe(401);
    expect(await rejectedStatus(`${root}/control?generation=2`)).toBe(401);
  });
});
