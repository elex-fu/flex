import { mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { createHostServer } from "../server.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import type { ClaudeAdapter } from "../claude/adapter.js";
import { writeTestReadiness } from "../diagnostics/test-readiness.js";
import { DeterministicAdapter } from "./deterministic-adapter.js";
import { rawGitServiceRunner } from "./managed-git-fixtures.js";

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
const databasePath = resolve(e2eRoot,"host-data/host.sqlite");
const identityDirectory = resolve(e2eRoot,"host-data/identity");
const coordinationDirectory = resolve(e2eRoot,"coordination");
await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
const ownerOptions = { databasePath,identityDirectory,coordinationDirectory };
if (keepData) {
  // SIGKILL recovery may proceed only after the original process birth is proved exited.
  const maintenance = HostOwnerLock.acquire({...ownerOptions,mode:"maintenance",reclaimStale:true});
  maintenance.release();
}
const owner = HostOwnerLock.acquire(ownerOptions);
const store = openOwned({databasePath:owner.databasePath,owner});

// The injected deterministic adapter must feed its events through the same
// durable pipeline as the built-in ClaudeAdapter; wire it after construction
// because the orchestrator needs the adapter in its own constructor.
let orchestratorRef: SessionOrchestrator | undefined;
const adapter = new DeterministicAdapter({
  workspace,
  onEvent: (event) => orchestratorRef?.ingestAdapterEvent(event),
  scenarios:[{id:"large-body",steps:[{kind:"text",text:"bounded browser body start\n"+"fixture-body-line\n".repeat(20_000)+"bounded browser body end"}],result:"bounded browser body completed"}],
});
const orchestrator = new SessionOrchestrator({
  workspace,
  databasePath: owner.databasePath, identityDirectory: owner.identityDirectory!, owner, store,
  // The fixture has only tracked in-process scenarios, never native OS producers.
  canReleaseWorkspace: () => true,
  adapter: adapter as unknown as ClaudeAdapter,
  // The deterministic E2E host has no managed execution backend; the test-only
  // raw runner keeps the legacy Workspace Diff read available. Production
  // composes this from the managed runner and never spawns Git directly.
  gitRunner: rawGitServiceRunner(),
});
orchestratorRef = orchestrator;
const server = createHostServer({
  orchestrator,
  pairingConfirmation: async () => true,
  webRoot,
  port: 0,
});
const address = await server.start();
if (process.env.FLYX_TEST_CONTROLLED_ENTRY === "1" && process.env.FLYX_TEST_READINESS_PATH) {
  await writeTestReadiness({ path: process.env.FLYX_TEST_READINESS_PATH, baseUrl: address,
    pairingToken: server.auth.pairingUrlToken, provider: "deterministic" });
}

// Every pairing exchange consumes a one-time grant, so mint one fresh token
// per browser test (plus slack) and print them for the global setup to hand
// out. The primary server token stays first for backwards compatibility.
const mintedTokens = [server.auth.pairingUrlToken];
const grantExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
for (let index = 0; index < 63; index += 1) {
  const token = randomBytes(32).toString("base64url");
  orchestrator.store.createPairingGrant(createHash("sha256").update(token).digest("hex"), grantExpiry);
  mintedTokens.push(token);
}
console.log(`FLYX_E2E_HOST_READY base=${address} token=${server.auth.pairingUrlToken} tokens=${mintedTokens.join(",")} pid=${process.pid}`);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => shutdownPromise ??= (async () => {
  try {
    await server.stop();
    const report = await orchestrator.closeAndWait();
    if (!report.clean) throw new Error("E2E_SHUTDOWN_UNVERIFIED");
    if (!keepData) await rm(e2eRoot, { recursive: true, force: true });
    process.exit(0);
  } catch {
    console.error("E2E_SHUTDOWN_UNVERIFIED");
    process.exit(1);
  }
})();
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
