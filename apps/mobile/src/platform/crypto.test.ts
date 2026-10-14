import { randomFillSync, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloneNativeValue, createNativeCrypto, installNativeGlobals } from "./crypto";
const native = createNativeCrypto({ fill: (value) => randomFillSync(value) });
const bytes = (buffer: ArrayBuffer) => new Uint8Array(buffer);
const source = new TextEncoder().encode("authenticated native text: 中文 🧪");
describe("native actual crypto adapter", () => {
  it("interoperates X25519 and SHA256 with the desktop WebCrypto reference", async () => {
    const a = await native.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const b = await webcrypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as unknown as webcrypto.CryptoKeyPair;
    const bRaw = await webcrypto.subtle.exportKey("raw", b.publicKey);
    const aRaw = await native.subtle.exportKey("raw", a.publicKey);
    const nativePublic = await native.subtle.importKey("raw", bRaw, { name: "X25519" }, true, []);
    const desktopPublic = await webcrypto.subtle.importKey("raw", aRaw, { name: "X25519" }, true, []);
    expect(bytes(await native.subtle.deriveBits({ name: "X25519", public: nativePublic }, a.privateKey, 256))).toEqual(new Uint8Array(await webcrypto.subtle.deriveBits({ name: "X25519", public: desktopPublic }, b.privateKey, 256)));
    expect(bytes(await native.subtle.digest("SHA-256", source))).toEqual(new Uint8Array(await webcrypto.subtle.digest("SHA-256", source)));
  });
  it("matches RFC5869 HKDF and interoperates authenticated AES256-GCM including tamper rejection", async () => {
    const ikm = new Uint8Array(22).fill(11), salt = Uint8Array.from({ length: 13 }, (_, i) => i), info = Uint8Array.from({ length: 10 }, (_, i) => 240 + i);
    const seed = await native.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits", "deriveKey"]);
    const keyMaterial = bytes(await native.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, seed, 336));
    expect(Buffer.from(keyMaterial).toString("hex")).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    const raw = keyMaterial.slice(0, 32), iv = new Uint8Array(12).fill(7), ad = new Uint8Array([1, 2, 3]);
    const key = await native.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const desktop = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const cipher = await native.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, key, source);
    expect(new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, desktop, cipher))).toEqual(source);
    const reverse = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, desktop, source);
    expect(bytes(await native.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, key, reverse))).toEqual(source);
    const damaged = bytes(cipher); damaged[0] = damaged[0]! ^ 1;
    await expect(native.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ad }, key, damaged)).rejects.toThrow();
    await expect(native.subtle.exportKey("raw", key)).rejects.toThrow("UNSUPPORTED");
  });
  it("verifies Ed25519 pins and rejects unsupported algorithms or absent randomness", async () => {
    const pair = await native.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const signature = await native.subtle.sign("Ed25519", pair.privateKey, source);
    const raw = await native.subtle.exportKey("raw", pair.publicKey);
    const desktop = await webcrypto.subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
    expect(await webcrypto.subtle.verify("Ed25519", desktop, signature, source)).toBe(true);
    expect(await native.subtle.verify("Ed25519", pair.publicKey, signature, source)).toBe(true);
    await expect(native.subtle.digest("SHA-1", source)).rejects.toThrow("UNSUPPORTED");
    const unavailable = createNativeCrypto({ fill: () => { throw new Error("native RNG unavailable"); } });
    expect(() => unavailable.randomUUID()).toThrow("unavailable");
  });
  it("clones replica DTO fields, cycles and bytes without JSON loss", () => {
    const source: { missing: undefined; bytes: Uint8Array; self?: unknown } = { missing: undefined, bytes: new Uint8Array([1, 2]) }; source.self = source;
    const result = cloneNativeValue(source); expect(result).not.toBe(source); expect(result.self).toBe(result); expect(Object.hasOwn(result, "missing")).toBe(true); expect(result.bytes).toEqual(source.bytes); expect(result.bytes.buffer).not.toBe(source.bytes.buffer);
    expect(() => cloneNativeValue({ callback: () => {} })).toThrow("UNSUPPORTED");
  });
  it("uses strict UTF8 in the Hermes encoding bridge", () => {
    const target = { crypto: undefined, TextEncoder: undefined, TextDecoder: undefined } as unknown as typeof globalThis;
    installNativeGlobals({ fill: (value) => randomFillSync(value) }, target);
    expect(new target.TextDecoder("utf-8", { fatal: true }).decode(new target.TextEncoder().encode("中文 🧪"))).toBe("中文 🧪");
    expect(() => new target.TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([192, 128]))).toThrow("INVALID_UTF8");
  });
});
