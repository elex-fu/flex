import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Bootstrap, SessionEvent, TimelineItem } from "@flyx/mvp-protocol";
import { ProtocolVersion } from "@flyx/mvp-protocol";
import { ClaudeAdapter } from "../claude/adapter.js";
import { HostOwnerLock, assertHostOwner, assertWorkspacePrivacy, createTestHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { WorkspaceLease } from "../workspace/workspace-lease.js";
import { CodexAdapter } from "../codex/adapter.js";
import type { AdapterEvent, DispatchContext, ProviderAdapter, ProviderId } from "../provider/types.js";
import { dispatchContextForTurn } from "../provider/types.js";
import { GitService, type GitDiff, type GitStatus } from "../git/git-service.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn, decideApprovalReservation, decideInterrupt } from "../orchestration/decider.js";
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
  databasePath?: string;
  provider?: ProviderId;
  adapter?: ProviderAdapter;
  runtimeId?: string;
  owner?: HostOwnerHandle;
  store?: SqliteStore;
  identityDirectory?: string;
  coordinationDirectory?: string;
  privateDirectories?: readonly string[];
};

const MAX_PROMPT_BYTES = 16 * 1024;

export class SessionOrchestrator {
  readonly store: SqliteStore;
  readonly owner: HostOwnerHandle;
  private activeWorkspaceLease: WorkspaceLease | undefined;
  private closed = false;
  readonly workspace: string;
  readonly git: GitService;
  readonly adapter: ProviderAdapter;
  readonly commandEngine: CommandEngine;
  readonly execution: ExecutionStore;
  private readonly listeners = new Set<SessionEventListener>();
  private commandTail: Promise<unknown> = Promise.resolve();
  private eventTail: Promise<void> = Promise.resolve();
  private readonly hostOwnerId: string;
  private readonly hostOwnerGeneration: number;
  private readonly runtimeId: string;
  private readonly dispatchContexts = new Map<string, DispatchContext>();
  private degraded = false;
  private baselinePromise: Promise<void> | undefined;
  private readonly session: SessionRow;

  constructor(options: OrchestratorOptions) {
    const canonicalWorkspace = realpathSync(options.workspace);
    const provider = options.adapter?.provider ?? options.provider ?? "claude";
    const databasePath = options.databasePath ?? options.owner?.databasePath ?? ":memory:";
    if (options.store && !options.owner) throw new Error("An injected Store requires its verified owner handle");
    if (options.owner?.recoveryOnly) throw new Error("HOST_RECOVERY_ONLY");
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
        mkdirSync(dirname(this.owner.databasePath), { recursive: true, mode: 0o700 });
      }
      this.store = openedStore = options.store ?? openOwned({ databasePath, owner: this.owner });
      this.owner.assertStorePath(this.store.db.name);
      const existingSession = this.store.getCurrentSession();
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
      this.store.recoverActiveTurns();
      this.execution = new ExecutionStore(this.store);
      this.commandEngine = new CommandEngine(this.store, {
        publish: (event) => this.notify(event),
        admission: (request) => {
          this.owner.assertActive();
          const device = this.store.getDevice(request.authSubjectId);
          if (device?.revokedAt || (device?.expiresAt && device.expiresAt <= new Date().toISOString())) {
            throw new OrchestratorError("DEVICE_REVOKED", "Device is no longer authorized");
          }
          const scope = request.method === "approval.respond" ? "approval:write" : "session:write";
          if (device && !device.scopes.includes(scope)) throw new OrchestratorError("SCOPE_REQUIRED", "Device cannot perform this command");
        },
      });
      this.git = new GitService(canonicalWorkspace);
      this.adapter = options.adapter ?? (provider === "codex"
        ? new CodexAdapter({ workspace: canonicalWorkspace, onEvent: (event) => this.enqueueAdapterEvent(event) })
        : new ClaudeAdapter({ workspace: canonicalWorkspace, onEvent: (event) => this.enqueueAdapterEvent(event) }));
    } catch (error) {
      // The Store is only assigned after ownership has been proven. A second
      // Host therefore cannot reach migration, recovery, or provider creation.
      openedStore?.close();
      this.owner.release();
      throw error;
    }
  }

  get workspaceLease(): WorkspaceLease | undefined { return this.activeWorkspaceLease; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.adapter.close?.();
    const active = this.store.getActiveTurn(this.session.id);
    if (active || this.activeWorkspaceLease) {
      // R04's async drain will release after proving the producer stopped.
      this.activeWorkspaceLease?.retain("producer_stop_unverified");
      this.owner.retain("producer_stop_unverified");
    }
    this.store.close();
    if (!this.owner.retainedReason) this.owner.release();
  }

  get sessionId(): string {
    return this.session.id;
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  startTurn(authSubjectId: string, commandId: string, prompt: string): Promise<StartTurnResponse> {
    return this.enqueueCommand(async () => {
      if (!commandId) throw new OrchestratorError("COMMAND_ID_REQUIRED", "Every write command needs commandId");
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        throw new OrchestratorError("PROMPT_TOO_LARGE", "Prompt exceeds 16 KiB");
      }
      const method = "session.startTurn";
      const requestHash = hashRequest(method, { prompt });
      const request = { authSubjectId, commandId, method, requestHash, requestFormatVersion: 1 as const, targetSessionId: this.session.id };
      if (this.store.getCommandReceipt(authSubjectId, commandId)) {
        return this.commandEngine.commitRequest<StartTurnResponse>(request, () => { throw new Error("RECEIPT_DISAPPEARED"); }).result;
      }
      if (this.degraded) throw new OrchestratorError("HOST_DEGRADED", "Host event persistence is degraded; restart the Host before starting a new Turn", true);
      const current = this.snapshot();
      if (current.session.activityState !== "idle" || current.activeTurn) {
        throw new OrchestratorError("TURN_BUSY", "The current session already has an active turn", true);
      }
      const leaseOperationId = randomUUID();
      let lease: WorkspaceLease;
      try { lease = WorkspaceLease.acquire({ workspace: this.workspace, owner: this.owner, operationId: leaseOperationId }); }
      catch (error) { throw new OrchestratorError("WORKSPACE_BUSY", error instanceof Error ? error.message : "Workspace is owned by another write task", true); }
      this.activeWorkspaceLease = lease;
      try {
        await this.ensureBaseline();
        const accepted = this.commandEngine.commitRequest(request, (facts, clock) => {
          this.assertWritable();
          return decideAcceptTurn(facts, request, { prompt }, clock);
        });
        if (accepted.reused) { lease.release(); this.activeWorkspaceLease = undefined; return accepted.result; }
        const turn = this.store.getTurn(accepted.result.turnId)!;
        void this.executeTurn(turn, authSubjectId, accepted.intents[0]!.id).finally(() => {
          const latest = this.store.db.open ? this.store.getTurn(turn.id) : undefined;
          if (!this.degraded && latest && ["completed", "failed", "cancelled"].includes(latest.status)) {
            lease.release();
            if (this.activeWorkspaceLease === lease) this.activeWorkspaceLease = undefined;
          } else {
            lease.retain("turn_outcome_unverified");
          }
        }).catch(() => { this.degraded = true; });
        return accepted.result;
      } catch (error) {
        lease.release();
        if (this.activeWorkspaceLease === lease) this.activeWorkspaceLease = undefined;
        throw error;
      }
    });
  }

  interrupt(authSubjectId: string, commandId: string): Promise<ControlResponse> {
    return this.enqueueCommand(async () => {
      const method = "session.interrupt";
      const requestHash = hashRequest(method, {});
      const committed = this.commandEngine.commitRequest({ authSubjectId, commandId, method, requestHash,
        requestFormatVersion: 1, targetSessionId: this.session.id }, (facts, clock) => {
        this.assertWritable();
        return decideInterrupt(facts, { authSubjectId, commandId, method, requestHash,
          requestFormatVersion: 1, targetSessionId: this.session.id }, clock);
      });
      const response = committed.result;
      if (committed.reused || response.status !== "accepted" || !response.turnId) return response;
      const current = this.store.getTurn(response.turnId)!;
      await this.resolvePendingApprovalsAsAborted(current);
      if (!this.prepareControlIntent(committed.intents[0]!.id)) {
        return this.store.getCommandReceipt(authSubjectId, commandId)!.response as ControlResponse;
      }
      const result = await this.adapter.interrupt("user_interrupt");
      if (result === "already_terminal") {
        const terminal = { status: "already_terminal", turnId: current.id } satisfies ControlResponse;
        this.commit("turn.interrupt.settled", { turnId: current.id, commandId, status: "already_terminal" }, {
          commandReceipt: { authSubjectId, commandId, state: "completed", response: terminal, requestHash, required: true },
        });
        return terminal;
      }
      if (result === "unavailable") {
        const failed = { status: "outcome_unknown", turnId: current.id } satisfies ControlResponse;
        const turnReceipt = this.receiptUpdateForTurn(current.id, "outcome_unknown", {
          turnId: current.id,
          status: "outcome_unknown",
          reason: "interrupt_unavailable",
        });
        this.commit("turn.interrupt.unavailable", { turnId: current.id }, {
          activityState: "outcome_unknown",
          turnId: current.id,
          turnStatus: "outcome_unknown",
          commandReceipt: { authSubjectId, commandId, state: "outcome_unknown", response: failed, requestHash, required: true },
          ...(turnReceipt ? { commandReceipts: [turnReceipt] } : {}),
          timeline: { itemId: `error-${randomUUID()}`, kind: "error", status: "error", content: { message: `${providerDisplayName(this.session.provider)} interrupt could not be confirmed` } },
        });
        return failed;
      }
      return response;
    });
  }

  respondApproval(authSubjectId: string, commandId: string, approvalId: string, action: "allow_once" | "deny"): Promise<ControlResponse> {
    return this.enqueueCommand(async () => {
      const method = "approval.respond";
      const request = { approvalId, action };
      const requestHash = hashRequest(method, request);
      const committed = this.commandEngine.commitRequest({ authSubjectId, commandId, method, requestHash,
        requestFormatVersion: 1, targetSessionId: this.session.id }, (facts, clock) => {
        this.assertWritable();
        return decideApprovalReservation(facts, { authSubjectId, commandId, method, requestHash,
          requestFormatVersion: 1, targetSessionId: this.session.id }, { approvalId, action }, clock);
      }, { approvalId });
      if (committed.reused) return committed.result;
      const approval = this.store.getApproval(approvalId)!;
      const intentId = committed.intents[0]!.id;
      if (!this.prepareControlIntent(intentId)) return this.store.getCommandReceipt(authSubjectId, commandId)!.response as ControlResponse;
      let delivered = false;
      try { delivered = this.adapter.respondApproval(approvalId, action); } catch { /* Native outcome is unproven. */ }
      if (!delivered) {
        const unavailable = { status: "outcome_unknown", approvalId } satisfies ControlResponse;
        const turnReceipt = this.receiptUpdateForTurn(approval.turnId, "outcome_unknown", {
          turnId: approval.turnId, status: "outcome_unknown", reason: "approval_not_active",
        });
        this.commit("approval.resolve.unavailable", { approvalId }, {
          activityState: "outcome_unknown", turnId: approval.turnId, turnStatus: "outcome_unknown",
          commandReceipt: { authSubjectId, commandId, state: "outcome_unknown", response: unavailable, requestHash, required: true },
          ...(turnReceipt ? { commandReceipts: [turnReceipt] } : {}),
          approvalDelivery: { approvalId, authSubjectId, commandId, state: "outcome_unknown" },
          timeline: { itemId: `approval-${approvalId}`, kind: "approval", status: "outcome_unknown",
            content: { ...approval.request, approvalId, action, status: "outcome_unknown", deliveryState: "outcome_unknown" } },
        });
        throw new OrchestratorError("APPROVAL_NOT_ACTIVE", `${providerDisplayName(this.session.provider)} approval request is no longer active`);
      }
      // A boolean Adapter result proves local delivery only. The durable
      // reservation is visible before this call and never claims tool success.
      const response = { status: "delivered", approvalId, deliveryState: "local_delivery" };
      const resolution = this.store.resolveApprovalAndCommit({
        approvalId, expectedVersion: approval.version, action,
        event: { sessionId: this.session.id, type: "approval.resolved", build: (resolved, pending) => {
          const stillPending = pending.some((item) => item.turnId === resolved.turnId);
          const content = { ...resolved.request, approvalId, toolUseId: resolved.toolUseId, action, status: "delivered", deliveryState: "local_delivery" };
          return { payload: { ...content, itemId: `approval-${approvalId}` }, options: {
            activityState: stillPending ? "waiting_approval" : "running", turnId: resolved.turnId,
            turnStatus: stillPending ? "waiting_approval" : "running",
            commandReceipt: { authSubjectId, commandId, requestHash, state: "completed", response, required: true },
            approvalDelivery: { approvalId, authSubjectId, commandId, state: "local_delivery" },
            timeline: { itemId: `approval-${approvalId}`, kind: "approval", status: "delivered", content },
          } };
        } },
      });
      if (!resolution) throw new OrchestratorError("INTERACTION_DELIVERY_UNSETTLED", "Approval delivery needs reconciliation");
      this.notify(resolution.event);
      return response;

    });
  }

  private async executeTurn(turn: TurnRow, authSubjectId: string, intentId: string): Promise<void> {
    const context = dispatchContextForTurn(turn.id, {
      hostOwnerId: this.hostOwnerId,
      hostOwnerGeneration: this.hostOwnerGeneration,
      sessionId: turn.sessionId,
      flyxTurnId: turn.id,
      runtimeId: this.runtimeId,
      runtimeGeneration: turn.generation,
      attemptId: turn.attemptId!,
    });
    this.dispatchContexts.set(turn.id, context);
    this.execution.claim(intentId, { id: "legacy-facade", generation: 0 });
    this.commit("turn.started", { turnId: turn.id }, { activityState: "running", turnId: turn.id, turnStatus: "running",
      executionIntentUpdates: [{ id: intentId, expectedStates: ["claimed"], state: "dispatching", attemptId: turn.attemptId!, runtimeGeneration: turn.generation }],
    });
    const session = this.store.getSession(this.session.id);
    let outcome: Awaited<ReturnType<ProviderAdapter["runTurn"]>>;
    try {
      outcome = await this.adapter.runTurn(turn.id, turn.prompt, session?.providerSessionId, context);
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    await this.eventTail;
    this.dispatchContexts.delete(turn.id);
    const latest = this.store.getTurn(turn.id);
    const finalResponse = { turnId: turn.id, ...outcome };
    const receiptUpdate = this.receiptUpdateForTurn(turn.id, outcomeToReceiptState(outcome.status), finalResponse);
    if (latest && ["queued", "running", "waiting_approval", "interrupting"].includes(latest.status)) {
      const terminal = outcome.status === "cancelled" ? "cancelled" : outcome.status === "outcome_unknown" ? "outcome_unknown" : outcome.status === "completed" ? "completed" : "failed";
      const controlReceipts = this.controlReceiptUpdatesForTurn(turn.id, terminal);
      const reconciliationOptions = {
        activityState: terminal === "outcome_unknown" ? "outcome_unknown" : "idle",
        turnId: turn.id,
        turnStatus: terminal,
        ...(receiptUpdate ? { commandReceipt: receiptUpdate } : {}),
        ...(controlReceipts.length ? { commandReceipts: controlReceipts } : {}),
        ...(terminal === "failed" || terminal === "outcome_unknown"
          ? { timeline: { itemId: `error-${randomUUID()}`, kind: "error" as const, status: terminal, content: { message: "error" in outcome ? outcome.error : "Turn ended without a terminal event" } } }
          : {}),
      } as const;
      this.commit("turn.reconciled", { turnId: turn.id, outcome }, reconciliationOptions);
      return;
    }
    // A terminal provider event should normally have committed the receipt in
    // the same transaction.  If an older adapter/event path left the receipt
    // accepted, append a tiny reconciliation event so the repair is still
    // durable and observable rather than mutating the receipt silently.
    const receipt = this.store.getCommandReceipt(authSubjectId, turn.commandId);
    if (receipt && ["accepted"].includes(receipt.state) && receiptUpdate) {
      this.commit("turn.receipt.reconciled", { turnId: turn.id, outcome }, { commandReceipt: receiptUpdate });
    }
  }

  /**
   * Public entry point for an injected adapter (e.g. the deterministic test
   * adapter) to feed provider events through the same durable pipeline the
   * built-in provider adapters use.
   */
  ingestAdapterEvent(event: AdapterEvent): void {
    this.enqueueAdapterEvent(event);
  }

  private enqueueAdapterEvent(event: AdapterEvent): void {
    this.eventTail = this.eventTail.then(() => this.handleAdapterEvent(event)).catch((error) => {
      this.degraded = true;
      const active = this.store.getActiveTurn(this.session.id);
      try {
        if (active) {
          this.commit("host.event_persist_failed", { turnId: active.id, message: error instanceof Error ? error.message : String(error) }, {
            activityState: "outcome_unknown",
            turnId: active.id,
            turnStatus: "outcome_unknown",
            ...(this.receiptUpdateForTurn(active.id, "outcome_unknown", { turnId: active.id, status: "outcome_unknown", reason: "event_persist_failed" })
              ? { commandReceipt: this.receiptUpdateForTurn(active.id, "outcome_unknown", { turnId: active.id, status: "outcome_unknown", reason: "event_persist_failed" }) }
              : {}),
            timeline: { itemId: `error-${randomUUID()}`, kind: "error", status: "fatal", content: { message: `Flyx could not persist a ${this.session.provider} event` } },
          });
        }
      } catch {
        // The database may itself be unavailable.  The degraded flag still
        // prevents new work, and the adapter is interrupted below.
      }
      void this.adapter.interrupt("event_persist_failed");
    });
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
    if (event.kind === "approval_requested" && event.request.turnId !== target.id) return;
    if (event.kind === "approval_resolved" && this.store.getApproval(event.approvalId)?.turnId !== target.id) return;
    const resolvedTurnId = target.id;
    // Native Item IDs can be reused by a resumed runtime. Keep separate
    // projections per Flyx Turn while preserving the source ID for recovery.
    if ("itemId" in event) event = { ...event, nativeItemId: event.itemId, itemId: `provider-${target.id}-${event.itemId}` };
    switch (event.kind) {
      case "session_init":
        this.commit("provider.session.init", event, { turnId: target.id, turnStatus: target.status, providerSessionId: event.providerSessionId, timeline: { itemId: `system-session-${target.id}`, kind: "system", status: "info", content: { message: `${providerDisplayName(event.provider)} session initialized`, provider: event.provider, providerSessionId: event.providerSessionId, model: event.model, runtimeVersion: event.runtimeVersion } } });
        return;
      case "native_binding":
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

  private nextRuntimeGeneration(): number {
    const row = this.store.db.prepare("SELECT MAX(generation) AS generation FROM turns WHERE session_id = ?")
      .get(this.session.id) as { generation: number | null };
    const generation = (row.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new OrchestratorError("GENERATION_EXHAUSTED", "Provider generation exhausted");
    return generation;
  }

  private commit(type: string, payload: unknown, options: Parameters<SqliteStore["commitEvent"]>[3] = {}): SessionEvent {
    this.owner.assertActive();
    const event = this.store.commitEvent(this.session.id, type, payload, options);
    this.notify(event);
    return event;
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

  private async resolvePendingApprovalsAsAborted(turn: TurnRow): Promise<void> {
    const snapshot = this.store.getSnapshot(this.session.id);
    for (const approval of snapshot?.pendingApprovals ?? []) {
      if (approval.turnId !== turn.id) continue;
      const committed = this.store.resolveApprovalAndCommit({
        approvalId: approval.approvalId,
        expectedVersion: approval.version,
        action: "aborted",
        event: {
          sessionId: this.session.id,
          type: "approval.resolved",
          build: (resolved) => {
            const content = { ...resolved.request, turnId: turn.id, approvalId: approval.approvalId, toolUseId: resolved.toolUseId, action: "aborted", status: "aborted" };
            return {
              payload: { ...content, itemId: `approval-${approval.approvalId}` },
              options: {
                activityState: "interrupting",
                turnId: turn.id,
                turnStatus: "interrupting",
                timeline: { itemId: `approval-${approval.approvalId}`, kind: "approval", status: "aborted", content },
              },
            };
          },
        },
      });
      if (committed) this.notify(committed.event);
    }
  }

  private enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.commandTail.then(() => {
      if (this.closed) throw new OrchestratorError("HOST_DRAINING", "Host is closed to new commands", true);
      this.owner.assertActive();
      return fn();
    }).catch((error: unknown) => {
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

  private assertWritable(): void {
    if (this.degraded) throw new OrchestratorError("HOST_DEGRADED", "Host event persistence is degraded; restart the Host before accepting commands", true);
  }

  private prepareControlIntent(intentId: string): boolean {
    const intent = this.execution.get(intentId);
    if (!intent || intent.state === "settled" || intent.state === "outcome_unknown") return false;
    this.execution.claim(intentId, { id: "legacy-facade", generation: 0 });
    this.execution.transition({ id: intentId, expectedStates: ["claimed"], state: "dispatching",
      attemptId: intent.attemptId, runtimeGeneration: intent.runtimeGeneration });
    return true;
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
