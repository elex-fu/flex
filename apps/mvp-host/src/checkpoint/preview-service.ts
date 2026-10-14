import { randomUUID } from "node:crypto";
import type { CheckpointPreviewPage } from "@flyx/mvp-protocol";
import { bindingDigest, digest } from "./git-driver.js";
import { CheckpointService, boundedCheckpointUnsupported, decodeCheckpointCursor, encodeCheckpointCursor } from "./checkpoint-service.js";
import { CHECKPOINT_POLICY_VERSION, CheckpointError } from "./types.js";
import type { CheckpointContext, CheckpointDiffEntry, CheckpointLease, CheckpointManifest, CheckpointPreviewAction, CheckpointPreviewPlan } from "./types.js";

export type CheckpointPreviewContext = CheckpointContext & { actorId: string; activeTurnId?: string };
export type LeaseSuccession = { previous: CheckpointLease; current: CheckpointLease };
export type CheckpointPreviewOptions = {
  checkpoints: CheckpointService;
  /** Checks current scope/actor and reads authoritative revision/native/epoch/lease state. */
  resolveContext: (sessionId: string, actorId: string) => CheckpointPreviewContext | Promise<CheckpointPreviewContext>;
  /** Trusted lease-manager proof of predecessor identity and absence of intervening writers. Never accept this from an RPC payload. */
  verifyLeaseSuccession?: (succession: LeaseSuccession) => boolean | Promise<boolean>;
  now?: () => Date; ttlMs?: number; pageBytes?: number;
};
/** R14 is preview-only. There is deliberately no workspace/index/Provider mutation method. */
export class CheckpointPreviewService {
  constructor(private readonly options: CheckpointPreviewOptions) {}
  async createPreview(input: { sessionId: string; actorId: string; checkpointId: string; expectedSessionRevision: number }): Promise<CheckpointPreviewPage> {
    const context = await this.resolve(input.sessionId, input.actorId);
    if (context.sessionRevision !== input.expectedSessionRevision) throw new CheckpointError("SESSION_REVISION_CONFLICT", "Session changed before preview");
    if (context.activeTurnId) throw new CheckpointError("WORKSPACE_BUSY", "A Turn is still using this workspace");
    const target = this.options.checkpoints.store.require(input.checkpointId, input.sessionId);
    if (target.workspaceId !== context.workspaceId) throw new CheckpointError("CHECKPOINT_SCOPE_MISMATCH", "Checkpoint belongs to another workspace");
    if (target.status === "capturing" || target.status === "failed" || target.status === "legacy_inexact" || !target.workspaceTree) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Checkpoint has no retained workspace snapshot");
    // Targeted ignored collisions/absent paths belong to the overwrite/delete digest as well.
    const paths = target.entries.map((entry) => entry.path);
    const current = await this.options.checkpoints.captureCurrent(context, "preview", paths);
    if (!current.workspaceDigest || !current.indexDigest || !current.workspaceTree) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Current workspace capture failed");
    const unsupported = this.unsupported(target, current);
    const actions: CheckpointPreviewAction[] = [];
    for (const layer of ["workspace", "index"] as const) {
      if (!(layer === "workspace" ? target.workspaceTree && current.workspaceTree : target.indexTree && current.indexTree)) {
        unsupported.push({ reason: `${layer}_tree_unavailable` }); continue;
      }
      const changes = await this.options.checkpoints.controlledDiff(current, target, layer);
      for (const change of changes) actions.push(...this.actions(change, layer));
    }
    for (const item of unsupported) if (item.path && !actions.some((action) => action.path === item.path && action.action === "unsupported")) {
      actions.push({ fileId: digest(`unsupported\0${item.path}\0${item.reason}`), path: item.path, layer: "workspace", action: "unsupported", reason: item.reason });
    }
    const authoritative = await this.resolve(input.sessionId, input.actorId);
    this.sameContext(context, authoritative);
    if (current.status === "complete") {
      const sampled = await this.options.checkpoints.driver(context.workspaceId).fingerprint(current.entries.map((entry) => entry.path));
      if (sampled.workspaceDigest !== current.workspaceDigest || sampled.indexDigest !== current.indexDigest || sampled.head !== current.head || sampled.branch !== current.branch) throw new CheckpointError("PLAN_STALE", "Workspace changed while constructing preview");
    }
    const createdAt = this.now();
    const plan: CheckpointPreviewPlan = {
      planId: randomUUID(), sessionId: input.sessionId, actorId: input.actorId, workspaceId: context.workspaceId,
      checkpointId: target.checkpointId, currentCheckpointId: current.checkpointId, createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + Math.max(1000, Math.min(30 * 60_000, this.options.ttlMs ?? 5 * 60_000))).toISOString(),
      state: "active", expectedWorkspaceDigest: current.workspaceDigest, expectedIndexDigest: current.indexDigest,
      expectedSessionRevision: context.sessionRevision, epoch: context.epoch, runtimeGeneration: context.runtimeGeneration,
      lease: context.lease, nativeHandle: context.nativeHandle ?? null, nativeHandleBinding: bindingDigest(context.nativeHandle),
      policyVersion: CHECKPOINT_POLICY_VERSION, actions, unsupported: [...new Map(unsupported.map((item) => [`${item.path ?? ""}\0${item.reason}`, item])).values()],
    };
    this.options.checkpoints.store.putPreview(plan);
    return this.page(plan);
  }
  getPreview(input: { sessionId: string; actorId: string; planId: string; cursor?: string; limit?: number }): CheckpointPreviewPage {
    const plan = this.options.checkpoints.store.getPreview(input.planId, input.sessionId, input.actorId);
    this.live(plan); return this.page(plan, input.cursor, input.limit);
  }
  /** R16 calls this again under its freshly asserted lease immediately before safety capture. */
  async validatePlan(input: { sessionId: string; actorId: string; planId: string; leaseSuccession?: LeaseSuccession }): Promise<{ plan: CheckpointPreviewPlan; target: CheckpointManifest; current: CheckpointManifest; context: CheckpointPreviewContext }> {
    const plan = this.options.checkpoints.store.getPreview(input.planId, input.sessionId, input.actorId); this.live(plan);
    if (plan.unsupported.length || plan.actions.some((action) => action.action === "unsupported")) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Preview contains unsupported restore actions");
    const context = await this.resolve(input.sessionId, input.actorId);
    if (context.activeTurnId || context.workspaceId !== plan.workspaceId || context.sessionRevision !== plan.expectedSessionRevision || context.epoch !== plan.epoch ||
      context.runtimeGeneration !== plan.runtimeGeneration || bindingDigest(context.nativeHandle) !== plan.nativeHandleBinding) {
      throw new CheckpointError("PLAN_STALE", "Session or runtime binding changed after preview");
    }
    if (!this.sameLease(context.lease, plan.lease)) {
      const succession = input.leaseSuccession;
      if (!succession || !this.sameLease(succession.previous, plan.lease) || !this.sameLease(succession.current, context.lease) ||
        succession.current.workspaceId !== succession.previous.workspaceId || succession.current.generation <= succession.previous.generation ||
        !this.options.verifyLeaseSuccession || !await this.options.verifyLeaseSuccession(succession)) {
        throw new CheckpointError("PLAN_STALE", "Workspace lease changed without verified succession");
      }
    }
    const target = this.options.checkpoints.store.require(plan.checkpointId, input.sessionId);
    const current = this.options.checkpoints.store.require(plan.currentCheckpointId, input.sessionId);
    const driver = this.options.checkpoints.driver(plan.workspaceId);
    await driver.verify(target, "workspace"); await driver.verify(target, "index");
    await driver.verify(current, "workspace"); await driver.verify(current, "index");
    const sampled = await driver.fingerprint(current.entries.map((entry) => entry.path));
    if (sampled.workspaceDigest !== plan.expectedWorkspaceDigest || sampled.indexDigest !== plan.expectedIndexDigest || sampled.head !== current.head || sampled.branch !== current.branch) {
      throw new CheckpointError("PLAN_STALE", "Workspace, index or HEAD changed after preview");
    }
    this.live(plan); await this.options.checkpoints.assertLease(context);
    this.sameContext(context, await this.resolve(input.sessionId, input.actorId));
    return { plan, target, current, context };
  }
  private async resolve(sessionId: string, actorId: string): Promise<CheckpointPreviewContext> {
    const context = await this.options.resolveContext(sessionId, actorId);
    if (context.sessionId !== sessionId || context.actorId !== actorId) throw new CheckpointError("PLAN_SCOPE_MISMATCH", "Preview resolver returned a different resource or actor");
    await this.options.checkpoints.assertLease(context); return context;
  }
  private live(plan: CheckpointPreviewPlan): void {
    if (plan.state !== "active" || !Number.isFinite(new Date(plan.expiresAt).getTime()) || this.now().getTime() >= new Date(plan.expiresAt).getTime() || plan.policyVersion !== CHECKPOINT_POLICY_VERSION) throw new CheckpointError("PLAN_STALE", "Preview plan expired or is no longer active");
  }
  private sameContext(before: CheckpointPreviewContext, after: CheckpointPreviewContext): void {
    if (before.sessionId !== after.sessionId || before.actorId !== after.actorId || before.workspaceId !== after.workspaceId || before.sessionRevision !== after.sessionRevision ||
      before.epoch !== after.epoch || before.runtimeGeneration !== after.runtimeGeneration || before.activeTurnId !== after.activeTurnId ||
      bindingDigest(before.nativeHandle) !== bindingDigest(after.nativeHandle) || !this.sameLease(before.lease, after.lease)) {
      throw new CheckpointError("PLAN_STALE", "Session or runtime changed while checking the preview");
    }
  }
  private sameLease(a: CheckpointLease, b: CheckpointLease): boolean { return a.workspaceId === b.workspaceId && a.leaseId === b.leaseId && a.generation === b.generation; }
  private unsupported(target: CheckpointManifest, current: CheckpointManifest): Array<{ path?: string; reason: string }> {
    const result = [...target.unsupported, ...current.unsupported];
    if (target.status !== "complete") result.push({ reason: `target_capture_${target.status}` });
    if (current.status !== "complete") result.push({ reason: `current_capture_${current.status}` });
    if (target.samplingConsistency !== "stable" || current.samplingConsistency !== "stable") result.push({ reason: "sampling_inexact" });
    return result;
  }
  private actions(entry: CheckpointDiffEntry, layer: "workspace" | "index"): CheckpointPreviewAction[] {
    const result: CheckpointPreviewAction[] = [];
    if (entry.oldPath && entry.status === "renamed") result.push({ fileId: digest(`${entry.fileId}\0delete`), path: entry.oldPath, layer, action: "delete" });
    if (entry.status === "deleted") result.push({ fileId: entry.fileId, path: entry.path, layer, action: "delete" });
    else if (entry.newMode === "160000" || !["100644", "100755", "120000"].includes(entry.newMode)) {
      result.push({ fileId: entry.fileId, path: entry.path, layer, action: "unsupported", reason: "unsupported_target_mode" });
    } else result.push({ fileId: entry.fileId, path: entry.path, layer, action: "write", targetMode: entry.newMode, targetOid: entry.newOid });
    return result;
  }
  private page(plan: CheckpointPreviewPlan, cursor?: string, requestedLimit = 100): CheckpointPreviewPage {
    const position = decodeCheckpointCursor(cursor, "preview", plan.planId); const limit = Math.max(1, Math.min(200, requestedLimit));
    const base = { planId: plan.planId, sessionId: plan.sessionId, checkpointId: plan.checkpointId, expiresAt: plan.expiresAt,
      expectedWorkspaceDigest: plan.expectedWorkspaceDigest, expectedIndexDigest: plan.expectedIndexDigest,
      expectedSessionRevision: plan.expectedSessionRevision, epoch: plan.epoch, runtimeGeneration: plan.runtimeGeneration,
      nativeHandleBinding: plan.nativeHandleBinding, supported: plan.unsupported.length === 0 && !plan.actions.some((action) => action.action === "unsupported"),
      unsupportedCount: plan.unsupported.length, unsupported: boundedCheckpointUnsupported(plan.unsupported, Math.min(8192, Math.floor((this.options.pageBytes ?? 48 * 1024) / 4))), totalFiles: plan.actions.length };
    const files: CheckpointPreviewPage["files"] = []; let last = position;
    for (let index = position + 1; index < Math.min(plan.actions.length, position + limit + 1); index++) {
      const action = plan.actions[index]!; const { targetMode: _mode, targetOid: _oid, ...publicAction } = action;
      const proposed = [...files, publicAction];
      if (Buffer.byteLength(JSON.stringify({ ...base, files: proposed, nextCursor: encodeCheckpointCursor("preview", plan.planId, index) })) > (this.options.pageBytes ?? 48 * 1024)) {
        if (!files.length) throw new CheckpointError("RESPONSE_TOO_LARGE", "A preview file exceeds the response budget"); break;
      }
      files.push(publicAction); last = index;
    }
    return { ...base, files, ...(last < plan.actions.length - 1 ? { nextCursor: encodeCheckpointCursor("preview", plan.planId, last) } : {}) };
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}
