# Host operations and compatibility evidence

Production restarts use `bash scripts/start-host.sh` and the fixed `apps/mvp-host/dist/main.js` artifact. The entry never installs packages, builds sources, invokes Corepack, or bootstraps through the network. Prepare a development checkout explicitly with `bash scripts/dev-bootstrap-host.sh`; deployment must supply its built Host, Web, workspace packages, and native SQLite dependency.

## Doctor

`collectDoctor` takes a read handle and runtime evidence from the Host lifecycle. It does not create identity files, migrate the database, recover turns, or call Provider preflight. Local diagnostics use the same sanitized projection as remote diagnostics. Remote callers need `host:read`; session aggregates additionally need `session:read`.

The projection contains owner/readiness, schema, verified Provider versions and capabilities, activity/unknown counts, queue budgets when supplied, Timeline watermarks, content storage, checkpoint failure categories, and Relay state. It excludes message bodies, full workspace/executable paths, native IDs, account metadata, credentials, and identity private keys. Unavailable queues/content/checkpoints stay unavailable. Physical stored bytes and logical reference bytes are separate.

Cost evidence requires explicit `native` or `estimated` provenance and availability. A legacy `costUsd: 0` without provenance, including the existing Codex placeholder, becomes `unknown/unavailable`. It cannot demonstrate a free run or an enforced budget.

## Backup and restore

`BackupService.create` requires an active owner bound to the database and a `withSnapshot` coordinator shared by identity rotation and Relay registration/generation changes. SQLite's backup API captures committed WAL facts. A private directory contains the database, associated identity and optional Relay files, plus an owner-only manifest. The manifest records schema/application versions, public identity fingerprint, file hashes and Relay generation; it contains no secrets or external Git/Provider history. Generation drift rejects the incomplete snapshot.

`RestoreService.restore` requires an offline maintenance owner and an assertion that all database handles/producers have stopped. Before installation it validates artifact hashes, identity association, SQL integrity/FKs/schema, and ready content-reference hashes/ranges. It captures the current state in the requested rollback directory, stages and validates the restored database, and installs it atomically.

Restore preserves the current matching Host identity. It revokes historical devices, auth sessions, pairing grants and protocol leases, marks accepted receipts and possible-dispatch intents unknown, and supersedes historical pending approvals. Historical Relay credentials are kept in the rollback snapshot and removed from the active registration path. The remote Relay route still needs external reconciliation.

The restored `host_state.restore_readiness` gate is `external_state_unverified`. Lifecycle readiness must honor this gate until Git and Provider history have been checked and unresolved execution/recovery gates have been settled. Restoring database history does not rewind the checkout, Git refs, a Provider conversation, or external tool effects. A missing receipt after the backup is not proof that a command never ran.

R03 owner mode `host` adapts to the operations capability mode `runtime`; `maintenance` adapts directly. R04 lifecycle owns the shared snapshot lane. CLI integration must acquire the correct owner and supply the current supported migration version before invoking these services.

## Controlled matrix

`node scripts/compatibility/run-matrix.mjs --deterministic-only` records only deterministic evidence. Real execution additionally requires `--real` and the provider-specific `RUN_REAL_CLAUDE=1` or `RUN_REAL_CODEX=1`. The same Node/OS, runtime, capability and native-proof requirements apply to both Providers.

Controlled Host/test entrypoints explicitly enable `FLYX_TEST_CONTROLLED_ENTRY=1` and call `writeTestReadiness` after startup using `FLYX_TEST_READINESS_PATH`. Readiness and a separate one-use pairing credential are written to owner-only temporary files. The runner consumes these files and deletes the scratch directory after shutdown. Normal startup output and evidence reports never contain the test pairing secret.

Adapters and authoritative recovery inspectors can record structural native facts through `CompatibilityEvidenceRecorder`, bound to `FLYX_COMPATIBILITY_RUN_ID` and `FLYX_COMPATIBILITY_EVIDENCE_PATH`. Native identifiers are hashed; messages, prompts, tool input/output and credentials are excluded. Callers must record approval delivery and verified stopping only after observing their native evidence. A local answer boolean, stdio write, interrupt request, version response, or fixture terminal event is insufficient.

Full promotion requires matching observed Node/OS/SDK/CLI/executable/auth/capability evidence and enough current-run native Turn, approval, interrupt and recovery records. Duplicate events and previous-run JSONL records cannot increase counts. Missing scenarios are recorded as skipped, unsupported native outcomes stay unsupported, and blocked/skipped runs never become real passes. The default fixed reply prompt exercises turns only; approval/interrupt prompts and authoritative recovery evidence must be supplied for full acceptance.

This implementation was verified with deterministic temporary-file and parser/gating tests. Real Provider, real phone, Direct/Tailscale/Relay and native shutdown acceptance evidence remains a separate release requirement.
