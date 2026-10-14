import Database from "better-sqlite3";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HOST_IDENTITY_FILENAME, loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { readRelayRegistration } from "../relay/relay-registration.js";
import { bindOwner, createBackupDirectory, digest, fileDigest, identityMirror, OperationsError, privateDatabaseFile, readPrivateFile, syncDirectory, validateDatabase, writePrivateFile, type OperationOwner, type SnapshotCoordinator } from "./operation-files.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const BackupManifestSchema = z.object({
  v: z.literal(1),
  createdAt: z.string().datetime(),
  applicationVersion: z.string().min(1).max(128),
  schema: z.object({ migrationVersion: z.number().int().positive(), userVersion: z.number().int().nonnegative() }).strict(),
  database: z.object({ file: z.literal("database.sqlite"), sha256: HashSchema }).strict(),
  identity: z.object({ file: z.literal("host-identity.json"), sha256: HashSchema, hostId: z.string().uuid(), fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  relay: z.object({ file: z.literal("relay-registration.json"), sha256: HashSchema, generation: z.number().int().nonnegative() }).strict().nullable(),
  checkedContentRefs: z.number().int().nonnegative(),
  includesExternalGitOrProviderHistory: z.literal(false),
}).strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface BackupOptions {
  db: Database.Database;
  owner: OperationOwner;
  identityDirectory: string;
  directory: string;
  applicationVersion: string;
  supportedSchemaVersion: number;
  /** Mandatory shared lane with identity and Relay mutations. */
  withSnapshot: SnapshotCoordinator;
  relay?: { registrationPath: string; relayUrl: string };
  now?: () => Date;
}

async function associatedFiles(options: BackupOptions) {
  const mirror = identityMirror(options.db);
  const identity = await loadOrCreateHostIdentity({ directory: options.identityDirectory, expectedMirror: mirror });
  const identityBytes = await readPrivateFile(join(options.identityDirectory, HOST_IDENTITY_FILENAME), 16_384);
  const relay = options.relay ? await readRelayRegistration(options.relay.registrationPath, options.relay.relayUrl) : undefined;
  const relayBytes = relay && options.relay ? await readPrivateFile(options.relay.registrationPath, 16_384) : undefined;
  // The identity loader validates the keypairs; this re-read detects a swap between reads.
  const reread = JSON.parse(identityBytes.toString("utf8")) as { hostId?: string; fingerprint?: string };
  if (reread.hostId !== identity.hostId || reread.fingerprint !== identity.fingerprint) throw new OperationsError("BACKUP_SNAPSHOT_CHANGED");
  return { identity, identityBytes, relay, relayBytes };
}

/** SQLite's backup API includes committed WAL data; copying the main file alone does not. */
export class BackupService {
  async create(options: BackupOptions): Promise<{ directory: string; manifest: BackupManifest }> {
    await bindOwner(options.owner, options.db.name);
    if (typeof options.withSnapshot !== "function") throw new OperationsError("BACKUP_COORDINATOR_REQUIRED");
    return options.withSnapshot(async () => {
      options.owner.assertActive();
      validateDatabase(options.db, options.supportedSchemaVersion);
      const before = await associatedFiles(options);
      const destination = await createBackupDirectory(options.directory);
      let complete = false;
      try {
        const databasePath = join(destination, "database.sqlite");
        await options.db.backup(databasePath);
        await privateDatabaseFile(databasePath);
        const snapshot = new Database(databasePath, { readonly: true, fileMustExist: true });
        let validation: ReturnType<typeof validateDatabase>;
        try {
          validation = validateDatabase(snapshot, options.supportedSchemaVersion);
          const mirror = identityMirror(snapshot);
          if (mirror.hostId !== before.identity.hostId || mirror.fingerprint !== before.identity.fingerprint) throw new OperationsError("BACKUP_SNAPSHOT_CHANGED");
        } finally { snapshot.close(); }
        const after = await associatedFiles(options);
        if (digest(before.identityBytes) !== digest(after.identityBytes)
          || digest(before.relayBytes ?? "") !== digest(after.relayBytes ?? "")
          || before.relay?.generation !== after.relay?.generation) throw new OperationsError("BACKUP_SNAPSHOT_CHANGED");
        options.owner.assertActive();
        await writePrivateFile(join(destination, "host-identity.json"), before.identityBytes);
        if (before.relayBytes) await writePrivateFile(join(destination, "relay-registration.json"), before.relayBytes);
        const manifest = BackupManifestSchema.parse({
          v: 1, createdAt: (options.now ?? (() => new Date()))().toISOString(),
          applicationVersion: options.applicationVersion, schema: validation.schema,
          database: { file: "database.sqlite", sha256: await fileDigest(databasePath) },
          identity: { file: "host-identity.json", sha256: digest(before.identityBytes), hostId: before.identity.hostId, fingerprint: before.identity.fingerprint },
          relay: before.relay && before.relayBytes ? { file: "relay-registration.json", sha256: digest(before.relayBytes), generation: before.relay.generation } : null,
          checkedContentRefs: validation.checkedContentRefs, includesExternalGitOrProviderHistory: false,
        });
        await writePrivateFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
        await syncDirectory(destination);
        complete = true;
        return { directory: destination, manifest };
      } finally {
        if (!complete) await rm(destination, { recursive: true, force: true });
      }
    });
  }
}
