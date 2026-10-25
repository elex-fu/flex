import type { ProviderId } from "@flyx/mvp-protocol";
import type { SqliteStore } from "../storage/db.js";
import { CatalogError, type CatalogStore } from "../storage/catalog-store.js";
import { LocalCatalogConfigurationSchema, readLocalCatalogConfiguration, type LocalCatalogConfiguration } from "../session/configured-catalog.js";
import type { HostCatalogOptions } from "./host-catalog.js";

const DEFAULT_POLICY = ["streamingText", "structuredToolCalls", "gitDiff", "resumeConversation", "workspaceWrite", "interrupt", "interactiveApprovals"];
export type HostCatalogBootstrap = {
  configuration: LocalCatalogConfiguration;
  initialLegacySession?: NonNullable<HostCatalogOptions["initialLegacySession"]>;
};

/** Select local metadata before any runtime, SDK, executable resolution or Git query. */
export function readHostCatalogBootstrap(options: {
  store: SqliteStore;
  workspace: string;
  provider: ProviderId;
  environment: Readonly<Record<string, string | undefined>>;
}): HostCatalogBootstrap {
  const env = options.environment;
  const hasSessions = Boolean(options.store.db.prepare("SELECT 1 FROM sessions LIMIT 1").get());
  const configured = env.FLYX_CATALOG_CONFIG ? readLocalCatalogConfiguration(env.FLYX_CATALOG_CONFIG) : undefined;
  if (configured?.legacyDefaultSessionId && env.FLYX_LEGACY_DEFAULT_SESSION_ID
    && configured.legacyDefaultSessionId !== env.FLYX_LEGACY_DEFAULT_SESSION_ID) throw new CatalogError("LEGACY_DEFAULT_CONFLICT");
  const configuration = LocalCatalogConfigurationSchema.parse({
    ...(configured ?? (hasSessions ? {} : {
      workspaces: [{ workspaceId: "default-workspace", root: options.workspace, capabilities: DEFAULT_POLICY }],
      providerInstances: [{ providerInstanceId: `default-${options.provider}`, provider: options.provider,
        executable: (options.provider === "codex" ? env.FLYX_CODEX_EXECUTABLE : env.FLYX_CLAUDE_EXECUTABLE) ?? options.provider,
        policyCapabilities: DEFAULT_POLICY }],
    })),
    ...(env.FLYX_LEGACY_DEFAULT_SESSION_ID ? { legacyDefaultSessionId: env.FLYX_LEGACY_DEFAULT_SESSION_ID } : {}),
  });
  // Existing Sessions retain their original binding. Environment defaults never
  // turn an existing Session into a different workspace or Provider instance.
  if (hasSessions) return { configuration };
  const workspaceId = env.FLYX_LEGACY_WORKSPACE_ID ?? (configuration.workspaces.length === 1 ? configuration.workspaces[0]?.workspaceId : undefined);
  const providerInstanceId = env.FLYX_LEGACY_PROVIDER_INSTANCE_ID ?? (configuration.providerInstances.length === 1 ? configuration.providerInstances[0]?.providerInstanceId : undefined);
  if (!workspaceId || !providerInstanceId || !configuration.workspaces.some((row) => row.workspaceId === workspaceId)
    || !configuration.providerInstances.some((row) => row.providerInstanceId === providerInstanceId)) {
    throw new CatalogError("LEGACY_INITIAL_SESSION_REQUIRED", "Choose FLYX_LEGACY_WORKSPACE_ID and FLYX_LEGACY_PROVIDER_INSTANCE_ID from the local Catalog configuration");
  }
  return { configuration, initialLegacySession: { workspaceId, providerInstanceId } };
}

/**
 * Restart revalidation source: the exact rows this Store already published. A
 * restarted Host already has Sessions, so `readHostCatalogBootstrap` yields an
 * empty environment configuration — environment defaults must never override
 * an existing binding. The explicit local configuration step therefore
 * revalidates the recorded rows instead, restoring the `configured` Provider
 * state the startup readiness withdrawal reset, without ever introducing a
 * binding the Store did not already hold. Disabled rows stay untouched: local
 * revalidation must not re-enable a resource some other flow withdrew.
 */
export function storedCatalogConfiguration(catalog: CatalogStore): LocalCatalogConfiguration {
  const legacyDefaultSessionId = catalog.legacyDefaultSessionId();
  return LocalCatalogConfigurationSchema.parse({
    workspaces: catalog.workspaces()
      .filter((workspace) => workspace.state !== "disabled")
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        root: workspace.canonicalRoot,
        repositoryId: workspace.repositoryId,
        capabilities: [...workspace.capabilities],
      })),
    providerInstances: catalog.providers()
      .filter((provider) => provider.state !== "disabled")
      .map((provider) => ({
        providerInstanceId: provider.providerInstanceId,
        provider: provider.provider,
        executable: provider.executable,
        config: {
          ...(provider.config.model ? { model: provider.config.model } : {}),
          environment: { ...provider.config.environment },
          sandboxRequired: true,
        },
        policyVersion: provider.policyVersion,
        policyCapabilities: [...provider.policyCapabilities],
      })),
    ...(legacyDefaultSessionId ? { legacyDefaultSessionId } : {}),
  });
}
