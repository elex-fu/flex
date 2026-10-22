import {
  compatibilityEvidenceArtifactDigest,
  loadTrustedCompatibilityEvidence,
  type CompatibilityEvidenceEntry,
  type CompatibilityEvidenceTrust,
} from "../diagnostics/compatibility-evidence.js";
import {
  newestPassedArtifact,
  observeProvider,
  type ProviderRuntimeFacts,
  type SupervisionContractFacts,
} from "../lifecycle/host-activation-load.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { NativeHandle } from "./native-history.js";
import type { NativeHistoryManifest } from "./native-history-reader.js";

export type NativeHistoryManifestSourceOptions = Readonly<{
  /** Host-private compatibility evidence log; an unusable log is a refusal, not an empty match. */
  compatibilityEvidencePath: string;
  compatibilityTrust?: CompatibilityEvidenceTrust;
  supervision?: () => SupervisionContractFacts | undefined;
  runtime?: (provider: ProviderInstanceRecord) => ProviderRuntimeFacts | undefined;
  resolveProvider(providerInstanceId: string): ProviderInstanceRecord | undefined;
}>;

export type NativeHistoryManifestSource = Readonly<{
  verifiedManifestForHandle(handle: NativeHandle): NativeHistoryManifest | undefined;
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
  return {
    verifiedManifestForHandle(handle: NativeHandle): NativeHistoryManifest | undefined {
      if (handle.provider !== "claude" && handle.provider !== "codex") return undefined;
      const record = options.resolveProvider(handle.providerInstanceId);
      if (!record || record.provider !== handle.provider || record.providerInstanceId !== handle.providerInstanceId) return undefined;
      // The write gate's live-fact checks: executable digest, configuration
      // fingerprint, supervision contract, runtime versions and baseline binding.
      const observation = observeProvider(record, dependencies);
      const baseline = newestPassedArtifact(options.compatibilityEvidencePath, record, options.compatibilityTrust);
      if (!observation.ready || !baseline) return undefined;
      const artifactDigest = compatibilityEvidenceArtifactDigest(baseline.artifact);
      let entries: readonly CompatibilityEvidenceEntry[];
      try { entries = loadTrustedCompatibilityEvidence(options.compatibilityEvidencePath, undefined, options.compatibilityTrust); } catch { return undefined; }
      // The read-only native history capability must be bound to the exact
      // same signed artifact, run and controlled entry as the turn baseline.
      const recovery = entries
        .filter((entry): entry is CompatibilityEvidenceEntry & { artifact: NonNullable<CompatibilityEvidenceEntry["artifact"]>; digest: string } =>
          entry.provider === record.provider && entry.kind === "recovery" && (entry.capability ?? "recovery") === "recovery"
          && entry.result === "passed" && entry.trusted === true && entry.artifact !== undefined && entry.digest !== undefined
          && entry.runId === baseline.runId && entry.entryDigest === baseline.entryDigest
          && compatibilityEvidenceArtifactDigest(entry.artifact) === artifactDigest)
        .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))[0];
      if (!recovery) return undefined;
      return Object.freeze({
        source: "real-provider" as const, state: "verified" as const, evidenceId: recovery.digest,
        provider: record.provider, providerInstanceId: record.providerInstanceId,
        configurationFingerprint: observation.value.configFingerprint,
        verifiedVersions: [baseline.artifact.providerVersion],
        historyContract: record.provider === "claude" ? ("claude-sdk-result-v1" as const) : ("codex-thread-read-v1" as const),
      });
    },
  };
}
