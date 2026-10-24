import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CATALOG_CAPABILITY, WORKTREE_CAPABILITY } from "@flyx/mvp-protocol";
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
 * A11 production-entry parallelism: through the real application graph, a
 * managed worktree checkout is created by device command, verified and
 * activated, and then a Session on it executes a real Turn that genuinely
 * overlaps a Turn in the main checkout. Same checkout stays mutually
 * exclusive, and each Session's durable rows (turns, captures, events) and
 * workspace writes stay isolated with no lease or event cross-talk.
 */
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function delay(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-r9-parallel-"))), workspace = realpathSync(await temporaryRepository());
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "worktrees"));
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
  const outcome: ProviderOutcome = { status: "completed", providerSessionId: "fixture-native", evidence: { kind: "native-terminal", sourceId: "a11-fixture-result" } };
  // Per-checkout adapter state: the shared overlap gate proves the two Turns
  // really executed concurrently; the hold gate pins the main checkout lease
  // while an excluded same-checkout Session attempts to start a Turn.
  const entered: string[] = [];
  const adapterCalls = new Map<string, number>();
  const runs = new Map<string, Promise<ProviderOutcome>>();
  let overlapProved = false, excludedInvoked = false, holdEntered = false;
  const overlapGate = deferred(), holdRelease = deferred();
  const applyFixtureFiles = async (prompt: string, checkoutRoot: string) => {
    if (prompt.includes("a11-parallel-main")) await writeFile(join(checkoutRoot, "parallel-main.txt"), "main\n");
    else if (prompt.includes("a11-parallel-worktree")) await writeFile(join(checkoutRoot, "parallel-worktree.txt"), "worktree\n");
  };
  // The adapter reads the parallel pair's session ids through this holder so
  // the overlap gate resolves only when both real Sessions are live.
  const parallelPair: { main?: string; worktree?: string } = {};
  const adapterFor = (checkoutRoot: string): ProviderAdapter => ({
    provider: "codex", workspace: checkoutRoot,
    status: async () => { throw new Error("Paid Provider forbidden"); }, preflight: async () => { throw new Error("Paid Provider forbidden"); },
    beginTurn: (context, prompt: string) => {
      const sessionId = context.sessionId;
      adapterCalls.set(sessionId, (adapterCalls.get(sessionId) ?? 0) + 1);
      entered.push(sessionId);
      if (prompt.includes("a11-parallel")) {
        // Whichever Turn enters second observes both real Sessions inside the
        // adapter, proving genuine overlap at the production entry seam.
        if (parallelPair.main && parallelPair.worktree
          && entered.includes(parallelPair.main) && entered.includes(parallelPair.worktree)) { overlapProved = true; overlapGate.resolve(); }
        const parked = (async () => {
          // Deadlock guard: resolve regardless after a bounded wait so the
          // assertion (not a hang) reports a missing overlap.
          await Promise.race([overlapGate.promise, delay(20_000)]);
          await applyFixtureFiles(prompt, checkoutRoot);
          return outcome;
        })();
        runs.set(prompt.includes("a11-parallel-main") ? "main" : "worktree", parked);
        return { outcome: parked };
      }
      if (prompt.includes("a11-hold")) {
        holdEntered = true;
        const parked = (async () => { await Promise.race([holdRelease.promise, delay(30_000)]); return outcome; })();
        runs.set("hold", parked);
        return { outcome: parked };
      }
      excludedInvoked = true;
      return { outcome: Promise.resolve(outcome) };
    },
    runTurn: async (_turnId: string, prompt: string) => { await applyFixtureFiles(prompt, checkoutRoot); return outcome; },
    interrupt: async () => "accepted", respondApproval: () => true,
  });
  const application = await createHostApplication({ store, owner, identity,
    configuration: { workspaces: [{ workspaceId: "workspace", root: workspace }], providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable, policyCapabilities: ["workspaceWrite"] }] },
    initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" },
    execution: { observation, worktreesRoot: join(root, "worktrees"),
      facts: { supervision: () => ({ contractId: "fixture-verified-tree-stop/v1" }) },
      git: { stopBackend: fixtureTreeStopBackend(), allowFixtureStopBackend: true, gitExecutable: trustedFixtureGit(), pythonExecutable: "/usr/bin/python3" },
      runtimeOptions: (context) => ({ adapter: adapterFor(context.workspace.worktreeRoot ?? context.workspace.canonicalRoot), canReleaseWorkspace: () => true }) },
    server: { pairingConfirmation: () => true, port: 0, webRoot: join(root, "no-web"), connectivity: parseConnectivityConfig({ FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_ALLOW_INSECURE_HTTP: "1" }) },
  });
  closes.push(async () => { holdRelease.resolve(); await application.stop().catch(() => {}); await removeFixture(workspace); rmSync(root, { recursive: true, force: true }); });
  const operations = createActivationOperationStore({ db: store.db, workspace: (id) => application.catalog.catalog.workspace(id), provider: (id) => application.catalog.catalog.provider(id) }, { guard: () => owner.assertActive() });
  await new WorkspaceRegistry(application.catalog.catalog, { owner, readOnlyGit: rawWorkspaceGitQuery() })
    .registerLocal({ workspaceId: "workspace", root: workspace, capabilities: ["streamingText", "workspaceWrite"], repositoryId: "repo-one" });
  const load = new HostActivationLoad(operations, observation);
  const management = new HostActivationService({ facts: { db: store.db, owner, catalog: application.catalog.catalog, readiness: () => inspectCatalogStartupReadiness(application.catalog) }, operations, load, observation, actorId: "fixture-maintenance",
    executorFactory: async () => ({ readOnlyGit: rawWorkspaceGitQuery(), prepare: async () => ({ ready: true }), closeAndWait: async () => ({ producerStopped: true, clean: true }) }) });
  const activateWorkspace = async (workspaceId: string, prefix: string) => {
    const evidence = await management.verify({ workspaceId, providerInstanceId: "provider", commandId: prefix + "-verify" });
    management.activate({ evidenceId: evidence.evidenceId, commandId: prefix + "-activate" });
  };
  await activateWorkspace("workspace", "a11-main");
  store.createDevice({ id: "actor", hostId: identity.hostId, platform: "test", credentialKind: "browser-session", credentialRevision: 0, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  await application.start();
  const legacySessionId = application.catalog.legacySessionId;
  const catalogContext = {
    subjectId: "actor", protocolVersion: 2, capabilities: new Set([SESSION_CATALOG_CAPABILITY]), assertAuthorized: () => {}, subscribe: async () => ({}), access: async () => ({}), assertSessionScope: () => {},
  };
  const createSession = async (commandId: string, workspaceId: string) => {
    const result = await application.catalog.dispatchCatalog({ id: randomUUID(), method: "session.createNew", commandId, payload: { workspaceId, providerInstanceId: "provider", title: "A11" } }, catalogContext);
    if (!result.handled) throw new Error("CREATE_NOT_HANDLED");
    return result.payload as { session: { sessionId: string } };
  };
  const startTurn = async (sessionId: string, commandId: string, prompt: string) => {
    const result = await application.catalog.dispatchCatalog({ id: randomUUID(), method: "session.startTurn", commandId, payload: { sessionId, prompt } }, catalogContext);
    if (!result.handled) throw new Error("TURN_NOT_HANDLED");
  };
  const drain = async (sessionId: string) => {
    const runtime = application.catalog.registry.loaded(sessionId) as SessionOrchestrator;
    if (!runtime) throw new Error("RUNTIME_NOT_LOADED");
    // Gated Turns park well past the default 5s deadline, so the worker's
    // operation queue is drained with an explicit long budget and the parked
    // outcome promises are awaited separately by the test body.
    await runtime.worker.drainOperations(60_000);
  };
  const turnRow = (sessionId: string, commandId: string) => store.db.prepare("SELECT id, status FROM turns WHERE session_id=? AND command_id=?").get(sessionId, commandId) as { id: string; status: string } | undefined;
  const captures = (sessionId: string) => store.db.prepare("SELECT phase, turn_id, status FROM checkpoint_captures WHERE session_id=? AND phase IN ('before','after') ORDER BY rowid").all(sessionId) as { phase: string; turn_id: string; status: string }[];
  const events = (sessionId: string) => store.db.prepare("SELECT type FROM session_events WHERE session_id=? ORDER BY sequence").all(sessionId) as { type: string }[];
  const worktreeDevice = application.devices.createBrowserDevice({ scopes: ["session:read", "session:write"] });
  const worktreeLease = application.devices.openLease(worktreeDevice.id, { kind: "direct", generation: 1, protocolVersion: 2, capabilities: [WORKTREE_CAPABILITY], close: () => {} });
  const worktreeActor = { subjectId: worktreeDevice.id, leaseId: worktreeLease.leaseId, transportGeneration: 1, protocolVersion: 2, capabilities: new Set([WORKTREE_CAPABILITY]) };
  return { application, store, root, workspace, owner, management, legacySessionId, catalogContext, createSession, startTurn, drain, turnRow, captures, events,
    worktreeActor, activateWorkspace, parallelPair, entered, adapterCalls, runs, overlapGate, holdRelease, hold: () => holdEntered, overlap: () => overlapProved, excluded: () => excludedInvoked };
}

describe("A11 independent checkout parallelism in activated production main", { timeout: 180_000 }, () => {
  it("overlaps turns across a real managed worktree and the main checkout, excludes a same-checkout session, and isolates durable rows", async () => {
    const f = await fixture();
    // Create the managed worktree through the device-command production entry;
    // the scheduler auto-dispatches the accepted intent after commit.
    const created = await f.application.worktrees.command("worktree.create", { sessionId: f.legacySessionId, repositoryId: "repo-one" }, "a11-create-worktree", f.worktreeActor);
    expect(created.receiptState).toBe("accepted");
    let worktreeState = "";
    for (let attempt = 0; attempt < 300; attempt++) {
      const operation = f.application.worktrees.getOperation({ sessionId: f.legacySessionId, operationId: created.operation.operationId }, f.worktreeActor) as { operation: { state: string; errorCode?: string } };
      worktreeState = operation.operation.state;
      if (["completed", "outcome_unknown", "failed"].includes(worktreeState)) break;
      await delay(100);
    }
    expect(worktreeState).toBe("completed");
    const worktreeRecord = f.application.worktrees.store.require(created.worktree.worktreeId);
    expect(worktreeRecord.path).not.toBe(f.workspace);
    // The managed checkout really materialized the tracked repository state.
    expect(await readFile(join(worktreeRecord.path, "tracked.txt"), "utf8")).toBe("committed\n");
    await f.activateWorkspace(worktreeRecord.workspaceId, "a11-worktree");

    // Two Sessions on two independent checkouts.
    const main = f.legacySessionId, worktreeSession = (await f.createSession("a11-create-worktree-session", worktreeRecord.workspaceId)).session.sessionId;
    const excluded = (await f.createSession("a11-create-excluded-session", "workspace")).session.sessionId;
    f.parallelPair.main = main; f.parallelPair.worktree = worktreeSession;
    await f.management.close();

    // Parallel leg: dispatch both Turns, then await the parked adapter
    // outcomes and drain both workers. Each adapter parks its outcome until
    // both beginTurn seams are live.
    await f.startTurn(main, "a11-turn-main", "a11-parallel-main writes parallel-main.txt");
    await f.startTurn(worktreeSession, "a11-turn-worktree", "a11-parallel-worktree writes parallel-worktree.txt");
    await Promise.all([f.runs.get("main")!, f.runs.get("worktree")!]);
    await f.drain(main);
    await f.drain(worktreeSession);
    expect(f.overlap()).toBe(true);
    expect(f.turnRow(main, "a11-turn-main")?.status).toBe("completed");
    expect(f.turnRow(worktreeSession, "a11-turn-worktree")?.status).toBe("completed");
    // Workspace writes land only in their own checkout.
    expect(await readFile(join(f.workspace, "parallel-main.txt"), "utf8")).toBe("main\n");
    expect(await readFile(join(worktreeRecord.path, "parallel-worktree.txt"), "utf8")).toBe("worktree\n");
    expect(existsSync(join(f.workspace, "parallel-worktree.txt"))).toBe(false);
    expect(existsSync(join(worktreeRecord.path, "parallel-main.txt"))).toBe(false);
    // Durable rows stay per-Session: captures, turn events, no cross-talk.
    expect(f.captures(main).map((row) => row.phase)).toEqual(["before", "after"]);
    expect(f.captures(worktreeSession).map((row) => row.phase)).toEqual(["before", "after"]);
    expect(f.captures(excluded)).toHaveLength(0);
    const TERMINAL_TURN_EVENTS = ["turn.completed", "turn.reconciled"] as const;
    const mainEvents = f.events(main).map((row) => row.type);
    const worktreeEvents = f.events(worktreeSession).map((row) => row.type);
    expect(mainEvents.some((type) => (TERMINAL_TURN_EVENTS as readonly string[]).includes(type))).toBe(true);
    expect(worktreeEvents.some((type) => (TERMINAL_TURN_EVENTS as readonly string[]).includes(type))).toBe(true);
    expect(f.events(excluded).map((row) => row.type)).not.toContain("turn.completed");

    // Mutual exclusion: hold the main checkout's lease with an in-flight Turn,
    // then attempt a same-checkout Turn from another Session.
    const holdDispatch = (async () => { await f.startTurn(main, "a11-turn-hold", "a11-hold holds the main checkout"); })();
    for (let attempt = 0; attempt < 600 && !f.hold(); attempt++) await delay(25);
    expect(f.hold()).toBe(true);
    await f.startTurn(excluded, "a11-turn-excluded", "a11-excluded must never run");
    await f.drain(excluded);
    expect(f.turnRow(excluded, "a11-turn-excluded")?.status).toBe("failed");
    expect(f.adapterCalls.get(excluded)).toBeUndefined();
    expect(f.excluded()).toBe(false);
    expect(f.captures(excluded)).toHaveLength(0);
    // The held Turn is unaffected by the excluded attempt and completes once released.
    f.holdRelease.resolve();
    await f.runs.get("hold")!;
    await holdDispatch;
    await f.drain(main);
    expect(f.turnRow(main, "a11-turn-hold")?.status).toBe("completed");
  });
});
