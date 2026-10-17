export type HostReadiness = "booting" | "read_only" | "ready" | "draining" | "stopped" | "recovery_required";

export type ShutdownResult = { stopped: boolean; recoveryRequired: boolean };
export type HostLifecycleHooks = {
  stopAdmission(): void;
  stopDispatch(): void;
  stopProducers(deadlineMs: number): Promise<{ stopped: boolean }>;
  drainIngestion(deadlineMs: number): Promise<boolean>;
  drainOperations(deadlineMs: number): Promise<boolean>;
  drainServices?(deadlineMs: number): Promise<boolean>;
  fenceCallbacks(): void;
  recordUnknown(reason: string): Promise<void> | void;
  retainOwnership(reason: string): void;
  closeTransports(): Promise<void>;
  sealJournal?(): void;
  closeStore(): Promise<void> | void;
  releaseOwnership(): void;
};

/** One shared shutdown Promise owns the producer → ingestion → Store close order. */
export class HostLifecycle {
  private state: HostReadiness = "booting";
  private shutdownPromise: Promise<ShutdownResult> | undefined;
  constructor(private readonly hooks: HostLifecycleHooks, private readonly deadlineMs = 5_000) {}
  get readiness(): HostReadiness { return this.state; }
  markReady(writable: boolean): void {
    if (this.shutdownPromise) throw new Error("HOST_DRAINING");
    this.state = writable ? "ready" : "read_only";
  }
  assertWritable(): void { if (this.state !== "ready") throw new Error("HOST_NOT_WRITABLE"); }
  shutdown(deadlineMs = this.deadlineMs): Promise<ShutdownResult> {
    this.shutdownPromise ??= this.shutdownInternal(deadlineMs);
    return this.shutdownPromise;
  }
  private async shutdownInternal(deadlineMs: number): Promise<ShutdownResult> {
    this.state = "draining";
    this.hooks.stopAdmission();
    this.hooks.stopDispatch();
    let safe = false;
    let failure: unknown;
    try {
      const producers = await bounded(this.hooks.stopProducers(deadlineMs), deadlineMs, { stopped: false });
      const ingestion = await bounded(this.hooks.drainIngestion(deadlineMs), deadlineMs, false);
      const operations = await bounded(this.hooks.drainOperations(deadlineMs), deadlineMs, false);
      const services = this.hooks.drainServices ? await bounded(this.hooks.drainServices(deadlineMs), deadlineMs, false) : true;
      safe = producers.stopped && ingestion && operations && services;
      this.hooks.fenceCallbacks();
      if (!safe) {
        this.hooks.retainOwnership("SHUTDOWN_STOP_UNPROVEN");
        await bounded(this.hooks.recordUnknown("SHUTDOWN_STOP_UNPROVEN"), deadlineMs, undefined);
      }
    } catch (error) {
      failure = error;
      this.hooks.fenceCallbacks();
      this.hooks.retainOwnership("SHUTDOWN_FAILED");
      try { await bounded(this.hooks.recordUnknown("SHUTDOWN_FAILED"), deadlineMs, undefined); } catch { /* retained journal is the fallback */ }
    }
    try { await boundedOrThrow(this.hooks.closeTransports(), deadlineMs); }
    catch (error) { failure ??= error; safe = false; this.hooks.retainOwnership("SHUTDOWN_CLOSE_FAILED"); }
    try {
      this.hooks.sealJournal?.();
    } catch (error) { failure ??= error; safe = false; this.hooks.retainOwnership("SHUTDOWN_CLOSE_FAILED"); }
    try {
      await boundedOrThrow(this.hooks.closeStore(), deadlineMs);
      if (safe && !failure) this.hooks.releaseOwnership();
    } catch (error) { failure ??= error; safe = false; this.hooks.retainOwnership("SHUTDOWN_CLOSE_FAILED"); }
    this.state = safe && !failure ? "stopped" : "recovery_required";
    if (failure) throw failure;
    return { stopped: safe, recoveryRequired: !safe };
  }
}

async function bounded<T>(work: Promise<T> | T, deadlineMs: number, timeoutValue: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(timeoutValue), Math.max(0, deadlineMs)); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function boundedOrThrow(work: Promise<void> | void, deadlineMs: number): Promise<void> {
  const timeout = Symbol("timeout");
  const result = await bounded(Promise.resolve(work).then(() => undefined as typeof timeout | undefined), deadlineMs, timeout);
  if (result === timeout) throw new Error("HOST_SHUTDOWN_DEADLINE");
}
