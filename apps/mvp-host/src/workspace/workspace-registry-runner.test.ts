import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { applyCatalogMigration } from "../storage/migrations/007-catalog.js";
import { WorkspaceRegistry, type WorkspaceGitQuery } from "./workspace-registry.js";
const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse())
    close(); for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-registry-query-")));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repo, "tracked"), "initial");
    execFileSync("git", ["-C", repo, "add", "tracked"]);
    execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "initial"]);
    const owner = createTestHostOwner();
    const store = openOwned({ databasePath: ":memory:", owner });
    applyCatalogMigration(store.db);
    const catalog = new CatalogStore(store);
    cleanups.push(() => { catalog.dispose(); store.close(); owner.release(); });
    return { root, repo, owner, store, catalog };
}
describe("tracked Workspace registry Git query seam", () => {
    it("routes only fixed readonly argv with original operation identity and preserves prepared provenance", async () => {
        const f = fixture();
        const runner = vi.fn<WorkspaceGitQuery>(async (input) => ({ stdout: execFileSync("git", [...input.argv], { cwd: input.cwd, encoding: "utf8", timeout: input.timeoutMs, maxBuffer: input.maxBufferBytes }) }));
        const registry = new WorkspaceRegistry(f.catalog, { owner: f.owner, readOnlyGit: runner });
        await registry.registerLocal({ workspaceId: "repo", repositoryId: "repo-id", root: f.repo });
        const generated = join(f.root, "generated");
        execFileSync("git", ["-C", f.repo, "worktree", "add", "--quiet", "--detach", generated, "HEAD"]);
        const prepared = await registry.prepareWorktreeRegistration({ workspaceId: "generated-id", repositoryId: "repo-id", root: generated, operationId: "original-operation" });
        expect(runner).toHaveBeenCalledTimes(4);
        for (const [query] of runner.mock.calls) {
            expect(query.argv.slice(0, 4)).toEqual(["-c", "core.fsmonitor=false", "-C", query.cwd]);
            expect(query.maxBufferBytes).toBe(16 * 1024);
            expect(query.timeoutMs).toBe(5000);
            expect(Object.isFrozen(query.argv)).toBe(true);
        }
        expect(runner.mock.calls.slice(1).every(([query]) => query.operationId === "original-operation")).toBe(true);
        expect(() => registry.commitWorktreeRegistration({ ...prepared }, "original-operation")).toThrow("WORKTREE_REGISTRATION_NOT_PREPARED");
        expect(registry.commitWorktreeRegistration(prepared, "original-operation")).toMatchObject({ workspaceId: "generated-id", registrationOperationId: "original-operation", worktreeRoot: realpathSync(generated) });
    });
    it("rejects an unbounded helper result before publishing a configured root", async () => {
        const f = fixture();
        const registry = new WorkspaceRegistry(f.catalog, { owner: f.owner, readOnlyGit: async () => ({ stdout: "x".repeat(16 * 1024 + 1) }) });
        await expect(registry.registerLocal({ workspaceId: "invalid", root: f.repo })).rejects.toMatchObject({ code: "WORKSPACE_GIT_OUTPUT_INVALID" });
        expect(f.catalog.workspace("invalid")).toBeUndefined();
    });
});
