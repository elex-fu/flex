import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Load the real Host in the fixture process without adding Host source files to
// the Web package's TypeScript root. Production Host sources have their own checks.
const hostSource = (path: string) => new URL(`../../mvp-host/src/${path}.ts`, import.meta.url).href;
const [{ createHostApplication }, { parseConnectivityConfig }, { getHostIdentityMirror, loadOrCreateHostIdentity }, { HostOwnerLock }, { openOwned }, { CatalogStore }, { WorkspaceRegistry }, { rawWorkspaceGitQuery }, { fixtureGit }] = await Promise.all([
  import(hostSource("host-application")), import(hostSource("connectivity/config")), import(hostSource("identity/host-identity")), import(hostSource("lifecycle/host-owner")), import(hostSource("storage/open-store")),
  import(hostSource("storage/catalog-store")), import(hostSource("workspace/workspace-registry")), import(hostSource("test-support/managed-git-fixtures")), import(hostSource("checkpoint/test-support")),
]);

// A real Gateway and SQL metadata catalog with an absent/unactivated Provider.
// Resource selection and Session metadata must not construct its runtime.
process.env.FLYX_ALLOW_INSECURE_HTTP = "1";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-core-browser-")));
const workspace = join(root, "workspace"), data = join(root, "data"); mkdirSync(workspace); mkdirSync(data);
const databasePath = join(data, "host.sqlite"), identityDirectory = join(data, "identity");
const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
const store = openOwned({ databasePath, owner });
const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
// Register a real checkout identity through the production registry (raw test
// Git query only), then keep the unverified state: this fixture performs no
// local verification or activation, and constructs no Git runner or Provider.
const catalogStore = new CatalogStore(store);
await fixtureGit(workspace, ["init", "-b", "main"]);
await fixtureGit(workspace, ["config", "user.name", "Core browser fixture"]);
await fixtureGit(workspace, ["config", "user.email", "core-fixture@flyx.invalid"]);
const registered = await new WorkspaceRegistry(catalogStore, { owner, readOnlyGit: rawWorkspaceGitQuery() }).registerLocal({ workspaceId: "registered-workspace", root: workspace });
catalogStore.putWorkspace({ ...registered, state: "needs_verification" });
const configuration = { workspaces: [{ workspaceId: "registered-workspace", root: workspace }], providerInstances: [{ providerInstanceId: "configured-provider", provider: "codex", executable: join(root, "deliberately-absent-provider"), policyCapabilities: ["workspaceWrite", "interrupt"] }] };
const application = await createHostApplication({ store, owner, identity,
  configuration,
  initialLegacySession: { workspaceId: "registered-workspace", providerInstanceId: "configured-provider", title: "Initial session" },
  server: { pairingConfirmation: () => true, port: 0, webRoot: resolve(repo, "apps/mvp-web/dist"), connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1", PORT: "4173" }) },
});
// The bootstrap registered the absent Provider as unconfigured (required for
// the initial legacy Session). Promote only its record to configured — the
// executable stays absent and verification stays unverified — so Session
// metadata writes can bind it without constructing any runtime.
catalogStore.putProvider({ providerInstanceId: "configured-provider", provider: "codex", executable: join(root, "deliberately-absent-provider"), config: { environment: {}, sandboxRequired: true }, policyVersion: 1, state: "configured", verification: { state: "unverified", capabilities: [] }, policyCapabilities: ["workspaceWrite", "interrupt"] });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  try { await application.stop(); rmSync(root, { recursive: true, force: true }); process.exit(code); }
  catch { console.error("CORE_BROWSER_SHUTDOWN_UNVERIFIED"); process.exit(1); }
}
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
try {
  const address = await application.start();
  console.log(`FLYX_CORE_BROWSER_READY ${JSON.stringify({ address, token: application.server.auth.pairingUrlToken })}`);
} catch (cause) { console.error(cause); await stop(1); }
process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("id" in value) || !("action" in value) || value.action !== "stats") return;
  const sessions = store.db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
  const native = store.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE provider_session_id IS NOT NULL").get() as { count: number };
  const processes = store.db.prepare("SELECT COUNT(*) AS count FROM managed_processes").get() as { count: number };
  // Host-side durable write receipts for the panels under test. Without a
  // backend these families must stay empty even when the panels are exercised.
  const writeReceipts = store.db.prepare("SELECT method, COUNT(*) AS count FROM command_receipts WHERE method LIKE 'checkpoint.%' OR method LIKE 'worktree.%' OR method LIKE 'session.recovery.%' GROUP BY method ORDER BY method").all() as Array<{ method: string; count: number }>;
  process.send?.({ id: value.id, sessions: sessions.length, nativeSessions: native.count, processes: processes.count, loadedRuntimes: sessions.filter((session) => application.catalog.registry.loaded(session.id)).length, writeReceipts });
});
