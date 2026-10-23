/** Ordinary local execution: observable root/group cleanup, not an escaped-descendant proof. */
export const MACOS_MANAGED_STOP_CONTRACT = "managed-process-group/v1/darwin";

export function hasManagedStopContract(proof: { platform?: unknown; verifiedDescendantStop?: unknown; managedStopContractId?: unknown }): boolean {
  return proof.platform === "darwin" && proof.verifiedDescendantStop === false && proof.managedStopContractId === MACOS_MANAGED_STOP_CONTRACT;
}

export function supportsNativeStop(proof: { platform?: unknown; verifiedDescendantStop?: unknown; managedStopContractId?: unknown }): boolean {
  return proof.verifiedDescendantStop === true || hasManagedStopContract(proof);
}

export function nativeStopContractId(proof: { platform?: unknown; verifiedDescendantStop?: unknown; managedStopContractId?: unknown; backend: string; evidenceDigest: string }): string {
  return hasManagedStopContract(proof) ? MACOS_MANAGED_STOP_CONTRACT : `native-boundary/v1/${proof.backend}/${proof.evidenceDigest}`;
}
