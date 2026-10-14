import { describe, expect, it, vi } from "vitest";
import { AttentionClient } from "./attention-client.js";
describe("typed attention client", () => {
  it("binds returned routing metadata to its Host/session and rejects response actor mixing", async () => {
    const item = { v: 1, hostId: "host1", attentionId: "a", sessionId: "s", version: 1, expiresAt: "2026-10-16T00:00:00.000Z", kind: "completion", createdAt: "2026-10-15T00:00:00.000Z", acknowledged: false, stale: false, deliveryState: "none" };
    const request = vi.fn(async () => ({ items: [item], nextAfter: 1, hasMore: false, unavailable: true }));
    const client = new AttentionClient({ hostId: "host1", request });
    expect((await client.list({ sessionId: "s" })).items).toHaveLength(1);
    request.mockImplementation(async () => ({ items: [{ ...item, hostId: "foreign" }], nextAfter: 1, hasMore: false, unavailable: true }));
    await expect(client.list()).rejects.toThrow("ATTENTION_HOST_OR_SESSION_MISMATCH");
  });
  it("carries command IDs separately and checks acknowledgement/preference resource versions", async () => {
    const request = vi.fn(async (method: string) => method === "attention.acknowledge" ? { attentionId: "a", version: 1, acknowledged: true, stale: true } : { mode: "all", pushEnabled: true, revision: 1 });
    const client = new AttentionClient({ hostId: "host1", request });
    expect((await client.acknowledge({ attentionId: "a", expectedVersion: 1 }, "command-1")).stale).toBe(true);
    expect(request).toHaveBeenCalledWith("attention.acknowledge", { attentionId: "a", expectedVersion: 1 }, "command-1");
    await expect(client.setPreferences({ mode: "all", pushEnabled: true, expectedRevision: 2 })).rejects.toThrow("ATTENTION_PREFERENCES_RESPONSE_INVALID");
  });
});
