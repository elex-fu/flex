import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createNetworkFixture } from "./network-e2e-main.js";

describe("real network fixture Host lifecycle", () => {
  it("owns private identity and DB before serving, shares stop, and closes transport before Store", async () => {
    const fixture = await createNetworkFixture({ offerCount: 0 });
    try {
      const { orchestrator, host } = fixture; const root = realpathSync(fixture.root);
      expect(orchestrator.owner.databasePath).toBe(join(root, "host-data", "host.sqlite"));
      expect(orchestrator.owner.identityDirectory).toBe(join(root, "host-data", "identity"));
      expect(orchestrator.store.getHostIdentityMirror()).toMatchObject({ hostId: fixture.profile.hostId, fingerprint: fixture.profile.fingerprint });
      expect(orchestrator.workspace).toBe(join(root, "workspace"));
      const transport = vi.spyOn(host.app, "close"); const originalCloseStore = orchestrator.store.close.bind(orchestrator.store);
      const closeStore = vi.spyOn(orchestrator.store, "close").mockImplementation(() => { expect(transport).toHaveBeenCalledTimes(1); expect(host.app.server.listening).toBe(false); expect(host.relay?.state).toBe("stopped"); originalCloseStore(); });
      const first = host.stop(); expect(host.stop()).toBe(first); await first;
      expect(transport).toHaveBeenCalledTimes(1); expect(closeStore).toHaveBeenCalledTimes(1); expect(orchestrator.store.db.open).toBe(false); expect(() => orchestrator.owner.assertActive()).toThrow();
      const closing = fixture.close(); expect(fixture.close()).toBe(closing); await closing;
    } finally { await fixture.close(); }
  }, 15_000);
});
