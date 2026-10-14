import type Database from "better-sqlite3";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { SqliteStore } from "./db.js";
import { inspectSchema } from "./migrations/schema-version.js";

export type OwnedStoreOptions = { databasePath: string; owner: HostOwnerHandle };

export function openOwned(options: OwnedStoreOptions): SqliteStore {
  assertHostOwner(options.owner);
  options.owner.assertStorePath(options.databasePath);
  if (options.owner.mode === "maintenance") throw new Error("Host startup requires a Host owner, not a maintenance owner");
  return new SqliteStore(options.databasePath, { mode: "owned", owner: options.owner });
}

/** No file creation, DDL, migration, recovery or identity creation. */
export function openReadOnly(databasePath: string): SqliteStore {
  return new SqliteStore(databasePath, { mode: "readonly" });
}

/** Mutating maintenance always requires exclusive offline ownership. */
export function openForMaintenance(options: OwnedStoreOptions): SqliteStore {
  assertHostOwner(options.owner);
  options.owner.assertStorePath(options.databasePath);
  if (options.owner.mode !== "maintenance") throw new Error("Offline maintenance ownership is required");
  if (options.owner.recoveryOnly) throw new Error("Recovery maintenance cannot migrate or initialize Host data");
  return new SqliteStore(options.databasePath, { mode: "maintenance", owner: options.owner });
}

/** Local revocation only: existing current schema, bounded connection timeout, no recovery. */
export function openForManagement(databasePath: string): SqliteStore {
  return new SqliteStore(databasePath, { mode: "management" });
}

/** Retained original owner + held exclusion; existing schema only, never DDL or startup recovery. */
export function openForRecoveryMaintenance(options: OwnedStoreOptions): SqliteStore {
  assertHostOwner(options.owner);
  options.owner.assertStorePath(options.databasePath);
  if (options.owner.mode !== "maintenance" || !options.owner.recoveryOnly) throw new Error("A retained recovery-maintenance owner is required");
  return new SqliteStore(options.databasePath, { mode: "recovery-maintenance", owner: options.owner });
}

/**
 * Explicit local SQL-only upgrade before an offline Recovery journal exists.
 * The normal recovery opener does no DDL. This caller-supplied migration must
 * be trusted code from the installed Host, not an RPC payload or Provider.
 */
export function upgradeForRecoveryMaintenance<T>(owner: HostOwnerHandle, db: Database.Database,
  pureMetadataMigration: (connection: Database.Database) => T): T {
  assertHostOwner(owner);
  owner.assertStorePath(db.name);
  if (!owner.recoveryOnly || owner.mode !== "maintenance" || db.readonly || !owner.retainedReason) {
    throw new Error("A held retained recovery-maintenance writer is required for metadata upgrade");
  }
  const retained = owner.retainedReason;
  const before = inspectSchema(db);
  if (before.version < 3) throw new Error("Recovery metadata upgrade requires an existing supported baseline");
  return db.transaction(() => {
    owner.assertActive();
    const result = pureMetadataMigration(db);
    if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
      throw new Error("SYNCHRONOUS_METADATA_MIGRATION_REQUIRED");
    }
    // Future markers or corrupt installed-schema declarations roll back the
    // entire explicit upgrade. Parent adds each installed migration validator.
    inspectSchema(db);
    owner.assertActive();
    if (owner.retainedReason !== retained) throw new Error("Metadata upgrade must preserve retained ownership until committed recovery proof");
    return result;
  })();
}
