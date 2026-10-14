import { DraftStore, type ClientDraft, type ClientStore, type DraftCommandOptions, type DraftKey, type PendingCommand, type Unsubscribe } from "@flyx/client-core";

export interface DraftCommandClient {
  readonly store: ClientStore;
  commandFromDraft<T = unknown>(method: string, payload: unknown, key: DraftKey, options: DraftCommandOptions): Promise<T>;
}
export interface WebDraftState {
  key?: DraftKey;
  text: string;
  loading: boolean;
  saving: boolean;
  submitting: boolean;
  error: string;
}
type Buffer = { text: string; clientMessageId?: string | undefined; edit: number; saved?: ClientDraft; submitting?: string };
type Selection = { key: DraftKey; client: DraftCommandClient; generation: number; buffer: Buffer };
function keyId(key: DraftKey): string { return JSON.stringify([key.hostId, key.sessionId]); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : "草稿存储失败"; }

/** The UI buffer and durable draft share a Host/Session namespace, never a render closure. */
export class WebDraftController {
  private buffers = new Map<string, Buffer>();
  private stores = new WeakMap<ClientStore, DraftStore>();
  private writes = new Map<string, Set<Promise<unknown>>>();
  private blocked = new Set<string>();
  private generation = 0;
  private selection: Selection | undefined;
  private observers = new Set<(state: WebDraftState) => void>();
  private state: WebDraftState = { text: "", loading: false, saving: false, submitting: false, error: "" };
  constructor(private readonly uuid: () => string = () => crypto.randomUUID()) {}
  getState(): WebDraftState { return structuredClone(this.state); }
  observe(handler: (state: WebDraftState) => void): Unsubscribe { handler(this.getState()); this.observers.add(handler); return () => { this.observers.delete(handler); }; }
  private publish(patch: Partial<WebDraftState> = {}): void {
    const selected = this.selection;
    this.state = { text: selected?.buffer.text ?? "", loading: this.state.loading, saving: selected ? (this.writes.get(keyId(selected.key))?.size ?? 0) > 0 : false, submitting: Boolean(selected?.buffer.submitting), error: this.state.error, ...(selected ? { key: { ...selected.key } } : {}), ...patch };
    for (const observer of this.observers) observer(this.getState());
  }
  private current(value: Selection): boolean { return this.selection === value && value.generation === this.generation && !this.blocked.has(value.key.hostId); }
  private draftStore(store: ClientStore): DraftStore { let drafts = this.stores.get(store); if (!drafts) { drafts = new DraftStore(store); this.stores.set(store, drafts); } return drafts; }
  async select(key: DraftKey | undefined, client?: DraftCommandClient): Promise<void> {
    const generation = ++this.generation;
    if (!key || !client) { this.selection = undefined; this.publish({ loading: false, error: "" }); return; }
    const id = keyId(key), existing = this.buffers.get(id);
    const buffer = existing ?? { text: "", edit: 0 };
    this.buffers.set(id, buffer);
    const selected: Selection = { key: { ...key }, client, generation, buffer };
    this.selection = selected;
    const edit = buffer.edit;
    this.publish({ loading: !existing, error: "" });
    try {
      await Promise.allSettled([...(this.writes.get(id) ?? [])]);
      if (!this.current(selected)) return;
      const saved = await client.store.getDraft(key);
      if (!this.current(selected)) return;
      if (!existing && buffer.edit === edit && saved) {
        buffer.text = saved.text;
        buffer.clientMessageId = saved.clientMessageId ?? (saved.text ? this.uuid() : undefined);
        buffer.saved = saved;
      }
      this.publish({ loading: false });
    } catch (cause) { if (this.current(selected)) this.publish({ loading: false, error: message(cause) }); }
  }
  edit(text: string): void {
    const selected = this.selection;
    if (!selected || this.blocked.has(selected.key.hostId)) return;
    const buffer = selected.buffer;
    buffer.edit++;
    if (text && (!buffer.clientMessageId || buffer.submitting === buffer.clientMessageId)) buffer.clientMessageId = this.uuid();
    if (!text) delete buffer.clientMessageId;
    buffer.text = text;
    this.publish({ error: "" });
    void this.save(selected, { text, edit: buffer.edit, clientMessageId: buffer.clientMessageId }).catch(() => undefined);
  }
  private save(selected: Selection, input: { text: string; edit: number; clientMessageId?: string | undefined }): Promise<ClientDraft> {
    const id = keyId(selected.key);
    let pending = this.writes.get(id);
    if (!pending) { pending = new Set(); this.writes.set(id, pending); }
    const work = this.draftStore(selected.client.store).save(selected.key, input.text, input.clientMessageId).then((saved) => {
      if (selected.buffer.edit === input.edit && selected.buffer.text === input.text && selected.buffer.clientMessageId === input.clientMessageId) selected.buffer.saved = saved;
      return saved;
    }).catch((cause: unknown) => { if (this.current(selected) && selected.buffer.edit === input.edit) this.publish({ error: message(cause) }); throw cause; });
    pending.add(work);
    this.publish();
    void work.finally(() => { pending.delete(work); if (pending.size === 0) this.writes.delete(id); if (this.current(selected)) this.publish(); }).catch(() => undefined);
    return work;
  }
  async submit(explicitSession: boolean): Promise<unknown> {
    const selected = this.selection;
    if (!selected || !this.current(selected) || !selected.buffer.text.trim()) throw new Error("DRAFT_SELECTION_REQUIRED");
    const buffer = selected.buffer;
    if (buffer.submitting) throw new Error("DRAFT_SUBMISSION_PENDING");
    const input = { text: buffer.text, edit: buffer.edit, clientMessageId: buffer.clientMessageId ?? this.uuid() };
    buffer.clientMessageId = input.clientMessageId;
    buffer.submitting = input.clientMessageId;
    this.publish({ error: "" });
    try {
      const saved = await this.save(selected, input);
      if (!this.current(selected)) throw new Error("DRAFT_SELECTION_CHANGED");
      return await selected.client.commandFromDraft("session.startTurn", { prompt: input.text.trim(), clientMessageId: input.clientMessageId, ...(explicitSession ? { sessionId: selected.key.sessionId } : {}) }, selected.key, {
        draftUpdatedAt: saved.updatedAt,
        onPersisted: (_command: PendingCommand) => {
          // New input, another Session, or a forgotten Host cannot be cleared by this callback.
          if (this.blocked.has(selected.key.hostId)) return;
          if (buffer.edit === input.edit && buffer.text === input.text && buffer.clientMessageId === input.clientMessageId) {
            buffer.text = ""; buffer.edit++; delete buffer.clientMessageId; delete buffer.saved;
            if (this.current(selected)) this.publish();
          }
        },
      });
    } catch (cause) { if (this.current(selected)) this.publish({ error: message(cause) }); throw cause; }
    finally { if (buffer.submitting === input.clientMessageId) delete buffer.submitting; if (this.current(selected)) this.publish(); }
  }
  /** Wait only for local draft writes, never for a remote command outcome. */
  async forgetHost(hostId: string, forget: () => Promise<void>): Promise<void> {
    if (this.blocked.has(hostId)) throw new Error("HOST_FORGETTING");
    this.blocked.add(hostId);
    try {
      const pending = [...this.writes].filter(([id]) => (JSON.parse(id) as string[])[0] === hostId).flatMap(([, values]) => [...values]);
      await Promise.allSettled(pending);
      await forget();
      for (const id of this.buffers.keys()) if ((JSON.parse(id) as string[])[0] === hostId) this.buffers.delete(id);
      if (this.selection?.key.hostId === hostId) { this.generation++; this.selection = undefined; this.publish({ loading: false, error: "" }); }
    } catch (cause) { if (this.selection?.key.hostId === hostId) this.publish({ loading: false, error: message(cause) }); throw cause; }
    finally { this.blocked.delete(hostId); }
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.writes.values()].flatMap((values) => [...values])); }
}
