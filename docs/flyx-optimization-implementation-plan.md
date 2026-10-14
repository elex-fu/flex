# Flyx 分阶段实施方案与代码改造细节

> 版本：v1.0  
> 日期：2026-10-14  
> 状态：实施中（完整批次验收见第 19 节）
> 对照基线：Flyx 当前工作树，Paseo 710851ccb，T3 Code 4ba4871af  
> 对应方案：[能力差异与优化技术方案](./paseo-t3code-comparison-and-optimization-technical-design.md)

## 1 实施结论

实现顺序保持 M1 可靠性基础、M2 日常使用闭环、M3 隔离并发与回退。首批改动应先修复现有数据契约，再抽取模块：文本增量、Provider 代际、Host 所有权和关闭顺序修好后，才能可靠引入持久执行意图、恢复和多 Session。

保留 SessionOrchestrator 作为旧入口的兼容 façade，保留 Direct、Relay 共用的 RpcDispatcher、ConnectionGateway 和 public projection。先把内部调用替换为独立服务，最后缩小 façade；不同时改写 Host、数据库、协议和 React 的全部结构。

本次细化确定以下实现约束：

1. 引擎统一分配 Turn 的运行代际，Adapter 不用自己的计数器作为数据库校验依据。
2. 长任务的完成等待与审批、中断派发分开；一个尚未结束的 runTurn 不能占住控制通道。
3. 接受操作、向原生运行时交付、确认任务终态分别提交事实，审批不能提前显示已经生效。
4. 恢复历史、证明终态和释放执行权是三个不同操作。
5. 新 Timeline 使用独立能力和订阅，旧订阅保持明确的兼容行为；客户端必须保存协商结果。
6. 历史页通过版本化投影读取固定水位，文本正文使用分段存储，避免每个增量复制一次完整长回答。
7. 结果未知的命令允许只读再核对，仍禁止自动重发；已接受命令也要最终更新为终态。
8. Git checkpoint 同时记录工作树和 index，rename、unborn HEAD、过滤器、子模块和外部编辑分别处理。

下列接口、目录、迁移和预算均为实施目标。现有实现与本轮新增复现分别列明，避免把设计契约当成已上线行为。

## 2 代码再核对与新增复现

### 新增复现结果

验证使用源码函数、内存 ClientStore、注入的 Codex app-server client 和临时 Git 仓库，没有调用真实 Provider。

| 编号 | 源码路径与条件 | 观察结果 | 实施影响 |
| --- | --- | --- | --- |
| B06 | Web timelineItemFromEvent 连续收到同一 Item 的 “Hello” 和 “ world” 增量 | 展示文本变成 “ world” | 先统一 append 与 replace 语义；最终全量消息偶尔能修复，不能掩盖流式丢前缀 |
| B07 | Codex 第一次 thread/start 注入失败，再执行第二个 Turn | DB generation=2，Adapter event generation=1；第二轮虽被 reconciled 为 completed，但 assistant Item 未写入 | Engine 把代际传入 Adapter；失败前后的所有事件使用同一个上下文 |
| B08 | Outbox 中命令已 accepted，或已标 outcomeUnknown；Host 查询桩可返回 completed | reconcile 对两者发出的回执查询均为 0 | 增加 query-only 核对路径及 accepted 命令的终态追踪 |
| B09 | Git 中将 README.md rename 为 Renamed README.md | status 返回正常目标路径外，又返回伪造的 “DME.md” 文件 | NUL 格式按 Git 记录解析，rename 消费额外源路径字段 |

B06 对应 [Web 投影](/Users/lex/play/flyx/apps/mvp-web/src/timeline.ts:73) 与 [Host 原始增量](/Users/lex/play/flyx/apps/mvp-host/src/session/orchestrator.ts:424)。Host 的事件 payload 是追加片段，数据库投影才是累计正文；Web 当前注释和实现把二者混用。

B07 对应 [Codex runTurn](/Users/lex/play/flyx/apps/mvp-host/src/codex/adapter.ts:178) 与 [事件校验](/Users/lex/play/flyx/apps/mvp-host/src/session/orchestrator.ts:399)。Codex 在 loadThread 成功后才增加自己的 generation，而 Orchestrator 在接受命令时已经增加；两者同步只是正常路径中的巧合。

B08 当前是保守的重放保护，相关测试明确要求不重试未知结果。新增恢复能力后需要修改的是“是否可以查询最新事实”，继续保留“不重发未知副作用”的约束。见 [Outbox](/Users/lex/play/flyx/packages/client-core/src/command-outbox.ts:53)。

B09 对应 [Git status 解析](/Users/lex/play/flyx/apps/mvp-host/src/git/git-service.ts:30)。文件计数也必须按完整记录计算，不能按所有 NUL 字段计数。

### 现有路径的具体改造点

| 当前入口 | 当前职责与限制 | 目标落点 |
| --- | --- | --- |
| main 的 bootstrapStore | 管理命令和启动都通过会执行 DDL 的 SqliteStore 打开 DB，并加载或创建身份 | 显式 openReadOnly、openForMaintenance、openOwned；先取得 owner 再初始化身份与 schema |
| Orchestrator constructor | 打开 DB、选择唯一 Session、恢复全部活动 Turn、构造 Adapter | HostLifecycle 负责启动；SessionRegistry 负责 catalog；构造函数不做恢复或启动 |
| startTurn 与 executeTurn | baseline Git 查询、接受事务、未跟踪的执行 Promise、终态提交集中在一个类 | CommandEngine、ExecutionStore、RuntimeRegistry 和受监管 operation |
| interrupt | accepted receipt 与 interrupt event 分开提交 | 同一个 commitCommand；派发通过持久 intent |
| respondApproval | CAS 后先完成回执，再调用返回 boolean 的 Adapter | 请求 reservation 与 delivery intent 原子提交；交付证据回来后更新状态 |
| close 与 server.stop | Adapter 可选同步 close，随后关 DB；main 最后强制 exit(0) | 幂等异步 lifecycle.shutdown，等待生产者、事件和后台任务退出 |
| Gateway subscribe | 先重放所有历史，客户端随后又取 getEvents 页 | 新 openView 注册 live listener 并取固定水位；历史只通过查询读取 |
| SqliteStore listTimeline | 按 updated_at 排序，没有历史版本与源覆盖信息 | 稳定 displaySequence、Item revision、epoch 与版本查询 |
| FlyxClient finishActivation | 领域同步和 outbox 核对失败会使整个 activate 失败 | 安全连接完成后独立启动副本同步；领域错误在健康 lease 上恢复 |
| useHost 与 app | React 保存投影和连接归属；发送前清空草稿 | client-core 拥有副本；React 订阅；先落盘命令再清草稿 |
| session.create | 实际返回默认快照，且只要求 session:read | 保留行为；真正新建使用 session.createNew |
| host.getStatus 与 publicValue | 当前所有内容按单一 workspace 过滤 | 先解析资源的 Session/workspace，再做投影；Host 聚合状态不能泄漏其他根目录 |

## 3 职责抽取与兼容接口

### 代码布局

~~~text
apps/mvp-host/src/
  lifecycle/host-owner.ts host-lifecycle.ts process-inspector.ts managed-process-registry.ts
  orchestration/command-engine.ts decider.ts command-contract.ts execution-worker.ts provider-ingestion.ts
  storage/open-store.ts migrations/ session-store.ts execution-store.ts recovery-store.ts
  workspace/workspace-registry.ts workspace-lease.ts
  session/session-registry.ts recovery-service.ts legacy-session-facade.ts
  provider/types.ts runtime-registry.ts capability-manifest.ts
  timeline/projector.ts timeline-query.ts timeline-subscriptions.ts content-store.ts
  interaction/interaction-store.ts interaction-service.ts
  checkpoint/git-driver.ts checkpoint-service.ts revert-service.ts
  diagnostics/host-diagnostics.ts backup-service.ts

packages/mvp-protocol/src/
  session-api.ts timeline-api.ts interaction-api.ts checkpoint-api.ts

packages/client-core/src/
  host-runtime.ts host-runtime-registry.ts session-replica.ts timeline-reconciler.ts
  platform.ts cache-store.ts draft-store.ts
~~~

以上文件按相应工作项逐步新增。现有 db.ts 的连接所有者只保留一个，拆 Store 是共用同一个连接和事务，不是为每个模块建立一个独立 SQLite writer。第一版 Engine 保持单 Host 的提交顺序，Git/Provider 等外部等待全部在提交锁之外进行；多 Session 后再根据测量决定是否需要更细粒度调度。

### 旧入口迁移规则

保留旧 RPC 的方法名、授权和省略 Session 时的含义。新增 Host catalog 时，legacyDefaultSessionId 持久化在 host_state，不能继续通过“最新 active Session”选择旧命令的目标，也不能跟随某个浏览器的当前选择。

新请求的 sessionId、workspaceId、Provider 配置由 schema 明确解析。现有 startTurn payload 不接收 sessionId，Zod 会去掉未声明字段；不能只让新 UI 增加字段就宣称完成多 Session。Dispatcher、请求 hash、回执资源绑定和 public projection 必须同批更新。

旧回执使用 hash version 1，保留原 method 与规范化 payload 的计算规则。新请求使用 version 2，把解析后的目标 Session 和资源上下文纳入 hash；两种版本不能交叉重用。回执补充 target_session_id 和 request_format_version，旧行通过 Turn/审批关联确定目标；无法唯一关联的行保留为 legacy，不猜测资源归属。

v2 application envelope 维持 strict。业务类型使用新 payload schema 和 capability；内部 Provider 终态、checkpoint 完成和 owner 维护命令不进入客户端 method map。

## 4 W01 验证入口与现有契约修复

### 实施步骤

1. root package.json 新增 test:product、test:fixtures、typecheck:tests、verify:clean；默认 test 指向产品用例。故意失败的 claude-fixtures 单独运行，验证夹具预期，而不让产品测试在它处中断。
2. Protocol 加源码 Vitest include；Host/Protocol 的 production tsconfig 排除测试，独立 tsconfig.test.json 包含测试并 noEmit。测试配置继承生产配置时显式覆盖 exclude，Web 的 test 目录同时扩展 rootDir/include，保留 strict、exactOptionalPropertyTypes 和 noUncheckedIndexedAccess。client-core 当前生产 typecheck 排除了测试，仍需要独立检查。
3. 修正 client.test.ts 的 connectTransport 注入参数，显式采用 endpoint、profile、generation、signal。
4. B06 先按事件类型修正：delta 追加，completed 全量替换；工具 progress 明确是累计输出。hasTerminalItem 只识别 Turn 终态，不能用 assistant_message completed 推断整个 Turn 已结束。
5. B07 先让现有 runTurn 接收 Engine 分配的 DispatchContext，见 W03；所有 Adapter 与 deterministic adapter 同步改造，覆盖准备失败、run start 失败和 resume 后事件。accepted/outcome 分离在 R06 接入调度时展开，不要求 R02 同时改写完整 worker。
6. B09 使用可独立测试的 Git porcelain parser；保留 rename 的 originalPath，不把其第二字段当成新文件。
7. E2E 等待本次 commandId/turnId 的状态；安全提示断言与当前 HttpOnly 文案一致；浏览器安装由 CI 固定，不在运行时静默选另一种引擎。
8. Verify workflow 执行 frozen install、native rebuild、依赖 build、生产及测试 typecheck、产品测试。清洁验证在临时副本中排除 dist，不能删除用户工作区的已有构建产物。

建议命令为后续新增入口：

~~~bash
pnpm build
pnpm typecheck
pnpm typecheck:tests
pnpm test:product
pnpm test:fixtures
pnpm verify:clean
~~~

### 退出条件

连续两个或更多 delta 保留前缀，完成消息替换后不翻倍，中断流也可读取已提交内容；首轮加载失败后第二轮全部事件持久化。冷环境和有 dist 的环境发现相同的产品用例，fixture 不阻断产品检查；关闭的真实用例显示 skipped。

关键落点：[root scripts](/Users/lex/play/flyx/package.json)、[CI](/Users/lex/play/flyx/.github/workflows/verify.yml)、[client 注入](/Users/lex/play/flyx/packages/client-core/src/client.test.ts:70)、[Timeline 测试](/Users/lex/play/flyx/apps/mvp-web/test/timeline.test.ts)、[GitService](/Users/lex/play/flyx/apps/mvp-host/src/git/git-service.ts)。

## 5 W02 Host 所有权与有序关闭

### Store 打开与 Owner

HostOwnerLock 的排他域覆盖 canonical DB 路径和 canonical identityDirectory。不存在的 DB 文件按已 realpath 的父目录加文件名计算；已有 DB 和身份目录通过真实路径消除 symlink 别名。按锁 key 固定排序获取，后续锁获取失败时释放本次已取得的锁。

首版使用独占创建的 owner 文件和随机 ownerId，借鉴 Paseo PID lock。已有锁默认拒绝，心跳过期不自动抢占。离线维护回收先确认原 PID 的启动身份已退出；EPERM、身份检查失败或平台不支持都返回 unknown。回收和释放核对 ownerId、文件身份及维护互斥，不能在检查之后无条件删除另一个实例创建的锁。自动 stale 回收在单独竞态验收通过后开放。

openOwned 接受 owner handle，检查未来 schema、迁移和恢复；openReadOnly 使用 SQLite readonly、fileMustExist，不执行 SCHEMA 和 ALTER；openForMaintenance 要求离线所有权。运行中设备撤销可保留受控短事务或通过本机 owner 控制接口；身份轮换、导入和恢复走维护入口。

HostOwnerLock 不代替 workspace lease。单机协调目录使用 canonical worktree 根的 key；不同 DB 指向同一个 checkout 仍只能有一个写任务。同一仓库的多个 worktree 可独立执行，不能用 git common dir 作为唯一互斥 key。lease 覆盖 checkpoint before、执行、终态 ingestion 和 checkpoint after；结果未知且旧进程未核对时继续阻止新写。

### Provider 进程

Codex 在 StdioAppServerClient.spawn 前保存 launching 记录，得到 child.pid 后补充启动身份和 exit listener。close 改为 closeAndWait，处理 EOF/SIGTERM、期限和确认退出；不能将 stdin.write 的 true 当成原生执行 ACK，也不能将 kill() 返回 true 当成进程已退出。

Claude 当前没有 ProviderAdapter.close 实现。接入锁定 SDK 提供的 spawnClaudeCodeProcess 回调，以原有 command、args、cwd、env 和 SDK 转发 signal 创建受监管 child；记录真实 child handle 和退出。遵守 SDK 的 EOF 与宽限关闭语义，不用即时 AbortSignal 抢先终止它的正常退出流程。该接入必须通过现有 sandbox、环境过滤、审批和中断真实契约。

spawn 与 PID 持久化之间仍可能 crash。launching 记录和未确认的子进程归属进入恢复 gate，不能靠没有 PID 就断言未启动。跨重启不能验证进程身份时，需要本机诊断或受支持的监管机制提供事实；不能使用进程名称匹配后批量终止。

确认 Provider 根进程退出也不能直接证明它启动的所有工具子进程已停止。第一版选择受监管的专属进程组、平台容器退出证明或经过验证的 SDK 进程树退出契约；无法覆盖后台子进程时继续保留执行 gate。Linux 可用 boot ID 加内核 start ticks 核对跨重启身份；macOS 需要足够精度的系统启动身份适配，只有秒级 ps 时间时不视为强证明。各平台未支持的情况明确返回 unknown。

Host 数据、身份、Relay 注册目录不得落入可授权 workspace。目录重叠时拒绝新执行并提供迁移提示；搬移私有数据是显式维护操作。Provider 的实际读边界需要验证，同一 UID 下文件 mode 不能单独保证密钥不可读。

### 生命周期与关闭

HostLifecycle 拥有 owner、Store、DeviceRegistry、Gateway、Relay 和所有后台 operation；server.ts 只负责 listener/transport。start 分为 booting、read_only、ready；业务 admission 独立于 HTTP 已监听。Provider 不可用时可保留授权后的历史与诊断，不把单个 Provider 故障变成整个 Host 无法访问。

shutdown 返回共享 Promise，第二次调用等待同一结果：

~~~text
draining，拒绝新业务写
  → 停止新 start intent 派发，保留内部控制与事件提交
  → 向活动 runtime 派发可追踪 stop/interrupt
  → 等待生产者停止或记录无法证明的执行结果
  → 排空 ingestion 与 terminal 提交
  → 排空 checkpoint/reactor，再关闭订阅、Relay、DeviceRegistry
  → 关闭 Store，最后释放已满足释放条件的 owner/lease
~~~

如果 producer 无法停止，先封闭其事件入口并提交未知状态，保留阻止重用 checkout 的监管记录。所有未结束 operation 都有注册表；DB 关闭后到达的 callback 被 generation/admission fence 拒绝。main 不在 finally 中无条件 exit(0)，关闭失败产生可诊断的非零退出；不能抹掉 pending work 后报告干净退出。

测试 Host 的构建入口也使用相同 lifecycle，不能只给 main 加锁却让 server/e2e 继续绕过。内存 Store 使用显式测试 owner，不会创建真实 daemon 的锁。

退出条件：第二 Host 在任何业务 DDL、恢复和 preflight 前被拒绝；关闭期间的迟到终态可被提交，DB 最后关闭；无法证明停止时新 checkout writer 仍被拒绝。

参考：[Paseo PID lock](/Users/lex/play/paseo/packages/server/src/server/pid-lock.ts)、[managed processes](/Users/lex/play/paseo/packages/server/src/server/managed-processes/managed-processes.ts)、[Flyx main](/Users/lex/play/flyx/apps/mvp-host/src/main.ts:34)、[关闭路径](/Users/lex/play/flyx/apps/mvp-host/src/server.ts:404)。

## 6 W03 原子 Engine 与持久执行意图

### CommandEngine 与事务

首先在现有 Store 添加 commitCommand，不立即删除 acceptTurn、commitEvent、resolveApprovalAndCommit。旧方法内部委托统一事务，保留已通过的原子性用例；所有构建提交计划的 callback 都必须同步，不能在 better-sqlite3 transaction 中 await。

提交过程：

1. 以当前设备 scope 和资源检查 admission，再读取回执；已撤销设备不能靠重用旧 commandId 绕过权限。
2. 在提交顺序内读取 Session revision、活动 Turn、恢复 gate、Interaction reservation 和已提交意图。
3. Decider 通过注入的时间和 ID 生成 Event、投影、回执及 intent。Git、SDK 和进程加载均不在 Decider 中。
4. 同一事务 CAS Session revision，并写事实、投影和回执。冲突重新读取，不沿用事务失败前的内存状态。
5. commit 成功后发布，唤醒 worker。唤醒失败不改回执为“未接受”，持久 pending intent 仍可被扫描发现。

每个 accepted 用户写都必须有对应可追踪执行路径；拒绝和纯同步命令的回执是否持久化在 method contract 中明确。DB 不可写转 degraded，拒绝新执行，但保留可用的只读查询。

### DispatchContext

~~~ts
type DispatchContext = {
  hostOwnerId: string;
  hostOwnerGeneration: number;
  sessionId: string;
  flyxTurnId: string;
  runtimeId: string;
  runtimeGeneration: number;
  attemptId: string;
};

type ProviderRun = {
  // 没有单独原生 ACK 的 Adapter 可以省略这个 Promise。
  accepted?: Promise<{ nativeSessionId: string; nativeTurnId?: string }>;
  outcome: Promise<ProviderOutcome>;
};

type ProviderOutcome = (
  | {
      status: "completed" | "failed" | "cancelled";
      evidence: { kind: "native-terminal"; sourceId: string };
    }
  | {
      status: "failed" | "cancelled";
      evidence: { kind: "not-dispatched" };
    }
  | {
      status: "outcome_unknown";
      evidence: { kind: "unknown"; reason: string };
    }
) & { nativeSessionId?: string; nativeTurnId?: string };

interface RuntimeDriver {
  beginTurn(
    context: DispatchContext,
    prompt: string,
    nativeHandle?: unknown
  ): ProviderRun;
  interrupt(
    context: DispatchContext,
    reason: string
  ): Promise<{ state: "accepted" | "terminal" | "unknown" }>;
  closeAndWait(deadlineMs: number): Promise<{ stopped: boolean }>;
}
~~~

Engine 的 runtimeGeneration 持久单调递增，attemptId 在调用前固定。Adapter 的私有计数只用于内部 callback 过滤；对外 envelope 始终带 Engine 上下文，准备失败和无原生 Turn ID 时也不能缺省 turnId。确定性 Adapter 采用同一契约，删除“没有 fence 时取当前 active Turn”的正常生产回退。

nativeSessionId/nativeTurnId 通过内部事实在取得时持久化。原生已有稳定 message/request ID 时加入 source key 去重；没有原生增量序号时不声称可以跨重启逐片去重，历史导入按完整原生 message ID 核对。旧 runtime 终态只作用于其原 Turn；不能更新新 Turn。

### 核心 SQL 草案

以下为新迁移中的核心约束，实际迁移按第 16 节执行，并补齐旧数据 backfill：

~~~sql
ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN attempt_id TEXT;
ALTER TABLE turns ADD COLUMN native_turn_id TEXT;
ALTER TABLE command_receipts ADD COLUMN target_session_id TEXT REFERENCES sessions(id);
ALTER TABLE command_receipts ADD COLUMN request_format_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE event_commits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  CHECK (first_sequence > 0 AND last_sequence >= first_sequence),
  UNIQUE (session_id, first_sequence),
  UNIQUE (session_id, last_sequence)
);
ALTER TABLE session_events ADD COLUMN commit_id TEXT REFERENCES event_commits(id);

CREATE TABLE execution_intents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  auth_subject_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('device', 'host')),
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  runtime_generation INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'claimed', 'dispatching', 'acknowledged', 'settled', 'outcome_unknown'
  )),
  claim_owner_id TEXT,
  claim_owner_generation INTEGER,
  native_request_id TEXT,
  result_code TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (auth_subject_id, command_id, ordinal),
  FOREIGN KEY (auth_subject_id, command_id)
    REFERENCES command_receipts(auth_subject_id, command_id),
  CHECK (state <> 'settled' OR result_code IS NOT NULL)
);
CREATE INDEX execution_intents_pending
  ON execution_intents(state, session_id, source_sequence, id);
CREATE INDEX execution_intents_turn
  ON execution_intents(session_id, turn_id, state);
~~~

ordinal 支持同一命令的多个同类子操作，替代原方案示例中的 commandId 加 kind 唯一键。payload 必须可由受控资源重新解析，不能只保存 method/hash；其中不能出现 refresh secret。host actor 只来自内部受信入口，客户端 payload 不能指定 actor_kind。

event_commits 与各源事件同事务记录提交边界，after 页可以据此避免返回半个新业务提交。旧事件的 commit_id 保留 null；没有足够事实时不猜测旧原子边界，legacy backfill 在恢复至固定 W 前不开放操作。receipt、intent 与内部结果都携带对应 commit ID/源序列，publish 失败后可从提交记录重建通知。

pending → claimed 只做准备，准备期间不能提交用户 prompt、审批答案或其他原生业务写。启动 runtime 的进程记录、Git checkpoint 等准备副作用各自有可核对的 operation，不用“准备”一词跳过监管。

claimed → dispatching 的标记在业务调用前提交；crash 后只有证明尚未派发的 intent 可以重新派发。原生 ACK 不存在时保持 dispatching，直到权威终态；session_init 或本地写入 stdio 不单独证明用户 Turn 已被接受。cancelled/failed 是 settled 的 result_code，不通过删除 intent 表示结束。

Provider 错误需要包含派发证据。准备阶段明确未发送 prompt 可以失败结算；收到原生拒绝或失败终态可以按权威结果结算；请求已进入 transport 后的 timeout、连接断开或缺少终态一律先进入 unknown。Codex 当前 turn/start catch 返回 failed，不能沿用这一泛化结果直接释放执行权。SDK iterator 抛错也不自动证明所有副作用未发生；验证停止和结果核对分别进行。

### 调度与控制通道

采用三类队列：提交命令队列、短时派发队列、Provider ingestion 队列。start 派发登记 ProviderRun 后立即释放派发槽位，其 outcome 在独立 operation 注册表中等待；控制队列可同时向同一个 runtime 发送审批、中断。不能把 await runTurn 放在单一 FIFO worker 内等待整项任务结束。

同一 Session 的业务提交仍串行，实际只有一个活动写 Turn。控制意图验证原 Turn、attempt 和 runtime generation；等待 native ID 有期限。尚未进入 dispatching 的 start 被中断时，可在事务中取消原 start intent 并完成 interrupt；已经可能派发的 start 先核对原生事实。

多 Session 的派发采用公平轮转和控制优先级，Session 内维持源提交顺序。各 Session 的 source_sequence 是各自水位，不能把它直接当成全 Host 的优先级，否则新会话与长历史会话可能相互饿死。

队列采用数量和字节双重预算，并为终态、控制和故障事件保留处理能力。DB 中已接受的 intent 不因内存唤醒队列满而丢弃。drain 区分“派发队列为空”和“所有运行 operation 已结束”；关闭等待二者及 ingestion，不能只看 outstanding 的一个计数。

Codex stdio 当前在 readline 产生完整行后才检查 2 MiB，不能限制没有换行的积累。改为在 data chunk 阶段累计字节的有界 line framer，超限先封闭输入并记录失败，再监管退出；Native frame、归一化事件和待提交 ingestion 三层分别设预算。达到预算时不能静默丢 terminal 或审批，需暂停可支持的生产者或进入 degraded/unknown。

派发前再次验证 actor 仍有授权以及资源 policy。凭据轮换不等同于设备撤销；已进入 dispatching 的操作即使设备被撤销，仍需对其实际结果结算。

### 审批原子性先修复

interrupt 的 receipt、turn.interrupt.requested、活动状态及 intent 一次提交。审批先 reservation 并写 accepted receipt/intent；Provider 交付证据回来后才完成回执和相应投影。CAS 版本只解决并发选答案，不能解决提交与原生交付之间的 crash 窗口。

Codex respond 当前只证明 frame 进入本地 stdin buffer，Claude respond 证明 SDK permission Promise 已被 resolve。分别记录 local-delivery 与 native-confirmation，UI 使用“已提交/已交付/已确认”文案；不能把 allow_once 交付当成工具已经执行成功。

设备撤销的 Device/lease/grant 变更、audit 和普通业务回执在一个 Host 事务提交，之后再执行可重复的 socket cleanup。它没有 Session 资源，不为了统一表结构给它伪造 session_id；同步数据库结果直接完成回执，只有需要跨事务执行的 Session 外部操作写 execution_intents。

退出条件：任一 Event/Projection/Receipt/Intent 写入失败时 Adapter 调用为 0；每个派发窗口 crash 都得到可解释状态；长 Turn 等待期间审批和中断不被队列阻塞。

参考：[T3 Engine 事务](/Users/lex/play/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts:153)、[DrainableWorker](/Users/lex/play/t3code/packages/shared/src/DrainableWorker.ts)、[Flyx 接受事务](/Users/lex/play/flyx/apps/mvp-host/src/storage/db.ts:542)、[审批交付](/Users/lex/play/flyx/apps/mvp-host/src/session/orchestrator.ts:262)。

## 7 W04 NativeHandle 与恢复操作

### Provider 能力分解

| 能力 | Claude 第一实现 | Codex 第一实现 | 生效门槛 |
| --- | --- | --- | --- |
| historyRead | 锁定 SDK 的 getSessionMessages，限定 dir、limit、offset | 受支持版本的 thread/read，指定原 threadId | 解析后的稳定 message/Turn ID 与分页契约通过 |
| resumeIdle | 已有 query resume；绑定 workspace 与 policy fingerprint | 已有 thread/resume；绑定 provider instance | 旧进程停止、活动 gate 通过，不把历史读取触发成新执行 |
| inspectTurn | 仅返回可证明的事实；SDK 消息类型不直接提供统一 Turn 终态 | 读取原 nativeTurnId 的状态 | 不能用最新 assistant message 或相同 prompt 猜测成功 |
| reattachRunning | 默认 false | 当前 stdio Adapter 默认 false | 单独验证跨 Host 重启的原运行连接支持 |
| conversationRewind | 默认 false；fork/resume-at 和文件 rewind 不是同一能力 | 原生 rollback 经真实版本验证后开启 | Provider 对话、工作区和 Timeline 的协调恢复通过 |
| managedProcessExit | SDK spawn 回调和真实 child 退出 | child handle 和退出事件 | 进程身份、退出等待及启动空窗通过 |

锁定 SDK 的 SessionMessage 是 user/assistant/system 消息，并不是 Flyx TurnOutcome。getSessionMessages 可用于找回消息，不足以把未知 Turn 改成 completed。T3 Claude 的 rollbackThread 当前更新内存 turns 和 resume cursor，不能直接等同于原生历史已物理回退。参考 [SDK 声明](/Users/lex/play/flyx/apps/mvp-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:748)、[T3 Codex runtime](/Users/lex/play/t3code/apps/server/src/provider/Layers/CodexSessionRuntime.ts:1343)、[T3 Claude rollback](/Users/lex/play/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:3842)。

NativeHandle 保存 provider instance、原生 session、workspace、配置 fingerprint 与已验证版本，认证 secret 不参与 fingerprint。Flyx Turn 的 native binding 在调用过程中立即提交，不能等 runTurn 返回后才保存。

历史合并同时保存 native message ID 到 Flyx Item 的映射。已有 Flyx 用户消息缺少 native ID 时，不用 prompt 文本相等推断同一消息；保留不同来源的历史核对视图或等待可证明的关联，避免 resume 导入出第二条用户消息。原生 message ID 的回显或受控输入 ID 只有通过锁定 SDK/CLI 契约后才用于去重。

### 恢复流程和 CAS

RecoveryService 的 inspect 不执行用户写，返回 evidenceId、Turn/attempt、事实版本、进程状态、原生结果、工作区 lease 状态以及允许的下一步。evidence 有短时有效期；执行 reconcile/acknowledge 时重新核对事实或验证当前 evidence revision，不依赖客户端传来的结论。

recovery 操作自己的 commandId 和原 start commandId 分开。核对到原终态时，在事务中结算原 Turn、原回执、相关控制意图和恢复 operation；未知历史仍保留。确认停止但没有终态时，acknowledge 仅关闭活动关联和执行 gate，不修改原任务为成功。

sessions 新增 active_turn_id、recovery_state 和 recovery_revision。先按已有活动行 backfill，旧未知行仍 blocked。替换 one_active_turn_per_session 前，同批改造 getActiveTurn、getSnapshot、acceptTurn 和所有恢复读取；snapshot 不能再用“最新 outcome_unknown 行”推断当前活动任务。

恢复 gate 解除需要原进程已停止且 checkout 无残留 writer。Session 内状态正常不代表另一 DB 的同 checkout lease 已解除。检查结果 unknown 时返回 RECOVERY_BLOCKED，保留本机处理路径。

### Outbox 跟踪终态

CommandOutbox 分开保存 delivery state、Host receipt state 和 replay policy。对 accepted 和 outcome_unknown 增加只读查询；连接恢复、Session 终态事件、恢复 operation 完成和用户“核对结果”触发查询，采用去重及预算，避免每个 delta 查询一次。

原 receipt 从 unknown 变成 completed 后可以更新展示；即使查询不到旧 receipt，也不能重放曾经已接受或可能派发的写。只有从未确认接受且显式重试的原命令，按原 commandId 和 hash 检查后可能重发。数据库回滚导致 receipt 消失不构成重放授权。

为持久回执的 access 撤销增加 capability 和 access.getCommandReceipt；scope 为 access:self，结果限于当前 actor 的命令，按原方法验证必要权限。保留 access.pair/refresh 的独立凭据状态机，不把它们放入长期业务 outbox。尚未提供 access 回执的旧 Host 继续提示核对设备状态。

自撤销或撤销所有设备后，原 actor 会失去查询授权。响应丢失时保留本机核对提示，不为读取回执恢复被撤销的权限，也不自动重试撤销；由本机 owner 或重新授权后的受控入口核对。

退出条件：未知状态既不会自动执行，也不会永久无法查询；原生终态、确认停止但结果未知、进程身份不明三类路径分别通过；UI 的恢复按钮不绕过进程和工作区事实。

## 8 W05 权威 Timeline 与有界内容

### 能力协商和分流

RpcClient.hello 返回的 server capabilities、maxFrameBytes、protocolVersion 保存到 HostRuntime，当前 FlyxClient 丢弃了这份结果。Gateway 保存客户端 capability 及订阅模式，并在新方法 admission 中检查功能已启用。只有发布代码和迁移完成、且有效能力可用时才广告 capability。

新增 session.openView、timeline.getPage、timeline.subscribe、timeline.unsubscribe、content.getChunk。openView 已建立订阅，客户端不能随后重复 subscribe；timeline.subscribe 用于重建 live 订阅或改选窗口。subscriptionId 绑定设备、Session、lease generation 和 epoch，断线时清理。

旧 session.subscribe 保留原始事件流。新模式不推全部历史：仅推固定水位之后的已提交源事件与受预算约束的投影增量。正常第一版本一条通知对应一个提交源 sequence；未来合并多个已提交 sequence 时必须显式携带连续 covered range，不能复用旧 SyncEngine 的 sequence+1 逻辑。

新 RpcClient 仍通过 strict event envelope 接收通知，SessionReplica 根据 capability 和 event payload schema 处理权威 Item/patch。旧 raw reducer 和新 canonical reducer不能同时给一个副本应用同一条消息。

### Epoch 与历史投影

引入 projectorVersion 与 epoch。每次源事实提交同时保存受影响 Item 的版本，revision 使用最后影响该 Item 的源 sequence，displaySequence 为第一次出现时的源 sequence。content 完成是 replace，delta 是 append，tool 的累计 output 与 outputDelta 分别归一化。

timeline_item_versions 保留查询水位所需的历史版本；不是每个版本存一份长文本。文本以不可变 segment 和固定长度 content ref 表示，工具或最终全量消息可使用不可变 blob。最新 projection 只是查询加速，固定 W 的 after 页从版本表选取小于等于 pageEnd 的最近版本。

~~~sql
CREATE TABLE timeline_epochs (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  epoch TEXT NOT NULL,
  projector_version INTEGER NOT NULL,
  indexed_sequence INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('building', 'active', 'retired')),
  PRIMARY KEY (session_id, epoch)
);
CREATE UNIQUE INDEX one_active_timeline_epoch
  ON timeline_epochs(session_id) WHERE state = 'active';

CREATE TABLE content_streams (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  item_id TEXT NOT NULL,
  format TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, session_id)
);
CREATE TABLE content_segments (
  stream_id TEXT NOT NULL REFERENCES content_streams(id),
  source_sequence INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (stream_id, source_sequence),
  CHECK (byte_start >= 0 AND byte_end > byte_start),
  CHECK (length(data) = byte_end - byte_start)
);
CREATE INDEX content_segments_offset
  ON content_segments(stream_id, byte_end);

CREATE TABLE content_refs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('blob', 'stream_prefix')),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'expired')),
  stream_id TEXT,
  through_sequence INTEGER,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL,
  blob_data BLOB,
  created_at TEXT NOT NULL,
  UNIQUE (id, session_id),
  FOREIGN KEY (stream_id, session_id) REFERENCES content_streams(id, session_id),
  CHECK (
    (kind = 'blob' AND stream_id IS NULL AND (
      (state = 'ready' AND blob_data IS NOT NULL AND length(blob_data) = byte_length)
      OR (state = 'expired' AND blob_data IS NULL)
    ))
    OR
    (kind = 'stream_prefix' AND stream_id IS NOT NULL
      AND through_sequence IS NOT NULL AND blob_data IS NULL)
  )
);

CREATE TABLE timeline_item_versions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  display_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  content_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id, revision),
  FOREIGN KEY (session_id, epoch) REFERENCES timeline_epochs(session_id, epoch),
  FOREIGN KEY (content_ref, session_id) REFERENCES content_refs(id, session_id)
);
CREATE INDEX timeline_versions_after
  ON timeline_item_versions(session_id, epoch, revision, item_id);
CREATE INDEX timeline_versions_display
  ON timeline_item_versions(session_id, epoch, display_sequence, item_id, revision);
~~~

长文本通过 byte_start/byte_end 索引读取固定 prefix 的范围，不给每个 revision 复制全文，也不在每个 revision 的 metadata 复制完整 segment 列表。递增 hash 可以在当前进程保持状态；恢复时从已提交 segment 重建，完成消息不同于流式前缀时保存新的 replace blob。

所有 contentRef 不可变。source range 元数据同样受预算限制：少量范围内联，多量范围用受授权的 ref；Item 的 source ranges 只用于来源解释，不能代替全局连续消费 cursor。

### 打开视图和分页

~~~ts
type TimelineCursor = { epoch: string; sequence: number };
type SourceRange = { fromExclusive: number; through: number };

type OpenViewRequest = {
  sessionId: string;
  cursor?: TimelineCursor;
  tailLimit?: number;
};

type TimelinePageRequest =
  | {
      sessionId: string;
      epoch: string;
      direction: "after";
      afterSequence: number;
      upToSequence: number;
    }
  | {
      sessionId: string;
      epoch: string;
      direction: "before";
      beforeDisplaySequence: number;
      beforeItemId?: string;
      limit: number;
    };

type AfterPage = {
  epoch: string;
  upToSequence: number;
  covered: SourceRange;
  items: unknown[]; // 实施时使用共同的 ProjectedItem schema。
  pageRef?: { ref: string; bytes: number; sha256: string; itemCount: number };
  nextCursor: TimelineCursor;
  hasNewer: boolean;
};
~~~

openView 登记 listener 后，在一个短只读事务中读取 Session snapshot、交互摘要、活跃 epoch、水位 W 和最近页。listener 的暂存与响应发送顺序由 subscription service 管理；交付前去掉 <=W 的重叠通知。冷启动将消费 cursor 设为 W，同时保留 hasOlder，并不声称已经加载了全部历史。

有旧 cursor 时，after 连续消费 (cursor,pageEnd]，直到固定 W。每页 covered 明确覆盖源事件，即使没有可显示 Item，也必须前进。事务导致多条关联事实时，页边界不得返回半个业务提交；必要时以提交批次末端选择 pageEnd。

after 只返回受影响 Item 在 pageEnd 时的完整版本；客户端按 revision 替换。单个超大 Item 变成 ref 以后仍可推进 cursor。单个提交影响的 Item 元数据总和也可能超预算，整批版本保存为不可变 pageRef，客户端完成读取、校验与合并后才推进 covered cursor，不拆成无法辨认的半批。

before 使用 displaySequence 加 itemId 的复合 key；页携带实际 snapshot 水位，新于本地 live 的结果不能使旧文字覆盖新 revision。若 before 的实际水位更高，仅按 revision 合并该历史窗口，并安排 catch-up，不据此提高全局消费 cursor 或推断当前 Session 已同步。

pending Interaction 摘要独立于历史窗口。数量或正文超预算时使用分页摘要和 contentRef，并报告总数及目录 revision；在权威列表补齐或目标请求重新验证前，不根据缓存开放操作。已加载窗口外的 Item 更新可以推进 cursor，不无限扩展可见列表。

### 预算与内容读取

初始预算候选为 192 KiB 最终编码 JSON，application frame 上限仍为 256 KiB；取协商上限和本地上限的最小值。普通页 item/source 数量作为额外上限，最终判定使用 UTF-8 编码字节，包含 envelope、转义与 base64。

所有返回路径都进入 FrameBudget：Timeline、Diff、command receipt、snapshot 的交互、设备列表和诊断。大内容改 ref 或分页；正常查询超预算返回明确业务错误，不通过 send() 关闭整条连接来报错。旧客户端返回有标记的摘要/截断或升级要求，不能伪造全文。

content.getChunk 参数包含 sessionId、ref、offset、maxBytes。第一版返回 UTF-8 边界对齐的文本或明确编码的 base64，带 nextOffset、totalBytes、hash；chunk 大小按实际编码回退计算。ref 不接受文件路径，不接受不同 Session 的引用。

当前 publicValue 在发送时过滤根目录。ContentStore 必须保存或构建固定版本的 public representation，不能把原始私有内容直接通过 ref 暴露；redaction 在 hash 和分块前完成。跨 chunk/增量边界的目录字符串纳入验证，不能在每个 chunk 独立 replace 后声称与原投影等价。

content、版本和 ref 引用在同一 SQLite 事务内提交，第一版采用 DB BLOB/segment，避免额外引入“文件已写、DB 引用未提交”的窗口。活动恢复、打开查询水位和 checkpoint 引用形成保留 pin；回收使用 mark-and-sweep operation，不删除仍可被页或 intent 读取的内容。

历史正文保留期限与事件事实保留分别配置。正文到期保留不可变 ref 元数据及 expired 标志，查询返回 CONTENT_EXPIRED，不把同一个 ref 指向新正文；segment 只有不再被任何可用 prefix 引用时才能回收。数据上限到达时采用可解释的 admission/存储错误，不能删除活动恢复依赖的正文后继续执行。

### 增量合并与查询保留

50 ms 是测量候选，不是正确性依赖。合并器只合并同一 Session/Turn/Item 的相邻文本；遇到审批、提问、工具边界和终态先 flush。flush 写段、Event 和投影后才发布。旧流维持真实已提交源序列。

历史版本的保留与 cursor 有明确期限。超过可恢复范围返回 CURSOR_EXPIRED，客户端建立新的 epoch/tail，并提示历史仍可查询；不能假装补完了遗漏范围。DB 版本重建通过 building epoch，记录 backfill cursor，完成验证后原子切换 active epoch，不覆盖正在提供服务的 projection。

退出条件：10,000 源事件冷启动与多页 after 无 gap；2 个以上 delta、tool/assistant 交错、完成替换均正确；300 KiB Diff 和 1 MiB 最终消息不会关闭连接；投影正文存储增长不随每个增量完整复制而呈平方增长。

参考：[Paseo 同步契约](/Users/lex/play/paseo/docs/timeline-sync.md)、[Flyx Gateway](/Users/lex/play/flyx/apps/mvp-host/src/api/connection-gateway.ts:134)、[SyncEngine](/Users/lex/play/flyx/packages/client-core/src/sync-engine.ts:49)、[RPC hello](/Users/lex/play/flyx/packages/client-core/src/rpc-client.ts:81)。

## 9 W06 多 Session 和 Workspace Registry

WorkspaceRegistry 首版从 Host 本机配置注册 root，不开放客户端任意 cwd 注册。记录 workspaceId、canonical root、实际 Git worktree 根、checkoutKey、local/worktree 类型与状态。重命名或目录搬移需要显式重新核对，不能根据相同 basename 自动关联。

ProviderInstanceRegistry 记录 Provider ID、已解析 executable、可控配置、policy version、版本验证状态和 capability。配置读取不能把 Host 全部 env 传给 Provider。有效能力为 Adapter 支持、真实版本验证、Host policy、工作区能力和当前设备 scope 的交集。

SessionRegistry 记录标题、workspace、Provider instance、NativeHandle、archive、runtime residency 和 revision。读取历史不创建运行进程，ensureLoaded 通过 per-session Promise 去重及 close barrier，先等待关闭，读取持久状态后再核对 archive；失败清理同一个 Promise，不能移除后来创建的 load。

Session 新 snapshot 使用 string workspaceId 和扩展字段；旧 SessionSchema 的 workspaceId 是 literal default，不能直接修改旧必填字段的含义。兼容 façade 固定 default 投影，新 UI 使用 SessionSummaryV2。

session.createNew 接受 workspaceId/providerInstanceId/title 等受控配置，并写持久回执；不能复用只读 session.create。archive 默认只允许 idle 且无恢复 gate，运行中的归档明确选择先停止并核对；closeRuntime 保留持久 Session，unarchive 不隐式提交 prompt。

原 Claude/Codex 分库导入采用 dry-run、离线备份、目标 catalog 事务与 import manifest。主库设备授权保持主库边界；副库历史回执可以保留原 actor，但不创建新的有效授权。冲突 ID、缺少 Provider 归属、不同 Host fingerprint 均阻断或分开处理。

退出条件：同 Host 两 Provider、多 Session 的事件、回执、交互与 Diff 不串线；旧不带 sessionId 命令只操作 legacy default；同 checkout 跨 DB/Session 的第二个 writer 被阻止。

参考：[Paseo ensureAgentLoaded](/Users/lex/play/paseo/packages/server/src/server/agent/agent-loading.ts)、[Flyx 默认会话](/Users/lex/play/flyx/apps/mvp-host/src/storage/db.ts:467)、[Dispatcher](/Users/lex/play/flyx/apps/mvp-host/src/api/rpc-dispatcher.ts:33)。

## 10 W07 Client Runtime 和移动恢复

### Runtime 所有权

HostRuntimeRegistry 在一个客户端执行环境内按 hostId 持有 Supervisor、RPC、Outbox 和 SessionReplica。React 的 useHost 改成订阅已存在 runtime，组件卸载只释放 observer；desired Host 的生命周期由应用入口管理。多标签页各自的运行环境不能因此被宣称全浏览器只有一个连接，跨标签页凭据轮换和连接共享另设平台协调验收。

连接状态与领域状态分开。hello/身份/授权成功后 transport 可以 online，SessionReplica 仍 synchronizing 或 failed；Timeline gap、缓存失败和普通查询错误不把安全路径标 unavailable。认证、Host key、协议和 socket 失败才替换连接。

SessionReplica 采用 Map、稳定顺序索引、loaded window、epoch、source cursor 和 replicaGeneration。切换 Session 的请求除 transportGeneration 外，还要校验 replicaGeneration/sessionId；同一个 socket 上晚到的旧 Session 响应也不能覆盖新选择。

### 缓存和草稿

IndexedDB 升级到版本 2，新增 replica cache、draft 和 content metadata store。保留现有 profiles/credentials/commands；onblocked 提示关闭旧连接，升级事务失败不回退到无法持久化命令的内存 Store。

cache key 包含 hostId、Host fingerprint、sessionId、epoch、projectorVersion。先展示 stale 内容，权威页到达后按 revision 替换；不从缓存推断 idle、审批仍有效或资源已经删除。缓存写入失败影响缓存功能，不必杀掉已有健康 RPC；Outbox 写入失败必须阻止新业务发送。

草稿以 Host/Session 为 key。提交先持久化 command 和 clientMessageId，再清除草稿；app.tsx 当前在调用 sendPrompt 前 setPrompt("")，必须改掉。存储失败保留输入，网络回执未知保存原命令，并提供核对入口。

当前 outbox 已明文保存 prompt。新增缓存设置正文保留期限、容量及本机清除，按真实平台能力描述安全级别；原生 secret storage 与普通正文 cache 分开。

forgetLocalHost 原子删除 profile、credential、cache、draft、outbox 和 selectedHost，并关闭 runtime；revokeRemoteDevice 是独立服务端写。离线本机忘记记录不显示服务端授权已撤销。

### Wakeup 策略

PlatformSignals 提供 online/offline、visibility、pageshow 和单调时钟；不自行重连。Supervisor 使用注入时钟和 random，提供 stableWindowMs、suspensionThresholdMs、probeDeadlineMs 等配置。

离线启动等待 online，不消耗退避；短前台恢复 probe 当前 lease；长后台或 socket 已失效替换 generation，随后领域补同步。延续当前 exponential+jitter 策略，连接保持 30 秒稳定后才清零，避免短时 flapping 总回到首次重试。

online、用户 retry 和生命周期信号共用去重唤醒入口。Direct 优先升级继续受未确认写的约束；credential rotation 的 AUTH_REFRESHED 仍使用专门路径，不当成设备撤销。保留一个端点选择者，UI 不另开重连循环。

退出条件：组件重复挂载不重复配对、不丢历史；旧 cache 和晚到请求不覆盖 live；长后台恢复不重复写；忘记 Host 后所有归属数据可核对清除。

参考：[T3 Supervisor](/Users/lex/play/t3code/packages/client-runtime/src/connection/supervisor.ts)、[Paseo HostRuntime](/Users/lex/play/paseo/packages/app/src/runtime/host-runtime.ts)、[Flyx activation](/Users/lex/play/flyx/packages/client-core/src/client.ts:227)、[Web 归属](/Users/lex/play/flyx/apps/mvp-web/src/use-host.ts:65)。

## 11 W08 类型化 Interaction 和手机卡片

InteractionRequest 统一绑定 interactionId、Session、Turn、attempt、runtimeGeneration、nativeRequestId、version、expiry、kind 和允许动作。status 与 deliveryState 分开；至少表达 pending、responding、delivered、confirmed、expired、superseded、outcome_unknown。同一请求只能有一个 reservation，不能让两个设备选出两份待派发答案。

先迁移旧审批，保持 approval.respond 兼容；新请求要求 expectedVersion。旧未携带 version 的响应由兼容层按当前权威 pending 状态处理，若已 reserved 则拒绝，不通过读取新 version 允许第二次选择。InteractionStore、receipt 和 intent 共享事务。

question.respond 使用 approval:write。问题、选项、答复字数、问题数和总编码大小都有 schema；使用 Host 生成稳定 option ID，Provider 的 label 与答案映射留在 Adapter。自由输入不能绕过原生 request 的结构或权限。

Claude 的 SAFE_TOOLS 和 PreToolUse 当前都没有 AskUserQuestion；需要在两处显式添加受控分支，返回经过验证的 updatedInput，并证明 SDK 真正收到了答案。工具类型声明存在不代表当前权限模式会触发 callback，先做真实版本契约。

Codex handleRequest 当前只允许两种审批方法。新增 item/tool/requestUserInput 的严格 parser、pending native RPC ID 和 response serializer；每个别名按真实版本建立兼容项，不自动接受未知交互 method。不能只复用 Bash allow/deny 来回答结构化问题。

卡片展示工作区、执行内容、命令/文件预览和请求原因；缓存态禁用。按钮状态跟随 reservation 与 delivery，而不是立即本地 resolved；过期、runtime 更换及 Host 恢复 supersede 旧请求。Question 的阻塞状态由扩展 snapshot 表示，旧 activity enum 保持可解析，旧客户端明确提示需要新版本。

退出条件：双设备竞争、过期、响应途中断线、Host crash、原生 request 已失效均不伪造成功；真实 Claude/Codex 的答案回传有来源证据。

参考：[Paseo Question core](/Users/lex/play/paseo/packages/app/src/components/question-form-card-core.ts)、[Flyx Claude 工具策略](/Users/lex/play/flyx/apps/mvp-host/src/claude/adapter.ts:348)、[Codex 请求入口](/Users/lex/play/flyx/apps/mvp-host/src/codex/adapter.ts:520)。

## 12 W09 Checkpoint Diff 和回退预览

GitDriver 先提供正确的 status/parser、tree capture、tree diff 和受控文件读取，继续通过 execFile 传参数，不拼 shell。查询关闭 ext-diff、textconv、fsmonitor 等不受控执行路径；捕获还要处理 clean filter 和 attributes，避免 checkpoint 触发仓库配置中的外部命令。

checkpoint before 在用户 Turn 派发前、持有 workspace lease 时捕获；after 在 Provider 已停止写入且 ingestion 终态提交之后捕获。after 未结束前下一个写任务不能启动。Provider 终态和 checkpoint 状态分开，capture 失败标 Diff unavailable，不把任务成功改为失败。

保存 workspaceTree、indexTree、HEAD、受控文件清单、captureStatus、samplingDigest、Turn/attempt 和 policy version。隐藏 ref 名称由 Host 生成，不能直接使用客户端任意 ref。临时 index 不修改用户 index、branch 或 HEAD。

从用户 index 的临时副本执行 write-tree，捕获前后核对原 index 字节摘要。workspace tree 与 index tree 分别建立可达的隐藏 commit/ref，并在 checkpoint manifest 保存两份关联；只把 index tree OID 写进 SQLite 无法阻止 Git GC。未结束的 capture、恢复或预览计划引用的 ref 不参与回收。

工作树的字节一致捕获优先使用受控 hash-object --no-filters 与临时 index；Git attributes/filter/LFS、symlink、submodule 和 conflict index 分别测试。无法完整捕获时列出 unsupported 状态，不承诺完整恢复。unborn HEAD 使用显式 empty tree，新文件纳入非 ignored 清单。

每个 Turn Diff 比较其 before/after，Session Diff 比较实际 Session baseline 与当前 checkpoint。外部编辑、git commit、HEAD 改变和 capture 时文件变化可能破坏归因，保存采样前后指纹并提示；共享 checkout 的时间区间变化不能宣称全由 Agent 产生。

Diff API 返回文件目录及状态，再按文件获取 text/binary/contentRef。文件列表超过上限仍可分页，不将 200 文件之外的变更静默丢失。rename 保留 old/new path，删除、权限改变和新文件完整展示。

previewRevert 返回 planId、expiresAt、expectedWorkspaceDigest、expectedIndexDigest、nativeHandle binding、epoch、将覆盖/删除的文件及不可支持项。计划存 Host DB，绑定设备和 Session；P1 只预览，不执行。

退出条件：已有 dirty/staged/untracked baseline 被包含而不改变 index；rename 不产生伪造文件；大 Diff 可读；缺 ref 和 capture 失败有准确状态；HEAD 后续变化不能把历史 Diff 悄悄改成另一个基线。

参考：[T3 capture](/Users/lex/play/t3code/apps/server/src/vcs/GitVcsDriver.ts:651)、[T3 restore](/Users/lex/play/t3code/apps/server/src/vcs/GitVcsDriver.ts:737)、[Flyx baseline](/Users/lex/play/flyx/apps/mvp-host/src/session/orchestrator.ts:640)。

## 13 W10 诊断 备份 与真实版本门槛

doctor 返回 Host owner/readiness、schema、各 Provider verified version、活动和未知 intent 数、队列预算、Timeline head/indexed cursor、内容存储、checkpoint 失败和 Relay 状态。远程诊断按 scope 过滤，默认不含正文、完整路径、账户元数据和 secret。

backup 在 owner 下执行 SQLite 一致性 backup；记录 DB schema、应用版本、Host fingerprint、身份文件关联及 Relay 注册版本。身份轮换/注册更新与 manifest snapshot 协调，不能把不同代际的 DB 和私钥拼成“完整备份”。restore 只能在离线维护 owner 下进行，先验证、创建当前状态恢复点，再安装备份并核对外部 Git/Provider 历史。

恢复 DB 后旧 grant/credential/lease 默认失效，dispatching/acknowledged 意图进入 recovery；备份不是 Git 或 Provider 的时间回退。SQL integrity_check、foreign_key_check、schema version 和内容引用检查通过后才提供写 readiness。

真实矩阵保存 SDK/CLI/Node/OS、解析后的 executable、认证模式、启用 capability、Turn/approval/interrupt/recovery 的原生证据及结果。Codex 和 Claude 使用同等标准；getVersion 或 fixture 通过不能代替真实审批和停止保证。

usage/cost 记录来源和可用性。Codex 当前 turn_completed 合成 costUsd=0，这只能作为遗留占位，不能在诊断或预算中解释成实际免费；新用量合同用 native、estimated、unknown 表示来源，缺少成本返回未知，不能据此宣称预算已受约束。

run-matrix 当前等待 Pairing token 文本，改为显式测试 readiness artifact/受控入口。测试 pairing credential 仅写 owner-only 临时文件，不进入正常 startup 输出或报告；实际终端配对继续走本机确认。结果保留通过、失败、跳过和不支持，不能通过函数提前 return 计算真实通过。

生产启动入口使用固定构建产物，开发 bootstrap 可以安装/构建，正常 service 重启不依赖网络。self-update 与 Rust sidecar 后续独立实施，不成为 M2 的前置依赖。

退出条件：一致性备份与恢复演练通过；未来 schema 拒绝写入；真实双 Provider 和真机 Direct/Tailscale/Relay 的阶段能力有证据。

## 14 W11 分阶段回退与隔离并发

RevertOperation 保存计划、当前 stage、每步 dispatch marker、workspace 安全恢复点、Provider 对话边界和错误。stage 至少包含 validated、safety_captured、workspace_restored、provider_rewound、projection_committed 和 partial_failure；每个不可原子外部步骤前后均持久化。

重新取得 lease 后再验证 plan digest、expiry、actor 权限、当前 Turn、native handle 与 epoch。安全恢复点先完成，再按受控文件集合恢复工作树和独立 index tree；删除仅针对计划中的文件，不用无条件 git clean -fd。权限、symlink、untracked 冲突和空间不足均可能失败。

Provider rewind 是第二个外部状态域，SQL transaction 无法覆盖 Git 和原生 Provider。阶段失败保留执行记录及安全点，阻止新 Turn；下一次操作从事实核对继续或恢复安全点，不能只删锁或换 epoch 抹掉分裂状态。

全部成功后，通过 Engine 提交新 epoch/视图边界及操作结果。旧 Event/receipt 保留；新视图可标记被回退的分支，不将删除旧事实作为撤销手段。Provider 不支持 conversation rewind 时只开放明确命名的 workspace restore，后续任务采用新会话或已验证恢复路径。

worktree create/archive/restore 同样是持久 operation。RPC 仅接受已注册 repo 和生成的路径/branch ID；不同 worktree 独立 lease，删除前确认无运行任务和无需要保留的 dirty 文件。Session archive、runtime close 和 worktree 清理三个动作分别表示。

退出条件：每一阶段注入 crash/失败均能核对和处理；workspace/provider 状态不一致时不得进入 ready；多个隔离 worktree 可并发，同一 checkout 仍不能双写。

## 15 W12 提醒 原生平台 与后续能力

先基于已提交事件生成 attention：等待回答、等待审批、任务完成、恢复阻塞。attention key 绑定 Session/Turn/Interaction 和版本，通知重试去重。presence 只选择页内还是平台提醒，不决定事实是否交付。

原生平台先实现 PlatformSignals、安全凭据存储、deep link 和状态恢复，复用 HostRuntime/SessionReplica。推送只含最小 routing/attention 元数据，正文和 Diff 在授权后读取；点击过期提醒先查询当前 Interaction，不能直接执行旧动作。

额外 Provider、ACP/MCP、语音、通用终端、多 Agent 和定时任务分别开独立工作项。M3 的隔离并发不等同于多 Agent 调度，提醒不等同于定时自动执行；新增自动写需要自己的 actor、预算和恢复合约。

## 16 Schema 与 RPC 分批迁移

### Schema 版本计划

当前 db.ts 执行 SCHEMA 后才记录 version 2/3，不能用于未来版本拒绝。新 open-store 先读取 sqlite_master 和 schema_migrations，验证结构与最高版本，之后才允许 writer migration。空 DB 走显式 baseline；已有 v3 DB 检查实际列和约束，不凭 version 行存在就认为所有结构正常。

| 迁移 | 内容 | Backfill 与安全条件 |
| --- | --- | --- |
| 004 Command execution | Session revision、回执资源/hash 版本、attempt/native Turn binding、event commit 边界、execution_intents | 旧 accepted 操作不伪造成新 pending；活动旧行保守进入恢复 |
| 005 Recovery gate | active_turn_id、recovery revision/state、恢复 operation、活动索引 | 全部读取改为明确活动关联后再放宽 outcome_unknown 索引；旧未知默认 blocked |
| 006 Timeline content | epoch、版本投影、content stream/blob/ref 和查询索引 | 用原日志可恢复的内容 backfill；建立 building epoch，验证后切换 |
| 007 Catalog | Workspace、Provider instance、Session metadata、legacy default、import manifest | 保留原 UUID/sequence/provider；副库设备授权不成为有效授权 |
| 008 Interaction | reservation、delivery state、native request binding、Question schema | 旧 resolved 保留 legacy 证据等级；不把旧本地 bool 还原为原生 ACK |
| 009 Checkpoint operations | index/workspace tree、Diff metadata、preview、revert/worktree journal | 旧 HEAD baseline 标 legacy/inexact，不能补造不存在的精确 before snapshot |

每次 migration 在 owner 下使用事务并记录版本；需要文件或 Git backfill 的任务单独 journal，不在 SQLite transaction 中等待外部操作。先部署能读新增 schema 的 Host 与客户端，再启用 feature。关闭 feature 停止新的 admission，已接受的 intent 继续结算或进入恢复。

### RPC 的共同要求

| RPC 组 | 关键参数与授权 | 返回与错误 |
| --- | --- | --- |
| Session registry | sessionId/workspaceId/providerInstanceId；创建和生命周期写带 commandId/expectedRevision，session:write | SessionSummaryV2；SESSION_REVISION_CONFLICT、WORKSPACE_BUSY |
| Recovery | 原 Turn/attempt、evidenceId/revision；inspect 为 session:read，reconcile/acknowledge 为 session:write | evidence/operation；RECOVERY_BLOCKED、RECOVERY_EVIDENCE_STALE |
| Timeline | Session/epoch、订阅 ID、after 的固定 W 或 before 的复合 key；session:read | covered/page/cursor；EPOCH_MISMATCH、CURSOR_EXPIRED、VIEW_RESYNC_REQUIRED |
| Content | Session/ref/offset/maxBytes；session:read | 不可变 chunk/hash；CONTENT_NOT_FOUND、CONTENT_SCOPE_MISMATCH |
| Interaction | interactionId/expectedVersion/类型化答案；approval:write | accepted/delivery status；INTERACTION_RESPONDING、INTERACTION_EXPIRED |
| Checkpoint | 受控 checkpoint/文件 ID；查询 session:read，执行 session:write | Diff/plan/operation；PLAN_STALE、CAPTURE_UNAVAILABLE、REVERT_PARTIAL_FAILURE |
| Access receipt | commandId；access:self 加原命令权限与 actor 校验 | 自己的回执摘要；不返回凭据 secret |

每个新 method 同时更新 protocol schema、requiredScopeForMethod、Dispatcher、public projection、client typed API 和权限测试；遗漏任一项不打开 capability。所有列表和错误都受编码预算与脱敏约束。

新 capability 包括 session-recovery-v1、timeline-projection-v1、bounded-content-v1、session-registry-v1、structured-question-v1、checkpoint-diff-v1；完整回退另设 checkpoint-revert-v1。legacy Direct v1 与原 v2 只走已有兼容路径，新能力不能通过宽松解析或安全降级获得。

## 17 可审阅改动拆分与依赖

下表将原 W01–W12 分成可独立审阅的改动。工程量使用 S/M/L 相对标记，不承诺日期；每批都有对应退出条件，不能以“文件已抽取”替代行为验收。

| 批次 | 关联工作项 | 主要改动 | 依赖与退出条件 | 量级 |
| --- | --- | --- | --- | --- |
| R01 | W01 | scripts/CI/test tsconfig、文本语义、Turn terminal 判定、Git parser | 产品检查不被 fixture 阻断；B06/B09 转回归 | M |
| R02 | W01/W03 | DispatchContext 与两 Adapter/test adapter fence | B07、准备失败、迟到事件通过；不增加新功能 | M |
| R03 | W02 | open-store、owner、read-only/maintenance 与 bootstrap | 第二实例不写、不恢复、不 preflight；管理命令不迁移活跃 DB | M |
| R04 | W02 | managed process、异步 close、lifecycle 和 test entrypoints | producer/operation/ingestion 关闭顺序通过 | M/L |
| R05 | W03 | commitCommand、纯决策、interrupt 原子性、migration 004 | 写失败 Adapter=0；既有 start/approval/terminal 原子性不退化 | L |
| R06 | W03 | 持久 intent、控制通道、worker/drain 与故障窗口 | R04/R05；长任务不阻塞中断，crash 不自动重复派发 | L |
| R07 | W04 | native binding、RecoveryService、migration 005、query-only Outbox | R02–R06；原执行核对后可继续，B08 不再阻挡只读核对 | L |
| R08 | W05 | ContentStore、FrameBudget、各旧查询的有界结果 | R03/R05；大响应不关闭 socket，引用授权完整 | M/L |
| R09 | W05 | projector versions、epoch backfill、openView/page/subscription | R05/R08；万级冷启动、固定 W 和完整 after 通过 | L |
| R10 | W05/W07 | client 保存协商结果、SessionReplica、React canonical 分流 | R09；旧客户端路径回归、新副本不重复投影 | M/L |
| R11 | W06 | Workspace/Provider/Session registry、migration 007、legacy routing | R07/R09/R10；双 Provider 多 Session 与分库导入通过 | L |
| R12 | W07 | runtime 生命周期、平台 wakeup、cache/draft、清除数据 | R10，Session 路由接 R11；offline/background/stale 请求通过 | M/L |
| R13 | W08 | Interaction reservation/delivery、Question 与卡片 | R06/R11/R12；真实原生回传及双设备竞争通过 | L |
| R14 | W09 | checkpoint capture、精确 Diff、大文件视图和 preview | R06/R08/R11；before/after/index/dirty/new files 通过 | L |
| R15 | W10 | doctor/backup/restore、矩阵和固定产物运行 | 版本检查随 R03 起实施，真实验证随各能力补齐；M2 发布前闭环 | M |
| R16 | W11 | revert journal、分阶段外部恢复、partial failure | R07/R13/R14；每个 crash 点可核对与处理 | L |
| R17 | W11 | worktree 管理和隔离并发 | R11/R14/R16；同 checkout 防冲突，worktree 生命周期通过 | L |
| R18 | W12 | attention、原生平台接入、最小推送 | R12/R13；过期提醒和后台恢复不重复写 | L |

M1 交付 R01–R10 的已验收子集，并包含 version gate、最小诊断和迁移备份；恢复依赖的进程监管不能延到 M2。M2 交付 R11–R15 并补齐真实 Provider/手机证据。M3 交付 R16–R18。自动升级、额外 Provider 和多 Agent 另排后续批次。

R03 完成后，R08 的接口和预算工作可与 R04 的生命周期工作分别推进；两者修改 Event/Projection 的提交路径时先按 R05 合约统一，不能各自复制一套写入机制。

## 18 验收用例与发布条件

### 确定性验证

| 范围 | 用例与故障注入 | 必须断言 |
| --- | --- | --- |
| 流式投影 | 连续 delta、完成 replace、tool/assistant 交错、中断前缀、同 Item 晚到旧 revision | DB/public/client 正文一致；Turn 终态不能靠消息状态推断 |
| Provider fence | ensureClient/loadThread/start 任一失败，再开始下一轮；resume 和旧 callback | 每轮使用 Engine context；不吞下一轮合法事件 |
| 所有权 | 同 DB/identity 别名、不同 DB 同 checkout、stale lock、PID 复用、EPERM | 第二实例不改事实；未知进程不被误杀或放行 |
| 命令原子性 | 每个写操作的 Event/Projection/Receipt/Intent 单点失败 | 全回滚、无原生调用、无虚假的接受状态 |
| 派发窗口 | pending、claimed、dispatching、ACK、终态提交前 crash | 只有可证明未发出的意图能重新派发 |
| 控制调度 | 长 Turn 未结束、多个审批、中断与终态竞态、queue full | 控制可达；一个命令的 reservation/intent 只生效一次 |
| 关闭 | SDK 不退出、stdio 不退出、晚到 event/checkpoint、关库失败 | 有期限和状态；DB 后无写；未证明停止则 lease 不放行 |
| 恢复与 Outbox | Native terminal/unknown/running，accepted→terminal，unknown→reconciled，备份后 receipt 缺失 | 查询可更新事实；任何路径都不自动重发未知写 |
| Timeline 页 | 10,000 源事件、无 Item 的页、W 后修改同 Item、多页 after、事务批次边界 | covered 连续；页只反映其水位；cursor 不按 Item 数推断 |
| 大内容 | 300 KiB Diff、1 MiB final、JSON 转义、中文/emoji、source ranges、多个 pending 请求 | 所有编码结果在预算内；ref/hash/chunk/授权正确 |
| Client 生命周期 | 重复 mount、切 Session 后晚响应、offline 启动、短/长后台、cache 晚到 | 单执行环境内不重复创建 runtime；stale 不覆盖 live |
| Interaction | 旧版本、双设备、过期、native request 消失、响应传输未确认 | 不伪造工具执行或原生确认；错误状态可核对 |
| Git | rename/copy、unborn、dirty/staged/untracked、ignored、binary、filter、submodule、index conflict | 不改用户 index；不伪造完整 capture；文件清单准确 |
| 回退 | plan 后外部修改、workspace restore/provider rewind 各步失败、磁盘满、Host crash | 计划拒绝或 partial failure；保留安全点并阻止新 Turn |
| 迁移导入 | v3 fixture、未来版本、缺失列、冲突 UUID、Host fingerprint 不同、authorization 差异 | 保留事实与身份边界；不自动放行副库授权 |
| 访问边界 | 新 RPC 的 scope、跨 Session ref、旧回执资源绑定、撤销后 pending intent、Host 私有目录 | 新功能不绕过授权、加密和私有目录边界 |

测试使用 fake clock、barrier、failpoint、operation registry 和 drain，不用固定 sleep 判断状态。ProviderRun 的 outcome 被独立等待，测试同时证明控制通道可达。确定性 Transport/Gateway 集成验证 Direct/Relay 使用相同业务投影。

### 实测与目标的区别

B01–B05 来自前一轮定向复现，本轮增加 B06–B09。当前已有构建和产品测试结果沿用主方案中的记录；本轮没有再次运行全套产品/E2E，也没有执行真实 Provider 或参考项目 daemon。新增事实来自上述源码路径与注入验证。

万级历史、大内容、恢复 P95、流式额外延迟和存储增长是待验收目标。M1 发布需要新故障用例、现有产品检查和受控兼容用例通过；M2 另需真实双 Provider、真机后台与端到端网络证据。代码合并本身不能替代这些门槛。

### 关键源码入口

| 范围 | 当前源码入口 | 参考机制 |
| --- | --- | --- |
| 生命周期 | [main](/Users/lex/play/flyx/apps/mvp-host/src/main.ts)、[server](/Users/lex/play/flyx/apps/mvp-host/src/server.ts)、[Orchestrator](/Users/lex/play/flyx/apps/mvp-host/src/session/orchestrator.ts) | Paseo owner/process；T3 启动 gate 与 scope |
| 持久事实 | [db.ts](/Users/lex/play/flyx/apps/mvp-host/src/storage/db.ts)、[db tests](/Users/lex/play/flyx/apps/mvp-host/src/storage/db.test.ts) | T3 transaction/decider；Flyx device-scoped receipt |
| Provider | [types](/Users/lex/play/flyx/apps/mvp-host/src/provider/types.ts)、[Claude](/Users/lex/play/flyx/apps/mvp-host/src/claude/adapter.ts)、[Codex](/Users/lex/play/flyx/apps/mvp-host/src/codex/adapter.ts)、[stdio](/Users/lex/play/flyx/apps/mvp-host/src/codex/app-server-client.ts) | Paseo NativeHandle/loading；T3 driver/runtime 能力分离 |
| RPC 与授权 | [Dispatcher](/Users/lex/play/flyx/apps/mvp-host/src/api/rpc-dispatcher.ts)、[Gateway](/Users/lex/play/flyx/apps/mvp-host/src/api/connection-gateway.ts)、[method scope](/Users/lex/play/flyx/apps/mvp-host/src/auth/connection-authorizer.ts)、[public projection](/Users/lex/play/flyx/apps/mvp-host/src/api/public-projection.ts) | 保留共用鉴权和投影入口 |
| 客户端 | [FlyxClient](/Users/lex/play/flyx/packages/client-core/src/client.ts)、[Supervisor](/Users/lex/play/flyx/packages/client-core/src/connection-supervisor.ts)、[SyncEngine](/Users/lex/play/flyx/packages/client-core/src/sync-engine.ts)、[Outbox](/Users/lex/play/flyx/packages/client-core/src/command-outbox.ts) | T3 domain/transport 分层；Paseo replica 生命周期 |
| Web | [useHost](/Users/lex/play/flyx/apps/mvp-web/src/use-host.ts)、[timeline](/Users/lex/play/flyx/apps/mvp-web/src/timeline.ts)、[app](/Users/lex/play/flyx/apps/mvp-web/src/app.tsx) | 组件只订阅副本，手机交互与大内容视图 |
| Git 与验证 | [GitService](/Users/lex/play/flyx/apps/mvp-host/src/git/git-service.ts)、[matrix](/Users/lex/play/flyx/scripts/compatibility/run-matrix.mjs)、[start-host](/Users/lex/play/flyx/scripts/start-host.sh) | T3 hidden ref/candidate 思路；独立实际版本证据 |

## 19 实施记录

本节记录已集成的代码与验证结果。局部测试通过、模块已提交、端到端接通和发布验收分别记录；尚未取得真实 Provider 或手机证据的能力仍保持未验收。

开发分支：`codex/flyx-optimization`；远程：`https://github.com/elex-fu/flex`。用户已批准源码基线及后续任务提交推送。基线提交 `63599da` 保存原有工作树，排除了运行数据目录。

| 批次 | 当前状态 | 已集成提交 / 验证 | 剩余验收 |
| --- | --- | --- | --- |
| R01 | 已完成并推送 | `4a46642`：Git 19、Timeline 14；`5eddded`：清洁副本 build、生产/测试类型检查、产品与 fixture 检查通过 | 后续批次继续沿用统一验证入口；浏览器仅发现 24 用例，尚未执行 |
| R02 | 已完成并推送 | `866e407`：Host 192 通过、5 明确跳过；`49ac8ce`：内部运行绑定脱敏，相关 16 用例与类型检查通过 | R03 接入真实 owner，R05/R06 接入持久 attempt；真实 Provider 契约随 R15 验收 |
| R03 | 所有权基础已集成并推送 | `bdd21d6`、`ad9b0f0`、`ff5c2dc`、`4ab9e49`、`f67181d`：原 owner、只读打开、显式恢复维护、004→006 迁移/重开检查 | 原 Host 硬崩溃的恢复入口补齐；原路径 lease 后续接 worktree |
| R04 | 生产生命周期已合入，平台停止证明未完成 | `86febe3`：Adapter 管理进程、原始派发绑定、异步关闭和共享 Store/Views 归属 | macOS 后代停止仍为 unknown；真实 Provider 与整体入口验收 |
| R05 | 原子引擎已集成并推送 | `5c34c20`、`3e5a4c5`：owner/lease 接入、命令故障矩阵和冻结旧版本迁移 fixture | 其它批次继续使用同一原子提交入口 |
| R06 | 核心及执行钩子已合入 | `5ec7a3c`、`c2e0bbd`、`8feef42`：Worker、Checkpoint 钩子、明确停止后解除保留运行绑定 | 泛化 operation 工厂、多 Session 和最终关闭合并验收 |
| R07 | Host/RPC/离线恢复入口已合入 | `7be14c7`：原尝试证据、已知结果与执行 gate 分离、硬崩溃维护和 typed client | 多 Session 路由、可信版本/进程检查与真实 Native 证据 |
| R08 | 模块已集成并推送，生产链路已接通 | `7e37d45`、`f67181d`、`59d7616`：正文引用、权限、006 SQL 和严格响应预算 | 最终 Web/原生大内容入口与整体回归 |
| R09 | 生产链路已集成，合并验收中 | `bbf31d8`、`f4bfcf7`、`59d7616`：固定水位、epoch、万级历史、Direct/Relay 与磁盘重开 | 多 Session/Interaction 投影及最终浏览器验收 |
| R10 | 共享核心及 Web 入口已合入 | `da7f23f`、`eee9af1`、`6222d68`：Replica、能力协商、引用、Session DTO 和只读回执核对 | Host 动态能力启用及真实浏览器闭环 |
| R11 | Catalog 和协议模块已合入，生产工厂集成中 | `630da94`、`ee882b6`、`f361d9f`：007、离线导入、公开 DTO 与 SessionClient | 多 Session 工厂、legacy 固定路由、共享 Store 与运行时关闭 |
| R12 | 共享核心及 Web 草稿入口已合入 | `1f26299`、`6222d68`：平台信号、runtime 归属、持久草稿、原子发送、本机清除与启动屏障 | 真实浏览器及手机后台恢复 |
| R13 | 008 和生产 RPC/控制钩子已合入 | `54e8ae0`、`e132b32`、`f361d9f`：reservation、delivery、Question、审批卡片和原子终态伴随事件 | 多 Session 单投影 hook、Gateway 动态能力与真实答案回传 |
| R14 | 模块和执行钩子已合入 | `916e3b2`、`c2e0bbd`、`f361d9f`：独立 index/workspace checkpoint、原始文件、终态后捕获、Diff 与预览 | 生产 factory/RPC/UI 接通及真实捕获验收 |
| R15 | 模块及 owned operations 已合入 | `82096b9`、`3790ecb`、`ac5988b`、`1d47948`：doctor、备份恢复、固定产物、握手、restore 写 gate | 主入口/CLI 组合、双 Provider 与真机 |
| R16 | journal、受控恢复及 SQL 已合入 | `56465d0`、`8715b50`、`f361d9f`：分阶段恢复、安全点、恢复证据与 readiness fencing | 生产 factory/RPC/UI、托管 helper 与真实 Provider rewind |
| R17 | 模块及 009 已合入，生产绑定开发中 | `233c2ac`、`f361d9f`：worktree 持久操作、原路径 lease 与隔离并发 | Catalog/Worker/RPC 接通、托管 Git 与真正停止证明 |
| R18 | attention SQL 与 Expo 最小平台已合入 | `a27a056`、`de38bc5`、`f361d9f`：提醒事实/队列、010、安全凭据/deep link、共同核心 | Host 提醒工厂与实际推送、真机网络和后台恢复 |

当前仍为开发分支，M1/M2/M3 均未宣称发布完成。整套方案完成前，必须逐项核对第 18 节的退出条件，包括确定性故障、真实 Provider 和真机证据。

2026-10-15 已集成基础的合并验证：Host 570 用例通过、5 个真实 Provider 用例明确跳过；client-core 101 用例、Web 26 用例通过，Host/client/Web 严格类型检查及 Host 构建通过。Host 测试使用本机临时监听和测试数据，禁用真实 Provider。后续生产端口、007–010 激活、多 Session 和原生平台提交继续进行独立合并验收，不能据此宣称完整十八批次已交付。

## 20 客户端范围与交付优先级

客户端工作主要集中在 R10、R12 和 R18。R11 的 Session 选择、R13 的审批/问答、R14 的 Diff、R16/R17 的恢复和 worktree 操作另有界面配套，因此不能将三个批次理解成全部客户端工作。客户端核心负责数据一致性和可靠发送，Web 与 Expo 复用这套机制；原生平台适配另行实现存储、生命周期、网络和配对。

| 范围 | 当前必要性 | 首版交付边界 | 直接收益 |
| --- | --- | --- | --- |
| R10 能力协商与 SessionReplica | M1 必须完成 | 固定水位分页、引用校验、跨 Session 迟到响应隔离、缓存与权威状态分离 | 大历史可用；切换会话不会串数据；大响应不会断连接 |
| R12 Runtime、草稿和 Outbox | 日常使用必须完成 | 应用持有连接；组件只订阅；持久化命令后清草稿；后台恢复不重复发送；本机清除 | 刷新与短暂断网可恢复；输入不因存储失败丢失；未知结果可以核对 |
| Web 功能闭环 | M1/M2 的主要入口 | Session 选择、Timeline、审批/问答、Diff 与恢复状态及回执查询 | Host 新能力能够实际操作与验收 |
| Expo 平台与最小界面 | 保持 M3；移动需求明确时有价值 | 安全凭据、普通正文 SQLite、配对/deep link、AppState/NetInfo、最小会话与交互界面 | 为手机访问复用共同核心，验证平台差异 |
| 完整原生 UI 与额外体验 | 可延后 | 完整导航、复杂通知设置、语音和更多视图另排 | 主要改善使用体验；不作为 Host 可靠性验收的前提 |

开发优先级是共享核心与 Web 端到端闭环，再进行 Expo 最小平台验收。原生代码和模拟平台测试通过仅说明实现可继续集成；真机网络、凭据与后台恢复尚须实际证据。SecureStore 保护短凭据，普通 SQLite 的正文缓存不宣称已经加密。提醒点击后重新读取当前状态，不能直接提交过期动作；未知命令始终核对原回执，不能因为重新连上而自动重发。

2026-10-15 合入最小原生平台及 Web 操作入口后的源码规模约为 5,000 行：共享客户端核心约 3,000 行，Web 约 1,200 行，Expo 约 700 行，不含测试和依赖锁文件。这个数字用于说明代码分布，不能换算为完成比例或剩余工期。当前必要投入主要是共享的可靠发送、草稿、权威状态与查询，以及 Web 的操作闭环；完整原生导航、语音和复杂通知设置仍保持后续范围。

本轮已验证共同核心 116 用例、Web 52 用例、Expo/Noise 73 用例，严格客户端类型检查通过；新增 SessionClient 的 15 用例另行通过。Host 全量合并回归仍在修正旧 fixture 和新生命周期/schema 的适配，真实浏览器正在验证。真实双 Provider、手机网络/后台/凭据和推送交付继续保持未验收。
