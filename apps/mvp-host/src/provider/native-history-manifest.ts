import {
  compatibilityEvidenceArtifactDigest,
  loadTrustedCompatibilityEvidence,
  readCompatibilityEvidence,
  type CompatibilityEvidenceArtifact,
  type CompatibilityEvidenceEntry,
  type CompatibilityEvidenceTrust,
  type NativeCompatibilityArtifact,
} from "../diagnostics/compatibility-evidence.js";
import {
  fileIdentity,
  newestPassedArtifact,
  observeProvider,
  providerConfigurationFingerprint,
  type ProviderRuntimeFacts,
  type SupervisionContractFacts,
} from "../lifecycle/host-activation-load.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { ProviderId } from "./types.js";
import type { NativeHandle } from "./native-history.js";
import type { NativeHistoryManifest } from "./native-history-reader.js";

/**
 * The scene's own authorization for manifest bootstrap (design §8.2): the
 * isolated compatibility run's controlled entry plus its live re-measured
 * artifact. Valid only while the scene is attached; the bootstrap manifest
 * authorizes the scene's own read-only recovery inspection, whose recorded
 * evidence is what later unlocks the production manifest after import.
 */
export type NativeHistorySceneBootstrap = Readonly<{
  runId: string;
  entryDigest: string;
  /** Re-measured live scene artifact; any drift is a refusal. */
  artifact(): NativeCompatibilityArtifact;
}>;

/**
 * The live session-resource proof in the recovery domain: the manifest's
 * configurationFingerprint must match what the reader gate and recovery
 * admission compare (catalogRecoveryConfigurationFingerprint over the live
 * session/workspace/provider rows), and must be derived independently from
 * those rows — never echoed from the handle or identity asking for it.
 */
export type NativeHistoryResourceFingerprint = Readonly<{
  provider: ProviderId;
  providerInstanceId: string;
  configurationFingerprint: string;
}>;

export type NativeHistoryManifestSourceOptions = Readonly<{
  /** Host-private compatibility evidence log; an unusable log is a refusal, not an empty match. */
  compatibilityEvidencePath: string;
  compatibilityTrust?: CompatibilityEvidenceTrust;
  supervision?: () => SupervisionContractFacts | undefined;
  runtime?: (provider: ProviderInstanceRecord) => ProviderRuntimeFacts | undefined;
  resolveProvider(providerInstanceId: string): ProviderInstanceRecord | undefined;
  /**
   * Re-derives the recovery-domain resource fingerprint from the live catalog
   * rows. When present it is required: the manifest binds the exact live
   * session resource instead of the provider activation configuration. When
   * absent (fixture wiring) the compatibility-domain fingerprint of the
   * provider configuration is used, matching handles constructed that way.
   */
  resourceFingerprint?: (sessionId: string) => NativeHistoryResourceFingerprint | undefined;
  /** Scene-authorized bootstrap for the isolated compatibility run's own reads. */
  sceneBootstrap?: () => NativeHistorySceneBootstrap | undefined;
}>;

export type NativeHistoryManifestSource = Readonly<{
  verifiedManifestForHandle(handle: NativeHandle): NativeHistoryManifest | undefined;
  /** Instance-level port for recovery admission (catalog-recovery versions()). The optional sessionId enables the live resource proof. */
  verifiedManifestForInstance(provider: ProviderId, providerInstanceId: string, sessionId?: string): CachedNativeHistoryManifest | undefined;
}>;

/** Manifest shape recovery admission trusts; no transcript contract is implied. */
export type CachedNativeHistoryManifest = Readonly<{
  source: "real-provider";
  state: "verified";
  evidenceId: string;
  provider: ProviderId;
  providerInstanceId: string;
  configurationFingerprint: string;
  verifiedVersions: readonly string[];
}>;

/**
 * The trusted source of the versioned installed-read contract design R4
 * requires: a manifest exists only when the same signed artifact, isolated run
 * and controlled entry that verified the turn baseline (and every capability
 * the provider's policy requires) also carries a passed read-only recovery
 * inspection, and the artifact still matches the live provider instance facts.
 * Current activation state alone is never a manifest: binding drift keeps the
 * read contract unavailable rather than re-deriving it from a live session.
 */
export function createNativeHistoryManifestSource(options: NativeHistoryManifestSourceOptions): NativeHistoryManifestSource {
  const dependencies = {
    compatibilityEvidencePath: options.compatibilityEvidencePath,
    ...(options.supervision ? { supervision: options.supervision } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.compatibilityTrust ? { compatibilityTrust: options.compatibilityTrust } : {}),
  };
  /**
   * Scene-authorized bootstrap: the isolated run's own signature-verified turn
   * baseline (the same artifact, run and controlled entry, and every
   * policy-required capability on that one artifact) authorizes the scene's
   * own read-only recovery inspection. The production path above requires an
   * endorsed recovery entry; inside the scene, before import, that cannot
   * exist yet — the read this manifest authorizes is what records it.
   */
  const sceneManifestFor = (record: ProviderInstanceRecord, resource: NativeHistoryResourceFingerprint): CachedNativeHistoryManifest | undefined => {
    const scene = options.sceneBootstrap?.();
    if (!scene) return undefined;
    let measured: NativeCompatibilityArtifact;
    try { measured = scene.artifact(); } catch { return undefined; }
    if (!measured || !measured.providerVersion || measured.executablePath !== record.executable) return undefined;
    const identity = fileIdentity(record.executable);
    if (!identity || measured.executableDigest !== identity.digest || measured.configFingerprint !== providerConfigurationFingerprint(record)) return undefined;
    const supervision = options.supervision?.();
    if (!supervision?.contractId || measured.supervisionContractId !== supervision.contractId) return undefined;
    const artifactDigest = compatibilityEvidenceArtifactDigest({ ...measured, provider: record.provider } as CompatibilityEvidenceArtifact);
    const read = readCompatibilityEvidence(options.compatibilityEvidencePath);
    if (!read.available) return undefined;
    const matches = read.entries.filter((entry): entry is CompatibilityEvidenceEntry & { artifact: CompatibilityEvidenceArtifact; digest: string } =>
      entry.trusted === true && entry.domain === "isolated-real" && entry.provider === record.provider && entry.result === "passed"
      && entry.artifact !== undefined && entry.digest !== undefined && entry.runId === scene.runId && entry.entryDigest === scene.entryDigest);
    const required = new Set<string>(["turn"]);
    const scenarios: Readonly<Record<string, string>> = {
      interrupt: "interrupt", interactiveApprovals: "approval", structuredQuestions: "question",
      resumeConversation: "reconnect", conversationRewind: "rewind",
    };
    for (const capability of record.policyCapabilities) if (scenarios[capability]) required.add(scenarios[capability]!);
    const baselines = matches.filter((entry) => entry.kind === "turn" && (entry.capability ?? "turn") === "turn")
      .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
    for (const baseline of baselines) {
      if (compatibilityEvidenceArtifactDigest(baseline.artifact) !== artifactDigest) continue;
      if ([...required].every((capability) => matches.some((entry) => entry.kind === capability && (entry.capability ?? capability) === capability
        && compatibilityEvidenceArtifactDigest(entry.artifact) === artifactDigest))) {
        return Object.freeze({ source: "real-provider" as const, state: "verified" as const, evidenceId: baseline.digest,
          provider: record.provider, providerInstanceId: record.providerInstanceId,
          configurationFingerprint: resource.configurationFingerprint, verifiedVersions: [measured.providerVersion!] });
      }
    }
    return undefined;
  };
  const manifestFor = (record: ProviderInstanceRecord, resource: NativeHistoryResourceFingerprint | undefined): CachedNativeHistoryManifest | undefined => {
    // The write gate's live-fact checks: executable digest, configuration
    // fingerprint, supervision contract, runtime versions and baseline binding.
    const observation = observeProvider(record, dependencies);
    const baseline = newestPassedArtifact(options.compatibilityEvidencePath, record, options.compatibilityTrust);
    if (observation.ready && baseline) {
      let entries: readonly CompatibilityEvidenceEntry[];
      try { entries = loadTrustedCompatibilityEvidence(options.compatibilityEvidencePath, undefined, options.compatibilityTrust); } catch { entries = []; }
      // The read-only native history capability must be bound to the exact
      // same signed artifact, run and controlled entry as the turn baseline.
      const recovery = entries
        .filter((entry): entry is CompatibilityEvidenceEntry & { artifact: NonNullable<CompatibilityEvidenceEntry["artifact"]>; digest: string } =>
          entry.provider === record.provider && entry.kind === "recovery" && (entry.capability ?? "recovery") === "recovery"
          && entry.result === "passed" && entry.trusted === true && entry.artifact !== undefined && entry.digest !== undefined
          && entry.runId === baseline.runId && entry.entryDigest === baseline.entryDigest
          && compatibilityEvidenceArtifactDigest(entry.artifact) === compatibilityEvidenceArtifactDigest(baseline.artifact))
        .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))[0];
      if (recovery) {
        return Object.freeze({
          source: "real-provider" as const, state: "verified" as const, evidenceId: recovery.digest,
          provider: record.provider, providerInstanceId: record.providerInstanceId,
          configurationFingerprint: resource?.configurationFingerprint ?? observation.value.configFingerprint,
          verifiedVersions: [baseline.artifact.providerVersion],
        });
      }
    }
    // Production manifest first; the scene bootstrap only fills the gap the
    // bootstrap itself exists to close (no endorsed evidence before import).
    return resource ? sceneManifestFor(record, resource) : undefined;
  };
  const resolve = (provider: ProviderId, providerInstanceId: string): ProviderInstanceRecord | undefined => {
    if (provider !== "claude" && provider !== "codex") return undefined;
    const record = options.resolveProvider(providerInstanceId);
    if (!record || record.provider !== provider || record.providerInstanceId !== providerInstanceId) return undefined;
    return record;
  };
  return {
    verifiedManifestForHandle(handle: NativeHandle): NativeHistoryManifest | undefined {
      const record = resolve(handle.provider, handle.providerInstanceId);
      if (!record) return undefined;
      // With the resource port wired, the manifest exists only for a handle
      // that still matches the live session resource; a stale handle keeps
      // the read contract unavailable instead of re-deriving it.
      const resource = options.resourceFingerprint?.(handle.sessionId);
      if (options.resourceFingerprint && (!resource || resource.provider !== handle.provider
        || resource.providerInstanceId !== handle.providerInstanceId || resource.configurationFingerprint !== handle.configurationFingerprint)) return undefined;
      const manifest = manifestFor(record, resource);
      if (!manifest) return undefined;
      return Object.freeze({ ...manifest, historyContract: record.provider === "claude" ? ("claude-sdk-result-v1" as const) : ("codex-thread-read-v1" as const) });
    },
    verifiedManifestForInstance(provider: ProviderId, providerInstanceId: string, sessionId?: string): CachedNativeHistoryManifest | undefined {
      const record = resolve(provider, providerInstanceId);
      if (!record) return undefined;
      const resource = sessionId !== undefined ? options.resourceFingerprint?.(sessionId) : undefined;
      if (sessionId !== undefined && options.resourceFingerprint && (!resource || resource.provider !== provider || resource.providerInstanceId !== providerInstanceId)) return undefined;
      return manifestFor(record, resource);
    },
  };
}
