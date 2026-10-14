# Web entry and shared runtime ownership

`main.tsx` consumes one-time pairing fragments before asynchronous work and initializes the application-owned `WebHostRuntimes`. React `useHost` subscribes to that owner and its shared client only. Observer cleanup never stops a Host, deletes credentials, or changes the desired Host. Explicit Host selection and pairing continue through the registry's pinned identity and authenticated transport path.

Drafts use the Host/Session key in `WebDraftController`. Late loads cannot replace local edits or another selection. Local storage failures retain the editable buffer. Submission saves a stable `clientMessageId`, then uses shared-core `commandFromDraft` for an atomic command/draft handoff before any send. Only `onPersisted` may clear matching input. A later edit gets a separate message identity and survives the original callback. Network uncertainty after persistence remains in the original durable command and is not restored as a new sendable duplicate.

The Web page offers independent read-only receipt queries for accepted, unknown, and failed commands. Only a saved `queued` command with explicit `dispatchState:'not_dispatched'` evidence exposes a send action; that action still uses core receipt reconciliation and the original command ID. A missing receipt never establishes that a command was not sent.

Canonical cached content is labeled stale/read-only until the current Host transport and Session replica are authoritative. Cache failure is displayed separately and does not terminate RPC. Referenced Timeline bodies and metadata have explicit loading/error controls. Diff handles both field refs and generic `payloadRef` envelopes through verified core content reads. The UI does not describe an unresolved reference or a truncation marker as a complete clean Diff.

The frozen R11 `session-registry-v1` capability and strict public Catalog DTOs gate explicit Session selection and target payloads. Public `sessionId` is normalized for the existing Web display model; private native handles are never accepted as public Session fields. Until Host schema/factory/RPC/capability activation is complete, the legacy default Session remains available. R13 InteractionCards are enabled only after the actual typed Interaction capability is negotiated and receive authenticated current `interaction.get` DTOs, source revisions, current device rights, and authoritative replica readiness. Their callbacks return the Host receipt without inventing a local terminal result.

## Local deletion and server authorization

Offline local forget and remote device revocation are separate actions. Local forget waits outstanding draft storage writes, invalidates late loads/submission callbacks, stops the owned runtime, and deletes the application's Host records, application credentials, commands, drafts, and cache. It does not send server logout/revoke requests and does not claim to remove Host-managed HttpOnly cookies or cancel remote authorization.

Before deletion, the Web owner durably writes a non-secret boolean preference under `flyx:web:automatic-bootstrap:v1`. It contains no Host ID or token. The preference prevents automatic bootstrap on reload while a same-origin HttpOnly cookie still exists; a transition fence also prevents a late startup from adopting the forgotten owner. Only explicit pairing or Host selection may clear the preference through the normal pinned/authenticated path. A failed preference write reports an error, preserves local records, and blocks subsequent automatic startup in the current owner. A failed read also blocks automatic startup. If clearing the preference fails after a manual connection, that connection remains valid and the preference failure is reported.

The local-delete confirmation describes these boundaries. Remote revocation reports a server acknowledgment only when the response actually confirms it; a lost/uncertain response remains unconfirmed and can be inspected through read-only receipts or the Host's device registry.

## Verification

Pure controller tests cover draft/save/handoff failures, rapid edits, late loads, Host/Session switches, local deletion barriers, retained newer drafts, cookie-present reload suppression, explicit pairing recovery, preference write failure, read-only receipt eligibility, strict Catalog DTOs, and generic Diff references. Existing shared runtime and InteractionCard tests remain part of `pnpm --filter @flyx/mvp-web test`; no React testing dependency was added.

The local unit build and deterministic controller tests do not establish real browser/phone network acceptance or native push delivery. Actual deterministic desktop-browser evidence and its limits are recorded in `BROWSER_ACCEPTANCE.md`. Production Catalog/Interaction activation and browser/phone acceptance belong to the parent integration.
