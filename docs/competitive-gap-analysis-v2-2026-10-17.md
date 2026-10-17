# Flyx / Paseo / T3 Code 重分析（2026-10-17 · 第二版）

> 本版是对第一版的**事实校准重写**。第一版有三处结论与代码不符，已逐条纠正（见 §0）。重写时不再依赖子 agent 摘要，关键判断全部回到源码行号。

---

## 0. 第一版的错误与纠正

| # | 第一版结论 | 代码事实 | 影响 |
|---|---|---|---|
| 1 | "protocol hello / range 协商未合入运行时，`protocolVersion` 仍硬编码" | **错**。`connection-gateway.ts:319-342` 有完整运行时协商：校验 hello shape、hostId/deviceId 匹配、`hello.protocol.min > 2 \|\| hello.protocol.max < 2` 拒绝、`requiredCapabilities` 校验、canonical timeline 必须同时声明 bounded content、返回 server.hello 带 leaseId/heartbeat/maxFrameBytes；`:352` 还有 v1 降级路径。`negotiateProtocolVersion()` 在 `handshake.ts:59` 是"取最高共同版本"，协议层与运行时都一致 | 第一版把它当 R1 的"硬前提 blocker"，属误判。多 Provider 热切不受此阻塞 |
| 2 | "acknowledge/repair 属 Phase 2 待办" | **错**。三层全部存在：`mvp-protocol/src/recovery-api.ts:55` 的 `session.recovery.acknowledge` RPC、`recovery-cli.ts:12` 的 `inspect\|reconcile\|acknowledge` CLI（强制 `--acknowledge-unknown` 显式确认）、`recovery-service.ts:83` 的实现（`RECOVERY_ACKNOWLEDGEMENT_REQUIRED` 守卫）。`client-core/recovery-client.ts:40` 还封装了 `acknowledge()` | 真实 gap 收窄为 **"web UI 未暴露该路径"**，而不是"后端未实现"。两者工作量差一个数量级 |
| 3 | "web 无 provider 切换入口 / 无多 session 入口" | **部分错**。`app.tsx:98` 有 session 下拉（列出每 session 的 `activityState`），`use-host.ts:186` 有 `selectSession`，`session-catalog.ts` 有 `session.list` 分页加载。真实缺的是 **运行时切 provider**（topbar 只从 `bootstrap.provider ?? snapshot.session.provider` 读取展示） | 多 Agent 并行从"完全缺失"降级为"**会话已可切换，缺并发编排**" |

**教训**：第一版用了"文档对照 + 子 agent 摘要"的推断链，未回到入口点验证。本版把三处都验到了行号。

---

## 1. 校准后的三方定位

| 维度 | Flyx（实测） | Paseo | T3 Code |
|---|---|---|---|
| 形态 | Host + Web PWA + Expo 壳 + Relay + 协议包 | daemon + 多端客户端 + relay（AGPL-3.0） | Web/Desktop GUI + 原生 iOS/Android + server |
| Provider 接入 | **ProviderAdapter SPI**（类内抽象，Claude/Codex 各有 fence 测试） | 包装外部 CLI（Codex/Claude Code/OpenCode），切换 = 换 binary | 30+ provider 面板热切 |
| 协议 | **自有 Zod v4 契约 + Noise + 运行时 hello 协商（v1↔v2）+ transportGeneration 栅栏** | CLI STDIO | 自有 orchestration_v2 投影 + deep link |
| 多 Agent | **多 session 可切换 + catalog 分页 + residency 状态机（unloaded/loading/loaded/closing/blocked）**；缺并发编排 | 每 agent 一个独立 git worktree，`paseo run` 并行 | threads / runs / turn items / plans 投影 |
| 恢复能力 | **inspect/reconcile/acknowledge 三层完整**（CLI + RPC + SDK）；web UI 未接入 | [推断] 未见公开形式化 | [推断] 未见公开形式化 |
| 移动端 | Expo 薄壳（client-core 共享，无 parity UI） | 原生 iOS/Android + 语音 I/O | 原生 App + AgentDevice 远程真机面板 |
| 验证体系 | **28 E2E spec + 7 类故障注入（T0–T8）+ 兼容矩阵证据** | [推断] 未见 | SKILL.md + `test-t3-app` / `test-t3-mobile` + SQLite fixture 规范 |

---

## 2. Flyx 实际领先的（校准后仍成立）

1. **ProviderAdapter 是内部抽象，不是 CLI 包装**。Paseo/T3 Code 的多 provider 本质是"调不同 binary"，能力边界由外部 CLI 决定；Flyx 的 `beginTurn/runTurn/respondApproval/interrupt` 是自有契约，能实现 Paseo 做不到的语义（例如 approval 的 `one_pending_approval_per_tool` 唯一索引 + version CAS + 重启 supersede）。

2. **恢复语义完整且可审计**。这不只是"有个 acknowledge 命令"——`recovery-service.ts:100-124` 的 `perform()` 会先 `observe`（进程树身份、原生 terminal 状态、committed outcome），再判定 `reconcile` 是否安全（必须有 committedOutcome 且能 release），`acknowledge` 必须 `observed.native.state !== "terminal"` 才允许（否则拒绝），全程 hash 化幂等 + `recoveryRevision` 乐观锁。对比：Paseo/T3 Code 公开材料无同等深度的"未知结果裁决"流程。

3. **运行时协议协商是真的**。v1↔v2 双版本、能力子集过滤、canonical timeline 强制依赖 bounded content 的交叉校验（`connection-gateway.ts:334`）——这是一处容易被忽略但很容易出 bug 的不变量，代码里明确守住了。

4. **Compatibility matrix 是证据驱动而非宣称驱动**。`lockedCombinations[]` + `verificationLevels` 状态机 + `.flyx-evidence/<id>/turns.jsonl`，还留有 2026-09-05 的审计纠错记录（确认实际跑的是 SDK-bundled 2.1.220 而非 PATH 里的 2.1.216）。这是"我知道我测的是哪个二进制"的工程纪律。

5. **Relay 双适配 + payload 永不落盘**。CF Durable Object 的 hibernation 序列化会丢内存态，代码用 `generation===0 拒收密文` 做了防御；Node 版用 `O_EXCL + fdatasync` 且文件只存 SHA-256。两套实现同一 `RelayPort` 契约。

---

## 3. 校准后仍然成立的 gap（按真实工作量重排）

### G1 · 多 Agent 并发编排（最大的结构性差距，仍未解决）

Flyx 已有：多 session 可切换、catalog 分页、`residency_state` 五态机、`provider_instances` 表、`workspaces` 表、`WorktreeService`。

Flyx 缺的是**编排层**，具体三点：
- `one_active_turn_per_session` 只允许"每 session 一个活跃 turn"，但系统**没有一个"同时跑 N 个 session"的调度器**——用户必须手动在下拉里切。
- **无跨 session 依赖图**（"agent A 改完后 agent B 跑测试"无法表达）。
- **无自动 worktree 分配**：Paseo 的 `paseo run` 会为每个 agent 建独立 worktree；Flyx 的 `WorktreeService` 存在但需要显式调用，没有 "spawn agent → 自动切 worktree → 自动写分支" 的链路。

→ 工作量：**后端为主**（调度器 + 依赖图 + 自动 worktree 绑定），前端只需在已有 session 下拉上加"并行看板"视图。估 Paseo 等价能力需 3–4 周。

### G2 · Web UI 未接入恢复路径（低工作量，高价值）

后端全通，前端零接入。`app.tsx:102` 的"发送任务"按钮条件是 `snapshot?.session.activityState !== "idle" || Boolean(snapshot?.activeTurn)`，`outcome_unknown` 状态下永久 disabled，且页面上没有"裁决"入口。

→ 工作量：**1–2 天**。加一个"该 Turn 结果未知 → 检查 / 核对 / 确认放弃"面板，调 `client.recovery.inspect/reconcile/acknowledge`，成功后刷新 snapshot 解锁输入框。resilience.spec 里那两处 `expect(textarea).toBeDisabled()` 注释"PRODUCT GAP"可以一并改成正向断言。

### G3 · Provider 运行时热切（中等工作量）

后端：`RuntimeRegistry` 有 busy/retained/unknown 三态、`provider_instances` 表、`session_catalog_provider` 索引——基础设施齐备。前端：topbar 只读展示。

→ 工作量：**约 1 周**。新增 `session.switchProvider` 或"新建 session 指定 provider"的 UI 路径（注意：**切 provider 不是切现有 session 的 provider**——按设计应该是新建 catalog 条目 + 选择 provider_instance，避免 native handle 混淆）。

### G4 · 移动端 parity（最大工作量）

现状：Expo 壳 + `client-core`（crypto/store/transport/pairing/signals 都有真实实现和非空测试），但无 assessment / diff / worktree / 多 session / push-driven approval UI。Paseo 和 T3 Code 都有原生 App 并把"手机不是阉割版"当卖点。

→ 工作量：**数周量级**。可复用 web 的 `use-host.ts` 逻辑层（纯 TS，不依赖 DOM），主要成本在 RN 组件 + 推送（APNs/FCM 真机回归）。

### G5 · Onboarding 一步拉起（中等）

`FLYX_RELAY_URL` 是可选参数，不是默认路径；移动端无 universal link（`flyx://pair?offer=` 只在 `parseNativePairing` 里被解析，但没有注册 handler）；web 有 QR 但需要用户先知道 URL。

→ 工作量：**约 1 周**。默认启动即注册 relay + 移动端 deep link + 首次启动引导。

---

## 4. 与两个对手的"真正不对称"在哪

对比表格容易误导。真正的差别是三句话：

**Paseo 的不对称优势 = "并行"**。它把 worktree 当成 agent 隔离的原语，一个命令拉起 N 个 agent 各改各的。Flyx 的架构完全支持（worktrees 表、residency 状态机都在），但没有"一条命令拉起 N 个"的产品入口。**这是产品决策差距，不是架构差距。**

**T3 Code 的不对称优势 = "广度 + 验证基建"**。30+ provider 热切 + SKILL.md 化的自测体系（把"怎么验证这个功能"写进仓库供 agent 自己读）。Flyx 的验证体系更深（28 spec + 故障注入 + 兼容矩阵），但**只覆盖自己的 2 个 provider**，广度完全不同量级。**这是生态差距，不是深度差距。**

**Flyx 的不对称优势 = "受控执行 + 未知结果裁决"**。这三件事 Paseo/T3 Code 没做：运行时协议版本协商、崩溃后的 inspect→reconcile→acknowledge 三段裁决、兼容矩阵的后验证据归档。**这是可以对外讲的技术叙事**——不是"又一个 agent 遥控器"，而是"给 agent 执行加了事务语义和恢复语义"。

---

## 5. 迭代建议（按"价值/工作量"重排，不按 RICE 套话）

### 立刻做（1 周内，投入产出比最高）

1. **Web 接入恢复面板**（G2）。后端已完备，纯前端接线。做完后 Flyx 才有资格说"崩溃后能恢复"——现在这句话在后端成立、在用户手里不成立。
2. **把 resilience.spec 的 PRODUCT GAP 注释改成正向断言**。同一个 PR 完成，顺带证明能力闭环。

### 紧接着（2–4 周）

3. **并行编排 MVP**（G1 的最小切片）：不做完整依赖图。只做「在这台 Host 上同时启动 3 个 session，各自自动分一个 worktree，看板显示各自 activityState」——直接对齐 Paseo 的核心卖点。用现有 `WorktreeService` + `session_catalog`，不加新表。
4. **Provider 选择 UI**（G3）：新建 session 时选 provider，复用 `provider_instances`。

### 中期（1–2 月）

5. **移动端 parity 第一批**：只做"看 timeline + 审批 + 发新任务"三件事，把 `use-host.ts` 的逻辑搬到 RN。不做 diff/assessment/worktree。
6. **Onboarding 一步拉起**（G5）：Host 默认注册 relay，移动端注册 deep link。

### 明确不该追的

- **30+ provider 广度**：Flyx 的差异化是深度受控，铺 provider 数量会稀释工程质量。保留 2 个做到 fully-verified 比 30 个 unknown 更有说服力。
- **语音 I/O**：与"受控执行"叙事无关，纯功能堆砌。
- **桌面客户端**：Web PWA + 移动端已覆盖"离开电脑"这个核心场景。

---

## 6. 风险（校准后，只列真实存在的）

1. **`residency_state` 与 `one_active_turn_per_session` 的交互未验证**：想做并行编排，必须先回答"两个 loaded session 同时 running turn 时，SQLite 写队列（单 worker）会不会成为瓶颈"。`execution-worker` 是单写串行设计，这是并行前必须做的压测。
2. **`connection-gateway.ts:352` 的 v1 降级路径**缺 E2E 覆盖——只在单测里覆盖。真要做跨版本兼容叙事，得补一条 E2E。
3. **web/mobile 的 projection 双栈**（legacy + canonical）在 client-core 与 web 各有一份逻辑，改一处容易漏另一处。`timeline.ts` 与 `canonical-timeline.ts` 并存是技术债。
4. **Paseo/T3 Code 的对比证据强度不均**：Paseo 依赖第三方评测（非代码可验证），T3 Code 有仓库直读（SKILL.md / SQLite schema / pair-client.sh）。本报告已标注哪些是 [推断]，但外部读者应知道两者证据等级不同。

---

## 7. 一句话结论（校准版）

Flyx 真实的位置是：**协议和恢复语义做到了竞品没有的深度（运行时协商 + 三段式未知结果裁决 + 证据化兼容矩阵），但产品化程度落后一个身位（恢复路径没接到 UI、并行编排没做、移动端只是壳）。** 最短的追赶路径不是加功能广度，而是先把已经建好的后端能力接到用户手上——恢复面板是 1–2 天的事，并行看板是 2–3 周的事，这两件事做完，Flyx 就不再是"一个做得更细的同类产品"，而是"有事务语义的 agent 执行层"。
