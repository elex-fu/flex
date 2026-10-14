import { describe, expect, it } from "vitest";
import { AttentionRouteSchema, AttentionRegisterPushRequestSchema, AttentionSetPreferencesRequestSchema, ATTENTION_MAX_PAYLOAD_BYTES } from "./attention-api.js";
describe("attention protocol privacy", () => {
  it("permits only routing identifiers/version/expiry", () => {
    const route = { v: 1, hostId: "h", attentionId: "a", sessionId: "s", version: 1, expiresAt: "2026-10-15T00:00:00.000Z" };
    expect(AttentionRouteSchema.safeParse(route).success).toBe(true);
    for (const key of ["prompt", "reason", "body", "diff", "path", "action"])
      expect(AttentionRouteSchema.safeParse({ ...route, [key]: "private" }).success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(AttentionRouteSchema.parse(route)))).toBeLessThan(ATTENTION_MAX_PAYLOAD_BYTES);
  });
  it("keeps actor identity out of registration and uses preference revision CAS", () => {
    const registration = { platform: "expo", tokenType: "expo", token: "ExpoPushToken[token]", projectId: "b5b3b486-c5df-4352-a31c-1c6cfcc5b897" };
    expect(AttentionRegisterPushRequestSchema.safeParse(registration).success).toBe(true);
    expect(AttentionRegisterPushRequestSchema.safeParse({ ...registration, deviceId: "other" }).success).toBe(false);
    expect(AttentionSetPreferencesRequestSchema.safeParse({ mode: "all", pushEnabled: false }).success).toBe(false);
  });
});
