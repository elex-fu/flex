import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointGitDriver } from "../checkpoint/git-driver.js";
import { HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { WorkspaceLease } from "./workspace-lease.js";
import { WORKTREE_SCHEMA_SQL } from "../storage/migrations/009-worktree.js";
import { RawWorktreeGit } from "./worktree-git.js";
import { WorktreeStore, WorktreeError, type ManagedWorktreeRecord, type WorktreeOperationRecord } from "./worktree-store.js";
import { WorktreeService, type WorktreeCatalog } from "./worktree-service.js";
import { rawCheckpointGitRunner } from "../test-support/managed-git-fixtures.js";

const roots: string[] = [], databases: Database.Database[] = [], owners: HostOwnerHandle[] = [], leases: Array<{ lease: WorkspaceLease; owner: HostOwnerHandle; operationId: string }> = [];
afterEach(async () => {
  for (const entry of leases.splice(0)) { try { entry.lease.clearRetention({ ownerId: entry.owner.ownerId, ownerGeneration: entry.owner.generation, evidenceId: "cleanup", turnId: entry.operationId, attemptId: "cleanup", resourceKeys: [entry.lease.resourceKey] }, () => true); } catch {} try { entry.lease.release(); } catch {} }
  for (const db of databases.splice(0)) db.close();
  for (const owner of owners.splice(0)) owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function git(root: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const child = execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@invalid" }, encoding: "buffer" }, (error, stdout) => error ? reject(error) : resolveResult(stdout));
    child.stdin?.end(input);
  });
}
class Catalog implements WorktreeCatalog {
  readonly busy = new Set<string>();
  failPublish = false;
  readonly sessions = new Map<string, string>();
  constructor(readonly db: Database.Database, readonly repository: string) { db.exec("CREATE TABLE IF NOT EXISTS test_workspaces (id TEXT PRIMARY KEY, state TEXT NOT NULL, operation_id TEXT NOT NULL)"); }
  resolveRepository(id: string): { canonicalRoot: string } { if (id !== "repo-1") throw new WorktreeError("REPOSITORY_NOT_FOUND", "Repository is not registered"); return { canonicalRoot: this.repository }; }
  assertNoWriterOrRuntime(id: string): void { if (this.busy.has(id)) throw new WorktreeError("WORKSPACE_BUSY", "Writer/runtime remains active"); }
  reserve(record: ManagedWorktreeRecord, op: WorktreeOperationRecord): void { this.db.prepare("INSERT INTO test_workspaces VALUES (?, 'reserved', ?) ON CONFLICT(id) DO UPDATE SET state='reserved',operation_id=excluded.operation_id").run(record.workspaceId, op.operationId); }
  async prepareWorktreeRegistration(record: ManagedWorktreeRecord): Promise<unknown> { return { workspaceId: record.workspaceId, root: await realpath((await git(record.path, ["rev-parse", "--show-toplevel"])).toString().trim()) }; }
  publish(record: ManagedWorktreeRecord): void { if (this.failPublish) throw new Error("catalog failure"); this.db.prepare("INSERT INTO test_workspaces(id,state,operation_id) VALUES (?, ?, 'published') ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(record.workspaceId, record.state); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-worktree-test-")); roots.push(root);
  const repository = join(root, "repository"), managed = join(root, "managed"), privateDirectory = join(root, "private");
  await mkdir(repository); await mkdir(managed); await mkdir(privateDirectory);
  await git(repository, ["init", "-q"]);
  await writeFile(join(repository, "tracked.txt"), "base\n"); await writeFile(join(repository, ".gitignore"), "ignored*\n");
  await git(repository, ["add", "."]); await git(repository, ["commit", "-qm", "base"]);
  const owner = HostOwnerLock.acquire({ databasePath: join(privateDirectory, "host.db"), identityDirectory: join(privateDirectory, "identity"), coordinationDirectory: join(root, "coordination") }); owners.push(owner);
  const db = new Database(owner.databasePath); databases.push(db); db.pragma("foreign_keys=ON"); db.exec(WORKTREE_SCHEMA_SQL);
  const store = new WorktreeStore(db, () => "2026-10-15T00:00:00.000Z"), catalog = new Catalog(db, repository);
  const driver = new RawWorktreeGit({ objects: (path) => new CheckpointGitDriver(path, { runGit: rawCheckpointGitRunner() }) });
  let fault: { name: string; moment: string } | undefined, stopped = true;
  const service = new WorktreeService(store, {
    managedRoot: managed, privateDirectories: [privateDirectory], catalog, git: driver,
    authorize: (actor) => { if (actor !== "device-1") throw new WorktreeError("FORBIDDEN", "Actor cannot manage this repository"); },
    acquireLease: (record, op, existing) => {
      const lease = WorkspaceLease.acquire({ workspace: existing, owner, operationId: op.operationId });
      leases.push({ lease, owner, operationId: op.operationId }); return lease;
    },
    producerStopped: async () => stopped,
    clearLeaseRetention: (_record, op, evidence, handle) => { const lease = handle as WorkspaceLease; lease.clearRetention({ ownerId: owner.ownerId, ownerGeneration: owner.generation, evidenceId: evidence.evidenceId, turnId: op.operationId, attemptId: op.operationId, resourceKeys: [lease.resourceKey] }, () => stopped && evidence.producerStopped); },
    onBoundary: async (name, moment) => { if (fault?.name === name && fault.moment === moment) { fault = undefined; throw new Error("simulated crash"); } },
  });
  let commandSequence = 0;
  const accept = (request: unknown, commandId = "command-" + ++commandSequence) => service.accept(request, { actorId: "device-1", commandId });
  const create = async () => { const op = accept({ kind: "create", repositoryId: "repo-1" }); expect((await service.execute(op.operationId)).state).toBe("completed"); return store.require(op.worktreeId); };
  return { root, repository, managed, privateDirectory, owner, db, store, catalog, driver, service, accept, create, fault: (name: string, moment = "applied") => { fault = { name, moment }; }, stopped: (value: boolean) => { stopped = value; } };
}

describe("persistent managed worktree lifecycle", { timeout: 60_000 }, () => {
  it("creates from a registered immutable ref, preserves staged/dirty/untracked data, and restores detached history", async () => {
    const f = await fixture(), record = await f.create();
    await writeFile(join(record.path, "tracked.txt"), "staged\n"); await git(record.path, ["add", "tracked.txt"]);
    await writeFile(join(record.path, "tracked.txt"), "dirty\n"); await writeFile(join(record.path, "untracked.txt"), "untracked\n");
    const indexPath = (await git(record.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).toString().trim();
    const beforeIndex = await readFile(indexPath), head = (await git(record.path, ["rev-parse", "HEAD"])).toString().trim();
    const before = await f.driver.fingerprint(record.path);
    f.catalog.sessions.set(record.workspaceId, "active");
    const archive = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    f.fault("capture", "committed");
    expect((await f.service.execute(archive.operationId)).state).toBe("outcome_unknown");
    expect(await readFile(indexPath)).toEqual(beforeIndex);
    const evidence = await f.service.reconcile(archive.operationId, "device-1");
    expect((await f.service.resumeVerified(archive.operationId, evidence.evidenceId, "device-1")).state).toBe("completed");
    const archived = f.store.require(record.worktreeId);
    expect(archived.state).toBe("archived"); expect(await lstat(record.path).catch(() => undefined)).toBeUndefined();
    expect(f.catalog.sessions.get(record.workspaceId)).toBe("active");
    expect(f.store.protectedRefs()[0]!.refs).toHaveLength(5);
    const restore = f.accept({ kind: "restore", worktreeId: record.worktreeId, expectedRevision: archived.revision });
    expect((await f.service.execute(restore.operationId)).state).toBe("completed");
    expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(await readFile(join(record.path, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect((await git(record.path, ["show", ":tracked.txt"])).toString()).toBe("staged\n");
    expect((await git(record.path, ["rev-parse", "HEAD"])).toString().trim()).toBe(head);
    expect(await git(record.path, ["symbolic-ref", "-q", "HEAD"]).then(() => true, () => false)).toBe(false);
    const after = await f.driver.fingerprint(record.path);
    expect(after.workspaceDigest).toBe(before.workspaceDigest);
    const snapshot = f.store.snapshot(archived.snapshotId!);
    expect((await git(f.repository, ["rev-list", snapshot.workspaceCommit])).toString()).toContain(head);
  });

  it("refuses active runtimes/writers and ignored files without discarding them", async () => {
    const f = await fixture(), record = await f.create();
    f.catalog.busy.add(record.workspaceId);
    expect(() => f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision })).toThrow(/Writer/);
    f.catalog.busy.clear(); await writeFile(join(record.path, "ignored-secret"), "needed\n");
    const archive = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    const result = await f.service.execute(archive.operationId);
    expect(result).toMatchObject({ state: "outcome_unknown", errorCode: "WORKTREE_IGNORED_FILES" });
    expect(await readFile(join(record.path, "ignored-secret"), "utf8")).toBe("needed\n");
    expect(await f.driver.registration(f.repository, record.path)).toBeDefined();
  });

  it("never invokes configured filters, checkout hooks or fsmonitor commands", async () => {
    const f = await fixture(), marker = join(f.root, "repo-command-ran");
    await writeFile(join(f.repository, ".gitattributes"), "tracked.txt filter=evil\n"); await git(f.repository, ["add", ".gitattributes"]); await git(f.repository, ["commit", "-qm", "attributes"]);
    const command = "sh -c 'echo invoked > " + marker + "; cat'";
    await git(f.repository, ["config", "filter.evil.clean", command]); await git(f.repository, ["config", "filter.evil.smudge", command]); await git(f.repository, ["config", "core.fsmonitor", command]);
    await writeFile(join(f.repository, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho invoked > " + marker + "\n", { mode: 0o755 });
    const record = await f.create(); await writeFile(join(record.path, "tracked.txt"), "changed raw\n");
    const archive = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    expect((await f.service.execute(archive.operationId)).state).toBe("completed");
    const archived = f.store.require(record.worktreeId), restore = f.accept({ kind: "restore", worktreeId: record.worktreeId, expectedRevision: archived.revision });
    expect((await f.service.execute(restore.operationId)).state).toBe("completed");
    expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe("changed raw\n");
  });

  for (const boundary of ["marker", "reserve_path", "register", "file_write:" + createHash("sha256").update("tracked.txt").digest("hex").slice(0, 24), "index_write", "materialize", "verified", "publish"]) it("journals create crash at " + boundary + " and resumes only after inspection", async () => {
    const f = await fixture(); f.fault(boundary, boundary === "publish" ? "dispatched" : "applied");
    const operation = f.accept({ kind: "create", repositoryId: "repo-1" });
    const failed = await f.service.execute(operation.operationId);
    expect(failed.state).toBe("outcome_unknown");
    await expect(f.service.execute(operation.operationId)).rejects.toThrow(/Inspect/);
    f.stopped(false); const unknown = await f.service.reconcile(operation.operationId, "device-1"); expect(unknown.canResume).toBe(false);
    f.stopped(true); const evidence = await f.service.reconcile(operation.operationId, "device-1");
    expect(evidence.canResume).toBe(true);
    expect((await f.service.resumeVerified(operation.operationId, evidence.evidenceId, "device-1")).state).toBe("completed");
    expect(f.store.steps(operation.operationId).filter((step) => step.boundary === "register")).toHaveLength(1);
  });

  for (const boundary of ["capture", "retain_snapshot", "quarantine", "remove", "publish"]) it("preserves archive snapshot/gates across crash at " + boundary, async () => {
    const f = await fixture(), record = await f.create();
    await writeFile(join(record.path, "untracked.txt"), "must survive");
    f.fault(boundary, boundary === "publish" ? "dispatched" : "applied");
    const operation = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    expect((await f.service.execute(operation.operationId)).state).toBe("outcome_unknown");
    const evidence = await f.service.reconcile(operation.operationId, "device-1");
    expect(evidence.canResume).toBe(true);
    expect((await f.service.resumeVerified(operation.operationId, evidence.evidenceId, "device-1")).state).toBe("completed");
    const archived = f.store.require(record.worktreeId), restore = f.accept({ kind: "restore", worktreeId: record.worktreeId, expectedRevision: archived.revision });
    expect((await f.service.execute(restore.operationId)).state).toBe("completed");
    expect(await readFile(join(record.path, "untracked.txt"), "utf8")).toBe("must survive");
  });

  for (const boundary of ["capture", "retain_snapshot", "quarantine", "remove", "publish"]) it("inspects archive before resuming dispatched boundary " + boundary, async () => {
    const f = await fixture(), record = await f.create();
    await writeFile(join(record.path, "untracked.txt"), "saved before dispatch");
    f.fault(boundary, "dispatched");
    const operation = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    expect((await f.service.execute(operation.operationId)).state).toBe("outcome_unknown");
    const evidence = await f.service.reconcile(operation.operationId, "device-1");
    expect(evidence.canResume).toBe(true);
    expect((await f.service.resumeVerified(operation.operationId, evidence.evidenceId, "device-1")).state).toBe("completed");
    expect(f.store.protectedRefs().flatMap((pin) => pin.refs)).toContain("refs/flyx/checkpoints/" + f.store.require(record.worktreeId).snapshotId + "/workspace");
  });

  for (const boundary of ["register", "file_write:" + createHash("sha256").update("tracked.txt").digest("hex").slice(0, 24), "index_write", "materialize", "verified", "publish"]) it("restores through inspected crash boundary " + boundary, async () => {
    const f = await fixture(), record = await f.create();
    await writeFile(join(record.path, "tracked.txt"), "snapshot bytes");
    const archive = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    expect((await f.service.execute(archive.operationId)).state).toBe("completed");
    const archived = f.store.require(record.worktreeId);
    f.fault(boundary, boundary === "publish" ? "dispatched" : "applied");
    const operation = f.accept({ kind: "restore", worktreeId: record.worktreeId, expectedRevision: archived.revision });
    expect((await f.service.execute(operation.operationId)).state).toBe("outcome_unknown");
    const evidence = await f.service.reconcile(operation.operationId, "device-1");
    expect(evidence.canResume).toBe(true);
    expect((await f.service.resumeVerified(operation.operationId, evidence.evidenceId, "device-1")).state).toBe("completed");
    expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe("snapshot bytes");
    expect(f.store.steps(operation.operationId).every((step) => step.state === "applied")).toBe(true);
  });

  it("keeps Catalog and operation publication atomic after external success", async () => {
    const f = await fixture(); f.catalog.failPublish = true;
    const op = f.accept({ kind: "create", repositoryId: "repo-1" });
    expect((await f.service.execute(op.operationId)).state).toBe("outcome_unknown");
    expect(f.db.prepare("SELECT state FROM test_workspaces WHERE id=?").get(f.store.require(op.worktreeId).workspaceId)).toBeUndefined();
    f.catalog.failPublish = false; const evidence = await f.service.reconcile(op.operationId, "device-1");
    expect((await f.service.resumeVerified(op.operationId, evidence.evidenceId, "device-1")).state).toBe("completed");
    expect(f.db.prepare("SELECT state FROM test_workspaces WHERE id=?").get(f.store.require(op.worktreeId).workspaceId)).toEqual({ state: "active" });
  });

  it("rejects stale evidence, changed files, symlink roots, private overlap and arbitrary repositories/paths", async () => {
    const f = await fixture();
    expect(() => f.accept({ kind: "create", repositoryId: "/etc" })).toThrow(/registered/);
    expect(() => f.accept({ kind: "create", repositoryId: "repo-1", path: "/etc" })).toThrow();
    f.fault("materialize"); const op = f.accept({ kind: "create", repositoryId: "repo-1" });
    await f.service.execute(op.operationId);
    const evidence = await f.service.reconcile(op.operationId, "device-1"), record = f.store.require(op.worktreeId);
    await writeFile(join(record.path, "tracked.txt"), "external edit");
    await expect(f.service.resumeVerified(op.operationId, evidence.evidenceId, "device-1")).rejects.toThrow(/changed/);
    expect((await f.service.reconcile(op.operationId, "device-1")).observed).toBe("conflict");
    const alias = join(f.root, "managed-link"); await symlink(f.managed, alias);
    expect(() => new WorktreeService(f.store, { managedRoot: alias } as any)).toThrow(/plain directory/);
    expect(() => new WorktreeService(f.store, { managedRoot: f.privateDirectory, privateDirectories: [f.privateDirectory] } as any)).toThrow(/overlaps/);
  });

  it("rejects submodules and escaping symlinks before checkout materialization", async () => {
    const f = await fixture();
    await symlink("/private/host-secret", join(f.repository, "escape"));
    await git(f.repository, ["add", "escape"]); await git(f.repository, ["commit", "-qm", "unsafe link"]);
    const op = f.accept({ kind: "create", repositoryId: "repo-1" });
    expect(await f.service.execute(op.operationId)).toMatchObject({ state: "outcome_unknown", errorCode: "WORKTREE_UNSUPPORTED_SYMLINK" });
    expect(await f.driver.registration(f.repository, f.store.require(op.worktreeId).path)).toBeUndefined();
  });

  it("creates independent managed worktrees concurrently and publishes no association before Git success", async () => {
    const f = await fixture();
    const one = f.accept({ kind: "create", repositoryId: "repo-1" }), two = f.accept({ kind: "create", repositoryId: "repo-1", branchMode: "generated" });
    expect(f.db.prepare("SELECT count(*) AS n FROM test_workspaces").get()).toEqual({ n: 0 });
    const results = await Promise.all([f.service.execute(one.operationId), f.service.execute(two.operationId)]);
    expect(results.map((result) => result.state)).toEqual(["completed", "completed"]);
    expect(f.db.prepare("SELECT count(*) AS n FROM test_workspaces WHERE state='active'").get()).toEqual({ n: 2 });
    expect(f.store.require(one.worktreeId).path).not.toBe(f.store.require(two.worktreeId).path);
  });

  it("refuses another DB checkout writer without taking a snapshot or blocking the existing Catalog", async () => {
    const f = await fixture(), record = await f.create();
    const other = HostOwnerLock.acquire({ databasePath: join(f.privateDirectory, "busy.db"), identityDirectory: join(f.privateDirectory, "busy-identity"), coordinationDirectory: join(f.root, "coordination") }); owners.push(other);
    const writer = WorkspaceLease.acquire({ workspace: record.path, owner: other, operationId: "active-writer" });
    leases.push({ lease: writer, owner: other, operationId: "active-writer" });
    const operation = f.accept({ kind: "archive", worktreeId: record.worktreeId, expectedRevision: record.revision });
    expect(await f.service.execute(operation.operationId)).toMatchObject({ state: "failed", errorCode: "WORKSPACE_BUSY" });
    expect(f.store.require(record.worktreeId).state).toBe("active");
    expect(f.store.protectedRefs()).toEqual([]);
    expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe("base\n");
    writer.assertActive();
  });

  it("does not execute an accepted operation until the outer Engine transaction commits", async () => {
    const f = await fixture();
    let running!: Promise<WorktreeOperationRecord>;
    f.db.transaction(() => {
      const operation = f.accept({ kind: "create", repositoryId: "repo-1" });
      running = f.service.execute(operation.operationId);
    })();
    await expect(running).rejects.toThrow(/Commit the accepted operation/);
    expect(await lstat(join(f.managed, "checkouts")).catch(() => undefined)).toBeUndefined();
  });

  it("uses actual checkout leases across DBs while separate managed worktrees admit concurrent writers", async () => {
    const f = await fixture(), one = await f.create(), two = await f.create();
    const secondOwner = HostOwnerLock.acquire({ databasePath: join(f.privateDirectory, "other.db"), identityDirectory: join(f.privateDirectory, "other-identity"), coordinationDirectory: join(f.root, "coordination") }); owners.push(secondOwner);
    const leaseOne = WorkspaceLease.acquire({ workspace: one.path, owner: f.owner, operationId: "writer-one" });
    leases.push({ lease: leaseOne, owner: f.owner, operationId: "writer-one" });
    expect(() => WorkspaceLease.acquire({ workspace: one.path, owner: secondOwner, operationId: "other-db-same-checkout" })).toThrow(/owner|Host|resource/);
    const leaseTwo = WorkspaceLease.acquire({ workspace: two.path, owner: secondOwner, operationId: "writer-two" });
    leases.push({ lease: leaseTwo, owner: secondOwner, operationId: "writer-two" });
    await Promise.all([writeFile(join(one.path, "tracked.txt"), "one\n"), writeFile(join(two.path, "tracked.txt"), "two\n")]);
    leaseOne.assertActive(); leaseTwo.assertActive();
    expect(await readFile(join(one.path, "tracked.txt"), "utf8")).toBe("one\n"); expect(await readFile(join(two.path, "tracked.txt"), "utf8")).toBe("two\n");
  });

  it("joins Engine acceptance rollback and reuses actor-bound commands", async () => {
    const f = await fixture(), reserve = f.catalog.reserve.bind(f.catalog);
    expect(() => f.db.transaction(() => { f.accept({ kind: "create", repositoryId: "repo-1" }, "once"); throw new Error("engine commit failure"); })()).toThrow("engine commit failure");
    expect(f.store.list()).toEqual([]); expect(f.db.prepare("SELECT count(*) AS n FROM worktree_operations").get()).toEqual({ n: 0 });
    f.catalog.reserve = reserve;
    const op = f.accept({ kind: "create", repositoryId: "repo-1" }, "once");
    expect(f.accept({ kind: "create", repositoryId: "repo-1" }, "once").operationId).toBe(op.operationId);
    expect(() => f.accept({ kind: "create", repositoryId: "repo-1", ref: "refs/heads/other" }, "once")).toThrow(/another request/);
    expect(() => f.service.accept({ kind: "create", repositoryId: "repo-1" }, { actorId: "revoked", commandId: "once" })).toThrow("Actor");
  });
});
