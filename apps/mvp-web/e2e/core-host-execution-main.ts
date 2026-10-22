import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Positive uplink variant of e2e/core-host-main.ts: the same real production
// createHostApplication, but with the trusted local execution port injected
// (fixture Git runner + managed worktrees root + supervision facts) and the
// workspace/Provider locally activated through the real activation service.
// No paid Provider is ever contacted: the adapter is a hard guard.
const hostSource = (path: string) => new URL(`../../mvp-host/src/${path}.ts`, import.meta.url).href;
const [{ createHostApplication }, { parseConnectivityConfig }, { getHostIdentityMirror, loadOrCreateHostIdentity }, { HostOwnerLock }, { openOwned },
  { temporaryRepository, removeFixture }, { fixtureTreeStopBackend, rawWorkspaceGitQuery, trustedFixtureGit },
  { HostActivationLoad, observeLocalWorkspace, providerLocalFacts }, { HostActivationService }, { createActivationOperationStore }, { inspectCatalogStartupReadiness },
  { CatalogStore }, { WorkspaceRegistry }] = await Promise.all([
  import(hostSource("host-application")), import(hostSource("connectivity/config")), import(hostSource("identity/host-identity")), import(hostSource("lifecycle/host-owner")), import(hostSource("storage/open-store")),
  import(hostSource("checkpoint/test-support")), import(hostSource("test-support/managed-git-fixtures")),
  import(hostSource("lifecycle/host-activation-load")), import(hostSource("lifecycle/host-activation-service")), import(hostSource("storage/activation-store")), import(hostSource("session/catalog-startup-readiness")),
  import(hostSource("storage/catalog-store")), import(hostSource("workspace/workspace-registry")),
]);

process.env.FLYX_ALLOW_INSECURE_HTTP = "1";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-core-execution-")));
const workspace = await temporaryRepository();
const worktreesRoot = join(root, "worktrees"); mkdirSync(worktreesRoot);
const data = join(root, "data"); mkdirSync(data);
const executable = join(root, "provider"); writeFileSync(executable, "#!/bin/sh\nexit 0\n"); chmodSync(executable, 0o700);
const databasePath = join(data, "host.sqlite"), identityDirectory = join(data, "identity");
const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
const store = openOwned({ databasePath, owner });
const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
// The SQL bootstrap registers only metadata (empty checkout roots), which the
// activation verify step cannot bind. Register the real checkout identity
// through the production registry first, keeping the unverified state so the
// bootstrap still creates the initial legacy Session.
const catalogStore = new CatalogStore(store);
const registered = await new WorkspaceRegistry(catalogStore, { owner, readOnlyGit: rawWorkspaceGitQuery() }).registerLocal({ workspaceId: "registered-workspace", root: workspace });
catalogStore.putWorkspace({ ...registered, state: "needs_verification" });
const observation = {
  workspace: (record: any) => observeLocalWorkspace(record, [dirname(databasePath)]),
  provider: (record: any) => {
    const local = providerLocalFacts(record);
    if (!local) return { ready: false, reasonCodes: ["PROVIDER_EXECUTABLE_UNAVAILABLE"] };
    return { ready: true, value: { ...local, providerInstanceId: record.providerInstanceId, provider: record.provider, runtimeVersion: "fixture-browser-runtime", runtimeArtifactDigest: "a".repeat(64), capabilities: record.policyCapabilities } };
  },
};
// Any attempt to contact a real Provider runtime is a fixture failure.
const adapter = { provider: "codex",
  status: async () => { throw new Error("Paid Provider forbidden"); }, preflight: async () => { throw new Error("Paid Provider forbidden"); },
  runTurn: async () => { throw new Error("Paid Provider forbidden"); }, beginTurn: () => { throw new Error("Paid Provider forbidden"); },
  interrupt: async () => { throw new Error("Paid Provider forbidden"); }, respondApproval: () => { throw new Error("Paid Provider forbidden"); } };
const application = await createHostApplication({ store, owner, identity,
  configuration: { workspaces: [{ workspaceId: "registered-workspace", root: workspace }], providerInstances: [{ providerInstanceId: "configured-provider", provider: "codex", executable, policyCapabilities: ["workspaceWrite", "interrupt"] }] },
  initialLegacySession: { workspaceId: "registered-workspace", providerInstanceId: "configured-provider", title: "Initial session" },
  execution: { observation,
    git: { stopBackend: fixtureTreeStopBackend(), allowFixtureStopBackend: true, gitExecutable: trustedFixtureGit(), pythonExecutable: "/usr/bin/python3" },
    facts: { supervision: () => ({ contractId: "fixture-verified-tree-stop/v1" }) },
    worktreesRoot,
    runtimeOptions: () => ({ adapter, canReleaseWorkspace: () => true }) },
  server: { pairingConfirmation: () => true, port: 0, webRoot: resolve(repo, "apps/mvp-web/dist"), connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1", PORT: "4173" }) },
});
// Local verification + activation through the real activation service, exactly
// like the production activation CLI would, before the server starts.
const operations = createActivationOperationStore({ db: store.db, workspace: (id: string) => application.catalog.catalog.workspace(id), provider: (id: string) => application.catalog.catalog.provider(id) }, { guard: () => owner.assertActive() });
const load = new HostActivationLoad(operations, observation);
const management = new HostActivationService({ facts: { db: store.db, owner, catalog: application.catalog.catalog, readiness: () => inspectCatalogStartupReadiness(application.catalog) }, operations, load, observation, actorId: "fixture-maintenance",
  executorFactory: async () => ({ readOnlyGit: rawWorkspaceGitQuery(), prepare: async () => ({ ready: true }), closeAndWait: async () => ({ producerStopped: true, clean: true }) }) });
const evidence = await management.verify({ workspaceId: "registered-workspace", providerInstanceId: "configured-provider", commandId: "fixture-verify" });
management.activate({ evidenceId: evidence.evidenceId, commandId: "fixture-activate" });
await management.close();
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  try { await application.stop(); rmSync(root, { recursive: true, force: true }); await removeFixture(workspace); process.exit(code); }
  catch { console.error("CORE_EXECUTION_SHUTDOWN_UNVERIFIED"); process.exit(1); }
}
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
try {
  const address = await application.start();
  console.log(`FLYX_CORE_EXECUTION_READY ${JSON.stringify({ address, token: application.server.auth.pairingUrlToken })}`);
} catch (cause) { console.error(cause); await stop(1); }
process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("id" in value) || !("action" in value) || value.action !== "stats") return;
  const sessions = store.db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
  const native = store.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE provider_session_id IS NOT NULL").get() as { count: number };
  const processes = store.db.prepare("SELECT COUNT(*) AS count FROM managed_processes").get() as { count: number };
  const writeReceipts = store.db.prepare("SELECT method, COUNT(*) AS count FROM command_receipts WHERE method LIKE 'checkpoint.%' OR method LIKE 'worktree.%' OR method LIKE 'session.recovery.%' GROUP BY method ORDER BY method").all() as Array<{ method: string; count: number }>;
  process.send?.({ id: value.id, sessions: sessions.length, nativeSessions: native.count, processes: processes.count, loadedRuntimes: sessions.filter((session) => application.catalog.registry.loaded(session.id)).length, writeReceipts });
});
