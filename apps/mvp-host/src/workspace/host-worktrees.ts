import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  WORKTREE_CAPABILITY, WorktreeCreateRpcSchema, WorktreeExistingRpcSchema, WorktreeListRpcSchema,
  WorktreeOperationRpcSchema, WorktreeResumeRpcSchema, WorktreeReceiptRpcSchema, WorktreeResultSchema,
  type WorktreeCommandResult, type WorktreeInspection, type WorktreeListResult, type WorktreeReceiptResult,
  type WorktreeRequest, type WorktreeResult,
} from "@flyx/mvp-protocol";
import { AccessError } from "../auth/connection-authorizer.js";
import type { ConnectionPrincipal, DeviceRegistry } from "../auth/device-registry.js";
import { assertHostOwner, type HostOwnerHandle, type OwnershipRecoveryAuthorization } from "../lifecycle/host-owner.js";
import { restoreWriteGuard } from "../operations/host-operations.js";
import { assertReceiptRequest, type ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { OperationIntentHandler, OperationResult } from "../orchestration/execution-worker.js";
import { dispatchContextForTurn, type DispatchContext } from "../provider/types.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { CatalogStore, WorkspaceRecord } from "../storage/catalog-store.js";
import type { CommandReceiptRow } from "../storage/db.js";
import { ExecutionStore } from "../storage/execution-store.js";
import type { WorktreeGit } from "./worktree-git.js";
import { WorktreeService, publicOperation, summary, type WorktreeCatalog } from "./worktree-service.js";
import { WorktreeStore, WorktreeError, type ManagedWorktreeRecord, type StoredWorktreeInspection, type WorktreeOperationRecord } from "./worktree-store.js";
import { WorkspaceLease } from "./workspace-lease.js";
import type { PreparedWorkspaceRegistration, WorkspaceRegistry } from "./workspace-registry.js";

export const WORKTREE_COMMAND_METHODS = ["worktree.create", "worktree.archive", "worktree.restore", "worktree.reconcile", "worktree.resume"] as const;
export type WorktreeCommandMethod = typeof WORKTREE_COMMAND_METHODS[number];
export const WORKTREE_RPC_SCOPES = Object.freeze({
  "worktree.list": "session:read", "worktree.getOperation": "session:read", "worktree.getReceipt": "session:read",
  "worktree.create": "session:write", "worktree.archive": "session:write", "worktree.restore": "session:write",
  "worktree.reconcile": "session:write", "worktree.resume": "session:write",
} as const);
/** Constructed from the authenticated Gateway context, never from the RPC payload. */
export type WorktreeRpcContext = { subjectId: string; leaseId: string; transportGeneration: number; protocolVersion: number; capabilities: ReadonlySet<string> };
/** Trusted attester must reload the original managed identities/boundaries and prove every original helper stopped. */
export type WorktreeProducerStopProof = {
  kind: "verified-worktree-stop"; operationId: string; dispatchContextDigest: string; writerContextsDigest: string; sourceId: string; contractId: string;
};
/** Private local driver context, never an RPC DTO. Git factories use it to journal before launch. */
export type WorktreeExecutionContext = Readonly<{
  operationId: string; worktreeId: string; sessionId: string; method: WorktreeCommandMethod; readOnly: boolean;
  dispatchContext: DispatchContext; originalDispatchContext: DispatchContext; checkoutRoot: string; repositoryRoot: string;
}>;
export type WorktreeDriverClose = { producerStopped: boolean; clean: boolean };
export type HostWorktreesOptions = {
  catalog: CatalogStore; workspaces: WorkspaceRegistry; sessions: SessionRegistry; devices: DeviceRegistry; owner: HostOwnerHandle;
  managedRoot: string; privateDirectories: readonly string[];
  /** Supply a pre-launch managed Git driver. Post-spawn observation cannot establish ownership. */
  git: WorktreeGit;
  assertWriteReady?(): void;
  /** Cached verified backend/exit-contract readiness; this accessor must not launch a process. */
  executionReadiness?(): { ready: boolean; reasonCode?: string };
  trackOperation?<T>(kind: "producer", operation: () => Promise<T>): Promise<T>;
  accepted?(intent: ExecutionIntentRow): void;
  producerStopProof?(operation: WorktreeOperationRecord, original: DispatchContext, successors: readonly DispatchContext[]): Promise<WorktreeProducerStopProof | undefined>;
  recoveryAuthorization?(record: ManagedWorktreeRecord, operation: WorktreeOperationRecord, inspection: StoredWorktreeInspection): OwnershipRecoveryAuthorization | undefined;
  /** Must derive stopped/clean from original central identity and full-tree evidence, never root exit alone. */
  closeGit?(deadlineMs: number): Promise<WorktreeDriverClose>;
  sealGitJournal?(): void;
  /** Testing/managed driver hook; all dispatched boundaries have already committed. */
  onBoundary?(boundary: string, moment: "dispatched" | "applied" | "committed", operation: WorktreeOperationRecord): Promise<void>;
  afterDispatchMarker?(intent: ExecutionIntentRow): Promise<void>;
};
type CommandBinding = { actorId: string; worktreeId: string; method: WorktreeCommandMethod; commandId: string; intentId: string; sessionId: string; requestHash: string; dispatchContext: DispatchContext; evidenceId?: string; gate?: ResumeGate };
type ResumeGate = { evidenceId: string; observationsDigest: string; originalContextDigest: string; proof: WorktreeProducerStopProof; expiresAt: string; revision: number };
const CommandId = z.string().min(1).max(128);
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw); if (!result.success) throw new WorktreeError("PROTOCOL_INVALID", "Worktree RPC payload is invalid"); return result.data;
}
export function worktreeDispatchContextDigest(context: DispatchContext): string {
  return createHash("sha256").update(JSON.stringify([context.hostOwnerId, context.hostOwnerGeneration, context.sessionId, context.flyxTurnId, context.runtimeId, context.runtimeGeneration, context.attemptId])).digest("hex");
}
export function worktreeWriterContextsDigest(contexts: readonly DispatchContext[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(contexts.map(worktreeDispatchContextDigest))].sort())).digest("hex");
}
function withoutTimes(record: WorkspaceRecord) { const { createdAt: _created, updatedAt: _updated, ...rest } = record; return rest; }
function publicErrorCode(value: unknown, fallback = "WORKTREE_OPERATION_UNKNOWN"): string {
  return typeof value === "string" && /^[A-Z0-9_]{1,128}$/.test(value) ? value : fallback;
}
function resultFor(store: WorktreeStore, operation: WorktreeOperationRecord, inspection?: WorktreeInspection): WorktreeResult {
  const publicValue = publicOperation(operation);
  return { operation: { ...publicValue, ...(publicValue.errorCode ? { errorCode: publicErrorCode(publicValue.errorCode) } : {}) }, worktree: summary(store.require(operation.worktreeId)), ...(inspection ? { inspection } : {}) };
}

/** One owned connection, real Catalog Sessions, immutable original operation context. No query loads a runtime. */
export class HostWorktrees {
  readonly store: WorktreeStore;
  readonly service: WorktreeService;
  readonly execution: ExecutionStore;
  readonly operationHandlers: Readonly<Record<string, OperationIntentHandler>>;
  private readonly nativeContext = new AsyncLocalStorage<WorktreeExecutionContext>();
  private readonly runtimeId = "worktree-driver-" + randomUUID();
  private readonly calls = new Set<Promise<unknown>>();
  private readonly publisher: WorktreeCatalog;
  private readonly running = new Map<string, Promise<OperationResult>>();
  private readonly executing = new Map<string, CommandBinding>();
  private readonly events = new Map<string, Parameters<SessionRegistry["publishCommittedEvents"]>[0]>();
  private admission = true;
  private sealed = false;
  private readonly guard: () => void;
  constructor(readonly options: HostWorktreesOptions) {
    const { catalog, workspaces, sessions, devices, owner } = options;
    assertHostOwner(owner); owner.assertStorePath(catalog.db.name); catalog.store.assertWriterOwner();
    if (workspaces.catalog !== catalog || sessions.catalog !== catalog || sessions.workspaces !== workspaces || devices.store !== catalog.store) throw new WorktreeError("WORKTREE_STORE_MISMATCH", "Worktree bindings must share the owned Catalog connection");
    this.store = new WorktreeStore(catalog.db); this.execution = new ExecutionStore(catalog.store);
    if (!this.ready()) throw new WorktreeError("WORKTREES_UNAVAILABLE", "Managed worktree schema is unavailable");
    this.guard = options.assertWriteReady ?? restoreWriteGuard(catalog.store);
    const publisher: WorktreeCatalog = {
      resolveRepository: (id) => workspaces.resolveRepository(id),
      assertNoWriterOrRuntime: (id, op) => this.assertCheckoutIdle(id, op),
      reserve: (record) => {
        const current = this.boundWorkspace(record);
        catalog.putWorkspace({ ...withoutTimes(current), state: "needs_verification" });
      },
      prepareWorktreeRegistration: (record, operation) => workspaces.prepareWorktreeRegistration({ workspaceId: record.workspaceId, root: record.path, repositoryId: record.repositoryId, operationId: operation.operationId }),
      publish: (record, operation, prepared) => {
        this.assertWritable();
        if (operation.state === "completed" && record.state === "active") workspaces.commitWorktreeRegistration(prepared as PreparedWorkspaceRegistration, operation.operationId);
        else {
          const current = this.boundWorkspace(record);
          catalog.putWorkspace({ ...withoutTimes(current), state: record.state === "active" ? "active" : record.state === "archived" ? "disabled" : "needs_verification" });
        }
        this.settleOriginal(operation);
        const continuation = this.executing.get(operation.operationId);
        if (continuation?.method === "worktree.resume") {
          for (const binding of this.recoveryBindings(operation).filter((item) => item.method === "worktree.resume")) {
            const receipt = catalog.store.getCommandReceipt(operation.actorId, binding.commandId);
            if (binding.intentId === continuation.intentId || receipt?.state === "outcome_unknown") this.settleBinding(operation, binding, "completed", resultFor(this.store, operation));
          }
        }
      },
    };
    this.publisher = publisher;
    this.service = new WorktreeService(this.store, {
      managedRoot: options.managedRoot, privateDirectories: options.privateDirectories, catalog: publisher, git: options.git,
      authorize: (actor) => { this.assertWritable(); this.assertDevice(actor, "session:write"); },
      acquireLease: (record, operation) => {
        const evidenceId = operation.facts.recoveryEvidenceId;
        const inspection = typeof evidenceId === "string" ? this.store.inspection(evidenceId) : undefined;
        const recovery = inspection ? options.recoveryAuthorization?.(record, operation, inspection) : undefined;
        return WorkspaceLease.acquireReserved({ canonicalWorkspace: record.path, owner, operationId: operation.operationId, ...(recovery ? { recovery } : {}) });
      },
      producerStopped: async (operation) => Boolean(await this.stopProof(operation)),
      clearLeaseRetention: (record, operation, inspection, handle) => {
        const authorization = options.recoveryAuthorization?.(record, operation, inspection);
        if (!authorization) throw new WorktreeError("WORKTREE_RECOVERY_PROOF_REQUIRED", "Retained checkout lease requires committed recovery authorization");
        (handle as WorkspaceLease).clearRetention(authorization.proof, authorization.verifyProof);
      },
      onBoundary: async (boundary, moment, operation) => {
        this.assertWritable(); if (moment === "dispatched") this.assertExecutionReady(); await options.onBoundary?.(boundary, moment, operation);
        if (boundary === "publish" && moment === "dispatched") {
          // Core releases the checkout lease after publication. Require evidence
          // for the current helper tree as well as every previous writer first.
          const proof = await this.stopProof(this.store.operation(operation.operationId), "");
          if (!proof) throw new WorktreeError("WORKTREE_PRODUCER_UNKNOWN", "Verify every worktree helper stopped before publishing or releasing the checkout lease");
          this.assertWritable(); this.store.facts(operation.operationId, { terminalStopProof: proof });
        }
      },
    });
    this.operationHandlers = Object.freeze(Object.fromEntries(WORKTREE_COMMAND_METHODS.map((kind) => [kind, (intent: ExecutionIntentRow) => this.handleIntent(intent)])));
  }
  ready(): boolean {
    if (this.sealed || !this.options.catalog.db.open || this.options.catalog.db.readonly) return false;
    try {
      if (!this.options.catalog.db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get()) return false;
      const required = { managed_worktrees: ["worktree_id", "record_json"], worktree_operations: ["operation_id", "facts_json", "request_hash"], worktree_steps: ["operation_id", "state"], worktree_inspections: ["evidence_json"], worktree_snapshots: ["snapshot_json"], worktree_snapshot_pins: ["snapshot_id"], execution_intents: ["dispatch_context_json", "commit_id"], command_receipts: ["request_format_version", "target_session_id"] };
      return Object.entries(required).every(([table, names]) => { const columns = new Set((this.options.catalog.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)); return names.every((name) => columns.has(name)); });
    } catch { return false; }
  }
  readiness(): { queryReady: boolean; executionReady: boolean; reasonCode?: string } {
    const queryReady = this.ready();
    if (!queryReady) return { queryReady, executionReady: false, reasonCode: "WORKTREES_UNAVAILABLE" };
    if (!this.options.producerStopProof || !this.options.executionReadiness) return { queryReady, executionReady: false, reasonCode: "WORKTREE_STOP_CONTRACT_UNVERIFIED" };
    try {
      const readiness = this.options.executionReadiness();
      if (readiness.ready) return { queryReady, executionReady: true };
      return { queryReady, executionReady: false, reasonCode: readiness.reasonCode && /^[A-Z0-9_]{1,128}$/.test(readiness.reasonCode) ? readiness.reasonCode : "WORKTREE_EXECUTION_UNAVAILABLE" };
    } catch { return { queryReady, executionReady: false, reasonCode: "WORKTREE_EXECUTION_UNAVAILABLE" }; }
  }
  private assertExecutionReady(): void {
    const readiness = this.readiness(); if (!readiness.executionReady) throw new WorktreeError(readiness.reasonCode!, "Managed Git execution needs a verified private-data boundary and helper stop contract");
  }
  private assertWritable(): void {
    if (this.sealed) throw new WorktreeError("HOST_CLOSED", "Worktree driver is sealed");
    assertHostOwner(this.options.owner); this.options.catalog.store.assertWriterOwner();
    if (this.options.owner.mode === "maintenance" || this.options.owner.recoveryOnly) throw new WorktreeError("HOST_MAINTENANCE_ONLY", "Worktree execution is unavailable in maintenance mode");
    const checked = this.guard?.() as unknown;
    if (checked && typeof (checked as { then?: unknown }).then === "function") throw new WorktreeError("WORKTREE_ASYNC_ADMISSION", "Write readiness must be synchronous");
  }
  private authorize(context: WorktreeRpcContext, scope: "session:read" | "session:write"): ConnectionPrincipal {
    if (!this.ready()) throw new WorktreeError("WORKTREES_UNAVAILABLE", "Managed worktrees are unavailable");
    const actor = this.options.devices.assertLease(context.leaseId, context.transportGeneration);
    if (actor.deviceId !== context.subjectId) throw new AccessError("DEVICE_UNAUTHORIZED", "Worktree requests belong to the authenticated actor");
    if (context.protocolVersion !== 2 || actor.protocolVersion !== 2) throw new AccessError("PROTOCOL_INCOMPATIBLE", "Managed worktrees require protocol version 2");
    const saved = this.options.catalog.store.getProtocolSession(actor.leaseId);
    if (!context.capabilities.has(WORKTREE_CAPABILITY) || !saved?.capabilities.includes(WORKTREE_CAPABILITY)) throw new AccessError("CAPABILITY_REQUIRED", "Managed worktree capability is required");
    if (!actor.scopes.has(scope)) throw new AccessError("FORBIDDEN", "This device does not have " + scope + " permission");
    return actor;
  }
  private assertDevice(actorId: string, scope: string): void {
    const device = this.options.catalog.store.getDevice(actorId);
    if (!device || device.hostId !== this.options.devices.hostId || device.revokedAt || device.expiresAt && device.expiresAt <= new Date().toISOString()) throw new AccessError("DEVICE_REVOKED", "Original worktree actor is no longer authorized");
    if (!device.scopes.includes(scope)) throw new AccessError("FORBIDDEN", "Original worktree actor no longer has " + scope + " permission");
  }
  private source(sessionId: string, repositoryId?: string) {
    const resolved = this.options.sessions.resolve(sessionId);
    if (repositoryId && resolved.workspace.repositoryId !== repositoryId) throw new WorktreeError("WORKTREE_SCOPE_MISMATCH", "Source Session belongs to another registered repository");
    return resolved;
  }
  list(raw: unknown, context: WorktreeRpcContext): WorktreeListResult {
    const request = parse(WorktreeListRpcSchema, raw); this.authorize(context, "session:read");
    const repositoryId = this.source(request.sessionId).workspace.repositoryId;
    const rows = this.options.catalog.db.prepare("SELECT record_json FROM managed_worktrees WHERE repository_id=? AND worktree_id>? ORDER BY worktree_id LIMIT ?").all(repositoryId, request.afterWorktreeId ?? "", request.limit + 1) as Array<{ record_json: string }>;
    const worktrees = rows.slice(0, request.limit).map((row) => summary(JSON.parse(row.record_json) as ManagedWorktreeRecord));
    return { worktrees, ...(rows.length > request.limit ? { nextWorktreeId: worktrees.at(-1)!.worktreeId } : {}) };
  }
  getOperation(raw: unknown, context: WorktreeRpcContext): WorktreeResult {
    const request = parse(WorktreeOperationRpcSchema, raw), actor = this.authorize(context, "session:read");
    return resultFor(this.store, this.original(request.operationId, request.sessionId, actor.deviceId));
  }
  getReceipt(raw: unknown, context: WorktreeRpcContext): WorktreeReceiptResult {
    const request = parse(WorktreeReceiptRpcSchema, raw), actor = this.authorize(context, "session:read"); this.source(request.sessionId);
    const receipt = this.options.catalog.store.getCommandReceipt(actor.deviceId, request.commandId);
    if (!receipt || !(WORKTREE_COMMAND_METHODS as readonly string[]).includes(receipt.method) || receipt.targetSessionId !== request.sessionId) return { found: false, commandId: request.commandId };
    this.assertDevice(actor.deviceId, "session:write");
    if (receipt.requestFormatVersion !== 2) throw new WorktreeError("WORKTREE_RECEIPT_INVALID", "Worktree receipt format is invalid");
    const response = parse(WorktreeResultSchema, receipt.response);
    return { found: true, commandId: receipt.commandId, method: receipt.method as WorktreeCommandMethod, state: receipt.state, response, updatedAt: receipt.updatedAt };
  }
  private trackCall<T>(run: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new WorktreeError("HOST_CLOSED", "Worktree driver is sealed"));
    const pending = Promise.resolve().then(run); this.calls.add(pending);
    void pending.then(() => this.calls.delete(pending), () => this.calls.delete(pending)); return pending;
  }
  command(method: WorktreeCommandMethod, raw: unknown, commandId: string, context: WorktreeRpcContext): Promise<WorktreeCommandResult> {
    return this.trackCall(() => this.acceptCommand(method, raw, commandId, context));
  }
  private async acceptCommand(method: WorktreeCommandMethod, raw: unknown, commandId: string, context: WorktreeRpcContext): Promise<WorktreeCommandResult> {
    parse(CommandId, commandId);
    if (!this.admission) throw new WorktreeError("HOST_DRAINING", "Worktree command admission is closed");
    if (!(WORKTREE_COMMAND_METHODS as readonly string[]).includes(method)) throw new WorktreeError("METHOD_NOT_FOUND", "Worktree command is unsupported");
    const resumeRequest = method === "worktree.resume" ? parse(WorktreeResumeRpcSchema, raw) : undefined;
    const payload = method === "worktree.create" ? parse(WorktreeCreateRpcSchema, raw) : method === "worktree.reconcile" ? parse(WorktreeOperationRpcSchema, raw) : method === "worktree.resume" ? resumeRequest! : parse(WorktreeExistingRpcSchema, raw);
    const actor = this.authorize(context, "session:write"), { sessionId } = payload;
    this.source(sessionId); this.assertWritable(); this.assertExecutionReady();
    const hash = this.options.sessions.hashRequest(method, payload, sessionId);
    const prior = this.options.catalog.store.getCommandReceipt(actor.deviceId, commandId);
    if (prior) { this.assertDuplicate(prior, method, hash, sessionId); return this.response(prior, true); }
    const continuation = method === "worktree.reconcile" || method === "worktree.resume";
    let operation: WorktreeOperationRecord | undefined;
    let gate: ResumeGate | undefined;
    if (continuation) {
      operation = this.original((payload as { operationId: string }).operationId, sessionId, actor.deviceId);
      if (method === "worktree.resume") gate = await this.prepareResume(operation, resumeRequest!.evidenceId);
    }
    const accepted = this.options.catalog.db.transaction(() => {
      this.authorize(context, "session:write"); this.assertWritable(); this.assertExecutionReady();
      const existing = this.options.catalog.store.getCommandReceipt(actor.deviceId, commandId);
      if (existing) { this.assertDuplicate(existing, method, hash, sessionId); return { receipt: existing }; }
      const resolved = this.source(sessionId);
      if (resolved.session.status !== "active") throw new WorktreeError("SESSION_ARCHIVED", "Source Session is archived");
      let op: WorktreeOperationRecord;
      if (operation) { op = this.original(operation.operationId, sessionId, actor.deviceId); if (gate) this.assertResumeGate(op, gate); }
      else {
        const { sessionId: _source, ...input } = payload;
        const request = { ...input, kind: method.slice("worktree.".length) } as WorktreeRequest;
        const repositoryId = request.kind === "create" ? request.repositoryId : this.store.require(request.worktreeId).repositoryId;
        this.source(sessionId, repositoryId); this.assertSourceIdle(sessionId);
        op = this.service.accept(request, { actorId: actor.deviceId, commandId });
      }
      const binding: CommandBinding = { actorId: actor.deviceId, worktreeId: op.worktreeId, method, commandId, sessionId, requestHash: hash, intentId: randomUUID(),
        dispatchContext: this.newContext(op.worktreeId, sessionId), ...(gate && resumeRequest ? { evidenceId: resumeRequest.evidenceId, gate } : {}) };
      if (continuation) {
        const recovery = this.recoveryBindings(op);
        if (recovery.length >= 128) throw new WorktreeError("WORKTREE_RECOVERY_LIMIT", "Worktree recovery command history reached its bound");
        this.assertSourceIdle(sessionId, this.originalBinding(op), ...recovery.filter((item) => this.execution.get(item.intentId)?.state === "outcome_unknown"));
        if (recovery.some((item) => { const intent = this.execution.get(item.intentId); return intent && ["pending", "claimed", "dispatching", "acknowledged"].includes(intent.state); })) throw new WorktreeError("WORKSPACE_BUSY", "Another recovery command is pending");
        this.store.facts(op.operationId, { recoveryCommands: [...recovery, binding] });
      } else this.store.facts(op.operationId, { originalCommand: binding });
      op = this.store.operation(op.operationId);
      const result = resultFor(this.store, op);
      const committed = this.options.catalog.store.commitCommand({ sessionId, build: () => ({ result,
        events: [{ type: method + ".accepted", payload: { operationId: op.operationId, worktreeId: op.worktreeId, ...(binding.evidenceId ? { evidenceId: binding.evidenceId } : {}) } }],
        receipts: [{ authSubjectId: actor.deviceId, commandId, method, requestHash: hash, requestFormatVersion: 2, targetSessionId: sessionId, state: "accepted", response: result }],
        intents: [{ id: binding.intentId, sessionId, authSubjectId: actor.deviceId, commandId, ordinal: 0, actorKind: "device", kind: method,
          resourceId: op.worktreeId, payload: { operationId: op.operationId, ...(binding.evidenceId ? { evidenceId: binding.evidenceId } : {}) }, requestHash: hash, requestFormatVersion: 2,
          runtimeGeneration: binding.dispatchContext.runtimeGeneration, attemptId: binding.dispatchContext.attemptId, dispatchContext: binding.dispatchContext }],
      }) })!;
      return { receipt: this.options.catalog.store.getCommandReceipt(actor.deviceId, commandId)!, events: committed.events, intent: committed.intents[0] };
    })();
    if (accepted.events) this.options.sessions.publishCommittedEvents(accepted.events);
    if (accepted.intent) { try { this.options.accepted?.(accepted.intent); } catch { /* Durable pending intent remains discoverable. */ } }
    return this.response(accepted.receipt, !accepted.intent);
  }
  /** The currently executing helper's actual context; safe for concurrent different worktrees. */
  currentExecution(): WorktreeExecutionContext | undefined { return this.nativeContext.getStore(); }
  private driverContext(operation: WorktreeOperationRecord, binding: CommandBinding, readOnly: boolean): WorktreeExecutionContext {
    const record = this.store.require(operation.worktreeId);
    return Object.freeze({ operationId: operation.operationId, worktreeId: operation.worktreeId, sessionId: binding.sessionId, method: binding.method, readOnly,
      dispatchContext: Object.freeze({ ...binding.dispatchContext }), originalDispatchContext: Object.freeze({ ...this.originalBinding(operation).dispatchContext }), checkoutRoot: record.path, repositoryRoot: record.repositoryRoot });
  }
  private newContext(worktreeId: string, sessionId: string): DispatchContext {
    return dispatchContextForTurn(worktreeId, { hostOwnerId: this.options.owner.ownerId, hostOwnerGeneration: this.options.owner.generation, sessionId, flyxTurnId: worktreeId,
      runtimeId: this.runtimeId, runtimeGeneration: 1, attemptId: randomUUID() });
  }
  private original(id: string, sessionId: string, actorId: string): WorktreeOperationRecord {
    const op = this.store.operation(id), binding = this.originalBinding(op);
    if (op.actorId !== actorId || binding.sessionId !== sessionId) throw new WorktreeError("WORKTREE_SCOPE_MISMATCH", "Worktree operation belongs to another Actor or Session");
    this.source(sessionId, this.store.require(op.worktreeId).repositoryId); return op;
  }
  private originalBinding(op: WorktreeOperationRecord): CommandBinding {
    const binding = op.facts.originalCommand as CommandBinding | undefined;
    if (!binding || binding.actorId !== op.actorId || binding.worktreeId !== op.worktreeId || binding.commandId !== op.commandId || binding.method !== "worktree." + op.kind || binding.dispatchContext?.sessionId !== binding.sessionId) throw new WorktreeError("WORKTREE_CONTEXT_MISSING", "Worktree operation has no original Engine context");
    return binding;
  }
  private recoveryBindings(op: WorktreeOperationRecord): CommandBinding[] { return Array.isArray(op.facts.recoveryCommands) ? op.facts.recoveryCommands as CommandBinding[] : []; }
  private bindingFor(intent: ExecutionIntentRow): { operation: WorktreeOperationRecord; binding: CommandBinding } {
    const payload = intent.payload as { operationId?: string } | undefined;
    if (!payload?.operationId) throw new WorktreeError("WORKTREE_INVALID_INTENT", "Worktree intent has no operation binding");
    const operation = this.store.operation(payload.operationId);
    const binding = [this.originalBinding(operation), ...this.recoveryBindings(operation)].find((item) => item.intentId === intent.id);
    if (!binding || binding.actorId !== operation.actorId || binding.worktreeId !== operation.worktreeId || operation.actorId !== intent.authSubjectId || intent.commandId !== binding.commandId || intent.kind !== binding.method
      || intent.sessionId !== binding.sessionId || intent.resourceId !== operation.worktreeId || intent.requestHash !== binding.requestHash || intent.requestFormatVersion !== 2
      || !intent.dispatchContext || worktreeDispatchContextDigest(intent.dispatchContext) !== worktreeDispatchContextDigest(binding.dispatchContext)) throw new WorktreeError("WORKTREE_SCOPE_MISMATCH", "Execution intent does not match its immutable worktree command");
    this.source(binding.sessionId, this.store.require(operation.worktreeId).repositoryId);
    return { operation, binding };
  }
  /** Inject in R06 synchronous claim/marker revalidation; resume gate was attested and committed at acceptance. */
  revalidateIntent(intent: ExecutionIntentRow): void {
    this.assertWritable(); this.assertExecutionReady(); const { operation, binding } = this.bindingFor(intent); this.assertDevice(intent.authSubjectId, "session:write");
    if (binding.method === "worktree.resume") this.assertResumeGate(operation, binding.gate!, binding.intentId);
  }
  private revalidate(intent: ExecutionIntentRow): void { this.revalidateIntent(intent); }
  /** Owned scheduler seam for unloaded Sessions; R06 can use operationHandlers instead. */
  dispatchAccepted(intentId: string): Promise<OperationResult> { return this.trackCall(() => this.dispatchOnce(intentId)); }
  private async dispatchOnce(intentId: string): Promise<OperationResult> {
    let intent = this.execution.get(intentId); if (!intent) throw new WorktreeError("WORKTREE_INVALID_INTENT", "Execution intent is missing");
    const { operation, binding } = this.bindingFor(intent);
    if (intent.state !== "pending") return { status: intent.state === "outcome_unknown" ? "outcome_unknown" : "settled", resultCode: "WORKTREE_ALREADY_DISPATCHED", result: resultFor(this.store, operation) };
    try {
      if (!this.admission) throw new WorktreeError("HOST_DRAINING", "Worktree dispatch admission is closed");
      if (binding.method === "worktree.resume") { const gate = await this.prepareResume(operation, binding.evidenceId!); this.assertResumeGate(operation, binding.gate!, binding.intentId); if (gate.observationsDigest !== binding.gate!.observationsDigest) throw new WorktreeError("WORKTREE_EVIDENCE_STALE", "Recovery observations changed before claim"); }
      const owner = { id: this.options.owner.ownerId, generation: this.options.owner.generation };
      intent = this.execution.claim(intent.id, owner, (value) => this.revalidate(value));
      intent = this.execution.transition({ id: intent.id, expectedStates: ["claimed"], state: "dispatching", expectedClaimOwnerId: owner.id, expectedClaimOwnerGeneration: owner.generation }, (value) => this.revalidate(value));
      await this.options.afterDispatchMarker?.(intent);
      this.revalidate(this.execution.get(intent.id)!);
    } catch (error) {
      const code = publicErrorCode(error instanceof Error && "code" in error ? error.code : undefined, "WORKTREE_NOT_DISPATCHED");
      // This local path has not invoked the operation driver. The already-written
      // marker alone does not convert a known non-invocation into an unknown effect.
      this.cancelBinding(operation, binding, code); this.flushEvents();
      return { status: "settled", resultCode: code, result: resultFor(this.store, this.store.operation(operation.operationId)) };
    }
    return this.handleIntent(intent);
  }
  handleIntent(intent: ExecutionIntentRow): Promise<OperationResult> { return this.trackCall(() => this.executeIntent(intent)); }
  private async executeIntent(intent: ExecutionIntentRow): Promise<OperationResult> {
    const { operation, binding } = this.bindingFor(intent);
    const latest = this.execution.get(intent.id)!;
    if (latest.state !== "dispatching" || latest.claimOwnerId !== this.options.owner.ownerId || latest.claimOwnerGeneration !== this.options.owner.generation) throw new WorktreeError("WORKTREE_DISPATCH_MARKER_REQUIRED", "Worktree native work requires the original committed dispatch marker");
    this.revalidate(latest);
    if (binding.method === "worktree.resume") { this.assertResumeGate(operation, binding.gate!, binding.intentId); if (!await this.stopProof(operation, binding.intentId)) throw new WorktreeError("WORKTREE_PRODUCER_UNKNOWN", "Original worktree helpers are not verified stopped"); }
    const existing = this.running.get(operation.operationId); if (existing) return existing;
    const run = async (): Promise<OperationResult> => {
      this.executing.set(operation.operationId, binding);
      try {
        let inspection: WorktreeInspection | undefined;
        let next: WorktreeOperationRecord;
        if (binding.method === "worktree.reconcile") { inspection = await this.service.reconcile(operation.operationId, operation.actorId); next = this.store.operation(operation.operationId); }
        else if (binding.method === "worktree.resume") next = await this.service.resumeVerified(operation.operationId, binding.evidenceId!, operation.actorId);
        else next = await this.service.execute(operation.operationId);
        const response = resultFor(this.store, next, inspection);
        this.options.catalog.db.transaction(() => {
          if (next.state !== "pending" && next.state !== "running") this.settleOriginal(next);
          if (binding.method === "worktree.reconcile" || binding.method === "worktree.resume") this.settleBinding(next, binding, binding.method === "worktree.reconcile" ? "completed" : next.state === "outcome_unknown" ? "outcome_unknown" : next.state === "failed" ? "failed" : "completed", response);
        })();
        return { status: next.state === "outcome_unknown" && binding.method !== "worktree.reconcile" ? "outcome_unknown" : "settled", resultCode: publicErrorCode(next.errorCode ?? "WORKTREE_" + next.state.toUpperCase()), result: response };
      } catch (error) {
        const code = publicErrorCode(error instanceof Error && "code" in error ? error.code : undefined);
        const next = this.store.operation(operation.operationId);
        if (binding.commandId !== operation.commandId) this.options.catalog.db.transaction(() => this.settleBinding(next, binding, "outcome_unknown", resultFor(this.store, next)))();
        return { status: "outcome_unknown", resultCode: code, result: resultFor(this.store, next) };
      } finally { this.executing.delete(operation.operationId); this.flushEvents(); }
    };
    const execute = () => this.nativeContext.run(this.driverContext(operation, binding, binding.method === "worktree.reconcile"), run);
    const pending = (this.options.trackOperation ? this.options.trackOperation("producer", execute) : Promise.resolve().then(execute)).finally(() => { this.running.delete(operation.operationId); });
    this.running.set(operation.operationId, pending); return pending;
  }
  private writerContexts(operation: WorktreeOperationRecord, excludeIntentId?: string): DispatchContext[] {
    return [this.originalBinding(operation).dispatchContext, ...this.recoveryBindings(operation).filter((binding) => {
      const intent = this.execution.get(binding.intentId);
      return binding.method === "worktree.resume" && binding.intentId !== excludeIntentId && intent && ["dispatching", "acknowledged", "outcome_unknown", "settled"].includes(intent.state);
    }).map((binding) => binding.dispatchContext)];
  }
  private async stopProof(operation: WorktreeOperationRecord, excludedIntent = this.executing.get(operation.operationId)?.intentId): Promise<WorktreeProducerStopProof | undefined> {
    const contexts = this.writerContexts(operation, excludedIntent), original = contexts[0]!;
    const proof = await this.options.producerStopProof?.(operation, original, contexts.slice(1));
    return proof?.kind === "verified-worktree-stop" && proof.operationId === operation.operationId && proof.dispatchContextDigest === worktreeDispatchContextDigest(original)
      && proof.writerContextsDigest === worktreeWriterContextsDigest(contexts) && proof.sourceId && proof.contractId ? proof : undefined;
  }
  private async prepareResume(operation: WorktreeOperationRecord, evidenceId: string): Promise<ResumeGate> {
    this.assertWritable();
    if (this.running.has(operation.operationId)) throw new WorktreeError("WORKSPACE_BUSY", "Original worktree producer is still running");
    const evidence = this.store.inspection(evidenceId), proof = await this.stopProof(operation);
    if (operation.state !== "outcome_unknown" || !evidence.canResume || evidence.operationId !== operation.operationId || evidence.expiresAt <= this.store.now() || !proof) throw new WorktreeError("WORKTREE_PRODUCER_UNKNOWN", "Recovery needs current evidence that every original helper stopped");
    const queryBinding: CommandBinding = { ...this.originalBinding(operation), method: "worktree.reconcile", dispatchContext: this.newContext(operation.worktreeId, this.originalBinding(operation).sessionId) };
    const checked = await this.nativeContext.run(this.driverContext(operation, queryBinding, true), () => this.service.reconcile(operation.operationId, operation.actorId));
    const current = this.store.inspection(checked.evidenceId);
    if (!checked.canResume || current.observationsDigest !== evidence.observationsDigest) throw new WorktreeError("WORKTREE_EVIDENCE_STALE", "Original worktree recovery observations changed");
    return { evidenceId, observationsDigest: evidence.observationsDigest, originalContextDigest: proof.dispatchContextDigest, proof, expiresAt: evidence.expiresAt, revision: this.store.require(operation.worktreeId).revision };
  }
  private assertResumeGate(operation: WorktreeOperationRecord, gate: ResumeGate, excludeIntentId?: string): void {
    if (!gate || operation.state !== "outcome_unknown" || this.store.inspection(gate.evidenceId).operationId !== operation.operationId || gate.originalContextDigest !== worktreeDispatchContextDigest(this.originalBinding(operation).dispatchContext)
      || gate.proof.writerContextsDigest !== worktreeWriterContextsDigest(this.writerContexts(operation, excludeIntentId))
      || this.store.inspection(gate.evidenceId).observationsDigest !== gate.observationsDigest
      || gate.expiresAt <= this.store.now() || gate.revision !== this.store.require(operation.worktreeId).revision || gate.proof.operationId !== operation.operationId) throw new WorktreeError("WORKTREE_EVIDENCE_STALE", "Committed recovery gate changed before claim");
  }
  private boundWorkspace(record: ManagedWorktreeRecord): WorkspaceRecord {
    const current = this.options.workspaces.get(record.workspaceId);
    if (!current || current.kind !== "worktree" || current.repositoryId !== record.repositoryId || current.canonicalRoot !== record.path || current.worktreeRoot !== record.path) throw new WorktreeError("WORKTREE_CATALOG_MISMATCH", "Managed checkout does not match its registered Catalog workspace");
    return current;
  }
  private assertCheckoutIdle(workspaceId: string, operationId?: string): void {
    const workspace = this.options.workspaces.get(workspaceId);
    if (!workspace) { if (operationId && this.store.operation(operationId).kind === "create") return; throw new WorktreeError("WORKTREE_CATALOG_MISMATCH", "Managed workspace association is missing"); }
    const original = operationId ? this.originalBinding(this.store.operation(operationId)) : undefined;
    const continuation = operationId ? this.executing.get(operationId) : undefined;
    const prior = operationId ? this.recoveryBindings(this.store.operation(operationId)).filter((binding) => this.execution.get(binding.intentId)?.state === "outcome_unknown") : [];
    for (const other of this.options.catalog.workspaces().filter((record) => record.checkoutKey === workspace.checkoutKey)) {
      for (const session of this.options.catalog.allSessions({ workspaceId: other.workspaceId })) this.assertSourceIdle(session.sessionId, original, continuation, ...prior);
    }
  }
  private assertSourceIdle(sessionId: string, ...excluded: Array<CommandBinding | undefined>): void {
    const session = this.options.catalog.requireSession(sessionId); this.options.catalog.assertRecovered(sessionId);
    if (session.activityState !== "idle" || session.residency !== "unloaded" || this.options.sessions.loaded(sessionId) || this.options.catalog.store.getActiveTurn(sessionId) || this.options.catalog.runtimeCloseForSession(sessionId)) throw new WorktreeError("WORKSPACE_BUSY", "Registered checkout has an active or resident Session");
    const rows = this.options.catalog.db.prepare("SELECT id FROM execution_intents WHERE session_id=? AND state<>'settled'").all(sessionId) as Array<{ id: string }>;
    for (const row of rows) {
      const intent = this.execution.get(row.id)!;
      const own = excluded.some((binding) => binding?.intentId === intent.id && binding.actorId === intent.authSubjectId && binding.worktreeId === intent.resourceId && binding.sessionId === intent.sessionId && binding.method === intent.kind && intent.requestFormatVersion === 2 && binding.commandId === intent.commandId && binding.requestHash === intent.requestHash && intent.dispatchContext && worktreeDispatchContextDigest(binding.dispatchContext) === worktreeDispatchContextDigest(intent.dispatchContext));
      if (!own) throw new WorktreeError("WORKSPACE_BUSY", "Registered checkout has another pending or unverified writer");
    }
  }
  private settleOriginal(operation: WorktreeOperationRecord): void {
    const binding = this.originalBinding(operation);
    this.settleBinding(operation, binding, operation.state === "completed" ? "completed" : operation.state === "failed" ? "failed" : "outcome_unknown", resultFor(this.store, operation));
  }
  private settleBinding(operation: WorktreeOperationRecord, binding: CommandBinding, state: CommandReceiptRow["state"], response: WorktreeResult): void {
    const receipt = this.options.catalog.store.getCommandReceipt(operation.actorId, binding.commandId);
    if (!receipt) throw new WorktreeError("WORKTREE_RECEIPT_INVALID", "Original worktree receipt is missing");
    if (receipt.state === state && JSON.stringify(receipt.response) === JSON.stringify(response)) return;
    const committed = this.options.catalog.store.commitCommand({ sessionId: binding.sessionId, build: () => ({ result: undefined,
      events: [{ type: binding.method + "." + state, payload: response }],
      receiptUpdates: [{ authSubjectId: operation.actorId, commandId: binding.commandId, method: binding.method, requestHash: binding.requestHash, requestFormatVersion: 2, targetSessionId: binding.sessionId, state, response, required: true }],
    }) })!;
    this.events.set(committed.commitId!, committed.events);
  }
  private flushEvents(): void { if (this.options.catalog.db.inTransaction) throw new WorktreeError("WORKTREE_UNCOMMITTED", "Commit before delivering worktree events"); for (const [commitId, events] of this.events) {
      // A later nested Catalog callback can roll back the outer transaction.
      // Only a still-persisted event commit is eligible for after-commit delivery.
      if (this.options.catalog.db.prepare("SELECT 1 FROM event_commits WHERE id=?").get(commitId)) this.options.sessions.publishCommittedEvents(events);
    } this.events.clear(); }
  private assertDuplicate(receipt: CommandReceiptRow, method: WorktreeCommandMethod, hash: string, sessionId: string): void { assertReceiptRequest(receipt, { authSubjectId: receipt.authSubjectId, commandId: receipt.commandId, method, requestHash: hash, requestFormatVersion: 2, targetSessionId: sessionId }); }
  private response(receipt: CommandReceiptRow, reused: boolean): WorktreeCommandResult { return { ...parse(WorktreeResultSchema, receipt.response), commandId: receipt.commandId, receiptState: receipt.state, reused }; }
  private cancelBinding(operation: WorktreeOperationRecord, binding: CommandBinding, code: string): void {
    this.options.catalog.db.transaction(() => {
      if (binding.commandId === operation.commandId && operation.state === "pending") {
        const rejected = this.store.rejectBeforeCheckout(operation.operationId, code, (record, op) => this.publisher.publish(record, op));
        this.settleOriginal(rejected);
      } else this.settleBinding(operation, binding, "failed", resultFor(this.store, operation));
    })();
  }
  private cancelUndispatched(): void {
    const rows = this.options.catalog.db.prepare("SELECT id FROM execution_intents WHERE kind IN ('worktree.create','worktree.archive','worktree.restore','worktree.reconcile','worktree.resume') AND state IN ('pending','claimed')").all() as Array<{ id: string }>;
    for (const row of rows) {
      const intent = this.execution.get(row.id)!;
      if (intent.dispatchContext?.hostOwnerId !== this.options.owner.ownerId || intent.dispatchContext.hostOwnerGeneration !== this.options.owner.generation) continue;
      const { operation, binding } = this.bindingFor(intent);
      this.cancelBinding(operation, binding, "HOST_CLOSED_NOT_DISPATCHED");
    }
    this.flushEvents();
  }
  stopAdmission(): void { this.admission = false; }
  /** Stop the R06 scheduler first. This gate never infers descendant exit from a resolved Git promise. */
  async closeAndWait(deadlineMs = 5000): Promise<{ drained: boolean; producerStopped: boolean; clean: boolean; state: "stopped" | "recovery_required" }> {
    this.stopAdmission();
    const deadline = Date.now() + Math.max(0, deadlineMs);
    const stop = this.options.closeGit ? this.trackCall(() => this.options.closeGit!(Math.max(0, deadline - Date.now()))).catch(() => ({ producerStopped: false, clean: false })) : Promise.resolve({ producerStopped: false, clean: false });
    const drain = async () => { while (this.calls.size || this.running.size) await Promise.allSettled([...this.calls, ...this.running.values()]); return { drained: true, stop: await stop }; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = await Promise.race([drain(), new Promise<{ drained: boolean; stop: WorktreeDriverClose }>((resolve) => { timer = setTimeout(() => resolve({ drained: false, stop: { producerStopped: false, clean: false } }), Math.max(0, deadline - Date.now())); })]);
    if (timer) clearTimeout(timer);
    if (report.drained) this.cancelUndispatched();
    const unknown = Boolean(this.options.catalog.db.prepare("SELECT 1 FROM worktree_operations WHERE state IN ('running','outcome_unknown') LIMIT 1").get());
    const clean = report.drained && report.stop.producerStopped && report.stop.clean && !unknown;
    return { drained: report.drained, producerStopped: report.stop.producerStopped, clean, state: clean ? "stopped" : "recovery_required" };
  }
  /** Call after producer drain; this only seals journals, it never releases an unknown checkout lease. */
  seal(): void { if (this.running.size || this.calls.size) throw new WorktreeError("WORKTREE_PRODUCER_UNKNOWN", "Drain worktree producers before sealing SQL callbacks"); this.options.sealGitJournal?.(); this.sealed = true; this.stopAdmission(); }
}
export function createHostWorktrees(options: HostWorktreesOptions): HostWorktrees { return new HostWorktrees(options); }
