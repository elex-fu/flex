import { ClientError, Signal } from "../common.js";
import type { ClientTransport, TransportAuthentication, TransportClose, Unsubscribe } from "../types.js";

export type SocketFactory = (url: string) => WebSocket;
export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url);
export const MAX_BUFFERED_BYTES = 1_048_576;

export async function openWebSocket(url: string, options: { signal?: AbortSignal; factory?: SocketFactory; timeoutMs?: number } = {}): Promise<WebSocket> {
  if (options.signal?.aborted) throw new ClientError("CONNECTION_REPLACED", "Connection was replaced");
  const socket = (options.factory ?? defaultSocketFactory)(url);
  socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("open", opened); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed); options.signal?.removeEventListener("abort", aborted); };
    const fail = (error: ClientError) => { cleanup(); socket.close(); reject(error); };
    const opened = () => { cleanup(); resolve(socket); };
    const failed = () => fail(new ClientError("SOCKET_OPEN_FAILED", "Unable to establish secure WebSocket"));
    const aborted = () => fail(new ClientError("CONNECTION_REPLACED", "Connection was replaced"));
    const timer = setTimeout(() => fail(new ClientError("SOCKET_OPEN_TIMEOUT", "WebSocket open timed out")), options.timeoutMs ?? 10_000);
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
    options.signal?.addEventListener("abort", aborted, { once: true });
  });
}

export class WebSocketApplicationTransport implements ClientTransport {
  readonly id = crypto.randomUUID();
  private messages = new Signal<string>();
  private closed = new Signal<TransportClose>();
  constructor(
    private socket: WebSocket,
    readonly generation: number,
    readonly kind: "direct" | "relay" = "direct",
    readonly deviceId?: string,
    private maxFrameBytes = 262_144,
    readonly authentication?: TransportAuthentication,
  ) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).byteLength > this.maxFrameBytes) { this.close(1009, "FRAME_TOO_LARGE"); return; }
      this.messages.emit(event.data);
    });
    socket.addEventListener("close", (event) => this.closed.emit({ code: event.code, reason: event.reason }));
  }
  async send(frame: string): Promise<void> {
    if (this.socket.readyState !== 1) throw new ClientError("CONNECTION_CLOSED", "Host connection closed");
    if (new TextEncoder().encode(frame).byteLength > this.maxFrameBytes) throw new ClientError("FRAME_TOO_LARGE", "Request exceeds the frame limit");
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.close(4009, "RESYNC_REQUIRED"); throw new ClientError("RESYNC_REQUIRED", "Connection send queue is full"); }
    this.socket.send(frame);
  }
  close(code = 1000, reason = "CLOSED"): void { this.socket.close(code === 1000 || code >= 3000 && code <= 4999 ? code : 4000 + (code % 1000), reason); }
  onMessage(handler: (frame: string) => void): Unsubscribe { return this.messages.subscribe(handler); }
  onClose(handler: (close: TransportClose) => void): Unsubscribe { return this.closed.subscribe(handler); }
}
