import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlledRestore } from "./controlled-restore.js";
import type { CheckpointGitDriver } from "./git-driver.js";
import type { CheckpointManifest } from "./types.js";
import type { RootIdentity } from "./revert-types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function identity(path: string): RootIdentity {
  const stat = statSync(path);
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}

describe("controlled restore producer path canonicalization", () => {
  it("hands the managed runner a canonical temp root even when TMPDIR is a symlink alias", async () => {
    // macOS `tmpdir()` routinely returns a /var -> /private/var alias. The
    // managed Git runner refuses non-canonical cwd/workspace paths, so the
    // restore producer must canonicalize its mkdtemp root before journalling.
    const base = await realpath(await mkdtemp(join(tmpdir(), "flyx-restore-alias-")));
    roots.push(base);
    const real = join(base, "real"), alias = join(base, "alias");
    await mkdir(real);
    await symlink(real, alias);
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = alias;
    try {
      const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // the empty tree
      const workspaces: string[] = [];
      const restore = new ControlledRestore({
        runGit: async (request) => {
          // Mirror the production managed runner's canonicalDirectory gate.
          expect(realpathSync(request.cwd)).toBe(request.cwd);
          expect(request.cwd.startsWith(real + "/")).toBe(true);
          workspaces.push(request.cwd);
          if (request.args[0] === "read-tree") await writeFile(request.env.GIT_INDEX_FILE!, Buffer.alloc(0));
          return { stdout: Buffer.from(`${request.args[0] === "write-tree" ? tree : ""}\n`), exitCode: 0 };
        },
      });
      const driver = {
        verify: async () => tree,
        listTree: async () => [],
      } as unknown as CheckpointGitDriver;
      const manifest = { checkpointId: "fixture-checkpoint" } as unknown as CheckpointManifest;
      const prepared = await restore.prepareIndex(driver, manifest, {
        workspace: identity(real), gitDirectory: identity(real), gitEntry: { kind: "absent" },
      });
      expect(prepared.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(workspaces).not.toHaveLength(0);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  });
});
