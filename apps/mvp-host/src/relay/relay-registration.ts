import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface RelayRegistration {
  v: 1;
  relayUrl: string;
  routeId: string;
  relayCredential: string;
  createdAt: string;
  generation: number;
}

export interface RelayRegistrationOptions {
  relayUrl: string;
  registrationPath: string;
  registrationToken?: string;
  allowInsecureLoopback?: boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export class RelayRegistrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RelayRegistrationError";
  }
}

/** Credentials never enter a URL, redirect, error body, or diagnostic string. */
export function normalizeRelayUrl(input: string, allowInsecureLoopback = false): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new RelayRegistrationError("RELAY_URL_INVALID"); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "wss:" && !(allowInsecureLoopback && loopback && url.protocol === "ws:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new RelayRegistrationError("RELAY_URL_INVALID");
  }
  return url.origin;
}

function isSecret(value: unknown, minimumBytes: number): value is string {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= minimumBytes && decoded.length <= 128 && decoded.toString("base64url") === value;
}

function parseRegistration(value: unknown, relayUrl: string): RelayRegistration {
  if (!value || typeof value !== "object") throw new RelayRegistrationError("RELAY_REGISTRATION_INVALID");
  const file = value as Record<string, unknown>;
  if (file.v !== 1 || file.relayUrl !== relayUrl || !isSecret(file.routeId, 24)
    || !isSecret(file.relayCredential, 32) || typeof file.createdAt !== "string"
    || !Number.isFinite(Date.parse(file.createdAt)) || !Number.isSafeInteger(file.generation)
    || (file.generation as number) < 0) {
    throw new RelayRegistrationError(file.relayUrl !== relayUrl ? "RELAY_REGISTRATION_URL_MISMATCH" : "RELAY_REGISTRATION_INVALID");
  }
  return file as unknown as RelayRegistration;
}

export async function readRelayRegistration(path: string, relayUrl: string): Promise<RelayRegistration | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RelayRegistrationError("RELAY_REGISTRATION_UNREADABLE");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new RelayRegistrationError("RELAY_REGISTRATION_PERMISSIONS");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await file.readFile("utf8")); }
    catch { throw new RelayRegistrationError("RELAY_REGISTRATION_INVALID"); }
    return parseRegistration(parsed, relayUrl);
  } finally { await file.close(); }
}

/** Atomic replacement preserves the credential through crashes and power loss. */
export async function persistRelayRegistration(path: string, registration: RelayRegistration): Promise<void> {
  const destination = resolve(path);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Refuse unsafe existing secrets instead of silently repairing their permissions.
  await readRelayRegistration(destination, registration.relayUrl);
  const temporaryPath = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  let renamed = false;
  try {
    await file.writeFile(`${JSON.stringify(registration)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporaryPath, destination);
    renamed = true;
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await file.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function limitedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new RelayRegistrationError("RELAY_REGISTRATION_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 64 * 1024) throw new RelayRegistrationError("RELAY_REGISTRATION_RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RelayRegistrationError) throw error;
    throw new RelayRegistrationError("RELAY_REGISTRATION_RESPONSE_INVALID");
  } finally { reader.releaseLock(); }
}

// Repeated starts and shutdown/start races in one Host must not allocate competing routes.
const pendingFiles = new Map<string, Promise<void>>();
async function serializeFile<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = pendingFiles.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  pendingFiles.set(key, pending);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (pendingFiles.get(key) === pending) pendingFiles.delete(key);
  }
}

export function loadOrRegisterRelayRoute(options: RelayRegistrationOptions): Promise<RelayRegistration> {
  return serializeFile(options.registrationPath, () => registerRoute(options));
}

async function registerRoute(options: RelayRegistrationOptions): Promise<RelayRegistration> {
  const relayUrl = normalizeRelayUrl(options.relayUrl, options.allowInsecureLoopback);
  const existing = await readRelayRegistration(options.registrationPath, relayUrl);
  if (existing) return existing;
  const url = new URL("/v1/routes", relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(options.registrationToken ? { authorization: `Bearer ${options.registrationToken}` } : {}) },
      body: JSON.stringify({ v: 1 }),
    });
  } catch { throw new RelayRegistrationError("RELAY_REGISTRATION_UNREACHABLE"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RelayRegistrationError(response.status === 401 || response.status === 403 ? "RELAY_REGISTRATION_DENIED" : "RELAY_REGISTRATION_FAILED");
  }
  const reply = await limitedJson(response);
  if (!reply || typeof reply !== "object" || (reply as Record<string, unknown>).v !== 1
    || !isSecret((reply as Record<string, unknown>).routeId, 24)
    || !isSecret((reply as Record<string, unknown>).relayCredential, 32)) {
    throw new RelayRegistrationError("RELAY_REGISTRATION_RESPONSE_INVALID");
  }
  const registration: RelayRegistration = {
    v: 1, relayUrl, routeId: (reply as { routeId: string }).routeId,
    relayCredential: (reply as { relayCredential: string }).relayCredential,
    createdAt: new Date().toISOString(), generation: 0,
  };
  await persistRelayRegistration(options.registrationPath, registration);
  return registration;
}

export function reserveRelayGeneration(path: string, registration: RelayRegistration, now = Date.now()): Promise<RelayRegistration> {
  return serializeFile(path, () => reserveGeneration(path, registration, now));
}

async function reserveGeneration(path: string, registration: RelayRegistration, now: number): Promise<RelayRegistration> {
  const latest = await readRelayRegistration(path, registration.relayUrl);
  if (!latest || latest.routeId !== registration.routeId || latest.relayCredential !== registration.relayCredential) {
    throw new RelayRegistrationError("RELAY_REGISTRATION_CHANGED");
  }
  const generation = Math.max(latest.generation + 1, Math.floor(now), 1);
  if (!Number.isSafeInteger(generation)) throw new RelayRegistrationError("RELAY_GENERATION_EXHAUSTED");
  const next = { ...latest, generation };
  await persistRelayRegistration(path, next);
  return next;
}
