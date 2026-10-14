# Bounded read-only Workspace Git query contract

`lifecycle/managed-workspace-query.ts` exposes the exact `WorkspaceGitQuery` port (`argv`, `cwd`, `maxBufferBytes`, `timeoutMs`, optional `operationId`), preparation, tracked requests, and global drain/close/seal ports. The current production implementation returns `WORKSPACE_QUERY_PROCESS_BIRTH_UNAVAILABLE` on macOS before any child or launching row exists. Other platforms return `WORKSPACE_QUERY_PLATFORM_UNSUPPORTED` for this separate helper. It does not own the shared Store/journal. SQL-only Workspace/Session/history reads do not use this port and remain available.

The planner accepts only the existing fixed `rev-parse --show-toplevel` and `rev-parse --path-format=absolute --git-common-dir` queries. It reconstructs the executable, argv, and environment; rejects mutation/plugin/network arguments, noncanonical or private-overlapping roots, untrusted executables, output bounds above 16 KiB, and timeouts above 5 seconds. System/global config, fsmonitor, hooks, optional locks, credentials, and protocols are disabled. No Host environment is inherited.

The dedicated diagnostic macOS profile denies child creation (`process-fork`, including actual POSIX spawn), persistent file writes (only the kernel `/dev/null` data sink is allowed), network access, and private-root reads. It permits only explicitly listed executable images. Actual fixture tests independently check fork and POSIX_SPAWN_SETSID denial, private reads through a symlink, private/workspace writes, the required `/dev/null` sink, network connect, and real Git queries in an unborn Unicode/space checkout with hostile local config. These restrictions are compatible with the tested read-only Git commands; they must not be applied to ordinary Native tool execution or Git mutations.

Enforcement alone is insufficient for the required immutable process identity. The installed SDK publicly exposes `TASK_AUDIT_TOKEN`, `audit_token_to_pidversion`, and `proc_bsdinfo` start timestamps. A direct actual-OS probe on macOS 26.5.2 / Darwin 25.5.0 returned a real boot UUID and kernel audit PID version. A same-PID exec probe changed that audit version, including under the helper-only profile. It is not a stable process birth binding. The BSD start value is a wall-clock timestamp; neither it nor `ps` output is promoted to unique birth. The shipped inspector has no supported stable macOS birth binding, and this module adds none.

Actual test launches use `ManagedProcessRegistry` and `SqliteProcessJournal`: the exact diagnostic profile and launch digest are committed before spawn, root exit is observed on the original child, and records remain `unknown` with no stop proof. The tests do not turn process-group absence or an audit version into a full-tree proof. All fixtures, compiler inputs, sentinels, Git metadata, and journals are owned temporary data; no Provider, daemon, real Host secret, or external service is used.

A future production executor needs a shipped, trusted, stable kernel identity binding before readiness; immutable launching/profile/argv evidence before spawn; actual birth before query dispatch; original-root completion and the independently verified no-descendant policy; bounded output and drain; and fenced late callbacks before the shared Store closes. Audit execution-version changes, crashes before birth persistence, policy/backend replacement, unsupported identity, and incomplete stop must return unavailable/unknown. Main may inject a separately verified trusted runner, but this port supplies no ordinary Native, write, rewind, or general Git capability.

Run the focused actual-OS and port tests after building local protocol artifacts:

```sh
rtk pnpm --filter @flyx/mvp-protocol build
rtk pnpm --filter @flyx/mvp-host exec vitest run src/lifecycle/managed-workspace-query.test.ts
rtk pnpm --filter @flyx/mvp-host typecheck:tests
```
