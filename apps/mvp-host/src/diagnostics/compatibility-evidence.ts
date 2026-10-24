import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { HostIdentityFileV1 } from "../identity/host-identity.js";
import { compatibilityDigest, signCompatibilityPayload, verifyCompatibilityPayload, type CompatibilityHostIdentity } from "./compatibility-integrity.js";
import { sceneSegments } from "./compatibility-scenes.js";
import { assertPrivateDirectory, OperationsError } from "../operations/operation-files.js";

export type NativeCompatibilityEvidence = {
  provider: "claude" | "codex";
  kind: "turn" | "approval" | "question" | "interrupt" | "stop" | "reconnect" | "recovery" | "rewind";
  capability?: string;
  launchRef?: string;
  stopRef?: string;
  result: "passed" | "failed" | "skipped" | "unsupported";
  nativeEvent: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeRequestId?: string;
  /** Exact original committed native source id, used only by the private journal resolver. */
  nativeSourceId?: string;
  nativeResultId?: string;
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
  runtimeVersion?: string;
  runtimeDigest?: string;
  nodeVersion?: string;
  os?: string;
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
  runtimeVersion?: string;
  runtimeDigest?: string;
  nodeVersion?: string;
  os?: string;
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
  capability?: string;
  sceneVersion?: string;
  entryDigest?: string;
  launchRef?: string;
  stopRef?: string;
  nativeSessionIdHash?: string;
  nativeTurnIdHash?: string;
  nativeResultIdHash?: string;
  nativeRequestIdHash?: string;
  host?: CompatibilityHostIdentity;
  digest?: string;
  signature?: string;
  /** Signature and source manifest integrity only; destination acceptance uses loadTrustedCompatibilityEvidence. */
  trusted?: boolean;
  domain?: "isolated-real" | "fixture";
  provenance?: CompatibilityNativeProvenance;
}>;

export type CompatibilityEvidenceRead = Readonly<{
  path: string;
  available: boolean;
  entries: readonly CompatibilityEvidenceEntry[];
}>;

const MASK = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const CONTRACT = /^[a-zA-Z0-9][a-zA-Z0-9._+:/-]{0,255}$/;
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
    if (!["provider", "providerVersion", "executablePath", "executableDigest", "configFingerprint", "sdkVersion", "adapterId", "adapterVersion", "supervisionContractId", "runtimeVersion", "runtimeDigest", "nodeVersion", "os"].includes(key)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
    if (typeof item !== "string" || !IDENTITY.test(item) && !ABSOLUTE.test(item) && !(key === "supervisionContractId" && CONTRACT.test(item)) && !(key === "os" && /^[a-z0-9 ._-]{1,128}$/i.test(item))) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  }
  if (!IDENTITY.test(value.providerVersion!) || !IDENTITY.test(value.configFingerprint!) || !CONTRACT.test(value.supervisionContractId!)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  if (!ABSOLUTE.test(value.executablePath!)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  if (!MASK.test(value.executableDigest!)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
  return Object.freeze(Object.fromEntries(entries));
}

function parsedArtifact(value: unknown, provider: "claude" | "codex"): CompatibilityEvidenceArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerVersion !== "string" || !IDENTITY.test(raw.providerVersion)) return undefined;
  if (typeof raw.executablePath !== "string" || !ABSOLUTE.test(raw.executablePath)) return undefined;
  if (typeof raw.executableDigest !== "string" || !MASK.test(raw.executableDigest)) return undefined;
  if (typeof raw.configFingerprint !== "string" || !IDENTITY.test(raw.configFingerprint)) return undefined;
  if (typeof raw.supervisionContractId !== "string" || !CONTRACT.test(raw.supervisionContractId)) return undefined;
  for (const key of ["sdkVersion", "adapterId", "adapterVersion"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !IDENTITY.test(raw[key] as string))) return undefined;
  }
  return Object.freeze({
    provider, providerVersion: raw.providerVersion, executablePath: raw.executablePath, executableDigest: raw.executableDigest,
    configFingerprint: raw.configFingerprint, supervisionContractId: raw.supervisionContractId,
    ...(typeof raw.sdkVersion === "string" ? { sdkVersion: raw.sdkVersion } : {}),
    ...(typeof raw.adapterId === "string" ? { adapterId: raw.adapterId } : {}),
    ...(typeof raw.adapterVersion === "string" ? { adapterVersion: raw.adapterVersion } : {}),
    ...(typeof raw.runtimeVersion === "string" ? { runtimeVersion: raw.runtimeVersion } : {}),
    ...(typeof raw.runtimeDigest === "string" ? { runtimeDigest: raw.runtimeDigest } : {}),
    ...(typeof raw.nodeVersion === "string" ? { nodeVersion: raw.nodeVersion } : {}),
    ...(typeof raw.os === "string" ? { os: raw.os } : {}),
  });
}

export interface CompatibilityNativeProvenance {
  provider: "claude" | "codex"; attemptIdHash: string;
  launchRecordDigest: string; nativeObservationDigest: string; stopRecordDigest?: string;
  executableDigest: string; runtimeDigest: string; configFingerprint: string; supervisionContractId: string;
}
function validProvenance(value: unknown, evidence: { provider: string; kind: string; attemptIdHash: string }, measured: NativeCompatibilityArtifact): value is CompatibilityNativeProvenance {
  const proof = value as CompatibilityNativeProvenance | undefined;
  return !!proof && proof.provider === evidence.provider && proof.attemptIdHash === evidence.attemptIdHash
    && MASK.test(proof.launchRecordDigest) && MASK.test(proof.nativeObservationDigest)
    && (!["interrupt", "stop"].includes(evidence.kind) || MASK.test(proof.stopRecordDigest ?? ""))
    && proof.executableDigest === measured.executableDigest && proof.runtimeDigest === measured.runtimeDigest
    && proof.configFingerprint === measured.configFingerprint && proof.supervisionContractId === measured.supervisionContractId;
}
export interface CompatibilityRecorderContext {
  domain: "isolated-real" | "fixture";
  /** Must resolve the immutable launch/stop journal records, attempt/provider and native IDs. */
  assertNativeProvenance?: (evidence: NativeCompatibilityEvidence, artifact: NativeCompatibilityArtifact) => CompatibilityNativeProvenance | Promise<CompatibilityNativeProvenance>;
  identity: HostIdentityFileV1;
  artifact: NativeCompatibilityArtifact | ((provider: "claude" | "codex") => NativeCompatibilityArtifact);
  sceneVersion: string;
  entryDigest: string;
}
const capabilityMatches = (kind: string, capability: string) => capability === kind || kind === "approval" && ["approval-allow", "approval-deny"].includes(capability);
const KINDS = ["turn", "approval", "question", "interrupt", "stop", "reconnect", "recovery", "rewind"];
/** Exact runtime facts are mandatory for signed evidence; no version or capability is inferred. */
export function assertCompleteCompatibilityArtifact(value: NativeCompatibilityArtifact | undefined): asserts value is NativeCompatibilityArtifact {
  artifact(value);
  if (!value || !value.adapterId || !value.adapterVersion || !value.runtimeVersion || !MASK.test(value.runtimeDigest ?? "")
    || !value.nodeVersion || !value.os) throw new OperationsError("COMPATIBILITY_ARTIFACT_INCOMPLETE");
}
/** Only adapters/recovery inspectors may call this after observing native facts. */
export class CompatibilityEvidenceRecorder {
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  constructor(private readonly path: string, private readonly enabled = process.env.FLYX_TEST_CONTROLLED_ENTRY === "1", private readonly runId = process.env.FLYX_COMPATIBILITY_RUN_ID, private readonly context?: CompatibilityRecorderContext) {}
  record(evidence: NativeCompatibilityEvidence): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const task = this.queue.then(async () => {
      await assertPrivateDirectory(dirname(resolve(this.path)));
      if (!/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(evidence.nativeEvent)
        || !/^[A-Z][A-Z0-9_]{0,95}$/.test(evidence.evidenceCode) || !evidence.attemptId || !this.runId || !/^[a-zA-Z0-9-]{1,128}$/.test(this.runId)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
      if (!["claude", "codex"].includes(evidence.provider) || !KINDS.includes(evidence.kind) || !["passed", "failed", "skipped", "unsupported"].includes(evidence.result)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
      const measured = this.context ? (typeof this.context.artifact === "function" ? this.context.artifact(evidence.provider) : this.context.artifact) : evidence.artifact;
      const traceable = artifact(measured);
      let provenance: CompatibilityNativeProvenance | undefined;
      if (this.context) {
        assertCompleteCompatibilityArtifact(traceable);
        if (evidence.provider === "claude" && !traceable?.sdkVersion) throw new OperationsError("COMPATIBILITY_ARTIFACT_INCOMPLETE");
        if (this.context.domain !== "fixture" && this.context.domain !== "isolated-real") throw new OperationsError("COMPATIBILITY_DOMAIN_INVALID");
        if (this.context.domain === "isolated-real") {
          if (process.env.FLYX_COMPATIBILITY_MODE !== "isolated" || process.env.FLYX_COMPATIBILITY_REAL_ENABLED !== "1"
            || process.env[evidence.provider === "claude" ? "RUN_REAL_CLAUDE" : "RUN_REAL_CODEX"] !== "1"
            || !this.context.assertNativeProvenance) throw new OperationsError("COMPATIBILITY_PROVENANCE_REQUIRED");
          provenance = await this.context.assertNativeProvenance(evidence, traceable!);
          if (!validProvenance(provenance, { ...evidence, attemptIdHash: hash(evidence.attemptId) }, traceable!)) throw new OperationsError("COMPATIBILITY_PROVENANCE_INVALID");
        }
        if (!capabilityMatches(evidence.kind, evidence.capability ?? evidence.kind) || !IDENTITY.test(this.context.sceneVersion) || !MASK.test(this.context.entryDigest)
          || !/^[a-z][a-z0-9._-]{0,95}$/.test(evidence.capability ?? evidence.kind)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
        if (evidence.result === "passed" && (!evidence.nativeSessionId || !evidence.launchRef
          || (["turn", "interrupt", "stop"].includes(evidence.kind) && (evidence.provider === "codex" ? !evidence.nativeTurnId : !(evidence.nativeResultId ?? evidence.nativeSourceId)))
          || (["approval", "question"].includes(evidence.kind) && !evidence.nativeRequestId)
          || (["interrupt", "stop"].includes(evidence.kind) && !evidence.stopRef))) throw new OperationsError("COMPATIBILITY_NATIVE_PROOF_MISSING");
      }
      for (const ref of [evidence.launchRef, evidence.stopRef]) if (ref !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(ref)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
      const record = {
        v: this.context ? 2 : 1, source: "native", runId: this.runId, provider: evidence.provider, kind: evidence.kind, result: evidence.result,
        nativeEvent: evidence.nativeEvent, evidenceCode: evidence.evidenceCode, attemptIdHash: hash(evidence.attemptId),
        ...(traceable ? { artifact: traceable } : {}),
        ...(provenance ? { provenance } : {}),
        ...(this.context ? { domain: this.context.domain, capability: evidence.capability ?? evidence.kind, sceneVersion: this.context.sceneVersion, entryDigest: this.context.entryDigest } : {}),
        ...(evidence.launchRef ? { launchRef: evidence.launchRef } : {}),
        ...(evidence.stopRef ? { stopRef: evidence.stopRef } : {}),
        ...(evidence.nativeSessionId ? { nativeSessionIdHash: hash(evidence.nativeSessionId) } : {}),
        ...((evidence.nativeResultId ?? (evidence.provider === "claude" ? evidence.nativeSourceId : undefined)) ? { nativeResultIdHash: hash((evidence.nativeResultId ?? evidence.nativeSourceId)!) } : {}),
        ...(evidence.nativeTurnId ? { nativeTurnIdHash: hash(evidence.nativeTurnId) } : {}),
        ...(evidence.nativeRequestId ? { nativeRequestIdHash: hash(evidence.nativeRequestId) } : {}),
        at: new Date().toISOString(),
      };
      const file = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new OperationsError("OPERATIONS_UNSAFE_FILE");
        await file.writeFile(JSON.stringify(this.context ? signCompatibilityPayload(record, this.context.identity) : record) + "\n");
        await file.sync();
      } finally { await file.close(); }
    });
    this.queue = task.catch((error) => { this.failure = error; });
    return task;
  }
  async drain(): Promise<void> { await this.queue; if (this.failure) throw this.failure; }
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
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || (opened.mode & 0o777) !== 0o600 || opened.size > READ_LIMIT_BYTES) return result([], false);
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
        if ((parsed.v !== 1 && parsed.v !== 2) || parsed.source !== "native") continue;
        const signed = parsed.v === 2 && verifyCompatibilityPayload(parsed);
        if (parsed.v === 2 && !signed) continue;
        const provider = parsed.provider;
        const kind = parsed.kind;
        const outcome = parsed.result;
        if (provider !== "claude" && provider !== "codex") continue;
        if (typeof kind !== "string" || !KINDS.includes(kind)) continue;
        if (outcome !== "passed" && outcome !== "failed" && outcome !== "skipped" && outcome !== "unsupported") continue;
        if (typeof parsed.nativeEvent !== "string" || !/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(parsed.nativeEvent)) continue;
        if (typeof parsed.evidenceCode !== "string" || !CODE.test(parsed.evidenceCode)) continue;
        if (typeof parsed.runId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(parsed.runId)) continue;
        if (typeof parsed.at !== "string" || !Number.isFinite(Date.parse(parsed.at))) continue;
        const attemptIdHash = typeof parsed.attemptIdHash === "string" && MASK.test(parsed.attemptIdHash) ? parsed.attemptIdHash : hash("");
        const artifactValue = parsedArtifact(parsed.artifact, provider);
        if (signed) {
          try { assertCompleteCompatibilityArtifact(artifactValue); } catch { continue; }
          if ((parsed.domain !== "isolated-real" && parsed.domain !== "fixture") || !artifactValue || provider === "claude" && !artifactValue.sdkVersion || !MASK.test(String(parsed.attemptIdHash)) || typeof parsed.sceneVersion !== "string" || !IDENTITY.test(parsed.sceneVersion)
            || typeof parsed.entryDigest !== "string" || !MASK.test(parsed.entryDigest)
            || typeof parsed.capability !== "string" || !capabilityMatches(kind, parsed.capability) || !/^[a-z][a-z0-9._-]{0,95}$/.test(parsed.capability)) continue;
          if (parsed.domain === "isolated-real" && !validProvenance(parsed.provenance, { provider, kind, attemptIdHash }, artifactValue)) continue;
          if (outcome === "passed" && (typeof parsed.nativeSessionIdHash !== "string" || !MASK.test(parsed.nativeSessionIdHash)
            || typeof parsed.launchRef !== "string" || (["turn", "interrupt", "stop"].includes(kind) && !MASK.test(String(provider === "claude" ? parsed.nativeResultIdHash : parsed.nativeTurnIdHash)))
            || (["approval", "question"].includes(kind) && !MASK.test(String(parsed.nativeRequestIdHash)))
            || (["interrupt", "stop"].includes(kind) && typeof parsed.stopRef !== "string"))) continue;
        }
        entries.push(Object.freeze({
          provider, kind: kind as NativeCompatibilityEvidence["kind"], result: outcome, nativeEvent: parsed.nativeEvent, evidenceCode: parsed.evidenceCode,
          attemptIdHash, runId: parsed.runId, at: parsed.at, ...(artifactValue ? { artifact: artifactValue } : {}),
          ...(signed ? { ...(parsed.provenance ? { provenance: parsed.provenance as CompatibilityNativeProvenance } : {}), domain: parsed.domain as "isolated-real" | "fixture", trusted: true, host: parsed.host as CompatibilityHostIdentity, digest: String(parsed.digest), signature: String(parsed.signature),
            capability: String(parsed.capability), sceneVersion: String(parsed.sceneVersion), entryDigest: String(parsed.entryDigest),
            launchRef: String(parsed.launchRef ?? ""), ...(typeof parsed.stopRef === "string" ? { stopRef: parsed.stopRef } : {}) } : {}),
          ...Object.fromEntries(["nativeSessionIdHash", "nativeTurnIdHash", "nativeResultIdHash", "nativeRequestIdHash"].filter((key) => typeof parsed[key] === "string" && MASK.test(String(parsed[key]))).map((key) => [key, parsed[key]])),
        }));
      } catch { /* A malformed line is not evidence. */ }
    }
    return result(entries, true);
  } catch { return result([], false); }
}

/** The trusted accessor used by activation: an unusable log is a typed refusal, not an empty match. */
export interface CompatibilityEvidenceTrust {
  destination?: CompatibilityHostIdentity;
  endorsementPath?: string;
  /** Fixture evidence is visible only to tests that opt into that domain. */
  domain?: "isolated-real" | "fixture";
  host?: Partial<CompatibilityHostIdentity>;
  runId?: string;
  entryDigest?: string;
  sceneVersion?: string;
  now?: number;
  maxAgeMs?: number;
}
/**
 * Reads and fully re-verifies the destination endorsement (directory/file
 * ownership and permissions, destination signature, structural integrity)
 * without comparing its sceneVersion against any expected value. The
 * endorsement's sceneVersion must still be a registered scene identity, so a
 * caller can thread the verified scene back into its trust (§6: a c7-imported
 * destination endorsement is only loadable with trust.sceneVersion = c7).
 */
function trustedEndorsementRecord(trust: CompatibilityEvidenceTrust, now: number): Record<string, unknown> | undefined {
  if (trust.domain === "fixture" || !trust.destination || !trust.endorsementPath) return undefined;
  try {
    const parent = lstatSync(dirname(resolve(trust.endorsementPath)));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || typeof process.getuid === "function" && parent.uid !== process.getuid()) return undefined;
    const fd = openSync(trust.endorsementPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let endorsement: Record<string, unknown> | undefined;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > READ_LIMIT_BYTES || typeof process.getuid === "function" && stat.uid !== process.getuid()) return undefined;
      const candidate: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!verifyCompatibilityPayload(candidate, trust.destination)) return undefined;
      endorsement = candidate;
    } finally { closeSync(fd); }
    if (endorsement.v !== 2 || endorsement.kind !== "compatibility-import" || endorsement.domain !== "destination-endorsement"
      || Date.parse(String(endorsement.expiresAt)) <= now || !Number.isFinite(Date.parse(String(endorsement.expiresAt)))
      || !Number.isFinite(Date.parse(String(endorsement.issuedAt))) || Date.parse(String(endorsement.issuedAt)) > now + 5_000 || !Array.isArray(endorsement.recordDigests) || !Array.isArray(endorsement.capabilities)
      || typeof endorsement.sceneVersion !== "string" || sceneSegments(endorsement.sceneVersion) === undefined
      || ["authorizationDigest", "readinessDigest", "artifactDigest", "evidenceSetDigest", "entryDigest"].some((key) => !MASK.test(String(endorsement![key])))
      || endorsement.recordDigests.some((value) => typeof value !== "string" || !MASK.test(value))) return undefined;
    return endorsement;
  } catch { return undefined; }
}

/**
 * The verified sceneVersion of a destination endorsement, for threading into
 * destination trust construction (activation CLI, restore-external inspection,
 * host activation trust). Undefined means the endorsement is absent or failed
 * re-verification; callers then keep the c3 default.
 */
export function compatibilityEndorsementSceneVersion(endorsementPath: string, destination: CompatibilityHostIdentity, now: number = Date.now()): string | undefined {
  return trustedEndorsementRecord({ destination, endorsementPath }, now)?.sceneVersion as string | undefined;
}

export function loadTrustedCompatibilityEvidence(path: string, limit?: number, trust: CompatibilityEvidenceTrust = {}): readonly CompatibilityEvidenceEntry[] {
  const read = readCompatibilityEvidence(path, limit);
  if (!read.available) throw new OperationsError("PROVIDER_COMPATIBILITY_EVIDENCE_MISSING");
  const now = trust.now ?? Date.now();
  const endorsement = trust.domain === "fixture" ? undefined : trustedEndorsementRecord(trust, now);
  if (trust.domain !== "fixture" && !endorsement) return [];
  if (endorsement && endorsement.sceneVersion !== (trust.sceneVersion ?? "flyx-c3-basic-v1")) return [];
  return read.entries.filter((entry) => entry.trusted && (!endorsement || entry.runId === endorsement.runId && entry.entryDigest === endorsement.entryDigest
      && entry.host?.fingerprint === (endorsement.sourceHost as CompatibilityHostIdentity)?.fingerprint
      && (endorsement.recordDigests as unknown[]).includes(entry.digest) && (endorsement.capabilities as unknown[]).includes(entry.capability)
      && entry.artifact && compatibilityEvidenceArtifactDigest(entry.artifact) === endorsement.artifactDigest)
    && entry.domain === (trust.domain ?? "isolated-real") && entry.sceneVersion === (trust.sceneVersion ?? "flyx-c3-basic-v1")
    && Date.parse(entry.at) <= now + 5_000 && Date.parse(entry.at) >= now - (trust.maxAgeMs ?? 86_400_000)
    && (!trust.runId || entry.runId === trust.runId) && (!trust.entryDigest || entry.entryDigest === trust.entryDigest)
    && (!trust.host || Object.entries(trust.host).every(([key, value]) => entry.host?.[key as keyof CompatibilityHostIdentity] === value)));
}

export function compatibilityEvidenceArtifactDigest(artifact: CompatibilityEvidenceArtifact): string {
  return compatibilityDigest({
    provider: artifact.provider, providerVersion: artifact.providerVersion, executablePath: artifact.executablePath,
    executableDigest: artifact.executableDigest, configFingerprint: artifact.configFingerprint,
    sdkVersion: artifact.sdkVersion ?? null, adapterId: artifact.adapterId ?? null, adapterVersion: artifact.adapterVersion ?? null,
    supervisionContractId: artifact.supervisionContractId, runtimeVersion: artifact.runtimeVersion ?? null, runtimeDigest: artifact.runtimeDigest ?? null,
    nodeVersion: artifact.nodeVersion ?? null, os: artifact.os ?? null,
  });
}

export function compatibilityEvidenceDigest(entry: CompatibilityEvidenceEntry): string {
  if (entry.trusted && entry.digest) return entry.digest;
  return compatibilityDigest({
    provider: entry.provider, kind: entry.kind, result: entry.result, nativeEvent: entry.nativeEvent, evidenceCode: entry.evidenceCode,
    attemptIdHash: entry.attemptIdHash, runId: entry.runId, at: entry.at, artifact: entry.artifact ?? null,
  });
}

export { hash as compatibilityEvidenceHash };
