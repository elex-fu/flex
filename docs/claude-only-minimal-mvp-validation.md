# Flyx Claude-only 最小 MVP 验证方案

> 版本：v0.2  
> 日期：2026-08-01  
> 定位：用最小可运行垂直切片验证 Flyx 主方案的核心假设  
> Provider：仅 Claude Code  
> Client：仅手机 Web；不做 Service Worker 和离线 PWA  
> 网络：仅 Tailscale HTTPS/WSS

后续 MVP Go、Host/协议生产化和 `client-core` 抽取方案见：[MVP Go 与 Host / 协议生产化技术方案](./mvp-go-and-host-productionization-technical-design.md)。

## 1. 结论先行

这个 MVP 只验证一条闭环：

```text
手机扫码配对
  -> 选择一个预配置 Workspace
  -> 发送一个真实 Claude 任务
  -> 实时看文本和 Tool Call
  -> 响应一次真实权限请求
  -> Claude 继续执行
  -> 查看 Git Diff
  -> 发送 follow-up
  -> 可中止当前 Turn
  -> 手机刷新/断网后恢复 Timeline
```

这个闭环通过，说明 Flyx 的核心产品形态和 Provider 控制方向可行。它不证明 Relay、Android 原生、多 Provider、Host 崩溃恢复、Checkpoint 或多 Agent 已经可行。

### 1.1 MVP 成功的严格含义

MVP 成功只表示下面三个假设同时成立：

1. **Provider 假设**：固定版本的 Claude Agent SDK/Claude Code 能提供可消费的结构化事件、真实审批、会话续接和中止控制；
2. **远程交互假设**：手机能安全完成“发任务、看过程、做审批、发 follow-up、发中止”；
3. **状态一致性假设**：刷新、短时断网、重复命令和控制竞态不会造成重复执行、丢 Timeline 或虚假终态。

它不是可发布产品，也不是生产安全性证明。验证必须在可丢弃 fixture repo 和测试账号/测试额度上进行；不得把本 MVP 直接用于重要仓库或无人值守执行。

### 1.2 验证优先级

```text
P0：Claude 结构化接入、审批、follow-up、中止
P1：手机实时展示、重连补同步、命令幂等
P2：配对、Git Diff、诊断
```

Day 1–2 的 P0 Spike 未通过时立即停止，不先建设 P1/P2 来掩盖 Provider 风险。

## 2. 本次要回答的六个问题

1. Claude Agent SDK 能否稳定提供文本、Tool、权限请求、终态和 session id？
2. 手机能否在不暴露终端的情况下正确展示 Claude 真实执行内容？
3. 权限请求能否跨 WebSocket 往返，且只解决一次？
4. 手机断线或刷新后，Timeline 能否从 SQLite 补齐而不重复？
5. 新 Turn 能否使用原 Claude session id 继续对话？
6. 中止、审批、重连和重试时，Flyx 状态能否与 Claude 真实状态保持一致？

## 3. 最小范围

### 3.1 必须实现

- macOS 上运行一个 Flyx MVP Host；
- 探测 SDK 内置 Claude Code 与本机 `claude`，选定并锁死一种有效执行组合；
- 验证实际认证/计费方式能完成一个最小请求；登录只能在电脑本地完成；
- 只允许一个启动时预配置的可信 Workspace；
- 同一时刻只有一个当前 Session、一个 active Turn；历史 Session 可只读保留；
- 手机同 origin Web UI；
- Tailscale Serve 提供 HTTPS/WSS；
- 一次性扫码配对、HttpOnly browser session cookie、短期 WSS ticket；
- 创建 Session、发送首个 Turn 和 follow-up；
- Claude 文本、Tool Call、Tool Result、Approval 和 Turn 终态展示；
- `allow_once` 和 `deny`；
- interrupt；
- SQLite 持久化、单 Session sequence、断线补同步；
- Turn 结束后的 Git status、文件列表和 unified diff；
- 最小诊断页：Claude 版本、Host 版本、Workspace、连接状态和最后错误。

### 3.2 明确不做

- Codex/OpenCode/任何第二 Provider；
- Android/iOS 原生 App；
- Service Worker、离线可操作 PWA 和系统安装能力；
- Flyx Relay、FCM、后台推送；
- LAN 自签 HTTPS、公网入站端口、SSH；
- 多 Host、多 Workspace、多用户；
- Provider Instance 动态管理；
- Android DPoP；
- E2EE Relay；
- 通用 Terminal、文件编辑器、内置浏览器；
- 图片/文件附件；
- Claude `AskUserQuestion` 交互；MVP 明确拒绝并提示 Claude 采用合理默认或结束 Turn；
- reasoning 原文；只有 SDK 提供稳定 summary 时才可展示；
- Provider-owned subagent UI；
- Worktree 自动创建；
- Git checkpoint/revert；
- Host 运行中自更新；
- Host 崩溃后 reattach 正在执行的 Claude query；
- 精确 once-only 外部副作用保证；
- 云端遥测、账号、团队和订阅。

## 4. 技术取舍

### 4.1 MVP Host 使用 TypeScript

生产首版默认继续使用 TypeScript Host；只有跨平台守护进程、性能或安全边界出现实测瓶颈时，才评估 Rust Host。Claude-only MVP 直接接入 Claude Agent SDK。

原因：

- 当前本机 Claude Code 版本为 `2.1.216`；
- 已有真实项目使用 `@anthropic-ai/claude-agent-sdk` 实现 `canUseTool`、`resume/sessionId`、partial messages 和 `query.interrupt()`；
- 本次最大未知是 Claude 双向交互和手机产品闭环，不是 Rust 语言可行性；
- 直接从 Rust 自行实现未承诺稳定的 stream-json 审批协议，会把 Provider 风险和语言桥接风险混在一起。

MVP 代码是验证性实现，不默认成为生产 Host。验证通过后再二选一：

1. Rust Host + 受监督的 TypeScript Claude Bridge sidecar；
2. 证明 Claude 双向 CLI 协议足够稳定后，由 Rust Adapter 直接接入。

### 4.2 固定技术栈

```text
Host:              Node.js 22+ / TypeScript
Claude transport:  @anthropic-ai/claude-agent-sdk 0.3.220（候选锁定版本）
HTTP/WSS:          Fastify + @fastify/websocket
Schema:            Zod
Store:             better-sqlite3 + SQLite WAL
Web:               React + TypeScript + Vite（无 Service Worker）
State:             小型 Client Core + reducer，不在 React 组件内直接接 WebSocket
Network:           Tailscale Serve HTTPS
Git:               只读 status/diff 命令
Tests:             Vitest + Playwright
```

SDK 和 Claude CLI 都记录精确版本。未经 fixture 回归验证不自动升级 SDK/CLI。

`0.3.220` 来自当前本地 Paseo 已锁定且已使用的 SDK 版本，仅作为 Day 1 候选基线。Agent SDK 可携带自己的 Claude Code executable，而 `pathToClaudeCodeExecutable` 也可指向本机版本；两者不得在运行时随机选择。Spike 必须分别探测：

1. SDK 默认携带的 executable；
2. 本机 Claude Code `2.1.216`；
3. 两种方式实际使用的认证来源和 session 文件位置。

优先锁定通过全部 P0 fixture 的组合，并在 Host 启动诊断中显示 SDK 版本、effective Claude Code 版本和 executable 来源。组合不兼容时必须记录证据并重新锁定，不为追求版本一致而忽略实际行为。

### 4.3 已核对的外部能力边界

本方案依赖的不是未公开 PTY 文本，而是 Claude Agent SDK 的公开契约：

- [TypeScript Agent SDK Reference](https://code.claude.com/docs/en/agent-sdk/typescript)；
- [Permissions 与 `canUseTool` 顺序](https://code.claude.com/docs/en/agent-sdk/permissions)；
- [审批与用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)；
- [Session capture/resume](https://code.claude.com/docs/en/agent-sdk/sessions)；
- [Partial message streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)；
- [Claude Code sandbox](https://code.claude.com/docs/en/sandboxing)；
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)。

公开文档只证明 API 设计存在，不证明候选版本组合行为正确；真实 fixture 仍是 Go/No-Go 的唯一依据。

## 5. 最小架构

```text
手机 Web
  React UI
  Client Core
  Timeline Reducer
       |
       | HTTPS + authenticated WSS
       v
Flyx MVP Host (TypeScript)
  Auth/Pairing
  RPC Router
  Session Orchestrator
  SQLite Event/Timeline Store
  Git Status/Diff
  Claude Adapter
       |
       | Claude Agent SDK
       v
Claude Code executable
       |
       v
预配置的本地 Workspace
```

MVP 只启动一个 Host 进程。Claude Agent SDK 启动的子进程属于 Host，客户端断开不关闭它。

## 6. Claude Adapter

### 6.1 启动约束

Host 启动时：

1. 解析并记录 effective Claude executable、SDK 版本和 Claude Code 版本；
2. 通过真实最小 query 检查认证，而不是只检查 `claude --version`；
3. 确认预配置 Workspace 存在、是 fixture repo 且本地用户显式信任；
4. 固定 `permissionMode: "default"`。候选版本实测发现 `settingSources: []` 会同时关闭本机 Claude Code 登录凭据，因此 MVP 使用 `settingSources: ["user"]` 仅取得本机认证来源，并通过最高优先级 inline `settings` 清空 `permissions` 默认规则、hooks、plugins、MCP 和额外目录，同时设置 `disableAllHooks`；文件路径 invariant deny 在 Host `canUseTool` 中重复执行。若真实 Spike 发现用户 hook/plugin 仍被加载或 callback 被 shadow，必须 fail closed；
5. 不设置 bare-name `allowedTools`，避免只读工具在 `canUseTool` 前被自动批准；允许只读工具也由 callback 在路径校验后自动返回；
6. 通过 SDK programmatic `tools/settings` 只暴露 `Read`、`Glob`、`Grep`、`Edit`、`Write`、`Bash` 六类 fixture 所需工具并注入 sandbox 配置，不改写用户的 Claude settings；Web、Task/Agent、Computer Use 和未知工具不可用；
7. 不使用 `bypassPermissions`、`acceptEdits`、`auto` 或 `dontAsk`；
8. 仅向 SDK 传递完成认证、Claude 调用和 fixture 测试所必需的环境；只记录环境变量名称，不记录值；
9. fixture 默认 `maxTurns = 20`、wall-clock timeout 15 分钟、approval timeout 10 分钟，并在认证模式支持时设置测试预算上限，防止失控执行。

MVP 使用 `canUseTool` 作为唯一互动审批入口；Host-defined `PreToolUse` hook 只负责不可绕过的 invariant deny，例如文件工具越界和禁用工具，不能代替手机审批或返回持久 allow。启动时通过固定的无副作用 Bash 请求确认 callback 可达，并监听 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 等 SDK warning；callback/hook 不可达或被规则遮蔽时，Host 标记 `interactiveApprovals = false`，MVP 直接 No-Go，不降级到 PTY 文本匹配。

### 6.2 Sandbox 与真实安全边界

只检查 Bash 字符串无法可靠判断命令最终访问了哪些路径，所以权限回调不是文件系统 sandbox。MVP 必须启用 Claude Code 内置 OS-level sandbox，并满足：

- `sandbox.enabled = true`；
- regular permissions mode，不能因为命令在 sandbox 内就自动批准 Bash；
- `sandbox.failIfUnavailable = true`；
- `sandbox.allowUnsandboxedCommands = false`；
- Bash 默认只允许向 Workspace 写入，测试不依赖外网；
- `Read/Glob/Grep/Edit/Write` 仍由 Host callback 校验 canonical path；
- fixture 不含 `.env`、SSH key、云凭据或真实业务数据。

这里承诺的是“阻止向 Workspace 外写入，并阻止内置文件工具读取 Workspace 外路径”。Claude Code sandbox 默认可能允许 Bash 读取部分 Workspace 外系统路径，以保证工具链运行；MVP 不宣称实现完整机密隔离。sandbox 不可用时不允许静默降级。

### 6.3 会话方式

- 首个 Turn 使用新 Claude session id；
- 从 SDK 消息捕获真实 `session_id`，写入 `sessions.provider_session_id`；
- follow-up 使用 SDK `resume: providerSessionId`；
- 每个 Session 同时最多一个 active Turn；
- 不支持并行 query、background agent 和 provider subagent 交互；
- clean Host 重启后尝试用已持久化 session id 开启新 follow-up，并记录为兼容性结果；最小闭环只硬性要求同进程的新 query 能 resume。任何情况下都不承诺恢复重启时仍在运行的 Turn。

同一 Turn 绑定不可复用的 `queryGeneration`。SDK message、approval 和 interrupt 只有 generation 与当前 active Turn 一致时才能改变状态，避免旧 query 的迟到事件污染后续 Turn。首个 init 捕获 session id 后，后续消息如果报告不同 session id，立即失败并记录兼容性错误。

### 6.4 事件映射

| Claude SDK 内容 | MVP Event/Timeline |
|---|---|
| system/session init | 保存 provider session id |
| assistant partial text | `assistant.message.delta` |
| assistant completed block | 完成同一个 `assistant.message` Item，不追加第二份正文 |
| assistant/tool content block 中的 tool_use | `tool.call.started` |
| tool_progress（若有） | 更新原 Tool Item |
| user/tool content block 中的 tool_result | `tool.call.completed/failed` |
| `canUseTool` callback | `approval.requested` |
| permission callback resolve | `approval.resolved` |
| result subtype success | `turn.completed` |
| result subtype error/SDK throw | `turn.failed` |
| interrupt 已确认且 iterator 无 result 结束，或 SDK result 的 `terminal_reason` 为 `aborted_tools` / `aborted_streaming` | `turn.cancelled` |
| unknown message | 记受限类型摘要，不推导成功或授权 |

Tool Item 至少展示：

- tool name；
- tool use id；
- 运行/完成/失败状态；
- 受限的 input 摘要；
- cwd 或目标路径（如可安全得到）；
- 截断后的 output/error；
- 开始时间和耗时。

MVP 将单个 Tool output 持久化上限设为 64 KiB。live 和恢复历史必须使用同一截断结果。

部分消息和完成消息必须通过真实 fixture 确认是“增量”还是“累计快照”。Adapter 将它们先归一化为同一 `itemId` 的 append/upsert；Client 不直接解释 Claude 原始事件。`toolUseID` 是 Tool/Approval 的关联主键；approval 即使先于可见的 tool start 到达也必须能独立展示。

assistant delta 允许在 Host 内按“最多 50 ms 或 4 KiB”合并后落库，进入 Tool/Approval/Result/terminal 前必须 flush。只有已经持久化的 chunk 才能发给 WebSocket，避免 live 看到了但刷新后无法恢复。

### 6.5 最小权限策略

```text
Read/Glob/Grep 类只读工具         -> callback 校验路径后自动允许
Edit/Write                         -> callback 校验路径后必须手机审批
Bash                               -> sandbox 内仍必须手机审批
AskUserQuestion                    -> MVP 拒绝并返回明确说明
Web/Task/Agent/MCP/未知工具        -> 不暴露；若仍出现则默认拒绝
内置文件工具访问 Workspace 外路径  -> 拒绝
```

MVP 只有：

- `allow_once`；
- `deny`。

不实现 `allow_session`、`allow_always`、规则学习或自动风险分类。

`allow_once` 必须返回当前原始 `input` 作为 `updatedInput`，且 `updatedPermissions: []`，绝不接受 SDK 的持久化 rule suggestion。`deny` 返回明确 message，默认不连带 interrupt。

`canUseTool` Promise 在 Host 中保持 pending，并与 `turnId + queryGeneration + toolUseID + approvalId + version` 绑定。手机响应使用 compare-and-set，第一个有效结果获胜。单个 Turn 可出现多个并发 pending approval，但每个 `toolUseID` 只能有一个未决请求。SDK `AbortSignal`、Session 结束、interrupt、审批 10 分钟超时或 query 退出时，pending approval 必须被 deny/abort、标记 superseded 并 cleanup，不留悬挂 Promise。Host 重启后内存 Promise 已不存在，持久化的 pending approval 一律改为 superseded，不能再次响应。

审批顺序固定为“SQLite CAS + `approval.resolved` Event 提交成功，再 resolve 内存 Promise”。数据库提交失败时绝不把 allow 交给 Claude。若进程恰好在提交后、resolve 前崩溃，重启按 active Turn `outcome_unknown` 处理，不尝试重放审批。

如果 approval 序列化 input 超过 128 KiB，Host 自动拒绝，不能把未完整展示的请求批准执行。

### 6.6 Interrupt

1. 手机发送带稳定 `commandId` 的 `session.interrupt`；
2. Host 写入 `turn.interrupt.requested`；
3. Host 调用当前 SDK query 的 `interrupt()`；
4. `interrupt()` resolve 只表示控制请求被 SDK 接收，不单独等价于 Turn 已结束；
5. 若成功/失败 result 先提交，则该终态获胜，迟到的 interrupt 只记为 no-op；
6. 若 interrupt 已确认且 async iterator 随后无 result 结束，才标记 cancelled；
7. 5 秒超时时进入 `interrupt_unconfirmed`，继续观察 query，不允许新 Turn；
8. MVP 不从手机提供 force-kill；若 query 长期不退出，只能在电脑本地处理并把 Turn 标记 `outcome_unknown`。

## 7. 最小领域模型

```ts
interface Session {
  id: string;
  workspaceId: "default";
  provider: "claude";
  providerSessionId?: string;
  status: "active" | "archived";
  activityState:
    | "idle"
    | "running"
    | "waiting_approval"
    | "interrupting"
    | "outcome_unknown"
    | "runtime_unavailable";
  headSequence: number;
}

interface Turn {
  id: string;
  sessionId: string;
  commandId: string;
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "interrupting"
    | "completed"
    | "failed"
    | "cancelled"
    | "outcome_unknown";
}

interface SessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
}
```

MVP Timeline Item 只包含：

```text
user_message
assistant_message
tool_call
approval
error
system
```

统一 reducer 契约：

- 每个 Event 有唯一 `id` 和严格递增 `sequence`；
- `session_events` 只存可安全下发的 canonical event；每个 sequence 至少产生一个客户端可接收的 envelope，不能因服务端过滤敏感事件造成客户端 sequence gap；
- Client 仅应用 `sequence == lastAppliedSequence + 1` 的事件；小于等于当前值去重，发现 gap 立即停止 live 应用并重新 catch-up；
- 流式 assistant text 更新同一个 `itemId`，delta 只 append 一次；completed 只封口或用权威 final text replace，不创建第二条消息；
- Tool 和 Approval 使用稳定 `toolUseID/itemId` upsert，带单调递增 `revision`，旧 revision 不覆盖新状态；
- Turn terminal 是不可逆状态；只有同一 `queryGeneration` 的第一个合法终态可提交。

Session activity 的正常迁移固定为：

```text
idle -> running <-> waiting_approval
running/waiting_approval -> interrupting
Turn completed/failed/cancelled -> Session 回到 idle
任意执行态 -> outcome_unknown/runtime_unavailable 时阻止新 Turn
```

`failed/cancelled/completed` 属于 Turn，不把整个 Session 永久标成 failed/interrupted；只要 provider session 仍可 resume，用户可以继续 follow-up。

## 8. SQLite 最小表

```text
host_state
auth_sessions
pairing_grants
sessions
turns
session_events
timeline_items
approvals
command_receipts
schema_migrations
```

必须约束：

- `session_events UNIQUE(session_id, sequence)`；
- `command_receipts PRIMARY KEY(auth_subject_id, command_id)`；
- command receipt 存 `request_hash`，同 ID 异请求返回 `COMMAND_ID_REUSED`；
- `timeline_items UNIQUE(session_id, item_id)`；
- `approvals` 使用 version compare-and-set；
- 同一 Session 最多一个 active Turn，使用 SQLite partial unique index 约束，不能只靠进程内判断；
- `provider_session_id` 只在 Host 本地存储，不写进浏览器 cache。

MVP 允许同步生成 Timeline projection，暂不实现通用 Drainable Projection Worker。但 Event、Timeline Item 和对应 command receipt 状态必须在同一 SQLite 事务内提交。startTurn receipt 至少有 `accepted/completed/failed/cancelled/outcome_unknown`，首事务写 `accepted + canonical turnId`，终态事务更新最终响应；重复请求在任何阶段都返回同一 turnId 和当前权威状态。interrupt/approval 等控制命令也各有自己的 receipt，不能复用 startTurn receipt。

SQLite 固定启用：

```text
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

所有写入由单写队列串行化。Claude 执行期间若 Event/Timeline 无法持久化，Host 进入 degraded、拒绝所有审批并请求 interrupt；不能一边丢审计事件一边继续授权副作用。

## 9. 最小协议

### 9.1 HTTPS

```text
GET  /api/bootstrap
POST /api/pairing/exchange
POST /api/auth/browser-session
POST /api/auth/logout
POST /api/auth/websocket-ticket
GET  /api/snapshot
GET  /api/session/:id/timeline?after=<sequence>&limit=<n>&upTo=<optional-sequence>
GET  /api/session/:id/diff
```

### 9.2 WSS RPC

```text
host.probe
session.create
session.startTurn
session.interrupt
session.subscribe
approval.respond
```

所有写 RPC 必须有 `commandId`。`clientId` 取自服务端 browser auth session，不能信任 payload 自报值；幂等键实际为 `(authSubjectId, commandId)`。

浏览器 WebSocket API 不能自由设置 `Authorization` header。MVP 使用 `wss://<same-origin>/api/ws?ticket=<opaque>`：ticket 必须 60 秒过期、单次消费、仅存 hash，并在 HTTP upgrade 事务中先消费再建立连接。Host access log、反向代理日志和错误日志必须对完整 URL/query 做脱敏。握手同时校验精确 Origin。

### 9.3 最小 Frame

```ts
type Frame =
  | { type: "request"; id: string; method: string; commandId?: string; payload: unknown }
  | { type: "response"; id: string; ok: true; payload: unknown }
  | { type: "response"; id: string; ok: false; error: RpcError }
  | { type: "event"; sessionId: string; event: SessionEvent };
```

MVP 不做通用 capability negotiation，`/api/bootstrap` 固定返回：

```json
{
  "protocolVersion": 1,
  "provider": "claude",
  "capabilities": {
    "streamingText": true,
    "structuredToolCalls": true,
    "interactiveApprovals": true,
    "resumeConversation": true,
    "interrupt": true,
    "gitDiff": true,
    "sandboxRequired": true
  }
}
```

所有 HTTP/RPC payload 通过共享 Zod schema 校验，并设置固定上限：prompt 16 KiB、单 Frame 256 KiB、approval input 128 KiB、Tool output 64 KiB、单 assistant message 1 MiB。超限输入在进入业务事务前拒绝；超限 Provider 输出以明确 marker 截断，live 和恢复使用同一份截断数据。

每个 WSS 连接的未发送 buffer 上限为 1 MiB。慢客户端超过上限时 Host 关闭该连接并返回 `RESYNC_REQUIRED`，Claude query 继续运行；客户端通过 SQLite catch-up 恢复，不能让一个手机连接反压或拖垮 Provider worker。

## 10. 命令与副作用边界

MVP 不实现完整通用 Event-sourced Engine，但保留最小 intent 边界：

```text
session.startTurn
  -> transaction: validate + receipt(accepted) + turn + canonical user event + turn.requested
  -> commit
  -> single serial Claude worker
  -> SDK query/resume
  -> SDK events
  -> transaction: append event + update projection
```

关键要求：

- SQLite commit 前不启动 Claude query；
- Worker 一次只执行一个 Turn；
- Host 崩溃后看到 accepted 但未知的 Turn 时标记 `outcome_unknown`，不自动重放；
- 相同 `commandId + requestHash` 返回已有 Turn；
- 相同 `commandId` 但 requestHash 不同直接拒绝。

`requestHash` 基于 schema 校验和规范化后的 method + payload 计算，不能直接 hash 未规范化 JSON 文本。`accepted` 只表示 Host 已获得执行责任，不表示 Claude 已开始或任务成功。

## 11. 关键流程

### 11.1 配对

```text
Host CLI 生成 5 分钟一次性 grant
  -> 显示 Tailscale HTTPS URL + fragment token QR
  -> 手机打开同 origin Web UI
  -> JS 从 fragment 取 token 并立即清除 URL/history
  -> POST /api/pairing/exchange
  -> Host 本地终端确认
  -> 返回一次性 browser bootstrap credential
  -> POST /api/auth/browser-session
  -> HttpOnly/Secure/SameSite browser session cookie
  -> 后续换取短期单次 WSS ticket
```

### 11.2 发起 Turn

```text
手机提交 prompt + clientMessageId + commandId
  -> Host 事务创建 canonical user message
  -> Claude worker 启动 SDK query
  -> 手机收到 turn.started
  -> assistant/tool live events
  -> result success/error
  -> Turn terminal + Git diff refresh
```

### 11.3 审批

```text
Claude canUseTool
  -> Host 创建 approval + Timeline Item
  -> Session waiting_approval
  -> 手机显示工具、input、cwd 和风险提示
  -> allow_once / deny
  -> approval version CAS
  -> resolve canUseTool Promise
  -> Claude 继续
  -> approval.resolved 在原 Timeline Item 更新
```

### 11.4 刷新/断网恢复

```text
WebSocket 断开
  -> Claude 继续执行
  -> Host 继续写 SQLite
  -> 手机恢复后 GET snapshot，只取得权威 Session/Turn 状态和 headSequence
  -> 未刷新重连从内存 lastAppliedSequence 开始；整页刷新从 0 开始
  -> 首次 GET timeline 固定回放上界 U，后续分页携带 upTo=U
  -> 补齐到 U 后建立 WSS，并 session.subscribe(afterSequence=U)
  -> Host 回放订阅建立前后的缺口，再切换 live
```

`/timeline` 首次响应返回 `{events, upTo: U, nextAfter, hasMore}`；同一次 catch-up 的后续页固定读取 `<= U`，避免边写边翻页导致边界漂移。`/snapshot.headSequence` 不能直接当作已应用 cursor。

`session.subscribe` 必须在每 Session 的 sequencer 内完成：先把连接标记为 `catching_up` 并记录 `W = headSequence`，再回放数据库中的 `(after, W]`；期间产生的 `> W` 事件进入该连接 buffer，回放完成后按 sequence flush 并切换 live。客户端只在收到连续 sequence 后前移 cursor。这样即使 HTTP catch-up 和 WSS 建连之间产生新事件也不会丢失。

## 12. 最小 Web UI

MVP 只有四个界面：

### 12.1 Pairing

- Host 名称；
- Tailscale hostname 和 Host instance id；
- Workspace 名称；
- “等待电脑确认”；
- 配对失败/过期。

### 12.2 Home

- Claude ready/login required/error；
- Workspace、branch、dirty 状态；
- 当前 Session 状态；
- 待审批数量；
- “新建 Session”或“继续 Session”。

### 12.3 Session

- user message；
- assistant streaming text；
- Tool Card；
- Approval Card；
- error/system item；
- prompt input；
- interrupt；
- 连接与同步状态。

### 12.4 Diff

- branch/HEAD；
- dirty baseline 警告；
- 变更文件列表；
- `+/-`；
- unified text diff；
- 二进制文件只显示元数据。

Session 创建时 Host 记录 HEAD、status 和 dirty baseline。MVP Diff 只声称“Session 期间观察到的 Workspace 变化”，不在 dirty baseline 或外部并发修改时宣称所有变化都由 Claude 产生。

Git 必须通过固定 argv 直接 spawn，不能拼 shell 字符串；禁用 pager、external diff 和 textconv。Diff 限制为 200 个文件、2 MiB 总响应，超出时显示明确 truncation，不允许大仓库输出拖垮 Host 或浏览器。

MVP 不追求完整设计系统，但手机宽度 360 px 下必须可完成全部流程。

## 13. 安全底线

- Host 只绑定 loopback，对外 HTTPS 由 Tailscale Serve 提供；
- MVP 前置条件是电脑和手机已加入同一 tailnet、ACL 允许访问且 tailnet 已启用 HTTPS；
- 只接受 Tailscale Serve，禁止配置 Tailscale Funnel；Host 启动只检查 Serve 状态，不静默修改用户 tailnet 配置；
- 不开公网入站端口；
- 只有一个启动时配置的 Workspace，客户端不传绝对路径；
- Workspace root 启动时 canonicalize；文件工具路径对已存在目标使用 realpath，对新路径找到最近的已存在祖先后 canonicalize 再拼接规范化剩余段，并拒绝 `..` 与逃逸 symlink；所有展示路径转为 relative path；
- pairing grant 一次性、5 分钟过期、只存 hash；
- pairing exchange 同一来源 60 秒最多 5 次失败尝试，超限返回可重试的 429；
- Host 本地确认后才签发 browser session；
- browser session cookie 不对 JavaScript 可见；
- Web UI 提供退出配对，服务端立即撤销当前 browser session；
- WSS 仅接受 60 秒单次 ticket；
- 写 RPC 均检查 origin/session 并使用 command id；
- 未知 Claude tool 默认拒绝；
- Claude sandbox 必须可用且禁止 unsandboxed fallback；
- 不实现 force kill、bypassPermissions、acceptEdits 和 allow always；
- 不记录 cookie、pairing token、Authorization、完整环境变量；
- SDK raw event 默认不落盘，诊断时手动开启有界本地日志；
- Tool output 按字节上限截断；
- API 响应设置 `Cache-Control: no-store`；MVP 不注册 Service Worker，浏览器持久层不保存 Timeline、approval input 或 provider session id；
- Web UI 仅在用户自有、可解锁的手机浏览器中使用。

## 14. 故障语义

| 场景 | MVP 行为 |
|---|---|
| 手机断网 | Claude 继续，事件落 SQLite |
| 手机刷新 | snapshot + sequence catch-up |
| 手机重复发 startTurn | 同 commandId 返回原 Turn |
| 重复审批 | version CAS，后到返回 `ALREADY_RESOLVED` |
| interrupt 超时 | `interrupt_unconfirmed`，继续观察 query，禁止新 Turn |
| interrupt 与 success 竞态 | 第一个合法 terminal 事务获胜，另一控制事件记 no-op |
| Claude 异常退出 | Turn failed，保留 stderr 受限摘要 |
| SDK stream 无终态结束 | Turn failed，原因 `stream_ended_without_result` |
| SDK stream 在已确认 interrupt 后无 result 结束 | Turn cancelled |
| Host 在 Claude 接受 Turn 后崩溃 | 重启后 `outcome_unknown`，不重放 |
| provider session id 不可 resume | 显示旧 Timeline，要求创建新 Session |
| Workspace 被移动/删除 | 停止新 Turn，显示 workspace unavailable |
| SQLite 在启动副作用前 full/busy | 不启动 Claude query，显示 Host degraded |
| SQLite 在 Claude 执行中不可写 | 拒绝审批、请求 interrupt，无法确认时 outcome_unknown |
| sandbox 不可用 | 启动失败，不降级执行 |
| AskUserQuestion/未知 Tool | 明确 deny，不创建可误操作的普通 approval |

## 15. 实施计划

以 1 名熟悉 TypeScript/React 的工程师为参考：2 个工日得到 Provider Go/No-Go；只有 P0 通过后，再投入约 8–13 个工日完成远程闭环，总计约 10–15 个工日。此估算不包含生产 Rust Host 和 Android 客户端。

实施期间冻结范围：16 个必过场景未完成前，不加入语音、附件、主题系统、多 Workspace、原生壳或第二 Provider。

### Day 1–2：Claude Spike

- 对比 SDK bundled 与本机 Claude executable，锁定唯一组合；
- probe effective version、auth、计费可用性和 session 存储；
- 验证 `settingSources: ["user"]` + inline settings isolation、`permissionMode: "default"` 和 tool allowlist 行为；同时确认 `settingSources: []` 的认证失败行为不能被误判为 provider 成功；
- 验证 sandbox 可用、fail closed 且 Bash 不可 unsandbox；
- 新 session；
- partial assistant text；
- tool use/result；
- `canUseTool` allow/deny；
- callback AbortSignal、多个 pending request 和 oversize input；
- `query.interrupt()`；
- resume session；
- 保存脱敏真实 fixture，并写成不依赖 Web UI 的 adapter contract tests。

这两天是硬门槛。如果真实 approval 或 resume 无法稳定完成，暂停 Web UI 开发。

Spike 只有同时满足下面条件才退出：

1. 固定版本组合连续完成 10 次 deterministic Turn；
2. allow/deny 各至少 3 次，`updatedPermissions` 未产生持久规则；
3. partial + completed 不导致正文翻倍；
4. Tool start/result 能以 `toolUseID` 配对；
5. in-process follow-up 使用捕获的 session id 成功；
6. interrupt 的实际事件序列已记录，能区分 cancelled、failed 和无 result 结束；
7. sandbox 不可用、callback 被 shadow 或 auth 不可用时均 fail closed。

### Day 3–5：Host 核心

- Fastify/WSS；
- SQLite migration；
- Session/Turn/Event/Timeline；
- command receipt；
- 单 Claude worker；
- approval pending map + CAS；
- Git status/diff。

### Day 6–8：手机 Web

- pairing；
- Home；
- Session Timeline；
- Approval Card；
- prompt/follow-up；
- interrupt；
- Diff；
- reconnect/catch-up。

### Day 9–11：端到端和故障测试

- Tailscale Serve；
- 真手机测试；
- 断网/刷新；
- 重复 command/approval；
- interrupt；
- Claude 非零退出；
- Host 重启后 Timeline 恢复和 active Turn 对账；
- Diff 展示。

### Day 12–15：预留缓冲

- 修复 SDK 事件映射；
- 处理手机布局与长内容；
- 补 fixture 和回归测试；
- 整理验证结果与生产架构决策。

## 16. 必过验收场景

验收使用一个独立、可重置的小型 Git fixture repo，不在 Flyx 主代码或用户重要仓库上执行。建议包含：

```text
fixture-repo/
  package.json
  src/retry.js          # 一个可稳定复现的小 bug
  test/retry.test.js    # 基于 node:test，无第三方依赖
  scripts/slow.js       # interrupt 场景使用的固定长任务
  README.md
```

fixture 的 `npm test` 只调用本机 Node，不安装依赖、不访问网络。每个场景前由测试 harness 在临时目录创建新 clone/worktree 并记录起始 commit；这是测试隔离，不是产品的 Worktree 功能。主任务固定为“修复 retry 边界问题并使用 Bash 运行 npm test”，follow-up 固定为“补充最大重试次数为 0 的边界测试”，以减少每次测试的任务差异。

1. 手机扫码配对，Host 本地确认后进入首页。
2. 手机发送一个要求 Claude 修改 fixture repo 文件并运行测试的任务。
3. Timeline 实时显示 canonical user message、assistant text 和 Tool Card；partial + completed 不产生重复正文。
4. Claude 请求 Bash/Edit/Write 权限，手机点击 `allow_once`，Claude 继续且只解决一次。
5. 对另一个权限请求点击 deny，Timeline 显示拒绝，Claude 能继续或明确失败。
6. Turn 结束后手机查看准确的变更文件和 unified diff。
7. 手机发送“补一个边界测试”follow-up，新的 SDK query 使用同一 provider session id 继续且具有前序上下文。
8. 在 assistant streaming 期间刷新页面，恢复后消息不丢失、不重复、不双倍追加。
9. 断网 60 秒，Claude 继续；恢复网络后补齐所有 sequence。
10. 快速重复提交相同 commandId，只有一个 Turn。
11. 运行长任务并点击 interrupt，只在控制已确认且 query 结束后显示 cancelled；未确认期间无法发新 Turn，成功取消后可发新 follow-up。
12. 关闭手机页面不中断 Claude；重新打开后看到权威状态。
13. 重启 Host，已完成 Session 的 Timeline、terminal 状态和 sequence 仍在且不重复；clean restart 后 resume 作为单独兼容性结果记录，不阻塞最小闭环。
14. 重启 Host 时若有未知的 active Turn，标记 `outcome_unknown`，不自动重放。
15. 修改 URL/RPC payload 或构造文件工具路径不能访问 Workspace 外文件；Bash 尝试向 Workspace 外写入被 OS sandbox 阻止，且 sandbox 不可用时 Host 拒绝启动。
16. 清除浏览器 cookie 后需要重新配对，旧 WSS ticket 不可重放。

## 17. Go/No-Go 决策

### Go

同时满足：

- 16 个验收场景全部通过；
- Day 1–2 的 7 项 Spike exit criteria 全部通过；
- 连续执行 30 个真实 Turn，无重复 Turn、重复审批、永久 pending 或 Timeline 文本翻倍；
- 至少 10 次真实 approval allow/deny 往返成功；
- 至少 10 次 interrupt 中 9 次在 5 秒内到达权威终态，其余能明确显示未确认而不假成功；
- 页面刷新和 60 秒断网各重复 10 次，无消息缺失/重复；
- Claude CLI/SDK 版本不兼容时 Host fail closed 并给出可行动诊断。

### Conditional Go

16 个必过场景和 P0 主链路仍须全部通过；仅下面这些未纳入最小闭环、能被明确关闭或降级的能力可判 Conditional Go：

- reasoning summary 不稳定：首版关闭该 capability；
- 某类 Tool progress 缺少：只显示 started/completed；
- clean Host restart 后不能继续旧 session：保留 Timeline，首版要求新建 Session；in-process follow-up resume 仍必须成功；
- interrupt 偶发超时：保留“未确认”安全状态，不开启 force kill。

### No-Go

任一情况成立：

- 无法使用结构化 callback 响应真实 Tool Permission；
- Claude session id 无法稳定捕获，或同进程 follow-up 无法 resume；
- SDK 事件无法稳定区分 Tool start/result 和 Turn terminal；
- interrupt 会经常产生 Flyx 与 Claude 状态分裂；
- Client 断开会导致 Claude query 终止；
- 幂等和 Timeline 补同步不能在可接受复杂度内做正确；
- 必须关闭 sandbox 或启用 unsandboxed fallback 才能完成 fixture；
- permission callback 会被本地 settings/rules 绕过且无法在启动时检测。

No-Go 时暂停 Android、Relay 和第二 Provider，先重新选择 Claude transport，不用 PTY 正则强行继续。

## 18. 建议目录

```text
apps/
  mvp-host/
    src/
      auth/
      claude/
      git/
      rpc/
      session/
      storage/
      server.ts
  mvp-web/
    src/
      client-core/
      screens/
      timeline/
packages/
  mvp-protocol/
  claude-fixtures/
```

即使是 MVP，Claude SDK parsing、Client Core 和 React UI 也必须分包/分层，不将 WebSocket 处理、retry 和 Provider 原始事件写在页面组件中。

当前验证实现已经落在以下目录（逻辑边界与后续 Rust Host 保持一致）：

```text
apps/mvp-host/src/
  claude/adapter.ts          # Claude SDK、canUseTool、sandbox、interrupt、事件归一化与 generation fence
  session/orchestrator.ts    # 单 Session/Turn、事件序列、幂等命令、Timeline projection、Git baseline
  storage/db.ts              # SQLite WAL、CAS、原子 receipt、重启 outcome_unknown/recovery event
  git/git-service.ts         # 固定 argv 的 status/diff、HEAD/baseline 与大小限制
  server.ts                  # pairing、本地确认、cookie、WSS ticket、HTTP/RPC 脱敏
apps/mvp-web/src/
  app.tsx                    # 手机 Web 最小配对、Timeline、审批、发送和中止
  styles.css
packages/mvp-protocol/src/index.ts
packages/claude-fixtures/
```

### 18.1 当前实现与验证状态

已经可以运行的能力：

- TypeScript Host、SQLite WAL/sequence、Session/Turn 和 `(authSubjectId, commandId)` 幂等收据；
- Claude Agent SDK 结构化 init、partial text、assistant completed、Tool start/result、`canUseTool` 审批、result、同进程 resume 和 `interrupt()`；
- approval version CAS、`approval.resolved` Event/Timeline/receipt 原子提交、超时/abort 清理、文件路径 invariant deny、sandbox fail-closed 配置；终态/interrupt receipt 一致更新、旧查询 generation fence 和 Host event persistence degraded fail-closed；
- loopback HTTP、Host 本地确认后的一次性 pairing grant、HttpOnly/Secure cookie、单次 60 秒 WSS ticket、严格 Origin 校验和固定上界 catch-up；
- 手机 Web 的实时 Timeline、assistant/tool/approval 稳定 item upsert、断线指数重连、sequence gap 重同步、follow-up、interrupt、刷新重放和 Git status/diff API；
- Session 首次使用前记录 Git HEAD、dirty baseline 和 status；Diff 显示 baseline 警告，不把预先存在的修改误称为 Claude 产生；
- `packages/claude-fixtures` 已初始化为独立 Git fixture，`scripts/reset.mjs` 可恢复可复现的初始 bug。

已执行的本机证据：`pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过；真实 SDK preflight（Read tool + auth marker）、no-tool Spike、同 session follow-up、Host WSS 实时文本与连续 sequence、Host WSS 真实 Bash/Edit 审批 `allow_once`、`npm test` 工具结果、单次浏览器 interrupt（`aborted_tools` -> `turn.cancelled`）、adapter interrupt、路径/symlink invariant、原子审批/终态/recovery、30 个 deterministic Turn 编排稳定性、会话退出/撤销、配对限流和动态静态资源测试均通过。仍未宣称 16 个场景或 Go：真手机/Tailscale Serve、60 秒断网、10 次 interrupt 稳定性、Host 进程崩溃对账和 30 个真实 Claude Turn 仍需在独立测试环境继续验证。

本地启动：

```bash
FLYX_WORKSPACE="$PWD/packages/claude-fixtures" ./scripts/start-host.sh
pnpm dev:web # 仅开发时使用；直连 HTTP 调试需另设 FLYX_ALLOW_INSECURE_HTTP=1；真机验证使用 Host 构建出的同 origin dist
```

Host 默认只监听 `127.0.0.1:4173`，通过 `tailscale serve` 暴露 HTTPS/WSS；终端会打印一次性 pairing token，手机提交 token 后 Host 终端默认要求输入 `y/yes` 确认。非交互 Host 默认拒绝配对；仅受控测试可设置 `FLYX_REQUIRE_PAIRING_CONFIRM=0`。可设置 `FLYX_REQUIRE_TAILSCALE_SERVE=1` 让启动时只读检查 Serve 状态。真实 Claude Spike 使用 `RUN_REAL_CLAUDE_SPIKE=1 pnpm test:spike`，真实 Edit/Bash flow 使用 `RUN_REAL_CLAUDE_FLOW=1 pnpm --filter @flyx/mvp-host exec vitest run src/claude/adapter.flow.test.ts`，两者都会消耗测试额度。

## 19. MVP 结束后的产出

除可运行代码外，必须产出：

- Claude CLI + Agent SDK 兼容矩阵；
- 真实原始事件 fixture（脱敏）；
- Claude SDK -> Flyx Event -> Timeline Item 映射表；
- 16 个验收场景的结果和失败证据；
- 未知/丢失/重复 SDK 事件报告；
- approval 等待、首 token、interrupt、断线 catch-up 耗时统计；
- TypeScript Host 继续生产化或下沉 Rust Host 的 ADR；
- 主技术方案需要修正的假设清单。

只有 Go/Conditional Go 后，才开始生产 Rust Host、Claude Adapter、Android Client 或 Relay。

## 20. 使用与验证步骤

### 20.1 前置条件

- macOS 已安装 Node.js 22+、pnpm，并在电脑本地完成 Claude Code 登录；
- `claude --version` 可执行，且当前账号有可用额度；
- 工作区使用本方案提供的可丢弃 fixture，不要替换成重要仓库；
- 真手机验证时，电脑和手机加入同一 tailnet，并已配置 Tailscale Serve HTTPS/WSS。

先恢复 fixture：

```bash
pnpm --filter @flyx/claude-fixtures reset
```

fixture 的初始 `npm test` 故意失败，这是待 Claude 修复的基线，不是 Flyx 产品测试失败。

首次启动或希望自动安装依赖、构建同源 Web 和 Host 时，直接运行：

```bash
./scripts/start-host.sh
# 等价入口：pnpm start:host
```

脚本默认使用 `packages/claude-fixtures` 和 `.flyx/mvp.sqlite`，Host 仍只绑定
`127.0.0.1:4173`。可用 `FLYX_WORKSPACE`、`FLYX_DB` 和 `PORT` 覆盖工作区、数据库和端口；已有依赖或构建产物时可分别设置
`FLYX_SKIP_INSTALL=1`、`FLYX_SKIP_BUILD=1`。脚本不会默认打开不安全 HTTP、关闭配对确认或修改
Tailscale 配置，这些选项必须显式传入。

### 20.2 自动化验证

先运行不消耗 Claude 额度的回归：

```bash
pnpm run typecheck
pnpm run build
pnpm test
```

再运行真实 Claude 验证（会消耗额度）：

```bash
RUN_REAL_CLAUDE_SPIKE=1 pnpm test:spike
RUN_REAL_CLAUDE_FLOW=1 pnpm --filter @flyx/mvp-host exec vitest run src/claude/adapter.flow.test.ts
RUN_REAL_INTERRUPT=1 pnpm --filter @flyx/mvp-host exec vitest run src/claude/adapter.interrupt.test.ts
```

三组真实验证分别覆盖 SDK preflight/认证、真实 Edit/Bash 审批和中止。任一失败时先保留日志和 fixture 状态，不要继续扩大功能范围。

### 20.3 本机浏览器闭环

先构建手机 Web，再启动 Host。`FLYX_DB` 使用一个新的路径，避免上次 Session 影响本次验收：

```bash
pnpm build
FLYX_WORKSPACE="$PWD/packages/claude-fixtures" \
FLYX_DB="/tmp/flyx-mvp-validation.sqlite" \
FLYX_ALLOW_INSECURE_HTTP=1 \
pnpm dev:host
```

Host 的静态资源路由支持构建后新增的 Vite hash，通常不需要重启；若浏览器仍显示旧页面，执行一次强制刷新即可。开发迭代可改用下面的 `pnpm dev:web`。

Host 启动时会自动执行 Claude preflight，并在终端打印一次性 pairing token。浏览器打开 `http://127.0.0.1:4173`，粘贴 token；终端出现 `Approve this phone pairing? [y/N]` 后输入 `y`。

本机 HTTP 调试必须显式设置 `FLYX_ALLOW_INSECURE_HTTP=1`。真实部署不要设置它，默认使用 Secure Cookie 和 HTTPS/WSS。Host 默认只绑定 loopback。

开发 UI 也可以单独启动：

```bash
pnpm dev:web
```

此时访问 `http://127.0.0.1:5173`；Vite 会把 `/api` 和 WebSocket 代理到 4173。真手机不要使用 Vite 的 loopback 开发服务，应访问 Host 构建出的同源页面。

### 20.4 手机/Tailscale 闭环

1. 保持 Host 监听 `127.0.0.1:4173`；
2. 使用现有 Tailscale Serve 将该端口暴露为 HTTPS/WSS；
3. 可设置 `FLYX_REQUIRE_TAILSCALE_SERVE=1`，让 Host 启动时只读检查 Serve 状态；
4. 手机打开 Serve 提供的 HTTPS 地址，输入终端显示的 pairing token；
5. 在 Host 终端确认配对，浏览器获得 HttpOnly 会话 Cookie；
6. 后续刷新不需要再次输入 token，清除 Cookie 后应重新配对。

非交互 Host 默认拒绝配对。`FLYX_REQUIRE_PAIRING_CONFIRM=0` 只允许受控自动化测试使用，不用于真实手机或生产环境。

### 20.5 手工验收顺序

建议每次从干净 fixture 开始，按以下顺序执行：

1. 发送“只回复 `FLYX_MVP_READY`，不要使用工具”，确认首个 Turn、流式文本和完成态；
2. 发送“修复 `src/retry.js` 的重试边界问题，并运行 `npm test`”，看到 Read/Edit/Bash Tool Card；
3. 对 Edit/Bash 审批点击 `allow_once`，确认 Claude 继续执行、审批只解决一次、`npm test` 通过；
4. 点击 Diff，确认变更文件、baseline dirty 警告和 unified diff；
5. 发送 follow-up“为 `maxRetries=0` 补充边界测试”，确认 Timeline 追加且上下文连续；
6. 执行 `scripts/slow.js` 长任务，在 streaming 期间点击 interrupt，确认先显示 interrupting，最终才显示 cancelled（Claude SDK 可能以 `terminal_reason=aborted_tools` 或 `aborted_streaming` 返回）；
7. 在 streaming 期间刷新页面，确认 Timeline 不丢失、不重复、不翻倍；
8. 关闭页面后等待 Turn 完成，再重新打开，确认权威状态和完整 Timeline 恢复；
9. 在同一 Session 中重启 Host，确认已完成 Timeline、terminal 状态和 sequence 保留；长 Turn 期间重启时应显示 `outcome_unknown`，且不会自动重放；
10. 重新运行 `pnpm --filter @flyx/claude-fixtures reset`，确认 fixture 回到红色初始基线。

### 20.6 通过标准与结果记录

单次手工闭环至少应满足：没有重复 Turn；assistant 正文不重复；审批没有永久 pending；Tool start/result 能配对；follow-up 使用同一 Claude session；interrupt 不出现假成功；刷新/断线后 sequence 连续；Diff 不把 baseline 之前的修改误报为 Claude 修改。

每次验证记录以下信息：SDK/Claude 版本、测试时间、fixture 起始 commit、测试账号、失败场景、Host 日志、Timeline sequence、首 token/审批/interrupt/catch-up 耗时。16 个场景、30-turn 稳定性、60 秒断网和真实手机全部完成前，只能标记为“实现已验证”或“Conditional Go”，不能标记最终 Go。

### 20.7 开发完成后必须人工验证

以下项目不能仅靠本地单元测试判定完成：

1. **真手机 + Tailscale**：手机通过 HTTPS/WSS 打开 Host，配对确认、刷新、退出配对、重新配对；确认不存在公网入站端口。
2. **断网恢复**：Claude 执行 `scripts/slow.js` 或真实修改任务时关闭手机网络至少 60 秒；恢复后 Timeline sequence 连续、无重复，Claude 未被中断。
3. **Host 崩溃对账**：Turn 执行中强制结束 Host，再启动同一 `FLYX_DB`；页面显示 `outcome_unknown`，不自动重放，旧审批变为 superseded，完成后可继续新 Turn。
4. **真实稳定性**：同一账号连续执行 30 个真实 Claude Turn；至少 10 次审批 allow/deny；至少 10 次 interrupt，记录权威终态和耗时。
5. **手机布局与长内容**：360 px 宽度下完成配对、审批、长工具输出、Diff、退出；确认滚动和按钮不会被遮挡。
6. **安全边界**：尝试修改 URL/RPC、构造 `../` 和 symlink 逃逸路径、跨 Origin WebSocket、重放旧 ticket；确认全部被拒绝且不泄露绝对路径。
7. **版本/环境故障**：Claude 未登录、CLI/SDK 版本不兼容、sandbox 不可用时启动失败或进入明确错误态，不执行未隔离命令。
