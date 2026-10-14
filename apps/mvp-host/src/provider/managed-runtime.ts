import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ManagedProcessRegistry, type ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import type { DispatchContext } from "./types.js";
import { dispatchContextForTurn } from "./types.js";

export type NativeSpawnRequest = Omit<SpawnOptions, "cwd" | "env"> & { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv };
export interface ProviderExecutionBoundary {
  spawn(registry: ManagedProcessRegistry, request: NativeSpawnRequest): ChildProcess;
}
export type BoundaryReadiness =
  | { ready: true; boundary: ProviderExecutionBoundary; proof: { verifiedPrivateReadBoundary: true; verifiedDescendantStop: boolean } }
  | { ready: false; code: string; summary: unknown };
export type ManagedRuntimeOptions = {
  /** Production supplies a per-attempt registry using the shared Store journal. */
  processRegistryFactory?: (context: DispatchContext, proof?: Extract<BoundaryReadiness, { ready: true }>['proof']) => ManagedProcessRegistry;
  executionBoundary?: () => Promise<BoundaryReadiness>;
  inspectionContext?: () => DispatchContext;
  onProcessStop?: (context: DispatchContext, result: ProcessStopResult) => void;
};
export type PreparedNativeRuntime = {
  context: DispatchContext;
  registry: ManagedProcessRegistry;
  spawn(request: NativeSpawnRequest): ChildProcess;
  closeAndWait(deadlineMs?: number): Promise<ProcessStopResult>;
};

/** Every inspection and Turn has an immutable launch identity and its own stop proof. */
export class ManagedRuntimeController {
  private runtimes = new Set<PreparedNativeRuntime>();
  private closing = false;
  private closePromise: Promise<ProcessStopResult> | undefined;
  constructor(private readonly options: ManagedRuntimeOptions = {}) {}
  inspectionContext(): DispatchContext {
    const supplied = this.options.inspectionContext?.();
    if (supplied) return dispatchContextForTurn(supplied.flyxTurnId, supplied);
    return dispatchContextForTurn(`probe-${randomUUID()}`);
  }
  async prepare(context: DispatchContext): Promise<PreparedNativeRuntime> {
    if (this.closing) throw new Error("RUNTIME_CLOSING");
    const fixed = dispatchContextForTurn(context.flyxTurnId, context);
    const readiness = await this.options.executionBoundary?.();
    if (this.closing) throw new Error("RUNTIME_CLOSING");
    if (readiness && !readiness.ready) throw new Error(readiness.code);
    if (fixed.hostOwnerId !== "standalone" && (!this.options.processRegistryFactory || !readiness?.ready)) throw new Error("NATIVE_EXECUTION_BOUNDARY_REQUIRED");
    const registry = this.options.processRegistryFactory?.(fixed, readiness?.ready ? readiness.proof : undefined) ?? new ManagedProcessRegistry({ journal: { save() {} }, context: () => fixed });
    let closed: Promise<ProcessStopResult> | undefined;
    const runtime: PreparedNativeRuntime = {
      context: fixed, registry,
      spawn: ({ command, args, ...spawnOptions }) => {
        if (this.closing) throw new Error("RUNTIME_CLOSING");
        return readiness?.ready ? readiness.boundary.spawn(registry, { command, args, ...spawnOptions }) : registry.spawn(command, args, spawnOptions);
      },
      closeAndWait: (deadlineMs) => closed ??= registry.closeAndWait(deadlineMs).then((result) => { this.options.onProcessStop?.(fixed, result); return result; }),
    };
    this.runtimes.add(runtime);
    return runtime;
  }
  sealJournals(): void { for (const runtime of this.runtimes) runtime.registry.sealJournal(); }
  closeAndWait(deadlineMs = 5_000): Promise<ProcessStopResult> {
    this.closing = true;
    this.closePromise ??= Promise.all([...this.runtimes].map((runtime) => runtime.closeAndWait(deadlineMs))).then((results) => ({ stopped: results.every((result) => result.stopped), treeStopped: results.every((result) => result.treeStopped), records: results.flatMap((result) => result.records) }));
    return this.closePromise;
  }
}

export async function inspectNativeVersion(runtime: PreparedNativeRuntime, executable: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5_000): Promise<string> {
  let child: ChildProcess;
  try { child = runtime.spawn({ command: executable, args: ["--version"], cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
  catch (error) { await runtime.closeAndWait(timeoutMs); throw error; }
  let output = "";
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  const append = (chunk: string) => { if (Buffer.byteLength(output) < 16 * 1024) output += chunk; };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("NATIVE_VERSION_FAILED")));
      timer = setTimeout(() => { reject(new Error("NATIVE_VERSION_TIMEOUT")); }, timeoutMs);
    });
    return output.trim() || "unknown";
  } finally { if (timer) clearTimeout(timer); await runtime.closeAndWait(timeoutMs); }
}
