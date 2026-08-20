import { mkdir, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { createHostServer } from "./server.js";
import { SessionOrchestrator } from "./session/orchestrator.js";

const workspace = resolve(process.env.FLYX_WORKSPACE ?? resolve(process.cwd(), "packages/claude-fixtures"));
const databasePath = resolve(process.env.FLYX_DB ?? resolve(process.cwd(), ".flyx/mvp.sqlite"));
await mkdir(dirname(databasePath), { recursive: true });
await assertFixtureWorkspace(workspace);
if (process.env.FLYX_REQUIRE_TAILSCALE_SERVE === "1") await assertTailscaleServe();
const orchestrator = new SessionOrchestrator({ workspace, databasePath });
if (process.env.FLYX_SKIP_PREFLIGHT !== "1") {
  try {
    const provider = await orchestrator.adapter.preflight();
    console.log(`Claude preflight passed: SDK ${provider.sdkVersion}, CLI ${provider.claudeVersion}`);
  } catch (error) {
    orchestrator.close();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const pairingConfirmation = createPairingConfirmation();
const server = createHostServer({ orchestrator, pairingConfirmation, ...(process.env.FLYX_WEB_ROOT ? { webRoot: process.env.FLYX_WEB_ROOT } : {}) });
const address = await server.start();
console.log(`Flyx MVP Host listening at ${address}`);
console.log(`Workspace: ${workspace}`);
console.log(`Pairing token: ${server.auth.pairingUrlToken}`);
// The scannable URL is the QR content served by /api/pairing/qrcode; print it
// verbatim so the terminal alone is enough to pair a phone (QR + text token
// fallback per the design doc 5.7).
console.log(`Pairing URL: ${address}/?pair=${server.auth.pairingUrlToken}`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function createPairingConfirmation(): () => Promise<boolean> {
  // A Host started from a terminal requires an explicit local approval before
  // a browser credential is minted.  Non-interactive service runners have no
  // person who can answer, so they fail closed unless the operator explicitly
  // opts into `FLYX_REQUIRE_PAIRING_CONFIRM=0` for a controlled test setup.
  if (process.env.FLYX_REQUIRE_PAIRING_CONFIRM === "0") return async () => true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return async () => false;
  return async () => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await readline.question("Approve this phone pairing? [y/N] ");
      return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    } finally {
      readline.close();
    }
  };
}

async function assertFixtureWorkspace(root: string): Promise<void> {
  try {
    const marker = await stat(resolve(root, ".git"));
    if (!marker.isDirectory() && !marker.isFile()) throw new Error("not a Git repository");
  } catch (error) {
    throw new Error(`FLYX_WORKSPACE must be an existing Git fixture repository: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertTailscaleServe(): Promise<void> {
  const execFile = promisify(execFileCallback);
  try {
    const result = await execFile("tailscale", ["serve", "status"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    if (!result.stdout.trim() && !result.stderr.trim()) throw new Error("empty Serve status");
  } catch (error) {
    throw new Error(`Tailscale Serve is required but unavailable; configure HTTPS/WSS first: ${error instanceof Error ? error.message : String(error)}`);
  }
}
