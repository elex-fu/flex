import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApplication } from "../host-application.js";
import { parseConnectivityConfig } from "../connectivity/config.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { HostOwnerLock } from "./host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { createMacosManagedExecution } from "./macos-managed-execution.js";
import { inspectCatalogStartupReadiness } from "../session/catalog-startup-readiness.js";
import { ManagedGitRunner } from "./managed-git-runner.js";
import { SqliteProcessJournal } from "./managed-process-registry.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";

it.skipIf(process.platform !== "darwin")("composes the actual macOS backend and preserves activation and original-stop gates", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-macos-composition-")));
  const workspace = join(root, "workspace"), data = join(root, "data");
  await mkdir(workspace); await mkdir(data);
  await promisify(execFile)("/usr/bin/git", ["init", "-q", workspace]);
  const owner = HostOwnerLock.acquire({ databasePath: join(data, "host.sqlite"), identityDirectory: join(data, "identity"), coordinationDirectory: join(root, "coordination") });
  const store = openOwned({ databasePath: owner.databasePath, owner });
  const identity = await loadOrCreateHostIdentity({ directory: owner.identityDirectory! }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const execution = await createMacosManagedExecution({ identity, compatibilityEvidencePath: join(data, "evidence.jsonl"), compatibilityEndorsementPath: join(data, "endorsement.json"), worktreesRoot: join(root, "worktrees") });
  const app = await createHostApplication({ store, owner, identity, execution: execution!,
    configuration: { workspaces: [{ workspaceId: "workspace", root: workspace }], providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable: "/usr/bin/true", policyCapabilities: ["workspaceWrite", "interrupt"] }] },
    initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" },
    server: { pairingConfirmation: () => true, port: 0, connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1", PORT: "4173" }) } });
  const runner = new ManagedGitRunner({ ...execution!.git!, journal: new SqliteProcessJournal(store.db), roots: () => [workspace], privateRoots: [data],
    context: () => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: "local-query", runtimeGeneration: 1, attemptId: "query" }) });
  try {
    await app.start(); expect((await app.queryReadiness()).ready).toBe(true);
    expect(app.catalog.registry.loaded(app.catalog.legacySessionId)).toBeUndefined();
    expect(app.startupReadiness().ready).toBe(false); // Installed backend alone does not activate a Provider.
    const result = await runner.run({ purpose: "checkpoint_read", args: ["rev-parse", "--show-toplevel"], cwd: workspace, maxOutputBytes: 4096, timeoutMs: 5000 });
    expect(result.stopProof.kind).toBe("managed-group-stop"); expect(result.stopProof.contractId).toBe(MACOS_MANAGED_STOP_CONTRACT);
    expect(inspectCatalogStartupReadiness(app.catalog).ready).toBe(true);
    store.db.prepare("UPDATE managed_process_stop_proofs SET proof_json=? WHERE process_id=?").run(JSON.stringify({ ...result.stopProof, launchDigest: "b".repeat(64) }), result.processId);
    try { expect(inspectCatalogStartupReadiness(app.catalog).blockers).toContain("ORIGINAL_PROCESS_STOP_UNVERIFIED"); }
    finally { store.db.prepare("UPDATE managed_process_stop_proofs SET proof_json=? WHERE process_id=?").run(JSON.stringify(result.stopProof), result.processId); }
  } catch (error) { console.error("COMPOSITION_CHECK_FAILED", error); throw error; }
  finally {
    await runner.closeAndWait(); runner.sealJournal();
    try { await app.stop(); } catch (error) { console.error("COMPOSITION_CLEANUP_FAILED", owner.retainedReason); throw error; }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
