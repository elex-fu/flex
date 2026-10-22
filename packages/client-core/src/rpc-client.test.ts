import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionCapability, BOUNDED_CONTENT_CAPABILITY, RecoveryCapability, SESSION_CATALOG_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY } from "@flyx/mvp-protocol";
import { ACCESS_RECEIPTS_CAPABILITY, RpcClient } from "./rpc-client.js";
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

describe("negotiated typed domain RPC", () => {
  async function negotiated(maxFrameBytes = 262_144) {
    const rpc = new RpcClient(); const transport = new TestTransport(1); rpc.bind(transport);
    const pending = rpc.hello({ hostId: "host-a", fingerprint: `sha256:${"a".repeat(64)}` });
    transport.emit({ type: "server.hello", hostId: "host-a", hostFingerprint: `sha256:${"a".repeat(64)}`, protocolVersion: 2, capabilities: [TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY, ACCESS_RECEIPTS_CAPABILITY], leaseId: "lease", heartbeatIntervalMs: 15_000, maxFrameBytes });
    return { rpc, transport, hello: await pending };
  }
  it("saves an immutable hello for this transport and enforces its frame budget", async () => {
    const { rpc, transport, hello } = await negotiated(512);
    expect(transport.sent[0]?.capabilities).toEqual(expect.arrayContaining([TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY, ACCESS_RECEIPTS_CAPABILITY, RecoveryCapability, SESSION_CATALOG_CAPABILITY, INTERACTION_CAPABILITY, STRUCTURED_QUESTION_CAPABILITY, AttentionCapability, CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY, "host-execution-readiness-v1"]));
    for (const capability of [CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, WORKTREE_CAPABILITY, "host-execution-readiness-v1"]) expect(rpc.supports(capability)).toBe(false);
    expect(rpc.supports(RecoveryCapability)).toBe(false); expect(rpc.supports(SESSION_CATALOG_CAPABILITY)).toBe(false); expect(rpc.supports(AttentionCapability)).toBe(false); expect(rpc.supports(INTERACTION_CAPABILITY)).toBe(false); expect(rpc.supports(STRUCTURED_QUESTION_CAPABILITY)).toBe(false);
    hello.capabilities.push("mutated"); rpc.getNegotiatedHello()!.capabilities.push("also-mutated");
    expect(rpc.supports("mutated")).toBe(false); expect(rpc.supports("also-mutated")).toBe(false);
    await expect(rpc.request("host.getStatus", { text: "x".repeat(1024) })).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
    expect(transport.sent).toHaveLength(1);
    rpc.bind(new TestTransport(2)); expect(rpc.getNegotiatedHello()).toBeUndefined(); expect(rpc.supports(TIMELINE_PROJECTION_CAPABILITY)).toBe(false); rpc.unbind();
  });
  it("validates domain responses while preserving the authenticated strict envelope", async () => {
    const { rpc, transport } = await negotiated();
    transport.respond = (frame) => transport.emit({ type: "response", id: frame.id, ok: true, payload: { extra: "invalid-domain-data" } });
    await expect(rpc.openView({ sessionId: "session-a", tailLimit: 50 })).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    expect(transport.sent.at(-1)).toMatchObject({ method: "session.openView", payload: { sessionId: "session-a", tailLimit: 50 }, transportGeneration: 1 });
    expect(transport.closes).toEqual([]); expect(rpc.getNegotiatedHello()?.protocolVersion).toBe(2);
    transport.emit({ type: "event", sessionId: "session-a", event: { id: "event", sessionId: "session-a", sequence: 1, type: "timeline.updated", payload: {}, occurredAt: "now" }, unsolicitedEnvelopeField: true });
    await Promise.resolve(); expect(transport.closes).toContainEqual({ code: 1002, reason: "INVALID_FRAME" }); rpc.unbind();
  });
  it("queries negotiated access receipts with typed identity and state validation", async () => {
    const { rpc, transport } = await negotiated();
    transport.respond = (frame) => transport.emit({ type: "response", id: frame.id, ok: true, payload: { found: true, commandId: "revoke-a", method: "access.revokeDevice", state: "completed", response: { revoked: true }, updatedAt: "now" } });
    expect(await rpc.getAccessReceipt({ commandId: "revoke-a" })).toMatchObject({ found: true, state: "completed" });
    expect(transport.sent.at(-1)).toMatchObject({ method: "access.getReceipt", payload: { commandId: "revoke-a" } });
    expect(transport.sent.at(-1)).not.toHaveProperty("commandId");
    await expect(rpc.getAccessReceipt({ commandId: "other-command" })).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    transport.respond = (frame) => transport.emit({ type: "response", id: frame.id, ok: true, payload: { found: true, commandId: "revoke-a", method: "access.revokeDevice", state: "invented" } });
    await expect(rpc.getAccessReceipt({ commandId: "revoke-a" })).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
    expect(transport.closes).toEqual([]); rpc.unbind();
  });
  it("requires capability negotiation and validates bounded content byte offsets", async () => {
    const rpc = new RpcClient(); rpc.bind(new TestTransport(1));
    expect(() => rpc.openView({ sessionId: "session-a", tailLimit: 50 })).toThrowError(/negotiated/); expect(() => rpc.getAccessReceipt({ commandId: "access-a" })).toThrowError(/negotiated/); rpc.unbind();
    const next = await negotiated();
    next.transport.respond = (frame) => next.transport.emit({ type: "response", id: frame.id, ok: true, payload: { sessionId: "session-a", ref: `cnt_${"a".repeat(32)}`, offset: 0, nextOffset: 3, totalBytes: 3, sha256: "b".repeat(64), format: "text/plain", hasMore: false, encoding: "utf8", text: "abc" } });
    expect(await next.rpc.getContentChunk({ sessionId: "session-a", ref: `cnt_${"a".repeat(32)}`, offset: 0, maxBytes: 64, encoding: "utf8" })).toMatchObject({ text: "abc", nextOffset: 3 });
    next.rpc.unbind();
  });
});
