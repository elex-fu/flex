import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "./common.js";
import { IndexedDbClientStore, MemoryClientStore } from "./host-profile-store.js";
import type { ClientStore, HostProfile, PendingCommand, ReplicaCacheKey, ReplicaCacheRecord } from "./types.js";

const profile = (hostId = "host-a"): HostProfile => ({ hostId, label: hostId, hostPublicKey: "host-key", signingPublicKey: "signing-key", fingerprint: "sha256:pinned", endpoints: [] });
const key = (hostId = "host-a"): ReplicaCacheKey => ({ hostId, fingerprint: "sha256:pinned", sessionId: "session-a", epoch: "epoch-a", projectorVersion: 1 });
const command = (hostId = "host-a", commandId = "command-a"): PendingCommand => ({ hostId, commandId, method: "session.startTurn", payload: { prompt: "draft", clientMessageId: "message-a" }, payloadHash: "hash", state: "queued", dispatchState: "not_dispatched", createdAt: "2026-10-14T00:00:00.000Z" });
const record = (hostId = "host-a", revision = 1): ReplicaCacheRecord => ({ ...key(hostId), revision, value: { items: ["cached text"] }, cachedAt: 10, expiresAt: 1_000_000, byteLength: 30 });
async function seed(store: ClientStore, hostId = "host-a"): Promise<void> {
  await store.putProfile(profile(hostId));
  await store.putCredential({ hostId, deviceId: "device-a", refreshCredential: "bounded", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [], storage: "short-lived-refresh" });
  await store.putCommand(command(hostId, "command-" + hostId));
  await store.putDraft({ hostId, sessionId: "session-a", text: "draft", updatedAt: 1 });
  await store.putReplicaCache(record(hostId));
  await store.putContentMetadata({ ...key(hostId), contentId: "content-a", hash: "hash", cachedAt: 10, expiresAt: 1_000_000, byteLength: 30 });
}
const stores: IndexedDbClientStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close().catch(() => undefined); });
const implementations = [
  { name: "memory", create: (): ClientStore => new MemoryClientStore() },
  { name: "IndexedDB", create: (): ClientStore => { const store = new IndexedDbClientStore(crypto.randomUUID(), new IDBFactory()); stores.push(store); return store; } },
];

describe.each(implementations)("$name local state parity", ({ create }) => {
  it("isolates fingerprint/session/epoch/projector namespaces and refuses lower revisions", async () => {
    const store = create();
    await store.putReplicaCache(record("host-a", 9));
    expect(await store.putReplicaCache(record("host-a", 8))).toBe(false);
    expect((await store.getReplicaCache(key()))?.revision).toBe(9);
    for (const changed of [{ fingerprint: "different-pin" }, { sessionId: "different-session" }, { epoch: "new-epoch" }, { projectorVersion: 2 }]) expect(await store.getReplicaCache({ ...key(), ...changed })).toBeUndefined();
    const loaded = await store.getReplicaCache(key());
    (loaded!.value as { items: string[] }).items.push("mutated");
    expect((await store.getReplicaCache(key()))?.value).toEqual({ items: ["cached text"] });
  });

  it("persists the original command before clearing its draft and retains a newer edit", async () => {
    const store = create();
    const draftKey = { hostId: "host-a", sessionId: "session-a" };
    await store.putDraft({ ...draftKey, text: "draft", updatedAt: 1 });
    await store.putCommandAndClearDraft(command(), draftKey, 1);
    expect(await store.getDraft(draftKey)).toBeUndefined();
    expect((await store.getCommand("command-a"))?.payload).toEqual({ prompt: "draft", clientMessageId: "message-a" });
    await store.putDraft({ ...draftKey, text: "new edit", updatedAt: 2 });
    await store.putCommand({ ...command(), state: "accepted", result: { turnId: "turn-a" } });
    await store.putCommandAndClearDraft(command(), draftKey, 1);
    expect((await store.getDraft(draftKey))?.text).toBe("new edit");
    expect((await store.getCommand("command-a"))?.state).toBe("accepted");
    await expect(store.putCommandAndClearDraft({ ...command(), payloadHash: "different" }, draftKey)).rejects.toMatchObject({ code: "COMMAND_ID_CONFLICT" });
    expect((await store.getDraft(draftKey))?.text).toBe("new edit");
  });

  it("atomically forgets every owned store and selection while keeping another Host", async () => {
    const store = create();
    await seed(store); await seed(store, "host-b");
    await store.setSelectedHost("host-a");
    await store.forgetLocalHost("host-a");
    expect(await store.getProfile("host-a")).toBeUndefined();
    expect(await store.getCredential("host-a")).toBeUndefined();
    expect(await store.listCommands("host-a")).toEqual([]);
    expect(await store.getDraft({ hostId: "host-a", sessionId: "session-a" })).toBeUndefined();
    expect(await store.listReplicaCaches("host-a")).toEqual([]);
    expect(await store.listContentMetadata("host-a")).toEqual([]);
    expect(await store.getSelectedHost()).toBeUndefined();
    expect(await store.getProfile("host-b")).toEqual(profile("host-b"));
    expect(await store.listCommands("host-b")).toHaveLength(1);
    await expect(store.putCommand(command())).rejects.toMatchObject({ code: "HOST_FORGOTTEN" });
    await expect(store.putDraft({ hostId: "host-a", sessionId: "session-a", text: "late", updatedAt: 3 })).rejects.toMatchObject({ code: "HOST_FORGOTTEN" });
    // A new verified pairing can deliberately establish a profile again.
    await store.putProfile(profile());
    await store.putDraft({ hostId: "host-a", sessionId: "session-a", text: "paired again", updatedAt: 4 });
    expect((await store.getDraft({ hostId: "host-a", sessionId: "session-a" }))?.text).toBe("paired again");
  });

  it("does not clear a different selected Host", async () => {
    const store = create();
    await store.setSelectedHost("host-b");
    await store.forgetLocalHost("host-a");
    expect(await store.getSelectedHost()).toBe("host-b");
  });
});

async function versionOne(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => { for (const table of ["profiles", "credentials", "commands", "meta"]) request.result.createObjectStore(table); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(["profiles", "credentials", "commands", "meta"], "readwrite");
    tx.objectStore("profiles").put(profile(), "host-a");
    tx.objectStore("credentials").put({ hostId: "host-a", deviceId: "old-device", refreshCredential: "bounded", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [], storage: "short-lived-refresh" }, "host-a");
    tx.objectStore("commands").put(command(), "command-a");
    tx.objectStore("meta").put("host-a", "selectedHost");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  return database;
}

describe("IndexedDB v2 upgrades and rollback", () => {
  it("upgrades v1 in place and preserves profile, credential, selected Host and unknown commands", async () => {
    const factory = new IDBFactory();
    const old = await versionOne(factory, "upgrade"); old.close();
    const store = new IndexedDbClientStore("upgrade", factory); stores.push(store);
    expect(await store.getProfile("host-a")).toEqual(profile());
    expect((await store.getCredential("host-a"))?.deviceId).toBe("old-device");
    expect(await store.getCommand("command-a")).toEqual(command());
    expect(await store.getSelectedHost()).toBe("host-a");
    await store.putDraft({ hostId: "host-a", sessionId: "session-a", text: "v2", updatedAt: 1 });
    await store.putReplicaCache(record());
  });

  it("reports blocked upgrades and closes a late successful open", async () => {
    const factory = new IDBFactory();
    const old = await versionOne(factory, "blocked");
    const blocked = vi.fn();
    const store = new IndexedDbClientStore("blocked", factory, { onBlocked: blocked });
    await expect(store.listProfiles()).rejects.toMatchObject({ code: "STORAGE_BLOCKED" });
    expect(blocked).toHaveBeenCalledTimes(1);
    old.close();
    const recovered = new IndexedDbClientStore("blocked", factory); stores.push(recovered);
    expect(await recovered.getProfile("host-a")).toEqual(profile());
  });

  it("leaves v1 facts intact when the upgrade transaction aborts", async () => {
    const factory = new IDBFactory();
    const old = await versionOne(factory, "aborted-upgrade"); old.close();
    const open = factory.open.bind(factory);
    const spy = vi.spyOn(factory, "open").mockImplementation((name, version) => {
      const request = open(name, version);
      request.addEventListener("upgradeneeded", () => queueMicrotask(() => request.transaction?.abort()));
      return request;
    });
    const failed = new IndexedDbClientStore("aborted-upgrade", factory);
    await expect(failed.listProfiles()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    spy.mockRestore();
    const recovered = new IndexedDbClientStore("aborted-upgrade", factory); stores.push(recovered);
    expect(await recovered.getProfile("host-a")).toEqual(profile());
    expect(await recovered.getSelectedHost()).toBe("host-a");
  });

  it("rolls back the draft handoff when command serialization fails", async () => {
    const store = new IndexedDbClientStore("failed-handoff", new IDBFactory()); stores.push(store);
    const draftKey = { hostId: "host-a", sessionId: "session-a" };
    await store.putDraft({ ...draftKey, text: "keep me", updatedAt: 1 });
    await expect(store.putCommandAndClearDraft({ ...command(), payload: () => {} }, draftKey)).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect((await store.getDraft(draftKey))?.text).toBe("keep me");
    expect(await store.getCommand("command-a")).toBeUndefined();
  });

  it("rolls back every deletion when the atomic forget transaction aborts", async () => {
    const store = new IndexedDbClientStore("failed-forget", new IDBFactory()); stores.push(store);
    await seed(store); await store.setSelectedHost("host-a");
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = transaction.call(this, names, mode, options);
      if (typeof names !== "string" && Array.from(names).length === 7 && mode === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    await expect(store.forgetLocalHost("host-a")).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    spy.mockRestore();
    expect(await store.getProfile("host-a")).toEqual(profile());
    expect(await store.getCredential("host-a")).toBeDefined();
    expect(await store.listCommands("host-a")).toHaveLength(1);
    expect(await store.getDraft({ hostId: "host-a", sessionId: "session-a" })).toBeDefined();
    expect(await store.listReplicaCaches("host-a")).toHaveLength(1);
    expect(await store.listContentMetadata("host-a")).toHaveLength(1);
    expect(await store.getSelectedHost()).toBe("host-a");
  });

  it("makes memory transaction failures preserve draft and all Host data", async () => {
    let fail: string | undefined;
    const store = new MemoryClientStore({ beforeWrite: (operation) => { if (operation === fail) throw new ClientError("STORAGE_WRITE_FAILED", "injected failure"); } });
    await seed(store); await store.setSelectedHost("host-a");
    fail = "draftCommand";
    await expect(store.putCommandAndClearDraft(command("host-a", "new-command"), { hostId: "host-a", sessionId: "session-a" })).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect(await store.getCommand("new-command")).toBeUndefined();
    expect(await store.getDraft({ hostId: "host-a", sessionId: "session-a" })).toBeDefined();
    fail = "forgetHost";
    await expect(store.forgetLocalHost("host-a")).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect(await store.getProfile("host-a")).toEqual(profile());
    expect(await store.listCommands("host-a")).toHaveLength(1);
    expect(await store.getSelectedHost()).toBe("host-a");
  });
});
