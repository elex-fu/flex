import type { Unsubscribe } from "@flyx/client-core";
export type WebSelection = { hostId: string; sessionId: string; transportGeneration: number };
export type SelectionTicket = { generation: number; selection?: WebSelection };
/** Every Host/Session/transport change invalidates pending UI reads. */
export class WebSelectionFence {
  private generation = 0;
  private selection: WebSelection | undefined;
  select(value?: WebSelection): void {
    if (JSON.stringify(value) === JSON.stringify(this.selection)) return;
    this.selection = value ? { ...value } : undefined; this.generation++;
  }
  invalidate(): void { this.generation++; }
  capture(): SelectionTicket { return { generation: this.generation, ...(this.selection ? { selection: { ...this.selection } } : {}) }; }
  current(ticket: SelectionTicket): boolean { return ticket.generation === this.generation && JSON.stringify(ticket.selection) === JSON.stringify(this.selection); }
}
export type WebLoadState<T> = { status: "idle" | "loading" | "ready" | "error"; value?: T; error?: string };
export class SelectedWebLoader<T> {
  private request = 0;
  private state: WebLoadState<T> = { status: "idle" };
  private observers = new Set<(state: WebLoadState<T>) => void>();
  constructor(private readonly fence: WebSelectionFence) {}
  getState(): WebLoadState<T> { return { ...this.state }; }
  observe(handler: (state: WebLoadState<T>) => void): Unsubscribe { handler(this.getState()); this.observers.add(handler); return () => { this.observers.delete(handler); }; }
  private publish(state: WebLoadState<T>): void { this.state = state; for (const observer of this.observers) observer(this.getState()); }
  reset(): void { this.request++; this.publish({ status: "idle" }); }
  async load(operation: () => Promise<T>): Promise<T | undefined> {
    const ticket = this.fence.capture(), request = ++this.request;
    const current = () => request === this.request && this.fence.current(ticket);
    this.publish({ status: "loading", ...(this.state.value !== undefined ? { value: this.state.value } : {}) });
    try { const value = await operation(); if (!current()) return; this.publish({ status: "ready", value }); return value; }
    catch (cause) { if (current()) this.publish({ status: "error", ...(this.state.value !== undefined ? { value: this.state.value } : {}), error: cause instanceof Error ? cause.message : "读取失败" }); return; }
  }
}
