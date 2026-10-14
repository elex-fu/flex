/** Salty's unused Node fallback also resolves to the installed native CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("NATIVE_CRYPTO_UNAVAILABLE");
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
