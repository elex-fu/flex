import type { ClientTransport, TransportAuthentication, TransportClose, Unsubscribe } from "./types.js";

/** Tests inject a physical transport; it intentionally lets stale listeners run. */
export class TestTransport implements ClientTransport {
  readonly id = crypto.randomUUID();
  sent: Record<string, unknown>[] = [];
  closes: TransportClose[] = [];
  messages: Array<(frame: string) => void> = [];
  closed: Array<(close: TransportClose) => void> = [];
  respond: ((frame: Record<string, unknown>) => void) | undefined;
  constructor(
    readonly generation: number,
    readonly kind: "direct" | "relay" = "direct",
    readonly deviceId = "device-test",
    readonly authentication?: TransportAuthentication,
  ) {}
  async send(text: string): Promise<void> { const frame = JSON.parse(text) as Record<string, unknown>; this.sent.push(frame); this.respond?.(frame); }
  emit(frame: Record<string, unknown>): void {
    const encoded = JSON.stringify({ transportGeneration: this.generation, ...frame });
    queueMicrotask(() => { for (const handler of this.messages) handler(encoded); });
  }
  disconnect(code = 1006, reason = "NETWORK_LOST"): void { for (const handler of this.closed) handler({ code, reason }); }
  close(code = 1000, reason = "CLOSED"): void { this.closes.push({ code, reason }); }
  onMessage(handler: (frame: string) => void): Unsubscribe { this.messages.push(handler); return () => {}; }
  onClose(handler: (close: TransportClose) => void): Unsubscribe { this.closed.push(handler); return () => {}; }
}
