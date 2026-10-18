import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { type ManagedChildHandle } from "./managed-child-handle.js";
import { CONTROLLED_RESTORE_HELPER } from "../checkpoint/controlled-restore-helper.js";
import type { CheckpointGitOperation, CheckpointGitRunRequest, CheckpointGitRunner, CheckpointGitRunResult } from "../checkpoint/git-driver.js";
import type { GitServiceRunner } from "../git/git-service.js";
import {
  MANAGED_QUERY_ENV, managedWorkspaceQueryShape,
  type ManagedWorkspaceQueryPlan,
} from "./managed-workspace-query.js";
import {
  ManagedProcessRegistry, processIdentityDigest,
  type ManagedProcessRecord, type ProcessJournal, type ProcessLaunchContext, type ProcessStopResult,
  type ProcessTreeStopEvidence,
} from "./managed-process-registry.js";

/**
 * Purposes served by the managed runner. Every production Git process and every
 * production restore helper process must be dispatched through one of these
 * fixed policies; none of them inherits ambient Git configuration, user hooks,
 * external diff/textconv helpers, fsmonitor tools or an implicit network fetch.
 */
export type ManagedGitPurpose =
  | "workspace_query" | "checkpoint_read" | "session_diff" | "worktree_write" | "restore_write" | "restore_helper";

export type ManagedGitExecutableIdentity = Readonly<{ path: string; digest: string }>;

/** One frozen purpose policy: trusted executable, canonical config, env, budgets and subcommand allowlist. */
export type ManagedGitPolicy = Readonly<{
  purpose: ManagedGitPurpose;
  policyId: string;
  executable: ManagedGitExecutableIdentity;
  /** Runner-owned canonical `-c` pairs prepended after caller config pairs are validated and dropped. */
  config: readonly string[];
  env: Readonly<Record<string, string>>;
  maxOutputBytes: number;
  maxInputBytes: number;
  timeoutMs: number;
  /** First-token allowlist of the caller tail argv. */
  commands: readonly string[];
}>;

export type ManagedGitErrorCode =
  | "MANAGED_GIT_STOP_BACKEND_REQUIRED" | "MANAGED_GIT_STOP_BACKEND_UNVERIFIED" | "MANAGED_GIT_FIXTURE_BACKEND_FORBIDDEN"
  | "MANAGED_GIT_SUPERVISOR_UNAVAILABLE" | "MANAGED_GIT_PURPOSE_UNKNOWN" | "MANAGED_GIT_INPUT_INVALID"
  | "MANAGED_GIT_EXECUTABLE_UNTRUSTED" | "MANAGED_GIT_CWD_INVALID" | "MANAGED_GIT_ENV_INVALID" | "MANAGED_GIT_ARGV_INVALID"
  | "MANAGED_GIT_CLOSED" | "MANAGED_GIT_SPAWN_FAILED" | "MANAGED_GIT_OUTPUT_BUDGET_EXCEEDED" | "MANAGED_GIT_TIMEOUT"
  | "MANAGED_GIT_ABORTED" | "MANAGED_GIT_TREE_STOP_UNPROVEN";
export type ManagedGitErrorState = "not_spawned" | "stopped" | "unknown";
export class ManagedGitError extends Error {
  readonly retryable = false;
  constructor(readonly code: ManagedGitErrorCode, readonly state: ManagedGitErrorState) {
    super(code); this.name = "ManagedGitError";
  }
}

/**
 * Trusted stop verifier for this Host. `supervisor` is the C0 contract and only
 * exists where the platform can prove descendant stop (Linux PID-namespace
 * boundary today); macOS has no supervisor, so a production constructor must
 * refuse instead of weakening the proof. `fixture` is a deterministic test
 * backend and requires an explicit opt-in.
 */
export type ManagedGitStopBackend = Readonly<{
  kind: "supervisor" | "fixture";
  contractId: string;
  verifiedDescendantStop: true;
  verify(record: ManagedProcessRecord): ProcessTreeStopEvidence | undefined | Promise<ProcessTreeStopEvidence | undefined>;
}>;

export type ManagedGitRunnerOptions = {
  journal: ProcessJournal;
  /** Main supplies the owner/runtime namespace; RPC input cannot select it. */
  context: (input: { purpose: ManagedGitPurpose; operationId?: string; stepId?: string }) => ProcessLaunchContext;
  stopBackend: ManagedGitStopBackend;
  /** Deterministic fixtures only. Production never sets this. */
  allowFixtureStopBackend?: boolean;
  /** Trusted registered checkout roots; every cwd must stay inside one of them or the OS temp root. */
  roots: () => readonly string[];
  privateRoots: readonly string[];
  gitExecutable?: string;
  pythonExecutable?: string;
  stopDeadlineMs?: number;
  /** Deterministic fixture seams forwarded to the managed process registry. */
  groupExists?: (pid: number) => "present" | "absent" | "unknown";
  identify?: ConstructorParameters<typeof ManagedProcessRegistry>[0]["identify"];
};

export type ManagedGitRunRequest = Readonly<{
  purpose: Exclude<ManagedGitPurpose, "workspace_query" | "restore_helper">;
  /** Tail argv after the validated caller config pairs; the runner prepends its own canonical prefix. */
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  input?: Readonly<{ encoding: "base64"; data: string; bytes: number }>;
  maxOutputBytes: number;
  timeoutMs: number;
  operationId?: string;
  stepId?: string;
  /** Opaque original Host binding captured into the fixed pre-dispatch digest. */
  bindingDigest?: string;
  signal?: AbortSignal;
}>;

export type ManagedGitRunResult = Readonly<{
  purpose: ManagedGitPurpose;
  policyId: string;
  launchDigest: string;
  processId: string;
  stdout: Uint8Array;
  exitCode: number;
  state: "stopped";
  stopped: true;
  stopProof: ProcessTreeStopEvidence;
}>;

export type ManagedGitRunnerCloseReport = Readonly<{
  closed: true;
  producerStopped: boolean;
  clean: boolean;
  runs: number;
}>;

export type ManagedHelperLaunchRequest = Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  purpose: "probe" | "read" | "mutate";
  operationId?: string;
  stepId?: string;
  workspace?: string;
}>;
export type ManagedHelperLauncher = (request: ManagedHelperLaunchRequest) => Promise<ManagedChildHandle>;

const GIT_EXECUTABLE = "/Library/Developer/CommandLineTools/usr/bin/git";
const PYTHON_EXECUTABLE = "/usr/bin/python3";
const CHECKPOINT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "Flyx Checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@flyx.invalid",
  GIT_COMMITTER_NAME: "Flyx Checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@flyx.invalid",
});
/** Canonical runner-owned config. Trusted code never has to remember these knobs. */
const GIT_CONFIG = Object.freeze([
  "core.fsmonitor=false", "core.hooksPath=/dev/null", "core.attributesFile=/dev/null",
  "core.untrackedCache=false", "core.preloadIndex=false", "core.splitIndex=false",
  "gc.auto=0", "maintenance.auto=false", "commit.gpgSign=false", "diff.external=",
  "submodule.recurse=false", "credential.helper=", "protocol.allow=never",
]);
/** Config pairs callers are allowed to send; they are validated then replaced by GIT_CONFIG. */
const KNOWN_CONFIG = new Set(GIT_CONFIG);
const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
  GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "",
});
const ENV_EXTRAS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", ...Object.keys(CHECKPOINT_IDENTITY)]);
const ENV_PATHS = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
const FORBIDDEN_ARGV = /^--(?:exec-path|upload-pack|receive-pack|git-dir|work-tree|namespace|config|config-env|output|no-index|literal-pathspecs)|:\/\//;
const CHECKPOINT_COMMANDS: Readonly<Record<CheckpointGitOperation["kind"], readonly string[]>> = Object.freeze({
  capture: Object.freeze(["rev-parse", "ls-files", "ls-tree", "read-tree", "write-tree", "hash-object", "update-index", "cat-file", "update-ref", "commit-tree", "mktree", "diff-tree", "diff", "symbolic-ref"]),
  fingerprint: Object.freeze(["rev-parse", "ls-files", "ls-tree", "read-tree", "symbolic-ref"]),
  // `verify` also serves the controlled-restore isolated-index queries
  // (`read-tree`/`write-tree` against a temp index owned by the caller).
  verify: Object.freeze(["rev-parse", "read-tree", "write-tree"]), diff: Object.freeze(["diff-tree"]), resolve_commit: Object.freeze(["rev-parse"]),
  list_tree: Object.freeze(["ls-tree"]), blob: Object.freeze(["cat-file"]), patch: Object.freeze(["diff"]),
});
const WORKTREE_COMMANDS = Object.freeze(["worktree", "rev-parse", "ls-files", "update-ref", "write-tree", "read-tree"]);
const RESTORE_COMMANDS = Object.freeze(["rev-parse", "read-tree", "write-tree"]);
const SESSION_DIFF_COMMANDS = Object.freeze(["status", "rev-parse", "diff"]);
const LIMITS = Object.freeze({ checkpoint: 32 * 1024 * 1024, sessionDiff: 2 * 1024 * 1024 + 64 * 1024, worktree: 32 * 1024 * 1024, restore: 1024 * 1024 });

function closed(): ManagedGitError { return new ManagedGitError("MANAGED_GIT_CLOSED", "not_spawned"); }
function invalid(): never { throw new ManagedGitError("MANAGED_GIT_INPUT_INVALID", "not_spawned"); }
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}
/** Absolute, real, root-owned, non-writable, non-setuid, executable file; digest pinned at construction. */
function trustedExecutable(path: string): ManagedGitExecutableIdentity {
  try {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("untrusted");
    const canonical = realpathSync(path);
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o6000) !== 0 || (stat.mode & 0o111) === 0) throw new Error("untrusted");
    return Object.freeze({ path: canonical, digest: digest(readFileSync(canonical)) });
  } catch { throw new ManagedGitError("MANAGED_GIT_EXECUTABLE_UNTRUSTED", "not_spawned"); }
}
function sameIdentity(expected: ManagedGitExecutableIdentity): boolean {
  try {
    const canonical = realpathSync(expected.path);
    if (canonical !== expected.path) return false;
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o6000) !== 0 || (stat.mode & 0o111) === 0) return false;
    return digest(readFileSync(canonical)) === expected.digest;
  } catch { return false; }
}
function launchContext(value: ProcessLaunchContext): ProcessLaunchContext {
  if (!value || [value.hostOwnerId, value.runtimeId, value.attemptId].some((item) => typeof item !== "string" || item.length < 1 || item.length > 256) ||
      !Number.isSafeInteger(value.hostOwnerGeneration) || value.hostOwnerGeneration < 1 ||
      !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 0 ||
      value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 256) ||
      value.flyxTurnId !== undefined && (typeof value.flyxTurnId !== "string" || value.flyxTurnId.length < 1 || value.flyxTurnId.length > 256)) invalid();
  return Object.freeze({ ...value });
}
function canonicalDirectory(path: string): string {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) invalid();
    const canonical = realpathSync(path);
    if (canonical !== path || !lstatSync(canonical).isDirectory()) invalid();
    return canonical;
  } catch (error) { if (error instanceof ManagedGitError) throw error; invalid(); }
}
/** Strip and validate caller `-c` pairs; the runner always prepends its own canonical prefix. */
function stripCallerConfig(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args) || args.length < 1 || args.length > 64 || args.some((value) => typeof value !== "string" || value.length > 512 || value.includes("\0"))) invalid();
  let index = 0;
  while (index + 1 < args.length && args[index] === "-c") {
    if (!KNOWN_CONFIG.has(args[index + 1]!)) throw new ManagedGitError("MANAGED_GIT_ARGV_INVALID", "not_spawned");
    index += 2;
  }
  const tail = args.slice(index);
  if (tail.length === 0 || tail.some((value) => value === "-c" || value.startsWith("--config") || FORBIDDEN_ARGV.test(value))) {
    throw new ManagedGitError("MANAGED_GIT_ARGV_INVALID", "not_spawned");
  }
  return Object.freeze(tail);
}

/** Fixed policies. `workspace_query` composes its own canonical argv through `managedWorkspaceQueryArgv`. */
function buildPolicies(options: { git: ManagedGitExecutableIdentity; python: ManagedGitExecutableIdentity }): Readonly<Record<ManagedGitPurpose, ManagedGitPolicy>> {
  const git = (purpose: ManagedGitPurpose, policyId: string, commands: readonly string[], maxOutputBytes: number, timeoutMs: number): ManagedGitPolicy => Object.freeze({
    purpose, policyId, executable: options.git, config: GIT_CONFIG, env: GIT_ENV, commands: Object.freeze([...commands]), maxOutputBytes, maxInputBytes: 32 * 1024 * 1024, timeoutMs,
  });
  return Object.freeze({
    workspace_query: Object.freeze({
      purpose: "workspace_query", policyId: "managed-git/workspace-query/v1", executable: options.git, config: GIT_CONFIG,
      env: MANAGED_QUERY_ENV, commands: Object.freeze(["rev-parse"]), maxOutputBytes: 16 * 1024, maxInputBytes: 0, timeoutMs: 5_000,
    }),
    checkpoint_read: git("checkpoint_read", "managed-git/checkpoint-read/v1", CHECKPOINT_COMMANDS.capture, LIMITS.checkpoint, 30_000),
    session_diff: git("session_diff", "managed-git/session-diff/v1", SESSION_DIFF_COMMANDS, LIMITS.sessionDiff, 15_000),
    worktree_write: git("worktree_write", "managed-git/worktree-write/v1", WORKTREE_COMMANDS, LIMITS.worktree, 30_000),
    restore_write: git("restore_write", "managed-git/restore-write/v1", RESTORE_COMMANDS, LIMITS.restore, 30_000),
    restore_helper: Object.freeze({
      purpose: "restore_helper", policyId: "managed-git/restore-helper/v1", executable: options.python, config: Object.freeze([]),
      env: Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }), commands: Object.freeze([]), maxOutputBytes: 16 * 1024 * 1024, maxInputBytes: 64 * 1024 * 1024, timeoutMs: 30_000,
    }),
  });
}

/**
 * Single controlled entry point for managed Git and restore helper execution.
 *
 * Order per dispatch: input validation -> actual path/binary/policy validation ->
 * durable `launching` -> controlled spawn and raw identity commit -> bounded
 * output -> original stop evidence -> result. A run is only a success when the
 * injected stop backend proved the descendant tree stopped; otherwise the
 * journal keeps `unknown` and a typed error carries that state.
 */
export class ManagedGitRunner {
  private readonly policies: Readonly<Record<ManagedGitPurpose, ManagedGitPolicy>>;
  private readonly stops = new Map<string, () => Promise<ProcessStopResult>>();
  private readonly registries = new Map<string, ManagedProcessRegistry>();
  private readonly runs = new Set<Promise<unknown>>();
  private runCounter = 0;
  private readonly stopBackend: ManagedGitStopBackend;
  private closing = false;
  private sealed = false;
  private closePromise: Promise<ManagedGitRunnerCloseReport> | undefined;
  constructor(private readonly options: ManagedGitRunnerOptions) {
    const backend = options.stopBackend;
    if (!backend || typeof backend !== "object") throw new ManagedGitError("MANAGED_GIT_STOP_BACKEND_REQUIRED", "not_spawned");
    if (backend.verifiedDescendantStop !== true || typeof backend.contractId !== "string" || backend.contractId.length < 1 || backend.contractId.length > 512 || typeof backend.verify !== "function") {
      throw new ManagedGitError("MANAGED_GIT_STOP_BACKEND_UNVERIFIED", "not_spawned");
    }
    if (backend.kind === "fixture" && options.allowFixtureStopBackend !== true) throw new ManagedGitError("MANAGED_GIT_FIXTURE_BACKEND_FORBIDDEN", "not_spawned");
    // The supervisor contract is a per-kernel proof; there is no macOS supervisor.
    if (backend.kind === "supervisor" && process.platform !== "linux") throw new ManagedGitError("MANAGED_GIT_SUPERVISOR_UNAVAILABLE", "not_spawned");
    this.stopBackend = backend;
    const git = trustedExecutable(options.gitExecutable ?? GIT_EXECUTABLE);
    const python = trustedExecutable(options.pythonExecutable ?? PYTHON_EXECUTABLE);
    this.policies = buildPolicies({ git, python });
  }

  policyFor(purpose: ManagedGitPurpose): ManagedGitPolicy {
    const policy = this.policies[purpose];
    if (!policy) throw new ManagedGitError("MANAGED_GIT_PURPOSE_UNKNOWN", "not_spawned");
    return policy;
  }

  /** Stop every active run's process tree first, then drain bounded by the same deadline, then seal journals. */
  closeAndWait(deadlineMs = 5_000): Promise<ManagedGitRunnerCloseReport> {
    this.closing = true;
    this.closePromise ??= this.closeInternal(Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : 0);
    return this.closePromise;
  }
  /** Durable fencing for the shared Store close: no further journal write leaves this runner. */
  sealJournal(): void {
    this.sealed = true; this.closing = true;
    for (const [runId, stop] of [...this.stops]) {
      const registry = this.registries.get(runId);
      void stop().then(() => registry?.sealJournal(), () => { registry?.sealJournal(); });
    }
    for (const [runId, registry] of [...this.registries]) if (!this.stops.has(runId)) registry.sealJournal();
  }

  async run(request: ManagedGitRunRequest): Promise<ManagedGitRunResult> {
    if (this.closing || this.sealed) throw closed();
    const policy = this.policyFor(request.purpose);
    const tail = stripCallerConfig(request.args);
    if (!policy.commands.some((command) => command === tail[0])) throw new ManagedGitError("MANAGED_GIT_ARGV_INVALID", "not_spawned");
    const cwd = canonicalDirectory(request.cwd);
    if (!this.allowedCwd(cwd)) throw new ManagedGitError("MANAGED_GIT_CWD_INVALID", "not_spawned");
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > policy.maxOutputBytes ||
        !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > policy.timeoutMs ||
        request.operationId !== undefined && (typeof request.operationId !== "string" || request.operationId.length < 1 || request.operationId.length > 256) ||
        request.stepId !== undefined && (typeof request.stepId !== "string" || request.stepId.length < 1 || request.stepId.length > 256) ||
        request.bindingDigest !== undefined && (typeof request.bindingDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.bindingDigest))) invalid();
    const input = this.validatedInput(request.input, policy);
    const env = this.validatedEnv(policy, request.env);
    const argv = Object.freeze([...policy.config.flatMap((pair) => ["-c", pair]), ...tail]);
    return this.dispatch({
      kind: "git", policy, argv, cwd, env, input, maxOutputBytes: request.maxOutputBytes, timeoutMs: request.timeoutMs,
      ...(request.operationId !== undefined ? { operationId: request.operationId } : {}),
      ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
      ...(request.bindingDigest !== undefined ? { bindingDigest: request.bindingDigest } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      stdin: input === undefined ? "open" : "close",
    });
  }

  /** Validate an already-planned Workspace query and execute it under the fixed read-only policy. */
  workspaceQueryPort(): { run(plan: ManagedWorkspaceQueryPlan): Promise<{ stdout: string }>; closeAndWait(deadlineMs: number): Promise<{ producerStopped: boolean; clean: boolean }> } {
    return {
      run: async (plan) => {
        if (this.closing || this.sealed) throw closed();
        const policy = this.policies.workspace_query;
        const cwd = canonicalDirectory(plan.cwd);
        if (!this.allowedCwd(cwd) || cwd !== plan.cwd || plan.command !== policy.executable.path ||
            !sameIdentity(policy.executable) || plan.maxBufferBytes > policy.maxOutputBytes || plan.timeoutMs > policy.timeoutMs ||
            managedWorkspaceQueryShape(plan.argv, cwd) === undefined ||
            Object.entries(plan.env).some(([key, value]) => typeof value !== "string" || (MANAGED_QUERY_ENV as Record<string, string | undefined>)[key] !== value)) {
          throw new ManagedGitError("MANAGED_GIT_INPUT_INVALID", "not_spawned");
        }
        const result = await this.dispatch({
          kind: "git", policy, argv: Object.freeze([...plan.argv]), cwd, env: { ...MANAGED_QUERY_ENV }, input: undefined,
          maxOutputBytes: plan.maxBufferBytes, timeoutMs: plan.timeoutMs,
          ...(plan.operationId !== undefined ? { operationId: plan.operationId } : {}), stdin: "close",
        });
        if (result.stdout.byteLength > plan.maxBufferBytes) throw new ManagedGitError("MANAGED_GIT_OUTPUT_BUDGET_EXCEEDED", "stopped");
        return { stdout: Buffer.from(result.stdout).toString("utf8") };
      },
      closeAndWait: async (deadlineMs) => {
        const report = await this.closeAndWait(deadlineMs);
        return { producerStopped: report.producerStopped, clean: report.clean };
      },
    };
  }

  /** `HostCheckpointGitRunner`-shaped adapter: revalidates the operation shape and the original Host binding. */
  checkpointGitRunner(): (request: CheckpointGitRunRequest & { binding: { hostOwnerId: string; hostOwnerGeneration: number; workspaceId: string } }) => Promise<CheckpointGitRunResult> {
    return async (request) => {
      const binding = request.binding;
      if (!binding || typeof binding.hostOwnerId !== "string" || binding.hostOwnerId.length < 1 ||
          !Number.isSafeInteger(binding.hostOwnerGeneration) || binding.hostOwnerGeneration < 1 ||
          typeof binding.workspaceId !== "string" || binding.workspaceId.length < 1 ||
          request.command !== "git" || !Object.hasOwn(CHECKPOINT_COMMANDS, request.operation.kind) ||
          !request.signal || typeof request.signal.aborted !== "boolean") invalid();
      const commands = CHECKPOINT_COMMANDS[request.operation.kind];
      const tail = stripCallerConfig(request.args);
      if (!commands.some((command) => command === tail[0])) throw new ManagedGitError("MANAGED_GIT_ARGV_INVALID", "not_spawned");
      const result = await this.run({
        purpose: "checkpoint_read", args: tail, cwd: request.cwd, env: request.env,
        ...(request.input !== undefined ? { input: request.input } : {}),
        maxOutputBytes: request.maxBuffer, timeoutMs: request.timeoutMs,
        ...(("checkpointId" in request.operation) ? { operationId: request.operation.checkpointId } : {}),
        bindingDigest: digest(stableJson({ hostOwnerId: binding.hostOwnerId, hostOwnerGeneration: binding.hostOwnerGeneration, workspaceId: binding.workspaceId, operation: request.operation })),
        signal: request.signal,
      });
      return { stdout: result.stdout, exitCode: result.exitCode };
    };
  }

  /** `GitServiceRunner` adapter for the legacy Session status/Diff reads. */
  gitServiceRunner(): GitServiceRunner {
    return async (command) => {
      const result = await this.run({
        purpose: "session_diff", args: command.args, cwd: command.cwd,
        maxOutputBytes: command.maxOutputBytes, timeoutMs: command.timeoutMs,
        ...(command.operationId !== undefined ? { operationId: command.operationId } : {}),
      });
      return { stdout: Buffer.from(result.stdout).toString("utf8"), exitCode: result.exitCode };
    };
  }

  /**
   * Plain `CheckpointGitRunner` for `ControlledRestore`: repository binding
   * queries (`fingerprint`) and isolated-index `verify` work. Callers never
   * supply a raw `-c` prefix the runner would trust; it is stripped and
   * replaced by the canonical `restore_write` policy prefix.
   */
  restoreGitRunner(): CheckpointGitRunner {
    return async (request) => {
      if (!request || request.command !== "git" || !request.signal || typeof request.signal.aborted !== "boolean") invalid();
      const kind = request.operation.kind;
      if (kind !== "fingerprint" && kind !== "verify") throw new ManagedGitError("MANAGED_GIT_PURPOSE_UNKNOWN", "not_spawned");
      const tail = stripCallerConfig(request.args);
      if (!CHECKPOINT_COMMANDS[kind].some((command) => command === tail[0]) || !RESTORE_COMMANDS.some((command) => command === tail[0])) {
        throw new ManagedGitError("MANAGED_GIT_ARGV_INVALID", "not_spawned");
      }
      const result = await this.run({
        purpose: "restore_write", args: tail, cwd: request.cwd, env: request.env,
        ...(request.input !== undefined ? { input: request.input } : {}),
        maxOutputBytes: request.maxBuffer, timeoutMs: request.timeoutMs,
        ...(kind === "verify" ? { operationId: request.operation.checkpointId } : {}),
        bindingDigest: digest(stableJson({ operation: request.operation })),
        signal: request.signal,
      });
      return { stdout: result.stdout, exitCode: result.exitCode };
    };
  }

  /**
   * Journaled restore helper launcher. The helper protocol keeps stdin open, so
   * the caller writes the exact request and closes it; completion stop evidence
   * is attached to the same journal record and settled after close.
   */
  helperLauncher(): ManagedHelperLauncher {
    return async (request) => {
      if (this.closing || this.sealed) throw closed();
      const policy = this.policies.restore_helper;
      if (request.command !== policy.executable.path || !sameIdentity(policy.executable) ||
          request.args.length !== 3 || request.args[0] !== "-I" || request.args[1] !== "-c" || request.args[2] !== CONTROLLED_RESTORE_HELPER) invalid();
      const cwd = request.workspace !== undefined ? canonicalDirectory(request.workspace) : realpathSync(tmpdir());
      if (request.workspace === undefined && !this.allowedCwd(cwd)) throw new ManagedGitError("MANAGED_GIT_CWD_INVALID", "not_spawned");
      const registry = this.runRegistry({ purpose: "restore_helper", ...(request.operationId !== undefined ? { operationId: request.operationId } : {}) , ...(request.stepId !== undefined ? { stepId: request.stepId } : {}) });
      const env = { ...policy.env };
      const evidence = Object.freeze({
        proof: Object.freeze({ kind: "managed-helper-launch-plan", purpose: policy.purpose, policyId: policy.policyId,
          executableDigest: policy.executable.digest, operationId: request.operationId ?? null, stepId: request.stepId ?? null }),
        launchDigest: digest(stableJson({ purpose: policy.purpose, policyId: policy.policyId, executable: policy.executable, argv: request.args, cwd, env })),
      });
      const child = this.spawn(registry, policy, [...request.args], cwd, env, evidence);
      const runId = "helper-run-" + (this.runCounter += 1);
      const stop = (deadlineMs = this.options.stopDeadlineMs ?? 2_000) => registry.closeAndWait(deadlineMs);
      this.stops.set(runId, stop); this.registries.set(runId, registry);
      // No mutation input exists until this launcher returned; the caller owns the protocol.
      void child.exited.then(() => {
        void stop().then(() => { /* Proof is settled into the record below. */ }, () => { /* A durable unknown keeps the recovery gate. */ })
          .finally(() => { registry.sealJournal(); this.stops.delete(runId); this.registries.delete(runId); });
      });
      return child;
    };
  }

  private closeInternal(deadlineMs: number): Promise<ManagedGitRunnerCloseReport> {
    return (async () => {
      const deadlineAt = Date.now() + deadlineMs;
      // 1. Stop every active producer before draining any completion.
      const stops = [...this.stops.values()];
      const stopped = (await Promise.all(stops.map((stop) => stop().then((result) => result.treeStopped, () => false)))).every(Boolean);
      // 2. Drain the actual run promises, bounded by the same deadline.
      const runs = [...this.runs];
      const drained = await waitForSettled(runs, Math.max(0, deadlineAt - Date.now()));
      // 3. Fence late journal writes for every registry this runner owns.
      for (const registry of [...this.registries.values()]) registry.sealJournal();
      return Object.freeze({ closed: true as const, producerStopped: stopped, clean: stopped && drained && runs.length === 0, runs: runs.length });
    })();
  }
  private runRegistry(input: { purpose: ManagedGitPurpose; operationId?: string; stepId?: string }): ManagedProcessRegistry {
    return new ManagedProcessRegistry({
      journal: this.options.journal,
      context: () => launchContext(this.options.context(input)),
      ...(this.options.groupExists ? { groupExists: this.options.groupExists } : {}),
      ...(this.options.identify ? { identify: this.options.identify } : {}),
      verifyDescendantStop: async (record) => {
        const proof = await this.stopBackend.verify(record);
        return proof && proof.contractId === this.stopBackend.contractId && proof.kind === "verified-tree-stop" ? proof : undefined;
      },
    });
  }
  private spawn(registry: ManagedProcessRegistry, policy: ManagedGitPolicy, argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, evidence: { proof: Readonly<object>; launchDigest: string } | undefined): ManagedChildHandle {
    if (!sameIdentity(policy.executable)) throw new ManagedGitError("MANAGED_GIT_EXECUTABLE_UNTRUSTED", "not_spawned");
    try {
      return registry.spawn(policy.executable.path, [...argv], { cwd, env: { ...env }, stdio: ["pipe", "pipe", "pipe"] }, evidence);
    } catch (error) {
      if (error instanceof ManagedGitError) throw error;
      throw new ManagedGitError("MANAGED_GIT_SPAWN_FAILED", "not_spawned");
    }
  }
  private async dispatch(input: {
    kind: "git" | "helper"; policy: ManagedGitPolicy; argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>>;
    input: { data: string; bytes: number } | undefined; maxOutputBytes: number; timeoutMs: number;
    operationId?: string; stepId?: string; bindingDigest?: string; signal?: AbortSignal; stdin: "open" | "close";
  }): Promise<ManagedGitRunResult> {
    const { policy } = input;
    const launchDigest = digest(stableJson({
      purpose: policy.purpose, policyId: policy.policyId, executable: policy.executable, argv: input.argv, cwd: input.cwd, env: input.env,
      inputBytes: input.input?.bytes ?? 0, inputDigest: input.input ? digest(Buffer.from(input.input.data, "base64")) : null,
      maxOutputBytes: input.maxOutputBytes, timeoutMs: input.timeoutMs,
      operationId: input.operationId ?? null, stepId: input.stepId ?? null, bindingDigest: input.bindingDigest ?? null,
    }));
    const boundaryEvidence = Object.freeze({
      proof: Object.freeze({
        kind: "managed-git-launch-plan", purpose: policy.purpose, policyId: policy.policyId, executableDigest: policy.executable.digest,
        operationId: input.operationId ?? null, stepId: input.stepId ?? null, bindingDigest: input.bindingDigest ?? null,
      }),
      launchDigest,
    });
    const registry = this.runRegistry({ purpose: policy.purpose, ...(input.operationId !== undefined ? { operationId: input.operationId } : {}), ...(input.stepId !== undefined ? { stepId: input.stepId } : {}) });
    const runId = "git-run-" + (this.runCounter += 1);
    const stop = (deadlineMs = this.options.stopDeadlineMs ?? 2_000) => registry.closeAndWait(deadlineMs);
    this.stops.set(runId, stop); this.registries.set(runId, registry);
    const work = (async (): Promise<ManagedGitRunResult> => {
      const child = this.spawn(registry, policy, input.argv, input.cwd, input.env, boundaryEvidence);
      child.stdin?.on("error", () => { /* A closed stdin is reported by the command result, never as a stop proof. */ });
      if (input.stdin === "close") child.stdin?.end(input.input ? Buffer.from(input.input.data, "base64") : undefined);
      const collected = await this.collect(child, input.maxOutputBytes, input.timeoutMs, input.signal);
      let stopped: ProcessStopResult;
      try { stopped = await stop(); }
      catch { throw new ManagedGitError("MANAGED_GIT_TREE_STOP_UNPROVEN", "unknown"); }
      const record = registry.records()[0];
      if (!record) throw new ManagedGitError("MANAGED_GIT_SPAWN_FAILED", "not_spawned");
      if (record.state === "not_spawned" || collected.kind === "spawn") throw new ManagedGitError("MANAGED_GIT_SPAWN_FAILED", "not_spawned");
      if (!stopped.treeStopped || record.state !== "stopped" || !record.stopProof) {
        throw new ManagedGitError("MANAGED_GIT_TREE_STOP_UNPROVEN", "unknown");
      }
      if (collected.kind === "output") throw new ManagedGitError("MANAGED_GIT_OUTPUT_BUDGET_EXCEEDED", "stopped");
      if (collected.kind === "timeout") throw new ManagedGitError("MANAGED_GIT_TIMEOUT", "stopped");
      if (collected.kind === "aborted") throw new ManagedGitError("MANAGED_GIT_ABORTED", "stopped");
      return Object.freeze({
        purpose: policy.purpose, policyId: policy.policyId, launchDigest, processId: record.id,
        stdout: collected.stdout, exitCode: collected.exitCode, state: "stopped" as const, stopped: true as const, stopProof: record.stopProof,
      });
    })();
    this.runs.add(work);
    try { return await work; }
    finally {
      this.stops.delete(runId); this.registries.delete(runId); this.runs.delete(work);
      // Late SQL never happens: the per-run journal is sealed before the result is observed.
      registry.sealJournal();
    }
  }
  private async collect(child: ManagedChildHandle, maxOutputBytes: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<Collected> {
    return await new Promise((resolve) => {
      const chunks: Buffer[] = []; let bytes = 0; let settled = false;
      const finish = (value: Collected): void => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const fail = (kind: "output" | "timeout" | "aborted" | "spawn"): void => {
        if (settled) return;
        try { child.kill("SIGTERM"); } catch { /* Stop evidence still comes from the registry. */ }
        finish({ kind });
      };
      const abort = (): void => fail("aborted");
      const timer = setTimeout(() => fail("timeout"), timeoutMs);
      if (signal) { if (signal.aborted) { abort(); return; } signal.addEventListener("abort", abort, { once: true }); }
      child.stdout?.on("data", (data: Buffer) => { bytes += data.length; if (bytes > maxOutputBytes) { fail("output"); return; } chunks.push(data); });
      child.stderr?.on("data", (data: Buffer) => { bytes += data.length; if (bytes > maxOutputBytes) child.stderr?.pause(); });
      child.stdout?.on("error", () => fail("spawn"));
      child.once("error", () => fail("spawn"));
      // The managed close boundary is the observed root exit plus a drained
      // stdout pipe; the journal keeps the root exit fact either way.
      void child.exited.then(async (exit) => {
        const stream = child.stdout;
        if (stream && !stream.readableEnded && !stream.destroyed) await new Promise<void>((done) => { stream.once("end", () => done()); stream.once("close", () => done()); });
        finish({ kind: "closed", stdout: Buffer.concat(chunks), exitCode: exit.code ?? -1 });
      });
    });
  }
  private validatedInput(input: ManagedGitRunRequest["input"], policy: ManagedGitPolicy): { data: string; bytes: number } | undefined {
    if (input === undefined) return undefined;
    if (!input || input.encoding !== "base64" || typeof input.data !== "string" || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > policy.maxInputBytes ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) invalid();
    const decoded = Buffer.from(input.data, "base64");
    if (decoded.length !== input.bytes) invalid();
    return Object.freeze({ data: input.data, bytes: input.bytes });
  }
  private validatedEnv(policy: ManagedGitPolicy, extras: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
    const env: Record<string, string> = { ...policy.env };
    if (extras === undefined) return Object.freeze(env);
    if (!extras || typeof extras !== "object" || Array.isArray(extras)) throw new ManagedGitError("MANAGED_GIT_ENV_INVALID", "not_spawned");
    for (const [key, value] of Object.entries(extras)) {
      if (typeof value !== "string" || value.includes("\0")) throw new ManagedGitError("MANAGED_GIT_ENV_INVALID", "not_spawned");
      const base = (policy.env as Record<string, string | undefined>)[key];
      if (base !== undefined) { if (base !== value) throw new ManagedGitError("MANAGED_GIT_ENV_INVALID", "not_spawned"); continue; }
      if (!ENV_EXTRAS.has(key)) throw new ManagedGitError("MANAGED_GIT_ENV_INVALID", "not_spawned");
      if (ENV_PATHS.has(key)) { if (!isAbsolute(value)) throw new ManagedGitError("MANAGED_GIT_ENV_INVALID", "not_spawned"); continue; }
      if ((CHECKPOINT_IDENTITY as Record<string, string>)[key] !== value) throw new ManagedGitError("MANAGED_GIT_ENV_INVALID", "not_spawned");
    }
    for (const [key, value] of Object.entries(extras)) env[key] = value;
    return Object.freeze(env);
  }
  private allowedCwd(cwd: string): boolean {
    for (const root of this.options.roots()) {
      let canonical: string;
      try { canonical = realpathSync(root); } catch { continue; }
      if (within(canonical, cwd)) return true;
    }
    let temporary: string;
    try { temporary = realpathSync(tmpdir()); } catch { return false; }
    if (!within(temporary, cwd)) return false;
    for (const root of this.options.privateRoots) {
      let canonical: string;
      try { canonical = realpathSync(root); } catch { continue; }
      if (within(canonical, cwd) || within(cwd, canonical)) return false;
    }
    return true;
  }
}

async function waitForSettled(runs: readonly Promise<unknown>[], deadlineMs: number): Promise<boolean> {
  if (runs.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...runs]).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
type Collected = { kind: "closed"; stdout: Uint8Array; exitCode: number } | { kind: "output" } | { kind: "timeout" } | { kind: "aborted" } | { kind: "spawn" };
export { processIdentityDigest };
export type { ManagedProcessRecord, ProcessLaunchContext, ProcessStopResult, ProcessTreeStopEvidence };
