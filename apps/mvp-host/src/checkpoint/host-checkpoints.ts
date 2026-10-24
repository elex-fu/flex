import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY,
  CheckpointGetDiffSchema, CheckpointGetTurnDiffSchema, CheckpointGetSessionDiffSchema,
  CheckpointGetFileSchema, CheckpointDiffPageSchema, CheckpointDiffFileSchema,
  CheckpointPreviewRevertSchema, CheckpointGetPreviewSchema, CheckpointPreviewPageSchema,
  CheckpointExecuteRevertSchema, CheckpointWorkspaceRestoreSchema, CheckpointRevertOperationQuerySchema,
  CheckpointInspectRevertSchema, CheckpointResumeVerifiedSchema, CheckpointRollbackToSafetySchema,
  CheckpointRevertOperationSchema, CheckpointRevertEvidenceSchema,
} from "@flyx/mvp-protocol";
import type { RpcRequest } from "../api/rpc-dispatcher.js";
import { ContentStore } from "../content/content-store.js";
import { FrameBudget } from "../content/frame-budget.js";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { MANAGED_GIT_CHECKPOINT_OUTPUT_BYTES } from "../lifecycle/managed-git-runner.js";
import { CommandEngine } from "../orchestration/command-engine.js";
import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { OperationIntentHandler } from "../orchestration/execution-worker.js";
import type { DispatchContext } from "../provider/types.js";
import type { ExecutionCheckpointBinding } from "../session/execution-integrations.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { SqliteStore } from "../storage/db.js";
import type { WorkspaceRecord } from "../storage/catalog-store.js";
import { validateInteractionSchema } from "../storage/migrations/008-interactions.js";
import { validateRevertSchema } from "../storage/migrations/009-checkpoints.js";
import { validateViewsSchema } from "../storage/migrations/006-views-schema.js";
import type { HostViews } from "../timeline/host-views.js";
import type { WorkspaceLease } from "../workspace/workspace-lease.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { CheckpointService, type CheckpointServiceOptions } from "./checkpoint-service.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { ControlledRestore, type ControlledRestoreOptions } from "./controlled-restore.js";
import { bindingDigest, CheckpointGitDriver, validateCheckpointPath, type CheckpointGitDriverOptions, type CheckpointGitRunner, type CheckpointGitRunRequest, type CheckpointGitRunResult } from "./git-driver.js";
import { CheckpointPreviewService, type CheckpointPreviewContext, type LeaseSuccession } from "./preview-service.js";
import { REVERT_INTENT_KIND, RevertService, type RevertServiceOptions } from "./revert-service.js";
import { CheckpointError, type CheckpointContext, type CheckpointPhase } from "./types.js";
import type { NativeRevertDriver, NativeRevertPreparation } from "./revert-types.js";

export type CheckpointScope = "session:read" | "session:write";
/** These facts come from a loaded runtime and actual lease manager, never an RPC body. */
export type CheckpointRuntimeState = { lease: WorkspaceLease; runtimeGeneration: number; nativeHandle: unknown };
export type VerifiedRewindCapability = Extract<NativeRevertPreparation, { supported: true }>["capability"];
export type HostRevertPorts = Pick<RevertServiceOptions,
  "dispatchContextFor" | "proveQuiescence" | "projectSuccess" | "assertRestoreWriteReady"
> & Partial<Pick<RevertServiceOptions,
  "native" | "nativeFactory" | "verifyLeaseSuccession" | "verifyWorkerRevision" | "nativeTimeoutMs" | "evidenceTtlMs"
>> & {
  acquire(input: Parameters<RevertServiceOptions["acquire"]>[0]): Promise<{ lease: WorkspaceLease; succession?: LeaseSuccession }>;
  /** Reload actual versioned evidence. Absence of this port never enables native rewind. */
  verifiedNativeCapabilities?(sessionId: string): Promise<readonly VerifiedRewindCapability[]>;
};
export type HostCheckpointGitBinding = Readonly<{
  hostOwnerId: string; hostOwnerGeneration: number; workspaceId: string;
  capture?: Readonly<Omit<CheckpointContext, "nativeHandle"> & { checkpointId: string; phase: CheckpointPhase }>;
}>;
export type HostCheckpointGitRunRequest = CheckpointGitRunRequest & Readonly<{ binding: HostCheckpointGitBinding }>;
export type HostCheckpointGitRunner = (request: HostCheckpointGitRunRequest) => Promise<CheckpointGitRunResult>;
export type HostCheckpointsOptions = {
  /** Production supplies a managed runner which journals before launching final Git argv. */
  runGit?: HostCheckpointGitRunner;
  driverFactory?(workspace: Readonly<WorkspaceRecord>, options: CheckpointGitDriverOptions): CheckpointGitDriver;
  store: SqliteStore; owner: HostOwnerHandle;
  registry: Pick<SessionRegistry, "store" | "resolve" | "publishCommittedEvents">;
  workspaces: Pick<WorkspaceRegistry, "require">;
  views: Pick<HostViews, "store" | "content" | "projector">;
  /** Must synchronously recheck current device revocation and Session scope inside Engine commits. */
  authorizeSession(sessionId: string, actorId: string, scope: CheckpointScope): void;
  runtimeState(sessionId: string, actorId: string, purpose: "preview" | "revert"): CheckpointRuntimeState | Promise<CheckpointRuntimeState>;
  leaseForContext(context: CheckpointContext): WorkspaceLease;
  captureStateFor(intent: ExecutionIntentRow, dispatch: DispatchContext, lease: WorkspaceLease): Omit<CheckpointRuntimeState, "lease">;
  previewAborted?(sessionId: string, actorId: string): void;
  previewCreated?(sessionId: string, actorId: string, expiresAt: string): void;
  captureNativeAnchor?: CheckpointServiceOptions["captureNativeAnchor"];
  revert?: HostRevertPorts;
  restoreOptions?: Omit<ControlledRestoreOptions, "fault">;
  now?: () => Date;
};
export interface CheckpointRpcContext {
  subjectId: string; protocolVersion?: number; capabilities?: ReadonlySet<string>;
  assertAuthorized(method: string): void;
  assertSessionScope(sessionId: string, scope: CheckpointScope): void;
  frameBudget?: FrameBudget;
  responseEnvelope?(payload: unknown): unknown;
}
export type CheckpointRpcResult = { handled: false } | { handled: true; payload: unknown };
export class CheckpointRpcError extends Error {
  readonly retryable = false;
  constructor(readonly code: string) { super(code); this.name = "CheckpointRpcError"; }
}
export type HostCheckpointSupport = {
  capabilities: readonly string[]; diff: true; preview: true;
  workspaceRestore: boolean; nativeRewind: boolean;
  unsupportedReason?: "CONTROLLED_RESTORE_UNAVAILABLE" | "REVERT_UNAVAILABLE" | "PROVIDER_REWIND_UNSUPPORTED";
};
const SCOPES = Object.freeze({
  "checkpoint.getDiff": "session:read", "checkpoint.getTurnDiff": "session:read", "checkpoint.getSessionDiff": "session:read",
  "checkpoint.getFile": "session:read", "checkpoint.previewRevert": "session:read", "checkpoint.getPreview": "session:read",
  "checkpoint.executeRevert": "session:write", "checkpoint.workspaceRestore": "session:write",
  "checkpoint.getRevertOperation": "session:read", "checkpoint.inspectRevert": "session:write",
  "checkpoint.resumeVerified": "session:write", "checkpoint.rollbackToSafety": "session:write",
} as const);
export const CHECKPOINT_RPC_SCOPES = SCOPES;
const CAPTURE_COLUMNS: Record<string, readonly string[]> = {
  sessions: ["id", "workspace_id", "workspace_path", "revision", "active_turn_id", "recovery_state", "recovery_revision"],
  execution_intents: ["id", "session_id", "dispatch_context_json", "request_format_version", "source_sequence"],
  checkpoint_captures: ["checkpoint_id", "session_id", "workspace_id", "turn_id", "attempt_id", "phase", "status", "workspace_ref", "index_ref", "manifest_json", "started_at", "completed_at"],
  checkpoint_files: ["checkpoint_id", "path", "entry_json"], checkpoint_baselines: ["session_id", "checkpoint_id"],
  checkpoint_diffs: ["diff_id", "session_id", "before_checkpoint_id", "after_checkpoint_id", "layer", "created_at"],
  checkpoint_diff_files: ["diff_id", "file_id", "position", "entry_json"],
  checkpoint_preview_plans: ["plan_id", "actor_id", "session_id", "checkpoint_id", "current_checkpoint_id", "state", "expires_at", "plan_json", "created_at"],
  checkpoint_pins: ["checkpoint_id", "owner_kind", "owner_id"],
};
/** Validation only: the central owned migration runner installs 008/009 before constructing this factory. */
export function validateHostCheckpointSchema(db: Database.Database): void {
  if (![8, 9].every((version) => db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version))) throw new CheckpointError("CHECKPOINT_SCHEMA_NOT_READY", "Checkpoint migrations are not installed");
  validateViewsSchema(db); validateInteractionSchema(db); validateRevertSchema(db);
  if (!ContentStore.isAvailable(db)) throw new CheckpointError("CHECKPOINT_SCHEMA_NOT_READY", "Checkpoint content storage is unavailable");
  for (const [table, names] of Object.entries(CAPTURE_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (names.some((name) => !columns.some((column) => column.name === name))) throw new CheckpointError("CHECKPOINT_SCHEMA_NOT_READY", "Checkpoint schema is incomplete");
  }
}
function sync<T>(value: T): T {
  if (value && typeof (value as { then?: unknown }).then === "function") { void Promise.resolve(value).catch(() => {}); throw new CheckpointError("CHECKPOINT_SYNC_GUARD_REQUIRED", "A commit guard must be synchronous"); }
  return value;
}
function pageInput<T extends { cursor?: string | undefined }>(input: T): Omit<T, "cursor"> & { cursor?: string } {
  const { cursor, ...rest } = input; return { ...rest, ...(cursor !== undefined ? { cursor } : {}) };
}
function errorCode(error: unknown): string {
  if (error instanceof z.ZodError) return "INVALID_PARAMS";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : "CHECKPOINT_FAILED";
}

export async function createHostCheckpoints(options: HostCheckpointsOptions): Promise<HostCheckpoints> {
  const host = new HostCheckpoints(options);
  await host.prepare();
  return host;
}
/** One owner, connection, content publisher and registered checkout boundary for all checkpoint operations. */
export class HostCheckpoints {
  readonly checkpoints: CheckpointService;
  readonly previews: CheckpointPreviewService;
  readonly revert: RevertService | undefined;
  readonly executionBinding: ExecutionCheckpointBinding;
  private readonly restore: ControlledRestore;
  private readonly drivers = new Map<string, CheckpointGitDriver>();
  private readonly requests = new Set<Promise<unknown>>();
  private helperAvailable = false;
  private sealed = false;
  private readonly registeredWorkers = new WeakSet<object>();
  constructor(private readonly options: HostCheckpointsOptions) {
    assertHostOwner(options.owner); options.owner.assertStorePath(options.store.db.name); options.store.assertWriterOwner();
    if (options.registry.store.db !== options.store.db || options.views.store.db !== options.store.db || options.views.content.db !== options.store.db || options.views.projector.db !== options.store.db) throw new CheckpointError("CHECKPOINT_SHARED_STORE_REQUIRED", "All checkpoint components must use the owned Store");
    validateHostCheckpointSchema(options.store.db);
    if (options.revert && !options.restoreOptions?.spawnHelper) throw new CheckpointError("CHECKPOINT_HELPER_JOURNAL_REQUIRED", "Controlled restore requires a managed prelaunch runner");
    this.restore = new ControlledRestore(options.restoreOptions);
    const content = new ContentStore(options.store.db, { workspaceForSession: (id) => this.publicRoots(id) });
    this.checkpoints = new CheckpointService({ store: new CheckpointStore(options.store.db), content,
      driverFor: (id) => this.driver(id), assertLease: (context) => this.assertLease(context),
      publicRootsForSession: (id) => this.publicRoots(id),
      ...(options.captureNativeAnchor ? { captureNativeAnchor: options.captureNativeAnchor } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.previews = new CheckpointPreviewService({ checkpoints: this.checkpoints, resolveContext: (id, actor) => this.resolveContext(id, actor, "session:read"),
      ...(options.revert?.verifyLeaseSuccession ? { verifyLeaseSuccession: options.revert.verifyLeaseSuccession } : {}), ...(options.now ? { now: options.now } : {}),
    });
    const ports = options.revert;
    const guardedNative = (native: NativeRevertDriver): NativeRevertDriver => ({
      prepare: async (input) => {
        const target = this.checkpoints.store.get(input.checkpointId);
        if (!target) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Native target checkpoint is unavailable");
        const before = this.resource(target.sessionId);
        const preparation = await native.prepare(input); this.assertOpen();
        if (preparation.supported) {
          const current = this.resource(target.sessionId);
          if (current.providerInstance.providerInstanceId !== before.providerInstance.providerInstanceId || current.providerInstance.policyVersion !== before.providerInstance.policyVersion || current.providerInstance.verification.state !== "verified" || current.providerInstance.verification.runtimeVersion !== preparation.capability.verifiedVersion) throw new CheckpointError("PROVIDER_CAPABILITY_UNVERIFIED", "Native preparation does not match the registered Provider version");
        }
        return preparation;
      },
      apply: (request) => native.apply(request), query: (request) => native.query(request),
    });
    this.revert = ports ? new RevertService({ engine: new CommandEngine(options.store, { publish: (event) => options.registry.publishCommittedEvents([event]) }), checkpoints: this.checkpoints, previews: this.previews, restore: this.restore,
      ...ports, resolveContext: (id, actor) => this.resolveContext(id, actor),
      ...(ports.native ? { native: guardedNative(ports.native) } : {}),
      ...(ports.nativeFactory ? { nativeFactory: (journal) => guardedNative(ports.nativeFactory!(journal)) } : {}),
      dispatchContextFor: (context, operationId, attemptId) => {
        const dispatch = sync(ports.dispatchContextFor(context, operationId, attemptId));
        if (dispatch.hostOwnerId !== options.owner.ownerId || dispatch.hostOwnerGeneration !== options.owner.generation || dispatch.sessionId !== context.sessionId || dispatch.flyxTurnId !== operationId || dispatch.runtimeGeneration !== context.runtimeGeneration || dispatch.attemptId !== attemptId || !dispatch.runtimeId) throw new CheckpointError("CHECKPOINT_CONTEXT_INVALID", "Generic intent requires the actual original Host binding");
        return dispatch;
      },
      acquire: async (input) => {
        this.authorize(input.sessionId, input.actorId, "session:write");
        const acquired = await ports.acquire(input); this.assertOpen();
        const context = await this.resolveContext(input.sessionId, input.actorId);
        this.assertActualLease(acquired.lease, context.workspaceId, context.lease);
        return { context, ...(acquired.succession ? { succession: acquired.succession } : {}) };
      },
      revalidateActorInCommit: (operation) => this.authorize(operation.sessionId, operation.actorId, "session:write"),
      assertRestoreWriteReady: (db) => { this.assertOpen(); if (db !== options.store.db) throw new CheckpointError("CHECKPOINT_SHARED_STORE_REQUIRED", "Wrong restore guard Store"); sync(ports.assertRestoreWriteReady(db)); },
      projectSuccess: (db, input) => {
        this.assertOpen(); if (db !== options.store.db || !db.inTransaction) throw new CheckpointError("CHECKPOINT_SHARED_STORE_REQUIRED", "Revert projection requires the owned transaction");
        const result = sync(ports.projectSuccess(db, input));
        const epoch = options.views.projector.activeEpoch(input.operation.sessionId);
        if (!epoch || epoch.epoch !== input.epoch || epoch.indexedSequence !== input.sourceSequence || epoch.projectorVersion !== options.views.projector.version || bindingDigest(options.registry.resolve(input.operation.sessionId).session.nativeHandle) !== bindingDigest(input.nativeProof.nativeHandle)) throw new CheckpointError("REVERT_PROJECTION_FAILED", "The actual Timeline epoch was not activated");
        return result;
      },
      publishCommitted: (events) => options.registry.publishCommittedEvents(events), ...(options.now ? { now: options.now } : {}),
    }) : undefined;
    this.executionBinding = { service: this.checkpoints, contextFor: (intent, dispatch, lease) => this.captureContext(intent, dispatch, lease) };
  }
  async prepare(): Promise<void> {
    this.assertOpen();
    if (!this.options.revert) return;
    // A real isolated helper probe is required; failure keeps basic Diff/preview available.
    try { await this.restore.probe(); this.assertOpen(); this.helperAvailable = true; }
    catch (error) { this.assertOpen(); if (!(error instanceof CheckpointError)) throw error; this.helperAvailable = false; }
  }
  bindWorker(worker: { registerOperation(kind: string, handler: OperationIntentHandler): void }): void {
    this.assertOpen(); if (!this.revert || this.registeredWorkers.has(worker)) return;
    worker.registerOperation(REVERT_INTENT_KIND, (intent) => this.revert!.handleIntent(intent));
    this.registeredWorkers.add(worker);
  }
  /** Only versioned current evidence can advertise full native rewind. No runtime is loaded by this check. */
  async capabilitiesForSession(sessionId: string, actorId: string): Promise<HostCheckpointSupport> {
    this.authorize(sessionId, actorId, "session:read");
    const resource = this.resource(sessionId);
    await this.driver(resource.workspace.workspaceId).fingerprint(); this.assertOpen();
    let nativeRewind = false;
    const ports = this.options.revert;
    if (this.helperAvailable && (ports?.native || ports?.nativeFactory) && ports.verifiedNativeCapabilities && resource.session.nativeHandle && resource.providerInstance.verification.state === "verified") {
      const capabilities = await ports.verifiedNativeCapabilities(sessionId); this.assertOpen();
      const current = this.resource(sessionId);
      nativeRewind = current.providerInstance.providerInstanceId === resource.providerInstance.providerInstanceId && bindingDigest(current.session.nativeHandle) === bindingDigest(resource.session.nativeHandle) && current.providerInstance.verification.state === "verified" && capabilities.some((capability) => capability.kind === "conversation-rewind" && Boolean(capability.evidenceId && capability.driverVersion && capability.verifiedVersion) && capability.verifiedVersion === current.providerInstance.verification.runtimeVersion);
    }
    this.authorize(sessionId, actorId, "session:read");
    const workspaceRestore = Boolean(this.revert && this.helperAvailable);
    return { capabilities: [CHECKPOINT_DIFF_CAPABILITY, ...(nativeRewind ? [CHECKPOINT_REVERT_CAPABILITY] : [])], diff: true, preview: true, workspaceRestore, nativeRewind,
      ...(!nativeRewind ? { unsupportedReason: !this.revert ? "REVERT_UNAVAILABLE" : !this.helperAvailable ? "CONTROLLED_RESTORE_UNAVAILABLE" : "PROVIDER_REWIND_UNSUPPORTED" } as const : {}),
    };
  }
  dispatchCheckpoint(frame: RpcRequest, context: CheckpointRpcContext): Promise<CheckpointRpcResult> {
    if (!Object.hasOwn(SCOPES, frame.method)) return Promise.resolve({ handled: false });
    const work = this.dispatch(frame, context); this.requests.add(work);
    void work.finally(() => this.requests.delete(work)).catch(() => {}); return work;
  }
  async drain(deadlineMs = 5000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = async () => { await Promise.all([this.checkpoints.drain(), this.revert?.drain(deadlineMs) ?? true, this.drainRequests()]); return !this.requests.size && await (this.revert?.drain(0) ?? true); };
    try { return await Promise.race([wait(), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs)); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  seal(): void { this.sealed = true; for (const driver of this.drivers.values()) driver.seal(); this.checkpoints.seal(); this.revert?.seal(); this.restore.seal(); }
  private async drainRequests(): Promise<void> { while (this.requests.size) await Promise.allSettled([...this.requests]); }
  private assertOpen(): void { if (this.sealed) throw new CheckpointError("CHECKPOINT_SEALED", "Host checkpoint boundary is sealed"); this.options.owner.assertActive(); }
  private authorize(sessionId: string, actorId: string, scope: CheckpointScope): void {
    this.assertOpen(); if (!actorId) throw new CheckpointError("AUTH_REQUIRED", "An authenticated actor is required");
    sync(this.options.authorizeSession(sessionId, actorId, scope));
    const device = this.options.store.getDevice(actorId);
    if (device && (device.revokedAt || device.expiresAt && device.expiresAt <= (this.options.now?.() ?? new Date()).toISOString())) throw new CheckpointError("DEVICE_REVOKED", "Actor was revoked");
    if (device && !device.scopes.includes(scope)) throw new CheckpointError("SCOPE_REQUIRED", "Actor lacks this scope");
  }
  private resource(sessionId: string) {
    this.assertOpen();
    const resolved = this.options.registry.resolve(sessionId), session = this.options.store.getSession(sessionId);
    // Persisted Diff/content reads use catalog identity only. Requiring a
    // fresh Native activation here would hide history after evidence expires.
    const workspace = resolved.workspace;
    if (!session || resolved.session.sessionId !== sessionId || session.workspaceId !== workspace.workspaceId || session.workspacePath !== workspace.canonicalRoot || resolved.workspace.worktreeRoot !== workspace.worktreeRoot || resolved.providerInstance.provider !== session.provider) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Registered Session binding changed");
    return { ...resolved, workspace };
  }
  private publicRoots(sessionId: string): string[] {
    const resource = this.resource(sessionId);
    const roots = [resource.workspace.canonicalRoot, resource.workspace.worktreeRoot];
    for (const root of [...roots]) if (process.platform === "darwin" && (root.startsWith("/private/var/") || root.startsWith("/private/tmp/"))) {
      const alias = root.slice("/private".length);
      try { if (realpathSync(alias) === root) roots.push(alias); } catch { /* Only verified aliases are public redaction roots. */ }
    }
    return [...new Set(roots)];
  }
  private driver(workspaceId: string): CheckpointGitDriver {
    this.assertOpen(); const workspace = this.options.workspaces.require(workspaceId); const cached = this.drivers.get(workspaceId);
    if (cached && cached.workspace !== workspace.worktreeRoot) throw new CheckpointError("WORKSPACE_BINDING_CHANGED", "Registered Git checkout changed");
    if (cached) return cached;
    const runner: CheckpointGitRunner | undefined = this.options.runGit ? async (request) => {
      this.assertOpen(); const actual = this.options.workspaces.require(workspaceId);
      if (request.workspace !== actual.worktreeRoot) throw new CheckpointError("WORKSPACE_BINDING_CHANGED", "Git runner belongs to another registered checkout");
      let capture: HostCheckpointGitBinding["capture"]; let captureContext: CheckpointContext | undefined;
      if (request.operation.kind === "capture") {
        const manifest = this.checkpoints.store.get(request.operation.checkpointId);
        if (!manifest || manifest.workspaceId !== workspaceId || manifest.status !== "capturing") throw new CheckpointError("CHECKPOINT_CONTEXT_INVALID", "Git capture has no original capturing journal");
        captureContext = { sessionId: manifest.sessionId, workspaceId, lease: { ...manifest.lease }, sessionRevision: manifest.sessionRevision,
          epoch: manifest.epoch, runtimeGeneration: manifest.runtimeGeneration, nativeHandle: manifest.nativeHandle,
          ...(manifest.turnId ? { turnId: manifest.turnId } : {}), ...(manifest.attemptId ? { attemptId: manifest.attemptId } : {}) };
        this.assertLease(captureContext);
        capture = Object.freeze({ checkpointId: manifest.checkpointId, phase: manifest.phase, sessionId: manifest.sessionId, workspaceId,
          ...(manifest.turnId ? { turnId: manifest.turnId } : {}), ...(manifest.attemptId ? { attemptId: manifest.attemptId } : {}),
          lease: Object.freeze({ ...manifest.lease }), sessionRevision: manifest.sessionRevision, epoch: manifest.epoch, runtimeGeneration: manifest.runtimeGeneration });
      }
      const binding: HostCheckpointGitBinding = Object.freeze({ hostOwnerId: this.options.owner.ownerId, hostOwnerGeneration: this.options.owner.generation, workspaceId, ...(capture ? { capture } : {}) });
      const result = await this.options.runGit!(Object.freeze({ ...request, binding })); this.assertOpen();
      if (captureContext) this.assertLease(captureContext); return result;
    } : undefined;
    // The managed runner rejects any requested output budget above its
    // checkpoint policy ceiling, so the production driver must be constructed
    // with budgets at or below it (its own defaults are larger).
    const driverOptions: CheckpointGitDriverOptions = runner ? { runGit: runner, maxFileBytes: MANAGED_GIT_CHECKPOINT_OUTPUT_BYTES, maxCaptureBytes: MANAGED_GIT_CHECKPOINT_OUTPUT_BYTES } : {};
    const record = Object.freeze({ ...workspace, capabilities: [...workspace.capabilities] });
    const driver = this.options.driverFactory?.(record, driverOptions) ?? new CheckpointGitDriver(workspace.worktreeRoot, driverOptions);
    if (driver.workspace !== workspace.worktreeRoot) throw new CheckpointError("WORKSPACE_BINDING_CHANGED", "Checkpoint driver factory returned another checkout");
    if (runner && !driver.usesGitRunner(runner)) throw new CheckpointError("CHECKPOINT_MANAGED_GIT_REQUIRED", "Checkpoint driver factory omitted the managed runner");
    this.drivers.set(workspaceId, driver); return driver;
  }
  private assertActualLease(lease: WorkspaceLease, workspaceId: string, token: CheckpointContext["lease"]): void {
    this.assertOpen(); lease.assertActive();
    const workspace = this.options.workspaces.require(workspaceId);
    if (lease.workspace !== workspace.worktreeRoot || token.workspaceId !== workspaceId || token.leaseId !== lease.operationId || token.generation !== this.options.owner.generation) throw new CheckpointError("WORKSPACE_LEASE_STALE", "Checkpoint lease does not match the registered checkout");
  }
  private assertLease(context: CheckpointContext): void {
    const resource = this.resource(context.sessionId);
    if (resource.workspace.workspaceId !== context.workspaceId) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Lease belongs to another Session");
    this.assertActualLease(this.options.leaseForContext(context), context.workspaceId, context.lease);
  }
  private async resolveContext(sessionId: string, actorId: string, scope: CheckpointScope = "session:write"): Promise<CheckpointPreviewContext> {
    this.authorize(sessionId, actorId, scope);
    const state = await this.options.runtimeState(sessionId, actorId, scope === "session:read" ? "preview" : "revert"); this.assertOpen();
    this.authorize(sessionId, actorId, scope);
    const resource = this.resource(sessionId), session = this.options.store.getSession(sessionId)!;
    if (scope === "session:read" && session.recoveryState === "blocked") throw new CheckpointError("RECOVERY_BLOCKED", "Preview waits for workspace recovery");
    if (resource.session.status !== "active") throw new CheckpointError("SESSION_ARCHIVED", "Preview requires an active Session");
    if (this.options.revert) sync(this.options.revert.assertRestoreWriteReady(this.options.store.db));
    else if (this.options.store.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()) throw new CheckpointError("RECOVERY_BLOCKED", "Restore readiness is blocked");
    const epoch = this.options.views.projector.activeEpoch(sessionId);
    if (!epoch || epoch.state !== "active" || epoch.indexedSequence !== session.headSequence || epoch.projectorVersion !== this.options.views.projector.version) throw new CheckpointError("TIMELINE_UNAVAILABLE", "The actual Session Timeline is not current");
    if (!Number.isSafeInteger(state.runtimeGeneration) || state.runtimeGeneration < 0 || !("nativeHandle" in state)) throw new CheckpointError("CHECKPOINT_CONTEXT_INVALID", "Runtime facts are unavailable");
    const token = { workspaceId: resource.workspace.workspaceId, leaseId: state.lease.operationId, generation: this.options.owner.generation };
    this.assertActualLease(state.lease, resource.workspace.workspaceId, token);
    const context: CheckpointPreviewContext = { sessionId, actorId, workspaceId: resource.workspace.workspaceId, lease: token, sessionRevision: session.revision,
      epoch: epoch.epoch, runtimeGeneration: state.runtimeGeneration, nativeHandle: state.nativeHandle, ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}) };
    this.assertLease(context); return context;
  }
  private captureContext(intent: ExecutionIntentRow, dispatch: DispatchContext, lease: WorkspaceLease): CheckpointContext & { turnId: string; attemptId: string } {
    this.assertOpen(); const resource = this.resource(intent.sessionId!), session = this.options.store.getSession(intent.sessionId!)!;
    const turn = intent.turnId ? this.options.store.getTurn(intent.turnId) : undefined;
    if (!turn || turn.sessionId !== session.id || turn.id !== dispatch.flyxTurnId || turn.attemptId !== dispatch.attemptId || turn.generation !== dispatch.runtimeGeneration || intent.attemptId !== dispatch.attemptId || intent.runtimeGeneration !== dispatch.runtimeGeneration || dispatch.sessionId !== session.id || dispatch.hostOwnerId !== this.options.owner.ownerId || dispatch.hostOwnerGeneration !== this.options.owner.generation || bindingDigest(intent.dispatchContext) !== bindingDigest(dispatch)) throw new CheckpointError("CHECKPOINT_CONTEXT_INVALID", "Capture must use the original dispatch binding");
    const state = this.options.captureStateFor(intent, dispatch, lease), epoch = this.options.views.projector.activeEpoch(session.id);
    if (state.runtimeGeneration !== dispatch.runtimeGeneration || !("nativeHandle" in state) || !epoch || epoch.state !== "active" || epoch.indexedSequence !== session.headSequence) throw new CheckpointError("CHECKPOINT_CONTEXT_INVALID", "Capture runtime or epoch is unavailable");
    const context = { sessionId: session.id, workspaceId: resource.workspace.workspaceId, turnId: turn.id, attemptId: dispatch.attemptId,
      lease: { workspaceId: resource.workspace.workspaceId, leaseId: lease.operationId, generation: this.options.owner.generation }, sessionRevision: session.revision, epoch: epoch.epoch, runtimeGeneration: state.runtimeGeneration, nativeHandle: state.nativeHandle };
    this.assertActualLease(lease, context.workspaceId, context.lease); return context;
  }
  private requireRevert(): RevertService {
    this.assertOpen(); if (!this.revert) throw new CheckpointRpcError("REVERT_UNAVAILABLE");
    if (!this.helperAvailable) throw new CheckpointRpcError("CONTROLLED_RESTORE_UNAVAILABLE"); return this.revert;
  }
  private async dispatch(frame: RpcRequest, context: CheckpointRpcContext): Promise<CheckpointRpcResult> {
    try {
      this.assertOpen(); context.assertAuthorized(frame.method);
      if (context.protocolVersion !== 2) throw new CheckpointRpcError("PROTOCOL_V2_REQUIRED");
      if (!context.capabilities?.has(CHECKPOINT_DIFF_CAPABILITY)) throw new CheckpointRpcError("CAPABILITY_REQUIRED");
      const method = frame.method as keyof typeof SCOPES;
      const scope = SCOPES[method];
      const parse = <T extends { sessionId: string }>(schema: z.ZodType<T>): T => {
        const input = schema.parse(frame.payload); sync(context.assertSessionScope(input.sessionId, scope)); this.authorize(input.sessionId, context.subjectId, scope); this.resource(input.sessionId); return input;
      };
      const command = (input: { commandId: string }) => { if (!frame.commandId) throw new CheckpointRpcError("COMMAND_ID_REQUIRED"); if (frame.commandId !== input.commandId) throw new CheckpointRpcError("COMMAND_ID_MISMATCH"); };
      let payload: unknown; let sessionId: string;
      switch (method) {
        case "checkpoint.getDiff": { const input = parse(CheckpointGetDiffSchema); sessionId = input.sessionId; payload = CheckpointDiffPageSchema.parse(await this.checkpoints.getDiffPage(pageInput(input))); break; }
        case "checkpoint.getTurnDiff": { const input = parse(CheckpointGetTurnDiffSchema); sessionId = input.sessionId; payload = CheckpointDiffPageSchema.parse(await this.checkpoints.getTurnDiff(pageInput(input))); break; }
        case "checkpoint.getSessionDiff": { const input = parse(CheckpointGetSessionDiffSchema); sessionId = input.sessionId; payload = CheckpointDiffPageSchema.parse(await this.checkpoints.getSessionDiff(pageInput(input))); break; }
        case "checkpoint.getFile": { const input = parse(CheckpointGetFileSchema); sessionId = input.sessionId; payload = CheckpointDiffFileSchema.parse(await this.checkpoints.getDiffFile(input)); break; }
        case "checkpoint.previewRevert": {
          const input = parse(CheckpointPreviewRevertSchema); sessionId = input.sessionId;
          try {
            const page = CheckpointPreviewPageSchema.parse(await this.previews.createPreview({ ...input, actorId: context.subjectId }));
            this.options.previewCreated?.(sessionId, context.subjectId, page.expiresAt); payload = page;
          } catch (error) { this.options.previewAborted?.(sessionId, context.subjectId); throw error; }
          break;
        }
        case "checkpoint.getPreview": { const input = parse(CheckpointGetPreviewSchema); sessionId = input.sessionId; payload = CheckpointPreviewPageSchema.parse(this.previews.getPreview({ ...pageInput(input), actorId: context.subjectId })); break; }
        case "checkpoint.executeRevert": {
          const input = parse(CheckpointExecuteRevertSchema); sessionId = input.sessionId; command(input);
          if (!context.capabilities.has(CHECKPOINT_REVERT_CAPABILITY) || !(await this.capabilitiesForSession(sessionId, context.subjectId)).nativeRewind) throw new CheckpointRpcError("PROVIDER_REWIND_UNSUPPORTED");
          payload = CheckpointRevertOperationSchema.parse(await this.requireRevert().accept({ ...input, actorId: context.subjectId, mode: "revert" })); break;
        }
        case "checkpoint.workspaceRestore": { const input = parse(CheckpointWorkspaceRestoreSchema); sessionId = input.sessionId; command(input); payload = CheckpointRevertOperationSchema.parse(await this.requireRevert().accept({ ...input, actorId: context.subjectId, mode: "workspaceRestore" })); break; }
        case "checkpoint.getRevertOperation": { const input = parse(CheckpointRevertOperationQuerySchema); sessionId = input.sessionId; if (!this.revert) throw new CheckpointRpcError("REVERT_UNAVAILABLE"); payload = CheckpointRevertOperationSchema.parse(this.revert.getOperation({ ...input, actorId: context.subjectId })); break; }
        case "checkpoint.inspectRevert": { const input = parse(CheckpointInspectRevertSchema); sessionId = input.sessionId; payload = CheckpointRevertEvidenceSchema.parse(await this.requireRevert().inspectRecovery({ ...input, actorId: context.subjectId })); break; }
        case "checkpoint.resumeVerified": { const input = parse(CheckpointResumeVerifiedSchema); sessionId = input.sessionId; command(input); payload = CheckpointRevertOperationSchema.parse(await this.requireRevert().resumeVerified({ ...input, actorId: context.subjectId })); break; }
        case "checkpoint.rollbackToSafety": { const input = parse(CheckpointRollbackToSafetySchema); sessionId = input.sessionId; command(input); payload = CheckpointRevertOperationSchema.parse(await this.requireRevert().rollbackToSafety({ ...input, actorId: context.subjectId })); break; }
      }
      this.assertOpen(); sync(context.assertSessionScope(sessionId, scope)); this.authorize(sessionId, context.subjectId, scope); this.assertPublicPaths(payload);
      (context.frameBudget ?? new FrameBudget()).assert(context.responseEnvelope?.(payload) ?? { type: "response", id: frame.id, ok: true, payload, transportGeneration: Number.MAX_SAFE_INTEGER });
      return { handled: true, payload };
    } catch (error) { throw new CheckpointRpcError(errorCode(error)); }
  }
  private assertPublicPaths(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) this.assertPublicPaths(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "path" || key === "oldPath") && typeof item === "string") validateCheckpointPath(item);
      else this.assertPublicPaths(item);
    }
  }
}
