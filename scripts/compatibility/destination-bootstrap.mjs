#!/usr/bin/env node
// M4 destination-host bootstrap: initializes a dedicated destination Host
// (identity + mirror + default provider instance registered with the measured
// executable realpath) without any model call, version probe or activation.
// Usage: node scripts/compatibility/destination-bootstrap.mjs --destination <dir> --provider claude --executable <path>
import { execFile as execFileRaw } from "node:child_process";
import { createServer } from "node:net";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function dirname(path) { const parts = String(path).split("/"); parts.pop(); return parts.join("/") || "/"; }
const execFile = promisify(execFileRaw);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

function parseArgs(argv) {
  const options = { destination: undefined, provider: "claude", executable: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === "--destination") options.destination = value;
    else if (flag === "--provider") options.provider = value;
    else if (flag === "--executable") options.executable = value;
    else fail("BOOTSTRAP_USAGE");
  }
  if (!options.destination?.startsWith("/") || !["claude", "codex"].includes(options.provider)
    || !options.executable?.startsWith("/")) fail("BOOTSTRAP_USAGE");
  return options;
}

async function reservePort() {
  return await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const destination = resolve(options.destination);
const provider = options.provider;
// The provider record must store the executable realpath: destination
// activation compares the signed artifact's executablePath against it with
// strict equality, and the ordinary-start metadata bootstrap persists the
// configured path verbatim (it never resolves executables by design).
const executable = realpathSync(options.executable);
// Same privacy-contract layout as the isolated source run: the DB lives in a
// sibling state/ directory of the workspace, never in an ancestor, so the
// activation CLI's managed Git query and workspace privacy checks accept the
// destination workspace.
const database = join(destination, "state", "host.sqlite");

await rm(destination, { recursive: true, force: true });
await rm(join(destination, "..", "destination-worktrees"), { recursive: true, force: true });
await mkdir(destination, { recursive: true, mode: 0o700 });
await chmod(destination, 0o700);
await mkdir(join(destination, "web"), { recursive: true, mode: 0o700 });

// Offline maintenance step: clear stale owner records for this destination's
// resource keys only when the recorded process is provably dead.
const coordinationDirectory = join(tmpdir(), "flyx-owners-" + (process.getuid?.() ?? "user"));
for (const resourceKey of ["db:" + database, "identity:" + join(destination, "identity")]) {
  const ownerPath = join(coordinationDirectory, createHash("sha256").update(resourceKey).digest("hex") + ".owner");
  try {
    const record = JSON.parse(readFileSync(ownerPath, "utf8"));
    const pid = record?.process?.pid;
    if (typeof pid !== "number") throw new Error("DESTINATION_OWNER_RECORD_INVALID");
    process.kill(pid, 0); // throws ESRCH when the recorded owner is dead
    const error = new Error("DESTINATION_OWNER_STILL_ALIVE:" + pid); error.code = "DESTINATION_OWNER_STILL_ALIVE"; throw error;
  } catch (error) {
    if (error.code === "DESTINATION_OWNER_STILL_ALIVE" || error.message === "DESTINATION_OWNER_RECORD_INVALID") throw error;
    // ENOENT (no record) or ESRCH (recorded owner exited): safe to clear.
    try { unlinkSync(ownerPath); } catch { /* already absent */ }
  }
}
const workspace = join(destination, "workspace");
await rm(workspace, { recursive: true, force: true });
await cp(join(ROOT, "packages/claude-fixtures"), workspace, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes(".git") });
await execFile("git", ["init", "--quiet", workspace]);
await execFile("git", ["-C", workspace, "add", "."]);
await execFile("git", ["-C", workspace, "-c", "user.name=Flyx destination", "-c", "user.email=destination@localhost", "commit", "--quiet", "-m", "destination fixture"]);

// The M4 basic scene (flyx-c3-basic-v1) publishes only the capabilities its
// source run actually exercised: the `turn` baseline. Per design §6.3 import
// never endorses capabilities the scene did not run, so the destination
// requests exactly the verified scope (streamingText) instead of the full
// default policy; interrupt/approval/reconnect arrive with their own scenes.
const catalogConfigPath = join(destination, "catalog-config.json");
await writeFile(catalogConfigPath, JSON.stringify({
  workspaces: [{ workspaceId: "default-workspace", root: workspace, capabilities: ["streamingText"] }],
  providerInstances: [{ providerInstanceId: `default-${provider}`, provider, executable, policyCapabilities: ["streamingText"] }],
}) + "\n", { mode: 0o600 });
await chmod(catalogConfigPath, 0o600);

// A short ordinary (non-isolated) Host start: it creates the schema, the
// identity + mirror and registers the default provider instance. No model,
// version probe or activation runs during ordinary startup.
const entry = join(ROOT, "apps/mvp-host/dist/main.js");
const child = spawn(process.execPath, [entry], {
  cwd: join(ROOT, "apps/mvp-host"),
  env: {
    ...process.env,
    PORT: String(await reservePort()),
    FLYX_CATALOG_CONFIG: catalogConfigPath,
    FLYX_PROVIDER: provider,
    FLYX_WORKSPACE: workspace,
    FLYX_DB: database,
    FLYX_IDENTITY_DIR: join(destination, "identity"),
    FLYX_WEB_ROOT: join(destination, "web"),
    FLYX_WORKTREES_ROOT: join(destination, "..", "destination-worktrees"),
    FLYX_ALLOW_INSECURE_HTTP: "1",
    FLYX_REQUIRE_PAIRING_CONFIRM: "0",
    FLYX_CONNECTIVITY_MODE: "local",
    FLYX_RELAY_ENABLED: "0",
    FLYX_PUBLIC_BASE_URL: "",
    ...(provider === "claude" ? { FLYX_CLAUDE_EXECUTABLE: executable } : { FLYX_CODEX_EXECUTABLE: executable }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });
await new Promise((done, reject) => {
  const timer = setTimeout(() => { reject(new Error("DESTINATION_START_TIMEOUT")); }, 60_000);
  const check = () => { if (output.includes("Flyx MVP Host listening at")) { clearTimeout(timer); done(); } };
  child.stdout.on("data", check);
  child.stderr.on("data", check);
  child.once("exit", (code) => { clearTimeout(timer); console.error(output); reject(new Error("DESTINATION_START_EXITED:" + code)); });
});
const exitCode = await new Promise((done) => {
  child.once("exit", (code) => done(code ?? 0));
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
});
if (exitCode !== 0) { console.error(output); fail("DESTINATION_STOP_FAILED"); }

// Export the destination public identity for the isolated source run and the
// authorize CLI; 0600 private file as required for controlled inputs.
const { loadOrCreateHostIdentity, publicHostIdentity } = await import(pathToFileURL(join(ROOT, "apps/mvp-host/dist/identity/host-identity.js")).href);
const identity = await loadOrCreateHostIdentity({ directory: join(destination, "identity") });
const publicIdentity = publicHostIdentity(identity);
const destinationHostPath = join(destination, "destination-host.json");
await writeFile(destinationHostPath, JSON.stringify(publicIdentity) + "\n", { mode: 0o600 });
await chmod(destinationHostPath, 0o600);
console.log(JSON.stringify({ status: "completed", destination, destinationHostPath, hostId: publicIdentity.hostId, fingerprint: publicIdentity.fingerprint }, null, 2));
