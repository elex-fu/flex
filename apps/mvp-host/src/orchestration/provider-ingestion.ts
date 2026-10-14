import type { AdapterEvent } from "../provider/types.js";

/** Serial ingestion remains open while producers drain; sealing fences late callbacks. */
export class ProviderIngestion {
  private current: Promise<void> = Promise.resolve();
  private sealed = false;
  private accepting = true;
  private count = 0;
  constructor(private readonly options: {
    admit(event: AdapterEvent): boolean;
    handle(event: AdapterEvent): Promise<void> | void;
    observed?(event: AdapterEvent): void;
    failed(error: unknown, event: AdapterEvent): Promise<void> | void;
    track?<T>(operation: () => Promise<T>): Promise<T>;
    maxQueued?: number;
  }) {}
  get tail(): Promise<void> { return this.current; }
  get size(): number { return this.count; }
  seal(): void { this.sealed = true; }
  enqueue(input: AdapterEvent): Promise<void> {
    if (this.sealed || !this.accepting || !this.options.admit(input)) return this.current;
    const event = normalizeTerminal(input);
    if (this.count >= (this.options.maxQueued ?? 2048)) {
      this.accepting = false;
      const failure = async () => { await this.options.failed(new Error("INGESTION_QUEUE_FULL"), event); };
      this.current = this.current.then(() => this.options.track ? this.options.track(failure) : failure());
      return this.current;
    }
    this.count++;
    const run = async () => {
      try {
        if (this.sealed || !this.options.admit(event)) return;
        await this.options.handle(event);
        this.options.observed?.(event);
      } catch (error) { await this.options.failed(error, event); }
      finally { this.count--; }
    };
    this.current = this.current.then(() => this.options.track ? this.options.track(run) : run());
    return this.current;
  }
  async drain(): Promise<void> {
    for (;;) { const tail = this.current; await tail; if (tail === this.current) return; }
  }
}

function normalizeTerminal(event: AdapterEvent): AdapterEvent {
  if (event.kind !== "turn_failed" || event.terminalEvidence) return event;
  if (["client_start_failed", "thread_start_failed"].includes(event.subtype)) return { ...event, terminalEvidence: { kind: "not-dispatched" } };
  if (["turn_start_failed", "stream_ended_without_result"].includes(event.subtype)) return {
    kind: "diagnostic", dispatchContext: event.dispatchContext, generation: event.generation, turnId: event.turnId,
    code: "PROVIDER_TERMINAL_UNPROVEN", message: event.errors.join("; ") || event.subtype,
  };
  return event;
}
