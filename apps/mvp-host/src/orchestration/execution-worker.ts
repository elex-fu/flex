import type { ExecutionIntentRow } from "./command-contract.js";
import type { DispatchContext, ProviderControlOutcome, ProviderOutcome } from "../provider/types.js";
import type { ExecutionStore } from "../storage/execution-store.js";
import { RuntimeRegistry } from "../provider/runtime-registry.js";
import { ControlLane } from "./control-lane.js";

export type ExecutionOperationKind = "producer" | "control" | "ingestion" | "checkpoint";
export type ExecutionStage = "before_claim" | "after_claim" | "after_marker" | "after_call" | "after_ack" | "before_settle";
export type OperationResult = { status: "settled" | "outcome_unknown"; resultCode: string; result?: unknown };
export type OperationIntentHandler = (intent: ExecutionIntentRow) => Promise<OperationResult>;
export type ControlIntentHandler = (intent: ExecutionIntentRow, context: DispatchContext) => Promise<ProviderControlOutcome> | ProviderControlOutcome;
export type ExecutionWorkerOptions = {
  owner: { id: string; generation: number };
  sessionId?: string;
  maxPending?: number;
  scanIntervalMs?: number;
  outcomeTimeoutMs?: number;
  controlTimeoutMs?: number;
  /** Must return synchronously inside the same SQLite claim/marker transaction. */
  revalidateDevice(intent: ExecutionIntentRow): void;
  assertWriteReady?(): void;
  onDispatch?(intent: ExecutionIntentRow, context: DispatchContext): Promise<void> | void;
  /** Runs while the intent is still pending, before the claim; a queued task waiting here for host capacity stays cancellable. */
  beforeClaim?(intent: ExecutionIntentRow): Promise<void> | void;
  beforeDispatch?(intent: ExecutionIntentRow, context: DispatchContext): Promise<void> | void;
  afterTerminal?(intent: ExecutionIntentRow, outcome: ProviderOutcome): Promise<void> | void;
  onStartOutcome(intent: ExecutionIntentRow, outcome: ProviderOutcome): Promise<void> | void;
  onOperationResult?(intent: ExecutionIntentRow, result: OperationResult): Promise<void> | void;
  onControlResult(intent: ExecutionIntentRow, outcome: ProviderControlOutcome): Promise<void> | void;
  drainIngestion(): Promise<void>;
  stage?(stage: ExecutionStage, intent: ExecutionIntentRow): Promise<void> | void;
  failed?(error: unknown, intent?: ExecutionIntentRow): void;
  track?<T>(kind: ExecutionOperationKind, operation: () => Promise<T>): Promise<T>;
};

/** Durable dispatch markers are committed before invoking any native operation. */
/**
 * A start_turn intent settled with the terminal "cancelled" result while this
 * worker still holds it pre-dispatch (pending/claimed, before the dispatching
 * marker): the durable turn.cancelled event settled it first, so the queued
 * task must finish as cancelled-before-dispatch without invoking its prompt.
 */
const cancelledBeforeDispatch = (row: { state?: string; resultCode?: string | null } | undefined | null): boolean =>
  row?.state === "settled" && (row.resultCode === "CANCELLED_BEFORE_DISPATCH" || row.resultCode === "cancelled");


export class ExecutionWorker {
  readonly controls = new ControlLane();
  private readonly controlSettlers = new Map<string, ExecutionWorkerOptions["onControlResult"]>();
  private readonly operationHandlers = new Map<string, OperationIntentHandler>();
  private readonly handlers = new Map<string, ControlIntentHandler>();
  private readonly scheduled = new Set<string>();
  private scheduledControls = 0;
  private readonly operations = new Map<Promise<unknown>, ExecutionOperationKind>();
  private readonly dispatches = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private draining = false;
  private admission = true;
  constructor(readonly execution: ExecutionStore, readonly runtimes: RuntimeRegistry, private readonly options: ExecutionWorkerOptions) {}
  get size(): number { return this.operations.size; }
  get isSealed(): boolean { return this.stopped; }
  registerOperation(kind: string, handler: OperationIntentHandler): void { this.operationHandlers.set(kind, handler); }
  registerControl(kind: string, handler: ControlIntentHandler, commit?: ExecutionWorkerOptions["onControlResult"]): void { this.handlers.set(kind, handler); if (commit) this.controlSettlers.set(kind, commit); }
  assertAdmission(kind: "start_turn" | "control"): void {
    if (!this.admission || this.stopped || (this.draining && kind === "start_turn")) throw new Error("HOST_DRAINING");
    const pending = this.execution.list({ ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), state: "pending", limit: 1000 }).length;
    if (pending + this.scheduled.size >= (this.options.maxPending ?? 256)) throw new Error("EXECUTION_QUEUE_FULL");
  }
  start(): void {
    if (this.stopped) throw new Error("WORKER_STOPPED");
    this.recover();
    this.scan();
    this.timer ??= setInterval(() => this.scan(), this.options.scanIntervalMs ?? 1000);
    this.timer.unref();
  }
  stopAdmission(): void { this.admission = false; }
  stopDispatch(): void { this.draining = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  seal(): void { this.stopped = true; this.stopAdmission(); this.stopDispatch(); }
  wake(): void { if (!this.stopped) this.scan(); }
  scan(): number {
    if (this.stopped) return 0;
    const pending = this.execution.list({ ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), state: "pending", limit: this.options.maxPending ?? 256 });
    let count = 0;
    for (const intent of pending) {
      const generic = this.operationHandlers.has(intent.kind);
      if (!intent.dispatchContext || intent.dispatchContext.hostOwnerId !== this.options.owner.id
        || intent.dispatchContext.hostOwnerGeneration !== this.options.owner.generation) continue;
      if (this.scheduled.has(intent.id) || (this.draining && (intent.kind === "start_turn" || generic))) continue;
      if (intent.kind === "start_turn" && this.runtimes.isBusy(intent.dispatchContext.runtimeId)) continue;
      if (!generic && intent.kind !== "start_turn" && !this.runtimes.matches(intent.dispatchContext)) continue;
      if (!generic && intent.kind !== "start_turn" && this.scheduledControls >= this.controls.maxQueued) continue;
      const control = !generic && intent.kind !== "start_turn";
      if (control) this.scheduledControls++;
      this.scheduled.add(intent.id); count++;
      const start = () => this.dispatch(intent);
      const operation = this.track(generic ? "checkpoint" : intent.kind === "start_turn" ? "producer" : "control", () => generic || intent.kind === "start_turn" ? start()
        : this.controls.submit(intent.dispatchContext?.runtimeId ?? intent.sessionId, start));
      this.dispatches.add(operation);
      void operation.then(() => this.completeDispatch(intent.id, operation, control), (error) => { this.options.failed?.(error, intent); this.completeDispatch(intent.id, operation, control); });
    }
    return count;
  }
  private completeDispatch(id: string, operation: Promise<unknown>, control: boolean): void {
    this.scheduled.delete(id); this.dispatches.delete(operation); if (control) this.scheduledControls--;
  }
  track<T>(kind: ExecutionOperationKind, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("WORKER_STOPPED"));
    const operation = Promise.resolve().then(() => this.options.track ? this.options.track(kind, run) : run());
    this.operations.set(operation, kind);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  async drainDispatch(): Promise<void> { while (this.dispatches.size) await Promise.allSettled([...this.dispatches]); }
  async drainOperations(deadlineMs = 5000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      for (;;) {
        if (this.operations.size) await Promise.allSettled([...this.operations.keys()]);
        // Accepted ingress may not have entered track() until its queued task runs.
        await this.options.drainIngestion();
        if (!this.operations.size) return true;
      }
    };
    try { return await Promise.race([drain(), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs)); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async stage(stage: ExecutionStage, intent: ExecutionIntentRow): Promise<void> { await this.options.stage?.(stage, intent); }
  private validateDevice(intent: ExecutionIntentRow): void {
    const readiness = this.options.assertWriteReady?.() as unknown;
    if (readiness && typeof (readiness as { then?: unknown }).then === "function") {
      void Promise.resolve(readiness).catch(() => undefined);
      throw new Error("DISPATCH_REVALIDATION_MUST_BE_SYNCHRONOUS");
    }
    const result = this.options.revalidateDevice(intent) as unknown;
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error("DISPATCH_REVALIDATION_MUST_BE_SYNCHRONOUS");
    }
  }
  private async dispatch(original: ExecutionIntentRow): Promise<void> {
    let intent = original;
    let invoked = false;
    try {
      await this.stage("before_claim", intent);
      if (this.stopped) return;
      const latest = this.execution.get(intent.id);
      if (!latest || latest.state !== "pending") {
        if (cancelledBeforeDispatch(latest)) await this.options.afterTerminal?.(latest!, { status: "cancelled", evidence: { kind: "not-dispatched" } });
        return;
      }
      intent = latest;
      const generic = this.operationHandlers.get(intent.kind);
      if (!intent.dispatchContext && !generic) throw new Error("DISPATCH_CONTEXT_MISSING");
      // Admission side effects (e.g. activation withdrawal) must commit outside the claim transaction.
      this.validateDevice(intent);
      if (intent.kind === "start_turn" || this.options.beforeClaim) await this.options.beforeClaim?.(intent);
      if (this.stopped) return;
      const afterWait = this.execution.get(intent.id);
      if (!afterWait || afterWait.state !== "pending") {
        if (cancelledBeforeDispatch(afterWait)) await this.options.afterTerminal?.(afterWait!, { status: "cancelled", evidence: { kind: "not-dispatched" } });
        return;
      }
      intent = afterWait;
      this.validateDevice(intent);
      intent = this.execution.claim(intent.id, this.options.owner, (value) => this.validateDevice(value));
      await this.stage("after_claim", intent);
      if (this.stopped || this.execution.get(intent.id)?.state !== "claimed") {
        if (!this.stopped && cancelledBeforeDispatch(this.execution.get(intent.id))) await this.options.afterTerminal?.(intent, { status: "cancelled", evidence: { kind: "not-dispatched" } });
        return;
      }
      if (intent.dispatchContext) await this.options.beforeDispatch?.(intent, intent.dispatchContext);
      if (this.stopped) return;
      if (cancelledBeforeDispatch(this.execution.get(intent.id))) {
        await this.options.afterTerminal?.(intent, { status: "cancelled", evidence: { kind: "not-dispatched" } }); return;
      }
      this.validateDevice(this.execution.get(intent.id)!);
      intent = this.execution.transition({ id: intent.id, expectedStates: ["claimed"], state: "dispatching",
        expectedClaimOwnerId: this.options.owner.id, expectedClaimOwnerGeneration: this.options.owner.generation,
        attemptId: intent.attemptId, runtimeGeneration: intent.runtimeGeneration }, (value) => this.validateDevice(value));
      if (intent.dispatchContext) await this.options.onDispatch?.(intent, intent.dispatchContext);
      await this.stage("after_marker", intent);
      if (this.stopped || this.execution.get(intent.id)?.state !== "dispatching") return;
      // The marker may be followed by async internal hooks; recheck immediately
      // before the native invocation, with no await between validation and call.
      this.validateDevice(this.execution.get(intent.id)!);
      invoked = true;
      if (generic) {
        const result = await generic(intent);
        if (!this.stopped) await this.settleOperation(intent, result);
      } else if (intent.kind === "start_turn") {
        const payload = startPayload(intent.payload);
        const run = this.runtimes.begin(intent.dispatchContext!, payload);
        this.wake();
        const nativeOutcome = this.track("producer", () => run.outcome);
        const outcome = this.track("producer", async () => {
          let businessCommitted = false;
          try {
            const value = await deadline(nativeOutcome, this.options.outcomeTimeoutMs ?? 30 * 60_000,
              () => this.runtimes.unknown(intent.dispatchContext!, "PROVIDER_OUTCOME_TIMEOUT"));
            await this.options.drainIngestion();
            if (this.stopped) return;
            await this.stage("before_settle", intent);
            if (this.stopped) return;
            await this.options.onStartOutcome(intent, value);
            businessCommitted = true;
            if (this.stopped) return;
            if (value.evidence.kind !== "unknown") await this.options.afterTerminal?.(intent, value);
            if (this.stopped) return;
            this.runtimes.finish(intent.dispatchContext!, value);
          } catch (error) {
            if (!this.stopped) {
              if (businessCommitted) { this.runtimes.retainBinding(intent.dispatchContext!); this.options.failed?.(error, intent); }
              else await this.recordFailure(intent, error, true);
            }
          }
        });
        void outcome.catch((error) => this.options.failed?.(error, intent));
        if (run.accepted) {
          const acknowledged = this.track("producer", async () => {
            try {
              const evidence = await run.accepted!;
              if (this.stopped) return;
              const current = this.execution.get(intent.id);
              if (current?.state === "dispatching") this.execution.transition({ id: intent.id, expectedStates: ["dispatching"], state: "acknowledged",
                expectedClaimOwnerId: this.options.owner.id, expectedClaimOwnerGeneration: this.options.owner.generation,
                resultCode: "NATIVE_ACK", result: { evidence: { kind: "native-ack", sourceId: evidence.sourceId }, ...evidence },
                ...(evidence.nativeTurnId ? { nativeRequestId: evidence.nativeTurnId } : {}) });
              await this.stage("after_ack", intent);
            } catch (error) { if (error instanceof Error && error.message !== "NATIVE_ACK_UNAVAILABLE") this.options.failed?.(error, intent); }
          });
          void acknowledged.catch((error) => this.options.failed?.(error, intent));
        }
      } else {
        const handler = this.handlers.get(intent.kind);
        const nativeDelivery = this.track("control", async () => handler ? handler(intent, intent.dispatchContext!) : this.runtimes.control(intent.dispatchContext!, controlPayload(intent)));
        const value = await deadline(nativeDelivery, this.options.controlTimeoutMs ?? 15_000,
          () => ({ status: "outcome_unknown" as const, evidence: { kind: "unknown" as const, reason: "CONTROL_DELIVERY_TIMEOUT" } }));
        if (!this.stopped) await this.settleControl(intent, value);
        await this.options.drainIngestion();
      }
      await this.stage("after_call", intent);
    } catch (error) { if (!this.stopped) await this.recordFailure(intent, error, invoked); }
  }
  private async recordFailure(intent: ExecutionIntentRow, error: unknown, invoked: boolean): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const current = this.execution.get(intent.id);
    if (!invoked && cancelledBeforeDispatch(current)) {
      await this.options.afterTerminal?.(intent, { status: "cancelled", evidence: { kind: "not-dispatched" } }); return;
    }
    this.options.failed?.(error, intent);
    if (invoked && intent.dispatchContext) this.runtimes.retainUnknown(intent.dispatchContext);
    if (this.operationHandlers.has(intent.kind)) { await this.settleOperation(intent, {
      status: invoked ? "outcome_unknown" : "settled", resultCode: reason, result: { evidence: { kind: invoked ? "unknown" : "not-dispatched" } },
    }); return; }
    const evidence = invoked ? { kind: "unknown" as const, reason } : { kind: "not-dispatched" as const };
    if (intent.kind === "start_turn") {
      const outcome: ProviderOutcome = invoked ? { status: "outcome_unknown", error: reason, evidence }
        : { status: "failed", error: reason, evidence };
      await this.options.onStartOutcome(intent, outcome);
      if (this.stopped) return;
      if (outcome.evidence.kind !== "unknown") await this.options.afterTerminal?.(intent, outcome);
      if (this.stopped) return;
      if (intent.dispatchContext) this.runtimes.finish(intent.dispatchContext, outcome);
    } else await this.settleControl(intent, { status: invoked ? "outcome_unknown" : "not_dispatched", evidence, error: reason });
  }
  recover(): void {
    const scope = this.options.sessionId ? { sessionId: this.options.sessionId } : {};
    for (const state of ["claimed", "dispatching", "acknowledged"] as const) {
      for (const intent of this.execution.list({ ...scope, state, limit: 1000 })) {
        const reason = state === "claimed" ? "PRE_DISPATCH_OWNER_ENDED" : "DISPATCH_OUTCOME_UNPROVEN";
        const evidence = state === "claimed" ? { kind: "not-dispatched" as const } : { kind: "unknown" as const, reason };
        // Recovery commits are synchronous before scanning may dispatch pending work.
        const result = this.operationHandlers.has(intent.kind) ? this.settleOperation(intent, {
          status: state === "claimed" ? "settled" : "outcome_unknown", resultCode: reason, result: { evidence },
        }) : intent.kind === "start_turn" ? this.options.onStartOutcome(intent, state === "claimed"
          ? { status: "failed", error: reason, evidence } : { status: "outcome_unknown", error: reason, evidence })
          : this.settleControl(intent, { status: state === "claimed" ? "not_dispatched" : "outcome_unknown", evidence, error: reason });
        if (result && typeof (result as Promise<void>).then === "function") throw new Error("RECOVERY_COMMIT_MUST_BE_SYNCHRONOUS");
        if (state !== "claimed" && intent.dispatchContext) this.runtimes.retainUnknown(intent.dispatchContext);
      }
    }
  }
  private settleControl(intent: ExecutionIntentRow, outcome: ProviderControlOutcome): Promise<void> | void {
    return (this.controlSettlers.get(intent.kind) ?? this.options.onControlResult)(intent, outcome);
  }
  private settleOperation(intent: ExecutionIntentRow, result: OperationResult): Promise<void> | void {
    if (this.options.onOperationResult) return this.options.onOperationResult(intent, result);
    const current = this.execution.get(intent.id);
    const receipt = this.execution.store.getCommandReceipt(intent.authSubjectId, intent.commandId);
    if (!current || !receipt || receipt.state !== "accepted") return;
    this.execution.store.commitCommand({ sessionId: intent.sessionId, build: () => {
      const latest = this.execution.get(intent.id);
      if (!latest || latest.state === "settled" || latest.state === "outcome_unknown") return { result: undefined };
      const siblings = this.execution.forCommand(intent.authSubjectId, intent.commandId);
      const final = result.status === "outcome_unknown" || siblings.every((value) => value.id === intent.id || value.state === "settled");
      return { result: undefined, events: [{ type: "execution.operation.settled", payload: { intentId: intent.id, ...result } }],
        ...(final ? { receiptUpdates: [{ authSubjectId: intent.authSubjectId, commandId: intent.commandId, requestHash: intent.requestHash,
          state: result.status === "outcome_unknown" ? "outcome_unknown" as const : "completed" as const,
          response: { resultCode: result.resultCode, ...(result.result !== undefined ? { result: result.result } : {}) }, required: true }] }
          : { intentUpdates: [{ id: intent.id, expectedStates: [latest.state], state: "settled" as const, resultCode: result.resultCode, ...(result.result !== undefined ? { result: result.result } : {}) }] }),
      };
    } });
  }
  async recordUnknown(reason: string): Promise<void> {
    for (const intent of this.execution.list({ ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), limit: 1000 })) {
      if (!["claimed", "dispatching", "acknowledged"].includes(intent.state)) continue;
      await this.recordFailure(intent, new Error(reason), intent.state !== "claimed");
    }
  }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INTENT_PAYLOAD_INVALID"); return value as Record<string, unknown>; }
function startPayload(value: unknown): { prompt: string; resumeSessionId?: string } {
  const payload = object(value);
  if (typeof payload.prompt !== "string") throw new Error("INTENT_PAYLOAD_INVALID");
  return { prompt: payload.prompt, ...(typeof payload.resumeSessionId === "string" ? { resumeSessionId: payload.resumeSessionId } : {}) };
}
function controlPayload(intent: ExecutionIntentRow): { kind: "interrupt_turn"; reason: string } | { kind: "respond_approval"; approvalId: string; action: "allow_once" | "deny" } {
  const payload = object(intent.payload);
  if (intent.kind === "interrupt_turn") return { kind: "interrupt_turn", reason: typeof payload.reason === "string" ? payload.reason : "user_interrupt" };
  if (intent.kind === "respond_approval" && typeof payload.approvalId === "string" && ["allow_once", "deny"].includes(String(payload.action))) return {
    kind: "respond_approval", approvalId: payload.approvalId, action: payload.action as "allow_once" | "deny",
  };
  throw new Error("INTENT_KIND_UNSUPPORTED");
}

async function deadline<T>(operation: Promise<T>, milliseconds: number, timeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(timeout()), Math.max(0, milliseconds)); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
