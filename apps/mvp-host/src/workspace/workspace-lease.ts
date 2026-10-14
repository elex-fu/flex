import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { ExclusiveFileLock, HostOwnershipError, assertHostOwner, defaultCoordinationDirectory, type HostOwnerHandle, type OwnershipRecoveryAuthorization, type OwnershipRecoveryProof, type OwnershipRecoveryVerifier } from "../lifecycle/host-owner.js";
import { SystemProcessInspector, type ProcessInspector } from "../lifecycle/process-inspector.js";

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
    assertHostOwner(options.owner);
    const workspace = realpathSync(options.workspace);
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
  release(): void { this.lock?.release(); }
}
