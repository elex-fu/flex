import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionNativeHandleSchema } from "@flyx/mvp-protocol";
import type { HostCatalog } from "../catalog/host-catalog.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import type { CachedNativeHistoryManifest } from "../provider/native-history-manifest.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import { SessionRegistry } from "../session/session-registry.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { openOwned } from "../storage/open-store.js";
import { rawWorkspaceGitQuery } from "../test-support/managed-git-fixtures.js";
import { HostViews } from "../timeline/host-views.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { WorkspaceLease } from "../workspace/workspace-lease.js";
import { bindingDigest } from "./git-driver.js";
import { NATIVE_REVERT_DRIVER_VERSION } from "./native-revert-drivers.js";
import { createProductionNativeRevert } from "./native-revert-production.js";
import type { NativeRevertProof, RevertOperation } from "./revert-types.js";
import { removeFixture, temporaryRepository } from "./test-support.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const manifest: CachedNativeHistoryManifest = { source: "real-provider", state: "verified", evidenceId: "evidence-1", provider: "codex", providerInstanceId: "provider-1", configurationFingerprint: "fingerprint-1", verifiedVersions: ["fixture-native-v1"] };
const staleManifest: CachedNativeHistoryManifest = { ...manifest, verifiedVersions: ["other-runtime-v9"] };

type FixtureInput = { register?: boolean; verified?: boolean; manifest?: CachedNativeHistoryManifest };

async function fixture(input: FixtureInput = {}) {
  const root = await temporaryRepository(); cleanups.push(() => removeFixture(root));
  const owner = createTestHostOwner(), store = openOwned({ databasePath: ":memory:", owner });
  cleanups.push(() => { store.close(); owner.release(); });
  const catalog = new CatalogStore(store); cleanups.push(() => catalog.dispose());
  const workspaces = new WorkspaceRegistry(catalog, { owner, readOnlyGit: rawWorkspaceGitQuery() });
  await workspaces.registerLocal({ workspaceId: "workspace-1", root });
  const providers = new ProviderInstanceRegistry(catalog);
  if (input.register !== false) {
    providers.registerLocal({ providerInstanceId: "provider-1", provider: "codex", executable: process.execPath });
    if (input.verified) providers.recordVerification("provider-1", { state: "verified", runtimeVersion: "fixture-native-v1", capabilities: ["workspaceWrite"] });
  }
  const runtimeFactory = vi.fn(() => { throw new Error("History must not load a Provider"); });
  const registry = new SessionRegistry(catalog, workspaces, providers, { owner, runtimeFactory });
  const views = new HostViews(store, owner, { resolveResource: (id) => {
    const session = store.getSession(id); if (!session) return undefined;
    return { sessionId: id, workspace: session.workspacePath, source: { get headSequence() { return store.getSession(id)!.headSequence; }, getEvent: (sequence: number) => store.listEvents(id, sequence - 1, 1).events[0], subscribe: (listener) => registry.subscribe(id, listener) }, readSnapshot: () => registry.readSnapshot(id) };
  } }); cleanups.push(() => views.close());
  const production = createProductionNativeRevert({
    store, owner, catalog: { catalog, registry } as Pick<HostCatalog, "catalog" | "registry">, views,
    manifestSource: { verifiedManifestForInstance: vi.fn((provider: string, providerInstanceId: string, sessionId?: string) => (provider === "codex" && providerInstanceId === "provider-1" && sessionId ? input.manifest : undefined)) },
  });
  if (input.register === false) return { root, owner, store, catalog, registry, views, production, manifestSource: undefined as never, session: undefined as never, nativeHandle: undefined as never };
  store.createDevice({ id: "device-1", hostId: "host-1", platform: "test", credentialKind: "browser-session", credentialRevision: 1, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  const seed = (commandId: string) => catalog.create({ authSubjectId: "device-1", commandId }, { workspaceId: "workspace-1", providerInstanceId: "provider-1", title: "Session" }, { workspace: workspaces.require("workspace-1"), provider: providers.require("provider-1") }).summary;
  const session = seed("create-one");
  const second = seed("create-two");
  const nativeHandle = SessionNativeHandleSchema.parse({ v: 1, provider: "codex", providerInstanceId: "provider-1", workspaceId: "workspace-1", nativeSessionId: "private-native-id", provenance: "native" });
  catalog.setNativeHandle(session.sessionId, nativeHandle);
  const lease = WorkspaceLease.acquire({ workspace: root, owner, operationId: "revert-lease" }); cleanups.push(() => lease.release());
  const insertProcess = (id: string, state: string, pid: number | null) => store.db.prepare(
    "INSERT INTO managed_processes (id, owner_id, owner_generation, runtime_id, runtime_generation, attempt_id, session_id, turn_id, pid, process_group, tree_control, state, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'process_group',?,?)",
  ).run(id, owner.ownerId, owner.generation, "runtime-1", 1, "attempt-1", session.sessionId, null, pid, pid, state, new Date().toISOString());
  const checkpointContext = (change: Record<string, unknown> = {}) => ({
    sessionId: session.sessionId, workspaceId: "workspace-1", lease, sessionRevision: store.getSession(session.sessionId)!.revision,
    epoch: views.projector.activeEpoch(session.sessionId)?.epoch ?? "epoch-1", runtimeGeneration: 1, nativeHandle, ...change,
  });
  return { root, owner, store, catalog, registry, views, production, session, second, nativeHandle, lease, insertProcess, checkpointContext };
}

describe("production native revert composition (R6 L1)", { timeout: 20_000 }, () => {
  it("refuses construction without any codex or claude provider record", async () => {
    const f = await fixture({ register: false });
    expect(f.production).toBeUndefined();
  });

  it("advertises no rewind capability without a native handle, verified provider or verified manifest", async () => {
    const unverified = await fixture({ verified: false, manifest });
    expect(await unverified.production!.ports.verifiedNativeCapabilities!(unverified.session.sessionId)).toEqual([]);
    const unmanifested = await fixture({ verified: true });
    expect(await unmanifested.production!.ports.verifiedNativeCapabilities!(unmanifested.session.sessionId)).toEqual([]);
    expect(await unmanifested.production!.ports.verifiedNativeCapabilities!(unmanifested.second.sessionId)).toEqual([]);
    const stale = await fixture({ verified: true, manifest: staleManifest });
    expect(await stale.production!.ports.verifiedNativeCapabilities!(stale.session.sessionId)).toEqual([]);
    expect(unmanifested.production!.ports.verifiedNativeCapabilities).toBeDefined();
  });

  it("derives the rewind capability only from the trusted manifest for the exact session", async () => {
    const f = await fixture({ verified: true, manifest });
    expect(await f.production!.ports.verifiedNativeCapabilities!(f.session.sessionId)).toEqual([
      { kind: "conversation-rewind", evidenceId: "evidence-1", driverVersion: NATIVE_REVERT_DRIVER_VERSION, verifiedVersion: "fixture-native-v1" },
    ]);
  });

  it("proves quiescence on blocked recovery, fail-closed on live producers and missing stop evidence", async () => {
    const f = await fixture({ verified: true, manifest });
    const operation = { sessionId: f.session.sessionId, operationId: "op-1" } as RevertOperation;
    expect((await f.production!.ports.proveQuiescence(operation)).proven).toBe(true);
    // A blocked Session is fenced from new Turns; recovery inspection and
    // rollback evidence must stay available while blocked.
    f.store.db.prepare("UPDATE sessions SET recovery_state='blocked' WHERE id=?").run(f.session.sessionId);
    expect((await f.production!.ports.proveQuiescence(operation)).proven).toBe(true);
    f.store.db.prepare("UPDATE sessions SET recovery_state='idle' WHERE id=?").run(f.session.sessionId);
    f.insertProcess("process-running", "running", 4321);
    expect((await f.production!.ports.proveQuiescence(operation)).proven).toBe(false);
    f.store.db.prepare("UPDATE managed_processes SET state='stopped' WHERE id=?").run("process-running");
    expect((await f.production!.ports.proveQuiescence(operation)).proven).toBe(false);
    f.store.db.prepare("UPDATE managed_processes SET state='not_spawned', pid=NULL WHERE id=?").run("process-running");
    expect((await f.production!.ports.proveQuiescence(operation)).proven).toBe(true);
  });

  it("refuses lease acquisition and dispatch context without a loaded Session runtime", async () => {
    const f = await fixture({ verified: true, manifest });
    await expect(f.production!.ports.acquire({ sessionId: f.session.sessionId, actorId: "device-1", workspaceId: "workspace-1", previousLease: { leaseId: "old", generation: 1 } })).rejects.toThrow("CHECKPOINT_RUNTIME_UNAVAILABLE");
    expect(() => f.production!.ports.dispatchContextFor(f.checkpointContext() as never, "op-2", "attempt-2")).toThrow("CHECKPOINT_RUNTIME_UNAVAILABLE");
    expect(f.registry.loaded(f.session.sessionId)).toBeUndefined();
  });

  it("binds a journal-scoped driver through nativeFactory without a static native port", async () => {
    const f = await fixture({ verified: true, manifest });
    expect(f.production!.ports.native).toBeUndefined();
    const journal = { claim: vi.fn(), get: vi.fn(async () => undefined), record: vi.fn() };
    const driver = f.production!.ports.nativeFactory!(journal as never);
    expect(typeof driver.prepare).toBe("function");
    expect(typeof driver.apply).toBe("function");
    expect(typeof driver.query).toBe("function");
  });

  it("never captures a native anchor without the trusted manifest", async () => {
    const f = await fixture({ verified: true });
    expect(await f.production!.captureNativeAnchor(f.checkpointContext({ turnId: "turn-1", attemptId: "attempt-1" }) as never, "before")).toBeUndefined();
  });

  it("projects the new native binding and Timeline epoch inside the caller's transaction", async () => {
    const f = await fixture({ verified: true, manifest });
    const next = SessionNativeHandleSchema.parse({ v: 1, provider: "codex", providerInstanceId: "provider-1", workspaceId: "workspace-1", nativeSessionId: "private-native-next", provenance: "native" });
    const result = f.store.db.transaction(() => f.production!.ports.projectSuccess(f.store.db, {
      operation: { sessionId: f.session.sessionId, operationId: "op-9" } as RevertOperation,
      epoch: "epoch-next", nativeProof: { nativeHandle: next } as NativeRevertProof, sourceSequence: 1,
    }))();
    expect(result.epoch).toBe("epoch-next");
    expect(result.nativeHandleBinding).toBe(bindingDigest(next));
    expect(f.catalog.allSessions().find((session) => session.sessionId === f.session.sessionId)!.nativeHandle!.nativeSessionId).toBe("private-native-next");
  });
});
