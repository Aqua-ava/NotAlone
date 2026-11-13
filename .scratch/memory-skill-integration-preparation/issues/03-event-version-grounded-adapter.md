# 03：集成事件原子版本与Grounded事件适配

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01, 02
Source unit: U3 / S源票02
Migration mapping: S059→060 (canonical)

## 交付行为

用户看到计划、约定、改期、取消与已发生的区别，同一事件不重复记，新旧变化原子保存并可合法撤销；main默认原文提取路径实际提供有来源的事件提案。

## 范围与兼容

- 承接历史核实、人工保护和版本原始证据；canonical060保存可空事件/版本依据。
- 保留Grounded生产默认，适配事件阶段/时段提案及来源位置到独立核验；不切回S旧提取器，不放行质量维度。

## 依赖说明

01提供历史语义；02提供纠错保护及059前缀。与04可逻辑并行，共享模块写入需协调。

## 验收标准

- [x] 原059前缀保留，canonical060全量/前向/重复与失败恢复通过；旧event/version_evidence为NULL，保持未知且不回填。
- [x] 生产builder配受控模型实际走Grounded→事件提案→核验→保存；单留event=None不计事件行为集成完成。
- [x] 计划、约定、改期、取消、发生、未知阶段及消息时间/发生时段分开；时间到了不能推断发生，证据位置/否定/主体不改变。
- [x] 同一事件重叠证据幂等，不同时段事件保留；risk/依据版本刷新不制造同义pending。
- [x] 新旧更新、人工修正竞态、撤销和删除原子；缺失原始依据不补造，不出现旧版本单独失效或两个当前版本。
- [x] 公开事件历史与页面、Grounded原文保真、记忆写入及来源删除相关回归完成；结果与质量资格分开记录。

## 验证入口

沿用memory event updates、Grounded extraction/runtime、pending去重和版本撤销组；新增默认builder事件闭环及canonical060边界。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

用户已明确继续实施，本票在独立集成树推进；S分叉库保持原样。完成本票不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。
- 2026-10-16：按已获授权领取实施；以下为候选工程证据，State保留claimed，等待独立Standards/Spec两轴审查与最终集成复验。

## Answer

### 来源与实现

以固定M2产品及集成票01/02为基底，逐块复用源02 `c0821fc4→2b5e0a76` 的事件值对象、来源绑定、候选身份、原始版本依据、原子替代/撤销、删除闭包、公开HTTP及React；未重放S分支或带入后续功能。canonical060与源S059正文SHA256相同；001–059原字节保持，预算夹具严格前缀同步到001–060/count60，未放宽为下界。

main三个Grounded默认builder保持。新增严格必填但可null的event标签，模型只选受控stage与occurrence原文分句引用；编译器保留原正文、主体、条件与否定，生成Unicode码点半开位置及支持的完整日/周时段。未知、否定或不支持的时间留空；不把墙钟、消息时间或kind当作发生证明。独立V分别核验阶段/发生时段，候选摘要绑定实际V事件。通用正文supported不能使事件自动采纳，合成放行回退也不能绕过。

Grounded追踪记录协议`grounded-labels-v3`、编译器`grounded-source-event-v1`及实际grounded/adapter/events代码摘要，后续任务10复用；本票不实现升级批准门禁。不新增冻结context事件字段，schema_revision保持1，MemoryEvent.source_current不进入codec。共用合成生产builder模型位于`backend/tests/integration/server/grounded_event_support.py`，供后续事件公开HTTP验证使用。

### 已验证与待复验

- TDD首红：公开HTTP原实现忽略事件提案，在合成放行配置下误auto保存；接独立V后同一反例转绿。Grounded编译首红为不接受事件标签，新增受控编译后转绿。首版合成记录缺time导致3例409；补全合成输入后3/3生产builder闭环通过。发生时段未知不能自动采纳的原期望已纠正为保守门。
- `python -m unittest discover -s tests/unit -t . -q`：最终同轮1336/1336通过，含新增2个独立事件V合同用例。原trace transport测试以同一旧来源要求自动替代的期望不再合法，夹具改用独立新来源；相关原反例通过。
- Grounded31方法与源事件公开HTTP59方法同轮90/90通过；另3个实际生产builder用例通过（默认pending→明确确认→重启事件/历史→来源删除；正文V不代签；合成双独立V允许auto保存）。新增2个编译反例覆盖阶段枚举、否定、未知时间、自由字段和无关时间引用，纳入后续1334单元全组。
- 迁移/035基线39方法首轮38过、1失败：`test_restore_with_same_count_but_modified_content_is_rejected`遇`adoption_writers_present`，占用来源未捕获；精确单例重跑1/1通过。060全量、059前向、重复0、失败事务回滚/恢复及旧NULL未知均已通过；未因此认证原39单轮全绿。最终迁移/035、02 Grounded、样本、current status与03 Grounded组合在精确断言的新自有库同轮84/84通过（112.544秒），finally删除并确认自有库消失。
- 显式新随机自有_test库（≤63字符、连接后精确断言dbname）全量060后，legacy记忆写入/本人记忆/来源及回复删除/提取追踪89/89通过，finally删除并确认自有库消失。没有连接或迁移S分叉库或业务库。
- `npm ci --offline --ignore-scripts`使用既有锁定缓存82包；`npm run typecheck`通过。事件业务Node16/16、React控制器+HTTP/PG与旧状态4/4通过，三个HTTP夹具均报告自有数据库及子进程清理确认。
- 获有限无头页面调度后执行`npm run test:pages -- --case memory-event-updates --timeout-seconds 180`：实际单Chrome生产React两场景通过（自动历史/撤销/来源删除；默认pending/人工更新/来源删除），cleanupConfirmed=true；结束interactive/headless租约均absent，未清理其他租约。Electron、App、微信及产品原生探针未运行。
- 追加核对发现原main退出/归属HTTP夹具`assistant-generation-ownership.py`仍严格058，会在060下阻断业务断言；现同步为精确001–060/count60和重复0，不改为下界。夹具复核本轮随机自有dbname精确相等、后缀与长度，重复迁移前断言双URL相等。最小命令`node --test --test-name-pattern='^受控退出等待迟到实际prepare及interrupt确认才关闭Host' tests/assistant-generation-quit-http.test.mjs`实际1/1通过，日志`migration actual=60, repeat=0`，真实prepare/interrupt/Host退出业务断言到达且模型0次；自有instance/class清理确认、database_remaining=false。没有重复执行全退出组，未启动App/微信/探针。追加前已合并根`ca61349d`的事故文档，保留原03候选，不搬入04产品。

所有Python命令均先激活Conda NotAlone，禁用dotenv并设`NOTALONE_ENV_FILE=/dev/null`与`PYTHONPATH=.:src:..`。上列组是分阶段结果，不合称一次全量通过。产品候选已固定为本地提交`946a0ea04a1175cf161776177a858f1984e1bb6c`，其main与HEAD公开历史审计均为0issues；本段验证补记不改变产品代码。

### 独立审查与集成签收

2026-10-16，最终来源`b50315a836e4ad9a931d805268a484f316a7c1d9`在同步集成根`ca61349d`后，无冲突合入`codex/memory-skill-integration`。主Agent委派的首轮独立审查覆盖`3e6ac12b→6ce21e04`：Standards产品代码硬违规0、possible issue 0，Spec 0；末轮`6ce21e04→b50315a8`的严格060退出归属夹具增量，两轴也均为0。测试执行中的数据库隔离违规另见下节与[事故记录](../reports/test-database-isolation-incident.md)，上述产品代码结论不抹去执行违规。

独立merger复核完整TypeScript、Git差异、三个严格060迁移夹具、三个Grounded默认builder及codec版本2/schema_revision1；M2原001–058、既有059字节均不变，060与固定S059的SHA256一致。仅同步预算夹具清理日志的001–060标签，不改断言或产品行为；没有追加数据库或页面运行。六项AC据实际分阶段证据及独立审查签收，State改为resolved；[03集成记录](../frontier-03-validation.md)区分每轮结果、原失败和未验边界。整批其余任务仍按任务图接续。

### 执行疏漏与数据影响

两组旧PG回归启动时未先设置`NOTALONE_TEST_DATABASE_URL`，违反本票自有随机库范围。源码默认连接路径为共享`notalone_test`，执行时据此判断误入该共享测试库；两份-q日志没有有效URL/current_database，实际目标库身份不能由保存证据独立认证。原94方法组为31错误+1跳过（MemoryAdoptionTest9、PostgresMemoryStoreTest15、WriteAdjudicationTest7）；另一58方法组为34错误（PostgresOwnerMemoryStoreTest10、SourceDeletion15、SourceReplyDeletion9），错误包括旧schema缺字段和SourceProcessingWriteError。这65个错误用例已实际写入随机owner等合成夹具，并非只读误连；失败分母保留，不计通过。

仅依据已保存日志及源码核对：夹具写入随机合成owner/contact/source/message，清理按各自随机owner范围；未执行共享库迁移或全表TRUNCATE。SourceReply9例在setup导入失败前已注册source清理，其他失败在测试体；日志未报告teardown/cleanup错误。source故障函数/触发器在导入之后，本轮该用例先在导入失败，未到DDL。注册清理前的setup失败并无finally保证，不能由源码推断最终零残留或没有影响其他会话。发现后未再连接、检查、清理或修复共享库；原完整命令和逐夹具证据仅留本地，已报主Agent。后续legacy验证改用上述显式新随机自有库与精确库名断言。

新增持久化为事件及版本定位/摘要，原始来源、修正与撤销仍按owner/contact隔离并遵守来源删除。生产质量放行仍为空，有限日/周解析不是通用时间理解；独立模型语义质量、真实App/微信、业务数据升级和最终全批组合不由这些合成结果认证。未push、PR、合main或部署。
