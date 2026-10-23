import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { arch, release } from "node:os";
import type { HostApplicationOptions } from "../host-application.js";
import type { IsolatedCompatibilityRun } from "../diagnostics/compatibility-run.js";
import { installedProviderRuntimeFacts } from "../diagnostics/compatibility-runtime-facts.js";
import { measuredHostBuildDigest } from "../diagnostics/planned-native-artifact.js";
import { publicHostIdentity, type HostIdentityFileV1 } from "../identity/host-identity.js";
import type { CompatibilityEvidenceTrust } from "../diagnostics/compatibility-evidence.js";
import { newestPassedArtifact, fileIdentity, providerConfigurationFingerprint } from "./host-activation-load.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";
import type { ManagedGitRunnerOptions } from "./managed-git-runner.js";

/** A locally constructed production backend; ordinary success never asserts descendant isolation. */
export function macosManagedGitOptions(): Pick<ManagedGitRunnerOptions, "stopBackend"> {
  if (process.platform !== "darwin") throw new Error("MANAGED_MACOS_PLATFORM_REQUIRED");
  return { stopBackend: Object.freeze({ kind: "managed_process_group" as const, platform: "darwin" as const,
    contractId: MACOS_MANAGED_STOP_CONTRACT, verifiedDescendantStop: false, verify: () => undefined }) };
}

/** Read-only fact load: no model, SDK query, version query or auto-activation at startup. */
export function macosManagedExecutionFacts(options: { compatibilityEvidencePath: string; trust: CompatibilityEvidenceTrust }) {
  return {
    supervision: () => ({ contractId: MACOS_MANAGED_STOP_CONTRACT }),
    runtime: (record: ProviderInstanceRecord) => {
      const accepted = newestPassedArtifact(options.compatibilityEvidencePath, record, options.trust);
      if (!accepted || accepted.artifact.supervisionContractId !== MACOS_MANAGED_STOP_CONTRACT
        || accepted.artifact.executablePath !== record.executable || accepted.artifact.executableDigest !== fileIdentity(record.executable)?.digest
        || accepted.artifact.configFingerprint !== providerConfigurationFingerprint(record)
        || accepted.artifact.runtimeDigest !== measuredHostBuildDigest() || accepted.artifact.nodeVersion !== process.versions.node
        || accepted.artifact.os !== `${process.platform} ${release()} ${arch()}`) return undefined;
      return installedProviderRuntimeFacts(record.provider, accepted.artifact.providerVersion);
    },
  };
}

export async function createMacosManagedExecution(options: { identity: HostIdentityFileV1; compatibilityEvidencePath: string;
  compatibilityEndorsementPath: string; worktreesRoot: string;
  /** Isolated compatibility run (M4); undefined for the ordinary online Host. */
  compatibility?: IsolatedCompatibilityRun }): Promise<HostApplicationOptions["execution"]> {
  if (process.platform !== "darwin") return undefined;
  await mkdir(options.worktreesRoot, { recursive: true, mode: 0o700 });
  return { git: macosManagedGitOptions(), worktreesRoot: realpathSync(options.worktreesRoot),
    ...(options.compatibility ? { compatibilityArtifact: () => options.compatibility!.compatibilityArtifact(),
      compatibilityRecorder: () => options.compatibility!.compatibilityRecorder(),
      compatibilityScene: () => options.compatibility!.compatibilityScene() } : {}),
    facts: macosManagedExecutionFacts({ compatibilityEvidencePath: options.compatibilityEvidencePath,
      trust: { destination: publicHostIdentity(options.identity), endorsementPath: options.compatibilityEndorsementPath } }) };
}
