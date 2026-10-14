import {
  createNoiseResponder, inspectNoiseHandshakePattern,
  type NoiseHandshake, type SecureSession,
} from "@flyx/secure-channel";
import { parseRelayDataMessage, MAX_RELAY_CIPHERTEXT_FRAME_BYTES, RELAY_SEND_HIGH_WATER_BYTES } from "@flyx/mvp-protocol";
import { sendRelaySocket, type RelaySocket, type RelaySocketClose } from "./relay-socket.js";

const MAX_APPLICATION_BYTES = 256 * 1024;

export interface SecureRelayConnection {
  transport: HostRelayTransport;
  pattern: "NK" | "IK";
  /** Only present after Noise IK cryptographically authenticates the client's static key. */
  remotePublicKey?: string;
}

export interface HostRelayTransportOptions {
  socket: RelaySocket;
  connectionId: string;
  generation: number;
  hostId: string;
  routeId: string;
  hostStaticKey: Uint8Array;
  protocol: { min: number; max: number };
  onConnection: (connection: SecureRelayConnection) => void | Promise<void>;
  openTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

/** Converts an outbound Relay data socket into the same plaintext transport used by Direct. */
export class HostRelayTransport {
  readonly kind = "relay" as const;
  readonly id: string;
  readonly generation: number;
  private phase: "connecting" | "handshaking" | "ready" | "closed" = "connecting";
  private handshake: NoiseHandshake | undefined;
  private secure: SecureSession | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unlisten: Array<() => void> = [];
  private readonly messages = new Set<(frame: string | Uint8Array) => void>();
  private readonly closes = new Set<(info: RelaySocketClose) => void>();
  private readonly queue: Array<string | Uint8Array> = [];
  private queuedBytes = 0;
  private pendingSendBytes = 0;
  private receivedSequence = 0;
  private draining = false;
  private closeInfo: RelaySocketClose | undefined;

  constructor(private readonly options: HostRelayTransportOptions) {
    this.id = options.connectionId;
    this.generation = options.generation;
    this.unlisten.push(
      options.socket.onMessage((frame) => this.enqueue(frame)),
      options.socket.onClose((info) => this.finishClose({ code: info.code, reason: "RELAY_SOCKET_CLOSED" })),
      options.socket.onError(() => this.close(1011, "RELAY_SOCKET_FAILED")),
    );
    this.deadline(options.openTimeoutMs ?? 15_000, "RELAY_DATA_OPEN_TIMEOUT");
  }

  get ready(): boolean { return this.phase === "ready"; }
  get closed(): boolean { return this.phase === "closed"; }

  onMessage(handler: (frame: string | Uint8Array) => void): () => void {
    this.messages.add(handler);
    return () => this.messages.delete(handler);
  }

  onClose(handler: (info: RelaySocketClose) => void): () => void {
    if (this.closeInfo) handler(this.closeInfo);
    else this.closes.add(handler);
    return () => this.closes.delete(handler);
  }

  async send(frame: string | Uint8Array): Promise<void> {
    if (this.phase !== "ready" || !this.secure) throw new Error("RELAY_TRANSPORT_NOT_READY");
    const bytes = typeof frame === "string" ? Buffer.from(frame, "utf8") : frame;
    if (bytes.byteLength > MAX_APPLICATION_BYTES) {
      this.close(4409, "RESYNC_REQUIRED");
      throw new Error("RELAY_FRAME_TOO_LARGE");
    }
    // Reserve space before advancing the Noise nonce; an unsent encrypted frame cannot be retried.
    const reserved = bytes.byteLength + 1024;
    if (Math.max(this.options.socket.bufferedAmount, this.pendingSendBytes) + reserved > RELAY_SEND_HIGH_WATER_BYTES) {
      this.close(4409, "RESYNC_REQUIRED");
      throw new Error("RELAY_BACKPRESSURE");
    }
    this.pendingSendBytes += reserved;
    try {
      const ciphertext = this.secure.encrypt(bytes);
      await sendRelaySocket(this.options.socket, ciphertext);
    } catch {
      this.close(1011, "RELAY_SEND_FAILED");
      throw new Error("RELAY_SEND_FAILED");
    } finally { this.pendingSendBytes -= reserved; }
  }

  close(code = 1000, reason = "RELAY_TRANSPORT_CLOSED"): void {
    if (this.closed) return;
    // Do not forward arbitrary peer text into diagnostics or a different socket.
    const safeReason = /^[A-Z0-9_]{1,80}$/.test(reason) ? reason : "RELAY_TRANSPORT_CLOSED";
    this.finishClose({ code, reason: safeReason });
    try { this.options.socket.close(code, safeReason); } catch { /* already disconnected */ }
    this.options.socket.terminate();
  }

  private deadline(milliseconds: number, reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(4408, reason), milliseconds);
    this.timer.unref?.();
  }

  private enqueue(frame: string | Uint8Array): void {
    if (this.closed) return;
    const size = typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    if (size > MAX_RELAY_CIPHERTEXT_FRAME_BYTES || this.queuedBytes + size > RELAY_SEND_HIGH_WATER_BYTES || this.queue.length >= 64) {
      this.close(4409, "RESYNC_REQUIRED");
      return;
    }
    this.queue.push(frame);
    this.queuedBytes += size;
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length && !this.closed) {
        const frame = this.queue.shift()!;
        this.queuedBytes -= typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
        await this.receive(frame);
        if (typeof frame !== "string" && !this.closed) {
          this.receivedSequence += 1;
          await sendRelaySocket(this.options.socket, JSON.stringify({ type: "ack", sequence: this.receivedSequence }));
        }
      }
    } catch { this.close(4403, "RELAY_SECURE_CHANNEL_FAILED"); }
    finally { this.draining = false; }
  }

  private async receive(frame: string | Uint8Array): Promise<void> {
    if (typeof frame === "string") {
      if (this.phase !== "connecting") throw new Error("RELAY_UNEXPECTED_TEXT_FRAME");
      const paired = parseRelayDataMessage(frame);
      if (paired.type !== "data.paired" || paired.connectionId !== this.id || paired.generation !== this.generation) {
        throw new Error("RELAY_DATA_PAIR_MISMATCH");
      }
      this.phase = "handshaking";
      this.deadline(this.options.handshakeTimeoutMs ?? 10_000, "RELAY_SECURE_HANDSHAKE_TIMEOUT");
      return;
    }
    if (this.phase === "connecting") throw new Error("RELAY_DATA_NOT_PAIRED");
    if (this.phase === "handshaking") {
      if (!this.handshake) {
        this.handshake = await createNoiseResponder({
          pattern: inspectNoiseHandshakePattern(frame),
          binding: { hostId: this.options.hostId, routeId: this.options.routeId, connectionId: this.id, protocol: this.options.protocol },
          staticKey: this.options.hostStaticKey,
        });
      }
      if (this.closed) { this.handshake.destroy(); return; }
      this.handshake.readMessage(frame);
      const response = this.handshake.writeMessage();
      if (!this.handshake.complete) throw new Error("RELAY_HANDSHAKE_INCOMPLETE");
      this.secure = this.handshake.finish();
      this.handshake = undefined;
      await sendRelaySocket(this.options.socket, response);
      if (this.closed) return;
      this.phase = "ready";
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      await this.options.onConnection({
        transport: this, pattern: this.secure.pattern,
        ...(this.secure.remoteStaticKey ? { remotePublicKey: Buffer.from(this.secure.remoteStaticKey).toString("base64url") } : {}),
      });
      return;
    }
    if (!this.secure) throw new Error("RELAY_SECURE_CHANNEL_MISSING");
    const plaintext = this.secure.decrypt(frame);
    if (plaintext.byteLength > MAX_APPLICATION_BYTES) throw new Error("RELAY_FRAME_TOO_LARGE");
    const message = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    for (const handler of this.messages) handler(message);
  }

  private finishClose(info: RelaySocketClose): void {
    if (this.closed) return;
    this.phase = "closed";
    this.closeInfo = info;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.handshake?.destroy();
    this.handshake = undefined;
    this.secure?.destroy();
    this.secure = undefined;
    this.queue.length = 0;
    this.queuedBytes = 0;
    for (const off of this.unlisten.splice(0)) off();
    for (const handler of this.closes) handler(info);
    this.closes.clear();
    this.messages.clear();
  }
}
