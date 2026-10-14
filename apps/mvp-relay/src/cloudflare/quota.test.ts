import { describe, expect, it } from "vitest";
import { bearerCredential, isAllowedOrigin, isSecureRequest, sameSecret, secureHeaders } from "./http.js";
import { RelayQuotaObject } from "./quota.js";
import type { RelayEnvironment } from "./runtime.js";
import { MemoryState } from "./test-support.js";

function env(values: Partial<RelayEnvironment> = {}): RelayEnvironment {
  const namespace = { idFromName: (name: string) => name, get: () => { throw new Error("unused"); } };
  return { RELAY_ROOMS: namespace, RELAY_QUOTAS: namespace, ...values };
}

const consume = (kind = "connect-ip") => new Request("https://quota.internal/consume", {
  method: "POST", body: JSON.stringify({ kind }),
});

describe("Cloudflare persistent quotas", () => {
  it("serializes a concurrent burst, survives hibernation, and expires its metadata", async () => {
    let now = 1_000_000;
    const state = new MemoryState();
    const config = env({ RELAY_MAX_CONNECTS_PER_IP_MINUTE: "3" });
    let limiter = new RelayQuotaObject(state, config, () => now);
    const burst = await Promise.all(Array.from({ length: 12 }, () => limiter.fetch(consume())));
    expect(burst.filter((response) => response.status === 200)).toHaveLength(3);
    expect(burst.filter((response) => response.status === 429)).toHaveLength(9);
    limiter = new RelayQuotaObject(state, config, () => now);
    const rejected = await limiter.fetch(consume());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("60");
    now += 60_000;
    await limiter.alarm();
    expect(state.storage.values.size).toBe(0);
    expect(state.storage.alarm).toBeNull();
    expect((await limiter.fetch(consume())).status).toBe(200);
  });

  it("keeps IP creation and global creation quotas independent and bounded", async () => {
    const state = new MemoryState();
    const limiter = new RelayQuotaObject(state, env({ RELAY_MAX_CREATES_PER_IP_HOUR: "1", RELAY_MAX_CREATES_PER_DAY: "2" }));
    expect((await limiter.fetch(consume("register-ip"))).status).toBe(200);
    expect((await limiter.fetch(consume("register-ip"))).status).toBe(429);
    expect((await limiter.fetch(consume("register-global"))).status).toBe(200);
    expect((await limiter.fetch(consume("register-global"))).status).toBe(200);
    expect((await limiter.fetch(consume("register-global"))).status).toBe(429);
    expect((await limiter.fetch(consume("arbitrary-attacker-key"))).status).toBe(400);
    expect(state.storage.values.size).toBe(1);
  });
});

describe("Cloudflare HTTP boundary", () => {
  it("only permits configured exact secure browser origins and explicit loopback HTTP", () => {
    const config = env({ RELAY_ALLOWED_ORIGINS: "https://app.flyx.example,http://localhost:5173" });
    expect(isAllowedOrigin(null, config)).toBe(true);
    expect(isAllowedOrigin("https://app.flyx.example", config)).toBe(true);
    expect(isAllowedOrigin("https://app.flyx.example.evil.test", config)).toBe(false);
    expect(isAllowedOrigin("null", config)).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", config)).toBe(false);
    config.RELAY_ALLOW_INSECURE_LOCAL = "true";
    expect(isAllowedOrigin("http://localhost:5173", config)).toBe(true);
    expect(isSecureRequest(new URL("http://relay.example"), config)).toBe(false);
  });

  it("does not accept query credentials or ambiguous authorization", async () => {
    const value = "a".repeat(43);
    expect(bearerCredential(new Request(`https://relay.example/?token=${value}`))).toBeNull();
    expect(bearerCredential(new Request("https://relay.example", { headers: { Authorization: `Bearer ${value}, Bearer ${value}` } }))).toBeNull();
    expect(bearerCredential(new Request("https://relay.example", { headers: { Authorization: `Bearer ${value}` } }))).toBe(value);
    expect(await sameSecret(value, value)).toBe(true);
    expect(await sameSecret(value, "b".repeat(43))).toBe(false);
    expect(secureHeaders().get("Cache-Control")).toBe("no-store");
    expect(secureHeaders().get("Referrer-Policy")).toBe("no-referrer");
  });
});
