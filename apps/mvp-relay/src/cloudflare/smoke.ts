import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import type { RawData } from "ws";
import type { RouteRegistration } from "../route-registry.js";

/** Real workerd/Wrangler probe. Prints categories only, never route credentials. */
const base = new URL(process.argv[2] ?? "http://127.0.0.1:8787");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("SMOKE_REQUIRES_EXPLICIT_LOCAL_WORKER");
}
const opened: WebSocket[] = [];
let stage = "health";
const deadline = setTimeout(() => {
  for (const socket of opened) socket.terminate();
  process.exitCode = 1;
  console.error("Cloudflare local smoke: timeout");
}, 20_000);

function frames(socket: WebSocket) {
  const messages: Array<{ bytes: Buffer; binary: boolean }> = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  socket.on("message", (data: RawData, binary: boolean) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    messages.push({ bytes, binary });
    waiters.splice(0).forEach((notify) => notify());
  });
  socket.on("close", () => { closed = true; waiters.splice(0).forEach((notify) => notify()); });
  return {
    async text(type: string): Promise<Record<string, unknown>> {
      while (true) {
        const index = messages.findIndex((message) => !message.binary && (JSON.parse(message.bytes.toString()) as { type: string }).type === type);
        if (index >= 0) return JSON.parse(messages.splice(index, 1)[0]!.bytes.toString()) as Record<string, unknown>;
        if (closed) throw new Error("SOCKET_CLOSED");
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async binary(): Promise<Buffer> {
      while (true) {
        const index = messages.findIndex((message) => message.binary);
        if (index >= 0) return messages.splice(index, 1)[0]!.bytes;
        if (closed) throw new Error("SOCKET_CLOSED");
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

async function connect(path: string, credential?: string) {
  const url = new URL(path, base);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    perMessageDeflate: false,
    ...(credential ? { headers: { Authorization: `Bearer ${credential}` } } : {}),
  });
  opened.push(socket);
  const reader = frames(socket);
  // Do not log WebSocket Error objects: they may contain the URL.
  socket.on("error", () => undefined);
  await once(socket, "open");
  return { socket, reader };
}

async function rejectedUpgrade(path: string, credential: string): Promise<number> {
  const url = new URL(path, base);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${credential}` }, perMessageDeflate: false });
  opened.push(socket);
  return new Promise<number>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("open", () => { reject(new Error("EXPECTED_REJECTION")); });
    socket.on("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
      request.destroy();
    });
  });
}

try {
  const health = await fetch(new URL("/healthz", base));
  assert.equal(health.status, 200);
  stage = "registration";
  const response = await fetch(new URL("/v1/routes", base), { method: "POST" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const route = await response.json() as RouteRegistration;
  stage = "control";
  const control = await connect(`/v1/routes/${route.routeId}/control?generation=1`, route.relayCredential);
  assert.equal((await control.reader.text("registered")).generation, 1);
  stage = "client";
  const client = await connect(`/v1/routes/${route.routeId}/client`);
  const connected = await client.reader.text("client.connected");
  const connectionId = String(connected.connectionId);
  assert.equal((await control.reader.text("connected")).connectionId, connectionId);
  stage = "data-pairing";
  const data = await connect(`/v1/routes/${route.routeId}/data/${connectionId}?generation=1`, route.relayCredential);
  await data.reader.text("data.paired");
  await client.reader.text("data.paired");
  stage = "binary-forwarding";
  const payload = randomBytes(1024);
  client.socket.send(payload);
  assert.deepEqual(await data.reader.binary(), payload);
  data.socket.send(JSON.stringify({ type: "ack", sequence: 1 }));
  data.socket.send(payload);
  assert.deepEqual(await client.reader.binary(), payload);
  client.socket.send(JSON.stringify({ type: "ack", sequence: 1 }));
  stage = "heartbeat";
  control.socket.send(JSON.stringify({ type: "ping", nonce: "local-smoke" }));
  assert.equal((await control.reader.text("pong")).nonce, "local-smoke");
  stage = "generation-recovery";
  const replacement = await connect(`/v1/routes/${route.routeId}/control?generation=2`, route.relayCredential);
  assert.deepEqual((await replacement.reader.text("registered")).connectionIds, [connectionId]);
  const staleStatus = await rejectedUpgrade(`/v1/routes/${route.routeId}/control?generation=1`, route.relayCredential);
  assert.equal(staleStatus, 409);
  console.log("Cloudflare local smoke: registration, authenticated control, pairing, bidirectional binary, ACK, heartbeat, generation recovery passed");
} catch {
  process.exitCode = 1;
  console.error(`Cloudflare local smoke: failed at ${stage} (credentials and URLs redacted)`);
} finally {
  clearTimeout(deadline);
  for (const socket of opened) socket.terminate();
}
