import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CheckpointGitRunRequest, CheckpointGitRunResult, CheckpointGitRunner } from "../checkpoint/git-driver.js";
import type { HostCheckpointGitRunner } from "../checkpoint/host-checkpoints.js";
import type { GitServiceRunner } from "../git/git-service.js";
import { adoptNodeChildProcess, type ManagedChildHandle } from "../lifecycle/managed-child-handle.js";
import { ManagedGitRunner, type ManagedGitStopBackend, type ManagedHelperLaunchRequest } from "../lifecycle/managed-git-runner.js";
import { processIdentityDigest, type ManagedProcessRecord, type ProcessJournal, type ProcessLaunchContext } from "../lifecycle/managed-process-registry.js";
import type { WorkspaceGitQuery } from "../workspace/workspace-registry.js";

/**
 * Deterministic fixtures for the managed Git/helper execution boundary.
 *
 * The raw runners below keep existing behavior tests on a real `git` process
 * without pretending to satisfy the production stop-proof contract; they are
 * never imported by production composition. The managed fixture runner is a
 * real `ManagedGitRunner` with an explicitly opted-in deterministic stop
 * backend, so integration fixtures can exercise the actual journal/dispatch/
 * stop-evidence path on a machine without a supervisor.
 */

type RawExecRequest = Readonly<{
  command?: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  input?: Buffer;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
}>;

function rawExec(request: RawExecRequest): Promise<{ stdout: Buffer; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(request.command ?? "git", [...request.args], {
      cwd: request.cwd, ...(request.env ? { env: { ...request.env } } : {}), encoding: "buffer",
      timeout: request.timeoutMs, maxBuffer: request.maxBuffer, ...(request.signal ? { signal: request.signal } : {}),
    }, (error, stdout) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ stdout, exitCode: error ? Number(error.code) : 0 });
    });
    child.stdin?.on("error", () => { /* A closed stdin is reported by the command result. */ });
    child.stdin?.end(request.input);
  });
}

/** Raw deterministic `CheckpointGitRunner`; a completion result, never a stop proof. */
export function rawCheckpointGitRunner(): CheckpointGitRunner {
  return async (request: CheckpointGitRunRequest): Promise<CheckpointGitRunResult> => {
    const result = await rawExec({ command: request.command, args: request.args, cwd: request.cwd, env: request.env,
      ...(request.input ? { input: Buffer.from(request.input.data, "base64") } : {}),
      timeoutMs: request.timeoutMs, maxBuffer: request.maxBuffer, signal: request.signal });
    return { stdout: result.stdout, exitCode: result.exitCode };
  };
}

/** Raw deterministic `HostCheckpointGitRunner`; the fixture accepts the Host binding it is handed. */
export function rawHostCheckpointGitRunner(): HostCheckpointGitRunner {
  const runner = rawCheckpointGitRunner();
  return async (request) => await runner(request);
}

/** Raw deterministic `GitServiceRunner`; nonzero exits are reported as a completion result. */
export function rawGitServiceRunner(): GitServiceRunner {
  return async (command) => {
    const result = await rawExec({ args: command.args, cwd: command.cwd, timeoutMs: command.timeoutMs, maxBuffer: command.maxOutputBytes });
    return { stdout: result.stdout.toString("utf8"), exitCode: result.exitCode };
  };
}

/** Raw deterministic `WorkspaceGitQuery`; a failed `git` query rejects like the tracked port. */
export function rawWorkspaceGitQuery(): WorkspaceGitQuery {
  return async (input) => {
    const result = await rawExec({ args: input.argv, cwd: input.cwd, timeoutMs: input.timeoutMs, maxBuffer: input.maxBufferBytes });
    if (result.exitCode !== 0) throw new Error(`Git query exited ${result.exitCode}`);
    return { stdout: result.stdout.toString("utf8") };
  };
}

/** Raw deterministic controlled-restore helper launcher; no prelaunch journal, tests only. */
export function rawControlledHelperSpawner(): (request: ManagedHelperLaunchRequest) => Promise<ManagedChildHandle> {
  return async (request) => adoptNodeChildProcess({ id: randomUUID(), child: spawn(request.command, [...request.args], {
    cwd: request.workspace ?? tmpdir(), env: { ...request.env }, stdio: ["pipe", "pipe", "pipe"],
  }) });
}

/** Absolute root-owned Git for fixtures that must satisfy the production trust check. */
export function trustedFixtureGit(): string {
  for (const candidate of [process.env.FLYX_TEST_GIT, "/Library/Developer/CommandLineTools/usr/bin/git", "/usr/bin/git"]) {
    if (!candidate) continue;
    try {
      const canonical = realpathSync(candidate);
      const stat = lstatSync(canonical);
      if (stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && (stat.mode & 0o6000) === 0 && (stat.mode & 0o111) !== 0) return canonical;
    } catch { /* Try the next candidate. */ }
  }
  throw new Error("MANAGED_GIT_FIXTURE_UNAVAILABLE");
}

/** Deterministic verified stop backend bound to the record's persisted raw identity. */
export function fixtureTreeStopBackend(contractId = "fixture-verified-tree-stop/v1"): ManagedGitStopBackend {
  return Object.freeze({
    kind: "fixture" as const, contractId, verifiedDescendantStop: true as const,
    verify: (record: ManagedProcessRecord) => record.processIdentity === undefined ? undefined : Object.freeze({
      kind: "verified-tree-stop" as const, sourceId: `fixture-stop:${record.id}`,
      identityDigest: processIdentityDigest(record.processIdentity), contractId,
    }),
  });
}

/** In-memory journal keeping the latest durable record per process id. */
export function memoryProcessJournal(): ProcessJournal & { records: ManagedProcessRecord[] } {
  const records: ManagedProcessRecord[] = [];
  return {
    records,
    save: (record) => {
      const index = records.findIndex((item) => item.id === record.id);
      if (index >= 0) records[index] = { ...record };
      else records.push({ ...record });
    },
  };
}

export function fixtureLaunchContext(overrides: Partial<ProcessLaunchContext> = {}): ProcessLaunchContext {
  return Object.freeze({
    hostOwnerId: "fixture-owner", hostOwnerGeneration: 1, runtimeId: "fixture-runtime",
    runtimeGeneration: 1, attemptId: "fixture-attempt", ...overrides,
  });
}

export type FixtureManagedGitRunnerOptions = {
  /** Trusted registered checkout roots; defaults to the OS temp root allowance only. */
  roots?: () => readonly string[];
  privateRoots?: readonly string[];
  journal?: ProcessJournal;
  context?: () => ProcessLaunchContext;
  gitExecutable?: string;
  pythonExecutable?: string;
};

/** Real managed runner with an opt-in deterministic stop backend; tests only. */
export function createFixtureManagedGitRunner(options: FixtureManagedGitRunnerOptions = {}): ManagedGitRunner {
  const context = options.context ?? (() => fixtureLaunchContext());
  return new ManagedGitRunner({
    journal: options.journal ?? memoryProcessJournal(),
    context: () => context(),
    stopBackend: fixtureTreeStopBackend(),
    allowFixtureStopBackend: true,
    roots: options.roots ?? (() => []),
    privateRoots: options.privateRoots ?? [],
    gitExecutable: options.gitExecutable ?? trustedFixtureGit(),
    ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}),
  });
}
