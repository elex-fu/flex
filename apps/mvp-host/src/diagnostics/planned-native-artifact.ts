import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, release } from "node:os";
import { compatibilityDigest } from "./compatibility-integrity.js";
export type PlannedNativeArtifact = Readonly<{
  v: 1; kind: "planned-native-launch"; operation: "version-query" | "provider-launch"; executable: Readonly<{ path: string; digest: string }>;
  scripts: readonly Readonly<{ path: string; digest: string }>[];
  nodeExecutable: Readonly<{ path: string; digest: string }>; nodeVersion: string; os: string;
  hostBuildDigest: string; requestConfigurationDigest: string; snapshotDigest: string;
}>;
export function measureRuntimeFile(path: string): { path: string; digest: string } {
  const canonical = realpathSync(path); const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd); if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error("COMPATIBILITY_ARTIFACT_FILE_INVALID");
    const digest = createHash("sha256").update(readFileSync(fd)).digest("hex"); const after = fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("COMPATIBILITY_ARTIFACT_FILE_CHANGED");
    return { path: canonical, digest };
  } finally { closeSync(fd); }
}
export function measuredHostBuildDigest(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files: Array<{ path: string; digest: string }> = [];
  const visit = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && /\.(?:js|ts|json)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push({ path: relative(root, path), digest: measureRuntimeFile(path).digest });
  } };
  visit(root);
  const dependencies: Array<{ path: string; digest: string }> = [measureRuntimeFile(resolve(root, "../package.json"))];
  try { const sdkEntry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"); dependencies.push(measureRuntimeFile(sdkEntry)); } catch { /* optional for Codex-only installs; Claude facts separately require its installed manifest */ }
  return compatibilityDigest({ files, dependencies });
}
/** Measurements of the planned files, not a kernel attestation of bytes ultimately executed. */
export function measurePlannedNativeArtifact(input: { executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }): PlannedNativeArtifact {
  const scripts: Array<{ path: string; digest: string }> = [];
  const runtime = basename(input.executable).toLowerCase();
  if (/^(?:node|nodejs|python[0-9.]*|bash|sh|zsh)$/.test(runtime)) {
    for (let index = 0; index < input.args.length; index++) {
      const argument = input.args[index]!;
      if (["-e", "--eval", "-c", "--print", "-p"].includes(argument)) break;
      if (argument.startsWith("-")) continue;
      const path = isAbsolute(argument) ? argument : resolve(input.cwd, argument);
      try { if (statSync(path).isFile() && /\.(?:m?js|cjs|ts|py|sh)$/.test(path)) { scripts.push(measureRuntimeFile(path)); break; } } catch { /* unresolved package/flag argument is not an executable script fact */ }
    }
  }
  const payload = { v: 1 as const, kind: "planned-native-launch" as const, operation: input.args.length === 1 && input.args[0] === "--version" ? "version-query" as const : "provider-launch" as const, executable: measureRuntimeFile(input.executable), scripts,
    nodeExecutable: measureRuntimeFile(process.execPath), nodeVersion: process.versions.node, os: process.platform + " " + release() + " " + arch(),
    hostBuildDigest: measuredHostBuildDigest(), requestConfigurationDigest: compatibilityDigest({ cwd: input.cwd, args: [...input.args], environment: Object.fromEntries(Object.entries(input.env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) }) };
  return Object.freeze({ ...payload, executable: Object.freeze(payload.executable), scripts: Object.freeze(scripts.map((file) => Object.freeze(file))), nodeExecutable: Object.freeze(payload.nodeExecutable), snapshotDigest: compatibilityDigest(payload) });
}
