import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Bootstrap, SessionEvent, TimelineItem } from "@flyx/mvp-protocol";
import { ProtocolVersion } from "@flyx/mvp-protocol";
import { ClaudeAdapter } from "../claude/adapter.js";
import type { AdapterEvent } from "../claude/types.js";
import { GitService, type GitDiff, type GitStatus } from "../git/git-service.js";
import {
  SqliteStore,
  type ApprovalRow,
  type CommandReceiptRow,
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
  adapter?: ClaudeAdapter;
};

const MAX_PROMPT_BYTES = 16 * 1024;

export class SessionOrchestrator {
  readonly store: SqliteStore;
  readonly workspace: string;
  readonly git: GitService;
  readonly adapter: ClaudeAdapter;
  private readonly listeners = new Set<SessionEventListener>();
  private commandTail: Promise<unknown> = Promise.resolve();
  private eventTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private degraded = false;
  private baselinePromise: Promise<void> | undefined;
  private readonly session: SessionRow;

  constructor(options: OrchestratorOptions) {
    const canonicalWorkspace = realpathSync(options.workspace);
    this.store = new SqliteStore(options.databasePath ?? ":memory:");
    const existingSession = this.store.getCurrentSession();
    if (existingSession && existingSession.workspacePath !== canonicalWorkspace) {
      this.store.close();
      throw new OrchestratorError("WORKSPACE_MISMATCH", "Persisted session belongs to a different configured workspace");
    }
    this.workspace = canonicalWorkspace;
    this.session = existingSession ?? this.store.createSession(canonicalWorkspace);
    this.store.recoverActiveTurns();
    this.git = new GitService(canonicalWorkspace);
    this.adapter = options.adapter ?? new ClaudeAdapter({
      workspace: canonicalWorkspace,
      onEvent: (event) => this.enqueueAdapterEvent(event),
    });
  }

  close(): void {
    this.store.close();
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
      provider: "claude",
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
    activeTurn?: Omit<TurnRow, "authSubjectId" | "providerSessionId">;
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
    const { authSubjectId: _authSubjectId, providerSessionId: _turnProviderSessionId, ...activeTurn } = snapshot.activeTurn;
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

  async providerStatus(): Promise<Awaited<ReturnType<ClaudeAdapter["status"]>>> {
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
      const existing = this.store.getCommandReceipt(authSubjectId, commandId);
      if (existing) return this.reuseReceipt(existing, method, requestHash) as StartTurnResponse;
      if (this.degraded) throw new OrchestratorError("HOST_DEGRADED", "Host event persistence is degraded; restart the Host before starting a new Turn", true);
      const current = this.snapshot();
      if (current.session.activityState !== "idle" || current.activeTurn) {
        throw new OrchestratorError("TURN_BUSY", "The current session already has an active turn", true);
      }
      await this.ensureBaseline();
      const turnId = randomUUID();
      const accepted = this.store.acceptTurn({
        authSubjectId,
        sessionId: this.session.id,
        turnId,
        commandId,
        requestHash,
        prompt,
        generation: ++this.generation,
      });
      accepted.events.forEach((event) => this.notify(event));
      void this.executeTurn(accepted.turn, authSubjectId);
      return accepted.receipt.response as StartTurnResponse;
    });
  }

  interrupt(authSubjectId: string, commandId: string): Promise<ControlResponse> {
    return this.enqueueCommand(async () => {
      const method = "session.interrupt";
      const requestHash = hashRequest(method, {});
      const existing = this.store.getCommandReceipt(authSubjectId, commandId);
      if (existing) return this.reuseReceipt(existing, method, requestHash) as ControlResponse;
      const current = this.store.getActiveTurn(this.session.id);
      if (!current) {
        const response = { status: "already_terminal" } satisfies ControlResponse;
        this.store.putCommandReceipt({ authSubjectId, commandId, method, requestHash, state: "completed", response });
        return response;
      }
      const response = { status: "accepted", turnId: current.id } satisfies ControlResponse;
      this.store.putCommandReceipt({ authSubjectId, commandId, method, requestHash, state: "accepted", response });
      this.commit("turn.interrupt.requested", { turnId: current.id, commandId }, {
        activityState: "interrupting",
        turnId: current.id,
        turnStatus: "interrupting",
        timeline: {
          itemId: `interrupt-${current.id}`,
          kind: "system",
          status: "requested",
          content: { turnId: current.id, message: "Interrupt requested" },
        },
      });
      await this.resolvePendingApprovalsAsAborted(current);
      const result = await this.adapter.interrupt("user_interrupt");
      if (result === "already_terminal") {
        const terminal = { status: "already_terminal", turnId: current.id } satisfies ControlResponse;
        this.store.updateCommandReceipt(authSubjectId, commandId, "completed", terminal);
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
          timeline: { itemId: `error-${randomUUID()}`, kind: "error", status: "error", content: { message: "Claude interrupt could not be confirmed" } },
        });
        return failed;
      }
      this.store.updateCommandReceipt(authSubjectId, commandId, "accepted", response);
      return response;
    });
  }

  respondApproval(authSubjectId: string, commandId: string, approvalId: string, action: "allow_once" | "deny"): Promise<ControlResponse> {
    return this.enqueueCommand(async () => {
      const method = "approval.respond";
      const request = { approvalId, action };
      const requestHash = hashRequest(method, request);
      const existing = this.store.getCommandReceipt(authSubjectId, commandId);
      if (existing) return this.reuseReceipt(existing, method, requestHash) as ControlResponse;
      const approval = this.store.getApproval(approvalId);
      if (!approval || approval.sessionId !== this.session.id) {
        throw new OrchestratorError("APPROVAL_NOT_FOUND", "Approval does not exist");
      }
      const response = { status: "resolved", approvalId } satisfies ControlResponse;
      const committed = this.store.resolveApprovalAndCommit({
        approvalId,
        expectedVersion: approval.version,
        action,
        event: {
          sessionId: this.session.id,
          type: "approval.resolved",
          build: (resolved, pending) => {
            const stillPending = pending.some((item) => item.approvalId !== approvalId && item.turnId === resolved.turnId);
            const content = { ...resolved.request, approvalId, toolUseId: resolved.toolUseId, action, status: "resolved" };
            return {
              payload: { ...content, itemId: `approval-${approvalId}` },
              options: {
                activityState: stillPending ? "waiting_approval" : "running",
                turnId: resolved.turnId,
                turnStatus: stillPending ? "waiting_approval" : "running",
                timeline: { itemId: `approval-${approvalId}`, kind: "approval", status: "resolved", content },
              },
            };
          },
        },
        receipt: {
          authSubjectId: authSubjectId,
          commandId,
          method,
          requestHash,
          state: "completed",
          response,
        },
      });
      if (!committed) throw new OrchestratorError("ALREADY_RESOLVED", "Approval was already resolved");
      this.notify(committed.event);
      if (!this.adapter.respondApproval(approvalId, action)) {
        const unavailable = { status: "outcome_unknown", approvalId } satisfies ControlResponse;
        const turnReceipt = this.receiptUpdateForTurn(committed.approval.turnId, "outcome_unknown", {
          turnId: committed.approval.turnId,
          status: "outcome_unknown",
          reason: "approval_not_active",
        });
        this.commit("approval.resolve.unavailable", { approvalId }, {
          activityState: "outcome_unknown",
          turnId: committed.approval.turnId,
          turnStatus: "outcome_unknown",
          commandReceipt: { authSubjectId, commandId, state: "outcome_unknown", response: unavailable, requestHash, required: true },
          ...(turnReceipt ? { commandReceipts: [turnReceipt] } : {}),
          timeline: { itemId: `error-${randomUUID()}`, kind: "error", status: "error", content: { message: "Claude approval request is no longer active" } },
        });
        throw new OrchestratorError("APPROVAL_NOT_ACTIVE", "Claude approval request is no longer active");
      }
      return response;
    });
  }

  private async executeTurn(turn: TurnRow, authSubjectId: string): Promise<void> {
    this.commit("turn.started", { turnId: turn.id }, { activityState: "running", turnId: turn.id, turnStatus: "running" });
    const session = this.store.getSession(this.session.id);
    let outcome: Awaited<ReturnType<ClaudeAdapter["runTurn"]>>;
    try {
      outcome = await this.adapter.runTurn(turn.id, turn.prompt, session?.providerSessionId);
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    await this.eventTail;
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
   * built-in ClaudeAdapter uses.
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
            timeline: { itemId: `error-${randomUUID()}`, kind: "error", status: "fatal", content: { message: "Flyx could not persist a Claude event" } },
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
    const current = this.store.getActiveTurn(this.session.id);
    const eventTurnId = event.turnId ?? (event.kind === "approval_requested" ? event.request.turnId : undefined);
    const target = eventTurnId ? this.store.getTurn(eventTurnId) : current;

    // SDK callbacks are delivered asynchronously.  A query can emit a late
    // message after its terminal event while the next Turn is already
    // running.  The adapter's generation/turn fence makes that message
    // harmless; older test adapters that do not provide a fence retain the
    // original single-active-turn behaviour.
    if (event.generation !== undefined) {
      if (!target || target.generation !== event.generation) return;
      if (current && current.id !== target.id) return;
      if (["completed", "failed", "cancelled", "outcome_unknown"].includes(target.status)) return;
    }
    const turnId = eventTurnId ?? target?.id;
    if (!turnId && event.kind !== "diagnostic" && event.kind !== "session_init") return;
    const resolvedTurnId = turnId ?? "";
    switch (event.kind) {
      case "session_init":
        this.commit("provider.session.init", event, { providerSessionId: event.providerSessionId, timeline: { itemId: `system-session-${event.providerSessionId}`, kind: "system", status: "info", content: { message: "Claude session initialized", providerSessionId: event.providerSessionId, model: event.model } } });
        return;
      case "assistant_delta": {
        const text = this.mergeText(resolvedTurnId, event.itemId, event.text);
        this.commit("assistant.message.delta", { turnId: resolvedTurnId, itemId: event.itemId, text: event.text }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "assistant_message", status: "streaming", content: { turnId: resolvedTurnId, itemId: event.itemId, text } } });
        return;
      }
      case "assistant_message":
        this.commit("assistant.message.completed", { turnId: resolvedTurnId, ...event }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "assistant_message", status: event.aborted ? "aborted" : "completed", content: { turnId: resolvedTurnId, itemId: event.itemId, text: event.text, ...(event.aborted ? { aborted: true } : {}) } } });
        return;
      case "tool_started":
        this.commit("tool.call.started", { turnId: resolvedTurnId, ...event }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "tool_call", status: "running", content: { turnId: resolvedTurnId, toolUseId: event.toolUseId, toolName: event.toolName, input: event.input } } });
        return;
      case "tool_progress": {
        const item = this.store.getTimelineItem(this.session.id, event.itemId);
        this.commit("tool.call.progress", { turnId: resolvedTurnId, ...event }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "tool_call", status: "running", content: { ...(isRecord(item?.content) ? item.content : {}), output: event.output } } });
        return;
      }
      case "tool_completed": {
        const item = this.store.getTimelineItem(this.session.id, event.itemId);
        this.commit("tool.call.completed", { turnId: resolvedTurnId, ...event }, { turnId: resolvedTurnId, timeline: { itemId: event.itemId, kind: "tool_call", status: event.error ? "failed" : "completed", content: { ...(isRecord(item?.content) ? item.content : {}), ...(event.output ? { output: event.output } : {}), ...(event.error ? { error: event.error } : {}) } } });
        return;
      }
      case "approval_requested": {
        const request = event.request;
        // SDK callbacks can be delivered more than once around an abort or
        // reconnect.  Never let a late duplicate move a resolved approval or
        // Turn back to waiting_approval.
        if (this.store.getApproval(request.approvalId)) return;
        const approval: ApprovalRow = { approvalId: request.approvalId, sessionId: this.session.id, turnId: request.turnId, toolUseId: request.toolUseId, version: 0, status: "pending", request, createdAt: request.createdAt };
        this.commit("approval.requested", { ...request, itemId: `approval-${request.approvalId}`, status: "pending" }, { activityState: "waiting_approval", turnId: request.turnId, turnStatus: "waiting_approval", approval, timeline: { itemId: `approval-${request.approvalId}`, kind: "approval", status: "pending", content: { ...request, status: "pending" } } });
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
                payload: { ...content, turnId: resolvedTurnId, itemId: `approval-${event.approvalId}`, ...event },
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
        this.commit("turn.completed", { turnId: resolvedTurnId, itemId: `result-${resolvedTurnId}`, ...event }, {
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
        this.commit("turn.failed", { turnId: resolvedTurnId, itemId: `error-${resolvedTurnId}`, ...event }, {
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
        this.commit("turn.cancelled", { turnId: resolvedTurnId, itemId: `result-${resolvedTurnId}`, ...event }, {
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
    const next = this.commandTail.then(fn);
    this.commandTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private ensureBaseline(): Promise<void> {
    if (this.store.getSessionBaseline(this.session.id)) return Promise.resolve();
    if (!this.baselinePromise) {
      this.baselinePromise = this.git.status().then((status) => {
        this.store.setSessionBaseline(this.session.id, { ...(status.head ? { head: status.head } : {}), dirty: status.dirty, files: status.files });
      }).catch((error) => {
        this.baselinePromise = undefined;
        throw error;
      });
    }
    return this.baselinePromise;
  }

  private reuseReceipt(receipt: CommandReceiptRow, method: string, requestHash: string): unknown {
    if (receipt.method !== method || receipt.requestHash !== requestHash) {
      throw new OrchestratorError("COMMAND_ID_REUSED", "commandId was already used with a different request");
    }
    return receipt.response;
  }
}

function hashRequest(method: string, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({ method, payload: canonicalize(payload) })).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outcomeToReceiptState(status: string): "completed" | "failed" | "cancelled" | "outcome_unknown" {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "outcome_unknown") return "outcome_unknown";
  return "failed";
}
