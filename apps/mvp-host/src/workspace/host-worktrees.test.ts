import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKTREE_CAPABILITY } from "@flyx/mvp-protocol";
import { DeviceRegistry } from "../auth/device-registry.js";
import { CheckpointGitDriver } from "../checkpoint/git-driver.js";
import { HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import { SessionRegistry } from "../session/session-registry.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { openOwned } from "../storage/open-store.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { WORKTREE_SCHEMA_SQL } from "../storage/migrations/009-worktree.js";
import { HostWorktrees, worktreeDispatchContextDigest, worktreeWriterContextsDigest, type WorktreeCommandMethod, type WorktreeRpcContext } from "./host-worktrees.js";
import { RawWorktreeGit } from "./worktree-git.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { WorkspaceLease } from "./workspace-lease.js";

const roots: string[] = [], cleanups: Array<() => void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((yes, no) => execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@invalid" }, encoding: "utf8" }, (error, out) => error ? no(error) : yes(out)));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-host-worktrees-"))); roots.push(root);
  const repository = join(root, "repository"), managed = join(root, "managed"), privateRoot = join(root, "private"), coordination = join(root, "coordination");
  await mkdir(repository); await mkdir(managed); await mkdir(privateRoot);
  await git(repository, ["init", "-q"]); await writeFile(join(repository, "tracked.txt"), "base\n"); await writeFile(join(repository, ".gitignore"), "ignored*\n");
  await git(repository, ["add", "."]); await git(repository, ["commit", "-qm", "base"]);
  const owner = HostOwnerLock.acquire({ databasePath: join(privateRoot, "host.db"), identityDirectory: join(privateRoot, "identity"), coordinationDirectory: coordination });
  const store = openOwned({ databasePath: owner.databasePath, owner });
  // Fixture migration activation only. The production binding never executes DDL.
  applyCatalogMigration(store.db); store.db.exec(WORKTREE_SCHEMA_SQL);
  store.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (9,?)").run(new Date().toISOString());
  const catalog = new CatalogStore(store), workspaces = new WorkspaceRegistry(catalog, { owner, privateDirectories: [privateRoot] });
  await workspaces.registerLocal({ workspaceId: "repository-workspace", root: repository, repositoryId: "repo-one" });
  const providers = new ProviderInstanceRegistry(catalog); providers.registerLocal({ providerInstanceId: "provider-one", provider: "codex", executable: process.execPath });
  const runtimeFactory = vi.fn(() => { throw new Error("QUERY_MUST_NOT_LOAD_PROVIDER"); });
  const delivered: Array<{ type: string; inTransaction: boolean }> = [];
  const sessions = new SessionRegistry(catalog, workspaces, providers, { owner, runtimeFactory, publish: (event) => delivered.push({ type: event.type, inTransaction: store.db.inTransaction }) });
  const devices = new DeviceRegistry(store, "test-host", { recoverLeases: false });
  const context = (scopes = ["session:read", "session:write", "access:self"], capabilities = [WORKTREE_CAPABILITY], version = 2): WorktreeRpcContext => {
    const device = devices.createBrowserDevice({ scopes });
    const lease = devices.openLease(device.id, { kind: "direct", generation: 1, protocolVersion: version, capabilities, close: () => {} });
    return { subjectId: device.id, leaseId: lease.leaseId, transportGeneration: 1, protocolVersion: version, capabilities: new Set(capabilities) };
  };
  const actor = context();
  let sessionCounter = 0;
  // Seed controlled fixture facts; actual RPC writes require current resource verification.
  const createSession = (workspaceId = "repository-workspace") => { const committed = catalog.create({ authSubjectId: actor.subjectId, commandId: "session-" + ++sessionCounter }, { workspaceId, providerInstanceId: "provider-one", title: "Session " + sessionCounter }, { workspace: workspaces.require(workspaceId), provider: providers.require("provider-one") }); sessions.publishCommittedEvents(committed.events); return committed.summary.sessionId; };
  const source = createSession();
  let stopVerified = true, fault: { boundary: string; moment: string } | undefined;
  let boundaryGate: { boundary: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let ready = true, revokeAtMarker = false, proofIncludesSuccessors = true;
  const attestedContexts: number[] = [];
  const accepted: string[] = [], markers: string[] = [], launchContexts: Array<{ operationId: string; worktreeId: string; contextOperationId?: string; contextWorktreeId?: string }> = [];
  const raw = new RawWorktreeGit({ objects: (path) => new CheckpointGitDriver(path) });
  const sealGitJournal = vi.fn();
  const binding: HostWorktrees = new HostWorktrees({ catalog, workspaces, sessions, devices, owner, managedRoot: managed, privateDirectories: [privateRoot, coordination], git: raw,
    executionReadiness: () => ({ ready: true }),
    assertWriteReady: () => { if (!ready) throw new Error("RESTORE_EXTERNAL_STATE_UNVERIFIED"); },
    sealGitJournal,
    accepted: (intent) => { expect(store.db.inTransaction).toBe(false); accepted.push(intent.id); },
    producerStopProof: async (operation, original, successors) => { attestedContexts.push(1 + successors.length); return stopVerified ? { kind: "verified-worktree-stop", operationId: operation.operationId, dispatchContextDigest: worktreeDispatchContextDigest(original), writerContextsDigest: worktreeWriterContextsDigest(proofIncludesSuccessors ? [original, ...successors] : [original]), sourceId: "fixture-attestation", contractId: "deterministic-test-port" } : undefined; },
    recoveryAuthorization: (_record, operation, inspection) => ({ proof: { ownerId: owner.ownerId, ownerGeneration: owner.generation, evidenceId: inspection.evidenceId, turnId: operation.operationId, attemptId: operation.operationId, resourceKeys: ["workspace:" + binding.store.require(operation.worktreeId).path] }, verifyProof: () => stopVerified && inspection.producerStopped }),
    onBoundary: async (boundary, moment, operation) => {
      expect(store.db.inTransaction).toBe(false);
      const launch = binding.currentExecution();
      launchContexts.push({ operationId: operation.operationId, worktreeId: operation.worktreeId, ...(launch ? { contextOperationId: launch.operationId, contextWorktreeId: launch.dispatchContext.flyxTurnId } : {}) });
      const original = operation.facts.originalCommand as { intentId: string };
      const current = binding.execution.get(original.intentId)!;
      expect(["dispatching", "outcome_unknown", "settled"]).toContain(current.state);
      if (moment === "dispatched") expect(binding.store.steps(operation.operationId).some((step) => step.boundary === boundary || boundary === "publish")).toBe(true);
      if (boundaryGate?.boundary === boundary && moment === "dispatched") { boundaryGate.entered.resolve(); await boundaryGate.release.promise; }
      if (fault?.boundary === boundary && fault.moment === moment) { fault = undefined; throw new Error("fixture crash"); }
    },
    afterDispatchMarker: async (intent) => { expect(binding.execution.get(intent.id)?.state).toBe("dispatching"); markers.push(intent.id); if (revokeAtMarker) { revokeAtMarker = false; devices.revokeSelf(actor.subjectId); } },
  });
  cleanups.push(() => { binding.seal(); devices.close(); catalog.dispose(); store.close(); owner.release(); });
  let commandCounter = 0;
  const command = async (method: WorktreeCommandMethod, payload: unknown, commandId = "worktree-" + ++commandCounter, principal = actor) => binding.command(method, payload, commandId, principal);
  const run = async (commandId: string, principal = actor) => { const intent = binding.execution.forCommand(principal.subjectId, commandId)[0]!; return binding.dispatchAccepted(intent.id); };
  const create = async () => { const result = await command("worktree.create", { sessionId: source, repositoryId: "repo-one" }); await run(result.commandId); return binding.store.require(result.worktree.worktreeId); };
  return { root, repository, managed, privateRoot, coordination, owner, store, catalog, workspaces, providers, sessions, devices, runtimeFactory, delivered, actor, source, context, createSession, binding, raw, accepted, markers, launchContexts, command, run, create, sealGitJournal,
    stopVerified: (value: boolean) => { stopVerified = value; }, ready: (value: boolean) => { ready = value; }, fault: (boundary: string, moment = "applied") => { fault = { boundary, moment }; },
    revokeAtMarker: () => { revokeAtMarker = true; }, proofIncludesSuccessors: (value: boolean) => { proofIncludesSuccessors = value; }, attestedContexts,
    hold: (boundary: string) => { boundaryGate = { boundary, entered: deferred(), release: deferred() }; return boundaryGate; },
  };
}

describe("managed worktrees production Catalog binding", () => {
  it("commits real Session receipts/intent before Git, publishes only after commit, and preserves dirty state across archive/restore", { timeout: 30_000 }, async () => {
    const f = await fixture();
    const created = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "create-one");
    expect(created.receiptState).toBe("accepted"); expect(f.catalog.workspace(created.worktree.workspaceId)).toBeUndefined();
    const intent = f.binding.execution.forCommand(f.actor.subjectId, "create-one")[0]!;
    expect(intent.sessionId).toBe(f.source); expect(intent.resourceId).toBe(created.worktree.worktreeId); expect(intent.dispatchContext?.flyxTurnId).toBe(intent.resourceId);
    expect(f.binding.store.steps(created.operation.operationId)).toHaveLength(0);
    await f.run("create-one");
    expect(f.markers).toEqual([intent.id]);
    const record = f.binding.store.require(created.worktree.worktreeId);
    expect(f.workspaces.require(record.workspaceId).canonicalRoot).toBe(record.path);
    const first = f.createSession(record.workspaceId), second = f.createSession(record.workspaceId);
    await writeFile(join(record.path, "tracked.txt"), "staged\n"); await git(record.path, ["add", "tracked.txt"]);
    await writeFile(join(record.path, "tracked.txt"), "dirty\n"); await writeFile(join(record.path, "untracked.txt"), "keep\n");
    const before = await f.raw.fingerprint(record.path);
    const archived = await f.command("worktree.archive", { sessionId: first, worktreeId: record.worktreeId, expectedRevision: record.revision }, "archive-one");
    expect(f.catalog.workspace(record.workspaceId)?.state).toBe("needs_verification");
    await f.run(archived.commandId);
    const snapshot = f.binding.store.require(record.worktreeId);
    expect(snapshot.state).toBe("archived"); expect(f.catalog.workspace(record.workspaceId)?.state).toBe("disabled");
    expect(f.sessions.get(first).status).toBe("active"); expect(f.sessions.get(second).status).toBe("active");
    expect(await lstat(record.path).catch(() => undefined)).toBeUndefined();
    const restore = await f.command("worktree.restore", { sessionId: first, worktreeId: record.worktreeId, expectedRevision: snapshot.revision }, "restore-one");
    await f.run(restore.commandId);
    expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe("dirty\n"); expect(await readFile(join(record.path, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(await git(record.path, ["show", ":tracked.txt"])).toBe("staged\n");
    expect((await f.raw.fingerprint(record.path)).workspaceDigest).toBe(before.workspaceDigest);
    expect(f.binding.getReceipt({ sessionId: first, commandId: "restore-one" }, f.actor)).toMatchObject({ found: true, state: "completed" });
    expect(f.binding.list({ sessionId: first }, f.actor).worktrees).toHaveLength(1);
    expect(f.binding.getOperation({ sessionId: f.source, operationId: created.operation.operationId }, f.actor).operation.state).toBe("completed");
    expect(f.runtimeFactory).not.toHaveBeenCalled(); expect(f.delivered.every((event) => !event.inTransaction)).toBe(true);
    const publicJson = JSON.stringify(f.binding.list({ sessionId: first }, f.actor)); expect(publicJson).not.toContain(f.root); expect(publicJson).not.toContain("dispatchContext");
    expect(await f.binding.closeAndWait()).toMatchObject({ drained: true, producerStopped: false, clean: false, state: "recovery_required" });
  });

  it("requires original Actor, V2 capability and scopes; hashes the real Session and all normalized inputs", async () => {
    const f = await fixture();
    const created = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "stable");
    const duplicate = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one", ref: "HEAD", branchMode: "detached" }, "stable");
    expect(duplicate.reused).toBe(true); expect(duplicate.operation.operationId).toBe(created.operation.operationId); expect(f.accepted).toHaveLength(1);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one", branchMode: "generated" }, "stable")).rejects.toThrow("COMMAND_ID_REUSED");
    await expect(f.command("worktree.create", { sessionId: f.createSession(), repositoryId: "repo-one" }, "stable")).rejects.toThrow("COMMAND_ID_REUSED");
    const other = f.context();
    expect(f.binding.getReceipt({ sessionId: f.source, commandId: "stable" }, other)).toEqual({ found: false, commandId: "stable" });
    expect(() => f.binding.getOperation({ sessionId: f.source, operationId: created.operation.operationId }, other)).toThrow(/another Actor/);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "v1", f.context(undefined, undefined, 1))).rejects.toThrow(/version 2/);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "cap", f.context(undefined, []))).rejects.toThrow(/capability/);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "read-only", f.context(["session:read"]))).rejects.toThrow(/session:write/);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one", path: f.root }, "path")).rejects.toThrow(/invalid/);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one", ref: "--exec=evil" }, "ref")).rejects.toThrow(/invalid/);
    f.ready(false);
    expect(f.binding.list({ sessionId: f.source }, f.actor).worktrees).toHaveLength(1);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "restored")).rejects.toThrow(/RESTORE_EXTERNAL/);
    expect(f.binding.execution.forCommand(f.actor.subjectId, "restored")).toHaveLength(0); expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it("rolls back Catalog reservation, operation, receipt, and intent together and never publishes before the outer commit", { timeout: 30_000 }, async () => {
    const f = await fixture(), record = await f.create(), sessionId = f.createSession(record.workspaceId);
    const beforeEvents = f.delivered.length;
    const detach = f.store.registerProjectionHook((_id, event) => { if (event.type === "worktree.archive.accepted") throw new Error("projection fault"); });
    await expect(f.command("worktree.archive", { sessionId, worktreeId: record.worktreeId, expectedRevision: record.revision }, "rollback")).rejects.toThrow(/projection fault/); detach();
    expect(f.binding.store.findCommand(f.actor.subjectId, "rollback")).toBeUndefined(); expect(f.store.getCommandReceipt(f.actor.subjectId, "rollback")).toBeUndefined();
    expect(f.binding.execution.forCommand(f.actor.subjectId, "rollback")).toHaveLength(0); expect(f.catalog.workspace(record.workspaceId)?.state).toBe("active");
    expect(f.binding.store.require(record.worktreeId)).toEqual(record); expect(f.delivered).toHaveLength(beforeEvents);
    const accepted = await f.command("worktree.archive", { sessionId, worktreeId: record.worktreeId, expectedRevision: record.revision }, "rollback");
    await f.run(accepted.commandId); expect(f.catalog.workspace(record.workspaceId)?.state).toBe("disabled");
  });

  it("scans every Session on a checkout and keeps distinct worktrees independently leased across databases", { timeout: 30_000 }, async () => {
    const f = await fixture(), one = await f.create(), two = await f.create();
    const a = f.createSession(one.workspaceId), b = f.createSession(one.workspaceId), isolated = f.createSession(two.workspaceId);
    f.catalog.setResidency(b, "loaded");
    await expect(f.command("worktree.archive", { sessionId: a, worktreeId: one.worktreeId, expectedRevision: one.revision })).rejects.toThrow(/resident/);
    f.catalog.setResidency(b, "unloaded");
    const otherOwner = HostOwnerLock.acquire({ databasePath: join(f.privateRoot, "other.db"), identityDirectory: join(f.privateRoot, "other-identity"), coordinationDirectory: f.coordination });
    const otherStore = openOwned({ databasePath: otherOwner.databasePath, owner: otherOwner });
    const same = WorkspaceLease.acquire({ workspace: one.path, owner: otherOwner, operationId: "other-writer" });
    const separate = WorkspaceLease.acquire({ workspace: two.path, owner: f.owner, operationId: "isolated-writer" });
    try {
      expect(same.resourceKey).not.toBe(separate.resourceKey);
      const accepted = await f.command("worktree.archive", { sessionId: a, worktreeId: one.worktreeId, expectedRevision: one.revision });
      expect(await f.run(accepted.commandId)).toMatchObject({ status: "settled", resultCode: "WORKSPACE_BUSY" });
      expect(f.binding.store.require(one.worktreeId).state).toBe("active"); expect(f.catalog.workspace(one.workspaceId)?.state).toBe("active");
      expect(f.sessions.get(isolated).workspaceId).toBe(two.workspaceId);
      expect(f.binding.store.steps(accepted.operation.operationId).some((step) => step.boundary === "capture")).toBe(false);
    } finally { same.release(); separate.release(); otherStore.close(); otherOwner.release(); }
  });

  it("keeps interrupted writers fenced and accepts separate recovery receipts only with the original proof and fresh observation CAS", { timeout: 30_000 }, async () => {
    const f = await fixture(); f.fault("register");
    const created = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "original");
    expect(await f.run(created.commandId)).toMatchObject({ status: "outcome_unknown" });
    f.stopVerified(false);
    const originalContext = JSON.stringify((f.binding.store.operation(created.operation.operationId).facts.originalCommand as { dispatchContext: unknown }).dispatchContext);
    const reconcile = await f.command("worktree.reconcile", { sessionId: f.source, operationId: created.operation.operationId }, "inspect-unknown");
    await f.run(reconcile.commandId);
    const unknown = f.binding.getReceipt({ sessionId: f.source, commandId: reconcile.commandId }, f.actor);
    expect(unknown).toMatchObject({ found: true, state: "completed", response: { inspection: { producerStopped: false, canResume: false } } });
    if (!unknown.found) throw new Error("receipt missing");
    await expect(f.command("worktree.resume", { sessionId: f.source, operationId: created.operation.operationId, evidenceId: unknown.response.inspection!.evidenceId }, "resume-unknown")).rejects.toThrow(/every original helper/);
    expect(f.binding.execution.forCommand(f.actor.subjectId, "resume-unknown")).toHaveLength(0);
    f.stopVerified(true);
    const verified = await f.command("worktree.reconcile", { sessionId: f.source, operationId: created.operation.operationId }, "inspect-verified"); await f.run(verified.commandId);
    const receipt = f.binding.getReceipt({ sessionId: f.source, commandId: verified.commandId }, f.actor); if (!receipt.found) throw new Error("receipt missing");
    const evidenceId = receipt.response.inspection!.evidenceId;
    const resumed = await f.command("worktree.resume", { sessionId: f.source, operationId: created.operation.operationId, evidenceId }, "resume-verified");
    expect(resumed.receiptState).toBe("accepted");
    await f.run(resumed.commandId);
    expect(f.binding.getReceipt({ sessionId: f.source, commandId: "original" }, f.actor)).toMatchObject({ found: true, state: "completed" });
    expect(f.binding.getReceipt({ sessionId: f.source, commandId: "resume-verified" }, f.actor)).toMatchObject({ found: true, state: "completed" });
    expect(JSON.stringify((f.binding.store.operation(created.operation.operationId).facts.originalCommand as { dispatchContext: unknown }).dispatchContext)).toBe(originalContext);
    expect(f.binding.store.steps(created.operation.operationId).filter((step) => step.boundary === "register")).toHaveLength(1);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("revalidates revocation after the durable marker and settles a known non-invocation without Git", async () => {
    const f = await fixture();
    const accepted = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "revoked-before-call");
    f.revokeAtMarker();
    expect(await f.run(accepted.commandId)).toMatchObject({ status: "settled", resultCode: "DEVICE_REVOKED" });
    expect(f.binding.store.steps(accepted.operation.operationId)).toHaveLength(0);
    expect(f.store.getCommandReceipt(f.actor.subjectId, accepted.commandId)?.state).toBe("failed");
    expect(f.binding.execution.forCommand(f.actor.subjectId, accepted.commandId)[0]?.state).toBe("settled");
    expect(await lstat(f.binding.store.require(accepted.worktree.worktreeId).path).catch(() => undefined)).toBeUndefined();
    expect(() => f.binding.getReceipt({ sessionId: f.source, commandId: accepted.commandId }, f.actor)).toThrow();
    const newlyPaired = f.context(); expect(f.binding.getReceipt({ sessionId: f.source, commandId: accepted.commandId }, newlyPaired)).toEqual({ found: false, commandId: accepted.commandId });
  });

  it("keeps verified Git files fenced when the final Catalog/receipt transaction rolls back", async () => {
    const f = await fixture(), accepted = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "final-fault");
    const detach = f.store.registerProjectionHook((_id, event) => { if (event.type === "worktree.create.completed") throw new Error("final receipt fault"); });
    expect(await f.run(accepted.commandId)).toMatchObject({ status: "outcome_unknown" }); detach();
    expect(f.catalog.workspace(accepted.worktree.workspaceId)).toBeUndefined();
    expect(f.store.getCommandReceipt(f.actor.subjectId, accepted.commandId)?.state).toBe("outcome_unknown");
    expect(f.delivered.some((event) => event.type === "worktree.create.completed")).toBe(false);
    expect(await readFile(join(f.binding.store.require(accepted.worktree.worktreeId).path, "tracked.txt"), "utf8")).toBe("base\n");
  });

  it("requires stop proof for every dispatched successor before another resume can claim", { timeout: 30_000 }, async () => {
    const f = await fixture(); f.fault("register");
    const accepted = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "chain-original"); await f.run(accepted.commandId); f.stopVerified(true);
    const inspect = async (commandId: string) => {
      await f.command("worktree.reconcile", { sessionId: f.source, operationId: accepted.operation.operationId }, commandId); await f.run(commandId);
      const receipt = f.binding.getReceipt({ sessionId: f.source, commandId }, f.actor); if (!receipt.found || !receipt.response.inspection) throw new Error("inspection missing"); return receipt.response.inspection;
    };
    const first = await inspect("chain-inspect-one");
    await f.command("worktree.resume", { sessionId: f.source, operationId: accepted.operation.operationId, evidenceId: first.evidenceId }, "chain-resume-one");
    f.fault("materialize"); expect(await f.run("chain-resume-one")).toMatchObject({ status: "outcome_unknown" });
    f.proofIncludesSuccessors(false);
    const incomplete = await inspect("chain-inspect-incomplete"); expect(incomplete.producerStopped).toBe(false);
    await expect(f.command("worktree.resume", { sessionId: f.source, operationId: accepted.operation.operationId, evidenceId: incomplete.evidenceId }, "chain-resume-denied")).rejects.toThrow(/every original helper/);
    expect(f.binding.execution.forCommand(f.actor.subjectId, "chain-resume-denied")).toHaveLength(0);
    f.proofIncludesSuccessors(true); const complete = await inspect("chain-inspect-complete"); expect(complete.producerStopped).toBe(true);
    await f.command("worktree.resume", { sessionId: f.source, operationId: accepted.operation.operationId, evidenceId: complete.evidenceId }, "chain-resume-two");
    expect(await f.run("chain-resume-two")).toMatchObject({ status: "settled" });
    expect(f.attestedContexts).toContain(2);
    expect(f.binding.getReceipt({ sessionId: f.source, commandId: "chain-original" }, f.actor)).toMatchObject({ found: true, state: "completed" });
    expect(f.binding.getReceipt({ sessionId: f.source, commandId: "chain-resume-one" }, f.actor)).toMatchObject({ found: true, state: "completed" });
    expect(f.catalog.assertIdle(f.source)).toBeUndefined();
  });

  it("seals idempotently without draining and cancels accepted commands that were never dispatched", async () => {
    const f = await fixture(), accepted = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "drain-running");
    const hold = f.hold("register"), run = f.run(accepted.commandId); await hold.entered.promise;
    expect(await f.binding.closeAndWait(1)).toMatchObject({ drained: false, producerStopped: false, clean: false });
    const record = f.binding.store.require(accepted.worktree.worktreeId);
    const peer = HostOwnerLock.acquire({ databasePath: join(f.privateRoot, "seal-peer.db"), identityDirectory: join(f.privateRoot, "seal-peer-identity"), coordinationDirectory: f.coordination });
    try {
      expect(() => f.binding.seal()).not.toThrow();
      expect(() => f.binding.seal()).not.toThrow();
      expect(f.sealGitJournal).toHaveBeenCalledTimes(1);
      // A callback fence must not release the running producer's retained checkout lease.
      expect(() => WorkspaceLease.acquire({ workspace: record.path, owner: peer })).toThrow(/holds this resource/);
    } finally { peer.release(); }
    hold.release.resolve(); await run;
    expect(await f.binding.closeAndWait(100)).toMatchObject({ drained: true, producerStopped: false, clean: false });
    // The fence rejects the late publication of a producer that was still running at seal time: its Git
    // work cannot be claimed as a committed result, so the durable row stays explicitly unproven.
    expect(f.binding.store.operation(accepted.operation.operationId).state).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt(f.actor.subjectId, accepted.commandId)?.state).toBe("outcome_unknown");
    // A sealed driver closes query admission too; the durable row stays the source of truth.
    expect(() => f.binding.getOperation({ sessionId: f.source, operationId: accepted.operation.operationId }, f.actor)).toThrow(/unavailable/);
    const queued = await fixture(), pending = await queued.command("worktree.create", { sessionId: queued.source, repositoryId: "repo-one" }, "never-dispatched");
    await queued.binding.closeAndWait(100);
    expect(queued.store.getCommandReceipt(queued.actor.subjectId, pending.commandId)?.state).toBe("failed");
    expect(queued.binding.execution.forCommand(queued.actor.subjectId, pending.commandId)[0]?.state).toBe("settled");
    expect(queued.binding.store.steps(pending.operation.operationId)).toHaveLength(0);
    await expect(queued.command("worktree.create", { sessionId: queued.source, repositoryId: "repo-one" }, "late")).rejects.toThrow(/admission/);
    expect(() => queued.binding.seal()).not.toThrow();
    expect(() => queued.binding.seal()).not.toThrow();
    expect(queued.sealGitJournal).toHaveBeenCalledTimes(1);
  });

  it("retains the original checkout lease and withholds final Catalog publication when current Git tree stop is unverified", async () => {
    const f = await fixture(); f.stopVerified(false);
    const accepted = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "unverified-stop");
    expect(await f.run(accepted.commandId)).toMatchObject({ status: "outcome_unknown", resultCode: "WORKTREE_PRODUCER_UNKNOWN" });
    const record = f.binding.store.require(accepted.worktree.worktreeId);
    expect(f.catalog.workspace(record.workspaceId)).toBeUndefined(); expect(record.state).toBe("blocked");
    expect(f.binding.getReceipt({ sessionId: f.source, commandId: accepted.commandId }, f.actor)).toMatchObject({ found: true, state: "outcome_unknown" });
    const other = HostOwnerLock.acquire({ databasePath: join(f.privateRoot, "unverified-peer.db"), identityDirectory: join(f.privateRoot, "unverified-peer-identity"), coordinationDirectory: f.coordination });
    try { expect(() => WorkspaceLease.acquire({ workspace: record.path, owner: other })).toThrow(/holds this resource/); } finally { other.release(); }
    expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it("keeps actual launch contexts isolated while two unloaded source Sessions create worktrees concurrently", async () => {
    const f = await fixture(), secondSource = f.createSession();
    const first = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "concurrent-one");
    const second = await f.command("worktree.create", { sessionId: secondSource, repositoryId: "repo-one" }, "concurrent-two");
    const outcomes = await Promise.all([f.run(first.commandId), f.run(second.commandId)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["settled", "settled"]);
    expect(f.binding.store.require(first.worktree.worktreeId).state).toBe("active"); expect(f.binding.store.require(second.worktree.worktreeId).state).toBe("active");
    expect(f.launchContexts.length).toBeGreaterThan(0);
    for (const launch of f.launchContexts) { expect(launch.contextOperationId).toBe(launch.operationId); expect(launch.contextWorktreeId).toBe(launch.worktreeId); }
    expect(f.binding.currentExecution()).toBeUndefined(); expect(f.runtimeFactory).not.toHaveBeenCalled();
  });

  it("fails closed without cached verified backend readiness while SQL history remains readable", async () => {
    const f = await fixture(); await f.create();
    delete f.binding.options.executionReadiness;
    expect(f.binding.readiness()).toEqual({ queryReady: true, executionReady: false, reasonCode: "WORKTREE_STOP_CONTRACT_UNVERIFIED" });
    expect(f.binding.list({ sessionId: f.source }, f.actor).worktrees).toHaveLength(1);
    await expect(f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "unsupported-backend")).rejects.toThrow(/verified private-data boundary/);
    expect(f.store.getCommandReceipt(f.actor.subjectId, "unsupported-backend")).toBeUndefined();
    f.binding.options.executionReadiness = () => ({ ready: false, reasonCode: f.privateRoot });
    expect(JSON.stringify(f.binding.readiness())).not.toContain(f.privateRoot);
  });

  it("projects safe public error codes when a local Git diagnostic contains a private path", async () => {
    const f = await fixture(); vi.spyOn(f.raw, "resolve").mockRejectedValue({ code: f.privateRoot });
    const accepted = await f.command("worktree.create", { sessionId: f.source, repositoryId: "repo-one" }, "private-error");
    expect(await f.run(accepted.commandId)).toMatchObject({ status: "outcome_unknown", resultCode: "WORKTREE_OPERATION_UNKNOWN" });
    expect(JSON.stringify(f.binding.getReceipt({ sessionId: f.source, commandId: accepted.commandId }, f.actor))).not.toContain(f.privateRoot);
    expect(JSON.stringify(f.binding.getOperation({ sessionId: f.source, operationId: accepted.operation.operationId }, f.actor))).not.toContain(f.privateRoot);
  });

});
