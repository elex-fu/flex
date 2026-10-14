import { buildRelaySocketUrl, parseRelayDataMessage } from "@flyx/mvp-protocol";
import { createNoiseInitiator, MAX_SECURE_FRAME_BYTES } from "@flyx/secure-channel";
import type { NoiseHandshake, SecureSession } from "@flyx/secure-channel";
import { ClientError, fromBase64Url, Signal } from "../common.js";
import type { ClientTransport, HostProfile, TransportClose, Unsubscribe } from "../types.js";
import { MAX_BUFFERED_BYTES, openWebSocket } from "./websocket.js";
import type { SocketFactory } from "./websocket.js";

export interface RelayE2eeOptions {
  profile: HostProfile;
  relayUrl: string;
  routeId: string;
  generation: number;
  staticKey?: Uint8Array;
  deviceId?: string;
  signal?: AbortSignal;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
}

export async function connectRelayE2ee(options: RelayE2eeOptions): Promise<ClientTransport> {
  const url = buildRelaySocketUrl(options.relayUrl, { role: "client", routeId: options.routeId });
  const socket = await openWebSocket(url, { ...(options.signal ? { signal: options.signal } : {}), ...(options.socketFactory ? { factory: options.socketFactory } : {}), timeoutMs: options.timeoutMs ?? 10_000 });
  const messages = new Signal<string>();
  const closed = new Signal<TransportClose>();
  let handshake: NoiseHandshake | undefined;
  let secure: SecureSession | undefined;
  let connectionId: string | undefined;
  let paired = false;
  let receiveSequence = 0;
  let processing = Promise.resolve();
  let destroyed = false;
  let resolveReady!: (value: ClientTransport) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<ClientTransport>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
  const destroy = () => { if (destroyed) return; destroyed = true; cleanup(); handshake?.destroy(); secure?.destroy(); };
  const fail = (code: string) => { destroy(); socket.close(4000, code); rejectReady(new ClientError(code, "Unable to establish the encrypted Host connection")); };
  const abort = () => fail("CONNECTION_REPLACED");
  const timer = setTimeout(() => fail("SECURE_HANDSHAKE_TIMEOUT"), options.timeoutMs ?? 10_000);
  const sendBinary = (data: Uint8Array) => {
    if (socket.readyState !== 1) throw new ClientError("CONNECTION_CLOSED", "Relay connection closed");
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) throw new ClientError("RESYNC_REQUIRED", "Relay send queue is full");
    socket.send(data as Uint8Array<ArrayBuffer>);
  };
  const transport: ClientTransport = {
    id: crypto.randomUUID(), kind: "relay", generation: options.generation,
    authentication: options.staticKey ? "relay-ik" : "relay-nk",
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    async send(frame) {
      if (!secure || destroyed) throw new ClientError("CONNECTION_CLOSED", "Encrypted Host connection is closed");
      const plaintext = new TextEncoder().encode(frame);
      if (plaintext.byteLength > 262_144) throw new ClientError("FRAME_TOO_LARGE", "Request exceeds the application frame limit");
      try { sendBinary(secure.encrypt(plaintext)); }
      catch (error) { fail("RESYNC_REQUIRED"); throw error; }
    },
    close(code = 1000, reason = "CLOSED") { destroy(); socket.close(code, reason); },
    onMessage(handler): Unsubscribe { return messages.subscribe(handler); },
    onClose(handler): Unsubscribe { return closed.subscribe(handler); },
  };
  socket.addEventListener("close", (event) => { destroy(); rejectReady(new ClientError("CONNECTION_CLOSED", "Relay connection closed")); closed.emit({ code: event.code, reason: event.reason }); });
  socket.addEventListener("error", () => fail("RELAY_CONNECTION_FAILED"));
  options.signal?.addEventListener("abort", abort, { once: true });
  socket.addEventListener("message", (event) => {
    processing = processing.then(async () => {
      if (destroyed) return;
      if (typeof event.data === "string") {
        const control = parseRelayDataMessage(event.data);
        if (control.type === "client.connected") {
          if (connectionId !== undefined) throw new ClientError("RELAY_PROTOCOL_ERROR", "Duplicate Relay connection assignment");
          connectionId = control.connectionId;
        } else if (control.type === "data.paired") {
          if (!connectionId || control.connectionId !== connectionId || paired) { fail("CONNECTION_REPLACED"); return; }
          paired = true;
          handshake = await createNoiseInitiator({ pattern: options.staticKey ? "IK" : "NK", remoteStaticKey: fromBase64Url(options.profile.hostPublicKey), ...(options.staticKey ? { staticKey: options.staticKey } : {}), binding: { hostId: options.profile.hostId, routeId: options.routeId, connectionId, protocol: { min: 2, max: 2 } } });
          sendBinary(handshake.writeMessage());
        } else if (control.type === "error") throw new ClientError(control.code, "Relay rejected the connection");
        return;
      }
      if (!paired) throw new ClientError("RELAY_PROTOCOL_ERROR", "Relay sent data before pairing");
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : ArrayBuffer.isView(event.data) ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength) : undefined;
      if (!bytes || bytes.byteLength > MAX_SECURE_FRAME_BYTES) throw new ClientError("FRAME_TOO_LARGE", "Relay frame exceeds its limit");
      if (!secure) {
        if (!handshake) throw new ClientError("SECURE_HANDSHAKE_FAILED", "Noise handshake is missing");
        handshake.readMessage(bytes);
        if (!handshake.complete) throw new ClientError("SECURE_HANDSHAKE_FAILED", "Noise handshake did not complete");
        secure = handshake.finish();
        cleanup();
        resolveReady(transport);
      } else {
        const plaintext = secure.decrypt(bytes);
        messages.emit(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      }
      // Count physical binary deliveries, including handshake frames. Relay ACKs
      // contain no application data and are consumed by the Relay itself.
      socket.send(JSON.stringify({ type: "ack", sequence: ++receiveSequence }));
    }).catch(() => fail("SECURE_CHANNEL_FAILED"));
  });
  return ready;
}
