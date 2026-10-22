import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CATALOG_CAPABILITY } from "@flyx/mvp-protocol";
import { createHostApplication } from "./host-application.js";
import { parseConnectivityConfig } from "./connectivity/config.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "./identity/host-identity.js";
import { HostOwnerLock } from "./lifecycle/host-owner.js";
import { HostActivationLoad, observeLocalWorkspace, providerLocalFacts, type ActivationLoadFacts } from "./lifecycle/host-activation-load.js";
import { HostActivationService } from "./lifecycle/host-activation-service.js";
import { createActivationOperationStore } from "./storage/activation-store.js";
import { openOwned } from "./storage/open-store.js";
import { inspectCatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { temporaryRepository, removeFixture } from "./checkpoint/test-support.js";
import { WorkspaceRegistry } from "./workspace/workspace-registry.js";
import { fixtureTreeStopBackend, rawWorkspaceGitQuery, trustedFixtureGit } from "./test-support/managed-git-fixtures.js";
import type { ProviderAdapter, ProviderOutcome } from "./provider/types.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(driftBeforeDispatch = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-positive-main-"))), workspace = realpathSync(await temporaryRepository());
  mkdirSync(join(root, "data"));
  const executable = join(root, "provider"); writeFileSync(executable, "#!/bin/sh\nexit 0\n"); chmodSync(executable, 0o700);
  const databasePath = join(root, "data", "host.sqlite"), identityDirectory = join(root, "data", "identity");
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory }), store = openOwned({ databasePath, owner });
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  let drift = false; const begin = vi.fn();
  const observation: ActivationLoadFacts = {
    workspace: (record) => observeLocalWorkspace(record, [dirname(databasePath)]),
    provider: (record) => {
      const local = providerLocalFacts(record);
      if (!local) return { ready: false, reasonCodes: ["PROVIDER_EXECUTABLE_UNAVAILABLE"] };
      return { ready: true, value: { ...local, providerInstanceId: record.providerInstanceId, provider: record.provider,
        runtimeVersion: "explicit-fixture-runtime", runtimeArtifactDigest: (drift ? "b" : "a").repeat(64), capabilities: record.policyCapabilities } };
    },
  };
  const outcome: ProviderOutcome = { status: "completed", providerSessionId: "fixture-native", evidence: { kind: "native-terminal", sourceId: "fixture-result" } };
  const adapter: ProviderAdapter = { provider: "codex", workspace,
    status: async () => { throw new Error("Paid Provider forbidden"); }, preflight: async () => { throw new Error("Paid Provider forbidden"); },
    runTurn: async () => outcome, beginTurn: () => { begin(); return { outcome: Promise.resolve(outcome) }; }, interrupt: async () => "accepted", respondApproval: () => true };
  const application = await createHostApplication({ store, owner, identity,
    configuration: { workspaces: [{ workspaceId: "workspace", root: workspace }], providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable, policyCapabilities: ["workspaceWrite"] }] },
    initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" },
    execution: { observation, git: { stopBackend: fixtureTreeStopBackend(), allowFixtureStopBackend: true, gitExecutable: trustedFixtureGit(), pythonExecutable: "/usr/bin/python3" },
      runtimeOptions: () => ({ adapter, canReleaseWorkspace: () => true, executionHooks: { beforeDispatch: async () => { if (driftBeforeDispatch) drift = true; } } }) },
    server: { pairingConfirmation: () => true, port: 0, webRoot: join(root, "no-web"), connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1" }) },
  });
  closes.push(async () => { await application.stop().catch(() => {}); await removeFixture(workspace); rmSync(root, { recursive: true, force: true }); });
  const operations = createActivationOperationStore({ db: store.db, workspace: (id) => application.catalog.catalog.workspace(id), provider: (id) => application.catalog.catalog.provider(id) }, { guard: () => owner.assertActive() });
  // Workspace verification is a separate owner step in production: the
  // read-only bootstrap never derives checkout identity from configuration.
  await new WorkspaceRegistry(application.catalog.catalog, { owner, readOnlyGit: rawWorkspaceGitQuery() })
    .registerLocal({ workspaceId: "workspace", root: workspace, capabilities: ["streamingText", "workspaceWrite"] });
  const load = new HostActivationLoad(operations, observation);
  const management = new HostActivationService({ facts: { db: store.db, owner, catalog: application.catalog.catalog, readiness: () => inspectCatalogStartupReadiness(application.catalog) }, operations, load, observation, actorId: "fixture-maintenance",
    executorFactory: async () => ({ readOnlyGit: rawWorkspaceGitQuery(), prepare: async () => ({ ready: true }), closeAndWait: async () => ({ producerStopped: true, clean: true }) }) });
  const evidence = await management.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "fixture-verify" });
  management.activate({ evidenceId: evidence.evidenceId, commandId: "fixture-activate" });
  await management.close();
  store.createDevice({ id: "actor", hostId: identity.hostId, platform: "test", credentialKind: "browser-session", credentialRevision: 0, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  await application.start();
  const dispatch = () => application.catalog.dispatchCatalog({ id: "start", method: "session.startTurn", commandId: "fixture-turn", payload: { sessionId: application.catalog.legacySessionId, prompt: "fixture task" } }, {
    subjectId: "actor", protocolVersion: 2, capabilities: new Set([SESSION_CATALOG_CAPABILITY]), assertAuthorized: () => {}, subscribe: async () => ({}), access: async () => ({}), assertSessionScope: () => {},
  });
  return { application, store, begin, dispatch };
}

describe("injected positive production application graph", { timeout: 30_000 }, () => {
  it("uses one activated graph through acceptance, managed before/after capture, and dispatch", async () => {
    const f = await fixture(); expect((await f.dispatch()).handled).toBe(true);
    const runtime = f.application.catalog.registry.loaded(f.application.catalog.legacySessionId);
    expect(runtime).toBeInstanceOf(SessionOrchestrator);
    await (runtime as SessionOrchestrator).worker.drainOperations();
    expect(f.begin).toHaveBeenCalledOnce();
    expect(f.store.db.prepare("SELECT phase FROM checkpoint_captures WHERE phase IN ('before','after') ORDER BY phase").all()).toEqual([{ phase: "after" }, { phase: "before" }]);
  });
  it("withdraws a changed activation after acceptance before any prompt is dispatched", async () => {
    const f = await fixture(true); expect((await f.dispatch()).handled).toBe(true);
    const runtime = f.application.catalog.registry.loaded(f.application.catalog.legacySessionId) as SessionOrchestrator;
    await runtime.worker.drainOperations();
    await vi.waitFor(() => expect(f.application.catalog.catalog.provider("provider")!.verification.state).toBe("unverified"));
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.store.getCommandReceipt("actor", "fixture-turn")).toBeDefined();
  });
});
