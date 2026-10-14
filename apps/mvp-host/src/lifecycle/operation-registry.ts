export type OperationKind = "producer" | "control" | "ingestion" | "checkpoint";

/** Tracks completion without making long running producers occupy the control lane. */
export class OperationRegistry {
  private readonly active = new Map<Promise<unknown>, OperationKind>();
  private draining = false;
  private sealed = false;

  beginDrain(): void { this.draining = true; }
  seal(): void { this.sealed = true; }
  get size(): number { return this.active.size; }

  track<T>(kind: OperationKind, operation: () => Promise<T>): Promise<T> {
    if (this.sealed || (this.draining && kind === "producer")) {
      return Promise.reject(new Error("HOST_DRAINING"));
    }
    // Register before invoking the producer: synchronous callbacks may enqueue ingestion.
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const tracked = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.active.set(tracked, kind);
    void tracked.then(() => this.active.delete(tracked), () => this.active.delete(tracked));
    try { Promise.resolve(operation()).then(resolve, reject); } catch (error) { reject(error); }
    return tracked;
  }

  async drain(kinds: readonly OperationKind[], deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, deadlineMs);
    for (;;) {
      const pending = [...this.active].filter(([, kind]) => kinds.includes(kind)).map(([promise]) => promise);
      if (pending.length === 0) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!completed) return false;
      // Re-read: the completed operations may have registered terminal/checkpoint work.
    }
  }
}
