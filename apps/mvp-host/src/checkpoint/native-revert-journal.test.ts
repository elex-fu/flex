import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { bindingDigest } from "./git-driver.js";
import type { NativeRevertMutation, NativeRevertMutationJournal } from "./native-revert-drivers.js";
import { RevertCrash } from "./revert-types.js";
import type { NativeRevertRequest } from "./revert-types.js";
import { revertFixture } from "./revert-test-support.js";

const fixtures: Awaited<ReturnType<typeof revertFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.revert.drain(20); if (fixture.owner.db.open) fixture.owner.close(); await rm(fixture.root, { recursive: true, force: true }); } });

async function fixture(crash?: "after_claim" | "after_external", beforeClaim?: () => Promise<void>) {
  const f = await revertFixture({ persistent: true }); fixtures.push(f);
  let lastMutation: NativeRevertMutation | undefined, lastRequest: NativeRevertRequest | undefined;
  let journal: NativeRevertMutationJournal;
  delete f.serviceOptions.native;
  f.restart({ nativeFactory: (ownedJournal) => {
    journal = ownedJournal;
    return {
      prepare: (input) => f.native.prepare(input),
      query: (request) => f.native.query(request),
      apply: async (request) => {
        const mutation: NativeRevertMutation = { operationId: request.operationId, requestId: request.requestId, requestDigest: bindingDigest(request),
          originalHandle: { provider: "codex", providerInstanceId: "fixture-instance", workspaceId: "default", nativeSessionId: "native-1", workspacePath: f.root, configurationFingerprint: "config-v1", verifiedVersion: "fixture-v1" },
          command: { method: "thread/rollback", threadId: "native-1", numTurns: 1 } };
        lastMutation = mutation; lastRequest = request;
        await beforeClaim?.();
        if (await journal.claim(mutation) === "existing") return f.native.query(request);
        if (crash === "after_claim") throw new RevertCrash("native_claim_durable");
        const proof = await f.native.apply(request);
        if (crash === "after_external") throw new RevertCrash("native_external_applied");
        await journal.record(mutation, { operationId: mutation.operationId, requestId: mutation.requestId, requestDigest: mutation.requestDigest,
          sourceId: "exact-original-managed-helper", state: "completed", quiescent: true, pendingRequest: false });
        return proof;
      },
    };
  } });
  Object.defineProperties(f, { mutation: { get: () => lastMutation! }, request: { get: () => lastRequest! }, journal: { get: () => journal! } });
  return f as typeof f & { readonly mutation: NativeRevertMutation; readonly request: NativeRevertRequest; readonly journal: NativeRevertMutationJournal };
}

describe("Service-owned native mutation journal", { timeout: 25_000 }, () => {
  it("commits claim and receipt through existing Engine projections and refreshes revisions before success", async () => {
    const f = await fixture(), operation = await f.accept();
    expect((await f.dispatch(operation.operationId)).status).toBe("settled");
    const stored = f.revert.store.require(operation.operationId, f.context.sessionId), attempt = stored.steps.find((step) => step.kind === "provider")!.attempts.at(-1)!;
    expect(attempt.nativeMutation!.mutation).toEqual(f.mutation);
    expect(attempt.nativeMutation!.receipt).toMatchObject({ state: "completed", requestId: f.request.requestId });
    expect(attempt.nativeMutation!.receiptOperationRevision).toBe(attempt.nativeMutation!.claimOperationRevision + 1);
    const row = f.owner.db.prepare("SELECT attempt_json FROM checkpoint_revert_step_attempts WHERE attempt_id=?").get(attempt.attemptId) as { attempt_json: string };
    expect(JSON.parse(row.attempt_json)).toEqual(attempt);
    const steps = f.owner.db.prepare("SELECT step_json FROM checkpoint_revert_steps WHERE operation_id=? AND kind='provider'").get(operation.operationId) as { step_json: string };
    expect(JSON.parse(steps.step_json).attempts.at(-1)).toEqual(attempt);
    expect(f.native.calls).toHaveLength(1);
  });
  it("reopens the SQLite file after claim-before-send crash and cannot authorize a second dispatch", async () => {
    const f = await fixture("after_claim"), operation = await f.accept();
    await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    const mutation = structuredClone(f.mutation);
    expect(f.native.calls).toHaveLength(0); f.reopen();
    expect((await f.revert.nativeMutationJournal.get(operation.operationId, mutation.requestId))!.mutation).toEqual(mutation);
    expect(await f.revert.nativeMutationJournal.claim(mutation)).toBe("existing");
    expect(f.native.calls).toHaveLength(0);
    expect(f.revert.store.require(operation.operationId, f.context.sessionId).safetyCheckpointId).toBeTruthy();
    expect(f.owner.getSession(f.context.sessionId)!.recoveryState).toBe("blocked");
  });
  it("reopens after lost external result and resumes by original read-only evidence without repeating native mutation", async () => {
    const f = await fixture("after_external"), operation = await f.accept();
    await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    const mutation = structuredClone(f.mutation);
    expect(f.native.calls).toHaveLength(1); f.reopen();
    const record = await f.revert.nativeMutationJournal.get(operation.operationId, mutation.requestId);
    expect(record!.mutation).toEqual(mutation); expect(record!.receipt).toBeUndefined();
    expect(await f.revert.nativeMutationJournal.claim(mutation)).toBe("existing");
    const resumed = await f.resume(operation.operationId);
    expect((await f.dispatch(resumed.operationId)).status).toBe("settled"); expect(f.native.calls).toHaveLength(1);
  });
  it("rejects rebound original request bytes after a real database reopen", async () => {
    const f = await fixture("after_claim"), operation = await f.accept();
    await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    const mutation = structuredClone(f.mutation); f.reopen();
    await expect(f.revert.nativeMutationJournal.claim({ ...mutation, requestDigest: "different-boundary" })).rejects.toThrow("durable claim");
    await expect(f.revert.nativeMutationJournal.claim({ ...mutation, requestId: "replacement-request" })).rejects.toThrow("persisted Provider step");
    expect(f.native.calls).toHaveLength(0);
  });
  it("keeps safety and claim when receipt SQL commit fails after native application", async () => {
    const f = await fixture(), operation = await f.accept();
    f.owner.db.exec("CREATE TEMP TRIGGER fail_native_receipt BEFORE UPDATE ON checkpoint_revert_step_attempts WHEN json_extract(NEW.attempt_json,'$.nativeMutation.receipt') IS NOT NULL BEGIN SELECT RAISE(ABORT,'native receipt disk failure'); END");
    expect((await f.dispatch(operation.operationId)).status).toBe("outcome_unknown");
    const stored = f.revert.store.require(operation.operationId, f.context.sessionId);
    expect(stored.stage).toBe("partial_failure"); expect(stored.safetyCheckpointId).toBeTruthy();
    expect(stored.steps.find((step) => step.kind === "provider")!.attempts.at(-1)!.nativeMutation!.receipt).toBeUndefined();
    expect(f.native.calls).toHaveLength(1); f.reopen();
    const resumed = await f.resume(operation.operationId);
    expect((await f.dispatch(resumed.operationId)).status).toBe("settled"); expect(f.native.calls).toHaveLength(1);
  });
  it("does not send when the Engine-owned claim transaction fails", async () => {
    const f = await fixture(), operation = await f.accept();
    f.owner.db.exec("CREATE TEMP TRIGGER fail_native_claim BEFORE UPDATE ON checkpoint_revert_step_attempts WHEN json_extract(NEW.attempt_json,'$.nativeMutation.mutation') IS NOT NULL BEGIN SELECT RAISE(ABORT,'native claim disk failure'); END");
    expect((await f.dispatch(operation.operationId)).status).toBe("outcome_unknown");
    const stored = f.revert.store.require(operation.operationId, f.context.sessionId);
    expect(stored.stage).toBe("partial_failure"); expect(stored.safetyCheckpointId).toBeTruthy();
    expect(stored.steps.find((step) => step.kind === "provider")!.attempts.at(-1)!.nativeMutation).toBeUndefined();
    expect(f.native.calls).toHaveLength(0);
    expect(f.owner.getSession(f.context.sessionId)!.recoveryState).toBe("blocked");
  });
  it("rejects a late native read continuation after the original operation deadline blocked its gate", async () => {
    let release!: () => void;
    const read = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(undefined, () => read); f.restart({ nativeTimeoutMs: 5 });
    const operation = await f.accept();
    expect((await f.dispatch(operation.operationId)).status).toBe("outcome_unknown");
    expect(f.native.calls).toHaveLength(0); release(); await f.revert.drain(100);
    expect(f.native.calls).toHaveLength(0);
    const stored = f.revert.store.require(operation.operationId, f.context.sessionId);
    expect(stored.status).toBe("blocked");
    expect(stored.steps.find((step) => step.kind === "provider")!.attempts.at(-1)!.nativeMutation).toBeUndefined();
  });
});
