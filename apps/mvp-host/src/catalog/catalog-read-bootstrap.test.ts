import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOUNDED_CONTENT_CAPABILITY, SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, SessionSnapshotV2Schema, ContentChunkSchema } from "@flyx/mvp-protocol";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openOwned, openReadOnly } from "../storage/open-store.js";
import { FROZEN_V6_SCHEMA } from "../test-support/frozen-v6-schema.js";
import { legacyProviderInstanceId, legacyWorkspaceId } from "../storage/migrations/007-catalog.js";
import { HostViews } from "../timeline/host-views.js";
import { JsonTimelineBudget } from "../timeline/contracts.js";
import { catalogRecoveryConfigurationFingerprint } from "../session/catalog-recovery.js";
import { createHostCatalogBindings, createHostCatalogReadBindings, type HostCatalog, type HostCatalogOptions, type CatalogRpcContext } from "./host-catalog.js";

const processes = vi.hoisted(() => ({
    execFile: vi.fn(() => { throw new Error("Subprocess forbidden in SQL bootstrap"); }),
    execFileSync: vi.fn(() => { throw new Error("Subprocess forbidden in SQL bootstrap"); }),
    spawn: vi.fn(() => { throw new Error("Subprocess forbidden in SQL bootstrap"); }),
    execSync: vi.fn(() => { throw new Error("Subprocess forbidden in SQL bootstrap"); }),
}));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), ...processes }));
const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => { for (const process of Object.values(processes)) process.mockClear(); });
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function noProcesses() { for (const process of Object.values(processes)) expect(process).not.toHaveBeenCalled(); }

function fixture(legacy = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-catalog-sql-")));
    roots.push(root);
    const data = join(root, "data");
    mkdirSync(data);
    const missingRoot = join(root, "unavailable-checkout");
    const owner = HostOwnerLock.acquire({ databasePath: join(data, "host.sqlite"), identityDirectory: join(data, "identity"), coordinationDirectory: join(root, "owners") });
    if (legacy) {
        const raw = new Database(owner.databasePath);
        raw.exec(FROZEN_V6_SCHEMA);
        // The pinned schema is DDL only; real migration 006 also stores this singleton.
        raw.prepare("INSERT INTO content_storage_state(id,stored_bytes) VALUES(1,0)").run();
        for (const [index, provider] of (["claude", "codex"] as const).entries()) {
            const id = index === 0 ? "original-claude" : "newer-codex";
            const at = `2026-10-${13 + index}T00:00:00.000Z`;
            raw.prepare("INSERT INTO sessions(id,workspace_id,workspace_path,provider,provider_session_id,status,activity_state,head_sequence,created_at,updated_at) VALUES(?,'default',?,?,?,'active','idle',1,?,?)")
                .run(id, missingRoot, provider, `private-native-${provider}`, at, at);
            raw.prepare("INSERT INTO session_events(id,session_id,sequence,type,payload_json,occurred_at) VALUES(?,?,1,'assistant.message.completed',?,?)")
                .run(`original-event-${provider}`, id, JSON.stringify({ itemId: `item-${provider}`, text: `saved ${provider} history` }), at);
        }
        raw.close();
    }
    const store = openOwned({ databasePath: owner.databasePath, owner });
    cleanups.push(() => { if (store.db.open) store.close(); owner.release(); });
    store.setHostIdentityMirror({ hostId: "host", fingerprint: "a".repeat(64) });
    store.createDevice({ id: "actor", hostId: "host", scopes: ["session:read", "session:write", "approval:write"], platform: "test", credentialKind: "browser-session", credentialRevision: 1, createdAt: new Date().toISOString() });
    const runtimeFactory = vi.fn(() => { throw new Error("Native runtime forbidden"); });
    const readOnlyGit = vi.fn(async () => { throw new Error("Git verification forbidden"); });
    const workspaceId = legacy ? legacyWorkspaceId(missingRoot) : "workspace-one";
    const configuration = { workspaces: [{ workspaceId, root: missingRoot }], providerInstances: (["claude", "codex"] as const).map((provider) => ({ providerInstanceId: legacy ? legacyProviderInstanceId(provider) : `instance-${provider}`, provider, executable: join(root, `missing-${provider}`), policyCapabilities: ["workspaceWrite", "interrupt", "interactiveApprovals"] })) };
    const initialLegacySession = { workspaceId, providerInstanceId: legacy ? legacyProviderInstanceId("claude") : "instance-claude", title: "Default" };
    const options = { store, owner, configuration, initialLegacySession, runtimeFactory, readOnlyGit };
    return { root, data, missingRoot, store, owner, configuration, options, runtimeFactory, readOnlyGit };
}
async function open(f: ReturnType<typeof fixture>, options: Partial<HostCatalogOptions> = {}) {
    const host = await createHostCatalogReadBindings({ ...f.options, ...options });
    cleanups.push(() => host.closeAndWait().then(() => undefined));
    return host;
}
function context(host: HostCatalog, change: Partial<CatalogRpcContext> = {}): CatalogRpcContext {
    return { subjectId: "actor", capabilities: new Set([SESSION_CATALOG_CAPABILITY, TIMELINE_PROJECTION_CAPABILITY, BOUNDED_CONTENT_CAPABILITY]), assertAuthorized: () => {}, assertSessionScope: (id, scope) => host.assertActorSession("actor", id, scope), subscribe: async () => ({}), access: async () => ({}), ...change };
}
async function rpc(host: HostCatalog, method: string, payload: unknown = {}, commandId?: string, ctx = context(host)) {
    const result = await host.dispatchCatalog({ id: "request", method, payload, ...(commandId ? { commandId } : {}) }, ctx);
    if (!result.handled) throw new Error("Expected Catalog route");
    return result.payload;
}

describe("owner-only SQL catalog bootstrap", () => {
    it("atomically seeds complete metadata, serves legacy/Views/content reads and advertises false execution capabilities without subprocesses", async () => {
        const f = fixture();
        let host: HostCatalog | undefined;
        const views = new HostViews(f.store, f.owner, { resolveResource: (id) => host?.viewResource(id), assertSessionAccess: (actor, resource) => host!.assertActorSession(actor.subjectId, resource.sessionId, "session:read") });
        cleanups.push(() => views.close());
        const schema = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
        host = await open(f, { hostViews: views });
        const id = host.legacySessionId;
        expect(f.store.db.prepare("SELECT s.id,s.workspace_id,c.provider_instance_id,c.native_handle_json FROM sessions s JOIN session_catalog c ON c.session_id=s.id").all())
            .toEqual([{ id, workspace_id: "workspace-one", provider_instance_id: "instance-claude", native_handle_json: null }]);
        expect(host.registry.resolve(id).workspace).toMatchObject({ canonicalRoot: f.missingRoot, worktreeRoot: "", checkoutKey: "", state: "needs_verification" });
        expect(host.catalog.provider("instance-claude")).toMatchObject({ state: "unconfigured", verification: { state: "unverified", capabilities: [] } });
        expect(host.legacyHost.bootstrap().capabilities).toMatchObject({ streamingText: false, interactiveApprovals: false, resumeConversation: false, interrupt: false });
        expect((await host.legacyHost.providerStatus()).runtimeVersion).toBe("unverified");
        expect(await host.legacyHost.gitStatus()).toMatchObject({ available: false });
        expect(await host.legacyHost.gitDiff()).toMatchObject({ available: false, diff: "" });
        expect(await rpc(host, "provider.list")).toMatchObject({ providerInstances: [{ provider: "claude", state: "unconfigured" }, { provider: "codex", state: "unconfigured" }] });
        expect(await rpc(host, "session.list")).toMatchObject({ sessions: [{ sessionId: id, nativeSessionAvailable: false }] });
        expect(SessionSnapshotV2Schema.parse(await rpc(host, "session.getSnapshot", { sessionId: id })).session.sessionId).toBe(id);
        expect((await rpc(host, "session.create") as { session: { id: string } }).session.id).toBe(id);
        f.store.commitEvent(id, "assistant.message.completed", { itemId: "history", text: "stored history" });
        const ref = views.content.putBlob({ sessionId: id, format: "text/plain", text: "stored content" });
        const actor = { subjectId: "actor", leaseId: "lease", generation: 1 };
        const connection = views.connect(actor, new JsonTimelineBudget(), () => host!.assertActorSession("actor", id, "session:read"));
        cleanups.push(() => connection.close());
        const opened = connection.openView({ sessionId: id, tailLimit: 20 }, async () => {});
        expect(opened.response.page.items.some((item) => item.itemId === "history")).toBe(true);
        opened.cancel();
        expect(ContentChunkSchema.parse(await rpc(host, "content.getChunk", { sessionId: id, ref: ref.ref }, undefined, context(host, { viewOwner: () => actor }))))
            .toMatchObject({ encoding: "utf8", text: "stored content" });
        expect(f.store.getCommandReceipt("host-bootstrap", "catalog-legacy-default")).toMatchObject({ requestFormatVersion: 2, state: "completed", targetSessionId: id });
        expect(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        await expect(host.registry.ensureLoaded(id)).rejects.toMatchObject({ code: "WORKSPACE_NOT_VERIFIED" });
        await expect(rpc(host, "session.rename", { sessionId: id, expectedRevision: host.registry.get(id).revision, title: "denied" }, "denied")).rejects.toMatchObject({ code: "WORKSPACE_NOT_VERIFIED" });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.readOnlyGit).not.toHaveBeenCalled();
        noProcesses();
    });

    it("rolls the seed, bindings, default, receipt and event back together and permits a clean retry", async () => {
        const f = fixture();
        const remove = f.store.registerCommitHook(() => { throw new Error("bootstrap projection fault"); });
        await expect(open(f)).rejects.toThrow("bootstrap projection fault");
        for (const table of ["sessions", "workspaces", "provider_instances", "session_catalog", "session_events", "command_receipts"])
            expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        expect(f.store.db.prepare("SELECT 1 FROM host_state WHERE key='legacyDefaultSessionId'").get()).toBeUndefined();
        remove();
        expect((await open(f)).legacySessionId).toBeTypeOf("string");
        noProcesses();
    });

    it("reads migrated missing-root Claude/Codex history, redacts original Native handles and never chooses the newer default", async () => {
        const f = fixture(true);
        await expect(open(f, { configuration: {} })).rejects.toMatchObject({ code: "LEGACY_DEFAULT_REQUIRED" });
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
        const host = await open(f, { configuration: { legacyDefaultSessionId: "original-claude" } });
        expect(host.legacySessionId).toBe("original-claude");
        expect(host.legacyHost.bootstrap().provider).toBe("claude");
        expect(host.legacyHost.bootstrap().capabilities.streamingText).toBe(false);
        expect(await rpc(host, "provider.list")).toMatchObject({ providerInstances: [{ provider: "claude", state: "unconfigured" }, { provider: "codex", state: "unconfigured" }] });
        for (const provider of ["claude", "codex"] as const) {
            const id = provider === "claude" ? "original-claude" : "newer-codex";
            expect(host.registry.resolve(id).session.nativeHandle?.nativeSessionId).toBe(`private-native-${provider}`);
            expect(host.registry.readEvents(id).events[0]?.id).toBe(`original-event-${provider}`);
            const snapshot = await rpc(host, "session.getSnapshot", { sessionId: id });
            expect(SessionSnapshotV2Schema.parse(snapshot).session).toMatchObject({ sessionId: id, nativeSessionAvailable: true });
            expect(JSON.stringify(snapshot)).not.toContain("private-native-");
            expect(host.views!.ready(id)).toBe(true);
        }
        host.registry.readSnapshot("newer-codex");
        expect((await rpc(host, "session.create") as { session: { id: string } }).session.id).toBe("original-claude");
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.readOnlyGit).not.toHaveBeenCalled();
        noProcesses();
    });

    it("invalidates readiness while preserving every existing Recovery resource identity and private Native binding", async () => {
        const f = fixture();
        mkdirSync(f.missingRoot);
        const config = { ...f.configuration, providerInstances: f.configuration.providerInstances.map((input) => ({ ...input, executable: process.execPath, config: { model: "original-model" }, policyVersion: 3 })) };
        const trustedFixtureQuery = vi.fn(async () => ({ stdout: f.missingRoot }));
        const previous = await createHostCatalogBindings({ ...f.options, configuration: config, readOnlyGit: trustedFixtureQuery });
        cleanups.push(() => previous.closeAndWait().then(() => undefined));
        previous.providers.recordVerification("instance-claude", { state: "verified", runtimeVersion: "original-proof-version", capabilities: ["workspaceWrite"] });
        f.store.commitEvent(previous.legacySessionId, "provider.init", {}, { providerSessionId: "original-private-native" });
        const workspace = previous.catalog.workspace("workspace-one")!;
        const provider = previous.catalog.provider("instance-claude")!;
        const native = previous.catalog.requireSession(previous.legacySessionId).nativeHandle;
        const fingerprint = catalogRecoveryConfigurationFingerprint(previous.registry.resolve(previous.legacySessionId));
        await previous.closeAndWait();
        rmSync(f.missingRoot, { recursive: true });
        const host = await open(f, { configuration: { ...config, workspaces: [{ workspaceId: "workspace-one", root: "/changed/unverified/root" }], providerInstances: config.providerInstances.map((input) => ({ ...input, executable: "/changed/unverified/executable", policyVersion: 99 })) } });
        expect(host.catalog.workspace("workspace-one")).toEqual({ ...workspace, state: "needs_verification" });
        expect(host.catalog.provider("instance-claude")).toEqual({ ...provider, state: "unconfigured", verification: { ...provider.verification, state: "unverified" } });
        expect(host.catalog.requireSession(host.legacySessionId).nativeHandle).toEqual(native);
        expect(catalogRecoveryConfigurationFingerprint(host.registry.resolve(host.legacySessionId))).toBe(fingerprint);
        expect((await host.legacyHost.providerStatus()).runtimeVersion).toBe("unverified");
        expect(JSON.stringify(await rpc(host, "provider.list"))).not.toContain("original-proof-version");
        expect(host.legacyHost.snapshot().session.providerSessionId).toBe("original-private-native");
        expect(f.readOnlyGit).not.toHaveBeenCalled();
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        noProcesses();
    });

    it("requires separate configuration and contract evidence, then denies stale executable writes before loading a runtime", async () => {
        const f = fixture();
        const host = await open(f);
        mkdirSync(f.missingRoot);
        const executable = join(f.root, "fixture-executable");
        writeFileSync(executable, "#!/bin/sh\nexit 0\n");
        chmodSync(executable, 0o700);
        const config = { ...f.configuration, providerInstances: f.configuration.providerInstances.map((input) => ({ ...input, executable })) };
        const query = vi.fn(async () => ({ stdout: f.missingRoot }));
        await host.revalidateConfiguration(config, { readOnlyGit: query });
        const id = host.legacySessionId;
        await expect(rpc(host, "session.startTurn", { sessionId: id, prompt: "unverified" }, "unverified")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNVERIFIED" });
        await expect(host.registry.ensureLoaded(id)).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNVERIFIED" });
        const verify = vi.fn(() => ({ state: "verified" as const, runtimeVersion: "fixture-contract-proof", capabilities: ["workspaceWrite", "interrupt", "interactiveApprovals"] }));
        await host.revalidateConfiguration(config, { readOnlyGit: query, verifyProviderConfiguration: verify });
        expect(verify).toHaveBeenCalledTimes(2);
        expect(host.assertExecutionResources(id).workspace.worktreeRoot).toBe(f.missingRoot);
        await rpc(host, "session.rename", { sessionId: id, expectedRevision: host.registry.get(id).revision, title: "verified metadata" }, "rename");
        rmSync(executable);
        for (const [method, payload] of [["session.rename", { sessionId: id, expectedRevision: host.registry.get(id).revision, title: "stale" }], ["session.startTurn", { sessionId: id, prompt: "stale" }], ["approval.respond", { sessionId: id, approvalId: "unknown", action: "deny" }]] as const)
            await expect(rpc(host, method, payload, `stale-${method}`)).rejects.toMatchObject({ code: "PROVIDER_EXECUTABLE_CHANGED" });
        await expect(host.registry.ensureLoaded(id)).rejects.toMatchObject({ code: "PROVIDER_EXECUTABLE_CHANGED" });
        expect(SessionSnapshotV2Schema.parse(await rpc(host, "session.getSnapshot", { sessionId: id })).session.title).toBe("verified metadata");
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.readOnlyGit).not.toHaveBeenCalled();
        noProcesses();
    });

    it("does not prepare Native execution for a verified contract lacking execution capability", async () => {
        const f = fixture();
        const host = await open(f);
        mkdirSync(f.missingRoot);
        const config = { ...f.configuration, providerInstances: f.configuration.providerInstances.map((input) => ({ ...input, executable: process.execPath })) };
        await host.revalidateConfiguration(config, { readOnlyGit: async () => ({ stdout: f.missingRoot }), verifyProviderConfiguration: () => ({ state: "verified", runtimeVersion: "fixture-read-contract", capabilities: ["streamingText"] }) });
        await expect(host.registry.ensureLoaded(host.legacySessionId)).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNVERIFIED" });
        await expect(rpc(host, "session.startTurn", { sessionId: host.legacySessionId, prompt: "unsupported" }, "unsupported")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNVERIFIED" });
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        noProcesses();
    });

    it("keeps unbound/readonly/restore-gated Stores fail-closed and does not repair a declared schema", async () => {
        const f = fixture();
        f.store.createSession(f.missingRoot, "claude", "unbound");
        await expect(open(f)).rejects.toMatchObject({ code: "CATALOG_SESSION_BINDING_MISSING" });
        expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
        f.store.close();
        const readonly = openReadOnly(f.owner.databasePath);
        try { await expect(createHostCatalogReadBindings({ ...f.options, store: readonly })).rejects.toThrow("HOST_OWNER_REQUIRED"); }
        finally { readonly.close(); }
        const restored = fixture();
        restored.store.db.prepare("INSERT INTO host_state VALUES('restore_readiness','{}',?)").run(new Date().toISOString());
        await expect(open(restored)).rejects.toMatchObject({ code: "RESTORE_EXTERNAL_STATE_UNVERIFIED" });
        expect(restored.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
        const corrupt = fixture();
        corrupt.store.db.exec("DROP INDEX one_catalog_runtime_close");
        const schema = corrupt.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
        await expect(open(corrupt)).rejects.toThrow("catalog");
        expect(corrupt.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        noProcesses();
    });
});
