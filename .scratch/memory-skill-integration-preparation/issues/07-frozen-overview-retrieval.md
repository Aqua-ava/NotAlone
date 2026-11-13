# 07：把概览有界依据接入冻结回复

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 04, 06
Source unit: U7 / S源票07

## 交付行为

用户的候选回复沿两类概览找到有界底层证据，展示实际使用内容与未知状态；准备回执冻结后新消息不会混入本次上下文或补查。

## 范围与兼容

- 复用原检索端口和回复生成，将导航/回执/预算与M2准备持久化、类型和删除依赖一起集成。
- 本票不启用语义检索；与08偏好、11审核使用可组合端口合同，不强加无关业务前置。

## 依赖说明

04提供历史继续与依赖分组；06传递两类概览。08可逻辑并行，本票完成不作为偏好产品前置。

## 验收标准

- [x] 联系人与本人独立预算、空结果、剩余字符/来源预算、相关性及强制未确认标注保持，目录标签不充当事实。
- [x] 实际导航和底层引用回执准确；历史依据只能历史使用，原始来源/修订变化在模型前及writer事务再核。
- [x] 新值对象能编码、持久化、重启、严格解码，schema修订显式识别；旧回执按01处理，不静默丢字段或补证明。
- [x] 初始材料和补查ID冻结，限制在准备时500条有效历史ID加初始ID；之后新消息不能进入本次初始或补查结果。
- [x] 准备后执行前删除导航参与来源，直接核固定JSON、快照、缓存及恢复副本擦除，晚结果拒绝；历史/当前复验不混用。
- [x] 公开HTTP/PG、生产React实际依据、main显式准备/多联系人任务组及overview retrieval/budgets/races相关回归与审查完成。

## 验证入口

沿用overview reply六组、assistant generation prepare/lifecycle、exploration generation preparation及explicit-generation-context HTTP；新增持久化导航与删除反例。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

本轮仅发布，本票保持open。未来实施须明确启动并使用独立集成树；S分叉库保持原样。完成本票也不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-16：06签收后领取，在独立codex/integration-07工作树推进；与另一张就绪票并行，新增冻结结构在集成时顺序提升修订。仅本任务自有资源，不合入main，S分叉库保留。

## Answer

2026-10-16 最终候选 `8bf0d3c8` 已经独立两轴完整及增量审查，无冲突合入 `2479f3a6`，六项 AC 签收。Spec 的 P3 证据措辞按实际 helper 精确校准并获原独立审查者确认关闭，两轴最终未关闭发现均为0；产品、测试及架构没有随签收改动。分轮成绩和剩余风险见[07集成记录](../frontier-07-validation.md)。下文保留各阶段的原失败、当时状态和恢复经过。

- 按固定来源 `6b81d8b1→b4429b5c` 逐块复用导航、三轨预算、来源窗口和无正文检索回执；M2 的显式准备、冻结历史 ID、04 合法历史、当前输入 CAS 与独立任务归属保留。本票没有新增 DDL，001–062 未修改。
- prepared version=2/schema_revision=3 显式登记六类值对象，解码复验回执与实际依据的身份、种类、修订、投影及计费；schema 2 沿原终态封键／重新准备，保留输入，不自动另建任务。
- prepare 前捕获 500 条有效历史 ID；初始窗口只可从该集合加本次初始消息 ID 查询。运行补查沿相同 SQL 白名单，且与初始补查共享 3 次／16 条／2048 估算 token。本人原 contact 只参与删除证明，不授权查询另一关系原话。
- 同一准备 CAS 保存全部导航删除 UUID；同 owner writer 复验两类修订和真实底层依赖。来源排队删除即在原 contact→owner 锁序中按已捕获依赖擦除固定 JSON、输入和恢复副本，不泛化撤销无关作业。导航身份按已保存导航与实际 owner／底层类型分型，不替代当前／历史事实门禁。
- 最小红绿：原构造器不认识 overview；显式 prepare 原包装器未传冻结 ID；M2 来源可用性未识别 ref／决定 UUID；排队删除尚无 C 的固定 JSON 未清除。均保留原失败日志并修复。单位最小 18 项及最新完整单位 1352 项通过；公开新增六方法／多子场景通过，桥接 HTTP 4 项通过，Node／React 控制器 29 项通过。14 模块单轮 111/111（164.288 秒）通过，显式准备上下文桥接 HTTP 8/8 通过。同步安全 root `166155a9` 后，完整单位 1351/1351 与概览桥接 HTTP 4/4 再过；随后补充“允许历史但冻结 ID 为 null 必须拒绝”的红绿，最新完整单位 1352/1352、六反例加 main 准备组单轮 31/31（47.369 秒）通过。分轮不累加为独立用例总数。
- 禁 dotenv、使用合成资料和脚本模型；新增概览桌面夹具具备 0600/fsync ownership、双 URL 及精确 current_database。旧组合启动器仅登记外层库，遗漏下述四次嵌套 CREATE，撤回“全部建库事前登记”的声明。未调用真实模型、App、探针或微信；实际页面失败另列，不把 HTTP／静态 React 通过当成页面或 App 通过。

私有运行证据（仓库外，不含凭据或私人资料）：`/tmp/notalone07-overview-http.log` 为最初 17 方法分母及 1 失败；`/tmp/notalone07-prepared-crossbranch.log` 与后续 green/green2/green3 为公开反例及夹具校准的原失败；`/tmp/notalone07-crossbranch-final.log` 为六方法通过；`/tmp/notalone07-combined-http.log` 为组合轮；`/tmp/notalone07-unit.log`、`/tmp/notalone07-node-green.log`、`/tmp/notalone07-desktop-http.log`、`/tmp/notalone07-explicit-context-http.log` 为分组记录。HTTP 夹具完整私有 proof 目录由 `/tmp/notalone07-http-proof-dir` 指向；其 JSON 中的 phase/cleanup_confirmed/database_remaining 是直接字段，命令通过及旧分组 absence 按日志分别报告，不将门禁推断伪装为 JSON 字段。

### 最终候选复验与边界

- 最后收口的 null 历史范围反例先失败（`/tmp/notalone07-null-history-red.log`），严格解码现在拒绝允许历史却缺少冻结集合的快照，空 tuple 仍合法，不会退回无白名单补查。18 项最小单位及 1352 项完整单位通过，31 项公开准备 HTTP 通过。
- `/tmp/notalone07-proof-index.json` 列出本票 14 个已知外层 PG 归属与 10 份概览 HTTP 运行 proof（两轮各五份，不等于十个独立测试）。这 24 个已知精确库名经管理员元数据的限定查询确认均不存在；索引不包括旧两轮的四次嵌套 CREATE，不能认证所有实际建库身份或其退场。未查询或清理未知库。最后组合轮 cleanup-proof.json 直接记录的是外层 phase=cleaned/database_remaining=false；早期 marker 仍是 planned，absence 取对应真实收尾日志。显式上下文八例逐例断言 `child.exitCode=0`，并将 cleanup 对象深比较为 `{instance_ok:true,class_ok:true,database_remaining:false}`；成功夹具目录已删除，未另行保留其 UUID 索引。
- 实际命令：Conda NotAlone、禁 dotenv，以 `/tmp/notalone07-run-owned.py` 在导入测试前登记外层库，显式绑定 DATABASE/TEST_DATABASE/EXPECTED_TEST_DATABASE 后运行上述 14 模块；该启动器未接 Core ownership hook，不能据此外推到嵌套库。单位用 `PYTHONPATH=src:.. python -m unittest discover -s tests/unit -t . -q`；桌面用 `npm run typecheck`、`node --test tests/overview-reply-retrieval.test.mjs tests/overview-reply-retrieval-scheduling.test.mjs tests/historical-reply-basis.test.mjs tests/assistant-generation-jobs.test.mjs`、独立概览与 explicit-generation-context HTTP 文件。
- root 从固定 `ebe5fa64` 实际执行 `npm run test:pages -- --case overview-reply-retrieval --timeout-seconds 180`：1 case／1 失败，1 Chrome，Electron／原生均未运行。来源删除后查空成功，再补资料的第三次生成仍显示前候选；模型仅进入两次。`/tmp/notalone07-root-pages.log` 保留原失败；`/private/tmp/notalone07-page-proof-47QK8l/overview-reply-runtime-b302bc82b7d34ad3989e3bd5260480fa.json` 直接记录 phase=cleaned、cleanup_confirmed=true、database_remaining=false，精确 001–062，PID85478。后续修复或新轮通过不抹去该分母，相关 AC 保持未勾。
- 大消息夹具保留一次实际默认 GET `/messages` 在回填后的 10 秒超时（`/tmp/notalone07-prepared-crossbranch-green3.log`）；未改报为列表性能通过。最终只从同自有库读取已导入合成行 UUID 作夹具身份，冻结补查的 search/query 结果仍经公开 generation/evidence HTTP 验证。批量列表性能尚未认证。

### 嵌套建库复核与限定新轮

- 对组合 14 模块逐一静态追踪：七个 `test_overview_reply_*`／`test_overview_prepared_context` 类经 OverviewReplyHttpFixture→MemoryOverviewHttpFixture；prepare／lifecycle HTTP 两类直接读取显式外层 URL；historical 经 memory_dependencies→inputs→session_api；memory_dependencies 经 inputs→session_api；persistence source_deletion 直接读取显式外层 URL。以上十二模块没有 CREATE DATABASE。
- 唯一两类嵌套链是 `test_exploration_generation_preparation` 与 `test_exploration_preparation_rejection`→FidelityHttpFixture→CoreBusinessFlowFixture.setUpClass（`core_business_flow_support.py:189`），每类一次 Connection.execute CREATE；Core 迁移子进程仅运行 database_migrations，没有 CREATE DATABASE。闭合路径未发现 Cursor／Async／Connection.connect 建库或 database_adoption 调用；Cursor 依赖核验仅 SELECT。此结论只覆盖所列模块及实际夹具链。
- `/tmp/notalone07-prepare-http.log`（35 项，1 失败）与 `/tmp/notalone07-combined-http.log`（111 项通过）均完整执行上述两个类，故原轮共有四次未事前登记的嵌套 CREATE。旧启动器没有 Core hook，日志未保留随机 UUID；无清理异常不能代替精确身份和 absence，未连接、扫描或清理未知库。
- 新轮使用 `/tmp/notalone07-run-owned-guarded.py`（08 已加强守卫的 07 专属副本，仅前缀及最多三库变更）；`/tmp/notalone07-guard-simulation.log` 证明无数据库模拟通过。Conda NotAlone、禁 dotenv、`PYTHONPATH=.:src:.. python /tmp/notalone07-run-owned-guarded.py tests.integration.server.test_exploration_generation_preparation tests.integration.server.test_exploration_preparation_rejection`：9/9，18.822 秒。外层一库和两个 Core 库逐次 planned→created→drop_confirmed，Core hook 同时保留；双 URL、current_database 与本地实例身份精确核验。`/tmp/notalone07-guard-exploration.log` 为执行日志；`<本机私有临时目录>/notalone07-guarded-kio4gd7u/database-absence.json` 直接逐名记录三库 absent=true。新轮独立证明，不追认旧四库核销。

### 页面失败的确定性恢复

- 实际故障发生在 prepare 成功后、执行前的同键 reserve 依赖门禁；合法纠错完整窗口没有 `kind`，普通 SQL 不等比较得到 NULL，误拒已登记的真实 correction decision UUID。补五条同词资料会使修正版与其他资料并列，因此原序列曾偶然通过；这不是模型或页面超时。`8603722e` 改为 NULL 安全比较，删除墓碑仍拒绝，owner、已登记导航身份、完整来源窗口与 writer 复验保留。
- 原序列 `node --test --test-name-pattern='来源删除后查空再补充资料' tests/overview-reply-retrieval-http.test.mjs` 首轮 1/1 失败、source_unavailable，`/tmp/notalone07-page-http-red.log`；后续 prepare／执行／单依赖探针的分轮结果保留在 `/tmp/notalone07-page-http-probe.log`、`origin.log`、`dependency.log`、`decision-red.log`。探针查明唯一拒绝项为已登记的 memory_correction_decision，随后全部移除。精确长句查询曾成功生成但本人预算未耗尽（`/tmp/notalone07-page-http-green.log`，1 项失败）；最终用“短程散步”确定命中修正版且保持三轨阈值，未删预算断言或改页面断言。
- 新增一个公开 HTTP 方法，按 complete／erased_guard／missing_window／missing_source 四分支实际准备后执行；合法无 kind 的完整窗口生成成功，后三种拒绝且没有保存回复身份。初轮来源支持夹具未选中修正版（`/tmp/notalone07-decision-window-red.log`，1 方法四分支预条件失败）；改为与页面一致的手录修正后，旧 SQL 的正例确切 409 source_unavailable，墓碑夹具另触发约束错误（`red2.log`，1 failure＋1 error）。按正式墓碑字段约束修正后，`/tmp/notalone07-decision-window-green.log` 为 1/1、4.539 秒，含三个负例。实际命令为 Conda NotAlone、禁 dotenv、`PYTHONPATH=.:src:.. python /tmp/notalone07-run-owned-guarded-single.py tests.integration.server.test_overview_prepared_context.OverviewPreparedContextHttpTest.test_corrected_navigation_requires_complete_window_and_active_sources_without_kind_discriminator`；单库上限守卫，绿轮 absence 直接路径 `<本机私有临时目录>/notalone07-guarded-u2ehxo7c/database-absence.json`。
- 完整控制器序列最新 1/1、7.414 秒（`/tmp/notalone07-page-http-final.log`），来源删除→查空→补资料→主按钮新生成，实际引用修正版，三轨预算均耗尽，受控模型三次。私证 `/private/tmp/notalone07-page-http-final-CwWaAc/overview-reply-runtime-668bf0eec1644508bcaa68d102e24ccd.json` 直接 phase=cleaned、cleanup_confirmed=true、database_remaining=false、controlled_model_calls=3、model_attempt_count=0，PID99090，精确062。类型检查与29项Node再过（`/tmp/notalone07-typecheck-page-fix.log`、`/tmp/notalone07-node-page-fix.log`），完整单位1352/1352、13.298秒（`/tmp/notalone07-unit-page-fix.log`）。
- `/tmp/notalone07-page-fix-proof-index.json` 分别索引原页面失败、七个独立 controller HTTP 诊断／校准／恢复轮、四个有界守卫轮与下述页面恢复轮；各轮独立保留实际分母，不累计成独立用例数。新轮精确已知库均有直接 cleaned/absence 记录；旧四次未知身份缺口继续保留。State claimed、AC 未勾，待独立增量两轴审查及合并签收。
- 主会话明确授权有限复验后，实读 App／headless 两租约 absent，在固定 `96270b5e89675d20d46378fa41eabc9dbf5b46ec` 运行 `npm run test:pages -- --case overview-reply-retrieval --timeout-seconds 180`，退出0，1 case／1 scenario 通过；原页面一失败分母仍单列。源码运行期间未变，原页面断言未削弱；1 Chrome，Electron／原生 App／微信／真实模型未运行。`/tmp/notalone07-page-fix-pages.log` 直接记录 cleanupConfirmed=true、quiet activeSamples=0／maxOnscreenWindows=0，RSS 采样峰值 Chrome 1106992KiB／Node198352KiB／backend163056KiB，不作物理内存永久上限解释。
- 页面私证 `/private/tmp/notalone07-page-fix-LZT9PN/overview-reply-runtime-1fd093cbf06a42bcbce7be304b42880d.json` 直接记录 PID1002、精确001–062、loaded_modules242／critical_modules22、controlled_model_calls=4／model_attempt_count=0、phase=cleaned／database_remaining=false／instance_cleanup_ok=true／cleanup_confirmed=true，以及双URL、禁dotenv和真实模块摘要。`fixed-source.json` 先于启动以0600/fsync记录固定提交与有限范围，夹具逐次事前 ownership 后创建精确单库。退出后实读两租约 absent，并以0600/fsync保存同目录 `leases-after.json`；租约状态不是数据库退场证明，二者分别记录。
- 重复迁移为0由夹具 `migrate(...)` 非空即失败的门禁及 ready 协议证明；Python 退出0由 RewriteFixture.cleanup 的 ChildProcess.exitCode 检查、页面 runner 退出0及成功收尾日志证明，这两项不是上述 runtime JSON 的直接字段。仅对已记录 PID1002 执行 `ps -p 1002 -o pid=,comm=`，状态1且输出为空，证明该次核查时已不存在；同目录 `recorded-pid-after.json` 以0600/fsync记录，未操作未知进程。

### 合并签收

独立 merger 在 clean 根 `2ec12587` 无冲突 no-ff 合入固定候选 `8bf0d3c8`，合并树与候选逐字节一致。实际执行类型检查、工作树／暂存／M2 至 HEAD 的差异检查及 Node 标准库断言：001–062 连续且相对原根不变、001–058 与 M2 同字节，七组严格夹具精确062／重复0、054→062生命周期尾序、codec2/schema3六类新值对象、三处生产Grounded默认、500条冻结范围及三个SQL白名单路径均保留。只读核对页面 runtime 的22个关键模块摘要全部匹配合并树；没有重复运行PG、HTTP、页面或App。

本票数据影响限于固定回复上下文、导航删除身份和自有合成夹具，没有新增DDL或外部发送能力。实际App／微信／真实模型未验；旧03默认PG事故、旧35目录数据库UUID缺失、07旧四次及08旧四次嵌套建库未知均继续保留，未连接或清理未知库。S分叉库保留，本轮未合入main或执行远端操作。当前8票resolved（01–07、14）、1票claimed（08）、6票open，AC47已勾／44未勾；未领取09。
