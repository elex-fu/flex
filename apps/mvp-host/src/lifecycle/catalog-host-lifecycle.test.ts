import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostOwnerLock } from "./host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { CatalogHostLifecycle } from "./catalog-host-lifecycle.js";
import type { RuntimeCloseReport } from "../session/orchestrator.js";

const clean: RuntimeCloseReport = { closed: true, stopped: true, clean: true, producerStopped: true, state: "stopped", recoveryRequired: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-global-lifecycle-")));
  roots.push(root);
  const owner = HostOwnerLock.acquire({ databasePath: join(root, "host.sqlite"), identityDirectory: join(root, "identity") });
  const store = openOwned({ databasePath: owner.databasePath, owner });
  return { owner, store };
}

describe("global Catalog lifecycle boundary", () => {
  it("waits for both Session reports and global delivery before transports, hooks and the shared Store", async () => {
    const { owner, store } = fixture();
    const calls: string[] = [];
    const stopped = deferred<readonly RuntimeCloseReport[]>();
    const delivery = deferred<void>();
    const closeStore = vi.spyOn(store, "close");
    const host = new CatalogHostLifecycle({ store, owner, catalog: { closeAndWait: async () => { calls.push("sessions"); return stopped.promise; } },
      services: [{ drain: async (deadline) => { expect(deadline).toBeGreaterThan(Date.now()); expect(store.db.open).toBe(true); calls.push("attention-drain"); },
        seal: () => { expect(store.db.open).toBe(true); calls.push("attention-seal"); }, close: () => { calls.push("attention-close"); } }],
      sealJournals: () => { expect(store.db.open).toBe(true); calls.push("journals"); },
    });
    host.registerTransportShutdown(async () => { expect(store.db.open).toBe(true); calls.push("transport"); });
    host.markReady();
    const sending = host.trackOperation("producer", () => delivery.promise);
    const first = host.closeAndWait(1000);
    expect(host.closeAndWait(5)).toBe(first);
    await expect(host.trackOperation("producer", async () => undefined)).rejects.toThrow("HOST_DRAINING");
    expect(() => host.registerTransportShutdown(async () => undefined)).toThrow("HOST_DRAINING");
    expect(store.db.open).toBe(true);
    stopped.resolve([clean, clean]);
    await Promise.resolve(); await Promise.resolve();
    expect(calls).not.toContain("transport");
    delivery.resolve(); await sending;
    expect(await first).toMatchObject({ clean: true, producerStopped: true, closed: true, state: "stopped" });
    expect(calls).toEqual(["sessions", "attention-drain", "transport", "attention-seal", "attention-close", "journals"]);
    expect(closeStore).toHaveBeenCalledOnce(); expect(() => owner.assertActive()).toThrow("Host owner has been released");
    expect(store.db.open).toBe(false);
  });

  it("records unknown while projections remain live and closes Store with ownership retained", async () => {
    const { owner, store } = fixture();
    let projectionLive = true;
    const host = new CatalogHostLifecycle({ store, owner,
      catalog: { closeAndWait: async () => [{ ...clean, clean: false, producerStopped: false, stopped: false, state: "recovery_required", recoveryRequired: true }] },
      recordUnknown: (reason) => {
        expect(projectionLive).toBe(true); expect(store.db.open).toBe(true);
        store.db.prepare("INSERT INTO host_state VALUES('shutdown_test',?,?)").run(JSON.stringify({ reason }), new Date().toISOString());
      },
      services: [{ drain: async () => true, seal: () => { projectionLive = false; } }],
    });
    expect(await host.closeAndWait(100)).toMatchObject({ clean: false, producerStopped: false, state: "recovery_required", closed: true });
    expect(owner.retainedReason).toBeTruthy(); expect(() => owner.release()).toThrow("retained");
    expect(projectionLive).toBe(false); expect(store.db.open).toBe(false);
  });

  it("bounds a hung global service, seals late work and keeps the original owner retained", async () => {
    vi.useFakeTimers();
    const { owner, store } = fixture();
    const hung = deferred<void>(); const sealed = vi.fn();
    try {
      const host = new CatalogHostLifecycle({ store, owner, catalog: { closeAndWait: async () => [clean] },
        services: [{ drain: () => hung.promise, seal: sealed }] });
      const closing = host.closeAndWait(50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await closing).toMatchObject({ clean: false, closed: true, recoveryRequired: true });
      expect(owner.retainedReason).toBeTruthy(); expect(sealed).toHaveBeenCalledOnce();
      hung.resolve(); await Promise.resolve();
      expect(store.db.open).toBe(false); expect(sealed).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); if (store.db.open) store.close(); }
  });

  it("attempts every pre-Store fence and closes the shared Store when one service seal fails", async () => {
    const { owner, store } = fixture();
    const sealed = vi.fn(), journalFence = vi.fn(), closeStore = vi.spyOn(store, "close");
    const host = new CatalogHostLifecycle({ store, owner, catalog: { closeAndWait: async () => [clean] },
      services: [{ drain: async () => true, seal: () => { throw new Error("service fence failed"); } }, { drain: async () => true, seal: sealed }],
      sealJournals: journalFence,
    });
    await expect(host.closeAndWait(100)).rejects.toThrow("service fence failed");
    expect(sealed).toHaveBeenCalledOnce(); expect(journalFence).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce(); expect(store.db.open).toBe(false); expect(owner.retainedReason).toBeTruthy();
  });

  it("closes every transport and seals all services when one transport fails", async () => {
    const { owner, store } = fixture();
    const other = vi.fn(async () => undefined); const sealed = vi.fn();
    const host = new CatalogHostLifecycle({ store, owner, catalog: { closeAndWait: async () => [clean] }, services: [{ drain: async () => true, seal: sealed }] });
    host.registerTransportShutdown(async () => { throw new Error("socket"); });
    host.registerTransportShutdown(other);
    await expect(host.closeAndWait(100)).rejects.toThrow("HOST_TRANSPORT_CLOSE_FAILED");
    expect(other).toHaveBeenCalledOnce(); expect(sealed).toHaveBeenCalledOnce();
    expect(owner.retainedReason).toBeTruthy(); expect(store.db.open).toBe(false);
  });
  it("starts every global producer stop before waiting for Session reports or operation drain", async () => {
    const { owner, store } = fixture(); const calls: string[] = [];
    const session = deferred<readonly RuntimeCloseReport[]>(), producer = deferred<boolean>();
    const host = new CatalogHostLifecycle({ store, owner,
      catalog: { closeAndWait: async () => { calls.push("sessions"); return session.promise; } },
      services: [{ stopProducers: async () => { calls.push("producer-stop"); return producer.promise; }, drain: async () => { calls.push("drain"); } }],
    });
    const closing = host.closeAndWait(1000);
    expect(calls).toEqual(["producer-stop", "sessions"]);
    session.resolve([clean]); await Promise.resolve(); expect(calls).not.toContain("drain");
    producer.resolve(true); expect(await closing).toMatchObject({ clean: true });
    expect(calls).toEqual(["producer-stop", "sessions", "drain"]);
  });
  it("seals every global producer when its stop never settles", async () => {
    vi.useFakeTimers(); const { owner, store } = fixture(); const sealed = vi.fn();
    try {
      const host = new CatalogHostLifecycle({ store, owner, catalog: { closeAndWait: async () => [clean] },
        services: [{ stopProducers: () => new Promise(() => {}), drain: async () => false, seal: sealed }] });
      const closing = host.closeAndWait(50); await vi.advanceTimersByTimeAsync(51);
      expect(await closing).toMatchObject({ clean: false, closed: true, recoveryRequired: true });
      expect(sealed).toHaveBeenCalledOnce(); expect(store.db.open).toBe(false); expect(owner.retainedReason).toBeTruthy();
    } finally { vi.useRealTimers(); if (store.db.open) store.close(); }
  });

});
