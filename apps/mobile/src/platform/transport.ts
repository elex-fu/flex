import { ClientError, connectDirectWeb, fetchDirectDescriptor, pairDirectWeb, RpcClient } from "@flyx/client-core";
import type { ClientStore, DeviceCredential, HostProfile, SocketFactory } from "@flyx/client-core";
import { generateNoiseKeyPair } from "@flyx/secure-channel";
import { encodeBase64Url } from "@flyx/mvp-protocol";

export type NativeFetchImplementation = (url: string, init: RequestInit) => Promise<Response>;
export interface NativeSocketConstructor { new(url: string, protocols?: string[], options?: { headers: Record<string, string> }): WebSocket }
/** Expo native fetch implements redirect:error and credentials:omit on both OSes.
 * Legacy RN fetch is deliberately not used for bearer requests. */
export function createNativeFetch(implementation: NativeFetchImplementation, cookie?: { origin: string; read: () => string | undefined }): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new ClientError("UNSAFE_ENDPOINT", "Native Host HTTP requests require HTTPS");
    const headers = new Headers(init.headers);
    if (headers.has("origin") && headers.get("origin") !== url.origin || headers.has("cookie")) throw new ClientError("ORIGIN_REJECTED", "Native request origin is invalid");
    headers.set("origin", url.origin);
    const temporary = cookie?.origin === url.origin ? cookie.read() : undefined;
    if (temporary) headers.set("cookie", temporary);
    const response = await implementation(url.href, { ...init, headers, credentials: "omit", redirect: "error" });
    if (response.redirected || response.url && new URL(response.url).origin !== url.origin) throw new ClientError("ORIGIN_REJECTED", "Native Host request was redirected");
    return response;
  };
}
export function createNativeSocketFactory(Socket: NativeSocketConstructor, relayClientOrigin?: string): SocketFactory {
  let relayOrigin: string | undefined;
  if (relayClientOrigin) { const parsed = new URL(relayClientOrigin); if (parsed.protocol !== "https:" || parsed.href !== parsed.origin + "/") throw new ClientError("UNSAFE_ENDPOINT", "Relay client Origin must be an exact HTTPS origin"); relayOrigin = parsed.origin; }
  return (value) => {
    const url = new URL(value);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash) throw new ClientError("UNSAFE_ENDPOINT", "Native WebSocket requires WSS");
    const hostOrigin = "https://" + url.host;
    // Direct tickets remain restricted by the Host's existing strict Origin gate.
    const origin = url.pathname === "/api/ws" ? hostOrigin : relayOrigin ?? hostOrigin;
    return new Socket(value, [], { headers: { Origin: origin } });
  };
}
export async function connectNativeDirect(profile: HostProfile, baseUrl: string, generation: number, store: ClientStore, request: typeof fetch, socketFactory: SocketFactory, signal?: AbortSignal) {
  const credential = await store.getCredential(profile.hostId);
  if (!credential) throw new ClientError("PAIRING_REQUIRED", "Pair this native device first");
  return connectDirectWeb(baseUrl, profile, generation, { fetch: request, socketFactory, preferCookie: false, deviceRefreshCredential: credential.refreshCredential }, signal);
}
/** Existing Direct bootstrap is used once, in memory, to establish device auth.
 * No cookie jar, persistent browser credential, redirect or TLS bypass is used. */
export async function pairNativeDirect(profile: HostProfile, baseUrl: string, grant: string, store: ClientStore, implementation: NativeFetchImplementation, socketFactory: SocketFactory, assertCurrent: () => void = () => {}): Promise<void> {
  assertCurrent();
  let cookie: string | undefined;
  const origin = new URL(baseUrl).origin;
  const request = createNativeFetch(async (url, init) => {
    assertCurrent(); const response = await implementation(url, init); assertCurrent();
    if (new URL(url).pathname === "/api/auth/browser-session" && response.ok) {
      const header = response.headers.get("set-cookie");
      const match = header && /^flyx_session=([A-Za-z0-9_-]{43,128});/i.exec(header);
      if (!match || !/;\s*secure(?:;|$)/i.test(header!) || !/;\s*httponly(?:;|$)/i.test(header!)) throw new ClientError("NATIVE_PAIRING_UNSUPPORTED", "Native HTTP did not expose the isolated secure bootstrap cookie");
      cookie = "flyx_session=" + match[1];
    }
    return response;
  }, { origin, read: () => cookie });
  await fetchDirectDescriptor(baseUrl, profile, { fetch: request });
  assertCurrent(); const key = await generateNoiseKeyPair();
  const rpc = new RpcClient();
  let transport: Awaited<ReturnType<typeof connectDirectWeb>> | undefined;
  try {
    await pairDirectWeb(baseUrl, grant, { fetch: request }, "Flyx native device");
    transport = await connectDirectWeb(baseUrl, profile, 1, { fetch: request, socketFactory, preferCookie: true });
    assertCurrent(); rpc.bind(transport); await rpc.hello(profile, transport.deviceId); assertCurrent();
    const response = await rpc.request<{ deviceId: string; refreshCredential: string; expiresAt: string; scopes: string[] }>("access.refresh", { proposedDevicePublicKey: encodeBase64Url(key.publicKey) }, crypto.randomUUID());
    if (typeof response.deviceId !== "string" || typeof response.refreshCredential !== "string" || typeof response.expiresAt !== "string" || !Array.isArray(response.scopes) || response.scopes.some((scope) => typeof scope !== "string")) throw new ClientError("INVALID_CREDENTIAL", "Host returned an invalid native device credential");
    const credential: DeviceCredential = { ...response, hostId: profile.hostId, storage: "short-lived-refresh" };
    assertCurrent(); await store.putProfile(profile); assertCurrent(); await store.putCredential(credential); assertCurrent(); await store.setSelectedHost(profile.hostId); assertCurrent();
  } finally { cookie = undefined; rpc.unbind(); transport?.close(1000, "NATIVE_BOOTSTRAP_COMPLETE"); key.secretKey.fill(0); }
}
