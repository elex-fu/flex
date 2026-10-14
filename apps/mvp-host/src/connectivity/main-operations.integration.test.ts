import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { SqliteProcessJournal } from "../lifecycle/managed-process-registry.js";
import { loadOrCreateHostIdentity, getHostIdentityMirror } from "../identity/host-identity.js";
import { openForMaintenance, openOwned, openReadOnly } from "../storage/open-store.js";
import { verifyOfflineHostQuiescence } from "./offline-quiescence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-main-operations-"))); roots.push(root);
  const databasePath = join(root, "host.sqlite"), identityDirectory = join(root, "identity");
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
});
