# Flyx 手机远程多 Agent 协作开发产品技术方案

> 版本：v0.5  
> 日期：2026-07-31  
> 第一阶段：手机浏览器/PWA 远程控制桌面上的 Codex、Claude Code  
> 第二阶段：Android 原生客户端（iOS 保留接口与扩展性）
> 后续范围：桌面、Web、手机等多端统一控制 Codex、Claude、OpenCode 等 Agent
> 最小验证：[`Claude-only 最小 MVP 验证方案`](./claude-only-minimal-mvp-validation.md)

## 1. 执行摘要

Flyx 不应做成“手机上的远程桌面”，也不应把 Codex、Claude 的终端输出直接透传给手机。更合适的产品形态是：

**在开发电脑上运行一个可信的 Flyx Host，由它注册并管理本机 Coding Agent；手机通过安全连接查看任务、发送指令、处理审批、查看变更，并在必要时中止或继续 Agent。**

推荐采用以下核心设计：

1. **本地执行边界**：代码、Git 凭证、Agent 登录态、命令执行均留在开发电脑。
2. **统一 Agent 协议**：Codex、Claude 的差异封装在 Provider Adapter 内，对客户端暴露统一的 Session、Turn、Message、Tool Call、Approval、Diff、Artifact 语义。
3. **客户端无执行能力**：手机、未来 Web 和桌面客户端只是控制面，不直接启动 Agent、不读本地文件、不持有 Provider 凭证。
4. **事件流作为事实来源**：所有任务执行转换为有序事件，支持断线重连、增量同步、多个客户端同时观察，以及未来多个 Agent 协作。
5. **产品交付分两阶段**：
   - 第一阶段：响应式 Web/PWA 验证远控闭环，不依赖应用商店。
- 第二阶段：先交付正式 Android 客户端，补齐推送、后台恢复、生物识别和本地安全缓存；iOS 保留同一套接口和可编译骨架，后续交付。
6. **网络方案务实分层**：
   - 开发验证：局域网 HTTPS/WSS 或 Tailscale。
   - 对外 MVP：一次性扫码配对 + Tailscale，或可选 Flyx Relay。
   - 产品化：端到端加密 Relay，用于 NAT 后的无配置远程访问。
7. **审批优先的移动体验**：手机首屏围绕“需要我处理什么”设计，而不是复刻桌面 IDE。

### 1.1 推荐结论

Flyx 建议建设三个稳定运行组件，客户端形态按阶段替换：

```text
Stage 1 Mobile Web/PWA ─┐
                        ├── WSS ── Flyx Host ── Adapter ── Codex CLI
Stage 2 Native Mobile ──┘              │       └───────── Claude Code CLI
                                       ├── Session/Event Store
                                       ├── Workspace/Git/Diff
                                       └── Approval & Policy Engine
```

第一阶段只支持：

- 手机浏览器/PWA 配对一台或多台开发电脑；
- 每台电脑自动发现并注册 Codex、Claude；
- 创建、继续、中止任务；
- 流式查看 Agent 消息、工具调用与状态；
- 响应权限审批和 Agent 提问；
- 查看 Git 变更摘要与文件 Diff；
- 发送补充指令；
- 页面刷新或网络中断后恢复；
- 安全地撤销已配对设备。

第一阶段明确不做：

- 手机远程操作完整桌面画面；
- 手机上的通用终端模拟器；
- App Store/Google Play 原生应用；
- 原生推送和可靠后台保活；
- 云端复制整个代码仓库；
- 多用户团队空间、Issue 管理、Agent 市场；
- Agent 间自动自主编排；
- 在手机上直接执行 Codex 或 Claude；
- OpenCode 正式支持（只保留 Adapter 接口并做契约测试）。

第二阶段在不改变 Host 和控制协议的前提下，增加原生手机客户端；详细方案见第 18 节。

## 2. 产品定义

### 2.1 一句话定位

**Flyx 是随身携带的 AI 开发控制台：离开电脑后，仍可安全地指挥、审批和检查桌面上的 Coding Agent。**

### 2.2 目标用户

- 使用 Codex CLI、Claude Code 进行日常开发的个人开发者；
- 经常离开工位，但希望任务不中断的工程师；
- 同时运行多个 Agent，需要统一掌握进度和审批请求的重度用户；
- 后续需要让多个 Agent 在多个仓库、工作树间协作的团队。

### 2.3 核心场景

#### 场景 A：离开电脑后继续任务

用户在桌面启动任务，通勤时从手机查看进度。Claude 请求执行高风险命令，用户查看原因和影响后选择“仅本次允许”。执行完成后，用户检查 Diff 摘要并要求补测试。

#### 场景 B：手机发起后台任务

用户从手机选择电脑、仓库和 Agent，输入“修复登录页在弱网下重复提交的问题并补测试”。Host 创建独立 Session，启动 Agent，手机可锁屏；需要干预时收到推送。

#### 场景 C：多个任务集中处理

用户在手机的“待处理”页看到：

- Codex 等待命令审批；
- Claude 提出澄清问题；
- 一个任务失败，需要重试；
- 一个任务已完成，等待检查变更。

用户不需要打开每段终端日志即可完成处理。

## 3. 从参考项目得到的结论

### 3.1 T3 Code：最适合作为本期架构基线

T3 Code 已采用“一个 Server 是一个执行环境”的清晰边界：Provider 进程、终端、Git 和文件系统都在 Server 内运行，Web、桌面、移动端只通过认证 WebSocket RPC 控制它。其关键设计包括：

- `ExecutionEnvironment` 有稳定 `environmentId`；
- Web、桌面、移动端共用 client runtime；
- Effect RPC 统一一元请求与服务端流；
- 每个 RPC 方法有独立授权 scope；
- Provider Driver 支持 Codex、Claude、OpenCode 等多个实现；
- Provider instance 可多实例注册，并由 registry 管理生命周期；
- 任务执行采用命令、事件、投影模式；
- 支持直连、Relay、Tailscale 和桌面管理的 SSH；
- 一次性配对、短期 WebSocket ticket、会话撤销有清晰分层。

Flyx 应直接借鉴：

1. **执行环境与访问方式分离**。Host 是身份与执行边界，Tailscale/Relay/局域网只是连接方式。
2. **Provider Driver SPI**。Provider 差异不能泄漏到客户端和业务编排层。
3. **共享客户端运行时**。未来 Mobile、Web、Desktop 使用同一协议和同步逻辑。
4. **按方法授权**。连接成功不等于拥有所有控制权限。
5. **命令幂等和有序事件**。移动网络天然会重试和乱序。

不建议首期照搬：

- 完整事件溯源系统和复杂读模型；
- Git checkpoint 隐藏 ref 的全量实现；
- 同时支持 Direct、Relay、Tailscale、SSH 四种接入；
- 完整远程终端和文件写入 RPC；
- Cloudflare Tunnel 自动编排。

这些能力正确，但会显著扩大 v1 的实现面。

### 3.2 Paseo：借鉴协议兼容、Agent 生命周期与协作表达

Paseo 将 daemon、协议包、client SDK、Expo App、Relay、Electron Desktop 分层，尤其适合参考以下部分：

- 协议 Schema 与生成式校验独立成包；
- WebSocket 消息带明确请求、响应、事件类型；
- 协议兼容性与 capability negotiation；
- Agent 生命周期是显式状态机；
- Provider manifest 描述能力而不是在 UI 中硬编码 Provider；
- Agent timeline 将消息、工具调用、终端活动等归一化；
- Relay transport 支持端到端加密；
- 手机与 Web 共享 Expo 应用层；
- chat room、handoff、committee 等多 Agent 产品概念可用于后续协作阶段。

Flyx 应借鉴：

1. **Capability 驱动 UI**：例如 Provider 是否支持 resume、审批、模型选择、图片输入。
2. **时间线归一化**：客户端展示领域事件，而非逐行 stdout。
3. **协议版本协商**：Host 与手机可独立发布，必须支持最小兼容版本。
4. **Relay 不可读取应用明文**：如果 Flyx 提供中继，需采用 E2EE。
5. **Agent 与 Session 分离**：Agent 是能力/配置，Session 是一次持续对话。

不建议首期照搬：

- chat room 作为主交互模型；
- 丰富的多 Agent 委员会、循环与调度；
- 完整浏览器、终端、文件传输二进制协议；
- 复杂的 Provider 自定义配置生态。

### 3.3 Multica：借鉴远程 Runtime 注册和任务控制面

Multica 更偏向云端工作管理系统。本期最有价值的设计是：

- 一个 Daemon 可注册多个 Provider Runtime；
- Runtime 以 daemon、workspace、provider/profile 组合形成稳定身份；
- heartbeat、last-seen、online/offline 和 stale sweeper；
- Runtime 默认私有，并有 owner/visibility；
- 云端排队任务，在线 Daemon claim 后本地执行；
- task message 以 sequence 增量获取；
- 任务取消、失败分类、运行历史和 token usage；
- Agent 是持久化配置，Runtime 是实际执行能力；
- 移动端通过 API/WebSocket 获得任务和 Runtime 状态。

Flyx 应借鉴：

1. **Host 与 Runtime 分层**：一台 Host 可同时提供 Codex、Claude Runtime。
2. **在线状态不能只依赖 socket**：应有 heartbeat、lastSeen 和明确的 offline 判定。
3. **任务与进程解耦**：网络断开不应杀掉桌面 Agent。
4. **运行历史持久化**：手机重连应能补齐缺失事件。
5. **默认私有和所有者约束**。

不建议首期照搬：

- Workspace/Issue/Project/Squad/Autopilot 全套 SaaS 模型；
- 云端数据库作为本地任务事实来源；
- Daemon 从云端 claim 所有任务的中心化架构；
- 复杂团队成员与 Runtime 可见性。

Flyx v1 是个人设备远控产品，本地 Host 应是任务和代码状态的事实来源。

### 3.4 三个项目的取舍对比

| 维度 | T3 Code | Paseo | Multica | Flyx 选择 |
|---|---|---|---|---|
| 执行边界 | 环境 Server | 本地 Daemon | 本地 Daemon + 云控制面 | 本地 Host |
| Provider 抽象 | Driver + Instance Registry | Manifest + Provider | Agent 实现 + Runtime | Adapter + Runtime Registry |
| 移动访问 | 直连/Relay/Tailscale | 直连/E2EE Relay | 云 API + Daemon | Tailscale 起步，E2EE Relay 产品化 |
| 状态模型 | 命令/事件/投影 | Timeline/状态机 | Task Queue/消息序列 | 本地事件日志 + 快照 |
| 多端共享 | client-runtime | protocol/client/app | core/api/mobile/web | protocol-sdk + client-core |
| 协作模型 | Thread/Turn | Room/Handoff/Committee | Issue/Squad/Agent | v1 单 Session；v2 Task/Agent 协作 |
| 首期适配度 | 高 | 中高 | 中 | T3 为骨架，吸收 Paseo/Multica 长处 |

### 3.5 Paseo 控制与展示能力对标

Flyx Phase 1B 的对标目标是达到 Paseo 在“Coding Agent 远程控制与结构化 Timeline 展示”上的核心闭环，而不是复制 Paseo 的所有功能。

Phase 1B 必须具备：

- 启动、恢复、发送 follow-up、中止、重试和归档 Agent Session；
- 实时展示用户消息、Agent 文本、reasoning summary、tool call、tool result、审批、提问、错误和完成状态；
- 手机断线、切后台或 Host 连接重建后，通过权威历史补齐展示；
- 一个 Session 在 Turn 结束后保持可继续，不因客户端断开而结束；
- interrupt 和 approval 的最终状态以 Provider 确认或权威事件为准；
- Client 快照只用于快速显示，Host 持久化 Timeline 才是正确性来源；
- Codex、Claude 的真实 Provider Session 身份、进程与历史可被 Flyx Session 稳定关联。

Phase 1B 明确不对标：

- 通用 PTY 终端与任意按键输入；
- 内置浏览器及浏览器自动化；
- 语音、定时任务、loop、Hub 和 Agent 市场；
- Agent 间自主创建子 Agent 和协作编排；
- Provider-owned subagent 的完整交互 UI（只保留协议扩展点）。

验收时应按能力矩阵逐项对比，不使用“类似 Paseo”作为模糊验收语句。

### 3.6 T3 Code 工程一致性与远程环境能力对标

Flyx 除了对标 Paseo 的 Agent 控制与展示，还应吸收 T3 Code 在事务一致性、连接运行时、远程端点、鉴权和 Host 运维方面的优势。

Phase 1B 纳入：

- 命令决策、Event Append、持久化 Projection 和 Command Receipt 在同一 SQLite 事务内提交；
- Provider 副作用通过持久化 intent event 与 Provider Reactor 执行，不在事务中直接调用 CLI；
- Provider ingestion、Provider command、Timeline projection 使用可排空 worker，支持确定性测试和安全关机；
- Tailscale/LAN 作为 endpoint provider，不作为新的 Host 或业务 transport 类型；
- Host 广告多个候选 endpoint，Client 根据稳定 key、可达性、安全 origin 兼容性和用户偏好选择；
- 每个 Host 只有一个 Connection Supervisor 拥有重试策略，连接健康与各业务域同步状态分离；
- Android 使用 DPoP-bound access token，PWA 优先使用 HttpOnly browser session cookie，WSS 只携带短期 ticket；
- Provider Instance 配置与 live Adapter 生命周期分离，一个实例失败不影响其他实例。

Phase 1C/2.1 纳入：

- 每 Turn 隐藏 Git checkpoint、精确 Diff、Workspace + Provider Conversation 协调回退；
- Host 版本偏移检测、精确版本安装预检和安全进程交接；
- 可选进程树 CPU/内存/I/O 遥测，仅在诊断需要时流式传输。

SSH 远程启动、通用 Terminal 和任意文件 RPC 继续不进入首期产品范围。

## 4. 产品范围与信息架构

### 4.1 手机端一级导航

建议 v1 只有四个一级入口：

1. **待处理**
   - 权限审批；
   - Agent 提问；
   - 执行失败；
   - 完成待检查。
2. **任务**
   - 运行中；
   - 等待中；
   - 最近完成；
   - 搜索历史。
3. **新任务**
   - 选择 Host；
   - 选择仓库/工作树；
   - 选择 Codex/Claude；
   - 输入目标和附件；
   - 选择权限模式。
4. **设备**
   - Host 在线状态；
   - Runtime 可用状态；
   - 配对、重命名、撤销；
   - 网络和版本诊断。

### 4.2 任务详情页

任务详情不模拟终端，应包含：

- 标题、仓库、分支/工作树、Agent、模型；
- 当前状态与最近活动时间；
- 结构化 Timeline；
- 当前待审批卡片；
- 当前计划/待办；
- Git Diff 摘要；
- 输入框和“补充指令”；
- 停止、继续、重试；
- “查看原始日志”作为二级诊断入口。

Timeline 展示要求：

- 用户消息保留提交位置，离线重连后不跳动或重复；
- assistant 文本流式增长，完成后由权威投影替换；
- reasoning summary 与 assistant 回答视觉分离，Provider 不支持时不显示空卡片；
- Tool Card 显示工具名称、状态、输入摘要、cwd/目标、受限输出、耗时和错误；
- shell/file/MCP/web/search 使用不同类型标识，但共用一套 Tool Item 生命周期；
- approval/question 卡片解决后在原位显示最终结果，不从 Timeline 删除；
- 显式显示“中止请求中”、“中止未确认”、`outcome_unknown`、runtime closed 和 recovery required；
- provider-owned subagent v1 仅显示可展开的只读执行摘要，不提供独立 prompt、archive 或 interrupt；
- 原始 Provider 帧只在 Host 诊断模式中可用，不得作为正常 Timeline 的唯一内容源。

### 4.3 通知策略

仅对需要用户动作或明确结果发送推送：

- `approval.requested`；
- `question.requested`；
- `session.failed`；
- `turn.completed` 产生的“完成待检查”投影；
- `host.offline`（仅运行中任务受影响时）。

普通 token 流、工具开始/结束不推送。

## 5. 总体技术架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Flyx Clients                                                  │
│ Mobile Web/PWA (Stage 1) │ Native Mobile (Stage 2)           │
│ Desktop/Web (Later) │ Shared Client Core │ Platform Adapter   │
└──────────────────────────────┬───────────────────────────────┘
                               │ Flyx Control Protocol
                         HTTPS + WSS / E2EE Relay
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Flyx Host（开发电脑，唯一执行边界）                           │
│                                                              │
│ API/Auth Gateway                                             │
│ Connection Supervisor │ Scope Authorizer │ Pairing           │
│                                                              │
│ Session Orchestrator                                         │
│ Command Inbox │ Event Log │ Snapshot │ Approval Engine       │
│                                                              │
│ Runtime Registry                                             │
│ Codex Adapter │ Claude Adapter │ OpenCode Adapter（预留）     │
│                                                              │
│ Workspace Services                                           │
│ Repo Registry │ Git/Diff │ Worktree │ Artifact │ Policy      │
│                                                              │
│ Local Store (SQLite) │ Secret Store (Keychain/DPAPI)         │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
       Codex CLI / app-server          Claude Code CLI
```

### 5.1 组件职责

#### Flyx Host

- 生成稳定设备身份；
- 发现 Codex、Claude 可执行文件和版本；
- 验证 Provider 登录状态；
- 注册 Runtime capability；
- 启停 Agent 进程；
- 维护 Session 状态和事件日志；
- 处理工作区、Git Diff 和附件；
- 执行权限策略；
- 向客户端提供认证 RPC 和事件流；
- 断网时继续执行并持久化结果。

#### Client Core

- 保存已知 Host 和访问目标；
- 完成配对与 token 更新；
- 管理连接、指数退避和前后台切换；
- 维护本地快照和事件游标；
- 对命令生成稳定 `commandId`；
- 协议版本与 capability 协商；
- 向 UI 暴露平台无关状态。

Client Core 必须从第一阶段开始独立于 Web UI。第二阶段原生客户端应复用同一套领域 store、RPC、游标同步、幂等命令和错误模型，只替换安全存储、推送、网络状态、后台任务和生物识别等平台适配器。

#### 可选 Flyx Relay

- 帮助 NAT 后的手机与 Host 建立连接；
- 认证设备和路由连接；
- 仅转发端到端加密帧；
- 不保存代码、Prompt、Agent 输出和 Diff 明文；
- 可保存最小离线推送信号，但不得包含敏感正文。

## 6. 核心领域模型

### 6.1 Host

```ts
interface Host {
  id: HostId;                 // 首次启动生成的 UUID，稳定持久化
  displayName: string;
  platform: "macos" | "windows" | "linux";
  hostVersion: string;
  protocolVersion: number;
  capabilities: string[];
  status: "online" | "degraded" | "offline";
  lastSeenAt: string;
}
```

Host 身份不得使用 hostname，因为 hostname 会改变、重复且可能泄漏信息。

### 6.2 ConnectionTarget 与 AdvertisedEndpoint

```ts
type ConnectionTarget =
  | {
      type: "bearer";
      hostId: HostId;
      preferredEndpointKey?: string;
      authSessionId: string;
    }
  | {
      type: "relay";
      relayUrl: string;
      hostId: HostId;
      relayCredentialRef: string;
    };

interface AdvertisedEndpoint {
  key: string; // 稳定 provider key，不尽量使用易变 URL 作为身份
  provider: "lan" | "tailscale" | "manual" | "relay";
  httpsBaseUrl: string;
  wssBaseUrl: string;
  reachability: "loopback" | "lan" | "private" | "public" | "tunnel";
  availability: "available" | "unavailable" | "unknown";
  browserCompatible: boolean;
  isDefault: boolean;
  lastVerifiedAt?: string;
}
```

Host、ConnectionTarget 和 AdvertisedEndpoint 必须分开。Host 是身份和执行边界，Target 是客户端持久化的连接/鉴权关系，Endpoint 是当前候选路径。切换 Wi-Fi、LAN IP、Tailscale IP、MagicDNS 或 Relay 不会产生新 Host。

Tailscale 是 endpoint provider：Host 可检测/管理 `tailscale serve`，并广告 `tailscale-ip:*` 或 `tailscale-magicdns:*` 稳定 key；实际连接仍走普通 HTTPS/WSS + bearer/DPoP 鉴权。

Client 端点选择顺序：

1. 用户保存的 `preferredEndpointKey`；
2. `isDefault = true` 且当前平台兼容的 endpoint；
3. 最近验证成功的非 loopback endpoint；
4. 对 hosted PWA，首个 `browserCompatible = true` 的 HTTPS/WSS endpoint；
5. 否则不自动回退到 loopback 或未信任 HTTP，向用户展示诊断与手动选择。

AdvertisedEndpoint 只是候选与提示，不是可达证明；真实 probe/连接结果才能更新 availability。自动切换 endpoint 必须验证同一 host key。

### 6.3 Runtime

```ts
interface AgentRuntime {
  id: RuntimeId;
  hostId: HostId;
  provider: "codex" | "claude" | "opencode";
  instanceKey: string;        // 允许未来同 Provider 多配置实例
  displayName: string;
  executablePath: string;
  version?: string;
  authStatus: "ready" | "login_required" | "error" | "unknown";
  status: "online" | "busy" | "degraded" | "offline";
  capabilities: RuntimeCapabilities;
  lastProbeAt: string;
}
```

首期 `instanceKey = "default"`，但数据库和协议不应假设每个 Provider 只有一个实例。

### 6.4 AgentProfile

Runtime 表示“能在哪里执行”，AgentProfile 表示“以什么配置执行”：

```ts
interface AgentProfile {
  id: AgentProfileId;
  name: string;
  provider: ProviderKind;
  model?: string;
  systemPrompt?: string;
  permissionPolicyId: PermissionPolicyId;
  defaultRuntimeId?: RuntimeId;
  enabledSkills?: string[];
}
```

v1 UI 可以把默认 Runtime 直接表现为 Codex/Claude 两个 Agent，但领域层应保持分离。

### 6.5 Workspace

```ts
interface Workspace {
  id: WorkspaceId;
  hostId: HostId;
  name: string;
  rootPath: string;           // 仅 Host 返回受控展示值
  repoIdentity?: string;      // remote URL 规范化哈希
  vcsType?: "git";
  currentBranch?: string;
  trustStatus: "trusted" | "untrusted";
}
```

远程客户端不得传任意绝对路径让 Host 直接执行。创建任务必须引用已注册且可信的 `workspaceId`。

### 6.6 Session 与 Turn

```ts
interface Session {
  id: SessionId;
  hostId: HostId;
  runtimeId: RuntimeId;
  agentProfileId?: AgentProfileId;
  workspaceId: WorkspaceId;
  providerSessionId?: string;
  providerNativeHandle?: ProviderNativeHandle;
  timelineEpoch: string;
  title: string;
  status:
    | "active"
    | "archived"
    | "interrupted";
  activityState:
    | "idle"
    | "queued"
    | "starting"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "failed"
    | "runtime_unavailable";
  runtimeResidency: "loaded" | "closed" | "recovering";
  headSequence: number;
  createdAt: string;
  updatedAt: string;
}

interface Turn {
  id: TurnId;
  sessionId: SessionId;
  commandId: string;
  userInput: ContentBlock[];
  status:
    | "queued"
    | "starting"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "completed"
    | "failed"
    | "cancelled"
    | "outcome_unknown";
}

interface ProviderNativeHandle {
  provider: ProviderKind;
  nativeSessionId: string;
  transportKind: "app_server" | "stream_json" | "remote_control" | "pty_fallback";
  opaqueResumeData?: unknown; // Adapter 私有、版本化，不下发给客户端
  adapterSchemaVersion: number;
}
```

Session 对应可继续的 Provider 对话，Turn 对应一次用户输入到 Agent 稳定结束。一次 Turn 完成后，Session 回到 `active + idle`，仍可接收 follow-up；`completed` 是 Turn 或产品 Task 的状态，不是可继续 Session 的终态。“完成待检查”由最近 Turn、未读状态和 Diff 投影得到。只有用户显式归档 Session，或 Provider 对话永久不可恢复时，Session 才离开 active 状态。

`runtimeResidency = "closed"` 表示 Flyx 已释放 Provider 进程，但 Session 记录、Timeline、Provider Native Handle 和 Workspace 关系仍然存在，后续 prompt 可通过 `ensureLoaded` 恢复。它不等于 archived 或 interrupted。

### 6.7 Event

```ts
interface SessionEvent<T = unknown> {
  eventId: string;
  sessionId: SessionId;
  sequence: number;           // 单 Session 严格递增
  type: SessionEventType;
  occurredAt: string;
  payload: T;
}
```

建议事件类型：

```text
session.created
session.status.changed
session.runtime.loaded
session.runtime.closed
turn.started
turn.interrupt.requested
turn.interrupt.unconfirmed
user.message.created
assistant.message.delta
assistant.message.completed
reasoning.summary.delta
tool.call.started
tool.call.progress
tool.call.completed
tool.call.failed
approval.requested
approval.resolved
question.requested
question.resolved
workspace.diff.updated
artifact.created
provider.subagent.updated
turn.completed
turn.failed
turn.cancelled
session.archived
session.unarchived
session.interrupted
```

`assistant.message.delta` 可短期合并后落盘，不能每个 token 写一行 SQLite。建议 50–100 ms 或 1–4 KB 合并一次。

### 6.8 权威 Timeline 与展示投影

`session_events` 是只追加的源事件，手机端不直接把每个 delta 渲染成独立卡片。Host 需要把源事件投影为稳定 Timeline Item：

```ts
interface TimelineItem {
  itemId: string;
  sessionId: SessionId;
  epoch: string;
  sourceSequenceStart: number;
  sourceSequenceEnd: number;
  sourceSequenceRanges: Array<[number, number]>;
  kind:
    | "user_message"
    | "assistant_message"
    | "reasoning_summary"
    | "tool_call"
    | "approval"
    | "question"
    | "provider_subagent"
    | "error"
    | "system";
  status?: "streaming" | "waiting" | "completed" | "failed" | "cancelled";
  providerItemId?: string;
  clientMessageId?: string;
  content: unknown;
  occurredAt: string;
  updatedAt: string;
}
```

投影规则：

- assistant/reasoning delta 按稳定 `itemId` 合并，完成后形成全量文本；
- `tool.call.started/progress/completed` 投影为同一个 Tool Item，保留最终状态和受限输出；
- `approval.requested/resolved` 和 `question.requested/resolved` 更新原 Item，不追加两张相互矛盾的卡片；
- live event 用于即时性，`timeline.getPage` 返回的投影页用于正确性；
- 权威页可以覆盖与 `sourceSequenceRanges` 重叠的 live 投影，不得把全量文本追加到已有 delta 后；
- `epoch` 在 Timeline 重建、导入或破坏性迁移时更换，客户端发现 epoch 变化必须丢弃旧 cursor 并重新同步；
- tool output 进入持久层前进行字节上限截断，live 和 history 使用同一截断结果。

用户消息不依赖 Provider 回显。Host 接受 `session.startTurn` 时在同一事务中创建 canonical `user.message.created`，其 `clientMessageId` 与手机乐观消息匹配；Provider 后续返回的 message id 写入 `providerItemId`。去重优先使用 ID，不对整个历史做文本去重。

## 7. Provider Adapter 设计

### 7.1 设计目标

- 业务层不知道 Codex/Claude 的进程参数和输出格式；
- Adapter 只输出统一领域事件；
- 支持 Provider 版本变化；
- 支持 resume/cancel；
- Provider 不支持的能力通过 capability 明确表达；
- 一个 Adapter 实例的停止不得影响其他实例；
- 原始输出可作为诊断日志保存，但不作为客户端协议。

### 7.2 接口

```ts
interface ProviderAdapter {
  readonly kind: ProviderKind;

  probe(input: ProbeInput): Promise<RuntimeProbe>;
  capabilities(probe: RuntimeProbe): RuntimeCapabilities;

  createSession(input: CreateProviderSessionInput): Promise<ProviderHandle>;
  resumeConversation(input: ResumeProviderSessionInput): Promise<ProviderHandle>;
  reattachProcess?(input: ReattachProviderProcessInput): Promise<ProviderHandle>;
  loadHistory(handle: ProviderHandle, input: HistoryInput): Promise<ProviderHistory>;
  runTurn(handle: ProviderHandle, input: ProviderTurnInput): AsyncIterable<ProviderEvent>;

  respondApproval(
    handle: ProviderHandle,
    input: ProviderApprovalResponse
  ): Promise<void>;

  respondQuestion(
    handle: ProviderHandle,
    input: ProviderQuestionResponse
  ): Promise<void>;

  interrupt(
    handle: ProviderHandle,
    input: ProviderInterruptInput
  ): Promise<ProviderInterruptResult>;
  dispose(handle: ProviderHandle): Promise<void>;
}
```

接口中的方法不表示 Provider 必然支持对应能力。具体 handle 应以 capability 暴露可选操作，并区分以下语义：

- `resumeConversation`：根据 provider session id 开启后续 Turn；
- `reattachProcess`：重新连接仍在运行的 Provider 进程；
- `recoverAfterHostRestart`：Host 重启后恢复事件和交互；
- `retryTurn`：创建新 Turn 重试，不复用可能已产生副作用的旧 Turn；
- `interrupt`：请求停止当前执行，不等价于归档 Session。

客户端和 Orchestrator 不得把 `resumeConversation: true` 推导为支持 reattach 或崩溃恢复。

### 7.3 Runtime capability

```ts
interface RuntimeCapabilities {
  resumeConversation: boolean;
  reattachRunningProcess: boolean;
  recoverAfterHostRestart: boolean;
  structuredToolCalls: boolean;
  interactiveApprovals: boolean;
  interactiveQuestions: boolean;
  reasoningSummary: boolean;
  imageInput: boolean;
  fileAttachments: boolean;
  modelSelection: boolean;
  historyHydration: boolean;
  providerSubagentEvents: boolean;
  sandboxModes: string[];
}
```

客户端只能根据 capability 显示功能，不能使用 `provider === "codex"` 之类的散落判断。

### 7.3.1 Provider 事件必备语义

Adapter 输出的 `ProviderEvent` 必须能表达：

```text
session.identity
turn.accepted
content.started / content.delta / content.completed
reasoning.started / reasoning.delta / reasoning.completed
tool.started / tool.progress / tool.completed / tool.failed
approval.requested / approval.resolved
question.requested / question.resolved
turn.completed / turn.failed / turn.cancelled
process.exited
unknown
```

Provider 未给出稳定 ID 时，Adapter 可在当前 Turn 内生成稳定映射 ID，但不得通过文本全局去重。`unknown` 事件保存受限诊断摘要并继续解析，但任何未知事件都不得解读为审批通过、Turn 完成或权限扩大。

### 7.3.2 Interrupt 确认语义

```ts
interface ProviderInterruptResult {
  status: "acknowledged" | "rejected" | "timed_out" | "process_exited";
  providerTurnId?: string;
  detail?: string;
}
```

`session.interrupt` 只表示“请求中止”。只有收到 Provider interrupt ACK、`turn.cancelled`、或进程已退出且 Host 完成 reconcile 后，才能将 Turn 转为 cancelled。拒绝或超时时 Turn 继续保持 running，UI 显示“中止未确认”，且同一 Session 不能启动新 Turn。

`force` 模式必须二次确认；它仅能终止 Flyx 已验证归属的 Provider 进程树，不能保证撤销已发生的文件、网络或外部系统副作用。

### 7.4 Codex Adapter

优先级：

1. 若本机 Codex 提供兼容的 app-server/结构化协议，优先使用，并从其生成的 JSON Schema/TypeScript binding 建立版本 fixture；
2. 否则使用 CLI 的 JSON/JSONL 结构化输出；
3. 最后才使用 PTY 文本解析，且只能作为兼容后备。

需要适配：

- 新建与继续 thread/session；
- 流式文本和 reasoning summary；
- tool call 生命周期；
- approval request/response；
- interrupt；
- 模型和 sandbox/approval mode；
- Provider session id 持久化；
- CLI 版本探测和兼容矩阵。

Codex 映射至少覆盖以下 app-server item 类别（名称随实际 Schema 版本适配）：

| Codex 结构化内容 | Flyx Timeline |
|---|---|
| UserMessage | canonical `user_message` 的 Provider ID/历史对账 |
| AgentMessage | `assistant_message` |
| Reasoning | `reasoning_summary` |
| Plan | Tool/System 类计划展示 |
| CommandExecution | shell `tool_call` + cwd/stdout/stderr/exit status |
| FileChange | file-write/patch `tool_call` + files/diff |
| McpToolCall | MCP `tool_call` |
| WebSearch | network/search `tool_call` |
| CollabAgentToolCall/SubAgentActivity | 保留为 tool/subagent 扩展事件，v1 可只读展示 |
| ImageView/ImageGeneration | artifact/assistant image content |

`thread/read` 或等价历史接口是 Codex history hydration 的权威来源。历史中的完成 Tool Item 不得重放成 live `started`；已有 Flyx Timeline 时，只对缺口做对账，不整段追加。

### 7.5 Claude Adapter

同样优先使用结构化 SDK/协议或 stream-json 模式，不依赖 ANSI 终端文本。需要适配：

- 新建与继续 conversation；
- assistant content blocks；
- tool use/tool result；
- permission prompt；
- user clarification；
- interrupt 与异常退出；
- permission mode；
- Provider session id 持久化；
- Claude Code 版本兼容矩阵。

Claude 映射至少覆盖：

| Claude 结构化内容 | Flyx Timeline |
|---|---|
| system/session init | Provider Native Handle 与 runtime metadata |
| assistant text block/delta | `assistant_message` |
| thinking/reasoning block | capability-gated `reasoning_summary` |
| tool_use | running `tool_call` |
| tool_result | 完成/失败原 `tool_call` |
| permission callback/prompt | `approval` |
| user clarification/UI request | `question` |
| result/success | `turn.completed` + usage |
| result/error/abort | `turn.failed` 或经确认的 `turn.cancelled` |
| provider child/sidechain event | 保留 subagent descriptor，v1 只读展示 |

Claude 的 tool permission 必须通过可编程 callback/双向结构化通道返回；如果选定 transport 只能输出事后 stream 而无法回答 permission/question，则 `interactiveApprovals/interactiveQuestions` 必须为 false，不得在手机 UI 显示可操作卡片。

Claude Code 当前还提供内建 Remote Control 和后台 Agent 能力。Phase 0 必须比较三条接入路径：

1. `stream-json` 双向进程协议；
2. Claude Code 内建 Remote Control 是否有可复用、稳定且允许第三方集成的控制面；
3. PTY 交互兼容层。

比较维度包括审批往返、提问、resume、正在运行进程的 reattach、Host 重启、版本稳定性、认证边界和许可约束。若内建 Remote Control 能满足需求，应优先作为 Claude transport 或明确说明不采用原因，避免重复实现 Provider 已提供的远控生命周期。PTY 仍只能是诊断性后备。

### 7.6 OpenCode 预留

v1 不实现完整功能，但应提供：

- `ProviderKind` 中的 `opencode`；
- Adapter 契约测试套件；
- manifest/capability 数据结构；
- unknown event 的安全降级；
- 数据库不使用 Codex/Claude 专属枚举约束。

### 7.7 Provider Driver、Instance 与 Adapter Registry

Provider 配置与 live process 必须分离：

```text
ProviderDriverRegistry      driver kind -> config schema + factory
ProviderInstanceRegistry    instanceId -> validated config + child scope
ProviderAdapterRegistry     instanceId -> live adapter
ProviderSessionDirectory    sessionId -> instanceId + Provider Native Handle
```

- Driver 声明 `driverKind`、版本化 config schema、capability probe 和 Adapter factory；
- Instance Registry 使用 Driver schema 校验配置，每个 instance 在独立 child scope 中创建；
- Adapter Registry 只路由 live instance，Orchestration 只持有 `runtimeId/instanceId`，不包含 Provider 分支；
- 一个 instance 初始化、鉴权或关闭失败不得关闭其他 instance scope；
- 更新 instance 配置使用新 generation，旧 Session 继续绑定已记录 generation，不静默切换运行中 Provider；
- v1 UI 仍可只显示 Codex/default 和 Claude/default，但数据库、RPC 和生命周期不假设单例。

Provider 模型、mode 和 capability 查询应有显式 global/workspace scope 和缓存状态。普通 UI 打开不得通过创建临时 Session 获取元数据，避免在 Provider 历史中产生空会话。

## 8. Host 内部架构

### 8.1 推荐技术栈

Flyx 不采用“一开始 Rust + 原生 Android + Relay”的大切片。参考 Paseo 的直接 Provider 集成和 T3 Code 的工程分层后，推荐按阶段选择：

| 层 | Claude 验证 MVP | 第一版可用产品 | 后续演进 |
|---|---|---|---|
| Host Runtime | Node.js 22 LTS + TypeScript | 仍使用 Node.js/TypeScript，直到跨平台守护进程需求真实出现 | 必要时将进程/存储/安全边界下沉 Rust；Claude 继续由 TS Bridge 或独立 Adapter 承载 |
| Claude 接入 | `@anthropic-ai/claude-agent-sdk` 直连 | 同一 SDK Adapter，锁定 SDK/Claude 版本组合 | 若 SDK 需要隔离，使用受监督 TS sidecar，不用 PTY 正则替代结构化协议 |
| Codex 接入 | 不实现 | Codex app-server/结构化协议 Adapter | Provider Driver/Instance Registry 多实例化 |
| HTTP/WSS | Fastify + `@fastify/websocket` | 同一 HTTPS/WSS 协议 | Relay 只转发 E2EE 帧，不改变业务协议 |
| 协议 | Zod runtime schema + TypeScript 类型 | 版本化协议包，生成 JSON Schema | JSON Schema 作为跨 Rust/TS 的 canonical source，生成 Rust/TS 类型和边界校验 |
| 本地存储 | SQLite WAL + `better-sqlite3` | SQLite WAL、migration、event/timeline projection | Rust `sqlx`/等价实现，保持同一 schema 和迁移契约 |
| Web | React + TypeScript + Vite | React + Client Core 独立包 | Web、Desktop、Mobile 继续复用 Client Core 和协议包 |
| Android | 不做原生壳 | React Native + Expo Development Build，Android-first | iOS 复用 Client Core 和协议，逐步实现平台 Adapter |
| Desktop | 不做 Electron/Tauri | Host CLI/后台进程 + 浏览器控制面 | 有托盘、自启动、更新和本地授权需求后再选 Tauri 或 Electron |
| 测试 | Vitest + Playwright + 真实 Claude fixture | 同上，加真机 Android 测试 | 契约测试、故障注入、跨版本兼容矩阵 |
| Monorepo/构建 | pnpm workspace + TypeScript project references + Vite | 同上；不引入 Vite Plus 专有编排 | 需要时再增加 Rust workspace 和跨语言 codegen |

具体原则：

- **Node 而不是 Bun**：Claude Agent SDK、原生 Claude executable、`node-pty`/系统进程和 Expo 工具链优先保证 Node 兼容；T3 的 Bun/Node 双运行时经验可参考，但不应给 Flyx 首期增加运行时矩阵。
- **TypeScript 而不是立即 Rust**：Paseo 已证明 Claude Agent SDK 在 TypeScript 中能承载 `canUseTool`、`resume`、partial message 和 `interrupt`；MVP 的最大风险是 Provider 行为，不是语言性能。当前 Claude-only MVP 已明确采用 TypeScript Host，详见独立验证方案。
- **不直接复制 Effect RPC**：T3 的 Effect 在资源生命周期、取消、错误类型和并发控制上有价值，但 Flyx 首期先用显式 Orchestrator、单写队列、状态机和 WSS 协议，避免把 Effect runtime 引入 Provider Spike。团队若已有 Effect 经验，可在 Host 内部逐步替换服务实现，不能改变协议契约。
- **协议单一来源**：MVP 可以 Zod-first；当 Rust Host 真正启动时切换为 JSON Schema canonical source，禁止手工维护 Rust/TypeScript 两套模型。
- **移动端共享“领域运行时”而非强求 UI 复用**：Paseo 的 Expo 共享层和 T3 的 `client-runtime` 都值得借鉴，但 Web DOM 和 React Native 原生 UI 不应为复用而共用组件。共享协议、同步、幂等、reducer、错误和 capability；平台层分别处理 cookie、Keystore、推送、后台和生物识别。

### 8.1.1 技术栈选择的否决条件

任何一次技术替换都必须由指标触发：

- 只有当 Node Host 的进程树、启动/关闭、CPU/内存或跨平台打包成为实测瓶颈，才评估 Rust Host；
- 只有当原生通知、后台恢复、Keystore 或 Android 网络状态无法由 Expo Development Build 满足，才引入自定义 Kotlin Module；
- 只有当 Tailscale/直连无法覆盖目标网络，才开发 Relay；
- 只有当协议需要 Rust/TS 双向生成，才把 JSON Schema 提升为 canonical source；
- 任何替换必须保留 Host、Session、Turn、Event、Approval、Diff 和 commandId 语义，不允许把框架类型泄漏到产品协议。

因此本期的最终建议不是“选 Rust 还是 TypeScript”，而是：**TypeScript 先验证并交付闭环，React Native/Expo 交付 Android，Rust/Tauri/Relay 延后到有实测证据时再引入。**

### 8.2 Host 模块

MVP/第一版 TypeScript Host 的逻辑目录：

```text
apps/flyx-host/src/
├── api/              # HTTP/WSS、RPC dispatch、stream
├── auth/             # pairing、session、scope、revocation
├── protocol/         # generated types、version negotiation
├── runtime/          # discovery、registry、health
├── provider/
│   ├── adapter.ts
│   ├── codex/
│   ├── claude/
│   └── opencode/
├── session/          # orchestrator、command inbox、event writer
├── approval/         # normalization、policy、response
├── workspace/        # registry、trust、path guard
├── vcs/              # status、diff、optional worktree
├── storage/          # sqlite repositories、migrations
├── transport/        # direct、tailscale、relay
└── observability/    # logs、metrics、diagnostics
```

如果后续把 Host Core 下沉 Rust，保持上述逻辑边界和协议不变，只替换实现目录为 `crates/flyx-host/...`；Claude Adapter 可暂时继续作为受监督 TypeScript sidecar。

### 8.3 并发约束

- 一个 Session 同一时刻最多运行一个 Turn；
- 同一 Session 的命令由单队列串行处理；
- 不同 Session 可并发；
- Runtime 可配置并发上限，默认 Codex 2、Claude 2；
- 同一 Workspace 默认允许多个只读任务，但写任务建议使用独立 worktree；
- 每个写命令必须有 `commandId`，Host 在调用 Provider 或产生外部副作用前持久化 receipt；重试返回已有状态或原结果；
- 每个 Session event sequence 由单 writer 分配。

### 8.4 命令一致性与崩溃窗口

`commandId` 只保证 Flyx 控制命令去重，不能承诺任意外部系统副作用的 exactly-once。Host 必须显式记录命令状态：

```text
received -> accepted -> dispatched -> completed
                         |              |
                         +-> outcome_unknown
received/accepted -------> rejected
```

建议 `command_receipts` 至少保存：

```ts
interface CommandReceipt {
  clientId: ClientId;
  commandId: string;
  method: string;
  requestHash: string;
  sessionId?: SessionId;
  turnId?: TurnId;
  state:
    | "received"
    | "accepted"
    | "dispatched"
    | "completed"
    | "rejected"
    | "outcome_unknown";
  resultRef?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}
```

处理规则：

1. 在一个 SQLite 事务内验证命令、创建稳定 `turnId`、写入 `received/accepted` receipt；
2. receipt 提交后才允许调用 Provider；
3. Provider 接受命令后更新为 `dispatched`；
4. 事件和最终 receipt 尽量由同一 orchestrator 串行提交；
5. 相同 `clientId + commandId` 但 `requestHash` 不同，返回 `COMMAND_ID_REUSED`；
6. Host 重启后不得自动重放 `dispatched` 命令；
7. 若可凭 provider session/turn identity 查询结果，则完成 reconcile；否则标记 `outcome_unknown`，要求用户检查后继续；
8. `approval.respond` 同时使用 approval version CAS，不能只依赖 command receipt；
9. 对网络请求、部署、数据库变更等外部副作用，UI 和审计明确显示“执行结果未知”，不得推测成功或自动重试。

首期至少对 `session.create`、`session.startTurn`、`session.interrupt`、`approval.respond`、`question.respond` 实现上述状态机。

### 8.5 Provider 进程监督与 Runtime Residency

Host 启动的 Provider 进程及其可长期存活的 helper 必须纳入 Managed Process Registry：

```ts
interface ManagedProviderProcess {
  id: string;
  sessionId: SessionId;
  runtimeId: RuntimeId;
  provider: ProviderKind;
  kind: "session" | "app_server" | "helper";
  pid: number;
  processStartIdentity: string;
  executablePath: string;
  argvDigest: string;
  generation: string;
  state: "starting" | "running" | "stopping" | "exited" | "orphaned";
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
}
```

约束：

- spawn 成功后立即记录所有权，不等 readiness 成功后才登记；
- Session 注册前任何初始化、鉴权或历史加载失败，Adapter 都必须清理已 spawn 的进程；
- Host 只根据 registry 中的 PID + process start identity + executable/argv digest 判断归属；
- PID 存在但 identity 不匹配时只删除失效记录，不得杀进程；
- 无法检查归属时保留记录并标记 orphaned，不做进程名全局扫描；
- Session 可在 idle 时保持 loaded，也可根据资源策略显式 close runtime；close 不归档 Session；
- 向 closed Session 发送 prompt 前必须调用 `ensureLoaded`，恢复 Provider Native Handle 并完成权威历史 reconcile；
- 归档是全局领域操作：先持久化 archived 状态，再关闭 runtime，并向所有客户端广播；关闭手机 tab 不自动归档。

### 8.6 Host 与 Provider 双状态对账

Host Session/Turn 状态不能只由 RPC 成功响应驱动。Orchestrator 必须把 Provider 事件、进程退出和持久化 receipt 进行 reconcile：

```text
Flyx accepted + Provider turn.accepted       -> running
approval.requested                           -> waiting_approval
question.requested                           -> waiting_input
Provider turn.completed                      -> completed / Session idle
Provider turn.failed                         -> failed / Session idle
Provider interrupt ACK or turn.cancelled     -> cancelled / Session idle
process exited with terminal turn event       -> use terminal event
process exited without terminal turn event    -> outcome_unknown or interrupted
interrupt timeout while process still alive  -> remain running
```

任何恢复流程都必须生成可见的 recovery event，禁止静默把 running 改成 completed、failed 或 cancelled。

### 8.7 事务化 Orchestration Engine

Orchestration Engine 是 Session/Turn 领域命令的唯一写入边界。客户端命令和 Provider 运行时结果都以 `CommandEnvelope` 进入同一引擎：

```ts
interface CommandEnvelope {
  commandId: string;
  clientId?: ClientId;       // 内部命令可为空
  source: "client" | "provider" | "system";
  sessionId?: SessionId;
  expectedHeadSequence?: number;
  command: OrchestrationCommand;
  occurredAt: string;
}
```

处理流程：

1. Session-scoped command 由单 writer/队列串行，不同 Session 可并发；
2. 查询持久化 command receipt，已处理命令直接返回原结果；
3. 纯 `decide(state, command)` 只生成 domain/intent events，不访问网络、文件、Git 或 Provider；
4. 在同一 SQLite 事务内 append events、更新持久化 Session/Turn/Approval/Timeline 投影、写入 accepted receipt；
5. 事务提交后才更换内存 read model 并发布 committed events；
6. ProviderCommandReactor 消费 committed intent event 并调用 Provider；
7. ProviderRuntimeIngestion 将 Provider 输出转换为内部 command，再进入本引擎；
8. 处理失败时从数据库重读起始 sequence 后的 committed events 对账，不相信可能落后的内存状态。

```text
Client RPC
  -> Orchestration Command
  -> transaction(events + projections + receipt)
  -> committed intent event
  -> ProviderCommandReactor
  -> Codex/Claude
  -> ProviderRuntimeIngestion
  -> internal command
  -> transaction(result events + projections)
  -> Timeline/live subscribers
```

禁止在 SQLite 事务内启动 Provider、等待 CLI、调用 Git 或发网络请求。持久化 intent event 是副作用恢复与审计的边界，但仍不对外部副作用承诺 exactly-once。

### 8.8 Drainable Worker

Provider command、Provider ingestion、Timeline projection 和后续 Checkpoint 都使用统一可排空 worker：

```ts
interface DrainableWorker<T> {
  enqueue(item: T): Promise<void>;
  drain(): Promise<void>;
  stop(mode: "drain" | "immediate"): Promise<void>;
  readonly outstanding: number;
}
```

- `enqueue` 必须原子地入队并增加 outstanding；
- 成功、失败和取消路径都必须在 finally 中减少 outstanding；
- `drain` 只在队列为空且当前处理已结束时返回；
- 测试使用 `drain`，禁止用固定 sleep 猜测后台工作是否完成；
- Host 正常关机先停止接收新命令，再按 ingestion -> orchestration -> projection 的安全顺序 drain，最后关闭存储。

### 8.9 Host 启动就绪阶段

Host 显式发布：

```text
starting -> command_ready -> http_listening -> ready -> draining -> stopped
```

- migrations、event replay、projection 恢复、Provider registry 和 reactors 启动完成后才进入 `command_ready`；
- HTTP/WSS listener 对外可达后进入 `http_listening`；
- endpoint provider、heartbeat 和关键后台服务可用后进入 `ready`；
- `host.probe` 可在非 ready 阶段返回结构化 readiness，其他写 RPC 在 `command_ready` 前返回 `HOST_NOT_READY`；
- socket 一旦可连接，Orchestration Engine 必须已能安全接受命令。

## 9. 控制协议

### 9.1 协议形式

推荐使用 **HTTPS 做 bootstrap 和一元 API，WSS 做双向 RPC 与事件订阅**。不建议首期引入 gRPC-Web，因为 React Native、浏览器代理和 Relay 的调试复杂度更高。

消息信封：

```ts
type Frame =
  | {
      type: "request";
      id: string;
      method: string;
      commandId?: string;
      payload: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: true;
      payload: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: RpcError;
    }
  | {
      type: "event";
      subscriptionId: string;
      event: unknown;
    };
```

### 9.1.1 HTTPS Bootstrap/Auth 端点

```text
GET  /.well-known/flyx-host              # Host identity/protocol/auth methods
GET  /api/host/advertised-endpoints
POST /api/pairing/exchange
POST /api/auth/token                     # Android DPoP token exchange
POST /api/auth/browser-session           # PWA HttpOnly cookie
POST /api/auth/websocket-ticket
POST /api/auth/revoke
```

Descriptor 显式广告支持的 session methods，如 `browser-session-cookie`、`dpop-access-token`、`bearer-access-token`（仅兼容模式）。Client 通过 capability 选择，不假设所有 Host 都支持新鉴权方式。

### 9.2 v1 RPC 清单

#### Host

```text
host.probe
host.getSnapshot
host.subscribeStatus
host.listAdvertisedEndpoints
host.getDiagnostics
host.subscribeDiagnostics        # Phase 2.1 capability-gated
host.updateWithProgress          # Phase 2.1 capability-gated
```

#### Runtime

```text
runtime.list
runtime.refresh
runtime.subscribe
```

#### Workspace

```text
workspace.list
workspace.get
workspace.registerLocal       # 仅本地 Desktop/CLI scope
workspace.getGitStatus
workspace.getDiff
```

#### Session

```text
session.create
session.list
session.get
session.ensureLoaded
session.startTurn
session.interrupt
session.retryTurn
session.archive
session.unarchive
session.closeRuntime
session.subscribe
session.getEvents
```

#### Timeline

```text
timeline.getPage              # 权威投影页，支持 before/after
timeline.getItem
timeline.subscribe            # 可见 Session 的 live delta
```

#### Checkpoint（Phase 1C capability-gated）

```text
checkpoint.getTurnDiff
checkpoint.getSessionDiff
checkpoint.revertPreview
checkpoint.revert
```

#### Interaction

```text
approval.respond
question.respond
```

#### Access

```text
access.listSessions
access.revokeSelf              # access:self
access.revokeSession           # admin:access
access.listPairings
access.revokePairing
```

### 9.3 订阅与补偿同步

手机连接后：

1. 调用 `host.getSnapshot` 获取 Host、Runtime、活跃 Session 和各自 `headSequence`；
2. 对需要观察的 Session 调用 `session.subscribe({ afterSequence })`；
3. Host 为订阅取得 watermark `W = headSequence`，先注册 live 缓冲，再回放 `(afterSequence, W]`，最后按 sequence 发送缓冲的 `> W` 事件；
4. 若游标早于保留窗口，返回 `CURSOR_EXPIRED`，客户端重新取 Session snapshot；
5. 客户端对 `eventId` 去重，并要求 sequence 连续；
6. 发现缺口时暂停应用事件并调用 `session.getEvents` 补齐。
7. 打开 Session 详情时调用 `timeline.getPage({ direction: "after", cursor })` 取权威投影，直到 `hasNewer = false`；
8. 权威投影页通过 `sourceSequenceRanges` 与 live item 合并，并更新展示 cursor。

这比“断线后重新拉完整聊天记录”更高效，也能正确恢复工具和审批状态。

订阅建立必须避免“查询历史完成、live listener 尚未注册”之间的丢事件窗口。客户端允许收到重复事件，但不允许跳过 sequence；重复由 `eventId + sequence` 去重。若 live 缓冲超过上限，Host 终止本次订阅并返回 `RESYNC_REQUIRED`。

### 9.3.1 Timeline 分页合约

```ts
interface TimelinePage {
  sessionId: SessionId;
  epoch: string;
  items: TimelineItem[];
  startCursor?: string;
  endCursor?: string;
  hasOlder: boolean;
  hasNewer: boolean;
  sourceSequenceStart?: number;
  sourceSequenceEnd?: number;
}
```

- 首次打开且无 cursor 时返回最新受限 tail，更旧内容由用户向上滚动加载；
- 已有 cursor 的恢复必须向后逐页补齐，不能直接换成最新 tail，否则可能跳过长时间后台运行的中间内容；
- `hasNewer = true` 时 Client Core 立即继续请求 `endCursor` 后的页，直到 false；
- 超时只检测“是否长时间无分页进展”，不对整个多页同步设短总超时；
- 投影 Item 的数量限制不等于源事件数量限制，一个 Tool Item 可以覆盖多个 source sequence；
- pending approval/question 必须从 Host snapshot 和权威 Timeline 恢复，不信任移动端的普通缓存。

### 9.4 背压

- token delta 在 Host 合并；
- Session 支持 `streaming | buffered` assistant delivery mode；buffered 只影响传输频率，不改变 canonical Timeline 内容；
- buffered 模式达到 24,000 字符或可配置上限时溢出一个合并 delta，不等到 Turn 结束才显示；
- 打开 approval/question 之前必须先 flush 已缓冲 assistant 文本，保证用户看到导致交互请求的上下文；
- WSS 每连接有有限发送队列；
- 慢客户端不阻塞 Agent；
- 队列高水位时，将多个 delta 合并成 message snapshot；
- 仍无法追上时关闭订阅并返回 `RESYNC_REQUIRED`；
- Diff、图片、附件通过短期签名 HTTPS URL 获取，不塞进 WSS JSON。

## 10. 配对、认证与授权

### 10.1 设备身份

Host 首次启动生成：

- `hostId`；
- Ed25519 身份密钥；
- 本地 TLS 证书或 Relay 身份材料；
- 加密存储在系统 Secret Store。

Mobile 首次安装同样生成设备密钥和 `clientId`。

对于 Stage 1 Web/PWA，“首次安装”具体指某个固定 HTTPS origin 下首次初始化。浏览器生成不可导出的 WebCrypto 密钥，并将其句柄保存在该 origin 的持久化存储中。清除站点数据、更换浏览器或更换 origin 均视为新客户端，必须重新配对；Host 端旧配对不会因此自动删除，用户可在设备页撤销。

### 10.2 配对流程

```text
Desktop CLI/UI                 Mobile                    Host
     │                           │                        │
     │ 创建 5 分钟一次性 Pairing Grant                  │
     │<──────────────────────────────────────────────────│
     │ 显示 QR: host/relay + grant + host public key     │
     │                           │                        │
     │                           │ 扫码并校验 Host 指纹    │
     │                           │── exchange(grant, client public key) ──>│
     │                           │<── client session + scopes + expiry ────│
     │                           │                        │
```

要求：

- grant 一次性使用，默认 5 分钟；
- QR 中的 secret 放 URL fragment 或编码 payload，不发给无关 Web origin；
- Mobile 显示 Host 名称和公钥短指纹；
- Host 本地显示新设备确认提示；
- 配对完成创建 server-side 可撤销 client session；
- WSS 使用 30–60 秒短期 ticket，避免长期 token 出现在 upgrade URL；
- 可从 Host 或手机撤销 session；
- Host 使用 server-side 可撤销 auth session；长期 refresh secret 仅保存哈希；
- Android 默认使用 DPoP-bound access token，配对私钥 JWK thumbprint 绑定 auth session，单独窃取 token 无法重放；
- PWA 优先使用 `HttpOnly + Secure + SameSite` browser session cookie，长期 session secret 不暴露给 JavaScript；
- access token/WSS ticket 为短期签名凭证，绑定 `clientId + authSessionId + audience + scopes + expiry + nonce`；
- WSS ticket 默认单次使用，Host 保存短期 nonce 消费记录；
- 撤销 auth session 后不得再换取 ticket，已连接 socket 立即关闭。

### 10.2.1 Android DPoP 合约

Android 在 Keystore 生成尽量不可导出的签名私钥，用配对 grant 做 token exchange 时提交 DPoP proof。Host 验证并保存 JWK thumbprint，签发短期 DPoP-bound access token。

DPoP proof 至少绑定：

```text
http method
canonical request URL
issued-at
unique jti
public JWK
access-token hash（已签发 token 请求）
```

Host 保存短期 `jti` replay cache，校验 clock skew，并在 proof URL 与实际 endpoint 不匹配时拒绝。无效 DPoP 不得静默降级签发 bearer token。

### 10.2.2 PWA Browser Session

PWA 使用一次性 bootstrap credential 调用 `POST /api/auth/browser-session`，Host 设置 HttpOnly session cookie，响应不向 JavaScript 返回 session secret。浏览器从同一 Host origin 获取 WSS ticket；如果使用固定 hosted PWA origin + Relay，则 browser session 属于 Relay/E2EE 的独立鉴权流程，不把 Host cookie 发给 hosted origin。

Browser session endpoint 必须配合 CSRF/origin 检查；非同 origin 访问不依赖第三方 cookie。

### 10.2.3 Stage 1 Web/PWA 信任与 Origin 约束

Web/PWA 只有在固定安全 origin 下才能稳定保存设备身份并使用 Service Worker、WebCrypto 等能力。v1 不把“任意 LAN IP + 自签证书”作为普通用户默认路径。

推荐优先级：

1. **内测默认：Tailscale HTTPS + 稳定 MagicDNS 名称**。Host 身份仍通过 Flyx host key 校验，DNS 名称只解决可达性和浏览器 HTTPS；
2. **开发模式：局域网 HTTPS**。需要用户显式安装/信任开发证书，UI 必须标记为开发接入；
3. **公开产品：固定 Flyx Web origin + E2EE Relay**。Web origin 不随 Host 改变，Relay 不读取应用明文。

必须满足：

- QR 中同时携带或绑定 `hostId + host public key fingerprint + access target + pairing grant`；
- 完成 exchange 前，客户端校验实际握手得到的 Host key 与 QR 一致；
- Endpoint/ConnectionTarget 自动切换时必须保持同一 host key，否则 fail closed；
- pairing secret 仅存在 QR payload/URL fragment，页面启动后立即从地址栏和 history 清除；
- 禁止第三方脚本、广告、非必要分析 SDK 出现在配对页面；
- 明确 PWA origin 迁移流程；origin 变化默认要求重新配对，不能静默复制私钥；
- IndexedDB 中只保存非秘密索引和密钥句柄，refresh secret 应由不可导出私钥包装，且仍需接受浏览器存储不等价于原生安全存储的风险。

Stage 1 的安全声明应写成“适合受控个人设备和 Tailscale/可信 HTTPS 环境”，不得宣称达到原生 Keychain/Keystore 同等级别。

### 10.3 Scope 与 Token Exchange

建议最小 scope：

```text
host:read
runtime:read
workspace:read
session:read
session:write
approval:respond
diff:read
terminal:read        # v1 默认不授予
terminal:write       # v1 不支持
access:self          # 查看/撤销当前客户端自己的 session
admin:access         # 管理其他配对和会话
workspace:register   # 仅本机客户端
```

默认手机配对具有 `access:self`，但不具备 `admin:access`、`workspace:register`、`terminal:write` 和任意文件写 RPC。撤销自己的 session 与撤销其他设备必须是两个独立授权路径。

要求：

- Pairing Grant 携带最大 scope grant，Token Exchange 的 requested scopes 必须是其子集；
- 普通 Android/PWA 客户端不得申请 `admin:access` 或 `workspace:register`；
- WSS ticket 继承 auth session 的 scope，但 socket 连接成功不等于授权所有 RPC；
- 协议包必须维护完整 `RPC_METHOD -> REQUIRED_SCOPE` 映射，每次新增 RPC 的契约测试必须失败，直到配置 scope；
- browser cookie、DPoP token、WSS ticket、Relay credential 和 E2EE key 是不同凭证/信任边界，不得相互替代或跨 audience 使用；
- 鉴权 Schema 的破坏性升级采用 hard cutover：废弃旧 session 并要求重新配对，不将旧 role/token 静默映射为新权限。

### 10.4 Relay 端到端加密

Relay 产品化时：

- Mobile 和 Host 使用配对密钥派生会话密钥；
- 使用 Noise XX/IK 类握手或成熟等价协议；
- 每帧 AEAD 加密，带单调 nonce/sequence；
- Relay 只知道 hostId、clientId、连接时间、流量大小；
- Relay 无法读取 RPC method、Prompt、Diff、路径；
- push notification 只发送 `hostId + opaque attention id`；
- Mobile 收到推送后连接 Host 拉取真实内容。
- Relay 鉴权凭证与 Host access token 分离；Host token 不能登录 Relay，Relay token 不能直接调用 Host RPC。

不要自创密码学细节；应选用成熟库和协议并做第三方审计。

## 11. 权限与安全策略

### 11.1 威胁模型

需要防范：

- QR/配对码被截获；
- 长期 token 泄漏；
- Relay 或公网观察者读取代码与 Prompt；
- 手机丢失后仍可控制电脑；
- 恶意客户端构造任意路径或命令；
- Agent 通过 prompt injection 请求危险工具；
- 多客户端重复审批；
- 重放或乱序命令；
- Host 被降级到不安全旧版本；
- 原始日志泄漏密钥。

不承诺防范：

- 已完全控制开发电脑的本地 root/admin；
- 已解锁且攻陷手机系统的攻击者；
- Provider 本身对其接收内容的处理风险。

### 11.2 Approval 统一模型

```ts
interface ApprovalRequest {
  id: ApprovalId;
  sessionId: SessionId;
  kind:
    | "shell_command"
    | "file_write"
    | "network_access"
    | "mcp_tool"
    | "workspace_escape"
    | "provider_specific";
  title: string;
  explanation?: string;
  risk: "low" | "medium" | "high" | "critical";
  preview: ApprovalPreview;
  previewConfidence: "provider_declared" | "flyx_inferred" | "unknown";
  sideEffectsComplete: boolean;
  allowedResponses: Array<"allow_once" | "allow_session" | "deny">;
  expiresAt?: string;
  status: "pending" | "approved" | "denied" | "expired" | "superseded";
  version: number;
}
```

风险和影响预览是辅助决策信息，不是完整副作用证明。脚本、shell、MCP 工具和网络服务可能动态产生未声明影响；当 `sideEffectsComplete = false` 时，UI 使用“已知影响”措辞并明确提示可能存在其他副作用。Host 不得仅因静态命令看似安全就把 Provider 的高风险审批降级。

手机卡片必须展示：

- 完整命令或结构化工具名称；
- 工作目录；
- 影响文件/网络目标；
- 风险标签和原因；
- Agent 的解释；
- “仅本次允许”作为默认正向动作；
- 高风险操作二次确认。

`allow_always` 不应出现在 v1 手机端。持久规则只能在本地桌面设置中创建。

### 11.3 并发审批

多个客户端可能同时响应：

- `approval.respond` 携带 `approvalId + version + commandId`；
- Host 使用 compare-and-set；
- 第一个有效响应获胜；
- 后续响应返回 `ALREADY_RESOLVED` 和最终结果；
- Provider 断开或 Session 结束时，所有 pending approval 标记为 superseded。

### 11.4 路径安全

- 所有文件、Diff、附件 API 使用 `workspaceId + relativePath`；
- canonicalize 后必须仍在 workspace root 内；
- 拒绝 `..`、符号链接逃逸和设备路径；
- Workspace 必须由本地用户显式注册/信任；
- 手机不能创建任意 rootPath；
- 附件写入 Host 的 session sandbox，再由 Adapter 引用；
- 下载 URL 短期、一次性或与 client session 绑定。

### 11.5 日志脱敏

- 不记录 token、pairing secret、Authorization header；
- 环境变量默认不落日志；
- 命令输出可包含秘密，原始日志只在 Host 本地有限保留；
- 手机只拉取结构化事件；
- 导出诊断包前进行二次脱敏；
- 路径展示允许用户选择隐藏用户名部分。

## 12. 移动网络与生命周期

### 12.1 关键原则

**客户端连接的生命周期不得决定 Agent 进程生命周期。**

手机锁屏、切后台、断网时：

- Host 继续执行 Session；
- 事件继续落 SQLite；
- pending approval 可按 Provider 能力保持等待；
- Mobile 恢复时使用 sequence 补同步；
- 需要操作时由 push 通知；
- 若 Host 离线，Mobile 显示最后快照而非清空状态。

### 12.2 连接状态机

```text
disconnected
   ↓
resolving_target
   ↓
connecting
   ↓
authenticating
   ↓
synchronizing
   ↓
ready
   ↘ degraded
   ↘ reconnecting ──> synchronizing
   ↘ revoked
   ↘ incompatible
```

每个已注册 Host 只有一个 `ConnectionSupervisor`。RPC session factory 只尝试一次 prepare/open/authenticate，不自行重试；Supervisor 是退避、endpoint 切换、离线等待和连接租约的唯一所有者。

退避建议：0.5s、1s、2s、5s、10s、16s，上限 16s；连接稳定 30s 后清空历史退避债务。

规则：

- 设备 offline 时释放 socket 并等待 network signal，不消耗 retry attempt，不运行退避 timer；
- 等待退避时回到前台、用户显式 retry、网络变化或 push 到达可立即清空本次等待；
- 已连接时普通前台唤醒先用短超时 `host.probe`检查 lease，健康时保留当前 socket；
- Android 经历长时间后台、OS 可能静默杀 socket 时发出 `application-active-reconnect`，直接替换 lease；
- auth/config 失败进入 blocked，直到凭证、配置或用户操作产生外部 wakeup，不无限重试；
- domain subscription 失败不等于 transport 失败；预期内业务错误在同一 session 重订阅，只有 transport failure 才等待 Supervisor 替换 session；
- mutation 在执行时解析当前 Host runtime，不长期持有可能已被替换的 RPC client；
- 显式删除 Host 是客户端破坏边界：关闭 Supervisor，清理 target、凭证、Host/Runtime/Session 缓存、Timeline replica、草稿和 outbox。

### 12.2.1 连接与领域同步状态分离

socket 已打开不等于所有数据已同步。Client Core 独立维护：

```ts
interface DomainSyncState {
  transport: "offline" | "connecting" | "connected" | "blocked" | "error";
  host: "empty" | "cached" | "synchronizing" | "live";
  runtimes: "empty" | "cached" | "synchronizing" | "live";
  sessions: "empty" | "cached" | "synchronizing" | "live";
  timelineBySession: Record<SessionId, "empty" | "cached" | "synchronizing" | "live" | "error">;
}
```

- UI 可显示“已连接，Timeline 同步失败”，不伪造一个并未调度的“正在重连”；
- cached snapshot 不能覆盖同一 RPC generation 中已到达的更新 live 状态；
- RPC generation 变更后，有限 query 重验证，持久 subscription 切换到新 session，outbox 重新 reconcile；
- 组件挂载/卸载不得创建、关闭 Supervisor 或清空 Host-scoped replica。

### 12.3 Host 重启恢复

Host 启动时：

1. 读取未结束 Session；
2. 根据 Managed Process Registry 校验 PID、process start identity、executable 和 argv digest；
3. 调用 Adapter 能力区分 reattach running process、resume conversation 和 history hydration；
4. 能 reattach 时先建立事件订阅，再加载 Provider 权威历史补齐 Host 缺口；
5. 进程不存在但 Provider 对话可 resume 时，将 Session 设为 `active + idle + closed`，不自动重放未知 Turn；
6. 无法判定已 dispatch Turn 结果时标记 Turn `outcome_unknown`，Session 生成 `session.recovery.required`；
7. 保留 providerSessionId 和 Provider Native Handle，允许用户检查后继续；
8. 绝不能静默把中断任务标为 completed、failed 或 cancelled。

## 13. Git、Diff 与工作区策略

### 13.1 v1

- 手机发起任务时选择已注册 workspace；
- 默认直接在当前工作树执行，但明显提示当前 branch 和 dirty 状态；同一 workspace 同时最多一个写 Session；
- dirty workspace 创建写任务前必须显式确认，Host 不得把既有变更归因给当前 Session；
- Session 开始记录 baseline：
  - HEAD commit；
  - `git status --porcelain=v2`；
  - 工作区 Diff 摘要；
  - 已修改和未跟踪文件的内容哈希/元数据；
- Turn 完成重新计算状态和 Diff；
- 手机支持文件列表、统计、文本 diff；
- 二进制文件只显示元信息；
- 超大 Diff 分页或按文件拉取。

Diff 需要区分三个概念：

```text
workspace current diff   当前工作区相对 Git baseline 的全部变化
session observed delta   Session 开始至当前观察到的文件变化
session attributed diff  能够较高置信度归因给本 Session 的变化
```

v1 在共享当前工作树时只能可靠提供前两者，不能无条件宣称第三者。若检测到用户、IDE、hook 或其他进程并发修改相同文件，返回：

```ts
interface DiffProvenance {
  confidence: "isolated" | "best_effort" | "conflicted" | "unknown";
  baselineDirty: boolean;
  concurrentChangesDetected: boolean;
  notes: string[];
}
```

UI 必须显示“工作区全部变化”或“本 Session 期间观察到的变化”，不能笼统称为“Agent 修改”。删除、重置或覆盖 dirty baseline 文件属于高风险操作。

### 13.2 推荐的安全升级

Phase 1B 应优先引入 Session worktree：

- 手机创建写任务时默认新建 `flyx/<session-short-id>` 分支和 worktree；
- Agent 在隔离 worktree 工作；
- 任务完成后手机查看 Diff；
- 合并、rebase、删除 worktree 属于高风险动作，首期仅桌面完成；
- 同仓库多 Agent 并发不会相互污染。

### 13.3 不应将 Git Diff 当作唯一审计

Agent 可能：

- 执行网络请求；
- 修改未跟踪/忽略文件；
- 运行数据库迁移；
- 改变外部系统；
- 修改 Git 配置。

因此 Approval 和 Tool Timeline 仍需独立保存。

### 13.4 Phase 1C 精确 Checkpoint 与 Revert

Worktree 解决并发隔离，Checkpoint 解决每 Turn 精确 Diff 和可审计回退，两者不互相替代。

Git VCS Driver 提供可选 checkpoint capability：

```ts
interface VcsCheckpointOps {
  capture(input: { workspaceId: WorkspaceId; checkpointRef: string }): Promise<void>;
  exists(input: { workspaceId: WorkspaceId; checkpointRef: string }): Promise<boolean>;
  diff(input: { fromRef: string; toRef: string; ignoreWhitespace?: boolean }): Promise<DiffRef>;
  restore(input: { workspaceId: WorkspaceId; checkpointRef: string }): Promise<void>;
  delete(input: { checkpointRefs: string[] }): Promise<void>;
}
```

Git 实现使用 Flyx 隐藏 refs，例如：

```text
refs/flyx/checkpoints/{sessionId}/0
refs/flyx/checkpoints/{sessionId}/1
refs/flyx/checkpoints/{sessionId}/2
```

流程：

1. Session 首个 Turn 前捕获 turn-0 baseline，包含 working tree 和 staging 状态；
2. 每个 Turn 终态后由 CheckpointReactor 捕获新 checkpoint；
3. `checkpoint.getTurnDiff(n)` 比较 `n-1 -> n`；
4. `checkpoint.getSessionDiff()` 比较 `0 -> latest`；
5. `checkpoint.revertPreview(n)` 显示 Workspace、Timeline 和 Provider Conversation 将受影响的内容；
6. `checkpoint.revert(n)` 是高风险命令，必须恢复 workspace/staging，并 fork/rewind Provider conversation；
7. n 之后的 Turn 不物理删除，标记为 superseded 并更换 Timeline epoch；
8. Workspace 恢复成功但 Provider rewind 失败时进入 `revert_partial_failure`，禁止伪装原子成功。

Checkpoint metadata 写入 orchestration projection，Git refs 由 VCS Driver 持有。CheckpointReactor 使用 DrainableWorker，Host 关机前排空已提交的 checkpoint intent。

### 13.5 RepositoryIdentity 仅用于跨 Host 分组

`repoIdentity` 是 remote URL 等信息规范化后的 best-effort 逻辑身份，只用于 UI 分组、搜索和关联提示，绝不用于 RPC 路由、Workspace 授权或文件访问。两个 Host 上具有相同 RepositoryIdentity 的 clone 仍是两个 Workspace。

## 14. 多 Agent 协作的演进设计

虽然 v1 只做用户分别控制 Codex/Claude，但模型需要避免未来推倒重来。

### 14.1 v2 新增 Task

```ts
interface Task {
  id: TaskId;
  objective: string;
  workspaceId: WorkspaceId;
  status: "planned" | "running" | "blocked" | "review" | "completed";
  coordinatorSessionId?: SessionId;
  memberSessionIds: SessionId[];
}
```

Task 是用户目标，Session 是某个 Agent 的执行对话。一个 Task 可有多个 Session。

### 14.2 协作方式

优先支持显式、可审计的协作：

1. 用户创建主任务；
2. 主 Agent 提议子任务；
3. 用户或策略批准后创建子 Session；
4. 子 Agent 在独立 worktree 执行；
5. 结果以 Artifact/Handoff 返回；
6. 主 Agent 汇总，而不是直接读取另一个 Agent 的终端；
7. 合并变更前进行冲突和测试检查。

### 14.3 Handoff

```ts
interface HandoffArtifact {
  id: ArtifactId;
  fromSessionId: SessionId;
  toSessionId?: SessionId;
  summary: string;
  decisions: string[];
  changedFiles: string[];
  verification: VerificationResult[];
  openQuestions: string[];
  diffRef?: string;
}
```

这吸收 Paseo 的协作房间/交接思想，但不把所有 Agent 放进无结构群聊。

### 14.4 调度策略

未来 Coordinator 只能通过受控命令创建子任务：

- 最大 Agent 并发；
- 最大子任务深度；
- token/费用预算；
- workspace/worktree 隔离；
- Provider 白名单；
- 高风险操作仍回到用户审批；
- 子 Agent 不能自动扩大权限。

## 15. 数据库建议

SQLite 主要表：

```text
hosts                    # 本机仅一条，保留未来迁移能力
advertised_endpoints
runtimes
provider_instances
agent_profiles
workspaces
sessions
turns
session_events
timeline_items
command_receipts
approvals
managed_provider_processes
checkpoints
client_devices
auth_sessions
pairing_grants
artifacts
schema_migrations
```

关键约束：

- `session_events UNIQUE(session_id, sequence)`；
- `timeline_items UNIQUE(session_id, epoch, item_id)`，并对 `(session_id, epoch, source_sequence_end)` 建索引；
- `command_receipts PRIMARY KEY(client_id, command_id)`；
- `command_receipts` 保存 `request_hash`，同 ID 异请求必须拒绝；
- `approvals` 更新使用 version；
- `turns` 同一 Session 最多一条 active Turn，通过事务内部分唯一约束或 session lock 保证；
- `managed_provider_processes` 保存 PID 和 process start identity，不以 PID 单独判定所有权；
- `provider_instances UNIQUE(host_id, provider, instance_key)`，配置带 generation 和 schema version；
- `advertised_endpoints UNIQUE(host_id, key)`，URL 可变但 provider key 稳定；
- `checkpoints UNIQUE(session_id, turn_count)`，记录 ref、capture status、failure 和 timestamps；
- `sessions.provider_native_handle` 加密或受限存储，带 `adapter_schema_version`；
- Runtime 唯一键 `(host_id, provider, instance_key)`；
- pairing grant 只存 secret hash；
- auth session 可撤销并记录 `last_seen_at`；
- 删除客户端不级联删除 Session 历史；
- Session/事件使用软删除或归档。

事件保留建议：

- 结构化 Session 事件：长期保存，用户可配置；
- token delta：投影为完整消息且所有活动 cursor 越过安全水位后清理；
- Timeline 投影：与 Session 历史同期保留，可从源事件重建；
- 原始 Provider stdout/stderr：默认不落盘；用户显式开启诊断模式后按时间和容量双限额滚动；
- Diff cache：可重建，按容量 LRU；
- 附件：Session 完成后默认保留 30 天或由用户配置。

## 16. API 错误模型

统一错误：

```ts
interface RpcError {
  code:
    | "UNAUTHENTICATED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "INVALID_ARGUMENT"
    | "HOST_OFFLINE"
    | "HOST_NOT_READY"
    | "ENDPOINT_UNREACHABLE"
    | "AUTH_BLOCKED"
    | "RUNTIME_UNAVAILABLE"
    | "SESSION_BUSY"
    | "COMMAND_ID_REUSED"
    | "COMMAND_OUTCOME_UNKNOWN"
    | "ALREADY_RESOLVED"
    | "CURSOR_EXPIRED"
    | "RESYNC_REQUIRED"
    | "PROTOCOL_INCOMPATIBLE"
    | "PROVIDER_ERROR"
    | "REVERT_PARTIAL_FAILURE"
    | "INTERNAL";
  message: string;
  retryable: boolean;
  details?: unknown;
  traceId: string;
}
```

Provider 原始错误只放在受控 `details`，客户端面向用户展示归一化、可行动的错误。

## 17. 可观测性

Host 本地指标：

- Host 启动时间；
- Runtime probe 状态和版本；
- 活跃 Session/Turn 数；
- Provider 启动与首 token 延迟；
- 事件写入延迟；
- 每连接发送队列水位；
- reconnect/resync 次数；
- approval 等待时间；
- Provider 非零退出；
- SQLite 大小和事件压缩情况。

日志关联字段：

```text
trace_id, host_id, client_id, session_id, turn_id,
runtime_id, provider, command_id, event_sequence
```

云端遥测默认只收集匿名运行指标，不上传 Prompt、路径、命令、Diff 或输出。

### 17.1 Phase 2.1 进程树资源遥测

资源遥测是可选诊断能力，不是 Session 正确性来源。推荐使用独立 Rust sidecar 读取操作系统进程计数器，避免周期性 spawn `ps`/PowerShell，也避免将 native ABI 加载进 Host 进程。

至少采集：

- PID、PPID、process start time、命令摘要；
- Host、Provider 及其后代进程树；
- CPU、RSS/虚拟内存、累计 I/O 计数器；
- 采样时间、平台 I/O 语义和数据可用性。

约束：

- process identity 使用 `(pid, startTime)`，不仅使用 PID；
- sidecar 崩溃不得影响 Host，Host 可监督和重启它；
- 有界历史默认只保留内存，不持续写 SQLite；
- 只有诊断页存在活动订阅时才开启高频 streaming；
- 遥测不进行 syscall tracing，不声称精确看到每一次文件或网络副作用。

### 17.2 Phase 2.1 Host 版本协调与安全自更新

Host descriptor 广告：

```ts
interface HostUpdateCapabilities {
  mode?: "service" | "respawn" | "desktop_managed";
  progress: boolean;
  currentVersion: string;
  minClientProtocol: number;
  maxClientProtocol: number;
}
```

客户端检测版本偏移后根据 capability 显示精确操作，不向旧 Host 发送未知 update RPC。自更新只接受精确版本，拒绝 `latest` 等漂移 tag。

安全流程：

1. 全局安装锁保证同时只有一个更新；
2. 安装到版本隔离的 candidate runtime；
3. 使用当前可执行环境运行 candidate `--version` 和协议预检；
4. 安装、预检或版本校验失败时保持当前 Host 运行；
5. 预检成功后根据 service/respawn 进行延迟交接，先将 ACK 发给客户端；
6. 客户端进入 `resuming`，由既有 Connection Supervisor 重连，只在新 Host 报告 ready 且版本匹配后完成；
7. desktop-managed Host 不自行 respawn 第二个进程，而是要求更新对应 Desktop 管理器。

Host 强制升级只用于已知安全红线；普通版本偏移尽量保留只读查看和安全 interrupt。

## 18. 第二阶段：Android-first 原生手机客户端方案

### 18.1 阶段目标

第二阶段不是简单地把 PWA 包进 WebView，而是先把已经验证的远控能力变成可靠的 Android 随身控制台。工程仍使用 React Native 共享架构，iOS 保留扩展性：

- 用户不打开 App 也能及时知道 Agent 正在等待；
- 点击通知可直接进入对应审批、问题或任务结果；
- App 被系统挂起、杀死或网络切换后能够正确恢复；
- 手机丢失时可撤销，App 回到前台时可要求生物识别；
- 弱网下可以查看最近状态并安全地提交幂等操作；
- Android 行为首先达到生产可用；iOS 接口、capability 和工程骨架保持可编译，但未实现能力显式返回 unavailable。

第二阶段不改变以下基础边界：

- Agent 仍只在 Flyx Host 执行；
- Host SQLite 仍是 Session 事实来源；
- App 不持有 Codex、Claude 的 Provider 凭证；
- App 不依靠永久 WebSocket 实现后台运行；
- 推送服务不携带 Prompt、命令、Diff 或审批正文；
- App 不获得任意终端和任意文件访问能力。

### 18.2 第二阶段产品范围

#### P0：Android 必须交付

- Android 原生 App；
- 扫码配对、设备确认和 Host 指纹展示；
- 多 Host 切换；
- 待处理、任务、新任务、设备四个一级入口；
- Session 结构化时间线；
- Approval 和 Agent Question 响应；
- follow-up、interrupt、retry、resume；
- Git 变更摘要和按文件 Diff；
- FCM 推送；
- 通知深链；
- 生物识别/设备密码解锁；
- 安全凭证存储；
- App 前后台与冷启动恢复；
- 离线只读缓存和待发送命令；
- 配对设备和 session 撤销；
- 崩溃报告和非敏感运行指标；
- Google Play Internal Testing 发布链路。

#### iOS 预留范围（不作为第二阶段交付项）

- 同一 React Native workspace 中保留 iOS target，CI 执行基础编译检查；
- 共用 protocol、client-core、domain store、页面模型与 design token；
- `SecureStore`、`PushAdapter`、`BiometricGate`、`BackgroundTask`等 iOS 实现可以是显式 stub；
- stub 必须返回 `unsupported/unavailable`，不得伪装成功或降级为不安全存储；
- UI 通过 platform capability 隐藏推送注册、生物识别等未实现功能；
- 首期不建设 APNs、TestFlight、iOS 后台任务和上架链路。

#### P1：Beta 后补充

- 图片、相册和文件附件；
- 分享扩展：从其他 App 分享文本/文件到 Flyx 新任务；
- Android App Shortcuts（Siri Shortcuts 留待 iOS 阶段）；
- 小组件显示运行中和待处理数量；
- 多窗口/平板适配；
- Diff 内搜索和行级评论草稿；
- 通知快捷动作（只允许低风险“拒绝”和“稍后提醒”）；
- App 内诊断包和连接测试。

#### 暂不支持

- 通知栏直接批准高风险命令；
- App 后台持续保持 Agent token stream；
- 完整 PTY 终端；
- 手机本地 Git clone、构建或测试；
- 手机本地运行 Coding Agent；
- App 内持久创建 `allow_always` 权限规则；
- 依赖 WebView 加载远端 PWA 作为主界面。

### 18.3 原生 App 信息架构

```text
App Root
├── Security Gate
├── Onboarding / Pairing
└── Main Tabs
    ├── 待处理
    │   ├── Approval
    │   ├── Agent Question
    │   ├── Failed / Interrupted
    │   └── Completed Review
    ├── 任务
    │   ├── Running
    │   ├── Recent
    │   ├── Session Detail
    │   └── Diff Viewer
    ├── 新任务
    │   ├── Host
    │   ├── Workspace
    │   ├── Agent/Runtime
    │   └── Permission Mode
    └── 设备
        ├── Host Detail
        ├── Runtime Health
        ├── Connections
        └── Security & Diagnostics
```

导航原则：

- 通知深链必须先经过 Security Gate，再进入目标页面；
- 目标已解决时显示最终状态，不返回失效错误页；
- Host 离线时保留缓存内容并显示数据时间；
- 用户切换 Host 不重置其他 Host 的运行状态和未读计数；
- 手机返回手势不能误取消任务或审批。

### 18.4 App 技术架构

```text
┌───────────────────────────────────────────────────────┐
│ React Native UI                                       │
│ Screens │ Navigation │ Design System │ Diff Renderer  │
├───────────────────────────────────────────────────────┤
│ Shared Client Core                                    │
│ Domain Store │ RPC Client │ Event Reducer             │
│ Command Outbox │ Snapshot Cache │ Capability Gating    │
├───────────────────────────────────────────────────────┤
│ Native Platform Adapters                              │
│ Secure Store │ Biometrics │ Push │ Network │ AppState │
│ Background Fetch │ Camera/QR │ Deep Link │ Share      │
├───────────────────────────────────────────────────────┤
│ SQLite Cache │ FCM (APNs future) │ WSS/HTTPS │ OS Key Store │
└───────────────────────────────────────────────────────┘
```

推荐包结构：

```text
apps/
├── mobile-web/                 # Stage 1
└── mobile/                     # Stage 2 React Native
packages/
├── protocol/                   # Schema/codegen
├── client-core/                # 平台无关
├── client-storage-contract/    # 存储接口
├── client-crypto/              # 会话密钥封装
├── domain/                     # reducer/selectors
├── design-tokens/
└── test-fixtures/
```

`client-core` 禁止直接依赖：

- React Native；
- DOM、LocalStorage、IndexedDB；
- Expo SecureStore；
- FCM（iOS 实现后接入 APNs）；
- AppState；
- 具体导航框架。

这些能力通过接口注入：

```ts
interface ClientPlatform {
  capabilities: PlatformCapabilities;
  secureStore: SecureStore;
  cacheStore: CacheStore;
  networkMonitor: NetworkMonitor;
  lifecycle: AppLifecycle;
  push: PushAdapter;
  clock: Clock;
  random: SecureRandom;
}

interface PlatformCapabilities {
  secureCredentialStorage: boolean;
  biometricGate: boolean;
  pushNotifications: boolean;
  backgroundRefresh: boolean;
  cameraQrScan: boolean;
  shareExtension: boolean;
}
```

Android adapter 是 Phase 2 的生产实现。iOS adapter 首期使用显式 stub，遵循以下规则：

- capability 为 `false` 时，UI 不展示或禁用相关入口；
- 安全存储不得退化为 AsyncStorage/明文文件；
- push 和后台任务 stub 不得伪造注册成功；
- 缺少 `secureCredentialStorage` 时禁止真实配对，只允许 fixture/demo 模式；
- 共享业务层禁止出现散落的 `Platform.OS === "android"` 判断，必须通过 capability 或 adapter 调用。

这样的“保留 iOS”是保留可扩展边界，而不是维护一套半完成的 iOS 业务实现。

### 18.5 本地状态与离线模型

App 本地保存两类数据：

#### 安全数据

当前 Android 实现存放于 Android Keystore 支持的安全存储；后续 iOS 实现使用 Keychain：

- client private key；
- Host 配对凭证或 refresh secret；
- Relay E2EE key material；
- 本地数据库加密密钥；
- device binding 信息。

不得存入 AsyncStorage、普通 SQLite、日志或崩溃上下文。

#### 可缓存领域数据

存放于加密 SQLite：

- Host 和 Runtime 快照；
- Session 摘要；
- 最近 Session events；
- 待处理索引；
- Diff 元数据与有限文本缓存；
- command outbox；
- 每个 Session 的 lastAppliedSequence；
- push attention id 的处理状态。

默认不缓存：

- 原始 Provider stdout/stderr；
- 完整环境变量；
- 大型二进制附件；
- 已显示后无必要保留的审批命令全文。

App 离线时：

- 可查看带“最后更新于”标识的缓存；
- 可编辑新任务和 follow-up 草稿；
- `interrupt`、`approval.respond` 等时效性命令必须明确显示“等待连接”；
- 高风险 approval 不允许纯离线批准；
- 恢复在线后先同步最终状态，再决定是否发送 outbox；
- 已过期或已解决命令从 outbox 移除并向用户说明；
- 所有写操作复用原 `commandId`，不得自动生成新命令造成重复执行。

### 18.5.1 Timeline Replica 与乐观消息

Android 本地 Timeline 是 Host 的非权威 replica，用于立即显示和离线阅读，不得自行推断远端删除、审批结果或 Turn 完成。

Client Core 为每个 Session 保存：

```ts
interface TimelineReplicaState {
  sessionId: SessionId;
  epoch: string;
  lastSourceSequence: number;
  startCursor?: string;
  endCursor?: string;
  itemsById: Record<string, TimelineItem>;
  orderedItemIds: string[];
  syncState: "stale" | "catching_up" | "ready" | "resync_required";
}
```

合并规则：

- 发送 prompt 时用 `clientMessageId` 插入稳定的 optimistic slot；
- Host canonical user item 到达后原位替换该 slot，不把消息移到 Timeline 尾部；
- 权威投影页覆盖重叠 `sourceSequenceRanges`，live delta 只更新未被权威页覆盖的部分；
- epoch 不匹配时整个 replica 失效，不尝试跨 epoch 合并；
- pending approval/question 每次前台恢复都与 Host snapshot 对账；
- 本地缓存可展示旧内容，但必须标记更新时间和 `stale`，不允许对旧 pending 直接做高风险操作。

### 18.6 推送与 Attention Service

原生推送是第二阶段最重要的新增基础设施。建议增加轻量 `Flyx Attention Service`，但它不是 Session 状态中心。

```text
Host ── encrypted attention ──> Flyx Attention Service
                                  │
                                  ├── APNs
                                  └── FCM
                                         │
                                         ▼
                                     Flyx App
                                         │
                                  WSS/HTTPS 拉取真实状态
```

推送流程：

1. Android App 向 FCM 获取 push token；iOS 后续使用同一 `PushAdapter` 接入 APNs；
2. App 通过已配对安全通道把 push registration 绑定到 `clientId`；
3. Host 遇到 attention event；
4. Host 向 Attention Service 发送最小 opaque envelope；
5. Service 投递无敏感正文的 push；
6. App 收到后连接对应 Host；
7. App 使用 `attentionId` 获取并同步真实事件；
8. App 本地生成可读通知内容。

服务端可见字段限制为：

```ts
interface PushEnvelope {
  clientRoutingId: string;
  attentionId: string;
  category:
    | "approval"
    | "question"
    | "completed"
    | "failed"
    | "host_status";
  collapseKey: string;
  expiresAt: string;
}
```

不得出现：

- 仓库名和本地路径；
- Prompt 或 Agent 回答；
- shell command；
- Diff；
- 用户名、分支名、Issue 内容；
- Provider token；
- 可用于直接控制 Host 的凭证。

通知策略：

- 同一 Session 的 token 活动不推送；
- 同一 pending item 使用 collapse key 去重；
- approval/question 使用高优先级但遵守平台限额；
- completed/failed 可按用户设置合并；
- Host 恢复在线不默认推送；
- 夜间免打扰只延迟非审批类通知；
- push 仅是提示，状态以 Host 同步结果为准。

### 18.7 通知深链

建议统一深链：

```text
flyx://host/{hostId}/session/{sessionId}
flyx://host/{hostId}/session/{sessionId}/approval/{approvalId}
flyx://host/{hostId}/session/{sessionId}/question/{questionId}
flyx://host/{hostId}/session/{sessionId}/diff
```

处理顺序：

1. 校验 URL 结构和 ID 格式；
2. 查找本地已配对 Host；
3. 经过 Security Gate；
4. 连接 Host 并同步；
5. 检查资源是否仍存在和是否有 scope；
6. 导航到目标或最终状态；
7. 未配对时只进入安全引导，不自动接受 URL 中的任何授权。

Universal Link/App Link 只用于打开 App，不能携带长期认证 secret。

### 18.8 前后台与冷启动恢复

Android 可能随时挂起或终止 App，不能假设后台 WebSocket 存活。这一生命周期合约保持平台无关，后续 iOS 适配器必须遵循同样的恢复语义。

#### 进入后台

- 立即持久化 lastAppliedSequence、未提交草稿和 outbox；
- 停止 token 级 UI 更新；
- 可在系统允许的短时间内完成已发出的幂等命令；
- 主动降低或关闭非必要订阅；
- 不因为 App 后台而改变 Host Session 状态。

#### 返回前台

1. 检查本地安全锁；
2. 读取网络状态；
3. 由 Connection Supervisor 选择最优 ConnectionTarget 和 AdvertisedEndpoint；
4. 重新认证；
5. 获取 Host snapshot；
6. 以 sequence 补同步活跃 Session；
7. reconcile outbox；
8. 更新通知 badge；
9. 恢复可见页面订阅。

#### 冷启动

- 先展示加密缓存骨架和更新时间；
- 并行恢复凭证、解析深链、连接 Host；
- 深链目标优先同步；
- 超时后提供“重试”“切换接入方式”“查看诊断”；
- 禁止用无限 loading 隐藏 Host 离线。

### 18.9 生物识别与设备安全

建议安全等级：

| 操作 | 默认要求 |
|---|---|
| 打开普通任务列表 | App 超过可配置锁定时间后生物识别 |
| 查看 Diff/命令详情 | App 已解锁 |
| 允许低/中风险操作 | App 已解锁 |
| 允许高/关键风险操作 | 近期生物识别 + 二次确认 |
| 撤销其他设备/导出诊断 | 近期生物识别 |
| 拒绝审批、停止任务 | App 已解锁，不额外提高摩擦 |

安全要求：

- iOS 后续实现使用 Keychain access control，首期 stub 不保存任何真实凭证；
- Android 私钥尽量不可导出并由 Keystore 保护；
- 检测设备安全能力，但不把 root/jailbreak 检测当绝对安全边界；
- App 切后台时隐藏 app switcher 敏感预览；
- 支持用户设置 立即、1 分钟、5 分钟锁定；
- 生物识别变化或设备密码移除后要求重新验证配对；
- 不提供“忘记 PIN 后云端恢复私钥”；重新配对更安全。

### 18.10 Diff 与长内容移动端优化

移动端不能直接复用桌面双栏 Diff：

- 手机默认 unified diff；
- 逐文件加载；
- 长行横向滚动，不强制错误折行；
- 支持“仅变更行/带上下文”切换；
- 文件列表显示 `+/-`、二进制、重命名；
- 超过阈值时 Host 返回摘要和分页 token；
- Markdown 和代码使用可控、离线的渲染器；
- 禁止渲染 Agent 返回的任意 HTML；
- 链接跳转前显示目标域名；
- 文件路径复制需用户主动触发。

性能预算建议：

- 首屏缓存内容 500 ms 内可见；
- 前台重连后 2 秒内显示 Host 状态；
- 1000 条事件的增量 reducer 在中端机低于 100 ms；
- 单次 Diff 页面内存目标低于 100 MB；
- 活跃 token UI 更新限制为每秒 10–20 次；
- 长 Session 使用虚拟列表和消息压缩快照。

### 18.11 原生客户端与 Host 的新增协议

第二阶段尽量不修改领域 RPC，只新增平台能力：

```text
client.registerPushTarget
client.unregisterPushTarget
client.updateCapabilities
attention.ack
attention.listPending
session.getCompactSnapshot
access.rotateClientCredential
```

客户端 capability 示例：

```ts
interface ClientCapabilities {
  platform: "ios" | "android" | "web";
  appVersion: string;
  protocolVersion: number;
  push: boolean;
  biometricGate: boolean;
  encryptedCache: boolean;
  backgroundRefresh: boolean;
  supportedContentBlocks: string[];
}
```

Host 不应因为客户端支持 push 就减少事件持久化；push 丢失是正常情况。

### 18.12 多 Host 连接策略

原生 App 可配对多个 Host，但不应长期保持所有 WSS：

- 前台当前 Host 保持完整订阅；
- 有运行任务或 pending approval 的其他 Host 保持轻量状态订阅，或依赖 push；
- 后台不保证任何 WSS；
- 同时活动连接默认上限 2，可配置；
- 所有 Host 都保存独立 sequence 和 outbox；
- AdvertisedEndpoint 选择按用户显式偏好、默认标记、最近成功、网络可达性和平台兼容性排序；
- 自动切换 LAN/Tailscale/Relay endpoint 时 Host 身份必须一致；
- TLS/Host key 不匹配时 fail closed，不静默连接“同名设备”。

### 18.13 App 发布与升级

渠道：

1. 开发期：Expo Development Build；
2. 内测：Google Play Internal Testing；
3. 封闭 Beta：分批邀请和崩溃率门禁；
4. 公开发布：App Store + Google Play；
5. 紧急协议问题：服务端 capability gate，不依赖立即过审。

版本策略：

- `appVersion` 与 `protocolVersion` 分离；
- Host 返回 `minClientProtocol`、`maxClientProtocol`；
- 客户端支持至少 N-1 Host minor protocol；
- 破坏性变更必须 capability 协商或新 method；
- App 过旧时允许只读查看和安全 interrupt，尽量不完全锁死；
- 安全漏洞可通过 `minimumSafeAppVersion` 强制升级。

### 18.14 第二阶段数据指标

产品指标：

- 推送送达至用户打开的 P50/P95；
- approval 请求至响应时长；
- 从通知进入目标页面成功率；
- Session 创建成功率；
- App 前台重连成功率和耗时；
- 断线补同步成功率；
- Diff 打开率和任务完成后 follow-up 率；
- 每周活跃 Host/Client 配对数；
- 被撤销设备数；
- 用户主动关闭高风险远控的比例。

质量红线：

- 任何重复 Turn/重复审批执行：0；
- 客户端把旧审批显示为 pending：低于 0.1%；
- push payload 敏感信息泄漏：0；
- crash-free sessions：不低于 99.5%；
- 前台重连成功率：不低于 99%；
- 深链目标正确率：不低于 99.9%；
- 冷启动后错误 Host 身份连接：0。

### 18.15 第二阶段验收场景

必须通过以下端到端场景：

1. App 被系统杀死后收到 approval 推送，生物识别后进入正确审批，批准一次且仅一次。
2. 用户同时收到两个 Host 的通知，分别进入正确 Session。
3. 从 Wi-Fi 切换蜂窝网络，任务继续执行，App 补齐事件且不重复消息。
4. push 丢失时，用户打开 App 仍能通过 snapshot 找到 pending item。
5. approval 在桌面已处理，手机点击旧通知后显示最终结果。
6. 手机离线时点击批准，App 不伪装成功；恢复后先同步并正确处置 outbox。
7. 手机丢失后从 Host 撤销，旧 App 无法换取新 WSS ticket。
8. Host 从 Direct 切到 Relay，App 校验为同一 Host 后恢复。
9. 查看含超长行、中文、二进制和超大文件的 Diff 不崩溃。
10. Host、App 协议版本相差一个 minor 时正常降级。
11. 生物识别信息变化后敏感凭证不可直接使用。
12. 通知服务数据库和 FCM payload 均不含敏感正文。
13. iOS target 在 CI 中通过基础编译；未实现适配器只能显式返回 unavailable。

## 19. 交付阶段

### Phase 0：协议与 Provider Spike（2–3 周）

目标：证明 Codex、Claude 均能稳定输出统一事件。

- 建立 `ProviderAdapter` 契约；
- 定义 Provider Native Handle、Managed Process Registry 和 Timeline Projection 契约；
- Codex/Claude 版本探测；
- 新建、流式输出、interrupt、resume；
- 审批能力实验；
- 保存原始 fixture，做解析回归测试；
- 决定每个 Provider 的首选结构化接入方式。
- Codex 优先验证 app-server 生成 Schema、审批和进程恢复；
- Claude 比较 stream-json、内建 Remote Control 和 PTY 后备；
- 建立 command receipt 崩溃点测试工具；
- 验证 Web/PWA 固定 origin、Tailscale HTTPS 与 host key 绑定。

退出标准：

- 两个 Provider 各完成 20 次真实任务；
- 文本、工具、完成、失败均可归一化；
- canonical user message、assistant delta、reasoning、tool lifecycle、approval/question 均可投影为稳定 Timeline Item；
- 不依赖脆弱 ANSI 文本解析作为主路径。
- approval 等待至少 1 小时后仍可正确响应；
- 明确记录每个 Provider 对 conversation resume、process reattach、Host restart recovery 的支持矩阵；
- 在 Provider 已接收命令前后分别杀死 Host，重启后不产生自动重复 Turn；
- Provider 已产生副作用但 Flyx 未收到完成事件时，系统显示 `outcome_unknown` 而非自动重试；
- 旧一版和当前版 Provider fixture 均通过，未知事件不会导致错误授权或错误完成；
- PWA 清站点数据、切换 origin、Host key 不匹配均按设计 fail closed。
- interrupt 超时时 Flyx 仍显示 Turn running，只有 Provider ACK/终态事件后才显示 cancelled；
- Host 能识别重用 PID，不会终止非 Flyx 进程。

### Phase 1A：单 Provider Host + 手机 Web/PWA 纵向闭环（3–4 周）

- Rust Host；
- SQLite；
- 单个优先 Provider 的 Runtime discovery；
- Session/Turn/Event；
- Timeline projector 与权威分页；
- Managed Process Registry；
- HTTPS/WSS；
- React 手机 Web/PWA；
- 平台无关 Client Core；
- 局域网扫码配对；
- 任务创建、观察、interrupt；
- 页面刷新与断线补同步。

退出标准：

- 手机页面刷新或离线 10 分钟后可恢复完整时间线；
- 重复发送命令不会创建重复 Turn；
- Host 在客户端断线后继续执行。
- live delta 与权威 Timeline 补齐后不重复文本、Tool Item 或用户消息；
- 手机断网期间产生超过一页的 Timeline，恢复后能连续翻页到 `hasNewer = false`；
- 关闭手机页面不关闭或归档 Host Session。

### Phase 1B：双 Provider Web MVP、事务引擎、审批、Diff、Tailscale（5–8 周）

- 第二个 Provider Adapter；
- 事务化 Orchestration Engine 与纯 decider；
- ProviderCommandReactor、ProviderRuntimeIngestion、TimelineProjectionWorker 及 drain；
- Provider Instance/Adapter Registry 与独立 child scope；
- 统一 Approval；
- Agent question；
- Git baseline/Diff；
- Tailscale HTTPS/WSS；
- AdvertisedEndpoint、endpoint provider 与选择策略；
- 单一 Connection Supervisor 与独立 domain sync 状态；
- Android DPoP/PWA browser-session cookie/WSS ticket 鉴权契约；
- 配对/会话撤销；
- 安全审计。

退出标准：

- 用户可在外网完成一次完整“发起—审批—补充指令—检查 Diff”；
- Codex 和 Claude 均能展示真实文本、reasoning summary（若支持）、tool lifecycle、审批/提问和最终 Turn 状态；
- idle Session 关闭 runtime 后可使用原 Provider Native Handle 恢复并发送 follow-up；
- interrupt 未被 Provider 确认时不接受同 Session 新 Turn；
- Session 归档在多客户端一致可见，单端关闭视图不触发归档；
- 手机丢失模拟下可撤销访问；
- 无公网入站端口。
- dirty workspace 和并发修改时 Diff 明确标注 provenance，不错误归因给 Agent。
- Event、Projection 和 Receipt 事务一致，Provider 调用只发生在 commit 之后；
- 离线不消耗 retry，domain subscription 错误不会拆掉健康 transport；
- LAN/Tailscale endpoint 变化不改变 Host 身份，自动切换时验证 host key。

### Phase 1C：精确 Checkpoint、Revert 与运行时加固（3–5 周）

- Git hidden-ref checkpoint capability；
- turn-0 baseline 和每 Turn 终态 checkpoint；
- 单 Turn/整 Session 精确 Diff；
- revert preview；
- Workspace/staging 恢复；
- Provider conversation fork/rewind；
- Timeline epoch 更换和后续 Turn supersede；
- CheckpointReactor DrainableWorker；
- Host readiness/draining 生命周期。

退出标准：

- 可精确查看任意 Turn Diff 和整个 Session Diff；
- revert 前必须看到 Workspace/Provider/Timeline 影响预览；
- Workspace 与 Provider 都成功时才显示完整 revert 成功；
- 部分失败进入明确 `REVERT_PARTIAL_FAILURE`，保留可恢复诊断；
- Host 正常关机排空已提交 worker，不丢失 Provider 终态和 checkpoint intent。

### Phase 2：Android 原生手机客户端（5–8 周）

- React Native + Expo Development Build；
- 加密 SQLite 和 Secure Store；
- Security Gate 与生物识别；
- FCM 和 Attention Service；
- 通知深链；
- 前后台、冷启动和 outbox 恢复；
- 多 Host；
- 原生 Diff 性能优化；
- Google Play 内测；
- iOS target、平台 capability 和空适配器保持可编译。

退出标准：

- 第 18.15 节端到端场景全部通过；
- 推送不包含敏感正文；
- crash-free sessions 不低于 99.5%；
- 重连不产生重复 Turn 或重复审批；
- 丢失手机可被远程撤销。

### Phase 2.1：E2EE Relay、Host 运维与原生客户端公开 Beta（4–6 周）

- Relay 路由；
- E2EE transport；
- NAT 场景；
- Host 自动重连；
- 推送 attention signal；
- 限流、防滥用、版本升级；
- Host 精确版本 self-update、candidate preflight 和安全交接；
- 可选 Rust 资源遥测 sidecar 与诊断订阅；
- 外部渗透测试。

### Phase 3：多端与多 Agent

- Tauri Desktop；
- OpenCode Adapter；
- Agent Profile；
- Task/Subtask/Handoff；
- worktree 隔离；
- 多 Agent 协调器。

## 20. 测试策略

### 20.1 Adapter 契约测试

每个 Provider Adapter 必须通过相同测试：

- probe；
- create；
- text streaming；
- structured tool call；
- approval；
- question（若 capability 支持）；
- interrupt；
- interrupt ACK/reject/timeout/process-exit；
- resume conversation；
- close runtime 后 ensureLoaded；
- reattach running process（若 capability 支持）；
- history hydration 与 canonical user message 去重；
- Provider Native Handle 版本迁移；
- non-zero exit；
- malformed frame；
- unknown event；
- Provider upgrade fixture。

### 20.2 协议测试

- Schema encode/decode；
- 新旧客户端兼容；
- unknown optional field；
- unknown event 安全忽略；
- required capability 不满足；
- sequence gap；
- duplicate event；
- duplicate command；
- cursor expired；
- slow subscriber 背压。
- live delta 与投影页重叠；
- tool lifecycle 跨多个 sequence 投影为单 Item；
- optimistic user message 被 canonical item 原位替换；
- Timeline epoch 变更；
- 多页 after catch-up 直到 `hasNewer = false`；
- 权威页不把全量 assistant 文本追加到 live delta 后；
- 新增每个 RPC method 时必须同时出现在 required-scope map；
- AdvertisedEndpoint 选择与 hosted HTTPS compatibility；
- buffered assistant 在 approval/question 前 flush；

### 20.3 故障注入

- 手机在 token stream 中断网；
- Host 在写 event 前后崩溃；
- Provider 子进程孤儿；
- PID 被无关进程重用；
- Provider 已接受 interrupt 但 Host 在终态落盘前崩溃；
- Provider 拒绝或超时 interrupt；
- Host 重启后 Provider 仍在运行但 live event 缺失；
- Provider 历史包含已在 Flyx Timeline 中的用户消息；
- SQLite busy/磁盘满；
- Relay 断开；
- Tailscale 地址变化；
- approval 同时被两个客户端响应；
- Host 时间漂移；
- Provider 输出超大行；
- Diff 超大或二进制；
- 工作区被移动/删除；
- Agent 尝试路径逃逸。
- Event append 成功但 Projection/Receipt 写入前注入失败；
- 事务 commit 后、Provider Reactor 执行前 Host 崩溃；
- worker item 成功/失败/取消时 outstanding 均归零；
- Host draining 期间 Provider terminal event 到达；
- Wi-Fi/LAN endpoint 变化后切换到同 Host Tailscale endpoint；
- domain subscription 失败而 transport 仍健康；
- checkpoint 捕获失败、ref 缺失和 revert partial failure；

### 20.4 安全测试

- 配对码重放；
- WSS ticket 重放；
- session 撤销后复用；
- scope 越权；
- 任意路径；
- symlink escape；
- commandId 碰撞；
- 日志 secret 扫描；
- Relay 明文检查；
- 降级攻击；
- push payload 敏感信息检查。
- DPoP `jti` 重放、method/URL/token hash 不匹配；
- DPoP 失败时不降级为 bearer；
- requested scopes 不是 pairing grant 子集；
- PWA browser-session CSRF/origin 绕过；
- browser cookie 不向 JavaScript 暴露 session secret；
- Relay credential 与 Host access token 跨 audience 复用；
- Host 自更新 candidate 版本错误、预检失败和同时更新。

### 20.5 Orchestration 一致性测试

- decider 纯函数 golden tests；
- Event + persisted projection + accepted receipt 同事务原子性；
- commit 前 Provider Adapter 调用次数始终为 0；
- commit 后 intent event 被 Reactor 消费；
- Reactor 重启后对已消费/未消费 intent 正确对账；
- internal Provider command 与 client command 走同一 event/projection 边界；
- in-memory read model 与 SQLite 不一致时从 committed sequence 恢复；
- `drain()` 等待队列和当前 item 全部完成，不依赖 sleep。

### 20.6 Connection Supervisor 测试

- offline startup 不消耗 retry，online wakeup 立即建立；
- 永久退避与 16 秒上限，稳定 30 秒后清零；
- 显式 retry 中断 backoff；
- 前台 activation 对健康 lease 仅 probe，长后台恢复替换 lease；
- auth/config blocked 只被外部状态变化唤醒；
- transport failure 替换 RPC generation，domain failure 在同一 generation 重订阅；
- 显式删除 Host 清理 target、凭证、cache、draft 和 outbox；
- 旧 cache hydration 不覆盖更新 live data。

## 21. 关键产品与技术决策记录

### ADR-001：Host 是唯一执行边界

**决定**：Agent、代码、Git、工具均在 Host。  
**原因**：最小化代码与凭证外泄，适配现有 CLI，支持离线继续。  
**代价**：Host 必须在线，远程连接是产品关键路径。

### ADR-002：不做像素级远程桌面

**决定**：提供 Agent 领域控制，不传桌面画面。  
**原因**：移动交互更适合任务、审批、Diff；带宽和安全性更好。  
**代价**：无法覆盖任意桌面操作，但产品定位更清晰。

### ADR-003：统一事件协议，不透传终端文本

**决定**：Adapter 将 Provider 输出归一化。  
**原因**：客户端稳定、多端复用、支持恢复和审批。  
**代价**：必须长期维护 Provider 兼容矩阵。

### ADR-004：本地事件日志是事实来源

**决定**：v1 Session 状态由 Host SQLite 管理。  
**原因**：断网仍执行、个人产品简单、安全边界清晰。  
**代价**：跨 Host 全局搜索和团队协作要后续增加索引/控制面。

### ADR-005：Tailscale 先行，Relay 产品化

**决定**：内测使用 Tailscale，公开产品提供 E2EE Relay。  
**原因**：先验证核心价值，推迟 NAT、滥用和运维复杂度。  
**代价**：早期用户需安装 Tailscale；正式版还需建设 Relay。

### ADR-006：Client Core 与 UI 分离

**决定**：连接、认证、缓存、同步放独立 SDK。  
**原因**：Mobile、Web、Desktop 共享行为，避免三套重连逻辑。  
**代价**：初期多一个包和接口层。

### ADR-007：原生客户端 Android-first

**决定**：第二阶段只把 Android 作为产品交付平台；iOS 保留 React Native target、共享 Client Core、platform capability 和显式空适配器。  
**原因**：聚焦单平台完成推送、后台恢复、安全存储和发布闭环，同时避免未来 iOS 需要重写业务核心。  
**约束**：iOS stub 必须 fail closed；不允许明文凭证、伪推送成功或无生物识别的静默降级。  
**代价**：iOS 无法与 Android 同期上线；需要在 CI 中持续维护 iOS 基础编译，避免长期架构漂移。

### ADR-008：Live Stream 负责即时性，权威 Timeline 负责正确性

**决定**：Host 保存只追加 Session Event，并生成可分页、可重建的 Timeline Item 投影；Client 用 live delta 快速展示，用权威投影页对账。  
**原因**：移动网络会丢连接，tool/approval 是跨多事件生命周期，只重放 delta 难以稳定恢复展示。  
**代价**：Host 需要 projector、epoch、source sequence ranges 和分页协议，Client Core 需要复杂的 reconcile reducer。

### ADR-009：Provider 权威终态优先于本地操作意图

**决定**：interrupt、approval、question 和 Turn 终态以 Provider ACK 或 Provider 权威事件为准；RPC 发送成功不等于操作已生效。  
**原因**：避免 Flyx 显示已停止或已审批，而 Provider 实际仍在执行的 split-brain。  
**代价**：UI 需要“正在请求/未确认/结果未知”中间状态，Provider Adapter 契约和故障测试更复杂。

### ADR-010：事务中只决策和持久化，事务后 Reactor 执行副作用

**决定**：Command -> Event 决策是纯函数；Event、Projection 和 Receipt 同事务提交；Provider/Git/网络副作用由 commit 后 Reactor 执行。  
**原因**：避免 SQLite 状态与事件日志持久化分裂，并为 Host 崩溃后副作用对账提供可见 intent。  
**代价**：增加 Reactor、internal command、worker drain 和 outcome-unknown 处理。

### ADR-011：Tailscale 是 Endpoint Provider

**决定**：Tailscale/LAN/Manual 负责产生 AdvertisedEndpoint；直连鉴权仍是 Bearer/DPoP ConnectionTarget。  
**原因**：网络地址和接入工具会改变，Host 身份、配对关系和业务协议不应随之改变。  
**代价**：Client 需要 endpoint 广告、选择、probe、稳定 key 和身份校验逻辑。

### ADR-012：每 Host 只有一个 Connection Supervisor

**决定**：Supervisor 独占 retry、backoff、endpoint 切换和 RPC lease 所有权；UI、query、subscription 和 RPC session 不自行重连。  
**原因**：避免多套重试循环互相放大，并区分 transport 健康与 domain sync 健康。  
**代价**：平台 wakeup、删除清理和 RPC generation 切换必须统一注入 Client Core。

### ADR-013：Android DPoP、PWA HttpOnly Cookie、WSS Ticket 分层

**决定**：Android access token 与 Keystore proof key 绑定；PWA session secret 默认只存 HttpOnly cookie；WebSocket 仅携带短期专用 ticket。  
**原因**：降低 token 重放、JavaScript 供应链泄漏和 WebSocket URL 日志暴露风险。  
**代价**：Host 需要 DPoP proof/replay 验证、browser CSRF/origin 校验和多凭证 audience 管理。

## 22. 主要风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Provider 协议随版本变化 | 任务无法解析或恢复 | 版本探测、fixture、兼容矩阵、灰度阻断 |
| 审批 API 不完整 | 手机无法继续交互任务 | 首期 Spike 先验证；必要时限制 permission mode |
| Android 后台连接受限 | 实时流中断 | Host 独立执行、FCM 提示、sequence + Timeline 补同步 |
| Provider 中止/审批没有权威 ACK | 客户端与真实进程 split-brain | 保持 running/未确认，禁止新 Turn，使用终态事件对账 |
| Timeline live/history 重叠 | 文本或 Tool 重复显示 | 稳定 itemId、epoch、source sequence ranges、权威页覆盖 |
| PID 重用或孤儿进程 | 误杀无关进程或资源泄漏 | Managed Process Registry + process start identity |
| 多层重试同时运行 | 连接风暴、endpoint 来回切换 | 每 Host 单一 Connection Supervisor |
| 古老 cache 覆盖 live state | UI 回退为旧状态 | RPC generation + domain sync state + monotonic reconcile |
| DPoP/Browser/Relay 凭证边界混用 | token 重放或跨系统越权 | audience 分离、scope 子集、replay cache |
| Checkpoint 回退部分失败 | Workspace 与 Provider 对话分裂 | revert preview、分阶段执行、partial failure 状态 |
| Host 自更新替换为不可用版本 | 远程 Host 失联 | 精确版本、candidate 隔离、preflight、失败保留当前进程 |
| Relay 安全与成本 | 数据风险和运维压力 | Tailscale 起步；E2EE；流量限额 |
| 多任务污染同一工作区 | 冲突、错误 Diff | 限制并发；尽快引入 worktree |
| 手机上误批危险操作 | 本机或外部系统受损 | 风险分级、默认 allow_once、高风险二次确认 |
| Host 宕机导致状态不一致 | 用户误判任务完成 | SQLite 事务、recovery 状态、绝不推测成功 |
| 协议过度设计拖慢 v1 | 延误验证 | 仅实现列出的 v1 RPC；预留不等于实现 |

## 23. MVP 验收标准

产品验收：

- 手机可发现/选择一台已配对 Host；
- 可看到 Codex、Claude 的可用与登录状态；
- 可选择已注册仓库创建任务；
- 可实时查看结构化输出；
- 实时输出包含稳定的用户消息、assistant、reasoning、tool、approval/question 和终态 Timeline Item；
- 可发送 follow-up；
- 可中止任务；
- 可在手机处理至少一种真实 Provider 审批；
- 可查看本次任务的文件变更和文本 Diff；
- 锁屏或断网后恢复，不丢消息、不重复执行；
- 断线后权威分页可补齐中间全部 Timeline，不只拉最新 tail；
- 中止操作只在 Provider 确认后显示成功，未确认时不允许发新 Turn；
- Session runtime 关闭后可通过 Provider Native Handle 恢复，且不重复导入历史；
- 关闭客户端页面不终止或归档 Agent，归档操作在多客户端一致可见；
- Host 离线和 Runtime 不可用有明确反馈；
- 可撤销手机访问。

安全验收：

- 无任意路径 API；
- 无长期 secret 出现在 URL/query/log；
- 每个写 RPC 有 scope；
- 重放 command 不重复执行；
- pairing grant 一次性且过期；
- WSS 使用短期 ticket；
- Relay 模式下 Relay 无法读取应用明文；
- 高风险审批有二次确认；
- 原始日志默认不上传。
- Android DPoP proof 可防重放，失败时不降级 bearer；
- PWA browser session secret 不暴露给 JavaScript；
- requested scopes 必须是 pairing grant 子集，每个 RPC method 都在 scope map 中；
- Relay credential、Host access token 和 WSS ticket 不能跨 audience 使用。

工程验收：

- Codex、Claude Adapter 契约测试通过；
- 协议兼容测试通过；
- 断网/崩溃故障注入通过；
- 事件 sequence 和 command receipt 有数据库约束；
- Timeline Item 可从源事件重建，live/history 合并契约测试通过；
- Managed Process Registry 能防止 PID 重用误杀；
- Event、Projection 和 Receipt 的原子事务测试通过；
- Provider/Git/网络副作用在事务 commit 前不会执行；
- Drainable worker 和 Host draining 测试不依赖固定 sleep；
- 单一 Connection Supervisor、endpoint 切换和 domain sync 测试通过；
- Provider 版本不兼容时 fail closed；
- Host 可在 macOS 首先稳定运行，Windows/Linux 有明确后续计划。

## 24. 建议的首批工程任务

1. 建立 Flyx monorepo 和协议包。
2. 编写 Codex/Claude Provider Spike，确定结构化接入方式。
3. 定义 `ProviderEvent -> SessionEvent -> TimelineItem` 映射和 fixture。
4. 完成 Rust Host 的 Runtime discovery、Provider Instance Registry、Managed Process Registry 与 process supervision。
5. 建立事务化 Orchestration Engine：纯 decider、event writer、persisted projector、command receipt。
6. 实现 ProviderCommandReactor、ProviderRuntimeIngestion、TimelineProjectionWorker 和 DrainableWorker。
7. 实现 `host.probe`、`runtime.list`、`session.create/startTurn/subscribe`、`timeline.getPage`。
8. 建立平台无关 Client Core，包括单一 Connection Supervisor、domain sync、optimistic message、live/history reconcile、cursor 和 epoch。
9. 实现 AdvertisedEndpoint、LAN/Tailscale endpoint provider、probe 与 host-key 切换验证。
10. 实现扫码配对、Android DPoP、PWA HttpOnly browser session、WSS ticket 和 scope map。
11. 加入 interrupt ACK、runtime close/ensureLoaded、conversation resume、history hydration 和 Host 重启对账。
12. 实现 Approval/Question、Session archive/unarchive、Git Diff 和 Tailscale 远程闭环。
13. Phase 1C 实现 checkpoint/diff/revert；Phase 2.1 实现 Host self-update 和可选 resource telemetry。

建议把第 2 项设为硬门槛：**在没有证明 Codex 和 Claude 的审批、恢复、结构化事件可稳定接入前，不应先投入大量移动 UI。**

第二阶段 Android 客户端开始前，必须先满足 Phase 1B 的远控闭环验收；随后按第 18 节实施 Secure Store、加密缓存、FCM、深链、前后台恢复与 Google Play 发布，不重新实现一套 Host 协议。iOS 同期只维持可编译骨架与显式空适配器。

## 25. 参考源码与文档

### T3 Code

- `/Users/lex/play/t3code/docs/internals/overview.md`
- `/Users/lex/play/t3code/docs/internals/remote.md`
- `/Users/lex/play/t3code/docs/internals/connection-runtime.md`
- `/Users/lex/play/t3code/docs/internals/environment-auth.md`
- `/Users/lex/play/t3code/docs/internals/providers.md`
- `/Users/lex/play/t3code/docs/internals/server-updates.md`
- `/Users/lex/play/t3code/docs/internals/resource-telemetry.md`
- `/Users/lex/play/t3code/docs/user/remote-access.md`
- `/Users/lex/play/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `/Users/lex/play/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `/Users/lex/play/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `/Users/lex/play/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- `/Users/lex/play/t3code/apps/server/src/checkpointing/CheckpointStore.ts`
- `/Users/lex/play/t3code/packages/shared/src/DrainableWorker.ts`
- `/Users/lex/play/t3code/apps/server/src/provider/ProviderDriver.ts`
- `/Users/lex/play/t3code/apps/server/src/provider/builtInDrivers.ts`
- `/Users/lex/play/t3code/apps/server/src/provider/Services/ProviderInstanceRegistry.ts`
- `/Users/lex/play/t3code/packages/client-runtime/src/connection/supervisor.ts`
- `/Users/lex/play/t3code/packages/contracts/src/rpc.ts`

### Paseo

- `/Users/lex/play/paseo/docs/product.md`
- `/Users/lex/play/paseo/docs/architecture.md`
- `/Users/lex/play/paseo/docs/data-model.md`
- `/Users/lex/play/paseo/docs/providers.md`
- `/Users/lex/play/paseo/docs/agent-lifecycle.md`
- `/Users/lex/play/paseo/docs/protocol-compatibility.md`
- `/Users/lex/play/paseo/packages/protocol/src/agent-lifecycle.ts`
- `/Users/lex/play/paseo/packages/protocol/src/provider-manifest.ts`
- `/Users/lex/play/paseo/packages/client/src/daemon-client-transport-types.ts`

### Multica

- `/Users/lex/play/multica/docs/product-overview.md`
- `/Users/lex/play/multica/CLI_AND_DAEMON.md`
- `/Users/lex/play/multica/server/pkg/agent/agent.go`
- `/Users/lex/play/multica/server/pkg/agent/codex.go`
- `/Users/lex/play/multica/server/pkg/agent/claude.go`
- `/Users/lex/play/multica/server/pkg/agent/opencode.go`
- `/Users/lex/play/multica/server/internal/daemonws/hub.go`
- `/Users/lex/play/multica/server/pkg/db/queries/runtime.sql`
