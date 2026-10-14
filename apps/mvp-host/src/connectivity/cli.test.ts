import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "../auth/device-registry.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { SqliteStore } from "../storage/db.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runFile = promisify(execFile);

describe("Host management command isolation", () => {
  it("lists and revokes without provider recovery, and cannot bypass local key-rotation confirmation", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "flyx-cli-test-"));
    const databasePath = join(temporary, "host.sqlite");
    const identityDirectory = join(temporary, "identity");
    const store = new SqliteStore(databasePath);
    let devices: DeviceRegistry | undefined;
    try {
      const identity = await loadOrCreateHostIdentity({ directory: identityDirectory });
      store.setHostIdentityMirror(getHostIdentityMirror(identity));
      devices = new DeviceRegistry(store, identity.hostId, { recoverLeases: false });
      const device = devices.createBrowserDevice({ displayName: "test phone" });
      const session = store.createSession("/missing-workspace", "codex");
      const turn = store.createTurn({ sessionId: session.id, turnId: "queued-cli-isolation", commandId: "command-cli-isolation",
        requestHash: "request-cli-isolation", prompt: "CLI must not recover this turn", generation: 1 });
      const env = { ...process.env, FLYX_DB: databasePath, FLYX_IDENTITY_DIR: identityDirectory,
        FLYX_WORKSPACE: "/missing-workspace", FLYX_PROVIDER: "codex", FLYX_CONNECTIVITY_MODE: "tailscale",
        FLYX_REQUIRE_PAIRING_CONFIRM: "0", FLYX_CODEX_EXECUTABLE: "/missing-provider" };
      const run = (args: string[]) => runFile(process.execPath,
        [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "apps/mvp-host/src/main.ts"), ...args],
        { env, cwd: repoRoot, timeout: 10_000, maxBuffer: 128 * 1024 });
      const listed = await run(["devices", "list"]);
      expect(JSON.parse(listed.stdout)).toMatchObject([{ id: device.id, displayName: "test phone" }]);
      expect(store.getTurn(turn.id)?.status).toBe("queued");
      await run(["devices", "revoke", device.id]);
      expect(store.getDevice(device.id)?.revokedAt).toBeDefined();
      await expect(run(["identity", "rotate"])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("local terminal") });
      expect(store.getHostIdentityMirror()).toEqual(getHostIdentityMirror(identity));
      const shown = await run(["identity", "show"]);
      expect(JSON.parse(shown.stdout)).toMatchObject({ hostId: identity.hostId, fingerprint: identity.fingerprint });
      expect(shown.stdout).not.toContain(identity.x25519SecretKey);
      expect(shown.stdout).not.toContain(identity.ed25519SecretKey);
    } finally {
      devices?.dispose();
      store.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 15_000);
});
