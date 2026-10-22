import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { CreateSessionV2Schema } from "@flyx/mvp-protocol";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import type { ActivationReadinessPort } from "../lifecycle/host-activation-load.js";
import { CatalogError, CatalogStore, hashCatalogRequest, publicSessionSummary } from "../storage/catalog-store.js";
import { LocalCatalogConfigurationSchema, type LocalCatalogConfiguration } from "../session/configured-catalog.js";
import { WorkspaceRegistry, type WorkspaceGitQuery } from "../workspace/workspace-registry.js";
import { ProviderInstanceRegistry, parseLocalProviderInstance } from "../provider/provider-instance-registry.js";

export type CatalogReadBootstrapOptions = {
    privateDirectories?: readonly string[];
    readOnlyGit?: WorkspaceGitQuery;
    /**
     * Explicit activation readiness (design §6.3 step 5). When supplied, the
     * bootstrap registers/loads identities and withdraws only the verdicts the
     * recorded facts no longer support; reading history never erases evidence
     * unconditionally.
     */
    readiness?: ActivationReadinessPort;
    initialLegacySession?: { workspaceId: string; providerInstanceId: string; title?: string };
    restoreWriteReady?: (db: CatalogStore["db"]) => void;
};

/**
 * Unconditional readiness invalidation for the legacy (no readiness port)
 * bootstrap: with migration 011 installed it also clears the activation
 * reference and bumps the readiness revision, so a stale reference can never
 * outlive the reset. Original Recovery resource identities are untouched.
 */
export function invalidateCatalogResourceReadiness(catalog: CatalogStore, owner: HostOwnerHandle): void {
    assertLocalOwner(catalog, owner);
    if (activationColumnsAvailable(catalog.db)) {
        catalog.db.prepare("UPDATE workspaces SET state='needs_verification',activation_operation_id=NULL,activation_binding_digest=NULL,readiness_revision=readiness_revision+1 WHERE state='active'").run();
        for (const provider of catalog.providers()) {
            if (provider.state === "disabled") continue;
            catalog.db.prepare("UPDATE provider_instances SET state='unconfigured',verification_json=?,activation_operation_id=NULL,activation_binding_digest=NULL,readiness_revision=readiness_revision+1 WHERE id=?")
                .run(JSON.stringify({ ...provider.verification, state: "unverified" }), provider.providerInstanceId);
        }
        return;
    }
    // A Store without migration 011 cannot reference an activation at all.
    catalog.db.prepare("UPDATE workspaces SET state='needs_verification' WHERE state='active'").run();
    for (const provider of catalog.providers()) {
        if (provider.state === "disabled") continue;
        catalog.db.prepare("UPDATE provider_instances SET state='unconfigured',verification_json=? WHERE id=?")
            .run(JSON.stringify({ ...provider.verification, state: "unverified" }), provider.providerInstanceId);
    }
}

function activationColumnsAvailable(db: CatalogStore["db"]): boolean {
    try {
        const columns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
        return columns.some((column) => column.name === "readiness_revision");
    } catch { return false; }
}

function assertLocalOwner(catalog: CatalogStore, owner: HostOwnerHandle): void {
    assertHostOwner(owner);
    owner.assertStorePath(catalog.db.name);
    if (owner.mode === "maintenance" || owner.recoveryOnly) throw new CatalogError("HOST_RECOVERY_ONLY");
    catalog.store.assertWriterOwner();
}

/**
 * Producer-side canonicalization for the journaled canonicalRoot: a configured
 * alias (for example a macOS /var -> /private/var temp path) must never be
 * persisted, or every later `assertCurrent`/identity comparison against the
 * canonical form fails as WORKSPACE_MOVED. A not-yet-existing root keeps its
 * absolute form; verification still decides the checkout identity.
 */
function canonicalConfiguredRoot(root: string): string {
    const absolute = resolve(root);
    try { return realpathSync(absolute); } catch { return absolute; }
}

/**
 * Owner-only SQL bootstrap. No Git, executable lookup, Native process or DDL.
 * Existing identities remain authoritative; supplied config registers new IDs.
 */
export function registerCatalogReadMetadata(catalog: CatalogStore, owner: HostOwnerHandle, configuration: LocalCatalogConfiguration, options: CatalogReadBootstrapOptions = {}) {
    assertLocalOwner(catalog, owner);
    const parsed = LocalCatalogConfigurationSchema.parse(configuration);
    const providerInputs = parsed.providerInstances.map(parseLocalProviderInstance);
    const workspaces = new WorkspaceRegistry(catalog, { owner, ...(options.privateDirectories ? { privateDirectories: options.privateDirectories } : {}), ...(options.readOnlyGit ? { readOnlyGit: options.readOnlyGit } : {}) });
    const providers = new ProviderInstanceRegistry(catalog);
    catalog.db.transaction(() => {
        owner.assertActive();
        // With an explicit readiness port only the decided verdicts are withdrawn
        // (after identities are registered); the legacy path stays unconditional.
        if (!options.readiness?.available) invalidateCatalogResourceReadiness(catalog, owner);
        for (const input of parsed.workspaces) {
            if (catalog.workspace(input.workspaceId)) continue;
            // Unknown checkout identity is explicit. It is never derived from cwd.
            catalog.putWorkspace({ workspaceId: input.workspaceId, canonicalRoot: canonicalConfiguredRoot(input.root), worktreeRoot: "", checkoutKey: "", kind: "local", state: "needs_verification", repositoryId: input.repositoryId ?? input.workspaceId, capabilities: input.capabilities ?? [] });
        }
        for (const input of providerInputs) {
            const existing = catalog.provider(input.providerInstanceId);
            if (existing) {
                if (existing.provider !== input.provider) throw new CatalogError("PROVIDER_REGISTRATION_CONFLICT");
                continue;
            }
            catalog.putProvider({ ...input, config: { environment: input.config.environment, sandboxRequired: true, ...(input.config.model ? { model: input.config.model } : {}) }, state: "unconfigured", verification: { state: "unverified", capabilities: [] } });
        }
        if (options.readiness?.available) {
            const at = new Date().toISOString();
            for (const readiness of options.readiness.scan()) {
                if (readiness.ready || !readiness.reasonCodes.length) continue;
                options.readiness.withdraw(readiness, at);
            }
        }
        if (parsed.legacyDefaultSessionId) catalog.setLegacyDefaultOnce(parsed.legacyDefaultSessionId);
        if (!catalog.legacyDefaultSessionId() && options.initialLegacySession && !catalog.db.prepare("SELECT 1 FROM sessions LIMIT 1").get()) {
            if (options.restoreWriteReady) options.restoreWriteReady(catalog.db);
            else if (catalog.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()) throw new CatalogError("RESTORE_EXTERNAL_STATE_UNVERIFIED");
            const input = CreateSessionV2Schema.parse({ ...options.initialLegacySession, title: options.initialLegacySession.title ?? "Untitled session" });
            const workspace = catalog.workspace(input.workspaceId);
            const provider = catalog.provider(input.providerInstanceId);
            if (!workspace || workspace.state !== "needs_verification" || !provider || provider.state !== "unconfigured") throw new CatalogError("RESOURCE_SCOPE_MISMATCH");
            if (catalog.store.getCommandReceipt("host-bootstrap", "catalog-legacy-default")) throw new CatalogError("CATALOG_BOOTSTRAP_CONFLICT");
            const id = randomUUID();
            catalog.store.createSession(workspace.canonicalRoot, provider.provider, id);
            catalog.db.prepare("UPDATE sessions SET workspace_id=? WHERE id=?").run(workspace.workspaceId, id);
            catalog.db.prepare("INSERT INTO session_catalog VALUES(?,?,?,NULL,'unloaded',NULL)").run(id, provider.providerInstanceId, input.title);
            catalog.setLegacyDefaultOnce(id);
            const at = new Date().toISOString();
            const summary = { ...publicSessionSummary(catalog.requireSession(id)), revision: 1, headSequence: 1, updatedAt: at };
            catalog.store.commitCommand({ sessionId: id, expectedRevision: 0, occurredAt: at, build: () => ({ result: summary, events: [{ type: "session.created", payload: { sessionId: id, ...input } }], receipts: [{ authSubjectId: "host-bootstrap", commandId: "catalog-legacy-default", method: "session.createNew", requestHash: hashCatalogRequest("session.createNew", input, { workspaceId: workspace.workspaceId, providerInstanceId: provider.providerInstanceId, provider: provider.provider }), requestFormatVersion: 2, targetSessionId: id, state: "completed", response: summary }] }) });
        }
        owner.assertActive();
    })();
    return { catalog, workspaces, providers };
}
