# 正式13：明确范围反馈候选验证

本票仍为`claimed`，六项AC保持空；此文件记录候选实现及实际分轮证据，不代替独立Standards／Spec审查或集成签收。固定基线为`401c8e8ba663e3e54655e2409c24bad4dcb687fc`，来源区间为`86481b9881582fb8203565f99d105dffd39bc7fa → 20a84220f2841c7f6cbbc389e2b446268af3f7df`，固定S为`54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616`。不吸收main漂移，不合入main、不push／PR或部署。

## 实际适配

- 新增canonical068，原字节承接S067，Git blob为`3f049a3eb788d223eb3baf42b97d31b1069878ab`，SHA256为`1670f66e4cc08371cbf4ffc97ffc2cceb26bea9da86e14757f86d56fb38f4bc6`。001–067与本票基线逐字相同；065既有算法JSONB本地增量不变，冻结issue-index SHA256仍为`93ab22eb181a733d0f0d730c92c749b9206b91da35e205635b86e8accfb049ec`。
- 政策保存owner全局单调CAS、明确对象和最小范围、命令指纹及结果修订；真实Skill／联系人复合外键与当前合法版本、方法校验共同限制管理入口。同键只重放原操作当前结果，新键旧修订和stop→undo后的旧stop拒绝。
- 目录和资源许可共用方法身份、映射、祖先及相关政策计算，不读取未选版本或方法正文，不构造假view。实际选择后，筛选版本只读取允许方法并构造新正文、安全描述及真实`SkillExecutionView`；未分离资源拒读。最终writer只对实际选中版本复算投影。12完整来源来历与13政策祖先为独立门，不覆盖11元数据／正文分离或12跨联系人历史许可。
- 回执的`policy_revision`是实际阻断相关政策的最大修订，区别于owner全局政策修订与原目录修订。继续、重试、携入、讨论后代、完成重放及保存到助手完成／中断之间递归核实际旧输入，最多256个请求；合法历史和编辑保留，政策变化显示`reply_skill/skill_policy_changed`。
- 场景仅从权威command／input重建，回执scene不一致或损坏即拒绝。旧缺view仅在当前实际相关政策修订为0时兼容，不补签新许可。更新、合并和旧本地包回滚继承方法及逻辑Skill祖先停用；来源擦除后撤销无正文决定不能恢复策略。
- 保留M2联系人输入、scene、编辑、异步任务与准备归属；反馈UI强制选择具体方法或整个Skill及四种范围。普通反馈仅编辑本次候选，长期修改仍经草稿审核。unknown POST只重原body／key，关闭面板及来源删除token使迟到返回失效。

## 准备格式边界

`SkillExecutionView`只出现在实际Skill版本／使用／预览及完成回执，不是prepared白名单字段；没有盲目把它加入codec。已有白名单`ReplyBasisChange`新增严格`reply_skill/skill_policy_changed`值变体，可位于`continuation_basis.basis_changes`与`DiscussionItem.basis_changes`，因此明确提升到version2/schema5，同时用Literal、UUID、精确字段集及kind／reason配对校验。旧schema4、未知字段及损坏值必须重新准备，不静默补revision0或允许集合。

政策推进目录修订；模型调用前的原`ReplyContext.validate_current`与最终writer均复验。M2的`requires_reprepare`另补同事务目录修订检查，让同schema5的旧政策许可也沿原身份、可靠终态、attempt与租约门封旧键后显式重新准备；不自动发第二次生成，不清用户编辑。具体新旧格式与running边界成绩按下列实际轮次记录。

## 已完成轮次与原失败

PG／HTTP轮使用新私有有限计划、明确方法／创建者／预算，Python先激活NotAlone，项目导入前绑定双URL、禁dotenv和tracing并固定本树PYTHONPATH。guard原34及新copy34纯fake通过；后续增加critical manifest与只读调用计数后，最终新36也独立全过。所有真实CREATE前以0600／O_EXCL／NOFOLLOW／fsync登记精确ASCII身份，确认created才DROP并逐名核absence，未知归属立即poison并failfast，未扫描未知库。

| 轮次 | 实际结果 | 说明 |
| --- | --- | --- |
| 凭证最小red | 1方法，1error | 新`SkillExecutionView`尚不存在；无DB连接或CREATE。 |
| models＋codec green | 16/16 | 新凭证、schema5新变体往返及旧schema4／严格字段拒绝。 |
| HTTP首轮 | 1方法，1error | 三方补丁在既有审核事务helper后误置投影块，`IndentationError`；自有created1精确核销，原栈保留。 |
| HTTP修复smoke | 1/1 | 审核投影移回原事务，保留唯一locked helper；2.293秒，created1／absence确认。 |
| 源反馈16 | 16/16 | 同一字节轮27.567秒，1库／cap1，精确absence；不是源成绩挪用。 |
| 准备许可新red | 1方法，1fail | 旧prepared执行HTTP500与预期409不符，未走到后续0model断言；原失败保留。 |
| 准备许可首修复 | 1方法，1error | 旧409／0model、封键、新key准备及通用回复已走过，最后测试错误读取session顶层input导致KeyError；不能改称整例通过。 |
| 新组合首轮 | 计划9、实际7：6过／1fail | stop-first已建立真实PG等待，但最终writer为500；使用既有输入失效错误改为409，原失败保留。 |
| 锁顺序修复 | 2/2 | 3.656秒；两个独立HTTP实例，分别writer-first与stop-first，均以`pg_blocking_pids`确认实际等待，不能用Event排序代替。 |
| 最终反馈组合 | 25/25 | 源16＋新增9，同轮43.547秒；含完整删除真实资源、直接SQL及旧动作拒复活。 |
| 最终调用观测组合 | 25/25 | 同字节再轮43.551秒；reply＋review实际seen96，extraction实际seen13。共享reply模型无法再拆分两种用途；旧轮未汇总不追认。 |
| 068缺失red | 1方法，1fail | 期望只追加068，实际为空；自有库精确核销。 |
| 旧前缀兼容首轮 | 计划6、实际1：1error | 原065→066用例在保留旧断言后直接调用现行port，缺068政策表；保留旧前缀断言，再明确追加067／068后验证现行读取接口。 |
| 迁移兼容恢复 | 6/6 | 2.299秒；含067前向／全量068、复合FK及重复0，6个created逐名absence。 |
| 11／12来源读门 | 2/2 | 6.942秒；真实旧候选只读来历与跨联系人先许可后正文，2个created逐名absence。 |
| 相关纯组首轮 | 实际377：376过／1fail | 审核SDK测试stub旧签名不收`with_execution_view`，实际MockTransport派发0与期望1不符；仅适配测试接口，不改产品SDK请求。 |
| SDK夹具恢复 | 5/5 | 13次实际MockTransport派发；外部模型0，产品SDK请求不变。 |
| 最终相关纯组 | 381/381 | 回复与Skill相关单元范围，PG连接尝试0；不宣称完整仓库组。 |
| shared首次计划 | 计划7、实际0 | 仅冻结计划与源码，没有启动真实方法。 |
| shared正文读门首轮 | 计划7、实际1：1fail | 旧夹具只监听`version_content`别名且未覆盖`Connection.execute`，漏计真实选择正文读取；扩大实际游标观测后仍要求目录／资源0、选择1。 |
| shared前缀夹具轮 | 实际6过，另1个setUpClass error | 组合夹具仍用full-root strict063；保留原前缀用意，现行全量明确strict068、尾文件068、身份与repeat0。 |
| shared证据目录轮 | 实际7：6过／1个teardown error | 最后方法断言已走过，但缺少组合证据目录环境变量，不能记成7通过；新私有0700证据目录随新计划注入。 |
| 最终shared组合 | 7/7 | 8.554秒；覆盖11最小正文读取、四种M2新旧准备终态／租约、04跨联系人导航与08双prepare／继续／重启；created1精确absence。 |
| 桌面相关Node | 82/82 | 8个相关文件，包含明确范围、原动作重试、关闭迟到、view严格解析及A→B→A。 |
| npm test | 65/65 | 含类型、安全／调度和macOS自有探针编译签名；未执行产物或App。 |
| 有限Chrome首轮 | 1个页面场景失败 | 已完成明确停用、真实POST后丢响应、相同body／key重试及编辑保留；第二次主动生成后期待新view超时，实际无新增模型派发。原页未捕获业务409原回执，不能追认。实际1Chrome／1context／2pages，响应原body8份共5,780,528B，自有库、进程与lease均精确退场。 |
| 主动重新生成入口 | 1方法red→green，相关84/84 | 原键只重试原次；明确“重新生成”才新键、新view，类型检查通过。新字节不追认此前82／65成绩。 |
| 公共409原因预查 | 1方法red→green，另会话3/3 | 恢复页启动前发现HTTP客户端丢弃`skill_policy_changed`；真实本机HTTP测试覆盖8种严格原因与未知仍拒，新增原因从后端实际409 DTO核验。只补客户端白名单；类型检查通过，未为此重跑84或npm65。 |
| 有限Chrome第二轮 | 1个页面场景error | 实际35个`/api`请求、34份完整响应，原prepare200与停用后prepare409同key／scene，409原body含`skill_policy_changed`；reply＋review5、learning1，尚未走到新key。新增诊断函数在隔离环境清除变量后读取证据路径，触发`ERR_INVALID_ARG_TYPE`；原错误及原body保留，自有资源精确退场。 |
| 诊断目录修复 | 1方法red→green | 使用真实文件系统复现相同错误，再验证进入隔离环境前捕获目录；清变量后仍写同目录、0600且JSON回执原样，类型检查通过。只改测试侧3文件，未放松环境隔离或业务断言。 |
| 有限Chrome第三轮 | 1个完整页面场景通过 | 原键409／编辑保留、显式新key／真实过滤view、A→B→A、关闭迟到轮询、重启、精确撤销、wholeSkill与来源删除均通过。Node主进程实际`/api`请求144、完整响应137、未完成响应7；Python夹具HTTP未计入。静态响应原body12份共8,671,620B、两份构建artifact及Python ready／end原bytes保留。实际learning started1／model_calls1、reply_started15；started不等于完成调用数。 |

桌面原red分别为凭证丢失、反馈桥缺失、审核拒绝新凭证、历史未展示允许方法数及范围被默认选择；组合测试还保留合成权威输入缺布尔字段与SSR无window宿主的夹具错误，修复后相关组通过。页面失败后的独立公开bridge反例证明：停用后沿原key生成被`skill_policy_changed`拒绝，模型派发0、用户编辑保留；显式新请求才得到新执行view。主动聊天页原先只有沿用原key的“生成候选”，已补齐与其他模式一致的显式“重新生成”入口，最终页面按真实原键拒绝后明确新键生成的流程通过。

另保留一次私有自测编排失误：原34已过后增加两条fake，critical fixture因`/var`与`/private`的路径解析差异报错；该shell未启用错误中止，仍继续运行已守卫的missing068 red。实际创建归属守卫没有poison，已知库完成精确核销，但不能把这次失败fake称为通过。原失败文件不覆盖；修复写入新copy，新36独立全过后，后续preflight与PG分独立工具调用并检查退出码。

页面第二轮前的原adapter离线12／12与HTTP旁观fake8项通过。另一次未启用的adapter候选因误判双install包装中的driver作用域，在2个fake方法报`NameError`，没有PG／Chrome启动；复核后仍使用已通过原adapter，未把未启用候选记成通过。第三轮前首次误调用不存在的fake文件，退出2、实际0测试且PG／Chrome0；另用实际文件独立12／12通过后才预检、启动。全部候选、失败计划与日志保持原样。

最终绿PG方法为25反馈、6迁移、2来源读门、7shared四轮的唯一并集40，不是一次40方法运行，原25重跑不算50个不同方法。相关纯组381包含定向SDK同5方法，不相加为386；Node82→84与后续HTTP原因1／会话3／证据目录1分别绑定当轮原bytes，不用先前成绩追认后来文件。每轮实际方法ID、计划与实际分母、源码ready／end、critical清单、命令、PID／group、创建登记和absence、原失败、资源与原body在私有最终索引保留。早期轮未独立汇总全部HTTP请求或受控模型调用时明确记为未汇总，不用方法数或外部调用0代替。

动态验证已停止。实际known-created共26（守卫轮23、页面轮3），均逐名精确absence且poison为空；只核登记自有PID与lease，不扫描未知进程或数据库。最后页面登记13个PID均已不存在，headless lease不存在。私有原始文件0600、目录0700并fsync，后续整理时补fsync不会追认最初写入时耐久性。

## 数据影响与未验边界

只使用合成联系人、受控模型和自有隔离库；政策表不保存反馈原话或候选正文。来源删除继续清草稿、私人依据、对照、版本、资源、方法、操作摘要及跨联系人实际使用／prepared／编辑／隐藏恢复副本；stop本身不删除合法历史。没有外部模型请求、实际App／微信／CLI／视觉、业务升级或业务迁移，工程合成通过不证明真实模型质量或原生渠道能力。

03旧事故152方法／65错误／1跳过的实际DB影响unknown、旧35目录DB UUID0及07／08旧各4个嵌套unknown继续保留；不查询、扫描或清理它们，不追认其退场。S分叉库保持原样，默认质量门、词法生产检索及DSH关闭不变。

## 固定候选独立审查后的增量修复

原候选`06795fa654324b1fc4011926a30ff3544247cea9`及其全部证据保持不变。独立Standards报告P2一项：政策POST借用历史展示载荷，读取仅需身份的版本／方法正文；另有selected投影流程重复的判断项。独立Spec报告wrong一项：递归许可门将显式null与真正缺字段混同。以下为修复候选，仍等待独立完整及增量复审，不自行关闭审查项、勾AC或签收。

- 政策写入保留同事务contact／owner锁、联系人许可、CAS／命令指纹／当前结果回放及删除并发顺序；仅查询请求Skill与版本身份，并对该版本调用既有完整`capture_parent_publications`来源证明。单方法只查询目标方法身份，wholeSkill不读取方法正文；legacy `whole_strategy`仍仅在不存在细分方法身份时可用。未知目标不会先遍历其他版本正文。
- 所选版本的metadata→必要正文→真实view流程合并为同事务`_selected_projection`。writer自己的目录修订、版本身份及执行view比较均保留，筛选路径继续只读取允许方法正文；资源许可与目录仍不构造假view。
- 保存的执行view只有真正缺键、且当前相关政策修订为0时可按旧记录兼容；字段存在时一律严格解析，显式null拒绝。新DTO不以null充作旧许可。没有新增encoded字段／值变体，prepared继续为version2／schema5。

新增真实公开HTTP／PG反例先red再green。政策目标反例最终实际执行8个POST：合法单方法／wholeSkill、未知版本／方法各出现2条正文投影，未知Skill／其他owner／真实publication跨contact／真实来源代际失效均为0；最后对8条不必要投影聚合失败。修复后8个POST均为0正文投影，原200／409／404许可结果和修订保持。观察使用真实`Cursor.execute`后的精确列名，不把`content_sha256`或`IS NOT NULL`谓词误算为正文。

null红轮的4个探针全部实际走过：真正缺字段related0携入200；显式null重放500、携入200、继续prepare200，provider／seen均2→2。修复后null三个入口均409、仍无新增模型调用；真正缺字段在已有无关scene及其他contact两条政策时，携入和新继续prepare仍200。原损坏／错scene／相关停用后拒绝由原25组合继续覆盖。

政策测试前两次附加更新草稿的夹具准备分别超时，8个目标POST均未执行；它们作为fixture失败保留，不称为Standards目标red。随后收窄到最小真实公开发布的两方法版本再完成上述反例，不宣称动态验证了多历史版本数量。每轮使用新私有有限计划、guard copy、双URL预绑定和创建前精确登记；原失败、实际方法及原bytes保留。

| 增量轮次 | 实际结果 | 保留边界 |
| --- | --- | --- |
| fix01／fix03政策夹具 | 各1方法、各1失败 | 13.987秒／16.862秒；目标8POST均0，不能当政策读取red。 |
| fix02 null共享门red | 1方法、1失败 | 四探针均实际执行，原重放500／携入200／继续prepare200保持原样。 |
| fix04政策读取red | 1方法、1失败 | 8POST全走，四种目标共8条正文投影；其他身份／来源拒绝与修订断言已通过。 |
| fix05新增反例green | 2/2 | 3.065秒；8POST全部0正文投影，null三入口409，missing与无关政策正例200。 |
| fix06反馈及历史门 | 27/27 | 48.101秒；原25反馈含新增null损坏断言，加11真实captured历史及12跨contact先许可门；真实PG两锁顺序等待继续通过。 |
| fix07 metadata门 | 1/1 | 目录与资源不读正文，实际选择才读取正文的原11门。 |

新绿轮按实际method ID去重为30（2＋27＋1）。直接与原最终40清单求交得交集28、新增2、原有未重跑12、并集42，不把两组相加成70或宣称42都在新字节运行。新轮的loaded模块原bytes及critical773均与当前一致。原381／SDK5、页面、Node及npm65保留为原候选成绩，本次没有重跑，不追认这三个产品模块的新字节；schema、迁移、桌面及SDK源码没有本次变化。

fix05实际reply provider／seen为5、extraction seen为1；fix06分别为106及15。null拒绝探针provider／seen均2→2。metadata轮没有受控模型对象计数字段，不把字段缺失称为实际调用0；未独立汇总的总HTTP请求按原口径注明，8个政策目标POST不代替全部夹具HTTP。没有外部模型调用。

本次7个有限轮实际新建9个自有库，全部创建前登记、双URL预绑定、逐名精确absence、poison为空、租约关闭，登记7个runner PID均已不存在。原候选26库只引用原索引，不重做或扩大核销。原报告、红轮、夹具失败、命令、方法清单、PID／group、marker／absence、源码ready／end与所有原bytes在新私有fix-index中保留；动态执行已停止，等待固定修复候选独立复审。


## 固定修复候选最终独立复查与集成签收

2026-10-16：固定最终候选为`3a2ff9b2d7bcb93f48748666d855e13f02b6d2f7`，parent为`06795fa654324b1fc4011926a30ff3544247cea9`，tree为`54d9d9ab0b685a536648b799281beb4fdf3a08f4`。独立Standards对完整70文件及修复6文件最终复查，原P2与重复投影判断项均closed，硬违规0／possible0／未关闭0；独立Spec的原P2 closed，missing／partial、scope creep及implemented wrong均0。两份最终原报告SHA256分别为`2723fd87cd5fd8509c99a69b629fb1439cf21073e2bccec7eee9ab354eebe122`与`1bc6a55c516251abe68f9134f081562a8d8b70d7cf099bf59a09d3d322c6fd72`；原报告和失败记录均保留。

根Agent独立只读核对31,587份原字节引用、70个候选Git文件及三绿轮critical各773项，loaded原bytes也均0差异。交接索引／候选来源清单／修复索引SHA256分别为`52bd3a850560776586527a1796ae7a9edd4f35ab4ebb1d5c0c23150bd0a4c524`、`a54fd3e196b9f2f8cd25ed6eb419f71ffc75c78cb1aeb9ae751f7ab370e1371d`、`99420d72f06c2dddf191283e06c30fa06cb71ad274dfe1dc7e929770d289528d`；独立原字节核对索引为`9866379c3986c0f5e3febc97b2f71e8edd5d67e35fc7b845f6321ea11f2ca6ae`。这些均为端侧既有证据的核对，没有新增动态执行。

从干净集成根`401c8e8ba663e3e54655e2409c24bad4dcb687fc`无冲突no-ff合入`762405952efad9f0da5aab56b64e4b84fcf4af09`，合并tree与候选完全相同。merger仅执行`git diff --check`、本树自有依赖的`npm --prefix desktop run typecheck`与Node标准库静态合同：canonical001–068连续，M2前58及原根前67文件原字节不变；068逐字等于S067 blob `3f049a3eb788d223eb3baf42b97d31b1069878ab`、SHA256 `1670f66e4cc08371cbf4ffc97ffc2cceb26bea9da86e14757f86d56fb38f4bc6`，codec仍version2／schema5。冻结`issue-index.tsv`不变，集成TSV为16行／11列／160个真实tab。merge后本地publication检查main与HEAD均issues0；当时main只读为`60c7f40774a6e175f1a93946fb023729465ef1dd`，未吸收其漂移。

工程签收继续按实际轮次说明：修复新绿30方法为2／27／1三轮，与旧40交28、并42，旧12未在新字节重跑；原页面、381、SDK及npm65也未在三个产品模块修复后重跑。第三轮页面原body含图像完整保留，实际1Chrome／2context／3pages、144请求／137完整响应／7不完整；reply_started15到cap15、learning1，started不冒称seen或completed，外部模型0。新9个known-created的27个planned／created／drop_confirmed标记与逐名absence齐全；旧26仅承接原索引，本票合计35个known-created。03、早期35目录及07／08旧unknown继续未知，未扩大核销。

六项AC与Answer按上述真实范围签收，当前01–14共14 resolved、0 claimed、1 open（15），AC83已勾／8未勾；15仅就绪，仍未领取。merger未运行PG、HTTP、Chrome、App、probe、CLI、模型或新租约；真实质量、实际App／微信及业务升级分别待后续验证。S分叉库保留，未合main、push／PR、远端或部署。
