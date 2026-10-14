import { describe, expect, it, vi } from "vitest";
import { revalidateAttentionRoute } from "./attention-route.js";
const route = { v: 1 as const, hostId: "host1", attentionId: "a1", sessionId: "s1", turnId: "t1", interactionId: "q1", version: 2, expiresAt: "2026-10-15T01:00:00.000Z" };
const interaction = { interactionId: "q1", sessionId: "s1", turnId: "t1", version: 2, status: "pending", expiresAt: route.expiresAt, responseAvailable: true };
describe("attention click revalidation", () => {
  it("queries current Host/session/interaction before returning a usable route", async () => {
    const loader = { getSession: vi.fn(async () => ({ id: "s1" })), getInteraction: vi.fn(async () => interaction) };
    expect((await revalidateAttentionRoute(route, loader, () => new Date("2026-10-15T00:00:00.000Z"))).status).toBe("ready");
    expect(loader.getSession).toHaveBeenCalledWith("host1", "s1");
    expect(loader.getInteraction).toHaveBeenCalledWith("host1", "s1", "q1");
  });
  it("requeries expired/stale reminders and never submits their old action", async () => {
    const loader = { getSession: vi.fn(async () => ({ id: "s1" })), getInteraction: vi.fn(async () => ({ ...interaction, version: 3 })) };
    expect((await revalidateAttentionRoute(route, loader, () => new Date("2026-10-15T00:00:00.000Z"))).status).toBe("stale");
    expect((await revalidateAttentionRoute(route, loader, () => new Date("2026-10-16T00:00:00.000Z"))).status).toBe("expired");
    expect(loader.getInteraction).toHaveBeenCalledTimes(2);
    expect(Object.keys(loader)).toEqual(["getSession", "getInteraction"]);
  });
  it("marks an earlier turn stale after reading the current active turn", async () => {
    const loader = { getSession: async () => ({ id: "s1", activeTurnId: "new-turn" }), getInteraction: vi.fn(async () => interaction) };
    expect((await revalidateAttentionRoute(route, loader, () => new Date("2026-10-15T00:00:00.000Z"))).status).toBe("stale");
    expect(loader.getInteraction).toHaveBeenCalledOnce();
  });
  it("fails closed on missing interactions, foreign Session facts and extra content payloads", async () => {
    const loader = { getSession: async () => ({ id: "s1" }), getInteraction: async () => undefined };
    expect((await revalidateAttentionRoute(route, loader, () => new Date("2026-10-15T00:00:00.000Z"))).status).toBe("stale");
    await expect(revalidateAttentionRoute(route, { ...loader, getSession: async () => ({ id: "foreign" }) })).rejects.toThrow("ATTENTION_SESSION_MISMATCH");
    await expect(revalidateAttentionRoute({ ...route, prompt: "secret" }, loader)).rejects.toThrow();
  });
});
