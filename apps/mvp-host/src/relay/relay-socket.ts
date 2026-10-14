import WebSocket from "ws";

export interface RelaySocketClose { code: number; reason: string }

/** A small injectable boundary keeps reconnect tests independent of real timers and TCP. */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(frame: string | Uint8Array, done: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  onOpen(handler: () => void): () => void;
  onMessage(handler: (frame: string | Uint8Array) => void): () => void;
  onClose(handler: (info: RelaySocketClose) => void): () => void;
  onError(handler: () => void): () => void;
}

export interface RelaySocketOptions {
  headers: { authorization: string };
  maxFrameBytes: number;
}

export type RelaySocketFactory = (url: string, options: RelaySocketOptions) => RelaySocket;

export const createNodeRelaySocket: RelaySocketFactory = (url, options) => {
  const socket = new WebSocket(url, {
    headers: options.headers,
    maxPayload: options.maxFrameBytes,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: 15_000,
  });
  // terminate() during an unfinished HTTP upgrade may emit after subscribers leave.
  socket.on("error", () => undefined);
  // The public callback intentionally omits Error objects, which can include URLs or headers.
  return {
    get readyState() { return socket.readyState; },
    get bufferedAmount() { return socket.bufferedAmount; },
    send(frame, done) { socket.send(frame, { binary: typeof frame !== "string", compress: false }, done); },
    close(code, reason) { socket.close(code, reason); },
    terminate() { socket.terminate(); },
    onOpen(handler) { socket.on("open", handler); return () => socket.off("open", handler); },
    onMessage(handler) {
      const receive = (data: WebSocket.RawData, binary: boolean) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        handler(binary ? bytes : bytes.toString("utf8"));
      };
      socket.on("message", receive); return () => socket.off("message", receive);
    },
    onClose(handler) {
      const close = (code: number, reason: Buffer) => handler({ code, reason: reason.toString("utf8") });
      socket.on("close", close); return () => socket.off("close", close);
    },
    onError(handler) { socket.on("error", handler); return () => socket.off("error", handler); },
  };
};

export function sendRelaySocket(socket: RelaySocket, frame: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(new Error("RELAY_SOCKET_NOT_OPEN")); return; }
    try { socket.send(frame, (error) => error ? reject(new Error("RELAY_SOCKET_SEND_FAILED")) : resolve()); }
    catch { reject(new Error("RELAY_SOCKET_SEND_FAILED")); }
  });
}
