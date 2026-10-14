/** Bounded per-runtime delivery; outcome waiting never enters this lane. */
export class ControlLane {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(readonly maxQueued = 64) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new Error("INVALID_CONTROL_BUDGET");
  }
  get size(): number { return this.pending.size; }
  hasCapacity(): boolean { return this.pending.size < this.maxQueued; }
  submit<T>(runtimeId: string, deliver: () => Promise<T> | T): Promise<T> {
    if (!this.hasCapacity()) return Promise.reject(new Error("CONTROL_QUEUE_FULL"));
    const next = (this.tails.get(runtimeId) ?? Promise.resolve()).then(deliver);
    const tail = next.then(() => undefined, () => undefined);
    this.tails.set(runtimeId, tail);
    this.pending.add(next);
    void tail.then(() => { this.pending.delete(next); if (this.tails.get(runtimeId) === tail) this.tails.delete(runtimeId); });
    return next;
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
