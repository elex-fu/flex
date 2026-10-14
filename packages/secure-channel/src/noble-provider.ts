import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import {
  INTERNALS,
  type AEAD,
  type Algorithms,
  type DHKeyPair,
  type Hash,
  type Nonce,
} from "salty-crypto";
import { SecureChannelError } from "./errors.js";

const EMPTY = new Uint8Array();

export function requireKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new SecureChannelError("INVALID_ARGUMENT");
  }
}

export function keyPairFromSecret(secret: Uint8Array): DHKeyPair {
  requireKey(secret);
  // Copy: destroying a handshake must never erase the caller's persisted key.
  // Uint8Array#slice copies, but Node Buffer#slice aliases the same memory.
  const copy = new Uint8Array(secret);
  return { secret: copy, public: x25519.getPublicKey(copy) };
}

function keyBytes(key: DataView): Uint8Array {
  if (key.byteLength !== 32) throw new SecureChannelError("INVALID_ARGUMENT");
  return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
}

function nonceBytes(nonce: Nonce): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  // Noise ChaChaPoly: four zero bytes followed by a little-endian uint64.
  view.setUint32(4, nonce.lo >>> 0, true);
  view.setUint32(8, nonce.hi >>> 0, true);
  return bytes;
}

const aead: AEAD = {
  NAME: "ChaChaPoly",
  KEYBYTES: 32,
  NONCEBYTES: 12,
  TAGBYTES: 16,
  encrypt(plaintext, key, nonce, ad = EMPTY) {
    return chacha20poly1305(keyBytes(key), nonceBytes(nonce), ad).encrypt(plaintext);
  },
  decrypt(ciphertext, key, nonce, ad = EMPTY) {
    return chacha20poly1305(keyBytes(key), nonceBytes(nonce), ad).decrypt(ciphertext);
  },
  encrypt_detached(plaintext, ciphertext, length, tag, key, nonce, ad = EMPTY) {
    const result = aead.encrypt(plaintext.subarray(0, length), key, nonce, ad);
    ciphertext.set(result.subarray(0, length));
    tag.set(result.subarray(length));
    result.fill(0);
  },
  decrypt_detached(plaintext, ciphertext, length, tag, key, nonce, ad = EMPTY) {
    const joined = new Uint8Array(length + 16);
    joined.set(ciphertext.subarray(0, length));
    joined.set(tag, length);
    try {
      const result = aead.decrypt(joined, key, nonce, ad);
      plaintext.set(result);
      result.fill(0);
      return true;
    } catch {
      return false;
    } finally {
      joined.fill(0);
    }
  },
};

class NobleBlake2s {
  static readonly NAME = "BLAKE2s";
  static readonly KEYBYTES = 32;
  static readonly OUTBYTES = 32;
  static readonly BLOCKLEN = 64;
  private readonly state;

  static digest(input: Uint8Array, key?: Uint8Array, outlen = 32): Uint8Array {
    return blake2s(input, { dkLen: outlen, ...(key ? { key } : {}) });
  }

  constructor(key?: Uint8Array, outlen = 32) {
    this.state = blake2s.create({ dkLen: outlen, ...(key ? { key } : {}) });
  }

  update(input: Uint8Array, offset = 0, length = input.byteLength - offset): void {
    this.state.update(input.subarray(offset, offset + length));
  }

  final(output?: Uint8Array): Uint8Array {
    const result = this.state.digest();
    this.state.destroy();
    if (output) {
      output.set(result);
      result.fill(0);
      return output;
    }
    return result;
  }
}

const hash: Hash = NobleBlake2s;

const noiseHmac = Object.assign(
  (key: Uint8Array, input: Uint8Array) => hmac(blake2s, key, input),
  { NAME: "HMAC-BLAKE2s" },
);

/**
 * The existing Noise engine owns all handshake tokens, transcript hashing, HKDF,
 * and Split. Its public Algorithms interface lets us use Noble's primitives.
 */
export const nobleNoiseAlgorithms: Algorithms = {
  dh: {
    NAME: "25519",
    DHLEN: 32,
    generateKeypair() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      return { secret, public: x25519.getPublicKey(secret) };
    },
    dh(pair, publicKey) {
      requireKey(pair.secret);
      requireKey(publicKey);
      // Noble rejects low-order/all-zero DH results instead of accepting them.
      return x25519.getSharedSecret(pair.secret, publicKey);
    },
  },
  aead,
  hash,
  hmac: noiseHmac,
  rekey(key) {
    // Upstream's default Noise REKEY is Encrypt(k, UINT64_MAX, empty, zeros32).
    // rc.4 returns ciphertext || tag (48 bytes). Noise uses only the FIRST 32.
    const result = INTERNALS.noise.rekey.makeRekey(aead)(key);
    const material = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    const nextKey = material.slice(0, 32);
    material.fill(0);
    return new DataView(nextKey.buffer);
  },
};
