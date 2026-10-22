# 中央组合审查（R2 / R4 / R5 / R7）

日期：2026-10-22。依据 core-capabilities-technical-design.md v1.1、implementation plan 与当前源文件。共享工作区正在并行修改；以下是端口约束与验收清单，不代表真实 Provider 或 macOS 监督验收通过。

## 1. 最小构造图

1. 验证 owner / Store / identity；创建 OperationRegistry、共享 journal、实际受控 runner（只有已验证 backend 才可用）及 query facade。runner 缺失时保留明确 unavailable，不能注入 fixture。
2. 创建 HostViews，resource/authorization 回调闭包引用尚未赋值的 catalog；回调被过早调用时抛 HOST_BOOTING。
3. 构造 metadata-only HostCatalog。在 activationReadiness(catalogStore) 中创建唯一 ActivationOperationStore、localActivationFacts observation、HostActivationLoad、HostActivationService。service/load 共用 observation 和 Store；原 producer readiness 通过闭包读取最终 catalog。此阶段不得启动 Git、Provider 或 scheduler。
4. 创建 CatalogHostLifecycle 和 DeviceRegistry，再创建 CatalogInteractions、CatalogRecovery、HostCheckpoints、HostWorktrees 与 WorktreeScheduler。HostWorktrees.accepted 闭包只在提交后调用 scheduler.accepted；scheduler.dispatch 固定指向 HostWorktrees.dispatchAccepted。
5. runtimeOptions(context) 在真正加载 runtime 时读取已建立的全局服务，注入 checkpoints.executionBinding、recovery.runtimeRecoveryOptions、原生 gate、真实 gitRunner 和共享 task permits。executionSetup 同步执行 interactions hook、checkpoints.bindWorker、事件订阅；均在 worker.start 前。
6. 注册 domain ports 和全部 shutdown ports，再启动传输/开放 admission，最后 scheduler.scan。旧 owner 或未知 intent 不进入普通调度。

不要把服务缺失静默改成空钩子。不要在普通启动调用 checkpoint.capabilitiesForSession：它会运行 Git fingerprint。hello 的 capabilities 必须是同步且不产生进程的功能声明，具体 RPC 再检查实际资源与后端。

## 2. Gate 必须按用途接入

| 入口 | 最小条件 | 不应附加的条件 |
| --- | --- | --- |
| SQL history / receipt / readiness | Store、owner、当前设备和资源 scope | workspace/provider 新启动激活；runtime load |
| startTurn 受理 | admission、当前 actor/resource、原 producer/restore、目标 workspace/provider 激活 | 先等待 Host permit 导致无 durable receipt |
| start_turn 实际调用 | 当前 actor/resource 与激活再次检查、原 attempt、实际 permit/checkout lease | 只相信受理时快照 |
| interrupt / cancel | 原 loaded runtime、原 active attempt、当前 scope/control channel | requireExecution、ensureLoaded、新激活 |
| approval / Question | 上述原控制绑定、当前 policy、交互版本和当前 actor | 激活过期直接关闭原控制路径；旧权限快照 |
| Worktree Git | 当前源 checkout/repository、用途 backend、相关 lease/common-dir 锁、当前权限、restore | 无关 Provider 激活 |
| recovery | 原身份、原证据 revision / TTL、当前 actor、inspection helper 监管 | 目标必须先 idle / 重新激活 |
| metadata create / rename / archive | 各自当前权限与状态约束 | 构造 Provider；归档隐含停止 |

现有 no-arg assertWriteReady 在 CommandEngine 与 Worker control 路径均使用，不能整体替换成 Native activation。推荐保留它为准确的公共写/restore 条件，单独添加 assertNativeReady，分别用于 catalog 加载前、startTurn 事务受理及 Worker 的 start_turn 同步 revalidation。assertReadyForWrite 必须调用现有 HostActivationService，以保留撤销和 CAS 语义。

SessionRegistry.resolveExecutionContext 内部使用 executionTarget -> assertExecutionResources，不能作为原控制通道读取。新增窄 resolveControlContext：读取 persisted relation 和已加载 runtime，核对原 turn/attempt/owner，绝不 ensureLoaded。CatalogInteractions.answerAdmission、HostCatalog.interactionsForSession 和 legacy approval/interrupt 都要一起审查。

ProviderInstanceRegistry.effectiveCapabilities 在 verification 失效时返回空集合。原控制应使用实际绑定 adapter 支持、原版本和当前 policy/device scope；不能通过把 provider.verification 手工恢复来放行。身份/配置发生真实变化仍需拒绝。

## 3. Git 与历史的资源区分

WorkspaceRegistry.require 同时要求 state=active、canonical roots 当前存在和 privacy；它适合执行资源，不适合作为所有 metadata read 的守卫。

- Worktree.source 当前已用 sessions.resolve；但 resolveRepository 只接受 active 源，metadata startup 将其降级后会连纯 Git 都阻塞。应增加 purpose-specific Git repository accessor，在真正 Git 副作用处核对路径/隐私/common-dir 与 backend。不要全局放宽 require。
- Worktree 创建后的登记只证明 checkout 身份，不能伪造 workspace/provider activation；新任务仍必须显式激活。
- HostCheckpoints.resource 对现有 Diff read 也调用 workspaces.require。持久 summary/page/content 先用元数据授权；只有需要 Git object/helper 的步骤使用真实 Git port 并保持对应后端 unavailable。
- Worktree 继续步骤的排除必须精确匹配原 intentId/actor/command/session/dispatch context。不得使用 ignoreBusy/bypassRecovery 全局标记。

## 4. 关闭与每 Turn 边界

CatalogGlobalService.stopProducers(deadlineAt) 是最小全局 seam。所有 stop 调用先启动，再等待 Session close/operation/service drain；shared runner 关闭须幂等并保留一个共享 deadline。各 duration 接口只能收到 max(0, deadlineAt-now)。ManagedWorkspaceQuery 旧 drain 将绝对截止传给 executor.closeAndWait 的相对预算，且 shutdownService 丢弃 clean 结果，这两项需要适配。

全局 runner、Worktrees、Checkpoints 都必须在 Store close 前同步 seal；drain 超时不能省略 fence。停止未知保留 owner/lease。空 producer set 可证明没有启动记录，不代表伪造平台停止合同。

Turn 顺序必须为：permit/lease -> baseline/before -> 当前 gate 重查 -> prompt -> 业务终态提交 -> 原 attempt 树停止 -> after -> Diff 发布 -> lease/permit 释放。旧 finalizeTurn 的外部 afterTerminal 在首次 canReleaseWorkspace 之后，不能把 stop 实现在该晚钩子。使用每 attempt closeTurnAndWait，Session adapter 轻对象可复用；全局 closeAndWait 若永久封闭 adapter 不能充当 Turn close。

Provider 与 managed-boundary stop 应共享一个 deadline。Checkpoint/helper 停止必须进入 release proof，不能只依据 Provider tree 停止。after 失败不得覆盖已知业务终态；已证明 helper 全停的 Diff unavailable 与执行 unknown 要区分。

## 5. Permit 移到派发前后的具体风险

ExecutionWorker 当前先 claim 再 beforeDispatch。beforeDispatch 等 permit 时，业务 Turn 仍 queued，但 durable intent 已 claimed；应明确采用此状态，或把资源预留等待移到 claim 前并在获取后重新读取/CAS。禁止重放旧 owner claimed。

最重要的新增回归是排队取消：decideInterrupt 只创建 interrupt_turn，而 Worker 控制扫描要求 runtimes.matches；在 runtimes.begin 前不满足，因此单纯接入 permit 会让“取消排队”最终仍发送 prompt。需要本地原子 cancelled/not-dispatched 路径：绑定原 start intent 与 interrupt、终结原 receipt/控制 receipt、撤销该 attempt 的 permit 等待，零 Provider 调用。

Worker.recordFailure(invoked=false) 会 onStartOutcome(failed, not-dispatched) 后调用 afterTerminal。故前派发失败清理需覆盖：

- 未取得 permit：无 lease/producer，结束 receipt，无需构造或停止 Provider。
- 已取得 permit 尚未取得 lease：释放该 permit，不能保留假 producer gate。
- 已取得 lease 且 baseline/before 启动过 helper：先取得 helper stop proof；清洁时释放，未知时保留。
- activation / 当前 scope / WORKSPACE_BUSY 是已知拒绝，不能因 failed 回调统一 degraded 使本可释放的 lease 永久保留。
- beforeDispatch 返回后、dispatch marker 后均需再查本地取消、actor、activation 和实际资源；marker 本身不等于已调用 Provider。
- control lane 不占 task permits；长任务或等待中的任务不得阻塞另一个已运行任务的中断/审批。

## 6. UI Turn / checkpoint 引用

checkpointSummary 已输出 checkpointId/sessionId/workspaceId/phase/turnId/attemptId 等公开字段；publicValue 不删除 attemptId。问题是 canonical Timeline normalizeEvent 尚未处理 checkpoint.captured，所以当前分页没有自然引用。

最小修复：将经过 CheckpointSummarySchema 校验的 checkpoint.captured 投影为稳定 itemId=checkpoint-<checkpointId> 的 system item，metadata 保留公开 summary，status 使用 summary.status。before/after 分开按 checkpointId 存放，客户端按 turnId+attemptId 分组。页内完整边界可直接调用既有 getTurnDiff，不让用户输入 attemptId。若产品需要独立于当前 Timeline 窗口的全历史选择，再增加限定 session、cursor、limit 的 summary list；不是当前必需的新框架。

## 7. 聚焦验收

1. 无 backend / 无 activation 正常启动；history、receipt、recovery 可读，startTurn 在 runtime preparation 前拒绝且零 Native launch。
2. 正向 fixture 受理后暂停 worker，撤销 actor 或使 activation 过期；恢复派发时零 prompt 且 receipt 为明确 not-dispatched。
3. 原 active attempt 的 activation 过期后，中断仍可发送；审批/Question 当前 scope 撤销后不得发送。
4. 两个 task permits 已占用时第三个任务 durable queued；取消第三个无需等待前两个结束、零第三个 prompt；释放 permit 后下一任务派发。
5. baseline/before 失败、permit abort、lease busy 均有准确 receipt 与无泄漏；helper unknown 保留 lease。
6. Host shutdown 在等待全局 Git operation 前启动 stop；每个 helper/backend 的 stop unknown 传入最终报告；晚回调不访问关闭 Store。
7. Timeline 首次页、增量页和重新连接均得到公开 checkpoint summary，选择 Turn 无手工 ID。

本报告只定义源码约束与模块验收；真实 Provider 跨进程续接、原历史恢复、macOS 停止闭包与手机网络恢复需要各自证据。

## 8. 并行实现复审补充

对 `repository-metadata-lock.ts`、`host-execution-permits.ts`、`scheduled-host-worktrees.ts`、`managed-host-worktrees.ts`、`managed-repository-metadata.ts` 的定点复审：

- canonical common-dir + ExclusiveFileLock 且不设置 reclaimStale，拒绝陌生/未知/陈旧 owner；跨 Host 使用同一 coordinationDirectory 是成立前提。不能把 PID 消失当回收授权。
- 已指出并由责任人修复：seal 前仍运行 common-dir 查询、多把锁恢复时未先 validate-all、构造期间自动启动 scheduler、permit 在 repository scope 下逆序获取。
- live retained-map 的 releaseAfterRecovery 只能释放该实例保留的锁；重启后的原锁需 maintenance 对原 owner 与证据复核，不能静默归入新实例。
- managed Worktree proofFor 精确查询原 owner/generation/runtime/generation/attempt/session/turn，并验证 immutable identity + stop proof + 指定合同；因此中央 runner.context 必须使用 currentExecution().dispatchContext。固定 host-git 上下文或只传 bindingDigest 都不满足这些查询。
- Host permit 在 grant 后 abort 不自动释放、unknown 保留 capacity，符合要求。runtime afterRecovery 必须在原证据及 lease/owner cleanup 成功后释放 matching attempt 的 permit，否则两次 unknown/recovery 后容量永久占满。

中央 R2/R5 接线还需检查以下具体链路：

1. HostCatalog.loadRuntime 的 assertWriteReady wrapper 会再次调用 assertRestoreReady；若该 callback 仍绑定 assertBusinessReady，则 runtime 层已拆开的 control gate 会重新被全局 producer gate 包住。HostCatalog.interactionsForSession 的独立旧路径也需更新。
2. catalog-checkpoints 的 assertSessionScope 必须组合原 Gateway callback。原 callback 记录 admittedTargets，供 await 后 responseCurrent 再核对资源权限；直接替换会丢掉该检查。
3. HostActivationService 在事务内 withdraw 然后 throw 会随 claim/marker 事务回滚。确保事务外同步 preflight 保存撤销原因，事务内保留 recheck；不能安排关库后的异步补写。
4. CheckpointGitDriver 将 ManagedGitError(state=unknown) 转为 GIT_OPERATION_FAILED，CheckpointService 再转换成 failed manifest；旧 Orchestrator 只拒绝 capturing，导致失败的 before 仍发 prompt，以及未知 helper 被当普通 Diff unavailable。必须保留 stop-unknown 分类，拒绝不可用 before，并在 after/清理前验证原 helper stopped。
5. catalog-checkpoints.runtimeState 只查当前持有的 workspaceLease；正常 Turn 完成后该 lease 已释放，预览/回退需要独立的真实 lease scope，而不是返回伪 lease 或无限保留任务 lease。

以上是审查时捕获的路径；修复与测试证据应由各责任人逐项记录，不凭本节推断已经关闭。

## 9. R8 客户端定点复审

本轮核对 `core-controls.ts`、Web `use-core-controls.ts` / `core-panels.tsx`、移动端 `App.tsx` / `core-panel.tsx` 与既有 `command-outbox.ts`：

- 控制层写操作使用 `port.command`，先保存 Outbox 再发送；结果未知不自动重发。Worktree 创建与后续 Session 创建分别保存回执，第二个 commandId 从原 Worktree commandId 确定性生成；已有第二条命令时只查原回执，不另建 Session。
- Host、Session、transport generation、replica generation 共同限制异步结果；恢复证据及回退预览另核对用户看到的 evidenceId / planId 与有效期。恢复写后重新读取权威快照并同步，不依赖操作结果中的 released 字段开放输入。
- canonical Timeline 已加入经过 schema 校验的 checkpoint summary，界面从当前 Session 的自然任务边界选择 Diff；移动端明确提供只读 Diff。
- 发现移动端通用回执栏 `Check result` 仅查回执和刷新命令列表，未像 Web 与共享控制层那样刷新权威 Session。丢失恢复成功响应后，原 `outcome_unknown` 快照可能继续阻塞输入，直到手动刷新或其他事件。已交给客户端责任人增加原 Host / Session / transport 绑定的权威刷新；同时补充终态但 `outcomeUnknown` 为真的持久命令显示。

本节是源码审查结果，没有执行移动端设备或真实网络切换验收；最后一项的实现和验证由客户端责任人回报。

## 10. R6 最小实际适配设计

已确认可实现的现有接口：

- Codex：`StdioAppServerClient` 接收现有 `PreparedNativeRuntime.registry` 和 `runtime.spawn`，复用 adapter 的限制参数与环境；只读请求为 `thread/read({threadId, includeTurns:true})`，回退为 `thread/rollback({threadId,numTurns})`。检查 helper 不发送 `turn/start` 或 `thread/resume`，拒绝入站工具请求。
- 锁定 Claude SDK 0.3.220：`getSessionMessages(sessionId,{dir,includeSystemMessages:true})` 返回持久会话链，`forkSession(sessionId,{dir,upToMessageId})` 返回实际新 `sessionId`。通过受管 Node helper 调用这些本地 SDK API，避免父进程直接修改 transcript；不需要发 prompt。SDK 当前没有独立的无 prompt `newConversation` 导出，不能生成一个 UUID 假装原生会话已建立。
- helper 复用 `ManagedRuntimeController.prepare(exactContext)`；真正启动之前、以及准备后发送 mutation 之前同步复核当前 operation/attempt/lease/actor。所有返回路径和超时都关闭原 registry，只有完整树停止证据能够授予 quiescent。`query` 只读取原 mutation journal 与原 helper 结果，不重发。

保留现有 `ManagedNativeRevertPort.read/execute/query`，增加具体实现文件与受管 SDK helper即可，无需另建通用 helper 平台。构造参数只需当前 Host 的 managed runtime options、可信 provider executable/env、原 operation context、同步 `assertCurrent`、原 runtime quiescence 以及既有 journal 查询。Claude fork 返回丢失且未持久化时保持 unknown，不通过会话列表或相似 transcript 猜测新会话。Codex rollback 可在原 helper 停止后由持久历史的精确前缀证明，不得再次 rollback。

历史解析必须保留真实边界：Codex entry ID 为 `thread.turns[].id`，digest 覆盖完整持久 Turn；Claude entry ID 为 SDK `SessionMessage.uuid`，digest 包含角色、消息和工具语义，排除 fork 会重映射的顶层 uuid/session_id。拒绝重复 ID、错误 native session、未知状态、超预算历史；Claude 空数组还可能表示会话不存在，应通过 `getSessionInfo` 核对存在性。SDK result 的 `uuid` 和原始 result digest 单独用于终态证明，不能用 assistant 投影文本替代。

检查点 anchor 与 canonical `SessionNativeHandle` 分开：在私有 manifest JSON 中保存版本化 `nativeHistoryAnchor`，含原 provider/config/version/native session 绑定，以及 compact `historyBoundary={v:1,kind,entryCount,lastId,digest,sourceId}`。捕获由 `captureNativeAnchor(context,phase)` 在实际 checkout lease 下执行受管历史只读查询；public checkpoint summary 不增加这些字段。Driver 的 target resolver 读取目标 manifest，original resolver 读取可信当前元数据。

关键边界修正：before capture 时本次 native Turn ID 尚未产生，不能把上一轮 ID 传入当前“before 排除该 Turn”逻辑。统一使用当时实际读取到的历史前缀 count/lastId/digest，准备时重新读取完整历史并核对精确前缀，before/after 标签不再额外减一。首轮 before 没有原生会话时，完整回退需要真实 new-conversation 合同；缺失则明确 unsupported。before 查询的 quiescence 判断依据 native producer 是否已派发，不能简单要求 Flyx Session idle，因为受理后的业务 Turn 此时已 queued。

这些 TypeScript 接口、解析器和私有锚点管线可以先实现并以受管 transport fixture 验证；当前平台缺少可证明的 C0 boundary 是独立运行条件，不能作为跳过适配层工程的理由。没有真实版本合同和完整平台停止证明时仍不发布已验证回退能力。

## 11. 预览 reservation 新接线复审

当前复审发现并已通知中央实现者：

1. `runtimeState` 使用 `workspaceLease ?? ensureCheckpointLease(...)`，已有 lease 时跳过 actor/expiry/idle 检查；另一 actor 可生成同 lease 的预览，session-only created/aborted callback 还可能更改或释放原 actor reservation。每次上下文解析需验证相同 actor 与精确 lease，回调绑定实际 reservation token。
2. `releaseCheckpointLease` 对正常进行中的 helper 或 open revert 也调用 durable retain。后续正常完成直接 release，没有 clearRetention，因此锁永久报 `OWNER_RECOVERY_REQUIRED`；timer 再调用还可能抛出未处理异常。需要区分正常 in-flight 持有（延后释放）与实际停止未知（保留并走有证据的恢复），不得把取消预览或计时器探测本身升级为不可恢复状态。

上述为发现时的源码状态；待责任人修复并补充对应竞态测试后再关闭。
