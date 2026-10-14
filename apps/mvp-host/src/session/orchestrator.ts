import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Bootstrap, SessionEvent, TimelineItem } from "@flyx/mvp-protocol";
import { HostViews, type HostViewsOptions, type ViewInteractionReader, type ViewResourceResolver } from "../timeline/host-views.js";
import { ProtocolVersion } from "@flyx/mvp-protocol";
import { checkpointSummary } from "../checkpoint/checkpoint-service.js";
import type { CheckpointContext, CheckpointManifest } from "../checkpoint/types.js";
import type { ExecutionCheckpointBinding } from "./execution-integrations.js";
import { ClaudeAdapter } from "../claude/adapter.js";
import { HostOwnerLock, assertHostOwner, assertWorkspacePrivacy, createTestHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { HostLifecycle } from "../lifecycle/host-lifecycle.js";
import { OperationRegistry, type OperationKind } from "../lifecycle/operation-registry.js";
import { HostManagedRuntime } from "../provider/native-runtime-factory.js";
import type { NativeBoundaryAssessment, prepareNativeExecutionBoundary } from "../lifecycle/native-execution-boundary.js";
import type { ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import { WorkspaceLease } from "../workspace/workspace-lease.js";
import { CodexAdapter } from "../codex/adapter.js";
import type { AdapterEvent, DispatchContext, ProviderAdapter, ProviderId } from "../provider/types.js";
import { dispatchContextForTurn } from "../provider/types.js";
import { GitService, type GitDiff, type GitStatus } from "../git/git-service.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn, decideApprovalReservation, decideInterrupt } from "../orchestration/decider.js";
import { ExecutionWorker, type ExecutionWorkerOptions, type OperationIntentHandler } from "../orchestration/execution-worker.js";
import { ProviderIngestion } from "../orchestration/provider-ingestion.js";
import { createHostRecovery, type HostRecovery, type HostRecoveryOptions } from "./host-recovery.js";
import { RuntimeRegistry } from "../provider/runtime-registry.js";
import type { CommandRequest, ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { HostInteractionHooks, InteractionRpcPort } from "../interaction/host-interactions.js";
import type { ProviderControlOutcome, ProviderOutcome } from "../provider/types.js";
import { ExecutionStore } from "../storage/execution-store.js";
import {
  SqliteStore,
  type ApprovalRow,
  type SessionRow,
  type Snapshot,
  type TurnRow,
} from "../storage/db.js";

export class OrchestratorError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export type SessionEventListener = (event: SessionEvent) => void;

export type StartTurnResponse = {
  turnId: string;
  status: "accepted";
};

export type ControlResponse = {
  status: string;
  approvalId?: string;
  turnId?: string;
};

export type OrchestratorOptions = {
  workspace: string;
  checkoutRoot?: string;
  sessionId?: string;
  ownsStore?: boolean;
  recoverOnStart?: boolean;
  databasePath?: string;
  provider?: ProviderId;
  adapter?: ProviderAdapter;
  executionHooks?: Pick<ExecutionWorkerOptions, "beforeDispatch" | "afterTerminal" | "stage" | "track">;
  revalidateDevice?: (intent: ExecutionIntentRow) => void;
  /** Verified preparer/producer tree exit, independent of business terminal evidence. */
  canReleaseWorkspace?: (context: DispatchContext) => boolean;
  checkpoints?: ExecutionCheckpointBinding;
  genericOperations?: Readonly<Record<string, OperationIntentHandler>>;
  /** Synchronous setup runs before startup recovery and dispatch scanning. */
  executionSetup?: (host: SessionOrchestrator) => void;
  /** Commits an R07 runtime gate without rewriting a known Provider terminal. */
  onExecutionBlocked?: (intent: ExecutionIntentRow, reason: string) => void;
  assertWriteReady?: () => void;
  recovery?: Pick<HostRecoveryOptions, "resolveResource" | "processInspector" | "inspectBoundary" | "inspectWorkspace" | "codexReader" | "supersedeInteractions" | "companionEvents">;
  runtimeId?: string;
  owner?: HostOwnerHandle;
  store?: SqliteStore;
  identityDirectory?: string;
  coordinationDirectory?: string;
  privateDirectories?: readonly string[];
  enableViews?: boolean;
  hostViews?: HostViews;
  resolveViewResource?: ViewResourceResolver;
  readViewInteractions?: ViewInteractionReader;
  interactionEvents?: HostInteractionHooks;
  assertViewSessionAccess?: HostViewsOptions["assertSessionAccess"];
  providerOptions?: { executable?: string; model?: string; environment?: Readonly<Record<string, string>> };
  nativeStateRoots?: readonly string[];
  nativeBoundaryFactory?: typeof prepareNativeExecutionBoundary;
  shutdownDeadlineMs?: number;
};

export type RuntimeCloseReport = { closed: boolean; producerStopped: boolean; clean: boolean; state: "stopped" | "recovery_required"; stopped: boolean; recoveryRequired: boolean };
export type ShutdownService = { drain(deadlineMs: number): Promise<void | boolean>; close?(): Promise<void> | void };

const MAX_PROMPT_BYTES = 16 * 1024;

export class SessionOrchestrator {
  readonly requestFormatVersions = [1, 2] as const;
  readonly store: SqliteStore;
  readonly views: HostViews | undefined = undefined;
  readonly ownsViews: boolean = false;
  readonly owner: HostOwnerHandle;
  readonly ownsStore: boolean;
  readonly recoverOnStart: boolean;
  readonly operations = new OperationRegistry();
  readonly lifecycle: HostLifecycle;
  private nativeRuntime: HostManagedRuntime | undefined;
  private closePromise: Promise<RuntimeCloseReport> | undefined;
  private producerStop: ProcessStopResult | undefined;
  private readonly shutdownServices = new Set<ShutdownService>();
  private readonly transportClosers = new Set<() => Promise<void>>();
  private activeWorkspaceLease: WorkspaceLease | undefined;
  private closed = false;
  readonly workspace: string;
  readonly checkoutRoot: string;
  readonly git: GitService;
  readonly adapter: ProviderAdapter;
  readonly commandEngine: CommandEngine;
  readonly execution: ExecutionStore;
  readonly worker: ExecutionWorker;
  readonly runtimes: RuntimeRegistry;
  readonly ingestion: ProviderIngestion;
  readonly recovery: HostRecovery;
  private readonly listeners = new Set<SessionEventListener>();
  private readonly interactionEvents: HostInteractionHooks | undefined;
  private commandTail: Promise<unknown> = Promise.resolve();
  private eventTail: Promise<void> = Promise.resolve();
  private readonly hostOwnerId: string;
  private readonly hostOwnerGeneration: number;
  readonly runtimeId: string;
  private readonly dispatchContexts = new Map<string, DispatchContext>();
  private readonly canReleaseWorkspace: (context: DispatchContext) => boolean;
  private readonly checkpointBinding: ExecutionCheckpointBinding | undefined;
  private readonly onExecutionBlocked: OrchestratorOptions["onExecutionBlocked"];
  private readonly capturedBefore = new Set<string>();
  private readonly checkWriteReady: OrchestratorOptions["assertWriteReady"];
  private degraded = false;
  private baselinePromise: Promise<void> | undefined;
  private readonly session: SessionRow;

  constructor(options: OrchestratorOptions) {
    this.interactionEvents = options.interactionEvents;
    this.canReleaseWorkspace = options.canReleaseWorkspace ?? ((context) => this.nativeRuntime?.canReleaseWorkspace(context) ?? false);
    this.ownsStore = options.ownsStore ?? true;
    this.recoverOnStart = options.recoverOnStart ?? true;
    if (!this.ownsStore && (!options.owner || !options.store || !options.sessionId)) throw new Error("A shared Session runtime requires explicit owner, Store and Session ID");
    if (!this.ownsStore && this.recoverOnStart) throw new Error("Shared Session runtimes cannot recover the Host on construction");
    this.checkpointBinding = options.checkpoints;
    this.onExecutionBlocked = options.onExecutionBlocked;
    this.checkWriteReady = options.assertWriteReady;
    const canonicalWorkspace = realpathSync(options.workspace);
    this.checkoutRoot = realpathSync(options.checkoutRoot ?? canonicalWorkspace);
    const provider = options.adapter?.provider ?? options.provider ?? "claude";
    const databasePath = options.databasePath ?? options.owner?.databasePath ?? ":memory:";
    if (options.store && !options.owner) throw new Error("An injected Store requires its verified owner handle");
    if (options.owner?.recoveryOnly) throw new Error("HOST_RECOVERY_ONLY");
    if (options.owner?.mode === "maintenance") throw new Error("HOST_MAINTENANCE_ONLY");
    this.owner = options.owner ?? (databasePath === ":memory:" ? createTestHostOwner() : HostOwnerLock.acquire({
      databasePath,
      ...(options.identityDirectory ? { identityDirectory: options.identityDirectory } : {}),
      ...(options.coordinationDirectory ? { coordinationDirectory: options.coordinationDirectory } : {}),
    }));
    let openedStore: SqliteStore | undefined;
    try {
      assertHostOwner(this.owner);
      this.owner.assertStorePath(databasePath);
      if (databasePath !== ":memory:") {
        assertWorkspacePrivacy(canonicalWorkspace, [dirname(this.owner.databasePath),
          ...(this.owner.identityDirectory ? [this.owner.identityDirectory] : []),
          ...(this.owner.coordinationDirectory ? [this.owner.coordinationDirectory] : []),
          ...(options.privateDirectories ?? [])]);
        assertWorkspacePrivacy(this.checkoutRoot, [dirname(this.owner.databasePath),
          ...(this.owner.identityDirectory ? [this.owner.identityDirectory] : []),
          ...(this.owner.coordinationDirectory ? [this.owner.coordinationDirectory] : []),
          ...(options.privateDirectories ?? [])]);
        mkdirSync(dirname(this.owner.databasePath), { recursive: true, mode: 0o700 });
      }
      this.store = openedStore = options.store ?? openOwned({ databasePath, owner: this.owner });
      this.owner.assertStorePath(this.store.db.name);
      const existingSession = options.sessionId ? this.store.getSession(options.sessionId) : this.store.getCurrentSession();
      if (options.sessionId && !existingSession) throw new OrchestratorError("SESSION_NOT_FOUND", "Selected Session does not exist");
      if (existingSession?.status === "archived") throw new OrchestratorError("SESSION_ARCHIVED", "Selected Session is archived");
      if (!this.ownsStore && existingSession?.recoveryState === "blocked") throw new OrchestratorError("RECOVERY_BLOCKED", "Selected Session requires recovery before loading");
      if (existingSession && existingSession.workspacePath !== canonicalWorkspace) {
        throw new OrchestratorError("WORKSPACE_MISMATCH", "Persisted session belongs to a different configured workspace");
      }
      if (existingSession && existingSession.provider !== provider) {
        throw new OrchestratorError(
          "PROVIDER_MISMATCH",
          `Persisted session uses ${existingSession.provider}; configure a separate FLYX_DB before switching to ${provider}`,
        );
      }
      this.workspace = canonicalWorkspace;
      this.session = existingSession ?? this.store.createSession(canonicalWorkspace, provider);
      this.hostOwnerId = this.owner.ownerId;
      this.hostOwnerGeneration = this.owner.generation;
      this.runtimeId = options.runtimeId ?? `${provider}:${this.session.id}`;
      if (options.hostViews) {
        if (options.hostViews.store !== this.store || options.hostViews.owner !== this.owner) throw new OrchestratorError("HOST_VIEWS_MISMATCH", "Shared Host views require the same Store and owner");
        this.views = options.hostViews;
      } else if (HostViews.isAvailable(this.store)) {
        this.ownsViews = true;
        this.views = new HostViews(this.store, this.owner, {
          enabled: options.enableViews ?? true,
          ...(options.assertViewSessionAccess ? { assertSessionAccess: options.assertViewSessionAccess } : {}),
          resolveResource: options.resolveViewResource ?? ((id) => id === this.session.id ? {
            sessionId: id, workspace: canonicalWorkspace, source: this, readSnapshot: () => this.publicSnapshot(),
            ...(options.readViewInteractions ? { readInteractions: (after?: string) => options.readViewInteractions!(id, after) } : {}),
          } : undefined),
        });
        this.views.prepareStoredSessions();
      }
      this.execution = new ExecutionStore(this.store);
      this.commandEngine = new CommandEngine(this.store, {
        publish: (event) => this.notify(event),
        wake: () => this.worker?.wake(),
        admission: (request) => {
          this.owner.assertActive(); this.assertWriteReady();
          const device = this.store.getDevice(request.authSubjectId);
          if (!device && this.owner.mode !== "test") throw new OrchestratorError("DEVICE_REVOKED", "Device is no longer authorized");
          if (device?.revokedAt || (device?.expiresAt && device.expiresAt <= new Date().toISOString())) {
            throw new OrchestratorError("DEVICE_REVOKED", "Device is no longer authorized");
          }
          const scope = ["approval.respond", "interaction.respondApproval", "question.respond"].includes(request.method) ? "approval:write" : "session:write";
          if (device && !device.scopes.includes(scope)) throw new OrchestratorError("SCOPE_REQUIRED", "Device cannot perform this command");
        },
      });
      this.git = new GitService(this.checkoutRoot);
      if (!options.adapter) this.nativeRuntime = new HostManagedRuntime({ store: this.store, owner: this.owner, sessionId: this.session.id, runtimeId: this.runtimeId, workspace: canonicalWorkspace, provider,
        ...(options.privateDirectories ? { privateRoots: options.privateDirectories } : {}), ...(options.nativeStateRoots ? { nativeStateRoots: options.nativeStateRoots } : {}), ...(options.nativeBoundaryFactory ? { boundaryFactory: options.nativeBoundaryFactory } : {}) });
      const nativeOptions = { ...options.providerOptions, ...this.nativeRuntime?.options, workspace: canonicalWorkspace, onEvent: (event: AdapterEvent) => this.enqueueAdapterEvent(event) };
      this.adapter = options.adapter ?? (provider === "codex" ? new CodexAdapter(nativeOptions) : new ClaudeAdapter(nativeOptions));
    } catch (error) {
      // The Store is only assigned after ownership has been proven. A second
      // Host therefore cannot reach migration, recovery, or provider creation.
      if (this.ownsViews) this.views?.close();
      if (this.ownsStore) { openedStore?.close(); this.owner.release(); }
      throw error;
    }
    this.runtimes = new RuntimeRegistry({ drainIngestion: () => this.ingestion.drain() });
    this.runtimes.register(this.runtimeId, this.adapter);
    this.recovery = createHostRecovery({ store: this.store, owner: this.owner, sessionId: this.session.id, workspace: this.workspace,
      provider: this.session.provider, ...options.recovery, canReleaseWorkspace: this.canReleaseWorkspace,
      onCommit: (events) => events.forEach((event) => this.notify(event)),
      onBlocked: (context) => { this.runtimes.retainBinding(context); this.activeWorkspaceLease?.retain("producer_stop_unverified"); this.owner.retain("producer_stop_unverified"); },
      reconcileRuntime: (context, native) => {
        if (!this.runtimes.matches(context)) return;
        if (native.state === "not_dispatched") {
          const evidence = { kind: "not-dispatched" as const };
          this.runtimes.reconcileVerified(context, native.status === "cancelled" ? { status: "cancelled", evidence } : { status: "failed", error: "Original user operation was not dispatched", evidence });
          return;
        }
        const evidence = { kind: "native-terminal" as const, sourceId: native.evidence.sourceId };
        this.runtimes.reconcileVerified(context, native.status === "completed" ? { status: "completed", providerSessionId: native.nativeSessionId, evidence }
          : native.status === "cancelled" ? { status: "cancelled", providerSessionId: native.nativeSessionId, evidence }
          : { status: "failed", providerSessionId: native.nativeSessionId, error: native.error ?? "Original native Turn failed", evidence });
      },
      reconcileStoppedRuntime: (context, evidence) => {
        if (this.runtimes.matches(context)) this.runtimes.reconcileStopped(context, evidence);
      },
      afterRecovery: (operation, evidenceId) => this.releaseRecoveredOwnership(operation, evidenceId),
    });
    this.ingestion = new ProviderIngestion({
      admit: (event) => this.admitAdapterEvent(event),
      handle: (event) => this.handleAdapterEvent(event),
      observed: (event) => this.runtimes.observe(event),
      failed: (error) => this.recordIngestionFailure(error),
      track: (run) => this.worker.track("ingestion", run),
    });
    this.worker = new ExecutionWorker(this.execution, this.runtimes, {
      owner: { id: this.hostOwnerId, generation: this.hostOwnerGeneration }, sessionId: this.session.id,
      ...options.executionHooks,
      beforeDispatch: async (intent, context) => {
        if (intent.kind === "start_turn" && this.checkpointBinding) await this.captureBefore(intent, context);
        if (this.worker.isSealed) return;
        await options.executionHooks?.beforeDispatch?.(intent, context);
      },
      afterTerminal: (intent, outcome) => this.finalizeTurn(intent, outcome, options.executionHooks?.afterTerminal),
      assertWriteReady: () => this.assertWriteReady(),
      track: (kind, run) => this.operations.track(kind, () => options.executionHooks?.track ? options.executionHooks.track(kind, run) : run()),
      revalidateDevice: (intent) => { this.revalidateIntentDevice(intent); return options.revalidateDevice?.(intent); },
      onDispatch: (intent, context) => {
        if (intent.turnId) this.dispatchContexts.set(intent.turnId, context);
        if (intent.kind === "start_turn") {
          const state = this.store.getTurn(intent.turnId!)?.status === "interrupting" ? "interrupting" : "running";
          this.commit("turn.started", { turnId: intent.turnId }, { activityState: state, turnId: intent.turnId!, turnStatus: state });
        }
      },
      onStartOutcome: (intent, outcome) => this.settleTurn(intent, outcome),
      onControlResult: (intent, outcome) => this.settleControl(intent, outcome),
      drainIngestion: () => this.ingestion.drain(),
      failed: (error, intent) => {
        if (this.closed || !this.store.db.open) return;
        if (intent?.dispatchContext && intent.turnId && ["completed", "failed", "cancelled"].includes(this.store.getTurn(intent.turnId)?.status ?? "")) {
          this.markExecutionBlocked(intent, "after_terminal_operation_unverified");
          options.onExecutionBlocked?.(intent, "after_terminal_operation_unverified");
        }
        if (error instanceof Error && !/^(DEVICE_|SCOPE_|PRE_DISPATCH_|DISPATCH_)/.test(error.message)) this.degraded = true;
      },
    });
    this.lifecycle = new HostLifecycle({
      stopAdmission: () => { this.closed = true; this.worker.stopAdmission(); },
      stopDispatch: () => this.worker.stopDispatch(),
      stopProducers: (deadline) => this.stopProducers(deadline),
      drainIngestion: async () => { await this.ingestion.drain(); return true; },
      drainOperations: async (deadline) => {
        const worker = await this.worker.drainOperations(deadline);
        const registered = await this.operations.drain(["producer", "control", "ingestion", "checkpoint"], deadline);
        return worker && registered;
      },
      drainServices: async (deadline) => { await this.checkpointBinding?.service.drain?.(); for (const service of this.shutdownServices) if (await service.drain(deadline) === false) return false; return true; },
      fenceCallbacks: () => { this.ingestion.seal(); this.worker.seal(); this.operations.seal(); if (this.ownsStore) this.checkpointBinding?.service.seal?.(); },
      recordUnknown: (reason) => this.recordShutdownUnknown(reason),
      retainOwnership: (reason) => { this.activeWorkspaceLease?.retain(reason); this.owner.retain(reason); },
      closeTransports: async () => { for (const close of this.transportClosers) await close(); for (const service of this.shutdownServices) await service.close?.(); if (this.ownsViews) this.views?.close(); await this.nativeRuntime?.disposeBoundary(); },
      sealJournal: () => { this.adapter.sealCallbacks?.(); this.adapter.sealProcessJournal?.(); this.nativeRuntime?.sealJournals(); },
      closeStore: () => { if (this.ownsStore) this.store.close(); },
      releaseOwnership: () => { if (this.ownsStore && !this.owner.retainedReason) this.owner.release(); },
    }, options.shutdownDeadlineMs);
    this.lifecycle.markReady(!this.nativeRuntime);
    for (const [kind, handler] of Object.entries(options.genericOperations ?? {})) this.worker.registerOperation(kind, handler);
    const configured = options.executionSetup?.(this) as unknown;
    if (configured && typeof (configured as { then?: unknown }).then === "function") {
      void Promise.resolve(configured).catch(() => undefined);
      throw new Error("EXECUTION_SETUP_MUST_BE_SYNCHRONOUS");
    }
    if (this.recoverOnStart) {
      // Native dispatch phases decide recovery before any pending intent can run.
      this.worker.start();
      const legacy = this.store.getActiveTurn(this.session.id);
      if (legacy && this.execution.list({ sessionId: this.session.id }).every((intent) => intent.turnId !== legacy.id)) this.store.recoverActiveTurns({ sessionId: this.session.id, legacyOnly: true });
    }
  }

  get workspaceLease(): WorkspaceLease | undefined { return this.activeWorkspaceLease; }
  get interactionRpcPort(): InteractionRpcPort | undefined { return this.interactionEvents?.rpcPort(); }

  /** Created only at acceptance; old pending intents never receive a new fence. */
  operationContext(resourceId: string, attemptId: string, runtimeGeneration: number): DispatchContext {
    this.owner.assertActive();
    return dispatchContextForTurn(resourceId, { hostOwnerId: this.hostOwnerId, hostOwnerGeneration: this.hostOwnerGeneration,
      sessionId: this.session.id, flyxTurnId: resourceId, runtimeId: this.runtimeId, runtimeGeneration, attemptId });
  }

  close(): void { void this.closeAndWait().catch(() => {}); }
  closeAndWait(deadlineMs?: number): Promise<RuntimeCloseReport> {
    this.closePromise ??= this.lifecycle.shutdown(deadlineMs).then((result) => ({ ...result, closed: true, producerStopped: !!this.producerStop?.treeStopped, clean: result.stopped && !result.recoveryRequired && (!this.ownsStore || !this.owner.retainedReason),
      state: result.stopped && !result.recoveryRequired && (!this.ownsStore || !this.owner.retainedReason) ? "stopped" as const : "recovery_required" as const }));
    return this.closePromise;
  }
  registerShutdownService(service: ShutdownService): () => void { this.shutdownServices.add(service); return () => this.shutdownServices.delete(service); }
  registerTransportShutdown(close: () => Promise<void>): () => void { this.transportClosers.add(close); return () => this.transportClosers.delete(close); }
  trackOperation<T>(kind: OperationKind, run: () => Promise<T>): Promise<T> {
    if (this.closed && kind === "producer") return Promise.reject(new OrchestratorError("HOST_DRAINING", "Host is draining", true));
    return this.operations.track(kind, run);
  }
  markProviderUnavailable(): void { this.lifecycle.markReady(false); }
  async prepareNativeRuntime(): Promise<NativeBoundaryAssessment | undefined> {
    if (!this.nativeRuntime) return undefined;
    const assessment = await this.nativeRuntime.prepare();
    this.lifecycle.markReady(assessment.ready);
    return assessment;
  }
  private async stopProducers(deadlineMs: number): Promise<{ stopped: boolean }> {
    const active = this.store.getActiveTurn(this.session.id) !== undefined || this.runtimes.isBusy(this.runtimeId);
    if (active) void this.worker.track("control", async () => { await this.adapter.interrupt("host_shutdown"); }).catch(() => {});
    const adapterStopping = this.worker.track("control", async () => {
      if (this.adapter.closeAndWait) return this.adapter.closeAndWait(deadlineMs);
      this.adapter.close?.(); return { stopped: !active, treeStopped: !active, records: [] };
    });
    const managedStopping = this.nativeRuntime?.closeAndWait(deadlineMs);
    const [adapter, managed] = await Promise.all([adapterStopping, managedStopping]);
    this.producerStop = { stopped: adapter.stopped && (managed?.stopped ?? true), treeStopped: adapter.treeStopped && (managed?.treeStopped ?? true), records: managed?.records ?? adapter.records };
    return { stopped: this.producerStop.stopped && this.producerStop.treeStopped };
  }
  private recordShutdownUnknown(reason: string): void {
    if (!this.store.db.open) return;
    const active = this.store.getActiveTurn(this.session.id);
    const contextTurn = this.producerStop?.records.find((record) => record.flyxTurnId && this.store.getTurn(record.flyxTurnId))?.flyxTurnId;
    const turnId = active?.id ?? contextTurn;
    const event = this.store.db.transaction(() => {
      const receipt = active ? this.receiptUpdateForTurn(active.id, "outcome_unknown", { turnId: active.id, status: "outcome_unknown", reason }) : undefined;
      const pending = this.execution.list({ sessionId: this.session.id }).filter((intent) => ["claimed", "dispatching", "acknowledged"].includes(intent.state));
      const event = this.store.commitEvent(this.session.id, "host.shutdown.unknown", { reason, ...(turnId ? { turnId } : {}) }, {
        activityState: "outcome_unknown", ...(active ? { turnId: active.id, turnStatus: "outcome_unknown" } : {}), ...(receipt ? { commandReceipt: receipt } : {}),
        executionIntentUpdates: pending.filter((intent) => !(active && intent.turnId === active.id && intent.kind === "start_turn")).map((intent) => ({ id: intent.id, expectedStates: [intent.state], state: "outcome_unknown" as const, resultCode: reason, result: { reason } })),
      });
      this.store.db.prepare("UPDATE sessions SET recovery_state = 'blocked', recovery_revision = recovery_revision + 1, active_turn_id = COALESCE(active_turn_id, ?) WHERE id = ?").run(turnId ?? null, this.session.id);
      return event;
    })();
    this.notify(event);
  }

  get sessionId(): string {
    return this.session.id;
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Internal publication of facts already committed by shared feature services. */
  publishCommittedEvent(event: SessionEvent): void {
    this.owner.assertActive();
    if (event.sessionId !== this.session.id) throw new OrchestratorError("RESOURCE_SCOPE_MISMATCH", "Committed event belongs to another Session");
    this.notify(event);
  }

  bootstrap(): Bootstrap {
    return {
      protocolVersion: ProtocolVersion,
      provider: this.session.provider,
      capabilities: {
        streamingText: true,
        structuredToolCalls: true,
        interactiveApprovals: true,
        resumeConversation: true,
        interrupt: true,
        gitDiff: true,
        sandboxRequired: true,
        timelineProjection: this.views?.ready(this.session.id) ?? false,
        boundedContent: Boolean(this.views),
      },
    };
  }

  snapshot(): Snapshot {
    const snapshot = this.store.getSnapshot(this.session.id);
    if (!snapshot) throw new OrchestratorError("SESSION_NOT_FOUND", "Current session does not exist");
    return snapshot;
  }

  publicSnapshot(): Omit<Snapshot, "session" | "activeTurn"> & {
    session: Omit<SessionRow, "workspacePath" | "createdAt" | "updatedAt" | "providerSessionId" | "baselineHead" | "baselineDirty" | "baselineStatus" | "baselineCapturedAt">;
    activeTurn?: Omit<TurnRow, "authSubjectId" | "providerSessionId" | "attemptId" | "nativeTurnId">;
  } {
    const snapshot = this.snapshot();
    const {
      workspacePath: _workspacePath,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      providerSessionId: _providerSessionId,
      baselineHead: _baselineHead,
      baselineDirty: _baselineDirty,
      baselineStatus: _baselineStatus,
      baselineCapturedAt: _baselineCapturedAt,
      ...session
    } = snapshot.session;
    if (!snapshot.activeTurn) return { session, pendingApprovals: snapshot.pendingApprovals };
    const { authSubjectId: _authSubjectId, providerSessionId: _turnProviderSessionId, attemptId: _attemptId, nativeTurnId: _nativeTurnId, ...activeTurn } = snapshot.activeTurn;
    return { session, activeTurn, pendingApprovals: snapshot.pendingApprovals };
  }

  timeline(after = 0, limit = 200, upTo?: number): ReturnType<SqliteStore["listEvents"]> {
    return this.store.listEvents(this.session.id, after, Math.min(Math.max(limit, 1), 200), upTo);
  }

  timelineItems(): TimelineItem[] {
    return this.store.listTimeline(this.session.id);
  }

  async gitStatus(): Promise<GitStatus> {
    await this.ensureBaseline();
    return this.git.status();
  }

  async gitDiff(): Promise<GitDiff> {
    await this.ensureBaseline();
    const baseline = this.store.getSessionBaseline(this.session.id);
    const diff = await this.git.diff(baseline?.head);
    return {
      ...diff,
      ...(baseline?.head ? { baselineHead: baseline.head } : {}),
      ...(baseline ? { baselineDirty: baseline.dirty } : {}),
      ...(baseline?.dirty ? { baselineWarning: "Workspace had uncommitted changes before this Session; Diff includes the pre-existing baseline." } : {}),
    };
  }

  async providerStatus(): Promise<Awaited<ReturnType<ProviderAdapter["status"]>>> {
    return this.adapter.status();
  }

  startTurn(authSubjectId: string, commandId: string, prompt: string, targetRequest?: CommandRequest): Promise<StartTurnResponse> {
    return this.enqueueCommand(async () => {
      if (!commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "Every write command needs commandId");
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        throw new OrchestratorError("PROMPT_TOO_LARGE", "Prompt exceeds 16 KiB");
      }
      const method = "session.startTurn";
      const request = this.commandRequest(authSubjectId, commandId, method, { prompt }, targetRequest);
      if (this.store.getCommandReceipt(authSubjectId, commandId)) {
        return this.commandEngine.commitRequest<StartTurnResponse>(request, () => { throw new Error("RECEIPT_DISAPPEARED"); }).result;
      }
      if (this.degraded) throw new OrchestratorError("HOST_DEGRADED", "Host event persistence is degraded; restart the Host before starting a new Turn", true);
      this.recovery.assertAdmission();
      const current = this.snapshot();
      if (current.session.activityState !== "idle" || current.activeTurn) {
        throw new OrchestratorError("TURN_BUSY", "The current session already has an active turn", true);
      }
      if (this.activeWorkspaceLease) throw new OrchestratorError("WORKSPACE_BUSY", "Checkout ownership remains retained", true);
      const leaseOperationId = randomUUID();
      let lease: WorkspaceLease;
      try { lease = WorkspaceLease.acquire({ workspace: this.checkoutRoot, owner: this.owner, operationId: leaseOperationId }); }
      catch (error) { throw new OrchestratorError("WORKSPACE_BUSY", error instanceof Error ? error.message : "Workspace is owned by another write task", true); }
      this.activeWorkspaceLease = lease;
      try {
        await this.ensureBaseline();
        const accepted = this.commandEngine.commitRequest(request, (facts, clock) => {
          this.assertWritable(); this.worker.assertAdmission("start_turn");
          this.recovery.assertAdmission();
          return decideAcceptTurn(facts, request, { prompt, turnId: leaseOperationId }, clock);
        });
        if (accepted.reused) { lease.release(); this.activeWorkspaceLease = undefined; return accepted.result; }
        return accepted.result;
      } catch (error) {
        lease.release();
        if (this.activeWorkspaceLease === lease) this.activeWorkspaceLease = undefined;
        throw error;
      }
    });
  }

  interrupt(authSubjectId: string, commandId: string, targetRequest?: CommandRequest): Promise<ControlResponse> {
    return this.enqueueCommand(async () => {
      const request = this.commandRequest(authSubjectId, commandId, "session.interrupt", {}, targetRequest);
      return this.commandEngine.commitRequest(request, (facts, clock) => {
        this.assertWritable(); this.recovery.assertAdmission(); this.worker.assertAdmission("control");
        return decideInterrupt(facts, request, clock);
      }).result;
    });
  }

  respondApproval(authSubjectId: string, commandId: string, approvalId: string, action: "allow_once" | "deny", targetRequest?: CommandRequest): Promise<ControlResponse> {
    return this.enqueueCommand(async () => {
      const request = this.commandRequest(authSubjectId, commandId, "approval.respond", { approvalId, action }, targetRequest);
      if (this.interactionEvents) {
        try { return this.interactionEvents.respondLegacyApproval(authSubjectId, commandId, approvalId, action, request); }
        catch (error) { if (!(error instanceof Error) || error.message !== "INTERACTIONS_UNAVAILABLE") throw error; }
      }
      return this.commandEngine.commitRequest(request, (facts, clock) => {
        this.assertWritable(); this.recovery.assertAdmission(); this.worker.assertAdmission("control");
        return decideApprovalReservation(facts, request, { approvalId, action }, clock);
      }, { approvalId }).result;
    });
  }

  private commandRequest(authSubjectId: string, commandId: string, method: string, payload: unknown, targetRequest?: CommandRequest): CommandRequest {
    if (targetRequest && (targetRequest.authSubjectId !== authSubjectId || targetRequest.commandId !== commandId || targetRequest.method !== method
      || targetRequest.targetSessionId !== this.session.id || !targetRequest.requestHash
      || ![1, 2].includes(targetRequest.requestFormatVersion ?? 1))) throw new OrchestratorError("COMMAND_SCOPE_MISMATCH", "Command does not belong to this actor/resource");
    return { authSubjectId, commandId, method, requestHash: targetRequest?.requestHash ?? hashRequest(method, payload), requestFormatVersion: targetRequest?.requestFormatVersion ?? 1,
      targetSessionId: this.session.id, actorKind: !this.store.getDevice(authSubjectId) && this.owner.mode === "test" ? "host" : "device",
      dispatchBinding: { hostOwnerId: this.hostOwnerId, hostOwnerGeneration: this.hostOwnerGeneration, runtimeId: this.runtimeId } };
  }
  private revalidateIntentDevice(intent: ExecutionIntentRow): void {
    this.owner.assertActive();
    if (intent.actorKind !== "device") return;
    const device = this.store.getDevice(intent.authSubjectId);
    if (!device || device.revokedAt || (device.expiresAt && device.expiresAt <= new Date().toISOString())) throw new Error("DEVICE_REVOKED");
    const scope = intent.kind.startsWith("respond_") ? "approval:write" : "session:write";
    if (!device.scopes.includes(scope)) throw new Error("SCOPE_REQUIRED");
  }
  private settleTurn(intent: ExecutionIntentRow, outcome: ProviderOutcome): void {
    const turn = intent.turnId ? this.store.getTurn(intent.turnId) : undefined;
    if (!turn) throw new Error("TURN_NOT_FOUND");
    const latest = this.store.getTurn(turn.id);
    const finalResponse = { turnId: turn.id, ...outcome };
    const receiptUpdate = this.receiptUpdateForTurn(turn.id, outcomeToReceiptState(outcome.status), finalResponse);
    if (latest && ["queued", "running", "waiting_approval", "interrupting"].includes(latest.status)) {
      const terminal = outcome.status;
      const controls = this.controlReceiptUpdatesForTurn(turn.id, terminal);
      this.commit("turn.reconciled", { turnId: turn.id, outcome }, {
        activityState: terminal === "outcome_unknown" ? "outcome_unknown" : "idle", turnId: turn.id, turnStatus: terminal,
        ...(receiptUpdate ? { commandReceipt: receiptUpdate } : {}), ...(controls.length ? { commandReceipts: controls } : {}),
        ...(terminal === "failed" || terminal === "outcome_unknown" ? { timeline: { itemId: `error-${turn.id}`, kind: "error" as const,
          status: terminal, content: { turnId: turn.id, message: "error" in outcome ? outcome.error : "Provider outcome is unknown" } } } : {}),
      });
    } else if (this.store.getCommandReceipt(intent.authSubjectId, intent.commandId)?.state === "accepted" && receiptUpdate) {
      this.commit("turn.receipt.reconciled", { turnId: turn.id, outcome }, { commandReceipt: receiptUpdate });
    }
    if (outcome.evidence.kind === "unknown") this.activeWorkspaceLease?.retain("turn_outcome_unverified");
  }
  private checkpointContext(intent: ExecutionIntentRow, dispatch: DispatchContext, lease: WorkspaceLease): CheckpointContext & { turnId: string; attemptId: string } {
    if (!this.checkpointBinding) throw new Error("CHECKPOINT_SERVICE_UNAVAILABLE");
    lease.assertActive();
    const context = this.checkpointBinding.contextFor(intent, dispatch, lease);
    const session = this.store.getSession(this.session.id)!;
    if (context.sessionId !== dispatch.sessionId || context.turnId !== dispatch.flyxTurnId || context.attemptId !== dispatch.attemptId
      || context.workspaceId !== session.workspaceId || context.runtimeGeneration !== dispatch.runtimeGeneration
      || context.sessionRevision !== session.revision || !context.epoch || context.lease.workspaceId !== context.workspaceId
      || context.lease.leaseId !== lease.operationId || context.lease.generation !== this.owner.generation) throw new Error("CHECKPOINT_BINDING_MISMATCH");
    return context;
  }
  private async captureBefore(intent: ExecutionIntentRow, context: DispatchContext): Promise<void> {
    const lease = this.activeWorkspaceLease;
    if (!lease) throw new Error("WORKSPACE_LEASE_REQUIRED");
    const manifest = await this.worker.track("checkpoint", () => this.checkpointBinding!.service.captureBefore(this.checkpointContext(intent, context, lease)));
    if (this.worker.isSealed) return;
    this.assertCheckpointManifest(intent, manifest, "before");
    this.capturedBefore.add(intent.id);
    this.commit("checkpoint.captured", checkpointSummary(manifest));
  }
  private assertCheckpointManifest(intent: ExecutionIntentRow, manifest: CheckpointManifest, phase: "before" | "after"): void {
    if (manifest.sessionId !== intent.sessionId || manifest.turnId !== intent.turnId || manifest.attemptId !== intent.attemptId
      || manifest.runtimeGeneration !== intent.runtimeGeneration || manifest.phase !== phase || manifest.status === "capturing") throw new Error("CHECKPOINT_BINDING_MISMATCH");
  }
  private retainExecution(intent: ExecutionIntentRow, reason: string): void {
    this.activeWorkspaceLease?.retain(reason); this.owner.retain(reason);
    if (intent.dispatchContext) this.runtimes.retainBinding(intent.dispatchContext);
    this.markExecutionBlocked(intent, reason);
    const blocked = this.onExecutionBlocked?.(intent, reason) as unknown;
    if (blocked && typeof (blocked as { then?: unknown }).then === "function") {
      void Promise.resolve(blocked).catch(() => undefined);
      throw new Error("EXECUTION_BLOCK_COMMIT_MUST_BE_SYNCHRONOUS");
    }
  }
  private async finalizeTurn(intent: ExecutionIntentRow, outcome: ProviderOutcome, hook: ExecutionWorkerOptions["afterTerminal"]): Promise<void> {
    if (this.worker.isSealed) return;
    const context = intent.dispatchContext; const lease = this.activeWorkspaceLease;
    if (!lease) { if (intent.turnId) this.dispatchContexts.delete(intent.turnId); return; }
    try {
      if (!context || !this.canReleaseWorkspace(context)) { this.retainExecution(intent, "producer_stop_unverified"); return; }
      lease.assertActive();
      const terminal = this.store.getTurn(intent.turnId!);
      if (!terminal || !["completed", "failed", "cancelled"].includes(terminal.status)) throw new Error("TERMINAL_COMMIT_UNPROVEN");
      if (this.checkpointBinding && this.capturedBefore.has(intent.id)) {
        const source = this.store.db.prepare(`SELECT sequence FROM session_events WHERE session_id = ?
          AND type IN ('turn.completed','turn.failed','turn.cancelled','turn.reconciled')
          AND json_extract(payload_json,'$.turnId') = ? ORDER BY sequence DESC LIMIT 1`).get(intent.sessionId, intent.turnId) as { sequence: number } | undefined;
        if (!source) throw new Error("TERMINAL_COMMIT_UNPROVEN");
        const capture = this.checkpointContext(intent, context, lease);
        const manifest = await this.worker.track("checkpoint", () => this.checkpointBinding!.service.captureAfter({ ...capture,
          evidence: { producerStopped: true, terminalCommitted: true, terminalSequence: source.sequence } }));
        if (this.worker.isSealed) return;
        this.assertCheckpointManifest(intent, manifest, "after");
        this.commit("checkpoint.captured", checkpointSummary(manifest));
      }
      await hook?.(intent, outcome);
      if (this.worker.isSealed) return;
      if (!this.canReleaseWorkspace(context)) { this.retainExecution(intent, "producer_stop_unverified"); return; }
      if (this.store.getSession(intent.sessionId)?.recoveryState === "blocked") { this.retainExecution(intent, "runtime_recovery_required"); return; }
      if (this.degraded) { this.retainExecution(intent, "terminal_commit_unverified"); return; }
      lease.assertActive(); lease.release();
      if (this.activeWorkspaceLease === lease) this.activeWorkspaceLease = undefined;
      if (intent.turnId) this.dispatchContexts.delete(intent.turnId);
      this.capturedBefore.delete(intent.id);
    } catch (error) {
      if (this.worker.isSealed) return;
      this.degraded = true;
      this.retainExecution(intent, "checkpoint_completion_unverified");
      throw error;
    }
  }

  private settleControl(intent: ExecutionIntentRow, outcome: ProviderControlOutcome): void {
    if (this.store.getCommandReceipt(intent.authSubjectId, intent.commandId)?.state !== "accepted") return;
    const payload = isRecord(intent.payload) ? intent.payload : {};
    const turn = intent.turnId ? this.store.getTurn(intent.turnId) : undefined;
    const alreadyTerminal = turn && ["completed", "failed", "cancelled"].includes(turn.status);
    const unknown = outcome.evidence.kind === "unknown" && !alreadyTerminal;
    const deliveryState = outcome.evidence.kind === "native-ack" ? "native_confirmation" : "local_delivery";
    const receipt = { authSubjectId: intent.authSubjectId, commandId: intent.commandId, requestHash: intent.requestHash, required: true };
    if (unknown) {
      const response = { status: "outcome_unknown", ...(intent.turnId ? { turnId: intent.turnId } : {}), evidence: outcome.evidence };
      const start = intent.turnId ? this.receiptUpdateForTurn(intent.turnId, "outcome_unknown", response) : undefined;
      this.commit("execution.control.unknown", { intentId: intent.id, ...response }, {
        ...(intent.turnId ? { activityState: "outcome_unknown", turnId: intent.turnId, turnStatus: "outcome_unknown" } : {}),
        commandReceipt: { ...receipt, state: "outcome_unknown", response }, ...(start ? { commandReceipts: [start] } : {}),
        ...(intent.kind === "respond_approval" && typeof payload.approvalId === "string" ? { approvalDelivery: {
          approvalId: payload.approvalId, authSubjectId: intent.authSubjectId, commandId: intent.commandId, state: "outcome_unknown" } } : {}),
      });
      if (intent.dispatchContext) this.runtimes.retainUnknown(intent.dispatchContext);
      return;
    }
    if (intent.kind === "respond_approval" && outcome.status === "delivered" && typeof payload.approvalId === "string") {
      const approval = this.store.getApproval(payload.approvalId);
      if (!approval) throw new Error("APPROVAL_NOT_FOUND");
      const response = { status: "delivered", approvalId: approval.approvalId, deliveryState, evidence: outcome.evidence };
      const content = { ...approval.request, approvalId: approval.approvalId, action: payload.action, status: "delivered", deliveryState };
      const options = { commandReceipt: { ...receipt, state: "completed" as const, response }, approvalDelivery: {
        approvalId: approval.approvalId, authSubjectId: intent.authSubjectId, commandId: intent.commandId, state: deliveryState as "native_confirmation" | "local_delivery" },
        timeline: { itemId: `approval-${approval.approvalId}`, kind: "approval" as const, status: "delivered", content } };
      if (approval.status === "pending") {
        const result = this.store.resolveApprovalAndCommit({ approvalId: approval.approvalId, expectedVersion: approval.version, action: String(payload.action),
          event: { sessionId: this.session.id, type: "approval.resolved", build: (resolved, pending) => ({ payload: { ...content, itemId: `approval-${approval.approvalId}` }, options: {
            ...options, activityState: pending.some((value) => value.turnId === resolved.turnId) ? "waiting_approval" : "running", turnId: resolved.turnId,
            turnStatus: pending.some((value) => value.turnId === resolved.turnId) ? "waiting_approval" : "running",
          } }) } });
        if (!result) throw new Error("INTERACTION_DELIVERY_UNSETTLED");
        this.notify(result.event);
      } else this.commit("approval.delivery.recorded", { ...response, turnId: intent.turnId }, options);
      return;
    }
    const response = { status: alreadyTerminal || outcome.status === "already_terminal" ? "already_terminal"
      : outcome.status === "not_dispatched" ? "not_dispatched" : "accepted", ...(intent.turnId ? { turnId: intent.turnId } : {}), evidence: outcome.evidence };
    this.commit("execution.control.delivered", { intentId: intent.id, ...response }, { commandReceipt: { ...receipt,
      state: outcome.status === "not_dispatched" ? "failed" : alreadyTerminal || outcome.status === "already_terminal" ? "completed" : "accepted", response } });
  }

  /**
   * Public entry point for an injected adapter (e.g. the deterministic test
   * adapter) to feed provider events through the same durable pipeline the
   * built-in provider adapters use.
   */
  ingestAdapterEvent(event: AdapterEvent): void {
    this.enqueueAdapterEvent(event);
  }

  private admitAdapterEvent(event: AdapterEvent): boolean {
    const context = event.dispatchContext;
    return !!context && !!this.dispatchContexts.get(context.flyxTurnId)
      && sameDispatchContext(this.dispatchContexts.get(context.flyxTurnId)!, context)
      && event.turnId === context.flyxTurnId && event.generation === context.runtimeGeneration;
  }
  private enqueueAdapterEvent(event: AdapterEvent): void { this.eventTail = this.ingestion.enqueue(event); }
  private recordIngestionFailure(error: unknown): void {
    this.degraded = true;
    const active = this.store.getActiveTurn(this.session.id);
    if (active) {
      const context = this.dispatchContexts.get(active.id);
      if (context) this.runtimes.retainUnknown(context);
      const receipt = this.receiptUpdateForTurn(active.id, "outcome_unknown", { turnId: active.id, status: "outcome_unknown", reason: "event_persist_failed" });
      try { this.commit("host.event_persist_failed", { turnId: active.id }, { activityState: "outcome_unknown", turnId: active.id, turnStatus: "outcome_unknown",
        ...(receipt ? { commandReceipt: receipt } : {}) }); } catch { /* Ownership gate is retained by the lifecycle when the Store fails. */ }
    }
    const stop = this.worker.track("control", async () => { await this.adapter.interrupt("event_persist_failed"); });
    void stop.catch(() => { this.degraded = true; });
  }

  private async handleAdapterEvent(event: AdapterEvent): Promise<void> {
    const context = event.dispatchContext;
    if (!context || event.turnId !== context.flyxTurnId || event.generation !== context.runtimeGeneration) return;
    const expected = this.dispatchContexts.get(context.flyxTurnId);
    if (!expected || !sameDispatchContext(expected, context)) return;
    const target = this.store.getTurn(context.flyxTurnId);
    const current = this.store.getActiveTurn(this.session.id);
    if (!target || target.sessionId !== context.sessionId || target.generation !== context.runtimeGeneration
      || current?.id !== target.id || ["completed", "failed", "cancelled", "outcome_unknown"].includes(target.status)) return;
    if ((event.kind === "approval_requested" || event.kind === "question_requested") && event.request.turnId !== target.id) return;
    if (event.kind === "approval_resolved" && this.store.getApproval(event.approvalId)?.turnId !== target.id) return;
    if (this.interactionEvents?.handle(event)) return;
    const resolvedTurnId = target.id;
    // Native Item IDs can be reused by a resumed runtime. Keep separate
    // projections per Flyx Turn while preserving the source ID for recovery.
    if ("itemId" in event) event = { ...event, nativeItemId: event.itemId, itemId: `provider-${target.id}-${event.itemId}` };
    switch (event.kind) {
      case "session_init":
        this.recovery.recordNativeEvent(event);
        this.commit("provider.session.init", event, { turnId: target.id, turnStatus: target.status, providerSessionId: event.providerSessionId, timeline: { itemId: `system-session-${target.id}`, kind: "system", status: "info", content: { message: `${providerDisplayName(event.provider)} session initialized`, provider: event.provider, providerSessionId: event.providerSessionId, model: event.model, runtimeVersion: event.runtimeVersion } } });
        return;
      case "native_binding":
        this.recovery.recordNativeEvent(event);
        this.commit("provider.turn.bound", event, { turnId: target.id, turnStatus: target.status, providerSessionId: event.nativeSessionId });
        return;
      case "assistant_delta": {
        const text = this.mergeText(resolvedTurnId, event.itemId, event.text);
        this.commit("assistant.message.delta", { ...event, turnId: resolvedTurnId }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "assistant_message", status: "streaming", content: { turnId: resolvedTurnId, itemId: event.itemId, text } } });
        return;
      }
      case "assistant_message":
        this.commit("assistant.message.completed", { ...event, turnId: resolvedTurnId }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "assistant_message", status: event.aborted ? "aborted" : "completed", content: { turnId: resolvedTurnId, itemId: event.itemId, text: event.text, ...(event.aborted ? { aborted: true } : {}) } } });
        return;
      case "tool_started":
        this.commit("tool.call.started", { ...event, turnId: resolvedTurnId }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "tool_call", status: "running", content: { turnId: resolvedTurnId, toolUseId: event.toolUseId, toolName: event.toolName, input: event.input } } });
        return;
      case "tool_progress": {
        const item = this.store.getTimelineItem(this.session.id, event.itemId);
        this.commit("tool.call.progress", { ...event, turnId: resolvedTurnId }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "tool_call", status: "running", content: { ...(isRecord(item?.content) ? item.content : {}), output: event.output } } });
        return;
      }
      case "tool_completed": {
        const item = this.store.getTimelineItem(this.session.id, event.itemId);
        this.commit("tool.call.completed", { ...event, turnId: resolvedTurnId }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "tool_call", status: event.error ? "failed" : "completed", content: { ...(isRecord(item?.content) ? item.content : {}), ...(event.output ? { output: event.output } : {}), ...(event.error ? { error: event.error } : {}) } } });
        return;
      }
      case "approval_requested": {
        const request = event.request;
        // SDK callbacks can be delivered more than once around an abort or
        // reconnect.  Never let a late duplicate move a resolved approval or
        // Turn back to waiting_approval.
        if (this.store.getApproval(request.approvalId)) return;
        const approval: ApprovalRow = { approvalId: request.approvalId, sessionId: this.session.id, turnId: request.turnId, toolUseId: request.toolUseId, version: 0, status: "pending", request, createdAt: request.createdAt };
        this.commit("approval.requested", { ...event, ...request, itemId: `approval-${request.approvalId}`, status: "pending" }, { activityState: "waiting_approval", turnId: request.turnId, turnStatus: "waiting_approval", approval, timeline: { itemId: `approval-${request.approvalId}`, kind: "approval", status: "pending", content: { ...request, status: "pending" } } });
        return;
      }
      case "approval_resolved": {
        const approval = this.store.getApproval(event.approvalId);
        if (!approval || approval.status !== "pending") return;
        const committed = this.store.resolveApprovalAndCommit({
          approvalId: event.approvalId,
          expectedVersion: approval.version,
          action: event.action,
          event: {
            sessionId: this.session.id,
            type: "approval.resolved",
            build: (resolved, pending) => {
              const stillPending = pending.some((item) => item.approvalId !== event.approvalId && item.turnId === resolved.turnId);
              const status = event.action === "allow_once" || event.action === "deny" ? "resolved" : event.action;
              const content = { ...resolved.request, approvalId: event.approvalId, status, action: event.action };
              return {
                payload: { ...content, ...event, turnId: resolvedTurnId, itemId: `approval-${event.approvalId}` },
                options: {
                  activityState: stillPending ? "waiting_approval" : "running",
                  turnId: resolved.turnId,
                  turnStatus: stillPending ? "waiting_approval" : "running",
                  timeline: { itemId: `approval-${event.approvalId}`, kind: "approval", status, content },
                },
              };
            },
          },
        });
        if (committed) this.notify(committed.event);
        return;
      }
      case "diagnostic": {
        const itemId = `diagnostic-${randomUUID()}`;
        this.commit("diagnostic", { ...event, itemId }, { timeline: { itemId, kind: "system", status: "diagnostic", content: event } });
        return;
      }
      case "turn_completed": {
        const controlReceipts = this.controlReceiptUpdatesForTurn(resolvedTurnId, "completed");
        this.commit("turn.completed", { ...event, turnId: resolvedTurnId, itemId: `result-${resolvedTurnId}` }, {
          activityState: "idle",
          turnId: resolvedTurnId,
          turnStatus: "completed",
          ...(this.receiptUpdateForTurn(resolvedTurnId, "completed", {
            turnId: resolvedTurnId,
            status: "completed",
            result: event.result,
            costUsd: event.costUsd,
            numTurns: event.numTurns,
          }) ? { commandReceipt: this.receiptUpdateForTurn(resolvedTurnId, "completed", {
            turnId: resolvedTurnId,
            status: "completed",
            result: event.result,
            costUsd: event.costUsd,
            numTurns: event.numTurns,
          }) } : {}),
          ...(controlReceipts.length ? { commandReceipts: controlReceipts } : {}),
          timeline: { itemId: `result-${resolvedTurnId}`, kind: "system", status: "completed", content: { message: event.result, costUsd: event.costUsd, numTurns: event.numTurns } },
        });
        return;
      }
      case "turn_failed": {
        const controlReceipts = this.controlReceiptUpdatesForTurn(resolvedTurnId, "failed");
        this.commit("turn.failed", { ...event, turnId: resolvedTurnId, itemId: `error-${resolvedTurnId}` }, {
          activityState: "idle",
          turnId: resolvedTurnId,
          turnStatus: "failed",
          ...(this.receiptUpdateForTurn(resolvedTurnId, "failed", {
            turnId: resolvedTurnId,
            status: "failed",
            error: event.errors.join("; ") || event.subtype,
            subtype: event.subtype,
          }) ? { commandReceipt: this.receiptUpdateForTurn(resolvedTurnId, "failed", {
            turnId: resolvedTurnId,
            status: "failed",
            error: event.errors.join("; ") || event.subtype,
            subtype: event.subtype,
          }) } : {}),
          ...(controlReceipts.length ? { commandReceipts: controlReceipts } : {}),
          timeline: { itemId: `error-${resolvedTurnId}`, kind: "error", status: "failed", content: { errors: event.errors, subtype: event.subtype } },
        });
        return;
      }
      case "turn_cancelled": {
        const controlReceipts = this.controlReceiptUpdatesForTurn(resolvedTurnId, "cancelled");
        this.commit("turn.cancelled", { ...event, turnId: resolvedTurnId, itemId: `result-${resolvedTurnId}` }, {
          activityState: "idle",
          turnId: resolvedTurnId,
          turnStatus: "cancelled",
          ...(this.receiptUpdateForTurn(resolvedTurnId, "cancelled", { turnId: resolvedTurnId, status: "cancelled", reason: event.reason })
            ? { commandReceipt: this.receiptUpdateForTurn(resolvedTurnId, "cancelled", { turnId: resolvedTurnId, status: "cancelled", reason: event.reason }) }
            : {}),
          ...(controlReceipts.length ? { commandReceipts: controlReceipts } : {}),
          timeline: { itemId: `result-${resolvedTurnId}`, kind: "system", status: "cancelled", content: { message: "Turn cancelled", reason: event.reason } },
        });
        return;
      }
    }
  }

  private commit(type: string, payload: unknown, options: Parameters<SqliteStore["commitEvent"]>[3] = {}): SessionEvent {
    this.owner.assertActive();
    const context = options.turnId ? this.dispatchContexts.get(options.turnId)
      ?? this.recovery.recovery.target(this.session.id, options.turnId).context : undefined;
    let blocked = false;
    const published: SessionEvent[] = [];
    const event = this.store.db.transaction(() => {
      if (context && options.turnStatus && ["completed", "failed", "cancelled"].includes(options.turnStatus)) blocked = this.recovery.protectTerminal(context);
      const terminal = options.turnId && options.turnStatus && ["completed", "failed", "cancelled", "outcome_unknown"].includes(options.turnStatus);
      const committed = this.store.commitCommand({ sessionId: this.session.id, build: () => ({ result: undefined,
        events: [ ...(terminal ? this.interactionEvents?.companionEvents(this.session.id, options.turnId!, type) ?? [] : []),
          { type, payload, options: blocked ? { ...options, activityState: "outcome_unknown" } : options } ],
      }) })!;
      published.push(...committed.events);
      if (context && (blocked || options.turnStatus === "outcome_unknown")) {
        const session = this.store.getSession(this.session.id)!;
        published.push(this.store.commitEvent(this.session.id, "session.recovery.blocked", { turnId: context.flyxTurnId,
          attemptId: context.attemptId, recoveryRevision: session.recoveryRevision, reason: blocked ? "producer_stop_unverified" : "turn_outcome_unknown" }));
      }
      return committed.events.at(-1)!;
    })();
    for (const committed of published) this.notify(committed);
    if (context && blocked) this.recovery.retained(context);
    return event;
  }

  /** A capture/cleanup failure blocks execution without changing a known business result. */
  markExecutionBlocked(intent: ExecutionIntentRow, reason: string): void {
    if (this.closed || !this.store.db.open) return;
    const context = intent.dispatchContext;
    if (!context || !intent.turnId || context.flyxTurnId !== intent.turnId || context.sessionId !== this.session.id
      || context.hostOwnerId !== this.owner.ownerId || context.hostOwnerGeneration !== this.owner.generation || !this.runtimes.matches(context)) return;
    this.owner.assertActive();
    const publicReason = /^[a-zA-Z0-9_]{1,128}$/.test(reason) ? reason : "execution_cleanup_unverified";
    let event: SessionEvent | undefined;
    let matched = false;
    this.store.db.transaction(() => {
      const target = this.recovery.recovery.target(context.sessionId, context.flyxTurnId, context.attemptId);
      const currentGeneration = (this.store.db.prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM turns WHERE session_id=?")
        .get(context.sessionId) as { generation: number }).generation;
      if (target.turn.generation !== context.runtimeGeneration || currentGeneration !== context.runtimeGeneration || target.context && !sameDispatchContext(target.context, context)
        || target.session.activeTurnId && target.session.activeTurnId !== target.turn.id) return;
      matched = true;
      const latest = this.store.db.prepare("SELECT payload_json FROM session_events WHERE session_id=? AND type='session.recovery.blocked' ORDER BY sequence DESC LIMIT 1")
        .get(this.session.id) as { payload_json: string } | undefined;
      const previous = latest ? JSON.parse(latest.payload_json) as { turnId?: string; attemptId?: string; reason?: string } : undefined;
      if (target.session.recoveryState === "blocked" && previous?.turnId === context.flyxTurnId && previous.attemptId === context.attemptId && previous.reason === publicReason) return;
      this.store.db.prepare("UPDATE sessions SET active_turn_id=?, recovery_state='blocked', activity_state='outcome_unknown', recovery_revision=recovery_revision+1 WHERE id=?")
        .run(context.flyxTurnId, context.sessionId);
      const current = this.store.getSession(context.sessionId)!;
      event = this.store.commitEvent(context.sessionId, "session.recovery.blocked", { turnId: context.flyxTurnId, attemptId: context.attemptId,
        reason: publicReason, recoveryRevision: current.recoveryRevision });
    })();
    if (!matched) return;
    if (event) this.notify(event);
    this.runtimes.retainBinding(context);
    this.recovery.retained(context);
  }

  private releaseRecoveredOwnership(operation: import("@flyx/mvp-protocol").RecoveryOperation, evidenceId: string): void {
    if (operation.gate !== "released") return;
    try {
      if (this.activeWorkspaceLease) {
        const proof = this.recovery.recovery.releaseProof(evidenceId, [this.activeWorkspaceLease.resourceKey]);
        if (!proof) throw new Error("RECOVERY_RELEASE_PROOF_INVALID");
        this.activeWorkspaceLease.clearRetention(proof, this.recovery.recovery.verifyReleaseProof);
        this.activeWorkspaceLease.release(); this.activeWorkspaceLease = undefined;
      }
      if (this.owner.retainedReason) {
        const proof = this.recovery.recovery.releaseProof(evidenceId, this.owner.resourceKeys);
        if (!proof) throw new Error("RECOVERY_RELEASE_PROOF_INVALID");
        this.owner.clearRetention(proof, this.recovery.recovery.verifyReleaseProof);
      }
    } catch {
      // An unlock failure must remain a durable admission gate as well as a file lock.
      let marker: SessionEvent | undefined;
      this.store.db.transaction(() => {
        const changed = this.store.db.prepare(`UPDATE sessions SET recovery_state='blocked', activity_state='outcome_unknown',
          active_turn_id=?, recovery_revision=recovery_revision+1 WHERE id=? AND active_turn_id IS NULL AND recovery_revision=?`)
          .run(operation.turnId, operation.sessionId, operation.recoveryRevision);
        if (changed.changes) marker = this.store.commitEvent(operation.sessionId, "session.recovery.blocked", { turnId: operation.turnId, reason: "retained_resource_release_unverified",
          recoveryRevision: operation.recoveryRevision + 1 });
      })();
      if (marker) {
        this.notify(marker);
        const original = this.recovery.recovery.target(operation.sessionId, operation.turnId, operation.attemptId).context;
        if (original) this.recovery.retained(original);
      }
      throw new OrchestratorError("RECOVERY_RELEASE_PROOF_INVALID", "Recovered execution remains blocked until retained ownership is verified");
    }
  }

  /**
   * Resolve the owner of a Turn's start command from the durable row.  The
   * resulting receipt update is passed into the terminal event transaction;
   * callers must not update the receipt in a follow-up transaction.
   */
  private receiptUpdateForTurn(
    turnId: string,
    state: "completed" | "failed" | "cancelled" | "outcome_unknown",
    response: unknown,
  ): NonNullable<Parameters<SqliteStore["commitEvent"]>[3]>["commandReceipt"] {
    const turn = this.store.getTurn(turnId);
    if (!turn?.authSubjectId) return undefined;
    return {
      authSubjectId: turn.authSubjectId,
      commandId: turn.commandId,
      requestHash: turn.requestHash,
      state,
      response,
      required: true,
    };
  }

  private controlReceiptUpdatesForTurn(
    turnId: string,
    turnStatus: "completed" | "failed" | "cancelled" | "outcome_unknown",
  ): NonNullable<NonNullable<Parameters<SqliteStore["commitEvent"]>[3]>["commandReceipts"]> {
    return this.store.listAcceptedReceiptsForTurn(turnId).map((receipt) => ({
      authSubjectId: receipt.authSubjectId,
      commandId: receipt.commandId,
      requestHash: receipt.requestHash,
      state: turnStatus === "outcome_unknown" ? "outcome_unknown" : "completed",
      response: turnStatus === "outcome_unknown"
        ? { status: "outcome_unknown", turnId, reason: "turn_outcome_unknown" }
        : { status: "completed", turnId, turnStatus },
      required: true,
    }));
  }

  private notify(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* A disconnected client cannot break the sequencer. */ }
    }
  }

  private mergeText(_turnId: string, itemId: string, delta: string): string {
    const existing = this.store.getTimelineItem(this.session.id, itemId);
    const current = isRecord(existing?.content) && typeof existing.content.text === "string" ? existing.content.text : "";
    return current + delta;
  }

  private enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operations.track("control", () => this.commandTail.then(() => {
      if (this.closed) throw new OrchestratorError("HOST_DRAINING", "Host is closed to new commands", true);
      this.owner.assertActive();
      return fn();
    })).catch((error: unknown) => {
      if (error instanceof OrchestratorError) throw error;
      if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) {
        throw new OrchestratorError(error.message, error.message, error.message === "TURN_BUSY" || error.message === "SESSION_REVISION_CONFLICT");
      }
      this.degraded = true;
      throw error;
    });
    this.commandTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private ensureBaseline(): Promise<void> {
    if (this.store.getSessionBaseline(this.session.id)) return Promise.resolve();
    if (!this.baselinePromise) {
      this.baselinePromise = this.git.status().then((status) => {
        this.owner.assertActive();
        this.store.setSessionBaseline(this.session.id, { ...(status.head ? { head: status.head } : {}), dirty: status.dirty, files: status.files });
      }).catch((error) => {
        this.baselinePromise = undefined;
        throw error;
      });
    }
    return this.baselinePromise;
  }

  private assertWriteReady(): void {
    const readiness = this.checkWriteReady?.() as unknown;
    if (readiness && typeof (readiness as { then?: unknown }).then === "function") {
      void Promise.resolve(readiness).catch(() => undefined);
      throw new Error("RESTORE_GATE_INVALID");
    }
  }

  private assertWritable(): void {
    this.assertWriteReady();
    this.lifecycle.assertWritable();
    if (this.degraded) throw new OrchestratorError("HOST_DEGRADED", "Host event persistence is degraded; restart the Host before accepting commands", true);
  }


}

const hashRequest = hashCommandRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outcomeToReceiptState(status: string): "completed" | "failed" | "cancelled" | "outcome_unknown" {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "outcome_unknown") return "outcome_unknown";
  return "failed";
}

function providerDisplayName(provider: ProviderId): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function sameDispatchContext(expected: DispatchContext, actual: DispatchContext): boolean {
  return expected.hostOwnerId === actual.hostOwnerId
    && expected.hostOwnerGeneration === actual.hostOwnerGeneration
    && expected.sessionId === actual.sessionId
    && expected.flyxTurnId === actual.flyxTurnId
    && expected.runtimeId === actual.runtimeId
    && expected.runtimeGeneration === actual.runtimeGeneration
    && expected.attemptId === actual.attemptId;
}
