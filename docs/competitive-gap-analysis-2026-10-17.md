# Flyx 与 Paseo / T3 Code 差距分析（2026-10-17）

> 方法学：Paseo 资料来自官方定位 + 第三方中文评测；T3 Code 从其 GitHub 仓库（pingdotgg/t3code）SKILL.md 系统 + SQLite fixture + 贡献策略文档直接读出，2026-10 仍在快速迭代。对比主要聚焦**工程可验证事实**而不是营销文案，无法从公开材料断言处标注 [推断]。

---

## 1. 三方一句话定位

| 维度 | 当前 Flyx | Paseo | T3 Code |
|---|---|---|---|
| 一句话 | 手机远程受控本机 Claude/Codex 执行的 Host 端 + 协议栈 | 本地 daemon 编排台，把 CLI agent 变成手机/桌面/CLI 可控的 worktrees | 多 agent Web GUI 演化出的编排平台 + 真机/浏览器验证面板 |
| 协议栈 | 自研 Zod-first + Noise + 11 区 SQLite migration | 依托 CLI agent 既有协议（Claude Code/Codex CLI 本地 STDIO） | 自有 orchestration_v2 投影 + deep link + server-side auth |
| 关键抽象 | `ProviderAdapter` SPI + TransportGeneration 栅栏 | "不替代 CLI，管理 CLI" 的 wrapper | 30+ provider 热切 + Browser/Device 双验证面板 |
| 商业模式 | 未定型（开源 MIT?） | AGPL-3.0 开源 + 自建 relay | 未读到明确 LICENSE（仓库 private 部分不可见） |
| 工程成熟度 | E2E 28 spec 全绿 + Crash 恢复 + 兼容矩阵基础设施 | [推断] 产品已面向个人（多端 App + 语音 + 私有 relay） | [推断] 14k+ stars，有 Contribution Triage 自动化，有 SKILL.md 体系 |

---

## 2. Flyx 领先维度（工程事实，非营销）

1. **Provider Adapter SPI** — `ProviderAdapter` 是头等抽象，Claude 与 Codex 已经 adapter-fenced（fence.test.ts），未来 Provider 只需实现 beginTurn/runTurn/respondApproval/interrupt + 可选 native-boundary factory。Paseo/T3 Code **直接依赖 CLI binary**（Claude Code / Codex CLI / OpenCode），没有脱离 CLI 的合同化抽象 — 切换 Provider ≈ 切换外部二进制，Flyx 切 Provider ≈ 切换内部实现类。

2. **协议可验证性** — mvp-protocol 用 Zod v4 全 schema + 自定义错误类（ProtocolFrameError）。帧大小、大小写字节流、`transportGeneration` 栅栏、handshake prologue 绑定都可在编译期验证。Paseo/T3 Code 的协议隐藏在 CLI STDIO 之后，没有独立的协议契约层。

3. **Crash-resilience 工程事实** — `recoverActiveTurns` + T0–T8 故障注入 + supersede pending approvals + `session.recovery.required` 事件溯源。这在公开资料中 Paseo/T3 Code **未声明** 同等工程深度。Flyx 把 "Host 在多长的崩溃窗口内仍能给出明确的 outcome_unknown 而不静默重复执行" 做成了 E2E 断言。

4. **Noise NK/IK + forward secrecy** — secure-channel 64-bit monotone nonce、1M/1GB/30min 强制 rekey、BLAKE2s、cacophony-vectors.fuzz。Paseo 声称 relay E2E 但未见 Noise suite 公开形式化；T3 Code relay 策略不可见。

5. **兼容性矩阵 Runner** — lockedCombinations 状态机（pending / deterministic-verified / fully-verified / broken）+ `.flyx-evidence/<combo-id>/turns.jsonl`。这是把 "Provider 与其宿主环境适配" 做成 evidence-based 的可重复工程。[推断] Paseo/T3 Code 未做同等证据归档。

6. **Relay 双适配器形式化** — CF Worker + Node server 共享 `RelayPort`/`Relay-Room`/`RouteRegistry`，且 payload 永不到盘（CF DO 休眠与 Node O_EXCL+fdatasync 两个断言）。

---

## 3. Flyx 落后维度（需正视）

### 3.1 多 Agent 编排（Flyx 最大工程 gap）

Paseo 卖的是 **"一次 run 多个 agent，每个 agent 在一个 git worktree，互不干扰"** — 它们把 worktree 当成 agent 隔离原生原语：

```
paseo run --provider codex "fix login bug"    → worktree_1 @ branch agent/1
paseo run --provider claude "cover with tests" → worktree_2 @ branch agent/2
```

T3 Code 走的是 `orchestration_v2_projection_*` 投影模型（threads / runs / messages / turn items / runtime requests / plans / provider sessions）— 一张表一个 event 溯源 + 一张图一条投影，**远比 Flyx 当前 session-wide 单 turn 的编排颗粒度要细**。

Flyx 当前约束：
- `one_active_turn_per_session` 每 session 最多一活跃 turn
- 尚无跨 turn 依赖图
- 尚无 "agent 市场" 或 provider 热切 UI
- WorktreeService/WorktreeRegistry 在 **后端** 启用，前端没有 "多 agent 列表" 入口

→ 差距级别：**结构性缺失**（Flyx 架构支持多 Provider，但无多 Agent 并发会话编排）。

### 3.2 移动端体验（产品级 gap）

Paseo 有：原生 iOS/Android 应用 + 本地语音 I/O + 私有 relay + 手机端完整会话搜索/分组/贴标签；T3 Code 通过 `t3code-dev://connections/new?pairingUrl=...` + AgentDevice `device_open` 在远程跑真机屏幕。

Flyx mobile：
- 当前是 Expo 薄壳，无 assessment / diff / worktree / 多 agent 列表 UI
- 推送（attention-service + Expo driver）在 "未跑真机多设备回归" 状态
- QR 配对 web 端完成 → mobile 端基于 client-core 共享但 **无原生 deep link 处理 + 无原生 QR scanner**

→ 差距级别：**Feature 量级缺失**（web 与 mobile 共享 client-core 已是正确定位，但 mobile 前端仍处于 "展示型"）。

### 3.3 远程访问 / Relay 产品化

Paseo 把 "私有 relay + 手机 → 家中 Mac" 当成默认产品卖给 C 端。Flyx 现状：
- mvp-relay 存在且双适配（CF Worker + Node）
- secure-channel Noise 套件的端到端加密已就绪
- 但 **主机端未启动 relay supervisor 作为默认启动路径**（只在 `FLYX_RELAY_URL` 显式传入时可选启用）
- 移动端也没有一个 "远端主机列表 + 一点即连" 的 onboarding

→ 差距级别：**集成未完成**，协议层已就位，产品化流程未通。

### 3.4 Provider 热切 UI

T3 Code 在 GUI 上把 30+ provider 放在一个下拉；（推断）Paseo 在每个 `paseo run --provider <x>` 时透明切换 binary。Flyx UI：**没有 provider 切换入口** — 用户需在后端配置中绑定 Provider，前端只能展示 activeProviderStatus，不能运行时切 provider。

→ 差距级别：**UI 功能缺失**（后端 `RuntimeRegistry` 已支持 busy/retained/unknown 三态，前端未暴露）。

### 3.5 Onboarding 与发现性

Paseo 评测反复提 "安装一次，手机就能找到 daemon"；T3 Code 有 `vp run dev --share` 一次给共享 URL。Flyx 当前 onboarding 仍需用户手动构造配对 URL / Tailscale 网络——对非技术用户门槛过高。

---

## 4. Flyx 与两者在架构哲学上的差异（这决定能否直追）

| 哲学 | Flyx | Paseo | T3 Code |
|---|---|---|---|
| Agent 抽象 | 头等 Provider SPI = 插拔即切换 | 外部 CLI 封装 = 切换 = 换 binary | 多 provider 面板 = 展示 + 切换 |
| 状态源 | SQLite 事件溯源 + Projection | [推断] per-worktree CLI 流 | orchestration_v2 投影表 |
| 身份边界 | Host identity 文件（X25519 签名 key） | [推测] 本地 daemon 认证 + relay 凭证 | server-side auth pairing + credential |
| 协议自举 | Noise → Frame → Method | CLI STDIO | deep link + HTTP/WSS |

**结论**：
- Flyx 在 "协议 + 主机执行边界 + 可审计性" 上 **走得更远**；
- Paseo 在 "把 agent 当独立隔离工作体并行跑" 上 **走得更远**；
- T3 Code 在 "单 Web 入口统一 30+ agent + 真机验证面板" 上 **走得更远**；
- 三方所攻 "coding agent" 其实是同一赛道的不同分形：Flyx 管 "单个 Agent 长尾可靠性"、Paseo 管 "多 Agent 并行隔离"、T3 Code 管 "多 Provider 热切 + 真机验证"。

---

## 5. 后续迭代建议（按 RICE 直觉排序）

### R1-高优（追平结构性 gap）

| 项 | 工程输入 | 输出物 | 对应 gap |
|---|---|---|---|
| **多 Agent 会话编排** | 借鉴 T3 投影表：threads / runs / turn items / provider sessions；保留 Flyx 事件溯源架构，"第二 session" 从 `one_active_turn_per_session` 改成 "(session_id, catalog_namespace) 多活跃 turn"，加跨 session dependency 图 | 后端：`SessionCatalog`（已在 client-core 出现但未贯穿 host）→ 前端：catalog 面板显示 "多个 agent 并发跑" | §3.1 |
| **Provider 热切 UI** | `host-runtimes.ts` 已经读取 `capabilities`；在 web/mobile top-bar 暴露 provider-picker，选 ProviderA → `RuntimeRegistry.retain` + `HostRuntimeRegistry.adopt` | 前端下拉 + 后端 `RuntimeRegistry.release/busy → retained` 状态切换 | §3.4 |
| **Onboarding 一步拉起** | mvp-relay 已是默认启动参数；移动端增加 universal link（`flyx://pair?...`）+ 本地 scanner；首次启动自动生成 self-signed cert + relay 注册 | 用户在 CLI 只会看到 `flyx start`，手机扫一次码就连上；Tailscale 路径留给 power user | §3.5 |

### R2-中优（追平产品级 gap）

| 项 | 工程输入 | 输出物 | 对应 gap |
|---|---|---|---|
| **Mobile parity（Web↔Mobile 差距收敛）** | 已共享 client-core；需在 mobile 实现：assessments / diff / worktree / multi-agent list / push-driven approval | 使用 Expo Router + RN 共享组件；E2E 覆盖 scenario 9（断网 60 秒）+ push 生物识别 | §3.2 |
| **Acknowledge/Repair 解锁** | `outcome_unknown` 后 Host 仍 count crashed turn 为 active → startTurn 返回 TURN_BUSY；需 host-recovery.acknowledgeReceipt + repair RPC | resilience.spec §13/§14 中 textarea-disabled 断言 → "新 Turn" 解锁按钮 | resilience.spec PRODUCT GAP |
| **Worktree UI** | WorktreeService + GitDriver 已在 host；需前端展示 "3 个活跃 worktree，每个在 agent/x 分支" | Worktree panel：diff/merge/archive；每 agent 单选 diff | §3.1 |

### R3-低优（差异化壁垒，短期不必追）

| 项 | 工程输入 | 输出物 | 备注 |
|---|---|---|---|
| **Voice I/O（类 Paseo）** | 当前无 voice 模块 | 可接 whisper + TTS via MCP？ | [推断] Paseo 的差异化之一，但非 Flyx "受控主机核心能力" |
| **Agent Marketplace（类 T3 Code 30+ providers）** | ProviderAdapter SPI 已就绪，缺 provider 注册中心 + UI 列表 | 社区 contribute 一个 ProviderAdapter → Host 动态加载 | 生态项，不必自建榜单，但需把 Provider SPI 文档化 |
| **Contribution Triage 自动化** | 已具备 GitHub Actions + verify + e2e；可照搬 T3 Code 的 SKILL.md + `contribution-triage` 自动 close 不合规 PR | `.github/skills/contribution-triage/SKILL.md` | 提升社区参与门槛 |

---

## 6. 风险 / 注意事项

1. **Protocol hello 仍未合入运行时**：mvp-protocol 文档写了 negotiation，但 `protocolVersion` schema 靠 `z.literal` 硬编码。多 Provider 一旦要求协商 min/max，这块会卡。在 R1 之前把 version negotiation 跑通是硬前提。
2. **claude-fixtures 嵌套 git 仓库 CI 边界**：在本地跨 branch 切换时父仓库对 nested 的改动可能丢失 → 新增 UI feature 前先把 `provision-fixture-workspace.mjs` 校验加进 pre-commit。
3. **蜂窝网络断网 scenario 9 无人跑过**：E2E 28 spec 里 WSS partition 仅 30s 确定性慢 Turn 覆盖，蜂窝上 60s+ 弱网还是空白 → mobile parity (R2) 需配合真机 tailscale runbook。
4. **移动端双写 SecureStore vs client-core 缓存一致性**：移动端的 `forgetLocalHost` 是 two-commit 但未见证据在 iOS background resume 后仍能保证 — 在 push-driven approval (R2) 时一并验证，避免漏批准。
5. **对比不完整**：Paseo 部分来自评测文（非直接代码访问），T3 Code 的推理部分基于仓库 SKILL + SQLite fixture schema（明确标注仓库不可见的部分未做结论）。

---

## 7. 一句话结论

Flyx 在 **"受控主机协议栈 + 单 Agent 长尾可靠性 + 跨平台 E2E 证据"** 这条分形上显著领先两个对手；但在 **"多 Agent 并行隔离编排 + 移动端产品体验 + Provider 热切 + Onboarding 一步拉起"** 这些决定"普通人会不会用"的维度上还有结构性 gap。R1 三项（多 Agent 编排 + Provider 热切 + Onboarding）是追平；R2 三项（Mobile parity + acknowledge/repair + Worktree UI）是补齐产品底线；R3 三项（Voice / Agent Marketplace / 贡献 Triage）是差异化壁垒，短期生态驱动。
