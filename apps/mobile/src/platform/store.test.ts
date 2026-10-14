import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ClientError, CommandOutbox, ReplicaCache } from "@flyx/client-core";
import type { DeviceCredential, HostProfile, PendingCommand } from "@flyx/client-core";
import { NativeClientStore, credentialKey } from "./store";
import type { NativeDatabase, SecureCredentialBridge, SqlValue } from "./store";
class SqlBridge implements NativeDatabase {
  db = new DatabaseSync(":memory:"); fail: ((sql: string) => boolean) | undefined;
  async execAsync(sql: string) { this.db.exec(sql); }
  async runAsync(sql: string, ...params: SqlValue[]) { if (this.fail?.(sql)) throw new Error("disk full"); return { changes: Number(this.db.prepare(sql).run(...params).changes) }; }
  async getFirstAsync<T>(sql: string, ...params: SqlValue[]) { return this.db.prepare(sql).get(...params) as T | undefined ?? null; }
  async getAllAsync<T>(sql: string, ...params: SqlValue[]) { return this.db.prepare(sql).all(...params) as T[]; }
  async withExclusiveTransactionAsync(task: (tx: NativeDatabase) => Promise<void>) { this.db.exec("BEGIN IMMEDIATE"); try { await task(this); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  async closeAsync() { this.db.close(); }
}
class SecureBridge implements SecureCredentialBridge {
  values = new Map<string, string>(); failDelete = false; failWrite = false; reads = 0;
  async getItemAsync(key: string) { this.reads++; return this.values.get(key) ?? null; }
  async setItemAsync(key: string, value: string) { if (this.failWrite) throw new Error("keychain locked"); this.values.set(key, value); }
  async deleteItemAsync(key: string) { if (this.failDelete) throw new Error("keychain locked"); this.values.delete(key); }
}
const profile: HostProfile = { hostId: "host-a", label: "A", hostPublicKey: "host", signingPublicKey: "sign", fingerprint: "pin", endpoints: [] };
const command: PendingCommand = { commandId: "command-a", hostId: "host-a", method: "session.startTurn", payloadHash: "hash", payload: { prompt: "private draft", clientMessageId: "message-a" }, createdAt: "now", state: "queued", dispatchState: "not_dispatched" };
const key = { hostId: "host-a", sessionId: "session-a" };
const cacheKey = { ...key, fingerprint: "pin", epoch: "epoch-a", projectorVersion: 1 };
async function fixture() {
  const sql = new SqlBridge(), secure = new SecureBridge(), store = await NativeClientStore.open(sql, secure);
  await store.putProfile(profile); await store.setSelectedHost("host-a");
  const credential: DeviceCredential = { hostId: "host-a", deviceId: "device-a", refreshCredential: "native-secret", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [], storage: "short-lived-refresh" };
  await store.putCredential(credential); await store.putDraft({ ...key, text: "private draft", updatedAt: 1 });
  return { sql, secure, store, credential };
}
describe("native two-store persistence", () => {
  it("keeps credentials out of body SQLite and commits draft+command atomically", async () => {
    const { store, sql } = await fixture();
    await store.putCommandAndClearDraft(command, key, 1);
    expect(await store.getDraft(key)).toBeUndefined(); expect((await store.getCommand("command-a"))?.payload).toEqual(command.payload);
    expect(sql.db.prepare("SELECT value FROM records").all().some((row) => String(row.value).includes("native-secret"))).toBe(false);
    await store.close();
  });
  it("rolls back command persistence and retains input on a mid-transaction failure", async () => {
    const { store, sql } = await fixture(); sql.fail = (query) => query.startsWith("DELETE FROM records WHERE kind='draft'");
    await expect(store.putCommandAndClearDraft(command, key)).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    sql.fail = undefined;
    expect(await store.getCommand("command-a")).toBeUndefined(); expect((await store.getDraft(key))?.text).toBe("private draft"); await store.close();
  });
  it("records a forget tombstone before secure deletion and recovers its crash window on restart", async () => {
    const { store, sql, secure } = await fixture(); await store.putCommand(command);
    await store.putReplicaCache({ ...cacheKey, revision: 1, value: { text: "cached" }, cachedAt: 0, expiresAt: 999999, byteLength: 10 });
    secure.failDelete = true;
    await expect(store.forgetLocalHost("host-a")).rejects.toMatchObject({ code: "LOCAL_CLEANUP_PENDING" });
    expect(await store.getProfile("host-a")).toBeUndefined(); expect(await store.getSelectedHost()).toBeUndefined(); expect(await store.listCommands("host-a")).toEqual([]); expect(await store.getDraft(key)).toBeUndefined(); expect(await store.listReplicaCaches("host-a")).toEqual([]);
    expect(secure.values.has(credentialKey("host-a"))).toBe(true); expect(await store.getCredential("host-a")).toBeUndefined();
    const reads = secure.reads; const restarted = await NativeClientStore.open(sql, secure);
    expect(await restarted.getCredential("host-a")).toBeUndefined(); expect(secure.reads).toBe(reads); expect(restarted.pendingSecureCleanup).toEqual(["host-a"]);
    await expect(restarted.putProfile(profile)).rejects.toMatchObject({ code: "LOCAL_CLEANUP_PENDING" });
    secure.failDelete = false; await restarted.finishPendingSecureCleanup(); expect(secure.values.has(credentialKey("host-a"))).toBe(false); expect(restarted.pendingSecureCleanup).toEqual([]);
    await expect(restarted.putCommand(command)).rejects.toMatchObject({ code: "HOST_FORGOTTEN" }); await restarted.close();
  });
  it("makes cache failure soft but prevents a business send if its SQL command write fails", async () => {
    const { store, sql } = await fixture(); sql.fail = (query) => query.startsWith("INSERT INTO records");
    const errors: ClientError[] = []; const cache = new ReplicaCache(store, { onError: (error) => errors.push(error) });
    expect(await cache.save(cache.select(cacheKey), 1, { text: "cache" })).toBe(false); expect(errors[0]?.code).toBe("CACHE_UNAVAILABLE");
    let sends = 0; const outbox = new CommandOutbox(store, "host-a", async () => { sends++; return {}; });
    await expect(outbox.execute("session.startTurn", { prompt: "private draft" })).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" }); expect(sends).toBe(0); await store.close();
  });
  it("fences writes queued before local forget and keeps a later edit on draft handoff", async () => {
    const { store } = await fixture();
    await store.putDraft({ ...key, text: "new edit", updatedAt: 2 }); await store.putCommandAndClearDraft(command, key, 1); expect((await store.getDraft(key))?.text).toBe("new edit");
    const late = store.putDraft({ ...key, text: "late", updatedAt: 3 }); const rejected = late.catch((error: unknown) => error);
    await store.forgetLocalHost("host-a"); expect(await rejected).toMatchObject({ code: "HOST_FORGOTTEN" }); expect(await store.getDraft(key)).toBeUndefined(); await store.close();
  });
});
