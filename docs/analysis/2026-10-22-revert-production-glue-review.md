# R6 Revert 生产接线审查（2026-10-22）

## 结论与当前缺口

现有 RevertService 已有完整操作/步骤/尝试记录和 pre-send dispatch 提交，不能另建 journal DDL。新 native-revert-drivers 是可注入的执行与证据校验机制，尚无真实 managed transport，不能算完整生产 Revert。macOS 正向 transport 仍受 R0/C0 硬阻塞；本次仅阅读代码，没有 Provider 调用。

审查期间代码由多人同时开发；以下指向实际读取的接口和行为，最终接线需与合并后的版本再核对。

1. `createCatalogCheckpoints.runtimeState` 只读已加载运行时的 `workspaceLease`；成功 Turn 结束会释放该 lease，而 preview 要求空闲且持有真实 lease。因此当前组合不能正常为普通 idle Session 建立 preview。
2. `CheckpointLease.generation` 来自 Host owner generation；preview 校验要求更换 lease 后 generation 严格增加。同一 Host 释放并重新取得 lease 不满足 succession；必须保留同一 lease，或令旧 preview 失效后重建。
3. 审查发现 rich `NativeRevertHandle` 与严格 v1 `SessionNativeHandleSchema`、完整 proof/catalog 摘要不兼容。随后驱动代理已添加 `resolveHandle(canonical, context)` 与独立 `nativeHistoryHandle`，并令 proof.nativeHandle 返回 schema-valid canonical handle；本报告已核对该源码变更。**尚需生产组合把私有历史元数据与成功投影原子持久化**，不能仅更新 catalog handle。
4. Driver journal 如果独立更新 operation JSON，`RevertService.provider()` 随后仍用旧 revision 调用 `applied()`，会冲突或覆盖附加证据。journal 必须由同一服务控制事务与重新加载。
5. `workspaceRestore` 当前只按 helper 可用性声明；如果缺少经验证的 new-conversation transition，它可能恢复文件后保留 `NEW_CONVERSATION_REQUIRED` 阻塞，不能被宣传为完整恢复并可继续新 Turn。

## 最小 HostRevertPorts 接线

复用 `createCatalogCheckpoints(catalog, views, runner, revert?)`。下面是建议的内部能力签名，不是已经实现的端口或可用保证：

```ts
// 由 SessionOrchestrator 的同一个串行命令/所有权边界管理。
ensureCheckpointLease(input: {
  actorId: string;
  purpose: "preview" | "revert" | "recovery";
  expectedSessionRevision?: number;
  previousLease?: CheckpointLease;
}): Promise<WorkspaceLease>;

// 查询原始全部进程及后继 helper，不启动 Provider。
inspectRevertWriters(operation: RevertOperation): Promise<{
  proven: boolean;
  proofId: string;
}>;
```

`ensureCheckpointLease` 不是公开 setter。它必须确认当前 actor、Session/workspace、真实 checkout、当前 owner、无冲突 Turn/任务和用途允许的恢复 gate，取得真实 WorkspaceLease 后登记到原运行时所有权状态中。preview 需要在 `resolveContext` 之前取得这项租约，不能仅在 Revert accept 的 acquire 中补，因为 accept 也先 resolve。

最小稳定路线：preview 创建时取得一个专用 lease ID，在计划有效期和后续 accept/execute 中保留同一个 lease。Revert operationId 可以不同；目前接口是在取得 lease、准备计划后才生成 operationId，不能倒推 lease.operationId 必须等于新 operationId。失败/过期/取消需要清理未被操作消费的 reservation；已消费或停止未证实时必须保留。资源读历史、读取已持久化 Diff 不得为了取这些信息加载运行时或取得新 lease。

不要在 `projectSuccess` 中释放租约：那时数据库事务尚未提交。应在最终提交后且相关 Provider、查询与 restore helpers 都有停止证据时释放；事务失败、unknown、服务关闭 deadline 则保留。当前 HostRevertPorts 没有完整 reservation/settlement 生命周期，需把这些少量调用放在现有 HostCheckpoints/RevertService 操作入口与结束边界，而非创建第二套调度器。

- `acquire(input)`：调用上述 runtime 边界，核对 previousLease；原 lease 仍持有就返回同一对象。新 Host 的恢复接管只能用真实 OwnershipRecoveryAuthorization/验证者和原进程停止证据，不能伪造 generation。无法证明 succession 就返回 PLAN_STALE/RECOVERY_BLOCKED。
- `dispatchContextFor(context, operationId, attemptId)`：调用已存在的 `SessionOrchestrator.operationContext(operationId, attemptId, context.runtimeGeneration)`。运行时 ID、owner、Session 必须来自实际加载对象；不得从 RPC 体取得或重绑定旧 intent。当前 MAX(turns.generation) 是组合中使用的值，若继续用它，须作为该 Session 的持久 generation 水位并在接受/派发时一致核对，不能宣称它代表另一次真实 Native 启动。
- `proveQuiescence(operation)`：核对该 operation.commands 的全部原始和后继尝试、原 Session/checkout 的相关未决生产者及 managed helper 记录；验证身份、boundary、stop-proof 和覆盖完整性。当前进程 Map 为空或没有加载运行时不构成证明。复用 managed_processes 与 identities/boundaries/stop_proofs 的既有记录及验真逻辑；缺 birth、launch 或证明返回 proven=false。不能仅查当前 attempt 或让 fixture 常量进入生产。
- `assertRestoreWriteReady(db)`：复用 CatalogStore 的 restore gate 断言，保持同步同连接。它不是跳过其他恢复 gate 的开关；Revert 自有 gate 由 `RevertStore.assertGate(operation)` 精确核对。
- `verifyWorkerRevision`：默认已有 acceptedRevision + 2，来自当前 Worker 的 claim 与 dispatch 两次提交；没有额外 hook 提交则不要覆盖。若 hook 新增提交，必须按原 intent、事件来源和准确序列验证，不使用 `>=` 或恒 true。
- `verifyLeaseSuccession`：没有可信交接证明时省略即可，现有逻辑会拒绝。当前纯 previous/current 两 token 不是证明，可信实现必须查自己管理的原身份和无介入写入证据。

## 实际 projectSuccess

已有 HostCheckpoints 测试展示了正确事务形状：

```ts
projectSuccess(db, { operation, epoch, nativeProof, sourceSequence }) {
  // assert same owned DB, active outer transaction, current actor and exact gate
  const canonical = canonicalHandleFromVerifiedProof(nativeProof);
  catalog.catalog.setNativeHandle(operation.sessionId, canonical);
  views.projector.createEpoch(operation.sessionId, "building", epoch);
  new TimelineBackfill(views.projector, () => catalog.owner.assertActive())
    .run(operation.sessionId, { epoch });
  // assert active epoch == epoch and indexedSequence == sourceSequence
  return { epoch, nativeHandleBinding: bindingDigest(canonical) };
}
```

其中 `canonicalHandleFromVerifiedProof` 表示 Host 对已校验 proof 的严格 schema/绑定复核，不得用 cast 或只挑字段绕过 proof。驱动现已采用下述分离；生产持久化仍需落实：将 **canonical SessionNativeHandle** 与 **经验证的执行/历史元数据** 分开：proof 中交付可以精确写入 catalog 的 canonical handle；原始版本/配置/锚点保存在现有版本化 NativeHandle/Checkpoint 元数据并单独绑定摘要。若选择扩展共享持久化 schema，必须显式版本化、修改全部消费者/校验/摘要，不能靠宽松对象混过严格 schema。

DB 成功后旧加载 adapter 也不能继续引用回退前的 Native session。后续每 Turn 构造/恢复必须从新的 canonical handle 取值，并按已验证跨进程续接语义运行。更新 catalog 一行不代表旧运行时已换绑。

## 复用持久步骤的 mutation journal

现有 `RevertService.provider()` 在调用 native.apply 前，已通过 `dispatch()` 将 NativeRevertRequest 同时写入 provider step 和最新 attempt。`RevertStore.save()` 在 Engine 提交钩子内同步 operation_json、step_json、attempt_json。推荐在现有 `RevertStepAttempt` 的版本化 JSON 上追加 `nativeMutation?: { mutation, receipt? }`，无新表、无构造器 DDL、无第二连接。

建议由 RevertService 暴露/持有窄 adapter：

```ts
nativeMutationJournal(): NativeRevertMutationJournal;
// claim/get/record 仍用 driver 已定义的参数；在服务内部经 update()/Engine hooks 写入。
```

`claim` 先加载 operation、当前 provider step 和最新 attempt，验证 requestId/digest/commandIntentId/lease/原 dispatch fence、running+dispatching 状态和精确 gate，再在同一 Engine 事务中写入 mutation claim。第一次提交成功后返回 claimed；已记录同一请求返回 existing；不同内容或将旧 requestId 绑定到其他 operation/attempt 必须拒绝。一个 operation 的显式恢复可产生新 requestId，但只有原请求经核对为 not_applied 后才允许走新的 pending→dispatching；旧请求的所有尝试永久保留，不能覆盖后再重发。

`record` 验证 exact mutation 与 helper receipt，使用同一 update() 路径持久化单调结果。已完成结果不能被改成另一 native session 或 not_dispatched。`get` 查询原始 operation/attempt；如果原记录不存在则 unknown。不要把“step.request 已存在”当成首次 claim 的 existing，否则每次首次发送都会被抑制。

因为 claim/record 增加 operation/session revision，`provider()` 在 `await native.apply()` 后必须重新加载并核对**同一个 operation、command、step、attempt、request 和 gate**，只接受自身 journal 引起的准确提交序列，再用该版本 `applied()`。不能粗暴接受任何新 revision。外层失败分支原本已经重新加载再 partial；成功分支也需要这项协调。这样复用原始 request claim，又能在响应返回后、最终 proof 提交前持久保存 fork 的目标 Native ID。

另一种严格方案是让 dispatch 事务本身发出仅当前执行调用持有的一次性 send permit；restart 无 permit，一律 query。它仍需上述 receipt 持久化和版本协调。本轮优先前述服务拥有 journal 的实现，避免两个独立授权源。

## transport 与验证范围

`ManagedNativeRevertPort.read/execute/query` 不能由普通 SDK 调用冒充。真实实现需要：原 request/attempt 绑定的受管 launch；固定方法白名单；受管只读 history；原 request 的 durable helper receipt；独立的完整树停止证据；query 永不重发 rollback/fork/start。Claude response 丢失且没有准确 fork receipt 时，不能扫描出相似 transcript 就认领新 session。

在 C0 未解决的当前 Mac 上，可以完成这些端口的结构、服务-owned journal、错绑定拒绝、重复调用/重建 driver 不重发、事务失败和迟到响应 fixture 测试；**不能完成真实 managed transport 的可用验收**。`ProviderNativeRevertDriver({})` 可以用于明确拒绝，不是正向组合完成。现有确定性测试通过、真实 OS helper 局部可运行、真实 Provider 回退闭环是三层不同结论。

## 10 月 23 日聚焦复核补充

服务现已提供 `nativeFactory(journal)`，并通过既有 `update()` / Engine commit hook 在 provider attempt JSON 中保存 claim 与 receipt。成功路径新增 `refreshAfterNativeJournal()`，只接受同一 attempt/request 的准确 claim/receipt revision 增量及其余 operation 内容不变。以上是当前源码观察，不替代真实 Provider 验收。

本轮另发现迟到只读结果可能触发 mutation：原 driver 在 claim 后等待 native history；若等待超过 RevertService deadline，外层已将 operation 标成 blocked，迟到读结果却仍可能调用 execute。worker 已将顺序改为“先检查已有 claim；已有则仅 query；读取原 history；重新验证并提交当前活跃 claim；立即 execute”，中间不再插入 awaited read。实际 managed port 在 spawn 时仍须复核当前精确许可。此修复的测试由实现与验证 worker负责，本报告没有宣称另跑真实 Provider。
