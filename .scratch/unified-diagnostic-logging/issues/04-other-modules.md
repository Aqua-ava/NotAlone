# 04 同步、取图、回复、删除等模块逐个接入

Triage: ready-for-agent
State: resolved
Blocked by: 无（02 及最终范围内验收已完成）

## 内容
- 每个模块一个提交，接入决策点与慢请求：同步、取图、回复生成、删除、前台定位、启动。
- 现有专用日志（连续性、启动、前台标题）逐步改经共用模块写入，保持原白名单语义与测试。
- 在 `privacy-deletion` 规格补充诊断日志的保留、清除与删除路径说明，评估联系人删除时是否需要清理对应前缀。

## 完成条件
- 各模块有接入点清单与对应测试；`## Answer` 汇总覆盖情况。

## Comments

## Answer

六个模块均已分提交接入；目前保持 claimed，等待主 Agent 最终实际 App 验收、删除模块两轴复核和最终性能复测后再 resolved。原三处用户未提交改动未触碰、未提交、未还原；未打包、未运行打包版、未推送或创建 PR。

### 模块与提交

| 模块 | 接入与保留语义 | 提交 |
| --- | --- | --- |
| 同步 | 首次历史、增量状态、固定错误分类、耗时；提交后的连续性分支回包至宿主唯一写者。原专用连续性日志白名单、属主/权限检查及删除失败阻塞语义保留。 | `a9df7952c` |
| 取图 | `SqliteMediaService` 的 extract、openPreview、readMemoryImage 公共入口记录实际结果，区分仅缩略图、缺钥、关联失败、来源失效、授权、取消及超时，不接收媒体正文/位置。 | `24606503f`；坏 getter/继承键加固 `c75f2611f` |
| 回复 | 正常 SQLite 候选 HTTP→合法 UUID→ALS→真实 SQL；实际生成 stage/onPhase 记录 preparing、queued、generating、saving、completed/failed，保留回调次数顺序、响应与原异常身份。预算、来源变化、取消、真实 generation timeout 使用固定原因。 | `70aface2c`；正式超时分类 `2b6442572` |
| 删除 | 原删除 runner/lease/计划核验与专用连续性严格清理之后、seal 之前，执行统一日志清理。联系人按前缀过滤并抑制迟到；单 owner 根目录账号删除清整份统一日志，并从仍保留墓碑导出有界前缀保护。失败真实 blocked，可原任务重试。 | `cd857bc12` |
| 前台 | controller 只记录稳定状态/原因变化；默认统一薄 sink 始终存在，包装可选专用 sink。合法 native/context 原因原值保留，任意原因/字段整条拒绝，不重复发送；专用标题日志仍默认关闭，原白名单与轮转保留。 | `7d7bcf09b`；默认无环境变量路径 `abd60bf39` |
| 启动 | 后台原专用小文件观察器镜像阶段/固定失败原因；主进程启动控制面镜像稳定阶段及耗时。已认证 Node HTTP 薄边界建立 ALS，既有域 wrapper 沿用同编号，保留原 Bearer/Origin/坏头响应，不增加 DSH 路由。 | `0cc00064d` |

共享缓冲修补独立于六模块提交：`5d3237970` 配置独立 4096 决策/128 debug 预算与各阶段精确损失信号；`794521849` 确保 `sql.slow(warn)` 不受 debug 洪峰挤占。上游慢 SQL 模板统计后由 02 精确补修 `74a02d5b2`，主 Agent 已亲跑联合验证。单条上限 2 KiB、写者序列化队列硬上限 8 MiB；这些是上限，不是常态占用；磁盘仍为每份 5 MiB、总计 50 MiB/14 天。

### 运行过的最小验证与结论

命令按所属目录运行；以下均为真实运行结果，退出码 0。主 Agent 已独立复核同步、增长、媒体、回复及前台相关输出；构建不替代桌面验收。

- backend-ts：`node --test test/unified-diagnostic-sync.test.mjs test/sqlite-continuity-diagnostic-integration.test.mjs`：16/16。来源围栏提交不被专用日志失败改变，联系人/账号清理原严格失败仍 blocked。
- backend-ts：`node --test test/unified-diagnostic-growth.test.mjs test/unified-diagnostic-log.test.mjs`：13/13。生产 schema 的合成 1000 task 控制生成 1001 条状态，已初始化及首次 lazy 两条路径均 1001 全到；5000 task 生成 5001，保留 4096，明确报告损失 905。多阶段转送损失 5904/976/12 不被重算成 1；debug 200 条保存 128、丢失 72，慢 SQL 警告仍保留。合成时钟仅用于分类/累计逻辑，不冒称 SQLite 实测耗时。
- backend-ts：`node --test test/unified-diagnostic-media.test.mjs`：4/4。真实合成 SQLite 下的公共调用、来源失效、异常 getter/constructor 原型键均覆盖，原异常身份保留。
- backend-ts：`node --test test/unified-diagnostic-reply.test.mjs test/unified-diagnostic-media.test.mjs`：5/5。正式 timeout 保持原 409 响应，日志固定 timeout；实际 SQL 与请求同 trace，坏 trace 仍 400。
- backend-ts：`node --test test/unified-diagnostic-deletion.test.mjs test/sqlite-continuity-diagnostic-integration.test.mjs test/unified-diagnostic-contract.test.mjs`：35/35。实际两进程锁竞争、真实 SIGKILL 后释放、同实例在途队列、两写者旧/新事件、lazy 回放、固定 wall clock 下清除后首条、跨内核重启模拟、真实 DeletionService 联系人/账号与两个联系人、墓碑、迟到/重启、伪 runner、权限/链接失败与修复重试均覆盖。
- desktop：`node --test tests/unified-diagnostic-foreground.test.mjs tests/foreground-latency.test.mjs tests/header-change-diagnostics.test.mjs tests/header-change-source-process.test.mjs` 等前台最小回归通过；补默认 sink 后原专用/合成子进程回归 17/17。无 env 实际写入 native/context 固定拒绝原因，坏原因、正文、路径均 0 条。
- backend-ts 最终启动集：`node --test test/unified-diagnostic-startup.test.mjs test/startup-diagnostics.test.mjs test/sqlite-reply-candidates-profile.test.mjs test/unified-diagnostic-contract.test.mjs`：12/12，5.62 秒。官方 profile 配置及既有合成网络 guard 下成功生成；实际原未包裹域 `/api/ledger/summary` HTTP 的 UUID 到真实 SQLite summary，任意坏头无落盘；无头内域 wrapper 沿用 host UUID。启动专用文件字段、512 字节、权限、异常分类与清理行为均保持。
- desktop 最终启动集：`node --test tests/unified-diagnostic-startup.test.mjs tests/unified-diagnostic-foreground.test.mjs tests/unified-trace.test.mjs tests/startup-continuity.test.mjs tests/backend-startup-budget.test.mjs`：35/35，15.39 秒。实际 JsonClient 正确区分删除/联系人/前台路由；默认 native sink、主进程 blocked 与原失败行为、原启动预算/导出回归通过。
- `pnpm --dir backend-ts run typecheck`、`pnpm --dir desktop run typecheck`：通过。`pnpm --dir desktop run test:inventory`：safe-node 165/headless 47/isolated-http 1/native 9/app 9/historical 1，登记通过。新增纯 Node 前台/启动测试在 safe-node；既有 sqlite-memory-read-failure 当前已在 headless，本模块未改其逻辑。`git diff --check` 通过。

正式 profile 的异步落盘与业务响应独立：测试用单次文件 watch + 2 秒有界等待检查实际 completed 和真实 SQL 条件，不用 sleep 轮询，不把 HTTP 200 当作日志已刷盘。新增测试先红再绿：无启动事件及原未包裹 HTTP 的 trace 缺口均先由公共 seam 复现。

### 清除协议与隐私边界

- `architecture/current/privacy-deletion.md:166` 已本地补齐保留、清除、自然到期、联系人删除/前缀碰撞、单 owner 账号清除及失败区别。该架构文档受 ignore，按要求未 force-add。
- 普通追加失败静默，绝不改变业务或授权。明确清除/删除清理失败返回固定失败码，不带路径/原异常，原专用连续性失败仍阻塞重试。
- 追加、初始化/轮转与 clear/erase 共用同实例 pending 和根级跨进程维护锁；控制先持久化、再过滤文件，前缀保护最多 14 天/4096 项/512 KiB，过期在下一次启动/写批物理淘汰。一键清除保留有效删除保护，后续新事件继续记录。
- 属主根目录沿原安全规则允许 0755，但不可组/其他写；诊断 logs 目录 0700、文件 0600；控制/锁文件核验属主、inode、nlink，并拒绝 symlink/hardlink。空固定锁文件永不删除，避免锁 inode 分叉。总量 50 MiB 中为控制原件及原子临时文件合计预留 1 MiB（每份控制文件最多 512 KiB），两个写者各 24.5 MiB。
- 内部观察时刻采用 `process.hrtime.bigint()`；单调清除屏障仅内部可信封套和严格私有控制使用，不进入公开事件、JSONL 或导出。固定 wall clock 不吞清除后的首条；内核重启时旧 RAM 不可能复活，在根锁内验证并重置屏障。不能把该保护描述为永久清除所有诊断元数据。
- 设置占用标注“含短期删除保护信息”，清除成功说明“已清除诊断记录。短期删除保护信息将在14天内过期。”。主 Agent 待在实际 App 核对残留大小、中文文案、导出无内部屏障/抑制内容。

### 一手依据与限制

- DSH 声明/锁定/安装：dsh、dsh-agent、dsh-agent-loop 均 `0.2.1-rc.2`，Cordis `4.0.5`。已按 dsh-development 阅读固定参考树 `687f282e8625c6b8d11ff58211a90524be2e4317`、安装 createAgent 类型，以及 Cordis 安装 `lib/types/registry.d.ts:70-80` 的 apply(ctx, config)、`fiber.d.ts:145-159` 的 effect 语义。相邻参考树工作 HEAD 为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，不冒称安装制品与参考树逐字一致。本模块仅改已有 Node handler 的认证后包装，不新增 DSH 接口。
- Darwin 锁依据：[Apple open(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html)、[Apple XNU fcntl.h](https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h)；本机 SDK `usr/include/sys/fcntl.h:120` 实核 O_EXLOCK=0x20。O_NONBLOCK 避免阻塞 libuv 线程池，异步有界重试 2 秒；真实子进程持锁被 SIGKILL 后另进程可立即获得锁。
- 单调跨进程依据：[libuv v1.52.1 Darwin uv__hrtime](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/darwin.c) 使用 mach_continuous_time。本机 Node 24.22.2/libuv 1.52.1 与 Electron 44.7.0 的 run-as-node Node 24.21.0/libuv 1.52.1，真实探针均满足父 beforeNs ≤ 子 Ns ≤ 父 afterNs；正式 main/backend 同 Electron 二进制。未把进程各自起点的 performance.now 用作跨进程屏障。
- 本轮维护锁仅实际认证 macOS；非 Darwin 安全停用诊断维护/写入，不自行增加平台实现。控制容量满或路径不安全时，普通日志静默不可用，明确删除会 blocked 并要求修复后重试。
- 测试使用私有临时合成资料/真实 SQLite schema，未读取真实聊天/记忆或外发身份资料。未启动桌面测试；最终 dev App 验收由主 Agent 独占执行。
- 维护锁/控制读写及最终启动事件已改变最终性能条件，必须复测最终树的日志开启/关闭与实际启动耗时。01 早期性能数据不能直接当作本轮最终开销，待主 Agent 统一补最终测量与风险结论。


### 最终独审边界补修

独审实测六项 P2 均已修复，未引入新依赖或运行时监听：

1. 根目录恢复原属主/不可组或其他写的安全边界，0755 用户根与 0700 logs 可正常写入/删除；没有放宽 logs、日志/控制/锁文件权限。
2. Worker 在真实事务 COMMIT/读取完成后捕获私有 wall/monotonic 观察时刻，顶层可信回执经两 client、transport、lazy、唯一 writer 原样传递；任意交付延迟不能把旧事件变为新事件，公开事件/JSONL/导出无这些字段。
3. debug 聚合保存最多 4096 个逐样本私有时刻与数字，先按清除/前缀/保留期过滤再聚合。旧先/新先均仅保留新 count1/duration2；原 200 同 trace 聚合完整保留。原始样本序列化字节均计入 8 MiB 硬界限。
4. overflow 正常保留最多 64 个不同观察时刻贡献，另固定六阶段各一个保守余量（通知共预留 140 KiB，仍在 8 MiB 内）。旧/新不同 Ns 不先混合，旧7/新3同 caller 仅留下新3/newTrace。超过贡献槽的余量以最早 Ns/At 证明全部贡献是否均在清除后，无法证明则整组安全舍弃，不把旧 trace/count 挪成新时刻；全新压力计数精确保留，不递归制造溢出。
5. setEnabled 与同实例 pending、根锁串行；后台已读开启的持锁旧批先完成，关闭返回后其它批次锁内重读 false，不再写入，不发生自锁。
6. control/settings 共享 create→write→sync→rename 整体 finally 的安全原子替换；启动及每次维护（包括 stale-control flush）持锁扫描固定 UUID 临时名，只清理 owner/0600/nlink1/inode/no-follow/size 安全的崩溃遗留，不触碰不可信目标。控制原件+临时文件预留调整为 1 MiB，总量仍 50 MiB。

另补超过 14 天的可信旧队列：即使前缀保护已正常过期，flush 仍在聚合前过滤 observedAt 早于 now-maxAgeMs 的普通事件、overflow 和计损提示。now 推进 15 天的 transport/lazy 旧事件与旧提示均不复活，fresh 事件继续写，过期控制物理移除。

独立回归由两轴各自提交：Spec `e86f1db62` 6/6、Standards `b38d018b0` 20/20（主 Agent 与作者均亲跑）。受控 sync 门闩直接测量替换中磁盘峰值：总预算 8192 bytes，替换前 8052，原件+临时同时存在的峰值 8077，未超限；并非只测最终 inventory。

补修验证：`node --test test/unified-diagnostic-observation-boundaries.test.mjs test/unified-diagnostic-clear-control-races.test.mjs test/unified-diagnostic-clear-transport-races.test.mjs` 29/29；扩大至增长、writer、删除、连续性、慢 SQL、官方 profile 和公共契约 57/57（4.67 秒）；两端 typecheck 通过。桌面 trace/bridge/startup/foreground 12/12，原 trace 测试按固定合成 SQL 指纹核验两次各101次的总数202，允许异步批次分开或合并；旧16天清理测试仅对 JSONL 断言过期删除，并额外验证永久锁 dev/ino 不变，4/4 通过。

最终统一回归：`node --test test/unified-diagnostic-*.test.mjs` 84/84，3.39 秒，退出 0。生产及本方回归补修提交 `7d627a7cd`；两轴独立回归提交保留，原三处 WIP 仍未触碰。此次更改后需以最终树重新测量性能与实际 App，State 继续 claimed。

### 主 Agent 最终集成验收

- 固定运行时 `7d627a7cd` 的全部统一诊断测试由主 Agent 亲跑 84/84；桌面 `unified-trace`、`unified-diagnostic-bridge`、`unified-diagnostic-startup`、`unified-diagnostic-foreground` 亲跑 12/12。生产 diff、两独立新测试、旧测试精确收紧及基准脚本均由主 Agent 核对；两轴原六项发现均已关闭。
- 最终 12 次交替合成业务样本及真实 SQLite，关闭→开启 mean：管理 1.2095→1.1977 ms，同步 6.1832→6.5397 ms，提取 201.4709→202.0776 ms。两组模型调用各26次（含预热），关闭0条、开启13081条内部覆盖记录，rejected/dropped均0。全分位数、冷 Node 与实际 Electron/DSH 启动数据见01 Answer；不是外部模型效果验收，不能宣称无性能影响。
- 实际官方 dev App 中文设置、清除后残留保护信息说明、本机导出35774条/0600/白名单复验均通过；内部单调屏障/控制内容不进入导出，样本已删除。实际激活 `/Applications/WeChat.app`、从助手小窗经过前台观察入口；未声明成功自动匹配联系人，未选择新联系人或改变授权。随后普通 dev 启动日志中看到固定 scope_changed/connection_changed/paused 等前台状态，重复稳定观察不刷状态事件；原生特定拒绝原因由对应真实子进程/合成回归覆盖，不能冒充所有原生原因均现场触发。
- 实际启动各n=1：关闭→开启 main 466.85→432.08 ms，backend 17839.05→16267.35 ms；有缓存/调度噪声。已恢复true并重启普通开发实例确认保留，桌面控制权已通知另一会话释放。观察目录已安全清理；原3WIP仍保留，没有打包、推送或外部消息发送。

### 扩大全量结论、外部失败归因与结案

- `cd desktop && perl -e 'alarm 600; exec @ARGV' -- pnpm test`：退出0，1355通过/1跳过，总1356，108.87秒。唯一跳过为既有 real-foreground-credential 负向静态EApp用例，依赖未设置的 NOTALONE_STATIC_E_APP；该文件本任务未修改，不为此打包或绕过发布门禁。
- `cd backend-ts && perl -e 'alarm 600; exec @ARGV' -- pnpm test`：全量实际退出1，2301总、2287通过、12失败、2取消，332.05秒。不能宣称后台全量全绿。其中05的 verified-output fixture第三参数遗漏已由原会话 `9304b8cec` 修复；主 Agent 亲核单行diff并复跑完整verified与两份来源批量测试16/16（4.56秒，退出0），不重复无关全量。
- 其余13个图片用例失败/取消属于先前图片规范化变更 `1f8f64704` 后的夹具/快照未迁移：两处共享PNG字面量70/68字节不能实际解码，导致11项图片组（含2项等待模型进入的取消）；另ModelHost第139行和正式profile第118行还期待原PNG，实际按新策略发送JPEG。两位独立审查者分别用私有git archive固定源码对照并清理：代表图片用例在 `8100de58f` 通过，在 `1f8f64704` 和当前树失败；仅隔离副本换为有效合成PNG后，保存图片/删除生命周期/在途清图三个代表单例均通过。ModelHost在pre04 `4e97f2197` 同样失败。未逐项重跑全部13项，已把证据交图片会话，未越界修其代码。
- 主 Agent 已亲读归因纯统计和固定提交的真实模型图片规范化diff：新实际解码/JPEG转换接入时，四份旧图片测试没有同步修改。证据 `/tmp/notalone-image-diagnostic-review-summary.json`、`/tmp/notalone-unified-special-failure-attribution-20261111.json` 均0600、无私人内容；归档、临时hook和原始归因日志均已删除。
- `node scripts/check_public_history.mjs --ref HEAD --working-tree` 最终 HEAD `9304b8cec`：退出0，issues=0；`git diff --check` 通过。工作区仅原3份WIP，未提交或还原。没有push、远端分支、PR或打包。

04各模块对应完成条件、独审、真实App及最终性能证据已满足，State改resolved。剩余风险：macOS之外维护锁未认证；突发/异常退出可能丢失未刷盘诊断，跨清除边界且通知槽满时保守舍弃不可安全拆分的余量；私有控制不安全或容量满会使明确清除/删除受阻；真实App启动仅各1样本，不能严格证明无性能回退；上述13个图片测试仍归并行图片修复任务，不能据此宣称整个后台测试全绿。

### 本轮额外收尾验收（2026-11-11 至 2026-11-12）

按用户追加要求重新执行后台全量，而非引用旧汇报：HEAD9304b8cec，命令 `cd backend-ts && perl -e 'alarm 600;exec @ARGV' -- pnpm test`，exit1，2301总/2288通过/11失败/2取消/0跳过，墙钟312.962秒。完整13个用例名及各失败原因、逐项命令和exit/pass/fail/cancel表见本目录额外验收记录 `acceptance-20261111-tests.md`、`acceptance-20261111-special-cases.md`。

每个失败均实际在首个诊断提交57b0c1611之前的准确父提交33b66ca7c运行且通过；在当前9304及图片提交1f8逐个重现同原因，非代表外推。十一图片用例另逐项保留全部1f8生产源码，只在私有副本更正无效合成PNG，11/11通过；两格式断言另双向控制，去1f8三处日志仍失败、保留当前全部诊断仅恢复图片旧行为则通过，原测试字节不变。主Agent已读新全量真实footer、每项统计和控制证据，确认这13项由图片夹具/旧PNG契约引起，不由诊断日志代码引入；没有修当前图片相关代码或测试。

新的实际diag链、设置四次截图/导出88495条及开关5次/5次启动mean/max已写02和01 Answer。隐私规格四项具备，git check-ignore命中而git ls-files为空；架构本地内容不在提交。本轮没有新增代码提交，原3WIP保留，未push。当前后台全量仍未通过，不能以本轮归因成功冒充图片任务已修复。
