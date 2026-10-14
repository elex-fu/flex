import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const distRoot = resolve(webRoot, "dist");

function buildWeb(): void {
  if (process.env.FLYX_SKIP_WEB_BUILD === "1" && existsSync(resolve(distRoot, "index.html"))) return;
  const result = spawnSync("pnpm", ["--filter", "@flyx/mvp-web", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("mvp-web build failed; cannot start browser E2E");
}

function prepareFixtureWorkspace(): string | undefined {
  if (process.env.FLYX_WORKSPACE) {
    const root = realpathSync(process.env.FLYX_WORKSPACE);
    const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== root) throw new Error("FLYX_WORKSPACE must be its own Git fixture root");
    return undefined;
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "flyx-browser-fixture-"));
  const workspace = resolve(temporary, "workspace");
  const result = spawnSync(process.execPath, [resolve(repoRoot, "scripts/provision-fixture-workspace.mjs"), workspace], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) { rmSync(temporary, { recursive: true, force: true }); throw new Error("Failed to provision isolated E2E fixture"); }
  process.env.FLYX_WORKSPACE = workspace;
  return temporary;
}

function startDeterministicHost(): { child: ChildProcess } {
  const child = spawn(
    "pnpm",
    ["--filter", "@flyx/mvp-host", "exec", "tsx", "src/test-support/e2e-main.ts"],
    {
      cwd: repoRoot,
      env: { ...process.env, FLYX_WEB_ROOT: distRoot, FLYX_E2E_ROOT: resolve(repoRoot, ".flyx-e2e") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffered = "";
  child.stdout!.setEncoding("utf8");
  child.on("exit", (code, signal) => {
    if (!process.env.FLYX_E2E_BASE_URL) {
      throw new Error(`deterministic Host exited before becoming ready (code=${code} signal=${signal}): ${buffered}`);
    }
  });
  return { child };
}

function waitForHostReady(child: ChildProcess): Promise<{ baseUrl: string; token: string; tokens: string[]; pid?: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`deterministic Host did not report readiness in 30s; stdout: ${buffered}`));
    }, 30_000);
    const onData = (chunk: string): void => {
      buffered += chunk;
      const match = /^FLYX_E2E_HOST_READY base=(\S+) token=(\S+)(?: tokens=([\S]+))?(?: pid=(\d+))?\s*$/m.exec(buffered);
      if (match) {
        clearTimeout(timeout);
        child.stdout!.off("data", onData);
        const tokens = match[3] ? match[3].split(",") : [match[2]!];
        resolvePromise({ baseUrl: match[1]!, token: match[2]!, tokens, ...(match[4] ? { pid: Number(match[4]) } : {}) });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { process.stderr.write(`[e2e-host] ${chunk}`); });
  });
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  buildWeb();
  const fixtureTemporary = prepareFixtureWorkspace();
  const { child } = startDeterministicHost();
  const { baseUrl, token, tokens, pid } = await waitForHostReady(child);
  // Env mutations here propagate to every test worker.
  process.env.FLYX_E2E_BASE_URL = baseUrl;
  process.env.FLYX_E2E_PAIRING_TOKEN = token;
  process.env.FLYX_E2E_PAIRING_TOKENS = JSON.stringify(tokens);
  // The resilience specs SIGKILL the Host process and respawn it with the
  // exact same command line.  globalSetup and the test workers are separate
  // processes, so the handle is passed through the environment instead of a
  // shared module.  `pid` is the real server process printed by e2e-main
  // (killing the pnpm wrapper would leave the server orphaned and listening).
  process.env.FLYX_E2E_HOST_PID = pid ? String(pid) : String(child.pid ?? "");
  process.env.FLYX_E2E_HOST_CMD = JSON.stringify({
    command: "pnpm",
    args: ["--filter", "@flyx/mvp-host", "exec", "tsx", "src/test-support/e2e-main.ts"],
    cwd: repoRoot,
    env: { FLYX_WEB_ROOT: distRoot, FLYX_E2E_ROOT: resolve(repoRoot, ".flyx-e2e"), FLYX_WORKSPACE: process.env.FLYX_WORKSPACE! },
  });
  // A file-based claim counter survives worker restarts (Playwright recycles
  // the worker after a failed test, which would otherwise reset in-memory
  // token queues and hand out already-consumed tokens).
  const claimFile = resolve(repoRoot, ".flyx-e2e", "token-claims.txt");
  mkdirSync(dirname(claimFile), { recursive: true });
  writeFileSync(claimFile, "");
  process.env.FLYX_E2E_CLAIM_FILE = claimFile;

  return async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise();
        }, 10_000);
        child.on("exit", () => { clearTimeout(timeout); resolvePromise(); });
      });
    }
    if (fixtureTemporary) rmSync(fixtureTemporary, { recursive: true, force: true });
  };
}
