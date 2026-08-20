import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Process control for the deterministic E2E Host.
 *
 * Playwright's globalSetup and the test workers are separate processes, so
 * the Host handle cannot be shared as module state.  globalSetup exports the
 * server PID (`FLYX_E2E_HOST_PID`, printed by e2e-main in its READY marker
 * because killing the pnpm wrapper would orphan the real server process) and
 * the exact launch command (`FLYX_E2E_HOST_CMD`) through the environment;
 * this module turns them into kill/restart primitives for the resilience
 * specs.
 */

type HostCommand = { command: string; args: string[]; cwd: string; env: Record<string, string> };

export type HostReady = { baseUrl: string; token: string; tokens: string[]; pid: number };

const spawnedHosts: Array<{ child: ChildProcess; pid?: number }> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SIGKILL the current Host server process and wait for it to disappear. */
export async function killHost(): Promise<void> {
  const pid = Number(process.env.FLYX_E2E_HOST_PID);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("FLYX_E2E_HOST_PID is not set; did global setup run?");
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(50);
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  throw new Error(`Host process ${pid} did not exit within 10s after SIGKILL`);
}

/**
 * Start a Host with the same launch command as globalSetup.
 *
 * `keepData: true` sets FLYX_E2E_KEEP_DATA=1 so e2e-main reuses the existing
 * SQLite database (crash-restart persistence).  `keepData: false` recreates
 * the scratch directory, so the token claim counter file is also reset and
 * the freshly minted token pool is published through the environment.
 */
export async function startHost(options: { keepData: boolean }): Promise<HostReady> {
  const command = JSON.parse(process.env.FLYX_E2E_HOST_CMD ?? "null") as HostCommand | null;
  if (!command) throw new Error("FLYX_E2E_HOST_CMD is not set; did global setup run?");
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: {
      ...process.env,
      ...command.env,
      ...(options.keepData ? { FLYX_E2E_KEEP_DATA: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedHosts.push({ child });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    process.stderr.write(`[e2e-host] ${chunk}`);
  });
  const ready = await waitForHostReady(child);
  spawnedHosts[spawnedHosts.length - 1]!.pid = ready.pid;

  process.env.FLYX_E2E_BASE_URL = ready.baseUrl;
  process.env.FLYX_E2E_PAIRING_TOKEN = ready.token;
  process.env.FLYX_E2E_PAIRING_TOKENS = JSON.stringify(ready.tokens);
  process.env.FLYX_E2E_HOST_PID = String(ready.pid);
  if (!options.keepData) {
    const claimFile = process.env.FLYX_E2E_CLAIM_FILE;
    if (claimFile) {
      mkdirSync(dirname(claimFile), { recursive: true });
      writeFileSync(claimFile, "");
    }
  }
  return ready;
}

function waitForHostReady(child: ChildProcess): Promise<HostReady> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`restarted Host did not report readiness in 30s; stdout: ${buffered}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    const onData = (chunk: string | Buffer): void => {
      buffered += chunk;
      const match = /^FLYX_E2E_HOST_READY base=(\S+) token=(\S+)(?: tokens=([\S]+))?(?: pid=(\d+))?\s*$/m.exec(buffered);
      if (match) {
        clearTimeout(timeout);
        child.stdout!.off("data", onData);
        const tokens = match[3] ? match[3].split(",") : [match[2]!];
        const pid = match[4] ? Number(match[4]) : child.pid;
        if (!pid) {
          rejectPromise(new Error("Host READY marker carried no pid"));
          return;
        }
        resolvePromise({ baseUrl: match[1]!, token: match[2]!, tokens, pid });
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", onData);
  });
}

/** Terminate every Host this worker spawned (test afterAll safety net). */
export async function killSpawnedHosts(): Promise<void> {
  for (const { child, pid } of spawnedHosts.splice(0)) {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch { /* already gone */ }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await sleep(50);
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
