# 本机启动与停读确认修复（2026-11-03）

## 问题与行为

- 普通已有库先由桌面预检查打开，再由正式后台打开；每次重复三轮完整性与外键检查，产生随资料规模增长的重复工作。
- 数据库预检查就绪而后台仍在连接时，页面提前显示“尚未连接”；记忆页把所有非连接状态都描述成“连接已变化”。
- 原同步停读请求超过8秒时，桌面只补查一次状态，仍在排空就显示未确认；文档处理与记忆裁决还永久缓存第一次关闭失败，明确重试不能继续。

## 修复范围与边界

桌面已完成资料的预检查返回 `prepared`，只定位受控文件并核对可信配置及切换清单，不打开数据库、不提升运行代次。正式后台沿用原库、原本人身份；已有服务复用也核对数据库、本人和受控文件身份。正式打开保留身份、结构、迁移账本校验，在同一写锁快照执行一次完整性与外键检查。实际迁移保留前后检查及失败回滚，非 WAL 库转换前仍额外检查。首次初始化保持原完整入口。

界面区分资料定位、连接中、未连接、失败、停读中、已停读与停读失败。读取状态失败提供重读入口，不冒充自动恢复，不在连接前读取记忆。诊断页停读后不再宣称功能开放；五类状态订阅在收到有效状态后清除旧读取错误，并忽略迟到失败。Skill页也区分连接与停读，用量不可读不再猜测连接阶段。

后台用认证能力字段声明 `poll-v1`。支持的新客户端提交一次异步停读，随后只查询原目标与原凭据；业务、读取和存储资源全部释放后才能返回 `stopped`，后台在确认响应结束后退出。客户端确认窗口30秒，宿主另保留一次最多4秒的查询及进程回收；不把超时、断线、进程消失或未知模型释放结果当成功。旧同步接口保持兼容，可恢复的领域关闭失败允许明确重试。

隔离历史窗口清理失败也保留原资源供重试，正文句柄立即失效；微信历史通道的失败关闭可重试等待原进程退出，关闭后不会重新读取。已有库缺少或不匹配已确认本人时，首次和后续重试都拒绝启动，不补建随机本人或覆盖原身份。

不改变同步总开关、联系人范围、已撤销授权、消息去重或来源资格；本修复不新增资料迁移、复制或删除路径，沿用既有结构升级流程，不创建替代空库，不调用真实模型或发送外部消息。

## 同工作负载性能

使用同一隔离合成数据库，160,000行，每行1,024字符，两个索引，文件971,452,416字节。使用生产 SQLite 存储和启动接口，注册表仅增加合成负载表；不包含 DSH、微信、模型和窗口启动。

固定数据并显式预热后，交替执行旧／新／新／旧／旧／新。旧实现只替换临时基线 worker，不切换共享源码。

| 实现 | 三次总耗时（毫秒） | 中位数（毫秒） |
| --- | --- | --- |
| 原启动预检＋正式打开 | 7565、13785、6595 | 7565 |
| 只读预检＋单次正式打开 | 1389、1725、1454 | 1454 |

中位数减少80.8%，约为原来的19.2%。新预检均不足1毫秒，其余为正式打开。旧实现一次有系统负载波动；更早未统一预热的新实现首轮也曾达到9349毫秒，因此不将本表描述成真实 App 冷启动保证。约971 MB合成库、基线实现和脚本已清理。

## 自动验证

测试先红后绿，使用公开存储／宿主接口、真实认证 HTTP、正式 DSH profile，以及真实 React 组件和隔离浏览器。

- 刷新并合并同时进行的工作区改动后，桌面启动、连接状态、停读确认、隔离窗口和首次读取等10个相关文件共73项：首次72项通过，1项受并行结构夹具版本超前影响；改为核对实际迁移注册表后，该文件4/4通过。涵盖停读接纳／首次查询丢包、慢排空、明确重试、旧协议和复用身份不符。
- 同一集成快照的后台存储、启动预检、切换演练、存储身份、正式profile、领域关闭、微信通道和宿主关闭等9个相关文件：96/96通过（51.7秒）。覆盖预检不抢租约、缺失／损坏／未知资料、原本人缺失的首次及重试拒绝、迁移前损坏不得被升级掩盖及迁移后失败回滚。
- 同步代表组37/37通过（18.6秒）。覆盖历史／增量交接、重叠去重、持久检查点续读、关闭时迟到页拒绝及按原开关恢复。隔离目录使用已安装同版本的原生媒体校验器。
- 五类首帧状态、诊断、会话及前台补充组合覆盖44项并通过；恢复入口补充后启动连续性18/18通过；缓存浏览器缺失的5项使用已安装系统Chrome执行。收到新有效状态时清除旧读取错误，旧事件不清错、不重复getState，会话业务操作错误保留。
- Skill／用量补充回归6/6通过；本地embedding生命周期5/5通过，覆盖释放失败保留引用、加载中关闭不得吞错、明确重试且关闭后不再推理。该生命周期模块尚无生产调用，不能归因于实际App故障。
- 两端 `pnpm typecheck` 和桌面测试登记通过（155项safe-node、43项headless，其余类别未改）。轻量存储身份检查涵盖同路径文件替换、关闭中和Worker故障，不排队全库SQL。

后台全量扩展检查设置600秒上限；出现失败和未完成进程，超时后仅回收本轮已核对归属的进程，未获得全绿结果。针对其中15个失败在修改前快照和本轮代码执行同一用例，两侧均复现相同错误：记忆／删除状态断言、过期结构计数及等待记忆运行状态超时。其余失败和挂起尚未完成归因，不声称均为既有问题。相关任务检查的通过结果不等于全套后台通过。

扩展旧版记忆迁移夹具在迁移前使用当前 `identity.directory` 动作报 `storage_invalid`；旧 worker 与新 worker同样失败，属于旧schema夹具与当前业务动作不兼容，这部分未认证。不得用本轮通过的合成迁移回归冒充该历史场景通过。

## 主要验证命令

以下命令在隔离工作区对应子目录执行；完整组、失败后单项重验和补充回归的结果分别见上文。

```bash
# backend-ts/
pnpm run typecheck
node --test test/sqlite-storage.test.mjs test/sqlite-startup-preflight.test.mjs test/sqlite-cutover-rehearsal.test.mjs test/sqlite-storage-identity.test.mjs test/sqlite-host-launch.test.mjs test/sqlite-shutdown.test.mjs test/sqlite-memory-close.test.mjs test/sqlite-wechat-history-channel.test.mjs test/sqlite-host-close.test.mjs
node --test test/sqlite-incremental-sync.test.mjs test/sqlite-incremental-controls.test.mjs test/sqlite-history-durable-resume.test.mjs test/sqlite-history-startup-host.test.mjs
node --test test/local-embedding-lifecycle.test.mjs

# desktop/
pnpm run typecheck
pnpm run test:inventory
node --test tests/backend-shutdown-confirmation.test.mjs tests/managed-shutdown.test.mjs tests/backend-startup-budget.test.mjs tests/startup-continuity.test.mjs tests/memory-processing-entry.test.mjs tests/first-frame-read.test.mjs tests/first-frame-state-view.test.mjs tests/sqlite-development.test.mjs tests/sqlite-only-storage-startup.test.mjs tests/quarantine-controller.test.mjs
node --test tests/sqlite-development.test.mjs
node --test tests/startup-continuity.test.mjs
node --test tests/skill-learning/sqlite-library-view.test.mjs tests/usage/connection-view.test.mjs tests/usage/react.test.mjs
```

## 实际开发版验收

原全范围同步窗口及新CLI窗口已明确释放后，将隔离修复三方合入当前工作区，保留其他会话的源码、配置和新的可接续CLI制品。仅运行 `pnpm run dev`，没有打包或替换数据库。以下为2026-11-03晚实际开发App的证据；最后的迟到页面保护修复已追加热更新、数据及状态请求复验。

| 检查 | 实际结果 |
| --- | --- |
| 启动连接 | 23:07一轮从桌面开始连接到已连接9845毫秒（日志初始化至已连接9847毫秒）；23:09退出后重开11508毫秒。 |
| 正常退出 | Computer Use执行Cmd+Q；桌面固定phase日志从stopping到stopped为3249毫秒，之后dev:status确认为停止；停读时不再显示等待重连。没有额外轮询后台停止终态，也没有强制结束进程。 |
| 状态请求 | 同一285位授权范围、联系人页面无设置展开，集成前8770毫秒，集成后3458毫秒；同步设置页实际加载后一次3549毫秒，均HTTP200。运行中的同步工作负载会变化，这些现场值不作严格百分比性能结论。 |
| 界面 | Computer Use确认本机服务已连接，实际打开同步设置看到同步开启和原selected范围；不把资料准备完成或停读中显示成连接失败。 |
| 资料保留 | 集成前后数据库身份、owner状态/开关/代次、全部授权、账号范围/版本、联系人身份摘要全同；287个联系人保留。164076个原消息身份逐一哈希比对，缺失0；未保存姓名或正文。 |
| 同步与去重 | 重开后的首轮只读比对新增47份accepted捕获；最终补丁重启后相同基线累计新增456份，消息数仍164076；重复规范化消息身份0、悬空规范化观察0，quarantined捕获数未增加。同期没有新的正文观察，不能声称验证了新消息到达后的发送端链路。 |

状态页仍如实显示部分来源连续性尚未获证的同步项；两次报告分别有192和230项 `history_source_continuity_unverified`，其间包含再次运行时重验。这是同步来源资格状态，未用放宽资格或改授权来消除提示，不等同于本机连接失败，也不宣称285位联系人在新CLI制品下全部终页。

第一轮计时尝试在连接完成前退出，起因未确认，不计入性能样本；随后开发监督器留下拒绝连接的socket。只在核对为本轮创建、进程消失、无监听者后移除该socket，用独立后台会话重开。一个同路径Electron默认空白窗口经正常菜单快捷键关闭，真实开发App保留。未修改系统权限或终止未知进程。

本机证据：`/tmp/notalone-startup-final-dev-3.log`、`/tmp/notalone-startup-reopen-dev.log`、`/tmp/notalone-startup-status-{before,after,page}.json`、`/tmp/notalone-startup-{pre,post}-integration.json`、`/tmp/notalone-startup-sync-{pre,post}-reopen.json`。消息身份哈希集合在完成比对后清理，不提交任何私人证据。合并后的桌面typecheck、55项重叠相关测试和inventory通过，当前主目录后台typecheck通过。

## 补充：同步状态报告的重复认证查询

协调会话保存的真实请求证据中，`/api/sync/status` 返回 HTTP 200、285份联系人覆盖和已开启的 `selected` 范围，耗时25,983毫秒，超过原客户端12秒预算；同入口较早一次为3,893毫秒。请求前后 Worker 快照均为 pending 1／queued 0，最近一次 `history.coverages` 执行162.972毫秒。前后快照不能证明整个请求期间没有排队，也不能把某一批耗时乘以批数当作完整归因。本补充没有请求实际 App HTTP 接口或操作 App。

代码路径为 `readHistoryStatus → syncDirectory → readStatusCoverages → history.coverages → readCoverage`。285个绑定按每批4位执行72批，批量动作内部仍逐联系人读取；每位重复计算最新目标、消息类型计数、捕获页数和隔离摘要，随后还读取基础同步状态并复验已有正文守卫。每批4位的调度边界保持，以允许其他请求在批间运行。

经授权以实际 Electron 的 Node 24.21.0／SQLite 3.53.4 建立只读、`query_only` 连接，仅记录聚合计数、SQL计划及耗时，不保存身份、正文或真实库副本：

- 一次最大消息量联系人样本共29,327条消息，`readCoverage` 的8条SQL合计146.752毫秒；消息类型统计81.145毫秒、当前目标捕获页计数30.339毫秒、隔离摘要27.864毫秒、两类最新目标查询合计4.339毫秒。该样本不代表285位联系人的完整请求。
- 一次聚合快照得到164,076条消息、526,386份捕获、185,340条观察、58,992个读取目标；目标数每联系人中位186、最大457，目标最多7张表／8个分片。另一次认证聚合为52条：completed 43、failed 4、interrupted 5。后台仍在运行，这些分次观测不是同一冻结快照。
- 查询计划显示，原认证排除子查询只能按 owner 使用 `history_recertification_contact(owner_id,contact_id,started_at)` 索引，随后按 `new_binding_id` 和状态筛选；每个历史目标会再次扫描同一本人的认证记录。

### 局部改变与同负载比较

本补充仅改变以下3个代码／测试文件：

- `backend-ts/src/history/sqlite/current-scope.ts`：每条SQL物化一次当前 owner 的未完成认证集合，3处排除仍使用原有 `owner_id + new_binding_id` 判断。集合不跨请求缓存；不新增索引、迁移或超时，不改变同步授权或来源资格。
- `backend-ts/test/history-status-recertification.test.mjs`：新增6项资格与隔离回归。
- `backend-ts/test/fixtures/history/status-recertification-registry.mjs`：通过公开存储注册接口建立合成认证记录及连续性回退场景。

没有直接增加 `cert.contact_id` 过滤，因为认证表的 `new_binding_id` 没有保证联系人归属的外键；同本人跨联系人错误记录仍须按原逻辑阻断其指向绑定。曾测量去除最新目标查询的窗口计数，同负载中位仅改善约2.4%，没有采用，旧NULL创建顺序处理保持不变。

合成比较使用实际 Electron 引擎和同一约663MB数据库，固定285位联系人、164,160条消息、526,395份捕获、185,250条观察、58,995个目标（每人110个history及97个incremental）、7张表／8个分片，以及43条completed、4条failed、5条interrupted认证记录。负载按真实规模校准，分布为合成数据；每人另包含1条隔离观察及1条metadata-only观察，不能称为真实资料复刻。基线与候选使用同一每批4位入口和逐SQL计时方式，交错顺序为前／后／后／前／前／后，完整285行结果严格相等。

| 实现 | 三次耗时（毫秒） | 中位数（毫秒） |
| --- | --- | --- |
| 每目标重复查询认证记录 | 3113、3490、3179 | 3179 |
| 每SQL物化一次未完成认证集合 | 2595、3046、2658 | 2658 |

中位减少16.4%。正式补丁通过公开 `history.coverages` 动作的同库三次结果为2509、2548、2712毫秒。该负载没有实际同步写者、模型或微信读取，也未复现真实25,983毫秒请求；这里只证明局部减少重复扫描，不能声称现场26秒问题已解决。前端去重与本优化整合后的实际UI负载结果见上文实机验收。

### 验证边界与留存

新增6项回归在原实现及优化后均通过，覆盖running／failed／interrupted／completed状态、当前与已保存资料范围、单联系人及全目录查询、现代目标与连续性回退、同本人跨联系人错误绑定仍阻断、其他本人同名绑定及空绑定不污染当前结果。

以下5文件组合共128项，127通过、1失败（约18.1秒）。唯一失败是 `sqlite-private-history.test.mjs:557`「页返回时同步已关闭，已观察的未知状态仍保护旧消息」，第561行断言为 `1 !== 0`。在仓外临时副本保留当前其余源码、仅恢复原 `current-scope.ts` 后，使用相同单例命令仍复现同一失败；当前实现单例亦同样失败。因此可判断该失败不是本次认证集合优化引入，但不能宣称该同步关闭场景通过，也不将整套后台结果描述成全绿。后台typecheck和`git diff --check`通过。

```bash
# backend-ts/
node --test test/history-status-recertification.test.mjs test/history-status-fairness.test.mjs test/sqlite-history-sync-status.test.mjs test/sqlite-private-history.test.mjs test/sqlite-history-recertify.test.mjs
node --test --test-name-pattern='页返回时同步已关闭' test/sqlite-private-history.test.mjs
pnpm run typecheck
```

性能汇总为 `/tmp/notalone-sync-status-performance-summary.json`；只读SQL计划及聚合计数为 `/tmp/notalone-sync-status-query-plan.json`、`/tmp/notalone-sync-status-workload-counts.json`。生成脚本、参数和各轮JSON保留在 `/var/folders/rj/p9s4d70132s0zmmvfchdyr240000gn/T/notalone-sync-status-synthetic-n9ijoa8i`（约213KB）。组合与单例日志分别为 `/tmp/notalone-status-recertification-regression.log`、`/tmp/notalone-status-scope-baseline-single.log`、`/tmp/notalone-status-scope-current-single.log`。260MB初始合成库、663MB校准合成库及原实现对照源码副本均已清理。实际运行目录与 App 未由本子任务修改、重启或停读。

## 补充修复：停读后迟到页面的旧资料保护

继续追查上文的127/128失败后，确认是历史页路径真实的保护顺序回归：`readPage`已返回的页面包含未知状态，但新增的提前`check()`因同步已关闭而跳过`quarantinePageStates`，使旧消息没有及时撤下。现恢复为先按原目标、运行令牌及来源范围保护已观察异常的旧资料，再复验授权、取消和持久检查点；新正文接纳前的全部门禁保留。该动作不恢复读取授权、不接纳关闭后的新正文、不推进游标。

增强原失败用例，同时构造未知旧消息、新正文和后续游标，验证旧消息撤下、新正文拒绝、页数0、游标为空、开关仍关闭、其他联系人资料仍可读；修改前红，修改后绿。停读、迟到页、持久分片及增量相关6文件共125/125通过（19.35秒），后台typecheck和diff检查通过。此项已修复，因此前面的127/128是诊断中间结果，不是当前未解决失败。

```bash
node --test test/sqlite-private-history.test.mjs test/sqlite-history-resumable-slices.test.mjs test/sqlite-history-shared-budget-controls.test.mjs test/sqlite-history-durable-resume.test.mjs test/sqlite-incremental-sync.test.mjs test/sqlite-incremental-controls.test.mjs
```

最终主目录（含同期迁移39）最小复验：`sqlite-private-history`、`sqlite-shutdown`、`history-status-recertification`三文件91/91通过（17.46秒），后台typecheck通过。开发监督器因最终源码变更正常认证停读3254毫秒，随后新实例8959毫秒连接成功；Computer Use确认实际页面显示“本机服务已连接”。再次比对全部身份/范围/开关摘要相同，164076原消息缺失0、重复消息身份0、悬空规范化观察0，原quarantined捕获数不变。

最终状态请求在重新进行来源检查的运行负载下9498毫秒、HTTP200、285项完整返回，仍在原12秒预算内。现场测得3.458～9.498秒，不作“稳定3.5秒”承诺；固定合成工作负载的优化结论仍以独立表格为准。
