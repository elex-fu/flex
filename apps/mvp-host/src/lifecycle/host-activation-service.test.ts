import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHostOwner, type HostOwnerHandle } from "./host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { CatalogStore, type ProviderInstanceRecord, type WorkspaceRecord } from "../storage/catalog-store.js";
import { createActivationOperationStore } from "../storage/activation-store.js";
import {
  HostActivationLoad, activationReadinessPort, observeLocalWorkspace, observeProvider, providerConfigurationFingerprint,
  type ActivationLoadFacts, type ProviderRuntimeFacts, type SupervisionContractFacts,
} from "./host-activation-load.js";
import { HostActivationService, reconcileObservable, workspaceArgv, type ManagedQueryPort } from "./host-activation-service.js";
import { registerCatalogReadMetadata, invalidateCatalogResourceReadiness } from "../catalog/catalog-read-bootstrap.js";

const processes = vi.hoisted(() => ({
  execFile: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  execFileSync: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  spawn: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  execSync: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
}));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), ...processes }));

const roots: string[] = [];
const cleanups: Array<() => void> = [];
beforeEach(() => { for (const process of Object.values(processes)) process.mockClear(); });
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function noProcesses() { for (const process of Object.values(processes)) expect(process).not.toHaveBeenCalled(); }
function sha256File(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
/** Run a synchronous callback expected to throw and return the thrown value. */
function thrown(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected the call to throw");
}

const SUPERVISION_CONTRACT = "fixture-supervisor.v1";
const PROVIDER_VERSION = "fixture-runtime.v1";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-activation-")));
  roots.push(root);
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const canonicalRoot = realpathSync(checkout);
  const commonDir = join(root, "common.git");
  mkdirSync(commonDir);
  const executable = join(root, "provider-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o700);
  const evidencePath = join(root, "compatibility-evidence.log");
  writeFileSync(evidencePath, "");
  chmodSync(evidencePath, 0o600);
  const owner = createTestHostOwner();
  const store = openOwned({ databasePath: ":memory:", owner });
  const catalog = new CatalogStore(store);
  cleanups.push(() => { catalog.dispose(); store.close(); owner.release(); });
  catalog.putWorkspace({
    workspaceId: "workspace", canonicalRoot, worktreeRoot: canonicalRoot, checkoutKey: "checkout-key-1", kind: "local",
    state: "needs_verification", repositoryId: "repository-1", capabilities: ["streamingText", "workspaceWrite"],
  });
  catalog.putProvider({
    providerInstanceId: "provider", provider: "claude", executable,
    config: { environment: {}, sandboxRequired: true }, policyVersion: 1,
    state: "unconfigured", verification: { state: "unverified", capabilities: [] },
    policyCapabilities: ["streamingText", "workspaceWrite", "interrupt"],
  });
  const operations = createActivationOperationStore(
    { db: store.db, workspace: (id) => catalog.workspace(id), provider: (id) => catalog.provider(id) },
    { guard: () => { owner.assertActive(); owner.assertStorePath(store.db.name); } },
  );
  const runtime = (): ProviderRuntimeFacts => ({ providerVersion: PROVIDER_VERSION, sdkVersion: "fixture-sdk.v1", adapterId: "fixture-adapter", adapterVersion: "1" });
  const supervision = (): SupervisionContractFacts => ({ contractId: SUPERVISION_CONTRACT });
  let now = new Date("2026-10-18T00:00:00.000Z");
  const load = new HostActivationLoad(operations, observation({ supervision, runtime, evidencePath }), { now: () => now });
  function observation(input: { supervision: () => SupervisionContractFacts | undefined; runtime: () => ProviderRuntimeFacts; evidencePath: string }): ActivationLoadFacts {
    return Object.freeze({
      workspace: (record: WorkspaceRecord) => observeLocalWorkspace(record, []),
      provider: (record: ProviderInstanceRecord) => observeProvider(record, {
        compatibilityEvidencePath: input.evidencePath, supervision: input.supervision, runtime: input.runtime,
      }),
    });
  }
  const queries: Array<{ argv: readonly string[]; cwd: string }> = [];
  const managedQuery: ManagedQueryPort = {
    readOnlyGit: vi.fn(async (request) => {
      queries.push({ argv: request.argv, cwd: request.cwd });
      if (request.argv.includes("--show-toplevel")) return { stdout: `${canonicalRoot}\n` };
      return { stdout: `${commonDir}\n` };
    }),
    prepare: async () => ({ ready: true as const }),
    closeAndWait: async () => ({ producerStopped: true, clean: true }),
  };
  function service(overrides: {
    /** `null` simulates Main not wiring a managed executor at all. */
    executorFactory?: (() => Promise<ManagedQueryPort | undefined>) | null;
    supervision?: () => SupervisionContractFacts | undefined;
    runtime?: () => ProviderRuntimeFacts;
    readiness?: () => Readonly<{ ready: boolean }>;
    ttlMs?: number;
    owner?: HostOwnerHandle;
  } = {}) {
    return new HostActivationService({
      facts: { db: store.db, owner: overrides.owner ?? owner, catalog, readiness: overrides.readiness ?? (() => ({ ready: true })) },
      operations,
      load,
      actorId: "local-maintenance",
      observation: observation({ supervision: overrides.supervision ?? supervision, runtime: overrides.runtime ?? runtime, evidencePath }),
      ...(overrides.executorFactory === null ? {} : { executorFactory: overrides.executorFactory ?? (async () => managedQuery) }),
      now: () => now,
      evidenceTtlMs: overrides.ttlMs ?? 24 * 60 * 60 * 1000,
    });
  }
  function writePassedEvidence(overrides: Record<string, unknown> = {}): void {
    const record = catalog.provider("provider")!;
    const artifact = {
      providerVersion: PROVIDER_VERSION,
      executablePath: record.executable,
      executableDigest: sha256File(record.executable),
      configFingerprint: providerConfigurationFingerprint(record),
      supervisionContractId: SUPERVISION_CONTRACT,
      sdkVersion: "fixture-sdk.v1",
      adapterId: "fixture-adapter",
      adapterVersion: "1",
      ...overrides,
    };
    writeFileSync(evidencePath, `${JSON.stringify({
      v: 1, source: "native", runId: "fixture-run-1", provider: "claude", kind: "turn", result: "passed",
      nativeEvent: "turn.completed", evidenceCode: "TURN_COMPLETED", attemptIdHash: "a".repeat(64), artifact, at: "2026-10-17T12:00:00.000Z",
    })}\n`);
    chmodSync(evidencePath, 0o600);
  }
  const configuration = { workspaces: [{ workspaceId: "workspace", root: canonicalRoot }], providerInstances: [{ providerInstanceId: "provider", provider: "claude" as const, executable, policyCapabilities: ["streamingText", "workspaceWrite", "interrupt"] }] };
  const readinessScan = () => ({ workspaces: catalog.workspaces(), providers: catalog.providers() });
  return {
    root, checkout, canonicalRoot, commonDir, executable, evidencePath, owner, store, catalog, operations, load, managedQuery, queries,
    service, writePassedEvidence, configuration, readinessScan,
    setNow: (value: string) => { now = new Date(value); },
  };
}

describe("HostActivationService explicit activation", () => {
  it("verifies and activates one binding through managed facts only, then gates writes and projects readiness", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-one" });
    expect(verified.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.validUntil).toBe("2026-10-19T00:00:00.000Z");
    expect(f.operations.operation(verified.operationId)?.state).toBe("ready");
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    // Exactly the two controlled query shapes, both through the managed port.
    expect(f.queries.map((query) => query.argv)).toEqual([
      [...workspaceArgv(f.canonicalRoot, "toplevel")],
      [...workspaceArgv(f.canonicalRoot, "common_dir")],
    ]);
    const activated = service.activate({ evidenceId: verified.evidenceId, commandId: "activate-one" });
    expect(activated.reused).toBe(false);
    expect(activated.activations.map((target) => `${target.kind}:${target.id}`)).toEqual(["workspace:workspace", "provider:provider"]);
    expect(f.catalog.workspace("workspace")?.state).toBe("active");
    expect(f.catalog.provider("provider")).toMatchObject({ state: "configured", verification: { state: "verified", runtimeVersion: PROVIDER_VERSION, capabilities: ["interrupt", "streamingText", "workspaceWrite"] } });
    expect(f.operations.operation(verified.evidenceId)?.state).toBe("completed");
    expect(f.operations.operation(activated.operationId)?.result?.activations.map((target) => target.kind)).toEqual(["workspace", "provider"]);
    const workspaceRow = f.store.db.prepare("SELECT activation_binding_digest,readiness_revision FROM workspaces WHERE id='workspace'").get() as { activation_binding_digest: string; readiness_revision: number };
    expect(workspaceRow.activation_binding_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(workspaceRow.readiness_revision).toBe(1);
    expect(service.resourceReadiness("workspace", "workspace")).toMatchObject({ state: "valid", ready: true, evidenceId: verified.evidenceId });
    service.assertReadyForWrite({ workspaceId: "workspace", providerInstanceId: "provider" });
    expect(service.readiness().every((verdict) => verdict.ready)).toBe(true);
    // Repeated activate with the original command returns the stored receipt; a new
    // command on consumed evidence reports the recorded activations without a write.
    const repeated = service.activate({ evidenceId: verified.evidenceId, commandId: "activate-one" });
    expect(repeated).toMatchObject({ operationId: activated.operationId, reused: true });
    const replayed = service.activate({ evidenceId: verified.evidenceId, commandId: "activate-two" });
    expect(replayed).toMatchObject({ operationId: verified.evidenceId, reused: true });
    expect(replayed.activations).toHaveLength(2);
    expect(f.operations.operationForCommand("local-maintenance", "activate-two")).toBeUndefined();
    expect(f.queries).toHaveLength(2);
    noProcesses();
  }, 20000);

  it("refuses verify without a managed executor and persists the concrete blocking reason", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service({ executorFactory: async () => undefined });
    await expect(service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-no-executor" }))
      .rejects.toMatchObject({ code: "WORKSPACE_QUERY_EXECUTOR_UNAVAILABLE", reasonCodes: ["WORKSPACE_QUERY_EXECUTOR_UNAVAILABLE"] });
    expect(f.operations.operationForCommand("local-maintenance", "verify-no-executor"))
      .toMatchObject({ state: "rejected", result: { reasonCodes: ["WORKSPACE_QUERY_EXECUTOR_UNAVAILABLE"] } });
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    expect(f.catalog.provider("provider")?.state).toBe("unconfigured");
    noProcesses();
  }, 20000);

  it("refuses a missing supervision contract, an unusable port, a missing executor factory and missing evidence as typed reasons", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const missingSupervision = f.service({ supervision: () => undefined });
    await expect(missingSupervision.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-supervision" }))
      .rejects.toMatchObject({ code: "SUPERVISION_CONTRACT_UNAVAILABLE" });
    const brokenPort = f.service({ executorFactory: async () => ({ ...f.managedQuery, prepare: async () => ({ ready: false as const, code: "WORKSPACE_QUERY_PROCESS_BIRTH_UNAVAILABLE" }) }) });
    await expect(brokenPort.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-port" }))
      .rejects.toMatchObject({ code: "WORKSPACE_QUERY_UNVERIFIED" });
    const missingFactory = f.service({ executorFactory: null });
    await expect(missingFactory.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-factory" }))
      .rejects.toMatchObject({ code: "WORKSPACE_QUERY_EXECUTOR_UNAVAILABLE" });
    rmSync(f.evidencePath);
    const missingEvidence = f.service();
    await expect(missingEvidence.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-evidence" }))
      .rejects.toMatchObject({ code: "PROVIDER_COMPATIBILITY_EVIDENCE_MISSING" });
    expect(f.operations.operationForCommand("local-maintenance", "verify-evidence")).toMatchObject({ state: "rejected" });
    noProcesses();
  }, 20000);

  it("refuses an unresolved retained recovery scope before any measurement", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const retained = Object.freeze({ ...f.owner, recoveryOnly: true }) as HostOwnerHandle;
    const service = f.service({ owner: retained });
    await expect(service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-retained" }))
      .rejects.toMatchObject({ code: "ACTIVATION_OWNER_INVALID" });
    expect(f.queries).toHaveLength(0);
    noProcesses();
  }, 20000);

  it("withdraws readiness on the next write gate after the executable digest changes (A2)", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-a2" });
    service.activate({ evidenceId: verified.evidenceId, commandId: "activate-a2" });
    writeFileSync(f.executable, "#!/bin/sh\nexit 1\n");
    chmodSync(f.executable, 0o700);
    const verdict = service.resourceReadiness("provider", "provider");
    expect(verdict).toMatchObject({ state: "invalid", ready: false });
    expect(verdict?.reasonCodes).toContain("PROVIDER_EXECUTABLE_CHANGED");
    const refusal = thrown(() => service.assertReadyForWrite({ workspaceId: "workspace", providerInstanceId: "provider" }));
    expect(refusal).toMatchObject({ code: "PROVIDER_EXECUTABLE_CHANGED" });
    expect((refusal as { reasonCodes: readonly string[] }).reasonCodes).toContain("PROVIDER_EXECUTABLE_CHANGED");
    // The withdrawal is persisted in one step: state reset, reference cleared, revision bumped.
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    expect(f.catalog.provider("provider")).toMatchObject({ state: "unconfigured", verification: { state: "unverified" } });
    const row = f.store.db.prepare("SELECT activation_operation_id,activation_binding_digest,readiness_revision FROM provider_instances WHERE id='provider'").get() as { activation_operation_id: string | null; activation_binding_digest: string | null; readiness_revision: number };
    expect(row).toEqual({ activation_operation_id: null, activation_binding_digest: null, readiness_revision: 2 });
    // The completed receipt keeps its activation record and gains the invalidation reasons.
    const receipt = f.operations.operation(verified.evidenceId)!;
    expect(receipt.state).toBe("completed");
    expect(receipt.result?.reasonCodes).toContain("PROVIDER_EXECUTABLE_CHANGED");
    expect(receipt.result?.activations).toHaveLength(2);
    noProcesses();
  }, 20000);

  it("withdraws readiness when the checkout directory identity changes (A2)", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-identity" });
    service.activate({ evidenceId: verified.evidenceId, commandId: "activate-identity" });
    rmSync(f.checkout, { recursive: true, force: true });
    mkdirSync(f.checkout);
    const verdict = service.resourceReadiness("workspace", "workspace");
    expect(verdict?.reasonCodes).toContain("WORKSPACE_IDENTITY_CHANGED");
    expect(() => service.assertReadyForWrite({ workspaceId: "workspace", providerInstanceId: "provider" })).toThrow();
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    noProcesses();
  }, 20000);

  it("rejects activate when a readiness revision moved after verify, without writing resources (A6)", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-cas" });
    // An invalidation between verify and activate bumps the workspace revision.
    f.operations.withdrawReadiness("workspace", "workspace", { at: "2026-10-18T00:30:00.000Z", reasonCodes: ["WORKSPACE_NOT_ACTIVATED"] });
    const refusal = thrown(() => service.activate({ evidenceId: verified.evidenceId, commandId: "activate-cas" }));
    expect(refusal).toMatchObject({ code: "ACTIVATION_SOURCE_BINDING_CHANGED", reasonCodes: ["ACTIVATION_SOURCE_BINDING_CHANGED"] });
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    expect(f.catalog.provider("provider")?.state).toBe("unconfigured");
    expect(f.operations.operationForCommand("local-maintenance", "activate-cas")).toMatchObject({ state: "rejected" });
    // The evidence receipt is untouched: it was never consumed.
    expect(f.operations.operation(verified.evidenceId)?.state).toBe("ready");
    noProcesses();
  }, 20000);

  it("rejects activate when the recorded evidence expired (A6)", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service({ ttlMs: 1000 });
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-expiry" });
    f.setNow("2026-10-18T00:00:05.000Z");
    const refusal = thrown(() => service.activate({ evidenceId: verified.evidenceId, commandId: "activate-expiry" }));
    expect(refusal).toMatchObject({ code: "ACTIVATION_EVIDENCE_EXPIRED", reasonCodes: ["ACTIVATION_EVIDENCE_EXPIRED"] });
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    noProcesses();
  }, 20000);

  it("rejects activate when the provider configuration changed after verify", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-config" });
    f.store.db.prepare("UPDATE provider_instances SET config_json=? WHERE id='provider'").run(JSON.stringify({ model: "changed-model", environment: {}, sandboxRequired: true }));
    const refusal = thrown(() => service.activate({ evidenceId: verified.evidenceId, commandId: "activate-config" }));
    expect(refusal).toMatchObject({ code: "PROVIDER_CONFIG_CHANGED", reasonCodes: ["PROVIDER_CONFIG_CHANGED"] });
    noProcesses();
  }, 20000);
});

describe("catalog bootstrap readiness port", () => {
  it("keeps a valid activation across restart and withdraws only the changed resource", async () => {
    const f = fixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-bootstrap" });
    service.activate({ evidenceId: verified.evidenceId, commandId: "activate-bootstrap" });
    const revisionQuery = "SELECT (SELECT readiness_revision FROM workspaces WHERE id='workspace') AS workspace,(SELECT readiness_revision FROM provider_instances WHERE id='provider') AS provider";
    const revisions = f.store.db.prepare(revisionQuery).get() as { workspace: number; provider: number };
    const bootstrap = () => registerCatalogReadMetadata(f.catalog, f.owner, f.configuration, {
      readiness: activationReadinessPort(f.load, f.readinessScan),
    });
    bootstrap();
    expect(f.catalog.workspace("workspace")?.state).toBe("active");
    expect(f.catalog.provider("provider")?.state).toBe("configured");
    expect(f.store.db.prepare(revisionQuery).get()).toEqual(revisions);
    // Only the changed resource is withdrawn on the next restart.
    writeFileSync(f.executable, "#!/bin/sh\nexit 1\n");
    chmodSync(f.executable, 0o700);
    bootstrap();
    expect(f.catalog.workspace("workspace")?.state).toBe("active");
    expect(f.catalog.provider("provider")?.state).toBe("unconfigured");
    // The legacy path stays unconditional and also clears the activation reference.
    invalidateCatalogResourceReadiness(f.catalog, f.owner);
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    const row = f.store.db.prepare("SELECT activation_operation_id,activation_binding_digest,readiness_revision FROM workspaces WHERE id='workspace'").get() as { activation_operation_id: string | null; activation_binding_digest: string | null; readiness_revision: number };
    expect(row.activation_operation_id).toBeNull();
    expect(row.activation_binding_digest).toBeNull();
    expect(row.readiness_revision).toBe(revisions.workspace + 1);
    noProcesses();
  }, 20000);
});

describe("reconcileObservable", () => {
  it("reports every locally observable difference with stable codes", () => {
    const payload = {
      v: 1 as const, kind: "activation" as const, observedAt: "2026-10-18T00:00:00.000Z", validUntil: "2026-10-19T00:00:00.000Z",
      resourceRevisions: { workspace: 0, provider: 0 },
      workspace: { canonicalRoot: "/a", worktreeRoot: "/a", checkoutKey: "k", repositoryId: "r", canonicalIdentity: "i", worktreeIdentity: "i", gitCommonDir: "/a/.git", commonDirIdentity: "c" },
      provider: { providerInstanceId: "p", provider: "claude" as const, executablePath: "/e", executableDigest: "d", configFingerprint: "c", policyFingerprint: "p", runtimeVersion: "v", runtimeArtifactDigest: "a", capabilities: ["b", "a"] },
    };
    const current = {
      workspace: { canonicalRoot: "/a", worktreeRoot: "/a", checkoutKey: "k", repositoryId: "r", canonicalIdentity: "i", worktreeIdentity: "i" },
      provider: { providerInstanceId: "p", provider: "claude" as const, executablePath: "/e", executableDigest: "d", configFingerprint: "c", policyFingerprint: "p", runtimeVersion: "v", runtimeArtifactDigest: "a", capabilities: ["a", "b"] },
    };
    expect(reconcileObservable(payload, current, new Date("2026-10-18T01:00:00.000Z"))).toEqual([]);
    expect(reconcileObservable(payload, current, new Date("2026-10-19T00:00:00.000Z"))).toEqual(["ACTIVATION_EVIDENCE_EXPIRED"]);
    expect(reconcileObservable(payload, { ...current, provider: { ...current.provider, executableDigest: "x" } }, new Date("2026-10-18T01:00:00.000Z"))).toEqual(["PROVIDER_EXECUTABLE_CHANGED"]);
  });
});
