import { computeHostFingerprint, encodeBase64Url, hostDescriptorSigningBytes } from "@flyx/mvp-protocol";
import type { HostDescriptorV1 } from "@flyx/mvp-protocol";
import { describe, expect, it } from "vitest";
import { ReplicaCache } from "./cache-store.js";
import { FlyxClient } from "./client.js";
import { ClientError } from "./common.js";
import { MemoryClientStore } from "./host-profile-store.js";
import { deferred, TestPlatformSignals } from "./platform-test-support.js";
import { TestTransport } from "./test-support.js";
import type { HostProfile, StoreWriteOperation } from "./index.js";

async function fixture(options: { beforeWrite?: (operation: StoreWriteOperation) => void; onStart?: () => boolean } = {}) {
  const host = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  if (!("publicKey" in host)) throw new Error("X25519 must generate a key pair");
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const hostPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", host.publicKey)));
  const signingPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey)));
  const fingerprint = await computeHostFingerprint(hostPublicKey, signingPublicKey);
  const endpoint = { id: "direct", kind: "direct-https", source: "tailscale", baseUrl: "https://host.example" } as const;
  const unsigned = { v: 1 as const, hostId: "host-a", hostPublicKey, signingPublicKey, fingerprint, protocol: { min: 2, max: 2 }, endpoints: [endpoint], issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "r12-descriptor-nonce" };
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, new Uint8Array(hostDescriptorSigningBytes(unsigned)))));
  const descriptor: HostDescriptorV1 = { ...unsigned, signature };
  const profile: HostProfile = { hostId: "host-a", label: "A", hostPublicKey, signingPublicKey, fingerprint, endpoints: [{ ...endpoint, availability: "available" }] };
  const store = new MemoryClientStore(options.beforeWrite ? { beforeWrite: options.beforeWrite } : {});
  await store.putProfile(profile); await store.setSelectedHost("host-a");
  const methods: string[] = [];
  const transports: TestTransport[] = [];
  const platform = new TestPlatformSignals();
  const client = new FlyxClient({ profile, store, platformSignals: platform, connectTransport: async (_endpoint, _profile, generation) => {
    const transport = new TestTransport(generation, "direct", "device-a", "direct-cookie");
    transport.respond = (frame) => {
      if (frame.type === "client.hello") { transport.emit({ type: "server.hello", hostId: "host-a", hostFingerprint: fingerprint, protocolVersion: 2, capabilities: [], leaseId: "lease-a", heartbeatIntervalMs: 15_000, maxFrameBytes: 262_144 }); return; }
      if (frame.type !== "request" || typeof frame.method !== "string") return;
      methods.push(frame.method);
      if (frame.method === "session.startTurn" && options.onStart?.() === true) return;
      const responses: Record<string, unknown> = { "host.getDescriptor": descriptor, "host.getSnapshot": { session: { id: "session-a", headSequence: 0 } }, "session.subscribe": {}, "command.getReceipt": { found: false }, "session.startTurn": { turnId: "turn-a" } };
      transport.emit({ type: "response", id: frame.id, ok: true, payload: responses[frame.method] ?? {} });
    };
    transports.push(transport); return transport;
  } });
  await client.start();
  expect(client.getState()).toMatchObject({ connection: "online", sync: "synced" });
  return { client, store, methods, transports, platform, profile };
}
const draftKey = { hostId: "host-a", sessionId: "session-a" };

describe("client lifecycle/store integration", () => {
  it("hands off a durable command and clientMessageId before the composer clears or sends", async () => {
    const ordering: string[] = [];
    const state = await fixture({ beforeWrite: (operation) => { if (operation === "draftCommand") ordering.push("durable"); }, onStart: () => { ordering.push("send"); return false; } });
    try {
      await state.store.putDraft({ ...draftKey, text: "draft", updatedAt: 1, clientMessageId: "message-a" });
      const result = await state.client.commandFromDraft("session.startTurn", { sessionId: "session-a", prompt: "draft", clientMessageId: "message-a" }, draftKey, { commandId: "command-a", draftUpdatedAt: 1, onPersisted: (command) => { ordering.push("clear"); expect(command.dispatchState).toBe("not_dispatched"); } });
      expect(result).toEqual({ turnId: "turn-a" });
      expect(ordering).toEqual(["durable", "clear", "send"]);
      expect(await state.store.getDraft(draftKey)).toBeUndefined();
      expect((await state.store.getCommand("command-a"))?.payload).toEqual({ sessionId: "session-a", prompt: "draft", clientMessageId: "message-a" });
    } finally { state.client.stop(); }
  });

  it("keeps the draft and input and sends no mutation when persistence fails", async () => {
    let fail = false;
    const state = await fixture({ beforeWrite: (operation) => { if (fail && operation === "draftCommand") throw new ClientError("STORAGE_WRITE_FAILED", "quota full"); } });
    try {
      await state.store.putDraft({ ...draftKey, text: "keep input", updatedAt: 1 });
      fail = true;
      let cleared = false;
      await expect(state.client.commandFromDraft("session.startTurn", { prompt: "keep input", clientMessageId: "message-a" }, draftKey, { commandId: "command-a", onPersisted: () => { cleared = true; } })).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
      expect(cleared).toBe(false);
      expect((await state.store.getDraft(draftKey))?.text).toBe("keep input");
      expect(await state.store.getCommand("command-a")).toBeUndefined();
      expect(state.methods).not.toContain("session.startTurn");
      expect(state.client.getState().connection).toBe("online");
    } finally { state.client.stop(); }
  });

  it("leaves healthy RPC online after a cache write failure", async () => {
    const state = await fixture({ beforeWrite: (operation) => { if (operation === "replicaCache") throw new ClientError("STORAGE_WRITE_FAILED", "quota full"); } });
    try {
      const cache = new ReplicaCache(state.store);
      expect(await cache.save(cache.select({ ...draftKey, fingerprint: state.profile.fingerprint, epoch: "epoch-a", projectorVersion: 1 }), 1, { items: ["text"] })).toBe(false);
      expect(state.client.getState().connection).toBe("online");
      expect(await state.client.request("host.getSnapshot")).toEqual({ session: { id: "session-a", headSequence: 0 } });
      expect(state.transports[0]?.closes).toEqual([]);
    } finally { state.client.stop(); }
  });

  it("forgets offline without remote revoke and fences a late unknown command result", async () => {
    const sent = deferred<void>();
    const state = await fixture({ onStart: () => { sent.resolve(); return true; } });
    await state.store.putDraft({ ...draftKey, text: "draft", updatedAt: 1 });
    const pending = state.client.commandFromDraft("session.startTurn", { prompt: "draft", clientMessageId: "message-a" }, draftKey, { commandId: "command-a" });
    const rejected = pending.catch((error: unknown) => error);
    await sent.promise;
    state.platform.online(false);
    await state.client.forgetLocalHost();
    expect(await rejected).toMatchObject({ code: "CONNECTION_REPLACED" });
    expect(state.client.getState()).toMatchObject({ connection: "closed", pairingRequired: true });
    expect(state.client.getState().profile).toBeUndefined();
    expect(await state.store.getProfile("host-a")).toBeUndefined();
    expect(await state.store.getSelectedHost()).toBeUndefined();
    expect(await state.store.listCommands("host-a")).toEqual([]);
    expect(await state.store.getDraft(draftKey)).toBeUndefined();
    expect(state.methods).not.toContain("access.revokeSelf");
    state.transports[0]!.disconnect();
    expect(state.client.getState().connection).toBe("closed");
  });

  it("rejects a cross-Session draft command before clearing or sending", async () => {
    const state = await fixture();
    try {
      await state.store.putDraft({ ...draftKey, text: "draft", updatedAt: 1 });
      await expect(state.client.commandFromDraft("session.startTurn", { sessionId: "session-b", prompt: "draft", clientMessageId: "message-a" }, draftKey)).rejects.toMatchObject({ code: "DRAFT_SESSION_MISMATCH" });
      expect((await state.store.getDraft(draftKey))?.text).toBe("draft");
      expect(state.methods).not.toContain("session.startTurn");
    } finally { state.client.stop(); }
  });

  it("keeps an adopted runtime bound to its registry Host", async () => {
    const state = await fixture();
    try {
      state.client.bindHostOwner("host-a");
      await expect(state.client.selectHost("host-b")).rejects.toMatchObject({ code: "HOST_RUNTIME_BOUND" });
      expect(state.client.getState().profile?.hostId).toBe("host-a");
      expect(state.client.getState().connection).toBe("online");
    } finally { state.client.stop(); }
  });

  it("forgets an initializing owner without a late profile read restoring it", async () => {
    const reading = deferred<void>();
    const profileRead = deferred<HostProfile | undefined>();
    class SlowStore extends MemoryClientStore {
      override getProfile(): Promise<HostProfile | undefined> { reading.resolve(); return profileRead.promise; }
    }
    const store = new SlowStore();
    const profile: HostProfile = { hostId: "host-a", label: "A", fingerprint: "pin", hostPublicKey: "host", signingPublicKey: "sign", endpoints: [] };
    await store.putProfile(profile); await store.setSelectedHost("host-a");
    const client = new FlyxClient({ store, hostId: "host-a" });
    const started = client.start();
    await reading.promise;
    await client.forgetLocalHost("host-a");
    profileRead.resolve(profile);
    await started;
    expect(client.getState()).toMatchObject({ connection: "closed", pairingRequired: true });
    expect(client.getState().profile).toBeUndefined();
    expect(await store.listProfiles()).toEqual([]);
    expect(await store.getSelectedHost()).toBeUndefined();
  });

  it("keeps remote revocation a separate authenticated mutation", async () => {
    const state = await fixture();
    try {
      await state.client.revokeRemoteDevice("device-b");
      expect(state.methods).toContain("access.revokeDevice");
      expect(await state.store.getProfile("host-a")).toBeDefined();
      expect(state.client.getState().connection).toBe("online");
    } finally { state.client.stop(); }
  });
});
