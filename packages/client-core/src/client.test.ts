import {
  computeHostFingerprint,
  encodeBase64Url,
  hostDescriptorSigningBytes,
  type HostDescriptorV1,
} from "@flyx/mvp-protocol";
import { describe, expect, it } from "vitest";
import { FlyxClient } from "./client.js";
import { MemoryClientStore } from "./host-profile-store.js";
import { TestTransport } from "./test-support.js";
import type { HostProfile, TransportAuthentication } from "./types.js";

async function identity(): Promise<{ descriptor: HostDescriptorV1; profile: HostProfile }> {
  const host = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const hostPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", host.publicKey)));
  const signingPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey)));
  const fingerprint = await computeHostFingerprint(hostPublicKey, signingPublicKey);
  const endpoint = { id: "direct", kind: "direct-https", source: "tailscale", baseUrl: "https://host.example" } as const;
  const unsigned = {
    v: 1 as const,
    hostId: "host-a",
    hostPublicKey,
    signingPublicKey,
    fingerprint,
    protocol: { min: 2, max: 2 },
    endpoints: [endpoint],
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "descriptor-nonce-0001",
  };
  const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, hostDescriptorSigningBytes(unsigned))));
  return {
    descriptor: { ...unsigned, signature },
    profile: { hostId: unsigned.hostId, label: "Test Host", hostPublicKey, signingPublicKey, fingerprint, endpoints: [{ ...endpoint, availability: "unknown" }] },
  };
}

function serve(transport: TestTransport, descriptor: HostDescriptorV1, methods: string[], rotate = false): void {
  transport.respond = (frame) => {
    if (frame.type === "client.hello") {
      transport.emit({ type: "server.hello", hostId: descriptor.hostId, hostFingerprint: descriptor.fingerprint, protocolVersion: 2, capabilities: [], leaseId: "lease", heartbeatIntervalMs: 15_000, maxFrameBytes: 262_144 });
      return;
    }
    if (frame.type !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
    methods.push(frame.method);
    const responses: Record<string, unknown> = {
      "access.refresh": { deviceId: "device-a", refreshCredential: "n".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: ["host:read", "session:read", "access:self"] },
      "host.getDescriptor": descriptor,
      "host.getSnapshot": { session: { id: "session-a", headSequence: 0 } },
      "session.subscribe": { sessionId: "session-a", afterSequence: 0, headSequence: 0 },
    };
    transport.emit({ type: "response", id: frame.id, ok: true, payload: responses[frame.method] ?? {} });
    // Reproduce a Host invalidating the lease synchronously with an accepted
    // access.refresh response. The new credential must win this race.
    if (rotate && frame.method === "access.refresh") transport.disconnect(1008, "AUTHENTICATION_REQUIRED");
  };
}

async function configuredClient(authentication: TransportAuthentication, rotate = false) {
  const { descriptor, profile } = await identity();
  const store = new MemoryClientStore();
  await store.putProfile(profile);
  await store.setSelectedHost(profile.hostId);
  if (authentication === "direct-device-ticket") {
    await store.putCredential({ hostId: profile.hostId, deviceId: "device-a", refreshCredential: "o".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: ["host:read", "session:read", "access:self"], storage: "short-lived-refresh" });
  }
  const methods: string[] = [];
  let connections = 0;
  const client = new FlyxClient({ profile, store, connectTransport: async (_endpoint, generation) => {
    const transport = new TestTransport(generation, "direct", "device-a", authentication);
    serve(transport, descriptor, methods, rotate && connections === 0);
    connections++;
    return transport;
  } });
  return { client, store, methods, get connections() { return connections; } };
}

describe("FlyxClient authentication transitions", () => {
  it("keeps an exact same-origin Direct browser on its HttpOnly cookie", async () => {
    const fixture = await configuredClient("direct-cookie");
    await fixture.client.start();
    if (fixture.client.getState().connection !== "online") throw new Error(JSON.stringify({ state: fixture.client.getState(), methods: fixture.methods }));
    expect(fixture.client.getState()).toMatchObject({ connection: "online", sync: "synced", securityLevel: "http-only-cookie", pairingRequired: false });
    expect(fixture.methods).not.toContain("access.refresh");
    expect(fixture.connections).toBe(1);
    expect(await fixture.store.getCredential("host-a")).toBeUndefined();
    fixture.client.stop();
  }, 15_000);

  it("preserves an accepted Hosted App refresh when the rotating lease closes", async () => {
    const fixture = await configuredClient("direct-device-ticket", true);
    await fixture.client.start();
    if (fixture.client.getState().connection !== "online") throw new Error(JSON.stringify({ state: fixture.client.getState(), methods: fixture.methods }));
    expect(fixture.methods.filter((method) => method === "access.refresh")).toHaveLength(1);
    expect(fixture.connections).toBe(2);
    expect((await fixture.store.getCredential("host-a"))?.refreshCredential).toBe("n".repeat(43));
    expect(fixture.client.getState()).toMatchObject({ connection: "online", sync: "synced", securityLevel: "short-lived-refresh", pairingRequired: false, endpointId: "direct" });
    fixture.client.stop();
  }, 15_000);
});
