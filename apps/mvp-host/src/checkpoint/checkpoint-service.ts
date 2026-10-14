import { randomUUID } from "node:crypto";
import type { CheckpointContentRef, CheckpointDiffFile, CheckpointDiffPage, CheckpointFileChange, CheckpointFileContent, CheckpointSummary } from "@flyx/mvp-protocol";
import { bindingDigest, CheckpointGitDriver, digest } from "./git-driver.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { CHECKPOINT_POLICY_VERSION, CheckpointError } from "./types.js";
import type { AfterCheckpointContext, CheckpointContext, CheckpointDiffEntry, CheckpointManifest, CheckpointPhase } from "./types.js";

/** Structural R08 seam. putBytes/pin join the shared owner's short synchronous DB transaction. */
export interface CheckpointContentPublisher {
  putBlob?(input: { sessionId: string; itemId?: string; format: string; text: string; workspace?: string; requiredScope?: string }): CheckpointContentRef;
  putBytes(input: { sessionId: string; itemId?: string; format: string; data: Uint8Array; workspace?: string; requiredScope?: string }): CheckpointContentRef;
  pin(input: { sessionId: string; ref: string; ownerKind: "checkpoint"; ownerId: string; expiresAt?: string }): string;
}
export type CheckpointServiceOptions = {
  store: CheckpointStore;
  driverFor: (workspaceId: string) => CheckpointGitDriver;
  assertLease: (context: CheckpointContext) => void | Promise<void>;
  content?: CheckpointContentPublisher;
  now?: () => Date;
  inlineBytes?: number;
  pageBytes?: number;
  publicRootsForSession?: (sessionId: string, workspace: string) => readonly string[];
};
export type DiffQuery = { sessionId: string; beforeCheckpointId: string; afterCheckpointId: string; layer?: "workspace" | "index"; cursor?: string; limit?: number };
export function checkpointSummary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    checkpointId: manifest.checkpointId, sessionId: manifest.sessionId, workspaceId: manifest.workspaceId, phase: manifest.phase,
    ...(manifest.turnId ? { turnId: manifest.turnId } : {}), ...(manifest.attemptId ? { attemptId: manifest.attemptId } : {}),
    status: manifest.status, capturedAt: manifest.capturedAt, policyVersion: manifest.policyVersion,
    ...(manifest.workspaceDigest ? { workspaceDigest: manifest.workspaceDigest } : {}), ...(manifest.indexDigest ? { indexDigest: manifest.indexDigest } : {}),
    samplingConsistency: manifest.samplingConsistency, unsupportedCount: manifest.unsupported.length, warnings: manifest.warnings.slice(0, 32),
  };
}
function publicFile(entry: CheckpointDiffEntry): CheckpointFileChange {
  const { oldOid: _oldOid, newOid: _newOid, position: _position, ...file } = entry; return file;
}
export function encodeCheckpointCursor(kind: string, id: string, position: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, id, position })).toString("base64url");
}
export function decodeCheckpointCursor(cursor: string | undefined, kind: string, id: string): number {
  if (!cursor) return -1;
  try {
    if (cursor.length > 2048) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v: number; kind: string; id: string; position: number };
    if (value.v !== 1 || value.kind !== kind || value.id !== id || !Number.isSafeInteger(value.position) || value.position < -1) throw new Error();
    return value.position;
  } catch { throw new CheckpointError("CURSOR_EXPIRED", "Checkpoint cursor belongs to another immutable query"); }
}
export function boundedCheckpointUnsupported(items: Array<{ path?: string; reason: string }>, maximumBytes = 8192): Array<{ path?: string; reason: string }> {
  const result: Array<{ path?: string; reason: string }> = [];
  for (const item of items.slice(0, 64)) {
    if (Buffer.byteLength(JSON.stringify([...result, item])) > maximumBytes) break;
    result.push(item);
  }
  return result;
}
export class CheckpointService {
  private sealed=false;
  private readonly pending = new Set<Promise<unknown>>();
  readonly store: CheckpointStore;
  constructor(private readonly options: CheckpointServiceOptions) { this.store = options.store; }
  seal():void {this.sealed=true;this.store.seal();}
  private assertOpen():void {if(this.sealed)throw new CheckpointError("CHECKPOINT_SEALED","Checkpoint publication is sealed");}
  /** Await this hook while holding the workspace lease, before native prompt dispatch. */
  captureBefore(context: CheckpointContext & { turnId: string; attemptId: string }): Promise<CheckpointManifest> {
    return this.capture(context, "before");
  }
  /** Await after producer stop and terminal ingestion commit, before releasing the workspace lease. */
  captureAfter(context: AfterCheckpointContext): Promise<CheckpointManifest> {
    if (context.evidence.producerStopped !== true || context.evidence.terminalCommitted !== true || !Number.isSafeInteger(context.evidence.terminalSequence) || context.evidence.terminalSequence < 1) {
      return Promise.reject(new CheckpointError("CHECKPOINT_ORDER_INVALID", "After checkpoint requires producer stop and committed terminal evidence"));
    }
    return this.capture(context, "after");
  }
  async ensureSessionBaseline(context: CheckpointContext): Promise<CheckpointManifest> {
    const existing = this.store.getBaseline(context.sessionId); if (existing) return existing;
    const manifest = await this.capture(context, "session_baseline"); this.store.bindBaseline(manifest); return this.store.getBaseline(context.sessionId)!;
  }
  /** Used by R16 for a safety capture, and by previews for a retained current-state manifest. */
  captureCurrent(context: CheckpointContext, phase: "preview" | "safety", additionalPaths: readonly string[] = []): Promise<CheckpointManifest> { return this.capture(context, phase, additionalPaths); }
  async drain(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  /** Recovery may settle abandoned journals only after proving all old capture producers stopped. */
  reconcileInterruptedCaptures(sessionId: string, evidence: { capturesStopped: true }): CheckpointManifest[] {
    if (evidence.capturesStopped !== true || this.pending.size) throw new CheckpointError("CAPTURE_IN_PROGRESS", "Active captures must stop before recovery settles their journals");
    const results: CheckpointManifest[] = [];
    for (const initial of this.store.list(sessionId).filter((manifest) => manifest.status === "capturing")) {
      const manifest: CheckpointManifest = { ...initial, status: "failed", completedAt: this.now(), errorCode: "CAPTURE_INTERRUPTED",
        samplingConsistency: "unavailable", warnings: ["interrupted_capture_cannot_be_proven_exact"] };
      this.store.finish(manifest);
      if (manifest.phase === "before" || manifest.phase === "session_baseline") this.store.bindBaseline(manifest);
      results.push(manifest);
    }
    return results;
  }
  async getTurnDiff(input: { sessionId: string; turnId: string; attemptId: string; layer?: "workspace" | "index"; cursor?: string; limit?: number }): Promise<CheckpointDiffPage> {
    const before = this.store.findAttempt(input.sessionId, input.turnId, input.attemptId, "before");
    const after = this.store.findAttempt(input.sessionId, input.turnId, input.attemptId, "after");
    if (!before || !after) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Turn has no before/after checkpoint pair");
    return this.getDiffPage({ ...input, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId });
  }
  async getSessionDiff(input: { sessionId: string; currentCheckpointId: string; layer?: "workspace" | "index"; cursor?: string; limit?: number }): Promise<CheckpointDiffPage> {
    const baseline = this.store.getBaseline(input.sessionId);
    if (!baseline) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Session has no exact retained baseline");
    return this.getDiffPage({ ...input, beforeCheckpointId: baseline.checkpointId, afterCheckpointId: input.currentCheckpointId });
  }
  async getDiffPage(input: DiffQuery): Promise<CheckpointDiffPage> {
    const before = this.store.require(input.beforeCheckpointId, input.sessionId); const after = this.store.require(input.afterCheckpointId, input.sessionId);
    const layer = input.layer ?? "workspace";
    const base = { before: checkpointSummary(before), after: checkpointSummary(after), layer, attribution: "time_boundary_only" as const,
      warnings: this.diffWarnings(before, after), unsupportedCount: before.unsupported.length + after.unsupported.length, unsupported: boundedCheckpointUnsupported([...before.unsupported, ...after.unsupported], Math.min(8192, Math.floor((this.options.pageBytes ?? 48 * 1024) / 4))), totalFiles: 0, files: [] };
    if (before.workspaceId !== after.workspaceId) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Diff checkpoints belong to different workspaces");
    if ([before.status, after.status].some((status) => status === "capturing" || status === "failed" || status === "legacy_inexact")) {
      return { ...base, status: "unavailable", unavailableReason: "capture_not_complete" };
    }
    const driver = this.options.driverFor(before.workspaceId);
    let beforeTree: string; let afterTree: string;
    try { beforeTree = await driver.verify(before, layer); afterTree = await driver.verify(after, layer); }
    catch (error) {
      if (error instanceof CheckpointError) return { ...base, status: "unavailable", unavailableReason: error.code.toLowerCase() };
      throw error;
    }
    const diffId = digest(`${before.checkpointId}\0${after.checkpointId}\0${layer}\0${beforeTree}\0${afterTree}`);
    if (!this.store.getDiff(diffId, input.sessionId)) {
      const entries = await driver.diff(beforeTree, afterTree, diffId);
      const unsupported = new Map([...before.unsupported, ...after.unsupported].filter((item) => item.path).map((item) => [item.path!, item.reason]));
      const decorated = entries.map((entry) => ({ ...entry, ...(unsupported.get(entry.path) ? { unsupported: unsupported.get(entry.path)! } : {}) }));
      // Unsupported paths still have catalog rows, even when their omitted bytes produced no tree change.
      for (const [path, reason] of unsupported) if (!decorated.some((entry) => entry.path === path)) {
        const position = decorated.length;
        decorated.push({ fileId: digest(`${diffId}\0unsupported\0${path}`), position, path, status: "unsupported",
          oldMode: before.entries.find((entry) => entry.path === path)?.mode ?? "000000",
          newMode: after.entries.find((entry) => entry.path === path)?.mode ?? "000000", oldOid: "0".repeat(40), newOid: "0".repeat(40), unsupported: reason });
      }
      this.store.putDiff({ diffId, sessionId: input.sessionId, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId,
        layer, createdAt: this.now(), entries: decorated });
    }
    const position = decodeCheckpointCursor(input.cursor, "diff", diffId); const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    const rows = this.store.diffPage(diffId, position, limit + 1); const files: CheckpointFileChange[] = []; let last = position;
    const totalFiles = this.store.diffCount(diffId); const pageBytes = this.options.pageBytes ?? 48 * 1024;
    for (const entry of rows.slice(0, limit)) {
      const proposed = [...files, publicFile(entry)];
      if (Buffer.byteLength(JSON.stringify({ ...base, status: "available", diffId, totalFiles, files: proposed, nextCursor: encodeCheckpointCursor("diff", diffId, entry.position) })) > pageBytes) {
        if (!files.length) throw new CheckpointError("RESPONSE_TOO_LARGE", "A checkpoint file entry exceeds the response budget");
        break;
      }
      files.push(publicFile(entry)); last = entry.position;
    }
    return { ...base, status: "available", diffId, totalFiles, files, ...(last < totalFiles - 1 ? { nextCursor: encodeCheckpointCursor("diff", diffId, last) } : {}) };
  }
  async getDiffFile(input: { sessionId: string; diffId: string; fileId: string }): Promise<CheckpointDiffFile> {
    const record = this.store.getDiff(input.diffId, input.sessionId);
    if (!record) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Diff does not exist");
    const entry = this.store.diffFile(input.diffId, input.fileId);
    if (!entry) throw new CheckpointError("CONTENT_NOT_FOUND", "Diff file does not exist");
    const before = this.store.require(record.beforeCheckpointId, input.sessionId); const after = this.store.require(record.afterCheckpointId, input.sessionId);
    const driver = this.options.driverFor(before.workspaceId);
    const beforeTree = await driver.verify(before, record.layer); const afterTree = await driver.verify(after, record.layer);
    if (entry.unsupported || entry.oldMode === "160000" || entry.newMode === "160000") {
      const content: CheckpointFileContent = { kind: "unsupported", reason: entry.unsupported ?? "submodule_worktree_not_captured" };
      return { diffId: record.diffId, file: publicFile(entry), before: content, after: content, patch: content };
    }
    const oldBytes = await driver.blob(entry.oldOid); const newBytes = await driver.blob(entry.newOid);
    const binary = this.isBinary(oldBytes) || this.isBinary(newBytes);
    const patch = await driver.patch(beforeTree, afterTree, entry);
    // Keep public bytes and their refs atomic. Raw objects remain immutable in Git.
    const file = { ...publicFile(entry), binary }; const pageBytes = this.options.pageBytes ?? 48 * 1024;
    const perPartBytes = Math.floor((pageBytes - Buffer.byteLength(JSON.stringify({ diffId: record.diffId, file })) - 512) / 3);
    if (perPartBytes < 512) throw new CheckpointError("RESPONSE_TOO_LARGE", "Diff file metadata exceeds the response budget");
    this.assertOpen();return this.store.db.transaction(() => {
      const result = { diffId: record.diffId, file,
        before: this.content(input.sessionId, record.diffId, entry.fileId, "before", oldBytes, before.workspacePath, perPartBytes),
        after: this.content(input.sessionId, record.diffId, entry.fileId, "after", newBytes, before.workspacePath, perPartBytes),
        patch: this.content(input.sessionId, record.diffId, entry.fileId, "patch", patch, before.workspacePath, perPartBytes),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > pageBytes) throw new CheckpointError("RESPONSE_TOO_LARGE", "Diff file exceeds the encoded response budget");
      return result;
    })();
  }
  /** Retained trees/actions for R16; clients only receive generated file IDs and public metadata. */
  async controlledDiff(before: CheckpointManifest, after: CheckpointManifest, layer: "workspace" | "index"): Promise<CheckpointDiffEntry[]> {
    if (before.sessionId !== after.sessionId || before.workspaceId !== after.workspaceId) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Controlled Diff crosses a resource boundary");
    const driver = this.options.driverFor(before.workspaceId);
    return driver.diff(await driver.verify(before, layer), await driver.verify(after, layer), digest(`${before.checkpointId}\0${after.checkpointId}\0${layer}`));
  }
  driver(workspaceId: string): CheckpointGitDriver { return this.options.driverFor(workspaceId); }
  async assertLease(context: CheckpointContext): Promise<void> { await this.options.assertLease(context); }
  private capture(context: CheckpointContext, phase: CheckpointPhase, additionalPaths: readonly string[] = []): Promise<CheckpointManifest> {
    this.assertOpen();const work = this.runCapture(context, phase, additionalPaths); this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work;
  }
  private async runCapture(context: CheckpointContext, phase: CheckpointPhase, additionalPaths: readonly string[]): Promise<CheckpointManifest> {
    if (context.lease.workspaceId !== context.workspaceId || !context.lease.leaseId || !Number.isSafeInteger(context.lease.generation) || context.lease.generation < 0) {
      throw new CheckpointError("WORKSPACE_LEASE_INVALID", "Checkpoint requires a fenced workspace lease");
    }
    await this.assertLease(context);this.assertOpen();
    if ((phase === "before" || phase === "after") && context.turnId && context.attemptId) {
      const existing = this.store.findAttempt(context.sessionId, context.turnId, context.attemptId, phase);
      if (existing) {
        if (existing.status === "capturing") throw new CheckpointError("CAPTURE_IN_PROGRESS", "Checkpoint capture must be reconciled before retrying");
        if (existing.workspaceId !== context.workspaceId || existing.epoch !== context.epoch || existing.runtimeGeneration !== context.runtimeGeneration) throw new CheckpointError("CAPTURE_BINDING_MISMATCH", "Attempt checkpoint belongs to another execution binding");
        return existing;
      }
    }
    const driver = this.driver(context.workspaceId); const checkpointId = randomUUID(); const startedAt = this.now();
    const initial: CheckpointManifest = {
      checkpointId, schemaVersion: 1, sessionId: context.sessionId, workspaceId: context.workspaceId, workspacePath: driver.workspace,
      phase, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}),
      additionalPaths: [...additionalPaths], status: "capturing", policyVersion: CHECKPOINT_POLICY_VERSION, capturedAt: startedAt, startedAt,
      workspaceRef: driver.ref(checkpointId, "workspace"), indexRef: driver.ref(checkpointId, "index"),
      lease: context.lease, sessionRevision: context.sessionRevision, epoch: context.epoch, runtimeGeneration: context.runtimeGeneration,
      nativeHandle: context.nativeHandle ?? null, nativeHandleBinding: bindingDigest(context.nativeHandle),
      samplingConsistency: "unavailable", unsupportedCount: 0, entries: [], statusEntries: [], unsupported: [], warnings: [],
    };
    this.store.begin(initial);
    let manifest: CheckpointManifest;
    try {
      const capture = await driver.capture(checkpointId, additionalPaths);
      await this.assertLease(context);this.assertOpen();
      const capturedAt = this.now(); manifest = { ...initial, ...capture, unsupportedCount: capture.unsupported.length, capturedAt, completedAt: capturedAt };
    } catch (error) {
      this.assertOpen();const code = error instanceof CheckpointError ? error.code : "CAPTURE_FAILED";
      const unsupported = code.startsWith("UNSUPPORTED_") ? [{ reason: code.toLowerCase() }] : [];
      manifest = { ...initial, status: unsupported.length ? "unsupported" : "failed", completedAt: this.now(),
        errorCode: code, unsupported, unsupportedCount: unsupported.length, warnings: [code.toLowerCase()] };
    }
    // Persistence failures propagate; only capture failure is separate from the Provider terminal fact.
    this.store.finish(manifest);
    if (phase === "before" || phase === "session_baseline") this.store.bindBaseline(manifest);
    return manifest;
  }
  private diffWarnings(before: CheckpointManifest, after: CheckpointManifest): string[] {
    const warnings = new Set([...before.warnings, ...after.warnings, "shared_workspace_changes_have_unknown_authorship"]);
    if (before.head !== after.head || before.branch !== after.branch) warnings.add("head_or_branch_changed_between_checkpoints");
    if (before.unsupported.length || after.unsupported.length) warnings.add("capture_contains_unsupported_entries");
    return [...warnings].slice(0, 32);
  }
  private content(sessionId: string, diffId: string, fileId: string, part: string, data: Buffer | undefined, workspace: string, encodedLimit: number): CheckpointFileContent {
    if (!data) return { kind: "absent" };
    const binary = this.isBinary(data);
    if (!binary && data.length <= Math.min(8192, this.options.inlineBytes ?? 8192)) {
      let text = data.toString("utf8");
      const roots = [...new Set(this.options.publicRootsForSession?.(sessionId, workspace) ?? [workspace])].filter(Boolean).sort((a, b) => b.length - a.length);
      for (const root of roots) text = text.replaceAll(root, ".");
      const publicBytes = Buffer.from(text); const inline: CheckpointFileContent = { kind: "text", bytes: publicBytes.length, sha256: digest(publicBytes), text };
      if (Buffer.byteLength(JSON.stringify(inline)) <= encodedLimit) return inline;
    }
    if (!this.options.content) throw new CheckpointError("CONTENT_STORE_UNAVAILABLE", "Large or binary checkpoint content requires bounded content storage");
    const common = { sessionId, itemId: `${fileId}:${part}`, format: binary ? "application/octet-stream" : part === "patch" ? "text/x-diff" : "text/plain", workspace, requiredScope: "session:read" };
    const utf8 = !binary && this.options.content.putBlob !== undefined;
    const ref = utf8 ? this.options.content.putBlob!({ ...common, text: data.toString("utf8") }) : this.options.content.putBytes({ ...common, data });
    this.options.content.pin({ sessionId, ref: ref.ref, ownerKind: "checkpoint", ownerId: diffId });
    return { kind: "contentRef", binary, encoding: utf8 ? "utf8" : "base64", contentRef: ref };
  }
  private isBinary(data: Buffer | undefined): boolean {
    if (!data) return false;
    if (data.includes(0)) return true;
    try { new TextDecoder("utf-8", { fatal: true }).decode(data); return false; } catch { return true; }
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}
