import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorktreeError, type ManagedWorktreeRecord, type WorktreeSnapshot } from "./worktree-store.js";

export type RawTreeEntry = { path: string; mode: string; oid: string };
export type RawFingerprint = { head?: string; branch?: string; workspaceDigest: string; indexDigest: string; pathDigest: string; digest: string };
export interface RawCheckpointObjects {
  resolveCommit(ref: string): Promise<string>;
  listTree(oid: string): Promise<RawTreeEntry[]>;
  blob(oid: string): Promise<Buffer | undefined>;
  fingerprint(): Promise<RawFingerprint>;
  ref(id: string, layer: "workspace" | "index"): string;
  capture(id: string): Promise<{
    status: string; workspaceCommit?: string | undefined; indexCommit?: string | undefined; head?: string | undefined;
    workspaceTree?: string | undefined; indexTree?: string | undefined; workspaceDigest?: string | undefined; indexDigest?: string | undefined;
    beforeSampling?: RawFingerprint | undefined; afterSampling?: RawFingerprint | undefined;
  }>;
}
export type WorktreeMutation = <T>(boundary: string, planned: unknown, apply: () => Promise<T>) => Promise<T>;
export type WorktreeRegistration = { path: string; head: string; branch?: string };
export interface WorktreeGit {
  resolve(repository: string, ref: string): Promise<string>;
  validate(repository: string, commit: string, destination: string): Promise<void>;
  registration(repository: string, path: string): Promise<WorktreeRegistration | undefined>;
  register(repository: string, path: string, commit: string, branchName?: string): Promise<unknown>;
  materialize(repository: string, path: string, workspaceCommit: string, indexTreeOrCommit: string, mutate: WorktreeMutation): Promise<unknown>;
  fingerprint(path: string): Promise<RawFingerprint>;
  ignored(repository: string, path: string): Promise<string[]>;
  snapshot(path: string, id: string, record: ManagedWorktreeRecord, expected: RawFingerprint): Promise<WorktreeSnapshot>;
  retain(repository: string, snapshot: WorktreeSnapshot): Promise<void>;
  verifySnapshot(repository: string, snapshot: WorktreeSnapshot): Promise<void>;
  retentionState(repository: string, snapshot: WorktreeSnapshot): Promise<"ready" | "missing" | "conflict">;
  move(repository: string, source: string, destination: string, snapshot: WorktreeSnapshot): Promise<void>;
  remove(repository: string, path: string, snapshot: WorktreeSnapshot): Promise<void>;
  inspect(repository: string, path: string, workspaceCommit: string, indexTreeOrCommit: string, allowMissing?: boolean): Promise<"absent" | "partial" | "complete" | "conflict">;
}
export type RawWorktreeGitOptions = {
  objects(path: string): RawCheckpointObjects;
  /** Parent can connect this to managed-process recording; Git descendants cannot run repo hooks/filters. */
  onSpawn?(child: ChildProcess, argv: readonly string[]): void;
  onExit?(child: ChildProcess): void;
  maxFiles?: number; maxBytes?: number;
};
const CONFIG = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "core.untrackedCache=false", "core.preloadIndex=false", "core.attributesFile=/dev/null", "submodule.recurse=false", "gc.auto=0", "maintenance.auto=false", "commit.gpgSign=false", "diff.external="];
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"); }
async function stat(path: string): Promise<Stats | undefined> { try { return await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; } }
function hash(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); }
export function validateWorktreeFile(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || process.platform === "win32" && path.includes("\\")) throw new WorktreeError("WORKTREE_UNSUPPORTED_PATH", "Git tree path is outside the controlled namespace");
}

/** Register with --no-checkout, then write immutable object bytes ourselves. No checkout/add/reset/clean/filter. */
export class RawWorktreeGit implements WorktreeGit {
  constructor(private readonly options: RawWorktreeGitOptions) {}
  async resolve(repository: string, ref: string): Promise<string> { return this.options.objects(repository).resolveCommit(ref); }
  async validate(repository: string, commit: string, destination: string): Promise<void> {
    const objects = this.options.objects(repository), entries = await objects.listTree(commit);
    if (entries.length > (this.options.maxFiles ?? 100_000)) throw new WorktreeError("WORKTREE_BUDGET_EXCEEDED", "Git tree has too many files");
    for (const entry of entries) {
      validateWorktreeFile(entry.path); this.oid(entry.oid);
      if (!["100644", "100755", "120000"].includes(entry.mode)) throw new WorktreeError("WORKTREE_UNSUPPORTED_TREE", "Submodules and unsupported Git modes cannot be materialized");
      if (entry.mode === "120000") {
        const bytes = await objects.blob(entry.oid); if (!bytes) throw new WorktreeError("WORKTREE_OBJECT_UNAVAILABLE", "Git symlink blob is unavailable");
        this.linkTarget(destination, entry.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
    }
  }
  async registration(repository: string, path: string): Promise<WorktreeRegistration | undefined> {
    const raw = (await this.git(repository, ["worktree", "list", "--porcelain", "-z"])).toString("utf8");
    let item: WorktreeRegistration | undefined;
    for (const field of raw.split("\0")) {
      if (field.startsWith("worktree ")) item = { path: field.slice(9), head: "" };
      else if (field.startsWith("HEAD ") && item) item.head = field.slice(5);
      else if (field.startsWith("branch ") && item) item.branch = field.slice(7);
      else if (field === "" && item) { if (resolve(item.path) === resolve(path)) return item; item = undefined; }
    }
    return item && resolve(item.path) === resolve(path) ? item : undefined;
  }
  async register(repository: string, path: string, commit: string, branchName?: string): Promise<unknown> {
    this.oid(commit);
    const existing = await this.registration(repository, path);
    if (existing) {
      if (existing.head !== commit || (existing.branch ?? undefined) !== (branchName ? "refs/heads/" + branchName : undefined)) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Generated checkout registration has changed");
      return existing;
    }
    const files = await readdir(path);
    if (files.length) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Generated checkout directory is not empty");
    if (branchName && !/^codex\/worktrees\/wt_[a-f0-9-]{36}$/.test(branchName)) throw new WorktreeError("WORKTREE_BRANCH_INVALID", "Worktree branch must use a generated ID");
    await this.git(repository, ["worktree", "add", "--no-checkout", ...(branchName ? ["-b", branchName] : ["--detach"]), "--", path, commit]);
    return (await this.registration(repository, path))!;
  }
  async materialize(repository: string, path: string, workspaceCommit: string, indexTreeOrCommit: string, mutate: WorktreeMutation): Promise<unknown> {
    await this.validate(repository, workspaceCommit, path);
    const objects = this.options.objects(repository), entries = await objects.listTree(workspaceCommit);
    const allowed = new Set(entries.map((entry) => entry.path));
    for (const file of await this.files(path)) if (!allowed.has(file)) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Generated checkout contains an unexpected file");
    let total = 0;
    for (const entry of entries) {
      const data = await objects.blob(entry.oid); if (!data) throw new WorktreeError("WORKTREE_OBJECT_UNAVAILABLE", "Retained Git object is unavailable");
      total += data.length; if (total > (this.options.maxBytes ?? 512 * 1024 * 1024)) throw new WorktreeError("WORKTREE_BUDGET_EXCEEDED", "Git tree exceeds materialization budget");
      await this.parents(path, entry.path, mutate);
      const absolute = join(path, entry.path), current = await stat(absolute);
      if (current) {
        await this.assertEntry(path, entry, data);
        await mutate("file_write:" + hash(entry.path).slice(0, 24), { path: entry.path, oid: entry.oid, mode: entry.mode }, async () => {
          await this.assertEntry(path, entry, data);
          return { path: entry.path, sha256: hash(data), bytes: data.length };
        });
        continue;
      }
      await mutate("file_write:" + hash(entry.path).slice(0, 24), { path: entry.path, oid: entry.oid, mode: entry.mode }, async () => {
        await this.parents(path, entry.path, mutate);
        if (entry.mode === "120000") { const target = new TextDecoder("utf-8", { fatal: true }).decode(data); this.linkTarget(path, entry.path, target); await symlink(target, absolute); }
        else {
          const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode === "100755" ? 0o755 : 0o644);
          try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        }
        return { path: entry.path, sha256: hash(data), bytes: data.length };
      });
    }
    this.oid(indexTreeOrCommit);
    const expectedTree = (await this.git(repository, ["rev-parse", "--verify", indexTreeOrCommit + "^{tree}"])).toString("ascii").trim();
    const currentTree = await this.indexTree(path);
    if (currentTree && currentTree !== expectedTree) throw new WorktreeError("WORKTREE_INDEX_CONFLICT", "Generated checkout index changed outside this operation");
    await mutate("index_write", { tree: expectedTree }, async () => {
      const actual = await this.indexTree(path);
      if (actual && actual !== expectedTree) throw new WorktreeError("WORKTREE_INDEX_CONFLICT", "Generated checkout index changed outside this operation");
      if (!actual) await this.writeIndex(path, expectedTree);
      if (await this.indexTree(path) !== expectedTree) throw new WorktreeError("WORKTREE_INDEX_CONFLICT", "Generated checkout index cannot be verified");
      return { tree: expectedTree };
    });
    return { files: entries.length, bytes: total, indexTree: expectedTree };
  }
  async fingerprint(path: string): Promise<RawFingerprint> { return this.options.objects(path).fingerprint(); }
  async ignored(_repository: string, path: string): Promise<string[]> { return (await this.git(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(Boolean); }
  async snapshot(path: string, id: string, record: ManagedWorktreeRecord, expected: RawFingerprint): Promise<WorktreeSnapshot> {
    const live = this.options.objects(path), source = this.options.objects(record.repositoryRoot);
    const workspaceCapture = live.ref(id, "workspace"), indexCapture = live.ref(id, "index");
    let workspaceCommit = await this.optionalCommit(source, workspaceCapture), indexCommit = await this.optionalCommit(source, indexCapture);
    if (!!workspaceCommit !== !!indexCommit) throw new WorktreeError("WORKTREE_CAPTURE_UNKNOWN", "Snapshot capture refs are incomplete");
    if (!workspaceCommit) {
      const capture = await live.capture(id);
      if (capture.status !== "complete" || !capture.workspaceCommit || !capture.indexCommit || !capture.head || !capture.workspaceTree || !capture.indexTree || capture.beforeSampling?.digest !== expected.digest || capture.afterSampling?.digest !== expected.digest) throw new WorktreeError("WORKTREE_CAPTURE_UNAVAILABLE", "Worktree snapshot is unsupported or raced");
      workspaceCommit = capture.workspaceCommit; indexCommit = capture.indexCommit;
    }
    if (!workspaceCommit || !indexCommit || !expected.head) throw new WorktreeError("WORKTREE_CAPTURE_UNAVAILABLE", "Worktree snapshot has no exact HEAD/index binding");
    if ((await live.fingerprint()).digest !== expected.digest || await this.inspect(record.repositoryRoot, path, workspaceCommit, indexCommit) !== "complete") throw new WorktreeError("WORKTREE_CAPTURE_UNAVAILABLE", "Worktree changed during snapshot capture");
    const prefix = "refs/flyx/worktrees/" + record.worktreeId + "/" + id;
    return { snapshotId: id, worktreeId: record.worktreeId, repositoryId: record.repositoryId, workspaceCommit, indexCommit, headCommit: expected.head,
      workspaceTree: (await this.git(record.repositoryRoot, ["rev-parse", workspaceCommit + "^{tree}"])).toString("ascii").trim(),
      indexTree: (await this.git(record.repositoryRoot, ["rev-parse", indexCommit + "^{tree}"])).toString("ascii").trim(),
      workspaceDigest: expected.workspaceDigest, indexDigest: expected.indexDigest, workspaceRef: prefix + "/workspace", indexRef: prefix + "/index", headRef: prefix + "/head" };
  }
  async retain(repository: string, snapshot: WorktreeSnapshot): Promise<void> {
    const objects = this.options.objects(repository);
    const pairs = [[snapshot.workspaceRef, snapshot.workspaceCommit], [snapshot.indexRef, snapshot.indexCommit], [snapshot.headRef, snapshot.headCommit]];
    const present = await Promise.all(pairs.map(async ([ref, oid]) => { const actual = await this.optionalCommit(objects, ref!); if (actual && actual !== oid) throw new WorktreeError("WORKTREE_SNAPSHOT_REF_CHANGED", "Retained snapshot ref changed"); return !!actual; }));
    if (present.every(Boolean)) return;
    if (present.some(Boolean)) throw new WorktreeError("WORKTREE_SNAPSHOT_REF_CHANGED", "Retained snapshot refs are incomplete");
    await this.git(repository, ["update-ref", "--stdin"], Buffer.from(["start", ...pairs.map(([ref, oid]) => "create " + ref + " " + oid), "prepare", "commit", ""].join("\n")));
  }
  async retentionState(repository: string, snapshot: WorktreeSnapshot): Promise<"ready" | "missing" | "conflict"> {
    const objects = this.options.objects(repository);
    const pairs = [[snapshot.workspaceRef, snapshot.workspaceCommit], [snapshot.indexRef, snapshot.indexCommit], [snapshot.headRef, snapshot.headCommit]];
    let available = 0;
    for (const [ref, oid] of pairs) { const actual = await this.optionalCommit(objects, ref!); if (actual && actual !== oid) return "conflict"; if (actual) available += 1; }
    return available === pairs.length ? "ready" : available === 0 ? "missing" : "conflict";
  }
  async verifySnapshot(repository: string, snapshot: WorktreeSnapshot): Promise<void> {
    if (await this.retentionState(repository, snapshot) !== "ready") throw new WorktreeError("WORKTREE_SNAPSHOT_UNAVAILABLE", "Retained snapshot ref is missing or changed");
  }
  async move(repository: string, source: string, destination: string, snapshot: WorktreeSnapshot): Promise<void> {
    await this.verifySnapshot(repository, snapshot);
    const sourceRegistration = await this.registration(repository, source), destinationRegistration = await this.registration(repository, destination);
    if (!await stat(source) && await stat(destination) && destinationRegistration?.head === snapshot.headCommit && !sourceRegistration) return;
    if (!sourceRegistration || sourceRegistration.head !== snapshot.headCommit || destinationRegistration || await stat(destination)) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Archive quarantine registration changed");
    if (await this.inspect(repository, source, snapshot.workspaceCommit, snapshot.indexCommit) !== "complete" || (await this.ignored(repository, source)).length) throw new WorktreeError("WORKTREE_ARCHIVE_CHANGED", "Worktree changed after its retained snapshot");
    await this.git(repository, ["worktree", "move", "--", source, destination]);
  }
  async remove(repository: string, path: string, snapshot: WorktreeSnapshot): Promise<void> {
    await this.verifySnapshot(repository, snapshot);
    const entry = await stat(path), registration = await this.registration(repository, path);
    if (!entry && !registration) return;
    if (entry && (await this.inspect(repository, path, snapshot.workspaceCommit, snapshot.indexCommit, true)) === "conflict") throw new WorktreeError("WORKTREE_ARCHIVE_CHANGED", "Quarantine has unsaved or changed files");
    if (entry && registration && (await this.ignored(repository, path)).length) throw new WorktreeError("WORKTREE_IGNORED_FILES", "Ignored files require separate preservation before archive");
    if (!registration) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Archive path lost its registered Git identity");
    await this.git(repository, ["worktree", "remove", "--force", "--", path]);
  }
  async inspect(repository: string, path: string, workspaceCommit: string, indexTreeOrCommit: string, allowMissing = false): Promise<"absent" | "partial" | "complete" | "conflict"> {
    const entry = await stat(path); if (!entry) return "absent";
    if (!entry.isDirectory() || entry.isSymbolicLink()) return "conflict";
    const objects = this.options.objects(repository), entries = await objects.listTree(workspaceCommit), allowed = new Set(entries.map((item) => item.path));
    let partial = false;
    try {
      for (const file of await this.files(path)) if (!allowed.has(file)) return "conflict";
      for (const item of entries) { const current = await stat(join(path, item.path)); if (!current) { partial = true; continue; } const data = await objects.blob(item.oid); if (!data) return "conflict"; await this.assertEntry(path, item, data); }
      const expected = (await this.git(repository, ["rev-parse", indexTreeOrCommit + "^{tree}"])).toString("ascii").trim();
      const tree = await this.indexTree(path);
      if (tree && tree !== expected) return "conflict";
      if (!tree) partial = true;
      return partial ? "partial" : "complete";
    } catch { return "conflict"; }
  }
  private async indexTree(path: string): Promise<string | undefined> {
    const indexPath = (await this.git(path, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).toString("utf8").trim();
    const indexStat = await stat(indexPath); if (!indexStat) return undefined;
    if (!indexStat.isFile() || indexStat.isSymbolicLink()) throw new WorktreeError("WORKTREE_INDEX_CONFLICT", "Git index is not a plain file");
    const gitDirectory = (await this.git(path, ["rev-parse", "--absolute-git-dir"])).toString("utf8").trim();
    const temp = await mkdtemp(join(tmpdir(), "flyx-worktree-index-"));
    try {
      const handle = await open(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await writeFile(join(temp, "index"), await handle.readFile(), { flag: "wx", mode: 0o600 }); } finally { await handle.close(); }
      return (await this.git(temp, ["write-tree"], undefined, { GIT_DIR: gitDirectory, GIT_INDEX_FILE: join(temp, "index"), GIT_WORK_TREE: temp })).toString("ascii").trim();
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  private async writeIndex(path: string, tree: string): Promise<void> {
    const gitDirectory = (await this.git(path, ["rev-parse", "--absolute-git-dir"])).toString("utf8").trim();
    const indexPath = (await this.git(path, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).toString("utf8").trim();
    const temp = await mkdtemp(join(tmpdir(), "flyx-worktree-raw-index-"));
    try { await this.git(temp, ["read-tree", tree], undefined, { GIT_DIR: gitDirectory, GIT_INDEX_FILE: indexPath, GIT_WORK_TREE: temp }); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
  private async files(root: string, directory = root): Promise<string[]> {
    const result: string[] = [];
    for (const name of await readdir(directory)) {
      if (directory === root && name === ".git") continue;
      const path = join(directory, name), entry = await lstat(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...await this.files(root, path));
      else result.push(relative(root, path).split(sep).join("/"));
    }
    return result;
  }
  private async parents(root: string, path: string, mutate: WorktreeMutation): Promise<void> {
    const parts = path.split("/").slice(0, -1); let current = root;
    for (const part of parts) {
      current = join(current, part); const found = await stat(current);
      if (found) { if (!found.isDirectory() || found.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Materialization parent is not a plain directory");
        const directory = current;
        await mutate("directory_write:" + hash(relative(root, directory)).slice(0, 24), { directory: relative(root, directory) }, async () => ({ directory: relative(root, directory) }));
      }
      else { const directory = current; await mutate("directory_write:" + hash(relative(root, directory)).slice(0, 24), { directory: relative(root, directory) }, async () => { await mkdir(directory, { mode: 0o700 }); return { directory: relative(root, directory) }; }); }
    }
  }
  private async assertEntry(root: string, entry: RawTreeEntry, data: Buffer): Promise<void> {
    validateWorktreeFile(entry.path);
    for (let parent = dirname(join(root, entry.path)); parent !== root; parent = dirname(parent)) { const value = await lstat(parent); if (!value.isDirectory() || value.isSymbolicLink()) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Materialization parent changed"); }
    const path = join(root, entry.path), value = await lstat(path);
    if (entry.mode === "120000") {
      if (!value.isSymbolicLink() || await readlink(path) !== new TextDecoder("utf-8", { fatal: true }).decode(data)) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Generated symlink changed"); this.linkTarget(root, entry.path, await readlink(path));
    } else {
      if (!value.isFile() || value.isSymbolicLink() || !!(value.mode & 0o111) !== (entry.mode === "100755")) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Generated file mode changed");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!(await handle.readFile()).equals(data)) throw new WorktreeError("WORKTREE_PATH_CONFLICT", "Generated file bytes changed"); } finally { await handle.close(); }
    }
  }
  private linkTarget(root: string, path: string, target: string): void { if (!target || isAbsolute(target) || !inside(root, resolve(dirname(join(root, path)), target)) || target.split("/").some((part) => part.toLowerCase() === ".git")) throw new WorktreeError("WORKTREE_UNSUPPORTED_SYMLINK", "Git symlink escapes the managed checkout"); }
  private oid(value: string): void { if (!OID.test(value)) throw new WorktreeError("WORKTREE_INVALID_OBJECT", "Worktree contains an invalid Git object ID"); }
  private async optionalCommit(objects: RawCheckpointObjects, ref: string): Promise<string | undefined> { try { return await objects.resolveCommit(ref); } catch { return undefined; } }
  private git(cwd: string, args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" }, extra);
    return new Promise((resolveResult, reject) => {
      const child = execFile("git", [...CONFIG.flatMap((config) => ["-c", config]), ...args], { cwd, env, encoding: "buffer", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        this.options.onExit?.(child);
        if (error) { reject(new WorktreeError("WORKTREE_GIT_FAILED", "Managed Git operation failed")); return; }
        resolveResult(stdout);
      });
      try { this.options.onSpawn?.(child, args); } catch (error) { child.kill("SIGTERM"); reject(error); }
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
}
