# Bounded read-only Workspace Git query contract

Updated 2026-10-24: ordinary macOS execution is explicitly authorized; see [the selected contract](./macos-managed-execution.md). `lifecycle/managed-workspace-query.ts` exposes the exact `WorkspaceGitQuery` port (`argv`, `cwd`, `maxBufferBytes`, `timeoutMs`, optional `operationId`), preparation, tracked requests, and global drain/close/seal ports. Production main and maintenance verification now inject the trusted ordinary macOS `ManagedGitRunner` executor. It journals original launches and `managed-group-stop` observations under `managed-process-group/v1/darwin`; it never claims complete descendant termination. Without an injected executor the existing unavailable codes remain. SQL-only Workspace/Session/history reads do not use this port or invoke identity probes.

The planner accepts only the existing fixed `rev-parse --show-toplevel` and `rev-parse --path-format=absolute --git-common-dir` queries. It reconstructs the executable, argv, and environment; rejects mutation/plugin/network arguments, noncanonical or private-overlapping roots, untrusted executables, output bounds above 16 KiB, and timeouts above 5 seconds. System/global config, fsmonitor, hooks, optional locks, credentials, and protocols are disabled. No Host environment is inherited.

The dedicated diagnostic macOS profile denies child creation (`process-fork`, including actual POSIX spawn), persistent file writes (only the kernel `/dev/null` data sink is allowed), network access, and private-root reads. It permits only explicitly listed executable images. Actual fixture tests independently check fork and POSIX_SPAWN_SETSID denial, private reads through a symlink, private/workspace writes, the required `/dev/null` sink, network connect, and real Git queries in an unborn Unicode/space checkout with hostile local config. These restrictions are compatible with the tested read-only Git commands; they must not be applied to ordinary Native tool execution or Git mutations.

The original strong-identity research remains relevant as a limitation: the installed SDK exposes `TASK_AUDIT_TOKEN`, `audit_token_to_pidversion`, and `proc_bsdinfo` start timestamps. On macOS 26.5.2 / Darwin 25.5.0 a same-PID exec changed the audit version, including under the helper-only profile. It is not stable birth. Ordinary launch identity now optionally records boot UUID and ps start time; this observation has second precision and is not promoted to a race-free kernel handle. Only actual ordinary launches request it. SQL bootstrap/default ownership performs no ps/sysctl subprocesses, and legacy PID-only records do not gain a birth observation retroactively.

Actual test launches use `ManagedProcessRegistry` and `SqliteProcessJournal`: the exact diagnostic profile and launch digest are committed before spawn, root exit is observed on the original child, and records remain `unknown` with no stop proof. The tests do not turn process-group absence or an audit version into a full-tree proof. All fixtures, compiler inputs, sentinels, Git metadata, and journals are owned temporary data; no Provider, daemon, real Host secret, or external service is used.

The selected production executor requires immutable launching/argv/purpose/owner evidence before spawn, original-root exit plus bounded group cleanup, a matching persisted ordinary stop record, bounded output/drain, and fenced callbacks before Store close. Failed group probes, launch-persistence gaps and incomplete cleanup stay unknown. Old records without the ordinary contract are not upgraded. The query port still supplies no ordinary Native, write, rewind, or general Git capability. Complete descendant isolation remains a separate stronger backend, not a prerequisite inferred from this query policy.

Run the focused actual-OS and port tests after building local protocol artifacts:

```sh
rtk pnpm --filter @flyx/mvp-protocol build
rtk pnpm --filter @flyx/mvp-host exec vitest run src/lifecycle/managed-workspace-query.test.ts
rtk pnpm --filter @flyx/mvp-host typecheck:tests
```
