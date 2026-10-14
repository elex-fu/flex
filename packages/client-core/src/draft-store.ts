import type { ClientDraft, ClientStore, DraftKey, PendingCommand } from "./types.js";
import { draftStorageKey } from "./host-profile-store.js";

/** Draft failures are reported to the caller so the composer can keep its input. */
export class DraftStore {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private store: ClientStore, private now: () => number = Date.now) {}
  get(key: DraftKey): Promise<ClientDraft | undefined> { return this.store.getDraft(key); }
  save(key: DraftKey, text: string, clientMessageId?: string): Promise<ClientDraft> {
    const id = draftStorageKey(key);
    const pending = this.writes.get(id) ?? Promise.resolve();
    const write = pending.catch(() => undefined).then(async () => {
      const previous = await this.store.getDraft(key);
      // Keep the deletion guard distinct even for two edits in one millisecond.
      const draft: ClientDraft = { ...key, text, updatedAt: Math.max(this.now(), (previous?.updatedAt ?? -1) + 1), ...(clientMessageId ? { clientMessageId } : {}) };
      await this.store.putDraft(draft);
      return draft;
    });
    this.writes.set(id, write);
    void write.finally(() => { if (this.writes.get(id) === write) this.writes.delete(id); }).catch(() => undefined);
    return write;
  }
  async clear(key: DraftKey): Promise<void> { await this.writes.get(draftStorageKey(key)); await this.store.deleteDraft(key); }
  async handoff(command: PendingCommand, key: DraftKey, expectedUpdatedAt?: number): Promise<void> {
    await this.writes.get(draftStorageKey(key));
    await this.store.putCommandAndClearDraft(command, key, expectedUpdatedAt);
  }
}
