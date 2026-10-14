# Flyx Expo mobile slice

This M3 app is a minimal native client for the shared Host runtime, canonical Session replica, and durable command Outbox. It provides pinned pairing by paste/QR/deep link, saved Host selection, session selection, timeline/reference reading, a durable task draft, fresh typed Interaction responses, receipt review, and attention navigation. React subscribes to an app-owned runtime; screen cleanup never closes the connection.

## Local commands

Use Node 24 and the repository's pnpm version. Dependencies come from this workspace, not symlinks to another checkout.

```sh
rtk proxy pnpm install --frozen-lockfile --ignore-scripts
rtk proxy pnpm --filter @flyx/mvp-protocol build
rtk proxy pnpm --filter @flyx/secure-channel build
rtk proxy pnpm --filter @flyx/client-core build
rtk proxy pnpm --filter @flyx/mobile typecheck
rtk proxy pnpm --filter @flyx/mobile typecheck:tests
rtk proxy pnpm --filter @flyx/mobile test
rtk proxy env EXPO_OFFLINE=1 CI=1 pnpm --filter @flyx/mobile build
rtk proxy pnpm --filter @flyx/mobile verify:export dist
rtk proxy pnpm --filter @flyx/mobile start
```

`ios` and `android` run local Expo development builds when the respective native toolchains and a device are installed. No EAS, signing, publishing, Provider execution, or push delivery is part of the test/build scripts. Native acceptance uses a development build; Expo Go support is not established. A trusted HTTPS Host reachable over LAN/Tailscale or an authorized Relay is required. There is no HTTP, certificate, redirect, anonymous-auth, or cookie fallback.

Optional `EXPO_PUBLIC_RELAY_CLIENT_ORIGIN` is an exact HTTPS Origin already allowed by the Relay. Direct always sends the Host's HTTPS Origin. Optional `EXPO_PUBLIC_EXPO_PROJECT_ID` is the Expo project UUID; without it push registration is hidden. Registration occurs only after the user requests it and grants OS notification permission. No push token is logged. In-app attention still works without a push project.

## Native boundaries

- `NativePlatformSignals` injects AppState, NetInfo, and a monotonic clock. It reports reachability/visibility facts and fences late NetInfo reads. The shared supervisor owns retries, offline waits, suspension probes, and transport replacement.
- `NativeClientStore.open(database, secureBridge)` implements `ClientStore`. Expo SQLite stores profiles, caches, content metadata, drafts, command payloads, and selected Host. Expo SecureStore stores only bounded refresh credentials. Body SQLite is ordinary app-sandbox storage, not SQLCipher or encrypted-body storage. Database encryption, backup policy and privacy review remain release work.
- `putCommandAndClearDraft` is one exclusive SQL transaction. Failed command persistence cannot send, and a newer draft survives. A queued command proven never dispatched can be explicitly sent with the same ID; uncertain commands only query receipts.
- Local forget commits body deletion plus a generation tombstone before deleting the secure token. These are two storage commits. If secure deletion fails, `LOCAL_CLEANUP_PENDING` is truthful: the surviving token is fenced and startup retries cleanup. Re-pairing is blocked until cleanup completes. SQL deletion failure rolls back and reports failure. This is logical deletion, not a forensic-erasure guarantee or remote device revocation.
- `createNativeFetch` uses `expo/fetch` with native `credentials:omit` and `redirect:error`. Direct pairing temporarily captures a Secure/HttpOnly bootstrap cookie in memory, checks the pinned descriptor and authenticated hello, rotates to a short-lived device credential, and discards the cookie. If native HTTP cannot expose the isolated cookie, pairing returns `NATIVE_PAIRING_UNSUPPORTED`; it never weakens authentication. Later Direct connections use the shared HTTP device-ticket path.
- `createNativeSocketFactory` supplies RN's custom Origin header. Shared Relay NK/IK transport still validates pinned Host identity, transcript binding and scopes.
- Notification metadata is routing data only. `revalidateAttentionRoute` re-queries the authenticated Session and Interaction/version before navigation. Notification clicks never approve or answer an old cached request.

## Crypto and platform evidence

`index.ts` installs native globals before loading the app/shared Noise engine. Expo's native `getRandomValues` supplies the CSPRNG; there is no `Math.random` fallback. The adapter implements SHA-256, raw X25519/Ed25519, AES-256-GCM and HKDF-SHA256 with the repository's pinned Noble 2.4 primitives. Unsupported algorithms and missing native randomness fail closed. Raw Noise secrets remain in JS memory and are not presented as nonextractable Keychain DH keys.

The wire suite remains `Noise_NK/IK_25519_ChaChaPoly_BLAKE2s`. The unchanged `salty-crypto` engine receives the existing Noble Noise algorithms; AES-GCM/HKDF do not replace its transcript or wire cipher. The installed Salty ESM package uses ordinary JS/BigInt/DataView, with no WebAssembly/browser loader. It selects the native `crypto.getRandomValues` global installed before the app/shared engine loads. Its dynamic optional Node fallback remains dormant and imports no Node crypto module in the actual Metro graph. The resolver bridge only handles a statically requested Salty `crypto` import; the current ESM export does not include that bridge. Missing native randomness fails closed.

The native test target runs the unchanged shared secure-channel contract suite under this provider. Primitive tests compare X25519/Ed25519/AES-GCM/SHA-256 against Node WebCrypto and HKDF against RFC5869. Those tests inject the desktop CSPRNG; they are algorithm and transcript evidence, not proof of OS keychain, socket headers, camera or background behavior on a phone. Storage tests use real SQLite through a fake Expo bridge and injected SecureStore failures. Runtime UI tests fence version/generation changes before interaction mutations.

Merged validation on the shared `ee882b6` foundation (including the public SessionClient): frozen offline install, shared package builds, product and fixture typechecks, and 83 tests across 12 files passed. Catalog reads use the negotiated public SessionClient. Canonical task input/command receipt validation wraps the existing atomic command-from-draft port, preserving persistence before draft clearing; the explicit legacy facade keeps its prior response contract. Full canonical snapshots and selected Session/Turn identity are checked before native actions. Task readiness also rejects archived, blocked or closing Sessions and active/unknown Turns; a new unloaded Session can still acquire its runtime on an explicit start. Installed runtime versions are Expo 54.0.37 and React Native 0.81.5. Metro exported both targets as Hermes bytecode version 96. The `verify:export` command reads both actual Hermes headers and source maps, reports byte counts/SHA-256 digests, and requires the native CSPRNG install before App, public client/SessionClient and unchanged Noble Noise graph. It rejects Node runtime imports, Host/Relay server modules, accidental fixtures, missing source evidence, and JS files renamed as bytecode. Buffer/punycode/assert imports are permitted only with their explicit bundled JavaScript package visible in the source map. These exports verify native dependency resolution and bytecode compilation. Device execution, real Direct Set-Cookie exposure, trusted TLS/Tailscale, Relay Origin acceptance, suspend/kill/network-switch recovery, camera/deep links, SecureStore cleanup and notification delivery require actual hardware evidence. This machine currently has neither `simctl` nor an Android SDK/emulator. No Android/iOS/Expo Go acceptance is claimed.

Expo 54 APIs and dependency compatibility were checked against the installed SDK and the local Paseo reference. Primary API references: [SQLite](https://docs.expo.dev/versions/v54.0.0/sdk/sqlite/), [SecureStore](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/), [NetInfo](https://docs.expo.dev/versions/v54.0.0/sdk/netinfo/), and [Notifications](https://docs.expo.dev/versions/v54.0.0/sdk/notifications/).
