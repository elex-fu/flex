import { type TransportState } from "salty-crypto";
import { MonotonicCipher, MAX_NOISE_NONCE } from "./cipher.js";
import { SecureChannelError, type SecureChannelErrorCode } from "./errors.js";

export type NoisePattern = "NK" | "IK";
export const MAX_SECURE_PLAINTEXT_BYTES = 256 * 1024;
export const NOISE_RECORD_PLAINTEXT_BYTES = 65_535 - 16;
export const SECURE_FRAME_HEADER_BYTES = 22;
export const MAX_SECURE_FRAME_BYTES = SECURE_FRAME_HEADER_BYTES + MAX_SECURE_PLAINTEXT_BYTES
  + Math.ceil(MAX_SECURE_PLAINTEXT_BYTES / NOISE_RECORD_PLAINTEXT_BYTES) * 16;

export interface SecureChannelLimits {
  maxPlaintextBytes: number;
  rekeyAfterMessages: number;
  rekeyAfterBytes: number;
  rekeyAfterMs: number;
}

export const DEFAULT_SECURE_CHANNEL_LIMITS: Readonly<SecureChannelLimits> = Object.freeze({
  maxPlaintextBytes: MAX_SECURE_PLAINTEXT_BYTES,
  rekeyAfterMessages: 1_048_576,
  rekeyAfterBytes: 1024 * 1024 * 1024,
  rekeyAfterMs: 30 * 60_000,
});

export interface SecureSessionOptions {
  /** Limits can only be tightened. Production peers use the fixed defaults. */
  limits?: Partial<SecureChannelLimits>;
  /** Must be a monotonic millisecond clock. */
  now?: () => number;
  /** The transport owner closes its physical socket here, or on any thrown error. */
  onFatalError?: (error: SecureChannelError) => void;
}

interface DirectionState {
  cipher: MonotonicCipher;
  epoch: number;
  sequence: bigint;
  messages: number;
  bytes: number;
  rotatedAt: number;
}

function chunkCount(length: number): number {
  return Math.max(1, Math.ceil(length / NOISE_RECORD_PLAINTEXT_BYTES));
}

function chunkAd(header: Uint8Array, index: number): Uint8Array {
  const ad = new Uint8Array(SECURE_FRAME_HEADER_BYTES + 2);
  ad.set(header);
  new DataView(ad.buffer).setUint16(SECURE_FRAME_HEADER_BYTES, index);
  return ad;
}

export function resolveLimits(input: Partial<SecureChannelLimits> = {}): SecureChannelLimits {
  const result = { ...DEFAULT_SECURE_CHANNEL_LIMITS, ...input };
  for (const key of Object.keys(result) as (keyof SecureChannelLimits)[]) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_SECURE_CHANNEL_LIMITS[key]) {
      throw new SecureChannelError("INVALID_ARGUMENT");
    }
  }
  return result;
}

/** One instance belongs to exactly one physical, ordered, binary connection. */
export class SecureSession {
  readonly remoteStaticKey: Uint8Array | undefined;
  readonly handshakeHash: Uint8Array;
  private readonly sending: DirectionState;
  private readonly receiving: DirectionState;
  private readonly limits: SecureChannelLimits;
  private readonly now: () => number;
  private readonly sendDirection: number;
  private closed = false;

  /** @internal Created only after a complete NK or IK handshake. */
  constructor(
    readonly pattern: NoisePattern,
    role: "initiator" | "responder",
    split: TransportState,
    remoteStaticKey: Uint8Array | undefined,
    handshakeHash: Uint8Array,
    private readonly options: SecureSessionOptions = {},
  ) {
    this.limits = resolveLimits(options.limits);
    this.now = options.now ?? (() => performance.now());
    this.remoteStaticKey = remoteStaticKey ? new Uint8Array(remoteStaticKey) : undefined;
    this.handshakeHash = new Uint8Array(handshakeHash);
    this.sendDirection = role === "initiator" ? 0 : 1;
    const make = (cipher: TransportState["send"]): DirectionState => ({
      cipher: new MonotonicCipher(cipher), epoch: 0, sequence: 0n, messages: 0, bytes: 0,
      rotatedAt: this.now(),
    });
    this.sending = make(split.send);
    this.receiving = make(split.recv);
  }

  get destroyed(): boolean { return this.closed; }

  get counters(): Readonly<{ sent: bigint; received: bigint; sendEpoch: number; receiveEpoch: number }> {
    return {
      sent: this.sending.sequence,
      received: this.receiving.sequence,
      sendEpoch: this.sending.epoch,
      receiveEpoch: this.receiving.epoch,
    };
  }

  private fail(code: SecureChannelErrorCode): never {
    const error = new SecureChannelError(code);
    this.destroy();
    try { this.options.onFatalError?.(error); } catch { /* Socket cleanup cannot revive the keys. */ }
    throw error;
  }

  private active(): void {
    if (this.closed) throw new SecureChannelError("CLOSED");
  }

  private exceeded(state: DirectionState, nextBytes: number): boolean {
    return state.messages >= this.limits.rekeyAfterMessages
      || state.bytes + nextBytes > this.limits.rekeyAfterBytes;
  }

  private rotate(state: DirectionState): void {
    if (state.epoch === 0xffff_ffff) this.fail("NONCE_EXHAUSTED");
    state.cipher.rekey();
    state.epoch += 1;
    state.messages = 0;
    state.bytes = 0;
    state.rotatedAt = this.now();
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    this.active();
    if (!(plaintext instanceof Uint8Array)) this.fail("INVALID_ARGUMENT");
    if (plaintext.byteLength > this.limits.maxPlaintextBytes
      || plaintext.byteLength > this.limits.rekeyAfterBytes) this.fail("FRAME_TOO_LARGE");
    const state = this.sending;
    if (state.sequence >= MAX_NOISE_NONCE) this.fail("NONCE_EXHAUSTED");
    try {
      // The authenticated epoch makes time-triggered rotation unambiguous even
      // when the two endpoint clocks disagree. Rotation never resets the nonce.
      if (this.exceeded(state, plaintext.byteLength)
        || this.now() - state.rotatedAt >= this.limits.rekeyAfterMs) this.rotate(state);
      const count = chunkCount(plaintext.byteLength);
      const frame = new Uint8Array(SECURE_FRAME_HEADER_BYTES + plaintext.byteLength + count * 16);
      const header = frame.subarray(0, SECURE_FRAME_HEADER_BYTES);
      const view = new DataView(frame.buffer);
      header.set([3, 1, this.sendDirection, 0]);
      view.setUint32(4, state.epoch);
      view.setBigUint64(8, state.sequence);
      view.setUint32(16, plaintext.byteLength);
      view.setUint16(20, count);
      let offset = SECURE_FRAME_HEADER_BYTES;
      for (let index = 0; index < count; index += 1) {
        const input = plaintext.subarray(index * NOISE_RECORD_PLAINTEXT_BYTES,
          (index + 1) * NOISE_RECORD_PLAINTEXT_BYTES);
        const encrypted = state.cipher.encrypt(input, chunkAd(header, index));
        frame.set(encrypted, offset);
        offset += encrypted.byteLength;
      }
      state.sequence += 1n;
      state.messages += 1;
      state.bytes += plaintext.byteLength;
      return frame;
    } catch (error) {
      return this.fail(error instanceof SecureChannelError ? error.code : "AUTHENTICATION_FAILED");
    }
  }

  decrypt(frame: Uint8Array): Uint8Array {
    this.active();
    if (!(frame instanceof Uint8Array)) this.fail("INVALID_FRAME");
    if (frame.byteLength > MAX_SECURE_FRAME_BYTES) this.fail("FRAME_TOO_LARGE");
    if (frame.byteLength < SECURE_FRAME_HEADER_BYTES + 16) this.fail("INVALID_FRAME");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (frame[0] !== 3 || frame[1] !== 1 || frame[2] !== (1 - this.sendDirection) || frame[3] !== 0) {
      this.fail("INVALID_FRAME");
    }
    const epoch = view.getUint32(4);
    const sequence = view.getBigUint64(8);
    const length = view.getUint32(16);
    const count = view.getUint16(20);
    const state = this.receiving;
    if (length > this.limits.maxPlaintextBytes || length > this.limits.rekeyAfterBytes) this.fail("FRAME_TOO_LARGE");
    if (count !== chunkCount(length)
      || frame.byteLength !== SECURE_FRAME_HEADER_BYTES + length + count * 16) this.fail("INVALID_FRAME");
    if (sequence !== state.sequence) this.fail("REPLAY_OR_OUT_OF_ORDER");
    if (sequence >= MAX_NOISE_NONCE) this.fail("NONCE_EXHAUSTED");
    if (epoch !== state.epoch && epoch !== state.epoch + 1) this.fail("INVALID_FRAME");
    if (epoch === state.epoch && this.exceeded(state, length)) this.fail("INVALID_FRAME");
    const plaintext = new Uint8Array(length);
    try {
      if (epoch !== state.epoch) this.rotate(state);
      const header = frame.subarray(0, SECURE_FRAME_HEADER_BYTES);
      let offset = SECURE_FRAME_HEADER_BYTES;
      let outputOffset = 0;
      for (let index = 0; index < count; index += 1) {
        const inputLength = Math.min(NOISE_RECORD_PLAINTEXT_BYTES, length - outputOffset);
        const chunk = state.cipher.decrypt(frame.subarray(offset, offset + inputLength + 16), chunkAd(header, index));
        plaintext.set(chunk, outputOffset);
        chunk.fill(0);
        outputOffset += inputLength;
        offset += inputLength + 16;
      }
      state.sequence += 1n;
      state.messages += 1;
      state.bytes += length;
      return plaintext;
    } catch (error) {
      // No prefix of a partially authenticated multi-record message escapes.
      plaintext.fill(0);
      return this.fail(error instanceof SecureChannelError ? error.code : "AUTHENTICATION_FAILED");
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.sending.cipher.destroy();
    this.receiving.cipher.destroy();
  }
}
