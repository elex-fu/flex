import { assertHostOwner, canonicalPath, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { createHostOperations, runHostOperationsCli, type HostOperationsOptions, type OfflineHostRestoreOptions } from "../operations/host-operations.js";
import { OperationsError, type SnapshotCoordinator } from "../operations/operation-files.js";

export const HOST_OPERATIONS_CLI_USAGE = "doctor | validate <backupDir> | backup <dir> | restore <backupDir> <rollbackDir>";
export type HostOperationsCliCommand =
  | { kind: "operations"; action: "doctor" }
  | { kind: "operations"; action: "validate" | "backup"; directory: string }
  | { kind: "operations"; action: "restore"; directory: string; rollbackDirectory: string };
const directory = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.startsWith("-") && !/[\u0000-\u001f\u007f]/u.test(value);
/** Pure routing: no filesystem, owner acquisition, migration or Provider construction. */
export function parseHostOperationsCommand(args: readonly string[]): HostOperationsCliCommand | undefined {
  const action = args[0];
  if (!["doctor", "validate", "backup", "restore"].includes(action ?? "")) return undefined;
  if (action === "doctor" && args.length === 1) return { kind: "operations", action };
  if ((action === "validate" || action === "backup") && args.length === 2 && directory(args[1])) return { kind: "operations", action, directory: args[1] };
  if (action === "restore" && args.length === 3 && directory(args[1]) && directory(args[2])) return { kind: "operations", action, directory: args[1], rollbackDirectory: args[2] };
  throw new OperationsError("OPERATIONS_INVALID_COMMAND");
}

export type RestoreVerificationScope = Readonly<{
  databasePath: string; identityDirectory: string; ownerId: string; ownerGeneration: number; resourceKeys: readonly string[];
}>;
/** Independently inspect lifecycle/OS evidence and all target DB handles. Owner-lock possession alone is insufficient. */
export type RestoreVerificationPorts = {
  verifyProducersStopped(scope: RestoreVerificationScope): boolean;
  verifyDatabaseClosed(scope: RestoreVerificationScope): boolean;
};
export type BackupCliBinding = HostOperationsOptions & { withSnapshot: SnapshotCoordinator };
export type RestoreCliBinding = Omit<OfflineHostRestoreOptions, "directory" | "rollbackDirectory" | "assertDatabaseClosed"> & { verification: RestoreVerificationPorts };
export type HostOperationsCliContext = {
  databasePath: string;
  /** The same actual lane must also guard identity rotation and local Relay registration writes. */
  backup?: BackupCliBinding;
  /** Caller already holds an exclusive offline maintenance owner; this wrapper never reclaims or clears retention. */
  restore?: RestoreCliBinding;
};

function assertResources(owner: HostOwnerHandle, databasePath: string, identityDirectory: string): void {
  assertHostOwner(owner);
  owner.assertStorePath(databasePath);
  if (!owner.identityDirectory || canonicalPath(identityDirectory) !== canonicalPath(owner.identityDirectory)) throw new OperationsError("OPERATIONS_OWNER_MISMATCH");
}
function requireTrue(value: unknown, code: string): void {
  if (value === true) return;
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") void Promise.resolve(value).catch(() => undefined);
  throw new OperationsError(code);
}
function restoreGuard(binding: RestoreCliBinding, configuredDatabasePath: string): () => void {
  assertResources(binding.owner, configuredDatabasePath, binding.identityDirectory);
  binding.owner.assertStorePath(binding.databasePath);
  const scope: RestoreVerificationScope = Object.freeze({ databasePath: binding.owner.databasePath, identityDirectory: binding.owner.identityDirectory!, ownerId: binding.owner.ownerId, ownerGeneration: binding.owner.generation, resourceKeys: Object.freeze([...binding.owner.resourceKeys]) });
  return () => {
    assertHostOwner(binding.owner);
    if (binding.owner.mode !== "maintenance") throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
    if (binding.owner.recoveryOnly || binding.owner.retainedReason) throw new OperationsError("RESTORE_PRODUCERS_UNVERIFIED");
    if (typeof binding.verification?.verifyProducersStopped !== "function" || typeof binding.verification.verifyDatabaseClosed !== "function") throw new OperationsError("RESTORE_PRODUCERS_UNVERIFIED");
    requireTrue(binding.verification.verifyProducersStopped(scope), "RESTORE_PRODUCERS_UNVERIFIED");
    requireTrue(binding.verification.verifyDatabaseClosed(scope), "RESTORE_DATABASE_NOT_CLOSED");
    // A verifier cannot invalidate or retain the owner and leave an approved result behind.
    assertHostOwner(binding.owner);
    if (binding.owner.mode !== "maintenance") throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
    if (binding.owner.retainedReason || binding.owner.recoveryOnly) throw new OperationsError("RESTORE_PRODUCERS_UNVERIFIED");
  };
}

/** Main supplies trusted configuration/ports; operation services keep validation, rollback and fail-closed restore semantics. */
export async function runHostOperationsCommand(command: HostOperationsCliCommand, context: HostOperationsCliContext) {
  if (command.kind !== "operations") throw new OperationsError("OPERATIONS_INVALID_COMMAND");
  if (command.action === "doctor") return runHostOperationsCli(["doctor"], { databasePath: context.databasePath });
  if (command.action === "validate") {
    parseHostOperationsCommand(["validate", command.directory]);
    return runHostOperationsCli(["validate", command.directory], { databasePath: context.databasePath });
  }
  if (command.action === "backup") {
    parseHostOperationsCommand(["backup", command.directory]);
    const binding = context.backup;
    if (!binding) throw new OperationsError("BACKUP_RUNTIME_REQUIRED");
    if (typeof binding.withSnapshot !== "function") throw new OperationsError("BACKUP_COORDINATOR_REQUIRED");
    assertResources(binding.owner, context.databasePath, binding.identityDirectory);
    binding.store.assertWriterOwner();
    const operations = createHostOperations({ store: binding.store, owner: binding.owner }, binding);
    return runHostOperationsCli(["backup", command.directory], { databasePath: context.databasePath, runtime: operations });
  }
  if (command.action === "restore") {
    parseHostOperationsCommand(["restore", command.directory, command.rollbackDirectory]);
    const binding = context.restore;
    if (!binding) throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
    const assertDatabaseClosed = restoreGuard(binding, context.databasePath);
    assertDatabaseClosed();
    const { verification: _verification, ...options } = binding;
    return runHostOperationsCli(["restore", command.directory, command.rollbackDirectory], { databasePath: context.databasePath, offlineRestore: { ...options, assertDatabaseClosed } });
  }
  throw new OperationsError("OPERATIONS_INVALID_COMMAND");
}
