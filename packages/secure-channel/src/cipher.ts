import { type CipherState } from "salty-crypto";
import { SecureChannelError } from "./errors.js";

export const MAX_NOISE_NONCE = (1n << 64n) - 1n;

export function wipeCipher(cipher: CipherState): void {
  if (cipher.view) {
    new Uint8Array(cipher.view.buffer, cipher.view.byteOffset, cipher.view.byteLength).fill(0);
    cipher.view = null;
  }
  cipher.nonce.reset();
}

/**
 * Nonce ownership is here, outside salty-crypto's signed 32-bit increment().
 * Resetting the representation before each operation does not reset the actual
 * counter: it increases monotonically for the entire connection, across rekeys.
 */
export class MonotonicCipher {
  private nextNonce: bigint;
  private closed = false;

  constructor(private readonly cipher: CipherState, initialNonce = 0n) {
    if (cipher.view?.byteLength !== 32 || initialNonce < 0n || initialNonce >= MAX_NOISE_NONCE) {
      throw new SecureChannelError("INVALID_ARGUMENT");
    }
    this.nextNonce = initialNonce;
  }

  private prepare(): void {
    if (this.closed) throw new SecureChannelError("CLOSED");
    if (this.nextNonce >= MAX_NOISE_NONCE) {
      this.destroy();
      throw new SecureChannelError("NONCE_EXHAUSTED");
    }
    this.cipher.nonce.reset(Number(this.nextNonce & 0xffff_ffffn), Number(this.nextNonce >> 32n));
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
    this.prepare();
    try {
      const result = this.cipher.encrypt(plaintext, ad);
      this.nextNonce += 1n;
      return result;
    } catch {
      this.destroy();
      throw new SecureChannelError("AUTHENTICATION_FAILED");
    }
  }

  decrypt(ciphertext: Uint8Array, ad: Uint8Array): Uint8Array {
    this.prepare();
    try {
      const result = this.cipher.decrypt(ciphertext, ad);
      this.nextNonce += 1n;
      return result;
    } catch {
      this.destroy();
      throw new SecureChannelError("AUTHENTICATION_FAILED");
    }
  }

  rekey(): void {
    this.prepare();
    const previous = this.cipher.view;
    try {
      this.cipher.rekey();
    } finally {
      if (previous) new Uint8Array(previous.buffer, previous.byteOffset, previous.byteLength).fill(0);
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    wipeCipher(this.cipher);
  }
}
