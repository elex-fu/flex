import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { ExclusiveFileLock, assertHostOwner, defaultCoordinationDirectory, type HostOwnerHandle, type OwnershipRecoveryAuthorization } from "../lifecycle/host-owner.js";
import { SystemProcessInspector, type ProcessInspector } from "../lifecycle/process-inspector.js";

const scope = new AsyncLocalStorage<readonly string[]>();
/** Fixed order is task permit -> checkout lease -> sorted common-directory metadata locks. */
export function assertCheckoutLockOrder(): void {
  if (scope.getStore()?.length) throw new Error("WORKSPACE_LOCK_ORDER_INVALID");
}
export function assertTaskPermitLockOrder(): void {
  if (scope.getStore()?.length) throw new Error("HOST_EXECUTION_PERMIT_LOCK_ORDER_INVALID");
}
export type RepositoryMetadataLockOptions = {
  owner: HostOwnerHandle;
  /** Managed read-only query; never a raw spawn or a repositoryId alias. */
  commonDirectory(repository: string): Promise<string>;
  /** Reload original managed helper evidence; neither resolved promises nor root exit are proof. */
  producerStopped(operationId: string): Promise<boolean>;
};

/** Short shared Git metadata scope, independent of a Provider turn's checkout lease. */
export class RepositoryMetadataLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private sealed = false;
  private readonly retained = new Map<string, { lock: ExclusiveFileLock; operationId: string }>();
  constructor(private readonly options: RepositoryMetadataLockOptions) {}
  seal(): void { this.sealed = true; }
  get retainedCount(): number { return this.retained.size; }
  releaseAfterRecovery(operationId: string, authorization: OwnershipRecoveryAuthorization): void {
    const entries = [...this.retained.entries()].filter(([, entry]) => entry.operationId === operationId);
    if (!entries.length || authorization.proof.turnId !== operationId || authorization.proof.resourceKeys.length !== entries.length
      || entries.some(([key]) => !authorization.proof.resourceKeys.includes(key))) throw new Error("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
    for (const [, entry] of entries) entry.lock.validateRecovery(authorization.proof, authorization.verifyProof);
    for (const [key, entry] of entries) { entry.lock.clearRetention(authorization.proof, authorization.verifyProof); entry.lock.release(); this.retained.delete(key); }
  }
  /** Explicit cross-restart maintenance. Every original owner must be proven exited and every authorization validated before any gate is cleared. */
  recoverRetained(options: {
    commonDirectories: readonly string[];
    authorize(ownership: { ownerId: string; ownerGeneration: number; resourceKey: string; purpose: string }): OwnershipRecoveryAuthorization | undefined;
    /** Synchronous committed operation/version CAS after all original handles have been validated. */
    commitAuthorization(): void;
    inspector?: ProcessInspector;
    /** No lock means there is no prior gate to clear; later mutations still acquire their own lock. */
    allowMissing?: boolean;
  }): number {
    assertHostOwner(this.options.owner);
    if (this.sealed) throw new Error("REPOSITORY_METADATA_LOCKS_SEALED");
    if (scope.getStore()?.length) throw new Error("REPOSITORY_LOCK_NESTING_INVALID");
    const keys = [...new Set(options.commonDirectories.map((path) => `repository:${realpathSync(path)}`))].sort();
    if (!keys.length) throw new Error("REPOSITORY_REQUIRED");
    const held: Array<{ lock: ExclusiveFileLock; authorization: OwnershipRecoveryAuthorization; liveKey?: string }> = [];
    try {
      for (const resourceKey of keys) {
        let lock: ExclusiveFileLock;
        const live = this.retained.get(resourceKey);
        try { lock = live?.lock ?? ExclusiveFileLock.acquireRetainedForMaintenance({ directory: this.options.owner.coordinationDirectory ?? defaultCoordinationDirectory(),
          resourceKey, inspector: options.inspector ?? new SystemProcessInspector(), allowUnretainedCrash: true }); }
        catch (error) { if (options.allowMissing && error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
        try {
          const authorization = options.authorize(lock.ownership());
          if (!authorization || authorization.proof.resourceKeys.length !== 1 || authorization.proof.resourceKeys[0] !== resourceKey) throw new Error("REPOSITORY_RECOVERY_EVIDENCE_INVALID");
          held.push({ lock, authorization, ...(live ? { liveKey: resourceKey } : {}) });
        } catch (error) { if (!live) lock.closeMaintenance(); throw error; }
      }
      if (!held.length) return 0;
      for (const { lock, authorization } of held) lock.validateRecovery(authorization.proof, authorization.verifyProof);
      const commit = options.commitAuthorization() as unknown;
      if (commit && typeof (commit as { then?: unknown }).then === "function") throw new Error("REPOSITORY_RECOVERY_COMMIT_MUST_BE_SYNCHRONOUS");
      for (const { lock, authorization } of held) lock.validateRecovery(authorization.proof, authorization.verifyProof);
      // No resource is released while another original gate is still being checked/cleared.
      for (const { lock, authorization } of held) lock.clearRetention(authorization.proof, authorization.verifyProof);
      for (const { lock, liveKey } of held) { lock.release(); if (liveKey) this.retained.delete(liveKey); }
      return held.length;
    } finally { for (const { lock, liveKey } of held) if (!liveKey) lock.closeMaintenance(); }
  }
  async run<T>(repository: string | readonly string[], operationId: string, action: () => Promise<T>, producerStopped?: () => Promise<boolean>): Promise<T> {
    if (scope.getStore()?.length) throw new Error("REPOSITORY_LOCK_NESTING_INVALID");
    if (this.sealed) throw new Error("REPOSITORY_METADATA_LOCKS_SEALED");
    assertHostOwner(this.options.owner);
    if (!operationId) throw new Error("REPOSITORY_OPERATION_REQUIRED");
    const paths = typeof repository === "string" ? [repository] : repository;
    if (!paths.length) throw new Error("REPOSITORY_REQUIRED");
    const keys = [...new Set(await Promise.all(paths.map(async (path) => realpathSync(await this.options.commonDirectory(path)))))].sort();
    const previous = keys.map((key) => this.tails.get(key) ?? Promise.resolve());
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    for (const key of keys) this.tails.set(key, pending);
    await Promise.all(previous);
    const locks: Array<{ key: string; lock: ExclusiveFileLock }> = [];
    let invoked = false;
    try {
      if (this.sealed) throw new Error("REPOSITORY_METADATA_LOCKS_SEALED");
      assertHostOwner(this.options.owner);
      for (const key of keys) locks.push({ key: `repository:${key}`, lock: ExclusiveFileLock.acquire({
        directory: this.options.owner.coordinationDirectory ?? defaultCoordinationDirectory(),
        resourceKey: `repository:${key}`, ownerId: this.options.owner.ownerId, ownerGeneration: this.options.owner.generation,
        purpose: `repository:${operationId}`, inspector: new SystemProcessInspector(),
      }) });
      invoked = true;
      return await scope.run(keys, action);
    } finally {
      let stopped = !invoked;
      if (invoked) { try { stopped = await (producerStopped ? producerStopped() : this.options.producerStopped(operationId)); } catch { stopped = false; } }
      try {
        for (const { key, lock } of locks.reverse()) {
          if (stopped) lock.release();
          else { lock.retain("repository helper stop requires verification"); this.retained.set(key, { lock, operationId }); }
        }
      } finally { for (const key of keys) if (this.tails.get(key) === pending) this.tails.delete(key); complete(); }
      if (!stopped) throw Object.assign(new Error("REPOSITORY_PRODUCER_UNKNOWN"), { code: "REPOSITORY_PRODUCER_UNKNOWN", state: "unknown" as const });
    }
  }
}
