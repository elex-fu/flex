import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CATALOG_CAPABILITY, SessionSnapshotV2Schema } from "@flyx/mvp-protocol";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openOwned, openReadOnly } from "../storage/open-store.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { legacyProviderInstanceId, legacyWorkspaceId } from "../storage/migrations/007-catalog.js";
import { FROZEN_V6_SCHEMA } from "../test-support/frozen-v6-schema.js";
import { createHostCatalogBindings, type CatalogRpcContext, type HostCatalogOptions } from "./host-catalog.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const legacyIds = ["old-claude-session", "newer-codex-session"];
function database(legacy = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-catalog-boot-")));
    roots.push(root);
    const checkout = join(root, "checkout");
    const providerRoot = join(checkout, "app");
    mkdirSync(providerRoot, { recursive: true });
    execFileSync("git", ["init", "--quiet", checkout]);
    const data = join(root, "data");
    mkdirSync(data);
    const ownerOptions = { databasePath: join(data, "host.sqlite"), identityDirectory: join(data, "identity"), coordinationDirectory: join(root, "coordination") };
    const owner = HostOwnerLock.acquire(ownerOptions);
    if (legacy) {
        const raw = new Database(owner.databasePath);
        try {
            raw.exec(FROZEN_V6_SCHEMA);
            for (const [index, provider] of (["claude", "codex"] as const).entries()) {
                const at = `2026-10-${13 + index}T00:00:00.000Z`;
                raw.prepare(`INSERT INTO sessions(id,workspace_id,workspace_path,provider,provider_session_id,status,activity_state,head_sequence,created_at,updated_at)
                    VALUES(?,'default',?,?,?,'active','idle',1,?,?)`).run(legacyIds[index], providerRoot, provider, `native-${provider}`, at, at);
                raw.prepare("INSERT INTO session_events(session_id,sequence,id,type,payload_json,occurred_at) VALUES(?,1,?,'assistant.message',?,?)")
                    .run(legacyIds[index], `original-event-${provider}`, JSON.stringify({ text: `history-${provider}` }), at);
            }
            expect(inspectSchema(raw).version).toBe(6);
        } finally { raw.close(); }
    }
    const store = openOwned({ databasePath: owner.databasePath, owner });
    cleanups.push(() => { if (store.db.open) store.close(); owner.release(); });
    store.setHostIdentityMirror({ hostId: "host-one", fingerprint: "a".repeat(64) });
    store.createDevice({ id: "reader", hostId: "host-one", platform: "test", credentialKind: "browser-session", credentialRevision: 1, scopes: ["session:read"], createdAt: new Date().toISOString() });
    const workspaceId = legacy ? legacyWorkspaceId(providerRoot) : "workspace-one";
    const providerId = (provider: "claude" | "codex") => legacy ? legacyProviderInstanceId(provider) : `instance-${provider}`;
    const configuration = { workspaces: [{ workspaceId, root: providerRoot }], providerInstances: (["claude", "codex"] as const).map((provider) => ({ providerInstanceId: providerId(provider), provider, executable: process.execPath })) };
    const runtimeFactory = vi.fn(() => { throw new Error("Startup must not construct a Provider runtime"); });
    const initialLegacySession = { workspaceId, providerInstanceId: providerId("claude"), title: "Default" };
    return { root, data, checkout, providerRoot, store, owner, ownerOptions, workspaceId, configuration, runtimeFactory, initialLegacySession };
}
async function catalog(f: ReturnType<typeof database>, options: Partial<HostCatalogOptions> = {}) {
    const host = await createHostCatalogBindings({ owner: f.owner, store: f.store, configuration: f.configuration, initialLegacySession: f.initialLegacySession, runtimeFactory: f.runtimeFactory, ...options });
    cleanups.push(() => host.closeAndWait().then(() => undefined));
    return host;
}
function context(host: Awaited<ReturnType<typeof catalog>>): CatalogRpcContext {
    return { subjectId: "reader", capabilities: new Set([SESSION_CATALOG_CAPABILITY]), assertAuthorized: () => {}, assertSessionScope: (id, scope) => host.assertActorSession("reader", id, scope), subscribe: async () => ({}), access: async () => ({}) };
}

describe("catalog production bootstrap", () => {
    it("creates exactly one bound default on an empty current Store and serves pure legacy reads without a default worker", async () => {
        const f = database();
        expect(inspectSchema(f.store.db).version).toBe(SUPPORTED_SCHEMA_VERSION);
        const host = await catalog(f);
        const id = host.legacySessionId;
        expect(f.store.db.prepare("SELECT s.id,s.workspace_id,c.provider_instance_id FROM sessions s JOIN session_catalog c ON c.session_id=s.id").all())
            .toEqual([{ id, workspace_id: "workspace-one", provider_instance_id: "instance-claude" }]);
        expect(f.store.getCommandReceipt("host-bootstrap", "catalog-legacy-default")).toMatchObject({ targetSessionId: id, method: "session.createNew", state: "completed", requestFormatVersion: 2 });
        expect(host.legacyHost.publicSnapshot().session).toMatchObject({ id, workspaceId: "default" });
        expect(host.legacyHost.checkoutRoot).toBe(f.checkout);
        expect((await host.legacyHost.providerStatus()).runtimeVersion).toBe("unverified");
        expect(host.bootstrap().capabilities).toMatchObject({ streamingText: false, interactiveApprovals: false, interrupt: false });
        expect(host.registry.resolve(id).providerInstance.verification).toEqual({ state: "unverified", capabilities: [] });
        expect(host.registry.loaded(id)).toBeUndefined();
        await host.legacyHost.gitStatus();
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        const legacy = await host.dispatchCatalog({ id: "legacy", method: "session.create", payload: {} }, context(host));
        expect(legacy).toMatchObject({ handled: true, payload: { session: { id } } });
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
        await host.closeAndWait();
        const reopened = await catalog(f);
        expect(reopened.legacySessionId).toBe(id);
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
    });

    it("upgrades actual v6 history, preserves both native identities and uses the explicitly chosen existing default", async () => {
        const f = database(true);
        const host = await catalog(f, { configuration: { ...f.configuration, legacyDefaultSessionId: legacyIds[0] } });
        expect(inspectSchema(f.store.db).version).toBe(SUPPORTED_SCHEMA_VERSION);
        expect(host.legacySessionId).toBe(legacyIds[0]);
        expect(host.registry.list().sessions.map((session) => session.sessionId).sort()).toEqual([...legacyIds].sort());
        for (const [index, provider] of (["claude", "codex"] as const).entries()) {
            const id = legacyIds[index]!;
            expect(host.registry.resolve(id)).toMatchObject({ session: { workspaceId: f.workspaceId, nativeHandle: { provider, nativeSessionId: `native-${provider}`, provenance: "legacy" } }, workspace: { canonicalRoot: f.providerRoot, worktreeRoot: f.checkout, state: "active" }, providerInstance: { verification: { state: "unverified" } } });
            expect(host.registry.readEvents(id).events).toMatchObject([{ id: `original-event-${provider}`, sequence: 1, payload: { text: `history-${provider}` } }]);
            const result = await host.dispatchCatalog({ id: "read", method: "session.getSnapshot", payload: { sessionId: id } }, context(host));
            expect(result.handled).toBe(true);
            if (result.handled) {
                expect(SessionSnapshotV2Schema.parse(result.payload).session.sessionId).toBe(id);
                expect(JSON.stringify(result.payload)).not.toContain(`native-${provider}`);
            }
        }
        expect(host.legacyHost.snapshot().session.id).toBe(legacyIds[0]);
        expect(host.bootstrap().provider).toBe("claude");
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM catalog_runtime_operations").get()).toEqual({ n: 0 });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
    });

    it("does not create a third default or register configuration when migrated Sessions have no explicit default", async () => {
        const f = database(true);
        const before = f.store.db.prepare("SELECT * FROM provider_instances ORDER BY id").all();
        const readOnlyGit = vi.fn(async () => { throw new Error("No configuration query expected"); });
        await expect(catalog(f, { readOnlyGit })).rejects.toMatchObject({ code: "LEGACY_DEFAULT_REQUIRED" });
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
        expect(f.store.db.prepare("SELECT * FROM provider_instances ORDER BY id").all()).toEqual(before);
        expect(f.store.db.prepare("SELECT 1 FROM host_state WHERE key='legacyDefaultSessionId'").get()).toBeUndefined();
        expect(readOnlyGit).not.toHaveBeenCalled();
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        // A failed bootstrap leaves no graph lease and can be retried with a concrete choice.
        expect((await catalog(f, { configuration: { ...f.configuration, legacyDefaultSessionId: legacyIds[0] } })).legacySessionId).toBe(legacyIds[0]);
    });

    it("rejects a raw post-migration Session before inventing resource bindings or creating a default", async () => {
        const f = database();
        f.store.createSession(f.providerRoot, "claude", "unbound-legacy-row");
        const readOnlyGit = vi.fn(async () => { throw new Error("No configuration query expected"); });
        await expect(catalog(f, { readOnlyGit })).rejects.toMatchObject({ code: "CATALOG_SESSION_BINDING_MISSING" });
        expect(f.store.db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "unbound-legacy-row" }]);
        for (const table of ["workspaces", "provider_instances", "session_catalog"])
            expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        expect(readOnlyGit).not.toHaveBeenCalled();
        expect(f.runtimeFactory).not.toHaveBeenCalled();
    });

    it("refuses factory writes on an actual readonly connection without changing schema, identity or data", async () => {
        const f = database();
        f.store.close();
        const before = readFileSync(f.owner.databasePath);
        const readonly = openReadOnly(f.owner.databasePath);
        try {
            const schema = readonly.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
            const readOnlyGit = vi.fn(async () => { throw new Error("No configuration query expected"); });
            await expect(createHostCatalogBindings({ owner: f.owner, store: readonly, configuration: f.configuration, initialLegacySession: f.initialLegacySession, runtimeFactory: f.runtimeFactory, readOnlyGit })).rejects.toThrow("HOST_OWNER_REQUIRED");
            expect(readonly.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
            expect(readonly.getHostIdentityMirror()).toEqual({ hostId: "host-one", fingerprint: "a".repeat(64) });
            expect(readonly.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
            expect(readOnlyGit).not.toHaveBeenCalled();
            expect(f.runtimeFactory).not.toHaveBeenCalled();
        } finally { readonly.close(); }
        expect(readFileSync(f.owner.databasePath)).toEqual(before);
    });
});
