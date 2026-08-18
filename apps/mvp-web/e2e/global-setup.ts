import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function startDeterministicHost(): { child: NodeJS.ChildProcess } {
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

function waitForHostReady(child: NodeJS.ChildProcess): Promise<{ baseUrl: string; token: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`deterministic Host did not report readiness in 30s; stdout: ${buffered}`));
    }, 30_000);
    const onData = (chunk: string): void => {
      buffered += chunk;
      const match = /^FLYX_E2E_HOST_READY base=(\S+) token=(\S+)(?: tokens=([\S]+))?\s*$/m.exec(buffered);
      if (match) {
        clearTimeout(timeout);
        child.stdout!.off("data", onData);
        const tokens = match[3] ? match[3].split(",") : [match[2]!];
        resolvePromise({ baseUrl: match[1]!, token: match[2]!, tokens });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { process.stderr.write(`[e2e-host] ${chunk}`); });
  });
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  buildWeb();
  const { child } = startDeterministicHost();
  const { baseUrl, token, tokens } = await waitForHostReady(child);
  // Env mutations here propagate to every test worker.
  process.env.FLYX_E2E_BASE_URL = baseUrl;
  process.env.FLYX_E2E_PAIRING_TOKEN = token;
  process.env.FLYX_E2E_PAIRING_TOKENS = JSON.stringify(tokens);
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
  };
}
