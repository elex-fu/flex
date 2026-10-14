import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parsePorcelainV1Z, type GitStatusFile } from "./porcelain-parser.js";

const execFile = promisify(execFileCallback);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;

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
  constructor(private readonly workspace: string) {}

  async status(): Promise<GitStatus> {
    try {
      const result = await execFile("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"], {
        cwd: this.workspace,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      });
      const parsed = parsePorcelainV1Z(result.stdout, MAX_FILES);
      let head: string | undefined;
      if (!parsed.unborn) {
        head = (await execFile("git", ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"], {
          cwd: this.workspace,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        })).stdout.trim();
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
      const result = await execFile("git", ["-c", "core.fsmonitor=false", "diff", baseline, "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--binary", "--"], {
        cwd: this.workspace,
        timeout: 15_000,
        maxBuffer: MAX_DIFF_BYTES + 64 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      });
      const raw = result.stdout;
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
    const format = (await execFile("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-object-format"], {
      cwd: this.workspace,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })).stdout.trim();
    if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format");
    return createHash(format).update("tree 0\0").digest("hex");
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1024;
  return value.slice(0, end);
}
