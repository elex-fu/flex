# Flyx 剩余任务分析（2026-08-18 第三版）

> 依据：`docs/mobile-remote-multi-agent-product-technical-design.md` 与 `docs/mvp-go-and-host-productionization-technical-design.md`
> 核对方式：对照当前代码库逐项验证（git@head，E2E 18/18、单测 24/24、typecheck 全绿）

## 1. 当前状态基线（较第二版的变化）

- Phase 1 所有 6 项剩余任务（#5–#9）已全部落地，**Phase 1 闭环达成**。
- Playwright 锁定 1.61.1 匹配本机 chromium-1228；better-sqlite3 已针对 Node 24 重编译。
- 关键修复（本次）：`session.recovery.required` 恢复事件在浏览器端此前不可见——根因是 (a) `shouldRenderEventWithoutItem` 白名单未包含 recovery 事件，(b) recovery payload 没带 `message` 字段（timeline_items 表里有 friendly 字符串但前端不读那张表）。双修复位于 `apps/mvp-host/src/storage/db.ts` 与 `apps/mvp-web/src/app.tsx`。

## 2. Phase 1 已交付清单（全部完成）

| # | 工作项 | 交付物 | 验收 |
|---|---|---|---|
| 5 | 断网/崩溃注入测试（场景 13/14 + 分区） | `apps/mvp-web/e2e/resilience.spec.ts`（3 项）、`apps/mvp-web/e2e/host-control.ts`、`e2e-main.ts` 的 KEEP_DATA 重启路径、`server.test.ts` / `orchestrator.deterministic.test.ts` 覆盖 T0–T8 + 场景 10 | E2E 3/3 通过；sequence 连续 + supersede approval + outcome_unknown 状态断言齐套 |
| 6 | 真机 Tailscale runbook + 验收模板 | `docs/tailscale-real-device-runbook.md`：5 项验收（E1–E5：HTTPS 可达 / 真实扫码配对 / 完整 Turn 闭环 / 网络韧性重连 / 产品 Gap 行为）+ 报告模板 + Tailscale Serve 反代附录 + 证据目录 `.flyx-evidence/tailscale/` | 人工文档，无自动验收 |
| 7 | SDK/CLI 兼容矩阵 | `config/claude-compatibility.json`（锁定组合 + deterministic/real requirements）、`scripts/compatibility/run-matrix.mjs`（证据归档供 .flyx-evidence/<combo-id>/turns.jsonl）、`docs/claude-compatibility-matrix.md` | 基础设施就绪；证据收集需真实 Claude 环境 |
| 8 | QR 配对 | `apps/mvp-host/src/server.ts` 的 `GET /api/pairing/qrcode`、`activeQrPairingToken()`、`apps/mvp-web/src/app.tsx` 的 QR 扫码区 + `?pair=` 自动配对、`apps/mvp-web/e2e/qr.spec.ts`（3 项） | E2E 3/3 通过 |
| 9 | CI workflows | `.github/workflows/verify.yml`（PR+main，typecheck+test）、`browser-e2e.yml`（main/labeled PR/dispatch，playwright chromium，工件上传）、`dependency.yml`（周审计） | YAML 已校验（js-yaml 解析通过）；CI 真实运行待 GitHub Action 触发验证 |

### 跨切配套

- Token-claim 文件计数器（`FLYX_E2E_CLAIM_FILE`）解决 Playwright worker 重启后 token 耗尽问题；
- Orchestrator 公开 `ingestAdapterEvent()`，供 DeterministicAdapter 注入，复用 Host 的 durable 管道；
- `.gitignore` 增加 `.flyx-e2e/`、`.flyx-evidence/`、`e2e/.artifacts/`、`playwright-report/`。

## 3. E2E 覆盖现状（18/18 全绿）

| Spec | 数 | 覆盖场景 |
|---|---|---|
| `mvp.spec.ts` | 12 | 1,2,3,4,5,6,7,8,11,12,16 + replay token + refresh replays + logout + page-close |
| `qr.spec.ts` | 3 | QR 渲染 / `?pair=` 自动配对 / 匿名路径安全 |
| `resilience.spec.ts` | 3 | 13 (SIGKILL mid-Turn → outcome_unknown) / 14 (crash 审批 → supersede + recovery event) / WSS 30s 分区 → 无序列间隙 |

另有 Host integration test 覆盖场景 10（duplicate commandId replay 与拒绝重用）。

## 4. Phase 2 剩余任务（全部未开始）

按文档 §9.1–§9.4 与退场标准，Phase 1 Go 后启动：

P0：
- 协议 hello / 版本范围协商（`protocolVersion` 仍为 `z.literal(min,max)` 待扩展）
- Host lifecycle（`src/lifecycle/` 不存在）
- ProviderRuntimeRegistry（`src/provider/` 不存在）
- SQLite migration / 备份
- `packages/client-core/` 抽取（app.tsx 625 行未拆）

P1：
- 诊断/指标
- Host identity / endpoint hello
- 设备注册与 revoke
- 协议 codegen 评估
- §10.1 九组测试矩阵

## 5. 推荐下一步

1. **按 runbook 跑一次 Tailscale 真机验收**（人工），把报告归档到 `.flyx-evidence/tailscale/<日期>/REPORT.md`，作为 Phase 1 退场证据的最后一环。
2. **拉一次真实 CI**（push to main with `run-e2e` 标签到 PR）验证三条 workflow 真实可跑通。
3. **Go 门槛证据收集**（设计 §5.9）：真实 Turn 30 / approval 10 / interrupt 10 / 刷新与断网各 10 次——基础设施已就绪，证据归档路径已创建。
4. Phase 2 P0 按上述顺序启动。

## 6. 风险与注意事项

- `packages/claude-fixtures` 仍是嵌套 git 仓库，外层不追踪；CI 需单独 clone 或改为 submodule（browser-e2e.yml 已在 `RUNNER_TEMP` 自建 fixture workspace 绕过该限制）。
- Playwright 锁 1.61.1 是为了复用本机缓存；CI 上无此约束，如需升级可随时调整 browser-e2e.yml。
- 真实 Token、Cookie、Prompt 原文仍禁止写入工件/报告（runbook 已明示）。
- 「outcome_unknown」产品 Gap（scenario 13/14 锁定 session 后无法发新 TURN）在 resilience.spec.ts 中已显式注释为 "PRODUCT GAP, asserted as current behavior"；修复（acknowledge/repair 路径）属于 Phase 2 范畴。
