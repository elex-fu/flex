import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "./rpc-client.js";
import { TestTransport } from "./test-support.js";

afterEach(() => vi.useRealTimers());
describe("generation-fenced RPC", () => {
  it("ignores old transport responses/events after failover and preserves command ID", async () => {
    const rpc = new RpcClient();
    const first = new TestTransport(1);
    const next = new TestTransport(2, "relay");
    const events: unknown[] = [];
    rpc.onEvent((event) => events.push(event));
    rpc.bind(first);
    const abandoned = rpc.request("session.startTurn", { prompt: "once" }, "stable-command");
    const rejection = expect(abandoned).rejects.toMatchObject({ code: "CONNECTION_REPLACED" });
    rpc.bind(next);
    await rejection;
    const active = rpc.request("host.getStatus");
    const activeId = next.sent[0]!.id;
    first.emit({ type: "response", id: activeId, ok: true, payload: "wrong", transportGeneration: 2 });
    first.emit({ type: "event", sessionId: "session-a", event: { id: "event-a", sessionId: "session-a", sequence: 1, type: "turn.started", payload: {}, occurredAt: "now" }, transportGeneration: 2 });
    next.emit({ type: "response", id: activeId, ok: true, payload: "current" });
    expect(await active).toBe("current");
    expect(events).toEqual([]);
    expect(first.sent[0]?.commandId).toBe("stable-command");
    expect(first.sent[0]?.transportGeneration).toBe(1);
    rpc.unbind();
  });

  it("rejects open requests on close and reports bounded timeout", async () => {
    vi.useFakeTimers();
    const rpc = new RpcClient(200);
    const transport = new TestTransport(1);
    rpc.bind(transport);
    const timed = rpc.request("host.getStatus");
    const timeout = expect(timed).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(200);
    await timeout;
    const pending = rpc.request("host.getSnapshot");
    const closed = expect(pending).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    transport.disconnect();
    await closed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects mismatched hello identity and propagates protocol authentication failure", async () => {
    const rpc = new RpcClient();
    const transport = new TestTransport(3);
    const fingerprint = `sha256:${"a".repeat(64)}`;
    rpc.bind(transport);
    const negotiating = rpc.hello({ hostId: "host-a", fingerprint });
    transport.emit({ type: "server.hello", hostId: "host-b", hostFingerprint: fingerprint, protocolVersion: 2, capabilities: [], leaseId: "lease", heartbeatIntervalMs: 15_000, maxFrameBytes: 262_144 });
    await expect(negotiating).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    const second = rpc.hello({ hostId: "host-a", fingerprint });
    transport.emit({ type: "protocol.error", error: { code: "DEVICE_REVOKED", message: "revoked", retryable: false } });
    await expect(second).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    expect(transport.closes).toContainEqual({ code: 1002, reason: "PROTOCOL_ERROR" });
  });
});
