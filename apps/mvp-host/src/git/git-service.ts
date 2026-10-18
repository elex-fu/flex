import { createHash } from "node:crypto";
import { parsePorcelainV1Z, type GitStatusFile } from "./porcelain-parser.js";

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;

/**
 * One Session read command for the injected managed runner. The runner owns the
 * final config prefix, environment and budgets; this port only names the tail
 * argv and the operation so the policy can allowlist it.
 */
export type GitServiceCommand = Readonly<{
  args: readonly string[];
  cwd: string;
  operation: "status" | "head" | "object_format" | "diff";
  maxOutputBytes: number;
  timeoutMs: number;
  operationId?: string;
}>;
export type GitServiceRunner = (command: GitServiceCommand) => Promise<{ stdout: string; exitCode: number }>;
export type GitServiceOptions = {
  /** Production composes this from the managed runner. Without it no Git process is launched. */
  runner?: GitServiceRunner;
};

export type GitStatus = {
  available: boolean;
  branch?: string;
  head?: string;
  dirty: boolean;
  files: GitStatusFile[];
  filesTruncated?: boolean;
  error?: string;
};

export type GitDiff = GitStatus & {
  diff: string;
  truncated: boolean;
  baselineHead?: string;
  baselineDirty?: boolean;
  baselineWarning?: string;
};

export class GitService {
  constructor(private readonly workspace: string, private readonly options: GitServiceOptions = {}) {}

  async status(): Promise<GitStatus> {
    const runner = this.options.runner;
    if (!runner) return { available: false, dirty: false, files: [], error: "MANAGED_GIT_RUNNER_REQUIRED" };
    try {
      const result = await runner({ args: ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"],
        cwd: this.workspace, operation: "status", maxOutputBytes: 512 * 1024, timeoutMs: 10_000 });
      if (result.exitCode !== 0) throw new Error(`git status exited ${result.exitCode}`);
      const parsed = parsePorcelainV1Z(result.stdout, MAX_FILES);
      let head: string | undefined;
      if (!parsed.unborn) {
        head = (await this.run(["rev-parse", "--verify", "HEAD"], { operation: "head", maxOutputBytes: 64 * 1024, timeoutMs: 5_000 })).trim();
      }
      return { available: true, branch: parsed.branch ?? "unknown", ...(head ? { head } : {}), dirty: parsed.dirty, files: parsed.files, ...(parsed.filesTruncated ? { filesTruncated: true } : {}) };
    } catch (error) {
      return { available: false, dirty: false, files: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async diff(baseHead?: string): Promise<GitDiff> {
    const status = await this.status();
    if (!status.available) return { ...status, diff: "", truncated: false };
    try {
      // Pin the observed HEAD so staged and unstaged tracked edits are shown
      // together. Unborn repositories compare against their format's empty
      // tree; a failed command remains an unavailable diff, never a clean one.
      const baseline = baseHead ?? status.head ?? await this.emptyTree();
      const raw = await this.run(["diff", baseline, "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--binary", "--"],
        { operation: "diff", maxOutputBytes: MAX_DIFF_BYTES + 64 * 1024, timeoutMs: 15_000 });
      const bytes = Buffer.byteLength(raw, "utf8");
      if (bytes <= MAX_DIFF_BYTES) return { ...status, diff: raw, truncated: false };
      return {
        ...status,
        diff: truncateUtf8(raw, MAX_DIFF_BYTES) + "\n\n[Flyx diff truncated at 2 MiB]",
        truncated: true,
      };
    } catch (error) {
      return { ...status, available: false, diff: "", truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async emptyTree(): Promise<string> {
    const format = (await this.run(["-c", "core.fsmonitor=false", "rev-parse", "--show-object-format"], { operation: "object_format", maxOutputBytes: 64 * 1024, timeoutMs: 5_000 })).trim();
    if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format");
    return createHash(format).update("tree 0\0").digest("hex");
  }

  /** Every call rechecks the injected runner; a missing runner is a refusal, never a direct spawn. */
  private async run(args: readonly string[], limits: { operation: GitServiceCommand["operation"]; maxOutputBytes: number; timeoutMs: number; operationId?: string }): Promise<string> {
    const runner = this.options.runner;
    if (!runner) throw new Error("MANAGED_GIT_RUNNER_REQUIRED");
    const result = await runner({ args, cwd: this.workspace, ...limits });
    if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? "operation"} exited ${result.exitCode}`);
    return result.stdout;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1024;
  return value.slice(0, end);
}
