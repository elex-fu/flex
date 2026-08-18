import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;

export type GitStatus = {
  available: boolean;
  branch?: string;
  head?: string;
  dirty: boolean;
  files: Array<{ path: string; index: string; worktree: string }>;
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
      const result = await execFile("git", ["status", "--porcelain=v1", "--branch", "-z"], {
        cwd: this.workspace,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      });
      const fields = result.stdout.split("\0").filter(Boolean);
      const branchField = fields.shift() ?? "## unknown";
      const branch = branchField.replace(/^##\s*/, "").split("...")[0] || "unknown";
      const filesTruncated = fields.length > MAX_FILES;
      const files = fields.slice(0, MAX_FILES).map((field) => ({
        index: field.slice(0, 1),
        worktree: field.slice(1, 2),
        path: field.slice(3),
      }));
      let head: string | undefined;
      try {
        head = (await execFile("git", ["rev-parse", "HEAD"], {
          cwd: this.workspace,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        })).stdout.trim();
      } catch {
        // An unborn repository has no HEAD; status is still useful.
      }
      return { available: true, branch, ...(head ? { head } : {}), dirty: files.length > 0, files, ...(filesTruncated ? { filesTruncated: true } : {}) };
    } catch (error) {
      return { available: false, dirty: false, files: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async diff(baseHead?: string): Promise<GitDiff> {
    const status = await this.status();
    if (!status.available) return { ...status, diff: "", truncated: false };
    try {
      // Compare against HEAD so both staged and unstaged Claude edits are
      // visible.  The fixture is a normal Git repository; an unborn HEAD is
      // reported as a bounded empty diff rather than invoking a shell.
      const result = await execFile("git", ["diff", baseHead ?? "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--binary", "--"], {
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
      return { ...status, diff: "", truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1024;
  return value.slice(0, end);
}
