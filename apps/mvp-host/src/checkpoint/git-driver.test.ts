import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointGitDriver } from "./git-driver.js";
import { fixtureGit, removeFixture, temporaryRepository, userGitState } from "./test-support.js";

const roots: string[] = [];
async function repository(unborn = false): Promise<string> { const root = await temporaryRepository(unborn); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });

describe("controlled checkpoint Git driver", { timeout: 30_000 }, () => {
  it("retains workspace/index independently without changing the user's staged index, HEAD or branch", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "staged\n"); await fixtureGit(root, ["add", "--", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "user workspace\n");
    await writeFile(join(root, "new file\nwith space.txt"), "untracked bytes\n");
    await writeFile(join(root, ".gitignore"), "ignored.log\n"); await writeFile(join(root, "ignored.log"), "ignored\n");
    const user = await userGitState(root); const driver = new CheckpointGitDriver(root); const id = randomUUID(); const capture = await driver.capture(id);
    expect(capture.status).toBe("complete"); expect(await userGitState(root)).toEqual(user);
    expect((await fixtureGit(root, ["show", `${capture.workspaceTree}:tracked.txt`])).toString()).toBe("user workspace\n");
    expect((await fixtureGit(root, ["show", `${capture.indexTree}:tracked.txt`])).toString()).toBe("staged\n");
    expect(capture.entries.map((entry) => entry.path)).toContain("new file\nwith space.txt");
    expect(capture.entries.map((entry) => entry.path)).not.toContain("ignored.log");
    expect(capture.statusEntries).toContainEqual({ path: "tracked.txt", index: "M", worktree: "M" });
    await fixtureGit(root, ["gc", "--prune=now"]);
    expect((await fixtureGit(root, ["rev-parse", `${driver.ref(id, "index")}^{tree}`])).toString().trim()).toBe(capture.indexTree);
    expect((await fixtureGit(root, ["rev-parse", `${driver.ref(id, "workspace")}^{tree}`])).toString().trim()).toBe(capture.workspaceTree);
  });
  it("captures unborn HEAD, binary, symlink and executable bytes without reading through links", async () => {
    const root = await repository(true); const outside = await repository(true);
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 1]));
    await writeFile(join(root, "run.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(root, "run.sh"), 0o755);
    await symlink(join(outside, "secret.txt"), join(root, "link"));
    const user = await userGitState(root); const driver = new CheckpointGitDriver(root); const capture = await driver.capture(randomUUID());
    expect(capture.status).toBe("complete"); expect(capture.head).toBeUndefined(); expect(await userGitState(root)).toEqual(user);
    expect(await fixtureGit(root, ["ls-tree", capture.indexTree!])).toEqual(Buffer.alloc(0));
    expect(await fixtureGit(root, ["show", `${capture.workspaceTree}:binary.dat`])).toEqual(Buffer.from([0, 255, 1]));
    expect((await fixtureGit(root, ["show", `${capture.workspaceTree}:link`])).toString()).toBe(join(outside, "secret.txt"));
    expect(capture.entries.find((entry) => entry.path === "link")?.mode).toBe("120000");
    expect(capture.entries.find((entry) => entry.path === "run.sh")?.mode).toBe("100755");
  });
  it("preserves both rename paths, including newline/space names, and recognizes copies", async () => {
    const root = await repository(); const driver = new CheckpointGitDriver(root);
    const before = await driver.capture(randomUUID());
    await fixtureGit(root, ["mv", "--", "tracked.txt", "renamed file\nname.txt"]);
    const renamed = await driver.capture(randomUUID());
    const diff = await driver.diff(before.workspaceTree!, renamed.workspaceTree!, "rename");
    expect(diff).toHaveLength(1); expect(diff[0]).toMatchObject({ status: "renamed", oldPath: "tracked.txt", path: "renamed file\nname.txt" });
    expect(renamed.statusEntries).toContainEqual({ path: "renamed file\nname.txt", originalPath: "tracked.txt", index: "R", worktree: " " });
    await writeFile(join(root, "copied file.txt"), "committed\n");
    const copy = await driver.capture(randomUUID()); const copiedDiff = await driver.diff(renamed.workspaceTree!, copy.workspaceTree!, "copy");
    expect(copiedDiff).toHaveLength(1); expect(copiedDiff[0]).toMatchObject({ status: "copied", oldPath: "renamed file\nname.txt", path: "copied file.txt" });
  });
  it("never executes clean/smudge, ext-diff, textconv or FSmonitor commands", async () => {
    const root = await repository(); const marker = join(root, "COMMAND_EXECUTED");
    await writeFile(join(root, ".gitattributes"), "tracked.txt filter=evil diff=evil\n");
    const command = `sh -c 'touch "${marker}"; cat'`;
    for (const key of ["filter.evil.clean", "filter.evil.smudge", "diff.evil.command", "diff.evil.textconv", "diff.external", "core.fsmonitor"]) await fixtureGit(root, ["config", key, command]);
    await fixtureGit(root, ["config", "filter.evil.required", "true"]);
    const driver = new CheckpointGitDriver(root);
    const controlled = driver as unknown as { git: (args: string[], options?: unknown) => Promise<unknown> };
    const actual = controlled.git.bind(driver);
    controlled.git = async (args, options) => {
      const result = await actual(args, options);
      if (await lstat(marker).catch(() => undefined)) throw new Error(`External command ran during ${args.join(" ")}`);
      return result;
    };
    const before = await driver.capture(randomUUID());
    await writeFile(join(root, "tracked.txt"), "raw unfiltered bytes\n"); const after = await driver.capture(randomUUID());
    const entries = await driver.diff(before.workspaceTree!, after.workspaceTree!, "safe-diff");
    await driver.patch(before.workspaceTree!, after.workspaceTree!, entries.find((entry) => entry.path === "tracked.txt")!);
    expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
    expect((await fixtureGit(root, ["show", `${after.workspaceTree}:tracked.txt`])).toString()).toBe("raw unfiltered bytes\n");
  });
  it("labels external file/index sampling races without overwriting the external index update", async () => {
    const root = await repository(); let externalState: Awaited<ReturnType<typeof userGitState>> | undefined;
    const driver = new CheckpointGitDriver(root, { onBoundary: async (boundary) => {
      if (boundary === "workspace_read") {
        await writeFile(join(root, "tracked.txt"), "external edit\n"); await fixtureGit(root, ["add", "--", "tracked.txt"]);
        externalState = await userGitState(root);
      }
    } });
    const capture = await driver.capture(randomUUID());
    expect(capture.status).toBe("raced"); expect(capture.samplingConsistency).toBe("raced");
    expect(capture.warnings).toContain("index_changed_during_capture"); expect(capture.warnings).toContain("workspace_changed_during_capture");
    expect(await userGitState(root)).toEqual(externalState);
    expect((await fixtureGit(root, ["show", `${capture.workspaceTree}:tracked.txt`])).toString()).toBe("committed\n");
  });
  it("reports conflict index and submodule limitations explicitly while retaining the supported workspace tree", async () => {
    const root = await repository();
    const oid = (await fixtureGit(root, ["rev-parse", "HEAD:tracked.txt"])).toString().trim();
    await fixtureGit(root, ["update-index", "--index-info"], Buffer.from(`0 ${"0".repeat(40)}\ttracked.txt\n100644 ${oid} 1\ttracked.txt\n100644 ${oid} 2\ttracked.txt\n100644 ${oid} 3\ttracked.txt\n`));
    const user = await userGitState(root); const driver = new CheckpointGitDriver(root); const conflict = await driver.capture(randomUUID());
    expect(conflict.status).toBe("unsupported"); expect(conflict.indexTree).toBeUndefined(); expect(conflict.workspaceTree).toBeTruthy();
    expect(conflict.unsupported).toContainEqual({ path: "tracked.txt", reason: "index_conflict" }); expect(await userGitState(root)).toEqual(user);
    const other = await repository(); const commit = (await fixtureGit(other, ["rev-parse", "HEAD"])).toString().trim();
    await fixtureGit(other, ["update-index", "--add", "--cacheinfo", `160000,${commit},submodule`]);
    await mkdir(join(other, "submodule")); await writeFile(join(other, "submodule", "dirty"), "not a recursive snapshot");
    const sub = await new CheckpointGitDriver(other).capture(randomUUID());
    expect(sub.status).toBe("unsupported"); expect(sub.unsupported).toContainEqual({ path: "submodule", reason: "submodule_worktree_not_captured" });
  });
  it("does not read tracked files through a replaced parent symlink", async () => {
    const root = await repository(); const outside = await repository(true);
    await mkdir(join(root, "dir")); await writeFile(join(root, "dir", "file.txt"), "inside\n");
    await fixtureGit(root, ["add", "--", "dir/file.txt"]); await fixtureGit(root, ["commit", "-m", "directory"]);
    await writeFile(join(outside, "file.txt"), "outside secret\n"); await rm(join(root, "dir"), { recursive: true }); await symlink(outside, join(root, "dir"));
    const capture = await new CheckpointGitDriver(root).capture(randomUUID());
    expect(capture.status).toBe("unsupported"); expect(capture.entries.find((entry) => entry.path === "dir/file.txt")).toMatchObject({ kind: "unsupported", unsupported: "parent_symlink" });
    expect(capture.entries.find((entry) => entry.path === "dir/file.txt")?.oid).toBeUndefined();
  });
  it("labels index flags and intent-to-add as unsupported restore semantics without changing them", async () => {
    const root = await repository(); await writeFile(join(root, "intent.txt"), "intent bytes\n");
    await fixtureGit(root, ["add", "-N", "--", "intent.txt"]); const user = await userGitState(root);
    const driver = new CheckpointGitDriver(root); const intent = await driver.capture(randomUUID());
    expect(intent.status).toBe("unsupported"); expect(intent.unsupported).toContainEqual({ path: "intent.txt", reason: "index_intent_to_add_not_restorable" });
    expect(await userGitState(root)).toEqual(user);
    await fixtureGit(root, ["update-index", "--assume-unchanged", "--", "tracked.txt"]);
    const flags = await driver.capture(randomUUID()); expect(flags.unsupported).toContainEqual({ path: "tracked.txt", reason: "index_assume_unchanged_not_restorable" });
    expect(await driver.resolveCommit("HEAD")).toBe(flags.head);
    expect(await driver.listTree(flags.workspaceTree!)).toContainEqual(expect.objectContaining({ path: "intent.txt", mode: "100644" }));
    await expect(driver.resolveCommit("--upload-pack=malicious")).rejects.toMatchObject({ code: "INVALID_GIT_REF" });
  });
  it("uses copied split indexes and labels capture budgets instead of silently dropping files", async () => {
    const root = await repository(); await fixtureGit(root, ["update-index", "--split-index"]); const user = await userGitState(root);
    const capture = await new CheckpointGitDriver(root).capture(randomUUID()); expect(capture.status).toBe("complete"); expect(await userGitState(root)).toEqual(user);
    const bounded = await new CheckpointGitDriver(root, { maxFileBytes: 3 }).capture(randomUUID());
    expect(bounded.status).toBe("unsupported"); expect(bounded.unsupported).toContainEqual({ path: "tracked.txt", reason: "file_exceeds_capture_budget" });
    await writeFile(join(root, "another.txt"), "new");
    await expect(new CheckpointGitDriver(root, { maxFiles: 1 }).capture(randomUUID())).rejects.toMatchObject({ code: "CAPTURE_BUDGET_EXCEEDED" });
  });
});
