export type HostExecutionPermit = {
  readonly executionId: string;
  /** Unknown stop outcomes keep capacity reserved for the original execution. */
  release(outcome: { producerStopped: boolean }): boolean;
  retain(reason?: string): void;
};
type Waiter = { id: string; resolve(value: HostExecutionPermit): void; reject(reason: Error): void; signal?: AbortSignal; abort?: () => void };

/** Host-wide task capacity. Control commands never acquire this permit. */
export class HostExecutionPermits {
  readonly limit: number;
  private readonly held = new Map<string, HostExecutionPermit>();
  private readonly waiters: Waiter[] = [];
  private sealed = false;
  private readonly changed = new Set<() => void>();
  constructor(options: { limit?: number } = {}) {
    this.limit = options.limit ?? 2;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error("HOST_EXECUTION_PERMIT_LIMIT_INVALID");
  }
  get active(): number { return this.held.size; }
  get queued(): number { return this.waiters.length; }
  get isSealed(): boolean { return this.sealed; }
  acquire(executionId: string, options: { signal?: AbortSignal } = {}): Promise<HostExecutionPermit> {
    try { assertTaskPermitLockOrder(); } catch (error) { return Promise.reject(error); }
    if (!executionId) return Promise.reject(new Error("HOST_EXECUTION_ID_REQUIRED"));
    if (this.sealed) return Promise.reject(new Error("HOST_EXECUTION_PERMITS_SEALED"));
    if (options.signal?.aborted) return Promise.reject(new Error("HOST_EXECUTION_PERMIT_CANCELLED"));
    if (this.held.has(executionId) || this.waiters.some((waiter) => waiter.id === executionId)) return Promise.reject(new Error("HOST_EXECUTION_PERMIT_DUPLICATE"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { id: executionId, resolve, reject, ...(options.signal ? { signal: options.signal } : {}) };
      if (waiter.signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          // An abort after grant cannot silently return a live producer's permit.
          if (index < 0) return;
          this.waiters.splice(index, 1); this.detach(waiter);
          reject(new Error("HOST_EXECUTION_PERMIT_CANCELLED")); this.pump();
        };
        waiter.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter); this.pump();
    });
  }
  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    for (const waiter of this.waiters.splice(0)) { this.detach(waiter); waiter.reject(new Error("HOST_EXECUTION_PERMITS_SEALED")); }
    this.notify();
  }
  async drain(deadlineMs = 5000): Promise<boolean> {
    if (!this.active) return true;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const check = () => { if (!this.active) { clearTimeout(timer); this.changed.delete(check); resolve(true); } };
      timer = setTimeout(() => { this.changed.delete(check); resolve(false); }, Math.max(0, deadlineMs));
      this.changed.add(check); check();
    });
  }
  private detach(waiter: Waiter): void { if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort); }
  private notify(): void { for (const callback of this.changed) callback(); }
  private pump(): void {
    while (!this.sealed && this.waiters.length && this.active < this.limit) {
      const waiter = this.waiters.shift()!; this.detach(waiter);
      let released = false;
      const permit: HostExecutionPermit = Object.freeze({ executionId: waiter.id,
        release: (outcome: { producerStopped: boolean }): boolean => {
          if (released) return true;
          if (outcome.producerStopped !== true) return false;
          released = true; this.held.delete(waiter.id); this.pump(); this.notify(); return true;
        },
        retain: (_reason?: string): void => { /* Capacity remains held until explicit verified stop. */ },
      });
      this.held.set(waiter.id, permit); waiter.resolve(permit);
    }
    this.notify();
  }
}
import { assertTaskPermitLockOrder } from "./repository-metadata-lock.js";

