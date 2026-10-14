import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
test("production restart launches only a fixed artifact and preserves management args", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-built-start-")));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "apps/mvp-host/dist"), { recursive: true });
    await mkdir(join(root, "apps/mvp-web/dist"), { recursive: true });
    await mkdir(join(root, "bin"));
    await copyFile(new URL("./start-host.sh", import.meta.url), join(root, "scripts/start-host.sh"));
    await writeFile(join(root, "apps/mvp-host/dist/main.js"), "");
    await writeFile(join(root, "apps/mvp-web/dist/index.html"), "");
    await writeFile(join(root, "bin/node"), '#!/bin/bash\nif [[ "$1" == "-e" ]]; then exit 0; fi\nprintf "%s\\n" "$@" > "$FLYX_CAPTURE"\nprintf "%s\\n" "$FLYX_PROVIDER" "$FLYX_DB" >> "$FLYX_CAPTURE"\n');
    await chmod(join(root, "bin/node"), 0o755);
    for (const command of ["pnpm", "corepack", "npm"]) {
      await writeFile(join(root, "bin", command), '#!/bin/bash\nprintf "unexpected bootstrap" > "$FLYX_BAD_CAPTURE"\nexit 91\n');
      await chmod(join(root, "bin", command), 0o755);
    }
    const capture = join(root, "capture");
    const bad = join(root, "bad");
    await exec("/bin/bash", [join(root, "scripts/start-host.sh"), "doctor", "--json"], {
      env: { ...process.env, PATH: join(root, "bin") + ":/usr/bin:/bin", FLYX_PROVIDER: "codex", FLYX_CAPTURE: capture, FLYX_BAD_CAPTURE: bad, FLYX_SKIP_BUILD: "0", FLYX_SKIP_INSTALL: "0" },
    });
    assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [join(root, "apps/mvp-host/dist/main.js"), "doctor", "--json", "codex", join(root, ".flyx/mvp-codex.sqlite")]);
    await assert.rejects(readFile(bad), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("missing artifact fails without bootstrapping", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-missing-start-")));
  try {
    await mkdir(join(root, "scripts"));
    await copyFile(new URL("./start-host.sh", import.meta.url), join(root, "scripts/start-host.sh"));
    await assert.rejects(exec("/bin/bash", [join(root, "scripts/start-host.sh"), "help"]), (error) => {
      assert.match(error.stderr, /Built Host artifact is missing/);
      return error.code === 1;
    });
    await assert.rejects(readFile(join(root, "node_modules/package.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
