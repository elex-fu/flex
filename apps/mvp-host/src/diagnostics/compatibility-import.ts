import { randomBytes } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HostIdentityFileV1 } from "../identity/host-identity.js";
import { publicHostIdentity } from "../identity/host-identity.js";
import { assertPrivateDirectory, OperationsError, readPrivateFile, syncDirectory, writePrivateFile } from "../operations/operation-files.js";
import { compatibilityEvidenceArtifactDigest, readCompatibilityEvidence, type CompatibilityEvidenceArtifact } from "./compatibility-evidence.js";
import { compatibilityDigest, signCompatibilityPayload, verifyCompatibilityPayload, type CompatibilityHostIdentity } from "./compatibility-integrity.js";
import { COMPATIBILITY_SCENE_VERSION } from "./compatibility-readiness.js";

export type CompatibilityRunAuthorization = {
  v: 2; kind: "compatibility-run-authorization"; domain: "destination-authorization";
  provider: "claude" | "codex"; artifactDigest: string; runtimeDigest: string; nonce: string;
  runId: string; sourceHost: CompatibilityHostIdentity; entryDigest: string; sceneVersion: string;
  issuedAt: string; expiresAt: string;
};
/** Explicit local maintenance prepares this before launching an independently identified run. */
export function authorizeCompatibilityRun(destination: HostIdentityFileV1, input: {
  provider: "claude" | "codex"; artifactDigest: string; runtimeDigest: string;
  runId: string; sourceHost: CompatibilityHostIdentity; entryDigest: string; now?: number;
}) {
  if (input.sourceHost.hostId === destination.hostId || input.sourceHost.fingerprint === destination.fingerprint || !["claude", "codex"].includes(input.provider) || !/^[a-f0-9]{64}$/.test(input.artifactDigest) || !/^[a-f0-9]{64}$/.test(input.runtimeDigest)
    || input.sourceHost.fingerprint !== "sha256:" + compatibilityDigest({ v: 1, hostPublicKey: input.sourceHost.hostPublicKey, signingPublicKey: input.sourceHost.signingPublicKey }) || !/^[a-zA-Z0-9-]{1,128}$/.test(input.runId) || !/^[a-f0-9]{64}$/.test(input.entryDigest)) throw new OperationsError("COMPATIBILITY_AUTHORIZATION_INVALID");
  const now = input.now ?? Date.now();
  const payload: CompatibilityRunAuthorization = { v: 2, kind: "compatibility-run-authorization", domain: "destination-authorization",
    provider: input.provider, artifactDigest: input.artifactDigest, runtimeDigest: input.runtimeDigest, nonce: randomBytes(24).toString("base64url"),
    runId: input.runId, sourceHost: input.sourceHost, entryDigest: input.entryDigest, sceneVersion: COMPATIBILITY_SCENE_VERSION,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString() };
  return signCompatibilityPayload(payload, destination);
}
export interface ImportCompatibilityRunOptions {
  destination: HostIdentityFileV1;
  authorization: unknown;
  readinessPath: string;
  evidencePath: string;
  endorsementPath: string;
  /**
   * Destination install path for the verified source-signed evidence records.
   * The destination trust chain needs both files: the destination-signed
   * endorsement alone cannot carry the per-capability records, and the
   * self-signed records alone cannot establish destination acceptance. The
   * log is published before the endorsement, so a crash between the two
   * leaves records that no endorsement will trust.
   */
  evidenceLogPath?: string;
  now?: number;
  beforePublish?: () => void;
}
/** No subprocesses or model calls. Imports a previously authorized real run.
 * Journal digests are source-attested provenance, not an independent replay of the source database.
 */
export async function importCompatibilityRun(options: ImportCompatibilityRunOptions): Promise<void> {
  const now = options.now ?? Date.now();
  const destination = publicHostIdentity(options.destination);
  if (!verifyCompatibilityPayload(options.authorization, destination)) throw new OperationsError("COMPATIBILITY_AUTHORIZATION_INVALID");
  const ticket = options.authorization as unknown as CompatibilityRunAuthorization;
  if (!Number.isFinite(Date.parse(ticket.issuedAt)) || !Number.isFinite(Date.parse(ticket.expiresAt)) || ticket.v !== 2 || ticket.kind !== "compatibility-run-authorization" || ticket.domain !== "destination-authorization"
    || !ticket.sourceHost || ticket.sourceHost.hostId === destination.hostId || ticket.sourceHost.fingerprint === destination.fingerprint
    || ticket.sceneVersion !== COMPATIBILITY_SCENE_VERSION || Date.parse(ticket.issuedAt) > now + 5_000 || Date.parse(ticket.expiresAt) <= now) throw new OperationsError("COMPATIBILITY_AUTHORIZATION_INVALID");
  await assertPrivateDirectory(dirname(resolve(options.readinessPath)));
  const ready: unknown = JSON.parse((await readPrivateFile(options.readinessPath, 64 * 1024)).toString("utf8"));
  if (!verifyCompatibilityPayload(ready, ticket.sourceHost)) throw new OperationsError("COMPATIBILITY_SOURCE_UNTRUSTED");
  const handshake = ready as Record<string, unknown>;
  if (handshake.v !== 2 || handshake.domain !== "isolated-real" || handshake.entry !== "production-main" || handshake.runId !== ticket.runId
    || typeof handshake.entryPath !== "string" || !isAbsolute(handshake.entryPath) || !handshake.entryPath.endsWith("/dist/main.js")
    || handshake.provider !== ticket.provider || handshake.buildDigest !== ticket.runtimeDigest || handshake.entryDigest !== ticket.entryDigest || handshake.sceneVersion !== ticket.sceneVersion || typeof handshake.createdAt !== "string"
    || !Number.isFinite(Date.parse(handshake.createdAt)) || Date.parse(handshake.createdAt) < Date.parse(ticket.issuedAt) || Date.parse(handshake.createdAt) > now + 5_000
    || (handshake.provider !== "claude" && handshake.provider !== "codex")) throw new OperationsError("COMPATIBILITY_SOURCE_MISMATCH");
  const sourceFacts = { ...(handshake.observed as object), provider: handshake.provider } as CompatibilityEvidenceArtifact;
  if (handshake.buildDigest !== sourceFacts.runtimeDigest) throw new OperationsError("COMPATIBILITY_SOURCE_MISMATCH");
  const artifactDigest = compatibilityEvidenceArtifactDigest(sourceFacts);
  if (artifactDigest !== ticket.artifactDigest) throw new OperationsError("COMPATIBILITY_SOURCE_MISMATCH");
  const read = readCompatibilityEvidence(options.evidencePath);
  await assertPrivateDirectory(dirname(resolve(options.evidencePath)));
  const sourceLines = (await readPrivateFile(options.evidencePath, 1024 * 1024)).toString("utf8").split("\n").filter((line) => line.trim());
  if (!read.available || !read.entries.length || read.entries.length !== sourceLines.length) throw new OperationsError("COMPATIBILITY_SOURCE_MISSING");
  const verifiedLines: string[] = [];
  const entries = read.entries.filter((entry, index) => {
    const accepted = entry.trusted && entry.domain === "isolated-real" && entry.runId === ticket.runId
      && entry.entryDigest === ticket.entryDigest && entry.sceneVersion === ticket.sceneVersion && entry.host?.fingerprint === ticket.sourceHost.fingerprint
      && entry.host?.hostId === ticket.sourceHost.hostId && entry.provider === handshake.provider && entry.artifact
      && compatibilityEvidenceArtifactDigest(entry.artifact) === artifactDigest && Date.parse(entry.at) >= Date.parse(String(handshake.createdAt)) - 1_000
      && Date.parse(entry.at) <= now + 5_000;
    // Preserve the exact source-signed line: bytes, order and signatures are
    // never re-serialized; only the verified subset is installed.
    if (accepted) verifiedLines.push(sourceLines[index]!);
    return accepted;
  });
  if (entries.length !== read.entries.length || entries.some((entry) => entry.result === "failed")) throw new OperationsError("COMPATIBILITY_SOURCE_MISMATCH");
  const turns = new Set(entries.filter((entry) => entry.kind === "turn" && entry.capability === "turn" && entry.result === "passed").map((entry) => entry.nativeSessionIdHash + ":" + (entry.provider === "claude" ? entry.nativeResultIdHash : entry.nativeTurnIdHash)));
  if (turns.size < 10) throw new OperationsError("COMPATIBILITY_SCENE_INCOMPLETE");
  // The destination endorsement must cover every capability the trusted set
  // carries: a run with verified native-history recovery inspections keeps
  // its recovery records importable, or the production manifest (which
  // requires a trusted recovery entry) could never exist after import.
  const passedRecords = entries.filter((entry) => entry.result === "passed" && entry.capability === entry.kind);
  const capabilities = [...new Set(passedRecords.map((entry) => entry.kind))].sort() as ("turn" | "recovery")[];
  const payload = signCompatibilityPayload({ v: 2, kind: "compatibility-import", domain: "destination-endorsement",
    sourceHost: ticket.sourceHost, runId: ticket.runId, entryDigest: ticket.entryDigest, sceneVersion: ticket.sceneVersion,
    authorizationDigest: (options.authorization as { digest: string }).digest, readinessDigest: handshake.digest, artifactDigest,
    evidenceSetDigest: compatibilityDigest(entries.map((entry) => entry.digest).sort()), capabilities, recordDigests: passedRecords.map((entry) => entry.digest).sort(),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 86_400_000, Date.parse(handshake.createdAt) + 86_400_000, Date.parse(ticket.expiresAt))).toISOString(),
  }, options.destination);
  if (options.evidenceLogPath) {
    const logPath = resolve(options.evidenceLogPath);
    const logDirectory = await assertPrivateDirectory(dirname(logPath));
    const stagedLog = join(logDirectory, ".compatibility-evidence-" + randomBytes(16).toString("hex") + ".tmp");
    try { await writePrivateFile(stagedLog, verifiedLines.join("\n") + "\n"); options.beforePublish?.(); await rename(stagedLog, logPath); await syncDirectory(logDirectory); }
    finally { await unlink(stagedLog).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  }
  const destinationPath = resolve(options.endorsementPath);
  const directory = await assertPrivateDirectory(dirname(destinationPath));
  const staged = join(directory, ".compatibility-import-" + randomBytes(16).toString("hex") + ".tmp");
  try { await writePrivateFile(staged, JSON.stringify(payload) + "\n"); options.beforePublish?.(); await rename(staged, destinationPath); await syncDirectory(directory); }
  finally { await unlink(staged).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
