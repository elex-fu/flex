import { describe, expect, it, vi } from "vitest";
import { EXPO_PUSH_SEND_ENDPOINT, EXPO_PUSH_RECEIPT_ENDPOINT, ExpoAttentionDriver, DisabledAttentionDriver } from "./delivery-driver.js";
import type { PushSubscription } from "./store.js";
const projectId = "b5b3b486-c5df-4352-a31c-1c6cfcc5b897";
const sub: PushSubscription = { id: "sub", host_id: "host", device_id: "device", platform: "expo", token: "ExpoPushToken[device]", token_hash: "hash", project_id: projectId, created_at: "2026-10-15T00:00:00.000Z", expires_at: "2026-10-16T00:00:00.000Z", revoked_at: null };
const route = { v: 1 as const, hostId: "host", attentionId: "attention", sessionId: "session", interactionId: "interaction", turnId: "turn", version: 2, expiresAt: "2026-10-15T01:00:00.000Z" };
describe("configured Expo attention driver", () => {
  it("does not send with a disabled sink or unpinned destination", async () => {
    const fetch = vi.fn();
    const driver = new ExpoAttentionDriver({ enabled: false, endpoint: EXPO_PUSH_SEND_ENDPOINT, projectId, fetch });
    expect(await driver.send(sub, route)).toEqual({ status: "unavailable", code: "PUSH_SINK_UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new ExpoAttentionDriver({ enabled: true, endpoint: "https://attacker.example/push", projectId })).toThrow("PUSH_CONFIGURATION_INVALID");
    expect(() => new ExpoAttentionDriver({ enabled: true, endpoint: EXPO_PUSH_SEND_ENDPOINT, projectId: "-".repeat(36) })).toThrow("PUSH_CONFIGURATION_INVALID");
    expect(await new DisabledAttentionDriver().send()).toEqual({ status: "unavailable", code: "PUSH_SINK_UNAVAILABLE" });
  });
  it("sends data-only routing and reports ticket acceptance separately from provider handoff", async () => {
    const calls: Array<{
      url: string;
      body: unknown;
    }> = [];
    const fetch = vi.fn(async (url: unknown, options: RequestInit | undefined) => {
      calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return new Response(JSON.stringify(String(url) === EXPO_PUSH_SEND_ENDPOINT ? { data: { status: "ok", id: "receipt-1" } } : { data: { "receipt-1": { status: "ok" } } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const driver = new ExpoAttentionDriver({ enabled: true, endpoint: EXPO_PUSH_SEND_ENDPOINT, projectId, fetch, now: () => new Date("2026-10-15T00:00:00.000Z") });
    expect(await driver.send(sub, route)).toEqual({ status: "accepted", receiptId: "receipt-1", code: "PUSH_SERVICE_ACCEPTED" });
    const message = calls[0]!.body as Record<string, unknown>;
    expect(message.data).toEqual(route);
    expect(message).not.toHaveProperty("title");
    expect(message).not.toHaveProperty("body");
    expect(message).not.toHaveProperty("reason");
    expect(await driver.inspectReceipt(sub, "receipt-1")).toEqual({ status: "provider_delivered", code: "PUSH_PROVIDER_HANDOFF" });
    expect(calls[1]?.url).toBe(EXPO_PUSH_RECEIPT_ENDPOINT);
  });
  it("keeps network uncertainty unknown and rejects unauthorized project/expired metadata", async () => {
    const fetch = vi.fn(async () => { throw new Error("secret account token"); }) as unknown as typeof globalThis.fetch;
    const driver = new ExpoAttentionDriver({ enabled: true, endpoint: EXPO_PUSH_SEND_ENDPOINT, projectId, fetch, now: () => new Date("2026-10-15T00:00:00.000Z") });
    expect(await driver.send(sub, route)).toEqual({ status: "outcome_unknown", code: "PUSH_DISPATCH_UNCONFIRMED" });
    expect(await driver.send({ ...sub, project_id: "other" }, route)).toEqual({ status: "unavailable", code: "PUSH_SUBSCRIPTION_INVALID" });
    expect(await driver.send(sub, { ...route, expiresAt: "2026-10-14T00:00:00.000Z" })).toEqual({ status: "unavailable", code: "ATTENTION_EXPIRED" });
    await expect(driver.send(sub, { ...route, prompt: "secret" } as typeof route)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("handles invalid registrations, rate limiting and bounded response bodies honestly", async () => {
    let mode = 0;
    const fetch = vi.fn(async () => {
      mode++;
      return mode === 1 ? new Response("", { status: 429 }) : mode === 2 ? new Response(JSON.stringify({ data: { status: "error", details: { error: "DeviceNotRegistered" }, message: "private raw reason" } })) : new Response("s".repeat(20000));
    }) as unknown as typeof globalThis.fetch;
    const driver = new ExpoAttentionDriver({ enabled: true, endpoint: EXPO_PUSH_SEND_ENDPOINT, projectId, fetch, now: () => new Date("2026-10-15T00:00:00.000Z") });
    expect((await driver.send(sub, route)).status).toBe("retryable");
    expect(await driver.send(sub, route)).toEqual({ status: "unavailable", code: "PUSH_DEVICE_UNREGISTERED", invalidateSubscription: true });
    expect((await driver.send(sub, route)).status).toBe("outcome_unknown");
  });
});
