import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbClientStore } from "./host-profile-store.js";
import type { HostProfile } from "./types.js";

describe("IndexedDB durable state", () => {
  it("reopens pinned multipath profiles, expiring credential, and unknown outbox receipt", async () => {
    const factory = new IDBFactory();
    const initial = new IndexedDbClientStore("restart", factory);
    const profile: HostProfile = { hostId: "host-a", label: "My Host", hostPublicKey: "x25519", signingPublicKey: "ed25519", fingerprint: "sha256:pinned", preferredEndpointId: "relay", endpoints: [
      { id: "direct", kind: "direct-https", baseUrl: "https://host.example", source: "tailscale", availability: "unavailable" },
      { id: "relay", kind: "relay-wss", relayUrl: "wss://relay.example", routeId: "opaque", availability: "available" },
    ] };
    await initial.putProfile(profile);
    await initial.setSelectedHost(profile.hostId);
    await initial.putCredential({ hostId: profile.hostId, deviceId: "device-a", refreshCredential: "bounded-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: ["session:read"], storage: "short-lived-refresh" });
    await initial.putCommand({ commandId: "command-a", hostId: profile.hostId, method: "session.startTurn", payloadHash: "hash", payload: { prompt: "one" }, createdAt: new Date().toISOString(), state: "receipt_unknown" });
    await initial.close();
    const resumed = new IndexedDbClientStore("restart", factory);
    expect(await resumed.getSelectedHost()).toBe(profile.hostId);
    expect(await resumed.getProfile(profile.hostId)).toEqual(profile);
    expect((await resumed.getCredential(profile.hostId))?.refreshCredential).toBe("bounded-token");
    expect((await resumed.listCommands(profile.hostId))[0]?.state).toBe("receipt_unknown");
    const database = await new Promise<IDBDatabase>((resolve) => { const request = factory.open("restart"); request.onsuccess = () => resolve(request.result); });
    expect([...database.objectStoreNames]).toEqual(["commands", "contentMetadata", "credentials", "drafts", "meta", "profiles", "replicaCache"]);
    database.close();
    await resumed.close();
  });

  it("rejects unbounded browser secrets instead of silently persisting long-lived keys", async () => {
    const store = new IndexedDbClientStore("bounded", new IDBFactory());
    await expect(store.putCredential({ hostId: "host-a", deviceId: "device-a", refreshCredential: "token", expiresAt: new Date(Date.now() + 48 * 60 * 60_000).toISOString(), scopes: [], storage: "short-lived-refresh" })).rejects.toMatchObject({ code: "INVALID_CREDENTIAL_LIFETIME" });
    expect(await store.getCredential("host-a")).toBeUndefined();
    await store.close();
  });
});
