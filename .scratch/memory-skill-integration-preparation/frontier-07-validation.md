# 07概览有界依据进入冻结回复集成验证

日期：2026-10-16。固定产品基底M2 `08c4d48e719353492f37620f4fb2aabd8710efc6` 和来源S `54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616` 不变。本记录签收正式07；当前状态见[任务索引](planning.md)，逐轮经过及私有证据指针见[07 Answer](issues/07-frozen-overview-retrieval.md#answer)。本票的普通React页面通过不认证实际App、微信或真实模型质量。

## 固定来源与独立审查

按固定来源 `6b81d8b1→b4429b5c` 逐块集成，保留M2准备持久化、04历史继续及06两类概览。初审固定 `166155a9→ebe5fa64` 的54文件，增量复审固定 `ebe5fa64→8bf0d3c8` 的6文件；审查者只读，没有代为重跑或认证未知资源。

| 审查轴 | 原发现及修正 | 收口结果 |
| --- | --- | --- |
| Standards | 原P2指出外层登记不覆盖两个Core类的嵌套建库；撤回全部事前登记声明，保留两轮四个旧UUID未知，另以封闭守卫新轮验证后续保护 | 原P2关闭，未关闭硬违反0、Fowler possible 0 |
| Spec | 初审产品0发现；增量SQL、公开四分支及页面恢复未见产品问题。P3要求写准八例cleanup字段 | 签收文案按实际helper改为每例 `child.exitCode=0`，cleanup深等于 `{instance_ok:true,class_ok:true,database_remaining:false}`；原独立Spec已只读确认关闭，最终未关闭0，未改产品或旧proof |

独立merger在clean根 `2ec12587b68d85bc08399c1cb0fe0c71f9208a6c` 无冲突no-ff合入最终候选 `8bf0d3c8f10a51578434eeb47a46b1e8d02e33b1`，合并提交 `2479f3a6bcc7ecd12878ff36eac1703ff2265471`。合并树与候选完全相同；之后仅写本票签收及索引文档，没有改候选产品、测试或架构，也没有吸收main后续变化。

## 交付接缝

- 联系人及本人各有独立概览预算，底层原话另计来源／字符预算。目录标签仅作导航，回执记录实际命中、空结果、未知、历史状态、实际消耗和预算耗尽；前端展示实际依据及未确认标记。
- 准备前固定最多500条有效历史ID，与本次初始消息ID取并集；初始补窗口和运行时三类SQL补查沿同一白名单，初始与后续共享3次／16条／2048估算token。准备后新消息不进入该次上下文或补查；本人跨联系人的底层身份用于删除证明，不授权读取另一关系原话。
- `version=2/schema_revision=3` 显式白名单包含六类新增值对象。严格解码核对身份、种类、修订、投影和计费；允许历史却缺冻结集合时拒绝，空tuple仍合法。旧修订沿01终态封键及明确重新准备路径保留编辑，不自动生成第二次任务。
- 同次prepare CAS登记完整导航删除UUID；模型前和同owner writer事务复验真实底层窗口、两类概览修订及历史／当前依赖。排队删除按既有contact→owner锁序擦除固定JSON、输入、快照／恢复依赖及相关缓存，不影响无关作业，晚结果不能回填。
- 合法纠错完整窗口可没有 `kind`。原普通SQL不等比较因NULL误拒，现用 `IS DISTINCT FROM 'erased_guard'`；墓碑继续排除，同owner、已登记身份、完整窗口和来源复验保持。
- 本票没有DDL；正式001–062原字节保持，三处生产Grounded默认、语义关闭与既有质量门保持。08随后增加另一种冻结结构时必须再升schema修订，不复用本票schema3。

## 分轮真实验证

各轮存在覆盖重叠，不能相加为一次全量或独立用例总数。资料均为合成数据，模型均为受控脚本；外部模型尝试为0。

| 实际轮次 | 成绩与限制 |
| --- | --- |
| 单位最小与完整 | 最小18项；最新完整1352/1352、13.298秒。较早1351及其他1352轮均独立记录 |
| 组合公开HTTP／PG | 14模块111/111同轮，164.288秒；当时仅外层登记，不能认证所有实际库已清 |
| 冻结／历史反例及main准备组 | 最终31/31同轮，47.369秒；不与111混加 |
| Node／React控制器 | 29/29；SQL页面修复后另轮29/29及类型检查通过 |
| 生产桥概览HTTP | 4/4；同步安全根后另轮4/4 |
| 显式生成上下文桥HTTP | 8/8；每例实际子进程退出0和cleanup对象断言通过，成功目录已删除，没有另存其UUID索引 |
| 新封闭exploration组 | 两模块9/9、18.822秒；外层1库加Core2库逐名absent=true，只认证新轮 |
| 合法纠错窗口公开HTTP | 新增1方法／4分支，4.539秒；合法无kind完整窗口成功，墓碑、缺窗口、缺来源拒绝且不保存回复身份 |
| 完整控制器序列 | 1/1、7.414秒；删除来源→查空→补资料→主按钮新生成，实际引用修正版，三轨预算均耗尽，脚本模型3次 |
| 固定源码React恢复页面 | `96270b5e`，单Chrome、1 case／1 scenario通过，有限180秒；脚本模型4次／外部0，原页面断言未削弱，Electron／原生未运行 |

实际单位命令为Conda `NotAlone`、禁dotenv的 `PYTHONPATH=src:.. python -m unittest discover -s tests/unit -t . -q`；旧14模块由 `/tmp/notalone07-run-owned.py` 在导入前绑定双URL，仅登记外层。新两个exploration模块和四分支方法分别使用已核阅的有界守卫副本；模块及命令原样记录于Answer。页面实际命令为 `npm run test:pages -- --case overview-reply-retrieval --timeout-seconds 180`；本次merger没有重复执行这些动态命令。

## 原失败与页面恢复

最初概览HTTP17方法含1失败，prepare组35项含1失败；包装器未传冻结ID、来源可用性未识别导航UUID、排队删除尚无回复请求时未擦固定JSON等红绿均保留。缺历史集合的严格解码反例先红后绿；较早夹具校准不改报全程通过。

原单Chrome页面1 case／1失败：来源删除查空后再补资料，第三次生成仍停留旧候选。实际故障是同键reserve在模型前误拒无kind的合法纠错决定，不能归为模型或页面偶发超时。原序列HTTP先1失败；诊断探针及“长句命中但本人预算未耗尽”的1失败均保留。新增四分支方法先有夹具预条件失败，下一轮为1 failure＋1 error，修正正式墓碑约束后才通过。探针已移除，最终查询保持真实修正版与三轨阈值，没有删除预算或页面断言。

固定 `96270b5e89675d20d46378fa41eabc9dbf5b46ec` 的页面恢复后至 `8bf0d3c8`，产品、测试和架构零差异，仅Answer补证。私有页面日志记录scenario通过及cleanupConfirmed=true；runtime直接记录精确001–062、loaded_modules242、critical_modules22、脚本调用4／外部尝试0、phase=cleaned、database_remaining=false、instance_cleanup_ok=true、cleanup_confirmed=true及PID1002。merger只读核对22个关键摘要全部匹配合并树。

重复迁移0来自夹具二次migrate严格门及ready协议；Python退出0来自ChildProcess退出检查、runner退出0及成功日志，这两项不是runtime JSON直接字段。原记录中仅查询已登记PID1002，status1／空输出证明当时不存在；两租约另读为absent。PID／租约观察和数据库核销分别保留，不相互替代。

大消息夹具回填后曾发生默认GET `/messages` 10秒超时，列表性能尚未认证。后续只从同自有库读取已导入合成UUID作夹具身份，冻结查询及生成／evidence仍经公开HTTP；没有把该变化写成列表性能通过。

## 资源证据与历史未知

`/tmp/notalone07-proof-index.json` 索引14个已知外层库和10份HTTP proof，即24个已知精确库名；其限定元数据absence核验已经完成。组合proof直接记录外层cleaned／database_remaining=false，部分早期marker仍为planned，absence取相应实际日志。此索引不能覆盖旧35项及111项两轮各两次、共四次未登记Core CREATE；旧UUID无法从现有日志恢复，无类清理异常不能代替逐名核销。

新exploration守卫轮的3库、窗口方法有界红绿各轮及controller／页面各轮精确库，分别由私有 `/tmp/notalone07-page-fix-proof-index.json`、marker、absence或runtime记录支持。事前0600/fsync归属、显式双URL、本机实例和current_database核验只认证实际覆盖的路径，不宣称覆盖未来任意Cursor／Async等新建库路径。新通过不补认旧四库。

[03隔离事故](reports/test-database-isolation-incident.md)的152项／65错误／1跳过及默认库身份、并发影响未知仍保留；[旧35个失败目录](reports/fixture-ownership-evidence-gap.md)归属虽全部恢复，精确旧库UUID仍为0，数据库残留未认证。另见[07／08嵌套建库补记](reports/nested-database-ownership-followups.md)：07旧四次和08旧四次均不能据新轮判清。没有连接、扫描或清理未知库，也不据此宣称其他会话完全未受影响。

## 合并最小复验与数据影响

merger实际运行 `npm run typecheck`；工作树、暂存及M2至HEAD三个范围 `git diff --check` 均通过。Node标准库读取固定Git blob与当前文件，断言正式62迁移连续、全部与原根同字节、前58个与M2同字节、07无DDL；六组known加新overview-reply共七组夹具保留精确062／重复0，生命周期054→062尾序、codec2/schema3六类新增白名单、三处Grounded默认、500范围与三个SQL白名单路径均保持。合并树与候选逐字节一致；签收只修改本票文档及索引。

签收计数检查的临时脚本首轮错误地trim了Git状态首行的前导空格，使路径白名单断言误报；该命令后续Git检查返回0，不能把外层退出0当作首轮脚本通过。修正为保留状态列后单独复验，产品没有变化。Markdown与真tab索引逐行核对15票、11字段及47／44计数。

合并提交后实际执行 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree` 及 `--ref HEAD --working-tree`，两项issues均为0；只读main快照 `4c9bf705f3ebf5dec6867336db0d2ceded66177f`，HEAD为 `2479f3a6`。签收记录提交后继续复验。本次没有启动DB、HTTP、Chrome、App、微信、模型、探针或租约，没有新增动态成绩。

本票数据影响为导航删除身份、固定回复上下文和自有合成测试资料，没有新增DDL或外部聊天发送能力。实际App／微信和真实模型仍待最终组合；S分叉库保留，本轮未迁移业务库、合入main、push、PR或部署。签收后8 resolved（01–07、14）、1 claimed（08）、6 open，AC47已勾／44未勾；09仍受08阻塞，未领取，持续目标尚未完成。
