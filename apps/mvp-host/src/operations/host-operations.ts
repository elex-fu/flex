import Database from "better-sqlite3";
import { z } from "zod";
import type { SqliteStore } from "../storage/db.js";
import { SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { collectDoctor, type DoctorContext } from "../diagnostics/doctor.js";
import { BackupService } from "./backup-service.js";
import { assertRestoreWriteReady, RestoreService, validateBackup, type RestoreOptions } from "./restore-service.js";
import { operationOwnerFromHost, OperationsError, type SnapshotCoordinator } from "./operation-files.js";

type DoctorFacts = Pick<DoctorContext, "readiness" | "providers" | "queues" | "relay">;
/** Share this same instance with identity rotation and Relay registration updates. */
export class OperationSnapshotLane {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly assertActive: () => void) {}
  readonly withSnapshot: SnapshotCoordinator = <T>(work: () => Promise<T>): Promise<T> => {
    const result = this.tail.then(async () => { this.assertActive(); const value = await work(); this.assertActive(); return value; });
    this.tail = result.catch(() => {}); return result;
  };
}
export type HostOperationsOptions = {
  store: SqliteStore; owner: HostOwnerHandle; identityDirectory: string; applicationVersion: string;
  withSnapshot?: SnapshotCoordinator; relay?: { registrationPath: string; relayUrl: string };
  /** Cached, verified public facts only; Doctor never probes a Provider. */
  doctorFacts?(): DoctorFacts;
};
/** Callable runtime bindings; the thin main route owns lifecycle and transport admission. */
export class HostOperations {
  readonly withSnapshot: SnapshotCoordinator;
  constructor(readonly options: HostOperationsOptions) {
    assertHostOwner(options.owner); options.owner.assertStorePath(options.store.db.name);
    this.withSnapshot = options.withSnapshot ?? new OperationSnapshotLane(() => assertHostOwner(options.owner)).withSnapshot;
  }
  readonly assertWriteReady = () => { assertHostOwner(this.options.owner); this.options.store.assertWriterOwner(); assertRestoreWriteReady(this.options.store.db); };
  doctor(access: DoctorContext["access"]) {
    assertHostOwner(this.options.owner);
    const facts = this.options.doctorFacts?.();
    return collectDoctor({ ...facts, ...(this.options.owner.recoveryOnly ? { readiness: { status: "blocked" as const, reasonCodes: ["HOST_RECOVERY_ONLY"] } } : {}), db: this.options.store.db, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, access,
      owner: { mode: this.options.owner.mode === "maintenance" ? "maintenance" : "runtime", state: "active", generation: this.options.owner.generation } });
  }
  backup(directory: string) {
    return new BackupService().create({ db: this.options.store.db, owner: operationOwnerFromHost(this.options.owner), identityDirectory: this.options.identityDirectory,
      directory, applicationVersion: this.options.applicationVersion, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, withSnapshot: this.withSnapshot,
      ...(this.options.relay ? { relay: this.options.relay } : {}) });
  }
  validate(directory: string) { return validateBackup(directory, SUPPORTED_SCHEMA_VERSION); }
}
export function createHostOperations(host: Pick<HostOperationsOptions, "store" | "owner">, options: Omit<HostOperationsOptions, "store" | "owner">): HostOperations {
  return new HostOperations({ ...host, ...options });
}
/** Inject this in Engine, Worker before claim/dispatch, and Catalog write admission. */
export function restoreWriteGuard(store: Pick<SqliteStore, "db">): () => void { return () => assertRestoreWriteReady(store.db); }

export type OfflineHostRestoreOptions = Omit<RestoreOptions, "owner" | "supportedSchemaVersion" | "withSnapshot"> & { owner: HostOwnerHandle; withSnapshot?: SnapshotCoordinator };
export async function restoreHostBackup(options: OfflineHostRestoreOptions) {
  assertHostOwner(options.owner); options.owner.assertStorePath(options.databasePath);
  if (options.owner.mode !== "maintenance") throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
  if (options.owner.recoveryOnly || options.owner.retainedReason) throw new OperationsError("RESTORE_PRODUCERS_UNVERIFIED");
  if (typeof options.assertDatabaseClosed !== "function") throw new OperationsError("RESTORE_PRODUCERS_UNVERIFIED");
  return new RestoreService().restore({ ...options, owner: operationOwnerFromHost(options.owner), supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    withSnapshot: options.withSnapshot ?? new OperationSnapshotLane(() => assertHostOwner(options.owner)).withSnapshot });
}
export function doctorHostDatabase(options: { databasePath: string; facts?: DoctorFacts }) {
  const db = new Database(options.databasePath, { readonly: true, fileMustExist: true });
  try { return collectDoctor({ ...options.facts, db, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, access: { kind: "local" }, owner: { mode: "read_only", state: "unverified" } }); }
  finally { db.close(); }
}
export const HOST_DIAGNOSTICS_RPC_SCOPES = Object.freeze({ "host.doctor": "host:read", "host.getDiagnostics": "host:read" });
export function hostDiagnosticsRpc(operations: HostOperations, method: string, payload: unknown, scopes: ReadonlySet<string>) {
  if (!Object.hasOwn(HOST_DIAGNOSTICS_RPC_SCOPES, method)) throw new OperationsError("METHOD_NOT_FOUND");
  if (!scopes.has("host:read")) throw new OperationsError("FORBIDDEN");
  z.object({}).strict().parse(payload);
  return operations.doctor({ kind: "remote", scopes });
}
/** main parses only routing/configuration; these handlers do all owned work. */
export async function runHostOperationsCli(argv: readonly string[], context: {
  databasePath: string; runtime?: HostOperations; offlineRestore?: Omit<OfflineHostRestoreOptions, "directory" | "rollbackDirectory">;
}) {
  const [command, directory, rollbackDirectory] = argv;
  if (command === "doctor" && argv.length === 1) return context.runtime ? context.runtime.doctor({ kind: "local" }) : doctorHostDatabase({ databasePath: context.databasePath });
  if (command === "validate" && argv.length === 2 && directory) return validateBackup(directory, SUPPORTED_SCHEMA_VERSION);
  if (command === "backup" && argv.length === 2 && directory && context.runtime) return context.runtime.backup(directory);
  if (command === "restore" && argv.length === 3 && directory && rollbackDirectory) {
    if (!context.offlineRestore) throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
    return restoreHostBackup({ ...context.offlineRestore, directory, rollbackDirectory });
  }
  throw new OperationsError("OPERATIONS_INVALID_COMMAND");
}
