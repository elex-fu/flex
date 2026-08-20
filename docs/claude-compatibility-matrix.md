# Claude SDK/CLI 兼容矩阵

> 状态：**初始状态，所有锁定组合均为 `pending`，尚未产生任何验证证据。** 本文档描述矩阵的结构与运行方式；任何"已验证"结论只能来自 `scripts/compatibility/run-matrix.mjs` 产出的证据文件，不允许手改状态。
>
> 机器可读定义（数据源）：`config/claude-compatibility.json`
> 执行脚本：`scripts/compatibility/run-matrix.mjs`
> 设计依据：`docs/mvp-go-and-host-productionization-technical-design.md` 第 5.6 / 5.9 节

## 目的

固化 Claude SDK / Claude Code CLI / Node 的锁定组合，禁止未经回归的漂移升级（设计文档 7 节 Phase 1 目标）。每个锁定组合必须分别完成：

1. **10 次 deterministic Turn**（DeterministicAdapter + 真实 server 栈）——证明 Flyx 编排、receipt、active state 状态机在该组合环境下无重复 Turn / 永久 pending / 文本翻倍；
2. **10 次真实 Turn**（真实 `ClaudeAdapter` → Claude SDK/CLI）——证明 Provider 行为（终态、耗时、错误路径）符合契约。

两类证据分别记录，数字不能相加或互相代替（设计文档 5.9.1 计数口径）。

## 锁定组合

数据以 `config/claude-compatibility.json` 的 `lockedCombinations` 为准。当前组合（`config/claude-compatibility.json` 的快照，重跑脚本后以 json 为权威）：

| 组合 id | SDK | Claude CLI | Node | OS | 状态 |
|---|---|---|---|---|---|
| `sdk-0.3.220_cli-2.1.216_node-24.18.0` | `@anthropic-ai/claude-agent-sdk@0.3.220` | `2.1.216` | `24.18.0` | macOS 25.5.0 arm64 | `pending` |

版本来源：

- `sdkVersion` 取自 `apps/mvp-host/package.json` 中 `@anthropic-ai/claude-agent-sdk` 的精确锁定版本（当前 `0.3.220`）；
- `claudeCliVersion` 取自设计文档 5.6 节的当前候选（`2.1.216`）；本机 `claude --version` 输出 `2.1.216 (Claude Code)` 时视为匹配；
- `nodeVersion` 为锁定运行时版本。

升级规则（设计文档 5.6 矩阵规则 6/7）：未通过矩阵的 SDK/CLI 不能进入启动脚本默认值；依赖升级必须由单独 PR 完成，并附矩阵差异与真实额度记录。

## 验证等级

```text
pending ──(10 次 deterministic Turn 全部 completed)──> deterministic-verified
deterministic-verified ──(10 次真实 Turn 全部 completed，且
                          approvals ≥ 10、interrupts ≥ 10 证据齐备)──> fully-verified
任意已执行层级出现非 completed 终态/超时 ──> broken
```

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `pending` | 尚未验证（初始状态） | — |
| `deterministic-verified` | deterministic 层通过 | 10 次 deterministic Turn 全部到达 `turn.completed` |
| `fully-verified` | 两层均通过 | deterministic 层通过 + 10 次真实 Turn 全部 `turn.completed` + `approvals.jsonl` ≥ 10 条 + `interrupts.jsonl` ≥ 10 条 |
| `broken` | 该组合验证失败 | 已执行的 Turn 出现 `turn.failed` / `turn.cancelled` / 超时 |

关键诚实性规则：**skipped / blocked 不改变状态**。claude CLI 缺失、版本不匹配、Host 无法启动（依赖未装、未登录、preflight 失败）都只是"本轮没有验证"，组合保持原状态并在 `notes`/`summary.json` 里记录原因，绝不装作验证过。auth/额度等外部故障按设计文档 5.9.2 记为 blocked，修复环境后重跑。

`approvals` / `interrupts` 证据（`approvals.jsonl`、`interrupts.jsonl`）由专用审批/中断验证运行产出（如 `RUN_REAL_CLAUDE_FLOW=1` / `RUN_REAL_INTERRUPT=1` 的受控真实测试，allow/deny 各不少于 3 次），`run-matrix.mjs` 只统计其行数，不负责生成。

## 运行方式

```bash
# 前置：仓库根目录执行过 pnpm install；真实层还需要本机 claude CLI 版本与组合一致且已登录
node scripts/compatibility/run-matrix.mjs                       # 跑所有 pending 组合（deterministic + real 两层）
node scripts/compatibility/run-matrix.mjs --deterministic-only  # 只跑 deterministic 层（不需要 claude CLI）
node scripts/compatibility/run-matrix.mjs --combo sdk-0.3.220_cli-2.1.216_node-24.18.0
node scripts/compatibility/run-matrix.mjs --turns 3             # 冒烟用（默认 10，验证等级判定始终要求 10）
```

脚本流程（每个选中组合）：

1. 读取 `config/claude-compatibility.json`；检测本机 `claude --version`（不存在或与 `claudeCliVersion` 不一致 → real 层记 skipped 并写明原因，退出码 0）；
2. **deterministic 层**：spawn `pnpm --filter @flyx/mvp-host exec tsx src/test-support/e2e-main.ts`（与 Playwright E2E 相同的入口：真实 Fastify server 栈 + `DeterministicAdapter`），等待 stdout 的 `FLYX_E2E_HOST_READY base=... token=...` 就绪行；
3. **real 层**：spawn `pnpm --filter @flyx/mvp-host exec tsx src/main.ts`（**真实 `ClaudeAdapter`**，Host 启动时真实执行 Claude preflight），等待 `Flyx MVP Host listening at ...` 与 `Pairing token: ...` 就绪行；
4. 每层通过 Host 的 HTTP 认证（`/api/pairing/exchange` → `/api/auth/browser-session` → `/api/auth/websocket-ticket`）+ WSS RPC（`/api/ws`）驱动 Turn：`session.subscribe` → N 次 `session.startTurn`（矩阵固定安全 prompt）→ 等待权威终态事件（`turn.completed` / `turn.failed` / `turn.cancelled`）；
5. 逐 Turn 追加脱敏证据到 `turns.jsonl`，写入本轮 `summary.json`，并把组合的 `status`、`observed`、`lastRun`、`notes`、`evidence` 指针回写到 `config/claude-compatibility.json`。

每次运行使用独立的 scratch 数据库与随机端口，结束后停止 Host 子进程。

## 证据存放结构

证据目录 `.flyx-evidence/` **已加入 `.gitignore`，不入库**（含真实 Turn 的本地记录，归档方式见设计文档 5.8/5.9：人工上传脱敏 JSON，不提交原始文件）：

```text
.flyx-evidence/
  sdk-0.3.220_cli-2.1.216_node-24.18.0/
    turns.jsonl        # 所有 Turn 的脱敏记录（deterministic 与 real 用 layer 字段区分）
    approvals.jsonl    # 审批证据（由专用审批验证运行产出，本脚本只统计）
    interrupts.jsonl   # 中断证据（由专用中断验证运行产出，本脚本只统计）
    summary.json       # 最近一次运行的汇总（版本、层结果、原因、结论）
    scratch/           # 运行期临时数据库/目录，运行后清理
```

`turns.jsonl` 每行一个 JSON 对象：

| 字段 | 说明 |
|---|---|
| `layer` | `deterministic` 或 `real` |
| `index` / `turnId` | 序号与 Host 生成的 Turn id |
| `promptId` / `promptHash` | 固定矩阵 prompt 的标识与 SHA-256（**不记录 prompt 原文、token、明文成本**） |
| `commandIdHash` | commandId 的哈希前缀（commandId 本身是随机 UUID） |
| `terminalType` | 权威终态事件类型（`turn.completed` 等） |
| `turnStatus` | `completed` / `failed` / `cancelled` / `error` |
| `durationMs` / `startedAt` / `finishedAt` | 耗时与时间戳 |
| `errorSummary` | 仅结构化错误 code（如 `TURN_TIMEOUT`），不含原始报错文本 |

## 当前状态与下一步

- [ ] `sdk-0.3.220_cli-2.1.216_node-24.18.0`：10 次 deterministic Turn（当前 `pending`）
- [ ] 同上组合：10 次真实 Turn
- [ ] 同上组合：10 次审批（allow/deny 各 ≥ 3）+ 10 次中断证据
- [ ] 全部通过后将 `decision` 从 `locked-candidate` 改为 `locked`
