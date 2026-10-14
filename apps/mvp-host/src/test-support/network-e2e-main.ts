import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { encodeRelayPairingFragment, HostDescriptorV1Schema, type HostDescriptorV1 } from "@flyx/mvp-protocol";
import { createRelayServer, MemoryRelayRouteStore, type RelayMetric, type RelayRouteRecord, type RelayServer } from "@flyx/mvp-relay";
import type { HostProfile, SocketFactory } from "@flyx/client-core";
import { DEVICE_SCOPES } from "../auth/connection-authorizer.js";
import { loadOrCreateHostIdentity, publicHostIdentity } from "../identity/host-identity.js";
import type { RelaySocketFactory } from "../relay/relay-socket.js";
import { createHostServer, type HostServer } from "../server.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { DeterministicAdapter } from "./deterministic-adapter.js";

/** Public, deliberately non-secret test credentials. Never used by a production entry point. */
export const NETWORK_TEST_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCospH5Bp0Yt7Y6
ptYdaFf6JdVRHlVyX+70dHcbFj1yzIH9SsyF/1WIjNrW1DOs6wfRBbQ6YIHFvg3+
RTVkaKspcC3MwjmeRpuKCm2apVDjd//zJHDXzlAZE2NNFRtTWOkVTo/Lubn9qCzh
tvZfhpFIOuNHi0cYEZLyP8gvERVT9YQ01lW3xq5Os6QxPDBGRnVNX9iXIKHz5TMZ
fxqtt+jKgtBlfG3C5nnYkffEkz/CbtAYb6bzgoOUGZMyMQ2VTwHIAkuV33hW/AM4
K0McDYxwPHJgq4Cd3+DKQDK5myw9NBCuTQ/r9QlKWXA7UfD1u3rAyxx4CFB2gjvT
Cf6woKlhAgMBAAECggEAcLytaqNt1vfm0zlte8egi64+6XABIGdWFI3EjxiExjQ/
ZptXJPFnItMm6Ex1oEiNN7W9JQobj5+cUGHF9a0xPYcXRHBD+y8qgMzJRIDYFru6
E641rzLUOn3Hbdr+IOwZEEEpPbeHwSljnRAdg+c1LfUUsFo2j7Im5reTO0kKXMlv
fyBdLSjvRZnyBoYi0S3HAvopiMZfDMCKNKWopvFPWP2ylvG0M7+4Eroii2FdsyBV
qV5jof+DpBldmgBt4HRjHHcgOQwmWxxAapPpLn5T/ZSwkFKoB3zZNQKtfuggVyZR
xDCh+d3Hx5naYOng5wTtm3IdAdOj1h6hcPtGSbh2FQKBgQDbXvjK6D0Ze0XMgK8R
7ucoRhwr4Y7KjsdSWXHt+Z9TfCJKZZ666jgrk7XarS3TIwNnkI24WRtfsfPN36uz
g9WcmZ2vq239o873v9orFYL+30tKV1422ctb8Y2togeTUGppt4kGTU0kkIwI6zEP
4U+bjp4EHKgxBQfj8nvD5vSsnwKBgQDE3Y71UWSCRq61VcBy2T99j+TJj7AV0IqQ
GQVyEfmmJO9Gr9mcrFEQoRhVqeBLctmgLagSJqyGMfmGVrYx0bm3wap+10xZOqO7
u0Dl+h4HdKLFqBQIaRVlwcd4x18ivYIeqG0/cd8pUn3SbT3azXxSgcVsRS76kVBO
udbHLrTp/wKBgBxVswr6XlH5QzW79WD6m67vB1p/ouL0+Dfhx752PKca5I75ezwn
XqP6S0X4km+wGRN6b2O9VrTQlm4kEth4EdJNYTm8idN2IhiMFlD0UVw8WUw75rZt
AUBZ/fPMdvAHNgd7pl5DA9DSPtQ0FL05W//6ttxPG0ZhoPhHbMcMANR/AoGAGsCp
DrlS2UlVsJrInlLbh+qoAqQeH7jJO6/Kx6edr3BRe9+lyN653XKm5e1B577hyBys
PFs5Ertz10etVrPTcx9EVhxX6cBIQ9i8hwQoVIcLH6Upo8Lz/3IH82fUi9oI9rWY
swh8dRcath/WSgemn2e3NnFoYvCgYzJp94NnXm0CgYEAseftv7a2eVeBzBPYbu5m
kpLppz+rvp8Z9CWLOHcqNOcIkV9CpWWgsX3MIzeTuywlHd8uK1VWF47hoHMyk7z/
9iCpsC2iHAmVQAtuzbyWVNoWWrDHjXx9zYEMxSJ3LxU9ozPll8fGY6MO/MOfX0is
+niqH1k1tnvCNn6S2xH4y+w=
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIC9jCCAd6gAwIBAgIJAMTObRJg9PtxMA0GCSqGSIb3DQEBCwUAMCIxIDAeBgNV
BAMMF0ZseXggdGVzdCBmaXh0dXJlcyBvbmx5MB4XDTI2MDkwODAxMzIyM1oXDTM2
MDkwNTAxMzIyM1owIjEgMB4GA1UEAwwXRmx5eCB0ZXN0IGZpeHR1cmVzIG9ubHkw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCospH5Bp0Yt7Y6ptYdaFf6
JdVRHlVyX+70dHcbFj1yzIH9SsyF/1WIjNrW1DOs6wfRBbQ6YIHFvg3+RTVkaKsp
cC3MwjmeRpuKCm2apVDjd//zJHDXzlAZE2NNFRtTWOkVTo/Lubn9qCzhtvZfhpFI
OuNHi0cYEZLyP8gvERVT9YQ01lW3xq5Os6QxPDBGRnVNX9iXIKHz5TMZfxqtt+jK
gtBlfG3C5nnYkffEkz/CbtAYb6bzgoOUGZMyMQ2VTwHIAkuV33hW/AM4K0McDYxw
PHJgq4Cd3+DKQDK5myw9NBCuTQ/r9QlKWXA7UfD1u3rAyxx4CFB2gjvTCf6woKlh
AgMBAAGjLzAtMBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAPBgNVHRMBAf8E
BTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBRVbty/RFRd5CqcPxF8+tbtwL9GcvK
KxD8fcJiQGD+nxdOtZuru2f0gMaboaKStZwcYjjzY9v6Oi7KD3kALZKxHDGVPMVU
3d5EyH8xVJQdtR2qrl9wrdBupQ3nTpNd38r4uUsG02ACv+mAU1+NLfCYCK/XzYu0
FN3Zr8wWo+LsbyE+mo4t7BcViFioj56x72KxzPIaV/tp7nBSn7yIvyGOfylbuvVI
KfwAVQeaiQii4M5tqlg9PtxW7UZ5alnY0/WgunALQw8rGopNxPmPTxDi6haVzDqi
dwvb/b8AhG24K4keaESTIhR3nhn5/c4FaHZmxDbDvYJRflJhWKZ07jAe
-----END CERTIFICATE-----`,
};

export const NETWORK_PROMPT_MARKER = "FLYX_NETWORK_PROMPT_f574d81f";
export const NETWORK_OUTPUT_MARKER = "FLYX_NETWORK_OUTPUT_47d3b0df";
export const NETWORK_TOOL_MARKER = "FLYX_NETWORK_TOOL_e4253b57";
export const NETWORK_DIFF_MARKER = "FLYX_NETWORK_DIFF_92a884d1";

const runFile = promisify(execFile);
const FIXTURE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

/** HTTPS fetch with a pinned fixture CA and an isolated browser-style cookie jar. */
export function createFixtureFetch(origin?: string): typeof fetch {
  const cookies = new Map<string, string>();
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new Error("FIXTURE_HTTPS_REQUIRED");
    const headers = new Headers(request.headers);
    if (origin && !headers.has("origin")) headers.set("origin", origin);
    if (request.credentials === "include" && cookies.has(url.origin)) headers.set("cookie", cookies.get(url.origin)!);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return new Promise<Response>((fulfill, reject) => {
      const outgoing = httpsRequest(url, { method: request.method, headers: Object.fromEntries(headers), ca: NETWORK_TEST_TLS.cert, signal: request.signal }, (incoming) => {
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8 * 1024 * 1024) incoming.destroy(new Error("FIXTURE_RESPONSE_TOO_LARGE"));
          else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          const session = incoming.headers["set-cookie"]?.find((value) => value.startsWith("flyx_session="));
          if (session && request.credentials === "include") cookies.set(url.origin, session.split(";", 1)[0]!);
          const status = incoming.statusCode ?? 500;
          fulfill(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
}

function nodeRelaySocketFactory(sockets: Set<WebSocket>): RelaySocketFactory {
  return (url, options) => {
    const socket = new WebSocket(url, { headers: options.headers, ca: NETWORK_TEST_TLS.cert, maxPayload: options.maxFrameBytes, perMessageDeflate: false, followRedirects: false });
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    return {
      get readyState() { return socket.readyState; },
      get bufferedAmount() { return socket.bufferedAmount; },
      send(frame, done) { socket.send(frame, { binary: typeof frame !== "string", compress: false }, done); },
      close(code, reason) { socket.close(code, reason); },
      terminate() { socket.terminate(); },
      onOpen(handler) { socket.on("open", handler); return () => socket.off("open", handler); },
      onError(handler) { socket.on("error", handler); return () => socket.off("error", handler); },
      onClose(handler) {
        const listener = (code: number, reason: Buffer) => handler({ code, reason: reason.toString("utf8") });
        socket.on("close", listener); return () => socket.off("close", listener);
      },
      onMessage(handler) {
        const listener = (data: WebSocket.RawData, binary: boolean) => {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          handler(binary ? bytes : bytes.toString("utf8"));
        };
        socket.on("message", listener); return () => socket.off("message", listener);
      },
    };
  };
}

async function listen(server: HttpsServer) {
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((fulfill, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); fulfill(); }); });
  const address = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((fulfill, reject) => server.close((error) => error ? reject(error) : fulfill()));
    },
  };
}

function proxyHeaders(request: IncomingMessage) {
  return { ...request.headers, "x-forwarded-proto": "https" };
}

async function createHostProxy() {
  let upstream: string | undefined;
  const server = createHttpsServer(NETWORK_TEST_TLS, (request, reply) => {
    if (!upstream) { reply.writeHead(503).end(); return; }
    const outgoing = httpRequest(new URL(request.url ?? "/", upstream), { method: request.method, headers: proxyHeaders(request) }, (response) => {
      reply.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(reply);
    });
    outgoing.on("error", () => { if (!reply.headersSent) reply.writeHead(502); reply.end(); });
    request.pipe(outgoing);
  });
  server.on("upgrade", (request, client, head) => {
    if (!upstream) { client.destroy(); return; }
    const outgoing = httpRequest(new URL(request.url ?? "/", upstream), { method: "GET", headers: proxyHeaders(request) });
    outgoing.on("upgrade", (response, remote, remoteHead) => {
      let headers = `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
      for (let index = 0; index < response.rawHeaders.length; index += 2) headers += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
      client.write(`${headers}\r\n`);
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on("error", () => client.destroy()); client.on("error", () => remote.destroy());
      remote.on("close", () => client.destroy()); client.on("close", () => remote.destroy());
      remote.pipe(client); client.pipe(remote);
    });
    outgoing.on("response", () => client.destroy());
    outgoing.on("error", () => client.destroy());
    outgoing.end();
  });
  return { ...await listen(server), setUpstream(value: string | undefined) { upstream = value; } };
}

async function createHostedApp(webRoot?: string) {
  const root = webRoot ? resolve(webRoot) : undefined;
  const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
  const server = createHttpsServer(NETWORK_TEST_TLS, (request, reply) => {
    reply.setHeader("content-security-policy", FIXTURE_CSP);
    reply.setHeader("referrer-policy", "no-referrer"); reply.setHeader("x-content-type-options", "nosniff"); reply.setHeader("x-frame-options", "DENY");
    reply.setHeader("cache-control", "no-store");
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") { reply.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(request.url ?? "/", "https://fixture.invalid").pathname);
      // The hosted origin serves static assets only; there is no hidden Host API proxy.
      if (path.startsWith("/api/") || path.startsWith("/.well-known/")) { reply.writeHead(404).end(); return; }
      if (!root) { reply.setHeader("content-type", "text/html"); reply.end("<!doctype html><title>Flyx network fixture</title>"); return; }
      const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      const suffix = relative(root, file);
      if (suffix.startsWith("..") || isAbsolute(suffix) || !(await stat(file)).isFile()) { reply.writeHead(404).end(); return; }
      reply.setHeader("content-type", contentTypes[extname(file)] ?? "application/octet-stream");
      if (request.method === "HEAD") reply.end();
      else { const stream = createReadStream(file); stream.on("error", () => reply.destroy()); stream.pipe(reply); }
    })().catch(() => { if (!reply.headersSent) reply.writeHead(404); reply.end(); });
  });
  return listen(server);
}

class ObservedRouteStore extends MemoryRelayRouteStore {
  readonly persisted: RelayRouteRecord[] = [];
  override async put(record: RelayRouteRecord): Promise<void> {
    await super.put(record);
    this.persisted.push({ ...record });
  }
}

export interface NetworkFixture {
  root: string;
  hostUrl: string;
  hostLoopbackUrl: string;
  appUrl: string;
  relayUrl: string;
  routeId: string;
  offers: string[];
  descriptor: HostDescriptorV1;
  profile: HostProfile;
  host: HostServer;
  relay: RelayServer;
  orchestrator: SessionOrchestrator;
  adapter: DeterministicAdapter;
  relayFrames: Array<{ binary: boolean; bytes: Buffer }>;
  relayLogs: Array<{ event: string; code: string }>;
  relayMetrics: RelayMetric[];
  routeRecords: RelayRouteRecord[];
  hostRelaySockets: Set<WebSocket>;
  setDirectAvailable(available: boolean): void;
  dropRelayConnections(): void;
  revokeDevice(deviceId: string): boolean;
  createSocketFactory(origin?: string): SocketFactory;
  close(): Promise<void>;
}

export async function waitForNetwork(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const expires = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= expires) throw new Error("NETWORK_FIXTURE_TIMEOUT");
    await new Promise((fulfill) => setTimeout(fulfill, 20));
  }
}

/** Real production Host/Relay stacks; only the Provider and TLS trust anchor are fixtures. */
export async function createNetworkFixture(options: { webRoot?: string; offerCount?: number } = {}): Promise<NetworkFixture> {
  const root = await mkdtemp(join(tmpdir(), "flyx-network-e2e-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "Network fixture baseline\n");
  await runFile("git", ["init", "--quiet", workspace]);
  await runFile("git", ["-C", workspace, "add", "README.md"]);
  await runFile("git", ["-C", workspace, "-c", "user.name=Flyx fixture", "-c", "user.email=fixture@flyx.invalid", "commit", "--quiet", "-m", "Fixture baseline"]);
  await writeFile(join(workspace, "README.md"), `Network fixture baseline\n${NETWORK_DIFF_MARKER}\n`);

  const tlsProxy = await createHostProxy();
  const app = await createHostedApp(options.webRoot);
  const routeStore = new ObservedRouteStore();
  const relayLogs: NetworkFixture["relayLogs"] = [];
  const relayMetrics: RelayMetric[] = [];
  // Browser WebSocket upgrades carry the hosted app's exact Origin. Keep the
  // fixture on the same fail-closed allowlist as production Relay deployments
  // instead of relying on a broad certificate/origin bypass in Playwright.
  const relay = createRelayServer({
    tls: NETWORK_TEST_TLS,
    port: 0,
    allowedClientOrigins: [app.url],
    routeStore,
    logger: (event) => relayLogs.push(event),
    onMetric: (metric) => relayMetrics.push(metric),
  });
  const { websocketUrl: relayUrl } = await relay.listen();
  const identityDirectory = join(root, "identity");
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory });
  let orchestratorRef: SessionOrchestrator | undefined;
  const adapter = new DeterministicAdapter({
    workspace,
    onEvent: (event) => orchestratorRef?.ingestAdapterEvent(event),
    scenarios: [
      { id: "network", steps: [{ kind: "text", text: NETWORK_OUTPUT_MARKER }, { kind: "tool", toolName: "Bash", input: { command: NETWORK_TOOL_MARKER }, output: NETWORK_TOOL_MARKER }], result: NETWORK_OUTPUT_MARKER },
      { id: "network-recovery", steps: [{ kind: "text", text: "started before transport interruption" }, { kind: "delay", ms: 900 }, { kind: "text", text: NETWORK_OUTPUT_MARKER }], result: NETWORK_OUTPUT_MARKER },
    ],
  });
  const orchestrator = new SessionOrchestrator({ workspace, databasePath: join(root, "host.sqlite"), adapter });
  orchestratorRef = orchestrator;
  const hostRelaySockets = new Set<WebSocket>();
  const host = createHostServer({
    orchestrator, identity, identityDirectory, port: 0, pairingConfirmation: () => true,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    connectivity: { mode: "relay", bindHost: "127.0.0.1", port: 4173, localOrigin: "http://127.0.0.1:4173", publicBaseUrl: tlsProxy.url, requireTailscaleServe: false, allowInsecureHttp: false, relayEnabled: true, relayUrl, hostedAppUrl: app.url },
    relayOptions: { fetch: createFixtureFetch(), socketFactory: nodeRelaySocketFactory(hostRelaySockets), openTimeoutMs: 3_000, handshakeTimeoutMs: 3_000 },
  });
  const clientSockets = new Set<WebSocket>();
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    for (const socket of clientSockets) socket.terminate();
    await host.stop();
    await relay.close();
    await Promise.all([tlsProxy.close(), app.close()]);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const hostLoopbackUrl = await host.start();
    tlsProxy.setUpstream(hostLoopbackUrl);
    await waitForNetwork(() => host.relay?.state === "online");
    const routeId = host.relay!.registration!.routeId;
    const room = relay.rooms.get(routeId)!;
    const relayFrames: NetworkFixture["relayFrames"] = [];
    const receive = room.receive.bind(room);
    // Test-only tap at the Relay's real post-TLS ingress; never added to its logs or storage.
    room.receive = async (socketId, frame) => {
      if (relayFrames.length < 10_000) relayFrames.push({ binary: typeof frame !== "string", bytes: Buffer.from(frame) });
      return receive(socketId, frame);
    };
    const profile: HostProfile = { ...publicHostIdentity(identity), label: "Network fixture", endpoints: [
      { id: "direct", kind: "direct-https", source: "manual", baseUrl: tlsProxy.url, availability: "unknown" },
      { id: "relay", kind: "relay-wss", relayUrl, routeId, availability: "unknown" },
    ] };
    const descriptorResponse = await createFixtureFetch(app.url)(`${tlsProxy.url}/.well-known/flyx-host`);
    if (!descriptorResponse.ok) throw new Error("FIXTURE_DESCRIPTOR_UNAVAILABLE");
    // Use the production endpoint, signing code and Host identity rather than
    // manufacturing a lookalike descriptor in the test harness.
    const descriptor = HostDescriptorV1Schema.parse(await descriptorResponse.json());
    const offers = Array.from({ length: options.offerCount ?? 8 }, () => {
      const pairing = host.devices.createPairingGrant({ scopes: [...DEVICE_SCOPES] });
      return `${app.url}/${encodeRelayPairingFragment({ v: 1, ...publicHostIdentity(identity), relay: { url: relayUrl, routeId }, pairing: { grant: pairing.grant, expiresAt: pairing.expiresAt }, protocol: { min: 2, max: 2 } })}`;
    });
    return {
      root, hostUrl: tlsProxy.url, hostLoopbackUrl, appUrl: app.url, relayUrl, routeId, offers, descriptor, profile, host, relay, orchestrator, adapter,
      relayFrames, relayLogs, relayMetrics, routeRecords: routeStore.persisted, hostRelaySockets,
      setDirectAvailable(available) { tlsProxy.setUpstream(available ? hostLoopbackUrl : undefined); },
      dropRelayConnections() {
        for (const socket of [...hostRelaySockets, ...clientSockets]) socket.terminate();
      },
      revokeDevice(deviceId) { return host.devices.revokeFromLocal(deviceId); },
      createSocketFactory(origin = app.url) {
        return (url) => {
          const socket = new WebSocket(url, { ca: NETWORK_TEST_TLS.cert, headers: { origin }, perMessageDeflate: false, followRedirects: false });
          clientSockets.add(socket);
          socket.on("close", () => clientSockets.delete(socket));
          socket.on("error", () => undefined);
          return socket as unknown as ReturnType<SocketFactory>;
        };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const webRoot = process.env.FLYX_WEB_ROOT;
  if (!webRoot) throw new Error("FLYX_WEB_ROOT is required for the hosted-app network fixture");
  await readFile(join(webRoot, "index.html"));
  const fixture = await createNetworkFixture({ webRoot });
  console.log(`FLYX_NETWORK_E2E_READY ${JSON.stringify({ pid: process.pid, appUrl: fixture.appUrl, hostUrl: fixture.hostUrl, relayUrl: fixture.relayUrl, hostId: fixture.profile.hostId, fingerprint: fixture.profile.fingerprint, offers: fixture.offers, descriptor: fixture.descriptor })}`);
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("id" in message) || typeof message.id !== "number" || !("action" in message) || typeof message.action !== "string") return;
    const request = message as { id: number; action: string; available?: boolean; deviceId?: string };
    try {
      let value: unknown;
      if (request.action === "direct.available" && typeof request.available === "boolean") fixture.setDirectAvailable(request.available);
      else if (request.action === "relay.drop") fixture.dropRelayConnections();
      else if (request.action === "device.revoke" && typeof request.deviceId === "string") value = fixture.revokeDevice(request.deviceId);
      else throw new Error("FIXTURE_CONTROL_INVALID");
      process.send?.({ id: request.id, ok: true, value });
    } catch { process.send?.({ id: request.id, ok: false }); }
  });
  const shutdown = () => { void fixture.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("FLYX_NETWORK_E2E_FAILED"); process.exitCode = 1; });
}
