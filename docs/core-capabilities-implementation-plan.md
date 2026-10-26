# Flyx 核心能力实施计划

> 更新：2026-10-24（Asia/Shanghai）。**开发已恢复**（用户指令按 G0 → M4 → R4 → R6 → R9 顺序继续）；G0 固定源码完整回归已通过；M4 首份生产兼容产物与显式激活闭环已通过；R4 真实恢复与备份恢复外部复核已通过（L1–L4 四层，2026-10-24）；R6 双 Provider Native 回退（L1 生产接线 + L2 真实 Provider 完整回退 A9/A10）已通过（2026-10-24）；R9 组合终验链路已通过（2026-10-24，`host-application.r9-combined.test.ts`：真实 Turn×2 → before/after → Diff → preview → 诚实 executeRevert 拒绝 → workspaceRestore blocked 恢复 → inspect → rollbackToSafety 全链，并修复 7 项生产集成缺陷）；R9 A11 独立 checkout 真并行已通过（2026-10-24，`host-application.r9-parallel.test.ts`）。交互能力场景（审批/中断/重连，c4–c7）已于 2026-10-25 双 Provider 真实验收通过并提交（`5dfa372`）：Claude r8（含 dest-claude 网页审批卡 E2E：卡片弹出→respond→原生确认→allow 落盘/deny 拒绝）与 Codex r7（`det=passed real=passed current=fully-verified`，approval 2/2、interrupt、reconnect，原生证据 complete/invalid 0；含 dest-codex 导入+激活+boot 复核），destination 现发布 `interactiveApprovals`/`interrupt`/`resumeConversation`；修复 `PRODUCER_STOP_DEADLINE_MS=30s`（codex r2/r4 RUNTIME_STOP_UNVERIFIED 根因）等，详见 [交互场景设计](./design/interactive-scenes.md) 头部验证记录。R9 仅剩物理手机验收（缺 adb/设备，暂阻塞待硬件）。当前采用普通 macOS 受管执行，契约以 [技术方案 §4](./core-capabilities-technical-design.md#4-macos-平台契约普通受管执行) 与 [普通执行专题](./macos-managed-execution.md) 为准。
> 下方 2026-10-23 及以前内容保留为历史记录；其中 ES/签名前置和强停止闭包门槛已被本次决策替代，不再代表当前依赖。

## 当前实施与验收（恢复检查点）

| 任务 | 当前状态 | 实现方式与退出条件 |
| --- | --- | --- |
| M0 停止语义 / C0 | 平台与适配器实机通过 | 普通合同 `managed-process-group/v1/darwin`；新增独立 stop kind；普通结果完整树标记保持 false；旧记录不升级；实机覆盖正常退出、根退出后工具、强杀与 unknown。 |
| M1 生产执行 | 后端接线与启动/关闭通过 | Node 受管进程组 + 原私有目录边界，按用途 Git/helper runner；生产 main、在线查询与维护查询统一构造可信端口。无后端/无激活继续拒绝 Native 派发。 |
| M2 恢复与放行 | 契约/组合回归通过；真实恢复另验 | after checkpoint、metadata/checkout lease、startup readiness、inspect/reconcile/acknowledge 消费原契约绑定的停止记录；缺观察/超时/旧记录保持 unknown。 |
| M3 真实 Provider | Claude/Codex 2/2 通过 | 独立临时 checkout/Store/identity；分别记录 CLI/SDK/Node/OS；真实任务与文件结果、中断、受管清理、跨进程续接；失败不登记通过。 |
| M4 兼容证据 / 准入 | **通过（2026-10-24，run-id m4-final2）** | 完整闭环实机通过：prepare（source identity/摘要）→ destination `compatibility authorize`（60 分钟 ticket）→ 真实 10-turn 场景（det=passed real=passed，fully-verified）→ destination `compatibility import`（安装 destination 签名 endorsement + 源签名 evidence log，均 0600）→ `activation verify` → `activation activate`（workspace+provider 双资源，revision 2）→ 普通重启后激活绑定保持。产物摘要：entry `2c6fee52…` / runtime `2a749f23…` / artifact `1e590ebc…`。destination 按 flyx-c3-basic-v1 只请求已验证的 turn 能力（policyCapabilities=`["streamingText"]`），未运行场景不给背书。 |
| G0 固定源码全量回归 | **通过（2026-10-24 恢复后重跑）** | 冻结源码 `5943418`、指纹 `d54ab46c`（360 文件，运行前后一致）；串行 `--maxWorkers=1` 完整运行：142 文件 / 1317 passed / 7 skipped / 0 failed，exit 0，828.78 秒；日志 `/tmp/flyx-g0-20261024.log`、指纹 JSON 同名 `.json`。暂停中断不再作为未完成状态保留。 |
| R4 真实恢复 / 备份外部复核 | **通过（2026-10-24，L1–L4）** | L1 原始终态收据锚点（migration 012 + Claude result 事件即到即记 + Codex 只读在连恢复 reader，`b4699f3`）；L2 恢复检查证据链（afterVerifiedRecoveryInspection 复证原停止链并签名 NATIVE_HISTORY_INSPECT_VERIFIED；manifest scene bootstrap 补 import 前的缺口，`f1c188e`）；L3 备份恢复外部复核（DB 兄弟 0600 launch/stop 顺序账本锚定监督窗口 + createRestoreExternalInspector 生产外部检查器，`fc2b892`）；L4 生产路径端到端恢复链测试（`recovery-production.test.ts`：场景 Host 真实 Turn→收据→恢复检查→签名产物→destination 导入→共享同一持久 Store 的目标 Host 在导入证据上重放 producer_stop_unverified 阻塞→inspect→漂移 fail-closed→reconcile 放行→下一 Turn），并修复 destination endorsement 不携带 recovery 能力/摘录的生产缺陷（`compatibility-import.ts`，先回退修复复测确认 fail-closed 后恢复复测通过）。 |
| R6 Native 回退 L1（生产接线） | **通过（2026-10-24）** | `checkpoint/native-revert-production.ts` 生产接线：`host-application` 在 runner 存在且无受信 `options.execution.revert` 覆盖时构造生产 revert——capability 仅来自可信 R4 manifest（`verifiedManifestForInstance` 必须带 sessionId 走 recovery 域指纹）、`nativeFactory` 把 Engine 持有的 mutation journal 绑到 `HostManagedNativeRevertPort`（per-session `HostManagedRuntime`+`ManagedRuntimeController` 经 `prepareRuntime` seam，绝不借用其它 Session 的边界）、持久 `checkpoint_revert_operations.operation_json` 还原原 dispatch context、`managed_processes` 行级全树停止证明 + `sessions.recovery_state=idle` 组成 quiescence、`captureNativeAnchor` 经 `createCatalogCheckpoints` 第 5 参数接入 checkpoint 采集（manifest 缺失即无锚点，fail-closed）；`host-checkpoints` 能力门修复为接受 `nativeFactory`（原仅认静态 `native`）。组合 fail-closed 测试 8 例（`native-revert-production.test.ts`）+ nativeFactory 端到端回退 1 例（`host-checkpoints.test.ts`）。 |
| R6 Native 回退 L2（真实 Provider 完整回退） | **通过（2026-10-24，A9/A10）** | 真实 codex CLI 0.164.0 app-server 与真实 Claude Agent SDK 0.3.220（glm 后端）双 Provider 真实回退验收（`native-revert.spike.test.ts`，门 `RUN_REAL_CODEX_REVERT=1` / `RUN_REAL_CLAUDE_REVERT=1`，默认 skip）。三语义齐验：真实完整回退→"applied"（Codex `thread/resume`+`thread/revert` 后原生历史实际落在锚点边界；Claude `forkSession` 产新 nativeSession 且 fork 历史条目数与 digest 序列等于锚点、原会话不动）；响应丢失→journal 精确持久边界恢复 "applied"（Codex）/"unknown" 且绝不二次派发（Claude，lossExecutions===1）；claim 与派发之间崩溃→"unknown" 且原生历史零变更。真实运行修正两项生产实现：codex 变异必须先 `thread/resume` 装载持久线程（0.164.0 中 `thread/revert` 对磁盘线程直接返回 -32600 "thread not found"）；Claude 条目 digest 归一为语义字段（`forkSession` 会重映射 uuid/session_id 并重写被复制末条消息的 timestamp）。单元测试同步按真实协议形状收紧（resume→revert 序列、timestamp 重写不变性、beforeTurnId 边界推导）。 |
| R9 组合终验 + 物理手机 | **组合链路通过（2026-10-24）；A11 真并行通过（2026-10-24）；仅物理手机待验收（缺设备暂阻塞）** | 已激活生产 main 中任务 → before/after → Diff → 回退全链已通过（`host-application.r9-combined.test.ts`，含 workspaceRestore blocked 恢复 + inspect + rollbackToSafety，修复 7 项生产集成缺陷，见"本轮证据"）。A11 独立 checkout 真并行已通过（`host-application.r9-parallel.test.ts`：设备命令创建受管 worktree → verify/activate → 两个 checkout 的真实 Turns 在生产入口真正重叠、同 checkout 互斥（second Turn 失败且 adapter 从未 invoked）、Turns/captures/events/文件写入按 Session 与 checkout 隔离无串线）。剩余：物理手机网络切换/后台恢复（本机无 adb/物理设备，暂阻塞待硬件）。普通模式不自动使这些事项完成。 |
| 交互能力场景（c4–c7：审批/中断/重连） | **通过（2026-10-25，双 Provider）** | Claude r8 与 Codex r7 真实全过（Codex `det=passed real=passed current=fully-verified`；approval×2/interrupt/reconnect 原生记录 complete、invalid 0）；destination 导入+激活后发布 `interactiveApprovals`/`interrupt`/`resumeConversation`；dest-claude 网页审批卡 E2E（弹卡→respond→原生确认→allow 落盘/deny 拒绝）+ 双 destination boot 复核。根因修复：`PRODUCER_STOP_DEADLINE_MS=30s`（codex r2/r4 RUNTIME_STOP_UNVERIFIED）、run-matrix bound-后再中断/300s 卡等待/45s SIGKILL 宽限、§6 sceneVersion 信任穿线（导入激活 boot 不再 fail-closed）。剩余后续见 [交互场景设计](./design/interactive-scenes.md) 头部与任务 #28–#31。 |

恢复开发后的顺序：~~G0 固定源码完整回归~~（已通过）→ ~~M4 首份生产兼容产物闭环~~（已通过，2026-10-24）→ ~~R4 真实恢复与备份外部复核~~（已通过，2026-10-24）→ ~~R6 Native 回退（L1 生产接线 + L2 真实 Provider 完整回退）~~（已通过，2026-10-24）→ ~~R9 组合终验（组合链路 + A11 真并行）~~（已通过，2026-10-24）→ ~~交互能力场景 c4–c7（审批/中断/重连）~~（已通过，2026-10-25，双 Provider）→ 剩余仅物理手机验收（缺 adb/物理设备，暂阻塞待硬件）。M0–M3 的平台/适配器证据不替代这些事项。ES 强监督移为可选增强；Developer ID 留在桌面分发阶段，不作为 M0–M4 前置。

暂停时源码基线为 `003faa3254a3fc76a2d624ed4a1c2d5fdf2c36c8`；本轮源码、测试和文档已于 2026-10-24 提交入库并推送（`4af1af5` 普通进程组执行 → `b60852c` 接线与恢复 → `0bbc950` 双 Provider 实机验收测试 → `0345f83` 状态文档，`main` 与 `codex/flyx-optimization` 同点，工作区干净）；交互场景轮（2026-10-25/26）：`5dfa372` 场景实现+停止预算修复+双 Provider 验收 → `20f275c` 验证记录文档 → `c79dd3d` 全量负载 flake 修复，均已推送 `origin/main`，工作区干净。真实 Provider 调用已结束；本轮最终回归已停止，没有继续开发或测试。下述待办保留实现步骤，等待恢复开发后执行。

### 本轮证据

- 2026-10-25（交互能力场景 c4–c7 双 Provider 验收通过）：新增场景注册表 `compatibility-scenes.ts`（c3–c7 版本↔段位↔命令族，`flyx-c7-interactive-v1` = basic×10 + approval×2 + interrupt×1 + reconnect×1）、per-scene 策略 pinning、recorder/provenance 扩展（approval 交互锚点、interrupt 停止证明、reconnect generation pin）、import 携带场景能力、destination 按 endorsement 发布、run-matrix 场景支持与 per-scene 配置（`config/claude-compatibility-{approval,interrupt,reconnect,interactive}.json`，用户改动的 `config/claude-compatibility.json` 不动）。真实验收：**Claude r8**（approval allow→落盘 / deny→拒绝、interrupt turn.cancelled、reconnect Host 重启+重启后 turn；dest-claude 导入激活 + 网页审批卡 E2E + boot 存活）与 **Codex r7**（`fully-verified`：approval 2/2（196s/252s，首次观测到 codex 审批卡）、interrupt、reconnect graceful 关闭+重启后 turn；dest-codex 导入激活 + boot 复核，发布 interactiveApprovals/interrupt/resumeConversation/streamingText/workspaceWrite）。根因修复三项：finalize 停止预算 5s→`PRODUCER_STOP_DEADLINE_MS=30_000` 贯穿 orchestrator/adapters/runtimes（codex r2/r4 RUNTIME_STOP_UNVERIFIED 保留级联根因，r5/r6/r7 basic 10/10 证明）；run-matrix 在 `provider.turn.bound` 后再发 interrupt（否则中断无目标，turn 停留 outcome_unknown、保留所有权阻塞重启）+ 审批卡等待 300s + stopHost SIGKILL 宽限 45s；§6 信任穿线 `macosExecutionFactsTrust`（`macos-managed-execution.trust.test.ts`：验证过的 destination endorsement sceneVersion 穿入执行事实信任，导入的 c7 激活 boot 不再 fail-closed）。r6 复盘：approval rep1 超时为模型跑偏请求工作区外访问被守卫按设计自动拒绝（`CODEX_APPROVAL_OUTSIDE_WORKSPACE`），非缺陷。回归：9 个改动测试文件 95/95、evidence.mjs 13/13；全量 1407/1408（唯一失败为已知负载 flake，`c79dd3d` 修复：清理语义断言不变，closeAndWait 预算 2s→10s）。
- 2026-10-24（R9·A11 独立 checkout 真并行通过）：新增 `apps/mvp-host/src/host-application.r9-parallel.test.ts`——通过真实应用图全链验收 A11 退出条件"生产入口两个独立 checkout 真正重叠执行，同 checkout 互斥，无事件/lease 串线"：(1) 浏览器设备 + WORKTREE_CAPABILITY lease 经 `worktree.create` 设备命令入口创建受管 worktree（WorktreeScheduler accepted 唤醒自动派发，真实 git worktree add，checkout 含基线 tracked.txt）；(2) 该 worktree 工作区走 HostActivationService verify/activate；(3) 主 checkout（legacy Session）与 worktree 工作区（session.createNew 新 Session）各自真实 startTurn——两个 per-checkout adapter 的 `beginTurn` 都进入后才放行（真实重叠证明，`HostExecutionPermits` 上限 2 允许并发），两个 Turn 均 completed、文件写入只落各自 checkout（parallel-main.txt 仅在主、parallel-worktree.txt 仅在 worktree）；(4) 同 checkout 互斥：主 checkout 以 hold Turn 占住 workspace lease 后，另一 Session 在同 checkout 的 Turn 被 `ExclusiveFileLock` HOST_ALREADY_OWNED 拒绝——turn 行 status=failed、adapter 从未 invoked（无 beginTurn 调用）、无 captures；(5) 隔离：per-Session 的 checkpoint_captures（before/after）与 session_events（terminal turn 事件）各自完整、excluded Session 零行，无跨 Session 串线。实现注：gated Turns 停在 adapter 内部时，`execution-worker.drainOperations()` 默认 5s 截止会静默漏 await——测试对 parked outcome promise 显式 await 并用 60s 预算 drain。同轮修复全量回归的持续失败（两次复跑同败）：`connectivity/main-operations.integration.test.ts` 的"restored history 不 prepare/preflight Native Provider"断言 `managed_processes` 计数 0，而 R9 组合链引入的启动期 restore-helper 可用性探测（`createHostCheckpoints().prepare()`，runtime_id="host-git"）会留下一行短命受管 git helper——探测不是 Native Provider 启动，断言改为"所有行 runtime_id 均为 host-git 且已停止"（保持原语义：Provider 运行时绝不被启动）。回归：R9-parallel 1/1；全量 `pnpm test:product` 见提交记录。
- 2026-10-24（R9 组合终验·组合链路通过）：新增 `apps/mvp-host/src/host-application.r9-combined.test.ts`——不 stub 任何 revert 端口的生产组合链全绿：临时 Git 仓库真实 Turn×2（受管 provider 写 tracked.txt/extra.txt）→ before/after capture + `getTurnDiff`×2（文件集与内容差异核对）→ `previewRevert` → `executeRevert` 诚实拒绝（PROVIDER_REWIND_UNSUPPORTED——能力门不虚构 conversation-rewind）→ `workspaceRestore` 受理并由 revert worker 经真实受管 helper 恢复文件（tracked.txt 回 "turn-1\n"）→ blocked NEW_CONVERSATION_REQUIRED + recoveryState=blocked + 新 Turn 拒绝 → `inspectRevert`（safetyRollbackAvailable）→ `rollbackToSafety` → tracked.txt 回 "turn-2\n"。该链路暴露并修复 **7 项生产集成缺陷**（单测因 stub 生产接线全部不可见）：(1) `createCatalogCheckpoints` 原用 `new HostCheckpoints`（helperAvailable 是构造默认）——改走异步 `createHostCheckpoints` 工厂真实执行 helper 探测（`host-application` 相应 `await`）；(2) 无 workspace 的 helper 探测以 cwd=realpath(tmpdir()) 启动被 `allowedCwd` 拒绝（生产默认协调目录就是 tmpdir 下的私有根）——`ManagedGitRunner` 新增 `privateCwd()` 判定（restore helper 从不遍历 cwd，只拒绝 cwd 位于私有根内部；git 侧 `allowedCwd` 双向限制不变）；(3) `restoreOptions` 缺 `runGit`——接入 `runner.restoreGitRunner()`（既有绑定无关、fingerprint/verify 命令集、restore_write 用途适配器）；(4) 回退受理事件自身置 activityState="outcome_unknown"，revert worker 再取 checkout lease 时自死锁（原要求严格 idle）——`ensureCheckpointLease` 按 purpose 区分准入（preview 仅 idle；revert/recovery 接受 outcome_unknown，workspace 即将变更的语义如实放行）；(5) `CheckpointGitDriver` 默认预算（maxFileBytes 64MiB / maxCaptureBytes 512MiB）超 checkpoint_read 策略 32MiB 上限，生产 blob/patch 读取一律 MANAGED_GIT_INPUT_INVALID（请求预算校验先于实际输出，与内容大小无关）——导出 `MANAGED_GIT_CHECKPOINT_OUTPUT_BYTES` 并按 ≤ 上限构造生产 driver；(6) `proveQuiescence` 要求 `recovery_state=idle`，使 blocked 恢复后的 inspect/rollback 证据永久不可用——方案 §11.3 明确部分失败后允许 inspect/resume/rollbackToSafety，改为 blocked（Session 已被围栏禁止新 Turn，journal 停止证明仍是真正门槛）即可判定，`nativeState` 准入保持仅 idle，`native-revert-production.test.ts` 同步收紧（blocked→proven=true；live producer / 缺停止证明仍 fail-closed）；(7) 受管 checkpoint 命令集 allowlist 的生产接线修正（本段早期）。回归：R9 测试 1/1；定向 managed-git-runner / host-checkpoints / native-revert-production / revert-service 87/87；`tsc --noEmit` 干净；全量 `pnpm test:product` 见提交记录。
- 2026-10-24（R6 L2，真实 Provider 完整回退通过，A9/A10）：`apps/mvp-host/src/checkpoint/native-revert.spike.test.ts` 双真实门控场景全绿——Codex（`RUN_REAL_CODEX_REVERT=1` + `FLYX_CODEX_EXECUTABLE=/tmp/codex-cli-probe/node_modules/.bin/codex`，codex-cli 0.164.0 + ChatGPT auth）：真实 3-turn 线程（FLYX_REVERT_L1/L2）→ 锚点"before"（turn-1 边界）→ 完整回退 "applied"（原生 3 turns → 1 turn，实际落在锚点 entryCount）→ 响应丢失（journal 失收据 + tracked port）query 精确恢复 "applied"、lossExecutions===1 原生历史不变；Claude（`RUN_REAL_CLAUDE_REVERT=1`，Claude Agent SDK 0.3.220，glm 后端）：真实 2-turn 会话 → 完整回退 "applied"（fork 新 nativeSession ≠ 原会话，fork 历史 entries 条目数/digest 序列 === 锚点 historyBoundary，原会话历史不变）→ claim 后派发前崩溃（crashing port 单次执行）→ "unknown" ×2、executions===1、原生历史零变更 → 响应丢失 → "unknown" ×2、lossExecutions===1、不重派。默认（无门）2 skipped。真实运行暴露并修复的生产实现缺陷：(a) **codex `thread/revert` 需先 `thread/resume` 装载持久线程**——0.164.0 新 app-server 进程中 `thread/read` 可读磁盘线程但 `thread/revert` 返回 -32600 "thread not found"（探针 /tmp/codex-revert-probe2/3.mjs 验证），port 变异路径补 `thread/resume {threadId,cwd,approvalPolicy:"never",sandbox:"read-only"}` + allowlist；(b) **Claude fork digest 必须归一语义字段**——SDK 0.3.220 投影每条消息为 7 字段且 `forkSession` 重映射 uuid/session_id 并**重写被复制末条消息的 timestamp**（04:28:50.252Z vs 原 04:28:44.807Z，实测），`parseClaudeRevertHistory` digest 收敛为 `{type,message,parent_tool_use_id,parent_agent_id}`；(c) 受管 read 上下文 attemptId 固定为 `native-revert-read:${bindingDigest({sessionId,nativeSessionId})}`（防 anti-rebound 误判）；(d) vitest 下 claude helperPath 指向 src `.ts`（node ≥23.6 type-stripping 直跑；dist 默认路径在 src 树不存在）。单元同步：port execute 断言 `thread/resume`→`thread/revert` 序列、parse 测试覆盖 timestamp 重写不变性、driver 边界推导断言 `beforeTurnId`（首个被丢弃 Turn）。日志 `/tmp/flyx-r6-{codex,claude}-revert*.log`（codex 终跑 427.30s、claude 14.37s）；`tsc --noEmit` 干净；全量回归（2026-10-24，`pnpm test:product`）：mvp-host 1376 passed / 9 skipped（155 文件），全仓 1776 passed / 0 failed，EXIT:0。
- 2026-10-24（R6 L1，生产接线通过）：新增 `apps/mvp-host/src/checkpoint/native-revert-production.ts`——`createProductionNativeRevert({store,owner,catalog,views,manifestSource})` 在 host-application 中默认构造（`runner && !options.execution.revert`，受信覆盖优先；manifestSource 构造上移到 createCatalogCheckpoints 之前共享）。要点：(1) capability 仅来自 `NativeHistoryManifestSource.verifiedManifestForInstance(provider,providerInstanceId,sessionId)` 的可信 manifest（sessionId 走 recovery 域 resourceFingerprint，缺 manifest/版本不含 runtimeVersion 即无能力，fail-closed）；(2) `nativeFactory(journal)` 为每个 RevertService 实例把 Engine 持有的 mutation journal 绑到新 `HostManagedNativeRevertPort`，`prepareRuntime` seam 按 (sessionId,runtimeId) 懒构造独立 `HostManagedRuntime`+`ManagedRuntimeController`（断言 dispatch context 重绑即 `NATIVE_REVERT_CONTEXT_REBOUND`）；(3) 原 dispatch context 从持久 `checkpoint_revert_operations.operation_json` commands[].dispatchContext 按 flyxTurnId===operationId && attemptId===requestId 还原（owner 重启后可复现，行缺失即 `NATIVE_REVERT_OPERATION_UNAVAILABLE`）；(4) quiescence=`sessions.recovery_state='idle'` + 全部 managed_processes 行（not_spawned 或 validateTreeStopEvidence 全树停止证明）；(5) `createCatalogCheckpoints` 第 5 参数把 `captureNativeAnchor`（读端 journal 为拒绝写的 dummy）接入 HostCheckpoints——`native-revert-anchors.ts` 结束零引用；(6) codex executable 取自 catalog provider 记录，claude 走默认 helper 路径。修复 `host-checkpoints.capabilitiesForSession` 门：`(ports?.native || ports?.nativeFactory)`（原仅认静态 native，生产 nativeFactory 永不广告 nativeRewind）。测试：`native-revert-production.test.ts` 8 例组合 fail-closed（无 provider 记录不构造/未验证或无 manifest 或版本不匹配无能力/无第二会话 handle 无能力/quiescence blocked-running-stopped fail-closed-not_spawned 放行/未加载 runtime 拒绝 acquire+dispatchContext/nativeFactory 产出 journal 绑定 driver/无 manifest 不采集锚点/projectSuccess 事务内写新 nativeHandle+epoch）；`host-checkpoints.test.ts` 新增 nativeFactory 广告+完整回退端到端 1 例（20/20）。`tsc --noEmit` 干净；全量回归（2026-10-24，`pnpm test:product`）：mvp-host 1376 passed / 7 skipped（+9），全仓 1776 passed / 0 failed，EXIT:0。

- 2026-10-24（R4，四层全部通过并已提交推送）：L1 `b4699f3` 原始终态收据锚点（migration 012 `native_terminal_receipts` 不可变 (session,turn,attempt) 锚点，Claude result 事件即到即记、首收据优先、损坏行保持缺失；Codex 只读在连 recovery reader，连接退役即 `CODEX_RECOVERY_CONNECTION_RETIRED`）；L2 `f1c188e` 恢复检查证据链（`afterVerifiedRecoveryInspection` 复证原绑定/原终态事件/provider-launch 账本/活 catalog 行后签名 `NATIVE_HISTORY_INSPECT_VERIFIED`，refusal 即 fail-closed；manifest scene bootstrap：import 前由本 run 签名验证过的 turn 基线授权场景自身的只读恢复检查，生产 endorsed manifest 恒优先）；L3 `fc2b892` 备份恢复外部复核（DB 兄弟 `managed-launch-order.jsonl` 0600 顺序账本在恢复换库后存活并锚定备份后监督窗口，`createRestoreExternalInspector` 以受管 Git 只读复核每个 checkout、以可信 manifest 复核每个原生历史，检查自身 launch 以专用 runtimeId 过滤保证观察摘要稳定）；L4 生产路径端到端恢复链（`apps/mvp-host/src/session/recovery-production.test.ts`）+ **生产缺陷修复**：`importCompatibilityRun` 的 destination endorsement 原先只携带 `["turn"]` 能力与 turn 摘录，recovery 检查记录导入后永远进不了 `loadTrustedCompatibilityEvidence` 的过滤集，生产 manifest（要求可信 recovery 条目）在导入后不可能存在——修复为 endorsement 覆盖全部通过能力（`capabilities` 含 `recovery`，`recordDigests` 含 recovery 摘录）。验证方式：先临时回退该修复复测，测试在 endorsement 能力断言处 fail-closed（`expected ['turn'] to include 'recovery'`）；恢复修复后整链通过。L4 测试链路：授权先于任何场景条目签发（满足 import 的 `entry.at ≥ readiness.createdAt − 1s ≥ ticket.issuedAt` 时间序）→ 场景 Host 真实 Turn（真实 orchestrator/ingest/收据 recorder）→ not_spawned 恢复检查经 scene manifest + SDK result transcript 锚点验证 → 补足 10 turns → 导入（含 <10 turns fail-closed 与导入前无 endorsement fail-closed 两分支）→ 生产 manifest（evidenceId=recovery 摘录、错 destination 拒绝）→ 共享同一持久 Store 的目标 Host（`canReleaseWorkspace=false`、无 recorder）重放：Turn 2 producer 停止未验证→durable blocked→`RECOVERY_BLOCKED`→inspect 经**导入的**证据 →transcript 篡改→`RECOVERY_EVIDENCE_STALE`→还原→reconcile released→会话 idle→下一 Turn accepted。全量回归 1367 passed / 7 skipped / 0 failed（148 文件，592.92s，2026-10-24）；`tsc --noEmit` 干净。
- 2026-10-24（M4）：首份生产兼容产物与显式激活闭环通过——run-id `m4-final2`（组合 cli-2.1.216_node-24.18.0，普通合同 managed-process-group/v1/darwin）：`run-matrix --prepare` 生成 source identity 与构建摘要 → destination `compatibility authorize` 签发 60 分钟 ticket → `RUN_REAL_CLAUDE=1 run-matrix --real` 真实 10-turn 场景（det=passed real=passed，fully-verified）→ destination `compatibility import` 原子安装 0600 的 destination 签名 endorsement 与源签名 evidence log（`compatibility-evidence.jsonl`）→ `activation verify`（操作 `de5101c9-76ef-4b7c-a20b-032e400a8b4d`）→ `activation activate --evidence … --command-id m4-explicit-activate-1`（workspace+provider 双资源 revision 2；provider verified，capabilities=`["streamingText"]`；SQL bootstrap 的空 worktreeRoot 由 verify 快照经受管 toplevel 查询决定并持久化）→ activate 后普通重启一次：workspace active/worktreeRoot 保持、readiness_revision 未变、Host 正常监听。产物位于 `.flyx-evidence/cli-2.1.216_node-24.18.0/m4-final2/`（readiness/native/turns/summary），矩阵状态 `fully-verified`。destination bootstrap（`scripts/compatibility/destination-bootstrap.mjs`）现经 `FLYX_CATALOG_CONFIG` 只请求已验证的 turn 能力：首个基本场景只发布实际完成的 `turn`（方案 §6.3），interrupt/approval/reconnect 待各自场景。
- 2026-10-24（M4 运行观察，fail-closed 行为记录）：(1) import 要求 readiness.createdAt ≥ ticket.issuedAt——真实运行完成后再补签发 ticket 无法导入（时间序是授权语义的一部分，非缺陷）；(2) destination 普通启动留下的 owner 记录在该次 SIGTERM 退出后残留，pid 已死时阻塞离线维护 CLI，需按 destination-bootstrap 同款“验证进程已退出后清除”流程处理；(3) isolated 真实运行 Host 崩溃后二次启动会以 `COMPATIBILITY_SCENE_BINDING_CHANGED` 拒绝重入场景（`readHostCatalogBootstrap` 在已有 sessions 时返回空配置，SQL bootstrap 的 worktreeRoot='' 不再被 registerLocal 补全；fail-closed 但错误码有误导性）——source run 单次启动不受影响，后续需要 scope 决策再处理。
- 2026-10-24（恢复后）：G0 固定源码完整回归通过——冻结 `5943418`，串行全量 142 文件 / 1317 passed / 7 skipped / 0 failed，exit 0，828.78 秒；运行前后 360 个 Host/protocol 源文件指纹一致（`d54ab46c`）。日志 `/tmp/flyx-g0-20261024.log`。
- 2026-10-24：普通合同、单层私有/工作区写边界、生产 main/维护 Git、恢复范围与停止门禁已实现。真实 Claude/Codex 2/2 通过（实际工具、跨进程续接、长命令开始后中断、清理）；生产 main 启动/关闭通过，未激活时零 Native 启动。详见 [阶段验收](./analysis/2026-10-24-macos-managed-execution-acceptance.md) 与 [版本/摘要 JSON](./analysis/2026-10-24-macos-managed-provider-results.json)。
- 构建、全工作区 typecheck、Host 测试类型检查通过；protocol 56、client-core 163、mobile 90、Web Node 63 通过。Host 首轮全量 1303 passed / 13 failed / 7 skipped；相关修复已通过 37、2、40 项定向复测。第二轮为 1316 passed / 1 failed / 7 skipped，运行跨越源码修改；新合同隔离断言独立复测 5/5、最终相关定向 35/35 通过。各批次有重叠，不合计为唯一测试数，也未登记 Host 全量通过。
- 暂停中断记录：`/private/tmp/flyx-macos-host-frozen-20261024.log` 与同名 `.json`；运行 50.33 秒，Vitest 退出码 130（SIGINT，包装进程记录 `-2`），`sameSource=true`。此结果只证明运行期间所检查源码未变，不能证明完整回归通过；本轮未重跑完整仓库/浏览器 E2E 或物理手机验收。

## 剩余事项的具体实现方式

### G0：固定源码完整回归（恢复后的首项）

- 先确认保留工作区与当前文档一致，冻结 Host/protocol 源码；记录运行前后源码指纹。使用 `pnpm --filter @flyx/mvp-host exec vitest run --maxWorkers=1 --reporter=verbose` 完整运行并保存退出码、测试汇总和失败日志。
- 若失败，先定位首个真实失败、完成必要修复和对应定向验证，再对新固定源码完成一次完整回归；运行期间继续修改源码的批次不登记为固定版本通过。
- 真实 Claude/Codex 2/2 已有独立阶段证据。后续执行路径、合同或 adapter 若变化，再按影响范围安排真实复测；不将暂停中断算作 Provider 失败或重写已有结果。
- 出口：当前固定版本取得完整结果，失败项有明确处置；随后进入 M4。即使 G0 全绿，也不能替代生产激活、真实恢复/回退与终验。

### M4：首份生产兼容产物与显式激活（已通过，2026-10-24）

> **完成记录（run-id `m4-final2`）**：普通 macOS 受管合同（managed-process-group/v1/darwin）下完整闭环一次通过——`run-matrix --prepare` → destination `compatibility authorize` → `RUN_REAL_CLAUDE=1 run-matrix --real`（真实 10-turn 场景，det=passed real=passed，状态 fully-verified）→ destination `compatibility import`（安装 destination 签名 endorsement + 源签名 evidence log，均 0600 原子落盘）→ `activation verify` → `activation activate`（显式 `--command-id m4-explicit-activate-1`）→ activate 后普通重启一次无回撤。destination 按 `flyx-c3-basic-v1` 只激活已验证的 `streamingText` 能力（§6.3）。interrupt/approval/reconnect 固定场景留待后续扩展。

- 入口：`main.ts` isolated 分支、`diagnostics/compatibility-runtime-facts.ts`、`compatibility-scene-policy.ts`、`scripts/compatibility/run-matrix.mjs`。已有 `createVersionProbeAuthority` 尚须在真实入口组合；不能把本轮 adapter 报告直接塞进激活表。
- 准备阶段固定 source/destination identity、runId、entry/runtime/executable/config 摘要和候选版本；候选不算已观察版本。校验私有授权文件后，仅允许受管 `--version`，用原始 query/stop 记录生成实际 runtime facts；候选不匹配即拒绝。
- 向 isolated application 的 lazy runtime 注入真实 `CompatibilityCommittedRecorder` 与 artifact getter；只在 Engine 原终态提交且该 attempt 停止后记录。普通 contractId 与 stop kind 都进入 provenance 验证，不能设置强停止布尔值。
- 第一份 scene 仍使用现有固定 prompt/commandId、独立 Store/identity/临时 Git 工作区与明确的真实调用开关。Workspace 本地受管核对和 Provider 旧产物激活必须分开，避免首次证据的循环依赖。
- 先通过既有 ≥10 turns 的 basic scene/签名/import/verify/activate；之后分别扩展 interrupt、approval、reconnect 的固定场景。缺某能力的产物不得激活对应 policy capability；不降低计数或跳过 artifact/build/Node/OS 校验。
- 出口：构建后的 main 在独立环境中完成授权 → 真实场景 → 签名产物 → 目标 Host 导入 → verify/activate → 当前权限下派发。普通启动、doctor、verify 不自动调用模型。

### R4：真实恢复与备份恢复放行

- 使用已接线的普通 stop scope；原始 owner/attempt、launchDigest、全部原及后继 helper、Native history 与 checkout clear 都必须匹配。缺原停止观察的崩溃窗口继续 unknown。
- 在 `createCatalogRecoveryBindings` 注入实际 `verifiedManifestForInstance`、checkout inspector、只读 Native history/helper 与它的停止 verifier；分别验证 Claude 捕获 result 锚点、Codex thread/read，不能凭当前 CLI 版本或 transcript 结尾推定原终态。
- 备份恢复不能依赖被恢复的 SQLite 自己证明备份后的活动。增加 Host 私有、独立于待恢复 DB 的受管 launch/stop 顺序日志，绑定 backup 截点/owner/attempt/合同；覆盖缺口、未决命令、磁盘错误继续阻塞。它只记录 Flyx 自己的执行，不引入 ES 系统审计。
- `inspect → evidence/revision → reconcile/acknowledge` 保持 CAS、当前授权与未知命令不重放。confirm 只解除本次可核实 gate，保留 Worktree/回退其他阻塞。

### R6/R9：保留的核心后续

- Native 回退：~~把现有受管 transport、原停止合同与持久 checkpoint/native 锚点接入 `execution.revert`；分别实测 Codex rollback、Claude fork、响应丢失与部分失败~~（R6 L1+L2 已通过，2026-10-24，见顶部与“本轮证据”）。普通中断/续接通过不推导回退可用这一门槛保持不变。
- 终验：在已激活的生产 main 中串起任务 → before/after → Diff → 回退；独立 checkout 真并行；最后验证物理手机的网络切换/后台恢复。已有确定性与浏览器记录继续保留。

---

## 2026-10-23 及以前的历史计划与验收记录（不作为当前平台门槛）

# Flyx 核心能力实施计划（C0–C8）

> 依据：[核心能力交付技术方案](./core-capabilities-technical-design.md)（下称"方案"）。
> 更新：2026-10-23（Asia/Shanghai）；已提交源码基线：`codex/flyx-optimization` / `1108bed69ba97706811833278dec22958be90d0d`；10-22 开始的并行开发位于其上的未提交工作区，验证记录见 §7。同日按模块完成工作区代码与本文档状态的逐项对照，结论同步至 §1–§4，记录见 §7 末条。
> 本文件记录**当前进度、剩余实现方式、依赖、文件责任、退出条件与证据**；契约与发布门槛以方案为准。
> 状态按交付范围记录：`未开始` → `开发中` → `待集成/待验收` → `已验证`；环境或机制缺项另记 `阻塞`。模块验证、生产组合、真实 Provider、物理手机分别记账，不合并成一个完成比例。

## 1. 当前结论与交付边界

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| C0 macOS 监督服务 | **首要阻塞** | audit-token 单节点终止有新增局部实测，完整树闭包仍未证明；尚无满足方案 §4.6 的通过产物，签名监督服务/授权前提也未落实。详见 [R0 审查](./analysis/2026-10-22-macos-supervisor-contract-review.md)。 |
| 生产执行接线 | **组合已接线，默认 fail-closed** | query executor、按用途准入、Checkpoint/Worktree/permit/元数据锁中央组合已在工作区 host-application 接线并有组合级测试；生产 `main.ts` start 仍不构造任何受信 execution 端口，等待 R0 的已验证 macOS backend。工作区代码不等于生产验收通过。 |
| 真实 Provider 验收 | **待环境与实际调用** | 本轮证据只覆盖确定性路径；Claude/Codex 的精确版本、跨进程续接、停止、恢复、回退仍需分别验证。 |
| C8 物理手机验收 | **待环境与人工操作** | 真机、TLS/Tailscale/Relay、网络切换与后台恢复仍未取得验收证据；浏览器模拟不能代替。 |

首版必须支持 **macOS 本机**。C0 阻塞期间可继续实现准入、恢复、Diff 和界面，但这些工作不能解除平台门槛，也不能自动改为 Linux、VM、轮询或单进程限制版。范围继续限定为 Claude/Codex、恢复、Checkpoint/Diff、回退、Worktree 和最小远控。

## 2. 进度总表（2026-10-23，开发中）

| 批次 / 历史任务 | 已完成范围（工作区对照 2026-10-23） | 当前状态 | 剩余交付 / 本文任务 |
| --- | --- | --- | --- |
| C0 | 已有无特权 macOS 探针与失败边界记录；10-22 审查报告 | 阻塞（无变化） | 可交付监督机制与实机停止闭包证明；R0 |
| C1 / W1-A | 窄句柄/原始 launch 已验证；工作区已接线每 Turn 进程边界（终态提交验证→停止证明→after）、stop-before-drain 全局停止端口、共享关闭 deadline、`CANCELLED_BEFORE_DISPATCH` 排队取消 | R1 组合已接线，待全量验证 | macOS supervisor backend 与证据映射（等 R0）；生产 main 注入受信 execution 端口；跨进程续接与真实流验收 |
| C2 / W1-B | 受管 runner 已验证；工作区已实现 `ManagedWorkspaceQueryExecutor` 并按 runner 注入，mutating Git 命令套 repository 元数据锁 | 同 R1（组合已接线） | 生产 main 提供已验证 backend 后生效；supervisor 分支仍限 Linux（等待 R0 的 macOS contract） |
| C3 / W2-D | v11 表/维护 CLI/加载诊断已集成；工作区已实现在线按用途 gate（组合层 `assertNativeReady` 拆分）、`restoreWriteReady` 收紧、scene policy、签名产物+隔离握手+authorize/import CLI 接 main | R2 组合已接线；R3 部分接线 | 实际监督/运行事实注入（等 R0/R1）；recorder 接 adapter/recovery 事件源；isolated-real 通道端到端可用与产物实际源验证 |
| C4 / W2-E | `NativeHistoryReaderFactory` 已注入 CatalogRecovery（绑定一致性校验）；restore inspect/confirm CLI 与 `restore_check` 收据状态机已注册；同 owner 重复 helper 正向恢复已补测（fixture 级） | R4 部分接线 | 生产 verifiedManifest 来源（当前恒 unknown）、真实外部检查器（CLI 占位拒绝）、备份后真实外部状态验收 |
| C5 / W2-F | HostCheckpoints 中央构造并注册为首个 domain port；bindWorker/executionBinding 注入；固定顺序（permit→lease→before→终态→停止证明→after）；captureBefore 失败先于 prompt；projector v4 | R5 组合已接线 | 生产启用依赖 runner 注入（R0/R1）；A8 精确 Diff 场景与捕获失败/业务结果分离验收 |
| C6 / W2-G | Codex rollback / Claude fork 驱动 prepare/apply/query 与响应丢失 unknown 语义完成；受管 transport（StdioAppServerClient+node helper）已实现；**生产接线完成（2026-10-24）**：`native-revert-production.ts` 默认构造 + `nativeFactory` journal 绑定 + `captureNativeAnchor` 接入 + manifest 门控 capability | R6 L1+L2 已通过（2026-10-24）；R9 组合链路（含 preview 拒绝、blocked 恢复 inspect 与 rollbackToSafety）已通过（2026-10-24） | 剩余：A11 独立 checkout 真并行随 R9 收尾；resume（新会话续接）生产实测 |
| C7 / W1-C | 调度/fence 已验证；工作区已实现任务 permit（首版 2）+锁序、common-dir 元数据锁（unknown retain/跨重启恢复）、scheduler SQL 扫描修复、managed/scheduled HostWorktrees 中央接线、归档/恢复互斥与路径冲突观测；A11 生产入口真并行/互斥/隔离已通过（2026-10-24，`host-application.r9-parallel.test.ts`） | R7+A11 已通过（2026-10-24） | 剩余：锁/停止恢复实机验收（随物理手机）；进程重启找回原创建操作 |
| C8 / W3-H、W3-I | CoreControls 共享控制器、Web 四面板全接线（含真实 Host E2E：会话元数据/草稿/readiness）、手机最小面板与回执核对 | R8 开发中，浏览器部分已测 | Recovery/Diff/Worktree/Revert 浏览器 E2E；网页端真实中断 E2E 留档（入口统一已完成，见 2026-10-26 核实）；最终生产构建、双 Provider 与物理手机（R9） |

以下是 `1108bed` 已核对缺口在当前工作区的对照结果（实现均未提交，尚需 §7 的独立验证；"已接线"指组合代码存在于生产模块并有定向测试，不是生产验收通过）：

- [Host 主入口](../apps/mvp-host/src/host-application.ts)：激活断言、query executor、HostCheckpoints/受管 HostWorktrees/Scheduler 组合**已在工作区接线**（checkpoint port 为首个 domain port）；但全部位于 `options.execution` 受信端口之后，生产 `main.ts` start 入口不构造任何 backend，默认 fail-closed（等待 R0）。
- [Git runner](../apps/mvp-host/src/lifecycle/managed-git-runner.ts)：supervisor 分派已契约化（新增 platform/spawn 校验、repository 元数据锁、shutdownService），**生产 backend 仍限定 Linux 且无生产构造点**。
- [激活服务](../apps/mvp-host/src/lifecycle/host-activation-service.ts)：在线 Host 已构造 `HostActivationService` 并经 `assertNativeReady` 在 host-catalog/orchestrator 多处调用。
- [兼容 runner](../scripts/compatibility/run-matrix.mjs)：签名产物、隔离 readiness 握手、authorize/import CLI 已接 main；**`CompatibilityEvidenceRecorder` 仍未接任何 adapter/recovery 事件源**（`afterCommittedNativeStop` 零引用），main 的 isolated 模式因无 execution 端口当前不可用。
- Web/mobile/client-core 已接 CoreControls/Web 四面板/手机最小面板；**缺 Recovery/Diff/Worktree/Revert 浏览器 E2E 与真机验收**。

## 3. 剩余任务的实现方式

以下文件路径中，Host 模块相对 `apps/mvp-host/src/`；标为“拟新增”的文件和方法仍属于待实施设计。每项都要分别报告模块、生产组合及实际运行证据。

### R0 / C0：证明 macOS 监督契约（P0，阻塞）

**责任范围**：拟新增 `native/macos-supervisor/`、`lifecycle/macos-supervisor-client.ts`；扩展 `scripts/native-stop-contract/` 和 `docs/macos-native-stop-contract.md`。协议按方案 §4，不先扩大到通用监控服务。

1. 先建立前置清单：entitlement、签名身份、安装/授权与正常 SIP 的目标 Mac；每项记录实际状态和证据，不能以 CI fixture 代填。
2. 对两个未证实条件单独给出机制与反例：**按原始身份终止且消除 PID 复用竞态**、**fork/exec/exit 与 stop 并发时的事件完成屏障**。ES 序号连续、静默等待和扫描均不是完整证明；若没有可成立机制，记录候选失败及具体阻塞，停止提升其可用状态。
3. 机制成立后实现最小 IPC：assess/registerHost/prepareLaunch/releaseLaunch/stopTree/inspectOriginal；负载以当前用户运行。先提交 launching，再建立启动屏障与原始绑定，持久提交后才 release。
4. 持久日志绑定 launch/owner/generation/boot/原始身份/谱系/策略；Host 校验服务与调用方身份。事件丢失、服务重启、写日志失败一律使相关开放 launch 为 unknown。
5. 扩展现有探针，实际覆盖方案 §4.6 的逃逸、身份变化、快速 fork/exit、停止期间新后代、Host/服务崩溃、事件丢失与写入屏障；出具可接受或阻塞结论。

**退出条件**：实际目标 Mac 上五项停止必要条件均有机制说明与原始证据，冻结 contract/version。仅取得权限、成功启动服务或能 kill 根进程均不能完成 R0。没有可信原证据的旧记录保持 unknown。

### R1 / C1–C2：接入真实 macOS 执行器与 Turn 生命周期（P0，生产验证依赖 R0）

**责任范围**：`lifecycle/managed-child-handle.ts`、`managed-process-registry.ts`、`native-boundary-proof.ts`、`managed-git-runner.ts`、`managed-workspace-query.ts`；`provider/native-runtime-factory.ts`、`claude/adapter.ts`、`codex/app-server-client.ts`、`codex/adapter.ts`、`session/orchestrator.ts`，以及中央组合。

**工作区状态（2026-10-23 对照）**：第 4、5 条与第 3 条的中央组合已接线（orchestrator 固定 Turn 顺序、lifecycle `stopProducers`→drain、共享 deadline、`CANCELLED_BEFORE_DISPATCH` 排队取消）；第 1、2 条的 supervisor 分派契约与 `ManagedWorkspaceQueryExecutor` 已实现（含 platform/spawn 校验、repository 元数据锁），但无生产 backend 构造点，`main.ts` start 也不注入 `execution` 端口。剩余：R0 交付已验证 macOS backend 后的生产注入与真实流验收。

1. 在现有窄句柄上增加 supervisor 实现，将经验证的原始身份、stdio、exit/error/背压和 stop/query 映射进 registry/journal；增加版本化 macOS proof 变体，不能直接把外部 `stopped:true` 转成可信结果。
2. 将 Git runner 当前 Linux 专用分支改成按**已验证 backend contract**分派；缺合同仍拒绝，不能只删除平台检查。以该 runner 实现 `ManagedWorkspaceQueryExecutor`，在在线 Host 与 maintenance CLI 分别绑定当前 owner/operation 并注入。
3. 同一 Host 组合统一提供 query、Checkpoint、旧 Git Diff、Worktree、Restore 的受控端口；保留用途白名单、冻结 argv/env/cwd、原 launch 与后继 helper 记录。列举并检查全部生产直启路径，避免 legacy Diff 漏接。
4. 按方案 §5.3 实现每 Turn attempt 的进程边界：业务终态后先结束相关 Provider/工具后代并证明停止，再 captureAfter、释放 checkout；下轮用持久 NativeHandle 启动新受控进程续接。常驻 app-server 的 idle 不作停止证明。
5. 将全局 runner 的 **stop** 接入 Host 的 `stopProducers` 阶段，再 drain operation/service；当前通用 service 仅有 drain/seal/close，需增加最小显式停止端口或等价固定接线，不能把停止放在 drain 后。封闭新 launch、限定共享 deadline、同步 fence，未知时保留 owner/lease。

**退出条件**：真实 macOS query/Git/helper 与双 Provider 的流关闭/中断/跨进程续接通过；helper 超时与关库重叠时先停止再排空；迟到回调不写库或发布；原启动证据不可替换。模块可先用显式 fixture 验证，生产完成必须等待 R0。

### R2 / C3：在线强制准入与实际运行事实（P0，可先完成拒绝路径）

**责任范围**：`host-application.ts`、`main.ts`、`catalog/host-catalog.ts`、`lifecycle/host-activation-service.ts`、`host-activation-load.ts`；涉及 Session、Interaction、Checkpoint、Worktree 的现有 admission 端口。

**工作区状态（2026-10-23 对照）**：第 1、3 条已实现——组合层拆出 `assertNativeReady`（先 `assertBusinessReady`，有 scene 授权走 `nativeScenePolicy.assertResource`，否则 `assertReadyForWrite`），`restoreWriteReady` 收紧，startTurn 受理/`beforeDispatch`/`revalidateDevice` 多点复核；排队取消见 R1。剩余：第 2 条实际监督/运行事实（等 R0/R1）与 fixture 正向激活→受理→派发、拒绝矩阵的全量验证。

1. 在线 Host 复用现有 `HostActivationService.assertReadyForWrite`；共享同一 load、Store 和 observation，维护 verify/activate 仍只开放本地 CLI。若需提取小的断言端口，保持现有撤销/CAS 语义，不另写第二份 readiness 判定。
2. `localActivationFacts` 注入实际监督合同、SDK/adapter/runtime 指纹和兼容证据来源；`HostActivationLoad`、maintenance verify、在线断言读取同一事实，缺失即给出精确原因。
3. 按下表替换大范围 `assertBusinessReady`。授权、owner、restore、原始 producer、资源与 lease 条件在各自边界复核；不能把所有操作都绑到“新 Provider 激活”。

| 用途 | 落点与检查 |
| --- | --- |
| 历史/回执/readiness | Store、当前设备权限与资源可见性；不加载 Provider、不启动查询进程 |
| 新 Native 命令 | 受理前及 worker 派发前检查目标 workspace/provider 激活、当前授权、原 producer/restore gate、实际 lease；排队期间变化仍拒绝派发 |
| 新 Git/Worktree 变更 | 检查源 repository/checkout、监督及该用途的执行策略、相关 lease/共享锁；不要求无关 Provider 已激活；新 workspace 未完成验证前不允许发任务 |
| 已受理操作后续步骤 | 绑定原 operation/attempt/资源、当前权限与步骤所需实际后端；只精确排除该操作自己建立的 gate，不跳过其他阻塞；尚未交付的 prompt 仍按新 Native 派发检查 |
| 中断/取消/审批/Question | 重查原活跃 attempt、授权、版本和控制通道；激活过期不能阻止停止，审批/Question 不因旧快照而绕过当前规则 |
| Recovery | 使用原目标身份、证据 revision/有效期和当前权限；不要求目标先 idle 或先重新激活 |
| 元数据写入 | 新建/命名/归档按各自权限与状态约束；登记 Session 不启动 Provider，归档不能替代进程停止 |

4. gate 失效写入精确原因并撤销相关 readiness；事务受理后另有异步步骤时，于实际副作用前重查。公开 RPC 的 readiness 只是提示，不能当授权票据。

**退出条件**：真实主入口在无后端/未激活时只读且零 Native 启动；输入漂移/过期在下一次派发前拒绝；历史、停止和原始恢复仍能使用；fixture 正向激活→受理→派发与拒绝矩阵通过。真实正向链路另依赖 R0/R1/R3，不能因为本机无法激活继续保留无强制 gate 的生产路径。

### R3 / C3：补全兼容产物生产与独立验证入口（P1，真实运行依赖 R0/R1）

**责任范围**：`diagnostics/compatibility-evidence.ts`、Provider/recovery 事件接点、`main.ts`、`scripts/compatibility/run-matrix.mjs`、`scripts/compatibility/evidence.mjs`、现有兼容配置。

**工作区状态（2026-10-23 对照）**：第 1–3 条大部分已实现——Ed25519 签名产物（canonicalJson+指纹绑定）、隔离 readiness 握手（0700 目录/0600 文件、入口 digest/runId/Node/OS 匹配、loopback 限制）、authorize/import CLI 已接 main（maintenance owner+identity mirror），逐能力计数（≥10 turns）在 import/evidence 脚本强制。剩余：`CompatibilityEvidenceRecorder` 仍未接任何 adapter/recovery 事件源（`afterCommittedNativeStop` 零引用）；main isolated 模式因缺 `execution.compatibilityArtifact` 端到端不可用（抛 `COMPATIBILITY_RUNTIME_FACTS_UNAVAILABLE`）；真实场景产物验证未做。

1. 接通 recorder 的真实来源：记录实际 executable 摘要、SDK/adapter/Node/配置/监督合同、场景集版本、原 launch/stop 引用和逐能力结果。私有产物验证规范化摘要与 Host 身份签名，不能只接受人工修改的 `verified` 状态。
2. 修复 runner 与生产 main 的 readiness 握手：通过仅本地、隔离验证模式输出受限私有文件，绑定 runId、构建/入口、Host 身份和观察版本；原子写入、0600、拒绝陈旧或错 runId 文件。配对材料只存在隔离目录，不写日志或公开 RPC。
3. 在独立 Store/identity/fixture checkout 运行固定兼容场景。入口只放行本地固定场景和已验证监督后端，不新增远程绕过激活的通用开关，不能要求用户生产资源先激活才能生成首份证据。
4. **现有 `activation verify` 只验证资源并消费已有兼容证据，不调用模型。** 付费场景由专用兼容命令显式启动，保留 `--real` 与对应 `RUN_REAL_<PROVIDER>=1` 双条件；常规启动、doctor、页面选择不触发。
5. 补 Claude/Codex 两类行；C3 覆盖任务、续接、审批允许/拒绝、Question、中断及停止，R4/R6 完成后才增加 recovery/rewind。未覆盖能力不发布，避免 C3 反向依赖全部后续阶段。

**退出条件**：生产构建握手可读、recorder 端到端产物可校验；错误版本/签名/合同/场景缺失被拒绝；两 Provider 的已验证基本能力可被 activation 消费。只跑 deterministic 或版本查询不得升级真实兼容状态。

### R4 / C4：原始恢复与 restore 外部复核（P1）

**责任范围**：`session/catalog-recovery.ts`、`session/host-recovery.ts`、拟新增 `provider/native-history-reader.ts`、`operations/restore-service.ts`、恢复 CLI 与中央组合。

**工作区状态（2026-10-23 对照）**：第 1、3、5 条结构接线完成——`NativeHistoryReaderFactory` 默认注入 CatalogRecovery（绑定一致性校验 `NATIVE_HISTORY_BINDING_CHANGED`），restore inspect-state/confirm-state CLI 已注册并使用 `host_execution_operations(kind=restore_check)` 完整状态机，readiness gate 增加 backupManifestDigest 绑定。缺口：生产 `verifiedManifestForHandle` 恒 `undefined`（原生读取恒 unknown）；main CLI 的 `inspectExternal` 为占位（抛 `RESTORE_EXTERNAL_INSPECTOR_UNAVAILABLE`），真实外部检查器只在测试注入；第 4 条 CAS/supersession 语义已有，同 owner 重复 helper 正向恢复已补测（见 §7 10-23 记录；仍不据此登记真实 Provider 恢复完成）。

1. 实现 `NativeHistoryReaderFactory`，通过明确的新注入端口接入 CatalogRecovery；保留现有 existing-reader 路径。只选绑定一致的受管连接，或在显式 inspect 中启动有界 inspection-only helper；普通历史读取不能构造 Native。
2. Codex 仅允许已验证 `thread/read` 等只读请求；Claude 读取锁定版本 transcript 与真实锚点。加载按原 provider/config/version 匹配的可信 manifest，不能把当前激活或字符串搜索当成原操作终态。
3. 中央注入 `verifiedManifestForInstance`、原 launch/boundary inspector、checkout inspector 和 history reader；离线恢复使用原 `checkoutRoot`，复核全部原始及后继 helper，检查自身也必须停止。
4. `inspect → evidenceId/recoveryRevision → reconcile/acknowledge` 沿用现有服务；动作后 CAS 更新 receipt/intent、交互 supersession 和权威投影。过期、失联、身份变化时重新 inspect，未知 prompt 不重发。
5. 本地 maintenance 新增 `restore inspect-state/confirm-state`：复核备份身份与内容、备份后监督日志、当前 checkout/refs/Native history；用现有 `host_execution_operations(kind=restore_check)` 保存检查收据。confirm 必须重查绑定和 revision，只解除可证明的 restore gate，保留其他原操作阻塞。

**退出条件**：A4/A6/A7；Host 崩溃前后仍按原 commandId/attempt 核对；旧 DB 缺 receipt 不推出未执行；证据缺失/过期不放行；确认 unknown 也不能替代停止与 checkout 证据。真实恢复通过后由 R3 记录相应能力。

### R5 / C5：Checkpoint 生产组合与 Diff（P1）

**责任范围**：`checkpoint/host-checkpoints.ts`、`session/orchestrator.ts`、`host-application.ts`、现有 Checkpoint RPC/client；UI 由 R8 接入。

**工作区状态（2026-10-23 对照）**：第 1–4 条已实现——`createCatalogCheckpoints` 全局构造并注册为首个 domain port，`executionBinding`/`bindWorker` 在 `executionSetup` 注入；orchestrator 强制 permit→lease→baseline→before→终态提交验证→停止证明（`stopped && treeStopped` 否则 `retainExecution`）→after 顺序，`captureBefore` 失败先于 prompt 交付；projector 升 v4（checkpoint 摘要白名单投影）。剩余：生产启用依赖 runner 注入（R0/R1）；A8 精确 Diff（staged/unstaged/binary/symlink/rename/unborn）与捕获失败/业务结果分离的全量验收。

1. 在全局 Catalog/Views 建立后构造唯一 `HostCheckpoints`，注入 R1 受控 Git、实际权限、lease 与 runtime state；通过现有 domain port 注册方法/scopes/capabilities。
2. 在每个 lazy runtime 启动 worker 前注入 `executionBinding`、调用 `bindWorker()`；`runtimeState/leaseForContext/captureStateFor` 从实际 runtime 与原 dispatch 产生，不从 RPC body 拼造。
3. 执行顺序固定为 lease→before→prompt→业务终态→原树停止证明→after→Diff 发布→释放 lease。R1 负责 Turn 进程终止，Checkpoint 只消费已核实事实，不能自行写死 `producerStopped:true`。
4. before 失败必须发生在 prompt 交付前；after 失败保留已知业务终态并显示 unavailable/raced。当前 `finalizeTurn` 的失败会保留 execution，需要在可证明 helper 已停止时区分 Diff 失败和原执行未知；不能直接无条件释放或永久阻塞。
5. 使用临时 index/hidden refs，保留 staged/unstaged/untracked、binary、symlink、rename 等支持状态；legacy 缺锚点不补造归属。分页和正文引用继续沿用现有预算。

**退出条件**：A8/A12，生产 main 产生可核对 before/after 与 Turn Diff；真实 index 不被污染，外部编辑标 raced；helper 不明时仍保留 lease，纯 Diff 失败不改写 Provider 业务结果。

### R6 / C6：双 Provider 原生回退（P1，依赖 R4/R5）

**责任范围**：`checkpoint/revert-types.ts`、`checkpoint/revert-service.ts`、Provider 专用 driver（拟新增）、实际原生锚点采集及兼容记录；UI 由 R8 接入。

**工作区状态（2026-10-24 对照）**：第 1、4 条完成——`CodexNativeRevertDriver`（thread/rollback）/`ClaudeNativeRevertDriver`（forkSession）prepare/apply/query 齐备，query 只读本 operationId+requestId journal、无记录即 `unknown(no_original_dispatch)`、Claude 歧义一律 unknown、journal claim 防二次回退；`HostManagedNativeRevertPort`（真实 StdioAppServerClient+node helper+全树停止证明）已实现。**生产接线（R6 L1）已完成（2026-10-24）**：新增 `checkpoint/native-revert-production.ts` 由 `host-application` 默认构造（runner 存在且无受信 `options.execution.revert` 覆盖时；受信覆盖仍优先），`createCatalogCheckpoints` 扩展第 5 参数把 `captureNativeAnchor` 接入 checkpoint 采集——`native-revert-anchors` 不再零引用；capability/manifest 一律经可信 `NativeHistoryManifestSource.verifiedManifestForInstance`（带 sessionId，recovery 域指纹），driver 经 `nativeFactory` 绑定 Engine 持有的 mutation journal，port 的 `prepareRuntime` seam 为每个 (sessionId,runtimeId) 构造独立 `HostManagedRuntime`+`ManagedRuntimeController`（不复用其它 Session 的执行边界）；原 dispatch context 从持久 `checkpoint_revert_operations.operation_json` 还原（owner 重启后仍可复现）；quiescence 由 `managed_processes` 行级 `validateTreeStopEvidence` 全树停止证明 + `sessions.recovery_state='idle'` 组成；Claude helper 走默认 `provider/native-revert-helper.js`（restrictedEnvironment 继承 ANTHROPIC_AUTH_TOKEN，与 adapter 一致）。`host-checkpoints.capabilitiesForSession` 门修复为接受 `nativeFactory`。组合 fail-closed 测试见 `native-revert-production.test.ts`（8 例）与 `host-checkpoints.test.ts` nativeFactory 端到端用例。真实 Provider 完整回退验收（A9/A10）已于 2026-10-24 通过（见“本轮证据” R6 L2 条目：真实 codex 0.164.0 与 Claude SDK 0.3.220 双门全绿，真实运行修正 resume-then-revert 与 fork 语义 digest 两项实现）。剩余：第 3 条 preview/safety 生产场景；复杂文件恢复 unknown 与受管 Worktree 两项 unknown 已定位修复（见 §7 10-23 记录），临时路径别名已在生产者端 canonicalize。

1. 分别实现现有 `NativeRevertDriver.prepare/apply/query`：Codex 以 `thread/read` 确认原生 Turn 边界，再按实际 turn 数 rollback；Claude 以真实 messageId 执行 `forkSession(upToMessageId)`，保留原会话。
2. 在真实事件/历史中持久 Native session/turn/message 与 before/after 的映射；优先使用已有 NativeHandle/Checkpoint 版本化元数据，不用 Flyx Turn 序号猜偏移。
3. preview 绑定 actor、Session revision、epoch、checkout/index/原生锚点和有效期；执行重查并 capture safety，按现有阶段 journal 逐步推进，所有 helper 都走 R1。
4. 原生副作用前持久原 requestId/绑定。响应丢失后 `query` 只能检查该步骤：Codex 比对目标历史边界；Claude 需要能唯一核对原 fork 的结果，否则返回 unknown。原生无幂等键或不可唯一定位时不再次 fork/rollback。
5. 部分失败保留 safety 与 lease，提供 inspect/resumeVerified/rollbackToSafety；`workspaceRestore` 必须新建 Native 会话并标历史不连续。仅内存裁剪或文件恢复不能发布 conversation-rewind。

**退出条件**：A9/A10；两个 Provider 分别完成真实完整回退、响应丢失和阶段崩溃恢复；unsupported 只代表明确拒绝，不算该 Provider 完整回退交付。参考方案 P04/T04 的具体映射，继续复用 Flyx 自身 journal。

### R7 / C7：Worktree 与会话实际组合（P1）

**责任范围**：`workspace/host-worktrees.ts`、`worktree-scheduler.ts`、`workspace-lease.ts`、`worktree-git.ts`、Session worker 及中央组合；UI 由 R8 接入。

**工作区状态（2026-10-23 对照）**：第 1–6 条主体已实现——`HostExecutionPermits`（首版 2，FIFO/abort/seal，producerStopped 才归还）经中央注入 orchestrator 并注册 shutdown；`RepositoryMetadataLocks`（common-dir realpath 排序短锁、锁序断言、unknown retain、跨重启恢复）套住 `update-ref`/`worktree add|move|remove`；scheduler 扫描改 SQL 直查（修 1000 行上限缺陷）；`createManagedScheduledHostWorktrees` 中央接线（accepted→scheduler.accepted、stopContractId 校验）；归档/恢复走同 checkout lease，路径冲突显式 `WORKTREE_PATH_CONFLICT`。剩余：生产启用依赖 runner/worktreesRoot 注入；A11 独立 checkout 真并行、锁/停止恢复的实机验收。

1. 全局构造 `HostWorktrees`，注入真实 WorktreeGit、当前 DeviceRegistry、原停止证明、恢复授权与 runner close/seal；注册既有 RPC，`accepted` 提交后唤醒 scheduler，服务就绪后作启动扫描。
2. scheduler 只调度当前 owner/generation 的固定 pending Worktree intent，复用 `dispatchAccepted` 唯一 claim。旧 owner 或 claimed/unknown 走恢复；补中央接线测试，不能只用直接实例化的模块测试证明服务已上线。
3. 补 Host 的实际任务 permit（首版 2）与 checkout lease；Worktree scheduler 的并发上限不能当成 Provider Turn 全局上限。等待项保留 queued，取得资源后才派发；interrupt/审批/恢复走独立控制 lane。
4. 同 checkout 的任务、回退、归档/恢复写互斥；共享 git common dir 的变更使用短 repository 锁，按固定顺序取锁，不持有共享锁等待整轮模型。失败或停止未知时不归还可复用写权限。
5. 沿用两段流程 `worktree.create → workspaceId → session.createNew`，各保留 commandId/receipt；新 workspace 单独验证/激活后才能运行。归档停止对应 runtime 并保留 staged/unstaged/untracked，恢复核对原绑定，禁止覆盖未知同名目录。
6. scheduler 封闭、Git 停止、operation drain、同步 seal 和关库纳入 R1 的全局关闭顺序；已有 `HostWorktrees.seal()` 幂等 fence 保持不释放 lease、不推导 stopped。

**退出条件**：A11/A12；生产入口两个独立 checkout 真正重叠执行，同 checkout 互斥，无事件/lease 串线；进程重启可找回原创建操作，归档/恢复及 unknown 核对通过。参考方案 P03，不扩展 PR checkout/setup scripts。

### R8 / C8：最小 Web 与手机操作闭环（P1，可提前开发不依赖 Native 的界面）

**责任范围**：`apps/mvp-web/src/app.tsx`、`use-host.ts` 及小面板/控制器；`packages/client-core/src/{session,recovery,checkpoint,worktree}-client.ts`；`apps/mobile/src/`。

**工作区状态（2026-10-23 对照）**：第 1–4、6 条大部分已实现——`CoreControls` 共享控制器（会话/中断/Recovery/Turn Diff+回退/Worktree 全链路，Outbox 防重+generation 隔离+稳定 commandId 续建第二份回执），Web 四面板全接线并移除旧会话选择器，真实 Host E2E 覆盖会话元数据闭环/草稿隔离/readiness 原因码（断言零 Provider 构造），手机接最小面板（会话/中断/Recovery/只读 Diff）+回执核对。剩余：Recovery/Diff/Worktree/Revert 的浏览器 E2E 场景（A5/A6/A13 其余部分）；网页端真实中断 E2E 留档（2026-10-26 核实：Web interrupt 入口已统一走 `CoreControls.interrupt()`→`session.interrupt`，此前“仍走 host.interrupt 未统一”的记录过时，`host.interrupt` RPC 并不存在）；复杂回退/归档按计划留在 Web；真机与生产构建归 R9。

1. Web 先接 Session 新建/命名/归档/关闭运行时和资源选择；会话创建后保持 Provider/workspace 绑定，“换 Provider”通过新会话完成。readiness 展示可读、可执行与待核对原因。
2. Recovery 面板直接消费 `RecoveryEvidence.nextSteps`，保留原 attempt/evidenceId/expectedRecoveryRevision；明确选择 unknown acknowledgement 后才提交对应语义，动作完成后重读权威快照。
3. 接 Turn Diff/单文件、preview、回退操作进度与 inspect/resume/safety；操作按钮由当前能力与状态决定，不支持时展示具体原因。
4. Worktree 面板保留创建与 Session 创建两份回执，刷新后从原 operation 继续；失败/超时只读核对，不能重新生成 commandId 建第二份资源。
5. 复用应用级 client-core runtime 与 durable Outbox；选择/传输/副本 generation 隔离旧响应，保留草稿和原命令。React 卸载不关闭远程任务，网络恢复不重发未知写。
6. 手机复用现有配对、安全存储、SQLite、NetInfo/AppState 和 Relay；首版只接会话、任务、审批/Question、中断、Recovery、只读 Diff 与已建工作区选择。复杂回退/归档先由 Web 完成。

**退出条件**：A5/A6/A13 的实际 Gateway/Web 用例通过；浏览器刷新、断线、快速切换不重复任务、不串会话。手机代码接通与物理手机验收分开记录，后者交由 R9。

### R9 / C8：生产构建、双 Provider、真机与交付记录（P1）

**责任范围**：现有产品/兼容/E2E 测试入口、隔离 fixture、运行手册和证据目录；不新增一套通用验收平台。

1. 以最终精确 commit/构建摘要运行完整 `pnpm test:product`、相关 typecheck 与生产 main 验收；单次全量退出码和失败文件单独保存，失败后定向重跑不能改写全量结论。
2. 方案 A1–A15 建立到具体套件/场景/原始产物的映射。失败注入覆盖受理、原生派发、业务终态、停止、回退步骤与最终发布，不只测试 happy path。
3. 在目标 macOS、锁定监督合同与各 Provider 精确版本下，分别完成 10 次普通任务、10 次审批（含拒绝）、10 次中断、3 次恢复、3 次成功完整回退；Question/unsupported 另记。未经实际运行不填写通过次数。
4. 物理手机验证 Direct/Tailscale/Relay 对应路径、Wi-Fi/蜂窝切换、后台 30 秒/5 分钟及杀进程重开；记录认证/同步与原 commandId，无重复任务或缓存审批执行。
5. 运行手册补安装与授权、身份核对、兼容验证、激活、unknown 处理、备份/外部复核、升级失败恢复；敏感产物仅保存私有引用，提交材料只保留脱敏摘要。

**退出条件**：方案 §16.4 全部满足。C0 未通过、某 Provider 缺完整回退、真机未验证或最终构建未完成验收时，明确列为未交付项。

## 4. 实施顺序与固定中央责任

| 顺序 | 可开展工作 | 必须等待的条件 |
| --- | --- | --- |
| 第零阶段（当前） | 工作区收敛：Luna 完整 `test:product`/typecheck 全量验证后提交；R6 两项 unknown 与临时路径 canonicalize 定位；R3 recorder 接 adapter/recovery 事件源（不依赖 R0）；R4 verifiedManifest 来源设计；R8 剩余浏览器 E2E（Recovery/Diff/Worktree/Revert） | 本阶段不产生真实执行；不提升 C0/真实 Provider/手机状态 |
| 第一阶段 | R0 机制/前置证明（仍为 P0 阻塞，可与第零阶段并行推进） | entitlement/签名/目标 Mac 前置清单；C0 结论不得由其他任务替代 |
| 第二阶段 | R1 生产 main 注入受信 execution 端口（git runner backend/worktreesRoot/query executor）→ R2 实际监督/运行事实 → R3 isolated-real 端到端与真实产物 → 激活正向闭环 | R0 冻结的 macOS 监督契约 |
| 第三阶段 | R4 真实外部检查器/manifest；R5 生产 capture/Diff 验收；R7 独立 checkout 真并行；R6 生产接线+持久锚点+真实回退；R8 对应面板 E2E | 各自写副作用须经过 R1/R2；R6 依赖 R4/R5 |
| 第四阶段 | R9 最终验收（A1–A15 映射、次数矩阵、物理手机） | C0–C8 全部退出条件 |

每次实际开发领取明确范围，由集成方按上述顺序接入中央入口，避免跨模块同时修改 application graph。

中央组合统一负责以下内容：

- `host-application.ts`、`main.ts`、`server.ts`、RPC domain 注册：只有一套生产 application graph，集中注入 query/activation/recovery/checkpoint/worktree，运行前检查必需绑定完整。
- `catalog-host-lifecycle.ts` 与 runtime hooks：停止、drain、fence、关库责任统一，时间参数显式区分 deadline 与 remaining duration；不让各 helper 延长总关闭期限。
- 数据迁移：011 已合入，后续优先使用现有列与版本化元数据；确需新增结构时使用下一个中央迁移（当前下一个为 012），同步 validator/冻结 fixture/future-schema 测试，不能回改 011 假设所有库都会重跑。
- Web/mobile 入口：按 R8 顺序接入已可用能力，不因 schema、factory 或 DTO 存在就发布写能力。

## 5. 验证要求与待完成检查

代码改动至少执行相关套件和 `rtk pnpm --filter @flyx/mvp-host typecheck`，跨包类型改动再执行 `rtk pnpm typecheck:tests`；界面改动覆盖对应客户端/浏览器测试。最终集成执行 `rtk pnpm test:product`。文档更新阶段未重跑产品测试；其后并行开发由 Luna 独立验证，记录在 §7。

| 证据层 | 当前可确认 | 尚需补齐 |
| --- | --- | --- |
| 模块/契约 | C1/C2、调度器、C3 核心服务与迁移已有通过记录；10-22 定向 9 文件 / 58 用例通过 | R2 用途 gate、R3 产物握手、R4–R8 新增路径 |
| 真实进程/Git | 历史 macOS 探针确认现有后代停止证明不足；已有临时 Git 用例 | C0 与 macOS 全用途 runner、每 Turn 停止/续接 |
| 生产组合 | C3 readiness/doctor/维护 CLI 已接主入口 | 强制写 gate、真实 executor、Checkpoint/Worktree、最终生产 main 验收 |
| 实际 Provider | 本轮没有新增真实通过证据 | 精确版本兼容、恢复、完整回退与方案次数矩阵 |
| 物理手机 | 未完成 | A14 及实际 Tailscale/Relay 路径 |

验收记录固定包含：commit/构建入口、OS/依赖/监督合同、命令与退出码、测试范围与 pass/skip、是否使用 fixture、原始产物私有位置、限制和未通过项。真实进程/Git 套件避免同时双跑，以事件屏障/drain 同步；调整测试总期限不得扩大产品 helper 预算或掩盖清理失败。

## 6. 历史记录与本次更新

| 日期 | 任务 | 提交 | 证据摘要 |
| --- | --- | --- | --- |
| 2026-10-18 | 基线 | 见提交记录 | 工作树收尾（生命周期多 fence 封闭、主入口清理错误保留）；全量 `pnpm test:product` 结果见任务记录 |
| 2026-10-18 | W1-A（C1） | `17551a7`（合并 `9bbe263`） | `typecheck`/`typecheck:tests` 通过；`src/lifecycle src/workspace src/provider src/claude src/codex src/git src/operations src/orchestration src/session src/checkpoint src/test-support` 584 passed/5 skipped；新增窄句柄失败路径（无 PID 不伪造 spawn/exit、原 launch 不可替换、late-listener replay）用例 |
| 2026-10-18 | W1-C（C7） | `5ac8150`（合并 `82c0a3e`） | `worktree-scheduler` 8 用例 + `host-worktrees` 13 用例（seal 幂等 fence/lease 不假释放）；`src/workspace` 66 passed；`typecheck(:tests)` 通过 |
| 2026-10-18 | 中央迁移 011 | `9ef2cf3` | `011-execution-activation`（`host_execution_operations` + 资源 `activation_operation_id`/`activation_binding_digest`/`readiness_revision` + validator）；冻结 v10 fixture；空库/冻结 v10/重复打开/requires-010/篡改拒绝/旧程序 FUTURE_SCHEMA 用例；`src/storage src/attention src/session src/catalog src/diagnostics`（含修复后重跑目标文件）通过 |
| 2026-10-18 | W1-B（C2） | `49bc1e6`（合并 `ac524cf`，夹具修复 `8d9e342`） | `managed-git-runner`：用途白名单、冻结 argv/env/cwd、预算、journal launching→结果→停止证据；无监督后端时生产构造器拒绝；`runGit`/`readOnlyGit`/`spawnHelper` 全注入点接入、无原始 fallback；合并时解决 C1×C2（窄句柄）与 C7×C2 冲突；`typecheck`/`typecheck:tests` 通过；全量 `pnpm test:product` EXIT=0（1124 passed/5 skipped + mvp-web）；目录夹具补注入后 7 文件 95 passed |
| 2026-10-19 | W2-D（C3）模块 | `a32aabe`（合并 `2609bd7`） | 激活服务、操作 Store、加载/失效与只读 RPC 模块；历史记录为 6 文件 56 passed、`typecheck`/`typecheck:tests` 通过。 |
| 2026-10-20 | C3 中央接线 | `1108bed` | `activationReadiness` 工厂接启动加载，doctor 精确原因码、`host.getExecutionReadiness`（`host:read` + 当前设备 lease/generation）、离线 activation CLI 接入 maintenance owner。历史记录含 Host application 5 passed、CLI 2 passed 及 terminal 解析检查；query 缺实际 executor 时落 rejected 收据。完整产品运行包含 Host 四个文件超时（worktree-service/host-checkpoints/late-ordered-schema/revert-service），随后定向重跑 117 passed；不据此登记最终主线一次完整全绿，也不单凭重跑断言超时与改动无关。在线强制激活和实际执行事实仍缺，转 R1/R2/R3。 |
| 2026-10-22 | 进展核查 | `1108bed` | 上一轮分析中实际执行下方命令，9 文件 / 58 用例 passed，EXIT=0；属于确定性定向证据，未跑真实 Provider/手机，也未重跑完整产品套件。 |
| 2026-10-22 | 本次文档更新 | 源码基线 `1108bed` + 文档工作区 | 收紧模块/生产/真实运行的状态口径；增加 R0–R9 的实现方式、依赖和退出条件，同步方案 v1.1；本次只做文档与源码一致性检查，不新增功能通过声明。 |

10-22 定向验证的可复现命令（已执行于上一轮分析，本次文档更新未重复执行）：

```sh
rtk proxy env RUN_REAL_CLAUDE=0 RUN_REAL_CODEX=0 RUN_REAL_CLAUDE_SPIKE=0 RUN_REAL_CLAUDE_FLOW=0 RUN_REAL_INTERRUPT=0 RUN_REAL_CODEX_SPIKE=0 RUN_REAL_CODEX_FLOW=0 pnpm --filter @flyx/mvp-host exec vitest run \
  src/lifecycle/managed-child-handle.test.ts \
  src/lifecycle/managed-git-runner.test.ts \
  src/workspace/worktree-scheduler.test.ts \
  src/lifecycle/host-activation-service.test.ts \
  src/lifecycle/host-activation-load.test.ts \
  src/lifecycle/activation-cli.test.ts \
  src/diagnostics/activation-rpc.test.ts \
  src/host-application.test.ts \
  src/storage/migrations/011-execution-activation.test.ts
```

## 7. 本轮并行开发记录（进行中）

用户指定复杂定位/设计使用 Astra、代码修改使用 6.1 Sol、编译/测试使用 Luna。本轮按模块独立所有权开发，共用一份工作区；中央入口由单一集成任务修改，测试避免同时双跑。任何记录均不提升 C0、实际 Provider 或手机状态。

| 责任 | 范围 | 状态 |
| --- | --- | --- |
| Astra 平台审查 | audit-token 候选实测、停止闭包与前置证据 | [审查报告](./analysis/2026-10-22-macos-supervisor-contract-review.md)已写；C0 仍阻塞 |
| Astra 接线审查 | 按用途 gate、原控制通道、排队取消、构造/关闭/投影约束 | [审查报告](./analysis/2026-10-22-central-integration-review.md)已写；继续审阅集成改动 |
| Sol Runtime | 每 Turn 关闭、共享关闭期限、query adapter、permit 等待与排队取消 | 开发/回归中 |
| Sol Compatibility | 签名且分域的产物、隔离生产 readiness 握手、逐能力校验 | 模块已写，等待验证与实际源接线 |
| Sol Recovery | 只读原生历史、restore inspect/confirm、原审批控制通道 | 模块已写，部分定向用例通过 |
| Sol Revert | Codex rollback / Claude fork 的 prepare/apply/query 与响应丢失核对 | 契约用例已写；真实受管 transport 与原生锚点待接 |
| Sol Worktree | permit、元数据锁、scheduler 与中央组合端口 | 模块已写，等待锁/生命周期集成验证 |
| Sol Clients | CoreControls、Session/Recovery/Diff/Worktree Web、手机最小操作 | 开发/类型检查中；真机未验收 |
| Sol Integration | 在线激活 gate、Checkpoint/Worktree/恢复/维护 CLI、checkpoint Timeline 投影 | 开发/组合验证中 |
| Luna | 类型检查、定向测试、后续产品与生产入口验收 | 分批进行；保留独立日志与环境限制 |

初始验证：基线 Host typecheck 通过；9 文件定向运行先因沙箱禁止监听 127.0.0.1 导致 Host application 5 例失败，其他 53 例通过；获准监听后仅重跑该文件，5/5 通过。日志位于 `/private/tmp/flyx-20261022-baseline-host-typecheck.log`、`flyx-20261022-baseline-host-deterministic.log`、`flyx-20261022-host-application-escalated.log`。这三次运行不能合写为当前所有工作区改动的一次全套通过。

开发中验证：Host typecheck 曾通过；client-core 两项类型错误修复后 typecheck 通过。第二批 7 文件定向运行 88/92 通过，4 项 helper-only macOS 策略探针因沙箱内 `sandbox-exec` 返回 `sandbox_apply: Operation not permitted`，待同一文件在允许该本机探针的环境重跑。对应日志为 `/private/tmp/flyx-20261022-batch1-host-typecheck.log`、`flyx-20261022-batch2-client-core-typecheck.log`、`flyx-20261022-batch2-host-focused.log`。这些都是修改过程中的快照，最终构建仍需完整验收。

10-23 后续记录（不覆盖先前失败或代表最后全部代码）：

- 用户确认 ES entitlement、Developer ID 与目标安装授权目前不确定，继续保留 C0 阻塞；没有安装监督服务、修改权限或 SIP。
- `managed-workspace-query.test.ts` 在允许本机策略探针的环境重跑，16/16 通过；先前四项 `sandbox_apply` EPERM 属于运行环境限制。日志：`/private/tmp/flyx-20261022-batch3-managed-workspace-query-escalated.log`。
- R4/交互六文件 93/93 通过，覆盖 Native history、Recovery、原控制通道与真实 maintenance DB/备份 fixture；外部监督事实仍为显式 fixture。日志：`/private/tmp/flyx-20261022-batch7-recovery-interaction.log`。同 owner 重复 helper 检查的正向恢复仍需补测，不据此登记真实 Provider 恢复完成。
- R3 当时版本脚本 9/9、Host 诊断 7/7 通过；之后又加入 authorize/import、planned snapshot、来源解析和 scene policy，新增部分仍待重新验证。日志：`/private/tmp/flyx-20261022-batch5-compatibility-evidence.log`、`flyx-20261022-batch5-compatibility-host-tests.log`。
- Host 源码、client-core/Web/mobile 源码类型检查通过；client-core build/test types、Web test types 通过；CoreControls 15/15、Web 定向 9/9 通过。对应 batch8/batch9 日志位于 `/private/tmp/flyx-20261023-*`；tsx IPC 监听也曾遇沙箱 EPERM，经允许后重跑通过。
- R6 新 driver/持久 journal 用例已取得通过记录，原 Revert 回归中一项复杂文件恢复曾返回 unknown；受控 Worktree 组合曾有两项 unknown。两者继续定位并保留原失败记录，不调大产品预算掩盖；已发现临时路径别名需在生产者端 canonicalize。
- 10-23 R6 两项 unknown 与临时路径 canonicalize 定位结论（独立 worktree 验证，基线 `9ec893b`）：
  - 复杂文件恢复 unknown 已定位为**实现缺陷并修复**：`mkdir` 步骤在内存中持有显式 `artifact: undefined` 属性，`stableJson` 将其序列化为 `"artifact":null`，而 SQLite JSON 持久化会丢弃该键；`refreshAfterNativeJournal` 比对内存态与重读态时 digest 恒不等，误判 `PLAN_STALE` 并 fail-closed 为 `outcome_unknown`。修复：`git-driver.ts` 的 `stableJson` 与 `JSON.stringify` 一致地跳过显式 undefined 属性，使 `bindingDigest` 在持久化往返下不变（显式 null 仍是有意义值）。回归测试加入 `git-driver.test.ts`；`revert-service.test.ts` 原 53 用例（含复杂恢复）全部通过，未放宽任何 unknown 语义。
  - 受控 Worktree 组合两项 unknown 已确认**在当前代码修复**：对应 10-22 batch6 日志中 `scheduled-host-worktrees.test.ts` 两例 `expected 'outcome_unknown' to be 'completed'`；当前基线两次运行 7/7 通过（e728fd0 的 stop-contract 树停止证据及后续组合修复生效），文件内保留的 `WORKTREE_PRODUCER_UNKNOWN` 用例为预期 fail-closed 语义。
  - 临时路径别名已在**生产者端 canonicalize**：`controlled-restore.ts` 的 `prepareIndex` 临时根（macOS `tmpdir()` 为 `/var → /private/var` 别名，managed runner 拒绝非 canonical cwd）改为 `realpath(mkdtemp(...))`；`catalog-read-bootstrap.ts` 的 SQL 引导改为 `canonicalConfiguredRoot`（存在即 realpath、缺失保留绝对路径），别名 root 不再以 canonicalRoot 入库（否则后续 `assertCurrent` 一律 `WORKSPACE_MOVED`）。各自补路径别名回归测试。
  - 附带发现（基线预存、非本轮引入，保留原失败记录待 R1/R2 归属处理）：`catalog-read-bootstrap.test.ts` 两例 `session.rename`/stale-executable 写 gate 现放行（期望 `WORKSPACE_NOT_VERIFIED` 拒绝）；`host-application.activation.test.ts` 两例因 metadata 引导的 `needs_verification` 记录无 `worktreeRoot` 以 `WORKSPACE_CHECKOUT_UNAVAILABLE` 拒绝；`host-application.test.ts` 一例 `INTERNAL_ERROR`（`toRpcError` 未映射 `CatalogError`）；`tsc` 因 `network-e2e-main.ts` 引用不存在的 `@flyx/mvp-relay` 包恒 6 错。`worktree-service.test.ts` 补 describe 级 60s 超时（真实 Git 用例默认 5s 在本机必超时，35/35 实际通过，非产品预算调整）。
  - `native-revert-anchors.ts` 未接线：`captureNativeAnchor`/`resolveHandle` 管道已在 `host-checkpoints.ts`/`native-revert-drivers.ts` 预留，但构造锚点需要生产 `HostManagedNativeRevertPort` 与 native 元数据来源，均依赖 R0/R1 execution backend 与第三阶段（R4/R5 后）生产接线，本轮只记录差距不强行接线。
- 10-23 R4 剩余补测：同 owner 重复 helper 检查的正向恢复（独立 worktree 验证，基线 `origin/codex/flyx-optimization`@`8b6f648`）。实现无需修复——`recovery-service.ts` 的 `savedInspectionEvidence`→`combineInspectionEvidence`→`inspectionIds` 排除链与 `verifyReleaseProof` 的 inspection ID 处理已完整，此前仅缺定向用例。补测三例：`recovery-service.test.ts` ①复用已保存同 owner helper 停止证据完成二次 inspect+reconcile 释放（断言无新 helper launch、执行检查两次均只见 `process-original`、最终 evidence 保留 helper 审计、release proof 可验证）；②已保存 helper 的持久停止记录缺失（state 翻为 running）时重新 inspect 以 `RECOVERY_EVIDENCE_STALE` 拒绝，且在任何新 helper spawn 之前 fail-closed（inspectNative 未再调用、无新进程/evidence 行、release proof 不可验证、Turn 保持 outcome_unknown）；`restore-external-check.test.ts` ③supervisor ledger 含同 owner helper launch：持久全树停止证明齐备→ready，state=running 或 stop 证明缺失→`RESTORE_ORIGINAL_OPERATIONS_UNRESOLVED` 拒绝且不释放 gate。验证：`tsc -p tsconfig.test.json --noEmit` 仅余基线预存 `network-e2e-main.ts` 8 错（非本轮引入）；R4/交互七文件定向 vitest（`RUN_REAL_CLAUDE=0 RUN_REAL_CODEX=0`）recovery-service 32/32、restore-external-check 9/9、native-history-reader 7/7、host-recovery、catalog-recovery、backup-restore、native-history-manifest 共 104/104 通过。外部检查器/监督事实仍为显式 fixture，不据此登记真实 Provider 恢复完成。
- Luna 验证已分为 Host 与 UI/browser 两条独立任务，避免重复运行同一套件。实际浏览器元数据闭环正在验证；无真实 Provider、完整最终产品套件或物理手机通过声明。

**2026-10-23 工作区对照（本文档维护方）**：对 `1108bed` 之上的未提交工作区（78 个修改文件 + 40 个新文件，约 +2400 行）按模块与本文档状态逐项对照，结论同步至 §1–§4；本次为文档与源码一致性检查，不新增功能通过声明。核心结论：

- R1/R2/R5/R7 的中央组合代码已在 host-application 生产模块接线（激活 gate、query executor、Checkpoint/受管 Worktree/permit/元数据锁、固定 Turn 顺序、stop-before-drain），并配组合级测试（host-application.activation、scheduled-host-worktrees、orchestrator.checkpoint/permits 等）；默认 `main.ts` start 不构造任何受信 execution 端口，保持 fail-closed，等待 R0。
- R3 签名/隔离握手/authorize-import CLI 已接 main，recorder 事件源与 isolated-real 端到端仍缺；R4 结构接线完成但生产 manifest 恒 unknown、CLI 外部检查器占位；R6 驱动与受管 transport 完成（仅 fixture），生产接线、持久锚点与两项 unknown 回归待做；R8 CoreControls/Web 四面板/手机最小面板已接，浏览器 E2E 覆盖会话元数据/草稿/readiness，其余面板场景与真机未做。
- 新登记缺口：`CompatibilityEvidenceRecorder.afterCommittedNativeStop` 零引用；`native-revert-anchors.ts` 零引用；main isolated 模式在无 execution 端口时不可用（`COMPATIBILITY_RUNTIME_FACTS_UNAVAILABLE`）；生产 supervisor backend 仍限 Linux 且无构造点。
- 以上"已接线/已实现"均以工作区代码与既有定向测试记录为据，完整 `test:product`/typecheck 全量验收仍待 Luna 执行后提交；C0、真实 Provider、物理手机状态不变。

**2026-10-23 收敛轮（提交并推送后）**：工作区经拆分提交（9 个模块提交至 `b79c759`）后进入全量验证收敛；期间按模块并行开发的三项 worktree 任务（R3 recorder 事件源 `db64380`、R6 unknown 定位+路径 canonicalize（5 commits）、R8 面板 E2E `b9be7f7`）已完成并合并推送。本收敛轮的验证与修复记录：

- 全量验证首次暴露基线破坏：`compatibility-scene-policy.ts` 的 `const` 箭头 `fail()` 不被 TS never 收窄（函数声明才行）导致 host build 失败（`9ec893b` 修复）；测试类型三处 exactOptionalPropertyTypes/mock 缺字段（`66893e9`）。
- R4 补齐：新增 `provider/native-history-manifest.ts` 可信 manifest 来源——仅在"验证过 turn 基线的同一签名产物/隔离 run/受控入口上还绑定通过的 recovery 只读检查,且产物仍匹配当前 provider 实例事实"时给出 manifest;接入 `NativeHistoryReaderFactory`,替换恒 `undefined` 占位（`d22b3e6`,6 个 fixture 用例）。
- 激活判定修复：记录绑定过期且兼容日志同时老化时报告 `stale/ACTIVATION_EVIDENCE_EXPIRED` 而非 `uncheckable`（其余观察拒绝仍优先）；service 测试改用 v2 签名 fixture 证据+trust;activation 应用测试补 workspace `registerLocal` 验证与 realpath;`dispatchCatalog` 映射 `ActivationServiceError` 为类型化错误（`db00cfe`）。
- 排队取消修复：`turn.cancelled` 事件的 `finalizeTurnIntentsInternal` 与计划显式 intent 更新冲突(恒 `EXECUTION_INTENT_TRANSITION_INVALID/STATE_CONFLICT`)——取消走持久事件路径,worker 各派发前检查点识别 settled+cancelled;新增 `beforeClaim` 钩子,容量等待(permit/lease/baseline)移到 claim 前使排队任务保持 pending 可取消,preparation 中的中断恢复走原控制通道（`276184f`）。
- Catalog gate 顺序修复:控制命令恢复 `ensureLoaded`(加载资源检查给出精确拒绝、加载后复核 actor);interaction 响应端口先过 restore 全局门再选端口,无已加载 runtime 时原控制绑定拒绝优先于能力证据（`95a4f7d`）;bootstrap/integration 测试期望更新到用途拆分语义(rename 不依赖工作区验证/可执行文件)。
- R6 worktree 结论已合并:复杂文件恢复 unknown 系 `stableJson` 对显式 `undefined` 序列化不一致的实现缺陷(已修);受管 Worktree 两项 unknown 在当前代码已修复;`controlled-restore`/`catalog-read-bootstrap` 生产者侧 realpath canonicalize(附回归测试);`native-revert-anchors` 记录为第三阶段差距。
- R8 worktree 结论已合并:Recovery/Diff/Worktree 不可用面板与 worktree 正向上链路 4 个真实 Host E2E 场景(6/6);core-host-main fixture 修复(registerLocal+provider configured 提升);`entry.spec.ts` large Git Diff 一例为基线预存,另行跟进。
- 验证日志:`/tmp/flyx-verify-{b79c759,9ec893b,66893e9,db00cfe,95a4f7d}.log`;secure-channel 262KB 帧用例曾因并发负载超时,单跑 48/48 通过。R6 受影响套件 113/113(串行,~8 分钟)。C0、真实 Provider、物理手机状态不变。

**2026-10-23 收敛完成**：第零阶段收敛完成,完整验证链一次全绿并已推送(`7cb015d` 基线,日志 `/tmp/flyx-verify-final.log`,`VERIFY_EXIT=0`):`pnpm build`/`typecheck`/`typecheck:tests`/`test:product` 全部通过——mvp-host 1305 passed/5 skipped(0 失败),mvp-protocol 56、mvp-relay 43、secure-channel 48、client-core 158、mobile 90、mvp-web node 套件全部通过;合并后主干的 core-capabilities Playwright E2E 6/6(会话元数据/草稿/Recovery·Diff·Worktree 不可用面板/worktree 正向上链路)。本收敛轮累计 12 个提交(含 3 个并行 worktree 任务合并),修复:TS never 收窄破坏、激活过期判定、排队取消与持久事件路径冲突、checkpoint 预留 generation 下限、catalog 控制绑定/门顺序、adapter fixture 的 stop-proof 变体、路径 canonicalize 与 stableJson 序列化缺陷;`entry.spec.ts` large Git Diff 一例仍为预存(另行跟进)。C0 阻塞不变,下一阶段进入 R0 证明(需 entitlement/签名/目标 Mac 前置)与 R1 生产 execution 端口注入等待 R0 结论。

**2026-10-23 收敛验收（verify:clean 通过）**：收敛完成条目所遗留的收尾事项已全部处理完毕并推送，干净检出门禁一次通过（基线 `010e00d`，日志 `/tmp/flyx-verify-clean4.log`，`VERIFY_EXIT=0`）：

- `entry.spec.ts` large Git Diff 一例已修复：E2E host 未注入 `gitRunner` 时 GitService 返回 `MANAGED_GIT_RUNNER_REQUIRED` 使面板显示 clean；`e2e-main.ts` 注入测试专用 `rawGitServiceRunner()`（8b6f648），生产组合纪律不变。
- R8 interrupt 统一（e8229bf）：`webInterrupt()` 统一路由到 `host.controls` 单一实例，`use-core-controls.ts` 消费；core-controls 模块 +5、Web interrupt +5 用例。
- R4 补测三例合并（c103776）：同 owner 重复 helper 检查正向恢复、停止记录缺失 fail-closed（`RECOVERY_EVIDENCE_STALE`）、supervisor ledger 三态门。
- Web Playwright 全套 35/35；core-capabilities E2E 6/6。
- verify:clean 前三次失败的三个根因均消除：并发负载超时（隔离重跑确认）、TMPDIR 磁盘 99% 满（清理 22G 陈旧临时副本）、真实 Git/迁移套件在干净检出版超时（describe 级显式超时 60s/30s/20s，仅测试期限，010e00d）。
- 干净检出门禁最终结果：host 140 文件 1308 passed/5 skipped、protocol 56、relay 43、secure-channel 48、client-core 163、mobile 90、mvp-web 63 node 用例 + Playwright 全套；fixtures 1 通过 + 1 预期边界失败；204 个产品源码测试文件构建前后逐字节一致。
- 第零阶段（R0–R9 工作区侧）至此全部收敛。剩余全部卡在 C0 用户前置（ES entitlement、Developer ID、目标 Mac 安装授权），后续顺序：R0 证明 → R1 生产 execution 端口 → R2 实际事实 → R3 isolated-real 端到端 → R4 真实外部检查器 → R6 生产接线+持久锚点 → R9 终验。
