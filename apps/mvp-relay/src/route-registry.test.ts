import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRelayRouteStore } from "./file-route-store.js";
import { credentialVerifier, MemoryRelayRouteStore, RouteRegistry } from "./route-registry.js";
import { KeyedRateLimiter } from "./rate-limit.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("route registry", () => {
  it("creates 192-bit routes and 256-bit credentials, keeping only the verifier", async () => {
    const store = new MemoryRelayRouteStore();
    const registry = new RouteRegistry({ store, now: () => 42 });
    const first = await registry.create();
    const second = await registry.create();
    expect(Buffer.from(first.routeId, "base64url")).toHaveLength(24);
    expect(Buffer.from(first.relayCredential, "base64url")).toHaveLength(32);
    expect(first.routeId).not.toBe(second.routeId);
    expect(first.relayCredential).not.toBe(second.relayCredential);
    expect(await registry.authenticate(first.routeId, first.relayCredential)).toEqual({ routeId: first.routeId });
    expect(await registry.authenticate(first.routeId, second.relayCredential)).toBeNull();
    expect(await registry.authenticate(second.routeId, first.relayCredential)).toBeNull();
    expect(await registry.authenticate(first.routeId, "short")).toBeNull();
    const record = await store.get(first.routeId);
    expect(record).toEqual({ routeId: first.routeId, credentialHash: await credentialVerifier(first.relayCredential), createdAt: 42 });
    expect(JSON.stringify(record)).not.toContain(first.relayCredential);
    await expect(store.put(record!)).rejects.toThrow("ROUTE_EXISTS");
  });

  it("persists owner-only hash metadata and authenticates the same route after service restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flyx-relay-registry-"));
    temporaryDirectories.push(directory);
    const registry = new RouteRegistry({ store: new FileRelayRouteStore(directory, 1) });
    const registration = await registry.create();
    const entries = await readdir(directory);
    expect(entries).toEqual([`${registration.routeId}.json`]);
    const path = join(directory, entries[0]!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain(registration.relayCredential);
    const restored = new RouteRegistry({ store: new FileRelayRouteStore(directory, 1) });
    expect(await restored.authenticate(registration.routeId, registration.relayCredential)).toEqual({ routeId: registration.routeId });
    await expect(restored.create()).rejects.toThrow("ROUTE_QUOTA_EXCEEDED");
    expect(await restored.get("../secret")).toBeNull();
  });

  it("bounds rate limiter cardinality without evicting active quota state", () => {
    const limiter = new KeyedRateLimiter(2, 1000, 2);
    expect(limiter.consume("one", 0)).toBe(true);
    expect(limiter.consume("one", 0)).toBe(true);
    expect(limiter.consume("one", 0)).toBe(false);
    expect(limiter.consume("two", 0)).toBe(true);
    expect(limiter.consume("three", 0)).toBe(false);
    expect(limiter.consume("three", 1000)).toBe(true);
  });
});
