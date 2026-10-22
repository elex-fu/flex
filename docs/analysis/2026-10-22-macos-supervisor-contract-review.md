# macOS Supervisor R0/C0 契约审查（2026-10-22）

## 结论

**R0/C0 仍阻塞。没有候选在本次审查中同时证明身份绑定终止和完整 fork/exec/stop 闭包。** 这是未完成证明与验收的结论，不是“macOS 上数学上不可能”的结论；也不是要求把现有契约改成较弱的契约。

本次发现并实际运行了一个更具体的单节点候选：本机 `libproc` 的 `proc_signal_with_audittoken()` 能拒绝错误或 exec 前的 pidversion，并向当前 token 对应的本探针子进程发送 SIGKILL。它优于“查 PID 后 kill PID”的候选，但本次有限实验没有证明所有并发/PID 复用路径的内核原子性，也没有获得整树闭包证据。不能据此发布 `verifiedDescendantStop: true`。

依据为 [实施计划 R0](../core-capabilities-implementation-plan.md)、[技术方案 §4](../core-capabilities-technical-design.md) 与 [已有 macOS 探针报告](../macos-native-stop-contract.md)。本报告不修改这些契约。其他开发可继续做拒绝路径、已有模块组合和显式 fixture 验证；生产 macOS 正向执行仍不可用。

## 本次新证据与边界

实际只读环境检查：macOS **26.5.2 / 25F84**、Darwin **25.5.0**、SDK **26.5**、当前 UID **501**；`csrutil status` 返回 **enabled**。通过 `ctypes.CDLL('/usr/lib/libproc.dylib')` 检查，两项 `proc_signal_with_audittoken` / `proc_terminate_with_audittoken` 符号均存在。符号存在不等于跨所有版本的产品支持承诺。

本次在自动清理的私有临时目录编译并运行一个有界 C 探针，未使用 Provider、付费调用、ES 订阅、特权服务或权限修改。探针创建且仅控制自己的直接子进程：子进程通过 `task_info(TASK_AUDIT_TOKEN)` 取 token，通过继承管道报告 exec 前后 token，exec 后等待；父进程测试 token 信号请求，最后 `waitpid` 回收。父子设置 5 秒 alarm，外层执行期限 8 秒。

原始输出：

```json
{"sourceSha256":"86c80a83184ed86c4988329b2befe791d49accdbf9c198f0545b9012bb798fbf","buildExit":0,"buildStderr":""}
{"pidSameAcrossExec":true,"pidversionChangedAcrossExec":true,"wrongPidversionSigkillResult":3,"preExecTokenSigkillResult":3,"postExecTokenAliveCheckResult":22,"postExecTokenSigkillResult":0,"ownedChildReaped":true,"terminalSignal":9}
```

这些结果的精确含义：

- 错误 pidversion 与 exec 前 token 的 SIGKILL 均返回 **ESRCH (3)**；当前 token 的 SIGKILL 返回 **0**，所拥有子进程最终被回收且终止信号为 **9**。
- **`proc_signal_with_audittoken(token, 0)` 返回 EINVAL (22)**，上述 `AliveCheck` 字段只是探针调用名，不能当成存活成功证据或替代 `kill(pid, 0)` 的接口。探针通过最终直接子进程 wait 状态确认终止。
- **ESRCH 不能推出该原始谱系死亡**：同一 PID 的 exec 后进程可以使旧 token 请求返回 ESRCH。必须通过可信 exec 事件关联到新的执行身份；缺关联时保留 unknown。
- 错误版本实验不是实际强制 PID 复用试验。本次未跑并发压力、跨 UID、setuid/setgid、受保护目标或 ES 完整性测试，未确认所有 API 支持/授权范围。
- 之前的 setsid/double-fork/NOTE_TRACK/ES 无权限结果来自现有报告，本次阅读源码和报告，**没有重跑整套旧探针**。旧报告的 `ERR_NOT_PRIVILEGED` 不能证明 entitlement 已获授或未获授。

## 两项独立证明义务

### A. 原始身份绑定终止

`libproc.h:132–133` 声明 audit-token signal/terminate 接口。Apple 开源 libproc wrapper 将整个 token 交给专用内核调用；其返回值是 0 或错误编号，调用方不能误按普通 `kill()` 的 -1/errno 风格解释。[Apple wrapper](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)

候选实现只能使用来自受信内核事件/启动屏障的当前 token；必须保留不可变 birth 节点以及每次 exec 的 old→new 边。SDK `ESMessage.h:234–243` 明确区分 exec 前的 message.process 与 exec 后 event.exec.target，并说明 pidversion 会变化。不能只把最初 token 当成永久身份，也不能凭 PID 查询的新 token覆盖原始身份。

在可接受之前，仍需获得匹配目标 OS 的内核查找/持有引用/信号投递语义说明，确认 token 校验和使用不会重新回落到未绑定 PID；同时用自己的受控目标验证实际 PID 复用与 exec/退出并发。SIGKILL 已接受只表示请求，不是目标已死或树已死。`proc_terminate_with_audittoken()` 本次仅确认符号，没有实际测试其选用信号和完成语义。

Mach task port 是另一个单节点方向：SDK 暴露 task identity token 与 task_terminate，但获取正确进程控制权、跨 exec 的绑定、签名/权限限制及所有后代覆盖均未证明。本次没有获取任意外部进程的 task port，不把它作为已实现 fallback。

### B. fork/exec/exit/stop 的闭包

Apple WWDC20 说明同一 ES client 的消息按发生顺序交付、handler 串行。SDK 也说明按交付顺序处理。这是有用的顺序依据，不能忽略；但不能直接把用户态回调队列为空提升成内核因果闭包。[Apple WWDC20](https://developer.apple.com/videos/play/wwdc2020/10159/)

可研究的严格机制是 **完整因果谱系 + 每节点最终死亡确认**。只有以下前提成立，才可以用归纳证明“最后一个开放节点关闭”意味着整树关闭：

1. 初始 launch 屏障在任何负载用户代码、fork、spawn 前建立，root 已持久绑定；exec 目标也没有机会抢先运行。`POSIX_SPAWN_START_SUSPENDED` 只是本机头文件存在的候选旗标，本次未验证其全过程。
2. 每个实际子进程的创建必有归属父节点的 birth 事件；该事件的捕获/排序点早于父节点可被视为最终死亡的时刻，且覆盖线程并发 fork、vfork/posix_spawn、失败/中途退出和 exec。
3. 父节点的关闭证据保证它已经不再创建子进程，且所有此前创建的子进程事件均在可验证的事件前缀内。子节点早于 birth 消息到达的 exec/exit 必须暂存并正确关联，不能丢弃未知 PID 消息后宣布集合为空。
4. 每个节点只有经过可信最终死亡确认才可关闭。必须说明 `NOTIFY_EXIT` 的具体时间点与其他线程、持有的 FD/映射/尚在进行的写入之间的关系；不能假定一条名为 exit 的通知天然完成所有必要屏障。
5. 从初始屏障到最后关闭点，订阅与过滤覆盖、事件丢失检测、generation/boot、执行身份关联均连续；全部相关日志与最终结论已持久提交。

如果能证明这些前提，最后一个开放节点的最终关闭可以成为**派生的完成屏障**，不一定需要名为 barrier 的新 API。但本项目没有上述机制说明、匹配目标 OS 的验证产物或实际 ES 观察记录，故该证明目前不成立。不能用大量顺序样本替代缺失的保证。

本次 SDK 没有找到 AUTH_FORK。AUTH_EXEC 只能控制相应 exec，不会停止已运行线程或阻止 fork 后不 exec 的写入者。连续 `global_seq_num` 只检测已经收到的前缀是否有丢失；不能自行证明没有未产生/尚未归属的 fork 消息。静默等待、扫描为空、队列 drain、哨兵事件或时间戳排序，都必须另外证明其与每个在途 fork 的因果关系，否则仍是 unknown。[Apple global_seq_num](https://developer.apple.com/documentation/endpointsecurity/es_message_t/global_seq_num)

需排除的错误算法反例：stop 时快照只有 P；P 的另一线程或已经开始的 spawn 产生 C；监督器观察 P 退出便删除最后一个已知节点，而 C 的 birth/归属尚未完成。单靠“当前集合为空”会释放 lease。这里是**未证明顺序时必须防守的执行序列**，不是声称本次已经观测到 ES 按此顺序失效。正确机制必须证明它不可能，或明确等待所需的完成证据。

## 前置清单与当前状态

| 前置或机制 | 当前证据 | 判定 |
| --- | --- | --- |
| 正常 SIP 目标 Mac | 本次 `csrutil status` enabled | 已核对 |
| ES entitlement、签名服务身份、TCC、安装授权 | 本次没有可验证服务产物；没有申请、安装或更改权限 | 未落实；不推断账户是否拥有 entitlement |
| 按 token 终止单节点 | 本次局部真实探针通过，错误 token/旧 token 被拒绝 | 候选局部证据；原子语义和完整矩阵未完成 |
| 启动前完整绑定 | 现有协议要求；本次没有实际 Supervisor 实现 | 未证明 |
| 原生谱系覆盖和最终闭包 | 顺序/丢失检测文档；没有实机 ES 记录及上述因果证明 | 阻塞 |
| 服务崩溃、丢事件、磁盘失败 | 现有设计要求 unknown；没有原生验收 | 待实现及验证 |

## 给实施代理的接口约束

沿用技术方案现有 assess/registerHost/prepareLaunch/releaseLaunch/stopTree/inspectOriginal 方法，不新增一套独立运行架构，也不冻结一个声称已验证的 macOS contract ID。

- `assess` 分别报告 prerequisites、原始身份、启动屏障、事件覆盖、identity-bound signal、closure 的证据和缺项。对外 ready 必须要求全部满足；头文件、符号、ES client 可创建或某一项 fixture 通过都不能令其为 true。
- prepare 必须绑定已持久化的 launching、最终冻结计划、owner/operation/attempt、用途、UID/GID、checkout/policy 摘要；release 必须核对同一原始绑定已提交。失败路径不得交付 stdin 或伪造 spawn 成功。
- 同一 launch 的 birth 节点不变。exec 只新增执行身份转换记录；服务重启不得把新 generation 当成旧 launch 的完整续接。与当前服务连通不能验证旧记录。
- `stopTree` 和 `inspectOriginal` 返回原始 launch/owner/attempt、service identity/generation/boot、root birth、谱系摘要、覆盖区间、停止动作、闭包机制证据及日志提交引用。签名校验、来源绑定、contract allowlist 与原 launch 一致性都必须在 Host 映射前检查。签名只证明来源完整性，不证明结论正确。
- ESRCH、缺少 exec 转换、未知子节点、事件缺口、服务断线/重启、写日志或持久提交失败、超时，都不能返回可信 stopped。sig=0 的 EINVAL 也不能被映射成 exited。保留 owner/lease 与原操作证据。
- 有效新版本 proof 必须与已有 v1 Seatbelt proof 分支区分。当前 `native-boundary-proof.ts` 对 Darwin 只接受 unverified/false；不要删除这条限制或以 `as` 强制转换绕过。旧 macOS 记录仍保持原来的未知性。
- `ProcessInspector` 当前为同步接口；异步 IPC 不能通过类型断言塞进 `inspect()`。若需改接口，由相关调用链显式等待，或仅消费已有可核验、绑定原始 launch 的观察；不能因未 await 而提前释放 owner。
- fixture 可以验证错误签名、错 launch/owner、generation/boot 漂移、旧 token、缺闭包、超时和迟到响应拒绝。fixture 的 stopped 必须显式标注测试域，不能进入生产合同 allowlist 或兼容产物。

下一步最有价值的工作是完成上述 A/B 的**具体机制证明和受限本机验收前提**。在没有完整机制和所需授权前，不应投入把临时 ES 观察器包装成可发布监督器的工作；R1–R9 可继续其不依赖 R0 正向能力的部分。

## 附录：本次 audit-token 探针的精确源码与复现

以下 C 代码块的内容包含首行空行和末尾换行；UTF-8/LF 字节 SHA-256 为 `86c80a83184ed86c4988329b2befe791d49accdbf9c198f0545b9012bb798fbf`，与本次实际编译源相同。追加附录时仅校验字节摘要，没有再次运行探针。此源码用于受控子进程局部实验，不用于生产停止或内核保证证明。

```c

#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
static int emit(int fd) { audit_token_t token; mach_msg_type_number_t count=TASK_AUDIT_TOKEN_COUNT; int r=task_info(mach_task_self(),TASK_AUDIT_TOKEN,(task_info_t)&token,&count); if(r) return 1; return write(fd,&token,sizeof(token)) == sizeof(token) ? 0 : 2; }
int main(int argc,char **argv) {
 alarm(5);
 if(argc==3 && !strcmp(argv[1],"exec-child")) { int fd=atoi(argv[2]); if(emit(fd)) return 2; close(fd); for(;;) pause(); }
 int fds[2]; if(pipe(fds)) return 3;
 pid_t child=fork(); if(child<0) return 4;
 if(!child){close(fds[0]); if(emit(fds[1])) _exit(5); char fd[20];snprintf(fd,sizeof(fd),"%d",fds[1]); execl(argv[0],argv[0],"exec-child",fd,NULL);_exit(6);}
 close(fds[1]); audit_token_t before,after;
 if(read(fds[0],&before,sizeof(before))!=sizeof(before) || read(fds[0],&after,sizeof(after))!=sizeof(after)) return 7;
 close(fds[0]); audit_token_t wrong=after; wrong.val[7]^=0x40000000U;
 int bad=proc_signal_with_audittoken(&wrong,SIGKILL);
 int stale=proc_signal_with_audittoken(&before,SIGKILL);
 int live=proc_signal_with_audittoken(&after,0);
 int sent=proc_signal_with_audittoken(&after,SIGKILL);
 int status=0; pid_t waited=waitpid(child,&status,0);
 printf("{\"pidSameAcrossExec\":%s,\"pidversionChangedAcrossExec\":%s,\"wrongPidversionSigkillResult\":%d,\"preExecTokenSigkillResult\":%d,\"postExecTokenAliveCheckResult\":%d,\"postExecTokenSigkillResult\":%d,\"ownedChildReaped\":%s,\"terminalSignal\":%d}\n", before.val[5]==after.val[5]?"true":"false",before.val[7]!=after.val[7]?"true":"false",bad,stale,live,sent,waited==child?"true":"false",WIFSIGNALED(status)?WTERMSIG(status):0);
 return 0;
}
```

可直接从本报告提取精确代码并使用与本次相同的编译参数和执行期限；只在自动清理的私有临时目录生成源文件及二进制：

```sh
rtk proxy python3 - <<'PYPROBE'
from pathlib import Path
import hashlib, json, subprocess, tempfile
report = Path('docs/analysis/2026-10-22-macos-supervisor-contract-review.md').read_text()
section = report.split('## 附录：本次 audit-token 探针的精确源码', 1)[1]
source = section.split('```c\n', 1)[1].split('```', 1)[0]
assert hashlib.sha256(source.encode()).hexdigest() == '86c80a83184ed86c4988329b2befe791d49accdbf9c198f0545b9012bb798fbf'
with tempfile.TemporaryDirectory(prefix='flyx-audit-token-review-') as root:
    path = Path(root) / 'probe.c'
    binary = Path(root) / 'probe'
    path.write_text(source)
    build = subprocess.run(['/usr/bin/xcrun', 'clang', '-Wall', '-Wextra', '-Werror', str(path), '-o', str(binary)], capture_output=True, text=True, timeout=15)
    print(json.dumps({'buildExit': build.returncode, 'buildStderr': build.stderr}))
    if build.returncode == 0:
        result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=8)
        print(json.dumps({'probeExit': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}))
PYPROBE
```

## 10 月 23 日授权状态补充

用户确认 ES entitlement、Developer ID 和目标机器安装授权目前仍不确定，因此 C0 保持 blocked。本轮未安装服务、申请权限、修改 SIP 或系统配置；后续仅继续源码工程与已有边界内的证据审查。此状态表示当前缺少可验证的授权/安装/完整树闭合条件，不是对 macOS 原理上不可实现的结论。
