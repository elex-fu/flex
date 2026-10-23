import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "../auth/device-registry.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { registerConfiguredCatalog } from "../session/configured-catalog.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { SqliteStore } from "../storage/db.js";
import { openOwned } from "../storage/open-store.js";
import { rawWorkspaceGitQuery } from "../test-support/managed-git-fixtures.js";

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

  it("keeps offline activation rejected without verified Provider facts and never launches the Provider", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "flyx-activation-cli-"));
    const databasePath = join(temporary, "data", "host.sqlite"), identityDirectory = join(temporary, "identity"), workspace = join(temporary, "workspace");
    try {
      await mkdir(join(temporary, "data"), { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
      await runFile("git", ["init", "--quiet", workspace]);
      const executable = join(temporary, "codex-bin"); await writeFile(executable, '#!/bin/sh\nprintf touched > "$0.invoked"\nexit 1\n', { mode: 0o755 });
      const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
      try {
        const store = openOwned({ databasePath, owner });
        try {
          // The activation CLI binds to the host identity mirror; without it
          // the command refuses before any verification attempt is recorded.
          const identity = await loadOrCreateHostIdentity({ directory: identityDirectory });
          store.setHostIdentityMirror(getHostIdentityMirror(identity));
          const catalog = new CatalogStore(store);
          try {
            await registerConfiguredCatalog(catalog, owner, { workspaces: [{ workspaceId: "workspace", root: workspace }],
              providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable }] },
            { readOnlyGit: rawWorkspaceGitQuery() });
          } finally { catalog.dispose(); }
        } finally { store.close(); }
      } finally { owner.release(); }
      const env = { ...process.env, FLYX_DB: databasePath, FLYX_IDENTITY_DIR: identityDirectory, FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1" };
      const run = (args: string[]) => runFile(process.execPath,
        [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "apps/mvp-host/src/main.ts"), ...args],
        { env, cwd: repoRoot, timeout: 20_000, maxBuffer: 128 * 1024 });
      const refusal = await run(["activation", "verify", "--workspace", "workspace", "--provider", "provider"]).then(
        (result) => { throw new Error(`activation verify unexpectedly succeeded: ${result.stdout}`); },
        (error: { code?: number; stderr?: string }) => error);
      expect(refusal.code).toBe(1);
      expect(refusal.stderr).toContain("Activation verification did not produce a reachable binding");
      const db = new Database(databasePath, { readonly: true });
      try {
        const row = db.prepare("SELECT id,state,result_json FROM host_execution_operations WHERE kind='activation' ORDER BY created_at DESC,id DESC LIMIT 1")
          .get() as { id: string; state: string; result_json: string };
        expect(row.state).toBe("rejected");
        expect(JSON.parse(row.result_json)).toMatchObject({ reasonCodes: expect.arrayContaining([process.platform === "darwin" ? "PROVIDER_RUNTIME_UNAVAILABLE" : "WORKSPACE_QUERY_UNVERIFIED"]) });
        await expect(stat(executable + ".invoked")).rejects.toMatchObject({ code: "ENOENT" });
        const inspected = await run(["activation", "inspect", row.id]);
        expect(JSON.parse(inspected.stdout)).toMatchObject({ command: "inspect", operation: { id: row.id, state: "rejected" } });
      } finally { db.close(); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }, 30_000);
});
