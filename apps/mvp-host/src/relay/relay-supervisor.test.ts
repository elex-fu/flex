import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createNoiseInitiator, noiseKeyPairFromSecretKey } from "@flyx/secure-channel";
import { HostRelaySupervisor } from "./relay-supervisor.js";
import { fakeRelaySocketFactory, settlePromises } from "./relay-test-support.js";

const directories: string[] = [];
const supervisors: HostRelaySupervisor[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(fetchOverride?: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), "flyx-relay-supervisor-"));
  directories.push(directory);
  const route = { v: 1, routeId: randomBytes(24).toString("base64url"), relayCredential: randomBytes(32).toString("base64url") };
  const fake = fakeRelaySocketFactory();
  const onConnection = vi.fn();
  const onState = vi.fn();
  const hostStaticKey = randomBytes(32);
  const supervisor = new HostRelaySupervisor({
    relayUrl: "wss://relay.example", registrationPath: join(directory, "relay.json"),
    hostId: "host-identity-1234", hostStaticKey, protocol: { min: 2, max: 2 },
    socketFactory: fake.factory, fetch: fetchOverride ?? vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(route))),
    random: () => 0.5, now: () => Date.now(), onConnection, onState,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return { ...fake, supervisor, route, hostStaticKey, onConnection, onState };
}

function registration(socket: { receive(frame: string): void; url: string }, connectionIds: string[] = []) {
  socket.receive(JSON.stringify({ type: "registered", connectionIds, generation: Number(new URL(socket.url).searchParams.get("generation")) }));
}

describe("Host outbound Relay supervisor", () => {
  it("recovers after route registration is unavailable at startup without another Host restart", async () => {
    vi.useFakeTimers();
    const reply = { v: 1, routeId: randomBytes(24).toString("base64url"), relayCredential: randomBytes(32).toString("base64url") };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("DNS unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply)));
    const { supervisor, sockets } = await setup(fetch);
    expect(supervisor.state).toBe("backoff");
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open(); registration(sockets[0]!);
    expect(supervisor.state).toBe("online");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops a pending registration retry and does not allocate a route after shutdown", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("DNS unavailable"));
    const { supervisor, sockets } = await setup(fetch);
    expect(supervisor.state).toBe("backoff");
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    expect(supervisor.state).toBe("stopped");
  });

  it("authenticates control/data via headers, deduplicates control events, and drains all sockets on stop", async () => {
    const { sockets, route, supervisor, onConnection } = await setup();
    const control = sockets[0]!;
    expect(new URL(control.url).pathname).toBe(`/v1/routes/${route.routeId}/control`);
    expect(control.options.headers.authorization).toBe(`Bearer ${route.relayCredential}`);
    expect(control.url).not.toContain(route.relayCredential);
    control.open();
    expect(supervisor.state).toBe("registering");
    const id = "client_connection_001";
    registration(control, [id]);
    expect(supervisor.state).toBe("online");
    expect(sockets).toHaveLength(2);
    control.receive(JSON.stringify({ type: "connected", connectionId: id }));
    expect(sockets).toHaveLength(2);
    expect(supervisor.dataConnectionCount).toBe(1);
    expect(sockets[1]!.options.headers.authorization).toBe(`Bearer ${route.relayCredential}`);
    expect(new URL(sockets[1]!.url).search).toBe(new URL(control.url).search);
    expect(onConnection).not.toHaveBeenCalled();
    await supervisor.stop();
    expect(supervisor.state).toBe("stopped");
    expect(supervisor.dataConnectionCount).toBe(0);
    expect(sockets.every((socket) => socket.terminated)).toBe(true);
    control.receive(JSON.stringify({ type: "connected", connectionId: "stale_connection_001" }));
    expect(sockets).toHaveLength(2);
  });

  it("reconnects after a 30-second half-open control socket with a strictly newer generation", async () => {
    vi.useFakeTimers();
    const { sockets, supervisor } = await setup();
    const control = sockets[0]!;
    control.open(); registration(control);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(control.sent[0] as string)).toMatchObject({ type: "ping" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(supervisor.state).toBe("backoff");
    expect(control.terminated).toBe(true);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const replacement = sockets[1]!;
    expect(Number(new URL(replacement.url).searchParams.get("generation"))).toBeGreaterThan(Number(new URL(control.url).searchParams.get("generation")));
    replacement.open(); registration(replacement);
    expect(supervisor.state).toBe("online");
    // The obsolete physical connection cannot add a new data socket after replacement.
    control.receive(JSON.stringify({ type: "connected", connectionId: "old_connection_0001" }));
    expect(sockets).toHaveLength(2);
  });

  it("counts only valid traffic for liveness and answers Relay heartbeat requests", async () => {
    // Own the startup deadline and heartbeat with one clock; fake clearTimeout cannot cancel a real timer.
    vi.useFakeTimers();
    const { sockets, supervisor } = await setup();
    const control = sockets[0]!;
    control.open(); registration(control);
    await vi.advanceTimersByTimeAsync(10_000);
    const ping = JSON.parse(control.sent[0] as string) as { nonce: string };
    control.receive(JSON.stringify({ type: "pong", nonce: ping.nonce }));
    control.receive(JSON.stringify({ type: "ping", nonce: "relay_heartbeat_1" }));
    await settlePromises();
    expect(control.sent).toContain(JSON.stringify({ type: "pong", nonce: "relay_heartbeat_1" }));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(supervisor.state).toBe("online");
    control.receive(JSON.stringify({ type: "pong", nonce: "unsolicited_nonce" }));
    expect(supervisor.state).toBe("backoff");
  });

  it("syncs pending clients after reconnect and replaces an incomplete old-generation handshake", async () => {
    vi.useFakeTimers();
    const { sockets, supervisor } = await setup();
    const control = sockets[0]!;
    const id = "client_connection_001";
    control.open(); registration(control, [id]);
    const oldData = sockets[1]!;
    oldData.open();
    oldData.receive(JSON.stringify({ type: "data.paired", connectionId: id, generation: supervisor.registration!.generation }));
    await settlePromises();
    control.serverClose();
    expect(oldData.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    const replacement = sockets[2]!;
    replacement.open(); registration(replacement, [id, "client_connection_002"]);
    expect(oldData.terminated).toBe(true);
    expect(sockets).toHaveLength(5);
    expect(supervisor.dataConnectionCount).toBe(2);
    replacement.receive(JSON.stringify({ type: "disconnected", connectionId: id }));
    expect(supervisor.dataConnectionCount).toBe(1);
  });

  it("preserves an already secure data channel when the control connection resumes", async () => {
    vi.useFakeTimers();
    const { sockets, supervisor, onConnection, hostStaticKey, route } = await setup();
    const control = sockets[0]!;
    const id = "client_connection_001";
    control.open(); registration(control, [id]);
    const data = sockets[1]!;
    data.open(); data.receive(JSON.stringify({ type: "data.paired", connectionId: id, generation: supervisor.registration!.generation }));
    await settlePromises();
    const handshake = await createNoiseInitiator({ pattern: "NK", remoteStaticKey: noiseKeyPairFromSecretKey(hostStaticKey).publicKey,
      binding: { hostId: "host-identity-1234", routeId: route.routeId, connectionId: id, protocol: { min: 2, max: 2 } } });
    data.receive(handshake.writeMessage());
    await vi.waitFor(() => expect(onConnection).toHaveBeenCalledTimes(1));
    handshake.readMessage(data.sent.find((frame): frame is Uint8Array => typeof frame !== "string")!);
    const session = handshake.finish();
    try {
      control.serverClose();
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      sockets[2]!.open(); registration(sockets[2]!, [id]);
      expect(sockets).toHaveLength(3);
      expect(data.terminated).toBe(false);
      expect(onConnection).toHaveBeenCalledTimes(1);
      await onConnection.mock.calls[0]![0].transport.send('{"still":"secure"}');
      const ciphertext = data.sent.filter((frame): frame is Uint8Array => typeof frame !== "string").at(-1)!;
      expect(new TextDecoder().decode(session.decrypt(ciphertext))).toBe('{"still":"secure"}');
    } finally { session.destroy(); }
  });

  it("bounds Host-side data allocation even when an authenticated Relay floods client announcements", async () => {
    const { sockets, supervisor } = await setup();
    sockets[0]!.open(); registration(sockets[0]!);
    for (let index = 0; index < 65; index += 1) {
      sockets[0]!.receive(JSON.stringify({ type: "connected", connectionId: `client_connection_${String(index).padStart(3, "0")}` }));
    }
    expect(supervisor.state).toBe("backoff");
    expect(supervisor.dataConnectionCount).toBe(64);
    expect(sockets).toHaveLength(65);
  });

  it("isolates a failed data channel and never retries a disconnected client", async () => {
    vi.useFakeTimers();
    const { sockets, supervisor } = await setup();
    const control = sockets[0]!;
    const id = "client_connection_001";
    control.open(); registration(control, [id, "client_connection_002"]);
    sockets[1]!.fail();
    expect(supervisor.state).toBe("online");
    expect(sockets[2]!.terminated).toBe(false);
    control.receive(JSON.stringify({ type: "disconnected", connectionId: id }));
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(3);
    expect(supervisor.dataConnectionCount).toBe(1);
  });

  it("rejects malformed or binary control frames without reflecting attacker text", async () => {
    const { sockets, supervisor, onState } = await setup();
    const control = sockets[0]!;
    control.open(); registration(control);
    control.receive(new TextEncoder().encode("SECRET_PROMPT_MARKER"));
    expect(supervisor.state).toBe("backoff");
    expect(onState.mock.calls.flat().join(" ")).not.toContain("SECRET_PROMPT_MARKER");
  });
});
