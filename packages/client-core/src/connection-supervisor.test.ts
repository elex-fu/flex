import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "./common.js";
import { ConnectionSupervisor } from "./connection-supervisor.js";
import { TestTransport } from "./test-support.js";
import type { ConnectionEndpoint } from "./types.js";

afterEach(() => vi.useRealTimers());
const endpoints = (): ConnectionEndpoint[] => [
  { id: "direct", kind: "direct-https", source: "tailscale", baseUrl: "https://host.tailnet.ts.net", availability: "available", lastRttMs: 10 },
  { id: "relay", kind: "relay-wss", relayUrl: "wss://relay.example", routeId: "r".repeat(32), availability: "available", lastRttMs: 100 },
];

describe("connection supervisor", () => {
  it("fails over after two missing heartbeats without old-socket callbacks changing state", async () => {
    vi.useFakeTimers();
    const candidates = endpoints();
    const transports: TestTransport[] = [];
    const selected: string[] = [];
    const supervisor = new ConnectionSupervisor({ endpoints: () => candidates, connect: async (endpoint, generation) => {
      selected.push(endpoint.id);
      const transport = new TestTransport(generation, endpoint.kind === "direct-https" ? "direct" : "relay");
      transports.push(transport);
      return transport;
    }, activate: async () => {}, ping: async () => {}, heartbeatMs: 100, probeMs: 10_000 });
    await supervisor.start();
    expect(supervisor.getState().connection).toBe("online");
    await vi.advanceTimersByTimeAsync(300);
    expect(selected).toEqual(["direct", "relay"]);
    const generation = supervisor.generation;
    expect(supervisor.getState().transportKind).toBe("relay");
    transports[0]!.disconnect();
    expect(supervisor.generation).toBe(generation);
    expect(transports[0]!.closes).toContainEqual({ code: 1000, reason: "CONNECTION_REPLACED" });
    supervisor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires three verified Direct probes, RTT benefit, and resolved writes before upgrade", async () => {
    vi.useFakeTimers();
    const candidates = endpoints();
    candidates[0]!.availability = "unavailable";
    let canUpgrade = false;
    let probes = 0;
    const selections: string[] = [];
    const supervisor = new ConnectionSupervisor({
      endpoints: () => candidates,
      connect: async (endpoint, generation) => { selections.push(endpoint.id); return new TestTransport(generation, endpoint.kind === "relay-wss" ? "relay" : "direct"); },
      activate: async () => {}, ping: async () => {},
      probe: async () => { probes++; return 10; },
      canUpgrade: () => canUpgrade, heartbeatMs: 10_000, probeMs: 100,
    });
    await supervisor.start();
    candidates[1]!.lastRttMs = 100;
    await vi.advanceTimersByTimeAsync(200);
    expect(probes).toBe(2);
    expect(selections).toEqual(["relay"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(selections).toEqual(["relay"]);
    canUpgrade = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(selections).toEqual(["relay", "direct"]);
    supervisor.stop();
  });

  it("uses full jitter and online recovery without reconnecting after stop", async () => {
    vi.useFakeTimers();
    const online = new EventTarget();
    const selected: number[] = [];
    let reachable = false;
    const supervisor = new ConnectionSupervisor({ endpoints: () => endpoints().slice(0, 1), random: () => 0.5, onlineTarget: online, connect: async (_endpoint, generation) => {
      selected.push(Date.now());
      if (!reachable) throw new ClientError("NETWORK_FAILED", "offline");
      return new TestTransport(generation);
    }, activate: async () => {}, ping: async () => {} });
    await supervisor.start();
    expect(selected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(selected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(selected).toHaveLength(2);
    reachable = true;
    online.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(selected).toHaveLength(3);
    expect(supervisor.getState().connection).toBe("online");
    supervisor.stop();
    online.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(selected).toHaveLength(3);
    expect(supervisor.getState().connection).toBe("closed");
  });

  it("increments generation for each failed candidate and halts on Host key mismatch", async () => {
    const generations: number[] = [];
    const supervisor = new ConnectionSupervisor({ endpoints, connect: async (_endpoint, generation) => {
      generations.push(generation);
      if (generations.length === 1) throw new ClientError("NETWORK_FAILED", "offline");
      throw new ClientError("IDENTITY_MISMATCH", "wrong host");
    }, activate: async () => {}, ping: async () => {} });
    await supervisor.start();
    expect(generations[1]).toBe(generations[0]! + 1);
    expect(supervisor.getState().error?.code).toBe("IDENTITY_MISMATCH");
    expect(supervisor.getState().connection).toBe("failed");
    supervisor.stop();
  });

  it("reconnects the same endpoint immediately after an accepted credential rotation", async () => {
    const candidates = endpoints();
    const selected: string[] = [];
    let activations = 0;
    const supervisor = new ConnectionSupervisor({
      endpoints: () => candidates,
      connect: async (endpoint, generation) => {
        selected.push(endpoint.id);
        return new TestTransport(generation, endpoint.kind === "direct-https" ? "direct" : "relay");
      },
      activate: async () => {
        if (activations++ === 0) throw new ClientError("AUTH_REFRESHED", "credential was durably rotated");
      },
      ping: async () => {},
    });
    await supervisor.start();
    expect(selected).toEqual(["direct", "direct"]);
    expect(supervisor.getState()).toMatchObject({ connection: "online", endpointId: "direct", transportKind: "direct" });
    expect(candidates[0]?.availability).toBe("available");
    supervisor.stop();
  });

  it("allows a pinned HTTPS loopback endpoint without opting into insecure HTTP", async () => {
    const candidates: ConnectionEndpoint[] = [
      { id: "direct", kind: "direct-https", source: "tailscale", baseUrl: "https://127.0.0.1:443", availability: "available" },
      { id: "relay", kind: "relay-wss", relayUrl: "wss://relay.example", routeId: "r".repeat(32), availability: "available" },
    ];
    const selected: string[] = [];
    const supervisor = new ConnectionSupervisor({
      endpoints: () => candidates,
      connect: async (endpoint, generation) => {
        selected.push(endpoint.id);
        return new TestTransport(generation, endpoint.kind === "direct-https" ? "direct" : "relay");
      },
      activate: async () => {},
      ping: async () => {},
      // HTTPS is the trust boundary here; this option must not be required
      // merely because a deterministic fixture uses a loopback address.
      allowLoopback: false,
    });
    await supervisor.start();
    expect(selected).toEqual(["direct"]);
    expect(supervisor.getState().transportKind).toBe("direct");
    supervisor.stop();
  });
});
