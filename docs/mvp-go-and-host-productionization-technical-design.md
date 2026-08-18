# Flyx MVP Go 与 Host / 协议生产化技术方案

> 版本：v0.1
> 日期：2026-08-12
> 适用范围：Claude-only MVP 收口、Host 生产化、协议版本化和 Android 前置基础
> 前置文档：[Claude-only 最小 MVP 验证方案](./claude-only-minimal-mvp-validation.md)

### 0.1 重新审查记录

本版经过四轮检查：前两轮完成代码一致性和总体安全补充；后两轮重新验证协议公式、v1 迁移、生命周期顺序、故障窗口、备份一致性和验收口径。后两轮发现并修正的关键问题：

1. 协议版本原公式会选择最低共同版本，已改为最高共同版本；
2. Phase 1 E2E 错误依赖 Phase 2 的 `/readyz`，已改为轮询现有 `/api/bootstrap`；
3. v1 兼容方案会提前禁用旧 Web 写操作，已改为明确兼容窗口；
4. 优雅关闭先 drain EventWriter 再关闭 Provider 会丢迟到终态，已重排关闭顺序；
5. `outcome_unknown` 缺少继续工作的显式路径，已增加对账/新 Session 语义；
6. Provider intent 无法区分“未派发”和“可能已派发”，已增加 claim/lease 状态；
7. SQLite 直接复制/模糊回滚不可靠，已改为 online backup 与备份回滚；
8. 未知 required Event、Timeline epoch、WSS catch-up 背压和 logout lease 原先定义不足，已补齐。

## 1. 结论先行

当前项目已经具备一条可运行的 Claude 远程控制垂直切片：

```text
Host 启动
  -> 本地配对确认
  -> 手机 Web 建立会话
  -> 发送 Claude Turn
  -> 实时文本 / Tool / Approval
  -> follow-up / interrupt
  -> SQLite 事件补同步
  -> Git Diff
```

当前阶段的主要问题不是“再增加一个 Provider”，而是三个闭环还没有同时完成：

1. **MVP 验收闭环**：真实手机、Tailscale、断网、Host 崩溃和真实压力场景仍缺少完整证据；
2. **Host 生产化闭环**：启动状态、Provider 进程、SQLite 备份、诊断、Host 身份和设备撤销仍是验证实现；
3. **客户端复用闭环**：`apps/mvp-web/src/app.tsx` 仍同时承担 Web UI、WebSocket、Timeline reducer、重连和命令幂等，无法直接复用到 Android。

因此采用两阶段推进：

```text
Phase 1：MVP Go
  E2E + 真机 + 故障 + 版本矩阵 + 配对 + CI 证据

Phase 2：Host / 协议生产化
  版本协商 + Host 生命周期 + Runtime 管理 + SQLite 运维
  + 诊断指标 + Host/设备身份 + client-core 抽取

Phase 3：Android-first
  在 Phase 1、Phase 2 退出条件满足后再启动
```

在 Phase 1 和 Phase 2 完成前，不开发 Codex、多 Agent、Relay 或复杂 Android UI。否则会把 Provider 可靠性、Host 进程可靠性和移动端生命周期问题混在一个大切片中。

## 2. 当前基线与差距

### 2.1 已存在的实现

| 领域 | 当前实现 | 代码位置 |
|---|---|---|
| Claude 接入 | Agent SDK、流式文本、结构化 Tool、`canUseTool`、session resume、interrupt、sandbox | `apps/mvp-host/src/claude/adapter.ts` |
| Session/Turn | 一个当前 Session、一个 active Turn、命令幂等、审批 CAS、generation fence | `apps/mvp-host/src/session/orchestrator.ts` |
| 持久化 | SQLite WAL、事件序列、Timeline projection、command receipt、恢复为 `outcome_unknown` | `apps/mvp-host/src/storage/db.ts` |
| HTTP/WSS | pairing grant、浏览器会话、单次 WSS ticket、Origin 校验、限流、logout | `apps/mvp-host/src/server.ts` |
| Web 控制台 | 配对、Timeline、Approval、follow-up、interrupt、Diff、刷新和自动重连 | `apps/mvp-web/src/app.tsx` |
| 协议 | Zod-first 的 Frame、Session、Turn、Event、TimelineItem | `packages/mvp-protocol/src/index.ts` |
| Fixture | 可重置的 Git fixture、故意失败的 `npm test`、长任务脚本 | `packages/claude-fixtures/` |
| 启动 | 安装依赖、构建 Web/Host、启动 Host | `scripts/start-host.sh` |

### 2.2 当前证据

本机自动化回归应保持以下命令通过：

```bash
pnpm run typecheck
pnpm run build
pnpm test
```

当前产品测试覆盖 protocol 2 个测试、Host 21 个测试、Web 1 个测试。真实 Claude preflight、Spike、Tool/Approval flow、interrupt 和 deterministic 30-turn 测试已有记录，但不能替代真手机、断网和崩溃场景。

需要特别修正的现状：

- `pnpm test:e2e` 当前引用了不存在的 Web `test:e2e` script，必须补齐 Playwright 或删除错误入口；
- 方案描述“扫码配对”，当前实际是 Token 文本输入，没有 QR 生成和扫描；
- `/api/bootstrap` 的 `protocolVersion` 固定为 1，没有版本范围协商；
- `SessionOrchestrator` 固定一个 Session、一个 Workspace 和一个 Claude Provider；
- Host 只有启动/停止，不具备完整的 ready/draining、Provider runtime registry 或自更新交接；
- Web 的同步和 reducer 仍在 `app.tsx`，没有可供 React Native 复用的 `client-core`；
- 没有可提交的 CI workflow、Playwright 报告和脱敏失败工件。

### 2.3 当前 v1 接口约束

Phase 2 不能假设当前协议已经具备版本化能力，必须把下面的现状当作迁移输入：

- HTTP：`/api/bootstrap`、`/api/pairing/exchange`、`/api/auth/browser-session`、`/api/auth/logout`、`/api/auth/websocket-ticket`、`/api/snapshot`、`/api/status`、`/api/session/:id/timeline`、`/api/session/:id/diff`；
- WSS method：`host.probe`、`session.create`、`session.startTurn`、`session.interrupt`、`approval.respond`、`session.subscribe`；
- v1 通过 `FrameSchema` 区分 request/response/event，没有 `client.hello`；
- WSS ticket 当前放在 URL query 中，浏览器依赖 HttpOnly Cookie 完成 pairing 后的身份关联；
- `/api/bootstrap` 当前在未配对状态也返回 Provider capability 和 Workspace basename，生产化应收敛为最小非敏感 Host 元数据；
- 客户端当前在每次写请求中生成 commandId，重试/离线 outbox 还没有稳定复用同一个 commandId 的领域模型；
- 当前 `trustProxy: true` 依赖 Fastify 解析 `request.ip`，尚未配置明确的可信代理边界；
- 当前 logout 撤销浏览器会话，但没有按设备关闭已建立的 WSS lease，也没有独立的设备注册表。

所有 v2 改造都必须提供 v1 兼容窗口、迁移测试和回滚策略，不能直接替换现有 `FrameSchema` 或删除 v1 method。

### 2.4 两阶段完成定义

| 阶段 | 完成定义 | 不代表什么 |
|---|---|---|
| MVP Go | 16 个验收场景、P0 Spike、30 个真实 Turn、断网/刷新/interrupt/崩溃证据全部满足退出条件 | 不代表多 Provider、多 Agent 或移动端生产可用 |
| Host/协议生产化 | 协议可版本协商，Host 可观测、可排空、可恢复，DB 可迁移/备份，客户端核心可复用 | 不代表 Relay、Android 推送或多 Agent 已完成 |

## 3. 目标、非目标与原则

### 3.1 Phase 1 目标

- 让 MVP 16 个场景可重复执行，而不是依赖一次人工演示；
- 将真实手机和 Tailscale Serve 纳入验收证据；
- 对手机断网、Host 崩溃、Provider 失败、版本不兼容进行可追溯验证；
- 固化 Claude SDK/Claude Code/Node/macOS 组合，禁止未经回归的漂移升级；
- 让配对方式、失败日志、测试报告和 Go/No-Go 结论可复核。

### 3.2 Phase 2 目标

- 在不改变当前 Session/Turn/Event/Approval/Diff 语义的前提下，为 Android 和未来 Provider 预留稳定协议；
- Host 明确区分启动中、可接收、降级、排空和停止状态；
- Provider 子进程或 SDK runtime 有明确的创建、运行、终止和未知状态语义；
- SQLite 在升级、磁盘不足、异常退出和备份恢复时不产生静默数据损坏；
- 日志、诊断和指标能定位一次控制命令从手机到 Provider 的完整路径；
- 把平台无关的同步和领域状态从 React 页面抽取为可测试的 `packages/client-core`。

### 3.3 非目标

本方案不在两阶段内实现：

- Codex/OpenCode Adapter；
- 多 Agent 调度、Task/Subtask/Handoff；
- Relay、E2EE 和公网中继；
- Git checkpoint/revert、worktree 自动隔离；
- 通用 Terminal、文件编辑器、图片附件；
- Android 本地执行 Agent；
- iOS 原生功能交付。

### 3.4 不可违反的原则

1. Provider 只在 Host 执行，手机不持有 Claude 凭证；
2. 客户端断开不等于取消 Provider Turn；
3. `commandId` 只保证 Flyx 控制命令去重，不宣称外部副作用 exactly-once；
4. Provider 状态未知时显示 `outcome_unknown`，禁止自动重放；
5. 没有结构化 Provider 协议时不退回 PTY 正则作为主路径；
6. 所有版本、事件和 capability 变化必须可回放、可降级、可诊断；
7. 先完成可验证的单 Host/单 Session，再增加并发和多实例。

## 4. 目标架构

```text
                         ┌──────────────────────────┐
                         │  Playwright / 真手机     │
                         │  Web / Android Client    │
                         └─────────────┬────────────┘
                                       │ HTTPS + WSS
                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Flyx Host                                                            │
│                                                                      │
│  HostLifecycle / Readiness / Draining                                │
│          │                                                           │
│  HTTP + WSS + ProtocolNegotiator + Auth/DeviceRegistry              │
│          │                                                           │
│  SessionOrchestrator + CommandInbox + EventWriter                   │
│          │                     │                                    │
│  TimelineProjection       SQLiteStore + BackupManager               │
│          │                     │                                    │
│  ProviderRuntimeRegistry ─── ClaudeAdapter / future ProviderAdapter  │
│          │                                                           │
│  Diagnostics + Metrics + Redacted Audit                             │
└──────────┬───────────────────────────────────────────────────────────┘
           │ structured SDK / managed child process
           ▼
     Claude Code / Claude Agent SDK
           │
           ▼
     canonical Workspace + Git
```

### 4.1 组件边界

| 组件 | 责任 | 不允许承担的责任 |
|---|---|---|
| `ProtocolNegotiator` | 握手、版本范围、capability、method scope | 不执行 Provider 命令 |
| `ConnectionSupervisor` | WSS lease、重连、订阅和补同步 | 不修改 Host 权威状态 |
| `SessionOrchestrator` | Session/Turn 命令决策和事务 intent | 不直接管理 HTTP 连接 |
| `EventWriter` | 单 writer 分配 sequence、事件和 projection 原子提交 | 不调用外部 Provider |
| `ProviderRuntimeRegistry` | Runtime 生命周期、generation、句柄和健康状态 | 不解析 Web UI payload |
| `ClaudeAdapter` | Claude SDK 事件/权限/interrupt/resume | 不持久化 Timeline |
| `BackupManager` | SQLite snapshot、校验、保留和恢复 | 不在执行中复制未提交临时文件 |
| `Diagnostics` | 脱敏状态、日志、计数器和耗时 | 不输出 Token、Cookie、Prompt 原文 |
| `client-core` | 客户端状态、同步、命令和 capability | 不依赖 React、DOM 或 React Native |

## 5. Phase 1：MVP Go 详细方案

### 5.1 工作流与顺序

Phase 1 采用四条并行工作流，但退出顺序固定：

```text
A. E2E 与 fixture
       ├─> B. 真手机/Tailscale/断网/崩溃
       ├─> C. 版本矩阵与配对
       └─> D. CI、报告、工件
                    │
                    ▼
              MVP Go/No-Go
```

推荐先完成 A，再进行 B。没有确定性 E2E，真机失败很难判断是 Provider、协议还是 UI 问题。

### 5.2 E2E 测试架构

#### 5.2.1 测试层级

| 层级 | 运行频率 | Provider | 目标 |
|---|---|---|---|
| Unit | 每次 PR | fake/deterministic | reducer、协议 schema、状态机、路径 guard |
| Host integration | 每次 PR | `DeterministicAdapter` | Fastify inject、SQLite、幂等、恢复、审批 |
| Browser E2E | 每次 PR | fake adapter | 配对、Timeline、Approval、刷新、Diff、interrupt UI |
| Real Claude smoke | 手动/受控 nightly | 真实 SDK | preflight、Tool、审批、resume、interrupt |
| 真机验收 | Release candidate | 真实 Claude | Tailscale、网络切换、后台、布局和人工操作 |

#### 5.2.2 Playwright 结构

新增建议目录：

```text
apps/mvp-web/
  playwright.config.ts
  e2e/
    pairing.spec.ts
    turn-flow.spec.ts
    approval.spec.ts
    reconnect.spec.ts
    interrupt.spec.ts
    diff.spec.ts
    security.spec.ts
```

根目录脚本调整为：

```json
{
  "scripts": {
    "test:e2e": "pnpm --filter @flyx/mvp-web test:e2e"
  }
}
```

Web 包必须增加：

```json
{
  "scripts": {
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "锁定版本"
  }
}
```

Playwright 不启动真实 Claude，而是启动一个测试 Host：

1. 使用临时 Workspace clone 或 fixture copy；
2. 使用临时 SQLite 文件；
3. 注入 `DeterministicAdapter`，可按测试控制文本、Tool、Approval、延迟、interrupt 和失败；
4. 使用随机可用端口，不依赖正在运行的开发 Host；
5. 每个测试结束关闭 WebSocket、Host 和 SQLite；
6. 失败时保留截图、视频、trace、Host JSON 日志和 SQLite 副本；
7. 测试中禁止使用真实 pairing token、真实 Cookie 和真实 Claude 凭证。

推荐增加 `apps/mvp-host/src/test-support/e2e-host.ts` 作为 Playwright 专用入口。它负责：

- 创建临时 SQLite 和临时 fixture；
- 注入 deterministic adapter；
- 设置 `FLYX_ALLOW_INSECURE_HTTP=1`、自动 pairing confirmation 和受限随机端口，仅在测试进程内生效；
- Phase 1 轮询现有 `/api/bootstrap` 直到返回 200 后再让 Playwright 打开页面；Phase 2 引入 `/readyz` 后再切换为 readiness probe；
- 收到 SIGTERM 后先关闭 WSS，再关闭 Host 和临时 DB；
- 将测试用 pairing URL 通过一个不落盘的 stdout marker 交给 Playwright fixture。

`playwright.config.ts` 使用 `webServer` 启动该入口，禁止复用开发者手工启动的 4173 端口。浏览器测试必须能够独立运行：

```text
pnpm run build
pnpm test:e2e
```

其中 `pnpm run build` 只负责生成 Web/Host 产物，E2E host 负责注入 fake adapter，不得因为本机是否登录 Claude 而改变结果。

#### 5.2.3 DeterministicAdapter 场景模型

测试 Adapter 需要支持以下可编程事件：

```ts
type FakeScenario = {
  sessionId: string;
  turns: Array<{
    promptIncludes: string;
    events: FakeProviderEvent[];
    outcome: "completed" | "failed" | "cancelled" | "outcome_unknown";
    approvals?: Array<{ toolName: string; input: Record<string, unknown> }>;
    delayMs?: number;
    interruptMode?: "ack" | "timeout" | "already_terminal";
  }>;
};
```

Fake Adapter 只能用于测试注入，生产 Host 启动时必须使用真实 `ClaudeAdapter`。测试必须同时断言：

- Provider 事件顺序；
- Host canonical Event 顺序；
- Timeline projection；
- command receipt 状态；
- snapshot 的 activity state；
- 客户端 item 是否重复、翻倍或永久 pending。

为适配当前 `SessionOrchestrator` 的注入点，fake adapter 至少实现 `status()`、`preflight()`、`runTurn()` 和 `interrupt()`，并通过与真实 Adapter 相同的事件回调将事件送入 Orchestrator。不得在 E2E 中直接写 SQLite 绕过 Orchestrator，否则无法验证事件、projection 和 receipt 的原子边界。

### 5.3 16 个 MVP 验收场景

| 编号 | 场景 | 自动化方式 | 核心断言 | 必留证据 |
|---:|---|---|---|---|
| 1 | 配对 | Playwright + 真机 | 一次性 grant、Host 本地确认、Cookie 建立 | pairing response、Host 确认时间、截图 |
| 2 | 首个真实任务 | Playwright fake + 真实 Claude | Turn accepted、user message、assistant delta、terminal | Event sequence、Provider 版本 |
| 3 | Timeline 稳定投影 | Playwright | partial + completed 不重复正文，Tool start/result 配对 | Timeline 截图、事件 JSON |
| 4 | `allow_once` | fake + 真实 Claude | 审批跨 WSS 往返，继续执行，只解决一次 | approval requested/resolved |
| 5 | deny | fake + 真实 Claude | 拒绝事件可见，Provider 不获得持久 allow | approval action、settings 检查 |
| 6 | Diff | fake + fixture | 显示 baseline、文件列表、unified diff、dirty warning | Diff 截图和 baseline commit |
| 7 | follow-up | 真实 Claude | 使用同一 provider session id，保留上下文 | 两次 Turn 的 session id |
| 8 | streaming 刷新 | Playwright | 刷新后从 SQLite 补齐，无丢失/重复/翻倍 | Playwright trace、sequence |
| 9 | 断网 60 秒 | 真机 | Claude 继续执行，恢复后 sequence 连续 | 手机网络时间线、Host 日志 |
| 10 | 重复 commandId | Host integration | 只创建一个 Turn，重复请求返回原 receipt | receipt 行和事件数量 |
| 11 | interrupt | fake + 真实 Claude | 未确认前显示 interrupting，确认后才 cancelled | interrupt ACK、terminal event |
| 12 | 关闭页面 | Playwright + 真机 | 页面关闭不取消 Provider，重新进入可恢复 | 页面关闭时间、Turn 状态 |
| 13 | 正常 Host 重启 | Host integration + 人工 | 已完成 Timeline、sequence、terminal 状态保留 | 前后 DB snapshot |
| 14 | active Turn 崩溃 | 故障注入 + 人工 | 变为 `outcome_unknown`，不自动重放，旧审批 superseded | crash 点、recovery event |
| 15 | 安全边界 | Playwright + Host integration | URL/RPC、`../`、symlink、跨 Origin、sandbox 均拒绝 | 安全响应、无绝对路径泄漏 |
| 16 | 撤销与 ticket | Playwright + 真机 | Phase 1 验证 logout 后旧 Cookie、未消费 ticket 和新连接失效；Phase 2 设备 revoke 后全部既有 lease 也立即关闭 | 401/1008、重新配对截图 |

每个场景的报告统一包含：

```text
scenarioId
startedAt / finishedAt
hostVersion / protocolVersion
nodeVersion / os
sdkVersion / claudeVersion / executableSource
fixtureCommit / databasePathHash
result: passed | failed | blocked
hostLogArtifact / browserTraceArtifact / screenshotArtifact
failureCode / operatorNotes
```

### 5.4 真手机与 Tailscale 验证

#### 5.4.1 拓扑

```text
Android/iOS 浏览器
        │ HTTPS/WSS
        ▼
Tailscale Serve
        │ loopback proxy
        ▼
127.0.0.1:4173 Flyx Host
        │
        ▼
Claude Agent SDK + fixture Workspace
```

要求：

- Host 只监听 loopback；
- 不使用 Tailscale Funnel；
- 手机和 Mac 在同一 tailnet；
- Tailscale hostname、Host instance id 和证书状态记录到报告；
- 真实部署不设置 `FLYX_ALLOW_INSECURE_HTTP=1`；
- Host 启动时使用 `FLYX_REQUIRE_TAILSCALE_SERVE=1` 做只读检查；
- 测试账号和 fixture 不包含真实业务凭证。

#### 5.4.2 操作步骤

1. `pnpm --filter @flyx/claude-fixtures reset`；
2. 启动 Tailscale Serve，将本地 4173 映射为 HTTPS；
3. `FLYX_REQUIRE_TAILSCALE_SERVE=1 ./scripts/start-host.sh`；
4. 手机打开 HTTPS 地址；
5. 输入 Token 或扫描 QR；
6. 在 Host 终端确认配对；
7. 完成首个 Turn、审批、Diff、follow-up、interrupt；
8. 关闭手机网络 60 秒，再恢复；
9. 注销会话并验证旧 Cookie、未消费 ticket 和新连接失效；现有已建立 WSS 的主动关闭作为 Phase 2 device revoke 验收；
10. 保存手机录屏、Host 日志、Tailscale status 和 SQLite hash。

#### 5.4.3 通过标准

- 没有公网入站端口；
- 断网期间 Claude 不因客户端断开自动取消；
- 恢复后事件 sequence 无缺口、无重复；
- logout 后旧 Cookie 和未消费 ticket 无法建立新的控制连接；Phase 2 device revoke 后既有 lease 也无法执行写命令；
- Host 端未出现 prompt、Token、Cookie 或绝对 Workspace 路径泄漏。

### 5.5 Host 崩溃与恢复测试

故障测试必须区分“Host 已接受命令前”和“Host 已调用 Provider 后”两个窗口。

#### 5.5.1 注入点

```text
T0  HTTP/WSS 收到 request
T1  receipt 写入前
T2  turn.requested / user.message 提交后
T3  Provider intent 提交后
T4  Claude query 已启动
T5  approval requested 已提交
T6  interrupt 已请求但未 ACK
T7  Provider terminal 已收到但未提交
T8  terminal event、projection、receipt 同事务提交后
```

#### 5.5.2 预期行为

| 崩溃位置 | 重启后行为 |
|---|---|
| T0/T1 | 不应产生 Turn，客户端可安全重试原 commandId |
| T2 | 当前 MVP 没有 durable Provider intent，保守标记 `outcome_unknown`；Phase 2 若事务内存在未 claim 的 `committed` intent 才允许安全 dispatch |
| T3 | Phase 2 根据 intent claim 状态判断：从未 claim 可 dispatch；`dispatching/dispatched` 无法证明未执行时转 `outcome_unknown` |
| T4/T5 | active Turn 标记 `outcome_unknown`，不自动重放；pending approval superseded |
| T6 | 仍为 interrupting 或 outcome_unknown，禁止新 Turn，等待人工诊断 |
| T7 | 以已提交事件为准；无 terminal 则 outcome_unknown |
| T8 | 完成态、Timeline 和 receipt 必须一致 |

#### 5.5.3 恢复断言

重启流程必须按以下顺序：

```text
打开 DB
  -> PRAGMA quick_check
  -> 迁移校验
  -> 找出 active / outcome_unknown Turn
  -> 标记 recovery required
  -> supersede pending approvals
  -> 启动 HTTP/WSS
  -> 允许只读 snapshot
  -> 仅在明确状态后允许新 Turn
```

MVP 不承诺重新 attach Host 崩溃时仍运行的 Claude query。任何实现 reattach 的版本都必须先新增 Provider capability，并通过独立故障矩阵验证。

### 5.6 Claude SDK/CLI 兼容矩阵

建立 `docs/claude-compatibility-matrix.md` 和机器可读的 `config/claude-compatibility.json`。每个组合必须包含：

| 字段 | 示例/要求 |
|---|---|
| `hostVersion` | Git commit 或发布版本 |
| `nodeVersion` | 精确版本，最低 Node 22 |
| `os` | macOS 版本和架构 |
| `sdkVersion` | 当前候选 `@anthropic-ai/claude-agent-sdk@0.3.220` |
| `executableSource` | SDK bundled 或本机 executable |
| `claudeVersion` | 当前候选 `2.1.216` |
| `authMode` | 本机登录来源/API 模式，不能记录 secret |
| `sandbox` | enabled/failIfUnavailable/unsandboxed false |
| `settingSources` | `user` + inline isolation 结果 |
| `p0Results` | probe/tool/approval/resume/interrupt |
| `cost` | 测试预算和实际成本区间 |
| `decision` | locked / candidate / rejected |

矩阵规则：

1. 每个锁定组合先完成 10 个 deterministic Adapter/Orchestrator Turn，再完成至少 10 个真实 Claude Turn；两类证据分别记录；
2. allow/deny 各至少 3 次；
3. 真实 follow-up 必须使用同一 provider session；
4. partial/completed、Tool start/result、interrupt terminal reason 全部通过；
5. sandbox、callback shadow、auth 失败都必须 fail closed；
6. 未通过矩阵的 SDK/CLI 不能进入启动脚本默认值；
7. 依赖升级由单独 PR 完成，必须附矩阵差异和真实额度记录。

Host `/api/status` 和诊断报告只输出版本、来源和状态，不输出登录路径、Token 或环境变量值。

### 5.7 QR 配对方案

#### 5.7.1 推荐实现

保留 Token 文本输入作为 fallback，同时增加 QR URL。QR 不携带长期凭证，只携带短期 pairing grant：

```text
https://<tailscale-host>/#pair=<base64url-pairing-payload>
```

使用 URL fragment 而不是 query，避免 grant 出现在 Host HTTP access log、Tailscale proxy log 和 Referer 中。fragment 解码后是一个短期 payload，包含非敏感的 Host hint：

```json
{
  "v": 1,
  "endpointHint": "https://host.tailnet.ts.net",
  "hostId": "stable-host-id",
  "grant": "short-lived-token"
}
```

服务端流程：

```text
Host 启动
  -> 生成/加载 stable hostId
  -> 生成 5 分钟 pairing grant，仅存 hash
  -> 终端输出 URL 和二维码
手机扫描
  -> 校验 endpoint/hostId
  -> POST /api/pairing/exchange
  -> Host 终端人工确认
  -> grant 原子消费
  -> 生成一次性 browser credential
  -> 建立 HttpOnly session
```

安全要求：

- grant 只能消费一次；
- grant 只允许指定 Host 和 scope；
- 每个来源 60 秒最多 5 次尝试；
- 终端默认必须人工确认；
- QR 不包含 Claude、Workspace、Prompt 或用户身份信息；
- 旧 QR 在消费、过期或 Host identity 变化后失效；logout 撤销由 QR 建立的浏览器/设备会话，但不需要改变一个尚未消费的独立 pairing grant，除非产品显式提供“撤销全部配对码”；
- 手机无法验证 Host identity 时不得静默切换到另一个 Host。

如果本阶段不实现 QR，则必须把 MVP 文档中的“扫码配对”统一改为“Token 配对”，避免验收标准与产品表现不一致。

实现建议：

- Host 终端本地生成 QR，不调用第三方二维码 API；
- 使用锁定版本的纯 Node QR 库或 `qrcode-terminal`，二维码输入只是一段 URL；
- Web 页面从 `location.hash` 读取 pairing payload，交换成功后立即 `history.replaceState` 清除 fragment；
- Android 后续使用系统相机/Expo barcode scanner 读取同一 URL，不重新定义二维码格式；
- QR 生成失败不阻塞 Token 文本配对，终端必须同时打印短 Token 和明确的过期时间。

### 5.8 CI、测试报告与失败工件

建议增加以下 CI 工作流：

```text
.github/workflows/
  verify.yml       # typecheck/build/unit/integration
  browser-e2e.yml  # Playwright + deterministic Host
  dependency.yml   # lockfile、audit、兼容矩阵提醒
```

#### PR 阶段

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm test:e2e
```

#### 受控真实 Claude 阶段

真实 Claude 不在普通 PR 中运行，采用人工触发或受保护 nightly：

```bash
RUN_REAL_CLAUDE_SPIKE=1 pnpm test:spike
RUN_REAL_CLAUDE_FLOW=1 pnpm --filter @flyx/mvp-host exec vitest run src/claude/adapter.flow.test.ts
RUN_REAL_INTERRUPT=1 pnpm --filter @flyx/mvp-host exec vitest run src/claude/adapter.interrupt.test.ts
```

CI 约束：

- 真实 Token、Cookie、Authorization、Prompt 原文禁止写入工件；
- Host 日志统一 JSON，上传前执行 secret scanner；
- Playwright 失败上传 trace、截图、视频、浏览器 console、Host log 和 DB schema hash；
- 每个报告包含 Git commit、SDK/CLI/Node/OS、fixture commit 和 scenario id；
- 失败工件保留 14 天，成功工件保留 7 天；
- 真机报告由人工上传同一格式 JSON，不把视频提交到 Git。

### 5.9 Phase 1 Go 门槛

只有同时满足以下条件才标记 Go：

- 16 个场景全部通过；
- P0 Spike 7 项退出条件全部通过；
- 30 个真实 Turn 无重复 Turn、永久 pending、文本翻倍；
- 至少 10 次真实 approval allow/deny 成功；
- 至少 10 次 interrupt 中 9 次在 5 秒内到达权威终态，其余明确为未确认；
- 刷新和 60 秒断网各重复 10 次无缺口/重复；
- 版本不兼容、未登录、sandbox 不可用均 fail closed；
- 真手机/Tailscale 无公网入站端口；
- 所有证据已归档，失败项有可复现命令和日志。

否则只能标记为 `Conditional Go`，并明确未通过项，不得开始多 Agent 开发。

#### 5.9.1 证据来源必须分层

当前 30-turn deterministic Orchestrator 测试只证明 Flyx 编排、receipt 和 active state 没有明显重复，不等于“30 个真实 Claude Turn”。Go 报告必须分别列出：

```text
deterministicOrchestratorTurns  # CI fake adapter，验证 Flyx 状态机
realClaudeTurns                 # 真实 SDK/CLI，验证 Provider 行为
browserE2eScenarios             # Playwright，验证 Web 控制面
physicalPhoneScenarios          # 真机/Tailscale，验证网络与移动端
```

不同层级的数字不能相加或互相代替。真实 Claude Turn 必须由锁定兼容组合执行，并记录实际 provider session、terminal reason、审批和 interrupt 结果的脱敏摘要。

#### 5.9.2 计数口径

- “10 次 approval allow/deny”表示至少 10 次真实 SDK 往返，并且 allow 和 deny 各不少于 3 次；
- “10 次 interrupt”必须在独立 Turn 上执行，不能重复点击同一 Turn 计数；
- “刷新/断网各 10 次”每次都必须从已记录的起始 sequence 到最终 sequence 做连续性校验；
- Provider auth、额度或 Tailscale 外部故障记为 blocked，不得记为产品通过或失败；修复环境后必须重跑；
- Go 的分母固定，不能删除失败样本后重新编号。

## 6. Phase 2：Host 与协议生产化

### 6.1 分层改造目标

当前：

```text
main.ts -> server.ts -> SessionOrchestrator -> ClaudeAdapter / SqliteStore
                         └-> app.tsx 自己维护客户端同步
```

目标：

```text
main.ts
  -> HostLifecycle
  -> ReadinessCoordinator
  -> HttpWssServer
       -> ProtocolNegotiator
       -> Auth/DeviceRegistry
       -> Session API
  -> SessionOrchestrator
       -> CommandInbox
       -> EventWriter
       -> ProviderRuntimeRegistry
       -> SqliteStore / BackupManager
       -> Diagnostics / Metrics

Web / Android
  -> client-core
       -> TransportAdapter
       -> SyncEngine
       -> DomainReducer
       -> CommandOutbox
       -> CapabilityGate
```

### 6.2 协议版本协商与 capability negotiation

#### 6.2.1 版本模型

`ProtocolVersion = 1` 只保留作为兼容版本。新增 `ProtocolRange`：

```ts
type ProtocolRange = {
  min: number;
  max: number;
};

type ClientHello = {
  protocol: ProtocolRange;
  clientType: "web" | "android" | "ios";
  clientVersion: string;
  instanceId: string;
  requestedCapabilities?: string[];
};

type HostHello = {
  protocol: ProtocolRange;
  selectedProtocol: number;
  hostId: string;
  hostVersion: string;
  minSafeClientVersion?: string;
  capabilities: Record<string, {
    enabled: boolean;
    version?: number;
    requiredScopes?: string[];
    reason?: string;
  }>;
};
```

选择规则必须选择双方支持的最高共同版本：

```text
commonMin = max(client.min, host.min)
commonMax = min(client.max, host.max)
if commonMin > commonMax: PROTOCOL_INCOMPATIBLE
selected = commonMax
```

协商失败时只允许返回安全错误，不创建 Session、不启动 Provider、不产生副作用。

#### 6.2.2 握手顺序

HTTP bootstrap 只提供非敏感元数据。客户端选出版本后，后续 HTTP 请求携带 `Flyx-Protocol` header；WSS 在 hello 中提交同一版本。browser/device session 保存已选版本，HTTP、ticket 和 WSS 三者不一致时返回 `PROTOCOL_SESSION_MISMATCH`：

```text
GET /api/bootstrap
  -> hostId / hostVersion / protocolRange / pairingRequired / capabilities

POST /api/auth/websocket-ticket { selectedProtocol }
  -> 单次、短期 ticket

WSS connect
  -> client.hello
  <- host.hello
  -> session.subscribe
  <- catch-up events + subscribe response
```

WSS 未完成 `client.hello` 前禁止处理 `session.startTurn`、`approval.respond` 和 `session.interrupt`。

当前浏览器版本仍可使用短期 query ticket，但必须满足：

- ticket 只允许一次消费，TTL 不超过 60 秒；
- Fastify、Host、Tailscale 和反向代理日志全部对 URL query 做显式脱敏；
- WSS 连接建立后立即从 URL 和内存连接状态清除 ticket；
- ticket 只能绑定一个 Host、一个设备/会话主体和一个 protocol handshake；
- Phase 2 优先迁移到限时首帧 `auth.hello`，避免 bearer 出现在 URL；不使用可能被代理记录或由服务端回显的 WebSocket subprotocol 承载 bearer；
- 未认证 socket 最长存活 5 秒、最大只接受一个小型 auth frame，且不注册 domain listener；
- 首帧认证失败时立即关闭连接，不触发订阅、Provider 或数据库写操作。

#### 6.2.3 Capability 规则

能力必须是可关闭的细粒度字符串，例如：

```text
timeline.v1
timeline.pagination.v1
session.follow_up.v1
session.interrupt.v1
approval.allow_once.v1
approval.deny.v1
git.diff.v1
host.qr_pairing.v1
host.device_revoke.v1
host.process_diagnostics.v1
```

客户端：

- 只调用已协商且 enabled 的 method；
- 未知 capability 不视为失败；
- capability 被关闭时隐藏对应 UI，并保留明确 unavailable 原因；
- 安全 interrupt 和只读 snapshot 尽量不因非关键 capability 关闭而消失；
- 不根据 Host 版本字符串猜测能力。

Method scope 也必须显式映射，不能只靠 UI 隐藏：

```ts
const MethodScopes = {
  "host.probe": ["host.read"],
  "session.create": ["session.read"],
  "session.subscribe": ["session.read"],
  "session.startTurn": ["session.write"],
  "session.interrupt": ["session.control"],
  "approval.respond": ["approval.respond"],
  "git.diff": ["workspace.read"],
  "host.device.revoke": ["host.admin"],
} as const;
```

服务端在 dispatch 前同时检查：已协商 capability、设备 scope、Session 归属和 Host lifecycle。未授权 method 必须返回结构化 `AUTH_SCOPE_DENIED`，不能落入普通 `METHOD_NOT_FOUND`。

#### 6.2.3.1 v1 兼容迁移

迁移期规则：

1. `/api/bootstrap` 返回 `protocolRange`，同时保留 v1 客户端能够读取的 `protocolVersion: 1`；
2. v2 客户端完成 `client.hello` 后使用 `host.hello`；
3. 兼容窗口内，使用 v1 Frame 且没有 hello 的已认证客户端继续允许全部现有 v1 method；Host 按 v1 固定 capability 和现有 browser-session scope 处理；
4. v1 客户端不能调用 v2-only method，服务端返回 `PROTOCOL_CAPABILITY_REQUIRED`；
5. v1 Event 缺少 `epoch/schemaVersion` 时，Host 发送兼容 envelope，客户端按 v1 reducer 处理；
6. 任何客户端均不得因为未知字段或未知 optional capability 失败。

#### 6.2.4 Event 兼容

Event 继续使用 `type` + `payload`，增加可选字段：

```ts
type SessionEventEnvelope = {
  id: string;
  sessionId: string;
  sequence: number;
  epoch: string;
  type: string;
  schemaVersion: number;
  minProtocol?: number;
  compatibility?: "optional" | "required";
  payload: unknown;
  occurredAt: string;
};
```

规则：

- 新增可选字段不提升 schemaVersion；
- 删除/改变字段语义必须增加 schemaVersion；
- 客户端对未知且 `compatibility = optional` 的 event 记录诊断后推进 sequence；
- 客户端遇到未知 required event 或 `minProtocol > selectedProtocol` 时停止投影，获取权威 snapshot；仍无法解释则进入 `protocol_blocked`，不能无限 resync；
- 不认识 payload 的事件不得被解释为成功、审批或终态；
- Projection 失败必须触发 snapshot resync，而不是继续猜测状态；
- Event sequence 只由 Host EventWriter 分配，客户端不能写入。

`epoch` 在一个 Session 的 Timeline lineage 内稳定，并持久化在 `sessions.timeline_epoch`；普通 Host 重启不能改变它。只有未来的权威历史替换、revert 或显式重建 projection 才生成新 epoch。客户端发现 epoch 改变时必须丢弃该 Session 的 cursor、item cache 和待发送命令，再从 sequence 0 获取 snapshot/catch-up。

#### 6.2.5 错误分类

统一错误至少包含：

```ts
type RpcError = {
  code: string;
  message: string;
  retryable: boolean;
  traceId: string;
  details?: {
    requiredCapability?: string;
    retryAfterMs?: number;
    currentState?: string;
  };
};
```

v2 response 必须包含 `traceId`；v1 兼容 response 中它保持可选，避免破坏现有 `RpcErrorSchema`。

错误码分层：

```text
AUTH_*                 配对、会话、设备撤销
PROTOCOL_*             版本、握手、未知 method
HOST_*                 readiness、draining、degraded
SESSION_*              busy、not found、archived
COMMAND_*              duplicate、hash mismatch、expired
APPROVAL_*             not found、already resolved、superseded
PROVIDER_*             unavailable、auth、timeout、unknown
WORKSPACE_*            moved、deleted、outside root
STORAGE_*              busy、full、corrupt、migration
```

手机号/浏览器只接收可行动且脱敏的 message；完整错误通过 `traceId` 在 Host 日志查找。

#### 6.2.6 HTTP/RPC 合同表

| 接口 | 认证 | 允许副作用 | 幂等/重试 | 生产化要求 |
|---|---|---|---|---|
| `GET /healthz` | 无 | 否 | 可重复 | 不读取 DB 业务内容，不暴露版本细节 |
| `GET /readyz` | 无或本机 | 否 | 可重复 | 只返回 ready/degraded/draining 和脱敏 code |
| `GET /api/bootstrap` | 无 | 否 | 可重复 | 只返回 Host identity、协议范围和配对状态 |
| `POST /api/pairing/exchange` | pairing grant | 消费 grant | 不可重试同一成功 grant | rate limit、本地确认、hash 存储 |
| `POST /api/auth/browser-session` | 一次 credential | 创建 session | credential 单次消费 | Secure/HttpOnly/SameSite cookie |
| `POST /api/auth/logout` | browser/device session | 撤销当前设备 | 可重复 | 关闭 lease、失效 ticket |
| `POST /api/auth/websocket-ticket` | session | 创建短期 ticket | 不重放 | 绑定 host/device/protocol |
| `GET /api/snapshot` | session | 否 | 可重复 | no-store、权威状态 |
| `GET /api/session/:id/timeline` | session | 否 | 可重复 | `upTo` 固定上界、分页有界 |
| `GET /api/session/:id/diff` | session + workspace.read | 否 | 可重复 | 限制大小、脱敏绝对路径 |
| `GET /api/diagnostics` | host.read/admin | 否 | 可重复 | 不输出 secret，限制频率 |
| WSS `session.startTurn` | session.write | 创建 Provider intent | commandId 幂等 | ready 且 capability enabled |
| WSS `approval.respond` | approval.respond | 解决一次审批 | version CAS + commandId | 旧审批返回 superseded |
| WSS `session.interrupt` | session.control | 请求中止 | commandId 幂等 | 未确认时不得允许新 Turn |

所有写接口必须区分“请求被 Host 接受”和“Provider 已达到终态”。HTTP/WSS response 只返回 command receipt 当前状态，最终权威状态通过 Event/Timeline 观察。

### 6.3 Host readiness、draining 与优雅关闭

#### 6.3.1 生命周期

```text
created
  -> starting
  -> probing
  -> ready
  -> degraded
  -> draining
  -> stopped

starting/probing 失败 -> failed
ready 运行时故障 -> degraded
degraded 可恢复 -> probing -> ready
```

状态定义：

| 状态 | 允许读 | 允许新 Turn | 允许审批/interrupt | 对外表现 |
|---|---:|---:|---:|---|
| starting | 否 | 否 | 否 | 503 |
| probing | 否 | 否 | 否 | 503 |
| ready | 是 | 是 | 是 | 200 |
| degraded | 是 | 否 | 仅安全 interrupt/已有审批 | 200/503，明确原因 |
| draining | 是 | 否 | 已有 Turn 可控制 | 409/503 |
| stopped | 否 | 否 | 否 | 连接关闭 |

`outcome_unknown` 是 Turn 的终态但也是 Session 的阻塞状态：它表示历史副作用不可确认，不能自动回到 `idle`。Phase 1 保持“人工在电脑处理/重新创建干净 DB”的验证边界；Phase 2 必须增加显式对账命令，例如：

```text
session.resolveUnknown(
  turnId,
  resolution = "observed_completed" | "observed_failed" | "abandoned"
)
```

该命令只改变 Flyx 的对账状态，不伪造 Provider 终态、不自动重放 Turn，并记录 audit event。未完成显式对账前，同一 Session 继续拒绝新 Turn；需要继续工作时可以创建新 Session，而不是把未知 Turn 改回 idle。

#### 6.3.2 启动检查

顺序必须固定：

1. 获取单 Host lock/pid file；
2. 加载 Host identity；
3. 打开 SQLite；
4. 执行 `PRAGMA quick_check`、WAL 和 migration 校验；
5. canonicalize Workspace 并检查 Git；
6. 检查 Claude SDK/CLI 版本组合；
7. 检查 sandbox 可用性和 permission callback 未被 shadow；
8. 恢复 active Turn、pending approval 和 command receipt；
9. 仅在以上通过后开始 HTTP/WSS listen；
10. 写入 `host.ready` 并允许写命令。

Provider preflight 失败时 Host 可以进入 `degraded` 或直接失败，但不得启动未隔离的 Claude query。

#### 6.3.3 关闭流程

```text
SIGTERM/SIGINT
  -> state = draining
  -> 拒绝新 startTurn
  -> 允许已有 approval / interrupt / read
  -> 停止接受新的 provider intent
  -> drain CommandInbox（不再产生新 intent）
  -> 请求 active Provider runtime drain/interrupt
  -> 等待 Provider terminal 或关闭超时
  -> active Turn 仍无权威终态则提交 outcome_unknown
  -> drain EventWriter（此后不再产生领域事件）
  -> 完成/取消 BackupManager 当前任务
  -> checkpoint WAL / flush logs
  -> close WSS/HTTP 和 Provider runtime handle
  -> release lock
  -> stopped
```

关闭必须有超时，例如 30 秒。超时后不执行全局 `kill`，而是保留 `outcome_unknown` 和受限诊断；Provider 是否仍存在由下一次启动的 Runtime Registry 处理。

新增接口：

```text
GET /healthz  -> 进程存活，不读取 Provider
GET /readyz   -> readiness + degraded/draining 原因
GET /api/status -> 脱敏 Provider、Git、Session、Host 状态
```

### 6.4 Provider 进程生命周期与异常退出

#### 6.4.1 Runtime Registry

新增 `ProviderRuntimeRegistry`，逻辑记录如下：

```ts
type ProviderRuntime = {
  runtimeId: string;
  provider: "claude";
  generation: number;
  state: "starting" | "ready" | "running" | "draining" | "closed" | "unknown";
  nativeHandle?: string;
  pid?: number;
  startedAt: string;
  lastHeartbeatAt?: string;
  supportsResume: boolean;
  supportsReattach: boolean;
  failureCode?: string;
};
```

`nativeHandle` 只由 Adapter 解释，Orchestrator 不解析 Claude 内部 session 文件。

#### 6.4.2 生命周期 API

```ts
interface ProviderRuntimeAdapter {
  probe(): Promise<ProviderProbeResult>;
  create(scope: ProviderScope): Promise<ProviderRuntimeHandle>;
  ensureLoaded(handle: ProviderRuntimeHandle): Promise<ProviderRuntimeStatus>;
  runTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent>;
  interrupt(reason: string): Promise<InterruptResult>;
  close(mode: "drain" | "abort"): Promise<void>;
  inspect(): Promise<ProviderRuntimeDiagnostics>;
}
```

Claude SDK 目前不保证 Host 能安全重新 attach 崩溃时仍运行的 query，因此：

- `supportsReattach = false` 时，Host 重启只标记 `outcome_unknown`；
- 不根据 PID 全局扫描并接管无归属进程；
- 不杀死不属于当前 Runtime Registry 的进程；
- runtime generation 变化后，旧事件不能更新新 Turn；
- Provider terminal、Host event 和 receipt 必须通过同一事务边界对账。

#### 6.4.3 Provider intent 与调用顺序

```text
client command
  -> SQLite accepted receipt
  -> provider.intent committed
  -> ProviderRuntimeRegistry dispatch
  -> Adapter query
  -> Provider events
  -> EventWriter / projection / receipt
```

Provider 调用不能发生在事务 commit 之前。若 commit 后 Host 崩溃，恢复器通过 intent 和 receipt 判断是 `dispatched`、`completed` 还是 `outcome_unknown`，不能重新执行未知外部副作用。

为了区分 commit 后但尚未 dispatch 的安全窗口，Provider Reactor 在执行前必须以事务方式 claim intent：

```text
committed -> dispatching(leaseOwner, leaseExpiresAt) -> dispatched -> terminal
```

- `committed` 且从未被 claim 的 intent 可以在重启后安全 dispatch；
- `dispatching` lease 过期但无法证明 Provider 未收到命令时，转为 `outcome_unknown`；
- `dispatched` 没有 terminal 时转为 `outcome_unknown`，禁止重发；
- Adapter 支持 provider-side idempotency key 时也只能减少风险，不能提升为 exactly-once 承诺；
- claim、receipt 和可观察 event 必须处于明确的事务边界。

### 6.5 SQLite 备份、迁移与磁盘满

#### 6.5.1 Schema 版本

当前 `schema_migrations` 已存在，但迁移逻辑仍是启动时 `ALTER TABLE`。生产化改为显式版本脚本：

```text
apps/mvp-host/src/storage/migrations/
  001_initial.sql
  002_turn_auth_subject.sql
  003_session_baseline.sql
  004_host_identity.sql
  005_devices_and_revocation.sql
  006_provider_runtime.sql
```

迁移要求：

- 每个版本只执行一次；
- 迁移在独占事务中执行；
- 记录 checksum、开始时间、完成时间和失败原因；
- 迁移失败时 Host 不进入 ready；
- 迁移不能删除未知列或未知数据；
- 新代码至少能从当前版本和上一个版本原地升级；旧二进制不承诺读取已升级 DB，回滚必须恢复迁移前备份；
- 备份恢复必须在临时 DB 上先跑 migration 和 quick check。

SQLite schema migration 通常不可安全 down-migrate，因此发布流程是“备份 -> 升级副本验证 -> 原库迁移 -> 启动”。若新 Host 启动失败，停止新二进制并使用原二进制 + 迁移前备份恢复，不能让旧二进制直接打开已升级数据库。

#### 6.5.2 备份策略

新增 `BackupManager`：

```ts
interface BackupManager {
  create(reason: "scheduled" | "pre_migration" | "manual"): Promise<BackupResult>;
  verify(path: string): Promise<BackupVerification>;
  list(): Promise<BackupInfo[]>;
  prune(policy: RetentionPolicy): Promise<void>;
}
```

策略：

- 迁移前自动备份；
- 每次 Host 正常关闭至少执行一次 WAL checkpoint；
- 默认保留最近 3 个成功备份；
- 使用 SQLite online backup API 或 `VACUUM INTO` 创建一致快照，禁止直接复制 `.sqlite` 而漏掉 WAL；
- 备份写入同一文件系统的临时文件后 fsync 并原子 rename；跨文件系统只能 copy + fsync + verify，不能宣称 rename 原子；
- 备份完成后执行 `PRAGMA quick_check`；
- 备份只包含当前 SQLite 已持久化的数据，不新增 Token、Cookie 或环境变量；其中 Prompt、Timeline 和相对路径仍按敏感数据处理；
- 备份路径不与当前 DB 相同，不允许递归覆盖 Workspace。

#### 6.5.3 磁盘满与 SQLite 错误

错误分级：

| 错误 | Host 行为 |
|---|---|
| `SQLITE_BUSY/LOCKED` | 有界重试，超过阈值进入 degraded，拒绝新 Turn |
| `SQLITE_FULL` | 立即停止新写命令，尝试写一次受限诊断，进入 degraded |
| `SQLITE_CORRUPT` | 不启动 Provider，进入 failed，提示从备份恢复 |
| WAL checkpoint 失败 | 保留可读状态，禁止宣称 clean shutdown |
| migration 失败 | 不 listen 或只提供本地诊断，不接受控制命令 |

### 6.6 日志、诊断与基本指标

#### 6.6.1 日志字段

所有 Host 日志使用 JSON，至少包含：

```text
timestamp
level
component
traceId
requestId
sessionId
turnId
commandId
approvalId
providerRuntimeId
providerGeneration
protocolVersion
eventSequence
errorCode
durationMs
```

禁止记录：

- pairing token、browser cookie、WSS ticket、Authorization；
- 完整 Prompt、Tool input 原文、环境变量值；
- Workspace 绝对路径；
- Claude session secret 或认证文件内容。

日志中的 Prompt/Tool 只允许记录长度、hash、工具名和脱敏相对路径。

#### 6.6.2 诊断接口

新增：

```text
GET /api/diagnostics
```

返回：

- Host identity 和版本；
- protocol range 和已选版本；
- lifecycle/readiness/draining 状态；
- Workspace basename、Git 状态摘要；
- Provider SDK/CLI 版本、runtime state、sandbox 状态；
- SQLite schema version、WAL size、last backup、degraded reason；
- 当前 Session activity、active Turn 状态和 sequence；
- 最近错误的 code、traceId 和时间。

不返回：Token、Cookie、Prompt、完整命令行、绝对路径和凭证。

#### 6.6.3 指标

先使用进程内 counters/histograms，后续再接 OpenTelemetry。指标建议：

```text
host_ready_total
host_degraded_total
provider_probe_total{result}
turn_started_total{provider}
turn_terminal_total{status}
approval_requested_total
approval_resolved_total{action}
interrupt_total{result}
command_duplicate_total
timeline_resync_total{reason}
websocket_disconnect_total{code}
sqlite_error_total{code}
backup_total{result}
duration_ms{operation}
```

指标标签禁止使用 Prompt、Workspace 绝对路径、用户账号或任意高基数字符串。

### 6.7 Host identity、Tailscale endpoint 与设备撤销

#### 6.7.1 Host identity

Host identity 不能使用 hostname。新增持久化记录：

```ts
type HostIdentity = {
  hostId: string;
  createdAt: string;
  publicKey?: string;
  keyAlgorithm?: "ed25519";
  hostVersion: string;
};
```

MVP 可先使用随机 UUID；生产化建议增加 Host signing key：

- 私钥只保存在 Host 本机安全目录；
- public key、hostId 和 endpoint hint 可发送给客户端；
- QR pairing 包含 hostId/fingerprint；
- endpoint 变化不改变 hostId；
- hostId 或公钥变化必须要求重新配对。

Host identity 不能只依赖 SQLite：

- `hostId` 和 signing key 的 canonical 副本放在 Host 专用 identity 目录，权限为 owner-only；
- DB 中保存 fingerprint 和最后观察值，用于启动时一致性校验；
- 从旧 DB 或备份恢复时，如果 identity 文件与 DB fingerprint 不一致，Host 进入 `identity_mismatch`，不接受写命令；
- 删除 identity 文件视为换机/丢失场景，必须显式执行 re-pair，而不是自动生成同名新 Host；
- 备份不复制私钥，迁移和恢复只携带 public fingerprint。

密钥写入使用临时文件、`fsync`、owner-only mode 后原子 rename；禁止先创建 world-readable 文件再 chmod。日志和诊断只输出短 fingerprint，不输出 public key 全文或 identity 目录绝对路径。

#### 6.7.2 Tailscale endpoint

新增 `EndpointProvider`，只读发现和探测：

```ts
type AdvertisedEndpoint = {
  url: string;
  transport: "https-wss";
  source: "tailscale-serve";
  hostId: string;
  browserCompatible: boolean;
  observedAt: string;
  probe: "unknown" | "reachable" | "unreachable";
};
```

规则：

- endpoint 是候选，不是可达证明；
- 连接前必须执行 HTTPS/WSS probe；
- 禁止自动开启 Funnel；
- endpoint 切换不能切换到不同 hostId；
- 连接失败时保留旧 endpoint 供诊断，不静默降级到 HTTP。

Host signing key 在当前阶段只用于稳定身份/fingerprint，不直接替代 TLS。客户端仍必须验证 Tailscale HTTPS；未来若签名 endpoint descriptor，应包含 `hostId + url + transport + issuedAt + expiresAt + nonce`，并拒绝过期或重放 descriptor。

#### 6.7.3 设备和会话撤销

当前 browser session logout 只撤销单个 Cookie。生产化增加：

```sql
CREATE TABLE devices(
  device_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  display_name TEXT,
  platform TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
)
```

所有 WSS ticket 必须关联 `deviceId` 和 `hostId`：

- 设备 revoke 后立即不能换取新 ticket；
- 已建立 WSS 收到 revoke 事件后主动关闭；
- 旧 ticket 即使未过期也不能使用；
- Android 后续可将设备 credential 升级为 DPoP，但不能破坏当前 scope 语义；
- 列表页只显示设备名、平台、最后活跃时间，不显示 credential。

Android 不应复用浏览器 HttpOnly Cookie，设备配对单独定义为：

```text
POST /api/pairing/device-exchange
  input: { grant, deviceId, devicePublicKey, platform, requestedScopes }
  output: { deviceCredential, hostId, selectedProtocol, grantedScopes }
```

服务端必须校验：

- grant 尚未消费且属于当前 Host；
- requested scopes 是 pairing grant 的子集；
- `deviceId` 与 public key 未被另一个未撤销设备占用；
- 设备 credential 只以 hash 落盘；
- 后续 WSS ticket 绑定 device、host、protocol 和 scope；
- Android 使用 SecureStore/Keystore 保存 credential，不能写入普通 AsyncStorage。

DPoP、密钥轮换和设备证明属于 Android 阶段，但 Phase 2 的表结构和 scope 模型不能预先绑定 bearer-only 语义。

### 6.8 `packages/client-core` 抽取方案

#### 6.8.1 目录

```text
packages/client-core/
  src/
    domain.ts          # Snapshot、Timeline、Connection、Capability
    protocol.ts        # Transport 无关的 frame decode/encode
    transport.ts       # Transport/Auth/Storage 接口
    sync-engine.ts     # bootstrap、catch-up、subscribe、gap recovery
    reducer.ts         # SessionEvent -> ClientState
    commands.ts        # commandId、receipt、outbox 状态
    errors.ts          # 可行动错误和 retry policy
    clock.ts            # 可注入时间
    ids.ts              # 可注入 UUID
    index.ts
  test/
    reducer.test.ts
    sync-engine.test.ts
    command-outbox.test.ts
```

#### 6.8.2 平台无关接口

```ts
export interface FlyxTransport {
  bootstrap(): Promise<BootstrapEnvelope>;
  snapshot(): Promise<Snapshot>;
  timeline(input: TimelineQuery): Promise<TimelinePage>;
  issueTicket(): Promise<Ticket>;
  connect(ticket: Ticket, handlers: TransportHandlers): Promise<TransportLease>;
  request(frame: RequestFrame): Promise<unknown>;
  close(reason: string): Promise<void>;
}

export interface AuthAdapter {
  getCredential(): Promise<string | undefined>;
  saveCredential(value: string): Promise<void>;
  revokeCredential(): Promise<void>;
}

export interface ClientStorage {
  loadState(hostId: string, sessionId: string): Promise<PersistedClientState | undefined>;
  saveState(state: PersistedClientState): Promise<void>;
  clear(hostId: string): Promise<void>;
}
```

Web 实现：

- `BrowserFetchTransport` 使用 same-origin fetch；
- HttpOnly Cookie 不暴露给 JavaScript；
- `BrowserWebSocketTransport` 使用 WSS ticket；
- `MemoryClientStorage` 仅保存当前内存状态，符合 MVP 不落盘约束。

Android 实现：

- `NativeFetchTransport`；
- `SecureStoreAuthAdapter`；
- 加密 SQLite `ClientStorage`；
- 网络、前后台、通知由平台 Adapter 注入；
- 不把 React Native 组件放进 `client-core`。

#### 6.8.3 SyncEngine 状态机

```text
idle
  -> bootstrapping
  -> authenticating
  -> hydrating
  -> catching_up
  -> subscribing
  -> synced

synced -> reconnect_wait
reconnect_wait -> bootstrapping
synced -> gap_detected -> hydrating
any -> auth_blocked | protocol_blocked | host_degraded | closed
```

核心保证：

- snapshot 的 `headSequence` 是 catch-up 上界；
- HTTP pagination 使用服务端 `nextAfter`，不使用 live cursor 代替；
- `sequence <= lastApplied` 去重；
- `sequence > lastApplied + 1` 触发 resync；
- catch-up 必须设置页数、事件数和总字节上限；超过上限返回 `RESYNC_SNAPSHOT_REQUIRED`，不能在一个 WSS handler 中无限循环阻塞；
- live event 和历史页重叠时只能产生一个 TimelineItem；
- domain reducer 不直接操作 WebSocket；
- command outbox 只有在网络恢复和权限允许时发送；
- 写命令必须显示 `accepted/completed/unknown`，不能以发送成功冒充执行成功。

ConnectionSupervisor 的默认退避：

```text
首次连接失败       250ms
指数退避上限        16s
随机抖动            ±20%
稳定在线 30s        清零 retry counter
浏览器 offline      不消耗 retry，等待 online 事件
显式用户重试        取消当前 backoff，立即 probe
auth/protocol block  不自动重试，等待 credential/version 变化
```

每次 transport generation 替换时，旧 generation 的 response/event 不能更新当前 domain state。domain subscription 失败只重订阅，不应拆掉健康的 transport lease。

Host 侧订阅也必须有界：当前 v1 `session.subscribe` 在单个 message handler 内循环回放全部页，Phase 2 改为游标分页/批次 ACK。单次批次建议不超过 200 events 和 256 KiB；客户端 ACK `afterSequence` 后再发下一批，慢客户端超过 buffered threshold 时关闭为 `RESYNC_REQUIRED`，但不影响 Provider Turn。

#### 6.8.4 从 `app.tsx` 迁移

分三步，避免一次重写：

1. 把 `eventPayload`、`eventItemKind`、`timelineItemFromEvent`、`projectSnapshot` 和 `applyEvent` 移到 `client-core`；
2. 把 `catchUp`、`connect`、reconnect backoff、request/receipt 移到 `SyncEngine`；
3. React `App` 只保留 view state、输入框和按钮事件，Web transport 通过 Adapter 注入。

迁移期间 Web 行为必须与现有 Playwright golden fixture 一致；每一步都能回滚。

### 6.9 协议与 Host 升级策略

采用兼容优先的两步发布：

```text
Release N
  Host 支持 protocol 1 + 2
  Web 支持 protocol 1 + 2
  新 capability 默认关闭

Release N+1
  Android 使用 protocol 2
  Web 默认协商 protocol 2
  已配对的 protocol 1 Web 继续使用全部既有 v1 method；不获得 v2-only capability

Release N+2
  发布明确的 v1 deprecation notice 和最低安全客户端版本
  先将 v1 降级为只读/安全 interrupt，再经过至少一个发布窗口

Release N+3
  统计确认没有活跃 protocol 1 client 后再移除 v1 写能力或整体支持
```

禁止在同一个版本同时：

- 改变 Event 语义；
- 删除旧错误码；
- 切换数据库 schema；
- 强制客户端升级；
- 更换 Host identity。

## 7. 数据模型变化

Phase 2 建议新增或扩展：

```text
host_identity
host_endpoints
devices
provider_runtimes
provider_intents
audit_events
backup_records
protocol_sessions
```

关键约束：

- `host_identity.host_id` 全局稳定；
- `provider_runtimes(runtime_id, generation)` 唯一；
- `provider_intents` 与 command receipt 通过 `command_id` 关联，但不把外部副作用标记为 exactly-once；
- `audit_events` 只记录谁、何时、对哪个 Host/Session 做了什么控制，不记录敏感正文；
- `backup_records` 记录 hash、schema version、验证结果和保留策略；
- `protocol_sessions` 记录客户端类型、协商版本和 capability snapshot，便于诊断版本兼容问题。

所有新表必须有：

- 创建迁移；
- rollback/恢复说明；
- 脱敏 fixture；
- quick check 和旧版本读取测试；
- 磁盘满、busy、重复写和崩溃点测试。

### 7.1 建议字段与状态

```sql
CREATE TABLE provider_runtimes (
  runtime_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  native_handle_hash TEXT,
  pid INTEGER,
  supports_resume INTEGER NOT NULL,
  supports_reattach INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  failure_code TEXT,
  PRIMARY KEY (runtime_id, generation)
);

CREATE TABLE provider_intents (
  intent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  command_id TEXT NOT NULL,
  runtime_id TEXT,
  generation INTEGER,
  method TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('committed', 'dispatching', 'dispatched', 'completed', 'failed', 'outcome_unknown')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  audit_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT,
  session_id TEXT,
  command_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
```

`native_handle_hash` 只用于关联和诊断，不存 Claude session secret；`provider_intents.request_hash` 只存 canonical payload hash，不存 Prompt 原文。`provider_intents` 是恢复依据，不是第二套 Timeline，任何对用户可见的状态仍必须通过 `session_events` 投影。

## 8. 安全方案

### 8.1 威胁模型

| 威胁 | 防护 |
|---|---|
| Pairing grant 猜测/重放 | 高熵、hash 存储、TTL、一次消费、限流、本地确认 |
| WSS ticket 重放 | 单次消费、短 TTL、device/host 绑定 |
| Cookie 被脚本读取 | HttpOnly、same-site、HTTPS |
| 跨 Origin WebSocket | 精确 Origin 校验 |
| Workspace 路径逃逸 | canonical path、symlink 检查、Provider sandbox |
| 未知 Tool | allowlist + PreToolUse deny |
| Host 崩溃重复执行 | receipt、intent、generation、outcome_unknown |
| 日志泄漏 | JSON redaction、secret scanner、字段白名单 |
| 伪 Host endpoint | hostId/fingerprint、HTTPS/WSS probe、重新配对 |
| 设备丢失 | device revoke、credential 失效、WSS 主动关闭 |

### 8.2 安全测试红线

任何以下失败都不能进入 Android 公测：

- 旧 pairing grant 能再次换 credential；
- 旧 ticket 能在 revoke 后建立 WSS；
- Prompt、Cookie、Token 进入日志或 CI artifact；
- sandbox 不可用时仍执行 Bash；
- Host 崩溃后自动重放未知副作用；
- endpoint 切换到不同 Host identity 仍能复用会话；
- path/symlink 逃逸能够读取或写入 Workspace 外文件。

### 8.3 生产化前必须修正的安全细节

#### 8.3.1 未配对 bootstrap 最小化

未配对请求只需要得到配对所需的最小信息：

```json
{
  "hostId": "stable-id",
  "hostVersion": "...",
  "protocolRange": { "min": 1, "max": 2 },
  "pairingRequired": true,
  "endpointHint": "https://..."
}
```

Provider 名称、Workspace basename、Git 状态、SDK/CLI 版本和 capability 详情应在认证后通过 `/api/status` 或 `/api/diagnostics` 返回。这样可以减少未配对扫描泄漏，也避免把当前 `/api/bootstrap` 的内部 workspace 信息固化成公开协议。

#### 8.3.2 可信代理与来源地址

`trustProxy: true` 不能作为默认生产配置。Host 必须显式配置：

- 直接 loopback 模式：不信任任意 `X-Forwarded-*`；
- Tailscale Serve 模式：只信任明确的本机 proxy hop；
- `request.ip` 用于限流时记录来源类型和解析结果，不能让客户端直接伪造任意 IP 绕过限流；
- 如果无法证明代理边界，配对限流使用“Token hash + 连接来源 + 时间窗口”的组合键，而不是只依赖 `request.ip`。

#### 8.3.3 Logout 与 WSS lease

撤销 Cookie 不等于已建立的 WSS 连接立即失效。Phase 2 的 `DeviceRegistry` 必须维护：

```text
deviceId -> active connection leases
```

logout/revoke 时：

1. 标记设备和所有 session credential revoked；
2. 使未消费的 ticket 立即失效；
3. 向该设备的 WSS lease 发送 `auth.revoked`；
4. 关闭连接并拒绝后续 request；
5. 记录不含凭证的 audit event。

#### 8.3.4 备份文件保护

SQLite 备份可能包含 Prompt、Timeline 和 Workspace 相对路径，必须：

- 文件权限至少为 owner-only（macOS 下 `0600`）；
- 备份目录不能位于被云盘自动同步的 Workspace 内；
- 生产环境使用系统磁盘加密，敏感部署可增加应用层加密；
- 备份文件名不含 Host、Workspace 或用户信息；
- 恢复前先复制到临时目录并执行 hash、quick check、schema migration；
- 备份失败只能报告失败，不能删除仍可用的当前 DB。

#### 8.3.5 Retry 与 commandId

客户端必须将 `requestId` 与 `commandId` 分开：

- `requestId` 每次网络发送可变化，用于匹配一次 RPC response；
- `commandId` 表示同一个领域命令，在超时、重连、离线 outbox 和进程重启后保持不变；
- 服务端用 `(deviceId, commandId, method, requestHash)` 做幂等键；
- request hash 不同的 commandId 重用仍返回 `COMMAND_ID_REUSED`；
- UI 显示 `accepted` 时不能将命令从 outbox 删除，必须等权威 terminal 或 `outcome_unknown`。

当前 v1 使用 `(authSubjectId, commandId)`；Phase 2 迁移时先为历史 browser session 建立稳定 `deviceId` 映射，再创建新的唯一索引。不能直接把主键切到 deviceId，否则旧 receipt 会丢失幂等归属。command receipt 需要保留到对应 Session 归档并超过恢复窗口；清理时必须和 Event/Turn retention 同事务或有可证明的先后顺序。

## 9. 实施拆分与文件映射

### 9.1 Phase 1 backlog

| 优先级 | 工作项 | 主要文件/目录 | 退出条件 |
|---|---|---|---|
| P0 | Playwright 基础设施 | `apps/mvp-web/playwright.config.ts`, `apps/mvp-web/e2e/` | `pnpm test:e2e` 可运行 |
| P0 | Deterministic Host fixture | `apps/mvp-host/src/test-support/` | 可控制 Tool/Approval/interrupt |
| P0 | 16 场景自动化 | `apps/mvp-web/e2e/`, Host integration | 关键场景可复跑 |
| P0 | 真机 Tailscale runbook | `docs/`、报告模板 | 至少一台目标 Android 真机完整通过；第二台不同浏览器/系统版本作为推荐兼容性证据 |
| P0 | 断网/崩溃注入 | Host test-support、SQLite | 恢复状态符合矩阵 |
| P0 | SDK/CLI matrix | `docs/claude-compatibility-matrix.md` | 锁定组合有证据 |
| P1 | QR pairing | `server.ts`, Web pairing UI | QR + Token fallback |
| P1 | CI artifacts | `.github/workflows/` | PR/受控真实测试可追溯 |

### 9.2 Phase 2 backlog

| 优先级 | 工作项 | 主要文件/目录 | 退出条件 |
|---|---|---|---|
| P0 | Protocol range/hello | `packages/mvp-protocol`, `server.ts` | v1/v2 协商和降级测试 |
| P0 | Host lifecycle | `apps/mvp-host/src/lifecycle/` | ready/degraded/draining 可观测 |
| P0 | Runtime registry | `apps/mvp-host/src/provider/` | generation、close、unknown 一致 |
| P0 | SQLite migration/backup | `storage/migrations`, `backup.ts` | 迁移、quick check、备份恢复 |
| P1 | Diagnostics/metrics | `observability/`、`server.ts` | 脱敏状态和基础指标 |
| P1 | Host identity/endpoint | `identity/`, `transport/` | endpoint 变化不换 Host |
| P1 | Device registry/revoke | `auth/`、DB migration | revoke 后旧 ticket 失效 |
| P0 | `client-core` | `packages/client-core/` | Web 改用 core，golden fixture 不变 |
| P1 | Protocol codegen 评估 | `packages/mvp-protocol/` | 决定 Zod-first 或 JSON Schema canonical |

### 9.3 推荐执行顺序

```text
1. 修复 test:e2e 入口并建立 deterministic Host
2. 自动化 16 场景中的 Web 可测部分
3. 完成真实 Claude 版本矩阵
4. 完成真机/Tailscale/断网/崩溃验收
5. 输出 Go/Conditional Go 决策
6. 引入 protocol hello/range/capability
7. 引入 Host lifecycle 和 readiness
8. 引入 Runtime Registry 与 intent/recovery
9. 引入 SQLite migration/backup/diagnostics
10. 抽取 client-core 并让 Web 全量迁移
11. 再开始 Android-first 设计实现
```

## 10. 验收与报告模板

每个场景提交一份结构化报告：

```yaml
scenarioId: MVP-09
title: phone-offline-60s
result: passed
startedAt: 2026-08-12T00:00:00Z
finishedAt: 2026-08-12T00:03:00Z
host:
  version: <git-sha>
  hostId: <redacted-stable-id>
  protocol: 1
  node: <exact-version>
provider:
  sdk: 0.3.220
  claude: 2.1.216
  executableSource: sdk-bundled
fixture:
  commit: <fixture-sha>
  dbHash: <sha256>
observations:
  firstTokenMs: 1200
  reconnectMs: 3100
  finalSequence: 87
artifacts:
  hostLog: artifacts/MVP-09/host.jsonl
  browserTrace: artifacts/MVP-09/trace.zip
  screenshot: artifacts/MVP-09/phone.png
failures: []
operatorNotes: "手机断网 60 秒，Claude 继续完成 npm test。"
```

报告中不得写入真实账号、Token、Cookie、Prompt 原文、绝对路径和完整 Tool input。

### 10.1 Phase 2 自动化测试矩阵

| 测试组 | 必测用例 | 注入方式 | 通过标准 |
|---|---|---|---|
| Protocol | v1/v2 hello、范围无交集、unknown capability、unknown event | fake frames | 不执行副作用，错误可行动 |
| Scope | read/write/control/admin 越权、撤销后请求 | fake device/session | 所有拒绝有明确 code |
| Lifecycle | starting/probing/ready/degraded/draining/stop | fake readiness/provider | 新 Turn 与关闭窗口正确拒绝 |
| Runtime | generation 迟到事件、Provider exit、interrupt timeout | fake runtime | 旧事件不污染新 Turn |
| Storage | migration、busy、full、corrupt、backup restore | temp SQLite / fault hook | 不静默丢事件，不自动重放 |
| EventWriter | event/projection/receipt 原子性 | commit point crash | 恢复后状态可解释 |
| Client Core | catch-up、gap、duplicate、offline、outbox | fake transport/clock | reducer 幂等、commandId 稳定 |
| Auth | grant/ticket/device revoke、query redaction | fake clock/connection | 过期/撤销立即拒绝 |
| Observability | secret scan、trace correlation、metric cardinality | synthetic logs | 无敏感字段、trace 可关联 |

每个故障用例都必须至少执行三次：故障前、故障中、故障恢复后；不能只断言进程退出码。

## 11. 运维与开发者操作

### 11.1 本地启动

```bash
./scripts/start-host.sh
```

脚本负责依赖安装和构建。只做开发迭代时可设置：

```bash
FLYX_SKIP_INSTALL=1 FLYX_SKIP_BUILD=1 ./scripts/start-host.sh
```

本机 HTTP 调试必须显式设置：

```bash
FLYX_ALLOW_INSECURE_HTTP=1 ./scripts/start-host.sh
```

### 11.2 测试前重置

```bash
pnpm --filter @flyx/claude-fixtures reset
```

Fixture 初始 `npm test` 故意失败，不能把它当成产品测试失败。真实仓库不能作为第一阶段验收 Workspace。

### 11.3 事件和数据库保留

- 测试 DB 使用临时路径；
- 正式 Host DB 使用显式 `FLYX_DB`；
- 任何 destructive reset 必须由人工明确执行；
- 备份、恢复和迁移不能直接覆盖当前 DB；
- 诊断工件上传前必须脱敏和 hash 路径。

## 12. 风险与待决策项

| 风险/决策 | 当前建议 | 决策时点 |
|---|---|---|
| QR 还是 Token | 实现 QR，保留 Token fallback；若延期则修正文档 | Phase 1 P1 |
| Claude runtime 是否可 reattach | 默认不承诺；仅在 SDK 明确支持且有证据时开启 | Phase 2 Runtime |
| Host identity 密钥存储 | MVP UUID，生产化加入本机 signing key | Android 配对前 |
| 协议 canonical source | Web/Android 仍为 TypeScript 时先 Zod；Rust 前再 JSON Schema | Rust/跨语言前 |
| 指标传输 | 先本地 JSON/内存指标，不在 MVP 上传云端 | Relay 前 |
| DB 云备份 | Phase 2 只做本机备份，不上传 Prompt/Timeline | 生产部署前 |
| Android storage | SecureStore 存 credential，加密 SQLite 存缓存和 outbox | Android 开始前 |
| 多 Host | 协议先保留 hostId；MVP 仍只支持一个 Host | Android P0 |

## 13. 最终退出标准

### Phase 1 退出

- [ ] `pnpm run typecheck`、`pnpm run build`、`pnpm test`、`pnpm test:e2e` 全部通过；
- [ ] 16 个验收场景全部有报告；
- [ ] 真实 Claude 版本矩阵锁定；
- [ ] 真手机/Tailscale 通过；
- [ ] 60 秒断网和 Host active Turn 崩溃通过；
- [ ] 30 个真实 Turn、10 次审批、10 次 interrupt 通过；
- [ ] 失败日志和 Playwright 工件已归档；
- [ ] QR/Token 配对定义与代码一致；
- [ ] 做出 Go 或 Conditional Go 决策。

### Phase 2 退出

- [ ] protocol range、hello、capability 和 v1/v2 兼容测试通过；
- [ ] Host ready/degraded/draining 状态可观测且关闭不产生新副作用；
- [ ] Provider runtime generation 和异常退出对账通过；
- [ ] `outcome_unknown` 可显式对账或创建新 Session，且绝不自动重放旧 Turn；
- [ ] Provider intent 的 committed/dispatching/dispatched 崩溃窗口测试通过；
- [ ] migration、quick check、备份恢复和磁盘满测试通过；
- [ ] `/healthz`、`/readyz`、`/api/diagnostics` 脱敏且可行动；
- [ ] Host identity、Tailscale endpoint 和设备撤销通过；
- [ ] logout/device revoke 会失效未消费 ticket，并按契约关闭既有 WSS lease；
- [ ] `client-core` 完成，Web 不再自己实现同步核心；
- [ ] Android 可以只依赖 protocol + client-core 开始开发；
- [ ] 未引入未经证据驱动的 Relay、Rust 或多 Agent 复杂度。

## 14. 下一步第一批任务

建议下一轮只实施以下五项：

1. 建立 `apps/mvp-web/e2e/` 和 deterministic Host，并修复 `pnpm test:e2e`；
2. 自动化 16 个场景中可在本机完成的 1–8、10、11、15、16；
3. 建立 Claude SDK/CLI 兼容矩阵和受控真实测试报告；
4. 编写真手机/Tailscale、断网、Host 崩溃的人工 runbook 并完成首轮证据；
5. 在 MVP Go 结论前冻结新增产品功能，不开发多 Agent 和第二 Provider。

完成这五项后，再开始 Phase 2 的 protocol negotiation、Host lifecycle 和 `client-core` 抽取，避免在未闭合的 Provider/网络/状态一致性基础上扩展客户端。

第一批实现仍必须控制依赖关系：Phase 1 E2E 只依赖现有 `/api/bootstrap`、v1 Frame 和浏览器 Cookie；不得为了写测试提前引入 v2 hello、设备 credential 或 Runtime Registry。测试先锁定现有行为，Phase 2 再以这些 E2E 作为兼容回归基线。
