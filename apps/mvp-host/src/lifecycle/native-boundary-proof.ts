import { processIdentityDigest } from "./managed-process-evidence.js";
import type { ProcessIdentity, ProcessInspector } from "./process-inspector.js";
import { hasManagedStopContract, MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";

export type NativeBoundaryPlatform = "darwin" | "linux";
export type NativeBoundaryBackend = "macos_seatbelt" | "linux_bubblewrap";
export type NativeBoundaryProof = Readonly<{
  version: 1;
  boundaryId: string;
  platform: NativeBoundaryPlatform;
  kernelRelease: string;
  backend: NativeBoundaryBackend;
  backendVersion: string;
  backendDigest: string;
  policyDigest: string;
  evidenceDigest: string;
  verifiedPrivateReadBoundary: true;
  verifiedPrivateWriteBoundary: true;
  verifiedChildInheritance: true;
  treeIsolation: "unverified" | "linux_pid_namespace";
  verifiedDescendantStop: boolean;
  /** Explicit ordinary mode; never upgrades the descendant-stop boolean. */
  managedStopContractId?: typeof MACOS_MANAGED_STOP_CONTRACT;
  verifiedWorkspaceWriteBoundary?: true;
}>;
export type NativeBoundaryReadinessCode = "NATIVE_BOUNDARY_READY" | "NATIVE_BOUNDARY_PLATFORM_UNSUPPORTED" | "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE" | "NATIVE_BOUNDARY_BACKEND_UNTRUSTED" | "NATIVE_BOUNDARY_POLICY_INVALID" | "NATIVE_BOUNDARY_SELF_TEST_FAILED" | "NATIVE_BOUNDARY_CHANGED" | "NATIVE_BOUNDARY_CLOSED" | "NATIVE_BOUNDARY_SPAWN_INVALID";
export type NativeBoundaryPublicSummary = Readonly<{
  ready: boolean;
  code: NativeBoundaryReadinessCode;
  platform: NodeJS.Platform;
  backend?: NativeBoundaryBackend;
  proof?: NativeBoundaryProof;
}>;
export class NativeBoundaryError extends Error {
  readonly retryable = false;
  constructor(readonly code: NativeBoundaryReadinessCode) { super(code); this.name = "NativeBoundaryError"; }
}
export function nativeIdentityDigest(identity: ProcessIdentity): string {
  return processIdentityDigest(identity);
}
export function isNativeBoundaryProof(value: unknown): value is NativeBoundaryProof {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<NativeBoundaryProof>;
  return p.version === 1 && typeof p.boundaryId === "string" && /^[a-f0-9-]{36}$/.test(p.boundaryId)
    && (p.platform === "darwin" && p.backend === "macos_seatbelt" || p.platform === "linux" && p.backend === "linux_bubblewrap")
    && [p.backendDigest, p.policyDigest, p.evidenceDigest].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
    && typeof p.kernelRelease === "string" && typeof p.backendVersion === "string"
    && p.verifiedPrivateReadBoundary === true && p.verifiedPrivateWriteBoundary === true && p.verifiedChildInheritance === true
    && (p.treeIsolation === "unverified" && p.verifiedDescendantStop === false || p.platform === "linux" && p.treeIsolation === "linux_pid_namespace" && p.verifiedDescendantStop === true)
    && (p.managedStopContractId === undefined || hasManagedStopContract(p))
    && (p.verifiedWorkspaceWriteBoundary === undefined || p.verifiedWorkspaceWriteBoundary === true && hasManagedStopContract(p));
}

export const NATIVE_RAW_PROCESS_EVIDENCE_VERSION = 1;

/**
 * Original operating-system launch/popen observation. It is recorded once,
 * together with the durable launching row, and is the immutable identity of
 * that launch: a later proof (newer backend, supervisor or proof version) may
 * be stored beside it but must never replace or rewrite it. The `version` /
 * `kind` fields are part of the stored JSON so a future proof variant can
 * coexist without reinterpreting v1 records.
 */
export type NativeRawLaunchEvidenceV1 = Readonly<{
  version: 1;
  kind: "original_launch";
  platform: NativeBoundaryPlatform;
  backend: NativeBoundaryBackend;
  /** Raw root PID reported by the OS at the original launch. */
  pid: number;
  launchDigest: string;
  observedAt: string;
}>;

/** Later root observation for the same launch; an observation, never a stop proof. */
export type NativeRawExitEvidenceV1 = Readonly<{
  version: 1;
  kind: "root_exit";
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  observedAt: string;
}>;

export type NativeRawProcessEvidence = NativeRawLaunchEvidenceV1 | NativeRawExitEvidenceV1;

/**
 * Durable raw-evidence ledger for one launch. `launch` is the original
 * identity; `later` only grows and never includes a replacement original.
 */
export type NativeRawEvidenceLedgerV1 = Readonly<{
  version: 1;
  launch: NativeRawLaunchEvidenceV1;
  later: readonly NativeRawProcessEvidence[];
}>;

export type NativeRawEvidenceErrorCode = "NATIVE_RAW_EVIDENCE_INVALID" | "NATIVE_RAW_EVIDENCE_CONFLICT";
export class NativeRawEvidenceError extends Error {
  readonly retryable = false;
  constructor(readonly code: NativeRawEvidenceErrorCode) { super(code); this.name = "NativeRawEvidenceError"; }
}

function rawBackendMatches(platform: unknown, backend: unknown): boolean {
  return platform === "darwin" && backend === "macos_seatbelt" || platform === "linux" && backend === "linux_bubblewrap";
}
function rawPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isNativeRawLaunchEvidence(value: unknown): value is NativeRawLaunchEvidenceV1 {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<NativeRawLaunchEvidenceV1>;
  return evidence.version === NATIVE_RAW_PROCESS_EVIDENCE_VERSION && evidence.kind === "original_launch"
    && rawBackendMatches(evidence.platform, evidence.backend) && rawPid(evidence.pid)
    && typeof evidence.launchDigest === "string" && /^[a-f0-9]{64}$/.test(evidence.launchDigest)
    && typeof evidence.observedAt === "string" && evidence.observedAt.length > 0;
}

export function isNativeRawProcessEvidence(value: unknown): value is NativeRawProcessEvidence {
  if (isNativeRawLaunchEvidence(value)) return true;
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<NativeRawExitEvidenceV1>;
  return evidence.version === NATIVE_RAW_PROCESS_EVIDENCE_VERSION && evidence.kind === "root_exit"
    && rawPid(evidence.pid)
    && (evidence.code === null || Number.isSafeInteger(evidence.code))
    && (evidence.signal === null || typeof evidence.signal === "string")
    && typeof evidence.observedAt === "string" && evidence.observedAt.length > 0;
}

/** Freeze the original launch identity into a fresh ledger; it is never mutated in place. */
export function nativeRawEvidenceLedger(launch: NativeRawLaunchEvidenceV1): NativeRawEvidenceLedgerV1 {
  if (!isNativeRawLaunchEvidence(launch)) throw new NativeRawEvidenceError("NATIVE_RAW_EVIDENCE_INVALID");
  return Object.freeze({ version: NATIVE_RAW_PROCESS_EVIDENCE_VERSION, launch: Object.freeze({ ...launch }), later: Object.freeze([]) });
}

/**
 * Append a later observation beside the original launch. A record that tries
 * to overwrite the original identity (another `original_launch`, or an exit
 * for another PID) is a conflict: the stored ledger is left untouched and the
 * caller must keep the original launch identity.
 */
export function appendNativeRawProcessEvidence(ledger: NativeRawEvidenceLedgerV1, incoming: NativeRawProcessEvidence): NativeRawEvidenceLedgerV1 {
  if (!ledger || typeof ledger !== "object" || ledger.version !== NATIVE_RAW_PROCESS_EVIDENCE_VERSION
    || !isNativeRawLaunchEvidence(ledger.launch) || !Array.isArray(ledger.later) || !ledger.later.every(isNativeRawProcessEvidence)
    || !isNativeRawProcessEvidence(incoming)) throw new NativeRawEvidenceError("NATIVE_RAW_EVIDENCE_INVALID");
  if (incoming.kind !== "root_exit") throw new NativeRawEvidenceError("NATIVE_RAW_EVIDENCE_CONFLICT");
  if (incoming.pid !== ledger.launch.pid) throw new NativeRawEvidenceError("NATIVE_RAW_EVIDENCE_CONFLICT");
  return Object.freeze({ version: NATIVE_RAW_PROCESS_EVIDENCE_VERSION, launch: ledger.launch, later: Object.freeze([...ledger.later, Object.freeze({ ...incoming })]) });
}

/** Proof must be reloaded and verified against the original durable launch, never supplied by an RPC caller. */
export function inspectNativeBoundaryStop(
  proof: unknown,
  identity: ProcessIdentity,
  inspector: ProcessInspector,
  verifyStoredProof: (proof: NativeBoundaryProof, identity: ProcessIdentity) => boolean,
): { state: "stopped" | "running" | "unknown"; sourceId?: string; contractId?: string; identityDigest?: string } {
  if (!isNativeBoundaryProof(proof) || identity.platform !== proof.platform || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return { state: "unknown" };
  let observed: ReturnType<ProcessInspector["inspect"]>;
  try { if (!verifyStoredProof(proof, identity)) return { state: "unknown" }; observed = inspector.inspect(identity); }
  catch { return { state: "unknown" }; }
  if (observed.state === "alive") return { state: "running" };
  if (observed.state !== "exited" || proof.platform !== "linux" || proof.treeIsolation !== "linux_pid_namespace" || !proof.verifiedDescendantStop || !identity.birth || identity.birth.kind !== "linux" || !/^[a-f0-9-]{36}$/i.test(identity.birth.bootId) || !/^\d+$/.test(identity.birth.startTicks)) return { state: "unknown" };
  const identityDigest = nativeIdentityDigest(identity);
  return { state: "stopped", sourceId: proof.boundaryId + ":" + identityDigest, contractId: "native-boundary/v1/" + proof.backend + "/" + proof.evidenceDigest, identityDigest };
}
