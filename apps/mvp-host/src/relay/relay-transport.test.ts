import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { createNoiseInitiator, type SecureSession } from "@flyx/secure-channel";
import { HostRelayTransport, type SecureRelayConnection } from "./relay-transport.js";
import { FakeRelaySocket, settlePromises } from "./relay-test-support.js";

const transports: HostRelayTransport[] = [];
const sessions: SecureSession[] = [];
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  for (const session of sessions.splice(0)) session.destroy();
  vi.useRealTimers();
});

function keypair() {
  const secret = randomBytes(32);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), secret]), type: "pkcs8", format: "der" });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
  return { secret, publicKey };
}

function setup() {
  const host = keypair();
  const secretBefore = Buffer.from(host.secret);
  const binding = { hostId: "host-identity-1234", routeId: randomBytes(24).toString("base64url"), connectionId: "client_connection_001", protocol: { min: 2, max: 2 } };
  const socket = new FakeRelaySocket("wss://relay.example/data", { headers: { authorization: "Bearer REDACTED" }, maxFrameBytes: 263_168 });
  const messages: Array<string | Uint8Array> = [];
  const onConnection = vi.fn((connection: SecureRelayConnection) => { connection.transport.onMessage((frame) => messages.push(frame)); });
  const transport = new HostRelayTransport({
    socket, ...binding, hostStaticKey: host.secret, generation: 42, onConnection,
  });
  transports.push(transport);
  socket.open();
  return { host, secretBefore, binding, socket, onConnection, transport, messages };
}

async function establish(pattern: "NK" | "IK" = "NK") {
  const state = setup();
  const device = keypair();
  state.socket.receive(JSON.stringify({ type: "data.paired", connectionId: state.binding.connectionId, generation: 42 }));
  await settlePromises();
  const handshake = await createNoiseInitiator({
    pattern, binding: state.binding, remoteStaticKey: state.host.publicKey,
    ...(pattern === "IK" ? { staticKey: device.secret } : {}),
  });
  state.socket.receive(handshake.writeMessage());
  await vi.waitFor(() => expect(state.onConnection).toHaveBeenCalledTimes(1));
  const reply = state.socket.sent.find((frame): frame is Uint8Array => typeof frame !== "string")!;
  handshake.readMessage(reply);
  const session = handshake.finish();
  sessions.push(session);
  return { ...state, session, device };
}

describe("Host Relay Noise plaintext boundary", () => {
  it("exposes an anonymous NK transport only after authenticated Host key agreement; Relay sees no application plaintext", async () => {
    const { socket, transport, session, onConnection, messages } = await establish();
    expect(onConnection.mock.calls[0]![0].pattern).toBe("NK");
    expect(onConnection.mock.calls[0]![0].remotePublicKey).toBeUndefined();
    const marker = JSON.stringify({ type: "request", method: "turn.start", payload: { prompt: "PRIVATE_PROMPT_MARKER_7c319" } });
    socket.receive(session.encrypt(Buffer.from(marker)));
    await vi.waitFor(() => expect(messages).toEqual([marker]));
    await transport.send(marker);
    const ciphertext = socket.sent.filter((frame): frame is Uint8Array => typeof frame !== "string").at(-1)!;
    expect(new TextDecoder().decode(session.decrypt(ciphertext))).toBe(marker);
    expect(socket.sent.some((frame) => Buffer.from(frame).includes("PRIVATE_PROMPT_MARKER_7c319"))).toBe(false);
    expect(socket.sent.filter((frame) => typeof frame === "string").map((frame) => JSON.parse(frame as string)))
      .toEqual([{ type: "ack", sequence: 1 }, { type: "ack", sequence: 2 }]);
  });

  it("reports only the static public key authenticated by IK for the device registry", async () => {
    const { onConnection, device } = await establish("IK");
    expect(onConnection.mock.calls[0]![0]).toMatchObject({ pattern: "IK", remotePublicKey: device.publicKey.toString("base64url") });
  });

  it("does not erase the caller's persisted Buffer key when a completed handshake is destroyed", async () => {
    const { transport, host, secretBefore } = await establish("IK");
    transport.close();
    expect(host.secret).toEqual(secretBefore);
  });

  it.each(["host-key", "route", "connection", "protocol"])("rejects a mismatched %s before the gateway is attached", async (variant) => {
    const { socket, transport, onConnection, host, binding } = setup();
    socket.receive(JSON.stringify({ type: "data.paired", connectionId: binding.connectionId, generation: 42 }));
    await settlePromises();
    const handshake = await createNoiseInitiator({
      pattern: "NK", remoteStaticKey: variant === "host-key" ? keypair().publicKey : host.publicKey,
      binding: { ...binding,
        ...(variant === "route" ? { routeId: randomBytes(24).toString("base64url") } : {}),
        ...(variant === "connection" ? { connectionId: "another_connection_001" } : {}),
        ...(variant === "protocol" ? { protocol: { min: 1, max: 2 } } : {}),
      },
    });
    socket.receive(handshake.writeMessage());
    await vi.waitFor(() => expect(transport.closed).toBe(true));
    expect(onConnection).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    handshake.destroy();
  });

  it.each(["replay", "reorder", "tamper"])("fails closed on ciphertext %s without duplicate gateway delivery", async (variant) => {
    const { socket, transport, session, messages } = await establish();
    const first = session.encrypt(Buffer.from('{"sequence":1}'));
    if (variant === "replay") {
      socket.receive(first);
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      socket.receive(first);
    } else if (variant === "reorder") {
      socket.receive(session.encrypt(Buffer.from('{"sequence":2}')));
    } else {
      first[first.byteLength - 1] = first[first.byteLength - 1]! ^ 1;
      socket.receive(first);
    }
    await vi.waitFor(() => expect(transport.closed).toBe(true));
    expect(messages).toHaveLength(variant === "replay" ? 1 : 0);
    expect(socket.closeCalls.at(-1)).toEqual({ code: 4403, reason: "RELAY_SECURE_CHANNEL_FAILED" });
  });

  it("enforces data pairing/generation, binary ciphertext, and handshake deadlines", async () => {
    vi.useFakeTimers();
    const first = setup();
    first.socket.receive(JSON.stringify({ type: "request", method: "host.bootstrap" }));
    await settlePromises();
    expect(first.transport.closed).toBe(true);
    const wrongGeneration = setup();
    wrongGeneration.socket.receive(JSON.stringify({ type: "data.paired", connectionId: wrongGeneration.binding.connectionId, generation: 41 }));
    await settlePromises();
    expect(wrongGeneration.transport.closed).toBe(true);
    const unopened = setup();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(unopened.socket.closeCalls.at(-1)?.reason).toBe("RELAY_DATA_OPEN_TIMEOUT");
    const noHandshake = setup();
    noHandshake.socket.receive(JSON.stringify({ type: "data.paired", connectionId: noHandshake.binding.connectionId, generation: 42 }));
    await settlePromises();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(noHandshake.socket.closeCalls.at(-1)?.reason).toBe("RELAY_SECURE_HANDSHAKE_TIMEOUT");
    expect([first, wrongGeneration, unopened, noHandshake].every((item) => item.onConnection.mock.calls.length === 0)).toBe(true);
  });

  it("rejects plaintext after secure setup and isolates send backpressure to one client", async () => {
    const first = await establish();
    const healthy = await establish();
    first.socket.bufferedAmount = 1024 * 1024;
    await expect(first.transport.send('{"prompt":"PRIVATE_MARKER"}')).rejects.toThrow("RELAY_BACKPRESSURE");
    expect(first.socket.closeCalls.at(-1)).toEqual({ code: 4409, reason: "RESYNC_REQUIRED" });
    expect(healthy.transport.ready).toBe(true);
    await healthy.transport.send('{"ok":true}');
    healthy.socket.receive('{"type":"request","method":"host.bootstrap"}');
    await vi.waitFor(() => expect(healthy.transport.closed).toBe(true));
    expect(healthy.messages).toEqual([]);
  });
});
