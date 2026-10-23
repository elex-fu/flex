import { createHash } from "node:crypto";
import type { ProcessIdentity } from "./process-inspector.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";

export type ProcessBoundaryEvidence = { proof: Readonly<object>; launchDigest: string };
export type ProcessTreeStopEvidence =
  | { kind: "verified-tree-stop"; sourceId: string; identityDigest: string; contractId: string }
  | { kind: "managed-group-stop"; version: 1; sourceId: string; identityDigest: string; contractId: typeof MACOS_MANAGED_STOP_CONTRACT;
      launchDigest: string; processGroup: number; rootExitObserved: true; groupAbsent: true; observedAt: string };

/** Shared canonical identity key for trusted boundary verifiers and the private journal. */
export function processIdentityDigest(identity: ProcessIdentity): string {
  return createHash("sha256").update(JSON.stringify({ pid: identity.pid, platform: identity.platform, ...(identity.birth ? { birth: identity.birth } : {}) })).digest("hex");
}

export function validateTreeStopEvidence(proof: ProcessTreeStopEvidence, identity: ProcessIdentity | undefined, boundary?: ProcessBoundaryEvidence, processGroup?: number): void {
  if (!identity || !proof || !["verified-tree-stop", "managed-group-stop"].includes(proof.kind) || proof.identityDigest !== processIdentityDigest(identity) ||
      proof.kind === "verified-tree-stop" && proof.contractId === MACOS_MANAGED_STOP_CONTRACT ||
      [proof.sourceId, proof.contractId].some((value) => typeof value !== "string" || value.length < 1 || value.length > 512)) {
    throw new Error("PROCESS_STOP_PROOF_INVALID");
  }
  if (proof.kind === "managed-group-stop") {
    const launch = boundary?.proof as { platform?: unknown; managedStopContractId?: unknown; kind?: unknown; stopContractId?: unknown } | undefined;
    if (identity.platform !== "darwin" || proof.version !== 1 || proof.contractId !== MACOS_MANAGED_STOP_CONTRACT
      || !launch || !(launch.platform === "darwin" && launch.managedStopContractId === proof.contractId
        || ["managed-git-launch-plan", "managed-helper-launch-plan"].includes(String(launch.kind)) && launch.stopContractId === proof.contractId)
      || !boundary || !/^[a-f0-9]{64}$/.test(proof.launchDigest) || proof.launchDigest !== boundary.launchDigest
      || proof.processGroup !== identity.pid || proof.processGroup !== processGroup
      || proof.rootExitObserved !== true || proof.groupAbsent !== true || !Number.isFinite(Date.parse(proof.observedAt))) throw new Error("PROCESS_STOP_PROOF_INVALID");
  }
}

export function hasValidProcessStop(record: { state: string; pid?: number; processIdentity?: ProcessIdentity; boundaryEvidence?: ProcessBoundaryEvidence | undefined; processGroup?: number; stopProof?: ProcessTreeStopEvidence }): boolean {
  if (record.state === "not_spawned") return record.pid === undefined;
  if (record.state !== "stopped" || !record.stopProof) return false;
  try { validateTreeStopEvidence(record.stopProof, record.processIdentity, record.boundaryEvidence, record.processGroup); return true; } catch { return false; }
}
