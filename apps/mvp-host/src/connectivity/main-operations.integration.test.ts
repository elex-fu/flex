import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { SqliteProcessJournal } from "../lifecycle/managed-process-registry.js";
import { loadOrCreateHostIdentity, getHostIdentityMirror } from "../identity/host-identity.js";
import { openForMaintenance, openOwned, openReadOnly } from "../storage/open-store.js";
import { verifyOfflineHostQuiescence } from "./offline-quiescence.js";
import { createHostCatalogReadBindings } from "../catalog/host-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-main-operations-"))); roots.push(root);
  const data = join(root, "data"); mkdirSync(data, { mode: 0o700 });
  const databasePath = join(data, "host.sqlite"), identityDirectory = join(data, "identity");
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
  const store = openOwned({ databasePath, owner });
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory });
  store.setHostIdentityMirror(getHostIdentityMirror(identity));
  store.db.prepare("INSERT INTO host_state VALUES('test_note',?,?)").run(JSON.stringify("original"), new Date().toISOString());
  store.close(); owner.release();
  const env = { ...process.env, NODE_ENV: "test", FLYX_DB: databasePath, FLYX_IDENTITY_DIR: identityDirectory,
    FLYX_PROVIDER: "invalid-unused-provider", FLYX_CLAUDE_EXECUTABLE: "/unavailable/flyx-cli-probe", FLYX_CODEX_EXECUTABLE: "/unavailable/flyx-cli-probe",
    FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_REQUIRE_TAILSCALE_SERVE: "0", FLYX_ALLOW_INSECURE_HTTP: "0",
    FLYX_PUBLIC_BASE_URL: "", FLYX_HOSTED_APP_URL: "", FLYX_RELAY_URL: "", FLYX_BIND: "127.0.0.1", PORT: "4173", RUN_REAL_CODEX: "0", RUN_REAL_CLAUDE: "0" };
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", resolve("src/main.ts"), ...args], { env, encoding: "utf8", timeout: 20000 })) as Record<string, unknown>;
  const note = () => { const readonly = openReadOnly(databasePath); try { return readonly.db.prepare("SELECT value_json FROM host_state WHERE key='test_note'").get() as { value_json: string }; } finally { readonly.close(); } };
  return { root, databasePath, identityDirectory, env, cli, note };
}

describe("actual main operations routing", { timeout: 30000 }, () => {
  it("runs readonly doctor before Provider parsing and leaves missing databases uncreated", async () => {
    const f = await fixture();
    expect(f.cli("doctor")).toHaveProperty("schema");
    expect(f.note().value_json).toBe(JSON.stringify("original"));
    const absent = join(f.root, "missing.sqlite");
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve("src/main.ts"), "doctor"], { env: { ...f.env, FLYX_DB: absent }, encoding: "utf8", timeout: 20000 });
    expect(child.status).toBe(1);
    expect(() => openReadOnly(absent)).toThrow();
  });

  it("backs up, validates and restores history under offline ownership without loading a Provider", async () => {
    const f = await fixture();
    const directory = join(f.root, "backup"), rollbackDirectory = join(f.root, "rollback");
    expect(f.cli("backup", directory)).toHaveProperty("manifest.includesExternalGitOrProviderHistory", false);
    expect(f.cli("validate", directory)).toHaveProperty("includesExternalGitOrProviderHistory", false);
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory, mode: "maintenance" });
    const store = openForMaintenance({ databasePath: f.databasePath, owner });
    store.db.prepare("UPDATE host_state SET value_json=? WHERE key='test_note'").run(JSON.stringify("modified"));
    store.close(); owner.release();
    expect(verifyOfflineHostQuiescence(f.databasePath)).toBe(true);
    expect(f.cli("restore", directory, rollbackDirectory)).toHaveProperty("readiness.status", "external_state_unverified");
    expect(f.note().value_json).toBe(JSON.stringify("original"));
    const restored = openReadOnly(f.databasePath);
    try { expect(restored.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()).toBeTruthy(); }
    finally { restored.close(); }
  });

  it("refuses restore when an original managed launch has no descendant stop proof", async () => {
    const f = await fixture();
    const directory = join(f.root, "backup"); f.cli("backup", directory);
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory, mode: "maintenance" });
    const store = openForMaintenance({ databasePath: f.databasePath, owner });
    new SqliteProcessJournal(store.db).save({ id: "original-unproved-query", hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
      runtimeId: "query-helper", runtimeGeneration: 1, attemptId: "attempt-one", state: "root_exited", treeControl: "process_group" });
    store.db.prepare("UPDATE host_state SET value_json=? WHERE key='test_note'").run(JSON.stringify("preserve"));
    store.close(); owner.release();
    expect(verifyOfflineHostQuiescence(f.databasePath)).toBe(false);
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve("src/main.ts"), "restore", directory, join(f.root, "rollback-refused")], { env: f.env, encoding: "utf8", timeout: 20000 });
    expect(child.status).toBe(1); expect(child.stderr).toContain("RESTORE_PRODUCERS_UNVERIFIED");
    expect(f.note().value_json).toBe(JSON.stringify("preserve"));
  });

  it("starts restored history without preparing or preflighting a Native Provider", async () => {
    const f = await fixture(), workspace = join(f.root, "workspace"); mkdirSync(workspace);
    execFileSync("git", ["init", "--quiet", workspace]);
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory });
    const store = openOwned({ databasePath: f.databasePath, owner });
    // Restore a complete existing Catalog, rather than asking a restored empty
    // database to create a new Session through the external-state write gate.
    const catalog = await createHostCatalogReadBindings({ store, owner,
      configuration: { workspaces: [{ workspaceId: "restored-workspace", root: workspace }],
        providerInstances: [{ providerInstanceId: "restored-provider", provider: "codex", executable: "/unavailable/flyx-cli-probe" }] },
      initialLegacySession: { workspaceId: "restored-workspace", providerInstanceId: "restored-provider" },
    });
    const sessionId = catalog.legacySessionId;
    await catalog.closeAndWait();
    const timestamp = new Date().toISOString();
    store.db.prepare("INSERT INTO host_state VALUES('restore_readiness',?,?)").run(JSON.stringify({ v: 1, status: "external_state_unverified", restoredAt: timestamp, backupCreatedAt: timestamp,
      possibleDispatchIntents: 0, reasonCodes: ["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"], relayRegistrationInvalidated: false }), timestamp);
    store.close(); owner.release();
    const reserve = createServer();
    await new Promise<void>((yes) => reserve.listen(0, "127.0.0.1", yes));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((yes, no) => reserve.close((error) => error ? no(error) : yes()));
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/main.ts"), "start"], { env: { ...f.env, NODE_ENV: "production", FLYX_PROVIDER: "codex", FLYX_WORKSPACE: workspace, FLYX_SKIP_PREFLIGHT: "0", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    const ended = new Promise<number | null>((yes, no) => { child.once("exit", yes); child.once("error", no); });
    void ended.catch(() => undefined);
    let output = "", errors = "";
    child.stdout!.on("data", (chunk) => { output += String(chunk); }); child.stderr!.on("data", (chunk) => { errors += String(chunk); });
    try {
      const deadline = Date.now() + 15000;
      while (!output.includes("Flyx MVP Host listening") && child.exitCode === null && Date.now() < deadline) await new Promise<void>((yes) => setTimeout(yes, 20));
      expect(output, errors).toContain("Flyx MVP Host listening");
      expect(errors).not.toContain("preflight"); expect(errors).not.toContain("Native execution unavailable");
      child.kill("SIGTERM"); expect(await ended).toBe(0);
      const readonly = openReadOnly(f.databasePath);
      try {
        expect(readonly.db.prepare("SELECT COUNT(*) AS count FROM managed_processes").get()).toEqual({ count: 0 });
        expect(readonly.db.prepare("SELECT session_id FROM session_catalog").all()).toEqual([{ session_id: sessionId }]);
      }
      finally { readonly.close(); }
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await ended; } }
  });

  it("preserves a bind startup error when cleanup also requires original-producer recovery", async () => {
    const f = await fixture(), workspace = join(f.root, "workspace"); mkdirSync(workspace);
    const owner = HostOwnerLock.acquire({ databasePath: f.databasePath, identityDirectory: f.identityDirectory, mode: "maintenance" });
    const store = openForMaintenance({ databasePath: f.databasePath, owner });
    new SqliteProcessJournal(store.db).save({ id: "original-startup-helper", hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
      runtimeId: "original-helper", runtimeGeneration: 1, attemptId: "original-attempt", state: "unknown", treeControl: "unavailable" });
    store.close(); owner.release();
    const occupied = createServer(); await new Promise<void>((yes) => occupied.listen(0, "127.0.0.1", yes));
    const port = (occupied.address() as { port: number }).port;
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", resolve("src/main.ts"), "start"], {
        env: { ...f.env, NODE_ENV: "production", FLYX_PROVIDER: "codex", FLYX_WORKSPACE: workspace, PORT: String(port) }, encoding: "utf8", timeout: 20000,
      });
      // The tightened restore gate refuses startup with an unresolved
      // original producer before any bind attempt: recovery takes precedence
      // over the incidental port conflict, and the unknown helper is left
      // untouched for explicit recovery.
      expect(child.status).toBe(1); expect(child.stderr).toContain("HOST_RECOVERY_REQUIRED");
      const readonly = openReadOnly(f.databasePath);
      try {
        expect(readonly.db.prepare("SELECT state FROM managed_processes WHERE id='original-startup-helper'").get()).toEqual({ state: "unknown" });
      } finally { readonly.close(); }
    } finally { await new Promise<void>((yes, no) => occupied.close((error) => error ? no(error) : yes())); }
  });
});
