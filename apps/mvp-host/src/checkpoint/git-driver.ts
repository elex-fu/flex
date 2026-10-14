import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdtemp, open, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CheckpointError } from "./types.js";
import type { CheckpointDiffEntry, CheckpointEntry, CheckpointFingerprint, CheckpointManifest, CheckpointStatusEntry, GitCapture } from "./types.js";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ZERO_OID = /^0+$/;
const CONFIG = [
  "core.fsmonitor=false", "core.hooksPath=/dev/null", "core.untrackedCache=false",
  "core.preloadIndex=false", "core.attributesFile=/dev/null", "gc.auto=0",
  "maintenance.auto=false", "commit.gpgSign=false", "diff.external=",
];
export type CheckpointTreeEntry = { path: string; mode: string; oid: string };
type TreeEntry = { path: string; mode: string; oid: string; stage?: number };
type Repo = { root: string; gitDirectory: string; indexPath: string };
type Sample = { fingerprint: CheckpointFingerprint; entries: CheckpointEntry[]; indexEntries: TreeEntry[]; headEntries: TreeEntry[]; unsupported: Array<{ path?: string; reason: string }>; readRaced: boolean };
export type CheckpointGitOperation = Readonly<
  { kind: "capture"; checkpointId: string } | { kind: "fingerprint" } |
  { kind: "verify"; checkpointId: string; layer: "workspace" | "index" } |
  { kind: "diff"; diffId: string } | { kind: "resolve_commit" } | { kind: "list_tree" } |
  { kind: "blob" } | { kind: "patch"; fileId: string }
>;
export type CheckpointGitRunRequest = Readonly<{
  command: "git"; args: readonly string[]; cwd: string; workspace: string;
  /** Final fixed overrides only: an injected runner must not merge arbitrary Host environment. */
  env: Readonly<Record<string, string>>;
  /** A frozen value snapshot; raw mutable byte views never cross this boundary. */
  input?: Readonly<{ encoding: "base64"; data: string; bytes: number }>;
  maxInputBytes: number; maxBuffer: number; timeoutMs: number; signal: AbortSignal;
  operation: CheckpointGitOperation;
}>;
export type CheckpointGitRunResult = { stdout: Uint8Array; exitCode: number };
/** Trusted prelaunch runner journals before spawn and proves its own lifecycle/containment contract. */
export type CheckpointGitRunner = (request: CheckpointGitRunRequest) => Promise<CheckpointGitRunResult>;
export type CheckpointGitDriverOptions = {
  runGit?: CheckpointGitRunner;
  maxFileBytes?: number; maxCaptureBytes?: number; maxFiles?: number;
  /** Deterministic fault/barrier seam; production callers normally omit it. */
  onBoundary?: (boundary: "workspace_read" | "refs_written") => Promise<void>;
};

export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function bindingDigest(value: unknown): string { return digest(stableJson(value)); }
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CheckpointError("UNSUPPORTED_PATH_ENCODING", "A Git path cannot be represented as UTF-8"); }
}
function nulFields(bytes: Buffer): Buffer[] {
  const result: Buffer[] = []; let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { result.push(bytes.subarray(start, i)); start = i + 1; }
  if (start !== bytes.length) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned an incomplete NUL record");
  return result;
}
export function validateCheckpointPath(path: string): void {
  if (!path || path.includes("\0") || isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new CheckpointError("UNSUPPORTED_PATH", "A Git path is outside the controlled file namespace");
  }
  if (process.platform === "win32" && path.includes("\\")) throw new CheckpointError("UNSUPPORTED_PATH", "A Git path cannot be represented on this platform");
}
function treeEntries(bytes: Buffer, index = false): TreeEntry[] {
  return nulFields(bytes).filter((field) => field.length > 0).map((field) => {
    const tab = field.indexOf(9); if (tab < 0) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned an invalid tree record");
    const prefix = field.subarray(0, tab).toString("ascii").split(" ");
    const path = decode(field.subarray(tab + 1)); validateCheckpointPath(path);
    const mode = prefix[0] ?? ""; const oid = prefix[index ? 1 : 2] ?? "";
    if (!/^[0-7]{6}$/.test(mode) || !OID.test(oid)) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned an invalid object record");
    return { path, mode, oid, ...(index ? { stage: Number(prefix[2]) } : {}) };
  });
}
/** --raw -z has one header and one or two complete path fields; paths never split on whitespace. */
export function parseCheckpointTreeDiff(bytes: Buffer): Omit<CheckpointDiffEntry, "fileId" | "position">[] {
  const fields = nulFields(bytes); const result: Omit<CheckpointDiffEntry, "fileId" | "position">[] = [];
  for (let i = 0; i < fields.length;) {
    const header = fields[i++]?.toString("ascii");
    if (!header) continue;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([ACDMRTUX])(?:[0-9]+)?$/.exec(header);
    if (!match) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned an invalid Diff header");
    const pathField = fields[i++]; if (!pathField) throw new CheckpointError("INVALID_GIT_RECORD", "Git omitted a Diff path");
    const first = decode(pathField); validateCheckpointPath(first);
    const code = match[5]; let path = first; let oldPath: string | undefined;
    if (code === "R" || code === "C") {
      const next = fields[i++]; if (!next) throw new CheckpointError("INVALID_GIT_RECORD", "Git omitted a rename path");
      oldPath = first; path = decode(next); validateCheckpointPath(path);
    }
    const statuses = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" } as const;
    if (!(code && code in statuses)) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Diff contains an unresolved or unknown entry");
    const oldOid = match[3] ?? ""; const newOid = match[4] ?? "";
    if (!OID.test(oldOid) || !OID.test(newOid)) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned an invalid Diff object");
    result.push({ path, ...(oldPath ? { oldPath } : {}), status: statuses[code as keyof typeof statuses], oldMode: match[1] ?? "", newMode: match[2] ?? "", oldOid, newOid });
  }
  return result;
}

/** Only plumbing commands on object IDs and isolated indexes; never git add/reset/clean. */
export class CheckpointGitDriver {
  private readonly maxFileBytes: number;
  private readonly maxCaptureBytes: number;
  private readonly maxFiles: number;
  private readonly operations = new AsyncLocalStorage<CheckpointGitOperation>();
  private readonly lifecycle = new AbortController();
  constructor(readonly workspace: string, private readonly options: CheckpointGitDriverOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxCaptureBytes = options.maxCaptureBytes ?? 512 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 100_000;
  }
  usesGitRunner(runner: CheckpointGitRunner): boolean { return this.options.runGit === runner; }
  /** Cancellation asks the actual runner to stop; it is not descendant-stop proof. */
  seal(): void { this.lifecycle.abort(); }
  private operation<T>(operation: CheckpointGitOperation, work: () => Promise<T>): Promise<T> {
    if (this.lifecycle.signal.aborted) return Promise.reject(new CheckpointError("CHECKPOINT_GIT_SEALED", "Checkpoint Git execution is sealed"));
    return this.operations.run(this.operations.getStore() ?? Object.freeze(operation), work);
  }
  capture(checkpointId: string, additionalPaths: readonly string[] = []): Promise<GitCapture> {
    return this.operation({ kind: "capture", checkpointId }, () => this.captureSnapshot(checkpointId, additionalPaths));
  }
  private async captureSnapshot(checkpointId: string, additionalPaths: readonly string[]): Promise<GitCapture> {
    if (!ID.test(checkpointId)) throw new CheckpointError("INVALID_CHECKPOINT_ID", "Checkpoint refs must use a generated ID");
    const repo = await this.repo(); const temp = await mkdtemp(join(tmpdir(), "flyx-checkpoint-"));
    const copiedIndex = join(temp, "index"); const workspaceIndex = join(temp, "workspace-index");
    try {
      const before = await this.sample(repo, copiedIndex, true, additionalPaths);
      const unsupported = [...before.unsupported];
      let indexTree: string | undefined;
      if (before.indexEntries.some((entry) => entry.stage !== 0)) unsupported.push(...[...new Set(before.indexEntries.filter((entry) => entry.stage !== 0).map((entry) => entry.path))].map((path) => ({ path, reason: "index_conflict" })));
      else indexTree = this.oid(await this.objectGit(["write-tree"], { index: copiedIndex }));
      await this.objectGit(["read-tree", "--empty"], { index: workspaceIndex });
      const entries: CheckpointEntry[] = []; let captureReadRaced = false;
      for (const entry of before.entries) {
        if (entry.kind === "file" || entry.kind === "symlink") {
          // Re-read controlled bytes so a write between sampling and hashing is detected below.
          const read = await this.readEntry(repo, entry.path, entry.tracked);
          captureReadRaced ||= read.raced;
          if (!read.data || !read.entry.mode || read.entry.unsupported) { entries.push(read.entry); unsupported.push({ path: entry.path, reason: read.entry.unsupported ?? "file_disappeared_during_capture" }); continue; }
          const oid = this.oid(await this.git(["hash-object", "-w", "--no-filters", "--stdin"], { input: read.data, maxBytes: 4096 }));
          entries.push({ ...read.entry, oid });
        } else entries.push(entry);
      }
      const indexInfo: Buffer[] = [];
      for (const entry of entries) if (entry.oid && entry.mode && entry.kind !== "deleted" && entry.kind !== "unsupported") {
        indexInfo.push(Buffer.from(`${entry.mode} ${entry.oid}\t${entry.path}\0`));
      }
      await this.objectGit(["update-index", "-z", "--index-info"], { index: workspaceIndex, input: Buffer.concat(indexInfo) });
      const workspaceTree = this.oid(await this.objectGit(["write-tree"], { index: workspaceIndex }));
      const workspaceCommit = await this.commit(workspaceTree, checkpointId, "workspace", before.fingerprint.head);
      const indexCommit = indexTree ? await this.commit(indexTree, checkpointId, "index", before.fingerprint.head) : undefined;
      const workspaceRef = this.ref(checkpointId, "workspace"); const indexRef = this.ref(checkpointId, "index");
      const commands = [`start`, `create ${workspaceRef} ${workspaceCommit}`, ...(indexCommit ? [`create ${indexRef} ${indexCommit}`] : []), "prepare", "commit", ""].join("\n");
      await this.git(["update-ref", "--stdin"], { input: Buffer.from(commands) });
      await this.options.onBoundary?.("refs_written");
      await this.options.onBoundary?.("workspace_read");
      const after = await this.sample(repo, join(temp, "after-index"), false, additionalPaths);
      const capturedDigest = this.workspaceDigest(entries);
      const reasons = new Set<string>();
      if (before.readRaced || after.readRaced || captureReadRaced) reasons.add("file_changed_while_reading");
      if (before.fingerprint.head !== after.fingerprint.head || before.fingerprint.branch !== after.fingerprint.branch) reasons.add("head_or_branch_changed_during_capture");
      if (before.fingerprint.indexDigest !== after.fingerprint.indexDigest) reasons.add("index_changed_during_capture");
      if (before.fingerprint.pathDigest !== after.fingerprint.pathDigest) reasons.add("file_set_changed_during_capture");
      if (before.fingerprint.workspaceDigest !== capturedDigest || capturedDigest !== after.fingerprint.workspaceDigest) reasons.add("workspace_changed_during_capture");
      const statusEntries = await this.statusEntries(before, indexTree, workspaceTree);
      const allUnsupported = this.uniqueUnsupported([...unsupported, ...entries.filter((entry) => entry.unsupported).map((entry) => ({ path: entry.path, reason: entry.unsupported! }))]);
      const status = reasons.size ? "raced" : allUnsupported.length ? "unsupported" : "complete";
      return {
        gitDirectory: repo.gitDirectory, workspaceTree, workspaceCommit,
        ...(indexTree && indexCommit ? { indexTree, indexCommit } : {}),
        ...(before.fingerprint.head ? { head: before.fingerprint.head } : {}),
        ...(before.fingerprint.branch ? { branch: before.fingerprint.branch } : {}),
        headTree: before.fingerprint.head ? this.oid(await this.git(["rev-parse", `${before.fingerprint.head}^{tree}`])) : this.oid(await this.git(["mktree"], { input: Buffer.alloc(0) })),
        beforeSampling: before.fingerprint, afterSampling: after.fingerprint,
        samplingDigest: bindingDigest({ before: before.fingerprint, captured: capturedDigest, after: after.fingerprint }),
        workspaceDigest: capturedDigest, indexDigest: before.fingerprint.indexDigest,
        entries, statusEntries, unsupported: allUnsupported, status,
        samplingConsistency: reasons.size ? "raced" : "stable", warnings: [...reasons],
      };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  /** Revalidation reads real bytes but neither stages files nor writes Git objects/refs. */
  fingerprint(additionalPaths: readonly string[] = []): Promise<CheckpointFingerprint> {
    return this.operation({ kind: "fingerprint" }, () => this.sampleFingerprint(additionalPaths));
  }
  private async sampleFingerprint(additionalPaths: readonly string[]): Promise<CheckpointFingerprint> {
    const repo = await this.repo(); const temp = await mkdtemp(join(tmpdir(), "flyx-checkpoint-sample-"));
    try {
      const sample = await this.sample(repo, join(temp, "index"), false, additionalPaths);
      if (sample.readRaced || sample.unsupported.length) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Current workspace cannot be sampled completely");
      return sample.fingerprint;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  ref(checkpointId: string, layer: "workspace" | "index"): string {
    if (!ID.test(checkpointId)) throw new CheckpointError("INVALID_CHECKPOINT_ID", "Checkpoint refs must use a generated ID");
    return `refs/flyx/checkpoints/${checkpointId}/${layer}`;
  }
  verify(manifest: CheckpointManifest, layer: "workspace" | "index"): Promise<string> {
    return this.operation({ kind: "verify", checkpointId: manifest.checkpointId, layer }, () => this.verifyTree(manifest, layer));
  }
  private async verifyTree(manifest: CheckpointManifest, layer: "workspace" | "index"): Promise<string> {
    const expected = layer === "workspace" ? manifest.workspaceTree : manifest.indexTree;
    const ref = layer === "workspace" ? manifest.workspaceRef : manifest.indexRef;
    if (!expected || ref !== this.ref(manifest.checkpointId, layer)) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Checkpoint has no retained tree for this layer");
    const actual = await this.git(["rev-parse", "--verify", `${ref}^{tree}`], { allowFailure: true });
    if (!actual || actual.toString("ascii").trim() !== expected) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Checkpoint ref is missing or changed");
    return expected;
  }
  diff(beforeTree: string, afterTree: string, diffId: string): Promise<CheckpointDiffEntry[]> {
    return this.operation({ kind: "diff", diffId }, () => this.diffTrees(beforeTree, afterTree, diffId));
  }
  private async diffTrees(beforeTree: string, afterTree: string, diffId: string): Promise<CheckpointDiffEntry[]> {
    this.assertOid(beforeTree); this.assertOid(afterTree);
    const raw = await this.objectGit(["diff-tree", "--no-commit-id", "-r", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-M", "-C", "--find-copies-harder", beforeTree, afterTree, "--"]);
    return parseCheckpointTreeDiff(raw!).map((entry, position) => ({ ...entry, position, fileId: digest(`${diffId}\0${position}\0${entry.oldPath ?? ""}\0${entry.path}`) }));
  }
  resolveCommit(serverValidatedRef: string): Promise<string> {
    return this.operation({ kind: "resolve_commit" }, () => this.resolveCommitOid(serverValidatedRef));
  }
  private async resolveCommitOid(serverValidatedRef: string): Promise<string> {
    if (!(OID.test(serverValidatedRef) || serverValidatedRef === "HEAD" || /^refs\/(?:heads|tags|remotes|flyx)\/[a-zA-Z0-9._/-]+$/.test(serverValidatedRef)) || serverValidatedRef.includes("..") || serverValidatedRef.includes("//")) {
      throw new CheckpointError("INVALID_GIT_REF", "Commit resolution requires a server-validated ref");
    }
    return this.oid(await this.git(["rev-parse", "--verify", "--end-of-options", `${serverValidatedRef}^{commit}`]));
  }
  listTree(treeOrCommitOid: string): Promise<CheckpointTreeEntry[]> {
    return this.operation({ kind: "list_tree" }, () => this.readTreeEntries(treeOrCommitOid));
  }
  private async readTreeEntries(treeOrCommitOid: string): Promise<CheckpointTreeEntry[]> {
    this.assertOid(treeOrCommitOid);
    return treeEntries((await this.git(["ls-tree", "-r", "-z", treeOrCommitOid]))!);
  }
  blob(oid: string): Promise<Buffer | undefined> {
    return this.operation({ kind: "blob" }, () => this.readBlob(oid));
  }
  private async readBlob(oid: string): Promise<Buffer | undefined> {
    if (ZERO_OID.test(oid)) return undefined;
    this.assertOid(oid);
    return await this.git(["cat-file", "blob", oid], { maxBytes: this.maxFileBytes });
  }
  patch(beforeTree: string, afterTree: string, entry: CheckpointDiffEntry): Promise<Buffer> {
    return this.operation({ kind: "patch", fileId: entry.fileId }, () => this.readPatch(beforeTree, afterTree, entry));
  }
  private async readPatch(beforeTree: string, afterTree: string, entry: CheckpointDiffEntry): Promise<Buffer> {
    this.assertOid(beforeTree); this.assertOid(afterTree); validateCheckpointPath(entry.path);
    if (entry.oldPath) validateCheckpointPath(entry.oldPath);
    return (await this.objectGit(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "-M", beforeTree, afterTree, "--", ...(entry.oldPath ? [entry.oldPath] : []), entry.path], { maxBytes: Math.min(this.maxCaptureBytes, 64 * 1024 * 1024) }))!;
  }
  private async repo(): Promise<Repo> {
    const root = await realpath(this.workspace);
    const actual = decode((await this.git(["rev-parse", "--show-toplevel"]))!).trim();
    if (await realpath(actual) !== root) throw new CheckpointError("WORKSPACE_NOT_REPOSITORY_ROOT", "Checkpoint workspace must be a registered Git worktree root");
    const gitDirectory = decode((await this.git(["rev-parse", "--absolute-git-dir"]))!).trim();
    const indexPath = decode((await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"]))!).trim();
    return { root, gitDirectory, indexPath };
  }
  private async sample(repo: Repo, copiedIndex: string, initial: boolean, additionalPaths: readonly string[]): Promise<Sample> {
    let index: Buffer | undefined;
    try { index = await readFile(repo.indexPath); } catch (error) { if (!this.missing(error)) throw error; }
    if (index && index.length > 64 * 1024 * 1024) throw new CheckpointError("CAPTURE_BUDGET_EXCEEDED", "Git index exceeds the capture budget");
    if (index) await writeFile(copiedIndex, index, { mode: 0o600 });
    else await this.git(["read-tree", "--empty"], { index: copiedIndex });
    const indexDigest = digest(index ? Buffer.concat([Buffer.from("index\0"), index]) : "index-absent");
    const headBytes = await this.git(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const head = headBytes ? this.oid(headBytes) : undefined;
    const branchBytes = await this.git(["symbolic-ref", "-q", "HEAD"], { allowFailure: true });
    const branch = branchBytes ? decode(branchBytes).trim() : undefined;
    const indexEntries = treeEntries((await this.git(["ls-files", "--stage", "-z"], { index: copiedIndex }))!, true);
    const headEntries = head ? treeEntries((await this.git(["ls-tree", "-r", "-z", head]))!) : [];
    const untracked = nulFields((await this.git(["ls-files", "--others", "--exclude-standard", "-z"], { index: copiedIndex }))!).filter((field) => field.length).map(decode);
    const tracked = new Set([...indexEntries, ...headEntries].map((entry) => entry.path));
    const paths = [...new Set([...tracked, ...untracked, ...additionalPaths])].sort();
    if (paths.length > this.maxFiles) throw new CheckpointError("CAPTURE_BUDGET_EXCEEDED", "File catalog exceeds the capture budget");
    const gitlinks = new Map([...headEntries, ...indexEntries].filter((entry) => entry.mode === "160000").map((entry) => [entry.path, entry.oid]));
    const entries: CheckpointEntry[] = []; const unsupported: Array<{ path?: string; reason: string }> = [];
    // Tree snapshots cannot reproduce intent-to-add or user index flags; never promise exact restore for them.
    const debug = (await this.git(["ls-files", "--debug", "-z"], { index: copiedIndex }))!;
    let offset = 0;
    while (offset < debug.length) {
      const end = debug.indexOf(0, offset);
      if (end < 0) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned incomplete index metadata");
      const path = decode(debug.subarray(offset, end)); validateCheckpointPath(path);
      let debugEnd = end + 1;
      for (let line = 0; line < 5; line++) {
        const next = debug.indexOf(10, debugEnd);
        if (next < 0) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned incomplete index flags");
        debugEnd = next + 1;
      }
      const match = /flags: ([a-f0-9]+)\n$/.exec(debug.subarray(end + 1, debugEnd).toString("ascii"));
      if (!match) throw new CheckpointError("INVALID_GIT_RECORD", "Git returned unsupported index metadata");
      const flags = Number.parseInt(match[1]!, 16);
      if (flags & 0x20000000) unsupported.push({ path, reason: "index_intent_to_add_not_restorable" });
      if (flags & 0x40000000) unsupported.push({ path, reason: "index_skip_worktree_not_restorable" });
      if (flags & 0x00008000) unsupported.push({ path, reason: "index_assume_unchanged_not_restorable" });
      offset = debugEnd;
    }
    let totalBytes = 0; let readRaced = false;
    for (const path of paths) {
      validateCheckpointPath(path);
      if (gitlinks.has(path)) {
        entries.push({ path, kind: "submodule", tracked: true, mode: "160000", oid: gitlinks.get(path)!, unsupported: "submodule_worktree_not_captured" });
        unsupported.push({ path, reason: "submodule_worktree_not_captured" }); continue;
      }
      const read = await this.readEntry(repo, path, tracked.has(path));
      entries.push(read.entry); totalBytes += read.entry.bytes ?? 0; readRaced ||= read.raced;
      if (read.entry.unsupported) unsupported.push({ path, reason: read.entry.unsupported });
      if (totalBytes > this.maxCaptureBytes) throw new CheckpointError("CAPTURE_BUDGET_EXCEEDED", "Workspace bytes exceed the capture budget");
    }
    if (!initial && indexEntries.some((entry) => entry.stage !== 0)) unsupported.push({ reason: "index_conflict" });
    const workspaceDigest = this.workspaceDigest(entries); const pathDigest = bindingDigest(paths);
    const source = { ...(head ? { head } : {}), ...(branch ? { branch } : {}), indexDigest, workspaceDigest, pathDigest };
    return { fingerprint: { ...source, digest: bindingDigest(source) }, entries, indexEntries, headEntries, unsupported, readRaced };
  }
  private async readEntry(repo: Repo, path: string, tracked: boolean): Promise<{ entry: CheckpointEntry; data?: Buffer; raced: boolean }> {
    const absolute = resolve(repo.root, path);
    if (relative(repo.root, absolute).startsWith(`..${sep}`)) throw new CheckpointError("UNSUPPORTED_PATH", "Path escapes the registered workspace");
    const base = { path, tracked };
    try {
      const parents = await this.parents(repo.root, dirname(absolute));
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) {
        const data = await readlink(absolute, { encoding: "buffer" });
        const after = await lstat(absolute);
        const raced = !this.sameStat(before, after) || parents !== await this.parents(repo.root, dirname(absolute));
        return { entry: { ...base, kind: "symlink", mode: "120000", bytes: data.length, sha256: digest(data) }, data, raced };
      }
      if (!before.isFile()) return { entry: { ...base, kind: "unsupported", unsupported: "unsupported_file_type" }, raced: false };
      if (before.size > this.maxFileBytes) return { entry: { ...base, kind: "unsupported", unsupported: "file_exceeds_capture_budget" }, raced: false };
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        // Recheck parent identities and final inode before reading an open descriptor.
        if (!this.sameStat(before, opened) || parents !== await this.parents(repo.root, dirname(absolute)) || !this.sameStat(opened, await lstat(absolute))) {
          return { entry: { ...base, kind: "unsupported", unsupported: "path_changed_while_opening" }, raced: true };
        }
        const data = await handle.readFile();
        const after = await handle.stat();
        if (data.length > this.maxFileBytes) return { entry: { ...base, kind: "unsupported", unsupported: "file_exceeds_capture_budget" }, raced: true };
        const raced = !this.sameStat(opened, after) || !this.sameStat(after, await lstat(absolute)) || parents !== await this.parents(repo.root, dirname(absolute));
        return { entry: { ...base, kind: "file", mode: (opened.mode & 0o111) ? "100755" : "100644", bytes: data.length, sha256: digest(data) }, data, raced };
      } finally { await handle.close(); }
    } catch (error) {
      if (this.missing(error)) return { entry: { ...base, kind: "deleted" }, raced: false };
      if (error instanceof CheckpointError && error.code === "UNSUPPORTED_PARENT_SYMLINK") return { entry: { ...base, kind: "unsupported", unsupported: "parent_symlink" }, raced: false };
      return { entry: { ...base, kind: "unsupported", unsupported: "file_read_unavailable" }, raced: false };
    }
  }
  private async parents(root: string, parent: string): Promise<string> {
    const parts = relative(root, parent).split(sep).filter(Boolean); let current = root; const identities: string[] = [];
    for (const part of ["", ...parts]) {
      if (part) current = join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CheckpointError("UNSUPPORTED_PARENT_SYMLINK", "A controlled file has a symlink parent");
      identities.push(`${stat.dev}:${stat.ino}`);
    }
    return identities.join("/");
  }
  private sameStat(a: Stats, b: Stats): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  }
  private workspaceDigest(entries: CheckpointEntry[]): string {
    return bindingDigest(entries.map((entry) => ({ path: entry.path, kind: entry.kind, mode: entry.mode ?? null, sha256: entry.sha256 ?? null, ...(entry.kind === "submodule" ? { oid: entry.oid } : {}), unsupported: entry.unsupported ?? null })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  private async statusEntries(before: Sample, indexTree: string | undefined, workspaceTree: string): Promise<CheckpointStatusEntry[]> {
    if (!indexTree) return [...new Set(before.indexEntries.map((entry) => entry.path))].sort().map((path) => ({ path, index: "U", worktree: "U" }));
    const headTree = before.fingerprint.head ? this.oid(await this.git(["rev-parse", `${before.fingerprint.head}^{tree}`])) : this.oid(await this.git(["mktree"], { input: Buffer.alloc(0) }));
    const staged = await this.diff(headTree, indexTree, "status-index"); const work = await this.diff(indexTree, workspaceTree, "status-workspace");
    const result = new Map<string, CheckpointStatusEntry>();
    const codes = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", type_changed: "T", unsupported: "U" } as const;
    for (const change of staged) result.set(change.path, { path: change.path, ...(change.oldPath ? { originalPath: change.oldPath } : {}), index: codes[change.status], worktree: " " });
    const tracked = new Set([...before.indexEntries, ...before.headEntries].map((entry) => entry.path));
    for (const change of work) {
      const item = result.get(change.path) ?? { path: change.path, index: " ", worktree: " " };
      if (change.status === "added" && !tracked.has(change.path)) { item.index = "?"; item.worktree = "?"; }
      else item.worktree = codes[change.status];
      if (change.oldPath) item.originalPath = change.oldPath;
      result.set(change.path, item);
    }
    return [...result.values()].sort((a, b) => a.path < b.path ? -1 : 1);
  }
  private uniqueUnsupported(items: Array<{ path?: string; reason: string }>): Array<{ path?: string; reason: string }> {
    return [...new Map(items.map((item) => [`${item.path ?? ""}\0${item.reason}`, item])).values()];
  }
  private async commit(tree: string, checkpointId: string, layer: string, head?: string): Promise<string> {
    if (head) this.assertOid(head);
    return this.oid(await this.git(["commit-tree", "--no-gpg-sign", tree, ...(head ? ["-p", head] : [])], { input: Buffer.from(`Flyx checkpoint ${checkpointId} ${layer}\n`), commitIdentity: true }));
  }
  private oid(bytes: Buffer | undefined): string { const oid = bytes?.toString("ascii").trim() ?? ""; this.assertOid(oid); return oid; }
  private assertOid(oid: string): void { if (!OID.test(oid)) throw new CheckpointError("INVALID_OBJECT_ID", "Checkpoint contains an invalid Git object ID"); }
  private missing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"); }
  private async objectGit(args: string[], options: { maxBytes?: number; index?: string; input?: Buffer } = {}): Promise<Buffer> {
    // Git can otherwise reuse/refresh a matching worktree file and run its clean filter, including write-tree.
    // Empty cwd/worktree prevents racy-index refresh from resolving real files; an isolated index prevents Diff reuse.
    const gitDirectory = decode((await this.git(["rev-parse", "--absolute-git-dir"]))!).trim();
    const temp = await mkdtemp(join(tmpdir(), "flyx-checkpoint-object-query-"));
    try { return (await this.git(args, { ...options, gitDirectory, worktree: temp, index: options.index ?? join(temp, "empty-index") }))!; }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
  private async git(args: string[], options: { gitDirectory?: string; worktree?: string; index?: string; input?: Buffer; maxBytes?: number; allowFailure?: boolean; commitIdentity?: boolean } = {}): Promise<Buffer | undefined> {
    if (this.lifecycle.signal.aborted) throw new CheckpointError("CHECKPOINT_GIT_SEALED", "Checkpoint Git execution is sealed");
    const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
    if (options.index) env.GIT_INDEX_FILE = options.index;
    if (options.gitDirectory) env.GIT_DIR = options.gitDirectory;
    if (options.worktree) env.GIT_WORK_TREE = options.worktree;
    if (options.commitIdentity) Object.assign(env, { GIT_AUTHOR_NAME: "Flyx Checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@flyx.invalid", GIT_COMMITTER_NAME: "Flyx Checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@flyx.invalid" });
    const input = options.input ? Object.freeze({ encoding: "base64" as const, data: options.input.toString("base64"), bytes: options.input.length }) : undefined;
    const request: CheckpointGitRunRequest = Object.freeze({ command: "git", args: Object.freeze([...CONFIG.flatMap((config) => ["-c", config]), ...args]),
      cwd: options.worktree ?? this.workspace, workspace: this.workspace, env: Object.freeze(env), ...(input ? { input } : {}), maxInputBytes: input?.bytes ?? 0,
      maxBuffer: options.maxBytes ?? 32 * 1024 * 1024, timeoutMs: 30_000, signal: this.lifecycle.signal,
      operation: this.operations.getStore() ?? Object.freeze({ kind: "fingerprint" as const }),
    });
    let result: CheckpointGitRunResult;
    try { result = await (this.options.runGit ?? ((value) => this.legacyRunGit(value)))(request); }
    catch (error) {
      if (error instanceof CheckpointError) throw error;
      throw new CheckpointError("GIT_OPERATION_FAILED", `Checkpoint Git ${args[0] ?? "operation"} failed`);
    }
    if (this.lifecycle.signal.aborted) throw new CheckpointError("CHECKPOINT_GIT_SEALED", "Checkpoint Git execution is sealed");
    if (!result || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 || !(result.stdout instanceof Uint8Array)) throw new CheckpointError("GIT_RUNNER_RESULT_INVALID", "Git runner returned an invalid completion result");
    if (result.stdout.length > request.maxBuffer) throw new CheckpointError("GIT_OUTPUT_BUDGET_EXCEEDED", "Git runner exceeded its output budget");
    if (result.exitCode !== 0) {
      if (options.allowFailure) return undefined;
      throw new CheckpointError("GIT_OPERATION_FAILED", `Checkpoint Git ${args[0] ?? "operation"} failed`);
    }
    return Buffer.from(result.stdout);
  }
  /** Compatibility only. Production Host composition supplies the tracked prelaunch runner. */
  private legacyRunGit(request: CheckpointGitRunRequest): Promise<CheckpointGitRunResult> {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !/^(?:DYLD_|LD_|GCONV_PATH$|GLIBC_TUNABLES$|LOCPATH$)/.test(key)));
    return new Promise((resolveResult, reject) => {
      const child = execFile(request.command, [...request.args], { cwd: request.cwd, env: { ...inherited, ...request.env }, encoding: "buffer", timeout: request.timeoutMs, maxBuffer: request.maxBuffer, signal: request.signal }, (error, stdout) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolveResult({ stdout, exitCode: error ? Number(error.code) : 0 });
      });
      child.stdin?.on("error", () => { /* Completion reports a closed/failed command. */ });
      child.stdin?.end(request.input ? Buffer.from(request.input.data, "base64") : undefined);
    });
  }
}
