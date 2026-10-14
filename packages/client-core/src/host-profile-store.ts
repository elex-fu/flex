import { ClientError } from "./common.js";
import type { ClientDraft, ClientStore, ContentMetadata, ContentMetadataKey, DeviceCredential, DraftKey, HostProfile, PendingCommand, ReplicaCacheKey, ReplicaCacheRecord } from "./types.js";

const MAX_REFRESH_AGE_MS = 24 * 60 * 60 * 1_000;
const TABLES = ["profiles", "credentials", "commands", "meta", "replicaCache", "drafts", "contentMetadata"] as const;
function validateCredential(credential: DeviceCredential): void {
  const remaining = Date.parse(credential.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_REFRESH_AGE_MS + 5_000) throw new ClientError("INVALID_CREDENTIAL_LIFETIME", "Refresh credential must expire within 24 hours");
  if (credential.storage !== "short-lived-refresh" || !credential.refreshCredential) throw new ClientError("INVALID_CREDENTIAL", "Invalid device credential");
}
export function draftStorageKey(key: DraftKey): string { return JSON.stringify([key.hostId, key.sessionId]); }
export function replicaStorageKey(key: ReplicaCacheKey): string { return JSON.stringify([key.hostId, key.fingerprint, key.sessionId, key.epoch, key.projectorVersion]); }
export function contentMetadataStorageKey(key: ContentMetadataKey): string { return JSON.stringify([key.hostId, key.fingerprint, key.sessionId, key.epoch, key.projectorVersion, key.contentId]); }
function assertCommandMatches(existing: PendingCommand | undefined, command: PendingCommand, key: DraftKey): void {
  if (command.hostId !== key.hostId) throw new ClientError("DRAFT_HOST_MISMATCH", "Draft and command belong to different Hosts");
  if (existing && (existing.hostId !== command.hostId || existing.method !== command.method || existing.payloadHash !== command.payloadHash)) throw new ClientError("COMMAND_ID_CONFLICT", "This command ID belongs to a different operation");
}
export type StoreWriteOperation = "profile" | "selectedHost" | "credential" | "command" | "draft" | "draftCommand" | "replicaCache" | "contentMetadata" | "forgetHost";
export interface MemoryClientStoreOptions { beforeWrite?: (operation: StoreWriteOperation) => void }

export class MemoryClientStore implements ClientStore {
  private profiles = new Map<string, HostProfile>();
  private credentials = new Map<string, DeviceCredential>();
  private commands = new Map<string, PendingCommand>();
  private drafts = new Map<string, ClientDraft>();
  private cache = new Map<string, ReplicaCacheRecord>();
  private content = new Map<string, ContentMetadata>();
  private selectedHost: string | undefined;
  private forgottenHosts = new Set<string>();
  private assertWritableHost(hostId: string): void { if (this.forgottenHosts.has(hostId)) throw new ClientError("HOST_FORGOTTEN", "Local Host data was removed"); }
  constructor(private options: MemoryClientStoreOptions = {}) {}
  private beforeWrite(operation: StoreWriteOperation): void { this.options.beforeWrite?.(operation); }
  async listProfiles(): Promise<HostProfile[]> { return structuredClone([...this.profiles.values()]); }
  async getProfile(hostId: string): Promise<HostProfile | undefined> { return structuredClone(this.profiles.get(hostId)); }
  async putProfile(profile: HostProfile): Promise<void> { const value = structuredClone(profile); this.beforeWrite("profile"); this.profiles.set(profile.hostId, value); this.forgottenHosts.delete(profile.hostId); }
  async getSelectedHost(): Promise<string | undefined> { return this.selectedHost; }
  async setSelectedHost(hostId: string): Promise<void> { this.assertWritableHost(hostId); this.beforeWrite("selectedHost"); this.selectedHost = hostId; }
  async getCredential(hostId: string): Promise<DeviceCredential | undefined> {
    const result = this.credentials.get(hostId);
    if (result && Date.parse(result.expiresAt) <= Date.now()) { this.credentials.delete(hostId); return undefined; }
    return structuredClone(result);
  }
  async putCredential(credential: DeviceCredential): Promise<void> { this.assertWritableHost(credential.hostId); validateCredential(credential); const value = structuredClone(credential); this.beforeWrite("credential"); this.credentials.set(credential.hostId, value); }
  async deleteCredential(hostId: string): Promise<void> { this.beforeWrite("credential"); this.credentials.delete(hostId); }
  async listCommands(hostId: string): Promise<PendingCommand[]> { return structuredClone([...this.commands.values()].filter((value) => value.hostId === hostId)); }
  async getCommand(commandId: string): Promise<PendingCommand | undefined> { return structuredClone(this.commands.get(commandId)); }
  async putCommand(command: PendingCommand): Promise<void> { this.assertWritableHost(command.hostId); const value = structuredClone(command); this.beforeWrite("command"); this.commands.set(command.commandId, value); }
  async getDraft(key: DraftKey): Promise<ClientDraft | undefined> { return structuredClone(this.drafts.get(draftStorageKey(key))); }
  async putDraft(draft: ClientDraft): Promise<void> { this.assertWritableHost(draft.hostId); const value = structuredClone(draft); this.beforeWrite("draft"); this.drafts.set(draftStorageKey(draft), value); }
  async deleteDraft(key: DraftKey): Promise<void> { this.beforeWrite("draft"); this.drafts.delete(draftStorageKey(key)); }
  async putCommandAndClearDraft(command: PendingCommand, key: DraftKey, expectedUpdatedAt?: number): Promise<void> {
    this.assertWritableHost(command.hostId);
    const existing = this.commands.get(command.commandId);
    assertCommandMatches(existing, command, key);
    const value = structuredClone(command);
    const draft = this.drafts.get(draftStorageKey(key));
    this.beforeWrite("draftCommand");
    if (!existing) this.commands.set(command.commandId, value);
    if (expectedUpdatedAt === undefined || draft?.updatedAt === expectedUpdatedAt) this.drafts.delete(draftStorageKey(key));
  }
  async getReplicaCache(key: ReplicaCacheKey): Promise<ReplicaCacheRecord | undefined> { return structuredClone(this.cache.get(replicaStorageKey(key))); }
  async listReplicaCaches(hostId: string): Promise<ReplicaCacheRecord[]> { return structuredClone([...this.cache.values()].filter((value) => value.hostId === hostId)); }
  async putReplicaCache(record: ReplicaCacheRecord): Promise<boolean> {
    this.assertWritableHost(record.hostId);
    const key = replicaStorageKey(record);
    if ((this.cache.get(key)?.revision ?? -1) > record.revision) return false;
    const value = structuredClone(record);
    this.beforeWrite("replicaCache");
    this.cache.set(key, value);
    return true;
  }
  async deleteReplicaCache(key: ReplicaCacheKey): Promise<void> { this.beforeWrite("replicaCache"); this.cache.delete(replicaStorageKey(key)); }
  async getContentMetadata(key: ContentMetadataKey): Promise<ContentMetadata | undefined> { return structuredClone(this.content.get(contentMetadataStorageKey(key))); }
  async listContentMetadata(hostId: string): Promise<ContentMetadata[]> { return structuredClone([...this.content.values()].filter((value) => value.hostId === hostId)); }
  async putContentMetadata(metadata: ContentMetadata): Promise<void> { this.assertWritableHost(metadata.hostId); const value = structuredClone(metadata); this.beforeWrite("contentMetadata"); this.content.set(contentMetadataStorageKey(metadata), value); }
  async deleteContentMetadata(key: ContentMetadataKey): Promise<void> { this.beforeWrite("contentMetadata"); this.content.delete(contentMetadataStorageKey(key)); }
  async forgetLocalHost(hostId: string): Promise<void> {
    this.beforeWrite("forgetHost");
    this.forgottenHosts.add(hostId);
    this.profiles.delete(hostId);
    this.credentials.delete(hostId);
    for (const [key, value] of this.commands) if (value.hostId === hostId) this.commands.delete(key);
    for (const [key, value] of this.drafts) if (value.hostId === hostId) this.drafts.delete(key);
    for (const [key, value] of this.cache) if (value.hostId === hostId) this.cache.delete(key);
    for (const [key, value] of this.content) if (value.hostId === hostId) this.content.delete(key);
    if (this.selectedHost === hostId) this.selectedHost = undefined;
  }
}

export interface IndexedDbClientStoreOptions { onBlocked?: (error: ClientError) => void }
/** No fallback to memory: failing persistence must prevent an unrecorded write. */
export class IndexedDbClientStore implements ClientStore {
  private database: Promise<IDBDatabase>;
  private hostGenerations = new Map<string, number>();
  private forgottenHosts = new Set<string>();
  private writeGeneration(hostId: string): number {
    if (this.forgottenHosts.has(hostId)) throw new ClientError("HOST_FORGOTTEN", "Local Host data was removed");
    return this.hostGenerations.get(hostId) ?? 0;
  }
  private assertWriteGeneration(hostId: string, generation: number): void {
    if ((this.hostGenerations.get(hostId) ?? 0) !== generation) throw new ClientError("HOST_FORGOTTEN", "Local Host data was removed");
  }
  constructor(name = "flyx-client-v1", factory: IDBFactory = indexedDB, options: IndexedDbClientStoreOptions = {}) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 2);
      let settled = false;
      request.onupgradeneeded = () => {
        try { for (const table of TABLES) if (!request.result.objectStoreNames.contains(table)) request.result.createObjectStore(table); }
        catch { request.transaction?.abort(); }
      };
      request.onsuccess = () => {
        // A blocked open can complete after the caller has already seen its error.
        if (settled) { request.result.close(); return; }
        settled = true;
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => { if (!settled) { settled = true; reject(new ClientError("STORAGE_UNAVAILABLE", "Unable to open durable client storage", request.error)); } };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        const error = new ClientError("STORAGE_BLOCKED", "Close other Flyx tabs to upgrade client storage");
        reject(error);
        options.onBlocked?.(error);
      };
    });
  }
  private async transaction<T>(tables: string | string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void, abort: (cause: unknown) => void) => void): Promise<T> {
    const db = await this.database;
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(tables, mode); }
      catch (cause) { reject(new ClientError(mode === "readwrite" ? "STORAGE_WRITE_FAILED" : "STORAGE_READ_FAILED", "Client storage is unavailable", cause)); return; }
      let value: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure instanceof ClientError ? failure : new ClientError(mode === "readwrite" ? "STORAGE_WRITE_FAILED" : "STORAGE_READ_FAILED", "Client storage transaction failed", failure ?? tx.error));
      const abort = (cause: unknown) => { failure = cause; tx.abort(); };
      try { run(tx, (next) => { value = next; }, abort); }
      catch (cause) { abort(cause); }
    });
  }
  private operation<T>(table: string, mode: IDBTransactionMode, create: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.transaction(table, mode, (tx, result) => { const request = create(tx.objectStore(table)); request.onsuccess = () => result(request.result); });
  }
  listProfiles(): Promise<HostProfile[]> { return this.operation("profiles", "readonly", (store) => store.getAll()); }
  getProfile(hostId: string): Promise<HostProfile | undefined> { return this.operation("profiles", "readonly", (store) => store.get(hostId)); }
  async putProfile(profile: HostProfile): Promise<void> {
    const generation = this.hostGenerations.get(profile.hostId) ?? 0;
    await this.operation("profiles", "readwrite", (store) => { this.assertWriteGeneration(profile.hostId, generation); return store.put(profile, profile.hostId); });
    this.assertWriteGeneration(profile.hostId, generation);
    this.forgottenHosts.delete(profile.hostId);
  }
  getSelectedHost(): Promise<string | undefined> { return this.operation("meta", "readonly", (store) => store.get("selectedHost")); }
  async setSelectedHost(hostId: string): Promise<void> { const generation = this.writeGeneration(hostId); await this.operation("meta", "readwrite", (store) => { this.assertWriteGeneration(hostId, generation); return store.put(hostId, "selectedHost"); }); }
  async getCredential(hostId: string): Promise<DeviceCredential | undefined> {
    const result = await this.operation<DeviceCredential | undefined>("credentials", "readonly", (store) => store.get(hostId));
    if (result && Date.parse(result.expiresAt) <= Date.now()) { await this.deleteCredential(hostId); return undefined; }
    return result;
  }
  async putCredential(credential: DeviceCredential): Promise<void> { const generation = this.writeGeneration(credential.hostId); validateCredential(credential); await this.operation("credentials", "readwrite", (store) => { this.assertWriteGeneration(credential.hostId, generation); return store.put(credential, credential.hostId); }); }
  async deleteCredential(hostId: string): Promise<void> { await this.operation("credentials", "readwrite", (store) => store.delete(hostId)); }
  async listCommands(hostId: string): Promise<PendingCommand[]> { return (await this.operation<PendingCommand[]>("commands", "readonly", (store) => store.getAll())).filter((command) => command.hostId === hostId); }
  getCommand(commandId: string): Promise<PendingCommand | undefined> { return this.operation("commands", "readonly", (store) => store.get(commandId)); }
  async putCommand(command: PendingCommand): Promise<void> { const generation = this.writeGeneration(command.hostId); await this.operation("commands", "readwrite", (store) => { this.assertWriteGeneration(command.hostId, generation); return store.put(command, command.commandId); }); }
  getDraft(key: DraftKey): Promise<ClientDraft | undefined> { return this.operation("drafts", "readonly", (store) => store.get(draftStorageKey(key))); }
  async putDraft(draft: ClientDraft): Promise<void> { const generation = this.writeGeneration(draft.hostId); await this.operation("drafts", "readwrite", (store) => { this.assertWriteGeneration(draft.hostId, generation); return store.put(draft, draftStorageKey(draft)); }); }
  async deleteDraft(key: DraftKey): Promise<void> { await this.operation("drafts", "readwrite", (store) => store.delete(draftStorageKey(key))); }
  async putCommandAndClearDraft(command: PendingCommand, key: DraftKey, expectedUpdatedAt?: number): Promise<void> {
    const generation = this.writeGeneration(command.hostId);
    await this.transaction<void>(["commands", "drafts"], "readwrite", (tx, result, abort) => {
      this.assertWriteGeneration(command.hostId, generation);
      const commands = tx.objectStore("commands");
      const drafts = tx.objectStore("drafts");
      // Asynchronous requests run inside this transaction; no promise gap can close it.
      const read = commands.get(command.commandId);
      read.onsuccess = () => {
        try {
          this.assertWriteGeneration(command.hostId, generation);
          assertCommandMatches(read.result as PendingCommand | undefined, command, key);
          if (!read.result) commands.put(command, command.commandId);
          const draft = drafts.get(draftStorageKey(key));
          draft.onsuccess = () => { if (expectedUpdatedAt === undefined || (draft.result as ClientDraft | undefined)?.updatedAt === expectedUpdatedAt) drafts.delete(draftStorageKey(key)); };
          result(undefined);
        } catch (cause) { abort(cause); }
      };
    });
  }
  getReplicaCache(key: ReplicaCacheKey): Promise<ReplicaCacheRecord | undefined> { return this.operation("replicaCache", "readonly", (store) => store.get(replicaStorageKey(key))); }
  async listReplicaCaches(hostId: string): Promise<ReplicaCacheRecord[]> { return (await this.operation<ReplicaCacheRecord[]>("replicaCache", "readonly", (store) => store.getAll())).filter((value) => value.hostId === hostId); }
  async putReplicaCache(record: ReplicaCacheRecord): Promise<boolean> {
    const generation = this.writeGeneration(record.hostId);
    return this.transaction("replicaCache", "readwrite", (tx, result, abort) => {
      const store = tx.objectStore("replicaCache");
      const key = replicaStorageKey(record);
      const read = store.get(key);
      read.onsuccess = () => {
        try { this.assertWriteGeneration(record.hostId, generation); } catch (cause) { abort(cause); return; }
        if ((read.result as ReplicaCacheRecord | undefined)?.revision !== undefined && (read.result as ReplicaCacheRecord).revision > record.revision) { result(false); return; }
        try { store.put(record, key); result(true); } catch (cause) { abort(cause); }
      };
    });
  }
  async deleteReplicaCache(key: ReplicaCacheKey): Promise<void> { await this.operation("replicaCache", "readwrite", (store) => store.delete(replicaStorageKey(key))); }
  getContentMetadata(key: ContentMetadataKey): Promise<ContentMetadata | undefined> { return this.operation("contentMetadata", "readonly", (store) => store.get(contentMetadataStorageKey(key))); }
  async listContentMetadata(hostId: string): Promise<ContentMetadata[]> { return (await this.operation<ContentMetadata[]>("contentMetadata", "readonly", (store) => store.getAll())).filter((value) => value.hostId === hostId); }
  async putContentMetadata(metadata: ContentMetadata): Promise<void> { const generation = this.writeGeneration(metadata.hostId); await this.operation("contentMetadata", "readwrite", (store) => { this.assertWriteGeneration(metadata.hostId, generation); return store.put(metadata, contentMetadataStorageKey(metadata)); }); }
  async deleteContentMetadata(key: ContentMetadataKey): Promise<void> { await this.operation("contentMetadata", "readwrite", (store) => store.delete(contentMetadataStorageKey(key))); }
  async forgetLocalHost(hostId: string): Promise<void> {
    this.hostGenerations.set(hostId, (this.hostGenerations.get(hostId) ?? 0) + 1);
    this.forgottenHosts.add(hostId);
    await this.transaction<void>([...TABLES], "readwrite", (tx, result) => {
      tx.objectStore("profiles").delete(hostId);
      tx.objectStore("credentials").delete(hostId);
      for (const name of ["commands", "drafts", "replicaCache", "contentMetadata"]) {
        const cursor = tx.objectStore(name).openCursor();
        cursor.onsuccess = () => {
          const value = cursor.result;
          if (!value) return;
          if ((value.value as { hostId: string }).hostId === hostId) value.delete();
          value.continue();
        };
      }
      const meta = tx.objectStore("meta");
      const selected = meta.get("selectedHost");
      selected.onsuccess = () => { if (selected.result === hostId) meta.delete("selectedHost"); };
      result(undefined);
    });
  }
  async close(): Promise<void> { (await this.database).close(); }
}
