import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointPreviewPageSchema } from "@flyx/mvp-protocol";
import { CheckpointPreviewService } from "./preview-service.js";
import type { CheckpointPreviewContext } from "./preview-service.js";
import { CheckpointService } from "./checkpoint-service.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { CheckpointGitDriver } from "./git-driver.js";
import { SqliteStore } from "../storage/db.js";
import { checkpointFixture, fixtureGit, removeFixture, temporaryRepository, userGitState } from "./test-support.js";
import { rawCheckpointGitRunner } from "../test-support/managed-git-fixtures.js";

const roots: string[] = []; const owners: SqliteStore[] = [];
async function fixture(persistent = false) {
  const root = await temporaryRepository(); roots.push(root);
  const value = checkpointFixture(root, persistent ? join(root, "host.sqlite") : ":memory:"); owners.push(value.owner);
  if (persistent) { await writeFile(join(root, ".gitignore"), "host.sqlite*\n"); }
  let context: CheckpointPreviewContext & { turnId: string; attemptId: string } = { ...value.context, actorId: "device-1" };
  const service = new CheckpointService({ store: value.store, driverFor: () => value.driver, assertLease: () => {} });
  const clock = { now: new Date("2026-10-14T10:00:00Z") };
  const preview = new CheckpointPreviewService({ checkpoints: service, resolveContext: () => structuredClone(context), now: () => clock.now });
  return { root, ...value, service, preview, clock, getContext: () => context, setContext: (next: CheckpointPreviewContext & { turnId: string; attemptId: string }) => { context = next; } };
}
afterEach(async () => { for (const owner of owners.splice(0)) if (owner.db.open) owner.close(); for (const root of roots.splice(0)) await removeFixture(root); });

describe("persistent preview-only revert plans", { timeout: 30_000 }, () => {
  it("previews independent workspace/index writes and deletes without restoring any file or changing HEAD/index", async () => {
    const value = await fixture(); const context = value.getContext();
    await writeFile(join(value.root, "tracked.txt"), "staged baseline\n"); await fixtureGit(value.root, ["add", "--", "tracked.txt"]);
    await writeFile(join(value.root, "tracked.txt"), "workspace baseline\n");
    const target = await value.service.captureBefore(context);
    await writeFile(join(value.root, "tracked.txt"), "new staged\n"); await fixtureGit(value.root, ["add", "--", "tracked.txt"]);
    await writeFile(join(value.root, "tracked.txt"), "new workspace\n"); await writeFile(join(value.root, "new.txt"), "delete on restore\n");
    const user = await userGitState(value.root);
    const page = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    expect(CheckpointPreviewPageSchema.safeParse(page).success).toBe(true); expect(page.supported).toBe(true);
    expect(page.files).toContainEqual(expect.objectContaining({ path: "new.txt", layer: "workspace", action: "delete" }));
    expect(page.files).toContainEqual(expect.objectContaining({ path: "tracked.txt", layer: "workspace", action: "write" }));
    expect(page.files).toContainEqual(expect.objectContaining({ path: "tracked.txt", layer: "index", action: "write" }));
    expect(await userGitState(value.root)).toEqual(user);
    const validated = await value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId });
    expect(validated.target.indexTree).toBe(target.indexTree); expect(validated.plan.nativeHandle).toEqual(context.nativeHandle);
    expect(value.store.protectedRefs().map((item) => item.checkpointId)).toContain(validated.current.checkpointId);
  });
  it("persists the plan across store reopen and binds it to actor/session/revision/native/epoch/runtime/lease", async () => {
    const value = await fixture(true); const context = value.getContext(); const target = await value.service.captureBefore(context);
    await writeFile(join(value.root, "tracked.txt"), "different\n");
    const page = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    value.owner.close(); const owner = new SqliteStore(join(value.root, "host.sqlite")); owners.push(owner);
    const store = new CheckpointStore(owner.db); const driver = new CheckpointGitDriver(value.root, { runGit: rawCheckpointGitRunner() });
    const checkpoints = new CheckpointService({ store, driverFor: () => driver, assertLease: () => {} });
    const preview = new CheckpointPreviewService({ checkpoints, resolveContext: () => structuredClone(value.getContext()), now: () => value.clock.now });
    expect(preview.getPreview({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId }).expectedWorkspaceDigest).toBe(page.expectedWorkspaceDigest);
    expect(() => preview.getPreview({ sessionId: context.sessionId, actorId: "other-device", planId: page.planId })).toThrow("another actor or session");
    const mutations: Partial<Omit<CheckpointPreviewContext, "turnId" | "attemptId">>[] = [
      { sessionRevision: context.sessionRevision + 1 }, { epoch: "new-epoch" }, { runtimeGeneration: 2 },
      { nativeHandle: { provider: "codex", sessionId: "different-native" } }, { activeTurnId: "running-turn" },
      { lease: { ...context.lease, leaseId: "new-lease", generation: 2 } },
    ];
    for (const mutation of mutations) {
      value.setContext({ ...context, ...mutation });
      await expect(preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId })).rejects.toMatchObject({ code: "PLAN_STALE" });
    }
    value.setContext(context); await expect(preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId })).resolves.toMatchObject({ plan: { planId: page.planId } });
    value.clock.now = new Date("2026-10-14T10:06:00Z");
    await expect(preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId })).rejects.toMatchObject({ code: "PLAN_STALE" });
  });
  it("rejects external workspace/index/HEAD changes after preview", async () => {
    const value = await fixture(); const context = value.getContext(); const target = await value.service.captureBefore(context);
    await writeFile(join(value.root, "tracked.txt"), "different\n");
    const page = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    await fixtureGit(value.root, ["add", "--", "tracked.txt"]);
    await expect(value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId })).rejects.toMatchObject({ code: "PLAN_STALE" });
    const next = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    await writeFile(join(value.root, "tracked.txt"), "outside editor\n");
    await expect(value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: next.planId })).rejects.toMatchObject({ code: "PLAN_STALE" });
    const last = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    await fixtureGit(value.root, ["commit", "--allow-empty", "-m", "outside commit"]);
    await expect(value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: last.planId })).rejects.toMatchObject({ code: "PLAN_STALE" });
  });
  it("samples now-ignored target paths, so ignored overwrite collisions are bound to their current bytes", async () => {
    const value = await fixture(); const context = value.getContext();
    await writeFile(join(value.root, "untracked.txt"), "target bytes\n"); const target = await value.service.captureBefore(context);
    await writeFile(join(value.root, ".gitignore"), "untracked.txt\n"); await writeFile(join(value.root, "untracked.txt"), "ignored current bytes\n");
    const page = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    expect(page.files).toContainEqual(expect.objectContaining({ path: "untracked.txt", action: "write" }));
    await value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId });
    await writeFile(join(value.root, "untracked.txt"), "external ignored bytes\n");
    await expect(value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId })).rejects.toMatchObject({ code: "PLAN_STALE" });
  });
  it("accepts lease succession only with trusted predecessor/no-intervening-writer evidence", async () => {
    const value = await fixture(); const context = value.getContext(); const target = await value.service.captureBefore(context);
    const page = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    const currentLease = { ...context.lease, leaseId: "lease-2", generation: 2 }; value.setContext({ ...context, lease: currentLease });
    const succession = { previous: context.lease, current: currentLease };
    await expect(value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId, leaseSuccession: succession })).rejects.toMatchObject({ code: "PLAN_STALE" });
    let verified = false;
    const trusted = new CheckpointPreviewService({ checkpoints: value.service, resolveContext: () => structuredClone(value.getContext()), now: () => value.clock.now,
      verifyLeaseSuccession: (evidence) => { expect(evidence).toEqual(succession); return verified; } });
    await expect(trusted.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId, leaseSuccession: succession })).rejects.toMatchObject({ code: "PLAN_STALE" });
    verified = true;
    await expect(trusted.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId, leaseSuccession: succession })).resolves.toMatchObject({ context: { lease: currentLease } });
  });
  it("shows unsupported conflict captures and refuses to validate them for restore", async () => {
    const value = await fixture(); const context = value.getContext();
    const oid = (await fixtureGit(value.root, ["rev-parse", "HEAD:tracked.txt"])).toString().trim();
    await fixtureGit(value.root, ["update-index", "--index-info"], Buffer.from(`0 ${"0".repeat(40)}\ttracked.txt\n100644 ${oid} 1\ttracked.txt\n100644 ${oid} 2\ttracked.txt\n`));
    const target = await value.service.captureBefore(context); expect(target.status).toBe("unsupported");
    const page = await value.preview.createPreview({ sessionId: context.sessionId, actorId: context.actorId, checkpointId: target.checkpointId, expectedSessionRevision: context.sessionRevision });
    expect(page.supported).toBe(false); expect(page.unsupportedCount).toBeGreaterThan(0);
    expect(page.files).toContainEqual(expect.objectContaining({ path: "tracked.txt", action: "unsupported", reason: "index_conflict" }));
    await expect(value.preview.validatePlan({ sessionId: context.sessionId, actorId: context.actorId, planId: page.planId })).rejects.toMatchObject({ code: "CAPTURE_UNAVAILABLE" });
  });
});
