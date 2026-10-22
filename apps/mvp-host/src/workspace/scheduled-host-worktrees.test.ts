import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKTREE_CAPABILITY } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { ManagedGitRunner, ManagedGitError } from "../lifecycle/managed-git-runner.js";
import { SqliteProcessJournal } from "../lifecycle/managed-process-registry.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import { SessionRegistry } from "../session/session-registry.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { openOwned } from "../storage/open-store.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { WORKTREE_SCHEMA_SQL } from "../storage/migrations/009-worktree.js";
import { fixtureTreeStopBackend, rawWorkspaceGitQuery, trustedFixtureGit } from "../test-support/managed-git-fixtures.js";
import { HostWorktrees } from "./host-worktrees.js";
import { createManagedScheduledHostWorktrees } from "./managed-host-worktrees.js";
import { createManagedRepositoryMetadata, type ManagedRepositoryMetadataInput } from "./managed-repository-metadata.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "test@invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "test@invalid" } }, (error) => error ? reject(error) : resolve()));
}
async function fixture(input: { contextMismatch?: boolean; contractMismatch?: boolean; corruptProof?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-managed-worktree-graph-")));
  const repository = join(root, "repository"), managed = join(root, "managed"), privateRoot = join(root, "private");
  for (const path of [repository, managed, privateRoot]) await mkdir(path);
  await git(repository, ["init", "-q"]); await writeFile(join(repository, "tracked.txt"), "base\n");
  await git(repository, ["add", "."]); await git(repository, ["commit", "-qm", "base"]);
  const owner = HostOwnerLock.acquire({ databasePath: join(privateRoot, "host.sqlite"), identityDirectory: join(privateRoot, "identity"), coordinationDirectory: join(root, "coordination") });
  const store = openOwned({ databasePath: owner.databasePath, owner }); applyCatalogMigration(store.db); store.db.exec(WORKTREE_SCHEMA_SQL);
  store.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(9,?)").run(new Date().toISOString());
  const catalog = new CatalogStore(store), workspaces = new WorkspaceRegistry(catalog, { owner, privateDirectories: [privateRoot], readOnlyGit: rawWorkspaceGitQuery() });
  await workspaces.registerLocal({ workspaceId: "repo-workspace", root: repository, repositoryId: "repo" });
  const providers = new ProviderInstanceRegistry(catalog); providers.registerLocal({ providerInstanceId: "provider", provider: "codex", executable: process.execPath });
  const runtimeFactory = vi.fn(() => { throw new Error("PROVIDER_MUST_REMAIN_UNLOADED"); });
  const sessions = new SessionRegistry(catalog, workspaces, providers, { owner, runtimeFactory });
  const devices = new DeviceRegistry(store, "fixture", { recoverLeases: false }), device = devices.createBrowserDevice({ scopes: ["session:read", "session:write"] });
  const lease = devices.openLease(device.id, { kind: "direct", generation: 1, protocolVersion: 2, capabilities: [WORKTREE_CAPABILITY], close: () => undefined });
  const actor = { subjectId: device.id, leaseId: lease.leaseId, transportGeneration: 1, protocolVersion: 2, capabilities: new Set([WORKTREE_CAPABILITY]) };
  let sequence = 0, ready = true, markerCount = 0, failCaptureMetadata = false, failBoundary: string | undefined;
  const source = (workspaceId = "repo-workspace") => catalog.create({ authSubjectId: device.id, commandId: `session-${++sequence}` }, { workspaceId, providerInstanceId: "provider", title: "Fixture" }, { workspace: workspaces.require(workspaceId), provider: providers.require("provider") }).summary.sessionId;
  let bindings: ReturnType<typeof createManagedScheduledHostWorktrees> | undefined;
  let runner!: ManagedGitRunner;
  const metadata = createManagedRepositoryMetadata({ owner, runner: () => runner });
  const metadataCalls: ManagedRepositoryMetadataInput[] = [];
  const metadataPort: typeof metadata.run = async (request, action) => {
    metadataCalls.push(request);
    return metadata.run(request, async () => {
    const result = await action();
    if (failCaptureMetadata && request.args.includes("update-ref") && bindings?.worktrees.currentExecution()?.method === "worktree.archive" && request.operationId !== bindings.worktrees.currentExecution()?.operationId) {
      failCaptureMetadata = false; throw new ManagedGitError("MANAGED_GIT_TREE_STOP_UNPROVEN", "unknown");
    }
    return result;
    });
  };
  runner = new ManagedGitRunner({ journal: new SqliteProcessJournal(store.db),
    context: () => {
      const context = bindings?.worktrees.currentExecution()?.dispatchContext;
      if (!context) throw new Error("FIXTURE_CONTEXT_MISSING");
      return input.contextMismatch ? { ...context, runtimeId: "wrong-original-runtime" } : context;
    },
    stopBackend: fixtureTreeStopBackend(), allowFixtureStopBackend: true,
    roots: () => [repository, managed], privateRoots: [privateRoot], gitExecutable: trustedFixtureGit(), repositoryMetadata: metadataPort,
  });
  bindings = createManagedScheduledHostWorktrees({ catalog, workspaces, sessions, devices, owner, managedRoot: managed, privateDirectories: [privateRoot], runner,
    stopContractId: input.contractMismatch ? "different-stop-contract" : "fixture-verified-tree-stop/v1", repositoryMetadata: metadata,
    executionReadiness: () => ({ ready: true }), assertWriteReady: () => { if (!ready) throw new Error("HOST_BOOTING"); },
    afterDispatchMarker: async () => { markerCount++; },
    onBoundary: async (boundary, moment) => {
      if (failBoundary === boundary && moment === "applied") { failBoundary = undefined; throw new Error("deterministic boundary crash"); }
      if (input.corruptProof && boundary === "publish" && moment === "dispatched") {
        const row = store.db.prepare("SELECT process_id,proof_json FROM managed_process_stop_proofs LIMIT 1").get() as { process_id: string; proof_json: string };
        store.db.prepare("UPDATE managed_process_stop_proofs SET proof_json=? WHERE process_id=?").run(JSON.stringify({ ...JSON.parse(row.proof_json), identityDigest: "0".repeat(64) }), row.process_id);
      }
    },
  });
  const graph = bindings;
  const acceptor = new HostWorktrees({ ...graph.worktrees.options, accepted: () => undefined });
  cleanup.push(async () => { await runner.closeAndWait(5000); graph.seal(); acceptor.seal(); metadata.seal(); devices.close(); catalog.dispose(); store.close(); owner.release(); await rm(root, { recursive: true, force: true }); });
  return { graph, acceptor, metadataCalls, metadata, runtimeFactory, catalog, store, actor, source, ready: (value: boolean) => { ready = value; }, markers: () => markerCount,
    failAt: (boundary: string) => { failBoundary = boundary; }, failCaptureMetadata: () => { failCaptureMetadata = true; } };
}

describe("deterministic managed Worktree graph (fixture stop backend, not native acceptance)", () => {
  it("scans durable pending work only after graph readiness and claims each original once", { timeout: 30_000 }, async () => {
    const f = await fixture(), sessionId = f.source();
    const accepted = await f.acceptor.command("worktree.create", { sessionId, repositoryId: "repo" }, "startup", f.actor);
    f.ready(false); await new Promise((resolve) => setImmediate(resolve));
    const intent = f.graph.worktrees.execution.forCommand(f.actor.subjectId, "startup")[0]!;
    expect(f.graph.worktrees.execution.get(intent.id)?.state).toBe("pending"); expect(f.markers()).toBe(0);
    f.ready(true); expect(f.graph.start()).toBe(1); expect(f.graph.start()).toBe(0);
    f.graph.scheduler.accepted(intent); expect(await f.graph.scheduler.drain(25_000)).toBe(true);
    expect(f.markers()).toBe(1);
    const operation = f.graph.worktrees.store.operation(accepted.operation.operationId);
    expect(operation, JSON.stringify({ operation, steps: f.graph.worktrees.store.steps(operation.operationId), processes: f.store.db.prepare("SELECT state,error_code FROM managed_processes").all() })).toMatchObject({ state: "completed" });
    expect(await readFile(join(f.graph.worktrees.store.require(accepted.worktree.worktreeId).path, "tracked.txt"), "utf8")).toBe("base\n");
    expect(f.metadataCalls.some((request) => request.args.some((argument, index) => argument === "worktree" && request.args[index + 1] === "add"))).toBe(true);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("wakes after acceptance commit and fences reserved dispatch before native launch on seal", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const accepted = await f.graph.worktrees.command("worktree.create", { sessionId: f.source(), repositoryId: "repo" }, "wake", f.actor);
    expect(await f.graph.scheduler.drain(25_000)).toBe(true);
    expect(f.graph.worktrees.store.operation(accepted.operation.operationId).state).toBe("completed");
    const pending = await f.acceptor.command("worktree.create", { sessionId: f.source(), repositoryId: "repo" }, "seal", f.actor);
    const launches = (f.store.db.prepare("SELECT count(*) AS n FROM managed_processes").get() as { n: number }).n;
    f.graph.start(); f.graph.seal(); expect(await f.graph.scheduler.drain(1000)).toBe(true);
    expect(f.graph.worktrees.store.operation(pending.operation.operationId).state).toBe("pending");
    expect((f.store.db.prepare("SELECT count(*) AS n FROM managed_processes").get() as { n: number }).n).toBe(launches);
    expect(f.markers()).toBe(1);
  });
  it.each([{ contextMismatch: true }, { contractMismatch: true }, { corruptProof: true }])("refuses publication without exact original-context stop evidence: %j", { timeout: 30_000 }, async (fault) => {
    const f = await fixture(fault);
    const accepted = await f.graph.worktrees.command("worktree.create", { sessionId: f.source(), repositoryId: "repo" }, "unknown", f.actor);
    expect(await f.graph.scheduler.drain(25_000)).toBe(true);
    expect(f.graph.worktrees.store.operation(accepted.operation.operationId)).toMatchObject({ state: "outcome_unknown", errorCode: "WORKTREE_PRODUCER_UNKNOWN" });
    expect(f.catalog.workspace(accepted.worktree.workspaceId)).toBeUndefined();
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("clears the original live checkout only through a committed resume gate and reaches completed", { timeout: 30_000 }, async () => {
    const f = await fixture(), sessionId = f.source(); f.failAt("register");
    const accepted = await f.graph.worktrees.command("worktree.create", { sessionId, repositoryId: "repo" }, "original-crash", f.actor);
    await f.graph.scheduler.drain(25_000);
    expect(f.graph.worktrees.store.operation(accepted.operation.operationId).state).toBe("outcome_unknown");
    await f.graph.worktrees.command("worktree.reconcile", { sessionId, operationId: accepted.operation.operationId }, "inspect-original", f.actor); await f.graph.scheduler.drain(25_000);
    const inspected = f.graph.worktrees.getReceipt({ sessionId, commandId: "inspect-original" }, f.actor);
    if (!inspected.found || !inspected.response.inspection) throw new Error("inspection missing");
    expect(inspected.response.inspection.canResume).toBe(true);
    await f.graph.worktrees.command("worktree.resume", { sessionId, operationId: accepted.operation.operationId, evidenceId: inspected.response.inspection.evidenceId }, "resume-original", f.actor); await f.graph.scheduler.drain(25_000);
    expect(f.graph.worktrees.store.operation(accepted.operation.operationId).state).toBe("completed");
    expect(f.graph.worktrees.getReceipt({ sessionId, commandId: "resume-original" }, f.actor)).toMatchObject({ found: true, state: "completed" });
  });
  it("recovers a retained captureId metadata lock with its original purpose before archive resumes", { timeout: 60_000 }, async () => {
    const f = await fixture();
    const created = await f.graph.worktrees.command("worktree.create", { sessionId: f.source(), repositoryId: "repo" }, "create-for-archive", f.actor); await f.graph.scheduler.drain(25_000);
    const record = f.graph.worktrees.store.require(created.worktree.worktreeId), sessionId = f.source(record.workspaceId);
    await writeFile(join(record.path, "tracked.txt"), "staged\n"); await git(record.path, ["add", "tracked.txt"]);
    await writeFile(join(record.path, "tracked.txt"), "unstaged\n"); await writeFile(join(record.path, "untracked.txt"), "preserve\n");
    f.failCaptureMetadata();
    const archived = await f.graph.worktrees.command("worktree.archive", { sessionId, worktreeId: record.worktreeId, expectedRevision: record.revision }, "archive-crash", f.actor); await f.graph.scheduler.drain(25_000);
    expect(f.graph.worktrees.store.operation(archived.operation.operationId).state).toBe("outcome_unknown"); expect(f.metadata.locks.retainedCount).toBe(1);
    const recoveryRevision = f.graph.worktrees.store.require(record.worktreeId).revision;
    await f.graph.worktrees.command("worktree.reconcile", { sessionId, operationId: archived.operation.operationId }, "inspect-archive", f.actor); await f.graph.scheduler.drain(25_000);
    const inspected = f.graph.worktrees.getReceipt({ sessionId, commandId: "inspect-archive" }, f.actor);
    if (!inspected.found || !inspected.response.inspection) throw new Error("archive inspection missing");
    expect(inspected.response.inspection.canResume).toBe(true);
    await f.graph.worktrees.command("worktree.resume", { sessionId, operationId: archived.operation.operationId, evidenceId: inspected.response.inspection.evidenceId }, "resume-archive", f.actor); await f.graph.scheduler.drain(25_000);
    expect(f.metadata.locks.retainedCount).toBe(0); expect(f.graph.worktrees.store.operation(archived.operation.operationId).state).toBe("completed");
    expect(f.graph.worktrees.store.operation(archived.operation.operationId).facts.metadataRecovery).toMatchObject({ evidenceId: inspected.response.inspection.evidenceId, observedRevision: recoveryRevision });
  });
});
