import { describe, expect, it } from "vitest";
import { RelayRoom } from "./relay-room.js";
import { RELAY_CLOSE, type RelayMetric, type RelaySocket } from "./relay-port.js";

const routeId = "r".repeat(32);
const principal = { routeId };

class SocketFixture implements RelaySocket {
  bufferedAmount = 0;
  readonly frames: Array<string | Uint8Array> = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  constructor(readonly id: string) {}
  send(frame: string | Uint8Array): void { this.frames.push(typeof frame === "string" ? frame : frame.slice()); }
  close(code: number, reason: string): void { this.closed.push({ code, reason }); }
  text(): Array<Record<string, unknown>> { return this.frames.filter((frame): frame is string => typeof frame === "string").map(frame => JSON.parse(frame) as Record<string, unknown>); }
  binary(): Uint8Array[] { return this.frames.filter((frame): frame is Uint8Array => typeof frame !== "string"); }
}

function fixture(limits: ConstructorParameters<typeof RelayRoom>[0]["limits"] = {}) {
  let now = 1000;
  let id = 0;
  const metrics: RelayMetric[] = [];
  const room = new RelayRoom({ routeId, now: () => now, randomId: () => `${++id}`.padStart(32, "x"), limits, observer: { record: metric => metrics.push(metric) } });
  return { room, metrics, time: (value: number) => { now = value; } };
}

async function pair(room: RelayRoom, suffix = "one", generation = 1) {
  const client = new SocketFixture(`client-${suffix}`);
  const connectionId = await room.attachClient(client);
  const data = new SocketFixture(`data-${suffix}`);
  await room.attachData(data, principal, connectionId, generation);
  return { client, data, connectionId };
}

describe("RelayRoom", () => {
  it("pairs independent opaque binary channels without payloads in snapshots or metrics", async () => {
    const { room, metrics } = fixture();
    const control = new SocketFixture("control");
    await room.attachControl(control, principal, 1);
    const first = await pair(room);
    const second = await pair(room, "two");
    expect(first.client.text()).toEqual([
      { type: "client.connected", connectionId: first.connectionId },
      { type: "data.paired", connectionId: first.connectionId, generation: 1 },
    ]);
    const marker = new TextEncoder().encode("TEST_PROMPT_NOT_FOR_RELAY_LOGS");
    await room.receive(first.client.id, marker);
    await room.receive(second.data.id, new Uint8Array([0, 255, 1]));
    expect(first.data.binary()).toEqual([marker]);
    expect(first.client.binary()).toEqual([]);
    expect(second.client.binary()).toEqual([new Uint8Array([0, 255, 1])]);
    expect(second.data.binary()).toEqual([]);
    expect(JSON.stringify(room.snapshot())).not.toContain("TEST_PROMPT");
    expect(JSON.stringify(metrics)).not.toContain("TEST_PROMPT");
    expect(JSON.stringify(metrics)).not.toContain(first.connectionId);
    expect(control.text().filter(value => value.type === "connected")).toHaveLength(2);
  });

  it("preserves live pairs across control outage and fences atomic control/data replacements", async () => {
    const { room } = fixture();
    const oldControl = new SocketFixture("control-old");
    await room.attachControl(oldControl, principal, 10);
    const active = await pair(room, "existing", 10);
    await room.detach(oldControl.id);
    expect(active.client.closed).toEqual([]);
    await room.receive(active.client.id, new Uint8Array([1]));
    expect(active.data.binary()).toHaveLength(1);
    const nextControl = new SocketFixture("control-new");
    await room.attachControl(nextControl, principal, 11);
    expect(nextControl.text()[0]).toEqual({ type: "registered", generation: 11, connectionIds: [active.connectionId] });
    const stale = new SocketFixture("control-stale");
    await expect(room.attachControl(stale, principal, 10)).rejects.toThrow("STALE_GENERATION");
    const replacement = new SocketFixture("data-new");
    await room.attachData(replacement, principal, active.connectionId, 11);
    expect(active.data.closed[0]?.reason).toBe("REPLACED");
    await room.detach(active.data.id);
    await room.detach(oldControl.id);
    await room.receive(active.data.id, new Uint8Array([9]));
    await room.receive(active.client.id, new Uint8Array([2]));
    expect(replacement.binary()).toEqual([new Uint8Array([2])]);
    expect(active.client.closed).toEqual([]);
    expect(room.snapshot().controlGeneration).toBe(11);
  });

  it("requires credential principal route, valid generation and a pending client", async () => {
    const { room } = fixture();
    await expect(room.attachControl(new SocketFixture("wrong"), { routeId: "z".repeat(32) }, 1)).rejects.toThrow("UNAUTHORIZED");
    await expect(room.attachControl(new SocketFixture("invalid"), principal, 0)).rejects.toThrow("BAD_FRAME");
    await room.attachControl(new SocketFixture("control"), principal, 1);
    await expect(room.attachData(new SocketFixture("missing"), principal, "missing".repeat(5), 1)).rejects.toThrow("STALE_GENERATION");
    const client = new SocketFixture("pending");
    const connectionId = await room.attachClient(client);
    await expect(room.attachData(new SocketFixture("future"), principal, connectionId, 2)).rejects.toThrow("STALE_GENERATION");
  });

  it("recovers pending clients after control reconnect without accepting pre-pair ciphertext", async () => {
    const { room } = fixture();
    const waiting = new SocketFixture("waiting");
    const connectionId = await room.attachClient(waiting);
    const control = new SocketFixture("control");
    await room.attachControl(control, principal, 1);
    expect(control.text()[0]?.connectionIds).toEqual([connectionId]);
    await room.receive(waiting.id, new Uint8Array([1, 2]));
    expect(waiting.closed[0]?.reason).toBe("BAD_FRAME");
    expect(room.snapshot().sockets).toHaveLength(1);
  });

  it("closes only a slow pair when unacknowledged ciphertext exceeds the byte bound", async () => {
    const { room, metrics } = fixture({ maxBufferedBytes: 256 });
    await room.attachControl(new SocketFixture("control"), principal, 1);
    const slow = await pair(room, "slow");
    const healthy = await pair(room, "healthy");
    await room.receive(slow.data.id, new Uint8Array(180));
    await room.receive(slow.data.id, new Uint8Array(180));
    expect(slow.client.closed[0]?.code).toBe(RELAY_CLOSE.RESYNC_REQUIRED);
    expect(slow.data.closed[0]?.code).toBe(RELAY_CLOSE.RESYNC_REQUIRED);
    await room.receive(healthy.data.id, new Uint8Array([7]));
    expect(healthy.client.binary()).toEqual([new Uint8Array([7])]);
    expect(healthy.client.closed).toEqual([]);
    expect(metrics).toContainEqual({ name: "backpressure_close_total", value: 1 });
  });

  it("applies native buffered bytes and in-flight frame-count bounds independently", async () => {
    const { room } = fixture({ maxSocketMessagesPerSecond: 1000 });
    await room.attachControl(new SocketFixture("control"), principal, 1);
    const buffered = await pair(room, "buffered");
    buffered.client.bufferedAmount = 1024 * 1024;
    await room.receive(buffered.data.id, new Uint8Array([1]));
    expect(buffered.client.closed[0]?.reason).toBe("RESYNC_REQUIRED");
    const tiny = await pair(room, "tiny");
    for (let count = 0; count < 256; count += 1) await room.receive(tiny.data.id, new Uint8Array());
    expect(tiny.client.closed).toEqual([]);
    expect(JSON.stringify(room.attachment(tiny.client.id)).length).toBeLessThan(16_384);
    await room.receive(tiny.data.id, new Uint8Array());
    expect(tiny.client.closed[0]?.reason).toBe("RESYNC_REQUIRED");
  });

  it("consumes monotonic cumulative ACKs locally; duplicate ACKs are harmless and future ACKs close", async () => {
    const { room } = fixture({ maxBufferedBytes: 256 });
    await room.attachControl(new SocketFixture("control"), principal, 1);
    const channel = await pair(room);
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      await room.receive(channel.data.id, new Uint8Array(180));
      await room.receive(channel.client.id, JSON.stringify({ type: "ack", sequence }));
      await room.receive(channel.client.id, JSON.stringify({ type: "ack", sequence }));
    }
    expect(channel.client.closed).toEqual([]);
    expect(channel.data.text()).toHaveLength(1);
    expect(room.attachment(channel.client.id)?.unacked).toEqual([]);
    await room.receive(channel.client.id, JSON.stringify({ type: "ack", sequence: 9 }));
    expect(channel.client.closed[0]?.reason).toBe("BAD_FRAME");
  });

  it("restores sequence fences and liveness metadata without persisting frames", async () => {
    const { room, time } = fixture({ maxBufferedBytes: 256 });
    const control = new SocketFixture("control");
    await room.attachControl(control, principal, 5);
    const channel = await pair(room, "saved", 5);
    await room.receive(channel.data.id, new Uint8Array(180));
    time(11_000);
    await room.tick();
    const snapshot = room.snapshot();
    const restored = new RelayRoom({ routeId, now: () => 12_000, snapshot, limits: { maxBufferedBytes: 256 } });
    const sockets = new Map(snapshot.sockets.map(attachment => [attachment.socketId, new SocketFixture(attachment.socketId)]));
    for (const attachment of snapshot.sockets) restored.restoreSocket(sockets.get(attachment.socketId)!, attachment);
    await restored.receive(control.id, JSON.stringify({ type: "pong", nonce: snapshot.outstandingPing }));
    expect(sockets.get(control.id)?.closed).toEqual([]);
    await restored.receive(channel.client.id, JSON.stringify({ type: "ack", sequence: 1 }));
    await restored.receive(channel.data.id, new Uint8Array(180));
    expect(restored.attachment(channel.client.id)?.nextSequence).toBe(3);
    expect(sockets.get(channel.client.id)?.closed).toEqual([]);
    await expect(restored.attachControl(new SocketFixture("stale"), principal, 5)).rejects.toThrow("STALE_GENERATION");
  });

  it("emits schema-valid heartbeat nonces for every base64url prefix", async () => {
    let now = 1_000;
    const room = new RelayRoom({ routeId, now: () => now, randomId: () => `-${"a".repeat(31)}` });
    const control = new SocketFixture("control");
    await room.attachControl(control, principal, 1);
    now += room.limits.controlHeartbeatIntervalMs;
    await room.tick();
    const ping = control.text().find((frame) => frame.type === "ping")!;
    expect(ping.nonce).toBe(`p.-${"a".repeat(31)}`);
    await room.receive(control.id, JSON.stringify({ type: "pong", nonce: ping.nonce }));
    expect(control.closed).toEqual([]);
  });

  it("rejects malformed or oversized ciphertext, unknown text and application frames on control", async () => {
    const { room } = fixture({ maxCiphertextFrameBytes: 16 });
    const control = new SocketFixture("control");
    await room.attachControl(control, principal, 1);
    const large = await pair(room, "large");
    await room.receive(large.data.id, new Uint8Array(17));
    expect(large.data.closed[0]?.reason).toBe("FRAME_TOO_LARGE");
    const text = await pair(room, "text");
    await room.receive(text.client.id, '{"type":"request","method":"session.startTurn"}');
    expect(text.client.closed[0]?.reason).toBe("BAD_FRAME");
    await room.receive(control.id, new Uint8Array([1]));
    expect(control.closed[0]?.reason).toBe("BAD_FRAME");
  });

  it("expires half-open control and unpaired clients while a healthy pair remains isolated", async () => {
    const { room, time } = fixture();
    const control = new SocketFixture("control");
    await room.attachControl(control, principal, 1);
    const live = await pair(room);
    const pending = new SocketFixture("pending");
    await room.attachClient(pending);
    time(16_001);
    await room.tick();
    expect(pending.closed[0]?.reason).toBe("TIMEOUT");
    time(31_001);
    await room.tick();
    expect(control.closed[0]?.reason).toBe("TIMEOUT");
    expect(live.client.closed).toEqual([]);
    time(91_001);
    await room.tick();
    expect(live.client.closed[0]?.reason).toBe("TIMEOUT");
  });

  it("enforces route connection/client quotas and per-socket message rates", async () => {
    const { room } = fixture({ maxClientsPerRoute: 1, maxSocketMessagesPerSecond: 2 });
    await room.attachControl(new SocketFixture("control"), principal, 1);
    const channel = await pair(room);
    await expect(room.attachClient(new SocketFixture("excess"))).rejects.toThrow("QUOTA_EXCEEDED");
    await room.receive(channel.data.id, new Uint8Array([1]));
    await room.receive(channel.data.id, new Uint8Array([2]));
    await room.receive(channel.data.id, new Uint8Array([3]));
    expect(channel.data.closed[0]?.reason).toBe("RATE_LIMITED");
  });
});
