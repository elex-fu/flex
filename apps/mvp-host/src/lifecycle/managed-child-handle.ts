import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Narrow process contract shared by the local Node backend and the future
 * macOS supervisor client. It deliberately re-exposes only what Flyx callers
 * (Claude, Codex, Git/helper queries) actually consume: the original root
 * identity, stdio pipes, terminal observations, a cancellation request and a
 * bounded wait. It is not a `ChildProcess`, so a supervisor adapter can
 * implement it without fabricating one.
 */

export type ManagedChildExit = {
  /** Exit code of the original root process; `null` when it was signal-terminated or never spawned. */
  readonly code: number | null;
  /** Signal that terminated the original root process; `null` when it exited with a code. */
  readonly signal: NodeJS.Signals | null;
};

export type ManagedChildExitListener = (exit: ManagedChildExit) => void;
export type ManagedChildErrorListener = (error: Error) => void;

export const MANAGED_CHILD_EVIDENCE_VERSION = 1;

/**
 * Versioned raw observation produced by a concrete process backend. Variants
 * stay backend-specific (`backend` discriminator) and consumers must reject
 * unknown versions instead of guessing. Raw evidence is an observation, never
 * a stop proof and never a descendant-stop claim.
 */
export type ManagedChildRawEvidence =
  | { readonly version: 1; readonly backend: "node_child_process"; readonly observation: "spawn"; readonly pid: number }
  | { readonly version: 1; readonly backend: "node_child_process"; readonly observation: "exit"; readonly pid: number; readonly exit: ManagedChildExit };

export function managedChildSpawnEvidence(pid: number): ManagedChildRawEvidence {
  return Object.freeze({ version: MANAGED_CHILD_EVIDENCE_VERSION, backend: "node_child_process", observation: "spawn", pid } as const);
}

export function managedChildExitEvidence(pid: number, exit: ManagedChildExit): ManagedChildRawEvidence {
  return Object.freeze({ version: MANAGED_CHILD_EVIDENCE_VERSION, backend: "node_child_process", observation: "exit", pid, exit: Object.freeze({ code: exit.code, signal: exit.signal }) } as const);
}

/** A failed launch never observed a root PID; the terminal value is explicitly not a normal exit. */
export const MANAGED_CHILD_UNSPAWNED_EXIT: ManagedChildExit = Object.freeze({ code: null, signal: null });

export interface ManagedChildHandle {
  /** Immutable journal record identity; committed before the OS spawn boundary. */
  readonly id: string;
  /** Raw root PID. `undefined` until a real OS process exists; never synthesized for a failed launch. */
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /**
   * Settles when the original root process exited or the launch definitively
   * failed before an OS process existed. A failed launch settles with
   * `{ code: null, signal: null }`; it never fabricates a normal exit.
   */
  readonly exited: Promise<ManagedChildExit>;
  /**
   * Versioned raw evidence observed so far (spawn, then optionally exit).
   * Listeners attached after a terminal observation still receive it once.
   */
  rawEvidence(): readonly ManagedChildRawEvidence[];
  on(event: "exit", listener: ManagedChildExitListener): this;
  on(event: "error", listener: ManagedChildErrorListener): this;
  once(event: "exit", listener: ManagedChildExitListener): this;
  once(event: "error", listener: ManagedChildErrorListener): this;
  off(event: "exit", listener: ManagedChildExitListener): this;
  off(event: "error", listener: ManagedChildErrorListener): this;
  /**
   * Request cancellation of the original root (process group when grouped).
   * The boolean only reports whether a signal request was issued; it is never
   * an exit or descendant-stop proof.
   */
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * Bounded observation of the original root. Resolves with the exit once
   * observed, or `undefined` when the deadline passes first. A deadline of `0`
   * only reports an already observed exit.
   */
  waitForExit(deadlineMs: number): Promise<ManagedChildExit | undefined>;
  /**
   * Detach this Host's local pipes/IPC handles. This is local cleanup only and
   * produces no stop evidence; `exited` still waits for the real observation.
   */
  dispose(): void;
}

/**
 * Shared observation bookkeeping. Terminal observations are retained and
 * replayed to every later registration, so a backend observation that raced
 * ahead of registration is never lost and never invented.
 */
class ManagedChildObservations {
  private readonly exitListeners = new Set<ManagedChildExitListener>();
  private readonly errorListeners = new Set<ManagedChildErrorListener>();
  private readonly exitedPromise: Promise<ManagedChildExit>;
  private resolveExited!: (exit: ManagedChildExit) => void;
  protected exitObservation: ManagedChildExit | undefined;
  protected errorObservation: Error | undefined;

  constructor() {
    this.exitedPromise = new Promise<ManagedChildExit>((resolve) => { this.resolveExited = resolve; });
  }

  get exited(): Promise<ManagedChildExit> { return this.exitedPromise; }

  on(event: "exit", listener: ManagedChildExitListener): this;
  on(event: "error", listener: ManagedChildErrorListener): this;
  on(event: "exit" | "error", listener: ManagedChildExitListener | ManagedChildErrorListener): this {
    if (event === "exit") {
      this.exitListeners.add(listener as ManagedChildExitListener);
      if (this.exitObservation) (listener as ManagedChildExitListener)(this.exitObservation);
    } else {
      this.errorListeners.add(listener as ManagedChildErrorListener);
      if (this.errorObservation) (listener as ManagedChildErrorListener)(this.errorObservation);
    }
    return this;
  }

  once(event: "exit", listener: ManagedChildExitListener): this;
  once(event: "error", listener: ManagedChildErrorListener): this;
  once(event: "exit" | "error", listener: ManagedChildExitListener | ManagedChildErrorListener): this {
    if (event === "exit") {
      const wrapped: ManagedChildExitListener = (exit) => { this.exitListeners.delete(wrapped); (listener as ManagedChildExitListener)(exit); };
      return this.on("exit", wrapped);
    }
    const wrapped: ManagedChildErrorListener = (error) => { this.errorListeners.delete(wrapped); (listener as ManagedChildErrorListener)(error); };
    return this.on("error", wrapped);
  }

  off(event: "exit", listener: ManagedChildExitListener): this;
  off(event: "error", listener: ManagedChildErrorListener): this;
  off(event: "exit" | "error", listener: ManagedChildExitListener | ManagedChildErrorListener): this {
    if (event === "exit") this.exitListeners.delete(listener as ManagedChildExitListener);
    else this.errorListeners.delete(listener as ManagedChildErrorListener);
    return this;
  }

  async waitForExit(deadlineMs: number): Promise<ManagedChildExit | undefined> {
    if (this.exitObservation) return this.exitObservation;
    if (!(deadlineMs > 0)) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exitedPromise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), deadlineMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  protected observeExit(exit: ManagedChildExit): void {
    if (this.exitObservation) return;
    this.exitObservation = Object.freeze({ code: exit.code, signal: exit.signal });
    this.resolveExited(this.exitObservation);
    for (const listener of [...this.exitListeners]) listener(this.exitObservation);
  }

  protected observeError(error: Error, terminalWithoutPid: boolean): void {
    if (this.errorObservation || this.exitObservation) return;
    this.errorObservation = error instanceof Error ? error : new Error(String(error));
    // A launch failure without a PID is terminal: no OS process was created.
    // It settles as "never spawned", which is never a normal exit.
    if (terminalWithoutPid) this.observeExit(MANAGED_CHILD_UNSPAWNED_EXIT);
    for (const listener of [...this.errorListeners]) listener(this.errorObservation);
  }
}

class NodeManagedChildHandle extends ManagedChildObservations implements ManagedChildHandle {
  readonly id: string;
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  private readonly child: ChildProcess;
  private readonly grouped: boolean;
  private disposed = false;

  constructor(options: { id: string; child: ChildProcess; grouped?: boolean }) {
    super();
    this.id = options.id;
    this.child = options.child;
    this.grouped = options.grouped === true;
    this.pid = options.child.pid;
    this.stdin = options.child.stdin ?? null;
    this.stdout = options.child.stdout ?? null;
    this.stderr = options.child.stderr ?? null;
    this.child.once("exit", (code, signal) => this.observeExit({ code, signal }));
    this.child.once("error", (error) => this.observeError(error, this.pid === undefined));
  }

  rawEvidence(): readonly ManagedChildRawEvidence[] {
    const evidence: ManagedChildRawEvidence[] = [];
    if (this.pid !== undefined) evidence.push(managedChildSpawnEvidence(this.pid));
    if (this.exitObservation && this.pid !== undefined) evidence.push(managedChildExitEvidence(this.pid, this.exitObservation));
    return Object.freeze(evidence);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.disposed || this.pid === undefined || this.exitObservation) return false;
    try {
      if (this.grouped) process.kill(-this.pid, signal);
      else this.child.kill(signal);
      return true;
    } catch {
      // A signal request is not an exit proof; failures stay silent here.
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.stdin?.destroy(); } catch { /* Handle cleanup is not process proof. */ }
    try { this.stdout?.destroy(); } catch { /* Handle cleanup is not process proof. */ }
    try { this.stderr?.destroy(); } catch { /* Handle cleanup is not process proof. */ }
    try { if (this.child.connected) this.child.disconnect(); } catch { /* IPC may already be closed. */ }
    try { this.child.unref(); } catch { /* Detached handles never become stop evidence. */ }
  }
}

/** Wrap a real Node `ChildProcess` as the narrow handle without inventing any fact. */
export function adoptNodeChildProcess(options: { id: string; child: ChildProcess; grouped?: boolean }): ManagedChildHandle {
  return new NodeManagedChildHandle(options);
}

class FailedManagedChildHandle extends ManagedChildObservations implements ManagedChildHandle {
  readonly id: string;
  readonly pid = undefined;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;

  constructor(options: { error: Error; id?: string }) {
    super();
    this.id = options.id ?? randomUUID();
    this.observeError(options.error, true);
  }

  rawEvidence(): readonly ManagedChildRawEvidence[] { return Object.freeze([]); }
  kill(_signal?: NodeJS.Signals): boolean { return false; }
  dispose(): void { /* No local OS handle was ever created. */ }
}

/**
 * Handle for a launch that failed before an OS process could be observed
 * (preparation/commit/registration failure). The caller gets a real handle
 * that emits `error`; it has no PID, no streams, no raw launch evidence and no
 * normal exit. It must never be presented as a successful spawn.
 */
export function failedChildHandle(options: { error: Error; id?: string }): ManagedChildHandle {
  return new FailedManagedChildHandle(options);
}
