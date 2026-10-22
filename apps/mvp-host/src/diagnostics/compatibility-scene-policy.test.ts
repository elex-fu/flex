import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateHostIdentity, loadOrCreateHostIdentity, publicHostIdentity, getHostIdentityMirror } from "../identity/host-identity.js";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn } from "../orchestration/decider.js";
import type { CommandPlan, CommandRequest } from "../orchestration/command-contract.js";
import { openOwned } from "../storage/open-store.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { authorizeCompatibilityRun } from "./compatibility-import.js";
import { compatibilityEvidenceArtifactDigest, type CompatibilityEvidenceArtifact } from "./compatibility-evidence.js";
import { COMPATIBILITY_BASIC_PROMPT } from "./compatibility-readiness.js";
import { createCompatibilityScenePolicy, createCompatibilityVersionProbeAuthority, compatibilitySceneCommandIds, type CompatibilityScenePermit } from "./compatibility-scene-policy.js";
const cleanup: Array<() => Promise<void>> = []; const originalArgv = [...process.argv];
afterEach(async () => { vi.unstubAllEnvs(); process.argv = [...originalArgv]; for (const close of cleanup.splice(0).reverse()) await close(); });
const rawHash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-scene-policy-"))); await chmod(root, 0o700);
  const workspace = join(root, "workspace"), identityDirectory = join(root, "identity"), dist = join(root, "dist"), entryPath = join(dist, "main.js"), executable = join(root, "provider-cli");
  await mkdir(workspace); await mkdir(join(workspace, ".git")); await mkdir(dist);
  await writeFile(entryPath, "// structural fixture; never launched\n"); await writeFile(executable, "#!/bin/sh\nexit 70\n"); await chmod(executable, 0o700);
  const owner = HostOwnerLock.acquire({ databasePath: join(root, "host.sqlite"), identityDirectory, coordinationDirectory: join(root, "owners") });
  const store = openOwned({ databasePath: owner.databasePath, owner });
  cleanup.push(async () => { store.close(); owner.release(); await rm(root, { recursive: true, force: true }); });
  const identity = await loadOrCreateHostIdentity({ directory: identityDirectory }); store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const destination = generateHostIdentity(); const session = store.createSession(workspace, "codex");
  store.createDevice({ id: "actor", hostId: identity.hostId, platform: "test", scopes: ["session:read", "session:write"], credentialKind: "browser-session", credentialRevision: 1, createdAt: new Date().toISOString() });
  const artifact = { providerVersion: "fixture-v1", executablePath: executable, executableDigest: rawHash("#!/bin/sh\nexit 70\n"), configFingerprint: "b".repeat(64),
    adapterId: "codex-app-server", adapterVersion: "fixture", supervisionContractId: "fixture-no-native-launch", runtimeVersion: "fixture", runtimeDigest: "c".repeat(64), nodeVersion: process.versions.node, os: process.platform + " " + release() + " " + arch() };
  const runId = "fixture-run"; let now = Date.now();
  const authorization = authorizeCompatibilityRun(destination, { provider: "codex", artifactDigest: compatibilityEvidenceArtifactDigest({ ...artifact, provider: "codex" } as CompatibilityEvidenceArtifact), runtimeDigest: artifact.runtimeDigest,
    runId, sourceHost: publicHostIdentity(identity), entryDigest: rawHash("// structural fixture; never launched\n"), now });
  for (const [key, value] of Object.entries({ FLYX_TEST_CONTROLLED_ENTRY: "1", FLYX_COMPATIBILITY_MODE: "isolated", FLYX_COMPATIBILITY_REAL_ENABLED: "1", RUN_REAL_CODEX: "1", FLYX_COMPATIBILITY_RUN_ID: runId, FLYX_COMPATIBILITY_ROOT: root, FLYX_COMPATIBILITY_ENTRY_DIGEST: authorization.entryDigest })) vi.stubEnv(key, value);
  process.argv[1] = entryPath;
  const binding = { sessionId: session.id, workspaceId: session.workspaceId, canonicalRoot: workspace, checkoutRoot: workspace, providerInstanceId: "provider", provider: "codex" as const, configurationFingerprint: artifact.configFingerprint };
  let baseline = true;
  const options = { authorization, expectedDestination: publicHostIdentity(destination), entry: { path: join(root, "ready.json"), baseUrl: "http://127.0.0.1:1234", pairingToken: "x".repeat(32), provider: "codex" as const, identity, runId, entryPath, databasePath: owner.databasePath, identityDirectory, workspace, artifact, authMode: "unknown" as const },
    store, owner, currentBinding: () => binding, measureArtifact: () => artifact, assertBaseline: () => { if (!baseline) throw new Error("NATIVE_BOUNDARY_UNAVAILABLE"); }, now: () => now };
  const policy = await createCompatibilityScenePolicy(options);
  const ids = compatibilitySceneCommandIds(runId);
  const request = (index = 0): CommandRequest => ({ authSubjectId: "actor", commandId: ids[index]!, method: "session.startTurn", requestHash: hashCommandRequest("session.startTurn", { prompt: COMPATIBILITY_BASIC_PROMPT }), targetSessionId: session.id,
    requestFormatVersion: 2, actorKind: "device", dispatchBinding: { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, runtimeId: "runtime" } });
  const permit = (index = 0) => { const req = request(index); return policy.authorizeStart({ actorId: req.authSubjectId, commandId: req.commandId, method: req.method, prompt: COMPATIBILITY_BASIC_PROMPT, requestHash: req.requestHash, sessionId: session.id }); };
  const engine = new CommandEngine(store);
  const accept = (index = 0, change?: (plan: CommandPlan<{ turnId: string; status: "accepted" }>) => void) => {
    const req = request(index), allowed = permit(index);
    return engine.commitRequest(req, (facts, clock) => { const plan = decideAcceptTurn(facts, req, { prompt: COMPATIBILITY_BASIC_PROMPT }, clock); change?.(plan); policy.assertAcceptInCommit(allowed, { request: req, plan }); return plan; });
  };
  return { root, store, owner, identity, session, artifact, options, policy, binding, ids, request, permit, accept, entryPath, executable, setBaseline: (value: boolean) => { baseline = value; }, expire: () => { now += 3_600_001; } };
}
describe("opaque isolated first-scene policy", () => {
  it("separates signed candidate --version preparation from model scene authority", async () => {
    const f = await fixture(); let baseline = true;
    const authority = await createCompatibilityVersionProbeAuthority({ ...f.options, measureCandidateArtifact: () => f.artifact, assertBaseline: () => { if (!baseline) throw new Error("C0_UNAVAILABLE"); } });
    const query = { provider: "codex" as const, executable: { path: f.executable, digest: f.artifact.executableDigest }, configFingerprint: f.artifact.configFingerprint, runtimeDigest: f.artifact.runtimeDigest, operation: "--version" as const };
    expect(() => authority.assertAuthorized(query)).not.toThrow();
    expect("authorizeStart" in authority).toBe(false);
    expect(() => authority.assertAuthorized({ ...query, executable: { ...query.executable, path: "/another/provider" } })).toThrow("COMPATIBILITY_VERSION_PROBE_REJECTED");
    baseline = false; expect(() => authority.assertAuthorized(query)).toThrow("C0_UNAVAILABLE");
    expect(f.store.db.prepare("SELECT 1 FROM execution_intents").get()).toBeUndefined();
  });
  it("uses an exact deterministic ten-command manifest and refuses arbitrary prompts or opaque permit forgery", async () => {
    const f = await fixture(); expect(f.ids).toHaveLength(10); expect(new Set(f.ids).size).toBe(10);
    expect(f.policy.commandIds).toEqual(f.ids);
    expect(() => f.policy.authorizeStart({ actorId: "actor", commandId: f.ids[0]!, method: "session.startTurn", prompt: "write a file", requestHash: "a".repeat(64), sessionId: f.session.id })).toThrow("COMPATIBILITY_SCENE_REQUEST_REJECTED");
    expect(() => f.policy.assertResource({ kind: "compatibility-scene-start" } as CompatibilityScenePermit, f.binding)).toThrow("COMPATIBILITY_SCENE_PERMIT_INVALID");
  });
  it("reserves through the normal Engine receipt and intent transaction and rolls back invalid plans", async () => {
    const f = await fixture(); const allowed = f.permit();
    expect(() => f.policy.assertAcceptInCommit(allowed, { request: f.request(), plan: { result: {} } })).toThrow("COMPATIBILITY_SCENE_TRANSACTION_REQUIRED");
    expect(() => f.accept(0, (plan) => { (plan.intents![0]!.payload as { prompt: string }).prompt = "arbitrary"; })).toThrow("COMPATIBILITY_SCENE_PLAN_REJECTED");
    expect(f.store.getCommandReceipt("actor", f.ids[0]!)).toBeUndefined();
    const accepted = f.accept(); expect(accepted.result).toMatchObject({ status: "accepted" });
    expect(f.store.getCommandReceipt("actor", f.ids[0]!)).toMatchObject({ state: "accepted" });
    expect(new ExecutionStore(f.store).forCommand("actor", f.ids[0]!)).toHaveLength(1);
  });
  it("rechecks exact saved attempt and marker at preclaim, marker and spawn without replaying unknown", async () => {
    const f = await fixture(); f.accept(); const execution = new ExecutionStore(f.store); let intent = execution.forCommand("actor", f.ids[0]!)[0]!;
    expect(() => f.policy.assertDispatch({ intent, context: intent.dispatchContext!, phase: "before_claim" })).not.toThrow();
    expect(() => f.policy.assertDispatch({ intent, context: intent.dispatchContext! })).toThrow("COMPATIBILITY_SCENE_DISPATCH_REJECTED");
    f.store.db.prepare("UPDATE execution_intents SET state='claimed',claim_owner_id=?,claim_owner_generation=? WHERE id=?").run(f.owner.ownerId, f.owner.generation, intent.id); intent = execution.get(intent.id)!;
    expect(() => f.policy.assertDispatch({ intent, context: intent.dispatchContext!, phase: "before_marker" })).not.toThrow();
    f.store.db.prepare("UPDATE execution_intents SET state='dispatching' WHERE id=?").run(intent.id); intent = execution.get(intent.id)!;
    expect(() => f.policy.assertDispatch({ intent, context: intent.dispatchContext! })).not.toThrow();
    expect(() => f.policy.assertDispatch({ intent, context: { ...intent.dispatchContext!, attemptId: "other-attempt" } })).toThrow("COMPATIBILITY_SCENE_DISPATCH_REJECTED");
    f.store.db.prepare("UPDATE execution_intents SET state='outcome_unknown' WHERE id=?").run(intent.id); intent = execution.get(intent.id)!;
    expect(() => f.policy.assertDispatch({ intent, context: intent.dispatchContext! })).toThrow("COMPATIBILITY_SCENE_DISPATCH_REJECTED");
  });
  it("preserves baseline, restore, recovery and current device gates after issuing a permit", async () => {
    const f = await fixture(); const allowed = f.permit(); f.setBaseline(false);
    expect(() => f.policy.assertResource(allowed, f.binding)).toThrow("NATIVE_BOUNDARY_UNAVAILABLE"); f.setBaseline(true);
    f.store.db.prepare("UPDATE sessions SET recovery_state='blocked' WHERE id=?").run(f.session.id);
    expect(() => f.policy.assertResource(allowed, f.binding)).toThrow("COMPATIBILITY_SCENE_SESSION_UNAVAILABLE");
    f.store.db.prepare("UPDATE sessions SET recovery_state='idle' WHERE id=?").run(f.session.id);
    f.store.db.prepare("UPDATE devices SET revoked_at='2026-01-01T00:00:00Z' WHERE id='actor'").run();
    expect(() => f.policy.assertResource(allowed, f.binding)).toThrow("COMPATIBILITY_SCENE_DEVICE_REJECTED");
  });
  it("rejects destination self-trust, changed build/artifact, expiry and command order", async () => {
    const f = await fixture();
    await expect(createCompatibilityScenePolicy({ ...f.options, expectedDestination: publicHostIdentity(generateHostIdentity()) })).rejects.toThrow("COMPATIBILITY_AUTHORIZATION_INVALID");
    expect(() => f.accept(1)).toThrow("COMPATIBILITY_SCENE_COMMAND_ORDER_INVALID");
    const allowed = f.permit(); f.artifact.runtimeDigest = "d".repeat(64);
    expect(() => f.policy.assertResource(allowed, f.binding)).toThrow("COMPATIBILITY_SCENE_ARTIFACT_CHANGED"); f.artifact.runtimeDigest = "c".repeat(64);
    await writeFile(f.entryPath, "// changed build"); expect(() => f.policy.assertResource(allowed, f.binding)).toThrow("COMPATIBILITY_BUILD_MISMATCH");
    await writeFile(f.entryPath, "// structural fixture; never launched\n"); f.expire(); expect(() => f.policy.assertResource(allowed, f.binding)).toThrow("COMPATIBILITY_AUTHORIZATION_INVALID");
  });
});
