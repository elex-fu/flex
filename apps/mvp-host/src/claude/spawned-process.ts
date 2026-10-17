import { PassThrough, type Readable, type Writable } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { failedChildHandle, type ManagedChildErrorListener, type ManagedChildExit, type ManagedChildExitListener, type ManagedChildHandle } from "../lifecycle/managed-child-handle.js";

type ClaudeExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ClaudeErrorListener = (error: Error) => void;

/**
 * Facade that satisfies the locked Claude SDK `SpawnedProcess` contract by
 * delegating to the narrow `ManagedChildHandle`. It never fabricates a Node
 * `ChildProcess`: the SDK only needs stdio streams, exit/error registration,
 * `killed`/`exitCode` reads and a kill request, all of which the narrow handle
 * can answer without exposing raw Node identity. The SDK does not consume a
 * PID, so none is exposed here.
 */
class ClaudeSpawnedProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly handle: ManagedChildHandle;
  private readonly exitOnWrappers = new Map<ClaudeExitListener, ManagedChildExitListener>();
  private readonly exitOnceWrappers = new Map<ClaudeExitListener, ManagedChildExitListener>();
  private exitObservation: ManagedChildExit | undefined;
  private killRequested = false;

  constructor(handle: ManagedChildHandle, stdin: Writable, stdout: Readable) {
    this.handle = handle;
    this.stdin = stdin;
    this.stdout = stdout;
    // Registered before any consumer listener: `exitCode`/`signalCode` must
    // already read the terminal observation when the SDK's exit handler runs.
    handle.on("exit", (exit) => { this.exitObservation = exit; });
  }

  get killed(): boolean { return this.killRequested; }
  get exitCode(): number | null { return this.exitObservation?.code ?? null; }
  get signalCode(): NodeJS.Signals | null { return this.exitObservation?.signal ?? null; }

  kill(signal: NodeJS.Signals): boolean {
    const issued = this.handle.kill(signal);
    if (issued) this.killRequested = true;
    return issued;
  }

  on(event: "exit", listener: ClaudeExitListener): void;
  on(event: "error", listener: ClaudeErrorListener): void;
  on(event: "exit" | "error", listener: ClaudeExitListener | ClaudeErrorListener): void {
    if (event === "exit") this.handle.on("exit", this.exitOnWrapper(listener as ClaudeExitListener));
    else this.handle.on("error", listener as ClaudeErrorListener);
  }

  once(event: "exit", listener: ClaudeExitListener): void;
  once(event: "error", listener: ClaudeErrorListener): void;
  once(event: "exit" | "error", listener: ClaudeExitListener | ClaudeErrorListener): void {
    if (event === "exit") this.handle.once("exit", this.exitOnceWrapper(listener as ClaudeExitListener));
    else this.handle.once("error", listener as ClaudeErrorListener);
  }

  off(event: "exit", listener: ClaudeExitListener): void;
  off(event: "error", listener: ClaudeErrorListener): void;
  off(event: "exit" | "error", listener: ClaudeExitListener | ClaudeErrorListener): void {
    if (event === "exit") {
      const target = listener as ClaudeExitListener;
      const on = this.exitOnWrappers.get(target);
      const once = this.exitOnceWrappers.get(target);
      this.exitOnWrappers.delete(target);
      this.exitOnceWrappers.delete(target);
      if (on) this.handle.off("exit", on);
      if (once) this.handle.off("exit", once);
      return;
    }
    this.handle.off("error", listener as ClaudeErrorListener);
  }

  /**
   * The narrow handle reports one structured exit while the SDK contract uses
   * the Node `(code, signal)` shape. Wrappers are memoized per listener so
   * `off(listener)` removes the exact function that was registered.
   */
  private exitOnWrapper(listener: ClaudeExitListener): ManagedChildExitListener {
    const existing = this.exitOnWrappers.get(listener);
    if (existing) return existing;
    const wrapper: ManagedChildExitListener = (exit) => listener(exit.code, exit.signal);
    this.exitOnWrappers.set(listener, wrapper);
    return wrapper;
  }

  private exitOnceWrapper(listener: ClaudeExitListener): ManagedChildExitListener {
    const existing = this.exitOnceWrappers.get(listener);
    if (existing) return existing;
    const wrapper: ManagedChildExitListener = (exit) => {
      this.exitOnceWrappers.delete(listener);
      listener(exit.code, exit.signal);
    };
    this.exitOnceWrappers.set(listener, wrapper);
    return wrapper;
  }
}

/**
 * The Claude spawn callback is synchronous while prepare/commit/release may
 * still be settling. When the launch was observed with the requested pipes the
 * facade forwards the narrow handle directly. When preparation, journaling or
 * registration failed before any OS process could be observed, the callback
 * must not throw a fabricated success: it returns a bounded facade that emits
 * `error`, has no PID, no raw launch evidence and no normal exit.
 */
export function claudeSpawnedProcess(handle: ManagedChildHandle): SpawnedProcess {
  if (!handle.stdin || !handle.stdout) throw new Error("CLAUDE_SPAWN_STDIO_UNAVAILABLE");
  return new ClaudeSpawnedProcess(handle, handle.stdin, handle.stdout);
}

export function failedClaudeSpawnedProcess(error: Error): SpawnedProcess {
  const handle = failedChildHandle({ error });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.end();
  return new ClaudeSpawnedProcess(handle, stdin, stdout);
}
