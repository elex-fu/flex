import { createCipheriv } from "node:crypto";
import { CipherState } from "salty-crypto";
import { describe, expect, it } from "vitest";
import { MonotonicCipher, MAX_NOISE_NONCE } from "./cipher.js";
import { nobleNoiseAlgorithms } from "./noble-provider.js";

const ad = new Uint8Array([7, 8, 9]);
const plaintext = new TextEncoder().encode("independently checked OpenSSL ciphertext");
const key = new Uint8Array(32).fill(123);

function opensslEncrypt(keyBytes: Uint8Array, counter: bigint, message: Uint8Array, associatedData: Uint8Array): Uint8Array {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(counter, 4);
  const cipher = createCipheriv("chacha20-poly1305", keyBytes, nonce, { authTagLength: 16 });
  cipher.setAAD(associatedData, { plaintextLength: message.byteLength });
  return Uint8Array.from(Buffer.concat([cipher.update(message), cipher.final(), cipher.getAuthTag()]));
}

describe("transport nonce and rekey primitives", () => {
  it.each([0n, 0x7fff_fffen, 0xffff_fffen, MAX_NOISE_NONCE - 3n])(
    "uses consecutive uint64 Noise nonces starting at %s", (initial) => {
      const cipher = new MonotonicCipher(new CipherState(nobleNoiseAlgorithms, key.slice()), initial);
      const receiver = new MonotonicCipher(new CipherState(nobleNoiseAlgorithms, key.slice()), initial);
      for (let index = 0n; index < 3n; index += 1n) {
        const encrypted = cipher.encrypt(plaintext, ad);
        expect(encrypted).toEqual(opensslEncrypt(key, initial + index, plaintext, ad));
        expect(receiver.decrypt(encrypted, ad)).toEqual(plaintext);
      }
      cipher.destroy();
      receiver.destroy();
    },
  );

  it("derives the Noise rekey material at UINT64_MAX and keeps the next nonce", () => {
    const raw = new CipherState(nobleNoiseAlgorithms, key.slice());
    const previous = raw.view!;
    const cipher = new MonotonicCipher(raw);
    cipher.encrypt(plaintext, ad);
    cipher.rekey();
    const nextKey = opensslEncrypt(key, MAX_NOISE_NONCE, new Uint8Array(32), new Uint8Array()).slice(0, 32);
    expect(cipher.encrypt(plaintext, ad)).toEqual(opensslEncrypt(nextKey, 1n, plaintext, ad));
    expect(new Uint8Array(previous.buffer).every((value) => value === 0)).toBe(true);
    cipher.destroy();
    expect(raw.view).toBeNull();
  });

  it("fails closed before the reserved nonce can be used for an application record", () => {
    const cipher = new MonotonicCipher(new CipherState(nobleNoiseAlgorithms, key.slice()), MAX_NOISE_NONCE - 1n);
    cipher.encrypt(plaintext, ad);
    expect(() => cipher.encrypt(plaintext, ad)).toThrow("NONCE_EXHAUSTED");
    expect(() => cipher.encrypt(plaintext, ad)).toThrow("CLOSED");
  });
});
