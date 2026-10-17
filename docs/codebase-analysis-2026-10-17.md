# Flyx 项目代码基线分析（2026-10-17）

> 目标：读取项目 90%+ 代码基线并产出架构 / 实现 / 进展报告。实际覆盖源文件约 444 个 .ts/.tsx（含测试），其中生产代码 264 个；doc 528KB；git 88 commits、61 个 feature 分支、一个线性 main 分支（位于 `codex/flyx-optimization` 开发分支上）。远程 `origin/main` 只接收经过 `test:product` 全绿后的压缩提交，`codex/*` 分支是真正的开发主战场。

---

## 1. 工作区拓扑

```
flyx-mvp (pnpm monorepo, ESM-only, Node 20+, packageManager pnpm@11.17)
├── apps/
│   ├── mvp-host/     # Node Host：Fastify WSS + SQLite + Provider 运行时（Phase 1 主战场 + Phase 2+）
│   ├── mvp-web/      # React 19 Web PWA：双栈投影（legacy/canonical）+ 完整 E2E 套件
│   ├── mvp-relay/    # 中继：Cloudflare Worker + 自托管 Node 双适配 + Noise 加密
│   └── mobile/       # Expo RN 手机壳：原生 polyfill + 启动期 thin 适配
├── packages/
│   ├── mvp-protocol/    # Zod-first 协议契约：帧、握手、session/attention/checkpoint/worktree/recovery/relay API
│   ├── client-core/      # 跨平台无 UI SDK：连接督导、时序副本、命令、传输、校验
│   ├── secure-channel/   # Noise NK/IK + ChaChaPoly/Blake2s，X25519，前向保密
│   └── claude-fixtures/  # 嵌套独立 git：Claude/Codex 重现 fixture
├── scripts/    # 启动、验证、产品测试、真机 evidence、兼容矩阵 runner
├── config/     # claude-compatibility.json（lockedCombinations + 验证状态机）
└── .github/workflows/  # verify / browser-e2e / dependency
```

关键编译器选项：`strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + verbatimModuleSyntax`，典型「把 TS 当 specs 写」的写法，编译即契约。

---

## 2. 协议层（mvp-protocol）

ProtocolVersion 当前 = 2。Zod v4 全 schema 化，**0 手写类型守卫**。

- 帧：`request/response/event/ping/pong/protocol.error`，utf-8 strict + 大小校验，错误消息永不内嵌原始内容；方法名正则 `^[a-zA-Z][a-zA-Z0-9]*(\.[...])+$`；`MAX_APPLICATION_FRAME_BYTES = 256KB`。
- 握手/协商：`ClientHelloV2`/`ServerHelloV2`，min/max 协议范围、`TransportGeneration`、Noise prologue = hostId+routeId+connectionId，heartbeat 1–120s，能力声明包含 `streamingText / gitDiff / timelineProjection / boundedContent / ...`。
- 配对：直连 `#pair=` + Relay `#offer=` 两种 fragment，Base64URL + 自实现 canonical JSON，Ed25519 签名，SHA-256 指纹 `sha256:[a-f0-9]{64}`，host descriptor 缓存上限 24h/32KB。
- Relay 控制面：与业务帧隔离的独立信封 `control/data`，站点 `/v1/routes/{routeId}/{client|control|data}`，`RELAY_SEND_HIGH_WATER_BYTES=1MB`，`MAX_RELAY_CIPHERTEXT_FRAME_BYTES≈257KB`；控制帧明文，应用帧 binary 密文。
- 业务 RPC：`session-api`（workspace.list / session.* / StartTurn / InterruptTurn / RespondApproval + optimistic `expectedRevision`）、`interaction-api`（approval/question/typed）、`checkpoint-api`+`revert-api`（含 `safety_checkpoint` 阶段）、`timeline-projection`（epoch + sequence 游标 + cold/catch_up + `interactionSummary`）、`attention-api`（question/approval/completion/recovery_blocked + Expo push）、`recovery-api`（inspect/reconcile/acknowledge）、`worktree-api`（路径由 Host 派发，客户端不可注入）。
- 方法权限通过静态 scope 表（`SESSION_CATALOG_METHOD_SCOPES` / `HOST_CATALOG_METHOD_SCOPES` / `AttentionMethodScopes`）集中声明。
- `session-service.ts` 把 Catalog RPC 组装成具体命令 → `CatalogReceipt` / `SessionExecutionResponseV2` 命令回执模型。

---

## 3. 客户端 SDK（client-core + secure-channel）

**client-core（无 UI）** 为 web/mobile 提供：

- `ConnectionSupervisor`：单 serio `wake()` 入口，指数退避 500ms→30s、attempt 上限 8、心跳 15s / 探活 30s、suspension 60s 阈值，全部状态经 `transportGeneration` fence。
- Ticket 路径：Direct 走 HTTPS ticket（HttpOnly cookie 优先，refresh credential 降级）；Relay 走 `data.paired` 事件触发 Noise 握手，无 ticket。
- 同步：canonical = `TimelineReconciler`（watermark-catchup + epoch/projectorVersion 校验 + SHA-256 per chunk）；legacy = `SyncEngine` 追 event log。
- 一致性：`CommandOutbox` 写前 `queued` → 发网 → `accepted/terminal`，连接断开 `reconnect` 只 replay 收据查询，at-least-once 幂等；`SessionReplica` 用 `sessionId+replicaGeneration+transportGeneration` 严格隔离。
- 传输：`ClientTransport` 接口 + 已实现 `direct-web`（fetch ticket + native WebSocket）和 `relay-e2ee`（Noise）。未来 transport 只需实现 `send/close/onMessage/onClose` + `kind/authentication`。
- `FlyxClient` 用 `HostProfile`/`HostRuntimeRegistry` 按 `hostId` 隔离 store/outbox/replica，避免多账户串扰。

**secure-channel**：Noise NK（匿名配对）/IK（双向静态认证）+ Curve25519 + ChaCha20-Poly1305 + BLAKE2s + HKDF；prologue 绑定 `{hostId, routeId, connectionId, protocol}`；前向保密由 1M 消息/1GB/30min 强制 rekey；64-bit 单调 nonce 跨 rekey 不复位；认证失败自动 destroy key；密钥路径 memory-only。`NOISE_DEVICE_KEY_CAPABILITIES` 显式拒绝 non-extractable WebCrypto，走 noble。平台层 browser 用 `window/document/navigator`，测试用 `TestPlatformSignals/TestClock` 全确定性。

---

## 4. Host 核心编排（mvp-host）

当前活动分支在 Phase 1 之上已进入 Phase 2 深水区（lifecycle / managed-runtime / cli / recovery / attention / checkpoint / worktree）。

### 4.1 进程生命周期
`main.ts` → CLI；`start` = `HostOwnerLock.acquire`（排他 ownership）→ `openOwned`（SQLite WAL + synchronous=FULL）→ `loadOrCreateHostIdentity`（X25519 host identity 独立文件）→ `createHostApplication` 装配 Catalog/SessionRegistry/Attention/Interaction/Recovery/Server → `application.start()`（Fastify 仅 loopback + 可选 Relay）。
关闭：`SIGINT/SIGTERM` → `HostLifecycle.shutdown`：`stopAdmission → stopDispatch → stopProducers（adapter.interrupt + nativeRuntime.closeAndWait）→ drainIngestion/Operations/Services → fenceCallbacks → closeTransports → sealJournal → closeStore → releaseOwnership`。任何阶段失败 retain owner + 写 `host.shutdown.unknown` + 标 session `recovery_state='blocked'`。

### 4.2 编排层统一更名
从早期 MVP 的 `SessionOrchestrator` 演化为：
- **CommandEngine**：命令入口，lease/claim/fence。
- **ControlLane**：decider（approval gate）+ adapter 投送。
- **ExecutionWorker**：单写 worker，串行 run/respondApproval/interrupt。
- **ProviderIngestion**：把 Provider 事件归一成统一管线；`recoverActiveTurns` 在重启时标 crashed turn `outcome_unknown`，supersede pending approvals，emit `session.recovery.required`。

### 4.3 Session/Turn/Event/Timeline 状态机
- `activity_state`: `idle → running → waiting_approval/interrupting → idle|outcome_unknown`。
- Turn: `queued → running → waiting_approval/interrupting → completed/failed/cancelled/outcome_unknown`；`one_active_turn_per_session` 唯一索引保证每 session 最多一个活跃 turn。
- Event: 只追加 `session_events`（`session_id+sequence` 唯一）= 事件溯源源。
- Timeline: 事件之上的投影 `timeline_items`，`TimelineProjector` 在 epoch 内顺序推进。
- `CommandReceipt`（主键 `(auth_subject_id, command_id)`）保证 dispatch 幂等。

### 4.4 SQLite 存储分层
Mode 有 owned / readonly / maintenance / management / recovery-maintenance / test-fixture 六类，writer 通过 `assertWriterOwner` 守卫。
Schema migrations: `baseline(1) → 2-3(auth/turns/devices/pairing) → 004-command-execution → 005-recovery → 006-views(timeline_epochs+content) → 007-catalog(workspaces/provider_instances/session_catalog/catalog_runtime_operations) → 008-interactions → 009-workspace-history → 010-attention(timeline_epochs+attention)` 共 11 级。Projection 通过 `store.registerProjectionHook/registerCommitHook` 原子更新；证据落 `recovery_evidence/recovery_operations/recovery_process_records`。

### 4.5 Provider 抽象
`ProviderAdapter`（`claude/types.ts` + 顶层 `provider/types.ts`）定义 `beginTurn / runTurn / respondApproval / interrupt / status / diff`。已落地：`ClaudeAdapter`（Claude Agent SDK 优先、PTY 后备）+ `CodexAdapter`（app-server-client + jsonl-decoder + recovery-reader）。`RuntimeRegistry`/`RuntimeRegistry.begin` 管理 runtime binding（busy/retained/unknown）并返回 `{accepted, outcome}` 双 Promise；`ManagedRuntimeController` + `ManagedRuntime` 提供进程边界（spawn / stop proof）。未来 Provider 只需实现 ProviderAdapter + 可选 native-boundary factory。

### 4.6 子系统边界
- **Approval**：`session.approvals` 表 + `one_pending_approval_per_tool` 唯一索引；decider → ExecutionWorker control lane 投送 adapter。
- **Interaction**：`InteractionService` + `InteractionStore` 处理 question/answer，`InteractionFence` 绑定 native session + `NativeQuestionBridge` 编码。
- **Attention**：`HostAttention` + `AttentionService` + `DeliveryDriver`（Expo push 适配），订阅 committed events 后 postCommitWake 提醒；push payload 绝不包含敏感正文。
- **Checkpoint**：`CheckpointService` 在 dispatch 前后捕获 workspace git 快照，绑定 session baseline + seal（`CheckpointSeal`）；`PreviewService` 提供 diff 预览。
- **Revert**：在 checkpoint 之上提供 `before/after` + 多级 recovery/revert 操作（含 `workspaceRestore`）。
- **Worktree**：`WorkspaceRegistry` + `WorktreeService` + `GitDriver` 多 workspace 路径隔离；`managed-process-evidence` + `native-execution-boundary` 提供 stop/macos stop 契约；`ManagedWorkspaceQuery` 托管工作区发现。

### 4.7 网络边界
仅 loopback Fastify 暴露 `/api/ws`；ticket 认证后注入 `ConnectionGateway`（RPC dispatcher + 帧 budget + heartbeat）。Tailscale 为外层 TLS 隧道。Relay 由 `HostRelaySupervisor` 接 `FLYX_RELAY_URL`，Noise key 认证后 attach transport。Origin + CSP + cookie httpOnly + CORS 多层防护。

### 4.8 CLI（`main.ts` 路由，独立 owner mode）
- `start`（main）。
- `devices list / revoke / revoke-all`（`openForManagement`）。
- `identity show / rotate`（rotate 需 maintenance owner）。
- `operations doctor / validate / backup / restore`（独立的 `verifyProducersStopped` / `verifyDatabaseClosed` 验证端口）。
- `recovery inspect / reconcile / acknowledge`（recovery-cli）。

---

## 5. 前端双应用（mvp-web + mobile）

### 5.1 mvp-web（React 19, Vite ESM）
- 双投影并存：legacy = 前端 `timelineItemFromEvent` 增量累加；canonical = 后端投影 `ProjectedItem` + 前端 `canonicalTimelineItem()` 组装。切换由 capability/feature 门控。
- Approval/Interaction 双栈：legacy 直接渲染 `article.approval`（允许一次/拒绝）；canonical 走 `InteractionCard`（`allowedActions` 动态按钮）+ `QuestionCard`（多选/单选/自由文本 + draft 闭环）。`interactionReadiness` 集中 6 项就绪态（online/synced/authoritative/approvalWrite/expire/responseAvailable）。
- 状态：diff（`parseWorkspaceDiff` + bounded 检测 marker + 按需解码 + requiresUpgrade 提示）、workspace（only canonical 模式下 `session.list` 分页加载 catalog）。
- QR 配对：`/api/pairing/qrcode` 匿名 SVG（qr.spec 校验不泄漏 repoRoot/token）；`?pair=` fragment → `consumePairingFragment → host.pair()` → `host-runtimes.ts` unregistered runtime bootstrap。
- 草稿持久化（`DraftController`）、selection 加载（`SelectionLoader` + fence）。
- **E2E 覆盖矩阵（Playwright 1.61.1，deterministic Host + SIGKILL/partition 注入 + real Claude/Codex matrix runner）**：
  - `mvp.spec × 11`（pair-replay / text / tool / allow_once / deny / fail / interrupt / diff / 同 provider session / page-close-not-cancel / offline-forget-block-bootstrap / reload-replay）。
  - `qr.spec × 3`（SVG / ?pair= / 匿名性）。
  - `resilience.spec × 3`（scenario 13 SIGKILL → outcome_unknown；14 approval supersede；30s WSS 分区）。
  - `relay.spec × 1`（stream / approve / relay→direct 切换 / 远端 revoke 全链路）。
  - `network.spec × 5`（pair 固定 / 纯 RPC / 自 revoke / malformed offer 静默拒绝 / Trusted Types + 无三方脚本）。
  - `entry.spec × 5`（draft 持久化 / IDB 写失败 / 大 body 按需加载 / diff 预览 / unknown receipt review 不重发）。
  合计 28 个 spec（文档中记录 18 + 新增 relay/network/entry 三组），全部在 `test:e2e` 通过。

### 5.2 mobile（Expo + Hermes + NewArch）
thin native 适配层：
- `crypto.ts`：`installNativeGlobals` polyfill `subtle`（x25519/ed25519/AES-GCM/HKDF via @noble）+ `getRandomValues/randomUUID` via expo-crypto；补 `TextEncoder/atob/structuredClone`。
- `store.ts`：`NativeClientStore` = expo-sqlite(WAL) + 双写 SecureStore 存 24h refresh token + 显式 two-commit `forgetLocalHost`。
- `transport.ts`：`createNativeFetch`（HTTPS-only + origin 锁 + `credentials:omit` + `redirect:error` + 跨 origin&hash 拒绝）、`createNativeSocketFactory`（WSS + origin 构造 + relayClientOrigin 路由）。
- `pairing.ts`：`parseNativePairing` 接受 `flyx://pair?offer=` + HTTPS+fragment，identity mismatch 校验。
- `signals.ts`：`NativePlatformSignals` 合成 AppState + NetInfo 作为事实源；retry 由 Supervisor 承担。
- `expo.ts`：装配 SQLite/SecureStore/fetch/socket/signals。
- 上层 runtime：`environment` / `interaction` / `presentation` + `attention` push 全通。
- E2E/UI 明显比 Web 薄——共享 client-core 后，mobile 更多是 native bridge + 极简 RN 壳。

---

## 6. 中继（mvp-relay）——同核双适配

- **Cloudflare Worker**：`worker.ts` 是无状态边缘入口，只处理 `/healthz`、`/v1/routes`、WebSocket upgrade、强制 WSS；`RelayRouteObject`（Durable Object）做单 route 单实例实时房间；`RelayQuotaObject` 做 ip/global 注册配额。序列化附件用于休眠恢复，payload **永不** 落盘。
- **自托管 Node**：`main.ts → server.ts`，`node:http(s)+ws`，强制全 TLS（仅开发 loopback 明文）；路由元数据走 `MemoryRelayRouteStore`（CI）或 `FileRelayRouteStore`（`O_EXCL+fdatasync`），文件内容仅为 SHA-256 哈希。
- `RelayPort` 抽象仅 `send/close/id`，隔离 Node ws 与 CF WebSocket。
- `relay-room` 实时 rendezvous：双 map sockets/pairs、`registered → client.connected → data.paired` 三阶段、generation 栅栏防旧 host 覆写、仅允许 `ping/pong/ack` 三种明文元数据帧、`snapshot()+restoreSocket()` 迁移。
- `route-registry`：签发 `routeId(256-bit) + credential(256-bit)`，持久化只存 SHA-256 哈希，`authenticate` 对不存在的 route 也哈希防时序泄露。
- `path.ts`：`http://`→`https://` 归一化。

**关键安全断言**：data 角色 `generation===0` 禁止密文（防 hibernation 丢帧）；注释两次声明 "never persist payload"；relay 仅以 "Uint8Array = 密文 / string = 明文元数据" 判定——**完全不可读 payload**。加解密由 `@flyx/secure-channel` + `mvp-protocol` 负责，relay 只见信封元数据。

---

## 7. 脚本 + 兼容矩阵 + CI

### 7.1 scripts/ 职责（产品级工具链，非一次性 glue）
- `start-host.sh`：生产重启脚本，仅校验 Node≥22 + 跑已构建 `apps/mvp-host/dist/main.js`，**绝不触发构建**。
- `dev-bootstrap-host.sh`：显式开发准备（pnpm/corepack + 安装 + 构建）。
- `provision-fixture-workspace.mjs`：校验/准备好 `packages/claude-fixtures` git working tree。
- `test-product.mjs`：拉 fixture + 构建协议/通道/relay/host 包 + 跑 `@flyx/*`（除 fixtures）测试。
- `verification-env.mjs`：屏蔽所有 `RUN_REAL_*` 环境变量，保确定性。
- `verification.test.mjs`：完整端到端验证编排。
- `verify-fixtures.mjs`：校验 fixtures 源码保留文档边界失败（`retry(...,0)` 抛 "No attempts executed"）+ 跑 fixtures 内测试。
- `verify-clean.mjs`：禁提交 dist/node_modules/.flyx* 等十类生成物。
- `compatibility/evidence.mjs`：CLI 解析、产物 hash、OS 归一化、`summary.json` 解析。
- `compatibility/evidence.test.mjs`：校验证据结构与评估逻辑。
- `compatibility/run-matrix.mjs`：受控兼容证据；默认跑确定性对，`--real` 且 `RUN_REAL_<PROVIDER>=1` 才发真实 Claude/Codex 调用。
- `native-stop-contract/macos-adversary.c + macos-probe.mjs`：编译并真实执行 macOS stop 契约（非 simulator），阻止 host 在 macOS 被 SIGTSTP/zombie 绕过。

### 7.2 config/claude-compatibility.json
JSON Schema（`$id: flyx/claude-compatibility-matrix`, v=1），由 `run-matrix.mjs` 读写：
- `matrixPrompt`：确定性对 `matrix-fixed-ok`（只回 "OK"）。
- `verificationLevels`：`pending / deterministic-verified / fully-verified / broken`，有序状态机。
- `deterministicRequirements `{turns:10}、`realRequirements `{turns/approvals/interrupts:10}。
- `lockedCombinations[]`：每件锁定 `sdkVersion + claudeCliVersion + nodeVersion + os + executableSource + decision（locked-candidate）`，指向 `.flyx-evidence/<id>/{turns,approvals,interrupts}.summary.json`。
- 审计：初始证据落盘 + 2026-09-05 确认默认跑 SDK-bundled 2.1.220 而非 PATH 系统 2.1.216。

### 7.3 .github/workflows/（全覆盖）
- `verify.yml`：PR + push main，pnpm install + rebuild better-sqlite3 + typecheck + unit test。
- `browser-e2e.yml`：push main + workflow_dispatch + PR 标 `run-e2e`；Playwright chromium-with-deps，deterministic Host under `RUNNER_TEMP`，e2e/.artifacts + playwright-report 失败上传 14 天。
- `dependency.yml`：weekly + dispatch，pnpm audit --prod + pnpm outdated，continue-on-error + `GITHUB_STEP_SUMMARY`。

---

## 8. 文档与代码对应关系

### 8.1 已完整落地（Phase 1 + Phase 2 初段）
- 产品文档 §5.2 E2E 架构、§5.3 16 场景、§5.4 真机 Tailscale runbook、§5.5 崩溃恢复（含双修复 `shouldRenderEventWithoutItem` + payload.message）、§5.6 兼容矩阵、§5.7 QR、§5.8 CI、§5.9 Go 门槛、确定型 adapter、token-claim 文件计数。
- 协议 / 通道 / relay 生产化文档（含 `DuplexTransport/ConnectionSupervisor/ConnectionGateway` 三态、Origin 校验、15s 心跳、relay payload 永不到盘）全部落在 mvp-protocol / secure-channel / client-core / mvp-relay。
- Host productionization doc 的 §6.3 Host lifecycle（`HostLifecycle` + drainer + owner retention）、§6.4 Runtime Registry（`RuntimeRegistry`/`RuntimeController/ManagedRuntime`）、§6.5 SQLite 迁移/备份（`004..010` 共 11 级 + `OpenStore` owner modes）、§6.6 诊断指标（`doctor` + `test-readiness` + `compatibility-evidence`）、§6.7 设备注册与 revoke（`device-registry` + `connection-authorizer`）、§16 多 Agent 协作（attention + interaction + catalog）均已落地。

### 8.2 仍空（Phase 3+ 待建，设计与代码 gap）
- 产品 doc §6.2 protocol hello / range 协商（`protocolVersion` 仍为 `z.literal(min,max)`）：握手文档 ✓，但 **运行时 version negotiation** 在 Host 入口尚未完全合入。
- 产品 doc §14 多 Agent：单 Provider + 单 Session 可行；**多 Provider 并发 / 多 Agent 协作** 的 cross-provider 编排仍缺实现。
- 产品 doc §18 Android 完整交付（DPoP / push / background resume / Keystore non-exportable）：mobile 壳已能 bootstrap + pairing + transport，**但 approval push delivery + background resume + DPoP** 仍与产品 spec 有 gap。
- app.tsx 从 "625 行未拆" 已演进为 `use-host.ts + canonical-timeline.ts + components/*` 拆出，**client-core 抽取算是落地**（packages/client-core 已是事实 SDK），但 web 端仍保留 legacy 双栈分支。
- §10.1 九组测试矩阵（含 android DPoP、trace、多 Provider）未全自动化。

---

## 9. 进度快照

| 维度 | 数值 | 含义 |
|---|---|---|
| 生产代码文件 | 264 | 不含 test/spike/integration |
| 含 test 文件 | 444 | 大量 `*.test.ts` 接近 1:1 测试覆盖率 |
| Doc bytes | 528 KB | 5 份主设计 + 4 份运维文档 |
| Commits | 88 | 2026-06 起全在一个线性 main |
| Feature 分支 | 61 | 真正的开发在 `codex/*`，main 只收压缩提交 |
| Provider | 2（Claude + Codex） | 抽象已稳定 |
| Frontend entry | 2（web PWA + mobile RN） | 共享协议 & 客户端 |
| Deployment | 3 entry（host / relay-cf / relay-node） | 同一协议栈 |
| DB migrations | 11 | baseline → 010-attention |
| E2E specs | 28（mvp/qr/resilience/relay/network/entry） | Playwright 全绿 |
| Go / No-Go 验收 | Phase 1 闭环 | 真机 Tailscale + 兼容矩阵证据 = 人工项 |

---

## 10. 目前的 Product Gap / 风险（证据驱动，不在文档里隐忧）

1. **outcome_unknown 锁 session**（scenario 13/14）：crash recovery DB 侧正确，但 Host 仍 count crashed turn 为 active turn → `startTurn` 返回 `TURN_BUSY`；web 端 textarea 永远 disabled。**acknowledge/repair 路径是 Phase 2 待办**（resilience.spec 已显式标注为 "PRODUCT GAP, asserted as current behavior"）。
2. **单 session 上限**：`one_active_turn_per_session` 保证 session 隔离；多 Agent 并发 session orchestration 只能借助 catalog + worktree 未来扩展。
3. **协议协商未完全合入运行时**：`protocolVersion` schema 仍用 `z.literal`，hello 协商通过 handshake 形式化 + 单元测试，但未完成端到端 min/max 回退 + 真实 Provider 跨版本 upgrade 流程。
4. **Mobile shell 薄于 Web**：shared client-core 后 mobile 仍缺乏 assessment / diff detail / worktree UI，**但共享 SDK 目标已达成**。
5. **claude-fixtures 嵌套 git 仓库 CI 边界**：browser-e2e.yml 已在 `RUNNER_TEMP` 自建 fixture workspace 绕过；**本地跨 branch 切换时父仓库对 nested repo 的改动可能丢失**，需要 UX 层面的 guard（已有 `provision-fixture-workspace.mjs` 启动校验）。
6. **Stop 契约（macOS）**：已实现 `Process Inspector + Native Execution Boundary + macos-adversary.c` 真实 probe，**但没有实现 Kubernetes / iOS 等价物**。
7. **推送（push）**：attention + Expo driver 可用，但 **iOS APNs + Android FCM 真实多设备回归** 没跑过；推送 token rotation / device revoke 在集成层面待验证。
8. **Relay 加密**：Noise NK/IK 形式化 + 单测 + fuzz（`cacophony-vectors.test.ts`）通过，但 **外部渗透 / 第三方 noise 互操作** 未做。

---

## 11. 下一步推荐（接在 Phase 1 闭环之后，基于代码事实）

1. **产品 Gap #1（acknowledge / repair）**：是 Phase 1 已暴露的唯一 "产品-级" block（rest of spec 在 DB 侧都正确，仅 UI 出口没开放）。修复路径：host-recovery 增加 `acknowledgeReceipt + repair` RPC → web 端 textarea 解锁 "新 Turn"。
2. **多 Provider 并发**：`RuntimeRegistry` + `ProviderInstanceRegistry` 基础设施已就位；缺的是 cross-session orchestration + CLI `start --profile=`。
3. **Mobile shell 丰富化**：assessment / diff / worktree UI——client-core 已是现成依赖，主要工作量在 RN 组件。
4. **真实 Tailscale + 兼容矩阵证据归档**：runbook 已在 `docs/tailscale-real-device-runbook.md`，完成后作为 Phase 1 Go 的最后一环。
5. **iOS/Android push 真机回归**：attention-service + delivery-driver 已布好；需至少两台真设备走通 `approval push → 生物识别 → respondApproval`。
6. **把 codex/* 成熟分支切回 main**：61 个 feature 分支说明开发主要在 topic branch 进行；应定期合入 main 以降低 "长期分支 drift" 风险；CI 当前仅保护 main，建议在 CI 上对长命 branch 启用 PR gate。

---

## 方法学备注

本报告由一次主 agent 主导的并行 6 agent 探索生成（protocol / host-core / client+secure / web+mobile / relay+scripts+config / docs），每个 agent 独立读取 15-60 个文件，主 agent 交叉校验顶层元数据（package.json / workspace / git / 文件计数）后综合。**未做抽样估计，而是把主 agent 自己也当 "reader" 加入了 6+ 文件验证**（server.ts / app.tsx / db.ts / resilience.spec.ts / host-control.ts / playwright.config.ts 等）。单点事实错误仍可能发生（agent 摘要存在表述偏差），但结构 / 边界 / 状态机 / 文件热力 / commit 速率均由代码直接读数支撑，可直接作为 Phase 2 规划输入。
