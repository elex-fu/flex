import { buildNoisePrologue } from "@flyx/mvp-protocol";
import { Handshake, type TransportState } from "salty-crypto";
import { wipeCipher } from "./cipher.js";
import { SecureChannelError } from "./errors.js";
import { keyPairFromSecret, nobleNoiseAlgorithms, requireKey } from "./noble-provider.js";
import { resolveLimits, SecureSession, type NoisePattern, type SecureSessionOptions } from "./session.js";

export interface NoiseBinding {
  hostId: string;
  routeId: string;
  connectionId: string;
  protocol: { min: number; max: number };
}

export interface NoiseInitiatorOptions extends SecureSessionOptions {
  pattern: NoisePattern;
  binding: NoiseBinding;
  remoteStaticKey: Uint8Array;
  /** Required for IK, absent for the unauthenticated NK pairing channel. */
  staticKey?: Uint8Array;
}

export interface NoiseResponderOptions extends SecureSessionOptions {
  pattern: NoisePattern;
  binding: NoiseBinding;
  staticKey: Uint8Array;
}

export const NOISE_SUITES = Object.freeze({
  NK: "Noise_NK_25519_ChaChaPoly_BLAKE2s",
  IK: "Noise_IK_25519_ChaChaPoly_BLAKE2s",
});

export function inspectNoiseHandshakePattern(frame: Uint8Array): NoisePattern {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 2) throw new SecureChannelError("INVALID_FRAME");
  if (frame[0] === 1) return "NK";
  if (frame[0] === 2) return "IK";
  throw new SecureChannelError("INVALID_FRAME");
}

function wipeHandshake(handshake: Handshake): void {
  handshake.staticKeypair.secret.fill(0);
  handshake.ephemeralKeypair.secret.fill(0);
  handshake.chainingKey.fill(0);
  wipeCipher(handshake.cipherState);
}

function sessionOptions(options: SecureSessionOptions): SecureSessionOptions {
  // Do not accidentally retain the factories' staticKey in a long-lived session.
  return {
    limits: resolveLimits(options.limits),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onFatalError ? { onFatalError: options.onFatalError } : {}),
  };
}

export class NoiseHandshake {
  private step = 0;
  private closed = false;
  private split: TransportState | undefined;
  private consumed = false;

  /** @internal Use the fixed-suite factories, which validate key requirements. */
  constructor(
    readonly pattern: NoisePattern,
    private readonly role: "initiator" | "responder",
    private readonly engine: Handshake,
    private readonly options: SecureSessionOptions,
  ) {}

  get complete(): boolean { return !this.closed && this.step === 2; }

  private fail(code: "HANDSHAKE_FAILED" | "HANDSHAKE_STATE"): never {
    this.destroy();
    const error = new SecureChannelError(code);
    try { this.options.onFatalError?.(error); } catch { /* Cleanup is best effort. */ }
    throw error;
  }

  private check(writing: boolean): void {
    if (this.closed || this.consumed || this.step >= 2) this.fail("HANDSHAKE_STATE");
    const writerIsInitiator = this.step === 0;
    if (writing !== (writerIsInitiator === (this.role === "initiator"))) this.fail("HANDSHAKE_STATE");
  }

  writeMessage(): Uint8Array {
    this.check(true);
    try {
      const { packet, finished } = this.engine.writeMessage(new Uint8Array());
      const frame = new Uint8Array(packet.byteLength + 1);
      frame[0] = this.pattern === "NK" ? 1 : 2;
      frame.set(packet, 1);
      this.step += 1;
      this.split = finished ?? undefined;
      return frame;
    } catch { return this.fail("HANDSHAKE_FAILED"); }
  }

  readMessage(frame: Uint8Array): void {
    this.check(false);
    // Validate framing outside the engine catch. Calling fail() inside that
    // catch would report one malformed flight to onFatalError twice.
    const expectedLength = this.pattern === "IK" && this.step === 0 ? 97 : 49;
    const expectedPattern = this.pattern === "NK" ? 1 : 2;
    if (!(frame instanceof Uint8Array) || frame.byteLength !== expectedLength
      || frame[0] !== expectedPattern) this.fail("HANDSHAKE_FAILED");
    try {
      // NK: 32 ephemeral + 16 tag. IK first flight adds encrypted static32+tag16.
      const { message, finished } = this.engine.readMessage(frame.subarray(1));
      if (message.byteLength !== 0) throw new Error("Handshake payloads are forbidden");
      this.step += 1;
      this.split = finished ?? undefined;
    } catch { this.fail("HANDSHAKE_FAILED"); }
  }

  finish(): SecureSession {
    if (!this.complete || !this.split || this.consumed) return this.fail("HANDSHAKE_STATE");
    const split = this.split;
    try {
      const session = new SecureSession(this.pattern, this.role, split,
        this.engine.remoteStaticPublicKey ?? undefined, this.engine.handshakeHash, this.options);
      this.consumed = true;
      this.split = undefined;
      wipeHandshake(this.engine);
      return session;
    } catch { return this.fail("HANDSHAKE_FAILED"); }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    wipeHandshake(this.engine);
    if (this.split) {
      wipeCipher(this.split.send);
      wipeCipher(this.split.recv);
      this.split = undefined;
    }
  }
}

export async function createNoiseInitiator(options: NoiseInitiatorOptions): Promise<NoiseHandshake> {
  if (options.pattern !== "NK" && options.pattern !== "IK") throw new SecureChannelError("INVALID_ARGUMENT");
  requireKey(options.remoteStaticKey);
  if (options.pattern === "IK" && !options.staticKey) throw new SecureChannelError("INVALID_ARGUMENT");
  if (options.pattern === "NK" && options.staticKey) throw new SecureChannelError("INVALID_ARGUMENT");
  resolveLimits(options.limits);
  try {
    const engine = new Handshake(nobleNoiseAlgorithms, options.pattern, "initiator", {
      prologue: buildNoisePrologue(options.binding),
      remoteStaticPublicKey: new Uint8Array(options.remoteStaticKey),
      ...(options.staticKey ? { staticKeypair: keyPairFromSecret(options.staticKey) } : {}),
    });
    return new NoiseHandshake(options.pattern, "initiator", engine, sessionOptions(options));
  } catch { throw new SecureChannelError("HANDSHAKE_FAILED"); }
}

export async function createNoiseResponder(options: NoiseResponderOptions): Promise<NoiseHandshake> {
  if (options.pattern !== "NK" && options.pattern !== "IK") throw new SecureChannelError("INVALID_ARGUMENT");
  requireKey(options.staticKey);
  resolveLimits(options.limits);
  try {
    const engine = new Handshake(nobleNoiseAlgorithms, options.pattern, "responder", {
      prologue: buildNoisePrologue(options.binding),
      staticKeypair: keyPairFromSecret(options.staticKey),
    });
    return new NoiseHandshake(options.pattern, "responder", engine, sessionOptions(options));
  } catch { throw new SecureChannelError("HANDSHAKE_FAILED"); }
}
