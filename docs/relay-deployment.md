# Flyx Relay 部署与验收

实现入口为 `apps/mvp-relay/src/cloudflare/worker.ts`，共享转发核心为 `apps/mvp-relay/src/relay-room.ts`。Cloudflare 和 Node 使用同一套控制消息、二进制转发、generation 检查和 ACK 背压；Relay 不执行 Flyx RPC 或 Noise 握手。

2026-09-08 已完成适配器单元测试、TypeScript 检查、Wrangler 4.129.0 构建预检和本地 workerd WebSocket 实测。尚未向 Cloudflare 账号发布，也没有获得真实移动网络的延迟、可用性或成本数据。下面的 SLO 是上线门槛，不是实测承诺。

## 拓扑与持久化边界

一个 `routeId` 对应一个 `RelayRouteObject`；Host control、Host data 和 Client 都作为入站 WebSocket 接入该对象。独立的 `RelayQuotaObject` 按来源 IP 的 SHA-256 名称统计建连和注册请求，另有一个全局注册预算对象。

| 位置 | 保存内容 | 不保存内容 |
| --- | --- | --- |
| Route Object storage | routeId、credential SHA-256、创建时间、control generation、心跳 challenge、速率窗口计数 | 原始 credential、业务 frame、Noise key |
| WebSocket attachment | role、socket/connection ID、generation、时间、ACK sequence/字节计数、入站计数 | Prompt、Diff、明文、密文、待转发消息 |
| Quota Object storage | 最多三个固定类别的计数与过期时间 | IP 原值、请求路径、credential |
| Analytics Engine | 固定事件类别、数量/耗时、24 位十六进制 route hash | 原始 route/connection ID、URL、headers、frame |

IP hash 用于配额分组，不意味着 IP 不可推断；Relay 和 Cloudflare 仍可观察源 IP、连接时间、帧大小和时序。计数到期由 alarm 删除；route 的 verifier 和 generation 保留用于后续重连。

使用 `acceptWebSocket()`、`getWebSockets()` 和 attachment 恢复连接。对象重建时恢复 ACK 队列的序号和大小、设备对、control generation 与未完成的心跳 challenge；不重放业务内容。CLOSING socket 会先写关闭标记，避免旧 generation 因迟到的 close 事件被重新恢复。该流程遵循 [Cloudflare Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。

对象没有 `setInterval` 或应用定时器。活跃连接最多每 10 秒通过 alarm 检查超时，持续流量不会把已排定的 alarm 向后推。没有活动 socket 时取消 alarm。alarm 会产生调用费用；使用 Hibernation 不等于没有心跳成本。[Durable Object 生命周期说明](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

## 协议

| 请求 | 用途 | 认证 |
| --- | --- | --- |
| `GET /healthz` | Worker 存活检查 | 无；不证明 Host 在线 |
| `POST /v1/routes` | Host 创建随机 routeId，返回一次 `{v:1,routeId,relayCredential}`；携带任意 Origin 的浏览器请求一律拒绝 | 可选注册 Bearer token；否则必须显式允许匿名注册 |
| `GET /v1/routes/:routeId/control?generation=N` + Upgrade | Host 控制连接 | `Authorization: Bearer <relayCredential>` |
| `GET /v1/routes/:routeId/client` + Upgrade | Client 会合连接 | Relay 不做设备授权；由后续 E2EE 内 Host 授权 |
| `GET /v1/routes/:routeId/data/:connectionId?generation=N` + Upgrade | Host 对应 data 连接 | 同 control credential |

Control/data 的 generation 必须是正安全整数。重复、过期 generation 被拒绝；新的 control 返回现有 client connectionIds，Host 幂等重建缺失 data 连接。Client 必须等到 `data.paired` 才发第一条 Noise 二进制消息，避免 hibernation 丢失未配对缓冲。

每个物理 data/client socket 收到二进制帧后，发送 `{ "type": "ack", "sequence": N }`，累计序号从 1 开始。ACK 是 Relay 流量控制元数据，不是 Flyx 命令 receipt 或持久化确认。每条 socket 最多保留 1 MiB、256 个未确认二进制帧；超过时以 `RESYNC_REQUIRED` 关闭该 pair，其余客户端继续工作。Cloudflare 没有文档化的 `bufferedAmount` 指标，因此边界由共享核心的 ACK 计数落实；支持该属性的运行时还会叠加原生缓冲检查。[Cloudflare WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

禁止 query credential、任意额外 query、非法 role/path、压缩协商和 plaintext 公网请求。浏览器 Origin 必须精确匹配配置。Node/原生客户端可不发送 Origin，但 control/data 仍必须验证 credential。

## 配置

`apps/mvp-relay/wrangler.jsonc` 提供 `RELAY_ROOMS`、`RELAY_QUOTAS` 两个 SQLite Durable Object binding 和首版 migration。配置不包含账号、生产域名或秘密；`workers_dev` 与预览 URL 默认关闭。按真实域名添加 custom domain route 后才有公网入口。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `RELAY_ALLOWED_ORIGINS` | 空 | 逗号分隔的精确 Hosted App HTTPS origins；空值拒绝所有浏览器 Origin |
| `RELAY_REGISTRATION_TOKEN` | 未设置 | 可选 256-bit base64url 注册口令，使用 Wrangler secret 保存 |
| `RELAY_ALLOW_ANONYMOUS_REGISTRATION` | `false` | 没有注册口令时是否允许创建 route |
| `RELAY_ALLOW_INSECURE_LOCAL` | `false` | 仅允许 `localhost`/`127.0.0.1`/`::1` 的 HTTP 开发 |
| `RELAY_MAX_CREATES_PER_IP_HOUR` | `5` | 每来源每小时注册上限 |
| `RELAY_MAX_CREATES_PER_DAY` | `1000` | 全局每天注册上限 |
| `RELAY_MAX_CONNECTS_PER_IP_MINUTE` | `120` | 每来源每分钟 WebSocket 建连上限 |
| `RELAY_MAX_CLIENTS_PER_ROUTE` | `32` | 每 Host 最多同时存在的 Client pairs |
| `RELAY_MAX_CONNECTS_PER_ROUTE_MINUTE` | `120` | 每 route 每分钟建连上限，hibernation 不重置 |
| `RELAY_MAX_FRAMES_PER_SOCKET_SECOND` | `128` | 每 socket 每秒消息数，包含 ACK/control |
| `RELAY_MAX_BYTES_PER_SOCKET_SECOND` | `1048576` | 每 socket 每秒入站字节数 |
| `RELAY_MAX_ROUTE_BYTES_PER_SECOND` | `8388608` | 每 route 每秒全部入站字节数 |
| `RELAY_IDLE_TIMEOUT_MS` | `90000` | Data/client 活动超时 |
| `RELAY_PENDING_TIMEOUT_MS` | `15000` | Client 等待配对超时 |

控制帧上限 64 KiB；密文帧上限 256 KiB + 1024 bytes 协议余量；control 每 10 秒发 challenge，30 秒没有有效心跳则关闭。Device scope、单设备限流和撤销由 Host 在 E2EE 内执行，Relay 不可读取设备身份。

来源配额只信任 Cloudflare 注入的 `CF-Connecting-IP`，不信任 `X-Forwarded-For`。显式本地模式没有该 header 时共享 `local` 配额桶。生产缺失来源信息或配额存储不可用时返回 503。

## 本地验证

在仓库根目录执行：

```bash
rtk proxy pnpm --filter @flyx/mvp-relay typecheck
rtk proxy pnpm --filter @flyx/mvp-relay test
rtk proxy pnpm --filter @flyx/mvp-relay exec wrangler deploy --dry-run
```

启动本地 Worker，显式启用 loopback HTTP 和测试注册：

```bash
rtk proxy pnpm --filter @flyx/mvp-relay exec wrangler dev \
  --local --ip 127.0.0.1 --port 8787 --log-level error \
  --var RELAY_ALLOW_ANONYMOUS_REGISTRATION:true \
  --var RELAY_ALLOW_INSECURE_LOCAL:true
```

在另一个终端运行：

```bash
rtk proxy pnpm --filter @flyx/mvp-relay exec tsx src/cloudflare/smoke.ts
```

Smoke 只接受 loopback HTTP 地址，不会意外创建生产 route；只输出检查类别。它验证真实 workerd 的注册、Host credential、client/data 配对、双向 binary、ACK、心跳、control 替换与过期 generation 拒绝。每次运行消耗一个本地注册配额；连续超过 5 次可在测试 Worker 上临时提高 `RELAY_MAX_CREATES_PER_IP_HOUR`。不应通过修改生产限额来运行测试。

`src/cloudflare/route.test.ts` 和 `quota.test.ts` 覆盖强制对象重建后的状态恢复、ACK 背压、慢客户端隔离、未知 attachment、心跳 challenge、generation fence、来源/route 限流、Origin、秘密未持久化和 alarm 不被持续流量推迟。本地 smoke 没有证明对象实际被 Cloudflare 从内存回收，不能替代真实平台的 hibernation/发布恢复测试。

Wrangler 本地状态位于 package 的 `.wrangler/`（已忽略）；测试 route verifier 只存在本地，用户可保留用于复现。不要把 `.dev.vars` 或 Host 的 relay-registration 私有文件加入版本控制。

## 发布

1. 将真实 custom domain 加到 Wrangler `routes`，例如 `{ "pattern": "relay.example.net", "custom_domain": true }`；设置真实 `RELAY_ALLOWED_ORIGINS`，保留生产 insecure 开关为 `false`。
2. 选定 Cloudflare 账号并配置部署凭证。使用独立 staging Worker/namespace；不要把本地或 staging binding 指向 production DO。
3. 选择受限注册方式：通过 `wrangler secret put RELAY_REGISTRATION_TOKEN` 配置注册口令，或明确把匿名注册设为 `true` 并验证配额预算。注册口令只交给 Host 注册流程，不能打进 Hosted App 资源。
4. 运行 package 测试与 `wrangler deploy --dry-run`。检查输出只有预期 DO/Analytics binding、受控 origins 和限制，秘密不会列为 vars。
5. 经实际发布流程确认后运行 `wrangler deploy`；验证 HTTPS 证书、浏览器 WSS、TLS-only、合法/非法 Origin、错误 credential 和跨 Host data ID 拒绝。
6. 用新配对的测试 Host 执行真实 E2EE/RPC/Timeline 验收。保留上一 Worker version、Host 配置和 Direct/Tailscale 候选 endpoint。

默认关闭 Workers invocation logs、应用日志、traces 和 Wrangler telemetry。Cloudflare 文档说明 invocation logs 会包含请求上下文；如果账号另有 Logpush、Tail Worker 或边缘访问日志配置，发布前必须检查字段过滤，避免完整路径、query 或认证 header 被留存。不要运行未经脱敏的 `wrangler tail` 调试真实配对。[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

DO migration 的 class 名称和 binding 名称属于持久状态地址，不要在普通重构中改名或重置。发布回滚使用上一 Worker version，保留 `v1` migration 和已有 DO 数据；删除 namespace 会丢失 route verifier/fence，要求 Host 重新注册和重新分发 endpoint。

## 指标、SLO 与告警

`RELAY_METRICS` 使用 Analytics Engine，事件维度为 `blob1`、数值为 `double1`，route 级事件以短 hash 放入 index。事件不依赖日志。Analytics Engine 可能采样，查询计数时需要乘 `_sample_interval`；数据默认保留三个月。[写入接口](https://developers.cloudflare.com/workers/examples/analytics-engine/)、[限制与保留期](https://developers.cloudflare.com/analytics/analytics-engine/limits/)

```sql
SELECT blob1 AS event, SUM(_sample_interval * double1) AS total
FROM flyx_relay
WHERE timestamp > NOW() - INTERVAL '5' MINUTE
  AND blob1 IN ('internal_error_total', 'backpressure_close_total',
               'upgrade_total.control', 'upgrade_total.client', 'upgrade_total.data')
GROUP BY event
```

核心上报 `routes_online`、`control_connections`、`client_connections`、`pairs_active`、`pair_duration_ms`、分方向 `bytes_forwarded` 和分原因 reject/close 事件。四个连接指标是 gauge，不能使用上面的 SUM 查询；按每个 route hash 的最新样本读取，并让超过 90 秒未更新的样本失效。活跃 route 的 alarm 每 10 秒刷新 gauge。平台异常重启可能缺少最终 zero 样本，需同时看 Cloudflare 自带 WebSocket/DO 指标。

| 目标或告警 | 阈值 | 动作 |
| --- | --- | --- |
| Relay 可达性 SLO | 合法、未超配额的测试 Host/Client 月成功率 ≥ 99.9% | 每区域每分钟执行注册复用后的配对探针；失败跨两个区域连续 3 次呼叫值班 |
| 新 data 配对延迟 | Host control 在线时 P95 ≤ 2 秒 | P95 > 2 秒持续 10 分钟排查区域 RTT、DO CPU 与 Host data 建连 |
| 用户网络恢复 | 网络恢复后 `online + synced` P95 ≤ 10 秒 | 在 Host/Client 端测量；Relay 配对成功不等于 Timeline 已同步 |
| Relay 服务错误 | `internal_error_total` / 升级尝试 > 1% 持续 5 分钟 | 检查 DO/配额 binding、存储错误与最近 Worker version；必要时回滚 |
| 背压关闭 | 有效 pairs 的关闭比例 > 1% 持续 10 分钟 | 检查缺失 ACK、慢客户端和 payload 分页；不要直接提高 1 MiB 安全上限 |
| 配额与滥用 | 429 比例 > 10% 持续 5 分钟或注册达到日预算 80% | 区分配置过低和恶意建连；调整边缘限流/注册策略并检查成本 |
| 同步正确性 | Timeline gap 和重复执行的写命令均为 0 | 任何非零立即阻止推广，保留 Host receipt/sequence 证据 |

以上告警阈值和查询已明确，但告警平台、联系人、生产探针和通知通道需要在目标账号上线时配置；代码没有伪造“已配置的线上监控”。`/healthz` 只适合作为最低层探针。每分钟的端到端探针应复用预注册测试 route，避免把正常注册配额当成可用性失败。

## 排障与退出门槛

| 现象 | 检查 |
| --- | --- |
| `REGISTRATION_DISABLED` | 配置注册口令并由 Host 发 Bearer，或明确开启匿名注册 |
| `ORIGIN_REJECTED` | 精确 scheme/hostname/port，不能带末尾斜线；检查 Hosted App 实际 Origin |
| `UNAUTHORIZED` | Host 私有注册文件是否对应此 relayUrl/routeId；不要从 query 发送 credential |
| `STALE_GENERATION` | Host 是否持久化单调 generation；旧 control 关闭事件不能撤销新连接 |
| `RATE_LIMITED` | 查看 HTTP Retry-After，以及来源、route、socket 三层限制；对象重建不会清空配额 |
| `RESYNC_REQUIRED` | Client/Host 是否逐物理 socket ACK；断开后必须重新握手并按 Timeline watermark 恢复 |
| 配对 15 秒超时 | Host 是否收到 connected，是否成功建立对应 data socket；control 在线不代表 data 可达 |
| 空闲时断开 | 检查 control pong 与 E2EE 内心跳是否继续；不要靠收到任意未知文本刷新 lease |
| 发布后全部不可达 | Worker domain/TLS、DO binding/migration、Origin 和流量过滤；不要修改 Host loopback bind 绕过 |

推广前必须在 staging 完成：实际 hibernation 后 control/data pair 与 ACK 恢复、Worker 更新/重启、错误凭证与错误 Host key、30 秒/5 分钟/30 分钟断网、Wi-Fi/蜂窝切换、data 单独失败、慢客户端、撤销设备立即断连、receipt 丢失后不重复 Turn、Direct/Tailscale 回退、iOS/Android 后台恢复。保留场景、版本、时间、是否达到 P95 和 sequence/receipt 结果；禁止把本地单元测试当作这些实网门槛已通过。

Relay 故障时 Host Provider 继续本机执行和持久化。回滚先停止推广、切回上一个 Worker version，再让客户端用已固定 Host key 的 Direct/Tailscale endpoint 恢复。不要自动创建新 Session/Turn，不要把结果未知的命令当成未执行而重放。

## Node 运行时备用入口

Node 适配器与 Cloudflare 使用同一 RelayRoom，可用于集成测试或独立部署：

```bash
rtk proxy env FLYX_RELAY_INSECURE_LOOPBACK=1 \
  pnpm --filter @flyx/mvp-relay start
```

默认 `FLYX_RELAY_HOST=127.0.0.1`、`FLYX_RELAY_PORT=4483`，route verifier 写入 `FLYX_RELAY_DATA_DIR`（默认 `.flyx/relay-routes`）。公网模式必须配置 `FLYX_RELAY_TLS_CERT`/`FLYX_RELAY_TLS_KEY`，浏览器允许来源使用 `FLYX_RELAY_ALLOWED_ORIGINS`，Host-only 路由创建口令使用 `FLYX_RELAY_REGISTRATION_TOKEN`，受保护指标入口可配置 `FLYX_RELAY_METRICS_TOKEN`。生产 Node Relay 应配置 256-bit base64url 注册口令；未配置时保持匿名创建，仅用于受控部署或本地 fixture。本地 insecure 开关仅允许 loopback 地址，不是公网部署方式。
