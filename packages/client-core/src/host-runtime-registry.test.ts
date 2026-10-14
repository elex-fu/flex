import { describe, expect, it } from "vitest";
import { Signal } from "./common.js";
import { MemoryClientStore } from "./host-profile-store.js";
import { HostRuntimeRegistry } from "./host-runtime-registry.js";
import { deferred } from "./platform-test-support.js";
import type { ClientState } from "./types.js";
import type { HostRuntime } from "./host-runtime.js";

class Runtime implements HostRuntime {
  readonly store = new MemoryClientStore();
  starts = 0; stops = 0; observers = 0;
  private state: ClientState = { connection: "idle", sync: "unknown", transportGeneration: 0, pairingRequired: false };
  private changed = new Signal<ClientState>();
  work: Promise<void> = Promise.resolve();
  start(): Promise<void> { this.starts++; return this.work; }
  stop(): void { this.stops++; }
  getState(): ClientState { return { ...this.state }; }
  onState(handler: (state: ClientState) => void) { this.observers++; handler(this.getState()); const off = this.changed.subscribe(handler); return () => { this.observers--; off(); }; }
}
describe("Host runtime ownership", () => {
  it("creates one owner per Host across repeated observer mounts and keeps it alive", async () => {
    let created = 0;
    const registry = new HostRuntimeRegistry(() => { created++; return new Runtime(); });
    const first = registry.get("host-a");
    const off = registry.observe("host-a", () => {});
    const offSecond = registry.observe("host-a", () => {});
    await Promise.all([registry.setDesiredHost("host-a"), registry.setDesiredHost("host-a")]);
    off(); offSecond();
    expect(created).toBe(1);
    expect(first.starts).toBe(1);
    expect(first.stops).toBe(0);
    expect(first.observers).toBe(0);
    expect(registry.get("host-a")).toBe(first);
    await registry.setDesiredHost("host-b");
    expect(created).toBe(2);
    expect(first.stops).toBe(1);
    expect(registry.peek("host-b")?.starts).toBe(1);
    registry.stopAll();
  });

  it("fences a late start completion after the desired Host changes", async () => {
    const pending = deferred<void>();
    const registry = new HostRuntimeRegistry((id) => { const runtime = new Runtime(); if (id === "host-a") runtime.work = pending.promise; return runtime; });
    const old = registry.setDesiredHost("host-a");
    await registry.setDesiredHost("host-b");
    pending.resolve();
    await old;
    expect(registry.desiredHost).toBe("host-b");
    expect(registry.peek("host-a")?.stops).toBeGreaterThanOrEqual(1);
    expect(registry.peek("host-b")?.stops).toBe(0);
  });

  it("forgets local data and closes the owner without a remote request", async () => {
    const registry = new HostRuntimeRegistry(() => new Runtime());
    const runtime = registry.get("host-a");
    await runtime.store.putProfile({ hostId: "host-a", label: "A", fingerprint: "pin", hostPublicKey: "host", signingPublicKey: "sign", endpoints: [] });
    await runtime.store.setSelectedHost("host-a");
    await registry.setDesiredHost("host-a");
    await registry.forgetLocalHost("host-a");
    expect(runtime.stops).toBe(1);
    expect(registry.peek("host-a")).toBeUndefined();
    expect(registry.desiredHost).toBeUndefined();
    expect(await runtime.store.getProfile("host-a")).toBeUndefined();
    expect(await runtime.store.getSelectedHost()).toBeUndefined();
  });

  it("adopts a paired bootstrap owner and rejects a second owner for the same Host", () => {
    const registry = new HostRuntimeRegistry(() => new Runtime());
    const bootstrap = new Runtime();
    expect(registry.adopt("host-a", bootstrap)).toBe(bootstrap);
    expect(registry.get("host-a")).toBe(bootstrap);
    expect(() => registry.adopt("host-a", new Runtime())).toThrow(/already owns/);
    expect(() => registry.adopt("host-b", bootstrap)).toThrow(/different Host/);
  });
});
