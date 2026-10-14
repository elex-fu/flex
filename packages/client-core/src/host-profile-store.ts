import { ClientError } from "./common.js";
import type { ClientStore, DeviceCredential, HostProfile, PendingCommand } from "./types.js";

const MAX_REFRESH_AGE_MS = 24 * 60 * 60 * 1_000;
function validateCredential(credential: DeviceCredential): void {
  const remaining = Date.parse(credential.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > MAX_REFRESH_AGE_MS + 5_000) throw new ClientError("INVALID_CREDENTIAL_LIFETIME", "Refresh credential must expire within 24 hours");
  if (credential.storage !== "short-lived-refresh" || !credential.refreshCredential) throw new ClientError("INVALID_CREDENTIAL", "Invalid device credential");
}

export class MemoryClientStore implements ClientStore {
  private profiles = new Map<string, HostProfile>();
  private credentials = new Map<string, DeviceCredential>();
  private commands = new Map<string, PendingCommand>();
  private selectedHost: string | undefined;
  async listProfiles(): Promise<HostProfile[]> { return structuredClone([...this.profiles.values()]); }
  async getProfile(hostId: string): Promise<HostProfile | undefined> { return structuredClone(this.profiles.get(hostId)); }
  async putProfile(profile: HostProfile): Promise<void> { this.profiles.set(profile.hostId, structuredClone(profile)); }
  async getSelectedHost(): Promise<string | undefined> { return this.selectedHost; }
  async setSelectedHost(hostId: string): Promise<void> { this.selectedHost = hostId; }
  async getCredential(hostId: string): Promise<DeviceCredential | undefined> {
    const result = this.credentials.get(hostId);
    if (result && Date.parse(result.expiresAt) <= Date.now()) { this.credentials.delete(hostId); return undefined; }
    return structuredClone(result);
  }
  async putCredential(credential: DeviceCredential): Promise<void> { validateCredential(credential); this.credentials.set(credential.hostId, structuredClone(credential)); }
  async deleteCredential(hostId: string): Promise<void> { this.credentials.delete(hostId); }
  async listCommands(hostId: string): Promise<PendingCommand[]> { return structuredClone([...this.commands.values()].filter((value) => value.hostId === hostId)); }
  async getCommand(commandId: string): Promise<PendingCommand | undefined> { return structuredClone(this.commands.get(commandId)); }
  async putCommand(command: PendingCommand): Promise<void> { this.commands.set(command.commandId, structuredClone(command)); }
}

/** No fallback to memory: failing persistence must prevent an unrecorded write. */
export class IndexedDbClientStore implements ClientStore {
  private database: Promise<IDBDatabase>;
  constructor(name = "flyx-client-v1", factory: IDBFactory = indexedDB) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        for (const table of ["profiles", "credentials", "commands", "meta"]) request.result.createObjectStore(table);
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new ClientError("STORAGE_UNAVAILABLE", "Unable to open durable client storage"));
      request.onblocked = () => reject(new ClientError("STORAGE_BLOCKED", "Close other Flyx tabs to upgrade client storage"));
    });
  }
  private async operation<T>(table: string, mode: IDBTransactionMode, create: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(table, mode);
      const request = create(tx.objectStore(table));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(new ClientError("STORAGE_WRITE_FAILED", "Client storage transaction failed"));
      tx.onerror = () => reject(new ClientError("STORAGE_WRITE_FAILED", "Client storage transaction failed"));
    });
  }
  listProfiles(): Promise<HostProfile[]> { return this.operation("profiles", "readonly", (store) => store.getAll()); }
  getProfile(hostId: string): Promise<HostProfile | undefined> { return this.operation("profiles", "readonly", (store) => store.get(hostId)); }
  async putProfile(profile: HostProfile): Promise<void> { await this.operation("profiles", "readwrite", (store) => store.put(profile, profile.hostId)); }
  getSelectedHost(): Promise<string | undefined> { return this.operation("meta", "readonly", (store) => store.get("selectedHost")); }
  async setSelectedHost(hostId: string): Promise<void> { await this.operation("meta", "readwrite", (store) => store.put(hostId, "selectedHost")); }
  async getCredential(hostId: string): Promise<DeviceCredential | undefined> {
    const result = await this.operation<DeviceCredential | undefined>("credentials", "readonly", (store) => store.get(hostId));
    if (result && Date.parse(result.expiresAt) <= Date.now()) { await this.deleteCredential(hostId); return undefined; }
    return result;
  }
  async putCredential(credential: DeviceCredential): Promise<void> { validateCredential(credential); await this.operation("credentials", "readwrite", (store) => store.put(credential, credential.hostId)); }
  async deleteCredential(hostId: string): Promise<void> { await this.operation("credentials", "readwrite", (store) => store.delete(hostId)); }
  async listCommands(hostId: string): Promise<PendingCommand[]> { return (await this.operation<PendingCommand[]>("commands", "readonly", (store) => store.getAll())).filter((command) => command.hostId === hostId); }
  getCommand(commandId: string): Promise<PendingCommand | undefined> { return this.operation("commands", "readonly", (store) => store.get(commandId)); }
  async putCommand(command: PendingCommand): Promise<void> { await this.operation("commands", "readwrite", (store) => store.put(command, command.commandId)); }
  async close(): Promise<void> { (await this.database).close(); }
}
