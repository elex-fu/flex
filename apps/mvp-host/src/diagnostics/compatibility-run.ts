import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { assertHostOwner } from "../lifecycle/host-owner.js";
import { assertRestoreWriteReady } from "../operations/restore-service.js";
import { OperationsError } from "../operations/operation-files.js";
import { providerConfigurationFingerprint } from "../lifecycle/host-activation-load.js";
import type { NativeBoundaryProof } from "../lifecycle/native-boundary-proof.js";
import { nativeStopContractId } from "../lifecycle/managed-stop-contract.js";
import { HostManagedRuntime } from "../provider/native-runtime-factory.js";
import { ManagedRuntimeController, type PreparedNativeRuntime } from "../provider/managed-runtime.js";
import type { DispatchContext } from "../provider/types.js";
import type { ProviderInstanceRecord, ProviderConfiguration } from "../storage/catalog-store.js";
import type { SqliteStore } from "../storage/db.js";
import type { HostIdentityFileV1 } from "../identity/host-identity.js";
import type { CommittedNativeStopRecorder } from "../session/orchestrator.js";
import type { NativeHistorySceneBootstrap } from "../provider/native-history-manifest.js";
import type { CompatibilityHostIdentity } from "./compatibility-integrity.js";
import type { CompatibilityRunAuthorization } from "./compatibility-import.js";
import type { CompatibilityReadinessOptions } from "./compatibility-readiness.js";
import { createCompatibilityCommittedRecorder, createCompatibilityRuntimeFacts, installedProviderRuntimeFacts } from "./compatibility-runtime-facts.js";
import { createCompatibilityVersionProbeAuthority, type CompatibilitySceneBinding, type CompatibilityScenePolicy, type CompatibilityVersionProbeAuthority } from "./compatibility-scene-policy.js";
import { assertCompleteCompatibilityArtifact, type NativeCompatibilityArtifact } from "./compatibility-evidence.js";
import { measureRuntimeFile, measuredHostBuildDigest } from "./planned-native-artifact.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (code: string): never => { throw new OperationsError(code); };
function hostPackageVersion(): string {
  const value = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value.version)) return fail("COMPATIBILITY_INSTALLED_METADATA_UNAVAILABLE");
  return value.version;
}

/**
 * The candidate artifact is fully measured except its providerVersion, which is
 * the expected (signed) version the destination ticket binds. It is never an
 * observed version: only the later managed `--version` probe observes one, and
 * every later digest comparison rejects a candidate that does not match the
 * observation. The isolated Host and run-matrix `--prepare` both call this, so
 * both sides compute byte-identical facts.
 */
export function composeCompatibilityCandidateArtifact(input: {
  provider: "claude" | "codex";
  executable: string;
  providerVersion: string;
  config: ProviderConfiguration;
  policyVersion: number;
  supervisionContractId: string;
}): NativeCompatibilityArtifact {
  const runtime = installedProviderRuntimeFacts(input.provider, input.providerVersion);
  const executable = measureRuntimeFile(input.executable);
  return Object.freeze({
    providerVersion: runtime.providerVersion,
    executablePath: executable.path,
    executableDigest: executable.digest,
    configFingerprint: providerConfigurationFingerprint({ config: input.config, policyVersion: input.policyVersion }),
    ...(runtime.sdkVersion ? { sdkVersion: runtime.sdkVersion } : {}),
    ...(runtime.adapterId ? { adapterId: runtime.adapterId } : {}),
    ...(runtime.adapterVersion ? { adapterVersion: runtime.adapterVersion } : {}),
    runtimeVersion: hostPackageVersion(),
    runtimeDigest: measuredHostBuildDigest(),
    nodeVersion: process.versions.node,
    os: platform() + " " + release() + " " + arch(),
    supervisionContractId: input.supervisionContractId,
  });
}

/** Honest label of the credential path the spawned CLI would actually use; never a guess that a credential works. */
export function observeCompatibilityAuthMode(provider: "claude" | "codex"): "unknown" | "signed_in" | "api_key" {
  if (provider === "claude") {
    // restrictedEnvironment passes exactly these two through to the child.
    if ((process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY !== "")
      || (process.env.ANTHROPIC_AUTH_TOKEN !== undefined && process.env.ANTHROPIC_AUTH_TOKEN !== "")) return "api_key";
    try { if (statSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json")).isFile()) return "signed_in"; } catch { /* fall through to the keychain check */ }
    if (platform() === "darwin") {
      try {
        // Existence check only; the secret itself is never read into this process.
        execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: ["ignore", "ignore", "ignore"] });
        return "signed_in";
      } catch { /* absent keychain item */ }
    }
    return "unknown";
  }
  if (process.env.OPENAI_API_KEY !== undefined && process.env.OPENAI_API_KEY !== "") return "api_key";
  try { if (statSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")).isFile()) return "signed_in"; } catch { /* no stored login */ }
  return "unknown";
}

/** Structural slice of the Host application the isolated run composes against. */
export interface CompatibilityApplicationSlice {
  catalog: {
    legacySessionId: string;
    registry: { resolve(sessionId: string): {
      session: { sessionId: string };
      workspace: { workspaceId: string; canonicalRoot: string; worktreeRoot: string };
      providerInstance: ProviderInstanceRecord;
    } };
  };
}
export interface IsolatedCompatibilityRunOptions {
  owner: HostOwnerHandle;
  store: SqliteStore;
  identity: HostIdentityFileV1;
  workspace: string;
  provider: "claude" | "codex";
  entryPath: string;
  compatibilityEvidencePath: string;
  /** Destination-signed ticket; validated by the scene policy before any recorder exists. */
  authorization: unknown;
  expectedDestination: CompatibilityHostIdentity;
  /** Candidate version from the local operator environment, never an observation. */
  candidateVersion: string;
}
export type CompatibilityReadinessEntry = Omit<CompatibilityReadinessOptions, "artifact">;

export interface IsolatedCompatibilityRun {
  /** Runs the managed `--version` probe under probe authority and returns the measured artifact. */
  start(application: CompatibilityApplicationSlice, entry: CompatibilityReadinessEntry): Promise<NativeCompatibilityArtifact>;
  /** The measured artifact after start(); undefined before it. */
  compatibilityArtifact(): NativeCompatibilityArtifact | undefined;
  /** The committed-stop recorder once a scene policy has been attached. */
  compatibilityRecorder(): CommittedNativeStopRecorder | undefined;
  /** The scene's own manifest-bootstrap authorization once a scene policy has been attached. */
  compatibilityScene(): NativeHistorySceneBootstrap | undefined;
  /** Binds the scene policy to the run, constructing the committed-stop recorder from the validated ticket. */
  attachScene(policy: CompatibilityScenePolicy): void;
  authMode(): "unknown" | "signed_in" | "api_key";
}

/** Composes the real isolated compatibility run: probe authority, runtime facts, recorder. */
export function createIsolatedCompatibilityRun(options: IsolatedCompatibilityRunOptions): IsolatedCompatibilityRun {
  const ticket = options.authorization as CompatibilityRunAuthorization;
  if (ticket?.v !== 2 || ticket.kind !== "compatibility-run-authorization" || ticket.provider !== options.provider
    || typeof ticket.runId !== "string" || typeof ticket.entryDigest !== "string") return fail("COMPATIBILITY_AUTHORIZATION_REQUIRED");
  let application: CompatibilityApplicationSlice | undefined;
  let probeAuthority: CompatibilityVersionProbeAuthority | undefined;
  let measured: NativeCompatibilityArtifact | undefined;
  let recorder: CommittedNativeStopRecorder | undefined;
  let scene: NativeHistorySceneBootstrap | undefined;
  let facts: ReturnType<typeof createCompatibilityRuntimeFacts> | undefined;
  let supervisionProof: NativeBoundaryProof | undefined;
  let started = false;
  const resolveApplication = (): CompatibilityApplicationSlice => application ?? fail("COMPATIBILITY_APPLICATION_UNAVAILABLE");
  const providerRecord = (): ProviderInstanceRecord => resolveApplication().catalog.registry.resolve(resolveApplication().catalog.legacySessionId).providerInstance;
  const sceneBinding = (): CompatibilitySceneBinding => {
    const target = resolveApplication().catalog.registry.resolve(resolveApplication().catalog.legacySessionId);
    return Object.freeze({ sessionId: target.session.sessionId, workspaceId: target.workspace.workspaceId, canonicalRoot: target.workspace.canonicalRoot,
      checkoutRoot: target.workspace.worktreeRoot, providerInstanceId: target.providerInstance.providerInstanceId, provider: target.providerInstance.provider,
      configurationFingerprint: providerConfigurationFingerprint(target.providerInstance) });
  };
  const assertOwner = (): void => { assertHostOwner(options.owner); options.owner.assertStorePath(options.store.db.name); options.store.assertWriterOwner(); };
  const start = async (app: CompatibilityApplicationSlice, entry: CompatibilityReadinessEntry): Promise<NativeCompatibilityArtifact> => {
    assertOwner();
    if (started) return fail("COMPATIBILITY_PROBE_ALREADY_STARTED");
    started = true;
    application = app;
    const record = providerRecord();
    if (record.provider !== options.provider) return fail("COMPATIBILITY_PROVIDER_MISMATCH");
    // A dedicated managed runtime for the fixed read-only probe; it never loads a Session runtime.
    const probeRuntime = new HostManagedRuntime({ store: options.store, owner: options.owner, sessionId: app.catalog.legacySessionId,
      runtimeId: "compatibility-version", workspace: options.workspace, provider: options.provider });
    const assessment = await probeRuntime.prepare();
    if (!assessment.ready) return fail("COMPATIBILITY_C0_UNAVAILABLE");
    supervisionProof = assessment.proof;
    const supervision = (): NativeBoundaryProof | undefined => supervisionProof;
    const candidateArtifact = (): NativeCompatibilityArtifact => {
      const current = providerRecord();
      return composeCompatibilityCandidateArtifact({ provider: options.provider, executable: current.executable, providerVersion: options.candidateVersion,
        config: current.config, policyVersion: current.policyVersion, supervisionContractId: nativeStopContractId(assessment.proof) });
    };
    probeAuthority = await createCompatibilityVersionProbeAuthority({ authorization: options.authorization, expectedDestination: options.expectedDestination,
      entry: { ...entry, artifact: candidateArtifact() }, store: options.store, owner: options.owner,
      currentBinding: sceneBinding, measureCandidateArtifact: candidateArtifact,
      assertBaseline: () => {
        assertOwner();
        if (options.owner.mode === "maintenance" || options.owner.recoveryOnly || options.owner.retainedReason) return fail("COMPATIBILITY_PROBE_OWNER_INVALID");
        assertRestoreWriteReady(options.store.db);
      } });
    const controller = new ManagedRuntimeController(probeRuntime.options);
    facts = createCompatibilityRuntimeFacts({ db: options.store.db, assertOwner, provider: providerRecord, workspace: options.workspace, supervision,
      assertVersionProbeAuthorized: (request) => probeAuthority!.assertAuthorized(request),
      prepareVersionRuntime: () => controller.prepare(controller.inspectionContext()) });
    const artifact = await facts.probeVersion();
    assertCompleteCompatibilityArtifact(artifact);
    measured = artifact;
    return artifact;
  };
  return Object.freeze({
    start,
    compatibilityArtifact: () => measured,
    compatibilityRecorder: () => recorder,
    attachScene: (policy: CompatibilityScenePolicy) => {
      if (!measured || !facts || !probeAuthority) return fail("COMPATIBILITY_PROBE_NOT_RUN");
      if (recorder) return fail("COMPATIBILITY_SCENE_ALREADY_STARTED");
      // The scene policy already validated ticket.runId/entryDigest against the
      // live process, so these bound values are the validated ones.
      recorder = createCompatibilityCommittedRecorder({ db: options.store.db, identity: options.identity, path: options.compatibilityEvidencePath,
        runId: ticket.runId, entryDigest: ticket.entryDigest, facts,
        assertSceneObservation: (context: DispatchContext) => policy.assertObservation(context) });
      // The scene's own authorization for manifest bootstrap (design §8.2):
      // run/entry bound to the validated ticket, artifact re-measured live so
      // any drift after the scene attached is a refusal.
      scene = Object.freeze({ runId: ticket.runId, entryDigest: ticket.entryDigest, artifact: () => facts!.measure() });
    },
    compatibilityScene: () => scene,
    authMode: () => observeCompatibilityAuthMode(options.provider),
  });
}
