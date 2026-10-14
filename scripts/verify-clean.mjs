import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm } from "./verification-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectories = new Set([
  ".git", "node_modules", ".pnpm-store", "dist", "dist-types", ".vite", ".vite-temp",
  ".flyx", ".flyx-dev", ".flyx-e2e", ".flyx-e2e-debug", ".flyx-evidence", ".artifacts", "playwright-report",
]);
const vitestPackages = ["mvp-protocol", "secure-channel", "client-core", "mvp-relay", "mvp-host"];

export async function copyCleanWorkspace(source, destination) {
  const target = relative(source, destination);
  assert(target.startsWith(".." + sep) || isAbsolute(target), "Clean-copy destination must be outside the source workspace");
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, filter: (path) => {
    const name = basename(path);
    return !generatedDirectories.has(name) && !name.endsWith(".tsbuildinfo") && !/^\.env(?:\.|$)/.test(name);
  } });
}

export async function discoverProductTests(root) {
  const paths = [];
  for (const name of vitestPackages) {
    const output = runPnpm(["--filter", "@flyx/" + name, "exec", "vitest", "list", "--filesOnly", "--json"], root, { capture: true });
    for (const { file } of JSON.parse(output)) {
      const path = relative(root, file);
      assert(!path.startsWith(".." + sep) && !isAbsolute(path), "Test discovery escaped the clean workspace");
      assert(path.endsWith(".test.ts") && !path.split(sep).includes("dist"), "Discovered a compiled or non-source product test: " + path);
      paths.push(path.split(sep).join("/"));
    }
  }
  for (const file of await readdir(join(root, "apps/mvp-web/test"))) {
    if (file.endsWith(".test.ts")) paths.push("apps/mvp-web/test/" + file);
  }
  assert(paths.length > 0, "No product tests were discovered");
  assert.equal(new Set(paths).size, paths.length, "Product test discovery contains duplicates");
  return paths.sort();
}

export async function assertNoBuiltTests(root) {
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await inspect(child);
      else assert(!/\.test\.(?:[cm]?js|d\.ts)(?:\.map)?$/.test(entry.name), "Production build emitted a test: " + relative(root, child));
    }
  }
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { await inspect(join(root, parent, entry.name, "dist")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

export async function verifyCleanWorkspace() {
  const temporary = await mkdtemp(join(tmpdir(), "flyx-verify-clean-"));
  let root = join(temporary, "workspace");
  try {
    await copyCleanWorkspace(repoRoot, root);
    root = await realpath(root);
    console.log("Verifying clean source copy: " + root);
    runPnpm(["install", "--offline", "--ignore-scripts", "--frozen-lockfile"], root);
    runPnpm(["-r", "rebuild", "better-sqlite3", "esbuild"], root);
    const coldTests = await discoverProductTests(root);
    runPnpm(["build"], root);
    await assertNoBuiltTests(root);
    runPnpm(["typecheck"], root);
    runPnpm(["typecheck:tests"], root);
    const builtTests = await discoverProductTests(root);
    assert.deepEqual(builtTests, coldTests, "Product test discovery changed after building dist");
    runPnpm(["test:product"], root);
    runPnpm(["test:fixtures"], root);
    console.log("Clean verification passed; " + coldTests.length + " product source test files are identical before and after build.");
  } finally {
    if (process.env.FLYX_VERIFY_KEEP_COPY === "1") console.log("Kept verification copy: " + root);
    else await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyCleanWorkspace();
