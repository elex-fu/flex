import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorktreeRequestSchema, type ManagedWorktreeSummary, type WorktreeInspection, type WorktreeOperation, type WorktreeRequest } from "@flyx/mvp-protocol";
import { WorktreeStore, WorktreeError, type ManagedWorktreeRecord, type StoredWorktreeInspection, type WorktreeOperationRecord, type WorktreeSnapshot } from "./worktree-store.js";
import { canonicalPath } from "../lifecycle/host-owner.js";
import type { RawFingerprint, WorktreeGit, WorktreeMutation } from "./worktree-git.js";

export interface WorktreeLeaseHandle { assertActive(): void; retain(reason: string): void; release(): void }
export interface WorktreeCatalog {
  resolveRepository(repositoryId: string): { canonicalRoot: string };
  assertNoWriterOrRuntime(workspaceId: string, operationId?: string): void;
  /** Same connection and transaction as accept(); reserve the workspace admission gate. */
  reserve(record: ManagedWorktreeRecord, operation: WorktreeOperationRecord): unknown;
  prepareWorktreeRegistration(record: ManagedWorktreeRecord, operation: WorktreeOperationRecord): Promise<unknown>;
  /** Same connection and transaction as complete(); emit Catalog/Engine facts synchronously. */
  publish(record: ManagedWorktreeRecord, operation: WorktreeOperationRecord, prepared?: unknown): unknown;
}
export interface WorktreeServiceOptions {
  managedRoot: string;
  privateDirectories: readonly string[];
  catalog: WorktreeCatalog;
  git: WorktreeGit;
  authorize(actorId: string, request: WorktreeRequest): void;
  acquireLease(record: ManagedWorktreeRecord, operation: WorktreeOperationRecord, existingPath: string): WorktreeLeaseHandle;
  producerStopped(operation: WorktreeOperationRecord): Promise<boolean>;
  /** Reload committed recovery proof before clearing an earlier retained lease. */
  clearLeaseRetention?(record: ManagedWorktreeRecord, operation: WorktreeOperationRecord, evidence: StoredWorktreeInspection, lease: WorktreeLeaseHandle): void;
  onBoundary?(boundary: string, moment: "dispatched" | "applied" | "committed", operation: WorktreeOperationRecord): Promise<void>;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); }
function overlap(left: string, right: string): boolean { return within(left, right) || within(right, left); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; } }

/** Admission is sync; external boundaries and verified recovery are async and journaled. */
export class WorktreeService {
  readonly managedRoot: string;
  private readonly rootIdentity: string;
  private readonly leases = new Map<string, WorktreeLeaseHandle>();
  private readonly running = new Map<string, Promise<WorktreeOperationRecord>>();
  constructor(readonly store: WorktreeStore, private readonly options: WorktreeServiceOptions) {
    const configured = resolve(options.managedRoot), stat = lstatSync(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorktreeError("WORKTREE_ROOT_UNSAFE", "Managed root must be an existing plain directory");
    this.managedRoot = realpathSync(configured); this.rootIdentity = String(stat.dev) + ":" + String(stat.ino);
    for (const privateDirectory of options.privateDirectories) if (overlap(this.managedRoot, canonicalLocal(privateDirectory))) throw new WorktreeError("WORKTREE_PRIVATE_DATA_OVERLAP", "Managed root overlaps private Host data");
  }
  accept(raw: unknown, context: { actorId: string; commandId: string }): WorktreeOperationRecord {
    const request = WorktreeRequestSchema.parse(raw);
    if (!context.actorId || !context.commandId || context.actorId.length > 128 || context.commandId.length > 128) throw new WorktreeError("WORKTREE_INVALID_COMMAND", "Worktree command identity is invalid");
    this.options.authorize(context.actorId, request);
    const requestHash = digest(request), previous = this.store.findCommand(context.actorId, context.commandId);
    if (previous) { if (previous.requestHash !== requestHash) throw new WorktreeError("COMMAND_ID_REUSED", "Command ID belongs to another request"); return previous; }
    let record: ManagedWorktreeRecord;
    if (request.kind === "create") {
      const repository = this.options.catalog.resolveRepository(request.repositoryId);
      if (repository && typeof repository === "object" && "then" in repository) throw new WorktreeError("WORKTREE_ASYNC_ADMISSION", "Registered repository lookup must be synchronous");
      const repositoryRoot = realpathSync(repository.canonicalRoot);
      if (overlap(repositoryRoot, this.managedRoot) || this.options.privateDirectories.some((path) => overlap(repositoryRoot, canonicalLocal(path)))) throw new WorktreeError("WORKTREE_PRIVATE_DATA_OVERLAP", "Registered repository overlaps managed or private data");
      const worktreeId = "wt_" + randomUUID();
      record = { worktreeId, repositoryId: request.repositoryId, workspaceId: "workspace-" + worktreeId, state: "creating", revision: 0,
        path: join(this.managedRoot, "checkouts", worktreeId), managedRoot: this.managedRoot, rootIdentity: this.rootIdentity, repositoryRoot,
        ...(request.branchMode === "generated" ? { branchName: "codex/worktrees/" + worktreeId } : {}) };
    } else {
      const current = this.store.require(request.worktreeId); this.guardRecord(current);
      this.options.catalog.assertNoWriterOrRuntime(current.workspaceId);
      record = { ...current, state: request.kind === "archive" ? "archiving" : "restoring", initialState: current.state, revision: current.revision + 1 };
    }
    return this.store.accept(record, request, context.actorId, context.commandId, requestHash, (record, operation) => operation.kind === "create" ? undefined : this.options.catalog.reserve(record, operation));
  }
  execute(id: string): Promise<WorktreeOperationRecord> {
    const pending = this.running.get(id); if (pending) return pending;
    const promise = this.executeOnce(id).finally(() => { this.running.delete(id); });
    this.running.set(id, promise); return promise;
  }
  async reconcile(id: string, actorId: string): Promise<WorktreeInspection> {
    let op = this.store.operation(id); if (op.actorId !== actorId) throw new WorktreeError("WORKTREE_SCOPE_MISMATCH", "Worktree operation belongs to another actor");
    this.options.authorize(actorId, op.request);
    if (op.state === "running" && !this.running.has(id)) op = this.store.failed(id, "WORKTREE_INTERRUPTED", true);
    const observation = await this.observe(op);
    const producerStopped = await this.options.producerStopped(op);
    const evidence: StoredWorktreeInspection = { evidenceId: randomUUID(), operationId: id, producerStopped,
      canResume: op.state === "outcome_unknown" && producerStopped && observation.observed !== "conflict",
      observed: observation.observed, observationsDigest: digest(observation),
      expiresAt: new Date(Date.parse(this.store.now()) + 60_000).toISOString(),
      ...(!producerStopped ? { errorCode: "WORKTREE_PRODUCER_UNKNOWN" } : observation.observed === "conflict" ? { errorCode: "WORKTREE_PATH_CONFLICT" } : {}) };
    this.store.putInspection(evidence); return publicInspection(evidence);
  }
  async resumeVerified(id: string, evidenceId: string, actorId: string): Promise<WorktreeOperationRecord> {
    const op = this.store.operation(id), evidence = this.store.inspection(evidenceId);
    if (op.actorId !== actorId || evidence.operationId !== id) throw new WorktreeError("WORKTREE_SCOPE_MISMATCH", "Worktree recovery belongs to another actor");
    this.options.authorize(actorId, op.request);
    if (!evidence.canResume || evidence.expiresAt <= this.store.now() || !await this.options.producerStopped(op) || digest(await this.observe(op)) !== evidence.observationsDigest) throw new WorktreeError("WORKTREE_EVIDENCE_STALE", "Worktree recovery evidence changed or expired");
    const record = this.store.require(op.worktreeId), lease = this.leases.get(id);
    if (lease) {
      if (!this.options.clearLeaseRetention) throw new WorktreeError("WORKTREE_RECOVERY_PROOF_REQUIRED", "Retained checkout lease needs committed recovery proof");
      this.options.clearLeaseRetention(record, op, evidence, lease);
    }
    this.store.facts(id, { recoveryEvidenceId: evidenceId });
    this.store.resume(id);
    return this.execute(id);
  }
  /** R06 registerOperation adapter: accepted commands are never retried by the generic worker. */
  async handleIntent(intent: { authSubjectId: string; commandId: string; payload: unknown }): Promise<{ status: "settled" | "outcome_unknown"; resultCode: string; result: { operation: WorktreeOperation; worktree: ManagedWorktreeSummary } }> {
    if (!intent.payload || typeof intent.payload !== "object" || !("operationId" in intent.payload) || typeof intent.payload.operationId !== "string") throw new WorktreeError("WORKTREE_INVALID_INTENT", "Worktree intent has no operation binding");
    const op = this.store.operation(intent.payload.operationId);
    if (op.actorId !== intent.authSubjectId || op.commandId !== intent.commandId) throw new WorktreeError("WORKTREE_SCOPE_MISMATCH", "Worktree intent belongs to another command");
    const result = await this.execute(op.operationId);
    return { status: result.state === "outcome_unknown" ? "outcome_unknown" : "settled", resultCode: result.errorCode ?? "WORKTREE_" + result.state.toUpperCase(), result: { operation: publicOperation(result), worktree: summary(this.store.require(result.worktreeId)) } };
  }
  private async executeOnce(id: string): Promise<WorktreeOperationRecord> {
    if (this.store.db.inTransaction) throw new WorktreeError("WORKTREE_UNCOMMITTED", "Commit the accepted operation before executing external work");
    const current = this.store.operation(id); this.options.authorize(current.actorId, current.request);
    if (current.state === "completed" || current.state === "failed") return current;
    if (current.state === "outcome_unknown" || current.state === "running") throw new WorktreeError("WORKTREE_RECOVERY_REQUIRED", "Inspect the original worktree operation before resuming");
    const record = this.store.require(current.worktreeId); this.guardRecord(record);
    this.store.running(id);
    try {
      await this.directory(id, join(this.managedRoot, "operations"));
      await this.directory(id, join(this.managedRoot, "checkouts"));
      await this.directory(id, join(this.managedRoot, "quarantine"));
      await this.marker(id, record);
      if (current.kind !== "archive") await this.reservePath(id, record);
      const existing = await exists(record.path) ? record.path : this.quarantine(current);
      const lease = this.leases.get(id) ?? this.options.acquireLease(record, this.store.operation(id), existing);
      this.leases.set(id, lease); lease.assertActive();
      this.options.catalog.assertNoWriterOrRuntime(record.workspaceId, id);
      if (current.kind === "archive") await this.archive(this.store.operation(id), record);
      else await this.createOrRestore(this.store.operation(id), record);
      lease.assertActive(); lease.release(); this.leases.delete(id);
      return this.store.operation(id);
    } catch (error) {
      if (this.store.operation(id).state === "completed") { this.leases.get(id)?.release(); this.leases.delete(id); return this.store.operation(id); }
      const lease = this.leases.get(id); lease?.retain("worktree operation outcome requires verification");
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "WORKTREE_OPERATION_UNKNOWN";
      if (!lease && (code === "HOST_ALREADY_OWNED" || code === "WORKSPACE_BUSY")) return this.store.rejectBeforeCheckout(id, "WORKSPACE_BUSY", (next, operation) => this.options.catalog.publish(next, operation));
      return this.store.failed(id, code, true);
    }
  }
  private async createOrRestore(op: WorktreeOperationRecord, record: ManagedWorktreeRecord): Promise<void> {
    let commit: string, workspaceCommit: string, indexTree: string;
    if (op.kind === "create") {
      commit = await this.boundary<string>(op.operationId, "resolve_ref", { ref: op.request.kind === "create" ? op.request.ref : "" }, () => this.options.git.resolve(record.repositoryRoot, op.request.kind === "create" ? op.request.ref : ""));
      this.store.facts(op.operationId, { commit }); workspaceCommit = commit; indexTree = commit;
    } else {
      if (!record.snapshotId) throw new WorktreeError("WORKTREE_SNAPSHOT_UNAVAILABLE", "Archive has no retained snapshot");
      const snapshot = this.store.snapshot(record.snapshotId); await this.options.git.verifySnapshot(record.repositoryRoot, snapshot);
      commit = snapshot.headCommit; workspaceCommit = snapshot.workspaceCommit; indexTree = snapshot.indexTree;
      this.store.facts(op.operationId, { commit, snapshotId: snapshot.snapshotId });
    }
    await this.options.git.validate(record.repositoryRoot, workspaceCommit, record.path);
    await this.boundary(op.operationId, "register", { path: record.path, commit }, () => this.options.git.register(record.repositoryRoot, record.path, commit, op.kind === "create" ? record.branchName : undefined));
    await this.boundary(op.operationId, "materialize", { workspaceCommit, indexTree }, () => this.options.git.materialize(record.repositoryRoot, record.path, workspaceCommit, indexTree, this.mutator(op.operationId)));
    const registration = await this.options.git.registration(record.repositoryRoot, record.path);
    if (registration?.head !== commit || await this.options.git.inspect(record.repositoryRoot, record.path, workspaceCommit, indexTree) !== "complete") throw new WorktreeError("WORKTREE_VERIFY_FAILED", "Generated checkout does not match its immutable snapshot");
    await this.boundary(op.operationId, "verified", { commit }, async () => ({ commit }));
    const prepared = await this.options.catalog.prepareWorktreeRegistration(record, this.store.operation(op.operationId));
    await this.options.onBoundary?.("publish", "dispatched", this.store.operation(op.operationId));
    this.store.complete(op.operationId, { state: "active", headCommit: commit, ...(op.kind === "restore" ? { branchName: "" } : {}) }, (next, operation) => this.options.catalog.publish(next, operation, prepared));
    await this.options.onBoundary?.("publish", "committed", this.store.operation(op.operationId));
  }
  private async archive(op: WorktreeOperationRecord, record: ManagedWorktreeRecord): Promise<void> {
    const quarantine = this.quarantine(op);
    let snapshotId = typeof op.facts.captureId === "string" ? op.facts.captureId : randomUUID();
    this.store.facts(op.operationId, { captureId: snapshotId, quarantine });
    let snapshot: WorktreeSnapshot;
    const savedId = this.store.operation(op.operationId).facts.snapshotId;
    if (typeof savedId === "string") snapshot = this.store.snapshot(savedId);
    else {
      if ((await this.options.git.ignored(record.repositoryRoot, record.path)).length) throw new WorktreeError("WORKTREE_IGNORED_FILES", "Ignored files require separate preservation before archive");
      const planned = this.store.steps(op.operationId).find((step) => step.boundary === "capture")?.planned as { fingerprint?: RawFingerprint } | undefined;
      const fingerprint = planned?.fingerprint ?? await this.options.git.fingerprint(record.path);
      snapshot = await this.boundary<WorktreeSnapshot>(op.operationId, "capture", { snapshotId, fingerprint }, () => this.options.git.snapshot(record.path, snapshotId, record, fingerprint));
      this.store.putSnapshot(snapshot, op.operationId);
    }
    await this.boundary(op.operationId, "retain_snapshot", { snapshotId }, async () => { await this.options.git.retain(record.repositoryRoot, snapshot); return { snapshotId }; });
    await this.boundary(op.operationId, "quarantine", { path: quarantine }, async () => { await this.options.git.move(record.repositoryRoot, record.path, quarantine, snapshot); return { path: quarantine }; });
    await this.boundary(op.operationId, "remove", { path: quarantine, snapshotId }, async () => { await this.options.git.remove(record.repositoryRoot, quarantine, snapshot); return { removed: true }; });
    if (await exists(record.path) || await exists(quarantine) || await this.options.git.registration(record.repositoryRoot, record.path) || await this.options.git.registration(record.repositoryRoot, quarantine)) throw new WorktreeError("WORKTREE_REMOVE_UNKNOWN", "Archive checkout removal cannot be verified");
    await this.options.git.verifySnapshot(record.repositoryRoot, snapshot);
    await this.options.onBoundary?.("publish", "dispatched", this.store.operation(op.operationId));
    this.store.complete(op.operationId, { state: "archived", snapshotId, headCommit: snapshot.headCommit }, (next, operation) => this.options.catalog.publish(next, operation));
    await this.options.onBoundary?.("publish", "committed", this.store.operation(op.operationId));
  }
  private async observe(op: WorktreeOperationRecord): Promise<Record<string, unknown> & { observed: WorktreeInspection["observed"] }> {
    const record = this.store.require(op.worktreeId); this.guardRecord(record);
    const markerPath = join(this.managedRoot, "operations", op.operationId + ".json");
    const marker = await exists(markerPath) ? await protectedText(markerPath) : null;
    const expected = JSON.stringify({ operationId: op.operationId, worktreeId: record.worktreeId, rootIdentity: record.rootIdentity });
    if (marker !== null && marker !== expected) return { observed: "conflict", marker };
    const original = await exists(record.path), quarantine = this.quarantine(op), quarantined = await exists(quarantine);
    const registration = await this.options.git.registration(record.repositoryRoot, record.path), quarantineRegistration = await this.options.git.registration(record.repositoryRoot, quarantine);
    if (original && quarantined || registration && quarantineRegistration) return { observed: "conflict", original, quarantined, registration, quarantineRegistration };
    if (op.kind === "archive") {
      const id = op.facts.snapshotId;
      if (typeof id === "string") {
        const snapshot = this.store.snapshot(id);
        const retained = await this.options.git.retentionState(record.repositoryRoot, snapshot);
        const retentionStep = this.store.steps(op.operationId).find((step) => step.boundary === "retain_snapshot");
        if (retained === "conflict" || retained === "missing" && retentionStep?.state === "applied") return { observed: "conflict", snapshotId: id, retained };
        const status = original ? await this.options.git.inspect(record.repositoryRoot, record.path, snapshot.workspaceCommit, snapshot.indexCommit) : quarantined ? await this.options.git.inspect(record.repositoryRoot, quarantine, snapshot.workspaceCommit, snapshot.indexCommit, true) : "absent";
        const fingerprint = original && registration || quarantined && quarantineRegistration ? await this.options.git.fingerprint(original ? record.path : quarantine).catch(() => null) : null;
        return { observed: status === "conflict" ? "conflict" : !original && !quarantined && !registration && !quarantineRegistration ? "complete" : "partial", original, quarantined, registration, quarantineRegistration, status, fingerprint, snapshotId: id };
      }
      if (!original || !registration || quarantined) return { observed: "conflict", original, quarantined, registration };
      return { observed: "partial", original, registration, fingerprint: await this.options.git.fingerprint(record.path), ignored: await this.options.git.ignored(record.repositoryRoot, record.path) };
    }
    const commit = typeof op.facts.commit === "string" ? op.facts.commit : this.store.steps(op.operationId).find((step) => step.boundary === "resolve_ref")?.result;
    if (!commit || typeof commit !== "string") {
      const empty = original && !registration ? (await readdir(record.path)).length === 0 : false;
      return { observed: original && !registration && empty ? "partial" : !original && !registration ? "absent" : "conflict", original, registration };
    }
    let workspace = commit, index = commit;
    if (op.kind === "restore" && record.snapshotId) { const snapshot = this.store.snapshot(record.snapshotId); if (await this.options.git.retentionState(record.repositoryRoot, snapshot) !== "ready") return { observed: "conflict", snapshotId: record.snapshotId }; workspace = snapshot.workspaceCommit; index = snapshot.indexTree; }
    const status = await this.options.git.inspect(record.repositoryRoot, record.path, workspace, index);
    if (registration && registration.head !== commit || quarantineRegistration || quarantined) return { observed: "conflict", original, registration, status };
    const fingerprint = status === "complete" ? await this.options.git.fingerprint(record.path) : null;
    return { observed: status, original, registration, fingerprint, commit };
  }
  private mutator(id: string): WorktreeMutation { return (boundary, planned, action) => this.boundary(id, boundary, planned, action); }
  private async boundary<T>(id: string, name: string, planned: unknown, action: () => Promise<T>): Promise<T> {
    this.guardRecord(this.store.require(this.store.operation(id).worktreeId));
    this.leases.get(id)?.assertActive();
    const step = this.store.beginStep(id, name, planned);
    if (step.state === "applied") return step.result as T;
    if (this.store.operation(id).state !== "running") throw new WorktreeError("WORKTREE_OPERATION_STATE", "Worktree operation cannot cross an external boundary");
    await this.options.onBoundary?.(name, "dispatched", this.store.operation(id));
    const result = await action();
    await this.options.onBoundary?.(name, "applied", this.store.operation(id));
    this.store.finishStep(id, name, result);
    await this.options.onBoundary?.(name, "committed", this.store.operation(id));
    return result;
  }
  private async directory(id: string, path: string): Promise<void> {
    const record = this.store.require(this.store.operation(id).worktreeId); this.guardRecord(record);
    if (!within(this.managedRoot, path) || dirname(path) !== this.managedRoot) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Managed directory is not generated");
    if (await exists(path)) { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Managed parent is not a plain directory"); return; }
    await this.boundary(id, "directory:" + relative(this.managedRoot, path), { path }, async () => {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Managed parent is not a plain directory");
      }
      return { path };
    });
  }
  private async marker(id: string, record: ManagedWorktreeRecord): Promise<void> {
    const path = join(this.managedRoot, "operations", id + ".json"), body = JSON.stringify({ operationId: id, worktreeId: record.worktreeId, rootIdentity: record.rootIdentity });
    if (await exists(path)) { if (await protectedText(path) !== body) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Generated operation marker changed"); return; }
    await this.boundary(id, "marker", { path }, async () => { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); } return { path }; });
  }
  private async reservePath(id: string, record: ManagedWorktreeRecord): Promise<void> {
    if (await exists(record.path)) { const s = await lstat(record.path); if (!s.isDirectory() || s.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Generated checkout path changed"); return; }
    await this.boundary(id, "reserve_path", { path: record.path }, async () => { await mkdir(record.path, { mode: 0o700 }); return { path: record.path }; });
  }
  private quarantine(op: WorktreeOperationRecord): string { return join(this.managedRoot, "quarantine", op.operationId); }
  private guardRecord(record: ManagedWorktreeRecord): void {
    const registeredRepository = this.options.catalog.resolveRepository(record.repositoryId);
    if (realpathSync(registeredRepository.canonicalRoot) !== record.repositoryRoot || realpathSync(record.repositoryRoot) !== record.repositoryRoot) throw new WorktreeError("WORKTREE_REPOSITORY_CHANGED", "Registered repository root changed");
    const root = lstatSync(this.managedRoot), identity = String(root.dev) + ":" + String(root.ino);
    if (!root.isDirectory() || root.isSymbolicLink() || identity !== record.rootIdentity || record.managedRoot !== this.managedRoot || record.path !== join(this.managedRoot, "checkouts", record.worktreeId)) throw new WorktreeError("WORKTREE_ROOT_CHANGED", "Managed root or generated checkout path changed");
    for (const parent of ["checkouts", "quarantine", "operations"]) { try { const s = lstatSync(join(this.managedRoot, parent)); if (!s.isDirectory() || s.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Managed directory changed"); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; } }
  }
}
function canonicalLocal(path: string): string { return canonicalPath(path); }
async function protectedText(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Generated operation marker is not a plain file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const current = await handle.stat(); if (current.dev !== before.dev || current.ino !== before.ino) throw new WorktreeError("WORKTREE_PATH_UNSAFE", "Generated operation marker changed"); return await handle.readFile("utf8"); }
  finally { await handle.close(); }
}
export function publicOperation(op: WorktreeOperationRecord): WorktreeOperation { return { operationId: op.operationId, worktreeId: op.worktreeId, kind: op.kind, state: op.state, stage: op.stage, createdAt: op.createdAt, updatedAt: op.updatedAt, ...(op.errorCode ? { errorCode: op.errorCode } : {}) }; }
export function summary(record: ManagedWorktreeRecord): ManagedWorktreeSummary { return { worktreeId: record.worktreeId, repositoryId: record.repositoryId, workspaceId: record.workspaceId, state: record.state, revision: record.revision, directoryName: record.worktreeId, ...(record.headCommit ? { headCommit: record.headCommit } : {}), ...(record.branchName ? { branchName: record.branchName } : {}), ...(record.snapshotId ? { snapshotId: record.snapshotId } : {}) }; }
function publicInspection(e: StoredWorktreeInspection): WorktreeInspection { const { observationsDigest, ...publicValue } = e; return publicValue; }
