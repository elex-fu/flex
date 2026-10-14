import { z } from "zod";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { assertHostOwner } from "../lifecycle/host-owner.js";
import type { SqliteStore } from "../storage/db.js";
import { CatalogError, CatalogStore } from "../storage/catalog-store.js";
import { CatalogImportService, type CatalogImportPlan, type CatalogImportResult } from "../storage/import-service.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import { validateCatalogSchema } from "../storage/migrations/007-catalog.js";
const Id = z.string().min(1).max(256);
export const CatalogImportCliRequestSchema = z.strictObject({
    mode: z.enum(["dry-run", "import"]),
    sourceDatabasePath: z.string().min(1),
    legacyWorkspaceByCanonicalRoot: z.record(z.string().min(1), Id).optional(),
    legacyProviderInstances: z.strictObject({ claude: Id.optional(), codex: Id.optional() }).optional(),
    approvedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type CatalogImportCliRequest = z.input<typeof CatalogImportCliRequestSchema>;
export type CatalogImportCliResult = {
    mode: "dry-run";
    plan: CatalogImportPlan;
} | {
    mode: "import";
    plan: CatalogImportPlan;
    result: CatalogImportResult;
};
export type CatalogImportCliOptions = {
    store: SqliteStore;
    owner: HostOwnerHandle;
    backupDirectory: string;
    privateDirectories?: readonly string[];
};
/** Thin local CLI handler. The caller opens an existing offline, owned Store. */
export async function runCatalogImportCli(options: CatalogImportCliOptions, value: CatalogImportCliRequest): Promise<CatalogImportCliResult> {
    const input = CatalogImportCliRequestSchema.parse(value);
    assertHostOwner(options.owner);
    options.owner.assertStorePath(options.store.db.name);
    options.store.assertWriterOwner();
    if (options.owner.mode !== "maintenance" || options.owner.recoveryOnly)
        throw new CatalogError("OFFLINE_MAINTENANCE_REQUIRED");
    validateCatalogSchema(options.store.db);
    if (input.mode === "import" && !input.approvedSourceDigest)
        throw new CatalogError("IMPORT_DRY_RUN_REQUIRED", "Review the dry-run digest before importing");
    const catalog = new CatalogStore(options.store);
    try {
        const workspaces = new WorkspaceRegistry(catalog, { owner: options.owner, ...(options.privateDirectories ? { privateDirectories: options.privateDirectories } : {}) });
        const providers = new ProviderInstanceRegistry(catalog);
        const service = new CatalogImportService(catalog, workspaces, providers, { owner: options.owner, backupDirectory: options.backupDirectory });
        const legacyProviders = input.legacyProviderInstances ? { ...(input.legacyProviderInstances.claude ? { claude: input.legacyProviderInstances.claude } : {}), ...(input.legacyProviderInstances.codex ? { codex: input.legacyProviderInstances.codex } : {}) } : undefined;
        const plan = service.dryRun({ sourceDatabasePath: input.sourceDatabasePath, ...(input.legacyWorkspaceByCanonicalRoot ? { legacyWorkspaceByCanonicalRoot: input.legacyWorkspaceByCanonicalRoot } : {}), ...(legacyProviders ? { legacyProviderInstances: legacyProviders } : {}) });
        if (input.mode === "dry-run")
            return { mode: "dry-run", plan };
        if (plan.sourceDigest !== input.approvedSourceDigest)
            throw new CatalogError("IMPORT_SOURCE_CHANGED", "Source facts or target bindings differ from the reviewed dry-run");
        return { mode: "import", plan, result: await service.import(plan) };
    }
    finally {
        catalog.dispose();
    }
}
