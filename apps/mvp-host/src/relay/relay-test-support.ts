import type { RelaySocket, RelaySocketClose, RelaySocketFactory, RelaySocketOptions } from "./relay-socket.js";

export class FakeRelaySocket implements RelaySocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  closeCalls: RelaySocketClose[] = [];
  terminated = false;
  failSends = false;
  private opens = new Set<() => void>();
  private messages = new Set<(frame: string | Uint8Array) => void>();
  private closes = new Set<(info: RelaySocketClose) => void>();
  private errors = new Set<() => void>();
  constructor(readonly url: string, readonly options: RelaySocketOptions) {}
  open(): void { this.readyState = 1; for (const fn of this.opens) fn(); }
  receive(frame: string | Uint8Array): void { for (const fn of this.messages) fn(frame); }
  serverClose(code = 1006): void {
    this.readyState = 3;
    for (const fn of this.closes) fn({ code, reason: "remote text must not be reflected" });
  }
  fail(): void { for (const fn of this.errors) fn(); }
  send(frame: string | Uint8Array, done: (error?: Error) => void): void {
    if (this.failSends) { done(new Error("PRIVATE_ERROR_MARKER")); return; }
    this.sent.push(typeof frame === "string" ? frame : new Uint8Array(frame)); done();
  }
  close(code = 1000, reason = ""): void { this.closeCalls.push({ code, reason }); this.readyState = 3; }
  terminate(): void { this.terminated = true; this.readyState = 3; }
  onOpen(handler: () => void): () => void { this.opens.add(handler); return () => this.opens.delete(handler); }
  onMessage(handler: (frame: string | Uint8Array) => void): () => void { this.messages.add(handler); return () => this.messages.delete(handler); }
  onClose(handler: (info: RelaySocketClose) => void): () => void { this.closes.add(handler); return () => this.closes.delete(handler); }
  onError(handler: () => void): () => void { this.errors.add(handler); return () => this.errors.delete(handler); }
}

export function fakeRelaySocketFactory(): { sockets: FakeRelaySocket[]; factory: RelaySocketFactory } {
  const sockets: FakeRelaySocket[] = [];
  return { sockets, factory: (url, options) => { const socket = new FakeRelaySocket(url, options); sockets.push(socket); return socket; } };
}

export async function settlePromises(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
