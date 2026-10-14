import { SecureChannelError } from "./errors.js";
import { keyPairFromSecret, nobleNoiseAlgorithms, requireKey } from "./noble-provider.js";

export interface NoiseKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateNoiseKeyPair(): Promise<NoiseKeyPair> {
  const pair = nobleNoiseAlgorithms.dh.generateKeypair();
  return { publicKey: pair.public, secretKey: pair.secret };
}

export function noiseKeyPairFromSecretKey(secretKey: Uint8Array): NoiseKeyPair {
  const pair = keyPairFromSecret(secretKey);
  return { publicKey: pair.public, secretKey: pair.secret };
}

/** This engine cannot perform a DH operation using a non-extractable CryptoKey. */
export const NOISE_DEVICE_KEY_CAPABILITIES = Object.freeze({
  nonExtractableX25519: false,
  requiresRawStaticSecret: true,
  recommendedBrowserProtection: "memory-only" as const,
});

export interface NoiseStaticKeyStore {
  /** wrapped-at-rest is NOT equivalent to a non-extractable X25519 private key. */
  readonly protection: "memory-only" | "wrapped-at-rest";
  load(id: string): Promise<NoiseKeyPair | null>;
  save(id: string, pair: NoiseKeyPair): Promise<void>;
  delete(id: string): Promise<void>;
}

function copyPair(pair: NoiseKeyPair): NoiseKeyPair {
  requireKey(pair.secretKey);
  requireKey(pair.publicKey);
  const expected = noiseKeyPairFromSecretKey(pair.secretKey);
  if (!expected.publicKey.every((value, index) => value === pair.publicKey[index])) {
    expected.secretKey.fill(0);
    throw new SecureChannelError("INVALID_ARGUMENT");
  }
  return expected;
}

/**
 * PWA fallback: refresh credentials are separately short-lived and rotated by
 * Host access.refresh; X25519 secrets never enter localStorage or IndexedDB.
 */
export class MemoryNoiseKeyStore implements NoiseStaticKeyStore {
  readonly protection = "memory-only" as const;
  private readonly keys = new Map<string, NoiseKeyPair>();

  async load(id: string): Promise<NoiseKeyPair | null> {
    const pair = this.keys.get(id);
    return pair ? { publicKey: pair.publicKey.slice(), secretKey: pair.secretKey.slice() } : null;
  }

  async save(id: string, pair: NoiseKeyPair): Promise<void> {
    if (!id || id.length > 256) throw new SecureChannelError("INVALID_ARGUMENT");
    const copy = copyPair(pair);
    this.keys.get(id)?.secretKey.fill(0);
    this.keys.set(id, copy);
  }

  async delete(id: string): Promise<void> {
    this.keys.get(id)?.secretKey.fill(0);
    this.keys.delete(id);
  }

  destroy(): void {
    for (const pair of this.keys.values()) pair.secretKey.fill(0);
    this.keys.clear();
  }
}
