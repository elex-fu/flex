import type { CatalogSession, ProviderInstanceRecord, WorkspaceRecord } from "../storage/catalog-store.js";
import { digest } from "../storage/recovery-store.js";

/**
 * Structural input for {@link catalogRecoveryConfigurationFingerprint}. Every
 * digest-relevant field is listed explicitly so callers can supply either a
 * full {@link ResolvedSession} or the same fields reconstructed from database
 * rows; both produce the identical recovery-domain fingerprint.
 */
export type RecoveryConfigurationTarget = Readonly<{
  session: Pick<CatalogSession, "workspaceId">;
  providerInstance: Pick<ProviderInstanceRecord, "providerInstanceId" | "provider" | "executable" | "config" | "policyVersion" | "policyCapabilities">;
  workspace: Pick<WorkspaceRecord, "canonicalRoot" | "worktreeRoot" | "checkoutKey" | "repositoryId" | "kind">;
}>;

/**
 * Shared by live capture and recovery. Mutable verification, version probes and residency are excluded.
 * This is the recovery-domain identity of the live resource: it is what
 * host-recovery records in `native_turn_bindings.configuration_fingerprint`
 * and what catalog recovery admission re-derives. It is deliberately distinct
 * from the compatibility artifact's `configFingerprint`
 * (providerConfigurationFingerprint), which attests only the provider
 * activation configuration.
 */
export function catalogRecoveryConfigurationFingerprint(target: RecoveryConfigurationTarget): string {
  const { session, providerInstance: provider, workspace } = target;
  return digest({ version: 1, providerInstanceId: provider.providerInstanceId, provider: provider.provider,
    executable: provider.executable, configuration: provider.config, policyVersion: provider.policyVersion,
    policyCapabilities: [...provider.policyCapabilities].sort(), workspaceId: session.workspaceId,
    canonicalRoot: workspace.canonicalRoot, checkoutRoot: workspace.worktreeRoot, checkoutKey: workspace.checkoutKey,
    repositoryId: workspace.repositoryId, kind: workspace.kind });
}
