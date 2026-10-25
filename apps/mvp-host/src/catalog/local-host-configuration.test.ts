import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { invalidateCatalogResourceReadiness } from "./catalog-read-bootstrap.js";
import { createHostCatalogBindings, createHostCatalogReadBindings, type HostCatalog } from "./host-catalog.js";
import { readHostCatalogBootstrap, storedCatalogConfiguration } from "./local-host-configuration.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-local-catalog-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), data = join(root, "data"); mkdirSync(workspace); mkdirSync(data);
  const owner = HostOwnerLock.acquire({ databasePath: join(data, "host.sqlite"), identityDirectory: join(data, "identity") });
  const store = openOwned({ databasePath: owner.databasePath, owner }); cleanup.push(() => { if (store.db.open) store.close(); owner.release(); });
  return { root, workspace, store, owner };
}

it("keeps existing original Session resources when CLI defaults choose another workspace or Provider", async () => {
  const f = fixture();
  const bootstrap = readHostCatalogBootstrap({ store: f.store, workspace: f.workspace, provider: "codex", environment: { FLYX_CODEX_EXECUTABLE: "/unavailable-original-codex" } });
  const catalog = await createHostCatalogReadBindings({ store: f.store, owner: f.owner, ...bootstrap });
  const original = catalog.registry.resolve(catalog.legacySessionId);
  const rows = JSON.stringify(f.store.db.prepare("SELECT * FROM workspaces").all()) + JSON.stringify(f.store.db.prepare("SELECT * FROM provider_instances").all());
  const next = readHostCatalogBootstrap({ store: f.store, workspace: join(f.root, "other"), provider: "claude", environment: { FLYX_CLAUDE_EXECUTABLE: "/other-executable" } });
  expect(next).toEqual({ configuration: { workspaces: [], providerInstances: [] } });
  expect(catalog.registry.resolve(catalog.legacySessionId)).toEqual(original);
  expect(JSON.stringify(f.store.db.prepare("SELECT * FROM workspaces").all()) + JSON.stringify(f.store.db.prepare("SELECT * FROM provider_instances").all())).toBe(rows);
  await catalog.closeAndWait();
});

it("requires an explicit first default when the local file defines multiple resources", () => {
  const f = fixture(), path = join(f.root, "catalog.json");
  writeFileSync(path, JSON.stringify({ workspaces: [{ workspaceId: "one", root: f.workspace }, { workspaceId: "two", root: join(f.root, "second") }],
    providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable: "/unavailable" }] }));
  const options = { store: f.store, workspace: f.workspace, provider: "codex" as const, environment: { FLYX_CATALOG_CONFIG: path } };
  expect(() => readHostCatalogBootstrap(options)).toThrow("Choose FLYX_LEGACY_WORKSPACE_ID");
  const selected = readHostCatalogBootstrap({ ...options, environment: { ...options.environment, FLYX_LEGACY_WORKSPACE_ID: "two" } });
  expect(selected.initialLegacySession).toEqual({ workspaceId: "two", providerInstanceId: "provider" });
  expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
});

it("rejects conflicting explicit existing default selections before any catalog write", () => {
  const f = fixture(), path = join(f.root, "catalog.json");
  writeFileSync(path, JSON.stringify({ legacyDefaultSessionId: "session-one" }));
  expect(() => readHostCatalogBootstrap({ store: f.store, workspace: f.workspace, provider: "codex", environment: {
    FLYX_CATALOG_CONFIG: path, FLYX_LEGACY_DEFAULT_SESSION_ID: "session-two",
  } })).toThrow("LEGACY_DEFAULT_CONFLICT");
  expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
});

it("restores the configured Provider a restart readiness withdrawal reset by revalidating the stored rows", async () => {
  const f = fixture();
  const executable = join(f.root, "claude"); writeFileSync(executable, ""); chmodSync(executable, 0o755);
  const readOnlyGit = (async () => ({ stdout: `${f.workspace}\n` })) as never;
  // First start: a fresh Store bootstraps the default Provider and the
  // explicit local configuration step registers it as configured.
  const first = readHostCatalogBootstrap({ store: f.store, workspace: f.workspace, provider: "claude", environment: { FLYX_CLAUDE_EXECUTABLE: executable } });
  const boot = await createHostCatalogBindings({ store: f.store, owner: f.owner, ...first, readOnlyGit });
  expect(f.store.db.prepare("SELECT state FROM provider_instances WHERE id=?").get("default-claude")).toEqual({ state: "configured" });
  await boot.closeAndWait();
  // Restart: Sessions exist, so the environment bootstrap is empty, and the
  // metadata/readiness bootstrap withdraws the Provider (no persisted
  // activation evidence) back to unconfigured.
  const restart = readHostCatalogBootstrap({ store: f.store, workspace: f.workspace, provider: "claude", environment: { FLYX_CLAUDE_EXECUTABLE: executable } });
  expect(restart.configuration).toEqual({ workspaces: [], providerInstances: [] });
  const catalog: HostCatalog = await createHostCatalogReadBindings({ store: f.store, owner: f.owner, ...restart, readOnlyGit });
  expect(f.store.db.prepare("SELECT state FROM provider_instances WHERE id=?").get("default-claude")).toEqual({ state: "unconfigured" });
  // The explicit local configuration step revalidates the exact rows the
  // Store already published, restoring the configured state without
  // environment defaults overriding any existing binding.
  const stored = storedCatalogConfiguration(catalog.catalog);
  const defaultCapabilities = ["streamingText", "structuredToolCalls", "gitDiff", "resumeConversation", "workspaceWrite", "interrupt", "interactiveApprovals"];
  expect(stored.providerInstances).toEqual([{ providerInstanceId: "default-claude", provider: "claude", executable, config: { environment: {}, sandboxRequired: true }, policyVersion: 1, policyCapabilities: defaultCapabilities }]);
  expect(stored.legacyDefaultSessionId).toBe(catalog.legacySessionId);
  await catalog.revalidateConfiguration(stored);
  expect(f.store.db.prepare("SELECT state FROM provider_instances WHERE id=?").get("default-claude")).toEqual({ state: "configured" });
  await catalog.closeAndWait();
});
