# Flyx

从手机安全控制本机 Claude Code 或 Codex CLI 的实验性 Host/Web MVP。

```bash
# Claude Code（默认）
FLYX_PROVIDER=claude pnpm start:host

# Codex CLI
FLYX_PROVIDER=codex pnpm start:host
```

Host 只绑定 loopback；跨设备访问应使用 Tailscale Serve 提供 HTTPS/WSS。开发分支主入口先打开 Catalog、历史与恢复服务，不在配对或切换会话时启动 Provider。工作区、Provider 与进程契约未经验证时，执行保持不可用；当前主入口和确定性测试不能替代真实双 Provider、托管 Git 与手机验收。

空库启动会原子创建一个完整的默认 Session。已有 Session 保留原来的工作区和 Provider 绑定，`FLYX_PROVIDER`、`FLYX_WORKSPACE` 不会改写它们。多资源配置使用 Host 本地的 `FLYX_CATALOG_CONFIG` JSON 文件；首次启动多个资源时，另设 `FLYX_LEGACY_WORKSPACE_ID` 和 `FLYX_LEGACY_PROVIDER_INSTANCE_ID`。已有库尚无固定默认时，通过配置中的 `legacyDefaultSessionId` 或 `FLYX_LEGACY_DEFAULT_SESSION_ID` 明确选择既有 Session。

手机接入的启动方式：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4173
FLYX_CONNECTIVITY_MODE=tailscale pnpm start:host
```

Host 校验 Serve 的 HTTPS listener、MagicDNS FQDN、loopback 目标端口及非 Funnel 模式，发现唯一 public origin 后在本机终端生成配对 QR。多个 listener 时用 `FLYX_PUBLIC_BASE_URL=https://<device>.<tailnet>.ts.net` 明确选择。扫码后在 Host 终端输入 `y`；grant 五分钟有效、只能消费一次，URL fragment 会在页面导入后清除。

Host 身份独立保存在数据库目录下的 `identity/host-identity.json`（可用 `FLYX_IDENTITY_DIR` 指定），设备凭证和连接 lease 支持撤销。使用 `pnpm start:host devices list` 查看设备，`pnpm start:host devices revoke <deviceId>` 撤销访问；`pnpm start:host identity rotate` 在本机确认轮换密钥并使旧设备重新配对。

Relay 是显式 feature flag：配置 `FLYX_RELAY_ENABLED=1`、`FLYX_RELAY_URL=wss://<relay-origin>`、`FLYX_HOSTED_APP_URL=https://<app-origin>`，并选择 `FLYX_CONNECTIVITY_MODE=relay` 或 `auto`。Relay 配对链接以 fragment 导入 Host 公钥与路由，业务通信使用端到端加密。默认不开启 Relay；`auto` 可结合可用的 Tailscale endpoint。配置细节、真机验收与回滚见 [Tailscale Runbook](docs/tailscale-real-device-runbook.md) 和[网络连通与 E2EE Relay 方案](docs/network-connectivity-and-e2ee-relay-technical-design.md)。

Codex 模式默认只开放命令执行和文件变更，并关闭本机已配置的 Apps、插件、MCP、浏览器、Web Search 与多智能体能力；命令或写入仍通过手机审批闭环。

详细架构、协议映射、安全边界和验证矩阵见 [双 Provider 远程控制技术方案](docs/dual-provider-remote-control-technical-design.md)。

下一阶段的核心交付以 [核心能力技术方案](docs/core-capabilities-technical-design.md) 为准：macOS 本机执行契约、显式激活、原始恢复、Session/Worktree、精确 Diff/回退和 Web/手机最小闭环。方案含具体接口、迁移、C0–C8 批次和验收矩阵；macOS 监督候选尚未取得可用性证明。

与本地 Paseo、T3 Code 的历史实现差异和架构依据见 [能力差异与优化技术方案](docs/paseo-t3code-comparison-and-optimization-technical-design.md)。

具体函数改造、数据迁移、RPC 契约、18 个实施批次与故障验收见 [分阶段实施方案](docs/flyx-optimization-implementation-plan.md)。

验证入口使用确定性 Provider，不会打开真实 Provider 用例：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r rebuild better-sqlite3 esbuild
pnpm build
pnpm typecheck
pnpm typecheck:tests
pnpm test:product
pnpm test:fixtures
pnpm verify:clean
```

`pnpm test` 等同于 `test:product`，先构建本工作树的共享依赖，再运行产品测试。
`test:fixtures` 必须观察到 retry 夹具的一次预期边界失败；夹具被修好或出现其他失败都会拒绝通过。
`verify:clean` 在临时副本中排除已有 dist 和 node_modules，执行离线 frozen install、原生重建、构建、两类 typecheck 和测试，并核对构建前后的源码测试发现结果。它保留原工作区的已有构建产物；首次使用前应先安装依赖以填充 pnpm 缓存。
浏览器用例固定使用 Chromium，由 CI 安装；本地安装命令为 `pnpm --filter @flyx/mvp-web exec playwright install chromium`。
