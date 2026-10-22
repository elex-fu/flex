import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointDiffFileSchema, CheckpointDiffPageSchema } from "@flyx/mvp-protocol";
import { CheckpointService } from "./checkpoint-service.js";
import type { CheckpointContentPublisher } from "./checkpoint-service.js";
import { CheckpointGitDriver, digest } from "./git-driver.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { SqliteStore } from "../storage/db.js";
import { applyCheckpointSchema } from "../storage/migrations/009-checkpoints.js";
import { checkpointFixture, fixtureGit, removeFixture, temporaryRepository, userGitState } from "./test-support.js";
import { rawCheckpointGitRunner } from "../test-support/managed-git-fixtures.js";
import type { AfterCheckpointContext } from "./types.js";
import { ManagedGitError } from "../lifecycle/managed-git-runner.js";

const roots: string[] = []; const owners: SqliteStore[] = [];
async function fixture() { const root = await temporaryRepository(); roots.push(root); const value = checkpointFixture(root); owners.push(value.owner); return { root, ...value }; }
afterEach(async () => { for (const owner of owners.splice(0)) if (owner.db.open) owner.close(); for (const root of roots.splice(0)) await removeFixture(root); });
const evidence = { producerStopped: true, terminalCommitted: true, terminalSequence: 1 } as const;

describe("persistent exact checkpoint service", { timeout: 30_000 }, () => {
  it("uses actual dirty before/after trees for historical Diff even after HEAD changes", async () => {
    const { root, service, store, context } = await fixture();
    await writeFile(join(root, "tracked.txt"), "user staged\n"); await fixtureGit(root, ["add", "--", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "user dirty before\n"); const user = await userGitState(root);
    const before = await service.captureBefore(context);
    expect(await service.captureBefore(context)).toEqual(before); expect(store.getBaseline(context.sessionId)?.checkpointId).toBe(before.checkpointId);
    await writeFile(join(root, "tracked.txt"), "agent after\n"); await writeFile(join(root, "new.txt"), "agent new\n");
    const after = await service.captureAfter({ ...context, evidence }); expect(await userGitState(root)).toEqual(user);
    await fixtureGit(root, ["add", "--", "tracked.txt", "new.txt"]); await fixtureGit(root, ["commit", "-m", "future HEAD"]);
    await writeFile(join(root, "tracked.txt"), "later external work\n");
    const page = await service.getTurnDiff(context); expect(CheckpointDiffPageSchema.safeParse(page).success).toBe(true);
    expect(page.status).toBe("available"); expect(page.files.map((entry) => entry.path)).toEqual(["new.txt", "tracked.txt"]);
    const file = await service.getDiffFile({ sessionId: context.sessionId, diffId: page.diffId!, fileId: page.files.find((entry) => entry.path === "tracked.txt")!.fileId });
    expect(file.before).toMatchObject({ kind: "text", text: "user dirty before\n" }); expect(file.after).toMatchObject({ kind: "text", text: "agent after\n" });
    expect(CheckpointDiffFileSchema.safeParse(file).success).toBe(true); expect(page.attribution).toBe("time_boundary_only");
    expect(store.protectedRefs().find((item) => item.checkpointId === after.checkpointId)?.indexRef).toBe(after.indexRef);
  });
  it("paginates every changed file past 200 and binds cursors to their immutable diff", async () => {
    const { root, service, context } = await fixture(); const before = await service.captureBefore(context);
    await Promise.all(Array.from({ length: 253 }, (_, i) => writeFile(join(root, `file-${String(i).padStart(3, "0")}.txt`), `unique file ${i}\n`)));
    const after = await service.captureAfter({ ...context, evidence }); const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await service.getDiffPage({ sessionId: context.sessionId, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId, limit: 200, ...(cursor ? { cursor } : {}) });
      expect(page.totalFiles).toBe(253); expect(page.files.length).toBeLessThanOrEqual(200); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024);
      seen.push(...page.files.map((file) => file.path)); cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(253);
    const first = await service.getTurnDiff({ ...context, limit: 1 });
    await expect(service.getDiffPage({ sessionId: context.sessionId, beforeCheckpointId: after.checkpointId, afterCheckpointId: before.checkpointId, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  }, 30_000);
  it("stores large patches and binary bytes through the scoped R08 interface without truncation", async () => {
    const { root, store, driver, context } = await fixture(); const published = new Map<string, Uint8Array>(); const pins: string[] = [];
    const publisher: CheckpointContentPublisher = {
      putBytes: (input) => {
        expect(input.sessionId).toBe(context.sessionId); expect(input.requiredScope).toBe("session:read");
        const ref = `${input.itemId}:${digest(input.data)}`; published.set(ref, input.data);
        return { ref, bytes: input.data.byteLength, sha256: digest(input.data), format: input.format };
      },
      pin: (input) => { expect(input.sessionId).toBe(context.sessionId); expect(input.ownerKind).toBe("checkpoint"); pins.push(input.ref); return `pin:${input.ref}`; },
    };
    const service = new CheckpointService({ store, driverFor: () => driver, assertLease: () => {}, content: publisher });
    await service.captureBefore(context); const large = "x".repeat(320 * 1024) + "\n";
    await writeFile(join(root, "tracked.txt"), large); await writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 1]));
    await service.captureAfter({ ...context, evidence }); const page = await service.getTurnDiff(context);
    const text = await service.getDiffFile({ sessionId: context.sessionId, diffId: page.diffId!, fileId: page.files.find((file) => file.path === "tracked.txt")!.fileId });
    expect(text.after.kind).toBe("contentRef"); expect(text.patch.kind).toBe("contentRef");
    if (text.after.kind === "contentRef") expect(Buffer.from(published.get(text.after.contentRef.ref)!).toString()).toBe(large);
    const binary = await service.getDiffFile({ sessionId: context.sessionId, diffId: page.diffId!, fileId: page.files.find((file) => file.path === "binary.dat")!.fileId });
    expect(binary.after).toMatchObject({ kind: "contentRef", binary: true }); expect(pins.length).toBeGreaterThanOrEqual(3);
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThan(48 * 1024);
    const other = store.db.prepare("SELECT id FROM sessions WHERE id != ?").get(context.sessionId);
    expect(other).toBeUndefined();
    await expect(service.getDiffFile({ sessionId: "different-session", diffId: page.diffId!, fileId: page.files[0]!.fileId })).rejects.toMatchObject({ code: "CHECKPOINT_SCOPE_MISMATCH" });
  });
  it("budgets JSON escapes and hashes the same public inline bytes the client receives", async () => {
    const { root, store, driver, context } = await fixture();
    const service = new CheckpointService({ store, driverFor: () => driver, assertLease: () => {}, content: {
      putBytes: (input) => ({ ref: `content-${digest(input.data)}`, bytes: input.data.byteLength, sha256: digest(input.data), format: input.format }),
      pin: () => "pin",
    } });
    await service.captureBefore(context);
    await writeFile(join(root, "controls.txt"), "\u0001".repeat(4096));
    await writeFile(join(root, "tracked.txt"), `Private root ${root}/file; 中文 😀\n`);
    await service.captureAfter({ ...context, evidence }); const page = await service.getTurnDiff(context);
    const escaped = await service.getDiffFile({ sessionId: context.sessionId, diffId: page.diffId!, fileId: page.files.find((file) => file.path === "controls.txt")!.fileId });
    expect(escaped.after).toMatchObject({ kind: "contentRef", binary: false, encoding: "base64" });
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(48 * 1024);
    const inline = await service.getDiffFile({ sessionId: context.sessionId, diffId: page.diffId!, fileId: page.files.find((file) => file.path === "tracked.txt")!.fileId });
    const text = "Private root ./file; 中文 😀\n";
    expect(inline.after).toEqual({ kind: "text", bytes: Buffer.byteLength(text), sha256: digest(text), text });
    expect(JSON.stringify(inline)).not.toContain(root); expect(CheckpointDiffFileSchema.safeParse(inline).success).toBe(true);
  });
  it("keeps capture failures separate from terminal facts and refuses missing retained refs", async () => {
    const { root, store, context, driver, owner } = await fixture();
    const outsideRoot = join(root, "ordinary-directory"); await mkdir(outsideRoot);
    let unavailable = true;
    const service = new CheckpointService({ store, driverFor: () => unavailable ? new CheckpointGitDriver(outsideRoot, { runGit: rawCheckpointGitRunner() }) : driver, assertLease: () => {} });
    await expect(service.captureBefore(context)).rejects.toMatchObject({code:"CHECKPOINT_BEFORE_UNAVAILABLE",manifest:{status:"failed"}});
    owner.createTurn({ sessionId: context.sessionId, turnId: context.turnId, commandId: "cmd", requestHash: "hash", prompt: "done", generation: 1 });
    owner.commitEvent(context.sessionId, "turn.completed", {}, { turnId: context.turnId, turnStatus: "completed", activityState: "idle" });
    unavailable = false; const after = await service.captureAfter({ ...context, evidence });
    expect(owner.getTurn(context.turnId)?.status).toBe("completed"); expect((await service.getTurnDiff(context)).status).toBe("unavailable");
    const freshContext = { ...context, turnId: "turn-2", attemptId: "attempt-2" }; await service.captureBefore(freshContext); await service.captureAfter({ ...freshContext, evidence });
    await fixtureGit(root, ["update-ref", "-d", after.workspaceRef]);
    const page = await service.getDiffPage({ sessionId: context.sessionId, beforeCheckpointId: store.findAttempt(context.sessionId, freshContext.turnId, freshContext.attemptId, "before")!.checkpointId, afterCheckpointId: after.checkpointId });
    expect(page).toMatchObject({ status: "unavailable", unavailableReason: "capture_unavailable" });
  });
  it("persists unknown helper stop on the original after capture while retaining known Provider terminal", async () => {
    const {store,context,driver,owner}=await fixture();
    let fail=false;
    const service=new CheckpointService({store,assertLease:()=>{},driverFor:()=>fail ? new CheckpointGitDriver(driver.workspace,{runGit:async(request)=>{throw new ManagedGitError("MANAGED_GIT_TREE_STOP_UNPROVEN","unknown",{processId:"original-after-helper",launchDigest:"a".repeat(64),purpose:"checkpoint_read",policyId:"checkpoint-policy",...("checkpointId" in request.operation?{operationId:request.operation.checkpointId}:{}),bindingDigest:"b".repeat(64)});}}):driver});
    await service.captureBefore(context);
    owner.createTurn({sessionId:context.sessionId,turnId:context.turnId,commandId:"known-terminal",requestHash:"hash",prompt:"done",generation:1});
    owner.commitEvent(context.sessionId,"turn.completed",{},{turnId:context.turnId,turnStatus:"completed",activityState:"idle"});
    fail=true;
    const after=await service.captureAfter({...context,evidence});
    expect(after).toMatchObject({status:"failed",errorCode:"MANAGED_GIT_TREE_STOP_UNPROVEN",producerFailure:{state:"unknown",producerStopped:false,operation:{kind:"capture",checkpointId:after.checkpointId},helper:{processId:"original-after-helper",operationId:after.checkpointId,launchDigest:"a".repeat(64),bindingDigest:"b".repeat(64)}}});
    expect(store.require(after.checkpointId,context.sessionId).producerFailure).toEqual(after.producerFailure);
    expect(owner.getTurn(context.turnId)!.status).toBe("completed");
    expect((await service.getTurnDiff(context)).status).toBe("unavailable");
  });
  it.each(["not_spawned","stopped","unknown"] as const)("rejects a failed before capture with its %s producer state before caller prompt dispatch",async(state)=>{
    const {store,context,root}=await fixture();let dispatched=false;
    const service=new CheckpointService({store,assertLease:()=>{},driverFor:()=>new CheckpointGitDriver(root,{runGit:async()=>{throw new ManagedGitError("MANAGED_GIT_TREE_STOP_UNPROVEN",state);}})});
    await expect(service.captureBefore(context).then(()=>{dispatched=true;})).rejects.toMatchObject({code:"CHECKPOINT_BEFORE_UNAVAILABLE",producerFailure:{state,producerStopped:state!=="unknown"}});
    expect(dispatched).toBe(false);
    const saved=store.findAttempt(context.sessionId,context.turnId,context.attemptId,"before")!;
    expect(saved.status).toBe("failed");expect(saved.producerFailure!.operation).toEqual({kind:"capture",checkpointId:saved.checkpointId});
    await expect(service.captureBefore(context)).rejects.toMatchObject({code:"CHECKPOINT_BEFORE_UNAVAILABLE",manifest:{checkpointId:saved.checkpointId}});
  });
  it("persists a capturing journal and protects refs when manifest persistence fails", async () => {
    const { service, store, context } = await fixture();
    store.db.exec("CREATE TRIGGER fail_checkpoint_files BEFORE INSERT ON checkpoint_files BEGIN SELECT RAISE(ABORT, 'injected manifest failure'); END;");
    await expect(service.captureBefore(context)).rejects.toThrow("injected manifest failure"); await service.drain();
    const row = store.findAttempt(context.sessionId, context.turnId, context.attemptId, "before")!;
    expect(row.status).toBe("capturing"); expect(store.protectedRefs()).toContainEqual({ checkpointId: row.checkpointId, workspaceRef: row.workspaceRef, indexRef: row.indexRef });
    await expect(service.captureBefore(context)).rejects.toMatchObject({ code: "CAPTURE_IN_PROGRESS" });
    const reconciled = service.reconcileInterruptedCaptures(context.sessionId, { capturesStopped: true });
    expect(reconciled[0]).toMatchObject({ status: "failed", errorCode: "CAPTURE_INTERRUPTED", samplingConsistency: "unavailable" });
    expect(store.protectedRefs()).toContainEqual({ checkpointId: row.checkpointId, workspaceRef: row.workspaceRef, indexRef: row.indexRef });
    expect(service.reconcileInterruptedCaptures(context.sessionId, { capturesStopped: true })).toEqual([]);
  });
  it("requires after producer-stop/terminal ordering and session-bound IDs", async () => {
    const { service, context } = await fixture();
    await expect(service.captureAfter({ ...context, evidence: { ...evidence, producerStopped: false } } as unknown as AfterCheckpointContext)).rejects.toMatchObject({ code: "CHECKPOINT_ORDER_INVALID" });
    const before = await service.captureBefore(context);
    await expect(service.getDiffPage({ sessionId: "another", beforeCheckpointId: before.checkpointId, afterCheckpointId: before.checkpointId })).rejects.toMatchObject({ code: "CHECKPOINT_SCOPE_MISMATCH" });
  });
  it("marks legacy HEAD baselines inexact and never replaces them with a fabricated historical snapshot", async () => {
    const root = await temporaryRepository(); roots.push(root); const owner = new SqliteStore(); owners.push(owner);
    const session = owner.createSession(root); owner.setSessionBaseline(session.id, { head: "historical-head", dirty: true, files: [{ path: "user-work.txt" }] });
    applyCheckpointSchema(owner.db); const store = new CheckpointStore(owner.db); const baseline = store.getBaseline(session.id)!;
    expect(baseline.status).toBe("legacy_inexact"); expect(baseline.workspaceTree).toBeUndefined(); expect(baseline.indexTree).toBeUndefined();
    applyCheckpointSchema(owner.db); expect(store.getBaseline(session.id)?.checkpointId).toBe(baseline.checkpointId);
    const driver = new CheckpointGitDriver(root, { runGit: rawCheckpointGitRunner() }); const service = new CheckpointService({ store, driverFor: () => driver, assertLease: () => {} });
    const disposable = checkpointFixture(root); const context = { ...disposable.context, sessionId: session.id }; disposable.owner.close();
    const returned = await service.ensureSessionBaseline(context); expect(returned.checkpointId).toBe(baseline.checkpointId);
  });
});
