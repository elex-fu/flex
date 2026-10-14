# macOS Native stop contract: actual local validation

The current unprivileged macOS private-file boundary does not prove Native descendant termination. Keep `treeIsolation: unverified`, `verifiedDescendantStop: false`, durable unknown process records, and retained writer ownership. A known business terminal remains distinct from producer-stop evidence. Do not release a canonical workspace lease from root exit, an absent process group, a missing PID, an SDK interrupt acknowledgement, or a successful checkpoint read.

This result is scoped to the tested implementation and machine: macOS 26.5.2 / build 25F84, Darwin 25.5.0 / XNU 12377.121.10, Apple clang 21.0.0 and SDK 26.5. The sandbox executable SHA-256 was `8290e4be7387a0df83cd1559e86afd880464f269450573d012795761fe298f16`. The runner records exact helper, backend and generated-profile hashes for each run. Policy hashes vary because each fresh fixture has unique private paths.

## Reproduce without a Provider or daemon

Build the Host's local modules, then run the owned probe. Commands must be prefixed with RTK:

```sh
rtk pnpm --filter @flyx/mvp-protocol build
rtk pnpm --filter @flyx/mvp-host build
rtk proxy node scripts/native-stop-contract/macos-probe.mjs
rtk pnpm --filter @flyx/mvp-host exec vitest run src/lifecycle/macos-stop-contract.test.ts
```

The script compiles [macos-adversary.c](../scripts/native-stop-contract/macos-adversary.c) into a fresh mode-0700 temporary directory. It imports the actual production private-boundary module and uses that module's tested profile. It never runs Claude/Codex, creates an ES subscription, changes a user daemon, accesses real Host secrets, or writes a registered workspace. The private sentinel, writable workspace and Native state are all fresh fixtures. A Host-owned FIFO provides the release barrier independently of root stdin; stdin alone is unsuitable because Node closes its write handle when the root exits. Children have bounded watchdogs, the runner awaits inherited output closure, and cleanup removes only its own temporary tree.

## Observed kernel behavior

| Probe | Actual observation | Implication |
| --- | --- | --- |
| `fork` then `setsid` | Child creates a new session, original group disappears, child writes after root exit and Host barrier release. | Root/group absence is not tree exit. |
| `fork` then `setpgid(0,0)` | Child moves into its own group within the original session and writes after root exit. | Preventing only new sessions would still be insufficient. |
| Double fork and grandchild `setsid` | Grandchild is reparented to PID 1 and writes after root exit. | Parent-PID scanning loses the original lineage. |
| `posix_spawn` with `POSIX_SPAWN_SETSID` | Spawned child escapes and writes after root exit. | A mechanism must cover spawn as well as explicit fork. |
| Private sentinel read in every descendant | Denied before and after the release barrier. | Private-file confinement is inherited; it is not lifetime confinement. |
| Candidate `process-setsid`, `process-setpgid`, `process-set-session` policies | Profile compilation exits 65 with an unbound-variable error. | These names are not usable controls on this backend. This is not an exhaustive claim about every private SBPL operation. |
| `deny process-info-setcontrol` | Profile compiles but `setsid` still succeeds. | That operation cannot be substituted for a session/group restriction. |
| `deny process-fork` | Both `fork` and `posix_spawn(SETSID)` return `EPERM` (1). | A single-process-only policy is a possible separate contract, but blocks normal child tools and must not silently replace the current Provider behavior. |
| kqueue `NOTE_TRACK` | Registration fails with `ENOTSUP` (45). | Automatic descendant tracking is unavailable in this interface. |
| kqueue fallback `NOTE_FORK | NOTE_EXIT` | Registration succeeds; root fork and exit are observed, fork data is 0 and no child identity events arrive, while the descendant still writes. | Root notifications cannot construct a complete descendant manifest. |
| EndpointSecurity client | `es_new_client` returns `ERR_NOT_PRIVILEGED` (5); no client/subscription is retained. | The normal unprivileged Host cannot use this stronger event interface directly. |
| Rename writable workspace, then chmod directory to 000 | Escaped child writes through its already-open file descriptor. | Path replacement and ordinary permissions do not revoke existing writes. |

These are positive effects after a barrier, not PID-liveness guesses: the Host first observes root exit and original-group absence, then permits the descendant to execute its write, and reads the new bytes. The test also verifies inherited private-file denial. No observation promotes the production stop flag.

## Locally inspected interface evidence

The installed SDK's `usr/include/sys/event.h` explicitly marks `NOTE_TRACK`, `NOTE_TRACKERR` and `NOTE_CHILD` unsupported since macOS 10.5. Its `NOTE_FORK` comment states that the child PID is not passed through in the actual kevent. The actual registration/fallback probes confirm both limitations. `usr/include/sys/spawn.h` exposes `POSIX_SPAWN_SETSID`. `usr/include/EndpointSecurity/ESTypes.h` distinguishes missing entitlement, missing user TCC approval, and not running as root; the actual client returns the last condition. The public `sandbox.h` is deprecated and provides no supported Host-side revocation API for descendants' existing file descriptors. Existing SDK/profile evidence plus these bounded probes does not establish a compatible unprivileged full-tree mechanism.

## Feasible follow-up contracts, not implemented capability

A Linux execution backend can supply an actual private PID namespace and restricted mounts. Native launches, auth/state, workspaces, helper tools and resume bindings would all belong to that backend; no host process-launch broker sockets should be exposed. The existing Linux boundary already requires actual namespace, capability-drop, user-namespace and hostile-descendant self-tests before readiness. A macOS-hosted implementation additionally needs a trusted VM/backend shutdown contract and compatible executable/auth packaging; it cannot pretend a macOS executable is a Linux binary.

A signed, privileged EndpointSecurity supervisor is another research direction. It would need the required entitlement, root execution and user approval; subscribe before any Native code can fork, bind kernel process identities to the exact launch context, detect event loss/sequence gaps, and persist the complete fork/exec/exit manifest. Startup races, unsubscription, supervisor crash and any loss of coverage must retain unknown. Its ordering/barrier and kill semantics require real adversarial validation before a new stop contract is accepted. Merely obtaining an ES client is not proof, and this probe installed no supervisor.

An explicit single-process Provider mode could be investigated separately using the observed no-fork enforcement plus a restricted executable/service policy. It would require actual Native compatibility tests, disable or broker child tools, and expose its restricted capabilities. Current general Native tool support must not be advertised under that profile.

A staging-workspace design can reduce canonical-write exposure only if kernel-enforced policy denies canonical checkout writes to every Native descendant and all aliases. It must also address writable Native state, existing descriptors, mapped pages and broker access. Copying staging data into the canonical checkout needs a consistent immutable snapshot and an independently owned merge/checkpoint transaction. Rename, chmod, process scanning or cached lease flags alone are not revocation mechanisms. This remains a design candidate, not producer-stop proof.
