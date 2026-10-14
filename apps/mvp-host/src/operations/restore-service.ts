import { constants } from "node:fs";
import { z } from "zod";
import Database from "better-sqlite3";
import { copyFile, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { readRelayRegistration } from "../relay/relay-registration.js";
import { BackupManifestSchema, BackupService, type BackupManifest } from "./backup-service.js";
import { assertPrivateDirectory, bindOwner, columns, digest, fileDigest, hasTable, identityMirror, OperationsError, privateDatabaseFile, readPrivateFile, syncDirectory, validateDatabase, type OperationOwner, type SnapshotCoordinator } from "./operation-files.js";

export const RestoreReadinessGateSchema = z.object({
  v: z.literal(1),
  status: z.literal("external_state_unverified"),
  restoredAt: z.string().datetime(),
  backupCreatedAt: z.string().datetime(),
  possibleDispatchIntents: z.number().int().nonnegative(),
  reasonCodes: z.tuple([z.literal("RESTORE_GIT_STATE_UNVERIFIED"), z.literal("RESTORE_PROVIDER_HISTORY_UNVERIFIED")]),
  relayRegistrationInvalidated: z.boolean(),
}).strict();
export type RestoreReadinessGate = z.infer<typeof RestoreReadinessGateSchema>;

export function readRestoreReadinessGate(db: Database.Database): RestoreReadinessGate | undefined {
  if (!hasTable(db, "host_state")) return undefined;
  const row = db.prepare("SELECT value_json FROM host_state WHERE key = 'restore_readiness'").get() as { value_json: string } | undefined;
  if (!row) return undefined;
  let value: unknown;
  try { value = JSON.parse(row.value_json); } catch { throw new OperationsError("RESTORE_GATE_INVALID"); }
  const parsed = RestoreReadinessGateSchema.safeParse(value);
  if (!parsed.success) throw new OperationsError("RESTORE_GATE_INVALID");
  return parsed.data;
}

export function assertRestoreWriteReady(db: Database.Database): void {
  if (readRestoreReadinessGate(db)) throw new OperationsError("RESTORE_EXTERNAL_STATE_UNVERIFIED");
}

export interface RestoreOptions {
  owner: OperationOwner;
  databasePath: string;
  directory: string;
  rollbackDirectory: string;
  identityDirectory: string;
  applicationVersion: string;
  supportedSchemaVersion: number;
  withSnapshot: SnapshotCoordinator;
  /** Must prove all local database handles and producers have stopped. */
  assertDatabaseClosed: () => void;
  relay?: { registrationPath: string; relayUrl: string };
  now?: () => Date;
  /** Integration hook for stricter future-schema recovery invariants. */
  prepareRestoredDatabase?: (db: Database.Database, gate: RestoreReadinessGate) => void;
  beforeInstall?: () => void | Promise<void>;
}

export async function validateBackup(directory: string, supportedVersion: number): Promise<BackupManifest> {
  const root = await assertPrivateDirectory(directory);
  let manifest: BackupManifest;
  try { manifest = BackupManifestSchema.parse(JSON.parse((await readPrivateFile(join(root, "manifest.json"), 32_768)).toString("utf8"))); }
  catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError("BACKUP_MANIFEST_INVALID"); }
  if (await fileDigest(join(root, manifest.database.file)) !== manifest.database.sha256
    || digest(await readPrivateFile(join(root, manifest.identity.file), 16_384)) !== manifest.identity.sha256
    || (manifest.relay && digest(await readPrivateFile(join(root, manifest.relay.file), 16_384)) !== manifest.relay.sha256)) throw new OperationsError("BACKUP_HASH_MISMATCH");
  const identity = await loadOrCreateHostIdentity({ directory: root, expectedMirror: manifest.identity });
  if (identity.fingerprint !== manifest.identity.fingerprint) throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
  if (manifest.relay) {
    let relayBytes: { relayUrl?: string };
    try { relayBytes = JSON.parse((await readPrivateFile(join(root, manifest.relay.file), 16_384)).toString("utf8")) as { relayUrl?: string }; }
    catch { throw new OperationsError("BACKUP_MANIFEST_INVALID"); }
    if (typeof relayBytes.relayUrl !== "string") throw new OperationsError("BACKUP_MANIFEST_INVALID");
    const registration = await readRelayRegistration(join(root, manifest.relay.file), relayBytes.relayUrl);
    if (!registration || registration.generation !== manifest.relay.generation) throw new OperationsError("BACKUP_RELAY_MISMATCH");
  }
  const db = new Database(join(root, manifest.database.file), { readonly: true, fileMustExist: true });
  try {
    const validation = validateDatabase(db, supportedVersion);
    if (validation.schema.migrationVersion !== manifest.schema.migrationVersion || validation.schema.userVersion !== manifest.schema.userVersion
      || validation.checkedContentRefs !== manifest.checkedContentRefs) throw new OperationsError("BACKUP_MANIFEST_MISMATCH");
    const mirror = identityMirror(db);
    if (mirror.hostId !== manifest.identity.hostId || mirror.fingerprint !== manifest.identity.fingerprint) throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
  } finally { db.close(); }
  return manifest;
}

function updateIfPresent(db: Database.Database, table: string, column: string, sql: string, timestamp: string): void {
  if (hasTable(db, table) && columns(db, table).has(column)) db.prepare(sql).run(timestamp);
}

/** Every credential and lease from the historical database fails closed. */
export function invalidateRestoredAccess(db: Database.Database, timestamp: string): number {
  if (!db.inTransaction) return db.transaction(() => invalidateRestoredAccess(db, timestamp))();
  updateIfPresent(db, "pairing_grants", "consumed_at", "UPDATE pairing_grants SET consumed_at = COALESCE(consumed_at, ?)", timestamp);
  updateIfPresent(db, "auth_sessions", "revoked_at", "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?)", timestamp);
  if (hasTable(db, "devices")) {
    const available = columns(db, "devices");
    if (!available.has("revoked_at") || !available.has("credential_revision")) throw new OperationsError("RESTORE_ACCESS_SCHEMA_UNSUPPORTED");
    db.prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), credential_revision = credential_revision + 1" + (available.has("credential_hash") ? ", credential_hash = NULL" : "")).run(timestamp);
  }
  updateIfPresent(db, "protocol_sessions", "disconnected_at", "UPDATE protocol_sessions SET disconnected_at = COALESCE(disconnected_at, ?), close_code = 'HOST_RESTORED'", timestamp);
  let possibleDispatchIntents = 0;
  if (hasTable(db, "execution_intents")) {
    const available = columns(db, "execution_intents");
    if (!available.has("state") || !available.has("updated_at")) throw new OperationsError("RESTORE_INTENT_SCHEMA_UNSUPPORTED");
    const assignments = ["state = 'outcome_unknown'", "updated_at = ?"];
    if (available.has("claim_owner_id")) assignments.push("claim_owner_id = NULL");
    if (available.has("claim_owner_generation")) assignments.push("claim_owner_generation = NULL");
    if (available.has("result_code")) assignments.push("result_code = CASE WHEN state = 'outcome_unknown' THEN COALESCE(result_code, 'HOST_RESTORED') ELSE 'HOST_RESTORED' END");
    possibleDispatchIntents = db.prepare("UPDATE execution_intents SET " + assignments.join(", ") + " WHERE state IN ('pending', 'claimed', 'dispatching', 'acknowledged', 'outcome_unknown')").run(timestamp).changes;
  }
  db.prepare("UPDATE turns SET status = 'outcome_unknown' WHERE status IN ('queued', 'running', 'waiting_approval', 'interrupting')").run();
  const sessionColumns = columns(db, "sessions");
  if (["active_turn_id", "recovery_state", "recovery_revision"].every((name) => sessionColumns.has(name))) {
    // Every pre-restore inspection/evidence revision is stale. Keep the active
    // relation for original-execution recovery, and never manufacture an idle gate.
    db.prepare(`UPDATE sessions SET recovery_revision = recovery_revision + 1,
      recovery_state = CASE WHEN active_turn_id IS NOT NULL OR recovery_state = 'blocked' THEN 'blocked' ELSE recovery_state END,
      activity_state = CASE WHEN active_turn_id IS NOT NULL OR EXISTS(SELECT 1 FROM turns t WHERE t.session_id=sessions.id AND t.status='outcome_unknown') THEN 'outcome_unknown' ELSE activity_state END,
      updated_at = ?`).run(timestamp);
    if (hasTable(db, "recovery_operations")) db.prepare("UPDATE recovery_operations SET phase = 'blocked', result_json = ?, updated_at = ? WHERE phase IN ('marked','checking')")
      .run(JSON.stringify({ status: "blocked", reasonCode: "HOST_RESTORED" }), timestamp);
  } else db.prepare("UPDATE sessions SET activity_state = 'outcome_unknown', updated_at = ? WHERE id IN (SELECT session_id FROM turns WHERE status = 'outcome_unknown')").run(timestamp);
  const receipts = db.prepare("SELECT auth_subject_id, command_id, response_json FROM command_receipts WHERE state = 'accepted'").all() as Array<{ auth_subject_id: string; command_id: string; response_json: string }>;
  for (const receipt of receipts) {
    let previous: Record<string, unknown> = {};
    try { const value: unknown = JSON.parse(receipt.response_json); if (value && typeof value === "object" && !Array.isArray(value)) previous = value as Record<string, unknown>; }
    catch { throw new OperationsError("RESTORE_RECEIPT_INVALID"); }
    const response: Record<string, string> = { status: "outcome_unknown", reason: "host_restore" };
    for (const key of ["turnId", "sessionId", "approvalId", "interactionId", "operationId"]) if (typeof previous[key] === "string") response[key] = previous[key];
    db.prepare("UPDATE command_receipts SET state = 'outcome_unknown', response_json = ?, updated_at = ? WHERE auth_subject_id = ? AND command_id = ?")
      .run(JSON.stringify(response), timestamp, receipt.auth_subject_id, receipt.command_id);
  }
  if (hasTable(db, "approvals")) db.prepare("UPDATE approvals SET status = 'superseded', version = version + 1, resolved_at = ? WHERE status = 'pending'").run(timestamp);
  if (hasTable(db, "approval_reservations")) db.prepare("UPDATE approval_reservations SET state = 'outcome_unknown', updated_at = ? WHERE state IN ('accepted','local_delivery','outcome_unknown')").run(timestamp);
  if (hasTable(db, "interactions")) {
    const required = ["status", "delivery_state", "evidence_kind", "reason_code", "version", "updated_at"];
    if (required.some((name) => !columns(db, "interactions").has(name))) throw new OperationsError("RESTORE_INTERACTION_SCHEMA_UNSUPPORTED");
    db.prepare(`UPDATE interactions SET delivery_state = CASE WHEN status = 'pending' THEN 'none' ELSE 'unconfirmed' END,
      evidence_kind = CASE WHEN status = 'pending' THEN evidence_kind ELSE 'unknown' END,
      status = 'superseded', reason_code = 'HOST_RESTORED', version = version + 1, updated_at = ?
      WHERE status IN ('pending','responding','outcome_unknown')`).run(timestamp);
  }
  if (hasTable(db, "attention_facts")) {
    if (!columns(db, "attention_facts").has("superseded_at")) throw new OperationsError("RESTORE_ATTENTION_SCHEMA_UNSUPPORTED");
    db.prepare("UPDATE attention_facts SET superseded_at = COALESCE(superseded_at, ?)").run(timestamp);
  }
  if (hasTable(db, "attention_push_subscriptions")) {
    if (!columns(db, "attention_push_subscriptions").has("revoked_at")) throw new OperationsError("RESTORE_ATTENTION_SCHEMA_UNSUPPORTED");
    db.prepare("UPDATE attention_push_subscriptions SET revoked_at = COALESCE(revoked_at, ?)").run(timestamp);
  }
  if (hasTable(db, "attention_deliveries")) {
    if (["state", "result_code", "updated_at"].some((name) => !columns(db, "attention_deliveries").has(name))) throw new OperationsError("RESTORE_ATTENTION_SCHEMA_UNSUPPORTED");
    db.prepare("UPDATE attention_deliveries SET state = 'cancelled', result_code = 'HOST_RESTORED', updated_at = ? WHERE state IN ('pending','dispatching','accepted','provider_delivered','outcome_unknown')").run(timestamp);
  }
  // Offline history installation must never resume a cached future branch.
  // Startup prepares a validated fresh epoch before capabilities are admitted.
  if (hasTable(db, "timeline_epochs")) db.prepare("UPDATE timeline_epochs SET state = 'retired' WHERE state IN ('active','building')").run();
  return possibleDispatchIntents;
}

/** Installs database history only. External Git/Provider state is never rewound here. */
export class RestoreService {
  async restore(options: RestoreOptions): Promise<{ rollbackDirectory: string; manifest: BackupManifest; readiness: RestoreReadinessGate }> {
    if (options.owner.mode !== "maintenance") throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
    if (typeof options.withSnapshot !== "function") throw new OperationsError("BACKUP_COORDINATOR_REQUIRED");
    return options.withSnapshot(() => this.restoreUnderSnapshot(options));
  }

  private async restoreUnderSnapshot(options: RestoreOptions): Promise<{ rollbackDirectory: string; manifest: BackupManifest; readiness: RestoreReadinessGate }> {
    await bindOwner(options.owner, options.databasePath);
    options.assertDatabaseClosed();
    const manifest = await validateBackup(options.directory, options.supportedSchemaVersion);
    const currentIdentity = await loadOrCreateHostIdentity({ directory: options.identityDirectory, expectedMirror: manifest.identity });
    if (currentIdentity.fingerprint !== manifest.identity.fingerprint) throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
    const target = resolve(options.databasePath);
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new OperationsError("RESTORE_TARGET_UNSAFE");
    const staging = join(dirname(target), ".restore-" + randomUUID() + ".sqlite");
    let rollbackDirectory = "";
    try {
      // The entire restore owns the shared lane; do not reacquire it for backup.
      const current = new Database(target, { fileMustExist: true });
      try {
        const rollback = await new BackupService().create({
          db: current, owner: options.owner, identityDirectory: options.identityDirectory, directory: options.rollbackDirectory,
          applicationVersion: options.applicationVersion, supportedSchemaVersion: options.supportedSchemaVersion,
          withSnapshot: async (work) => work(), ...(options.relay ? { relay: options.relay } : {}), ...(options.now ? { now: options.now } : {}),
        });
        rollbackDirectory = rollback.directory;
        const checkpoint = current.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
        if (checkpoint.some((row) => row.busy !== 0)) throw new OperationsError("RESTORE_DATABASE_BUSY");
      } finally { current.close(); }
      await copyFile(join(options.directory, manifest.database.file), staging, constants.COPYFILE_EXCL);
      await privateDatabaseFile(staging);
      if (await fileDigest(staging) !== manifest.database.sha256) throw new OperationsError("BACKUP_HASH_MISMATCH");
      const restored = new Database(staging, { fileMustExist: true });
      const timestamp = (options.now ?? (() => new Date()))().toISOString();
      const gate: RestoreReadinessGate = {
        v: 1, status: "external_state_unverified", restoredAt: timestamp, backupCreatedAt: manifest.createdAt,
        possibleDispatchIntents: 0, reasonCodes: ["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"],
        relayRegistrationInvalidated: Boolean(options.relay || manifest.relay),
      };
      try {
        restored.pragma("foreign_keys = ON");
        restored.transaction(() => {
          gate.possibleDispatchIntents = invalidateRestoredAccess(restored, timestamp);
          const preparation: unknown = options.prepareRestoredDatabase?.(restored, gate);
          if (preparation && typeof preparation === "object" && "then" in preparation && typeof preparation.then === "function") {
            void Promise.resolve(preparation).catch(() => {}); throw new OperationsError("RESTORE_ASYNC_PREPARATION");
          }
          restored.prepare("INSERT INTO host_state (key, value_json, updated_at) VALUES ('restore_readiness', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
            .run(JSON.stringify(gate), timestamp);
        })();
        validateDatabase(restored, options.supportedSchemaVersion);
        const checkpoint = restored.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
        if (checkpoint.some((row) => row.busy !== 0)) throw new OperationsError("RESTORE_DATABASE_BUSY");
      } finally { restored.close(); }
      await privateDatabaseFile(staging);
      options.owner.assertActive();
      options.assertDatabaseClosed();
      await loadOrCreateHostIdentity({ directory: options.identityDirectory, expectedMirror: manifest.identity });
      await options.beforeInstall?.();
      options.owner.assertActive(); options.assertDatabaseClosed();
      for (const suffix of ["-wal", "-shm"]) await unlink(target + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (options.relay) await unlink(options.relay.registrationPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      await rename(staging, target);
      await syncDirectory(dirname(target));
      return { rollbackDirectory, manifest, readiness: gate };
    } finally {
      for (const path of [staging, staging + "-wal", staging + "-shm"]) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
