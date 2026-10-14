import { verifyHostDescriptor } from "@flyx/mvp-protocol";
import type { HostDescriptorV1 } from "@flyx/mvp-protocol";
import { assertNotAborted, ClientError, isRecord, validateDirectUrl } from "../common.js";
import type { ClientTransport, HostProfile } from "../types.js";
import { openWebSocket, WebSocketApplicationTransport } from "./websocket.js";
import type { SocketFactory } from "./websocket.js";

export interface DirectWebOptions {
  allowInsecureLoopback?: boolean;
  fetch?: typeof fetch;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
  /** Sent only over a pinned HTTPS connection, never in a URL or browser log. */
  deviceRefreshCredential?: string;
  /** Prefer the HttpOnly browser session at an exact same-origin endpoint.
   * If that session has expired, a supplied device credential is the fallback. */
  preferCookie?: boolean;
}

export async function directJson<T>(baseUrl: string, path: string, options: DirectWebOptions, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const url = validateDirectUrl(baseUrl, options.allowInsecureLoopback);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 10_000);
  try {
    assertNotAborted(signal);
    const response = await (options.fetch ?? fetch)(new URL(path, url), { ...init, credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
      const remoteCode = typeof error?.code === "string" ? error.code : undefined;
      // An expired cookie or rotating Hosted App credential is an
      // authentication failure, not proof that a saved Host pairing is bad.
      const code = response.status === 401 ? "AUTHENTICATION_REQUIRED" : remoteCode ?? "HTTP_FAILED";
      throw new ClientError(code, typeof error?.message === "string" ? error.message : `Host returned HTTP ${response.status}`);
    }
    return body as T;
  } catch (error) {
    if (signal?.aborted) throw new ClientError("CONNECTION_REPLACED", "Connection was replaced");
    if (controller.signal.aborted) throw new ClientError("SOCKET_OPEN_TIMEOUT", "Host request timed out");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function fetchDirectDescriptor(baseUrl: string, pin: Pick<HostProfile, "hostId" | "hostPublicKey" | "signingPublicKey"> | undefined, options: DirectWebOptions = {}, signal?: AbortSignal): Promise<HostDescriptorV1> {
  const descriptor = await directJson<HostDescriptorV1>(baseUrl, "/.well-known/flyx-host", options, {}, signal);
  // With no existing pin, TLS on the explicitly selected pairing origin is the
  // initial trust anchor. Subsequent endpoints always require both saved keys.
  const expected = pin ?? { hostId: descriptor.hostId, hostPublicKey: descriptor.hostPublicKey, signingPublicKey: descriptor.signingPublicKey };
  try { return await verifyHostDescriptor(descriptor, expected, options.allowInsecureLoopback ? { allowLoopbackHttp: true } : {}); }
  catch { throw new ClientError("IDENTITY_MISMATCH", "Host descriptor does not match the pinned identity"); }
}

export async function connectDirectWeb(baseUrl: string, profile: HostProfile, generation: number, options: DirectWebOptions = {}, signal?: AbortSignal): Promise<ClientTransport> {
  await fetchDirectDescriptor(baseUrl, profile, options, signal);
  type Ticket = { ticket: string; deviceId?: string };
  const cookieTicket = () => directJson<Ticket>(baseUrl, "/api/auth/websocket-ticket", options, { method: "POST" }, signal);
  const deviceTicket = () => directJson<Ticket>(baseUrl, "/api/auth/device-ticket", options, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshCredential: options.deviceRefreshCredential }) }, signal);
  let authentication: "direct-cookie" | "direct-device-ticket";
  let ticket: Ticket;
  if (options.preferCookie) {
    try { ticket = await cookieTicket(); authentication = "direct-cookie"; }
    catch (error) {
      if (!(error instanceof ClientError) || error.code !== "AUTHENTICATION_REQUIRED" || !options.deviceRefreshCredential) throw error;
      ticket = await deviceTicket(); authentication = "direct-device-ticket";
    }
  } else if (options.deviceRefreshCredential) {
    ticket = await deviceTicket(); authentication = "direct-device-ticket";
  } else {
    ticket = await cookieTicket(); authentication = "direct-cookie";
  }
  if (!ticket.ticket) throw new ClientError("PAIRING_REQUIRED", "Pair this browser with the Host first");
  const url = new URL("/api/ws", validateDirectUrl(baseUrl, options.allowInsecureLoopback));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket.ticket);
  const socket = await openWebSocket(url.toString(), { ...(signal ? { signal } : {}), ...(options.socketFactory ? { factory: options.socketFactory } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  assertNotAborted(signal);
  return new WebSocketApplicationTransport(socket, generation, "direct", ticket.deviceId, 262_144, authentication);
}

export async function pairDirectWeb(baseUrl: string, grant: string, options: DirectWebOptions = {}, deviceName?: string): Promise<void> {
  const exchanged = await directJson<{ credential: string }>(baseUrl, "/api/pairing/exchange", options, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: grant, ...(deviceName ? { deviceName } : {}) }) });
  await directJson(baseUrl, "/api/auth/browser-session", options, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: exchanged.credential }) });
}
