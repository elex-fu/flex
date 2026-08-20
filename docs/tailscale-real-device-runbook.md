# Tailscale 真机验收 Runbook

> 本 runbook 对应《移动远程多 Agent 产品技术设计》接收标准（Phase 1B 退回 + §2548 Tailscale HTTPS/WSS）。
> 目标：**在本机 Host  Tailscale tailnet 可达后，用真实手机构端到端验证 "Claude-only MVP 通过 Tailscale HTTPS 受控访问" 的闭环可用性**，并把每项验收的证据归档到 `.flyx-evidence/tailscale/`，作为 Phase 1 Go 门槛的可审计输入。

本 runbook 是 **人工测试 guiding 文档**——Playwright 无法覆盖真机 / 真实移动网络 / 真实 Tailscale 隧道。所有命令都在本机 Host 上执行，除非特别说明。

---

## 1. 前提与工具

| 项目 | 版本/要求 | 用途 |
|---|---|---|
| 本机 Host | macOS / Linux，Node 24，pnpm 10 | 运行 Flyx Host |
| `tailscale` CLI | 已登录 tailnet，且 tailnet 权限允许手机加入 | 提供稳定 FQDN 与 HTTPS 隧道 |
| 手机浏览器 | iOS Safari 17+ / Android Chrome 120+（推荐安装为 PWA 后再验收） | 被验收端 |
| 同一 tailnet 中的手机 | 加入同一 tailnet | 提供“远程 / 第二条网络路径”视角 |
| `flyctl`（可选） | 仅在需要 MagicDNS / HTTPS 证书未自动签发时使用 | 启用 MagicDNS + HTTPS |

**证据目录**：测试前创建 `./.flyx-evidence/tailscale/`，并在每项验收后以 `<项编号>-<slug>/` 形式归档日志、截图与 Host/Client header 捕获。该目录已在 `.gitignore`，不会进源码。

---

## 2. 环境准备

### 2.1 Tailscale 基础就绪

在 Host 执行：

```sh
tailscale status              # 确认已登录同一 tailnet，手机也在其中
tailscale ip -4               # 记录 Host 的 Tailscale IPv4（下文写作 <ts-ip>）
tailscale status --self --json | jq .Self.DNSName   # 记录 MagicDNS 名称（下文写作 <ts-dns>，不含尾随 "."）
```

**验收前提 A（先决）**：

- [ ] `tailscale status` 输出中本机的 `Self.Online == true`
- [ ] `tailscale ping <手机 tailscale IP>` 双向可达，RTT < 100ms
- [ ] MagicDNS 已在 tailnet 开启（`tailscale status` 中 DNSName 非空）；否则 `flyctl tailscale set --magic-dns=true` 或 admin console 开启

### 2.2 在 Tailscale interface 上启动 Host

Flyx Host 默认只监听 loopback；**真机验收必须绑定 tailnet 接口**。MVP Host 当前通过 `FLYX_BIND` 控制监听地址（默认 `127.0.0.1`）；真机验收切换到 `<ts-ip>` 或 `0.0.0.0`。

记录并执行：

```sh
cd /Users/lex/play/flyx
pnpm -r install
pnpm --filter @flyx/mvp-host run build
pnpm --filter @flyx/mvp-web run build

# 选择其一：
#  - 仅 tailnet 接口
FLYX_BIND="<ts-ip>" pnpm --filter @flyx/mvp-host run start
#  - 全部接口（loopback 也保留，便于本机自检）
FLYX_BIND="0.0.0.0" pnpm --filter @flyx/mvp-host run start
```

> 若当前 MVP 实现尚未暴露 `FLYX_BIND`，先用 "保留 loopback + 反向代理到 tailnet" 过渡——附录 A 给出一份最小 `caddy` / `tailscale serve` 反代配置。Host 启动后日志中应出现 `FLYX_READY base=http://<ts-ip|localhost>:<port>/ pairing=http://.../pair?grant=...` 配对 URL。

### 2.3 HTTPS 通道

设计 §1429 指定 Phase 1 内测默认采用 **Tailscale HTTPS + 稳定 MagicDNS**。达成路径按优先级：

1. **首选：Tailscale Serve**——将 Host 作为 plaintext HTTP service 在 tailnet 内通过 `tailscale serve` 暴露为 `https://<ts-dns>`，由 Tailscale 自动签发 tailnet-scoped 证书。
2. **次选：MagicDNS 自签FQDN**——通过 `tailscale cert <ts-dns>` 取 cert/key，Host 用它们启动 HTTPS listener。

无论哪条路径：

- [ ] 浏览器访问 `https://<ts-dns>:<port>/` 应看到 Flyx Host 首页，证书为 Tailscale 签发的有效证书
- [ ] 检查证书 SAN 包含 `<ts-dns>` 或 `<ts-ip>`，过期时间 > 30 天
- [ ] 归档：`openssl s_client -connect <ts-dns>:<port> -servername <ts-dns> </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates -ext subjectAltName` 的完整输出 → `.flyx-evidence/tailscale/01-https-channel/cert.txt`

> iOS Safari 只信任系统根证书；Tailscale 根在加入 tailnet 时通过配置描述文件安装（iOS）或在设备上信任（Android）。若手机未主动信任 tailnet 根，会产生证书错误——这种错误记录在案并在报告中标注 tailnet 信任状态。

### 2.4 证据占位

```sh
mkdir -p .flyx-evidence/tailscale/{01-https-channel,02-pairing,03-timeline-e2e,04-network-resilience,05-prod-gap}
```

---

## 3. 验收项

### E1. Tailscale HTTPS 可达 + 前端资源加载（phase-gate）

**条目**：手机（同 tailnet、另一子网段）通过 `https://<ts-dns>:<port>/` 能完整加载 Flyx Web UI，无混合内容 / CORS / WSS 证书错误。

**步骤**：

1. 手机开启飞行蜂窝、关闭 Wi-Fi，**仅靠 tailnet** 连接；若 tailnet 隧道需要上游，改用 Wi-Fi + 退出企业 VPN 的真实远端网络。
2. 打开 `https://<ts-dns>:<port>/`。
3. 在 Host 抓包确认服务收到请求：`tcpdump -i tailscale0 -n port <port>` 或观察 Host 日志 `access` 行。

**PASS 条件**：

- [ ] 屏幕显示 "连接电脑 Host" 配对页面（未配对前 landing）
- [ ] 浏览器开发者工具 console 无 TLS / 混合内容报错
- [ ] 归档：手机截图 + Host 访问日志行 + TCPDUMP 时间戳 → `01-https-channel/`

### E2. 真实扫码配对（scenario 9 核心）

**条目**：手机上通过 `https://<ts-dns>:<port>/pair?grant=<token>` 的一次性扫码配对，30 秒内完成配对并进入 "执行 Timeline" 页面，且可验证 host key pinning 显示。

**步骤**：

1. 手机摄像头扫描 Host 日志输出的配对 QR（或在浏览器中打开配对 URL）。
2. 配对完成后，用不同的 origin/host 再次打开同一会话，确认 cookie 作用域被限制在 tailnet origin。

**PASS 条件**：

- [ ] 30 秒内进入 "执行 Timeline"
- [ ] Host 日志显示 `pairing.exchange.*subject=phone-<id>` 与 `auth.session.*created`
- [ ] 归档：视频/GIF 配对手册 + Host access log → `02-pairing/`

### E3. Tailnet 中的完整 Turn 闭环

**条目**：在手机端输入任一 prompt（如"列出当前目录"），从发起请求到看到完整 Timeline 项（包括 `user.message.created` / `turn.started` / `provider.session.init` / `assistant.message.delta` / `turn.completed`）。

**步骤**：

1. 使用本机自检的 deterministic 场景或真实 Claude 会话均可；若用真实 Claude 需要 CLAUDE_API_KEY。
2. 输入 `scenario:text`（deterministic）或自然语言。
3. 记录事件序列，与 E2E 套件 `mvp.spec.ts` 的断言序列对比。

**PASS 条件**：

- [ ] 输入后 3 秒内 `turn.started` 在 timeline 可见
- [ ] `assistant.message.delta` 流式增量渲染（tailnet RTT 下不超过 200ms 一颗事件）
- [ ] `turn.completed` 在 5 秒内盖落
- [ ] 归档：timeline 截图 + `/api/session/:id/timeline` 响应体 → `03-timeline-e2e/`

### E4. Tailnet 网络韧性（scenario 13/14 的远程版本）

**条目**：当手机与 Host 之间网络抖动/断开，重新连回同一 tailnet 后 Timeline 同步恢复无重复/无间隙 (sequence contiguous)。**注意：此处的 "断网" 是手机端飞行模式 / 路由器重启，而不是 Host SIGKILL。**

1. 手机端关闭飞行蜂窝（断开与 tailnet 的路由），保持 Host 活跃。在 Host 端发起一个 `scenario:slow`（deterministic 8s 长 Turn）。
2. 在 Turn 执行期间手机飞行 30 秒以上；Turn 完成后再关闭飞行。
3. 等待 Flyx Web 自动重连（retry 退避），检查 timeline 序列。

**PASS 条件**：

- [ ] 重连后 timeline 事件序列号连续（连续整数）——这是 Flyx 的核心不变量
- [ ] 没有重复的 `assistant.message.delta` 事件
- [ ] 最终 `turn.completed` 正常落盘
- [ ] 对比 Host 端 SQLite 的 `events` 表 sequence 与前端渲染 IDs 一致
- [ ] 归档：手机飞行/恢复的时间轴截图 + Host `events` 表导出 → `04-network-resilience/`

### E5. 产品 Gap 验证（明确失败路径）

**条目**：验证 scenario 13/14 中暴露的 "terminal outcome_unknown 锁住 session 无法发新 Turn" 的 Product Gap，在 Tailscale 路径下行为与 loopback 一致（两者都应锁住）。

1. Host SIGKILL 一个 running turn 后重启并保持 DB（参考 resilience.spec.ts）。
2. 手机重新打开 UI，确认：
   - [ ] timeline 出现 "Host restarted while this Turn was executing; result is unknown and it was not replayed."
   - [ ] 输入框 disabled
   - [ ] `/api/snapshot` `activeTurn.status == outcome_unknown`
3. **关键观察项（Gap 描述）**：通过 tailscale HTTPS 路径重连的 "产品 gap" 是否与 loopback 一致——如果远程路径有显著差异（如 session cookie 丢失需要重配对），则是 Phase 1B 的真实产品 Gap，需在 §5 报告。

**归档**：截图 + apiSnapshot 调用 log → `05-prod-gap/`

---

## 4. 报告模板

> 执行完本章所有项后，把证据拷贝到 `.flyx-evidence/tailscale/<日期>/REPORT.md`，填写以下模板。

```markdown
# Tailscale 真机验收报告 - <YYYY-MM-DD>

- Host 机器: <主机名 / OS>
- Host tailscale IP: <ts-ip>
- Host MagicDNS: <ts-dns>
- Host Flyx 绑定: FLYX_BIND=<...>
- 手机设备: <机型 / iOS|Android 版本 / WebView>
- 网络路径: 同 tailnet / 跨 subnet / 公网
- tailnet 根证书信任: 已描述文件 / 已手动 / N/A

## 结果矩阵

| 编号 | 条目 | 结果 | 备注 |
|---|---|---|---|
| E1 | Tailscale HTTPS 可达 | PASS / FAIL / PARTIAL | |
| E2 | 真实扫码配对 | PASS / FAIL | |
| E3 | 完整 Turn 闭环 | PASS / FAIL | |
| E4 | 网络韧性（重连） | PASS / FAIL | |
| E5 | 产品 Gap 行为 | PASS / FAIL | |

## 中断条件

- 任何 E1/E2 FAIL 直接阻塞后续项；E1/E2 是 phase-gate。

## 阻塞 / 风险

- ...

## 结论

- [ ] Phase 1 Go 门槛达成（E1/E2/E3 PASS）
- [ ] E4/E5 通过，可用于生产化验收
- [ ] 存在产品 Gap，需要 ... 修复
```

---

## 5. 附录 A：Tailscale Serve 反代配置（仅 FLYX_BIND 未暴露时使用）

```bash
# 启用 MagicDNS
tailscale set --magic-dns

# 将本机 <port> 作为 http 服务 serve 到 tailnet https
tailscale serve --bg --https=443 http://127.0.0.1:<web-port>

# 查看分配给的 FQDN
tailscale status --self --json | jq '.Self.DNSName'
```

此时 Host 仍然只监听 loopback，但浏览器使用 `https://<ts-dns>` 可达；所有 tailnet 内设备共享同一 MagicDNS，无需额外界该 Host。该路径与 §1429 直接吻合。

## 附录 B：调试清单

- 手机 telnet 验证连通：`nc -vz <ts-ip> <port>`（iOS 用 Network Utility / Android 用 Termux）。
- Host 侧抓包：`tcpdump -i tailscale0 -w .flyx-evidence/tailscale/capture.pcap port <port>`。
- Host 日志增加请求 id：在 Host 启动前 `FLYX_LOG=request`（若支持）以关联手机与 Host。
- Tailscale 诊断：`tailscale bugreport` 若需要上报 tailnet admin 协助，勿直接贴公共 git log。
