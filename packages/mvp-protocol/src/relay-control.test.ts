import { describe, expect, it } from "vitest";
import {
  MAX_RELAY_CONTROL_FRAME_BYTES, RelayDataMessageSchema, RouteRegistrationSchema,
  buildRelayRegistrationUrl, buildRelaySocketUrl, encodeRelayControlMessage, encodeRelayDataMessage,
  parseRelayControlMessage, parseRelayDataMessage, parseRelaySocketUrl,
} from "./index.js";

const routeId = "a".repeat(32);
const connectionId = "b".repeat(32);

describe("opaque Relay envelopes", () => {
  it("round trips control/data envelopes and cumulative binary ACKs", () => {
    const registered = { type: "registered" as const, connectionIds: [connectionId], generation: 4 };
    expect(parseRelayControlMessage(encodeRelayControlMessage(registered))).toEqual(registered);
    const paired = { type: "data.paired" as const, connectionId, generation: 4 };
    expect(parseRelayDataMessage(encodeRelayDataMessage(paired))).toEqual(paired);
    const ack = encodeRelayDataMessage({ type: "ack", sequence: 12 });
    expect(ack).toBe('{"type":"ack","sequence":12}');
    expect(parseRelayDataMessage(ack)).toEqual({ type: "ack", sequence: 12 });
    expect(() => parseRelayDataMessage(new TextEncoder().encode(ack) as unknown as string)).toThrow(/text frame/);
    expect(RelayDataMessageSchema.safeParse({ type: "ack", sequence: 0 }).success).toBe(false);
    for (const sequence of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(RelayDataMessageSchema.safeParse({ type: "ack", sequence }).success).toBe(false);
    }
  });

  it("does not accept application data in Relay control envelopes", () => {
    expect(() => parseRelayControlMessage('{"type":"request","id":"1","method":"session.startTurn","payload":{"prompt":"secret"}}')).toThrow(/invalid shape/);
    expect(() => parseRelayControlMessage(JSON.stringify({ type: "ping", nonce: "ping-1", payload: { prompt: "secret" } }))).toThrow(/invalid shape/);
    expect(() => parseRelayDataMessage(JSON.stringify({ type: "ack", sequence: 1, application: true }))).toThrow(/invalid shape/);
    expect(() => parseRelayControlMessage(" ".repeat(MAX_RELAY_CONTROL_FRAME_BYTES + 1))).toThrow(/byte limit/);
  });

  it("builds and parses role-specific route paths without leaking credentials", () => {
    const client = { role: "client" as const, routeId };
    const control = { role: "control" as const, routeId, generation: 2 };
    const data = { role: "data" as const, routeId, connectionId, generation: 2 };
    for (const target of [client, control, data]) {
      const url = buildRelaySocketUrl("wss://relay.example", target);
      expect(parseRelaySocketUrl(url)).toEqual(target);
      expect(parseRelaySocketUrl(url.replace("wss:", "https:"))).toEqual(target);
    }
    expect(buildRelayRegistrationUrl("wss://relay.example")).toBe("https://relay.example/v1/routes");
    expect(RouteRegistrationSchema.parse({ v: 1, routeId, relayCredential: "c".repeat(43) })).toMatchObject({ routeId });
  });

  it("rejects role confusion, stale/ambiguous generation syntax and secret-bearing paths", () => {
    for (const url of [
      `wss://relay.example/v1/routes/${routeId}/control`,
      `wss://relay.example/v1/routes/${routeId}/control?generation=0`,
      `wss://relay.example/v1/routes/${routeId}/control?generation=01`,
      `wss://relay.example/v1/routes/${routeId}/control?generation=9007199254740992`,
      `wss://relay.example/v1/routes/${routeId}/control?generation=1&generation=2`,
      `wss://relay.example/v1/routes/${routeId}/client?credential=secret`,
      `wss://relay.example/v1/routes/${routeId}/data?generation=1`,
      `wss://relay.example/v1/routes/${routeId}/control/${connectionId}?generation=1`,
      `ws://relay.example/v1/routes/${routeId}/client`,
    ]) expect(() => parseRelaySocketUrl(url)).toThrow();
  });

  it("accepts only canonical 192-bit routes and 256-bit credentials", () => {
    expect(RouteRegistrationSchema.safeParse({ v: 1, routeId: "r".repeat(31), relayCredential: "c".repeat(43) }).success).toBe(false);
    expect(RouteRegistrationSchema.safeParse({ v: 1, routeId, relayCredential: `${"c".repeat(42)}_` }).success).toBe(false);
  });
});
