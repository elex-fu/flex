import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { ExecutionStore } from "../storage/execution-store.js";
import { WORKTREE_COMMAND_METHODS } from "./host-worktrees.js";

/** ExecutionIntentState has no "accepted" member: a committed, not-yet-dispatched intent is durably pending. */
const DISPATCHABLE_INTENT_STATE = "pending" as const;
/** ExecutionStore.list clamps any scan to at most 1000 rows. */
const SCAN_LIMIT = 1000;

export type WorktreeSchedulerOptions = {
  store: ExecutionStore;
  owner: { id: string; generation: number };
  /** Production binding is HostWorktrees.dispatchAccepted, which performs the unique claim/dispatch CAS. */
  dispatch(intentId: string): Promise<unknown>;
  /** Fixed worktree command methods this scheduler may dispatch; everything else is left to its owner. */
  methods?: readonly string[];
  /** Actual concurrent dispatch budget; accepted work beyond it stays durably queued. */
  limit?: number;
  onDispatchError?(intent: ExecutionIntentRow, error: unknown): void;
};

/**
 * Host-level bounded dispatcher for committed, not-yet-dispatched managed-worktree intents.
 * It never loads a source Session runtime, never claims an intent itself, and never rewrites
 * durable intent state: dispatch failures leave the original pending row for explicit recovery.
 */
export class WorktreeScheduler {
  readonly limit: number;
  private readonly owner: { id: string; generation: number };
  private readonly methods: ReadonlySet<string>;
  private readonly queue: ExecutionIntentRow[] = [];
  private readonly scheduled = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private sealed = false;
  constructor(private readonly options: WorktreeSchedulerOptions) {
    const limit = options.limit ?? 2;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("WORKTREE_SCHEDULER_LIMIT_INVALID");
    this.limit = limit;
    // Snapshot the owner identity so later caller mutation cannot widen dispatch eligibility.
    this.owner = { id: options.owner.id, generation: options.owner.generation };
    this.methods = new Set(options.methods ?? WORKTREE_COMMAND_METHODS);
  }
  get isSealed(): boolean { return this.sealed; }
  get queued(): number { return this.queue.length; }
  get active(): number { return this.inFlight.size; }
  /** Post-commit wake for one durable intent; repeated wakes for the same id never double-dispatch it. */
  accepted(intent: ExecutionIntentRow): void {
    if (this.sealed) return;
    // Re-read the durable row: a stale in-memory copy must never widen owner or state eligibility.
    const committed = this.options.store.get(intent.id);
    if (committed && this.enqueue(committed)) this.pump();
  }
  /** Startup/recovery scan; returns how many durable intents were newly queued. */
  scan(): number {
    if (this.sealed) return 0;
    let queued = 0;
    for (const intent of this.options.store.list({ state: DISPATCHABLE_INTENT_STATE, limit: SCAN_LIMIT })) if (this.enqueue(intent)) queued++;
    if (queued) this.pump();
    return queued;
  }
  /** Idempotent synchronous callback fence; a queued-but-undispatched intent stays durably pending. */
  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    for (const intent of this.queue) this.scheduled.delete(intent.id);
    this.queue.length = 0;
  }
  /** Bounded wait for dispatches already running; it never starts queued work and never claims success. */
  async drain(deadlineMs = 5000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, deadlineMs);
    while (this.inFlight.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          Promise.allSettled([...this.inFlight]).then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
        ]);
        if (!drained) return false;
      } finally { if (timer) clearTimeout(timer); }
    }
    return true;
  }
  private eligible(intent: ExecutionIntentRow): boolean {
    if (this.sealed || intent.state !== DISPATCHABLE_INTENT_STATE || !this.methods.has(intent.kind)) return false;
    const context = intent.dispatchContext;
    return Boolean(context && context.hostOwnerId === this.owner.id && context.hostOwnerGeneration === this.owner.generation);
  }
  private enqueue(intent: ExecutionIntentRow): boolean {
    if (!this.eligible(intent) || this.scheduled.has(intent.id)) return false;
    this.scheduled.add(intent.id);
    this.queue.push(intent);
    return true;
  }
  /** Starts queued intents only while a permit is free; dispatch runs after the current commit stack unwinds. */
  private pump(): void {
    while (!this.sealed && this.queue.length && this.inFlight.size < this.limit) {
      const intent = this.queue.shift()!;
      const pending = Promise.resolve().then(() => this.options.dispatch(intent.id));
      this.inFlight.add(pending);
      void pending.then(
        () => this.finish(intent, pending, undefined),
        (error) => this.finish(intent, pending, error),
      );
    }
  }
  private finish(intent: ExecutionIntentRow, pending: Promise<unknown>, error: unknown): void {
    this.inFlight.delete(pending);
    this.scheduled.delete(intent.id);
    if (error !== undefined) { try { this.options.onDispatchError?.(intent, error); } catch { /* A failed observer never stalls the permit. */ } }
    this.pump();
  }
}
