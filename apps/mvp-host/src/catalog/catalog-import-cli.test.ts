import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openForMaintenance } from "../storage/open-store.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";
import { SqliteStore } from "../storage/db.js";
import { FROZEN_V6_SCHEMA } from "../test-support/frozen-v6-schema.js";
import { parseCatalogImportCommand, runCatalogImportCli } from "./catalog-import-cli.js";
import { rawWorkspaceGitQuery } from "../test-support/managed-git-fixtures.js";
const cleanups: Array<() => void> = [];
const roots: string[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse())
    cleanup(); for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
const bytes = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
async function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-import-cli-")));
    roots.push(root);
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    execFileSync("git", ["init", "--quiet", checkout]);
    const coordinationDirectory = join(root, "coordination");
    const targetPath = join(root, "target", "host.sqlite");
    const sourcePath = join(root, "source", "host.sqlite");
    const fingerprint = { hostId: "same-host", fingerprint: "a".repeat(64) };
    const owner = HostOwnerLock.acquire({ databasePath: targetPath, identityDirectory: join(root, "target", "identity"), coordinationDirectory, mode: "maintenance" });
    mkdirSync(join(root, "target"), { recursive: true });
    const store = openForMaintenance({ databasePath: targetPath, owner });
    cleanups.push(() => { store.close(); owner.release(); });
    store.setHostIdentityMirror(fingerprint);
    applyCatalogMigration(store.db);
    const catalog = new CatalogStore(store);
    cleanups.push(() => catalog.dispose());
    const workspaces = new WorkspaceRegistry(catalog, { owner, readOnlyGit: rawWorkspaceGitQuery() });
    await workspaces.registerLocal({ workspaceId: "workspace-one", root: checkout });
    new ProviderInstanceRegistry(catalog).registerLocal({ providerInstanceId: "instance-claude", provider: "claude", executable: process.execPath });
    const sourceOwnerOptions = { databasePath: sourcePath, identityDirectory: join(root, "source", "identity"), coordinationDirectory };
    const sourceOwner = HostOwnerLock.acquire(sourceOwnerOptions);
    mkdirSync(join(root, "source"), { recursive: true });
    // The import source is a real legacy v6 file, rather than an incomplete
    // post-007 Session inserted into today's schema.
    const source = new SqliteStore(":memory:", { mode: "test-fixture", fixtureSchema: FROZEN_V6_SCHEMA });
    source.setHostIdentityMirror(fingerprint);
    const session = source.createSession(checkout, "claude", "preserved-session");
    source.commitEvent(session.id, "assistant.message", { text: "preserved source event" });
    source.createDevice({ id: "source-device", hostId: fingerprint.hostId, platform: "test", credentialKind: "browser-session", credentialRevision: 1, scopes: ["session:write"], createdAt: new Date().toISOString() });
    source.createAuthSession("source-private-auth", "2099-01-01");
    writeFileSync(sourcePath, source.db.serialize());
    source.close();
    sourceOwner.release();
    const options = { owner, store, backupDirectory: join(root, "backups") };
    const input = { sourceDatabasePath: sourcePath, legacyWorkspaceByCanonicalRoot: { [checkout]: "workspace-one" }, legacyProviderInstances: { claude: "instance-claude" } };
    return { root, checkout, owner, store, catalog, sourcePath, sourceOwnerOptions, options, input };
}
describe("offline catalog CLI handler", () => {
    it("parses only the bounded local catalog argv contract", () => {
        expect(parseCatalogImportCommand(["start"])).toBeUndefined();
        expect(parseCatalogImportCommand(["catalog", "dry-run", "/source db", "/backup dir"]))
            .toEqual({ kind: "catalog-import", backupDirectory: "/backup dir", request: { mode: "dry-run", sourceDatabasePath: "/source db" } });
        expect(parseCatalogImportCommand(["catalog", "import", "/source", "/backup", "a".repeat(64)]))
            .toEqual({ kind: "catalog-import", backupDirectory: "/backup", request: { mode: "import", sourceDatabasePath: "/source", approvedSourceDigest: "a".repeat(64) } });
        for (const args of [["catalog"], ["catalog", "dry-run", "/source"], ["catalog", "dry-run", "/source", "/backup", "extra"], ["catalog", "import", "/source", "/backup"], ["catalog", "import", "/source", "/backup", "not-a-digest"], ["catalog", "dry-run", "", "/backup"], ["catalog", "dry-run", "bad\0path", "/backup"]])
            expect(() => parseCatalogImportCommand(args)).toThrow("Usage: catalog dry-run");
    });
    it("requires a reviewed digest, revalidates it, backs up and imports only same-Host facts", async () => {
        const f = await fixture();
        const sourceBytes = bytes(f.sourcePath);
        const schema = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
        const dry = await runCatalogImportCli(f.options, { ...f.input, mode: "dry-run" });
        expect(dry.mode).toBe("dry-run");
        expect(dry.plan.sessionIds).toEqual(["preserved-session"]);
        expect(f.catalog.allSessions()).toEqual([]);
        expect(bytes(f.sourcePath)).toBe(sourceBytes);
        expect(existsSync(f.options.backupDirectory)).toBe(false);
        await expect(runCatalogImportCli(f.options, { ...f.input, mode: "import" })).rejects.toMatchObject({ code: "IMPORT_DRY_RUN_REQUIRED" });
        await expect(runCatalogImportCli(f.options, { ...f.input, mode: "import", approvedSourceDigest: "b".repeat(64) })).rejects.toMatchObject({ code: "IMPORT_SOURCE_CHANGED" });
        expect(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        const imported = await runCatalogImportCli(f.options, { ...f.input, mode: "import", approvedSourceDigest: dry.plan.sourceDigest });
        expect(imported.mode).toBe("import");
        if (imported.mode !== "import")
            throw new Error("Expected import result");
        expect(existsSync(imported.result.sourceBackupPath)).toBe(true);
        expect(existsSync(imported.result.targetBackupPath)).toBe(true);
        expect(f.store.listEvents("preserved-session", 0, 100).events[0]?.payload).toEqual({ text: "preserved source event" });
        expect(f.store.getDevice("source-device")).toBeUndefined();
        expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
        expect(bytes(f.sourcePath)).toBe(sourceBytes);
        const retried = await runCatalogImportCli(f.options, { ...f.input, mode: "import", approvedSourceDigest: dry.plan.sourceDigest });
        expect(retried.mode === "import" && retried.result.reused).toBe(true);
    });
    it("aborts a changed source between separate preview and apply invocations", async () => {
        const f = await fixture();
        const dry = await runCatalogImportCli(f.options, { ...f.input, mode: "dry-run" });
        const sourceOwner = HostOwnerLock.acquire(f.sourceOwnerOptions);
        const source = new Database(f.sourcePath);
        source.transaction(() => {
            const at = new Date().toISOString();
            source.prepare("INSERT INTO session_events(id,session_id,sequence,type,payload_json,occurred_at) VALUES('late-source-event','preserved-session',2,'assistant.message',?,?)").run(JSON.stringify({ text: "later source change" }), at);
            source.prepare("UPDATE sessions SET head_sequence=2,revision=revision+1,updated_at=? WHERE id='preserved-session'").run(at);
        })();
        source.close();
        sourceOwner.release();
        await expect(runCatalogImportCli(f.options, { ...f.input, mode: "import", approvedSourceDigest: dry.plan.sourceDigest })).rejects.toMatchObject({ code: "IMPORT_SOURCE_CHANGED" });
        expect(f.catalog.allSessions()).toEqual([]);
        expect(existsSync(f.options.backupDirectory)).toBe(false);
    });
});
