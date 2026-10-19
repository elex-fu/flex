import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { assertPrivateDirectory, OperationsError } from "../operations/operation-files.js";

export type NativeCompatibilityEvidence = {
  provider: "claude" | "codex";
  kind: "turn" | "approval" | "interrupt" | "recovery";
  result: "passed" | "failed" | "skipped" | "unsupported";
  nativeEvent: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeRequestId?: string;
  attemptId: string;
  evidenceCode: string;
  /**
   * Version/artifact facts of the exact runtime that produced this record. They
   * make the observation traceable to an executable digest, configuration
   * fingerprint, adapter/SDK build and supervision contract; absent facts are
   * never inferred. An activation binds only to records that carry them.
   */
  artifact?: NativeCompatibilityArtifact;
};

export type NativeCompatibilityArtifact = {
  providerVersion?: string;
  executablePath?: string;
  executableDigest?: string;
  configFingerprint?: string;
  sdkVersion?: string;
  adapterId?: string;
  adapterVersion?: string;
  supervisionContractId?: string;
};

export type CompatibilityEvidenceArtifact = Readonly<{
  provider: "claude" | "codex";
  providerVersion: string;
  executablePath: string;
  executableDigest: string;
  configFingerprint: string;
  sdkVersion?: string;
  adapterId?: string;
  adapterVersion?: string;
  supervisionContractId: string;
}>;

export type CompatibilityEvidenceEntry = Readonly<{
  provider: "claude" | "codex";
  kind: NativeCompatibilityEvidence["kind"];
  result: NativeCompatibilityEvidence["result"];
  nativeEvent: string;
  evidenceCode: string;
  attemptIdHash: string;
  runId: string;
  at: string;
  artifact?: CompatibilityEvidenceArtifact;
}>;

export type CompatibilityEvidenceRead = Readonly<{
  path: string;
  available: boolean;
  entries: readonly CompatibilityEvidenceEntry[];
}>;

const MASK = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const ABSOLUTE = /^\/[^\0]{0,1023}$/;
const READ_LIMIT_BYTES = 1024 * 1024;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function artifact(value: NativeCompatibilityArtifact | undefined): NativeCompatibilityArtifact | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  // Traceability is all-or-nothing: a partially described runtime cannot be bound.
  for (const required of ["providerVersion", "executablePath", "executableDigest", "configFingerprint", "supervisionContractId"]) {
    if (!Object.hasOwn(value, required)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  }
  for (const [key, item] of entries) {
    if (!["providerVersion", "executablePath", "executableDigest", "configFingerprint", "sdkVersion", "adapterId", "adapterVersion", "supervisionContractId"].includes(key)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
    if (typeof item !== "string" || !IDENTITY.test(item) && !ABSOLUTE.test(item)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  }
  if (!IDENTITY.test(value.providerVersion!) || !IDENTITY.test(value.configFingerprint!) || !IDENTITY.test(value.supervisionContractId!)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  if (!ABSOLUTE.test(value.executablePath!)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  if (!MASK.test(value.executableDigest!)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  return Object.freeze({ ...value });
}

function parsedArtifact(value: unknown, provider: "claude" | "codex"): CompatibilityEvidenceArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerVersion !== "string" || !IDENTITY.test(raw.providerVersion)) return undefined;
  if (typeof raw.executablePath !== "string" || !ABSOLUTE.test(raw.executablePath)) return undefined;
  if (typeof raw.executableDigest !== "string" || !MASK.test(raw.executableDigest)) return undefined;
  if (typeof raw.configFingerprint !== "string" || !IDENTITY.test(raw.configFingerprint)) return undefined;
  if (typeof raw.supervisionContractId !== "string" || !IDENTITY.test(raw.supervisionContractId)) return undefined;
  for (const key of ["sdkVersion", "adapterId", "adapterVersion"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !IDENTITY.test(raw[key] as string))) return undefined;
  }
  return Object.freeze({
    provider, providerVersion: raw.providerVersion, executablePath: raw.executablePath, executableDigest: raw.executableDigest,
    configFingerprint: raw.configFingerprint, supervisionContractId: raw.supervisionContractId,
    ...(typeof raw.sdkVersion === "string" ? { sdkVersion: raw.sdkVersion } : {}),
    ...(typeof raw.adapterId === "string" ? { adapterId: raw.adapterId } : {}),
    ...(typeof raw.adapterVersion === "string" ? { adapterVersion: raw.adapterVersion } : {}),
  });
}

/** Only adapters/recovery inspectors may call this after observing native facts. */
export class CompatibilityEvidenceRecorder {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly enabled = process.env.FLYX_TEST_CONTROLLED_ENTRY === "1", private readonly runId = process.env.FLYX_COMPATIBILITY_RUN_ID) {}
  record(evidence: NativeCompatibilityEvidence): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const task = this.queue.then(async () => {
      await assertPrivateDirectory(dirname(resolve(this.path)));
      if (!/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(evidence.nativeEvent)
        || !/^[A-Z][A-Z0-9_]{0,95}$/.test(evidence.evidenceCode) || !evidence.attemptId || !this.runId || !/^[a-zA-Z0-9-]{1,128}$/.test(this.runId)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
      const traceable = artifact(evidence.artifact);
      const record = {
        v: 1, source: "native", runId: this.runId, provider: evidence.provider, kind: evidence.kind, result: evidence.result,
        nativeEvent: evidence.nativeEvent, evidenceCode: evidence.evidenceCode, attemptIdHash: hash(evidence.attemptId),
        ...(traceable ? { artifact: traceable } : {}),
        ...(evidence.nativeSessionId ? { nativeSessionIdHash: hash(evidence.nativeSessionId) } : {}),
        ...(evidence.nativeTurnId ? { nativeTurnIdHash: hash(evidence.nativeTurnId) } : {}),
        ...(evidence.nativeRequestId ? { nativeRequestIdHash: hash(evidence.nativeRequestId) } : {}),
        at: new Date().toISOString(),
      };
      const file = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new OperationsError("OPERATIONS_UNSAFE_FILE");
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally { await file.close(); }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async drain(): Promise<void> { await this.queue; }
}

/**
 * Read the Host-private evidence log with the same safety rules the recorder
 * writes under: regular file, 0600, current user. Unknown or corrupt lines are
 * skipped; they never become trusted facts. Missing/unreadable logs report
 * `available: false` instead of throwing.
 */
export function readCompatibilityEvidence(path: string, limit = 4096): CompatibilityEvidenceRead {
  const result = (entries: readonly CompatibilityEvidenceEntry[], available: boolean): CompatibilityEvidenceRead => Object.freeze({ path, available, entries: Object.freeze(entries) });
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return result([], false);
    if ((stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return result([], false);
    if (stat.size > READ_LIMIT_BYTES) return result([], false);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const buffer = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const read = readSync(fd, buffer, offset, stat.size - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
      raw = buffer.subarray(0, offset).toString("utf8");
    } finally { closeSync(fd); }
    const entries: CompatibilityEvidenceEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim() || entries.length >= Math.max(1, Math.min(limit, 4096))) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.v !== 1 || parsed.source !== "native") continue;
        const provider = parsed.provider;
        const kind = parsed.kind;
        const outcome = parsed.result;
        if (provider !== "claude" && provider !== "codex") continue;
        if (kind !== "turn" && kind !== "approval" && kind !== "interrupt" && kind !== "recovery") continue;
        if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped" && outcome !== "unsupported") continue;
        if (typeof parsed.nativeEvent !== "string" || !/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(parsed.nativeEvent)) continue;
        if (typeof parsed.evidenceCode !== "string" || !CODE.test(parsed.evidenceCode)) continue;
        if (typeof parsed.runId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(parsed.runId)) continue;
        if (typeof parsed.at !== "string" || !Number.isFinite(Date.parse(parsed.at))) continue;
        const attemptIdHash = typeof parsed.attemptIdHash === "string" && MASK.test(parsed.attemptIdHash) ? parsed.attemptIdHash : hash("");
        const artifactValue = parsedArtifact(parsed.artifact, provider);
        entries.push(Object.freeze({
          provider, kind, result: outcome, nativeEvent: parsed.nativeEvent, evidenceCode: parsed.evidenceCode,
          attemptIdHash, runId: parsed.runId, at: parsed.at, ...(artifactValue ? { artifact: artifactValue } : {}),
        }));
      } catch { /* A malformed line is not evidence. */ }
    }
    return result(entries, true);
  } catch { return result([], false); }
}

/** The trusted accessor used by activation: an unusable log is a typed refusal, not an empty match. */
export function loadTrustedCompatibilityEvidence(path: string, limit?: number): readonly CompatibilityEvidenceEntry[] {
  const read = readCompatibilityEvidence(path, limit);
  if (!read.available) throw new OperationsError("PROVIDER_COMPATIBILITY_EVIDENCE_MISSING");
  return read.entries;
}

export function compatibilityEvidenceArtifactDigest(artifact: CompatibilityEvidenceArtifact): string {
  return hash(JSON.stringify({
    provider: artifact.provider, providerVersion: artifact.providerVersion, executablePath: artifact.executablePath,
    executableDigest: artifact.executableDigest, configFingerprint: artifact.configFingerprint,
    sdkVersion: artifact.sdkVersion ?? null, adapterId: artifact.adapterId ?? null, adapterVersion: artifact.adapterVersion ?? null,
    supervisionContractId: artifact.supervisionContractId,
  }));
}

export function compatibilityEvidenceDigest(entry: CompatibilityEvidenceEntry): string {
  return hash(JSON.stringify({
    provider: entry.provider, kind: entry.kind, result: entry.result, nativeEvent: entry.nativeEvent, evidenceCode: entry.evidenceCode,
    attemptIdHash: entry.attemptIdHash, runId: entry.runId, at: entry.at, artifact: entry.artifact ?? null,
  }));
}

export { hash as compatibilityEvidenceHash };
