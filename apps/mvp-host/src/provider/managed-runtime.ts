import type { SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ManagedProcessRegistry, type ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import type { ManagedChildExit, ManagedChildHandle } from "../lifecycle/managed-child-handle.js";
import type { DispatchContext } from "./types.js";
import { dispatchContextForTurn } from "./types.js";
import { supportsNativeStop } from "../lifecycle/managed-stop-contract.js";

export type NativeSpawnRequest = Omit<SpawnOptions, "cwd" | "env"> & { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv };
export interface ProviderExecutionBoundary {
  spawn(registry: ManagedProcessRegistry, request: NativeSpawnRequest): ManagedChildHandle;
}
export type BoundaryReadiness =
  | { ready: true; boundary: ProviderExecutionBoundary; proof: { verifiedPrivateReadBoundary: true; verifiedDescendantStop: boolean; platform?: NodeJS.Platform; managedStopContractId?: string; verifiedWorkspaceWriteBoundary?: true } }
  | { ready: false; code: string; summary: unknown };
export type ManagedRuntimeOptions = {
  /** Production supplies a per-attempt registry using the shared Store journal. */
  processRegistryFactory?: (context: DispatchContext, proof?: Extract<BoundaryReadiness, { ready: true }>['proof']) => ManagedProcessRegistry;
  executionBoundary?: () => Promise<BoundaryReadiness>;
  inspectionContext?: () => DispatchContext;
  /** Recheck the exact persisted dispatch synchronously at every actual spawn. */
  assertDispatch?: (context: DispatchContext) => void;
  onProcessStop?: (context: DispatchContext, result: ProcessStopResult) => void;
};
export type PreparedNativeRuntime = {
  context: DispatchContext;
  registry: ManagedProcessRegistry;
  workspaceWriteBoundary?: true;
  spawn(request: NativeSpawnRequest): ManagedChildHandle;
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
    if (fixed.hostOwnerId !== "standalone" && readiness?.ready && !supportsNativeStop(readiness.proof)) throw new Error("NATIVE_DESCENDANT_STOP_UNVERIFIED");
    const registry = this.options.processRegistryFactory?.(fixed, readiness?.ready ? readiness.proof : undefined) ?? new ManagedProcessRegistry({ journal: { save() {} }, context: () => fixed });
    let closed: Promise<ProcessStopResult> | undefined;
    const runtime: PreparedNativeRuntime = {
      context: fixed, registry,
      ...(readiness?.ready && readiness.proof.verifiedWorkspaceWriteBoundary === true ? { workspaceWriteBoundary: true as const } : {}),
      spawn: ({ command, args, ...spawnOptions }) => {
        if (this.closing) throw new Error("RUNTIME_CLOSING");
        this.options.assertDispatch?.(fixed);
        return readiness?.ready ? readiness.boundary.spawn(registry, { command, args, ...spawnOptions }) : registry.spawn(command, args, spawnOptions);
      },
      closeAndWait: (deadlineMs) => closed ??= registry.closeAndWait(deadlineMs).then((result) => { this.options.onProcessStop?.(fixed, result); return result; }),
    };
    this.runtimes.add(runtime);
    return runtime;
  }
  async closeTurnAndWait(context: DispatchContext, deadlineMs = 5_000): Promise<ProcessStopResult> {
    const results = await Promise.all([...this.runtimes].filter((runtime) => sameContext(runtime.context, context)).map((runtime) => runtime.closeAndWait(deadlineMs)));
    return { stopped: results.every((value) => value.stopped), treeStopped: results.every((value) => value.treeStopped), records: results.flatMap((value) => value.records) };
  }
  sealJournals(): void { for (const runtime of this.runtimes) runtime.registry.sealJournal(); }
  closeAndWait(deadlineMs = 5_000): Promise<ProcessStopResult> {
    this.closing = true;
    this.closePromise ??= Promise.all([...this.runtimes].map((runtime) => runtime.closeAndWait(deadlineMs))).then((results) => ({ stopped: results.every((result) => result.stopped), treeStopped: results.every((result) => result.treeStopped), records: results.flatMap((result) => result.records) }));
    return this.closePromise;
  }
}

export type ManagedVersionObservation = Readonly<{
  context: DispatchContext; processId: string; executable: string; rawVersion: string;
  stop: ProcessStopResult;
}>;
export async function inspectNativeVersion(runtime: PreparedNativeRuntime, executable: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 5_000,
  observed?: (value: ManagedVersionObservation) => void | Promise<void>): Promise<string> {
  let child: ManagedChildHandle;
  try { child = runtime.spawn({ command: executable, args: ["--version"], cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
  catch (error) { await runtime.closeAndWait(timeoutMs); throw error; }
  if (!child.stdout || !child.stderr) { await runtime.closeAndWait(timeoutMs); throw new Error("NATIVE_VERSION_STDIO_UNAVAILABLE"); }
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const append = (chunk: string) => { if (Buffer.byteLength(output) < 16 * 1024) output += chunk; };
  child.stdout.on("data", append); child.stderr.on("data", append);
  let result: string | undefined;
  let stop: ProcessStopResult | undefined;
  try {
    const exit = await new Promise<ManagedChildExit | undefined>((resolve, reject) => {
      child.once("error", reject);
      void child.waitForExit(timeoutMs).then(resolve, reject);
    });
    if (!exit) throw new Error("NATIVE_VERSION_TIMEOUT");
    if (exit.code !== 0) throw new Error("NATIVE_VERSION_FAILED");
    result = output.trim() || "unknown";
  } finally { stop = await runtime.closeAndWait(timeoutMs); }
  if (observed) await observed({ context: runtime.context, processId: child.id, executable, rawVersion: result!, stop: stop! });
  return result!;
}

function sameContext(left: DispatchContext, right: DispatchContext): boolean {
  return left.hostOwnerId === right.hostOwnerId && left.hostOwnerGeneration === right.hostOwnerGeneration && left.sessionId === right.sessionId
    && left.flyxTurnId === right.flyxTurnId && left.runtimeId === right.runtimeId && left.runtimeGeneration === right.runtimeGeneration && left.attemptId === right.attemptId;
}
