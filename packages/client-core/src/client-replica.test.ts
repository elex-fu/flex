import { BOUNDED_CONTENT_CAPABILITY, computeHostFingerprint, encodeBase64Url, hostDescriptorSigningBytes, TIMELINE_PROJECTION_CAPABILITY } from "@flyx/mvp-protocol";
import type { HostDescriptorV1, OpenViewResponse, ProjectedItem, TimelinePage } from "@flyx/mvp-protocol";
import { describe, expect, it } from "vitest";
import { ACCESS_RECEIPTS_CAPABILITY } from "./rpc-client.js";
import { FlyxClient } from "./client.js";
import { MemoryClientStore } from "./host-profile-store.js";
import { TestTransport } from "./test-support.js";
import type { HostProfile } from "./types.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function identity(): Promise<{ descriptor: HostDescriptorV1; profile: HostProfile }> {
  const host = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair; const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const hostPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", host.publicKey))); const signingPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey))); const fingerprint = await computeHostFingerprint(hostPublicKey, signingPublicKey);
  const endpoint = { id: "direct", kind: "direct-https", source: "tailscale", baseUrl: "https://host.example" } as const;
  const unsigned = { v: 1 as const, hostId: "host-a", hostPublicKey, signingPublicKey, fingerprint, protocol: { min: 2, max: 2 }, endpoints: [endpoint], issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "descriptor-nonce-0001" };
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, new Uint8Array(hostDescriptorSigningBytes(unsigned)))));
  return { descriptor: { ...unsigned, signature }, profile: { hostId: unsigned.hostId, label: "Host", hostPublicKey, signingPublicKey, fingerprint, endpoints: [{ ...endpoint, availability: "unknown" }] } };
}
const item = (revision: number, text: string): ProjectedItem => ({ sessionId: "session-a", itemId: "reply", kind: "assistant_message", status: "completed", displaySequence: 2, revision, content: { inline: { text, turnId: "turn-a" } }, updatedAt: "now" });
const snapshot = (headSequence: number) => ({ session: { id: "session-a", provider: "claude", headSequence, activityState: "running" }, activeTurn: { id: "turn-a", status: "running", prompt: "task" }, pendingApprovals: [] });
function view(): OpenViewResponse { return { sessionId: "session-a", subscriptionId: "subscription-a", mode: "cold", projectorVersion: 1, watermark: { epoch: "epoch-a", sequence: 4 }, page: { epoch: "epoch-a", projectorVersion: 1, upToSequence: 4, items: [item(4, "Hello")], nextCursor: { epoch: "epoch-a", sequence: 4 }, hasOlder: false, hasNewer: false, boundaryComplete: true }, snapshot: snapshot(4), interactions: { total: 0, directoryRevision: 4, complete: true, items: [] }, catchUpComplete: true }; }
async function fixture(options: { fail?: boolean; openGate?: Promise<void>; opened?: () => void; sessionId?: string; setupStore?: (store: MemoryClientStore, profile: HostProfile) => Promise<void>; store?: MemoryClientStore; accessReceipts?: boolean; respond?: (frame: Record<string, unknown>, reply: (payload: unknown) => void) => boolean } = {}) {
  const { descriptor, profile } = await identity(); const store = options.store ?? new MemoryClientStore(); await store.putProfile(profile); await store.setSelectedHost(profile.hostId);
  await options.setupStore?.(store, profile);
  const methods: string[] = []; let transport!: TestTransport; let connections = 0; let fail = options.fail ?? false;
  const client = new FlyxClient({ profile, store, ...(options.sessionId ? { sessionId: options.sessionId } : {}), connectTransport: async (_endpoint, _profile, generation) => {
    connections++; transport = new TestTransport(generation, "direct", "device-a", "direct-cookie");
    transport.respond = (frame) => {
      if (frame.type === "client.hello") { transport.emit({ type: "server.hello", hostId: descriptor.hostId, hostFingerprint: descriptor.fingerprint, protocolVersion: 2, capabilities: [TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY, ...(options.accessReceipts ? [ACCESS_RECEIPTS_CAPABILITY] : [])], leaseId: "lease", heartbeatIntervalMs: 15_000, maxFrameBytes: 262_144 }); return; }
      if (frame.type !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
      methods.push(frame.method);
      const reply = (payload: unknown) => transport.emit({ type: "response", id: frame.id, ok: true, payload });
      if (options.respond?.(frame, reply)) return;
      if (frame.method === "host.getDescriptor") reply(descriptor);
      else if (frame.method === "host.getSnapshot") reply(snapshot(4));
      else if (frame.method === "session.openView") {
        options.opened?.();
        if (fail) transport.emit({ type: "response", id: frame.id, ok: false, error: { code: "TIMELINE_UNAVAILABLE", message: "Projection unavailable", retryable: true } });
        else if (options.openGate) void options.openGate.then(() => reply(view()));
        else reply(view());
      } else reply({});
    };
    return transport;
  } });
  return { client, methods, store, profile, get transport() { return transport; }, get connections() { return connections; }, setFailure: (value: boolean) => { fail = value; } };
}

describe("FlyxClient canonical replica activation", () => {
  it("saves negotiation, uses one canonical subscription and does not apply raw events to canonical items", async () => {
    const test = await fixture(); let rawEvents = 0; test.client.onEvent(() => rawEvents++);
    try {
      await test.client.start(); expect(test.client.getState()).toMatchObject({ connection: "online", sync: "synced" });
      expect(test.client.getNegotiatedHello()?.capabilities).toContain(TIMELINE_PROJECTION_CAPABILITY); expect(test.methods.filter((method) => method === "session.openView")).toHaveLength(1);
      expect(test.methods).not.toContain("session.subscribe"); expect(test.methods).not.toContain("timeline.subscribe"); expect(test.methods).not.toContain("session.getEvents");
      test.transport.emit({ type: "event", sessionId: "session-a", event: { id: "raw", sessionId: "session-a", sequence: 5, type: "assistant.message.delta", payload: { itemId: "reply", text: "duplicate raw" }, occurredAt: "now" } });
      const applied = deferred(); const off = test.client.onReplica((state) => { if (state.sourceCursor?.sequence === 5) applied.resolve(); });
      const page: TimelinePage = { epoch: "epoch-a", projectorVersion: 1, upToSequence: 5, coveredSourceRange: { fromExclusive: 4, through: 5 }, nextCursor: { epoch: "epoch-a", sequence: 5 }, items: [item(5, "Hello world")], hasOlder: false, hasNewer: false, boundaryComplete: true };
      const update = { id: "live", sessionId: "session-a", sequence: 5, type: "timeline.updated", payload: { ...page, subscriptionId: "subscription-a", snapshot: snapshot(5), snapshotSequence: 5, interactions: { total: 0, directoryRevision: 5, complete: true, items: [] } }, occurredAt: "now" };
      test.transport.emit({ type: "event", sessionId: "session-a", event: update }); test.transport.emit({ type: "event", sessionId: "session-a", event: update });
      await applied.promise; off(); expect(test.client.replica.getState().items).toHaveLength(1); expect(test.client.replica.getState().items[0]?.content).toEqual({ inline: { text: "Hello world", turnId: "turn-a" } }); expect(rawEvents).toBe(0);
    } finally { test.client.stop(); }
  });
  it("retains a healthy lease after domain sync failure and retries domain work without reconnecting", async () => {
    const test = await fixture({ fail: true });
    try {
      await test.client.start(); expect(test.client.getState()).toMatchObject({ connection: "online", sync: "resync_required" }); expect(test.connections).toBe(1); expect(test.transport.closes).toEqual([]);
      test.setFailure(false); await test.client.retrySynchronization(); expect(test.client.getState()).toMatchObject({ connection: "online", sync: "synced" }); expect(test.connections).toBe(1); expect(test.transport.closes).toEqual([]);
    } finally { test.client.stop(); }
  });
  it("publishes secure online state while the replica is still waiting for its domain view", async () => {
    const gate = deferred(); const opened = deferred(); const online = deferred(); const test = await fixture({ openGate: gate.promise, opened: opened.resolve });
    test.client.onState((state) => { if (state.connection === "online") online.resolve(); });
    const starting = test.client.start();
    try { await online.promise; await opened.promise; expect(test.client.getState()).toMatchObject({ connection: "online", sync: "catching_up" }); gate.resolve(); await starting; expect(test.client.getState().sync).toBe("synced"); }
    finally { gate.resolve(); await starting; test.client.stop(); }
  });
  it("displays cache as stale, then saves only canonical items/coverage while interactions come from authority", async () => {
    const test = await fixture({ setupStore: async (store, profile) => {
      const value = { epoch: "epoch-a", projectorVersion: 1, sourceCursor: { epoch: "epoch-a", sequence: 3 }, items: [item(3, "cached prefix")], loadedWindow: { hasOlder: true }, snapshot: { session: { activityState: "idle" } }, interactions: { items: ["cached approval"] } };
      await store.putReplicaCache({ hostId: profile.hostId, fingerprint: profile.fingerprint, sessionId: "session-a", epoch: "epoch-a", projectorVersion: 1, revision: 3, value, cachedAt: Date.now(), expiresAt: Date.now() + 60_000, byteLength: 512 });
    } });
    let staleShown = false; test.client.onReplica((state) => { if (state.items[0] && "inline" in state.items[0].content && (state.items[0].content.inline as { text?: string }).text === "cached prefix" && state.stale) { staleShown = true; expect(state.interactionsAuthoritative).toBe(false); expect(state.snapshot).toBeUndefined(); } });
    try {
      await test.client.start(); expect(staleShown).toBe(true); expect(test.client.replica.getState().items[0]?.content).toEqual({ inline: { text: "Hello", turnId: "turn-a" } });
      const stored = await test.store.getReplicaCache({ hostId: test.profile.hostId, fingerprint: test.profile.fingerprint, sessionId: "session-a", epoch: "epoch-a", projectorVersion: 1 });
      expect(stored?.revision).toBe(4); expect(stored?.value).not.toHaveProperty("snapshot"); expect(stored?.value).not.toHaveProperty("interactions");
    } finally { test.client.stop(); }
  });
  it("keeps cache storage failures separate from secure connection and replica readiness", async () => {
    class FailedCacheStore extends MemoryClientStore { override async listReplicaCaches(): Promise<never> { throw new Error("cache unavailable"); } }
    const test = await fixture({ store: new FailedCacheStore() });
    try { await test.client.start(); expect(test.client.getState()).toMatchObject({ connection: "online", sync: "synced" }); expect(test.client.getCacheError()?.code).toBe("CACHE_UNAVAILABLE"); expect(test.connections).toBe(1); expect(test.transport.closes).toEqual([]); }
    finally { test.client.stop(); }
  });

  it("queries accepted receipts on authoritative Turn changes without querying on body deltas or replaying mutations", async () => {
    let terminal = false;
    const test = await fixture({ respond: (frame, reply) => {
      if (frame.method === "session.startTurn") { reply({ status: "accepted", turnId: "turn-a" }); return true; }
      if (frame.method === "command.getReceipt") { reply({ found: true, commandId: "start-a", method: "session.startTurn", state: terminal ? "completed" : "accepted", response: { turnId: "turn-a" } }); return true; }
      return false;
    } });
    try {
      await test.client.start(); await test.client.command("session.startTurn", { prompt: "task" }, "start-a");
      await expect.poll(() => test.methods.filter((method) => method === "command.getReceipt").length).toBe(1);
      const apply = async (sequence: number, complete: boolean) => {
        const changed = deferred(); const off = test.client.onReplica((state) => { if (state.sourceCursor?.sequence === sequence) changed.resolve(); });
        const nextSnapshot = snapshot(sequence); if (complete) { nextSnapshot.activeTurn.status = "completed"; nextSnapshot.session.activityState = "idle"; }
        const page: TimelinePage = { epoch: "epoch-a", projectorVersion: 1, upToSequence: sequence, coveredSourceRange: { fromExclusive: sequence - 1, through: sequence }, nextCursor: { epoch: "epoch-a", sequence }, items: [item(sequence, "more text")], hasOlder: false, hasNewer: false, boundaryComplete: true };
        test.transport.emit({ type: "event", sessionId: "session-a", event: { id: `live-${sequence}`, sessionId: "session-a", sequence, type: "timeline.updated", payload: { ...page, subscriptionId: "subscription-a", snapshot: nextSnapshot, snapshotSequence: sequence, interactions: { total: 0, directoryRevision: sequence, complete: true, items: [] } }, occurredAt: "now" } });
        await changed.promise; off();
      };
      await apply(5, false); expect(test.methods.filter((method) => method === "command.getReceipt")).toHaveLength(1);
      terminal = true; await apply(6, true);
      await expect.poll(async () => (await test.store.getCommand("start-a"))?.state).toBe("terminal");
      expect(test.methods.filter((method) => method === "command.getReceipt")).toHaveLength(2); expect(test.methods.filter((method) => method === "session.startTurn")).toHaveLength(1);
    } finally { test.client.stop(); }
  });
  it("queries an accepted Interaction response when its authoritative pending directory resolves", async () => {
    let terminal = false;
    const test = await fixture({ respond: (frame, reply) => {
      if (frame.method === "approval.respond") { reply({ status: "accepted" }); return true; }
      if (frame.method === "command.getReceipt") { reply({ found: true, commandId: "response-a", method: "approval.respond", state: terminal ? "completed" : "accepted", response: { status: terminal ? "delivered" : "accepted" } }); return true; }
      return false;
    } });
    try {
      await test.client.start();
      const directory = async (sequence: number, items: unknown[]) => {
        const changed = deferred(); const off = test.client.onReplica((state) => { if (state.sourceCursor?.sequence === sequence) changed.resolve(); });
        test.transport.emit({ type: "event", sessionId: "session-a", event: { id: `directory-${sequence}`, sessionId: "session-a", sequence, type: "timeline.updated", payload: { epoch: "epoch-a", projectorVersion: 1, upToSequence: sequence, coveredSourceRange: { fromExclusive: sequence - 1, through: sequence }, nextCursor: { epoch: "epoch-a", sequence }, items: [], hasOlder: false, hasNewer: false, boundaryComplete: true, subscriptionId: "subscription-a", snapshot: snapshot(sequence), snapshotSequence: sequence, interactions: { total: items.length, directoryRevision: sequence, complete: true, items } }, occurredAt: "now" } });
        await changed.promise; off();
      };
      await directory(5, [{ approvalId: "approval-a", status: "pending", version: 1 }]);
      await test.client.command("approval.respond", { approvalId: "approval-a", action: "allow_once" }, "response-a");
      await expect.poll(() => test.methods.filter((method) => method === "command.getReceipt").length).toBe(1);
      terminal = true; await directory(6, []);
      await expect.poll(async () => (await test.store.getCommand("response-a"))?.state).toBe("terminal");
      expect(test.methods.filter((method) => method === "command.getReceipt")).toHaveLength(2); expect(test.methods.filter((method) => method === "approval.respond")).toHaveLength(1);
    } finally { test.client.stop(); }
  });
  it("supports explicit receipt review while domain synchronization is unavailable", async () => {
    const test = await fixture({ fail: true, setupStore: async (store, profile) => {
      await store.putCommand({ commandId: "old-a", hostId: profile.hostId, method: "approval.respond", payloadHash: "hash", payload: { approvalId: "approval-a" }, state: "accepted", dispatchState: "possibly_dispatched", createdAt: "now" });
    }, respond: (frame, reply) => { if (frame.method !== "command.getReceipt") return false; reply({ found: true, commandId: "old-a", method: "approval.respond", state: "completed", response: { status: "delivered" } }); return true; } });
    try { await test.client.start(); expect(test.client.getState()).toMatchObject({ connection: "online", sync: "resync_required" }); expect(await test.client.queryCommandReceipt("old-a")).toMatchObject({ state: "terminal", result: { status: "delivered" } }); expect(test.methods).not.toContain("approval.respond"); expect(test.connections).toBe(1); }
    finally { test.client.stop(); }
  });
  it("selects the negotiated actor-scoped access receipt method without repeating an access mutation", async () => {
    let terminal = false;
    const test = await fixture({ accessReceipts: true, respond: (frame, reply) => {
      if (frame.method === "access.revokeDevice") { reply({ revoked: true }); return true; }
      if (frame.method === "access.getReceipt") { reply({ found: true, commandId: "revoke-a", method: "access.revokeDevice", state: terminal ? "completed" : "accepted", response: { revoked: true } }); return true; }
      return false;
    } });
    try { await test.client.start(); await test.client.command("access.revokeDevice", { deviceId: "other-device" }, "revoke-a"); await expect.poll(() => test.methods.filter((method) => method === "access.getReceipt").length).toBe(1); terminal = true; expect(await test.client.queryCommandReceipt("revoke-a")).toMatchObject({ state: "terminal" }); expect(test.methods).not.toContain("command.getReceipt"); expect(test.methods.filter((method) => method === "access.revokeDevice")).toHaveLength(1); }
    finally { test.client.stop(); }
  });
});
