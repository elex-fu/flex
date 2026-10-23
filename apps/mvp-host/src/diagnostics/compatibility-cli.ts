import { randomBytes } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { publicHostIdentity, type HostIdentityFileV1, type HostIdentityMirror } from "../identity/host-identity.js";
import { assertPrivateDirectory, OperationsError, readPrivateFile, syncDirectory, writePrivateFile, type OperationOwner } from "../operations/operation-files.js";
import { authorizeCompatibilityRun, importCompatibilityRun } from "./compatibility-import.js";
import type { CompatibilityHostIdentity } from "./compatibility-integrity.js";

export type CompatibilityCommand = { kind: "compatibility-authorize"; sourceHostPath: string; runId: string; provider: "claude" | "codex"; entryDigest: string; artifactDigest: string; runtimeDigest: string; outputPath: string }
  | { kind: "compatibility-import"; authorizationPath: string; readinessPath: string; evidencePath: string; outputPath: string };
const invalid = (): never => { throw new OperationsError("COMPATIBILITY_COMMAND_INVALID"); };
/** Local terminal command only; no RPC route and no implicit work from activation verify. */
export function parseCompatibilityCommand(args: readonly string[]): CompatibilityCommand | undefined {
  if (args[0] !== "compatibility") return undefined;
  const action = args[1];
  const flags: Record<string, string> = {};
  const allowed = action === "authorize" ? ["--source-host", "--run-id", "--provider", "--entry-digest", "--artifact-digest", "--runtime-digest", "--output"]
    : action === "import" ? ["--authorization", "--readiness", "--evidence", "--output"] : invalid();
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag || !allowed.includes(flag) || flags[flag] !== undefined || !value || value.startsWith("--")) invalid();
    flags[flag!] = value!;
  }
  if (allowed.some((flag) => !flags[flag])) invalid();
  for (const flag of allowed.filter((flag) => ["--source-host", "--output", "--authorization", "--readiness", "--evidence"].includes(flag))) if (!isAbsolute(flags[flag]!)) invalid();
  if (action === "authorize") {
    if (!["claude", "codex"].includes(flags["--provider"]!) || !/^[a-zA-Z0-9-]{1,128}$/.test(flags["--run-id"]!)
      || ["--entry-digest", "--artifact-digest", "--runtime-digest"].some((flag) => !/^[a-f0-9]{64}$/.test(flags[flag]!))) invalid();
    return { kind: "compatibility-authorize", sourceHostPath: flags["--source-host"]!, runId: flags["--run-id"]!, provider: flags["--provider"] as "claude" | "codex",
      entryDigest: flags["--entry-digest"]!, artifactDigest: flags["--artifact-digest"]!, runtimeDigest: flags["--runtime-digest"]!, outputPath: flags["--output"]! };
  }
  return { kind: "compatibility-import", authorizationPath: flags["--authorization"]!, readinessPath: flags["--readiness"]!, evidencePath: flags["--evidence"]!, outputPath: flags["--output"]! };
}
export interface CompatibilityCommandContext {
  owner: OperationOwner;
  identity: HostIdentityFileV1;
  store: { getHostIdentityMirror(): HostIdentityMirror | null | undefined };
}
export async function runCompatibilityCommand(command: CompatibilityCommand, context: CompatibilityCommandContext): Promise<{ status: "completed"; outputPath: string }> {
  context.owner.assertActive();
  const destination = publicHostIdentity(context.identity);
  const mirror = context.store.getHostIdentityMirror();
  if (context.owner.mode !== "maintenance" || !mirror || mirror.hostId !== destination.hostId || mirror.fingerprint !== destination.fingerprint) throw new OperationsError("COMPATIBILITY_MAINTENANCE_REQUIRED");
  const readJson = async (path: string): Promise<unknown> => { await assertPrivateDirectory(dirname(resolve(path))); return JSON.parse((await readPrivateFile(path, 64 * 1024)).toString("utf8")); };
  if (command.kind === "compatibility-authorize") {
    const sourceHost = await readJson(command.sourceHostPath) as CompatibilityHostIdentity;
    if (!sourceHost || Object.keys(sourceHost).sort().join(",") !== "fingerprint,hostId,hostPublicKey,signingPublicKey"
      || !/^[a-f0-9-]{36}$/.test(sourceHost.hostId) || !/^[A-Za-z0-9_-]{43}$/.test(sourceHost.hostPublicKey) || !/^[A-Za-z0-9_-]{43}$/.test(sourceHost.signingPublicKey)) invalid();
    const ticket = authorizeCompatibilityRun(context.identity, { ...command, sourceHost });
    const destinationPath = resolve(command.outputPath); const directory = await assertPrivateDirectory(dirname(destinationPath));
    const staged = join(directory, ".compatibility-authorize-" + randomBytes(16).toString("hex") + ".tmp");
    try { await writePrivateFile(staged, JSON.stringify(ticket) + "\n"); context.owner.assertActive(); await rename(staged, destinationPath); await syncDirectory(directory); }
    finally { await unlink(staged).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  } else {
    // Same derivation as the activation CLI and the Host startup read: the
    // verified evidence log lives beside the destination database unless the
    // environment pins an explicit private path.
    const evidenceLogPath = resolve(process.env.FLYX_COMPATIBILITY_EVIDENCE_PATH ?? join(dirname(resolve(context.owner.databasePath)), "compatibility-evidence.jsonl"));
    await importCompatibilityRun({ destination: context.identity, authorization: await readJson(command.authorizationPath), readinessPath: command.readinessPath, evidencePath: command.evidencePath, endorsementPath: command.outputPath, evidenceLogPath, beforePublish: () => context.owner.assertActive() });
  }
  return { status: "completed", outputPath: resolve(command.outputPath) };
}
