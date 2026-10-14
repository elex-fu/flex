import { describe, expect, it } from "vitest";
import { createNativeFetch, createNativeSocketFactory, pairNativeDirect } from "./transport";
import { MemoryClientStore } from "@flyx/client-core";
import { computeHostFingerprint, encodeBase64Url, hostDescriptorSigningBytes } from "@flyx/mvp-protocol";
import type { HostDescriptorV1 } from "@flyx/mvp-protocol";
import type { HostProfile } from "@flyx/client-core";
import type { NativeSocketConstructor } from "./transport";
describe("native transport guards", () => {
  it("uses exact Origin, isolated cookies and no redirects for native HTTP", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = createNativeFetch(async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); });
    await fetch("https://host.example/api/auth/device-ticket", { method: "POST", body: "opaque", credentials: "include", redirect: "follow" });
    expect(calls[0]?.init.credentials).toBe("omit"); expect(calls[0]?.init.redirect).toBe("error"); expect(new Headers(calls[0]?.init.headers).get("origin")).toBe("https://host.example");
    await expect(fetch("http://host.example/api/auth/device-ticket")).rejects.toMatchObject({ code: "UNSAFE_ENDPOINT" });
    await expect(fetch("https://host.example/api/auth/device-ticket", { headers: { Origin: "https://other.example" } })).rejects.toMatchObject({ code: "ORIGIN_REJECTED" }); expect(calls).toHaveLength(1);
  });
  it("rejects an implementation redirect and fences a pairing result after local forget", async () => {
    const response = new Response(""); Object.defineProperty(response, "redirected", { value: true });
    await expect(createNativeFetch(async () => response)("https://host.example/api/auth/device-ticket")).rejects.toMatchObject({ code: "ORIGIN_REJECTED" });
    let reads = 0, cancelled = false; const store = new MemoryClientStore();
    await expect(pairNativeDirect({ hostId: "host-a", label: "A", hostPublicKey: "pin", signingPublicKey: "pin", fingerprint: "pin", endpoints: [] }, "https://host.example", "opaque", store, async () => { reads++; await store.forgetLocalHost("host-a"); cancelled = true; return new Response("{}"); }, () => { throw new Error("must not connect"); }, () => { if (cancelled) throw new Error("pair cancelled"); })).rejects.toThrow("pair cancelled");
    expect(reads).toBe(1); expect(await store.listProfiles()).toEqual([]);
  });
  it("sets RN custom Origin for WSS and rejects insecure sockets", () => {
    const calls: { url: string; origin: string }[] = [];
    class Socket { constructor(url: string, _protocols: string[], options: { headers: { Origin: string } }) { calls.push({ url, origin: options.headers.Origin }); } }
    const factory = createNativeSocketFactory(Socket as unknown as NativeSocketConstructor, "https://app.example");
    factory("wss://host.example/api/ws?ticket=one-use"); factory("wss://relay.example/data?role=client");
    expect(calls.map((value) => value.origin)).toEqual(["https://host.example", "https://app.example"]); expect(() => factory("ws://host.example/api/ws")).toThrow(/WSS/);
  });
});

async function identity() {
  const host = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair, signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const hostPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", host.publicKey))), signingPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey)));
  const fingerprint = await computeHostFingerprint(hostPublicKey, signingPublicKey);
  const endpoint = { id: "direct", kind: "direct-https", source: "manual", baseUrl: "https://host.example" } as const;
  const unsigned = { v: 1 as const, hostId: "host-a", hostPublicKey, signingPublicKey, fingerprint, protocol: { min: 2, max: 2 }, endpoints: [endpoint], issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "native-descriptor-nonce" };
  const descriptor: HostDescriptorV1 = { ...unsigned, signature: encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, new Uint8Array(hostDescriptorSigningBytes(unsigned))))) };
  const profile: HostProfile = { ...unsigned, label: "Host A", endpoints: [{ ...endpoint, availability: "unknown" }] };
  return { descriptor, profile };
}
async function bootstrapFixture(wrongHello = false, exposeCookie = true) {
  const { descriptor, profile } = await identity(); const store = new MemoryClientStore(); const http: { path: string; cookie: string | null; init: RequestInit }[] = [], rpc: string[] = []; let closes = 0;
  const implementation = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname; http.push({ path, init, cookie: new Headers(init.headers).get("cookie") });
    if (path === "/.well-known/flyx-host") return Response.json(descriptor);
    if (path === "/api/pairing/exchange") return Response.json({ credential: "b".repeat(43) });
    if (path === "/api/auth/browser-session") return new Response("{}", { headers: exposeCookie ? { "set-cookie": "flyx_session=" + "c".repeat(43) + "; Path=/; HttpOnly; Secure; SameSite=Strict" } : {} });
    if (path === "/api/auth/websocket-ticket") return Response.json({ ticket: "single-use", deviceId: "device-a" });
    throw new Error("unexpected native HTTP path");
  };
  class Socket extends EventTarget {
    readyState = 0; bufferedAmount = 0; binaryType = "arraybuffer";
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send(text: string) {
      const frame = JSON.parse(text) as { type: string; id: string; method: string; transportGeneration: number };
      const response = frame.type === "client.hello" ? { type: "server.hello", hostId: "host-a", hostFingerprint: wrongHello ? "sha256:" + "a".repeat(64) : profile.fingerprint, protocolVersion: 2, capabilities: [], leaseId: "lease-a", heartbeatIntervalMs: 15_000, maxFrameBytes: 262_144 }
        : { type: "response", id: frame.id, ok: true, payload: { deviceId: "device-a", refreshCredential: "r".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: ["host:read", "session:read", "session:write", "approval:write", "access:self"] } };
      if (frame.type === "request") rpc.push(frame.method);
      queueMicrotask(() => { const event = new Event("message"); Object.defineProperty(event, "data", { value: JSON.stringify({ ...response, transportGeneration: frame.transportGeneration }) }); this.dispatchEvent(event); });
    }
    close() { closes++; this.readyState = 3; }
  }
  return { profile, store, http, rpc, closes: () => closes, pair: () => pairNativeDirect(profile, "https://host.example", "g".repeat(43), store, implementation, () => new Socket() as unknown as WebSocket) };
}
describe("native Direct pinned bootstrap", () => {
  it("converts one isolated secure cookie into a bounded device credential", async () => {
    const f = await bootstrapFixture(); await f.pair();
    expect(f.rpc).toEqual(["access.refresh"]); expect((await f.store.getCredential("host-a"))?.storage).toBe("short-lived-refresh"); expect(f.closes()).toBe(1);
    expect(f.http.every((request) => request.init.credentials === "omit" && request.init.redirect === "error")).toBe(true);
    expect(f.http.find((request) => request.path === "/api/auth/websocket-ticket")?.cookie).toBe("flyx_session=" + "c".repeat(43));
    expect(f.http.filter((request) => request.path === "/api/pairing/exchange" || request.path === "/api/auth/browser-session").every((request) => request.cookie === null)).toBe(true);
  });
  it("fails closed if native HTTP hides the isolated bootstrap cookie", async () => {
    const f = await bootstrapFixture(false, false); await expect(f.pair()).rejects.toMatchObject({ code: "NATIVE_PAIRING_UNSUPPORTED" }); expect(await f.store.listProfiles()).toEqual([]); expect(f.rpc).toEqual([]);
  });
  it("never stores a device credential after a mismatched authenticated hello", async () => {
    const f = await bootstrapFixture(true); await expect(f.pair()).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" }); expect(await f.store.getCredential("host-a")).toBeUndefined(); expect(f.rpc).toEqual([]); expect(f.closes()).toBe(1);
  });
});
