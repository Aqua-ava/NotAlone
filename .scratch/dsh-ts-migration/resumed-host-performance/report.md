# 宿主性能采样入口交付

结论：已交付可执行的成对采样与统计入口，并通过合成进程和实际旧／新宿主的短探针。**未启动正式长采样，原性能门禁未通过签收。** 最终验证及冻结提交见 `validation.json`、`probe-report.json`。

## 范围与来源

- 只新增本目录文件，不改产品源码、其他 runner、根交接、索引或任务状态；不暂存、不提交、不 push、不打包。
- 旧臂固定 `3c168296e9e8edaa43b8b323ff693e790e709069`，从 Git 导出其真实 Python 源码、SQL 与项目配置；不以合成进程或 Node 内存替代旧臂。
- 新臂冻结当前产品源码，记录 commit、与该 commit 的字节匹配结果及文件清单哈希，使用产品 `launchDsh` 和官方 profile。未来正式运行应在最终 TS 提交上重新 `prepare`。
- DSH 锁定 `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`，准备时核验七个已安装核心包版本。已读固定官方 [profile 组成规则](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts#L1-L22)、[官方启动说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L15-L45) 和 `packages/boot/app-boot/tests/profile.spec.ts:48–90`；本仓依据为 `backend-ts/src/launch.ts`、`backend-ts/test/host-http.test.mjs:1–36` 和 `host-storage-fixture.mjs:1–35`。观察器不另造 Harness 或修改 DSH 核心。
- 复用现有宿主启动器、认证握手与正式 SQL 迁移；未发现覆盖启动／进程树 RSS／真实 HTTP 三项预注册合同的现成采样器。门槛来自 `../baseline/evaluation-protocol.md:55–71`，缺口依据 `../comparison-protocol-gate-audit/handoff.md:11`。

## 执行入口

从仓库根目录执行。状态、源码副本、原始日志、临时配置、PG 克隆名均留在仓库外；`--out` 必须是新目录。

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/miniconda3/envs/NotAlone/bin:$PATH"
TASK_PERF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notalone-host-performance-XXXXXX")"
python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py prepare --state "$TASK_PERF_DIR/state"
python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py collect --plan "$TASK_PERF_DIR/state/plan.json" --out "$TASK_PERF_DIR/probe" --probe
```

正式采样由根会话在其他测试停止、最终 TS 臂完成后串行安排。以下命令约需 40 分钟以上，**本次没有执行**；75 分钟硬期限会触发采样器的有界清理与取消记录。使用 `--electron-absent` 前必须确实没有 Electron／NotAlone 进程，入口会前后核验；需要保留既有 Electron 时换为 `--electron-pid "$TASK_ELECTRON_PID"`，只读该身份的进程树并另列 RSS。不能同时运行另一个业务后端。

```sh
TASK_FINAL_PERF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/notalone-final-host-performance-XXXXXX")"
python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py prepare --state "$TASK_FINAL_PERF_DIR/state"
perl -e 'alarm 4500; exec @ARGV' -- python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py collect --plan "$TASK_FINAL_PERF_DIR/state/plan.json" --out "$TASK_FINAL_PERF_DIR/formal" --formal --electron-absent
python .scratch/dsh-ts-migration/resumed-host-performance/host_perf.py report --run "$TASK_FINAL_PERF_DIR/formal/run.json" --out "$TASK_FINAL_PERF_DIR/formal/reported.json"
```

准备会冻结源码与依赖字节、两种解释器、Python 包版本、profile、lock、同一合成 PG dump、工作负载、受控配置和空权重缓存。运行前后复核；变化、失败、取消、缺失均保留。新臂仍含 Python、Electron 缺失核验失败或样本不足时不能签为最终 TS 性能通过。

## 测量口径

- 启动：严格 ABAB，各 20 次单实例进程冷启动；每次从同一 PG dump 恢复独立测试库。旧臂计真实 Python 启动，新臂计官方 DSH 子进程 spawn 至认证业务联系人 HTTP 返回正确合成范围。父采样适配器准备不计入新臂后台启动；不宣称 OS 冷缓存。
- RSS：每次 ready 后 60 秒，每秒取整个后台进程树的 OS RSS；每次启动先取中位数，再比较 20 次启动的 median／p95。父启动观察器另列，Electron 指定树另列；缺席不虚构 0。迟到样本保留，超过所属一秒时间格半秒时不认证采样完整。
- HTTP：另启串行旧／新宿主，不把两个额外 HTTP 宿主混入 40 次启动样本；每例每臂预热 10 次，不计分，再测 30 次。合成 workload 为联系人列表、空来源列表、手动确认范围下默认讨论的持久写入及 HTTP 读回；两个 owner、每人四位联系人，无真实历史和消息。
- HTTP 入口统一为“请求头解析完成，进入业务处理器”，分别记录服务器响应完成、客户端响应读完、PG COMMIT／隐式提交确认、后续 HTTP 读回完成。事务记录驱动边界区间之和；无独立业务排队 marker 时 `queue_ms=null` 并说明原因。代理场景使用请求 ID 关联同机 Node／Python 单调时钟，不把外层 return 冒充提交时间。
- 服务器响应及写操作的提交完成按原 p50≤1.15／p95≤1.25 判门；启动、RSS 的 median／p95≤1.20。客户端往返、读回和事务值仅作观察，不增加门槛。观察器开销没有扣除，原始时间保持可追溯。
- seed 102、10,000 次、Mulberry32、R7 百分位。启动／RSS 按启动对重采样，HTTP 总体按 case 聚类并保留所属重复，单例按请求对重采样。报告配对差、median／p95、比值及 95% 区间；只有区间上界达标才通过，跨阈值保持未定。零基线不可比较；不丢掉对侧失败时本臂的慢成功。
- 每臂固定分母与失败 ID 单列；HTTP 新增失败直接失败。超时记录观测下界，错误响应与成功延迟分开，取消和缺失不充作快成功。输出是证据，CLI 退出 0 仅表示采集／报告命令完成。

## 验证与清理

```sh
python -m unittest discover -s .scratch/dsh-ts-migration/resumed-host-performance -p 'test_*.py' -v
node --check .scratch/dsh-ts-migration/resumed-host-performance/new-host.mjs
node --check .scratch/dsh-ts-migration/resumed-host-performance/perf-preload.mjs
```

测试只经 CLI、真实 HTTP、进程生命周期与公开数据库驱动边界观察。RED／GREEN 脱敏日志在本目录，原始诊断在仓库外。首次实际失败只保留 unittest 摘要；最初临时夹具曾自动回收原始目录，后续已改为保留失败原始证据，未重构或补造该次原始数据。

旧／新实际短探针每臂两次 RSS，三个 HTTP case 各一次预热与两次测量：共 18 次请求（预热 6、计分观察 12），不足原协议样本。新臂仍有真实 Python 子进程，RSS 已计入；`probe-report.json` 保持未定，不能外推到最终 TS、真实记忆或 embedding 工作负载。

只处理合成资料和公开源码；未读真实业务库或项目 `.env`，无模型凭据。出站在发起前拒绝，并核验模型调用台账为空。未操作、启动或重启 App／微信；未发送消息。自有进程和测试库已清理，原始失败及未知证据保留在仓库外；多余冻结源码副本仅在核验进程不引用后回收。

仍缺：根会话完成最终去 Python、冻结最终提交、停止并行测试后运行 40×60 秒正式宿主采样及每例 30 次 HTTP；届时重做 Electron 单列核验并审阅原门槛。当前真实 App 与记忆验收仍由根会话执行。费用不作为本入口阻塞，不为费用另跑。
