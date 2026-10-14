import { createHash } from "node:crypto";
import type { ProcessIdentity } from "./process-inspector.js";

export type ProcessBoundaryEvidence = { proof: Readonly<object>; launchDigest: string };
export type ProcessTreeStopEvidence = { kind: "verified-tree-stop"; sourceId: string; identityDigest: string; contractId: string };

/** Shared canonical identity key for trusted boundary verifiers and the private journal. */
export function processIdentityDigest(identity: ProcessIdentity): string {
  return createHash("sha256").update(JSON.stringify({ pid: identity.pid, platform: identity.platform, ...(identity.birth ? { birth: identity.birth } : {}) })).digest("hex");
}

export function validateTreeStopEvidence(proof: ProcessTreeStopEvidence, identity: ProcessIdentity | undefined): void {
  if (!identity || proof.kind !== "verified-tree-stop" || proof.identityDigest !== processIdentityDigest(identity) ||
      [proof.sourceId, proof.contractId].some((value) => typeof value !== "string" || value.length < 1 || value.length > 512)) {
    throw new Error("PROCESS_STOP_PROOF_INVALID");
  }
}
