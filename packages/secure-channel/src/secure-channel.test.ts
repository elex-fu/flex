import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNoiseInitiator,
  createNoiseResponder,
  inspectNoiseHandshakePattern,
  type NoiseBinding,
} from "./handshake.js";
import { generateNoiseKeyPair, MemoryNoiseKeyStore, noiseKeyPairFromSecretKey } from "./key-store.js";
import { MAX_SECURE_FRAME_BYTES, MAX_SECURE_PLAINTEXT_BYTES, type NoisePattern, type SecureSession, type SecureSessionOptions } from "./session.js";

const binding: NoiseBinding = { hostId: "host-secure-test", routeId: "route-secure-test-0123456789abcdef", connectionId: "conn-secure-test-0123456789", protocol: { min: 2, max: 2 } };
const sessions: SecureSession[] = [];
const message = new TextEncoder().encode("PROMPT-MARKER-should-never-be-visible-at-relay");

afterEach(() => { for (const session of sessions.splice(0)) session.destroy(); });

async function connect(pattern: NoisePattern = "NK", options: SecureSessionOptions = {}) {
  const host = await generateNoiseKeyPair();
  const device = await generateNoiseKeyPair();
  const init = await createNoiseInitiator({ pattern, binding, remoteStaticKey: host.publicKey,
    ...(pattern === "IK" ? { staticKey: device.secretKey } : {}), ...options });
  const resp = await createNoiseResponder({ pattern, binding, staticKey: host.secretKey, ...options });
  const first = init.writeMessage();
  expect(inspectNoiseHandshakePattern(first)).toBe(pattern);
  resp.readMessage(first);
  expect(resp.complete).toBe(false);
  const second = resp.writeMessage();
  init.readMessage(second);
  expect(init.complete).toBe(true);
  expect(resp.complete).toBe(true);
  const client = init.finish();
  const server = resp.finish();
  sessions.push(client, server);
  return { host, device, client, server, init, resp };
}

describe("Flyx NK/IK secure channel", () => {
  it.each(["NK", "IK"] as const)("authenticates the pinned Host and transfers only ciphertext with %s", async (pattern) => {
    const { client, server, host, device, init, resp } = await connect(pattern);
    expect(client.remoteStaticKey).toEqual(host.publicKey);
    expect(server.remoteStaticKey).toEqual(pattern === "IK" ? device.publicKey : undefined);
    expect(client.handshakeHash).toEqual(server.handshakeHash);
    const frame = client.encrypt(message);
    expect(new TextDecoder().decode(frame)).not.toContain("PROMPT-MARKER");
    expect(server.decrypt(frame)).toEqual(message);
    expect(client.decrypt(server.encrypt(message))).toEqual(message);
    expect(host.secretKey.some((value) => value !== 0)).toBe(true);
    // Destroying the spent handshake cannot destroy the transferred session keys.
    init.destroy(); resp.destroy();
    expect(server.decrypt(client.encrypt(message))).toEqual(message);
  });

  it.each([0, 1, 65_519, 65_520, MAX_SECURE_PLAINTEXT_BYTES])("round-trips a %s byte application frame", async (length) => {
    const { client, server } = await connect();
    const payload = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) payload[index] = index % 251;
    const encrypted = client.encrypt(payload);
    expect(encrypted.byteLength).toBeLessThanOrEqual(MAX_SECURE_FRAME_BYTES);
    expect(server.decrypt(encrypted)).toEqual(payload);
  });

  it("does not accept a wrong pinned Host key", async () => {
    const host = await generateNoiseKeyPair();
    const wrong = await generateNoiseKeyPair();
    const init = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: wrong.publicKey });
    const resp = await createNoiseResponder({ pattern: "NK", binding, staticKey: host.secretKey });
    expect(() => resp.readMessage(init.writeMessage())).toThrow("HANDSHAKE_FAILED");
    expect(() => resp.finish()).toThrow("HANDSHAKE_STATE");
    init.destroy(); resp.destroy();
  });

  it.each([
    { ...binding, hostId: "other-host" },
    { ...binding, routeId: "other-route-test-0123456789abcdefg" },
    { ...binding, connectionId: "other-connection-0123456789" },
    { ...binding, protocol: { min: 1, max: 2 } },
  ])("binds every connection prologue field (%j)", async (other) => {
    const host = await generateNoiseKeyPair();
    const init = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: host.publicKey });
    const resp = await createNoiseResponder({ pattern: "NK", binding: other, staticKey: host.secretKey });
    expect(() => resp.readMessage(init.writeMessage())).toThrow("HANDSHAKE_FAILED");
    init.destroy(); resp.destroy();
  });

  it("rejects all-zero or low-order remote static keys", async () => {
    const init = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: new Uint8Array(32) });
    expect(() => init.writeMessage()).toThrow("HANDSHAKE_FAILED");
    init.destroy();
  });

  it("refuses handshake application payloads, short frames, repeated flights and early finish", async () => {
    const host = await generateNoiseKeyPair();
    const short = await createNoiseResponder({ pattern: "NK", binding, staticKey: host.secretKey });
    expect(() => short.readMessage(new Uint8Array([1]))).toThrow("HANDSHAKE_FAILED");
    const early = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: host.publicKey });
    expect(() => early.finish()).toThrow("HANDSHAKE_STATE");
    const init = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: host.publicKey });
    const resp = await createNoiseResponder({ pattern: "NK", binding, staticKey: host.secretKey });
    const frame = init.writeMessage();
    resp.readMessage(frame);
    expect(() => resp.readMessage(frame)).toThrow("HANDSHAKE_STATE");
    init.destroy(); resp.destroy(); short.destroy(); early.destroy();
  });

  it("reports one fatal callback for one malformed handshake flight", async () => {
    const host = await generateNoiseKeyPair();
    for (const frame of [new Uint8Array([1]), new Uint8Array(49).fill(2)]) {
      const onFatalError = vi.fn();
      const resp = await createNoiseResponder({ pattern: "NK", binding, staticKey: host.secretKey, onFatalError });
      expect(() => resp.readMessage(frame)).toThrow("HANDSHAKE_FAILED");
      expect(onFatalError).toHaveBeenCalledTimes(1);
      resp.destroy();
    }
  });

  it("does not permit pattern negotiation to downgrade IK to NK", async () => {
    const host = await generateNoiseKeyPair();
    const device = await generateNoiseKeyPair();
    const init = await createNoiseInitiator({ pattern: "IK", binding, remoteStaticKey: host.publicKey, staticKey: device.secretKey });
    const resp = await createNoiseResponder({ pattern: "NK", binding, staticKey: host.secretKey });
    const frame = init.writeMessage(); frame[0] = 1;
    expect(() => resp.readMessage(frame)).toThrow("HANDSHAKE_FAILED");
    init.destroy(); resp.destroy();
  });

  it("generates fresh ephemeral keys even with identical static keys and binding", async () => {
    const host = await generateNoiseKeyPair();
    const first = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: host.publicKey });
    const second = await createNoiseInitiator({ pattern: "NK", binding, remoteStaticKey: host.publicKey });
    expect(first.writeMessage()).not.toEqual(second.writeMessage());
    first.destroy(); second.destroy();
  });

  it.each([0, 1, 2, 3, 4, 8, 16, 20, 22, 35, 62])("closes on tampering at binary offset%s", async (offset) => {
    const close = vi.fn();
    const { client, server } = await connect("NK", { onFatalError: close });
    const frame = client.encrypt(message);
    frame[offset] = frame[offset]! ^ 1;
    expect(() => server.decrypt(frame)).toThrow();
    expect(server.destroyed).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(() => server.encrypt(message)).toThrow("CLOSED");
  });

  it("closes on replay of an already accepted frame", async () => {
    const { client, server } = await connect();
    const frame = client.encrypt(message);
    server.decrypt(frame);
    expect(() => server.decrypt(frame)).toThrow("REPLAY_OR_OUT_OF_ORDER");
    expect(server.destroyed).toBe(true);
  });

  it("closes on an out-of-order frame without delivering any plaintext", async () => {
    const { client, server } = await connect();
    client.encrypt(message);
    const second = client.encrypt(message);
    expect(() => server.decrypt(second)).toThrow("REPLAY_OR_OUT_OF_ORDER");
    expect(server.destroyed).toBe(true);
  });

  it("rejects direction reflection and ciphertext from a different session", async () => {
    const first = await connect(); const second = await connect();
    const frame = first.client.encrypt(message);
    expect(() => first.client.decrypt(frame)).toThrow("INVALID_FRAME");
    expect(() => second.server.decrypt(frame)).toThrow("AUTHENTICATION_FAILED");
  });

  it("fails closed on oversized, truncated, trailing and text input", async () => {
    const { client } = await connect();
    expect(() => client.encrypt(new Uint8Array(MAX_SECURE_PLAINTEXT_BYTES + 1))).toThrow("FRAME_TOO_LARGE");
    for (const mode of ["truncated", "trailing", "text"] as const) {
      const { client: sender, server } = await connect();
      const frame = sender.encrypt(message);
      const input = mode === "truncated" ? frame.subarray(0, frame.length - 1)
        : mode === "trailing" ? new Uint8Array([...frame, 0]) : "plaintext" as unknown as Uint8Array;
      expect(() => server.decrypt(input)).toThrow("INVALID_FRAME");
      expect(server.destroyed).toBe(true);
    }
  });

  it("does not deliver a partially valid chunked message", async () => {
    const { client, server } = await connect();
    const encrypted = client.encrypt(new Uint8Array(130_000).fill(9));
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
    expect(() => server.decrypt(encrypted)).toThrow("AUTHENTICATION_FAILED");
    expect(server.destroyed).toBe(true);
  });

  it("rekeys by message count without coupling send and receive keys", async () => {
    const { client, server } = await connect("IK", { limits: { rekeyAfterMessages: 2 } });
    for (let index = 0; index < 7; index += 1) expect(server.decrypt(client.encrypt(message))).toEqual(message);
    expect(client.counters).toEqual({ sent: 7n, received: 0n, sendEpoch: 3, receiveEpoch: 0 });
    expect(server.counters).toEqual({ sent: 0n, received: 7n, sendEpoch: 0, receiveEpoch: 3 });
    expect(client.decrypt(server.encrypt(message))).toEqual(message);
  });

  it("encodes direction, epoch and sequence in fixed big-endian headers without resetting sequence on rekey", async () => {
    const { client, server } = await connect("NK", { limits: { rekeyAfterMessages: 1 } });
    const first = client.encrypt(message);
    const firstView = new DataView(first.buffer, first.byteOffset, first.byteLength);
    expect(Array.from(first.subarray(0, 4))).toEqual([3, 1, 0, 0]);
    expect(firstView.getUint32(4)).toBe(0);
    expect(firstView.getBigUint64(8)).toBe(0n);
    expect(firstView.getUint32(16)).toBe(message.byteLength);
    expect(firstView.getUint16(20)).toBe(1);
    server.decrypt(first);

    const second = client.encrypt(message);
    const secondView = new DataView(second.buffer, second.byteOffset, second.byteLength);
    expect(secondView.getUint32(4)).toBe(1);
    expect(secondView.getBigUint64(8)).toBe(1n);
    expect(server.decrypt(second)).toEqual(message);
  });

  it("rekeys before exceeding the per-key byte budget", async () => {
    const { client, server } = await connect("NK", { limits: { rekeyAfterBytes: message.length * 2 } });
    server.decrypt(client.encrypt(message));
    server.decrypt(client.encrypt(message));
    server.decrypt(client.encrypt(message));
    expect(server.counters.receiveEpoch).toBe(1);
  });

  it("rekeys by elapsed time without relying on receiver clock synchronization", async () => {
    let now = 0;
    const { client, server } = await connect("NK", { now: () => now, limits: { rekeyAfterMs: 10 } });
    server.decrypt(client.encrypt(message));
    now = 11;
    expect(server.decrypt(client.encrypt(message))).toEqual(message);
    expect(server.counters.receiveEpoch).toBe(1);
    expect(server.counters.sent).toBe(0n);
  });

  it("does not accept replay from a previous rekey epoch", async () => {
    const { client, server } = await connect("NK", { limits: { rekeyAfterMessages: 1 } });
    const old = client.encrypt(message); server.decrypt(old);
    server.decrypt(client.encrypt(message));
    expect(() => server.decrypt(old)).toThrow("REPLAY_OR_OUT_OF_ORDER");
  });
});

describe("device key storage boundary", () => {
  it("keeps key material in memory, copies at its boundary and supports deletion", async () => {
    const store = new MemoryNoiseKeyStore();
    const pair = await generateNoiseKeyPair();
    expect(noiseKeyPairFromSecretKey(pair.secretKey).publicKey).toEqual(pair.publicKey);
    await store.save("device", pair);
    pair.secretKey.fill(0);
    const loaded = (await store.load("device"))!;
    expect(loaded.secretKey.some((value) => value !== 0)).toBe(true);
    loaded.secretKey.fill(0);
    expect((await store.load("device"))!.secretKey.some((value) => value !== 0)).toBe(true);
    await store.delete("device");
    expect(await store.load("device")).toBeNull();
    expect(store.protection).toBe("memory-only");
    store.destroy();
  });

  it("never aliases or wipes a caller-owned Node Buffer key", async () => {
    const backing = Buffer.alloc(48, 0xa5);
    const secret = backing.subarray(8, 40);
    const before = Buffer.from(backing);
    const pair = noiseKeyPairFromSecretKey(secret);
    pair.secretKey.fill(0);
    expect(backing).toEqual(before);

    const handshake = await createNoiseResponder({ pattern: "NK", binding, staticKey: secret });
    handshake.destroy();
    expect(backing).toEqual(before);
  });
});
