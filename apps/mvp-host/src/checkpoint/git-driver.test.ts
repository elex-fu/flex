import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointGitDriver, type CheckpointGitDriverOptions, type CheckpointGitRunRequest, type CheckpointGitRunResult } from "./git-driver.js";
import { fixtureGit, removeFixture, temporaryRepository, userGitState } from "./test-support.js";
import { ManagedGitError } from "../lifecycle/managed-git-runner.js";

const roots: string[] = [];
async function repository(unborn = false): Promise<string> { const root = await temporaryRepository(unborn); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });

async function runGitFixture(request: CheckpointGitRunRequest): Promise<CheckpointGitRunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(request.command, [...request.args], { cwd: request.cwd, env: { ...request.env }, encoding: "buffer", timeout: request.timeoutMs, maxBuffer: request.maxBuffer, signal: request.signal }, (error, stdout) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ stdout, exitCode: error ? Number(error.code) : 0 });
    });
    child.stdin?.on("error", () => {}); child.stdin?.end(request.input ? Buffer.from(request.input.data, "base64") : undefined);
  });
}
function barrier<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
/** Real driver on the raw deterministic fixture runner; managed launch semantics need the lifecycle tests. */
function makeDriver(root: string, options: Omit<CheckpointGitDriverOptions, "runGit"> = {}): CheckpointGitDriver {
  return new CheckpointGitDriver(root, { ...options, runGit: runGitFixture });
}

describe("controlled checkpoint Git driver", { timeout: 30_000 }, () => {
  it.each(["unknown","stopped","not_spawned"] as const)("retains managed %s producer failure and original operation binding",async(state)=>{
    const root=await repository(),checkpointId=randomUUID(),evidence={processId:"exact-original-process",launchDigest:"a".repeat(64),purpose:"checkpoint_read" as const,policyId:"checkpoint-policy",operationId:checkpointId,bindingDigest:"b".repeat(64)},cause=new ManagedGitError("MANAGED_GIT_TREE_STOP_UNPROVEN",state,evidence);
    const driver=new CheckpointGitDriver(root,{runGit:async()=>{throw cause;}});
    await expect(driver.capture(checkpointId)).rejects.toMatchObject({code:cause.code,cause,producerFailure:{code:cause.code,state,producerStopped:state!=="unknown",helper:evidence,operation:{kind:"capture",checkpointId},requestBinding:expect.stringMatching(/^[a-f0-9]{64}$/)}});
  });
  it("registers immutable final Git requests before launch with isolated environment and stdin budgets", async () => {
    const root = await realpath(await repository()), records: CheckpointGitRunRequest[] = [], boundaries: string[] = [];
    const originalSecret = process.env.FLYX_CHECKPOINT_GIT_SECRET, originalIndex = process.env.GIT_INDEX_FILE;
    const user = await userGitState(root);
    process.env.FLYX_CHECKPOINT_GIT_SECRET = "Host-only-test-value"; process.env.GIT_INDEX_FILE = "/unrelated/client-index";
    const id = randomUUID();
    try {
      const driver = new CheckpointGitDriver(root, { runGit: async (request) => {
        expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.args)).toBe(true); expect(Object.isFrozen(request.env)).toBe(true); expect(Object.isFrozen(request.operation)).toBe(true);
        expect(request.workspace).toBe(root); expect(request.command).toBe("git"); expect(request.timeoutMs).toBe(30_000); expect(request.maxBuffer).toBeGreaterThan(0);
        expect(request.env.FLYX_CHECKPOINT_GIT_SECRET).toBeUndefined(); expect(request.env.GIT_INDEX_FILE).not.toBe("/unrelated/client-index"); expect(request.env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(request.env.GIT_CONFIG_NOSYSTEM).toBe("1"); expect(request.env.GIT_OPTIONAL_LOCKS).toBe("0");
        expect(request.args.slice(0, 4)).toEqual(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]); expect(request.operation).toEqual({ kind: "capture", checkpointId: id });
        if (request.input) { expect(Object.isFrozen(request.input)).toBe(true); expect(Buffer.from(request.input.data, "base64").length).toBe(request.input.bytes); expect(request.maxInputBytes).toBe(request.input.bytes); expect(() => Reflect.set(request.input!, "data", "changed")).not.toThrow(); expect(Reflect.set(request.input, "data", "changed")).toBe(false); }
        records.push(request); boundaries.push("registered");
        expect(records.at(-1)).toBe(request); boundaries.push("process-boundary"); return runGitFixture(request);
      } });
      const capture = await driver.capture(id); expect(capture.status).toBe("complete");
      expect(records.some((request) => request.args.includes("hash-object") && request.args.includes("--no-filters") && request.input?.bytes)).toBe(true);
      expect(records.some((request) => request.args.includes("update-index") && request.env.GIT_INDEX_FILE && request.env.GIT_WORK_TREE === request.cwd && request.cwd !== root)).toBe(true);
      expect(boundaries.every((value, index) => value === (index % 2 ? "process-boundary" : "registered"))).toBe(true);
    } finally { if (originalSecret === undefined) delete process.env.FLYX_CHECKPOINT_GIT_SECRET; else process.env.FLYX_CHECKPOINT_GIT_SECRET = originalSecret; if (originalIndex === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = originalIndex; }
    expect(await userGitState(root)).toEqual(user);
  });
  it("keeps concurrent historical blob reads separate from a suspended capture context", async () => {
    const root = await repository(), entered = barrier(), release = barrier(), records: CheckpointGitRunRequest[] = [];
    const oid = (await fixtureGit(root, ["rev-parse", "HEAD:tracked.txt"])).toString().trim(); let held = false;
    const driver = new CheckpointGitDriver(root, { runGit: async (request) => {
      records.push(request); if (request.operation.kind === "capture" && !held) { held = true; entered.resolve(); await release.promise; } return runGitFixture(request);
    } });
    const id = randomUUID(), capture = driver.capture(id); await entered.promise;
    expect((await driver.blob(oid))?.toString()).toBe("committed\n"); expect(records.filter((request) => request.args.includes("cat-file")).map((request) => request.operation)).toEqual([{ kind: "blob" }]);
    release.resolve(); expect((await capture).status).toBe("complete");
    expect(records.filter((request) => !request.args.includes("cat-file")).every((request) => request.operation.kind === "capture" && request.operation.checkpointId === id)).toBe(true);
  });
  it("does not reinterpret launch rejection as unborn HEAD and rejects output budget violations", async () => {
    const root = await repository(true);
    const driver = new CheckpointGitDriver(root, { runGit: async (request) => {
      if (request.args.includes("--verify") && request.args.at(-1) === "HEAD") throw Object.assign(new Error("prelaunch journal failed"), { code: 128 }); return runGitFixture(request);
    } });
    await expect(driver.capture(randomUUID())).rejects.toMatchObject({ code: "GIT_OPERATION_FAILED" });
    const bounded = new CheckpointGitDriver(root, { maxFileBytes: 3, runGit: async () => ({ stdout: Buffer.alloc(4), exitCode: 0 }) });
    await expect(bounded.blob("a".repeat(40))).rejects.toMatchObject({ code: "GIT_OUTPUT_BUDGET_EXCEEDED" });
  });
  it("cancels a queued managed launch and rejects its late successful result after seal", async () => {
    const root = await repository(), entered = barrier(), release = barrier(); let launched = 0; let signal: AbortSignal | undefined;
    const driver = new CheckpointGitDriver(root, { runGit: async (request) => { signal = request.signal; entered.resolve(); await release.promise; if (!request.signal.aborted) launched++; return { stdout: Buffer.from(root), exitCode: 0 }; } });
    const work = driver.capture(randomUUID()); await entered.promise; driver.seal(); expect(signal?.aborted).toBe(true); release.resolve();
    await expect(work).rejects.toMatchObject({ code: "CHECKPOINT_GIT_SEALED" }); expect(launched).toBe(0); await expect(driver.fingerprint()).rejects.toMatchObject({ code: "CHECKPOINT_GIT_SEALED" });
  });
  it("retains workspace/index independently without changing the user's staged index, HEAD or branch", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "staged\n"); await fixtureGit(root, ["add", "--", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "user workspace\n");
    await writeFile(join(root, "new file\nwith space.txt"), "untracked bytes\n");
    await writeFile(join(root, ".gitignore"), "ignored.log\n"); await writeFile(join(root, "ignored.log"), "ignored\n");
    const user = await userGitState(root); const driver = makeDriver(root); const id = randomUUID(); const capture = await driver.capture(id);
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
    const user = await userGitState(root); const driver = makeDriver(root); const capture = await driver.capture(randomUUID());
    expect(capture.status).toBe("complete"); expect(capture.head).toBeUndefined(); expect(await userGitState(root)).toEqual(user);
    expect(await fixtureGit(root, ["ls-tree", capture.indexTree!])).toEqual(Buffer.alloc(0));
    expect(await fixtureGit(root, ["show", `${capture.workspaceTree}:binary.dat`])).toEqual(Buffer.from([0, 255, 1]));
    expect((await fixtureGit(root, ["show", `${capture.workspaceTree}:link`])).toString()).toBe(join(outside, "secret.txt"));
    expect(capture.entries.find((entry) => entry.path === "link")?.mode).toBe("120000");
    expect(capture.entries.find((entry) => entry.path === "run.sh")?.mode).toBe("100755");
  });
  it("preserves both rename paths, including newline/space names, and recognizes copies", async () => {
    const root = await repository(); const driver = makeDriver(root);
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
    const driver = makeDriver(root);
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
    const driver = new CheckpointGitDriver(root, { runGit: runGitFixture, onBoundary: async (boundary) => {
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
    const user = await userGitState(root); const driver = makeDriver(root); const conflict = await driver.capture(randomUUID());
    expect(conflict.status).toBe("unsupported"); expect(conflict.indexTree).toBeUndefined(); expect(conflict.workspaceTree).toBeTruthy();
    expect(conflict.unsupported).toContainEqual({ path: "tracked.txt", reason: "index_conflict" }); expect(await userGitState(root)).toEqual(user);
    const other = await repository(); const commit = (await fixtureGit(other, ["rev-parse", "HEAD"])).toString().trim();
    await fixtureGit(other, ["update-index", "--add", "--cacheinfo", `160000,${commit},submodule`]);
    await mkdir(join(other, "submodule")); await writeFile(join(other, "submodule", "dirty"), "not a recursive snapshot");
    const sub = await makeDriver(other).capture(randomUUID());
    expect(sub.status).toBe("unsupported"); expect(sub.unsupported).toContainEqual({ path: "submodule", reason: "submodule_worktree_not_captured" });
  });
  it("does not read tracked files through a replaced parent symlink", async () => {
    const root = await repository(); const outside = await repository(true);
    await mkdir(join(root, "dir")); await writeFile(join(root, "dir", "file.txt"), "inside\n");
    await fixtureGit(root, ["add", "--", "dir/file.txt"]); await fixtureGit(root, ["commit", "-m", "directory"]);
    await writeFile(join(outside, "file.txt"), "outside secret\n"); await rm(join(root, "dir"), { recursive: true }); await symlink(outside, join(root, "dir"));
    const capture = await makeDriver(root).capture(randomUUID());
    expect(capture.status).toBe("unsupported"); expect(capture.entries.find((entry) => entry.path === "dir/file.txt")).toMatchObject({ kind: "unsupported", unsupported: "parent_symlink" });
    expect(capture.entries.find((entry) => entry.path === "dir/file.txt")?.oid).toBeUndefined();
  });
  it("labels index flags and intent-to-add as unsupported restore semantics without changing them", async () => {
    const root = await repository(); await writeFile(join(root, "intent.txt"), "intent bytes\n");
    await fixtureGit(root, ["add", "-N", "--", "intent.txt"]); const user = await userGitState(root);
    const driver = makeDriver(root); const intent = await driver.capture(randomUUID());
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
    const capture = await makeDriver(root).capture(randomUUID()); expect(capture.status).toBe("complete"); expect(await userGitState(root)).toEqual(user);
    const bounded = await makeDriver(root, { maxFileBytes: 3 }).capture(randomUUID());
    expect(bounded.status).toBe("unsupported"); expect(bounded.unsupported).toContainEqual({ path: "tracked.txt", reason: "file_exceeds_capture_budget" });
    await writeFile(join(root, "another.txt"), "new");
    await expect(makeDriver(root, { maxFiles: 1 }).capture(randomUUID())).rejects.toMatchObject({ code: "CAPTURE_BUDGET_EXCEEDED" });
  });
});
