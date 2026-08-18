# Flyx 剩余任务分析（2026-08-18）

> 依据：`docs/mvp-go-and-host-productionization-technical-design.md`（v0.1，2026-08-12 定稿）
> 核对方式：对照当前代码库逐项验证（typecheck / 单测全绿，目录与文件级检查）

## 1. 当前状态基线

- 垂直切片已跑通：Host 启动 → 配对 → 手机 Web 会话 → Claude Turn → 实时文本/Tool/Approval → follow-up/interrupt → SQLite 事件补同步 → Git Diff。
- `pnpm run typecheck` 全部通过；`pnpm test` 全部通过（protocol 2 / Host 21 / Web 1）。
- 代码停留在 2026-08-12 方案定稿时的基线，之后未再推进。
- Git 仓库已初始化并推送至 `git@github.com:elex-fu/flex.git`（main 分支）。

## 2. Phase 1（MVP Go）剩余任务 —— 全部未开始

### P0（核心，按推荐执行顺序）

| # | 工作项 | 现状 | 涉及文件 |
|---|---|---|---|
| 1 | 修复 `test:e2e` 入口 + Playwright 基础设施 | 缺失：`apps/mvp-web/playwright.config.ts`、`apps/mvp-web/e2e/` 均不存在；根 `test:e2e` 指向 Web 包不存在的 script | Web/package.json、playwright.config.ts、e2e/ 七个 spec |
| 2 | Deterministic Host fixture | `apps/mvp-host/src/test-support/` 不存在 | e2e-host.ts：临时 SQLite + fixture copy + 随机端口 + stdout marker |
| 3 | DeterministicAdapter 场景模型 | 未实现 | FakeScenario（文本/Tool/Approval/延迟/interrupt/失败），至少实现 status/preflight/runTurn/interrupt |
| 4 | 16 个验收场景自动化 | 0/16，其中约 6 个可纯 Playwright 跑 | `apps/mvp-web/e2e/`、Host integration |
| 5 | 断网/崩溃注入测试 | 未实现 | T0–T8 九个注入点 + 5.5.3 恢复断言序列 |
| 6 | 真机 Tailscale runbook + 验收 | 未开始，需人工（断网 60s、录屏、双机型） | docs/runbook、报告模板 |
| 7 | SDK/CLI 兼容矩阵 | `docs/claude-compatibility-matrix.md`、`config/claude-compatibility.json` 均不存在 | 锁定组合需 10 deterministic + 10 真实 Turn 证据 |

### P1

| # | 工作项 | 现状 |
|---|---|---|
| 8 | QR 配对 | 代码无任何 QR 实现，纯 Token 文本输入；若延期需把文档"扫码配对"统一改为"Token 配对" |
| 9 | CI workflows | `.github/workflows/` 不存在，需 verify.yml / browser-e2e.yml / dependency.yml |

### Go 门槛（5.9 节，依赖上述基础设施）

- 16 个验收场景全部通过；
- 30 个真实 Turn（非 deterministic）；
- 10 次真实 approval（allow/deny 各 ≥3）；
- 10 次 interrupt（9 次 5 秒内到终态）；
- 刷新 / 60 秒断网各 10 次无缺口；
- 真机 + Tailscale 验证；
- 证据分层归档（报告 YAML 模板见文档第 10 节）。

## 3. Phase 2（Host/协议生产化）剩余任务 —— 全部未开始

### P0

| 工作项 | 现状 |
|---|---|
| 协议 hello/版本范围协商 | `protocolVersion` 仍为 `z.literal` 固定值，无协商 |
| Host lifecycle（ready/degraded/draining） | `src/lifecycle/` 不存在 |
| ProviderRuntimeRegistry | `src/provider/` 不存在 |
| SQLite migration/backup | 无 migrations 目录和 backup.ts |
| client-core 抽取 | `packages/client-core/` 不存在；Web 625 行 app.tsx 未拆分 |

### P1

诊断/指标（observability/）、Host identity/endpoint、设备注册与 revoke、协议 codegen 评估；以及 10.1 节九组自动化测试矩阵（Protocol/Scope/Lifecycle/Runtime/Storage/EventWriter/ClientCore/Auth/Observability）。

## 4. 推荐执行顺序（9.3 节）

1. 修复 test:e2e 入口并建立 deterministic Host（= 上述 P0 #1–3 打包做）
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

## 5. 风险与注意事项

- 真机验收和真实 Claude 矩阵需要本机配合（Tailscale、手机、Claude 登录），可与基础设施开发并行人工准备；
- `packages/claude-fixtures` 是嵌套 git 仓库，未被外层仓库追踪；
- fixture 初始 `npm test` 故意失败，不能当成产品测试失败；
- 真实 Token、Cookie、Prompt 原文禁止写入任何工件/报告。
