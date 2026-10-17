# Flyx 核心能力实施计划（C0–C8）

> 依据：[核心能力交付技术方案](./core-capabilities-technical-design.md)（下称"方案"）。
> 本文件只记录**实施分工、文件所有权、退出条件与证据**，不修改方案中的契约、验收矩阵或发布门槛。
> 状态口径：`未开始` → `开发中` → `待集成` → `已验证`；只有取得对应验证证据（命令与结果）才标记 `已验证`。

## 1. 环境结论（先行判定，2026-10-18）

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| C0 macOS 监督服务 | **阻塞** | 本机无 Endpoint Security entitlement、签名服务与目标 Mac 的安装授权流程；按方案 §4.6 不得以 Linux、弱化停止证明或轮询替代。C0 未通过前 macOS 真实执行无法宣布可用。 |
| C8 物理手机验收 | **待人工** | 无真机与 Tailscale/Relay 环境；Web 侧最小闭环在本地自动化内验证，物理手机用例保持未完成。 |
| 真实 Provider 验收（A3/A4 等） | **待人工** | 需要真实认证与付费调用；自动化只覆盖 fixture/确定性路径，产物按方案 §16.1 分层记录。 |

因此本计划聚焦 C1–C7 中**可在本机以自动化证据验证**的交付；每个任务的退出条件均按方案 §15 的批次退出条件裁剪，且不得将未验证能力标记为已交付。

## 2. 波次与任务

### 波次 1（并行）

| 任务 | 批次 | 交付范围 | 文件所有权（不得越界） | 退出条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| W1-A | C1 | `ManagedChildHandle` 窄接口与 Node 适配器；Registry/运行时/Claude/Codex/版本查询全部改用窄句柄；Claude SDK `SpawnedProcess` 由锁定的 facade 满足；原始证据变体（版本化 JSON）与不可替换原始身份的回归 | `lifecycle/managed-child-handle.ts`、`lifecycle/managed-process-registry.ts`、`lifecycle/native-boundary-proof.ts`、`provider/`、`claude/adapter.ts`、`codex/app-server-client.ts`、`codex/adapter.ts` 及其测试 | Claude/Codex/helper 均不伪造 `ChildProcess`；准备失败发 error 且不伪造 PID/成功 spawn；原 launch 记录不可替换；目标测试通过 | 已验证 |
| W1-B | C2 | `lifecycle/managed-git-runner.ts`：统一受控 Git/helper 执行（用途白名单、冻结 argv/env/cwd、预算、journal launching→结果→停止证据）；接入 `CheckpointGitDriver`/worktree/restore 注入点；生产构造器缺失 runner 时拒绝；只读查询执行器的能力判定保持 fail-closed | `lifecycle/managed-git-runner.ts`、`lifecycle/managed-workspace-query.ts`、`checkpoint/git-driver.ts`、`checkpoint/controlled-restore.ts`、`checkpoint/controlled-restore-helper.ts`、`git/git-service.ts`、`workspace/workspace-registry.ts`、`workspace/worktree-git.ts` 及其测试 | 异常输出/期限/停止证据/关库回归；超时与关库 deadline 先停止再 drain；无原始 fallback | 开发中 |
| W1-C | C7 | Host 级 `WorktreeScheduler`：提交后唤醒 + 启动扫描、只处理当前 owner/generation 未派发持久 intent、调用既有 `HostWorktrees.dispatchAccepted`；关闭顺序与 `seal()` 幂等 fence 回归 | `workspace/worktree-scheduler.ts`（新增）、`workspace/host-worktrees.ts`、`lifecycle/catalog-host-lifecycle.ts` 及其测试 | 两个独立 checkout 可各自由 pending intent 派发；同 checkout 互斥；提交后唤醒不丢；关闭先封闭扫描 | 已验证 |

### 波次 2（依赖波次 1 合入后）

| 任务 | 批次 | 交付范围 | 状态 |
| --- | --- | --- | --- |
| W2-D | C3 | `HostActivationService` + `host_execution_operations` 管理操作 Store、本地 verify/activate、启动加载与失效、`host.getExecutionReadiness` 只读 RPC | 未开始 |
| W2-E | C4 | `NativeHistoryReaderFactory`（Codex `thread/read` 只读、Claude transcript 只读）、恢复端口接线、restore 外部复核（`restore inspect-state/confirm-state` 语义） | 未开始 |
| W2-F | C5 | Checkpoint 生产组合：全局 `HostCheckpoints`、`bindWorker`、`executionBinding`、runtimeState/leaseForContext/captureStateFor 由实际运行时提供 | 未开始 |
| W2-G | C6 | Claude `forkSession(upToMessageId)` / Codex `thread/read`+`thread/rollback(numTurns)` 的 NativeRevertDriver；响应丢失只读核对；部分失败保留 safety | 未开始 |

### 波次 3

| 任务 | 批次 | 交付范围 | 状态 |
| --- | --- | --- | --- |
| W3-H | C8（Web 部分） | Web 会话管理/恢复/Diff/Worktree 面板接通 client-core 控制器；旧响应按 generation 隔离、原 commandId 保留 | 未开始 |
| W3-I | 验收 | 方案 §16.2 中可自动化的用例（A1、A2、A5、A6、A8、A9、A12、A13 等）落到独立套件；不可自动化项登记为待人工 | 未开始 |

## 3. 固定的中央所有权

为避免互相捕获未初始化对象与并行写冲突，以下文件由集成方（主会话）修改，子任务不得直接编辑：

- `apps/mvp-host/src/host-application.ts`、`main.ts`、`server.ts`
- `apps/mvp-host/src/storage/migrations/011-*.ts`、`schema-version.ts`、`storage/db.ts` 的迁移 runner
- `apps/mvp-web/src/app.tsx` 与 `apps/mobile/src/**` 的界面入口（波次 3 统一接线）

各任务在自身分支/工作树完成并自证后，由集成方按顺序合入 `codex/flyx-optimization` 并推送。

## 4. 每个任务的验证要求（最低）

1. `pnpm --filter @flyx/mvp-host typecheck` 与本任务全部测试文件通过；需要跨包类型时额外 `pnpm typecheck:tests`。
2. 测试必须覆盖任务退出条件中的**失败路径**（例如缺 runner 拒绝、准备失败、迟到回调、关库 deadline）。
3. 不得弱化既有 gate、停止证明或 fail-closed 行为；不得用类型断言掩盖句柄差异。
4. 报告格式：变更文件、验证命令与结果、已知限制、分支提交号。

## 5. 记录

| 日期 | 任务 | 提交 | 证据摘要 |
| --- | --- | --- | --- |
| 2026-10-18 | 基线 | 见提交记录 | 工作树收尾（生命周期多 fence 封闭、主入口清理错误保留）；全量 `pnpm test:product` 结果见任务记录 |
| 2026-10-18 | W1-A（C1） | `17551a7`（合并 `9bbe263`） | `typecheck`/`typecheck:tests` 通过；`src/lifecycle src/workspace src/provider src/claude src/codex src/git src/operations src/orchestration src/session src/checkpoint src/test-support` 584 passed/5 skipped；新增窄句柄失败路径（无 PID 不伪造 spawn/exit、原 launch 不可替换、late-listener replay）用例 |
| 2026-10-18 | W1-C（C7） | `5ac8150`（合并 `82c0a3e`） | `worktree-scheduler` 8 用例 + `host-worktrees` 13 用例（seal 幂等 fence/lease 不假释放）；`src/workspace` 66 passed；`typecheck(:tests)` 通过 |
| 2026-10-18 | 中央迁移 011 | 本次提交 | `011-execution-activation`（`host_execution_operations` + 资源 `activation_operation_id`/`activation_binding_digest`/`readiness_revision` + validator）；冻结 v10 fixture；空库/冻结 v10/重复打开/requires-010/篡改拒绝/旧程序 FUTURE_SCHEMA 用例；`src/storage src/attention src/session src/catalog src/diagnostics`（含修复后重跑目标文件）通过 |
