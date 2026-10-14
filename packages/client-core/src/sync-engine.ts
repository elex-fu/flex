import type { SessionEvent } from "@flyx/mvp-protocol";
import { ClientError, isRecord, Signal } from "./common.js";
import type { SyncState, Unsubscribe } from "./types.js";

export interface SyncEngineOptions {
  request: <T>(method: string, payload?: unknown) => Promise<T>;
  isCurrent: (generation: number) => boolean;
  recover: () => void;
  pageSize?: number;
  maxBufferedEvents?: number;
}
interface TimelinePage { events: SessionEvent[]; upTo: number; nextAfter?: number; hasMore: boolean }
export class SyncEngine {
  private state: SyncState = "unknown";
  private generation = -1;
  private sequence = 0;
  private sessionId: string | undefined;
  private buffer: SessionEvent[] = [];
  private states = new Signal<SyncState>();
  private events = new Signal<SessionEvent>();
  private snapshots = new Signal<unknown>();
  private resets = new Signal<void>();
  constructor(private options: SyncEngineOptions) {}
  get lastSequence(): number { return this.sequence; }
  onState(handler: (state: SyncState) => void): Unsubscribe { return this.states.subscribe(handler); }
  onEvent(handler: (event: SessionEvent) => void): Unsubscribe { return this.events.subscribe(handler); }
  onSnapshot(handler: (snapshot: unknown) => void): Unsubscribe { return this.snapshots.subscribe(handler); }
  onReset(handler: () => void): Unsubscribe { return this.resets.subscribe(handler); }
  private update(state: SyncState): void { this.state = state; this.states.emit(state); }
  invalidate(): void { this.generation = -1; this.buffer = []; this.update("unknown"); }
  reset(): void { this.invalidate(); this.sequence = 0; this.sessionId = undefined; this.resets.emit(); }
  receive(event: SessionEvent, generation: number): void {
    if (generation !== this.generation || !this.options.isCurrent(generation)) return;
    if (this.state !== "synced") {
      if (this.buffer.length >= (this.options.maxBufferedEvents ?? 4_096)) { this.update("resync_required"); this.options.recover(); return; }
      this.buffer.push(event);
      return;
    }
    if (!this.apply(event)) { this.buffer.push(event); this.update("resync_required"); this.options.recover(); }
  }
  private apply(event: SessionEvent): boolean {
    if (event.sessionId !== this.sessionId) return false;
    if (event.sequence <= this.sequence) return true;
    if (event.sequence !== this.sequence + 1) return false;
    this.sequence = event.sequence;
    this.events.emit(event);
    return true;
  }
  async synchronize(generation: number): Promise<void> {
    this.generation = generation;
    this.buffer = [];
    this.update("catching_up");
    const current = () => generation === this.generation && this.options.isCurrent(generation);
    try {
      const snapshot = await this.options.request<unknown>("host.getSnapshot");
      if (!current()) return;
      if (!isRecord(snapshot) || !isRecord(snapshot.session) || typeof snapshot.session.id !== "string" || !Number.isSafeInteger(snapshot.session.headSequence) || (snapshot.session.headSequence as number) < 0) throw new ClientError("INVALID_SNAPSHOT", "Host returned an invalid snapshot");
      const sessionId = snapshot.session.id;
      const upper = snapshot.session.headSequence as number;
      if (this.sessionId !== sessionId || this.sequence > upper) { this.sequence = 0; this.resets.emit(); }
      this.sessionId = sessionId;
      this.snapshots.emit(snapshot);
      await this.options.request("session.subscribe", { sessionId, afterSequence: this.sequence });
      if (!current()) return;
      let cursor = this.sequence;
      while (cursor < upper) {
        const page = await this.options.request<TimelinePage>("session.getEvents", { sessionId, afterSequence: cursor, limit: this.options.pageSize ?? 200, upTo: upper });
        if (!current()) return;
        if (page.upTo !== upper || !Array.isArray(page.events)) throw new ClientError("TIMELINE_GAP", "Timeline watermark changed during recovery");
        for (const event of page.events) {
          if (event.sequence > upper || !this.apply(event)) throw new ClientError("TIMELINE_GAP", "Timeline sequence is not continuous");
        }
        if (!page.hasMore) break;
        if (page.nextAfter === undefined || page.nextAfter <= cursor || page.nextAfter !== this.sequence || page.nextAfter > upper) throw new ClientError("TIMELINE_GAP", "Timeline pagination did not advance");
        cursor = page.nextAfter;
      }
      if (this.sequence !== upper) throw new ClientError("TIMELINE_GAP", "Timeline did not reach its recovery watermark");
      // Historical replay builds items; the authoritative snapshot describes W.
      // Restore that projection before applying buffered events strictly above W.
      this.snapshots.emit(snapshot);
      const buffered = this.buffer;
      this.buffer = [];
      for (const event of buffered) if (!this.apply(event)) throw new ClientError("TIMELINE_GAP", "Live timeline has a sequence gap");
      this.update("synced");
    } catch (error) { if (current()) this.update("resync_required"); throw error; }
  }
}
