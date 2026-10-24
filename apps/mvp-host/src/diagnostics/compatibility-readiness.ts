import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { arch, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HostIdentityFileV1 } from "../identity/host-identity.js";
import { assertPrivateDirectory, OperationsError, syncDirectory, writePrivateFile } from "../operations/operation-files.js";
import { assertCompleteCompatibilityArtifact, compatibilityEvidenceHash, type NativeCompatibilityArtifact } from "./compatibility-evidence.js";
import { signCompatibilityPayload } from "./compatibility-integrity.js";
import { sceneSegments } from "./compatibility-scenes.js";

export const COMPATIBILITY_SCENE_VERSION = "flyx-c3-basic-v1";
export const COMPATIBILITY_BASIC_PROMPT = "回复 OK 两个字母，不要做任何其他事";
export function isCompatibilityScenePrompt(prompt: unknown): boolean { return prompt === COMPATIBILITY_BASIC_PROMPT; }
export interface CompatibilityReadinessOptions {
  path: string;
  baseUrl: string;
  pairingToken: string;
  provider: "claude" | "codex";
  identity: HostIdentityFileV1;
  runId: string;
  /** The actual process entry, normally fileURLToPath(import.meta.url) in main.ts. */
  entryPath: string;
  databasePath: string;
  identityDirectory: string;
  workspace: string;
  artifact: NativeCompatibilityArtifact;
  authMode: "unknown" | "signed_in" | "api_key";
  /** Registered scene this run executes; defaults to the c3 basic scene. */
  sceneVersion?: string | undefined;
}
const refuse = (code: string): never => { throw new OperationsError(code); };
const inside = (root: string, path: string) => { const part = relative(root, path); return !!part && part !== ".." && !part.startsWith("../") && !isAbsolute(part); };
/** This validates isolation only; it grants no catalog/RPC activation capability. */
export async function assertControlledCompatibilityEntry(options: CompatibilityReadinessOptions): Promise<{ root: string; entryPath: string; entryDigest: string }> {
  if (process.env.FLYX_TEST_CONTROLLED_ENTRY !== "1" || process.env.FLYX_COMPATIBILITY_MODE !== "isolated"
    || process.env.FLYX_COMPATIBILITY_REAL_ENABLED !== "1" || process.env[options.provider === "claude" ? "RUN_REAL_CLAUDE" : "RUN_REAL_CODEX"] !== "1") refuse("COMPATIBILITY_ENTRY_NOT_ENABLED");
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(options.runId) || options.runId !== process.env.FLYX_COMPATIBILITY_RUN_ID) refuse("COMPATIBILITY_RUN_MISMATCH");
  const root = await assertPrivateDirectory(resolve(process.env.FLYX_COMPATIBILITY_ROOT ?? ""));
  for (const path of [options.path, options.databasePath, options.identityDirectory, options.workspace]) {
    if (!isAbsolute(path)) refuse("COMPATIBILITY_ISOLATION_REQUIRED");
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (current?.isSymbolicLink()) refuse("COMPATIBILITY_ISOLATION_REQUIRED");
    if (current && !inside(root, await realpath(path))) refuse("COMPATIBILITY_ISOLATION_REQUIRED");
    // Resolve an existing parent, so a symlink cannot redirect a future artifact outside isolation.
    const parent = await realpath(dirname(path));
    if (!inside(root, join(parent, basename(path))) || parent !== root && !inside(root, parent)) refuse("COMPATIBILITY_ISOLATION_REQUIRED");
  }
  const workspace = await realpath(options.workspace);
  if (!inside(root, workspace) || !(await lstat(join(workspace, ".git"))).isDirectory()) refuse("COMPATIBILITY_FIXTURE_REQUIRED");
  const entryPath = await realpath(options.entryPath);
  if (!entryPath.endsWith("/dist/main.js") || entryPath !== await realpath(process.argv[1] ?? "")) refuse("COMPATIBILITY_PRODUCTION_ENTRY_REQUIRED");
  const entryDigest = compatibilityEvidenceHash(await readFile(entryPath, "utf8"));
  if (process.env.FLYX_COMPATIBILITY_ENTRY_DIGEST !== entryDigest) refuse("COMPATIBILITY_BUILD_MISMATCH");
  assertCompleteCompatibilityArtifact(options.artifact);
  if (options.artifact.nodeVersion !== process.versions.node || options.artifact.os !== process.platform + " " + release() + " " + arch()) refuse("COMPATIBILITY_RUNTIME_MISMATCH");
  return { root, entryPath, entryDigest };
}
/** Private production handshake. Pairing material is never returned or logged. */
export async function writeCompatibilityReadiness(options: CompatibilityReadinessOptions): Promise<void> {
  const sceneVersion = options.sceneVersion ?? COMPATIBILITY_SCENE_VERSION;
  if (sceneSegments(sceneVersion) === undefined) refuse("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED");
  const checked = await assertControlledCompatibilityEntry(options);
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== "/") refuse("READINESS_LOOPBACK_REQUIRED");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.pairingToken)) refuse("READINESS_CREDENTIAL_INVALID");
  const destination = resolve(options.path);
  const directory = await assertPrivateDirectory(dirname(destination));
  const credentialFile = "pairing-" + randomBytes(16).toString("hex") + ".secret";
  const temporary = join(directory, ".readiness-" + randomBytes(16).toString("hex") + ".tmp");
  const credentialPath = join(directory, credentialFile);
  let published = false;
  try {
    await writePrivateFile(credentialPath, options.pairingToken + "\n");
    const payload = signCompatibilityPayload({
      v: 2, domain: "isolated-real", pid: process.pid, runId: options.runId, baseUrl: base.origin, provider: options.provider,
      credentialFile, credentialDigest: compatibilityEvidenceHash(options.pairingToken), entry: "production-main", entryPath: checked.entryPath,
      entryDigest: checked.entryDigest, buildDigest: options.artifact.runtimeDigest, sceneVersion,
      observed: { ...Object.fromEntries(Object.entries(options.artifact).filter(([, value]) => value !== undefined)), cliVersion: options.artifact.providerVersion, authMode: options.authMode }, createdAt: new Date().toISOString(),
    }, options.identity);
    await writePrivateFile(temporary, JSON.stringify(payload) + "\n");
    await rename(temporary, destination);
    await syncDirectory(directory);
    published = true;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!published) await unlink(credentialPath).catch(() => undefined);
  }
}
