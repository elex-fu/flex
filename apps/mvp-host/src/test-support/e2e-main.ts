import { mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createHostServer } from "../server.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import type { ClaudeAdapter } from "../claude/adapter.js";
import { DeterministicAdapter } from "./deterministic-adapter.js";

/**
 * Standalone E2E Host entry.  Runs the exact production server stack with a
 * DeterministicAdapter instead of the Claude SDK, a throwaway SQLite database
 * and a random loopback port.  Playwright's global setup spawns this file and
 * reads the `FLYX_E2E_HOST_READY` marker line from stdout to learn the base
 * URL and the one-time pairing token.
 *
 * Required environment:
 *   FLYX_WEB_ROOT  absolute path to the built web app (mvp-web/dist)
 * Optional environment:
 *   FLYX_WORKSPACE git fixture workspace (defaults to packages/claude-fixtures)
 *   FLYX_E2E_ROOT  scratch directory for the throwaway database (defaults to
 *                  <repo>/.flyx-e2e, recreated on every start)
 *   FLYX_E2E_KEEP_DATA  when "1", keep the existing scratch directory and
 *                  SQLite database across restarts (crash-recovery specs
 *                  SIGKILL this process and respawn it to verify durable
 *                  recovery); startup and shutdown cleanup are skipped
 */

// The browser talks to the loopback HTTP listener directly; without this flag
// the cookie layer would mark the session cookie `Secure` and drop it.
process.env.FLYX_ALLOW_INSECURE_HTTP = "1";

const repoRoot = resolve(process.cwd(), "../..");
const workspace = realpathSync(resolve(process.env.FLYX_WORKSPACE ?? resolve(repoRoot, "packages/claude-fixtures")));
const e2eRoot = resolve(process.env.FLYX_E2E_ROOT ?? resolve(repoRoot, ".flyx-e2e"));
const webRoot = process.env.FLYX_WEB_ROOT;
const keepData = process.env.FLYX_E2E_KEEP_DATA === "1";

if (!webRoot) {
  console.error("FLYX_WEB_ROOT is required; build mvp-web first (pnpm --filter @flyx/mvp-web build)");
  process.exit(1);
}

if (!keepData) {
  await rm(e2eRoot, { recursive: true, force: true });
}
await mkdir(dirname(resolve(e2eRoot, "host.sqlite")), { recursive: true });

// The injected deterministic adapter must feed its events through the same
// durable pipeline as the built-in ClaudeAdapter; wire it after construction
// because the orchestrator needs the adapter in its own constructor.
let orchestratorRef: SessionOrchestrator | undefined;
const adapter = new DeterministicAdapter({
  workspace,
  onEvent: (event) => orchestratorRef?.ingestAdapterEvent(event),
});
const orchestrator = new SessionOrchestrator({
  workspace,
  databasePath: resolve(e2eRoot, "host.sqlite"),
  adapter: adapter as unknown as ClaudeAdapter,
});
orchestratorRef = orchestrator;
const server = createHostServer({
  orchestrator,
  pairingConfirmation: async () => true,
  webRoot,
  port: 0,
});
const address = await server.start();

// Every pairing exchange consumes a one-time grant, so mint one fresh token
// per browser test (plus slack) and print them for the global setup to hand
// out. The primary server token stays first for backwards compatibility.
const mintedTokens = [server.auth.pairingUrlToken];
const grantExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
for (let index = 0; index < 24; index += 1) {
  const token = randomBytes(24).toString("base64url");
  orchestrator.store.createPairingGrant(createHash("sha256").update(token).digest("hex"), grantExpiry);
  mintedTokens.push(token);
}
console.log(`FLYX_E2E_HOST_READY base=${address} token=${server.auth.pairingUrlToken} tokens=${mintedTokens.join(",")} pid=${process.pid}`);

const shutdown = async () => {
  try {
    await server.stop();
  } finally {
    orchestrator.close();
    if (!keepData) await rm(e2eRoot, { recursive: true, force: true });
    process.exit(0);
  }
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
