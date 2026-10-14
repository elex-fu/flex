import { ClientError, contentMetadataStorageKey, draftStorageKey, replicaStorageKey } from "@flyx/client-core";
import type { ClientDraft, ClientStore, ContentMetadata, ContentMetadataKey, DeviceCredential, DraftKey, HostProfile, PendingCommand, ReplicaCacheKey, ReplicaCacheRecord } from "@flyx/client-core";
import { Buffer } from "buffer";
export type SqlValue = string | number | null;
export interface SqlExecutor {
  runAsync(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
export interface NativeDatabase extends SqlExecutor { execAsync(sql: string): Promise<void>; withExclusiveTransactionAsync(task: (tx: SqlExecutor) => Promise<void>): Promise<void>; closeAsync(): Promise<void> }
export interface SecureCredentialBridge { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; deleteItemAsync(key: string): Promise<void> }
interface Guard { host_id: string; generation: number; forgotten: number; secure_cleanup: number }
interface Row { value: string }
const SCHEMA = `CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, key TEXT NOT NULL, host_id TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,key));
CREATE INDEX IF NOT EXISTS records_host ON records(host_id,kind);
CREATE TABLE IF NOT EXISTS host_guard(host_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, forgotten INTEGER NOT NULL, secure_cleanup INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`;
export function credentialKey(hostId: string): string { return "flyx.credential." + Buffer.from(hostId, "utf8").toString("base64url"); }
/** Ordinary SQLite holds readable body/cache/draft/commands. Only refresh tokens use
 * SecureStore. SQL deletion and SecureStore deletion are explicitly TWO commits. */
export class NativeClientStore implements ClientStore {
  private guards = new Map<string, Guard>();
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private db: NativeDatabase, private secure: SecureCredentialBridge) {}
  static async open(db: NativeDatabase, secure: SecureCredentialBridge): Promise<NativeClientStore> {
    const store = new NativeClientStore(db, secure);
    const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
    if ((version?.user_version ?? 0) > 1) throw new ClientError("STORAGE_VERSION_UNSUPPORTED", "Native storage requires a newer app");
    await db.execAsync("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    await db.withExclusiveTransactionAsync(async (tx) => { for (const statement of SCHEMA.split(";").filter(Boolean)) await tx.runAsync(statement); await tx.runAsync("PRAGMA user_version=1"); });
    for (const guard of await db.getAllAsync<Guard>("SELECT * FROM host_guard")) store.guards.set(guard.host_id, guard);
    // A crash after SQL deletion cannot make the surviving credential usable.
    await store.finishPendingSecureCleanup().catch(() => undefined);
    return store;
  }
  get pendingSecureCleanup(): string[] { return [...this.guards.values()].filter((guard) => guard.secure_cleanup === 1).map((guard) => guard.host_id); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next; return next;
  }
  private generation(hostId: string): number { return this.guards.get(hostId)?.generation ?? 0; }
  private assertHost(hostId: string, generation: number, revive = false): void {
    const guard = this.guards.get(hostId);
    if (generation !== this.generation(hostId) || guard?.forgotten && !revive) throw new ClientError("HOST_FORGOTTEN", "Local Host data was removed");
    if (revive && guard?.secure_cleanup) throw new ClientError("LOCAL_CLEANUP_PENDING", "Finish secure credential cleanup before pairing this Host again");
  }
  private write<T>(hostId: string, task: (tx: SqlExecutor) => Promise<T>, revive = false): Promise<T> {
    const generation = this.generation(hostId);
    return this.enqueue(async () => {
      this.assertHost(hostId, generation, revive);
      let result!: T;
      try { await this.db.withExclusiveTransactionAsync(async (tx) => { this.assertHost(hostId, generation, revive); result = await task(tx); this.assertHost(hostId, generation, revive); }); }
      catch (error) { if (error instanceof ClientError) throw error; throw new ClientError("STORAGE_WRITE_FAILED", "Native body storage transaction failed"); }
      return result;
    });
  }
  private async read<T>(kind: string, key: string, tx: SqlExecutor = this.db): Promise<T | undefined> { const row = await tx.getFirstAsync<Row>("SELECT value FROM records WHERE kind=? AND key=?", kind, key); return row ? JSON.parse(row.value) as T : undefined; }
  private async list<T>(kind: string, hostId?: string): Promise<T[]> { const rows = hostId === undefined ? await this.db.getAllAsync<Row>("SELECT value FROM records WHERE kind=?", kind) : await this.db.getAllAsync<Row>("SELECT value FROM records WHERE kind=? AND host_id=?", kind, hostId); return rows.map((row) => JSON.parse(row.value) as T); }
  private put(tx: SqlExecutor, kind: string, key: string, hostId: string, value: unknown, revision = 0): Promise<{ changes: number }> {
    return tx.runAsync("INSERT INTO records(kind,key,host_id,value,revision) VALUES(?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET host_id=excluded.host_id,value=excluded.value,revision=excluded.revision", kind, key, hostId, JSON.stringify(value), revision);
  }
  listProfiles(): Promise<HostProfile[]> { return this.enqueue(() => this.list("profile")); }
  getProfile(hostId: string): Promise<HostProfile | undefined> { return this.enqueue(() => this.read("profile", hostId)); }
  async putProfile(profile: HostProfile): Promise<void> {
    const generation = this.generation(profile.hostId);
    await this.write(profile.hostId, async (tx) => { await this.put(tx, "profile", profile.hostId, profile.hostId, profile); await tx.runAsync("INSERT INTO host_guard VALUES(?,?,0,0) ON CONFLICT(host_id) DO UPDATE SET forgotten=0", profile.hostId, generation); }, true);
    if (this.generation(profile.hostId) === generation) this.guards.set(profile.hostId, { host_id: profile.hostId, generation, forgotten: 0, secure_cleanup: 0 });
  }
  getSelectedHost(): Promise<string | undefined> { return this.enqueue(async () => (await this.db.getFirstAsync<Row>("SELECT value FROM metadata WHERE key='selectedHost'"))?.value); }
  async setSelectedHost(hostId: string): Promise<void> { await this.write(hostId, async (tx) => { await tx.runAsync("INSERT INTO metadata VALUES('selectedHost',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", hostId); }); }
  getCredential(hostId: string): Promise<DeviceCredential | undefined> {
    const generation = this.generation(hostId);
    return this.enqueue(async () => {
      if (this.guards.get(hostId)?.forgotten || generation !== this.generation(hostId)) return undefined;
      const value = await this.secure.getItemAsync(credentialKey(hostId));
      if (generation !== this.generation(hostId) || this.guards.get(hostId)?.forgotten || !value) return undefined;
      const credential = JSON.parse(value) as DeviceCredential;
      if (credential.hostId !== hostId || credential.storage !== "short-lived-refresh" || !credential.refreshCredential) throw new ClientError("INVALID_CREDENTIAL", "Native credential is invalid");
      if (!Number.isFinite(Date.parse(credential.expiresAt))) throw new ClientError("INVALID_CREDENTIAL", "Native credential expiry is invalid");
      if (Date.parse(credential.expiresAt) <= Date.now()) { await this.secure.deleteItemAsync(credentialKey(hostId)); return undefined; }
      return credential;
    });
  }
  putCredential(credential: DeviceCredential): Promise<void> {
    const generation = this.generation(credential.hostId);
    return this.enqueue(async () => {
      this.assertHost(credential.hostId, generation);
      const lifetime = Date.parse(credential.expiresAt) - Date.now();
      if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86_405_000 || credential.storage !== "short-lived-refresh" || !credential.refreshCredential) throw new ClientError("INVALID_CREDENTIAL_LIFETIME", "Native refresh token must expire within 24 hours");
      try { await this.secure.setItemAsync(credentialKey(credential.hostId), JSON.stringify(credential)); }
      catch { throw new ClientError("STORAGE_WRITE_FAILED", "Unable to save the native credential securely"); }
      this.assertHost(credential.hostId, generation);
    });
  }
  deleteCredential(hostId: string): Promise<void> { return this.enqueue(() => this.secure.deleteItemAsync(credentialKey(hostId))); }
  listCommands(hostId: string): Promise<PendingCommand[]> { return this.enqueue(() => this.list("command", hostId)); }
  getCommand(commandId: string): Promise<PendingCommand | undefined> { return this.enqueue(() => this.read("command", commandId)); }
  async putCommand(command: PendingCommand): Promise<void> { await this.write(command.hostId, async (tx) => { await this.put(tx, "command", command.commandId, command.hostId, command); }); }
  getDraft(key: DraftKey): Promise<ClientDraft | undefined> { return this.enqueue(() => this.read("draft", draftStorageKey(key))); }
  async putDraft(draft: ClientDraft): Promise<void> { await this.write(draft.hostId, async (tx) => { await this.put(tx, "draft", draftStorageKey(draft), draft.hostId, draft); }); }
  async deleteDraft(key: DraftKey): Promise<void> { await this.enqueue(async () => { await this.db.runAsync("DELETE FROM records WHERE kind='draft' AND key=?", draftStorageKey(key)); }); }
  async putCommandAndClearDraft(command: PendingCommand, key: DraftKey, expectedUpdatedAt?: number): Promise<void> {
    await this.write(command.hostId, async (tx) => {
      if (command.hostId !== key.hostId) throw new ClientError("DRAFT_HOST_MISMATCH", "Draft belongs to another Host");
      const existing = await this.read<PendingCommand>("command", command.commandId, tx);
      if (existing && (existing.hostId !== command.hostId || existing.method !== command.method || existing.payloadHash !== command.payloadHash)) throw new ClientError("COMMAND_ID_CONFLICT", "Command ID belongs to another operation");
      if (!existing) await this.put(tx, "command", command.commandId, command.hostId, command);
      const draft = await this.read<ClientDraft>("draft", draftStorageKey(key), tx);
      if (expectedUpdatedAt === undefined || draft?.updatedAt === expectedUpdatedAt) await tx.runAsync("DELETE FROM records WHERE kind='draft' AND key=?", draftStorageKey(key));
    });
  }
  getReplicaCache(key: ReplicaCacheKey): Promise<ReplicaCacheRecord | undefined> { return this.enqueue(() => this.read("cache", replicaStorageKey(key))); }
  listReplicaCaches(hostId: string): Promise<ReplicaCacheRecord[]> { return this.enqueue(() => this.list("cache", hostId)); }
  putReplicaCache(record: ReplicaCacheRecord): Promise<boolean> { return this.write(record.hostId, async (tx) => (await tx.runAsync("INSERT INTO records(kind,key,host_id,value,revision) VALUES('cache',?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value,revision=excluded.revision WHERE records.revision<=excluded.revision", replicaStorageKey(record), record.hostId, JSON.stringify(record), record.revision)).changes > 0); }
  async deleteReplicaCache(key: ReplicaCacheKey): Promise<void> { await this.enqueue(async () => { await this.db.runAsync("DELETE FROM records WHERE kind='cache' AND key=?", replicaStorageKey(key)); }); }
  getContentMetadata(key: ContentMetadataKey): Promise<ContentMetadata | undefined> { return this.enqueue(() => this.read("content", contentMetadataStorageKey(key))); }
  listContentMetadata(hostId: string): Promise<ContentMetadata[]> { return this.enqueue(() => this.list("content", hostId)); }
  async putContentMetadata(metadata: ContentMetadata): Promise<void> { await this.write(metadata.hostId, async (tx) => { await this.put(tx, "content", contentMetadataStorageKey(metadata), metadata.hostId, metadata); }); }
  async deleteContentMetadata(key: ContentMetadataKey): Promise<void> { await this.enqueue(async () => { await this.db.runAsync("DELETE FROM records WHERE kind='content' AND key=?", contentMetadataStorageKey(key)); }); }
  async forgetLocalHost(hostId: string): Promise<void> {
    const generation = this.generation(hostId) + 1;
    const previous = this.guards.get(hostId);
    this.guards.set(hostId, { host_id: hostId, generation, forgotten: 1, secure_cleanup: 1 });
    await this.enqueue(async () => {
      try { await this.db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync("DELETE FROM records WHERE host_id=?", hostId);
        await tx.runAsync("DELETE FROM metadata WHERE key='selectedHost' AND value=?", hostId);
        await tx.runAsync("INSERT INTO host_guard VALUES(?,?,1,1) ON CONFLICT(host_id) DO UPDATE SET generation=excluded.generation,forgotten=1,secure_cleanup=1", hostId, generation);
      }); } catch { if (previous) this.guards.set(hostId, previous); else this.guards.delete(hostId); throw new ClientError("STORAGE_WRITE_FAILED", "Local Host deletion was rolled back"); }
      try { await this.secure.deleteItemAsync(credentialKey(hostId)); await this.db.runAsync("UPDATE host_guard SET secure_cleanup=0 WHERE host_id=? AND generation=?", hostId, generation); this.guards.get(hostId)!.secure_cleanup = 0; }
      catch { throw new ClientError("LOCAL_CLEANUP_PENDING", "Body data was removed; secure credential cleanup will be retried on restart"); }
    });
  }
  finishPendingSecureCleanup(): Promise<void> {
    return this.enqueue(async () => {
      let failed = false;
      for (const guard of [...this.guards.values()].filter((value) => value.secure_cleanup)) {
        try { await this.secure.deleteItemAsync(credentialKey(guard.host_id)); await this.db.runAsync("UPDATE host_guard SET secure_cleanup=0 WHERE host_id=? AND generation=?", guard.host_id, guard.generation); guard.secure_cleanup = 0; }
        catch { failed = true; }
      }
      if (failed) throw new ClientError("LOCAL_CLEANUP_PENDING", "Some secure credentials still require cleanup");
    });
  }
  async close(): Promise<void> { await this.queue.catch(() => undefined); await this.db.closeAsync(); }
}
