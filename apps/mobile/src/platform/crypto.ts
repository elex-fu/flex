import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer";

export interface NativeRandom { fill(bytes: Uint8Array): Uint8Array }
interface Algorithm {
  name: string; iv?: BufferSource; additionalData?: BufferSource; tagLength?: number;
  public?: CryptoKey; salt?: BufferSource; info?: BufferSource; hash?: AlgorithmIdentifier; length?: number;
}
function algorithm(value: string | Algorithm): Algorithm { return typeof value === "string" ? { name: value } : value; }
function bytes(value: BufferSource): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
function output(value: Uint8Array): ArrayBuffer { return new Uint8Array(value).buffer; }
function unsupported(): never { throw new Error("NATIVE_CRYPTO_UNSUPPORTED"); }
/** Actual Noble primitives; RNG comes only from Expo's native CSPRNG, never Math.random.
 * Raw Noise secrets remain in JS memory; this is not a nonextractable Keychain DH key. */
export function createNativeCrypto(random: NativeRandom): Crypto {
  const material = new WeakMap<CryptoKey, Uint8Array>();
  const makeKey = (name: string, type: KeyType, raw: Uint8Array, extractable: boolean, usages: KeyUsage[]): CryptoKey => {
    const key: CryptoKey = Object.freeze({ type, algorithm: Object.freeze({ name }), extractable, usages: Object.freeze([...usages]) as unknown as KeyUsage[] });
    material.set(key, new Uint8Array(raw)); return key;
  };
  const rawKey = (key: CryptoKey, name: string, usage?: KeyUsage): Uint8Array => {
    const value = material.get(key);
    if (!value || key.algorithm.name.toUpperCase() !== name.toUpperCase() || usage && !key.usages.includes(usage)) unsupported();
    return value;
  };
  const derive = (input: Algorithm, key: CryptoKey, length: number | null, usage: KeyUsage = "deriveBits"): Uint8Array => {
    if (input.name === "X25519") {
      if (!input.public || key.type !== "private" || input.public.type !== "public" || length !== null && length !== 256) unsupported();
      return x25519.getSharedSecret(rawKey(key, "X25519", usage), rawKey(input.public, "X25519"));
    }
    if (input.name === "HKDF") {
      if (!input.salt || !input.info || !input.hash || algorithm(input.hash).name !== "SHA-256" || length === null || length % 8 || length <= 0 || length > 255 * 32 * 8) unsupported();
      return hkdf(sha256, rawKey(key, "HKDF", usage), bytes(input.salt), bytes(input.info), length / 8);
    }
    return unsupported();
  };
  const subtle = {
    async digest(input: string | Algorithm, value: BufferSource): Promise<ArrayBuffer> { if (algorithm(input).name !== "SHA-256") unsupported(); return output(sha256(bytes(value))); },
    async importKey(format: KeyFormat, value: BufferSource, input: string | Algorithm, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey> {
      const name = algorithm(input).name; const raw = bytes(value);
      if (format !== "raw" || !["X25519", "Ed25519", "AES-GCM", "HKDF"].includes(name)) unsupported();
      if (name !== "HKDF" && raw.byteLength !== 32) unsupported();
      if (name === "HKDF" && extractable) unsupported();
      return makeKey(name, name === "X25519" || name === "Ed25519" ? "public" : "secret", raw, extractable, usages);
    },
    async exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer> { if (format !== "raw" || !key.extractable) unsupported(); return output(rawKey(key, key.algorithm.name)); },
    async generateKey(input: string | Algorithm, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey | CryptoKeyPair> {
      const name = algorithm(input).name;
      if (name === "AES-GCM" && algorithm(input).length === 256) return makeKey(name, "secret", random.fill(new Uint8Array(32)), extractable, usages);
      if (name !== "X25519" && name !== "Ed25519") unsupported();
      const secret = random.fill(new Uint8Array(32));
      const publicKey = name === "X25519" ? x25519.getPublicKey(secret) : ed25519.getPublicKey(secret);
      const pair = { privateKey: makeKey(name, "private", secret, extractable, usages), publicKey: makeKey(name, "public", publicKey, true, name === "Ed25519" ? ["verify"] : []) };
      secret.fill(0); return pair;
    },
    async sign(input: string | Algorithm, key: CryptoKey, value: BufferSource): Promise<ArrayBuffer> { if (algorithm(input).name !== "Ed25519" || key.type !== "private") unsupported(); return output(ed25519.sign(bytes(value), rawKey(key, "Ed25519", "sign"))); },
    async verify(input: string | Algorithm, key: CryptoKey, signature: BufferSource, value: BufferSource): Promise<boolean> {
      if (algorithm(input).name !== "Ed25519" || key.type !== "public") unsupported();
      try { return ed25519.verify(bytes(signature), bytes(value), rawKey(key, "Ed25519", "verify"), { zip215: false }); } catch { return false; }
    },
    async deriveBits(input: Algorithm, key: CryptoKey, length: number | null): Promise<ArrayBuffer> { return output(derive(input, key, length)); },
    async deriveKey(input: Algorithm, key: CryptoKey, target: Algorithm, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey> {
      if (target.name !== "AES-GCM" || target.length !== 256 || !key.usages.includes("deriveKey")) unsupported();
      // Derive material with the requested usage; unsupported algorithms fail closed.
      return makeKey("AES-GCM", "secret", derive(input, key, 256, "deriveKey"), extractable, usages);
    },
    async encrypt(input: Algorithm, key: CryptoKey, value: BufferSource): Promise<ArrayBuffer> {
      if (input.name !== "AES-GCM" || !input.iv || bytes(input.iv).length !== 12 || input.tagLength !== undefined && input.tagLength !== 128) unsupported();
      return output(gcm(rawKey(key, "AES-GCM", "encrypt"), bytes(input.iv), input.additionalData ? bytes(input.additionalData) : undefined).encrypt(bytes(value)));
    },
    async decrypt(input: Algorithm, key: CryptoKey, value: BufferSource): Promise<ArrayBuffer> {
      if (input.name !== "AES-GCM" || !input.iv || bytes(input.iv).length !== 12 || input.tagLength !== undefined && input.tagLength !== 128) unsupported();
      return output(gcm(rawKey(key, "AES-GCM", "decrypt"), bytes(input.iv), input.additionalData ? bytes(input.additionalData) : undefined).decrypt(bytes(value)));
    },
  };
  return {
    subtle: subtle as unknown as SubtleCrypto,
    getRandomValues<T extends ArrayBufferView | null>(view: T): T {
      if (!view || !ArrayBuffer.isView(view) || view instanceof Float32Array || view instanceof Float64Array || view instanceof DataView || view.byteLength > 65_536) unsupported();
      random.fill(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)); return view;
    },
    randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
      const value = random.fill(new Uint8Array(16)); value[6] = value[6]! & 15 | 64; value[8] = value[8]! & 63 | 128;
      const h = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
}
/** Core DTO clone support on Hermes. Unsupported objects fail rather than silently
 * losing fields through JSON serialization. Transfer lists are not supported. */
export function cloneNativeValue<T>(value: T, options?: StructuredSerializeOptions): T {
  if (options?.transfer?.length) unsupported();
  const seen = new Map<object, unknown>();
  const clone = (input: unknown): unknown => {
    if (typeof input === "function" || typeof input === "symbol") unsupported();
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (input instanceof ArrayBuffer) { const result = input.slice(0); seen.set(input, result); return result; }
    if (ArrayBuffer.isView(input)) {
      const buffer = clone(input.buffer) as ArrayBuffer;
      const result = input instanceof DataView ? new DataView(buffer, input.byteOffset, input.byteLength)
        : new (input.constructor as { new(buffer: ArrayBuffer, offset: number, length: number): ArrayBufferView })(buffer, input.byteOffset, input.byteLength / (input as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT);
      seen.set(input, result); return result;
    }
    if (input instanceof Date) { const result = new Date(input); seen.set(input, result); return result; }
    if (input instanceof Map) { const result = new Map(); seen.set(input, result); for (const [key, item] of input) result.set(clone(key), clone(item)); return result; }
    if (input instanceof Set) { const result = new Set(); seen.set(input, result); for (const item of input) result.add(clone(item)); return result; }
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) unsupported();
    const result: Record<string, unknown> | unknown[] = Array.isArray(input) ? new Array(input.length) : {};
    seen.set(input, result);
    for (const key of Object.keys(input)) Object.defineProperty(result, key, { value: clone((input as Record<string, unknown>)[key]), writable: true, enumerable: true, configurable: true });
    return result;
  };
  return clone(value) as T;
}
export function installNativeGlobals(random: NativeRandom, target: typeof globalThis = globalThis): void {
  class Encoder { readonly encoding = "utf-8"; encode(input = ""): Uint8Array { return new Uint8Array(Buffer.from(input, "utf8")); } }
  class Decoder {
    readonly encoding = "utf-8"; readonly fatal: boolean; readonly ignoreBOM: boolean;
    constructor(label = "utf-8", options: TextDecoderOptions = {}) { if (!["utf-8", "utf8"].includes(label.toLowerCase())) unsupported(); this.fatal = options.fatal ?? false; this.ignoreBOM = options.ignoreBOM ?? false; }
    decode(input?: BufferSource, options: TextDecodeOptions = {}): string {
      if (options.stream) unsupported(); const value = input ? bytes(input) : new Uint8Array();
      const text = Buffer.from(value).toString("utf8"); const encoded = Buffer.from(text, "utf8");
      if (this.fatal && (encoded.length !== value.length || value.some((byte, index) => byte !== encoded[index]))) throw new Error("INVALID_UTF8");
      return !this.ignoreBOM && text.startsWith("\ufeff") ? text.slice(1) : text;
    }
  }
  if (typeof target.TextEncoder !== "function") Object.defineProperty(target, "TextEncoder", { value: Encoder, configurable: true });
  if (typeof target.TextDecoder !== "function") Object.defineProperty(target, "TextDecoder", { value: Decoder, configurable: true });
  if (typeof target.atob !== "function") Object.defineProperty(target, "atob", { value: (text: string) => Buffer.from(text, "base64").toString("binary"), configurable: true });
  if (typeof target.btoa !== "function") Object.defineProperty(target, "btoa", { value: (text: string) => Buffer.from(text, "binary").toString("base64"), configurable: true });
  if (typeof target.structuredClone !== "function") Object.defineProperty(target, "structuredClone", { value: cloneNativeValue, configurable: true });
  Object.defineProperty(target, "crypto", { value: createNativeCrypto(random), configurable: true });
}
