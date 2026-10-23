# macOS 普通受管执行与真实 Provider 验收

更新：2026-10-24。用户已选择此路线，替代首版依赖 ES 监督服务的方案。范围仍为 macOS 本机、Claude/Codex、任务中断与续接、恢复、Checkpoint/Diff、Worktree。

当前开发已按用户要求暂停。平台/适配器实机证据和未完成的最终全量回归分别记录，剩余实现与恢复顺序见[实施计划](./core-capabilities-implementation-plan.md)；本文中的待验收步骤尚未因采用普通执行路线自动完成。

## 1. 参考实现与保证范围

- [Paseo 清理](../../paseo/packages/server/src/utils/tree-kill.ts)：SDK 结束后，SIGTERM、超时、SIGKILL；[持久进程记录](../../paseo/packages/server/src/server/managed-processes/managed-processes.ts)绑定身份并清理遗留进程。
- [T3 Codex 中断](../../t3code/apps/server/src/provider/Layers/CodexSessionRuntime.ts)：调用 turn/interrupt；[OpenCode 运行时](../../t3code/apps/server/src/provider/opencodeRuntime.ts)以进程组和尽力清理管理服务。
- Flyx 复用自身已有的 durable receipt/intent、原 DispatchContext、单一 SQLite writer、checkout lease 和按用途 Git runner；不复制参考项目的整个服务层。

普通模式只承诺：原始受管根进程已退出，原进程组已完成有界清理，相关已登记的 Provider/Git/helper 均有同范围停止记录。主动 setsid、更换进程组、借外部服务执行、外部编辑器和远端副作用不在完整停止保证内。后台开发服务不作为首版可保留任务。

ES、root 服务、系统扩展与完全磁盘访问不再是首版门槛。Developer ID/公证属于以后桌面分发工作。ES 强监督作为未来独立 backend，不能把普通结果标为完整后代停止。

## 2. 停止契约与记录

| 字段/状态 | 普通模式 | 原强隔离模式 |
| --- | --- | --- |
| contractId | `managed-process-group/v1/darwin` | `native-boundary/v1/...` |
| stop kind | `managed-group-stop` | `verified-tree-stop` |
| `stopped` | 本次启动的契约已满足 | 强隔离停止已满足 |
| `treeStopped` / `verifiedDescendantStop` | **false** | 只有强证明才 true |
| `unknown` | 身份/组查询异常、超时、journal 失败、启动窗口未决 | 原规则不变 |

`managed-group-stop` 版本为 1，绑定 processId/sourceId、原 identityDigest、launchDigest、processGroup、原根退出观察、组不存在观察和 observedAt。校验必须连接原始 launch/boundary/owner/attempt；RPC 布尔值、SDK interrupt 成功、根退出或 `ps` 单独缺席都不构成有效记录。

数据库继续保存版本化 JSON；原 launch、birth、boundary、strong proof 不改写。旧 macOS proof 不含普通契约、旧 unknown 没有可关联停止观察时，不自动升级。强证明与普通证明分支分别验证，生产不使用 fixture backend。

macOS boot/ps 身份观察只在实际普通 launch 时按需进行；它的秒级时间不作为无竞态内核句柄。默认 owner/SQL 历史启动不调用 ps/sysctl；不能为了提供普通进程身份而破坏无子进程的历史启动契约。

## 3. 启动与停止顺序

1. 检查当前 owner、设备/作用域、资源激活、restore/recovery gate、checkout lease 和必要 repository 元数据锁。
2. 冻结 executable/argv/env/cwd、用途与 DispatchContext；提交 launching 和原始计划摘要后才 spawn。
3. 使用 Node detached 进程组。保留原 ManagedChildHandle、stdio/exit/error 与 journal；Provider/工具采用单层 macOS Seatbelt，验证私有目录读写拒绝以及 workspace/Native state/专用 temp 写范围。固定 Git/恢复 helper 仍走 root-owned executable、用途白名单、受控 env/路径与独立 journal；它们不获得任意 shell 执行端口。只在该实际工作区边界通过探针后，由它承担 Claude Bash 的隔离，避免内部再次 sandbox-exec 失败；其他路径仍保留 SDK sandbox。设置 Host 专用 TMPDIR 及 [CLAUDE_CODE_TMPDIR](https://code.claude.com/docs/en/env-vars)，不放开全局 /tmp 或用户主目录。
4. 中断先走 Provider SDK/protocol；关闭 stdin 并在共享 deadline 内等待退出，必要时 SIGTERM → SIGKILL。
5. 根已退出但组仍存在时，也清理原组，避免工具持有 pipe 导致 Host 永久等待。组检查 EPERM/错误不能当 ESRCH；deadline 到达时 unknown。
6. 成功后提交匹配契约的停止记录；每个已登记 helper 同样处理。业务终态与执行停止分开记录。
7. captureAfter、Diff 发布、checkout/元数据锁释放只消费已验证的相应停止契约。普通模式不要求 `treeStopped=true`，仍要求 `stopped=true` 及完整原始绑定。

Provider 维持每 Turn attempt 的进程边界；下一 Turn 使用原 Native session/thread ID，在新受管进程中续接。常驻 app-server idle 不替代停止观察。关闭 Host 先封闭新启动、停止生产者、排空、同步 fence，再关 Store。

## 4. 恢复与放行

- 已提交的普通停止记录可用于匹配的普通契约；不得解释为强后代闭包证明。
- 未提交停止观察的崩溃窗口继续 unknown；不能因新 Host 启动成功、激活有效或用户 acknowledge 而清除。
- inspect 连接原 owner/generation/runtime/attempt、完整进程与检查 helper 清单、原工作区绑定、Native 历史以及当前 checkout 状态。
- reconcile 需要实际 Native 终态；acknowledge 可以保留业务 outcome_unknown，但仍需要执行停止与 checkout clear。新检查 helper 也必须停止，证据过期/身份漂移必须重新 inspect。
- 恢复确认按 evidenceId/recoveryRevision/CAS 与当前授权处理；未知命令不自动重放。备份恢复的全局 gate、Worktree 未决操作及回退部分失败分别保留。
- 发现脱离受管组或外部写入者，保留相关资源阻塞；可显式另建独立 checkout。普通模式无法保证对抗性逃逸进程停止，不提供自动强制解锁冒充证明。

## 5. C0 新退出条件

C0 改为普通本机执行的工程验收：

1. 目标 macOS 上私有目录边界、受管启动、原始记录和正常退出通过。
2. 活跃根、根退出后组内工具、SIGTERM 不响应、超时、检查失败、spawn 失败和 journal 失败均有正确清理/unknown 结果。
3. 普通结果 `treeStopped=false`；强停止分支与无普通合同的旧记录不被误放行。
4. 生产 main 与本地维护查询接入同一按用途 runner；历史启动不自动调用 Provider。
5. Claude/Codex 分别完成真实任务、实际工具/文件结果、SDK 中断、受管清理及跨进程续接。精确记录 CLI/SDK/Node/OS/配置和产物摘要。

逃逸探针作为范围限制的反例保留，不再要求普通模式通过强停止闭包。真实 Provider 的认证/网络/版本缺项单独列为对应 Provider 阻塞，不重设 ES 前置。

## 6. 验证与证据

确定性测试覆盖合同验证、unknown 拒绝、旧记录拒绝、恢复放行、Git/helper 和主入口组合。目标 Mac 实测覆盖进程组生命周期与真实 Provider；真实调用使用专用显式开关和独立临时工作区/DB/identity，限制 prompt、次数、时限与费用，不访问业务仓库。

真实兼容证据必须来自原生事件与原始 launch/stop 记录，绑定实际 executable/SDK/adapter/runtime/配置。无工具响应测试不替代工具执行、审批、恢复或回退验收；未测试的能力保持未验证。版本查询、fixture、未通过终态均不得登记为真实通过。

当前实施进度与实际命令/结果统一写入 [实施计划](./core-capabilities-implementation-plan.md)，未完成项不因方案写入而视为完成。

显式本机验收入口：

```sh
RUN_REAL_MACOS_PROVIDERS=claude,codex \
FLYX_CLAUDE_EXECUTABLE=/absolute/path/to/claude \
FLYX_ACCEPTANCE_REPORT_DIR=/absolute/path/to/private/reports \
pnpm --filter @flyx/mvp-host test:macos-providers
```

该入口使用已登录的本机 CLI、独立临时工作区/DB/coordination，Claude 每次 query 预算上限 0.5 USD；Codex 使用 low effort。每阶段最多 180 秒；真实写入及文件内容、全新进程中的原 Native 会话续接、长命令写出启动标记后再中断、原始受管停止记录分别断言。失败保留失败结果，停止不明时保留原现场；普通 CI 默认跳过真实调用。

报告记录 CLI/SDK/adapter/Node/OS、原始 launch snapshot 与 stop 摘要。它是平台与适配器验收证据，**不等于**生产 C3 签名兼容产物的导入/激活；后者仍须通过现有隔离授权、原提交事件与 provenance 校验。真实恢复、Native 回退、备份后外部覆盖和物理手机分别验收，不由本入口推导完成。
