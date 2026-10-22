import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { WorkspaceGitQuery } from "../workspace/workspace-registry.js";
import type { ProcessJournal, ProcessLaunchContext } from "./managed-process-registry.js";

export type ManagedWorkspaceQueryInput = Parameters<WorkspaceGitQuery>[0];
export type ManagedWorkspaceQueryCode =
  | "WORKSPACE_QUERY_PROCESS_BIRTH_UNAVAILABLE"
  | "WORKSPACE_QUERY_PLATFORM_UNSUPPORTED"
  | "WORKSPACE_QUERY_CLOSED"
  | "WORKSPACE_QUERY_INPUT_INVALID"
  | "WORKSPACE_QUERY_EXECUTABLE_UNTRUSTED"
  | "WORKSPACE_QUERY_RESULT_INVALID";
export class ManagedWorkspaceQueryError extends Error {
  readonly retryable = false;
  constructor(readonly code: ManagedWorkspaceQueryCode) {
    super(code);
    this.name = "ManagedWorkspaceQueryError";
  }
}
export type ManagedWorkspaceQueryReadiness =
  | Readonly<{ ready: true; platform: NodeJS.Platform }>
  | Readonly<{ ready: false; code: ManagedWorkspaceQueryCode; platform: NodeJS.Platform }>;
export type ManagedWorkspaceQueryCloseReport = Readonly<{
  closed: true;
  producerStopped: boolean;
  clean: boolean;
}>;
/**
 * Trusted injected executor. Only a proven managed runner may implement this;
 * its own stop report is the only accepted producer evidence. Without it the
 * port stays fail-closed on every platform.
 */
export type ManagedWorkspaceQueryExecutor = Readonly<{
  run(plan: ManagedWorkspaceQueryPlan): Promise<{ stdout: string }>;
  closeAndWait(deadlineMs: number): Promise<{ producerStopped: boolean; clean: boolean }>;
}>;
export type ManagedWorkspaceQueryOptions = {
  /** Shared Host journal, retained for a future proven executor. Never owned or closed here. */
  journal: ProcessJournal;
  /** Main supplies the owner/runtime namespace; RPC input cannot select it. */
  context: (input: { purpose: "query"; operationId?: string }) => ProcessLaunchContext;
  assertActive: () => void;
  privateRoots: readonly string[];
  gitExecutable?: string;
  /** Main injects a proven managed executor; RPC input can never select one. */
  executor?: ManagedWorkspaceQueryExecutor;
  trackOperation?: (work: Promise<unknown>) => void;
};
export type ManagedWorkspaceQueryPlan = Readonly<{
  command: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  maxBufferBytes: number;
  timeoutMs: number;
  operationId?: string;
}>;

const DEFAULT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git";
const LIMIT_BYTES = 16 * 1024;
const LIMIT_TIME_MS = 5_000;
/** Canonical controlled query environment. Exported so the managed runner executes the same fixed values. */
export const MANAGED_QUERY_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_ALLOW_PROTOCOL: "",
});
const QUERY_TAILS = Object.freeze({
  toplevel: Object.freeze(["rev-parse", "--show-toplevel"]),
  common_dir: Object.freeze(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
});
export type ManagedWorkspaceQueryShape = keyof typeof QUERY_TAILS;
/** The one canonical final argv for a controlled Workspace query; the managed runner rechecks it verbatim. */
export function managedWorkspaceQueryArgv(cwd: string, shape: ManagedWorkspaceQueryShape): readonly string[] {
  return Object.freeze([
    "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=", "-c", "protocol.allow=never", "-C", cwd, ...QUERY_TAILS[shape],
  ]);
}
/** Identify the exact bounded query shape of an already composed argv, or undefined. */
export function managedWorkspaceQueryShape(argv: readonly string[], cwd: string): ManagedWorkspaceQueryShape | undefined {
  return (Object.keys(QUERY_TAILS) as ManagedWorkspaceQueryShape[]).find((shape) => same(argv, managedWorkspaceQueryArgv(cwd, shape)));
}
function invalid(): never { throw new ManagedWorkspaceQueryError("WORKSPACE_QUERY_INPUT_INVALID"); }
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}
function controlledExecutable(path: string): string {
  try {
    if (!isAbsolute(path)) throw new Error("relative");
    const canonical = realpathSync(path);
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.mode & 0o6000 || !(stat.mode & 0o111)) throw new Error("untrusted");
    return canonical;
  } catch { throw new ManagedWorkspaceQueryError("WORKSPACE_QUERY_EXECUTABLE_UNTRUSTED"); }
}

/** Validate the exact existing WorkspaceRegistry port, then rebuild every execution option. */
export function planManagedWorkspaceQuery(
  input: ManagedWorkspaceQueryInput,
  options: Pick<ManagedWorkspaceQueryOptions, "privateRoots" | "gitExecutable">,
): ManagedWorkspaceQueryPlan {
  if (!input || typeof input.cwd !== "string" || !isAbsolute(input.cwd) || !Array.isArray(input.argv) || input.argv.some(value => typeof value !== "string") ||
      !Number.isSafeInteger(input.maxBufferBytes) || input.maxBufferBytes <= 0 || input.maxBufferBytes > LIMIT_BYTES ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > LIMIT_TIME_MS ||
      input.operationId !== undefined && (typeof input.operationId !== "string" || input.operationId.length < 1 || input.operationId.length > 256)) invalid();
  const callerPrefix = ["-c", "core.fsmonitor=false", "-C", input.cwd];
  const shape = ([...Object.keys(QUERY_TAILS)] as ManagedWorkspaceQueryShape[])
    .find(value => same(input.argv, [...callerPrefix, ...QUERY_TAILS[value]]));
  if (!shape) invalid();
  let cwd: string;
  try {
    cwd = realpathSync(input.cwd);
    if (cwd !== input.cwd || !lstatSync(cwd).isDirectory()) invalid();
    for (const root of options.privateRoots) {
      const canonical = realpathSync(root);
      if (within(canonical, cwd) || within(cwd, canonical)) invalid();
    }
  } catch { invalid(); }
  return Object.freeze({
    command: controlledExecutable(options.gitExecutable ?? DEFAULT_GIT),
    argv: managedWorkspaceQueryArgv(cwd, shape),
    cwd,
    env: MANAGED_QUERY_ENV,
    maxBufferBytes: input.maxBufferBytes,
    timeoutMs: input.timeoutMs,
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
  });
}

/** Diagnostic policy only. Passing its OS tests never establishes stable process birth. */
export function macosWorkspaceQueryReadOnlyProfile(input: {
  privateRoots: readonly string[];
  executables: readonly string[];
}): string {
  if (input.privateRoots.length === 0 || input.executables.length === 0 ||
      [...input.privateRoots, ...input.executables].some(path => !isAbsolute(path) || path.includes("\0"))) invalid();
  return [
    "(version 1)", "(allow default)", "(deny file-write*)",
    // Git opens the kernel null sink O_RDWR; this grants no persistent write.
    "(allow file-write-data (literal \"/dev/null\"))", "(deny network*)",
    "(deny process-fork)", "(deny process-exec)",
    "(allow process-exec " + input.executables.map(path => "(literal " + JSON.stringify(path) + ")").join(" ") + ")",
    ...input.privateRoots.map(path => "(deny file-read* (subpath " + JSON.stringify(path) + "))"), "",
  ].join("\n");
}

/**
 * The shipped Mac inspector has no supported stable kernel birth binding.
 * The audit PID version changes at exec, and BSD start timestamps are wall clock.
 * Do not start production children or write launching rows for an unavailable
 * contract. SQL-only catalog/history reads need neither this port nor a runtime.
 */
export class ManagedWorkspaceQuery {
  private accepting = true;
  private sealed = false;
  private preparation: Promise<ManagedWorkspaceQueryReadiness> | undefined;
  private drainPromise: Promise<ManagedWorkspaceQueryCloseReport> | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private producerStop: Promise<{ producerStopped: boolean; clean: boolean }> | undefined;
  readonly shutdownService = {
    stopProducers: (deadlineAt: number) => this.stopProducers(deadlineAt),
    drain: async (deadlineAt: number): Promise<boolean> => (await this.drain(deadlineAt)).clean,
    seal: (): void => this.seal(),
    close: async (): Promise<void> => { await this.close(); },
  };
  constructor(private readonly options: ManagedWorkspaceQueryOptions) {}

  prepare(): Promise<ManagedWorkspaceQueryReadiness> {
    if (!this.accepting || this.sealed) return Promise.resolve(this.unavailable("WORKSPACE_QUERY_CLOSED"));
    this.preparation ??= Promise.resolve().then(() => {
      if (!this.accepting || this.sealed) return this.unavailable("WORKSPACE_QUERY_CLOSED");
      this.options.assertActive();
      // Only Main can inject a proven executor; the shipped platform codes stay
      // the answer whenever no trusted executor exists.
      return this.options.executor
        ? Object.freeze({ ready: true as const, platform: process.platform })
        : this.unavailable(process.platform === "darwin"
          ? "WORKSPACE_QUERY_PROCESS_BIRTH_UNAVAILABLE" : "WORKSPACE_QUERY_PLATFORM_UNSUPPORTED");
    });
    return this.preparation;
  }

  readonly readOnlyGit: WorkspaceGitQuery = (input) => {
    let begin!: () => void;
    let rejectWork!: (error: unknown) => void;
    const work = new Promise<{ stdout: string }>((resolve, reject) => {
      rejectWork = reject;
      begin = () => { void this.execute(input).then(resolve, reject); };
    });
    try {
      this.options.trackOperation?.(work);
      this.operations.add(work);
      void work.then(() => this.operations.delete(work), () => this.operations.delete(work));
      begin();
    } catch (error) {
      // A tracking/admission rejection must settle the original promise too.
      rejectWork(error);
    }
    return work;
  };

  stopProducers(deadlineAt = Date.now() + LIMIT_TIME_MS): Promise<{ producerStopped: boolean; clean: boolean }> {
    this.accepting = false;
    return this.producerStop ??= (async () => {
      if (!this.options.executor) return { producerStopped: true, clean: true };
      try { return await withinDeadline(this.options.executor.closeAndWait(Math.max(0, deadlineAt - Date.now())), deadlineAt, { producerStopped: false, clean: false }); }
      catch { return { producerStopped: false, clean: false }; }
    })();
  }
  drain(deadlineMs = Date.now() + LIMIT_TIME_MS): Promise<ManagedWorkspaceQueryCloseReport> {
    if (!Number.isFinite(deadlineMs)) invalid();
    this.accepting = false;
    this.drainPromise ??= (async () => {
      // Executor close uses a duration; this service receives one absolute Host deadline.
      const stop = await this.stopProducers(deadlineMs);
      await withinDeadline(Promise.allSettled([...this.operations]), deadlineMs, []);
      return Object.freeze({ closed: true as const, producerStopped: stop.producerStopped, clean: stop.clean && this.operations.size === 0 });
    })();
    return this.drainPromise;
  }
  close(): Promise<ManagedWorkspaceQueryCloseReport> { return this.drain(); }
  seal(): void { this.accepting = false; this.sealed = true; }

  private async execute(input: ManagedWorkspaceQueryInput): Promise<{ stdout: string }> {
    if (!this.accepting || this.sealed) throw new ManagedWorkspaceQueryError("WORKSPACE_QUERY_CLOSED");
    this.options.assertActive();
    const plan = planManagedWorkspaceQuery(input, this.options);
    const context = Object.freeze({ ...this.options.context({ purpose: "query", ...(input.operationId !== undefined ? { operationId: input.operationId } : {}) }) });
    if ([context.hostOwnerId, context.runtimeId, context.attemptId].some(value => typeof value !== "string" || value.length < 1) ||
        !Number.isSafeInteger(context.hostOwnerGeneration) || context.hostOwnerGeneration < 1 ||
        !Number.isSafeInteger(context.runtimeGeneration) || context.runtimeGeneration < 1) invalid();
    const readiness = await this.prepare();
    if (!this.accepting || this.sealed) throw new ManagedWorkspaceQueryError("WORKSPACE_QUERY_CLOSED");
    this.options.assertActive();
    if (!readiness.ready || !this.options.executor) throw new ManagedWorkspaceQueryError(readiness.ready ? "WORKSPACE_QUERY_PLATFORM_UNSUPPORTED" : readiness.code);
    const result = await this.options.executor.run(plan);
    if (!this.accepting || this.sealed) throw new ManagedWorkspaceQueryError("WORKSPACE_QUERY_CLOSED");
    if (!result || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > plan.maxBufferBytes) {
      throw new ManagedWorkspaceQueryError("WORKSPACE_QUERY_RESULT_INVALID");
    }
    return { stdout: result.stdout };
  }
  private unavailable(code: ManagedWorkspaceQueryCode): ManagedWorkspaceQueryReadiness {
    return Object.freeze({ ready: false, code, platform: process.platform });
  }
}

export function createManagedWorkspaceQuery(options: ManagedWorkspaceQueryOptions): ManagedWorkspaceQuery {
  return new ManagedWorkspaceQuery(options);
}

async function withinDeadline<T>(work: Promise<T>, deadlineAt: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, deadlineAt - Date.now())); })]); }
  finally { if (timer) clearTimeout(timer); }
}
