# Tailscale 真机验收 Runbook

本 runbook 覆盖[网络连通与 E2EE Relay 技术方案](network-connectivity-and-e2ee-relay-technical-design.md) Gate A，记录真实手机上的配对、Turn、审批、中断及断网补同步证据。Claude Code 与 Codex 使用同一网络检查。Provider 认证和兼容版本参照[双 Provider 技术方案](dual-provider-remote-control-technical-design.md)。自动化通过不能代替真机结果。

## 1. 准备与启动

- Host：Node.js 22+、仓库指定的 pnpm 版本、已安装并认证的 Provider、已有 Git 工作区。
- Host 与手机加入同一 tailnet；在 Tailscale 管理端启用 MagicDNS 和 HTTPS。手机保持 Tailscale VPN 已连接。
- 手机：iOS Safari 或 Android Chrome，记录系统、浏览器版本和是否使用 PWA。
- Host 始终监听 `127.0.0.1`，外部 HTTPS/WSS 由 Tailscale Serve 提供，TLS 在本机 Tailscale daemon 终止。此路径不需要公网入站端口。

在仓库根目录执行：

```bash
tailscale status
tailscale status --json
tailscale serve --bg --https=443 http://127.0.0.1:4173
tailscale serve status --json

# 默认 Claude；如需 Codex，增加 FLYX_PROVIDER=codex。
FLYX_CONNECTIVITY_MODE=tailscale pnpm start:host
```

启动时只读检查 Serve JSON 的 `TCP`、`Web`、`Handlers`、`AllowFunnel` 和 `Foreground`。合格配置必须具有 HTTPS listener、完整的 `device.tailnet.ts.net` FQDN、根路径代理 `http://127.0.0.1:4173`，并关闭该 Host 的 Funnel 暴露。非 loopback、错误端口、明文 HTTP、覆盖 API 的其它路径代理、无法确定的 schema 均拒绝启动。

Host 使用其它 `PORT` 时，Serve target 必须同步修改，例如：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4174
PORT=4174 FLYX_CONNECTIVITY_MODE=tailscale pnpm start:host
```

Host 从唯一合格 listener 发现 public origin。如果存在多个合格 origin，明确选择实际 Serve 输出的域名：

```bash
FLYX_CONNECTIVITY_MODE=tailscale \
FLYX_PUBLIC_BASE_URL=https://workstation.example-tailnet.ts.net \
pnpm start:host
```

Public URL 仅接受 HTTPS origin，可省略或保留末尾 `/`，不允许用户名、密码、路径、query 或 fragment；显式配置同样必须通过 Serve 校验。兼容入口 `FLYX_REQUIRE_TAILSCALE_SERVE=1` 也会启用必需的 Serve 检查。

Serve CLI 和证书行为以 [Tailscale Serve 文档](https://tailscale.com/docs/reference/tailscale-cli/serve)为准。有效 HTTPS 证书由 Serve 自动配置；不要安装未知根证书或忽略浏览器 TLS 错误来通过验收。

## 2. 配置与本机管理

| 配置 | 行为 |
| --- | --- |
| `FLYX_CONNECTIVITY_MODE=local` | 默认；不查询 Tailscale，可使用显式 HTTPS origin。无远程 endpoint 时只适用于本机。 |
| `FLYX_CONNECTIVITY_MODE=tailscale` | Serve 必须有效，发现或校验 HTTPS origin。 |
| `FLYX_CONNECTIVITY_MODE=relay` | 必须显式开启 Relay feature flag，并配置 Relay 与 Hosted App。 |
| `FLYX_CONNECTIVITY_MODE=auto` | 尝试唯一 Serve discovery；未配置或 CLI 不可用时保留本机/已启用的 Relay。已发现的不安全或歧义配置仍阻止启动。 |
| `FLYX_IDENTITY_DIR` | 默认是数据库所在目录下的 `identity`，存放独立于 SQLite 的 Host 身份。 |
| `FLYX_ALLOW_INSECURE_HTTP=1` | 仅允许 `local` 模式的 loopback 调试，不能与远程 endpoint 或 Relay 同用。 |

不要在真机验收时开启不安全 HTTP。本机调试的显式命令是：

```bash
FLYX_CONNECTIVITY_MODE=local FLYX_ALLOW_INSECURE_HTTP=1 pnpm start:host
```

身份目录权限为 `0700`，文件为 `0600`，私钥不进入 SQLite、日志或 QR。持久数据库已有身份镜像时，身份丢失或 fingerprint 不匹配会阻止启动；不要删除身份文件绕过错误。数据库与对应身份应分别安全备份，恢复时成对核对。

管理命令使用现有 `FLYX_DB` 和 `FLYX_IDENTITY_DIR`，不会启动 Provider、监听网络或恢复运行中的 Turn：

```bash
pnpm start:host identity show
pnpm start:host devices list
pnpm start:host devices revoke <deviceId>
pnpm start:host devices revoke-all
pnpm start:host identity rotate
```

`identity rotate` 必须在本机终端输入 `rotate` 确认，保持 `hostId`、替换密钥并撤销旧设备；之后重启 Host 并重新配对。撤销设备会关闭活动连接，跨进程关闭检查周期为 1 秒。同一身份目录若用于多个数据库，轮换后其它数据库的旧 fingerprint 会触发 mismatch；需要核对并明确处理对应镜像，不能静默接受新密钥。

## 3. 验收与证据

在 `.flyx-evidence/tailscale/<日期>/` 保存已脱敏的 Serve 配置、设备版本、截图、时间线和报告。配对 fragment/grant、cookie、刷新凭证、身份私钥和完整 Provider 提示内容不要进入可共享日志。

### E1. HTTPS 页面与 WebSocket

手机关闭 Wi-Fi，启用蜂窝数据并保持 Tailscale VPN。访问 Host 输出的 `https://<FQDN>/`，不要把 HTTP 端口 `4173` 加到此 URL。

- 页面和静态资源完整加载，证书有效且域名匹配，无混合内容或 CORS 错误。
- WebSocket 使用相同 public origin 的 WSS，连接后没有重连循环。
- 另一设备不能直接访问 Host 的 LAN 地址和 `4173` 端口，Host listener 仍是 loopback。

证据：手机截图、Serve JSON（脱敏）、浏览器 Network 中的 HTTPS/WSS origin 和连接状态。本机查询 Host listener，不把 tailnet IP 的明文 HTTP 可达当作通过条件。

### E2. 扫码、单次 grant 与身份固定

Host 在交互终端本地生成 QR，内容为 `https://<FQDN>/#pair=<payload>`，不调用外部 QR 服务；非交互日志不打印链接。Payload 包含 Host ID、公钥与 fingerprint、endpoint、五分钟有效的单次 grant，不含私钥。

1. 手机扫描 QR（或打开终端链接），在 Host 终端 60 秒内输入 `y` 确认。
2. 确认进入会话，客户端显示/保存的 Host 身份与本机 `identity show` 一致。
3. 导入 fragment 后立即清理地址栏；静态页面 GET、访问日志和 Referer 不含 grant。
4. 在另一浏览器重用已消费链接必须失败；过期链接必须失败。拒绝 Host 提示不得颁发凭证。
5. 使用错误 Host key 或变更 fingerprint 的配置，确认客户端拒绝并要求人工重新配对。

证据：已遮挡 QR/grant 的配对截图、清理后的地址栏、单次/过期/拒绝结果，以及匹配的公开 fingerprint。

### E3. Turn、审批与中断

使用已认证的真实 Claude 或 Codex，记录 Provider/版本。依赖各自官方 CLI 认证，不用任意环境变量代替 preflight。

1. 发送简单只读任务，观察流式 Timeline 和最终状态。
2. 发起需要命令或文件写入的任务，分别验证一次性允许与拒绝；未批准前不能执行操作。
3. 发起持续任务并从手机中断，确认进入终态，之后能发送新任务。

证据：操作时间戳、会话与 Turn ID、审批结果、最终 Timeline。实际 Provider 时延单独记录，不把固定几秒完成作为网络正确性的替代证据。

### E4. 断网、后台与路径恢复

1. 持续 Turn 期间让手机飞行 30 秒，Host 保持运行；再恢复蜂窝数据和 Tailscale。
2. 运行 Turn 时从 Wi-Fi 切蜂窝，再切回 Wi-Fi。
3. 页面置于后台后返回；另空闲 30 分钟，再发起一次只读操作。

- 手机断连不取消 Host 上正在运行的 Turn。
- 自动重连先恢复快照/watermark，再补同步；Timeline sequence 无间隙、无重复项，命令不重复执行。
- 记录恢复耗时（目标 10 秒）；若系统冻结后台计时器，单独记录页面可见性时间。
- 空闲首次操作成功，或经一次自动重连后恢复；无需重新配对。

证据：网络切换时间、重连状态、相关 sequence 与 Host 持久化记录。手机断网与 Host 崩溃分开测试；Host 崩溃时不可自动重放结果未知的写命令。

### E5. 登出、撤销与故障关闭

1. 同一设备开两个页面，登出后确认该设备所有活动连接关闭。
2. 重新配对，本机执行 `devices revoke <deviceId>`；旧 cookie/凭证与活动 WebSocket 失效，其它设备仍可用。
3. 在独立测试环境验证错误端口、明文 listener、Funnel 配置阻止启动；不要为测试将真实 Host 暴露到公网。
4. 使用测试副本验证身份缺失/不匹配时 fail closed，不修改正式身份。

证据：设备 ID、撤销提交与关闭时间、失败码和其它设备可用性。

## 4. Relay Alpha 与回滚

Relay 默认关闭。有可用的 Hosted App 与 Relay 部署后显式启用：

```bash
FLYX_CONNECTIVITY_MODE=auto \
FLYX_RELAY_ENABLED=1 \
FLYX_RELAY_URL=wss://relay.example.com \
FLYX_HOSTED_APP_URL=https://app.example.com \
pnpm start:host
```

托管 Relay 如需注册凭证，设置 `FLYX_RELAY_REGISTRATION_TOKEN`，不要写入配对链接或仓库。Relay URL 为 WSS origin，Hosted App 为 HTTPS origin。Host 出站注册路由，Relay offer 以 Hosted App fragment 展示；另行执行技术方案的蜂窝网络、E2EE、重放、配额和 Direct/Relay 切换验收。

回滚时关闭 `FLYX_RELAY_ENABLED`，保留身份和设备数据库，用 `FLYX_CONNECTIVITY_MODE=tailscale` 重启。不要删除身份或 SQLite 新表来回滚网络路径。不再使用 Serve 时按实际配置关闭：

```bash
tailscale serve --https=443 off
```

## 5. 报告模板

```markdown
# Tailscale 真机结果 — <日期>

- Host OS / Node / Tailscale / Provider 版本：
- 手机系统 / 浏览器 / PWA：
- Host ID / 公开 fingerprint：
- 网络：Wi-Fi / 蜂窝 + Tailscale
- Host loopback 端口 / HTTPS origin（脱敏）：

| 项目 | PASS / FAIL / 未执行 | 证据与观察 |
| --- | --- | --- |
| E1 HTTPS/WSS | | |
| E2 配对/身份固定 | | |
| E3 Turn/审批/中断 | | |
| E4 断网/后台/空闲 | | |
| E5 登出/撤销/故障关闭 | | |

- 恢复耗时：
- Timeline 与命令幂等核对：
- 尚未验证的设备或路径：
- Gate A 结论（全部 E1–E5 通过才填写通过）：
```
