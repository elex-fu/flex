import { dirname, join, resolve } from "node:path";
import { arch, release } from "node:os";
import { randomBytes } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { assertPrivateDirectory, OperationsError, syncDirectory, writePrivateFile } from "../operations/operation-files.js";

export interface TestReadinessOptions {
  path: string;
  baseUrl: string;
  pairingToken: string;
  provider: "claude" | "codex" | "deterministic";
  observed?: {
    sdkVersion?: string;
    cliVersion?: string;
    adapterVersion?: string;
    executablePath?: string;
    authMode?: "unknown" | "signed_in" | "api_key" | "loopback_test";
    capabilities?: string[];
  };
}

/** Explicit controlled entry only. Nothing here is emitted by ordinary startup. */
export async function writeTestReadiness(options: TestReadinessOptions): Promise<void> {
  if (process.env.FLYX_TEST_CONTROLLED_ENTRY !== "1") throw new OperationsError("TEST_READINESS_NOT_ENABLED");
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new OperationsError("TEST_READINESS_LOOPBACK_REQUIRED");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.pairingToken)) throw new OperationsError("TEST_READINESS_CREDENTIAL_INVALID");
  const destination = resolve(options.path);
  const directory = await assertPrivateDirectory(dirname(destination));
  const credentialFile = "pairing-" + randomBytes(16).toString("hex") + ".secret";
  const temporary = join(directory, ".readiness-" + randomBytes(16).toString("hex") + ".tmp");
  const credentialPath = join(directory, credentialFile);
  let published = false;
  try {
    await writePrivateFile(credentialPath, options.pairingToken + "\n");
    await writePrivateFile(temporary, JSON.stringify({
      v: 1, pid: process.pid, baseUrl: base.origin, provider: options.provider,
      credentialFile, observed: { ...options.observed, nodeVersion: process.versions.node, os: process.platform + " " + release() + " " + arch() }, createdAt: new Date().toISOString(),
    }) + "\n");
    await rename(temporary, destination);
    await syncDirectory(directory);
    published = true;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!published) await unlink(credentialPath).catch(() => undefined);
  }
}
