import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { ExclusiveFileLock, HostOwnershipError, assertHostOwner, canonicalPath, defaultCoordinationDirectory, type HostOwnerHandle, type OwnershipRecoveryAuthorization, type OwnershipRecoveryProof, type OwnershipRecoveryVerifier } from "../lifecycle/host-owner.js";
import { SystemProcessInspector, type ProcessInspector } from "../lifecycle/process-inspector.js";
import { assertCheckoutLockOrder } from "./repository-metadata-lock.js";

export type WorkspaceLeaseOptions = {
  workspace: string;
  owner: HostOwnerHandle;
  operationId?: string;
  coordinationDirectory?: string;
  inspector?: ProcessInspector;
  recovery?: OwnershipRecoveryAuthorization;
};

/** Coordinates the actual checkout across Hosts using different SQLite files. */
export class WorkspaceLease {
  readonly workspace: string;
  readonly operationId: string;
  get resourceKey(): string { return `workspace:${this.workspace}`; }
  private constructor(private readonly lock: ExclusiveFileLock | undefined, private readonly owner: HostOwnerHandle, workspace: string, operationId: string) {
    this.workspace = workspace;
    this.operationId = operationId;
  }

  static acquire(options: WorkspaceLeaseOptions): WorkspaceLease {
    assertCheckoutLockOrder();
    assertHostOwner(options.owner);
    const workspace = realpathSync(options.workspace);
    return this.acquireAt(options,workspace);
  }

  /** Trusted local managed-record seam; RPC callers must never supply this path. */
  static acquireReserved(options: Omit<WorkspaceLeaseOptions,"workspace"> & {canonicalWorkspace:string}): WorkspaceLease {
    assertCheckoutLockOrder();
    assertHostOwner(options.owner);
    const workspace=canonicalPath(options.canonicalWorkspace);
    if(workspace!==options.canonicalWorkspace)throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID","Reserved checkout must use its exact original canonical managed path.");
    return this.acquireAt({...options,workspace},workspace);
  }

  private static acquireAt(options:WorkspaceLeaseOptions,workspace:string):WorkspaceLease {
    const operationId = options.operationId ?? randomUUID();
    if (options.recovery && (options.recovery.proof.resourceKeys.length !== 1 || options.recovery.proof.resourceKeys[0] !== `workspace:${workspace}`)) {
      throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID", "Recovery evidence belongs to a different checkout.");
    }
    // An explicitly ephemeral test host cannot conflict with a real daemon.
    // File-backed test hosts take the same checkout lease as production.
    const lock = options.owner.mode === "test" ? undefined : ExclusiveFileLock.acquire({
      directory: options.coordinationDirectory ?? options.owner.coordinationDirectory ?? defaultCoordinationDirectory(),
      resourceKey: `workspace:${workspace}`, ownerId: options.owner.ownerId, ownerGeneration: options.owner.generation,
      purpose: `workspace:${operationId}`, inspector: options.inspector ?? new SystemProcessInspector(),
      ...(options.recovery ? { reclaimStale: true, recovery: options.recovery } : {}),
    });
    return new WorkspaceLease(lock, options.owner, workspace, operationId);
  }

  assertActive(): void { this.owner.assertActive(); this.lock?.assertActive(); }
  ownership(): { ownerId: string; ownerGeneration: number; resourceKey: string } {
    return this.lock?.ownership() ?? { ownerId: this.owner.ownerId, ownerGeneration: this.owner.generation, resourceKey: this.resourceKey };
  }
  retain(reason: string): void { this.lock?.retain(reason); }
  clearRetention(proof: OwnershipRecoveryProof, verifyProof: OwnershipRecoveryVerifier): void {
    this.assertActive();
    if (proof.resourceKeys.length !== 1 || proof.resourceKeys[0] !== this.resourceKey || proof.turnId !== this.operationId) {
      throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID", "Recovery evidence belongs to a different checkout operation.");
    }
    this.lock?.clearRetention(proof, verifyProof);
  }
  static reclaimAfterRecovery(options: WorkspaceLeaseOptions & { recovery: OwnershipRecoveryAuthorization }): WorkspaceLease {
    return this.acquire(options);
  }
  /** Explicit resumed-operation recovery holds the old lock while inspecting the original exited owner and authorization. */
  static recoverReserved(options: Omit<WorkspaceLeaseOptions, "workspace" | "recovery"> & { canonicalWorkspace: string;
    authorize(ownership: { ownerId: string; ownerGeneration: number; resourceKey: string; purpose: string }): OwnershipRecoveryAuthorization | undefined;
  }): WorkspaceLease {
    assertCheckoutLockOrder(); assertHostOwner(options.owner);
    const workspace = canonicalPath(options.canonicalWorkspace);
    if (workspace !== options.canonicalWorkspace || !options.operationId) throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID", "Recovery requires the exact original checkout operation");
    const lock = ExclusiveFileLock.acquireRetainedForMaintenance({ directory: options.coordinationDirectory ?? options.owner.coordinationDirectory ?? defaultCoordinationDirectory(),
      resourceKey: `workspace:${workspace}`, inspector: options.inspector ?? new SystemProcessInspector(), allowUnretainedCrash: true });
    try {
      const authorization = options.authorize(lock.ownership());
      if (!authorization || authorization.proof.turnId !== options.operationId || authorization.proof.resourceKeys.length !== 1 || authorization.proof.resourceKeys[0] !== `workspace:${workspace}`) throw new HostOwnershipError("OWNER_RECOVERY_EVIDENCE_INVALID", "Committed recovery must cover the original checkout operation");
      lock.validateRecovery(authorization.proof, authorization.verifyProof);
      lock.clearRetention(authorization.proof, authorization.verifyProof); lock.release();
    } finally { lock.closeMaintenance(); }
    return this.acquireAt({ ...options, workspace }, workspace);
  }
  release(): void { this.lock?.release(); }
}
