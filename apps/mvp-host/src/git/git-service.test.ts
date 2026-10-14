import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "./git-service.js";

const execFile = promisify(execFileCallback);
const repositories: string[] = [];
async function git(workspace: string, ...args: string[]): Promise<string> {
  return (await execFile("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: workspace,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  })).stdout;
}
async function repository(objectFormat: "sha1" | "sha256" = "sha1"): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "flyx-git-contract-"));
  repositories.push(workspace);
  await git(workspace, "init", "-b", "main", `--object-format=${objectFormat}`);
  await git(workspace, "config", "user.name", "Flyx Test");
  await git(workspace, "config", "user.email", "flyx-test@example.invalid");
  return workspace;
}
async function commit(workspace: string): Promise<void> {
  await git(workspace, "add", "--all");
  await git(workspace, "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "baseline");
}
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe("Git status and diff contracts", () => {
  it("returns one complete staged rename with originalPath and keeps the index untouched", async () => {
    const workspace = await repository();
    await writeFile(join(workspace, "README.md"), "initial content\n");
    await commit(workspace);
    await git(workspace, "mv", "README.md", "Renamed README.md");
    await writeFile(join(workspace, "Renamed README.md"), "initial content\nunstaged addition\n");
    const indexBefore = await readFile(join(workspace, ".git", "index"));
    const service = new GitService(workspace);
    const status = await service.status();
    expect(status).toMatchObject({ available: true, branch: "main", dirty: true, files: [{ path: "Renamed README.md", originalPath: "README.md", index: "R", worktree: "M" }] });
    expect(status.filesTruncated).toBeUndefined();
    const diff = await service.diff();
    expect(diff.available).toBe(true);
    expect(diff.error).toBeUndefined();
    expect(diff.diff).toContain("unstaged addition");
    expect(await readFile(join(workspace, ".git", "index"))).toEqual(indexBefore);
  });

  it("parses real Git copy detection with Unicode and space paths", async () => {
    const workspace = await repository();
    const source = "source line\n".repeat(20);
    await writeFile(join(workspace, "original.txt"), source);
    await commit(workspace);
    await git(workspace, "config", "status.renames", "copies");
    await writeFile(join(workspace, "复制 空格.txt"), source);
    await writeFile(join(workspace, "original.txt"), source + "changed source\n");
    await git(workspace, "add", "--all");
    const status = await new GitService(workspace).status();
    expect(status.available).toBe(true);
    expect(status.files).toHaveLength(2);
    expect(status.files).toContainEqual({ path: "复制 空格.txt", originalPath: "original.txt", index: "C", worktree: " " });
    expect(status.files).toContainEqual({ path: "original.txt", index: "M", worktree: " " });
  });

  it("reports staged, unstaged, deleted and untracked files while excluding ignored files", async () => {
    const workspace = await repository();
    await writeFile(join(workspace, ".gitignore"), "ignored.log\n");
    await writeFile(join(workspace, "staged 空格.txt"), "old staged\n");
    await writeFile(join(workspace, "unstaged.txt"), "old unstaged\n");
    await writeFile(join(workspace, "removed.txt"), "removed\n");
    await commit(workspace);
    await writeFile(join(workspace, "staged 空格.txt"), "new staged\n");
    await git(workspace, "add", "staged 空格.txt");
    await writeFile(join(workspace, "unstaged.txt"), "new unstaged\n");
    await rm(join(workspace, "removed.txt"));
    await mkdir(join(workspace, "new folder"));
    await writeFile(join(workspace, "new folder", "new file.txt"), "untracked\n");
    await writeFile(join(workspace, "ignored.log"), "ignored\n");
    const diff = await new GitService(workspace).diff();
    expect(diff.available).toBe(true);
    expect(diff.files).toEqual(expect.arrayContaining([
      { path: "staged 空格.txt", index: "M", worktree: " " },
      { path: "unstaged.txt", index: " ", worktree: "M" },
      { path: "removed.txt", index: " ", worktree: "D" },
      { path: "new folder/new file.txt", index: "?", worktree: "?" },
    ]));
    expect(diff.files).toHaveLength(4);
    expect(diff.diff).toContain("+new staged");
    expect(diff.diff).toContain("+new unstaged");
    expect(diff.diff).toContain("deleted file mode");
  });

  it("applies file limits to records when a rename contributes an extra NUL field", async () => {
    const workspace = await repository();
    await writeFile(join(workspace, "README.md"), "source\n");
    await commit(workspace);
    await git(workspace, "mv", "README.md", "000 renamed.md");
    for (let index = 1; index < 200; index++) await writeFile(join(workspace, `file-${String(index).padStart(3, "0")}.txt`), "new\n");
    const service = new GitService(workspace);
    const exact = await service.status();
    expect(exact.files).toHaveLength(200);
    expect(exact.filesTruncated).toBeUndefined();
    expect(exact.files[0]).toEqual({ path: "000 renamed.md", originalPath: "README.md", index: "R", worktree: " " });
    await writeFile(join(workspace, "file-200.txt"), "overflow\n");
    const limited = await service.status();
    expect(limited.files).toHaveLength(200);
    expect(limited.filesTruncated).toBe(true);
    expect(limited.dirty).toBe(true);
    expect(limited.files.some((file) => file.path === "DME.md")).toBe(false);
  });

  for (const objectFormat of ["sha1", "sha256"] as const) {
    it(`supports clean and dirty unborn repositories in ${objectFormat} without treating HEAD absence as a diff failure`, async () => {
      const workspace = await repository(objectFormat);
      const service = new GitService(workspace);
      const clean = await service.diff();
      expect(clean).toMatchObject({ available: true, branch: "main", dirty: false, files: [], diff: "", truncated: false });
      expect(clean.head).toBeUndefined();
      expect(clean.error).toBeUndefined();
      await writeFile(join(workspace, "first 空格.txt"), "staged first\n");
      await git(workspace, "add", "first 空格.txt");
      await writeFile(join(workspace, "first 空格.txt"), "staged first\nunstaged second\n");
      await writeFile(join(workspace, "untracked.txt"), "new\n");
      const indexBefore = await readFile(join(workspace, ".git", "index"));
      const dirty = await service.diff();
      expect(dirty.available).toBe(true);
      expect(dirty.head).toBeUndefined();
      expect(dirty.error).toBeUndefined();
      expect(dirty.files).toContainEqual({ path: "first 空格.txt", index: "A", worktree: "M" });
      expect(dirty.files).toContainEqual({ path: "untracked.txt", index: "?", worktree: "?" });
      expect(dirty.diff).toContain("+staged first");
      expect(dirty.diff).toContain("+unstaged second");
      expect(await readFile(join(workspace, ".git", "index"))).toEqual(indexBefore);
    });

  }

  it("marks invalid baseline or non-repository failures unavailable instead of successful empty diffs", async () => {
    const workspace = await repository();
    await writeFile(join(workspace, "tracked.txt"), "baseline\n");
    await commit(workspace);
    const invalid = await new GitService(workspace).diff("missing-baseline");
    expect(invalid.available).toBe(false);
    expect(invalid.error).toBeTruthy();
    const nonRepository = await mkdtemp(join(tmpdir(), "flyx-non-git-contract-"));
    repositories.push(nonRepository);
    const missing = await new GitService(nonRepository).diff();
    expect(missing.available).toBe(false);
    expect(missing.error).toBeTruthy();
  });
});
