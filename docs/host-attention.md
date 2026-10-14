# Committed attention and native notification integration

Attention represents committed pending questions, approvals, completed turns, and blocked recovery. Canonical completion sources include `turn.completed` and a `turn.reconciled` completed outcome whose authoritative stored Turn is completed. Recovery sources include `session.recovery.required`, `session.recovery.blocked`, `host.event_persist_failed`, and the R06 unknown reconciliation/control sources only while the committed Session recovery gate is blocked. The version uses the R07 stored recovery revision; it does not treat an intent attempt ID as a new recovery epoch. It stores only routing identifiers, versions, timestamps, and delivery status. It does not copy prompts, questions, approval reasons, paths, Diff, or content into push payloads or the unread list.

## Activation

The owned migration runner applies `ATTENTION_SCHEMA_SQL`/`applyAttentionSchema(db)` on the existing Host connection after R05 event commits and R13 interaction tables. `ATTENTION_SCHEMA_VERSION` proposes migration 10; the central migration runner owns final numbering and the schema-version record. Constructors perform no DDL and do not create another database connection.

Construct `AttentionStore(store.db, hostId, budgets)` and `AttentionService({store: attentionStore, authorizeSession, inApp, wakeup, driver})` under the Host owner. Resource authorization must be synchronous and must reflect current authorized Session access. The service also rechecks fresh stored device revocation, expiry, and `session:read` rights before delivering.

Register the R13 interaction projector first, then `attention.bindCommittedSource(store)`. It accepts the exact R05 `registerCommitHook(events, commit)` contract on the same SQLite connection. The synchronous hook re-reads source Events, the matching commit boundary, and authoritative Turn/Interaction/Session projections. Facts and eligible-device queue entries share the source transaction. A rollback removes all of them; the hook never invokes a driver or wakeup.

After a successful source commit, the Engine publication path calls `await attention.notifyCommitted(commit.id)`. The wakeup callback signals the managed delivery scheduler; it must not introduce an independent unmanaged background loop. Streaming commits without new attention do not scan history or wake delivery. Wake failures record a fixed error code while facts and queue entries remain durable.

At owned startup, call `recoverPendingDispatches()` before any delivery, then `enqueueOutstanding()` once and schedule bounded `drain()` calls. A previously claimed send whose outcome was not recorded becomes `outcome_unknown`; restart never repeats it automatically. Rate limiting has bounded retry attempts and a persisted next-attempt time. Unknown sends remain queryable until retention expires.

Registration, preference changes, and presence updates perform targeted device catch-up after their transaction and signal the scheduler. Foreground presence chooses in-app delivery when a configured in-app sink is available; background chooses push. Presence never removes a source fact. Preference suppression retains facts for the authorized unread list, and enabling preferences can resume suppressed jobs.

Route the server's committed device-revocation callback to `onDeviceRevoked(deviceId)`. It requires the credential revocation to be committed, revokes subscriptions, cancels queued/unknown jobs, aborts in-flight transport, and fences late results. On shutdown, stop admission and scheduling, call `abortDeliveries()`, await `awaitIdle()`, then release hooks and close the owned Store. Keep source hooks registered through any final authorized ingestion.

## Authenticated RPC and clients

Advertise `AttentionCapability` (`attention-v1`) only after schema and service activation. The central RPC dispatcher passes its trusted `{deviceId, hostId, scopes, leaseId}` principal to `handleRpc`; actor IDs are never accepted from a request body. Host routing and fresh database authorization are enforced again by the service.

- `attention.registerPush` accepts `{platform:'expo', tokenType:'expo', token, projectId, expiresAt?}` and returns subscription metadata without the token. It requires `access:self`, rotates the device's active token, clips expiry to device expiry, and has a subscription budget.
- `attention.unregisterPush`, `attention.getPreferences`, `attention.setPreferences`, and `attention.setPresence` require `access:self`. Preferences use `expectedRevision` and default to `{mode:'all', pushEnabled:false, revision:0}`. Presence is tied to the authenticated lease; call `disconnect(principal)` when that lease closes.
- `attention.list` requires `session:read` and optional Session authorization. Its ordinal cursor, 50-item limit, and encoded 24 KiB page budget bound responses. It includes stale/delivery state and never returns push credentials.
- `attention.acknowledge` requires `access:self` plus `session:read` and the exact fact version. It acknowledges only this device's reminder and cannot answer an Interaction or approve a Provider action.

`AttentionClient` in `@flyx/client-core` wraps these typed schemas around an authenticated per-Host request function, with mutation command IDs kept outside payloads. The parent integrates central command receipt/dedup handling where required.

Native clicks pass the strict minimal route into `revalidateAttentionRoute`. The helper selects the referenced Host through the caller's registry loader, re-queries current Session and Interaction facts even for expired routes, and returns `ready`, `stale`, or `expired`. It checks current version, pending status, response availability, and turn binding; it has no response action. Display current authorized facts before any user action.

## Push configuration and privacy

Push is disabled by default and reports `unavailable`, never delivered. A native application needs an explicitly configured Expo project UUID, OS permission, and a successful native token result before registering; missing project/device setup must remain unavailable.

`ExpoAttentionDriver` requires explicit `enabled:true`, the exact pinned endpoint `https://exp.host/--/api/v2/push/send`, and a configured project UUID. It accepts only a current authorized subscription for that Host/project. Redirects are rejected, responses are bounded, transport timeouts are finite, and errors expose fixed codes rather than remote messages. No request chooses the endpoint.

The route payload is exactly `{v:1, hostId, attentionId, sessionId, turnId?, interactionId?, version, expiresAt}` with a 1536-byte encoded limit. The Expo envelope is data-only with expiry/TTL and an opaque collapse ID; there is no title, body, prompt, reason, path, Diff, content, or response action. Tokens stay private in the Host database and never enter RPC responses or public readiness artifacts.

An Expo push ticket means service acceptance. A successful inspected receipt means provider handoff, not delivery to a device. These states are represented separately, following [Expo's sending documentation](https://docs.expo.dev/push-notifications/sending-notifications/). Real phone delivery, OS background wake behavior, and APNS/FCM credentials remain unverified by these tests. This implementation uses fake transport hooks for verification and makes no external sends.

## Retention and failure limits

Defaults are 10,000 retained facts, 50,000 per-device delivery records, 256 subscriptions, 24-hour fact retention, and three dispatch attempts. Budget overrides are finite positive integers; fact retention is at most 30 days. Queue exhaustion preserves the fact and records a fixed budget code. Fact exhaustion fails and rolls back the source transaction, allowing the Engine to report persistence failure rather than silently lose attention.

Expiry removes attention facts, their acknowledgements/deliveries, and expired subscriptions. It preserves source Events. Completion dedup across native and reconciled terminal sources uses the first committed completion timestamp, so replaying an old completion after attention retention cannot resurrect a new reminder. A source fact is keyed by Host/kind/Session/Turn/Interaction/version, and delivery by fact/device; accepted, presented, stale, revoked, and unknown records are not duplicated.

The deterministic tests cover source rollback, no driver within commit, failed wakeup persistence, later-device catch-up, delivery dedup, foreground/background routing, scope changes, revocation with a late send result, stale interaction versions, minimal payload privacy, disabled sinks, encoded budgets, expiry, and unknown-dispatch recovery. Central Host activation and actual native device acceptance belong to the parent integration.
