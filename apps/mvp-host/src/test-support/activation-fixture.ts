import { generateHostIdentity } from "../identity/host-identity.js";
import { signCompatibilityPayload } from "../diagnostics/compatibility-integrity.js";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { CatalogStore, type ProviderInstanceRecord, type WorkspaceRecord } from "../storage/catalog-store.js";
import { createActivationOperationStore, type ActivationOperationStore } from "../storage/activation-store.js";
import {
  HostActivationLoad, observeLocalWorkspace, observeProvider, providerConfigurationFingerprint,
  type ActivationLoadFacts, type ProviderRuntimeFacts, type SupervisionContractFacts,
} from "../lifecycle/host-activation-load.js";
import { HostActivationService, type ManagedQueryPort } from "../lifecycle/host-activation-service.js";

/**
 * Deterministic in-memory activation fixture shared by the C3 test files. It
 * creates a real migrated Store, catalog rows, one 0700 executable, one empty
 * compatibility-evidence log and a fake managed query port whose two controlled
 * `rev-parse` shapes answer from temp directories. No test here launches Git, a
 * Provider or a helper; filesystem facts are real so executable/identity
 * changes are observable.
 */

export const ACTIVATION_FIXTURE_ACTOR = "local-maintenance";
export const ACTIVATION_FIXTURE_SUPERVISION = "fixture-supervisor.v1";
export const ACTIVATION_FIXTURE_PROVIDER_VERSION = "fixture-runtime.v1";
export const ACTIVATION_FIXTURE_NOW = "2026-10-18T00:00:00.000Z";
export const ACTIVATION_FIXTURE_VALID_UNTIL = "2026-10-19T00:00:00.000Z";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

/** Close handles, then remove temp roots; safe to call from every `afterEach`. */
export function disposeActivationFixtures(): void {
  for (const close of cleanups.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function sha256File(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

/** Run a synchronous callback expected to throw and return the thrown value. */
export function captureError(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected the call to throw");
}

export function createActivationFixture() {
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
  const operations: ActivationOperationStore = createActivationOperationStore(
    { db: store.db, workspace: (id) => catalog.workspace(id), provider: (id) => catalog.provider(id) },
    { guard: () => { owner.assertActive(); owner.assertStorePath(store.db.name); } },
  );
  const runtime = (): ProviderRuntimeFacts => ({ providerVersion: ACTIVATION_FIXTURE_PROVIDER_VERSION, sdkVersion: "fixture-sdk.v1", adapterId: "fixture-adapter", adapterVersion: "1" });
  const supervision = (): SupervisionContractFacts => ({ contractId: ACTIVATION_FIXTURE_SUPERVISION });
  let now = new Date(ACTIVATION_FIXTURE_NOW);
  function observation(input: { supervision: () => SupervisionContractFacts | undefined; runtime: () => ProviderRuntimeFacts | undefined; evidencePath: string }): ActivationLoadFacts {
    return Object.freeze({
      workspace: (record: WorkspaceRecord) => observeLocalWorkspace(record, []),
      provider: (record: ProviderInstanceRecord) => observeProvider(record, {
        compatibilityEvidencePath: input.evidencePath, supervision: input.supervision, runtime: input.runtime, compatibilityTrust: {domain:"fixture",now:now.getTime()},
      }),
    });
  }
  const load = new HostActivationLoad(operations, observation({ supervision, runtime, evidencePath }), { now: () => now });
  const queries: Array<{ argv: readonly string[]; cwd: string }> = [];
  const managedQuery: ManagedQueryPort = {
    readOnlyGit: async (request) => {
      queries.push({ argv: request.argv, cwd: request.cwd });
      if (request.argv.includes("--show-toplevel")) return { stdout: `${canonicalRoot}\n` };
      return { stdout: `${commonDir}\n` };
    },
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
      actorId: ACTIVATION_FIXTURE_ACTOR,
      observation: observation({ supervision: overrides.supervision ?? supervision, runtime: overrides.runtime ?? runtime, evidencePath }),
      ...(overrides.executorFactory === null ? {} : { executorFactory: overrides.executorFactory ?? (async () => managedQuery) }),
      now: () => now,
      evidenceTtlMs: overrides.ttlMs ?? 24 * 60 * 60 * 1000,
    });
  }
  function writePassedEvidence(overrides: Record<string, unknown> = {}): void {
    writeFileSync(evidencePath, signedActivationFixtureEvidence(catalog.provider("provider")!, now.toISOString(), overrides).map((record)=>JSON.stringify(record)).join("\n")+"\n");
    chmodSync(evidencePath, 0o600);
  }
  const configuration = { workspaces: [{ workspaceId: "workspace", root: canonicalRoot }], providerInstances: [{ providerInstanceId: "provider", provider: "claude" as const, executable, policyCapabilities: ["streamingText", "workspaceWrite", "interrupt"] }] };
  const readinessScan = () => ({ workspaces: catalog.workspaces(), providers: catalog.providers() });
  return {
    root, checkout, canonicalRoot, commonDir, executable, evidencePath, owner, store, catalog, operations, load, managedQuery, queries,
    observation, supervision, runtime, service, writePassedEvidence, configuration, readinessScan,
    setNow: (value: string) => { now = new Date(value); },
  };
}

export type ActivationFixture = ReturnType<typeof createActivationFixture>;

/** Explicit signed test domain; production trust never accepts these records. */
export function signedActivationFixtureEvidence(record: ProviderInstanceRecord, at: string, overrides: Record<string,unknown> = {}): readonly Record<string,unknown>[] {
  const identity=generateHostIdentity();
  const artifact={ providerVersion:ACTIVATION_FIXTURE_PROVIDER_VERSION,executablePath:record.executable,executableDigest:sha256File(record.executable),
    configFingerprint:providerConfigurationFingerprint(record),supervisionContractId:ACTIVATION_FIXTURE_SUPERVISION,sdkVersion:"fixture-sdk.v1",adapterId:"fixture-adapter",adapterVersion:"1",
    runtimeVersion:"fixture-host.v1",runtimeDigest:"b".repeat(64),nodeVersion:process.version,os:process.platform,...overrides };
  return (["turn","interrupt"] as const).map((kind)=>signCompatibilityPayload({v:2,source:"native",domain:"fixture",runId:"fixture-run-1",provider:record.provider,
    kind,capability:kind,result:"passed",nativeEvent:kind==="turn"?"turn.completed":"turn.interrupted",evidenceCode:kind==="turn"?"TURN_COMPLETED":"TURN_INTERRUPTED",
    attemptIdHash:"a".repeat(64),artifact,at,sceneVersion:"flyx-c3-basic-v1",entryDigest:"c".repeat(64),launchRef:"fixture-launch",
    nativeSessionIdHash:"d".repeat(64),...(record.provider==="claude"?{nativeResultIdHash:"e".repeat(64)}:{nativeTurnIdHash:"e".repeat(64)}),
    ...(kind==="interrupt"?{stopRef:"fixture-stop"}:{})},identity));
}
