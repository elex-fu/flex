import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { encodeDirectPairingFragment, encodeRelayPairingFragment, type AdvertisedEndpoint } from "@flyx/mvp-protocol";
import { z } from "zod";
import * as QRCode from "qrcode";
import { OrchestratorError, SessionOrchestrator } from "./session/orchestrator.js";
import { DeviceRegistry } from "./auth/device-registry.js";
import { assertMethodScope } from "./auth/connection-authorizer.js";
import { createHostDescriptor, generateHostIdentity, getHostIdentityMirror, loadOrCreateHostIdentity, publicHostIdentity, type HostIdentityFileV1 } from "./identity/host-identity.js";
import { ConnectionGateway, type DuplexTransport } from "./api/connection-gateway.js";
import { publicEvent, publicGitDiff, publicGitStatus, publicProviderStatus, publicSnapshot, toRpcError } from "./api/public-projection.js";
import { parseConnectivityConfig, type ConnectivityConfig } from "./connectivity/config.js";
import { HostRelaySupervisor, type HostRelaySupervisorOptions } from "./relay/relay-supervisor.js";

const SESSION_COOKIE = "flyx_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60_000;
const MAX_FRAME_BYTES = 256 * 1024;
type PendingTicket = { subject?: string; deviceId: string; credentialRevision?: number; expiresAt: number };
type PairingAttempt = { startedAt: number; count: number };
export type PairingConfirmation = () => boolean | Promise<boolean>;

class AuthManager {
  private pairingToken: string;
  private pairingExpiresAt: string;
  private readonly credentials = new Map<string, { expiresAt: number; deviceId: string }>();
  private readonly tickets = new Map<string, PendingTicket>();
  private readonly pairingAttempts = new Map<string, PairingAttempt>();

  constructor(private readonly orchestrator: SessionOrchestrator, private readonly devices: () => DeviceRegistry, private readonly confirmPairing: PairingConfirmation = () => false) {
    this.pairingToken = process.env.FLYX_PAIRING_TOKEN ?? randomBytes(32).toString("base64url");
    this.pairingExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.orchestrator.store.createPairingGrant(hash(this.pairingToken), this.pairingExpiresAt);
  }

  get pairingUrlToken(): string { return this.pairingToken; }
  get expiresAt(): string { return this.pairingExpiresAt; }

  activeQrPairingToken(): string {
    if (this.orchestrator.store.hasActivePairingGrant(hash(this.pairingToken))) return this.pairingToken;
    this.pairingToken = randomBytes(32).toString("base64url");
    this.pairingExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.orchestrator.store.createPairingGrant(hash(this.pairingToken), this.pairingExpiresAt);
    return this.pairingToken;
  }

  async exchangePairingToken(token: string, rateKey = "unknown"): Promise<string> {
    const now = Date.now();
    this.pruneEphemeral(now);
    for (const [key, limit] of [[`ip:${rateKey}`, 5], [`grant:${hash(token)}`, 5], ["global", 30]] as const) {
      const attempt = this.pairingAttempts.get(key);
      if (!attempt) {
        if (this.pairingAttempts.size >= 4096) throw new OrchestratorError("PAIRING_RATE_LIMITED", "Too many pairing attempts", true);
        this.pairingAttempts.set(key, { startedAt: now, count: 1 });
      } else if (++attempt.count > limit) throw new OrchestratorError("PAIRING_RATE_LIMITED", "Too many pairing attempts; retry later", true);
    }
    const tokenHash = hash(token);
    if (!this.orchestrator.store.hasActivePairingGrant(tokenHash)) throw new OrchestratorError("PAIRING_INVALID", "Pairing token is invalid or expired");
    if (!(await this.confirmPairing())) throw new OrchestratorError("PAIRING_DENIED", "Pairing was denied on the Host");
    const device = this.orchestrator.store.db.transaction(() => {
      if (!this.orchestrator.store.consumePairingGrant(tokenHash)) throw new OrchestratorError("PAIRING_INVALID", "Pairing token is invalid or expired");
      return this.devices().createBrowserDevice({ pairingGrant: token });
    })();
    const credential = randomBytes(32).toString("base64url");
    this.credentials.set(hash(credential), { deviceId: device.id, expiresAt: Date.now() + 60_000 });
    return credential;
  }

  createBrowserSession(credential: string): string {
    this.pruneEphemeral(Date.now());
    const key = hash(credential);
    const pending = this.credentials.get(key);
    this.credentials.delete(key);
    if (!pending || pending.expiresAt <= Date.now()) throw new OrchestratorError("PAIRING_INVALID", "Pairing credential is invalid or expired");
    const raw = randomBytes(32).toString("base64url");
    this.orchestrator.store.db.transaction(() => {
      this.orchestrator.store.createAuthSession(hash(raw), new Date(Date.now() + SESSION_TTL_MS).toISOString());
      const session = this.orchestrator.store.findAuthSession(hash(raw))!;
      this.devices().bindAuthSession(session.id, pending.deviceId);
    })();
    return raw;
  }

  sessionSubject(rawCookie: string | undefined): string | undefined {
    if (!rawCookie) return undefined;
    const record = this.orchestrator.store.findAuthSession(hash(rawCookie));
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) return undefined;
    try { this.devices().ensureBrowserSessionDevice(record.id); } catch { return undefined; }
    this.orchestrator.store.updateLastSeen(record.id);
    return record.id;
  }

  revokeBrowserSession(rawCookie: string | undefined): boolean {
    const subject = this.sessionSubject(rawCookie);
    if (!subject) return false;
    const device = this.devices().getDeviceForAuthSession(subject);
    this.devices().revokeAuthSession(subject);
    if (device) this.devices().revokeSelf(device.id);
    for (const [key, ticket] of this.tickets) if (ticket.subject === subject) this.tickets.delete(key);
    return true;
  }

  issueTicket(subject: string): string {
    this.pruneEphemeral(Date.now());
    const device = this.devices().getDeviceForAuthSession(subject);
    if (!device) throw new OrchestratorError("UNAUTHENTICATED", "Pair this browser first");
    const raw = randomBytes(32).toString("base64url");
    this.tickets.set(hash(raw), { subject, deviceId: device.id, expiresAt: Date.now() + TICKET_TTL_MS });
    return raw;
  }

  issueDeviceTicket(refreshCredential: string): { ticket: string; deviceId: string; expiresInMs: number } {
    this.pruneEphemeral(Date.now());
    const device = this.devices().authenticateRefreshCredential(refreshCredential);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(hash(ticket), { deviceId: device.id, credentialRevision: device.credentialRevision, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket, deviceId: device.id, expiresInMs: TICKET_TTL_MS };
  }

  consumeTicket(rawTicket: string): PendingTicket | undefined {
    this.pruneEphemeral(Date.now());
    const key = hash(rawTicket);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (!ticket || ticket.expiresAt <= Date.now()) return undefined;
    const device = ticket.subject ? this.devices().getDeviceForAuthSession(ticket.subject) : this.devices().getDevice(ticket.deviceId);
    if (!device || device.revokedAt || (device.expiresAt && Date.parse(device.expiresAt) <= Date.now())) return undefined;
    if (ticket.credentialRevision !== undefined) {
      try { this.devices().assertCredentialRevision(device.id, ticket.credentialRevision); }
      catch { return undefined; }
    }
    return ticket;
  }

  private pruneEphemeral(now: number): void {
    for (const [key, credential] of this.credentials) if (credential.expiresAt <= now) this.credentials.delete(key);
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(key);
    for (const [key, attempt] of this.pairingAttempts) if (now - attempt.startedAt >= 60_000) this.pairingAttempts.delete(key);
  }
}

export type HostServerOptions = {
  orchestrator: SessionOrchestrator;
  host?: string;
  port?: number;
  webRoot?: string;
  pairingConfirmation?: PairingConfirmation;
  connectivity?: ConnectivityConfig;
  identity?: HostIdentityFileV1;
  identityDirectory?: string;
  /** Dependency injection for embedders/custom trust stores; production defaults remain strict TLS. */
  relayOptions?: Pick<HostRelaySupervisorOptions,
    "fetch" | "socketFactory" | "openTimeoutMs" | "handshakeTimeoutMs" | "heartbeatIntervalMs" | "livenessTimeoutMs"
    | "allowInsecureLoopback" | "now" | "random" | "maxDataConnections">;
};

export type HostServer = {
  app: FastifyInstance;
  auth: AuthManager;
  readonly identity: HostIdentityFileV1;
  readonly devices: DeviceRegistry;
  readonly relay: HostRelaySupervisor | undefined;
  getPairingUrl(): string;
  getRelayPairingUrl(appUrl?: string): string | undefined;
  start(): Promise<string>;
  stop(): Promise<void>;
};

export function createHostServer(options: HostServerOptions): HostServer {
  const connectivity = options.connectivity ?? parseConnectivityConfig();
  const app = Fastify({
    logger: { redact: ["req.url", "req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']", "req.headers['x-forwarded-for']"] },
    bodyLimit: MAX_FRAME_BYTES,
    trustProxy: (address, hop) => hop === 0 && isLoopbackHost(address),
  });
  let identity = options.identity;
  let devices: DeviceRegistry;
  let gateway: ConnectionGateway;
  let relay: HostRelaySupervisor | undefined;
  let identityPoll: ReturnType<typeof setInterval> | undefined;
  let localOrigin = `http://127.0.0.1:${options.port ?? connectivity.port}`;
  const identityDirectory = options.identityDirectory ?? process.env.FLYX_IDENTITY_DIR ?? resolve(dirname(options.orchestrator.store.db.name), "identity");
  const auth = new AuthManager(options.orchestrator, () => devices, options.pairingConfirmation);
  const assertIdentity = () => {
    const mirror = options.orchestrator.store.getHostIdentityMirror();
    if (!identity || mirror?.hostId !== identity.hostId || mirror.fingerprint !== identity.fingerprint) {
      throw new OrchestratorError("IDENTITY_MISMATCH", "Host identity changed; restart and pair again");
    }
  };
  const endpoints = (): AdvertisedEndpoint[] => {
    const candidates: AdvertisedEndpoint[] = [];
    if (connectivity.publicBaseUrl) candidates.push({ id: "tailscale", kind: "direct-https", source: "tailscale", baseUrl: connectivity.publicBaseUrl });
    // Loopback is descriptive only and never eligible for automatic remote failover.
    else if (connectivity.allowInsecureHttp) candidates.push({ id: "local", kind: "direct-https", source: "manual", baseUrl: localOrigin });
    const registration = relay?.registration;
    if (registration) candidates.push({ id: "relay", kind: "relay-wss", relayUrl: registration.relayUrl, routeId: registration.routeId });
    return candidates;
  };
  const descriptor = () => { assertIdentity(); return createHostDescriptor(identity!, { protocol: { min: 1, max: 2 }, endpoints: endpoints() }); };
  const bootstrap = (pairingRequired = false) => ({ ...options.orchestrator.bootstrap(), host: { instanceId: identity!.hostId, workspace: basename(options.orchestrator.workspace), ...publicHostIdentity(identity!) }, pairingRequired });
  const getPairingUrl = () => {
    assertIdentity();
    const grant = auth.activeQrPairingToken();
    const origin = connectivity.publicBaseUrl ?? localOrigin;
    return `${origin}/${encodeDirectPairingFragment({ v: 1, ...publicHostIdentity(identity!), endpoint: origin, grant, expiresAt: auth.expiresAt })}`;
  };
  const getRelayPairingUrl = (appUrl = connectivity.hostedAppUrl) => {
    const registration = relay?.registration;
    if (!registration || !appUrl) return undefined;
    assertIdentity();
    const grant = auth.activeQrPairingToken();
    return `${appUrl}/${encodeRelayPairingFragment({ v: 1, ...publicHostIdentity(identity!), relay: { url: registration.relayUrl, routeId: registration.routeId }, pairing: { grant, expiresAt: auth.expiresAt }, protocol: { min: 2, max: 2 } })}`;
  };

  void app.register(cookie);
  void app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false } });
  const moduleRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const webRoot = options.webRoot ?? resolve(moduleRoot, "apps/mvp-web/dist");
  const hasWebRoot = existsSync(webRoot);
  if (hasWebRoot) void app.register(fastifyStatic, { root: webRoot, wildcard: true });
  app.addHook("onReady", async () => {
    const store = options.orchestrator.store;
    identity ??= store.db.name === ":memory:" ? generateHostIdentity() : await loadOrCreateHostIdentity({ directory: identityDirectory, expectedMirror: store.getHostIdentityMirror() ?? null });
    const mirror = store.getHostIdentityMirror();
    if (mirror && (mirror.hostId !== identity.hostId || mirror.fingerprint !== identity.fingerprint)) throw new OrchestratorError("IDENTITY_MISMATCH", "Host identity does not match database");
    store.setHostIdentityMirror(getHostIdentityMirror(identity));
    devices = new DeviceRegistry(store, identity.hostId);
    gateway = new ConnectionGateway({ hostId: identity.hostId, fingerprint: identity.fingerprint, orchestrator: options.orchestrator, devices, bootstrap, descriptor, assertIdentity, confirmPairing: options.pairingConfirmation ?? (() => false) });
    if (connectivity.relayEnabled && connectivity.relayUrl) {
      relay = new HostRelaySupervisor({
        ...options.relayOptions,
        relayUrl: connectivity.relayUrl,
        registrationPath: resolve(identityDirectory, "relay-registration.json"),
        hostId: identity.hostId,
        hostStaticKey: Buffer.from(identity.x25519SecretKey, "base64url"),
        protocol: { min: 2, max: 2 },
        ...(connectivity.relayRegistrationToken ? { registrationToken: connectivity.relayRegistrationToken } : {}),
        onConnection: (connection) => { assertIdentity(); gateway.attach(connection.transport, connection.remotePublicKey ? { remotePublicKey: connection.remotePublicKey } : {}); },
        onState: (state, reason) => app.log.info({ state, reason }, "Relay connection state"),
      });
    }
    identityPoll = setInterval(() => { try { assertIdentity(); } catch { gateway.close(1008, "IDENTITY_MISMATCH"); void relay?.stop(); } }, 1000);
    identityPoll.unref?.();
  });
  app.addHook("onClose", async () => {
    clearInterval(identityPoll);
    gateway?.close();
    await relay?.stop();
    devices?.close();
  });
  app.addHook("onRequest", async (request, reply) => {
    const requestOrigin = validatedRequestOrigin(request, connectivity.publicBaseUrl);
    if (!requestOrigin) return reply.code(403).send({ error: { code: "HOST_REJECTED", message: "Host header rejected", retryable: false } });
    const pathname = new URL(request.raw.url ?? "/", "http://flyx.local").pathname;
    const hosted = request.headers.origin && connectivity.hostedAppUrl && isExactOrigin(request.headers.origin, connectivity.hostedAppUrl);
    const hostedRoute = ["/.well-known/flyx-host", "/api/auth/device-ticket", "/api/ws"].includes(pathname);
    if (request.headers.origin && !isAllowedDirectOrigin(request.headers.origin, requestOrigin, localOrigin, connectivity.publicBaseUrl)
      && !(hosted && hostedRoute)) return reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "Origin rejected", retryable: false } });
    if (hosted && hostedRoute) {
      reply.header("access-control-allow-origin", connectivity.hostedAppUrl!).header("access-control-allow-credentials", "true").header("vary", "Origin").header("access-control-allow-methods", "GET, POST, OPTIONS").header("access-control-allow-headers", "Content-Type").header("access-control-max-age", "600");
      if (request.method === "OPTIONS") return reply.code(204).send();
    }
    try { assertIdentity(); } catch (error) { return reply.code(503).send({ error: toRpcError(error) }); }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff").header("x-frame-options", "DENY");
    reply.header("content-security-policy", `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https: wss:${connectivity.allowInsecureHttp ? " ws:" : ""}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'`);
    return payload;
  });

  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
  const subject = (request: FastifyRequest, reply: FastifyReply, method = "host.bootstrap") => {
    const id = auth.sessionSubject(request.cookies[SESSION_COOKIE]);
    const device = id ? devices.getDeviceForAuthSession(id) : undefined;
    if (!id || !device) { noStore(reply).code(401).send({ error: { code: "UNAUTHENTICATED", message: "Pair this browser first", retryable: false } }); return undefined; }
    try { assertMethodScope({ scopes: new Set(device.scopes) }, method); }
    catch { noStore(reply).code(403).send({ error: { code: "FORBIDDEN", message: "Device permission denied", retryable: false } }); return undefined; }
    return id;
  };
  app.get("/.well-known/flyx-host", async (_request, reply) => { noStore(reply); return descriptor(); });
  app.get("/api/bootstrap", async (request, reply) => { noStore(reply); return bootstrap(!auth.sessionSubject(request.cookies[SESSION_COOKIE])); });
  app.post("/api/pairing/exchange", async (request, reply) => {
    noStore(reply);
    const parsed = z.object({ token: z.string().min(1).max(256) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Invalid pairing request", retryable: false } });
    try { return { credential: await auth.exchangePairingToken(parsed.data.token, request.ip) }; }
    catch (error) { const rpcError = toRpcError(error, "PAIRING_INVALID"); return reply.code(rpcError.code === "PAIRING_RATE_LIMITED" ? 429 : 403).send({ error: rpcError }); }
  });
  app.get("/api/pairing/qrcode", async (request, reply) => {
    noStore(reply);
    const host = new URL(`http://${request.headers.host ?? "invalid"}`).hostname;
    const local = isLoopbackHost(host) && isLoopbackHost(request.raw.socket.remoteAddress ?? "")
      && !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((header) => request.headers[header]);
    if (!local && !subject(request, reply, "access.listDevices")) return;
    try { return reply.type("image/svg+xml; charset=utf-8").send(await QRCode.toString(getRelayPairingUrl() ?? getPairingUrl(), { type: "svg", errorCorrectionLevel: "M", margin: 1 })); }
    catch { return reply.code(500).send({ error: { code: "QR_UNAVAILABLE", message: "QR code unavailable; use the token text input", retryable: true } }); }
  });
  app.post("/api/auth/browser-session", async (request, reply) => {
    noStore(reply);
    const parsed = z.object({ credential: z.string().min(1).max(256) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Invalid browser credential", retryable: false } });
    try {
      const raw = auth.createBrowserSession(parsed.data.credential);
      reply.setCookie(SESSION_COOKIE, raw, { httpOnly: true, secure: !connectivity.allowInsecureHttp, sameSite: "strict", path: "/", maxAge: SESSION_TTL_MS / 1000 });
      const id = auth.sessionSubject(raw)!;
      return { ok: true, deviceId: devices.getDeviceForAuthSession(id)!.id };
    } catch (error) { return reply.code(403).send({ error: toRpcError(error, "PAIRING_INVALID") }); }
  });
  app.post("/api/auth/logout", async (request, reply) => {
    noStore(reply); auth.revokeBrowserSession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: !connectivity.allowInsecureHttp, sameSite: "strict", path: "/" }); return { ok: true };
  });
  app.post("/api/auth/websocket-ticket", async (request, reply) => {
    noStore(reply); const id = subject(request, reply); if (!id) return;
    return { ticket: auth.issueTicket(id), expiresInMs: TICKET_TTL_MS, deviceId: devices.getDeviceForAuthSession(id)!.id };
  });
  app.options("/api/auth/device-ticket", async (_request, reply) => reply.code(204).send());
  app.post("/api/auth/device-ticket", async (request, reply) => {
    noStore(reply);
    const parsed = z.object({ refreshCredential: z.string().min(43).max(128) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Invalid device credential", retryable: false } });
    try { return auth.issueDeviceTicket(parsed.data.refreshCredential); }
    catch { return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Device credential expired or revoked", retryable: false } }); }
  });
  app.get("/api/snapshot", async (request, reply) => {
    noStore(reply); if (!subject(request, reply, "host.getSnapshot")) return; return publicSnapshot(options.orchestrator.publicSnapshot(), options.orchestrator.workspace);
  });
  app.get("/api/status", async (request, reply) => {
    noStore(reply); if (!subject(request, reply, "host.getStatus")) return;
    const [provider, git] = await Promise.all([options.orchestrator.providerStatus(), options.orchestrator.gitStatus()]);
    return { provider: publicProviderStatus(provider, options.orchestrator.workspace), git: publicGitStatus(git, options.orchestrator.workspace), session: publicSnapshot(options.orchestrator.publicSnapshot(), options.orchestrator.workspace).session };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string; upTo?: string } }>("/api/session/:id/timeline", async (request, reply) => {
    noStore(reply); if (!subject(request, reply, "session.getEvents")) return;
    if (request.params.id !== options.orchestrator.sessionId) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Session does not exist", retryable: false } });
    const after = Number(request.query.after ?? 0), limit = Number(request.query.limit ?? 200), upTo = request.query.upTo === undefined ? undefined : Number(request.query.upTo);
    const page = options.orchestrator.timeline(Number.isFinite(after) && after >= 0 ? after : 0, Number.isFinite(limit) ? limit : 200, Number.isFinite(upTo) && (upTo as number) >= 0 ? upTo : undefined);
    return { ...page, events: page.events.map((event) => publicEvent(event, options.orchestrator.workspace)) };
  });
  app.get<{ Params: { id: string } }>("/api/session/:id/diff", async (request, reply) => {
    noStore(reply); if (!subject(request, reply, "session.getDiff")) return;
    if (request.params.id !== options.orchestrator.sessionId) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Session does not exist", retryable: false } });
    return publicGitDiff(await options.orchestrator.gitDiff(), options.orchestrator.workspace);
  });
  if (!hasWebRoot) app.get("/", async (_request, reply) => reply.type("text/plain").send("Flyx Host is running. Build apps/mvp-web to use the mobile Web UI."));
  app.after(() => app.get("/api/ws", { websocket: true }, (socket, request) => {
    const requestOrigin = validatedRequestOrigin(request, connectivity.publicBaseUrl);
    const allowedOrigin = request.headers.origin && requestOrigin
      && (isAllowedDirectOrigin(request.headers.origin, requestOrigin, localOrigin, connectivity.publicBaseUrl)
        || Boolean(connectivity.hostedAppUrl && isExactOrigin(request.headers.origin, connectivity.hostedAppUrl)));
    if (!allowedOrigin) { socket.close(1008, "ORIGIN_REJECTED"); return; }
    const ticket = new URL(request.raw.url ?? "/", "http://flyx.local").searchParams.get("ticket");
    const principal = ticket ? auth.consumeTicket(ticket) : undefined;
    if (!principal) { socket.close(1008, "TICKET_INVALID"); return; }
    const transport: DuplexTransport = {
      id: randomUUID(), kind: "direct", generation: 0,
      send(frame) {
        return new Promise((fulfill, reject) => {
          if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "RESYNC_REQUIRED"); reject(new Error("Backpressure")); return; }
          socket.send(frame, (error) => error ? reject(error) : fulfill());
        });
      },
      close: (code, reason) => socket.close(code, reason),
      onMessage(handler) { const listener = (data: Buffer, binary: boolean) => handler(binary ? new Uint8Array(data) : data.toString("utf8")); socket.on("message", listener); return () => socket.off("message", listener); },
      onClose(handler) { const listener = (code: number, reason: Buffer) => handler({ code, reason: reason.toString("utf8") }); socket.on("close", listener); return () => socket.off("close", listener); },
    };
    // ws treats an unhandled error event as process-fatal. Converge transport
    // failures through the normal close/lease cleanup path without logging the
    // underlying network error or request URL.
    socket.on("error", () => {
      try { socket.close(1011, "SOCKET_FAILED"); }
      catch { socket.terminate(); }
    });
    gateway.attach(transport, {
      deviceId: principal.deviceId,
      ...(principal.subject ? { authSessionId: principal.subject } : {}),
      assertCurrent: () => {
        if (principal.credentialRevision !== undefined) devices.assertCredentialRevision(principal.deviceId, principal.credentialRevision);
      },
    });
  }));

  let stopPromise: Promise<void> | undefined;
  options.orchestrator.registerTransportShutdown(() => app.close());
  return {
    app, auth,
    get identity() { if (!identity) throw new Error("Host is not ready"); return identity; },
    get devices() { return devices; },
    get relay() { return relay; },
    getPairingUrl, getRelayPairingUrl,
    async start() {
      const host = options.host ?? "127.0.0.1";
      if (!isLoopbackHost(host)) throw new OrchestratorError("HOST_BIND_FORBIDDEN", "Flyx Host must bind to loopback; expose it with Tailscale Serve");
      const address = await app.listen({ host, port: options.port ?? connectivity.port });
      localOrigin = address;
      try { await relay?.start(); } catch { app.log.error({ code: "RELAY_START_FAILED" }, "Relay registration unavailable; local Host remains running"); }
      app.log.info({ address }, "Flyx Host started");
      return address;
    },
    stop() {
      stopPromise ??= options.orchestrator.closeAndWait().then((result) => {
        if (!result.clean) throw new OrchestratorError("SHUTDOWN_RECOVERY_REQUIRED", "Host stopped with retained unverified execution ownership");
      });
      return stopPromise;
    },
  };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validatedRequestOrigin(request: FastifyRequest, publicBaseUrl: string | undefined): string | undefined {
  const host = request.headers.host;
  if (!host || /[\s,\\/@?#]/.test(host)) return undefined;
  try {
    const local = new URL(`http://${host}`);
    if (publicBaseUrl) {
      const publicOrigin = new URL(publicBaseUrl);
      const publicAuthority = new URL(`${publicOrigin.protocol}//${host}`);
      if (publicAuthority.host === publicOrigin.host) return publicOrigin.origin;
    }
    if (!isLoopbackHost(local.hostname)) return undefined;
    // Forwarded host never selects an authority; only configured origins or a literal loopback Host do.
    const encrypted = "encrypted" in request.raw.socket && request.raw.socket.encrypted === true;
    return new URL(`${encrypted ? "https:" : "http:"}//${host}`).origin;
  } catch { return undefined; }
}
function isAllowedDirectOrigin(value: string, requestOrigin: string, localOrigin: string, publicBaseUrl: string | undefined): boolean {
  return isExactOrigin(value, requestOrigin)
    || isExactOrigin(value, localOrigin)
    || Boolean(publicBaseUrl && isExactOrigin(value, publicBaseUrl));
}
function isExactOrigin(value: string, expected: string): boolean {
  try { const parsed = new URL(value); return parsed.origin === expected && parsed.href === `${parsed.origin}/` && !parsed.username && !parsed.password; } catch { return false; }
}
function isLoopbackHost(host: string): boolean { return ["127.0.0.1", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"].includes(host.toLowerCase()); }
