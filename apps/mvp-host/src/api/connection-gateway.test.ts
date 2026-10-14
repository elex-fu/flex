import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../auth/device-registry.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import { ConnectionGateway, type DuplexTransport } from "./connection-gateway.js";

const HOST_ID = "host-test";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const open: Array<() => void> = [];

afterEach(() => { while (open.length) open.pop()!(); });

class MemoryTransport implements DuplexTransport {
  readonly id = randomUUID();
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly messages = new Set<(frame: string | Uint8Array) => void>();
  private readonly closeHandlers = new Set<(info: { code?: number; reason?: string }) => void>();

  constructor(readonly kind: "direct" | "relay", readonly generation: number) {}

  async send(frame: string | Uint8Array): Promise<void> {
    this.sent.push(JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame)) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    if (this.closes.length) return;
    const info = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    this.closes.push(info);
    for (const handler of this.closeHandlers) handler(info);
  }

  onMessage(handler: (frame: string | Uint8Array) => void): () => void {
    this.messages.add(handler);
    return () => this.messages.delete(handler);
  }

  onClose(handler: (info: { code?: number; reason?: string }) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emit(frame: Record<string, unknown>): void {
    const encoded = JSON.stringify(frame);
    for (const handler of this.messages) handler(encoded);
  }
}

function fixture() {
  const orchestrator = new SessionOrchestrator({ workspace: resolve(process.cwd(), "../../packages/claude-fixtures") });
  const devices = new DeviceRegistry(orchestrator.store, HOST_ID);
  const gateway = new ConnectionGateway({
    hostId: HOST_ID,
    fingerprint: FINGERPRINT,
    orchestrator,
    devices,
    bootstrap: () => ({ stable: true }),
    descriptor: () => ({ hostId: HOST_ID }),
    confirmPairing: () => true,
  });
  open.push(() => { gateway.close(); devices.close(); orchestrator.close(); });
  return { devices, gateway };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

function hello(generation: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "client.hello",
    clientId: "client-test",
    hostId: HOST_ID,
    protocol: { min: 2, max: 2 },
    capabilities: [],
    transportGeneration: generation,
    ...extra,
  };
}

describe("ConnectionGateway integration contract", () => {
  it("keeps v1 Direct requests compatible without adding generation fields", async () => {
    const { devices, gateway } = fixture();
    const device = devices.createBrowserDevice();
    const transport = new MemoryTransport("direct", 0);
    gateway.attach(transport, { deviceId: device.id });

    transport.emit({ type: "request", id: "v1-bootstrap", method: "host.bootstrap", payload: {} });
    await settle();

    expect(transport.sent).toContainEqual({ type: "response", id: "v1-bootstrap", ok: true, payload: { stable: true } });
    expect(transport.sent[0]).not.toHaveProperty("transportGeneration");
    expect(transport.closes).toEqual([]);
  });

  it("negotiates v2 generation and fences stale frames", async () => {
    const { devices, gateway } = fixture();
    const device = devices.createBrowserDevice();
    const transport = new MemoryTransport("direct", 3);
    gateway.attach(transport, { deviceId: device.id });

    transport.emit(hello(9, { deviceId: device.id }));
    await settle();
    expect(transport.sent[0]).toMatchObject({ type: "server.hello", protocolVersion: 2, transportGeneration: 9 });

    transport.emit({ type: "request", id: "stale", method: "host.bootstrap", payload: {}, transportGeneration: 8 });
    await settle();
    expect(transport.closes).toContainEqual({ code: 1008, reason: "STALE_GENERATION" });
    expect(transport.sent).toHaveLength(1);
  });

  it("returns an explicit negotiation error before closing incompatible clients", async () => {
    const { gateway } = fixture();
    const transport = new MemoryTransport("relay", 1);
    gateway.attach(transport);

    transport.emit(hello(4, { protocol: { min: 3, max: 3 } }));
    await settle();

    expect(transport.sent).toEqual([{
      type: "protocol.error",
      error: { code: "PROTOCOL_INCOMPATIBLE", message: "No mutually supported protocol version", retryable: false },
    }]);
    expect(transport.closes).toEqual([{ code: 1002, reason: "PROTOCOL_INCOMPATIBLE" }]);
  });

  it("supports Relay NK pairing and hash-fenced refresh rotation", async () => {
    const { devices, gateway } = fixture();
    const grant = devices.createPairingGrant();
    const firstKey = Buffer.alloc(32, 1).toString("base64url");
    const secondKey = Buffer.alloc(32, 2).toString("base64url");
    const pairedTransport = new MemoryTransport("relay", 1);
    gateway.attach(pairedTransport);
    pairedTransport.emit(hello(1));
    pairedTransport.emit({
      type: "request", id: "pair", method: "access.pair", commandId: "pair-command",
      payload: { grant: grant.grant, proposedDevicePublicKey: firstKey }, transportGeneration: 1,
    });
    await settle();
    const paired = pairedTransport.sent.find((frame) => frame.type === "response") as { payload: { deviceId: string; refreshCredential: string } };
    expect(paired.payload.deviceId).toEqual(expect.any(String));
    expect(paired.payload.refreshCredential).toEqual(expect.any(String));

    const refreshTransport = new MemoryTransport("relay", 2);
    gateway.attach(refreshTransport);
    refreshTransport.emit(hello(2));
    refreshTransport.emit({
      type: "request", id: "refresh", method: "access.refresh", commandId: "refresh-command",
      payload: { refreshCredential: paired.payload.refreshCredential, proposedDevicePublicKey: secondKey }, transportGeneration: 2,
    });
    await settle();
    const refreshed = refreshTransport.sent.find((frame) => frame.type === "response") as { payload: { deviceId: string; refreshCredential: string } };
    expect(refreshed.payload.deviceId).toBe(paired.payload.deviceId);
    expect(refreshed.payload.refreshCredential).not.toBe(paired.payload.refreshCredential);
    expect(() => devices.authenticateRefreshCredential(paired.payload.refreshCredential)).toThrowError(/invalid or expired/i);
  });
});
