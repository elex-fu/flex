# 普通 macOS 执行阶段验收（2026-10-24）

起点：`003faa3254a3fc76a2d624ed4a1c2d5fdf2c36c8` 上的本轮工作区。路线由用户明确选择，替代首版 ES entitlement/Developer ID/特权监督服务前置；原强停止探针和反例保留。

暂停记录：2026-10-24 按用户要求停止开发和最终回归。本轮改动保留在未提交工作区；下列已完成证据保持原范围，暂停中断的回归未登记为通过。

## 结果与适用范围

普通受管执行后端、生产启动接线及双 Provider 的适配器实机检查已取得正向结果。完整产品上线仍需要 C3 产物/激活、真实恢复与 Native 回退等后续检查；本报告不把平台/适配器结果登记成这些事项完成。

| 项目 | 实际结果 |
| --- | --- |
| 平台 | Darwin 25.5.0 arm64；Node 24.18.0 |
| Claude | CLI 2.1.216、Agent SDK 0.3.220 |
| Codex | CLI 0.163.0-alpha.11.2、app-server adapter；low effort |
| 真实验收 | 2/2 通过；总时长 403.24 秒 |
| 原始进程 | Claude 4 条、Codex 5 条全部 stopped；普通 stop kind；完整树标记仍 false |
| 生产 main | 构建后 main 启动成功、SIGTERM 正常关闭、退出码 0；1 个元数据 Session，0 个 Native Session、0 次自动 Provider/进程启动 |

真实调用逐项断言：受管版本查询；实际工具写入随机内容；关闭原 CLI 后以新 PID 续接原 Native 会话并读取相同内容；长命令写出启动标记后再发送中断；SDK/protocol 取消与受管清理完成。Claude 的写入额外要求 Bash 实际成功，不能用 Write/Edit 回退替代。

精确版本、adapter 摘要、原启动快照和停止记录摘要见 [结果 JSON](./2026-10-24-macos-managed-provider-results.json)。JSON 已省去工具正文、Native session/thread ID 和登录材料；它不是 C3 导入产物。

## 本轮修复

1. 新增 `managed-process-group/v1/darwin` / `managed-group-stop`。普通成功保持 `treeStopped=false`，旧 macOS 无合同记录不升级。
2. 根退出后清理原组内工具；SDK 中断、TERM/KILL、组观察和 journal 失败均保留各自结果，unknown 不放行。
3. 当前 owner 的已提交 stop 记录按原合同与 launch 校验；历史 owner 仍使用原始边界/恢复证据。macOS boot/ps 观察仅在实际普通 launch 时按需执行，SQL/历史启动保持零子进程。不能把当前仍运行的生产者与已损坏的 stopped 记录混为一类跳过。
4. 恢复、Checkpoint、Worktree、metadata 锁、Native helper 与备份复核消费端同步普通停止范围；Recovery 对外明确 `managed_process_group`。
5. Claude 审批事件在响应槽注册后发布，支持本地同步响应。
6. 实机发现嵌套 Seatbelt 令 Bash 返回 `sandbox_apply: Operation not permitted`。改为已实际探测的 Host 单层工作区/私有目录边界，只有该边界有效时才由它替代 SDK 内部沙箱；Host 专用 TMPDIR/CLAUDE_CODE_TMPDIR 解决 CLI 固定 /tmp 写入。验证范围外写入与私有目录读写仍被拒绝。

## 验证记录

- 构建：`pnpm -r build` 通过；全工作区 typecheck 通过；Host 测试类型检查通过。
- 协议：56/56；client-core：163/163；mobile：90/90；Web Node：63/63。
- 平台/owner/生产组合定向：49/49；最终 Native history/回退/restore 消费端与边界定向：48/48。
- 新普通执行门禁修复后的激活/启动/组合/Native helper 定向：37/37；维护 CLI：2/2。
- Host 首轮全量为 1303 passed / 13 failed / 7 skipped。失败分别来自当前 owner Git 证据消费、维护 CLI 的旧拒绝预期、元数据启动不应调用 ps/sysctl 的约束，以及 factory 测试的旧强停止预期；已修复并经相关 37、2、40 项定向通过。第二轮运行跨越源码修改，1316 passed / 1 failed / 7 skipped；新合同隔离用例独立 5/5、最终相关定向 35/35 通过。定向批次有重叠，不合计为唯一总数。
- 最终固定源码重跑在用户暂停后被 SIGINT 中断，运行 50.33 秒，Vitest 退出码 130（包装进程 `-2`）；前后检查的 361 个源文件摘要相同（`sameSource=true`，`ac921a26e88d5e465752cda0b633d089c6bb5c15761dff1eb616aafe517f43ed`）。未取得完整汇总，状态为**暂停中断、待重跑**。
- Host 全量回归结果在实施计划中追加，不将过程中失败的旧结果覆盖为通过。

日志：`/private/tmp/flyx-macos-provider-acceptance-20261024.log`、`flyx-macos-host-full-20261024.log`、`flyx-macos-build-20261024.log`、`flyx-macos-typecheck-20261024.log`；生产 main 摘要：`/private/tmp/flyx-macos-main-20261024.json`。

最终暂停回归日志与指纹摘要：`/private/tmp/flyx-macos-host-frozen-20261024.log`、`/private/tmp/flyx-macos-host-frozen-20261024.json`。恢复开发后先完成固定源码回归，再推进生产兼容产物与显式激活；详细文件范围、实现步骤和退出条件保存在[实施计划](../core-capabilities-implementation-plan.md)。

## 限制与后续

- Codex 最终成功运行仍产生 12 条 `CODEX_TURN_ERROR` 重连提示；先前 90 秒阶段期限下曾续接超时。记录恢复后的结果，不据此承诺连接稳定性或延迟 SLA。
- 普通组清理不证明 setsid/更换组后所有后代停止；macOS ps/boot 身份也不是消除 PID 复用竞态的内核句柄。已知原组检查错误、超时或缺失原停止观察时仍 unknown。
- 此处是平台与 Provider adapter 验收，没有完成带签名兼容产物的生产激活闭环，也没有把本轮临时测试资源改成生产已激活。
- 真实 Crash Recovery、Native history manifest、备份恢复后的独立日志覆盖、双 Provider Native 回退锚点/完整回退和物理手机仍需分别验收，详见实施计划当前剩余事项。
