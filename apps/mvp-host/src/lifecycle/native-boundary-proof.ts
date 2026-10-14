import { processIdentityDigest } from "./managed-process-evidence.js";
import type { ProcessIdentity, ProcessInspector } from "./process-inspector.js";

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
    && (p.treeIsolation === "unverified" && p.verifiedDescendantStop === false || p.platform === "linux" && p.treeIsolation === "linux_pid_namespace" && p.verifiedDescendantStop === true);
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
