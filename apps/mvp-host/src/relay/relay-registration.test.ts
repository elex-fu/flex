import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadOrRegisterRelayRoute, normalizeRelayUrl, readRelayRegistration, reserveRelayGeneration, type RelayIdentityPin } from "./relay-registration.js";

import { OperationSnapshotLane } from "../operations/host-operations.js";
import { settlePromises } from "./relay-test-support.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const pin: RelayIdentityPin = { hostId: "original-host", fingerprint: "original-fingerprint" };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function registrationPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flyx-relay-registration-"));
  directories.push(directory);
  return join(directory, "relay-registration.json");
}
function remoteReply() { return { v: 1, routeId: randomBytes(24).toString("base64url"), relayCredential: randomBytes(32).toString("base64url") }; }

describe("Host Relay private registration", () => {
  it("registers once over HTTPS with a bearer header and persists a private durable route", async () => {
    const path = await registrationPath();
    const reply = remoteReply();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(reply), { status: 201 }));
    const options = { relayUrl: "wss://relay.example", registrationPath: path, fetch, registrationToken: "MANAGED_SECRET" };
    const route = await loadOrRegisterRelayRoute(options);
    expect(route).toMatchObject(reply);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const call = fetch.mock.calls[0]!;
    expect(String(call[0])).toBe("https://relay.example/v1/routes");
    expect(call[1]).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer MANAGED_SECRET" } });
    expect(await loadOrRegisterRelayRoute(options)).toEqual(route);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(directories[0]!)).toEqual(["relay-registration.json"]);
    expect(await readFile(path, "utf8")).not.toContain("MANAGED_SECRET");
  });

  it("persists monotonic generations across restart and a backwards wall clock", async () => {
    const path = await registrationPath();
    const route = await loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(remoteReply()))) });
    const first = await reserveRelayGeneration(path, route, 10_000);
    const second = await reserveRelayGeneration(path, first, 5_000);
    expect(first.generation).toBe(10_000);
    expect(second.generation).toBe(10_001);
    expect((await readRelayRegistration(path, route.relayUrl))?.generation).toBe(10_001);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("serializes simultaneous startup and generation reservation for a shared Host path", async () => {
    const path = await registrationPath();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify(remoteReply())));
    const options = { relayUrl: "wss://relay.example", registrationPath: path, fetch };
    const routes = await Promise.all([loadOrRegisterRelayRoute(options), loadOrRegisterRelayRoute(options)]);
    expect(routes[0]).toEqual(routes[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const generations = await Promise.all([reserveRelayGeneration(path, routes[0]!, 100), reserveRelayGeneration(path, routes[1]!, 100)]);
    expect(generations.map((route) => route.generation)).toEqual([100, 101]);
  });

  it("refuses an exposed, redirected, malformed, or substituted private file", async () => {
    const path = await registrationPath();
    const route = await loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(remoteReply()))) });
    await expect(readRelayRegistration(path, "wss://other.example")).rejects.toMatchObject({ code: "RELAY_REGISTRATION_URL_MISMATCH" });
    await chmod(path, 0o644);
    await expect(readRelayRegistration(path, route.relayUrl)).rejects.toMatchObject({ code: "RELAY_REGISTRATION_PERMISSIONS" });
    await chmod(path, 0o600);
    const link = join(directories[0]!, "linked-secret.json");
    await symlink(path, link);
    await expect(readRelayRegistration(link, route.relayUrl)).rejects.toMatchObject({ code: "RELAY_REGISTRATION_UNREADABLE" });
    await writeFile(path, "{broken", { mode: 0o600 });
    await expect(readRelayRegistration(path, route.relayUrl)).rejects.toMatchObject({ code: "RELAY_REGISTRATION_INVALID" });
  });

  it("does not create a secret file or echo the remote body on failed registration", async () => {
    const path = await registrationPath();
    await expect(loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("SECRET_ERROR_BODY", { status: 403 })) }))
      .rejects.toMatchObject({ message: "RELAY_REGISTRATION_DENIED" });
    expect(await readdir(directories[0]!)).toEqual([]);
    await expect(loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(" ".repeat(64 * 1024 + 1))) }))
      .rejects.toMatchObject({ code: "RELAY_REGISTRATION_RESPONSE_TOO_LARGE" });
  });

  it("uses the shared lane for local work and releases it throughout network registration", async () => {
    const path = await registrationPath();
    const lane = new OperationSnapshotLane(() => {});
    const releaseLane = deferred(), laneEntered = deferred();
    const occupied = lane.withSnapshot(async () => { laneEntered.resolve(); await releaseLane.promise; });
    await laneEntered.promise;
    const networkEntered = deferred(), reply = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { networkEntered.resolve(); return reply.promise; });
    const readCurrent = vi.fn(() => pin);
    const options = { relayUrl: "wss://relay.example", registrationPath: path, fetch, withSnapshot: lane.withSnapshot, identity: { expected: pin, readCurrent } };
    const pending = loadOrRegisterRelayRoute(options);
    await settlePromises();
    expect(fetch).not.toHaveBeenCalled();
    expect(readCurrent).not.toHaveBeenCalled();
    releaseLane.resolve(); await occupied; await networkEntered.promise;
    await expect(lane.withSnapshot(async () => "backup-entered")).resolves.toBe("backup-entered");
    reply.resolve(new Response(JSON.stringify(remoteReply())));
    const route = await pending;
    const reserved = await Promise.all([reserveRelayGeneration(path, route, 100, options), reserveRelayGeneration(path, route, 100, options)]);
    expect(reserved.map((item) => item.generation)).toEqual([100, 101]);
    expect((await readRelayRegistration(path, route.relayUrl, options))?.generation).toBe(101);
  });

  it("rechecks the original identity after HTTP and before any route publication", async () => {
    const path = await registrationPath(), lane = new OperationSnapshotLane(() => {});
    const entered = deferred(), reply = deferred<Response>();
    const expected = { ...pin }; let current = { ...pin };
    const pending = loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path, withSnapshot: lane.withSnapshot,
      identity: { expected, readCurrent: () => current },
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { entered.resolve(); return reply.promise; }) });
    await entered.promise;
    await lane.withSnapshot(async () => { current = { hostId: "rotated-host", fingerprint: "rotated-fingerprint" }; Object.assign(expected, current); });
    reply.resolve(new Response(JSON.stringify(remoteReply())));
    await expect(pending).rejects.toMatchObject({ code: "RELAY_IDENTITY_CHANGED", message: "RELAY_IDENTITY_CHANGED" });
    expect(await readdir(directories[0]!)).toEqual([]);
  });

  it("refuses a cached route and generation reservation after identity drift", async () => {
    const path = await registrationPath(), lane = new OperationSnapshotLane(() => {});
    let current = pin;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(remoteReply())));
    const options = { relayUrl: "wss://relay.example", registrationPath: path, fetch, withSnapshot: lane.withSnapshot,
      identity: { expected: pin, readCurrent: () => current } };
    const route = await loadOrRegisterRelayRoute(options), before = await readFile(path, "utf8");
    await lane.withSnapshot(async () => { current = { ...pin, fingerprint: "rotated-fingerprint" }; });
    await expect(loadOrRegisterRelayRoute(options)).rejects.toMatchObject({ code: "RELAY_IDENTITY_CHANGED" });
    await expect(reserveRelayGeneration(path, route, 100, options)).rejects.toMatchObject({ code: "RELAY_IDENTITY_CHANGED" });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a queued publication without late identity reads or a private file", async () => {
    const path = await registrationPath(), lane = new OperationSnapshotLane(() => {}), abort = new AbortController();
    const entered = deferred(), reply = deferred<Response>(), queued = deferred();
    let entries = 0;
    const readCurrent = vi.fn(() => pin);
    const pending = loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path, signal: abort.signal,
      withSnapshot: <T>(work: () => Promise<T>) => { entries += 1; if (entries === 2) queued.resolve(); return lane.withSnapshot(work); },
      identity: { expected: pin, readCurrent },
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { entered.resolve(); return reply.promise; }) });
    const outcome = pending.catch((error: unknown) => error);
    await entered.promise;
    const release = deferred(), laneEntered = deferred();
    const occupied = lane.withSnapshot(async () => { laneEntered.resolve(); await release.promise; });
    await laneEntered.promise;
    reply.resolve(new Response(JSON.stringify(remoteReply()))); await queued.promise;
    abort.abort();
    expect(await outcome).toMatchObject({ code: "RELAY_OPERATION_ABORTED" });
    release.resolve(); await occupied; await lane.withSnapshot(async () => {});
    expect(readCurrent).toHaveBeenCalledTimes(1);
    expect(await readdir(directories[0]!)).toEqual([]);
  });

  it("aborts an uncooperative response body without waiting for its remote stream", async () => {
    const path = await registrationPath(), abort = new AbortController(), bodyEntered = deferred(), releaseBody = deferred();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { bodyEntered.resolve(); return releaseBody.promise.then(() => { if (!cancelled) controller.close(); }); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const pending = loadOrRegisterRelayRoute({ relayUrl: "wss://relay.example", registrationPath: path, signal: abort.signal,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)) });
    const outcome = pending.catch((error: unknown) => error);
    await bodyEntered.promise; abort.abort();
    expect(await outcome).toMatchObject({ code: "RELAY_OPERATION_ABORTED" });
    releaseBody.resolve(); await settlePromises();
    expect(cancelled).toBe(true);
    expect(await readdir(directories[0]!)).toEqual([]);
  });

  it("allows plaintext only through an explicit loopback test escape", () => {
    for (const value of ["https://relay.example", "ws://relay.example", "wss://a:b@relay.example", "wss://relay.example/path", "wss://relay.example?secret=x", "wss://relay.example/#token"]) {
      expect(() => normalizeRelayUrl(value)).toThrow("RELAY_URL_INVALID");
    }
    expect(() => normalizeRelayUrl("ws://127.0.0.1:4444")).toThrow();
    expect(normalizeRelayUrl("ws://127.0.0.1:4444", true)).toBe("ws://127.0.0.1:4444");
    expect(() => normalizeRelayUrl("ws://relay.example", true)).toThrow();
  });
});
