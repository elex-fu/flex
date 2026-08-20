import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { FrameSchema } from "@flyx/mvp-protocol";
import { z } from "zod";
import * as QRCode from "qrcode";
import { OrchestratorError, SessionOrchestrator } from "./session/orchestrator.js";

const SESSION_COOKIE = "flyx_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60_000;
const MAX_FRAME_BYTES = 256 * 1024;
const PAIRING_RATE_WINDOW_MS = 60_000;
const PAIRING_RATE_LIMIT = 5;

type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
  bufferedAmount?: number;
};

function closeSocket(socket: SocketLike, code: number, reason: string): void {
  if (typeof socket.close === "function") socket.close(code, reason);
  else (socket as unknown as { destroy?: () => void }).destroy?.();
}

type PendingTicket = { subject: string; expiresAt: number };
type PairingAttempt = { startedAt: number; count: number };

export type PairingConfirmation = () => boolean | Promise<boolean>;

class AuthManager {
  private pairingToken: string;
  private readonly credentials = new Map<string, number>();
  private readonly tickets = new Map<string, PendingTicket>();
  private readonly pairingAttempts = new Map<string, PairingAttempt>();

  constructor(
    private readonly orchestrator: SessionOrchestrator,
    private readonly confirmPairing: PairingConfirmation = () => false,
  ) {
    this.pairingToken = process.env.FLYX_PAIRING_TOKEN ?? randomBytes(24).toString("base64url");
    this.orchestrator.store.createPairingGrant(hash(this.pairingToken), new Date(Date.now() + 5 * 60_000).toISOString());
  }

  get pairingUrlToken(): string {
    return this.pairingToken;
  }

  /**
   * The token embedded in the pairing QR.  Grants are single-use, so once the
   * startup token has been consumed (or expired) rotate to a freshly minted
   * short-lived grant instead of encoding a dead token into a scannable URL.
   * Only the grant hash is persisted, exactly like the startup grant.
   */
  activeQrPairingToken(): string {
    if (this.orchestrator.store.hasActivePairingGrant(hash(this.pairingToken))) return this.pairingToken;
    const token = randomBytes(24).toString("base64url");
    this.orchestrator.store.createPairingGrant(hash(token), new Date(Date.now() + 5 * 60_000).toISOString());
    this.pairingToken = token;
    return token;
  }

  async exchangePairingToken(token: string, rateKey = "unknown"): Promise<string> {
    const now = Date.now();
    this.pruneEphemeral(now);
    const attempt = this.pairingAttempts.get(rateKey);
    if (!attempt || now - attempt.startedAt >= PAIRING_RATE_WINDOW_MS) {
      this.pairingAttempts.set(rateKey, { startedAt: now, count: 1 });
    } else {
      attempt.count += 1;
      if (attempt.count > PAIRING_RATE_LIMIT) {
        throw new OrchestratorError("PAIRING_RATE_LIMITED", "Too many pairing attempts; retry later", true);
      }
    }
    // Reject garbage without waking a local confirmation prompt.  The final
    // consume remains an atomic compare-and-set after the prompt, so two
    // simultaneous requests still produce at most one credential.
    const tokenHash = hash(token);
    if (!this.orchestrator.store.hasActivePairingGrant(tokenHash)) throw new OrchestratorError("PAIRING_INVALID", "Pairing token is invalid or expired");
    // Do not mint a browser credential until the person at the Host has
    // explicitly approved this pairing.  The callback is injected by main.ts
    // (which has a TTY prompt); tests and embedders can provide their own
    // deterministic policy.
    if (!(await this.confirmPairing())) {
      throw new OrchestratorError("PAIRING_DENIED", "Pairing was denied on the Host");
    }
    if (!this.orchestrator.store.consumePairingGrant(tokenHash)) throw new OrchestratorError("PAIRING_INVALID", "Pairing token is invalid or expired");
    const credential = randomBytes(32).toString("base64url");
    this.credentials.set(hash(credential), now + 60_000);
    this.pairingAttempts.delete(rateKey);
    return credential;
  }

  createBrowserSession(credential: string): string {
    this.pruneEphemeral(Date.now());
    const credentialHash = hash(credential);
    const expires = this.credentials.get(credentialHash);
    if (!expires || expires < Date.now()) throw new OrchestratorError("PAIRING_INVALID", "Pairing credential is invalid or expired");
    this.credentials.delete(credentialHash);
    const raw = randomBytes(32).toString("base64url");
    this.orchestrator.store.createAuthSession(hash(raw), new Date(Date.now() + SESSION_TTL_MS).toISOString());
    return raw;
  }

  sessionSubject(rawCookie: string | undefined): string | undefined {
    if (!rawCookie) return undefined;
    const record = this.orchestrator.store.findAuthSession(hash(rawCookie));
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) return undefined;
    this.orchestrator.store.updateLastSeen(record.id);
    return record.id;
  }

  revokeBrowserSession(rawCookie: string | undefined): boolean {
    const subject = this.sessionSubject(rawCookie);
    if (!subject) return false;
    this.orchestrator.store.revokeAuthSession(subject);
    return true;
  }

  issueTicket(subject: string): string {
    this.pruneEphemeral(Date.now());
    const raw = randomBytes(32).toString("base64url");
    this.tickets.set(hash(raw), { subject, expiresAt: Date.now() + TICKET_TTL_MS });
    return raw;
  }

  consumeTicket(rawTicket: string): string | undefined {
    this.pruneEphemeral(Date.now());
    const key = hash(rawTicket);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (!ticket || ticket.expiresAt < Date.now()) return undefined;
    return ticket.subject;
  }

  private pruneEphemeral(now: number): void {
    for (const [credential, expiresAt] of this.credentials) {
      if (expiresAt <= now) this.credentials.delete(credential);
    }
    for (const [ticket, pending] of this.tickets) {
      if (pending.expiresAt <= now) this.tickets.delete(ticket);
    }
    for (const [key, attempt] of this.pairingAttempts) {
      if (now - attempt.startedAt >= PAIRING_RATE_WINDOW_MS) this.pairingAttempts.delete(key);
    }
  }
}

const PairingExchangeSchema = z.object({ token: z.string().min(1).max(256) });
const BrowserSessionSchema = z.object({ credential: z.string().min(1).max(256) });
const StartTurnSchema = z.object({ prompt: z.string().min(1).max(16 * 1024) });
const ApprovalSchema = z.object({ approvalId: z.string().min(1).max(128), action: z.enum(["allow_once", "deny"]) });
const SubscribeSchema = z.object({ sessionId: z.string().max(128).optional(), afterSequence: z.number().int().nonnegative().default(0) });

export type HostServerOptions = {
  orchestrator: SessionOrchestrator;
  host?: string;
  port?: number;
  webRoot?: string;
  pairingConfirmation?: PairingConfirmation;
};

export type HostServer = {
  app: FastifyInstance;
  auth: AuthManager;
  start(): Promise<string>;
  stop(): Promise<void>;
};

export function createHostServer(options: HostServerOptions): HostServer {
  const app = Fastify({
    logger: { redact: ["req.url", "req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"] },
    bodyLimit: MAX_FRAME_BYTES,
    trustProxy: true,
  });
  const auth = new AuthManager(options.orchestrator, options.pairingConfirmation);
  void app.register(cookie);
  void app.register(websocket);
  // pnpm runs a filtered package script with that package as cwd, while a
  // direct monorepo invocation uses the repository root. Resolve the bundled
  // Web dist from this module first so both forms serve the same-origin UI.
  const moduleRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const webRoot = options.webRoot ?? resolve(moduleRoot, "apps/mvp-web/dist");
  const hasWebRoot = existsSync(webRoot);
  // Keep the wildcard route so a dev rebuild can add a new Vite-hashed asset
  // without requiring a Host restart.  API routes below are more specific and
  // continue to win over this static fallback.
  if (hasWebRoot) void app.register(fastifyStatic, { root: webRoot, wildcard: true });

  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
  const subject = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const id = auth.sessionSubject(request.cookies[SESSION_COOKIE]);
    if (!id) {
      noStore(reply).code(401).send({ error: { code: "UNAUTHENTICATED", message: "Pair this browser first", retryable: false } });
      return undefined;
    }
    return id;
  };

  app.get("/api/bootstrap", async (request, reply) => {
    noStore(reply);
    const paired = Boolean(auth.sessionSubject(request.cookies[SESSION_COOKIE]));
    return {
      ...options.orchestrator.bootstrap(),
      host: { instanceId: process.env.FLYX_HOST_INSTANCE_ID ?? "local", workspace: basename(options.orchestrator.workspace) },
      pairingRequired: !paired,
    };
  });

  app.post("/api/pairing/exchange", async (request, reply) => {
    noStore(reply);
    const parsed = PairingExchangeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Invalid pairing request", retryable: false } });
    try { return { credential: await auth.exchangePairingToken(parsed.data.token, request.ip) }; }
    catch (error) {
      const rpcError = toRpcError(error, "PAIRING_INVALID");
      return reply.code(rpcError.code === "PAIRING_RATE_LIMITED" ? 429 : 403).send({ error: rpcError });
    }
  });

  // Deliberately anonymous: a phone must see the pairing QR before it holds
  // any credential, exactly like the token text input on the same screen.
  // There is no global auth hook here; each protected route calls `subject()`
  // itself, so this route simply does not.
  app.get("/api/pairing/qrcode", async (request, reply) => {
    noStore(reply);
    // Build the URL from the request's own origin so it stays correct behind
    // Tailscale Serve (x-forwarded-host/proto, trusted via trustProxy).  The
    // grant rides in the query, not the fragment, because the phone opens the
    // URL directly from the camera app before any page exists to read a hash.
    const origin = expectedRequestOrigin(request) ?? `http://${request.headers.host ?? "127.0.0.1"}`;
    const pairingUrl = `${origin}/?pair=${encodeURIComponent(auth.activeQrPairingToken())}`;
    // The SVG only encodes the URL into module geometry; it never embeds local
    // paths, and QR generation failing must not block the token text fallback.
    try {
      const svg = await QRCode.toString(pairingUrl, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
      return reply.type("image/svg+xml; charset=utf-8").send(svg);
    } catch (error) {
      app.log.error({ err: error }, "QR generation failed");
      return reply.code(500).send({ error: { code: "QR_UNAVAILABLE", message: "QR code unavailable; use the token text input", retryable: true } });
    }
  });

  app.post("/api/auth/browser-session", async (request, reply) => {
    noStore(reply);
    const parsed = BrowserSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Invalid browser credential", retryable: false } });
    try {
      const raw = auth.createBrowserSession(parsed.data.credential);
      // The supported deployment is HTTPS/WSS through Tailscale Serve.  Keep
      // Secure on unless a developer explicitly opts into direct HTTP; using
      // NODE_ENV here would silently issue a downgradeable cookie in a
      // production process whose environment omitted NODE_ENV.
      const secureCookie = process.env.FLYX_ALLOW_INSECURE_HTTP !== "1";
      reply.setCookie(SESSION_COOKIE, raw, { httpOnly: true, secure: secureCookie, sameSite: "strict", path: "/", maxAge: SESSION_TTL_MS / 1000 });
      return { ok: true };
    } catch (error) { return reply.code(403).send({ error: toRpcError(error, "PAIRING_INVALID") }); }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    noStore(reply);
    auth.revokeBrowserSession(request.cookies[SESSION_COOKIE]);
    const secureCookie = process.env.FLYX_ALLOW_INSECURE_HTTP !== "1";
    reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: secureCookie, sameSite: "strict", path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/websocket-ticket", async (request, reply) => {
    noStore(reply);
    const id = subject(request, reply);
    if (!id) return;
    return { ticket: auth.issueTicket(id), expiresInMs: TICKET_TTL_MS };
  });

  app.get("/api/snapshot", async (request, reply) => {
    noStore(reply);
    if (!subject(request, reply)) return;
    return publicSnapshot(options.orchestrator.publicSnapshot(), options.orchestrator.workspace);
  });

  app.get("/api/status", async (request, reply) => {
    noStore(reply);
    if (!subject(request, reply)) return;
    const [provider, git] = await Promise.all([options.orchestrator.providerStatus(), options.orchestrator.gitStatus()]);
    return { provider: publicProviderStatus(provider, options.orchestrator.workspace), git: publicGitStatus(git, options.orchestrator.workspace), session: publicSnapshot(options.orchestrator.publicSnapshot(), options.orchestrator.workspace).session };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string; upTo?: string } }>("/api/session/:id/timeline", async (request, reply) => {
    noStore(reply);
    if (!subject(request, reply)) return;
    if (request.params.id !== options.orchestrator.sessionId) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Session does not exist", retryable: false } });
    const after = Number(request.query.after ?? 0);
    const limit = Number(request.query.limit ?? 200);
    const upTo = request.query.upTo === undefined ? undefined : Number(request.query.upTo);
    const page = options.orchestrator.timeline(Number.isFinite(after) && after >= 0 ? after : 0, Number.isFinite(limit) ? limit : 200, Number.isFinite(upTo) && (upTo as number) >= 0 ? upTo : undefined);
    return { ...page, events: page.events.map((event) => publicEvent(event, options.orchestrator.workspace)) };
  });

  app.get<{ Params: { id: string } }>("/api/session/:id/diff", async (request, reply) => {
    noStore(reply);
    if (!subject(request, reply)) return;
    if (request.params.id !== options.orchestrator.sessionId) return reply.code(404).send({ error: { code: "SESSION_NOT_FOUND", message: "Session does not exist", retryable: false } });
    return publicGitDiff(await options.orchestrator.gitDiff(), options.orchestrator.workspace);
  });

  if (!hasWebRoot) {
    app.get("/", async (_request, reply) => {
      return reply.type("text/plain").send("Flyx MVP Host is running. Build apps/mvp-web to use the mobile Web UI.");
    });
  }

  app.after(() => app.get("/api/ws", { websocket: true }, (socket, request) => {
    const ws = socket as unknown as SocketLike;
    const origin = request.headers.origin;
    const expectedOrigin = expectedRequestOrigin(request);
    // Browser WebSocket handshakes always carry Origin.  Accepting a missing
    // Origin would make this endpoint usable by non-browser cross-site
    // primitives and would violate the same-origin contract of the MVP.
    if (!origin || !expectedOrigin || !isExactOrigin(origin, expectedOrigin)) {
      closeSocket(ws, 1008, "Origin rejected");
      return;
    }
    const requestUrl = new URL(request.raw.url ?? "/", "http://flyx.local");
    const ticket = requestUrl.searchParams.get("ticket") ?? undefined;
    const ticketSubject = ticket ? auth.consumeTicket(ticket) : undefined;
    if (!ticketSubject) {
      closeSocket(ws, 1008, "Ticket invalid or expired");
      return;
    }
    let activeUnsubscribe: (() => void) | undefined;
    let catchingUp = false;
    let queued: Array<ReturnType<SessionOrchestrator["timeline"]>["events"][number]> = [];

    const send = (frame: unknown): boolean => {
      const payload = JSON.stringify(frame);
      if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) return false;
      if ((ws.bufferedAmount ?? 0) > 1024 * 1024) {
        closeSocket(ws, 1013, "RESYNC_REQUIRED");
        return false;
      }
      try { ws.send(payload); return true; } catch { return false; }
    };
    const sendEvent = (event: ReturnType<SessionOrchestrator["timeline"]>["events"][number]) => {
      if (catchingUp) queued.push(event);
      else send({ type: "event", sessionId: event.sessionId, event: publicEvent(event, options.orchestrator.workspace) });
    };

    const respond = (id: string, payload: unknown) => send({ type: "response", id, ok: true, payload });
    const fail = (id: string, error: unknown) => send({ type: "response", id, ok: false, error: toRpcError(error) });

    ws.on("message", (raw) => {
      void (async () => {
        const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
        if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) { closeSocket(ws, 1009, "Frame too large"); return; }
        let parsedJson: unknown;
        try { parsedJson = JSON.parse(text); } catch { closeSocket(ws, 1003, "Invalid JSON"); return; }
        const parsed = FrameSchema.safeParse(parsedJson);
        if (!parsed.success || parsed.data.type !== "request") { closeSocket(ws, 1003, "Invalid request frame"); return; }
        const frame = parsed.data;
        if (frame.id.length > 128 || frame.method.length > 128 || (frame.commandId !== undefined && frame.commandId.length > 128)) {
          closeSocket(ws, 1009, "Request identifiers too large");
          return;
        }
        try {
          switch (frame.method) {
            case "host.probe": {
              const [status, git] = await Promise.all([options.orchestrator.providerStatus(), options.orchestrator.gitStatus()]);
              respond(frame.id, { bootstrap: options.orchestrator.bootstrap(), status: publicProviderStatus(status, options.orchestrator.workspace), git: publicGitStatus(git, options.orchestrator.workspace) });
              return;
            }
            case "session.create":
              respond(frame.id, publicSnapshot(options.orchestrator.publicSnapshot(), options.orchestrator.workspace));
              return;
            case "session.startTurn": {
              if (!frame.commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "commandId is required");
              const payload = StartTurnSchema.parse(frame.payload);
              respond(frame.id, await options.orchestrator.startTurn(ticketSubject, frame.commandId, payload.prompt));
              return;
            }
            case "session.interrupt": {
              if (!frame.commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "commandId is required");
              respond(frame.id, await options.orchestrator.interrupt(ticketSubject, frame.commandId));
              return;
            }
            case "approval.respond": {
              if (!frame.commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "commandId is required");
              const payload = ApprovalSchema.parse(frame.payload);
              respond(frame.id, await options.orchestrator.respondApproval(ticketSubject, frame.commandId, payload.approvalId, payload.action));
              return;
            }
            case "session.subscribe": {
              const payload = SubscribeSchema.parse(frame.payload);
              if (payload.sessionId && payload.sessionId !== options.orchestrator.sessionId) throw new OrchestratorError("SESSION_NOT_FOUND", "Session does not exist");
              activeUnsubscribe?.();
              catchingUp = true;
              queued = [];
              activeUnsubscribe = options.orchestrator.subscribe(sendEvent);
              const head = options.orchestrator.snapshot().session.headSequence;
              let cursor = payload.afterSequence;
              let page = options.orchestrator.timeline(cursor, 200, head);
              while (page.events.length > 0) {
                for (const event of page.events) send({ type: "event", sessionId: event.sessionId, event: publicEvent(event, options.orchestrator.workspace) });
                cursor = page.nextAfter ?? cursor;
                if (!page.hasMore) break;
                page = options.orchestrator.timeline(cursor, 200, head);
              }
              queued.sort((a, b) => a.sequence - b.sequence);
              for (const event of queued) if (event.sequence > cursor) { send({ type: "event", sessionId: event.sessionId, event: publicEvent(event, options.orchestrator.workspace) }); cursor = event.sequence; }
              queued = [];
              catchingUp = false;
              respond(frame.id, { sessionId: options.orchestrator.sessionId, afterSequence: cursor, headSequence: options.orchestrator.snapshot().session.headSequence });
              return;
            }
            default:
              throw new OrchestratorError("METHOD_NOT_FOUND", `Unknown method ${frame.method}`);
          }
        } catch (error) { fail(frame.id, error); }
      })();
    });
    ws.on("close", () => activeUnsubscribe?.());
    ws.on("error", () => activeUnsubscribe?.());
  }));

  return {
    app,
    auth,
    async start() {
      const host = options.host ?? "127.0.0.1";
      if (!isLoopbackHost(host)) throw new OrchestratorError("HOST_BIND_FORBIDDEN", "Flyx MVP Host must bind to loopback; expose it with Tailscale Serve");
      const address = await app.listen({ host, port: options.port ?? Number(process.env.PORT ?? 4173) });
      // The token is deliberately not passed to the structured logger.  The
      // caller may display it once on a local terminal for QR generation.
      app.log.info({ address }, "Flyx MVP Host started");
      return address;
    },
    async stop() { await app.close(); options.orchestrator.close(); },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toRpcError(error: unknown, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof OrchestratorError) return { code: error.code, message: error.message, retryable: error.retryable };
  // Never send raw SDK/SQLite/OS messages to a phone: they can contain local
  // paths, command arguments, or provider details.  Structured orchestrator
  // errors above remain actionable and intentionally preserve their code.
  return { code: fallbackCode, message: "Host request failed", retryable: false };
}

type PublicProviderStatus = Awaited<ReturnType<SessionOrchestrator["providerStatus"]>>;
type PublicSnapshot = ReturnType<SessionOrchestrator["publicSnapshot"]>;
type PublicEvent = ReturnType<SessionOrchestrator["timeline"]>["events"][number];

/**
 * Provider diagnostics are useful on a phone, but an absolute local path is
 * not.  Keep the public contract stable while exposing only the configured
 * workspace name and executable basename.
 */
function publicProviderStatus(status: PublicProviderStatus, workspace: string): PublicProviderStatus {
  return {
    ...status,
    workspace: basename(workspace),
    claudeExecutable: isAbsolute(status.claudeExecutable) ? basename(status.claudeExecutable) : status.claudeExecutable,
  };
}

type PublicGitStatus = Awaited<ReturnType<SessionOrchestrator["gitStatus"]>>;
type PublicGitDiff = Awaited<ReturnType<SessionOrchestrator["gitDiff"]>>;

function publicGitStatus(status: PublicGitStatus, workspace: string): PublicGitStatus {
  const projected = publicValue(status, workspace) as PublicGitStatus;
  return projected.error ? { ...projected, error: "Git status unavailable" } : projected;
}

function publicGitDiff(diff: PublicGitDiff, workspace: string): PublicGitDiff {
  const projected = publicValue(diff, workspace) as PublicGitDiff;
  return projected.error ? { ...projected, error: "Git diff unavailable" } : projected;
}

const PATH_KEYS = new Set([
  "cwd",
  "path",
  "filePath",
  "file_path",
  "targetPath",
  "target_path",
  "workspacePath",
  "workspace_path",
  "workspace",
  "directory",
]);

/**
 * Canonical events are persisted locally with useful absolute paths for the
 * Host, but all API/WSS responses pass through this projection.  The client
 * only needs a relative path; an outside-workspace path is intentionally
 * represented by a marker rather than leaking the machine's filesystem.
 */
function publicValue(value: unknown, workspace: string, key?: string): unknown {
  if (typeof value === "string") {
    // Also redact the configured root when it appears inside provider text or
    // an error string (those values are not reliably labelled as `path`).
    const workspaceRedacted = value.split(workspace).join(".");
    if (!key || !PATH_KEYS.has(key) || !isAbsolute(value)) return workspaceRedacted;
    const rel = relative(workspace, value);
    if (!rel || rel === ".") return ".";
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "[outside workspace]";
    return rel.split(sep).join("/");
  }
  if (Array.isArray(value)) return value.map((item) => publicValue(item, workspace));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = publicValue(childValue, workspace, childKey);
    return result;
  }
  return value;
}

function publicSnapshot(snapshot: PublicSnapshot, workspace: string): PublicSnapshot {
  return publicValue(snapshot, workspace) as PublicSnapshot;
}

function publicEvent(event: PublicEvent, workspace: string): PublicEvent {
  return { ...event, payload: publicValue(event.payload, workspace) };
}

function firstForwarded(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return undefined;
  const result = first.split(",", 1)[0]?.trim();
  return result || undefined;
}

function expectedRequestOrigin(request: FastifyRequest): string | undefined {
  const protocol = firstForwarded(request.headers["x-forwarded-proto"]) ?? request.protocol;
  const host = firstForwarded(request.headers["x-forwarded-host"]) ?? firstForwarded(request.headers.host);
  if (!protocol || !host || !/^(?:http|https)$/.test(protocol) || /[\s,]/.test(host)) return undefined;
  try { return new URL(`${protocol}://${host}`).origin; } catch { return undefined; }
}

function isExactOrigin(origin: string, expectedOrigin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === expectedOrigin && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "localhost";
}
