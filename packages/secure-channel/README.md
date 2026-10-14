# Flyx secure channel

`@flyx/secure-channel` implements the Relay's fixed Noise NK first-pairing channel and IK paired-device channel. The public APIs use `Uint8Array` in both browsers and Node 20.19+. X25519 keys are raw 32-byte values; descriptor signing uses the **separate Ed25519 key** owned by the identity package.

```ts
const initiator = await createNoiseInitiator({
  pattern: "IK",
  binding: { hostId, routeId, connectionId, protocol: { min: 2, max: 2 } },
  remoteStaticKey: pinnedHostPublicKey,
  staticKey: deviceSecretKey,
  onFatalError: () => socket.close(1008, "SECURE_CHANNEL_FAILED"),
});
socket.send(initiator.writeMessage());
// Receive exactly one binary handshake reply before parsing application data.
initiator.readMessage(reply);
const session = initiator.finish();
socket.send(session.encrypt(applicationBytes));
const incoming = session.decrypt(ciphertextBytes);
```

The responder uses `inspectNoiseHandshakePattern(firstFrame)`, then `createNoiseResponder({pattern, binding, staticKey})`, `readMessage`, `writeMessage`, and `finish`. Both handshake flights carry a pattern byte: 1 for NK, 2 for IK. Noise's authenticated transcript also binds the suite; changing this byte cannot downgrade a successful handshake. The public handshake API allows **no application payloads**. NK authenticates the Host only. IK proves possession of the returned `remoteStaticKey`; the Host must independently resolve it to a live device and check scopes. Neither handshake authorizes an RPC by itself.

The prologue is the protocol package's unambiguous UTF-8 JSON array `["flyx-relay-v1", hostId, routeId, connectionId, protocol.min, protocol.max]`. Reconnecting always creates fresh ephemeral keys and new directional ciphers. Static keys are copied without Node `Buffer.slice()` aliasing. Destroying a handshake or session performs best-effort secret zeroization; JavaScript garbage collection and internal dependency temporaries preclude guaranteed memory erasure.

New Relay routes use canonical unpadded base64url encodings of exactly 24 random bytes. The prologue parser temporarily accepts the prior v1 variable-length locator so existing routes can reconnect; the exact locator is still transcript-bound, and this package never treats route entropy as client authorization.

## Implementation and assurance

The handshake token processing, transcript, HKDF and Split come from the existing [salty-crypto](https://git.leastfixedpoint.com/tonyg/typescript-salty-crypto) `Handshake` implementation, pinned to `1.0.0-rc.4` (MIT). Its public algorithm-provider interface is bound to pinned `@noble/curves`, `@noble/ciphers`, and `@noble/hashes` `2.4.0` (MIT). Flyx does not implement a new ECDH handshake or use Paseo AGPL code.

Noble publishes [curve audit details](https://github.com/paulmillr/noble-curves#security), [cipher audit details](https://github.com/paulmillr/noble-ciphers#security), and [hash audit details](https://github.com/paulmillr/noble-hashes#security). Those reviews cover particular upstream versions, **not this integration or every subsequent release**. There is no claim that the salty-crypto Noise engine or Flyx framing has received a formal independent audit. Its source was inspected and the complete NK/IK Cacophony handshake and transport ciphertext vectors are checked against fixed data from [Snow](https://github.com/mcginty/snow/blob/main/tests/vectors/cacophony.txt), Git blob `b8a271ed1aba8b4a56bf429e559d7947827123b4`. Independent Node/OpenSSL checks cover rekey material and nonce boundaries.

Two observed rc.4 edge cases are handled at the adapter boundary and regression-tested:

- The library's nonce increment uses signed 32-bit comparisons. `MonotonicCipher` owns a bigint counter and sets its exact low/high representation before each operation, including at 2³¹ and 2³². No nonce is reused or reset on rekey, and the reserved 2⁶⁴−1 nonce is never used for application records.
- Its default rekey helper returns the 32-byte ciphertext plus its 16-byte tag. The provider uses the existing helper and retains exactly the first 32 bytes prescribed by Noise; it zeroes discarded bytes and old key material.

`noise-c.wasm@0.4.0` was evaluated and rejected: although its README lists `Rekey`, the implementation throws `Not implemented`, its binary does not export a rekey operation, and its archived UMD loader predates current browser packaging. No such dependency or binary is included.

## Binary frames and rotation

An encrypted application frame has this big-endian, authenticated header:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 1 | 3: encrypted application frame |
| 1 | 1 | Wire version 1 |
| 2 | 1 | Direction: 0 initiator→responder, 1 responder→initiator |
| 3 | 1 | Reserved, must be zero |
| 4 | 4 | Directional key epoch |
| 8 | 8 | Directional application frame sequence |
| 16 | 4 | Total plaintext length |
| 20 | 2 | Number of Noise records |

Payloads are limited to 256 KiB. Noise allows at most 65,535 ciphertext bytes per record, so frames are split into at most five records of 65,519 plaintext bytes, each with a 16-byte Poly1305 tag. Every record authenticates the complete header and its record index. An empty application frame contains one authenticated empty record. The maximum binary frame is 262,246 bytes; the Relay protocol allocates 263,168 bytes. No plaintext prefix is returned before **all** records have authenticated.

Each direction rekeys before exceeding 1,048,576 application messages, 1 GiB of plaintext, or 30 minutes. Rekey uses the Noise REKEY function and preserves its monotonic nonce. A sender-driven authenticated epoch permits time-based rotation without synchronized clocks; only the same epoch or the next epoch is accepted, never arbitrary jumps. The first message after an idle period rotates before encryption. Message and byte ceilings are also enforced by the receiver. Lower configurable limits exist for tests and constrained deployments; peers must use compatible limits.

Replay, reordering, wrong direction, malformed lengths, key epoch changes that fail authentication, or any cryptographic error destroy **both** directional keys. `onFatalError` must close the physical socket, or the transport must catch the error and close it. `destroy()` is idempotent. Handshake timeout, WebSocket binary-only framing, compression disabling, and send-backpressure limits belong to the physical Relay transport; no RPC is parsed until the handshake completes.

## Browser device keys

The engine's DH interface is synchronous and consumes raw X25519 bytes, so `NOISE_DEVICE_KEY_CAPABILITIES.nonExtractableX25519` is `false`. It cannot use a WebCrypto non-extractable X25519 key directly. `MemoryNoiseKeyStore` never persists private keys. The PWA fallback uses an in-memory device key and the Host's bounded, rotated refresh credential, with the reduced protection shown in the UI. After reload it obtains a new in-memory key through authenticated refresh. Credential lifetime, revocation, and one-time refresh rotation are enforced by Host access management, not by this package.

`NoiseStaticKeyStore` exposes an explicit protection level for platform implementations. A non-extractable AES key wrapping raw X25519 bytes would be **wrapped at rest**, not a non-extractable X25519 key: active JavaScript could still unwrap it. No plaintext persistent-key fallback is supplied. Future native/async-DH engines can implement genuine hardware-backed key operations behind a different provider.

## Validation

From this package directory (all workspace dependencies installed):

```sh
../../node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/vitest run
node scripts/browser-smoke.mjs
```

The browser smoke uses the Web app's Playwright installation, bundles the production ESM entry for a browser, and runs real Chromium against an ephemeral loopback test server with CSP allowing no `unsafe-eval` and no external connections. Both NK and IK exchange data between Chromium and Node, including a 256 KiB frame, automatic rekeys, and tamper-close checks, without `Buffer`, `process`, or `require` browser globals.
