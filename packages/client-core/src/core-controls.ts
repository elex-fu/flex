import {
  CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, RecoveryCapability, SESSION_CATALOG_CAPABILITY, WORKTREE_CAPABILITY,
  CatalogMutationResponseSchema, WorktreeResultSchema, CheckpointSummarySchema, SessionSnapshotV2Schema, type CheckpointSummary,
  type SessionSnapshotV2, type SessionSummaryV2, type WorkspaceSummaryV2, type ProviderInstanceSummaryV2,
  type RecoveryEvidence, type RecoveryOperation, type RecoveryInspectPayload,
  type CheckpointDiffPage, type CheckpointDiffFile, type CheckpointPreviewPage, type CheckpointRevertOperation, type CheckpointRevertEvidence,
  type ManagedWorktreeSummary, type WorktreeResult,
  type TimelineContentReference,
} from "@flyx/mvp-protocol";
import { SessionClient, type SessionClientPort } from "./session-client.js";
import { createRecoveryClient } from "./recovery-client.js";
import { CheckpointClient } from "./checkpoint-client.js";
import { WorktreeClient } from "./worktree-client.js";
import { ClientError, isRecord } from "./common.js";
import type { ClientState, ClientStore, PendingCommand, Unsubscribe } from "./types.js";

export interface CoreControlPort extends SessionClientPort {
  readonly store: Pick<ClientStore, "listCommands" | "getCommand">;
  readonly replica?: { getState(): { sessionId?: string | undefined; replicaGeneration: number } };
  getState(): ClientState;
  queryCommandReceipt(commandId: string): Promise<PendingCommand>;
  retrySynchronization(): Promise<unknown>;
  readContent?(reference: TimelineContentReference, sessionId?: string): Promise<Uint8Array>;
}
export type CoreSelection = { hostId: string; sessionId?: string | undefined; transportGeneration: number; replicaGeneration: number };
export type ResourceReadiness = { workspaceId: string; providerInstanceId: string; hostState: string; reasonCodes: string[]; capabilities: string[]; validUntil?: string | undefined };
export type WorktreeFlow = { command: PendingCommand; sessionCommandId: string; sessionCommand?: PendingCommand | undefined; result?: WorktreeResult | undefined };
export type CoreControlState = {
  selection?: CoreSelection | undefined;
  busy?: string | undefined; error?: string | undefined;
  sessions: SessionSummaryV2[]; nextSessionId?: string | undefined; includeArchived: boolean;
  workspaces: WorkspaceSummaryV2[]; providers: ProviderInstanceSummaryV2[];
  snapshot?: SessionSnapshotV2 | undefined; readiness?: ResourceReadiness | undefined;
  recovery?: RecoveryEvidence | undefined; recoveryOperation?: RecoveryOperation | undefined;
  diff?: CheckpointDiffPage | undefined; file?: CheckpointDiffFile | undefined;
  fileContents?: Partial<Record<"before" | "after" | "patch", string>> | undefined;
  preview?: CheckpointPreviewPage | undefined; revert?: CheckpointRevertOperation | undefined; revertEvidence?: CheckpointRevertEvidence | undefined;
  worktrees: ManagedWorktreeSummary[]; nextWorktreeId?: string | undefined; flows: WorktreeFlow[]; worktreeOperation?: WorktreeResult | undefined;
};
type Ticket = { generation: number; selection: CoreSelection };
function empty(): CoreControlState { return { sessions: [], includeArchived: false, workspaces: [], providers: [], worktrees: [], flows: [] }; }
function sessionFor(command: PendingCommand): string | undefined { return isRecord(command.payload) && typeof command.payload.sessionId === "string" ? command.payload.sessionId : undefined; }
/** Accept only typed, scoped checkpoint summaries, from either canonical items or the Web's presentation adapter. */
export function checkpointReferences(items: readonly unknown[], sessionId: string): CheckpointSummary[] {
  const found = new Map<string, CheckpointSummary>();
  for (const item of items) {
    if (!isRecord(item) || item.sessionId !== sessionId) continue;
    const content = isRecord(item.content) ? item.content : {};
    const merged = { ...(isRecord(item.metadata) ? item.metadata : {}), ...content, ...(isRecord(content.inline) ? content.inline : {}) };
    const candidate = Object.fromEntries(Object.keys(CheckpointSummarySchema.shape).filter((key) => key in merged).map((key) => [key, merged[key]]));
    const parsed = CheckpointSummarySchema.safeParse(candidate);
    if (parsed.success && parsed.data.sessionId === sessionId) found.set(parsed.data.checkpointId, parsed.data);
  }
  return [...found.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
export function worktreeSessionCommandId(worktreeCommandId: string): string {
  const id = `worktree-session:${worktreeCommandId}`;
  if (id.length > 128) throw new ClientError("COMMAND_ID_INVALID", "Original Worktree command identity is too long");
  return id;
}
/** The two original Outbox entries are the workflow journal. There is no third job or automatic resend. */
export function worktreeFlows(commands: PendingCommand[], sessionId: string): WorktreeFlow[] {
  return commands.filter((command) => command.method === "worktree.create" && sessionFor(command) === sessionId).map((command) => {
    const sessionCommandId = worktreeSessionCommandId(command.commandId);
    const parsed = WorktreeResultSchema.safeParse(isRecord(command.result) ? { operation: command.result.operation, worktree: command.result.worktree, ...(command.result.inspection ? { inspection: command.result.inspection } : {}) } : undefined);
    return { command, sessionCommandId, sessionCommand: commands.find((item) => item.commandId === sessionCommandId), ...(parsed.success ? { result: parsed.data } : {}) };
  });
}
export function recoveryWritePayload(evidence: RecoveryEvidence, action: "reconcile" | "acknowledge", acknowledgeUnknown: boolean, now = Date.now()) {
  if (!evidence.nextSteps.includes(action)) throw new ClientError("RECOVERY_ACTION_UNAVAILABLE", "Inspect again; this action is not offered by the Host");
  if (!Number.isFinite(Date.parse(evidence.expiresAt)) || Date.parse(evidence.expiresAt) <= now) throw new ClientError("RECOVERY_EVIDENCE_EXPIRED", "Recovery evidence expired; inspect the original execution again");
  if (action === "acknowledge" && !acknowledgeUnknown) throw new ClientError("UNKNOWN_ACKNOWLEDGEMENT_REQUIRED", "Explicitly acknowledge that the original execution outcome remains unknown");
  return { sessionId: evidence.sessionId, turnId: evidence.turnId, ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}), evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, ...(action === "acknowledge" ? { acknowledgeUnknown: true as const } : {}) };
}

/** Shared Web/native controls. Selection changes invalidate reads, never the application runtime or its durable commands. */
export class CoreControls {
  readonly sessions: SessionClient;
  readonly checkpoints: CheckpointClient;
  readonly worktrees: WorktreeClient;
  private recoveryClient;
  private state = empty();
  private generation = 0;
  private observers = new Set<(state: CoreControlState) => void>();
  private writing = new Set<string>();
  constructor(readonly port: CoreControlPort, private options: { commandId?: () => string; now?: () => number } = {}) {
    this.sessions = new SessionClient(port, { commandId: () => this.id() });
    this.recoveryClient = createRecoveryClient(port);
    const request = <T = unknown>(method: string, payload?: unknown, commandId?: string): Promise<T> => commandId ? port.command<T>(method, payload, commandId) : port.request<T>(method, payload);
    this.checkpoints = new CheckpointClient({ request, supports: (capability) => port.supportsCapability(capability) });
    this.worktrees = new WorktreeClient({ request, supports: (capability) => port.supportsCapability(capability) });
  }
  getState(): CoreControlState { return structuredClone(this.state); }
  observe(handler: (state: CoreControlState) => void): Unsubscribe { this.observers.add(handler); handler(this.getState()); return () => { this.observers.delete(handler); }; }
  private publish(patch: Partial<CoreControlState>): void { this.state = { ...this.state, ...patch }; for (const observer of this.observers) observer(this.getState()); }
  select(selection?: CoreSelection): void {
    if (JSON.stringify(selection) === JSON.stringify(this.state.selection)) return;
    this.generation++; this.state = { ...empty(), ...(selection ? { selection: { ...selection } } : {}) }; this.publish({});
  }
  supports(capability: "sessions" | "recovery" | "diff" | "revert" | "worktrees"): boolean {
    return this.port.supportsCapability(({ sessions: SESSION_CATALOG_CAPABILITY, recovery: RecoveryCapability, diff: CHECKPOINT_DIFF_CAPABILITY, revert: CHECKPOINT_REVERT_CAPABILITY, worktrees: WORKTREE_CAPABILITY })[capability]);
  }
  /** Call only with the current authoritative replica. Cached summaries never grant write authority. */
  acceptSnapshot(value: unknown): void {
    if (!this.state.selection || !this.current({ generation: this.generation, selection: this.state.selection })) return;
    const parsed = SessionSnapshotV2Schema.safeParse(value);
    if (!parsed.success || parsed.data.session.sessionId !== this.state.selection?.sessionId || parsed.data.activeTurn && parsed.data.activeTurn.sessionId !== parsed.data.session.sessionId || this.state.snapshot && parsed.data.session.revision < this.state.snapshot.session.revision) return;
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.state.snapshot)) this.publish({ snapshot: parsed.data });
  }
  private id(): string { const id = this.options.commandId?.() ?? globalThis.crypto?.randomUUID?.(); if (!id) throw new ClientError("COMMAND_ID_REQUIRED", "A cryptographic command identity is required"); return id; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private ticket(): Ticket {
    const selection = this.state.selection;
    if (!selection || this.port.getState().profile?.hostId !== selection.hostId) throw new ClientError("SELECTION_REQUIRED", "Select a verified Host first");
    const ticket = { generation: this.generation, selection: { ...selection } };
    this.assertCurrent(ticket); return ticket;
  }
  private current(ticket: Ticket): boolean {
    const replica = this.port.replica?.getState();
    return ticket.generation === this.generation && this.port.getState().profile?.hostId === ticket.selection.hostId && this.port.getState().transportGeneration === ticket.selection.transportGeneration && (!replica || replica.sessionId === ticket.selection.sessionId && replica.replicaGeneration === ticket.selection.replicaGeneration);
  }
  private assertCurrent(ticket: Ticket): void { if (!this.current(ticket)) throw new ClientError("SELECTION_CHANGED", "Host, Session or connection changed; refresh the current view"); }
  private session(ticket: Ticket): string { const id = ticket.selection.sessionId; if (!id) throw new ClientError("SESSION_REQUIRED", "Select a Session first"); return id; }
  private async action<T>(label: string, operation: (ticket: Ticket) => Promise<T>): Promise<T | undefined> {
    let ticket: Ticket;
    try { ticket = this.ticket(); } catch (cause) { this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); return; }
    if (this.state.busy) return;
    this.publish({ busy: label, error: undefined });
    try { const result = await operation(ticket); if (this.current(ticket)) return result; }
    catch (cause) { if (this.current(ticket)) this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { if (this.current(ticket)) this.publish({ busy: undefined }); }
    return;
  }
  private async write<T>(ticket: Ticket, method: string, operation: (commandId: string) => Promise<T>, commandId?: string): Promise<T> {
    this.assertCurrent(ticket);
    const key = `${ticket.selection.hostId}:${method}:${ticket.selection.sessionId ?? ""}`;
    if (this.writing.has(key)) throw new ClientError("COMMAND_PENDING", "This operation is already being submitted");
    this.writing.add(key);
    try {
      const commands = await this.port.store.listCommands(ticket.selection.hostId);
      this.assertCurrent(ticket);
      const pending = commands.find((command) => command.method === method && (command.state !== "terminal" || command.outcomeUnknown) && (method === "session.createNew" || sessionFor(command) === ticket.selection.sessionId));
      if (pending) throw new ClientError("COMMAND_REVIEW_REQUIRED", `Check the original command receipt first: ${pending.commandId}`);
      return await operation(commandId ?? this.id());
    } finally { this.writing.delete(key); }
  }
  private async refreshCurrent(ticket: Ticket): Promise<void> {
    const snapshot = await this.sessions.getSnapshot({ sessionId: this.session(ticket) });
    if (this.current(ticket)) this.acceptSnapshot(snapshot);
  }
  refresh(includeArchived = this.state.includeArchived, more = false) {
    return this.action("refresh", async (ticket) => {
      const [page, workspaces, providers, snapshot] = await Promise.all([
        this.sessions.list({ includeArchived, ...(more && this.state.nextSessionId ? { afterSessionId: this.state.nextSessionId } : {}) }),
        this.sessions.listWorkspaces(), this.sessions.listProviders(),
        ticket.selection.sessionId ? this.sessions.getSnapshot({ sessionId: ticket.selection.sessionId }) : Promise.resolve(undefined),
      ]);
      if (this.current(ticket)) { this.publish({ includeArchived, sessions: more ? [...this.state.sessions, ...page.sessions] : page.sessions, nextSessionId: page.nextSessionId, workspaces: workspaces.workspaces, providers: providers.providerInstances }); if (snapshot) this.acceptSnapshot(snapshot); }
      await this.refreshFlows(ticket);
    });
  }
  readiness(workspaceId: string, providerInstanceId: string) {
    return this.action("readiness", async (ticket) => {
      if (!this.port.supportsCapability("host-execution-readiness-v1")) throw new ClientError("CAPABILITY_UNSUPPORTED", "Host does not expose execution readiness; verify and activate these resources locally");
      const value = await this.port.request<unknown>("host.getExecutionReadiness", { targets: [{ workspaceId, providerInstanceId }] });
      if (!isRecord(value) || value.v !== 1 || typeof value.hostState !== "string" || !Array.isArray(value.reasonCodes) || !value.reasonCodes.every((code) => typeof code === "string") || !Array.isArray(value.targets)) throw new ClientError("INVALID_RPC_RESPONSE", "Invalid Host readiness response");
      const target = value.targets.find((entry) => isRecord(entry) && entry.workspaceId === workspaceId && entry.providerInstanceId === providerInstanceId);
      if (!isRecord(target) || !Array.isArray(target.capabilities) || !target.capabilities.every((cap) => typeof cap === "string")) throw new ClientError("INVALID_RPC_RESPONSE", "Readiness belongs to different resources");
      if (this.current(ticket)) this.publish({ readiness: { workspaceId, providerInstanceId, hostState: value.hostState, reasonCodes: value.reasonCodes as string[], capabilities: target.capabilities as string[], ...(typeof target.validUntil === "string" ? { validUntil: target.validUntil } : {}) } });
    });
  }
  createSession(workspaceId: string, providerInstanceId: string, title: string) {
    return this.action("create-session", async (ticket) => {
      if (!this.state.workspaces.some((workspace) => workspace.workspaceId === workspaceId) || !this.state.providers.some((provider) => provider.providerInstanceId === providerInstanceId)) throw new ClientError("RESOURCE_SELECTION_REQUIRED", "Refresh and select resources registered on the current Host");
      const result = await this.write(ticket, "session.createNew", (id) => this.sessions.createNew({ workspaceId, providerInstanceId, title }, id));
      this.assertCurrent(ticket);
      if (result.receipt.state !== "completed") throw new ClientError("COMMAND_REVIEW_REQUIRED", `Session creation is ${result.receipt.state}; check its original receipt: ${result.receipt.commandId}`);
      return result.session;
    });
  }
  changeSession(action: "rename" | "archive" | "unarchive" | "closeRuntime", title?: string) {
    return this.action(action, async (ticket) => {
      const shown = this.state.snapshot?.session;
      if (!shown || shown.sessionId !== this.session(ticket)) throw new ClientError("SNAPSHOT_REQUIRED", "Refresh the authoritative Session revision first");
      const payload = { sessionId: shown.sessionId, expectedRevision: shown.revision };
      await this.write(ticket, `session.${action}`, (id) => action === "rename" ? this.sessions.rename({ ...payload, title: title ?? shown.title }, id) : this.sessions[action](payload, id));
      this.assertCurrent(ticket); await this.refreshCurrent(ticket); await this.port.retrySynchronization();
    });
  }
  interrupt() {
    return this.action("interrupt", async (ticket) => {
      const shown = this.state.snapshot;
      if (!shown?.activeTurn || shown.session.activityState === "outcome_unknown") throw new ClientError("TURN_NOT_INTERRUPTIBLE", "Refresh the active Turn before interrupting");
      await this.write(ticket, "session.interrupt", (id) => this.sessions.interrupt({ sessionId: this.session(ticket), expectedRevision: shown.session.revision }, id));
      this.assertCurrent(ticket); await this.refreshCurrent(ticket); await this.port.retrySynchronization();
    });
  }
  inspectRecovery(target?: RecoveryInspectPayload) {
    return this.action("inspect-recovery", async (ticket) => {
      const turnId = target?.turnId ?? this.state.snapshot?.activeTurn?.id;
      if (!turnId || target && target.sessionId !== this.session(ticket)) throw new ClientError("RECOVERY_TARGET_REQUIRED", "Choose the original Turn from this Session");
      const evidence = await this.recoveryClient.inspect(target ?? { sessionId: this.session(ticket), turnId });
      if (this.current(ticket)) this.publish({ recovery: evidence, recoveryOperation: undefined });
    });
  }
  recover(action: "reconcile" | "acknowledge", acknowledgeUnknown = false, shownEvidenceId?: string) {
    return this.action(`recovery-${action}`, async (ticket) => {
      const evidence = this.state.recovery;
      if (!evidence || evidence.sessionId !== this.session(ticket)) throw new ClientError("RECOVERY_INSPECT_REQUIRED", "Inspect the original execution first");
      if (shownEvidenceId !== undefined && evidence.evidenceId !== shownEvidenceId) throw new ClientError("RECOVERY_EVIDENCE_CHANGED", "The inspected evidence changed; review it before taking action");
      const payload = recoveryWritePayload(evidence, action, acknowledgeUnknown, this.now());
      const operation = await this.write(ticket, `session.recovery.${action}`, (id) => action === "acknowledge" ? this.recoveryClient.acknowledge({ ...payload, acknowledgeUnknown: true }, id) : this.recoveryClient.reconcile(payload, id));
      if (!this.current(ticket)) return;
      this.publish({ recoveryOperation: operation, recovery: undefined });
      await this.refreshCurrent(ticket); this.assertCurrent(ticket); await this.port.retrySynchronization();
    });
  }
  turnDiff(turnId: string, attemptId: string, layer: "workspace" | "index" = "workspace", more = false) {
    return this.action("turn-diff", async (ticket) => {
      const old = this.state.diff;
      const page = await this.checkpoints.getTurnDiff({ sessionId: this.session(ticket), turnId, attemptId, layer, ...(more && old?.nextCursor ? { cursor: old.nextCursor } : {}) });
      if (this.current(ticket)) this.publish({ diff: more && old && old.diffId === page.diffId ? { ...page, files: [...old.files, ...page.files] } : page, file: undefined, fileContents: undefined, preview: undefined });
    });
  }
  readFile(fileId: string) {
    return this.action("file", async (ticket) => {
      const diffId = this.state.diff?.diffId;
      if (!diffId) throw new ClientError("DIFF_REQUIRED", "Read an available Turn Diff first");
      const file = await this.checkpoints.getFile({ sessionId: this.session(ticket), diffId, fileId });
      if (this.current(ticket)) this.publish({ file, fileContents: undefined });
    });
  }
  readFileContent(part: "before" | "after" | "patch") {
    return this.action("file-content", async (ticket) => {
      const file = this.state.file, value = file?.[part];
      if (!file || value?.kind !== "contentRef" || !this.port.readContent) throw new ClientError("CONTENT_REFERENCE_REQUIRED", "Choose a current file with a readable content reference");
      if (value.binary || value.encoding !== "utf8") throw new ClientError("BINARY_PREVIEW_UNAVAILABLE", "Binary file metadata is available; text preview is unsupported");
      const bytes = await this.port.readContent(value.contentRef, this.session(ticket));
      this.assertCurrent(ticket);
      if (this.state.file?.file.fileId !== file.file.fileId || this.state.file.diffId !== file.diffId) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      this.publish({ fileContents: { ...this.state.fileContents, [part]: text } });
    });
  }
  previewRevert(checkpointId: string) {
    return this.action("preview-revert", async (ticket) => {
      const revision = this.state.snapshot?.session.revision;
      if (revision === undefined) throw new ClientError("SNAPSHOT_REQUIRED", "Refresh the Session revision first");
      const preview = await this.checkpoints.previewRevert({ sessionId: this.session(ticket), checkpointId, expectedSessionRevision: revision });
      if (this.current(ticket)) this.publish({ preview });
    });
  }
  morePreview() {
    return this.action("preview-page", async (ticket) => {
      const old = this.state.preview;
      if (!old?.nextCursor) return;
      const page = await this.checkpoints.getPreview({ sessionId: this.session(ticket), planId: old.planId, cursor: old.nextCursor });
      if (this.current(ticket)) this.publish({ preview: { ...page, files: [...old.files, ...page.files] } });
    });
  }
  executeRevert(confirmation: boolean, shownPlanId?: string) {
    return this.action("execute-revert", async (ticket) => {
      const preview = this.state.preview;
      if (shownPlanId !== undefined && preview?.planId !== shownPlanId) throw new ClientError("PREVIEW_CHANGED", "The revert preview changed; review the current plan before confirming");
      if (!confirmation || !preview?.supported || preview.nextCursor || !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= this.now()) throw new ClientError("PREVIEW_REQUIRED", "Review all files and explicitly confirm a supported, current revert preview");
      if (!this.supports("revert")) throw new ClientError("CAPABILITY_UNSUPPORTED", "This Host does not support complete Provider and workspace revert");
      const operation = await this.write(ticket, "checkpoint.executeRevert", (id) => this.checkpoints.executeRevert({ sessionId: this.session(ticket), planId: preview.planId, expectedSessionRevision: preview.expectedSessionRevision, commandId: id, confirmation: true }));
      if (this.current(ticket)) this.publish({ revert: operation, preview: undefined, revertEvidence: undefined });
      this.assertCurrent(ticket); await this.refreshCurrent(ticket); await this.port.retrySynchronization();
    });
  }
  inspectRevert(operationId: string) {
    return this.action("inspect-revert", async (ticket) => {
      const query = { sessionId: this.session(ticket), operationId };
      const [operation, evidence] = await Promise.all([this.checkpoints.getRevertOperation(query), this.checkpoints.inspectRevert(query)]);
      if (evidence.operationRevision !== operation.revision || evidence.expectedSessionRevision !== operation.sessionRevision) throw new ClientError("REVERT_EVIDENCE_STALE", "The revert operation changed during inspection; inspect it again");
      if (this.current(ticket)) this.publish({ revert: operation, revertEvidence: evidence });
    });
  }
  recoverRevert(action: "resumeVerified" | "rollbackToSafety", confirmation: boolean, shownEvidenceId?: string) {
    return this.action(action, async (ticket) => {
      const evidence = this.state.revertEvidence;
      if (shownEvidenceId !== undefined && evidence?.evidenceId !== shownEvidenceId) throw new ClientError("REVERT_EVIDENCE_CHANGED", "Revert recovery evidence changed; review the current operation");
      if (!this.supports("revert")) throw new ClientError("CAPABILITY_UNSUPPORTED", "This Host has not negotiated complete revert recovery");
      if (!confirmation || !evidence || !Number.isFinite(Date.parse(evidence.expiresAt)) || Date.parse(evidence.expiresAt) <= this.now() || !(action === "resumeVerified" ? evidence.resumable : evidence.safetyRollbackAvailable)) throw new ClientError("REVERT_EVIDENCE_REQUIRED", "Inspect this operation and explicitly confirm an available recovery action");
      const result = await this.write(ticket, `checkpoint.${action}`, (id) => this.checkpoints[action]({ sessionId: this.session(ticket), operationId: evidence.operationId, evidenceId: evidence.evidenceId, expectedSessionRevision: evidence.expectedSessionRevision, commandId: id, confirmation: true }));
      if (this.current(ticket)) this.publish({ revert: result, revertEvidence: undefined });
      this.assertCurrent(ticket); await this.refreshCurrent(ticket); await this.port.retrySynchronization();
    });
  }
  private async refreshFlows(ticket: Ticket): Promise<void> {
    const commands = await this.port.store.listCommands(ticket.selection.hostId);
    if (this.current(ticket)) this.publish({ flows: ticket.selection.sessionId ? worktreeFlows(commands, ticket.selection.sessionId) : [] });
  }
  reviewReceipt(commandId: string) {
    return this.action("review-receipt", async (ticket) => {
      const original = await this.port.store.getCommand(commandId);
      this.assertCurrent(ticket);
      if (!original || original.hostId !== ticket.selection.hostId) throw new ClientError("COMMAND_TARGET_MISMATCH", "Receipt belongs to another Host");
      await this.port.queryCommandReceipt(commandId);
      this.assertCurrent(ticket); await this.refreshFlows(ticket);
      if (ticket.selection.sessionId) { await this.refreshCurrent(ticket); this.assertCurrent(ticket); await this.port.retrySynchronization(); }
    });
  }
  listWorktrees(more = false) {
    return this.action("worktrees", async (ticket) => {
      const result = await this.worktrees.list({ sessionId: this.session(ticket), ...(more && this.state.nextWorktreeId ? { afterWorktreeId: this.state.nextWorktreeId } : {}) });
      if (this.current(ticket)) this.publish({ worktrees: more ? [...this.state.worktrees, ...result.worktrees] : result.worktrees, nextWorktreeId: result.nextWorktreeId });
      await this.refreshFlows(ticket);
    });
  }
  createWorktree(repositoryId: string, ref: string) {
    return this.action("create-worktree", async (ticket) => {
      if (!this.state.workspaces.some((workspace) => workspace.repositoryId === repositoryId)) throw new ClientError("REGISTERED_REPOSITORY_REQUIRED", "Choose an already registered repository");
      try { await this.write(ticket, "worktree.create", (id) => this.worktrees.create({ sessionId: this.session(ticket), repositoryId, ref, branchMode: "generated" }, id)); }
      finally { await this.refreshFlows(ticket); }
    });
  }
  checkWorktree(commandId: string) {
    return this.action("check-worktree", async (ticket) => {
      const original = await this.port.store.getCommand(commandId);
      if (!original || original.hostId !== ticket.selection.hostId || sessionFor(original) !== this.session(ticket) || original.method !== "worktree.create") throw new ClientError("COMMAND_TARGET_MISMATCH", "Choose the original Worktree command from this Session");
      await this.port.queryCommandReceipt(commandId);
      this.assertCurrent(ticket);
      const receipt = await this.worktrees.getReceipt({ sessionId: this.session(ticket), commandId });
      let result = receipt.found ? receipt.response : undefined;
      if (result) result = await this.worktrees.getOperation({ sessionId: this.session(ticket), operationId: result.operation.operationId });
      await this.refreshFlows(ticket);
      if (this.current(ticket) && result) this.publish({ flows: this.state.flows.map((flow) => flow.command.commandId === commandId ? { ...flow, result } : flow) });
    });
  }
  continueWorktree(commandId: string, providerInstanceId: string, title: string) {
    return this.action("worktree-session", async (ticket) => {
      const flow = this.state.flows.find((entry) => entry.command.commandId === commandId);
      if (!flow?.result || flow.result.operation.state !== "completed" || flow.result.worktree.state !== "active") throw new ClientError("WORKTREE_NOT_READY", "Query the original operation until the workspace is confirmed active");
      const id = flow.sessionCommandId;
      const existing = await this.port.store.getCommand(id);
      this.assertCurrent(ticket);
      if (existing) {
        // Even a missing receipt cannot authorize a second Session or another command ID.
        await this.port.queryCommandReceipt(id); await this.refreshFlows(ticket);
        const current = await this.port.store.getCommand(id);
        if (current?.state === "terminal" && !current.outcomeUnknown && !current.error) {
          const response = CatalogMutationResponseSchema.parse(current.result);
          if (response.receipt.commandId !== id || response.receipt.state !== "completed" || response.session.workspaceId !== flow.result.worktree.workspaceId) throw new ClientError("SESSION_TARGET_MISMATCH", "Session receipt belongs to another workspace or is not completed");
          return response.session;
        }
        throw new ClientError("COMMAND_REVIEW_REQUIRED", `The original Session receipt is still pending: ${id}`);
      }
      try {
        const response = await this.write(ticket, "session.createNew", (stableId) => this.sessions.createNew({ workspaceId: flow.result!.worktree.workspaceId, providerInstanceId, title }, stableId), id);
        this.assertCurrent(ticket);
        if (response.receipt.state !== "completed") throw new ClientError("COMMAND_REVIEW_REQUIRED", `Session creation is ${response.receipt.state}; check its original receipt: ${id}`);
        return response.session;
      } finally { await this.refreshFlows(ticket); }
    });
  }
  changeWorktree(action: "archive" | "restore", worktreeId: string) {
    return this.action(`worktree-${action}`, async (ticket) => {
      const shown = this.state.worktrees.find((worktree) => worktree.worktreeId === worktreeId);
      if (!shown) throw new ClientError("WORKTREE_REQUIRED", "Refresh the managed Worktree catalog first");
      const operation = await this.write(ticket, `worktree.${action}`, (id) => this.worktrees[action]({ sessionId: this.session(ticket), worktreeId, expectedRevision: shown.revision }, id));
      if (this.current(ticket)) this.publish({ worktreeOperation: operation });
      const page = await this.worktrees.list({ sessionId: this.session(ticket) });
      if (this.current(ticket)) this.publish({ worktrees: page.worktrees, nextWorktreeId: page.nextWorktreeId });
    });
  }
  inspectWorktree(operationId: string) {
    return this.action("inspect-worktree", async (ticket) => {
      const result = await this.worktrees.getOperation({ sessionId: this.session(ticket), operationId });
      if (this.current(ticket)) this.publish({ worktreeOperation: result });
    });
  }
  reconcileWorktree() {
    return this.action("reconcile-worktree", async (ticket) => {
      const operationId = this.state.worktreeOperation?.operation.operationId;
      if (!operationId) throw new ClientError("WORKTREE_OPERATION_REQUIRED", "Inspect the original operation first");
      const result = await this.write(ticket, "worktree.reconcile", (id) => this.worktrees.reconcile({ sessionId: this.session(ticket), operationId }, id));
      if (this.current(ticket)) this.publish({ worktreeOperation: result });
    });
  }
  resumeWorktree(confirmation: boolean, shownEvidenceId?: string) {
    return this.action("resume-worktree", async (ticket) => {
      const inspection = this.state.worktreeOperation?.inspection;
      if (shownEvidenceId !== undefined && inspection?.evidenceId !== shownEvidenceId) throw new ClientError("WORKTREE_EVIDENCE_CHANGED", "Worktree recovery evidence changed; review it before confirming");
      if (!confirmation || !inspection?.canResume || !inspection.producerStopped || !Number.isFinite(Date.parse(inspection.expiresAt)) || Date.parse(inspection.expiresAt) <= this.now()) throw new ClientError("WORKTREE_EVIDENCE_REQUIRED", "Inspect the original operation and confirm valid stopped-producer recovery evidence");
      const result = await this.write(ticket, "worktree.resume", (id) => this.worktrees.resume({ sessionId: this.session(ticket), operationId: inspection.operationId, evidenceId: inspection.evidenceId }, id));
      if (this.current(ticket)) this.publish({ worktreeOperation: result });
    });
  }
}
