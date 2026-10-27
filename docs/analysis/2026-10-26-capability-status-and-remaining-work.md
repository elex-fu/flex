# Flyx 能力最新状态与剩余任务（2026-10-26）

> 目的：把散落在 [实施计划](../core-capabilities-implementation-plan.md) 头部、[交互场景设计](../design/interactive-scenes.md) 验证记录与任务列表中的状态，提炼成一份单页可读的现状 + 路线文档。本文是**汇总视图**：契约与设计以 [核心能力技术方案](../core-capabilities-technical-design.md) 为准，逐日证据以实施计划"本轮证据"为准。
>
> 基线：`origin/main` = `20b95e9`；工作区干净。当前执行模式为普通 macOS 受管执行（`managed-process-group/v1/darwin`）。

## 1. 一页结论

里程碑链 **G0 → M4 → R4 → R6 → R9（组合链路 + A11 真并行）→ 交互能力场景 c4–c7** 全部真实验收通过（Claude 与 Codex 双 Provider）。核心平台闭环已完整：受管执行与验证停止、检查点/回退、独立 checkout 真并行、兼容证据→授权→导入→激活信任链、审批/中断/重连交互能力。**写盘工具死锁在无应答审批卡上的问题已闭环**：destination 按证据发布 `interactiveApprovals`，卡片在网页可答（allow 落盘 / deny 拒绝均有原生确认）。

剩余全部是收尾项，无平台级未解问题：四面板浏览器 E2E、resume 生产实测、worktree 创建操作重启找回、物理手机验收（唯一硬阻塞：本机无 adb 设备）。网页端中断验证已双 Provider 留档完成（Claude 2026-10-27；Codex 2026-10-28——#33 三项中断链路缺陷 + r11 两项停止验证根因修复后，r12 全链路 `real=passed` 17/17 原生记录、网页驱动 EXIT=0、160/160 受管进程 managed-group-stop、零诊断事件）。

## 2. 能力状态总览

| 能力域 | 状态 | 验收证据（最新） | 关键实现锚点 |
| --- | --- | --- | --- |
| 受管执行 + 验证停止 | ✅ 实机通过 | M0/M1（2026-10-24 前）；本轮根因修复后 r5/r6/r7 basic 10/10 | `ManagedProcessRegistry` 进程组、`managed-stop-contract`；`PRODUCER_STOP_DEADLINE_MS=30_000`（`managed-runtime.ts`，修复 codex r2/r4 `RUNTIME_STOP_UNVERIFIED` 保留级联）；r11 根因修复：zombie-EPERM 组检查继续轮询至截止（macOS `kill(-pgid,0)` 对未 reap 的僵尸成员返回 EPERM 而非 ESRCH）+ codex `finish()` 退役改用 30s 截止（`closeAndWait` 记忆首个截止） |
| 兼容证据 → 激活信任链 | ✅ 生产闭环 | M4（2026-10-24，c3 `fully-verified`） | prepare → authorize（60 分钟单次 ticket）→ 真实场景 → import（destination 签名 endorsement）→ activation verify/activate |
| 交互能力（c4–c7） | ✅ 双 Provider 真实验收（2026-10-25） | Claude r8、Codex r7（`det=passed real=passed current=fully-verified`，原生证据 complete / invalid 0） | 场景注册表 `compatibility-scenes.ts`（`flyx-c7-interactive-v1` = basic×10+approval×2+interrupt×1+reconnect×1）、recorder/provenance 扩展、import 能力携带、destination 按 endorsement 发布 |
| 审批卡（网页可答） | ✅ E2E 通过 | dest-claude：弹卡→respond→UI 内"Native response confirmed"→allow 落盘 / deny 拒绝 | `catalog-interactions` 双端能力门 + 适配器 `respondApproval`（Claude `canUseTool` / Codex `item/*/requestApproval`，工作区外守卫自动拒绝） |
| 中断 | ✅ 真实验收（compat RPC 驱动 + 网页 E2E 双 Provider 留档） | 双 Provider interrupt 段 turn.cancelled + 原生停止证明；网页中断 E2E 双侧 EXIT=0（Claude 2026-10-27；Codex 2026-10-28 r12 激活后：160/160 受管进程 managed-group-stop、零诊断事件，含中止后 follow-up 恢复） | `session.interrupt`（trailing expectedRevision，`44d766f`）；适配器 60s 重投递窗口（`b5d043a`）；`startTurn` 等待在途 finalize（`5276aba`）；run-matrix `provider.turn.bound` 后再发；r11 根因修复（zombie-EPERM 轮询 + 30s `finish()` 退役截止） |
| 重连 | ✅ 真实验收 | 双 Provider：graceful 验证停止 → Host 重启 → 重启后新 turn 成功 | destination 发布 `resumeConversation`；§6 信任穿线（`macosExecutionFactsTrust`，导入激活 boot 不 fail-closed，有专项测试） |
| 真实恢复 + 备份外部复核 | ✅ L1–L4 通过（2026-10-24） | R4 | 原始终态收据锚点、恢复检查证据链、DB 兄弟 0600 launch/stop 顺序账本、生产端到端恢复链测试 |
| Native 回退 | ✅ L1 生产接线 + L2 双 Provider 真实完整回退（2026-10-24，A9/A10） | R6 | `native-revert-production.ts`；Codex `thread/resume`+`thread/revert`、Claude `forkSession`；响应丢失/崩溃语义（applied/unknown，绝不二次派发） |
| 组合终验 + 真并行 | ✅ 通过（2026-10-24） | R9 组合链路 + A11 | `host-application.r9-{combined,parallel}.test.ts` |
| Web UI（会话/草稿/readiness/审批卡） | ✅ 已测（真实 Host E2E + 浏览器 E2E） | C8 浏览器部分 | CoreControls 共享控制器；审批卡网页 E2E 已留档 |
| 手机最小面板 | ✅ 代码接通（回执核对） | 浏览器模拟；真机归 #18 | Expo 壳 + `client-core` |

测试基线：全量 `pnpm test:product` 1417 通过 / 0 失败（2026-10-27，含 #33 三项修复与 r11 两项根因修复的回归测试）。

### #33 网页端 streaming turn 中断被 SESSION_REVISION_CONFLICT 拒绝 —— 已修复（2026-10-27，`44d766f` / `b5d043a` / `5276aba`）

首次网页中断驱动暴露三个叠加缺陷，均已修复并带回归测试：(a) `session.interrupt` 对 `expectedRevision` 精确匹配，streaming turn 推进 revision 后客户端副本滞后即被拒（改为接受 trailing revision，`startTurn`/`approval.respond` 仍精确匹配）；(b) Claude 适配器遗留的 5s 中断确认计时器在重投递控制请求悬挂时误报 `INTERRUPT_UNCONFIRMED`（改为 fire-and-forget 重投递 + 同步重挂，60s 窗口为唯一后障，悬挂投递不再阻塞链条）；(c) 中止后 follow-up `startTurn` 撞上仍在途的 post-turn checkpoint finalize 被 `WORKSPACE_BUSY` 静默丢弃（`startTurn` 现等待在途 finalize，默认 15s；真正被持有的 lease 仍立即拒绝）。修复后 Claude compat 链以 r13 重跑通过，网页中断驱动 EXIT=0 且 DB 零诊断事件。

## 3. 双 Provider 交互能力矩阵（真实证据）

| 能力 | Claude（r14 重跑通过，claude-cli 2.1.216 / SDK 0.3.220） | Codex（r12 重跑通过，codex 0.164.0 app-server） |
| --- | --- | --- |
| turn（basic×10） | ✅ | ✅（46–179s/turn） |
| approval 卡（allow→落盘 / deny→拒绝） | ✅ ×2 + 网页 E2E | ✅ ×2（首次观测到 codex 审批卡） |
| interrupt（turn.cancelled + 停止证明） | ✅ | ✅（167s） |
| reconnect（验证停止→重启→新 turn） | ✅ | ✅（graceful 关闭） |
| destination 发布能力 | streamingText/workspaceWrite/interactiveApprovals/interrupt/resumeConversation | 同左（dest-codex 激活后实测发布） |
| 完整回退（R6） | ✅ forkSession | ✅ thread/revert |
| 已知环境性 | — | OpenAI 后端流不稳（"Reconnecting n/5"）：环境问题，harness 已加固（300s 卡等待、bound 后再中断）；r6 rep1 模型跑偏请求工作区外访问被守卫按设计拒绝（非缺陷） |

## 4. 剩余任务与实现方式

按建议顺序排列；均已在任务列表登记（编号对应）。

### T1（#29）网页端真实中断验证留档 —— 已完成（双 Provider）

- **结果（2026-10-27/28）**：入口统一核实完成（代码中不存在 `host.interrupt`；`use-host.ts webInterrupt` 走 `CoreControls.interrupt()`）。#33 三项中断链路缺陷（`44d766f`/`b5d043a`/`5276aba`）与 r11 两项停止验证根因修复（zombie-EPERM 组检查轮询至截止 + codex `finish()` 30s 退役截止）落地后：
  - **Claude**：网页中断 E2E EXIT=0（2026-10-27）——streaming 长任务 → 中止 → `cancelled`（`aborted_streaming` + native-terminal 停止证据）→ follow-up 完成；DB 零诊断事件。compat 链随 dist 重建以 **r13/r14 重跑通过**（r14 17/17 原生记录）。
  - **Codex**：r12 全链路 `real=passed`（11/11 段、17/17 原生记录、`HOST_STOP_UNVERIFIED` 未复现）→ import → activation 激活后，同款 Playwright 驱动对 dest-codex **EXIT=0**（2026-10-28）：interrupted turn `cancelled`、follow-up `completed`、**160/160 受管进程 `stopped` 带 managed-group-stop 证明**；诊断仅既有 OpenAI "Reconnecting n/5" 环境噪声，零 SESSION_REVISION_CONFLICT / INTERRUPT_UNCONFIRMED / WORKSPACE_BUSY。
- **留档**：`docs/design/interactive-scenes.md` 头部 2026-10-26→28 验证记录（含 r11 根因、r12/r14 重跑、codex 网页驱动记录与两条已知运维缺陷——dest-codex `web/` 需自 dest-claude 复制、每次驱动需 pairing-grant 重置周期）。

### T2（#28）Web 四面板（Recovery/Diff/Worktree/Revert）浏览器 E2E
- **现状**：CoreControls 控制器与四面板已接线，会话元数据/草稿/readiness 有真实 Host E2E；四个高危面板缺浏览器层场景。
- **实现方式**：同一 Playwright 驱动骨架上按面板写场景：Recovery（制造 outcome_unknown→inspect→reconcile 放行）、Diff（turn 前后 before/after + 差异渲染）、Worktree（创建/选择/并发提示）、Revert（preview→workspaceRestore blocked→rollbackToSafety 的 UI 侧投影）；每场景覆盖浏览器刷新/断线重连不重复任务、不串会话（A5/A6/A13 退出条件）。
- **验收标准**：四面板各至少一条真实 Host 驱动的浏览器场景记录；刷新/重连断言通过。
- **预估**：中（1–2 天）。

### T3（#30）resume（新会话续接）生产实测
- **现状**：`resumeConversation` 已随 endorsement 发布；reconnect 段验证的是 **Host 重启**+重启后新 turn；矩阵内 turn 2+ 自动带 `resumeSessionId` 但不构成独立验收；R6 回退里的 `thread/resume` 是回退装载，不是对话续接验收。
- **实现方式**：新增场景段或独立驱动：dest host 上原会话 N turn → 会话结束 → **新会话**（新 sessionId）带原 native 会话引用发 turn → 断言适配器走真实续接（Claude `resumeSessionId`；Codex 新会话装载原 thread）且原生历史连续（原生事件计数/条目 digest 前缀匹配），并记录进 recorder（kind 复用 reconnect 或新增 resume 段位——registry 已预留）。若新增段位需 bump sceneVersion（c8）并同步 import 宽度测试。
- **验收标准**：双 Provider 各一份"新会话续接原 native 会话"的真实记录，native 历史连续性有证据；destination `resumeConversation` 有了对应实测背书。
- **预估**：中（1 天，含场景段位扩展与回归）。

### T4（#31）进程重启找回原 worktree 创建操作
- **现状**：A11 已证 worktree 创建、真并行与互斥；C7 剩余"进程重启后找回原创建操作"——创建操作在 Host 进程重启后的恢复/重放语义未验收。
- **实现方式**：以 `worktree.create` 设备命令入口制造"受理后、完成前"的进程崩溃（SIGKILL Host），重启后断言：操作从持久 journal 找回（scheduled → 重派发或显式 unknown，不静默丢失、不重复创建同路径）；受管 worktree 目录状态与 DB 一致。复用 r7 已验证的 45s 停止宽限与 scratch 保留机制取证。
- **验收标准**：崩溃-重启后创建操作有确定终态（completed 或显式失败原因码），无孤儿 worktree/重复目录；记录进 C7 证据。
- **预估**：中（1 天）。

### T5（#18）物理手机验收 —— 唯一硬阻塞
- **现状**：手机最小面板代码已接（会话/中断/Recovery/只读 Diff + 回执核对），缺真机。
- **实现方式**（等 adb 设备后执行）：真机安装 Expo 构建 → 配对 → 验收清单：网络切换（Wi-Fi↔蜂窝）不掉命令、后台恢复续传、审批卡真机可答、中断回执核对；与锁/停止恢复实机验收（C7 剩余）一并做。
- **验收标准**：R9 手机网络切换/后台恢复取证的原始记录；浏览器模拟不替代。

## 5. 非目标与边界（防误读）

- **question 场景（`structuredQuestions`）与 `conversationRewind` 未实现**：registry 已预留段位；发布前不做背书。
- **C0/R0 ES 强监督**：按既定决策移为可选增强，不阻塞主线；普通受管执行契约为准。
- **Developer ID 签名/公证**：留在桌面分发阶段，不作为当前前置。
- **秘密策略不变**：无 token 落盘/日志；auth mode 只查 keychain 存在性；`config/claude-compatibility.json`（用户改动）不动，场景一律用 per-scene 配置。
- **产品层竞争缺口**（一步配对/universal link、移动端完整面板等）：路线图级，见 [竞争差距分析](../competitive-gap-analysis-v2-2026-10-17.md)，不在本收尾清单内。

## 6. 文档索引

- 契约与设计：[核心能力技术方案](../core-capabilities-technical-design.md)（§6.3 含 2026-10-26 状态更新）、[交互场景设计](../design/interactive-scenes.md)（头部验证记录 + 剩余后续）
- 逐日证据与历史：[核心能力实施计划](../core-capabilities-implementation-plan.md)
- 普通执行专题：[macos-managed-execution](../macos-managed-execution.md)、[macos-native-stop-contract](../macos-native-stop-contract.md)
