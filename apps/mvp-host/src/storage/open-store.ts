import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { SqliteStore } from "./db.js";

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
