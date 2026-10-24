import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY, CheckpointDiffPageSchema, CheckpointPreviewPageSchema, CheckpointRevertEvidenceSchema, CheckpointRevertOperationSchema, SESSION_CATALOG_CAPABILITY } from "@flyx/mvp-protocol";
import { createHostApplication } from "./host-application.js";
import { parseConnectivityConfig } from "./connectivity/config.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity } from "./identity/host-identity.js";
import { HostOwnerLock } from "./lifecycle/host-owner.js";
import { HostActivationLoad, observeLocalWorkspace, providerLocalFacts, type ActivationLoadFacts } from "./lifecycle/host-activation-load.js";
import { HostActivationService } from "./lifecycle/host-activation-service.js";
import { createActivationOperationStore } from "./storage/activation-store.js";
import { openOwned } from "./storage/open-store.js";
import { inspectCatalogStartupReadiness } from "./session/catalog-startup-readiness.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { temporaryRepository, removeFixture } from "./checkpoint/test-support.js";
import { WorkspaceRegistry } from "./workspace/workspace-registry.js";
import { fixtureTreeStopBackend, rawWorkspaceGitQuery, trustedFixtureGit } from "./test-support/managed-git-fixtures.js";
import type { ProviderAdapter, ProviderOutcome } from "./provider/types.js";

/**
 * R9 组合终验: one activated production application graph driven end to end —
 * real Turns against a real managed git workspace, real before/after captures,
 * public checkpoint diff/preview RPCs, then the honest fail-closed production
 * revert boundary: executeRevert refuses without a signed native capability,
 * workspaceRestore really restores the workspace through the managed helper
 * runner and blocks NEW_CONVERSATION_REQUIRED, and rollbackToSafety returns
 * the workspace to the pre-restore state.
 */
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function fixture() {
  // Private directories (database/identity plus the default coordination
  // directory under tmpdir) mirror the production layout; the probe helper
  // launches with cwd = realpath(tmpdir()) and must still be admitted.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-r9-combined-"))), workspace = realpathSync(await temporaryRepository());
  mkdirSync(join(root, "data"));
  const executable = join(root, "provider"); writeFileSync(executable, "#!/bin/sh\nexit 0\n"); chmodSync(executable, 0o700);
  const databasePath = join(root, "data", "host.sqlite"), identityDirectory = join(root, "data", "identity");
  const owner = HostOwnerLock.acquire({ databasePath, identityDirectory }), store = openOwned({ databasePath, owner });
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const observation: ActivationLoadFacts = {
    workspace: (record) => observeLocalWorkspace(record, [dirname(databasePath)]),
    provider: (record) => {
      const local = providerLocalFacts(record);
      if (!local) return { ready: false, reasonCodes: ["PROVIDER_EXECUTABLE_UNAVAILABLE"] };
      return { ready: true, value: { ...local, providerInstanceId: record.providerInstanceId, provider: record.provider,
        runtimeVersion: "explicit-fixture-runtime", runtimeArtifactDigest: "a".repeat(64), capabilities: record.policyCapabilities } };
    },
  };
  const outcome: ProviderOutcome = { status: "completed", providerSessionId: "fixture-native", evidence: { kind: "native-terminal", sourceId: "r9-fixture-result" } };
  // The adapter writes the real workspace changes the checkpoint boundary must
  // observe; writes are idempotent per prompt so both the begin/run seams agree.
  const applyFixtureFiles = async (prompt: string) => {
    if (prompt.includes("r9-turn-one")) await writeFile(join(workspace, "tracked.txt"), "turn-1\n");
    else if (prompt.includes("r9-turn-two")) {
      await writeFile(join(workspace, "tracked.txt"), "turn-2\n");
      await writeFile(join(workspace, "extra.txt"), "extra\n");
    }
  };
  const adapter: ProviderAdapter = { provider: "codex", workspace,
    status: async () => { throw new Error("Paid Provider forbidden"); }, preflight: async () => { throw new Error("Paid Provider forbidden"); },
    runTurn: async (_turnId: string, prompt: string) => { await applyFixtureFiles(prompt); return outcome; },
    beginTurn: (_context, prompt: string) => { void applyFixtureFiles(prompt); return { outcome: Promise.resolve(outcome) }; },
    interrupt: async () => "accepted", respondApproval: () => true };
  const application = await createHostApplication({ store, owner, identity,
    configuration: { workspaces: [{ workspaceId: "workspace", root: workspace }], providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable, policyCapabilities: ["workspaceWrite"] }] },
    initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" },
    execution: { observation, git: { stopBackend: fixtureTreeStopBackend(), allowFixtureStopBackend: true, gitExecutable: trustedFixtureGit(), pythonExecutable: "/usr/bin/python3" },
      runtimeOptions: () => ({ adapter, canReleaseWorkspace: () => true }) },
    server: { pairingConfirmation: () => true, port: 0, webRoot: join(root, "no-web"), connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1" }) },
  });
  closes.push(async () => { await application.stop().catch(() => {}); await removeFixture(workspace); rmSync(root, { recursive: true, force: true }); });
  const operations = createActivationOperationStore({ db: store.db, workspace: (id) => application.catalog.catalog.workspace(id), provider: (id) => application.catalog.catalog.provider(id) }, { guard: () => owner.assertActive() });
  await new WorkspaceRegistry(application.catalog.catalog, { owner, readOnlyGit: rawWorkspaceGitQuery() })
    .registerLocal({ workspaceId: "workspace", root: workspace, capabilities: ["streamingText", "workspaceWrite"] });
  const load = new HostActivationLoad(operations, observation);
  const management = new HostActivationService({ facts: { db: store.db, owner, catalog: application.catalog.catalog, readiness: () => inspectCatalogStartupReadiness(application.catalog) }, operations, load, observation, actorId: "fixture-maintenance",
    executorFactory: async () => ({ readOnlyGit: rawWorkspaceGitQuery(), prepare: async () => ({ ready: true }), closeAndWait: async () => ({ producerStopped: true, clean: true }) }) });
  const evidence = await management.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "fixture-verify" });
  management.activate({ evidenceId: evidence.evidenceId, commandId: "fixture-activate" });
  await management.close();
  store.createDevice({ id: "actor", hostId: identity.hostId, platform: "test", credentialKind: "browser-session", credentialRevision: 0, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  await application.start();
  const sessionId = application.catalog.legacySessionId;
  const dispatchTurn = async (commandId: string, prompt: string) => {
    const result = await application.catalog.dispatchCatalog({ id: randomUUID(), method: "session.startTurn", commandId, payload: { sessionId, prompt } }, {
      subjectId: "actor", protocolVersion: 2, capabilities: new Set([SESSION_CATALOG_CAPABILITY]), assertAuthorized: () => {}, subscribe: async () => ({}), access: async () => ({}), assertSessionScope: () => {},
    });
    if (!result.handled) throw new Error("TURN_NOT_HANDLED");
    const runtime = application.catalog.registry.loaded(sessionId) as SessionOrchestrator;
    await runtime.worker.drainOperations();
  };
  const rpc = async (method: string, payload: unknown, commandId?: string) => {
    const result = await application.checkpoints.dispatchCheckpoint({ id: randomUUID(), method, payload, ...(commandId ? { commandId } : {}) }, {
      subjectId: "actor", protocolVersion: 2, capabilities: new Set([CHECKPOINT_DIFF_CAPABILITY, CHECKPOINT_REVERT_CAPABILITY]), assertAuthorized: () => {}, assertSessionScope: () => {},
    });
    if (!result.handled) throw new Error("CHECKPOINT_NOT_HANDLED");
    return result.payload;
  };
  const drainRevertWork = async () => {
    const runtime = application.catalog.registry.loaded(sessionId) as SessionOrchestrator;
    runtime.worker.scan();
    await runtime.worker.drainDispatch();
  };
  const captures = () => store.db.prepare("SELECT checkpoint_id, phase, turn_id, attempt_id, status FROM checkpoint_captures WHERE session_id=? AND phase IN ('before','after') ORDER BY rowid").all(sessionId) as { checkpoint_id: string; phase: string; turn_id: string; attempt_id: string; status: string }[];
  const turnRow = (commandId: string) => store.db.prepare("SELECT id, attempt_id, status FROM turns WHERE session_id=? AND command_id=?").get(sessionId, commandId) as { id: string; attempt_id: string | null; status: string };
  return { application, store, workspace, sessionId, dispatchTurn, rpc, drainRevertWork, captures, turnRow };
}

describe("R9 combined acceptance in activated production main", { timeout: 120_000 }, () => {
  it("runs real turns, real captures, honest revert gates, real workspace restore and safety rollback", async () => {
    const f = await fixture();
    const session = f.store.getSession(f.sessionId)!;
    expect(session.revision).toBeGreaterThanOrEqual(0);
    await f.dispatchTurn("r9-turn-1", "r9-turn-one writes tracked.txt");
    const first = f.turnRow("r9-turn-1");
    expect(first.status).toBe("completed"); expect(first.attempt_id).toBeTruthy();
    const firstCaptures = f.captures();
    expect(firstCaptures.map((row) => row.phase)).toEqual(["before", "after"]);
    expect(firstCaptures.every((row) => row.status === "complete" && row.turn_id === first.id && row.attempt_id === first.attempt_id)).toBe(true);
    expect(await readFile(join(f.workspace, "tracked.txt"), "utf8")).toBe("turn-1\n");

    await f.dispatchTurn("r9-turn-2", "r9-turn-two writes tracked.txt and extra.txt");
    const second = f.turnRow("r9-turn-2");
    expect(second.status).toBe("completed"); expect(second.attempt_id).toBeTruthy();
    expect(f.captures()).toHaveLength(4);
    expect(await readFile(join(f.workspace, "tracked.txt"), "utf8")).toBe("turn-2\n");
    expect(existsSync(join(f.workspace, "extra.txt"))).toBe(true);

    // Public turn diffs describe exactly what each real Turn changed.
    const firstDiff = CheckpointDiffPageSchema.parse(await f.rpc("checkpoint.getTurnDiff", { sessionId: f.sessionId, turnId: first.id, attemptId: first.attempt_id }));
    expect(firstDiff.totalFiles).toBe(1);
    expect(firstDiff.before.checkpointId).toBe(firstCaptures[0]!.checkpoint_id);
    expect(firstDiff.after.checkpointId).toBe(firstCaptures[1]!.checkpoint_id);
    expect(firstDiff.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    const secondDiff = CheckpointDiffPageSchema.parse(await f.rpc("checkpoint.getTurnDiff", { sessionId: f.sessionId, turnId: second.id, attemptId: second.attempt_id }));
    expect(new Set(secondDiff.files.map((file) => file.path))).toEqual(new Set(["extra.txt", "tracked.txt"]));

    // Preview the historical revert-to-turn-1 boundary.
    const page = CheckpointPreviewPageSchema.parse(await f.rpc("checkpoint.previewRevert", { sessionId: f.sessionId, checkpointId: firstCaptures[1]!.checkpoint_id, expectedSessionRevision: f.store.getSession(f.sessionId)!.revision }));
    expect(page.planId).toBeTruthy();

    // Honest fail-closed: this fixture has no signed native rewind capability,
    // so the production boundary refuses a native conversation rewind.
    const rewind = { sessionId: f.sessionId, commandId: "r9-execute-revert", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    await expect(f.rpc("checkpoint.executeRevert", rewind, rewind.commandId)).rejects.toMatchObject({ code: "PROVIDER_REWIND_UNSUPPORTED" });
    expect(f.store.getCommandReceipt("actor", rewind.commandId)).toBeUndefined();

    // Workspace restore is admitted: the managed helper runner really restores
    // the checkout to the turn-1 checkpoint, then blocks for a new native
    // conversation because none is proved.
    const restore = { sessionId: f.sessionId, commandId: "r9-workspace-restore", planId: page.planId, expectedSessionRevision: page.expectedSessionRevision, confirmation: true };
    const accepted = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.workspaceRestore", restore, restore.commandId));
    expect(accepted.status).toBe("queued");
    await f.drainRevertWork();
    const blocked = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.getRevertOperation", { sessionId: f.sessionId, operationId: accepted.operationId }));
    expect(blocked).toMatchObject({ status: "blocked", errorCode: "NEW_CONVERSATION_REQUIRED", recoveryRequired: true });
    expect(await readFile(join(f.workspace, "tracked.txt"), "utf8")).toBe("turn-1\n");
    expect(f.store.getSession(f.sessionId)!.recoveryState).toBe("blocked");
    expect(() => f.store.createTurn({ sessionId: f.sessionId, turnId: randomUUID(), commandId: "r9-blocked-turn", requestHash: "r9", prompt: "must block", generation: 3 })).toThrow();
    const evidence = CheckpointRevertEvidenceSchema.parse(await f.rpc("checkpoint.inspectRevert", { sessionId: f.sessionId, operationId: accepted.operationId }));
    expect(evidence.safetyRollbackAvailable).toBe(true);

    // Safety rollback returns the real workspace to the pre-restore state.
    const rollback = { sessionId: f.sessionId, operationId: accepted.operationId, commandId: "r9-rollback", evidenceId: evidence.evidenceId, expectedSessionRevision: evidence.expectedSessionRevision, confirmation: true };
    const rolled = CheckpointRevertOperationSchema.parse(await f.rpc("checkpoint.rollbackToSafety", rollback, rollback.commandId));
    expect(rolled.parentOperationId).toBe(accepted.operationId);
    await f.drainRevertWork();
    expect(await readFile(join(f.workspace, "tracked.txt"), "utf8")).toBe("turn-2\n");
  });
});
