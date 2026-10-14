import { dispatchContextForTurn } from "./types.js";
import type { AdapterEvent, DispatchContext, ProviderAcceptance, ProviderAdapter, ProviderControlOutcome, ProviderOutcome, ProviderRun, TurnOutcome } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A native ACK is optional; attach a handler even if the worker only awaits outcome.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
type Runtime = { adapter: ProviderAdapter; context?: DispatchContext | undefined; terminal?: AdapterEvent | undefined; acceptance?: ReturnType<typeof deferred<ProviderAcceptance>> | undefined; unknown: boolean };
export function sameDispatchContext(a: DispatchContext | undefined, b: DispatchContext | undefined): boolean {
  return !!a && !!b && a.hostOwnerId === b.hostOwnerId && a.hostOwnerGeneration === b.hostOwnerGeneration
    && a.sessionId === b.sessionId && a.flyxTurnId === b.flyxTurnId && a.runtimeId === b.runtimeId
    && a.runtimeGeneration === b.runtimeGeneration && a.attemptId === b.attemptId;
}

/** Owns runtime bindings and retains uncertain attempts until explicit recovery. */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  constructor(private readonly options: { drainIngestion?(): Promise<void> } = {}) {}
  register(runtimeId: string, adapter: ProviderAdapter): void {
    if (this.runtimes.has(runtimeId)) throw new Error("RUNTIME_ALREADY_REGISTERED");
    this.runtimes.set(runtimeId, { adapter, unknown: false });
  }
  isBusy(runtimeId: string): boolean { const runtime = this.runtimes.get(runtimeId); return !!runtime?.context || !!runtime?.unknown; }
  matches(context: DispatchContext): boolean { return sameDispatchContext(this.runtimes.get(context.runtimeId)?.context, context); }
  begin(contextInput: DispatchContext, input: { prompt: string; resumeSessionId?: string }): ProviderRun {
    const context = dispatchContextForTurn(contextInput.flyxTurnId, contextInput);
    const runtime = this.runtimes.get(context.runtimeId);
    if (!runtime) throw new Error("RUNTIME_NOT_FOUND");
    if (runtime.context || runtime.unknown) throw new Error("RUNTIME_BUSY");
    runtime.context = context;
    runtime.terminal = undefined;
    runtime.acceptance = deferred<ProviderAcceptance>();
    let source: { accepted?: Promise<ProviderAcceptance>; outcome: Promise<TurnOutcome> };
    try {
      source = runtime.adapter.beginTurn?.(context, input.prompt, input.resumeSessionId) ?? {
        ...(runtime.adapter.provider === "codex" ? { accepted: runtime.acceptance.promise } : {}),
        outcome: Promise.resolve(runtime.adapter.runTurn(context.flyxTurnId, input.prompt, input.resumeSessionId, context)),
      };
    } catch (error) {
      source = { outcome: Promise.resolve(this.unknown(context, error)) };
    }
    const outcome = source.outcome.then(async (value) => { await this.options.drainIngestion?.(); return this.classify(context, value); }, (error) => this.unknown(context, error))
      .then((value) => { runtime.acceptance?.reject(new Error("NATIVE_ACK_UNAVAILABLE")); return value; });
    const accepted = source.accepted ? Promise.race([source.accepted, outcome.then(() => { throw new Error("NATIVE_ACK_UNAVAILABLE"); })]) : undefined;
    return { ...(accepted ? { accepted } : {}), outcome };
  }
  observe(event: AdapterEvent): void {
    const runtime = this.runtimes.get(event.dispatchContext?.runtimeId);
    if (!runtime || !sameDispatchContext(runtime.context, event.dispatchContext)) return;
    if (event.kind === "native_binding") runtime.acceptance?.resolve({ nativeSessionId: event.nativeSessionId, nativeTurnId: event.nativeTurnId,
      sourceId: event.nativeTurnId });
    if (["turn_completed", "turn_failed", "turn_cancelled"].includes(event.kind)) runtime.terminal = event;
  }
  classify(context: DispatchContext, value: TurnOutcome): ProviderOutcome {
    if (this.runtimes.get(context.runtimeId)?.unknown) return this.unknown(context, "RUNTIME_RECOVERY_REQUIRED");
    if (value.evidence?.kind === "native-terminal" && value.status !== "outcome_unknown") return { ...value, evidence: value.evidence };
    if (value.evidence?.kind === "not-dispatched" && ["failed", "cancelled"].includes(value.status)) return { ...value, evidence: value.evidence };
    if (value.evidence?.kind === "unknown" || value.status === "outcome_unknown") return this.unknown(context, "error" in value ? value.error : "Provider outcome is unknown");
    const terminal = this.runtimes.get(context.runtimeId)?.terminal;
    if (terminal && sameDispatchContext(terminal.dispatchContext, context)) {
      if (terminal.terminalEvidence?.kind === "not-dispatched" && value.status !== "completed") return { ...value, evidence: terminal.terminalEvidence };
      if (!terminal.terminalEvidence || terminal.terminalEvidence.kind === "native-terminal") return { ...value,
        evidence: terminal.terminalEvidence ?? { kind: "native-terminal", sourceId: terminal.nativeItemId ?? context.attemptId } };
    }
    return this.unknown(context, "error" in value ? value.error : "Provider returned no terminal evidence");
  }
  unknown(_context: DispatchContext, error: unknown): ProviderOutcome {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "outcome_unknown", error: reason, evidence: { kind: "unknown", reason } };
  }
  finish(context: DispatchContext, outcome: ProviderOutcome): void {
    const runtime = this.runtimes.get(context.runtimeId);
    if (!runtime || !sameDispatchContext(runtime.context, context)) return;
    if (outcome.evidence.kind === "unknown") { runtime.unknown = true; return; }
    if (runtime.unknown) return;
    runtime.context = undefined;
    runtime.terminal = undefined;
    runtime.acceptance = undefined;
  }
  /** Called only after the recovery service commits its verified terminal fact. */
  reconcileVerified(context: DispatchContext, outcome: ProviderOutcome): void {
    if (outcome.status === "outcome_unknown" || outcome.evidence.kind === "unknown") throw new Error("RUNTIME_RECOVERY_EVIDENCE_REQUIRED");
    const runtime = this.runtimes.get(context.runtimeId);
    if (!runtime || !sameDispatchContext(runtime.context, context)) throw new Error("RUNTIME_RECOVERY_CONTEXT_MISMATCH");
    runtime.unknown = false;
    this.finish(context, outcome);
  }
  retainUnknown(context: DispatchContext): void {
    const runtime = this.runtimes.get(context.runtimeId);
    if (runtime) { runtime.context ??= context; runtime.unknown = true; }
  }
  async control(context: DispatchContext, command: { kind: "interrupt_turn"; reason: string } | { kind: "respond_approval"; approvalId: string; action: "allow_once" | "deny" }): Promise<ProviderControlOutcome> {
    const runtime = this.runtimes.get(context.runtimeId);
    if (!runtime || !sameDispatchContext(runtime.context, context)) return { status: "not_dispatched", evidence: { kind: "not-dispatched" }, error: "RUNTIME_BINDING_UNAVAILABLE" };
    if (runtime.adapter.deliverControl) return runtime.adapter.deliverControl(context, command);
    try {
      if (command.kind === "respond_approval") {
        const delivered = runtime.adapter.respondApproval(command.approvalId, command.action);
        return delivered ? { status: "delivered", evidence: { kind: "local-delivery" } }
          : { status: "outcome_unknown", evidence: { kind: "unknown", reason: "APPROVAL_DELIVERY_UNCONFIRMED" } };
      }
      const delivered = await runtime.adapter.interrupt(command.reason);
      if (delivered === "accepted") return { status: "delivered", evidence: { kind: "local-delivery" } };
      if (delivered === "already_terminal") {
        await this.options.drainIngestion?.();
        const terminal = runtime.terminal;
        if (terminal?.terminalEvidence?.kind === "not-dispatched") return { status: "not_dispatched", evidence: terminal.terminalEvidence };
        if (terminal && (!terminal.terminalEvidence || terminal.terminalEvidence.kind === "native-terminal")) return {
          status: "already_terminal", evidence: terminal.terminalEvidence ?? { kind: "native-terminal", sourceId: context.attemptId },
        };
      }
      return { status: "outcome_unknown", evidence: { kind: "unknown", reason: "INTERRUPT_DELIVERY_UNCONFIRMED" } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: "outcome_unknown", evidence: { kind: "unknown", reason } };
    }
  }
}
