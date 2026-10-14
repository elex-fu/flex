import { describe, expect, it } from "vitest";
import {
  ApplicationFrameSchema, ClientHelloV2Schema, FrameSchema, MAX_APPLICATION_FRAME_BYTES,
  ProtocolFrameError, buildNoisePrologue, encodeApplicationFrame, negotiateCapabilities,
  negotiateProtocolVersion, parseApplicationFrame,
} from "./index.js";

describe("application protocol version 2", () => {
  const request = {
    type: "request" as const, id: "request-1", method: "host.getSnapshot", payload: {}, transportGeneration: 3,
  };

  it("round trips requests, responses, events and heartbeats with a generation fence", () => {
    const frames = [
      request,
      { type: "response", id: "request-1", ok: true, payload: { hostId: "host-1" }, transportGeneration: 3 },
      { type: "response", id: "request-1", ok: false, error: { code: "REVOKED", message: "Access revoked", retryable: false }, transportGeneration: 3 },
      { type: "event", sessionId: "session-1", event: {
        id: "event-1", sessionId: "session-1", sequence: 1, type: "turn.started", payload: {}, occurredAt: "2026-09-08T10:00:00Z",
      }, transportGeneration: 3 },
      { type: "ping", nonce: "ping-1", transportGeneration: 3 },
      { type: "pong", nonce: "ping-1", transportGeneration: 3 },
    ];
    for (const frame of frames) {
      const valid = ApplicationFrameSchema.parse(frame);
      expect(parseApplicationFrame(new TextEncoder().encode(encodeApplicationFrame(valid)))).toEqual(valid);
    }
  });

  it("preserves legacy Direct frames without letting them bypass v2 checks", () => {
    const legacy = { type: "request", id: "legacy", method: "session.startTurn", payload: { prompt: "hello" }, commandId: "command-1" };
    expect(FrameSchema.parse(legacy)).toEqual(legacy);
    expect(FrameSchema.safeParse({ ...legacy, transportGeneration: 3 }).success).toBe(false);
    expect(FrameSchema.safeParse({ ...legacy, extra: "not allowed" }).success).toBe(false);
    expect(() => parseApplicationFrame(JSON.stringify(legacy))).toThrow(ProtocolFrameError);
    expect(() => parseApplicationFrame(JSON.stringify({ ...request, extra: "not allowed" }))).toThrow(ProtocolFrameError);
    expect(() => parseApplicationFrame(JSON.stringify({ ...request, transportGeneration: -1 }))).toThrow(ProtocolFrameError);
  });

  it("rejects stale-shape events whose outer and inner session IDs disagree", () => {
    expect(ApplicationFrameSchema.safeParse({
      type: "event", sessionId: "session-1", transportGeneration: 2,
      event: { id: "event-1", sessionId: "other-session", sequence: 1, type: "turn.started", payload: {}, occurredAt: "now" },
    }).success).toBe(false);
  });

  it("measures the 256 KiB limit in UTF-8 bytes at both encode and parse", () => {
    const small = { ...request, payload: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(small)).byteLength;
    const exact = { ...small, payload: "x".repeat(MAX_APPLICATION_FRAME_BYTES - overhead) };
    expect(new TextEncoder().encode(encodeApplicationFrame(exact)).byteLength).toBe(MAX_APPLICATION_FRAME_BYTES);
    expect(parseApplicationFrame(JSON.stringify(exact))).toEqual(exact);
    expect(() => encodeApplicationFrame({ ...exact, payload: `${exact.payload}x` })).toThrow(/byte limit/);
    expect(() => parseApplicationFrame(JSON.stringify({ ...request, payload: "界".repeat(100_000) }))).toThrow(/byte limit/);
  });

  it("fails invalid JSON and UTF-8 without echoing secrets", () => {
    for (const wire of ["{secret-grant", new Uint8Array([0xff, 0xfe])]) {
      expect(() => parseApplicationFrame(wire)).toThrow("Protocol frame is not valid JSON UTF-8");
    }
  });

  it("requires a valid hello and fails unsupported required capabilities", () => {
    const hello = {
      type: "client.hello", clientId: "client-1", hostId: "host-1", protocol: { min: 1, max: 2 },
      capabilities: ["devices", "relay"], requiredCapabilities: ["relay"], transportGeneration: 1,
    };
    expect(ClientHelloV2Schema.parse(hello)).toEqual(hello);
    expect(ClientHelloV2Schema.safeParse({ ...hello, requiredCapabilities: ["unknown"] }).success).toBe(false);
    expect(ClientHelloV2Schema.safeParse({ ...hello, capabilities: ["relay", "relay"] }).success).toBe(false);
    expect(negotiateProtocolVersion({ min: 1, max: 2 })).toBe(2);
    expect(negotiateProtocolVersion({ min: 1, max: 1 })).toBe(1);
    expect(() => negotiateProtocolVersion({ min: 3, max: 4 })).toThrow(/No mutually/);
    expect(negotiateCapabilities(["devices", "relay"], ["devices"])).toEqual(["devices"]);
    expect(() => negotiateCapabilities(["devices", "relay"], ["devices"], ["relay"])).toThrow(/required capability/);
  });

  it("binds every Noise prologue field unambiguously", () => {
    const binding = { hostId: "host-1", routeId: "_".repeat(32), connectionId: "-".repeat(16), protocol: { min: 1, max: 2 } };
    const baseline = buildNoisePrologue(binding);
    expect(new TextDecoder().decode(baseline)).toBe(JSON.stringify(["flyx-relay-v1", "host-1", binding.routeId, binding.connectionId, 1, 2]));
    expect(buildNoisePrologue({ ...binding, connectionId: "connection-number-2" })).not.toEqual(baseline);
    expect(buildNoisePrologue({ ...binding, protocol: { min: 2, max: 2 } })).not.toEqual(baseline);
  });
});
