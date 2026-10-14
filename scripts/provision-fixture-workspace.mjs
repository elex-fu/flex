import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureSource = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/claude-fixtures");

function git(root, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Fixture git " + args[0] + " failed: " + result.stderr);
  return result.stdout.trim();
}

async function markerExists(root) {
  try {
    const marker = await lstat(join(root, ".git"));
    if (!marker.isDirectory() && !marker.isFile()) throw new Error("Fixture .git must be a repository directory or worktree marker");
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

/** A clean checkout tracks the fixture source, but has no nested Git metadata. */
export async function ensureFixtureRepository(path = fixtureSource) {
  const root = await realpath(path);
  const existing = await markerExists(root);
  if (!existing) {
    git(root, ["init", "--initial-branch=main", "."]);
  }
  const top = await realpath(git(root, ["rev-parse", "--show-toplevel"]));
  if (top !== root) throw new Error("Fixture must be its own Git root; refusing to use parent repository " + top);
  if (!existing) {
    const hooks = join(root, ".git", "flyx-empty-hooks");
    await mkdir(hooks);
    git(root, ["add", "--", "README.md", "package.json", "src", "test", "scripts"]);
    git(root, ["-c", "user.name=Flyx fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=" + hooks, "commit", "-m", "chore: deterministic fixture baseline"]);
  }
  return root;
}

/** Copy into a new destination; existing fixtures and their history are never reset. */
export async function copyFixtureWorkspace(destination, source = fixtureSource) {
  const root = resolve(destination);
  try {
    await lstat(root);
    throw new Error("Fixture destination already exists; refusing to overwrite " + root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(source, root, { recursive: true, force: false, errorOnExist: true,
    filter: (path) => ![".git", "node_modules"].includes(path.split(/[\\/]/).at(-1)) });
  return ensureFixtureRepository(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? await copyFixtureWorkspace(process.argv[2]) : await ensureFixtureRepository();
  console.log("Fixture workspace ready: " + root);
}
