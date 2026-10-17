# 正式12：Skill更新、合并与合法回滚候选

日期：2026-10-16。独立分支 `codex/integration-12`，基线 `020451752889e63656409ad903224816aaa4f773`。本票保持 `claimed`，六项AC未勾；本记录交主Agent独立Standards／Spec审查，不是签收、合入main或整批完成。

下文首版统计归 `c85cb0296b4b38f432f45b38cba94c6bf1a0ae49`。首次暂存新文件时发现两处源EOF空行，末节单列规范及重新冻结后的最终轮；不把首版16库或两轮页面当成全票最后资源数。

`a27680078a12b7f14f41e522cb12e4b90d0d9d2f`之后的独立审查及P2窄修记录在最后一节；该节为最新待复核候选。旧页面及117方法属于各自明确源码轮次，不自动转认后续修复字节。

## 固定来源与兼容

逐块集成源 `aac75f16b7c3a9816614567ad76c98535d93dbf3 → 86481b9881582fb8203565f99d105dffd39bc7fa`（源提交20615b85、fc3981d1）。`skill_history.py`、`skill_version_lineage.py`及源生命周期测试在该终点到固定S之间无差异；没有导入后续13执行投影、政策或15升级装配。新增canonical067来自源066，Git blob `29f5f5028a0f230a59e060b088eb2b52a10058c6`，原字节SHA256为 `7a2780fddd439393aa749019a25bd2896e409b293f91df994ae27d65bacc2fc6`。

001–066与本票基线逐字节相同，001–058与固定M2逐字节相同，035审计清单及M2旧058保持。真实库只安装001–067，保留旧包、审核正文／方法／发布来历、原迁移checksum及applied_at，重复应用0；真实复合FK拒绝跨Owner／联系人及同Owner另一Skill版本混接。没有安装或读取未来068政策表。

11已签收的目录元数据最小投影、只读未物化候选原版、精确来源LEFT JOIN、摘要“来源已删除”及运行中审核核验保持。准备codec仍为version2/schema4：本票没有新增encoded fixed字段；审核来历JSON的version3独立于prepared codec，不给旧快照补parents或执行证明。保留04合法历史与当前生成门、07完整导航／500消息与3-16-2048预算、08偏好世代、10算法指纹与Grounded默认／独立V／空质量维度表，以及11零重试／DeepSeek thinking配置和未知预算本地拒绝。

## 最终行为

更新和用户明确集合内的合并仍只形成草稿，经过11编辑、同输入对照、范围及替代关系双确认后原子发布；混合父范围拒绝合并，仅停用明确替代目标。版本和方法保留logical身份、替代映射及mapping_state，供13接续，尚未宣称方法政策执行已验证。

父版本在原取材联系人范围递归核验完整publication及来源；普通、导航与继承依赖保持保守并集。明确本人／精确场景范围的合法父版本可由另一已确认联系人更新，模型材料只含本联系人的普通材料、清洗策略及合法版本身份，不含原联系人、来源UUID或私人原话。私有祖先仍受原范围限制，去身份不自动取得广范围资格。

历史入口读取真实合法非current／停用版本。回滚沿contact→owner锁、当前版本及library revision双CAS，同键回执也重验完整来源、当前结果版本及result_revision；新键旧revision拒绝。只切current，保持用户停用，不启用合并中其他目标。当前版本被删除后，独立合法旧包仍能明确恢复为current且保持disabled；已删正文不能恢复。管理read_current_version／export同样核完整来源。

两个独立生产HttpBackend实例分别发起回滚与删除，实际共享同一自有库。两条测试均用`pg_stat_activity`／`pg_blocking_pids`证明第二个HTTP事务真实等待第一个数据库锁，再释放事务；没有只靠线程Event判断锁等待。回滚先提交时只有一条最小历史回执，随后删除擦除；删除先提交时原合法回滚拒绝且回执0。首个后续GET之前直接SQL核两代正文／摘要／资源／publication来源及审核回执清除；经公开DELETE入口同步运行真实worker后，再在GET前核删除终态，重启同键和新键旧修订均拒恢复。独立旧包与另一Owner的包继续可预览。历史动作回执仅保留无正文身份及摘要，不是策略或响应副本。

## 红测、错误与恢复

- 请求反例先因新路由缺失得到404而非400；接入严格字段合同后9/9绿。此前第一次命令因未显式指定本树PYTHONPATH，错误使用共享editable包导致ModuleNotFoundError；原日志保留，这是装配错误。最早两次无连接请求命令使用未登记占位URL；未连接或创建库，后续unit均改为事前登记、cap0且禁止连接的自有身份，不追认早期占位为归属证明。
- 067前向反例在真实自有库先红：`migrate`返回空集合而非067；放入源原字节后4/4绿。最终源码冻结后另轮4/4，不把预冻结绿当最终重跑。
- 桌面最小反馈依次缺历史入口、初始history状态、目标变化区及页面case白名单；修复后单文件绿。早期记录为工具输出摘录，不冒称完整原stdout；最终完整日志独立保存。
- 后端原字节归档首次在backend目录使用仓库根过滤，生成0条manifest；空文件以toolerror保存，随后按仓库根纠正为1359条。所有运行ready／complete模块SHA均与纠正后的原字节逐项一致，最终源码0漂移。没有修改运行中的产品源码。
- 首轮页面完整流程绿，但没有保存浏览器响应原字节；保留该轮证据，另立新有限计划重跑同一冻结源码补齐。新私有adapter先12/12标准库fake，再保存ready／complete原字节；没有以事后构建目录hash代替浏览器实际响应。

## 实际命令与结果

所有Python先激活Conda `NotAlone`，项目／测试导入前固定双数据库URL、禁dotenv及`ENV_FILE=/dev/null`。私有runner记录完整命令、selector、精确库名与原始栈；下表是各独立轮次，不是单轮总suite。

| 组 | 实际入口 | 结果 |
| --- | --- | --- |
| 067最终迁移 | 私有guard `--mode compatibility` | 4/4，原11两方法＋12两方法 |
| HTTP | 私有guard `--mode related`，冻结41个method ID | 41/41，103.492秒；Lifecycle12＋Review26＋Learning3 |
| 旧本地包 | 私有guard `--mode shared`，六类显式57方法 | 57/57，1.674秒；library／lifecycle／port／preview／export／deletion |
| 来源删除 | 私有guard `--mode shared`，显式15方法 | 15/15，2.440秒 |
| 相关unit | skills排除两个未改SDK transport模块＋请求＋prepared codec | 58/58，0.100秒；PG／socket连接边界禁止 |
| 相关Node | 14个显式测试文件，生产Main／preload合成传输 | 200/200，2674.939毫秒 |
| `npm test` | 类型检查＋safe调度 | 65/65，23980.682毫秒；含自有探针编译／签名，未执行探针或App |
| 页面import-only | 实际导入全部required模块，连接边界禁止 | 25/25，PG0／模型0；不作为runtime通过 |
| 单Chrome生命周期首轮 | `npm run test:pages -- --case skill-lifecycle --timeout-seconds 300` | 1/1；learning1＋reply4，外部0，独立库1 |
| 单Chrome证据补齐轮 | 同命令及新私有只读observer／adapter | 1/1；learning1＋reply4，外部0，独立库1 |

最终PG／HTTP按method ID并集为**117唯一方法**（4＋41＋57＋15）。连同缺067红1、预冻结迁移绿4，共122次PG／HTTP方法执行；不是122/122单轮绿。unit与Node分母不并入PG方法数，HTTP脚本模型未另采集聚合调用分母，不把测试方法数当模型次数；两个页面各自固定1次学习＋4次回复，共10次受控模型轮、真实外部0。未改SDK接口，未新跑SDK传输批次或完整Python unit suite。

## 原字节与资源

后端／桌面1359路径源码归档、桌面571路径独立前后manifest均0漂移。最终页面274个ready／277个complete实际模块、25个critical全部保存原字节并对照本树；最终候选代码与实际运行模块字节一致。执行artifact `run.mjs` SHA256为 `72d766bfe0db836c59d4c81c1591f5145ea59b9c5cedc755fa82313d911dc070`，`renderer.js`为 `6b468d3519db2a6d95be0654dfb29347e4445697d24a92aa5285bc3f372838d7`，前后相同。浏览器两context／两page共8份实际200响应、4个唯一SHA（HTML／JS／CSS／图像），逐字节等于实际served文件，原body保存在私有证据中；首轮没有这项采集，不追认。

PG／HTTP六轮14个created，加两页面各1个，共**16个confirmed-created自有库**均在CREATE之前以O_EXCL／NOFOLLOW／0600／fsync登记，成功后记录created，精确current_database核验；DROP后逐名EXISTS确认absence。guard原33、新34、页面adapter11及补齐adapter12项标准库fake分开全部通过。所有计划均有限且封闭，未知DDL／URL／owner／query拒绝后poison并failfast，已知自有cleanup仍可运行；没有扫描或清理未知历史库。

两页面均Chrome1、300秒cap、单库cap1，无嵌套CREATE，收尾cleanupConfirmed；自有PID／进程组原记录及关闭租约保存在私有索引，末次页面租约状态absent。页面静默观察helper只观察本轮浏览器，页面不是Electron、实际NotAlone App或微信验收。

## 交付与未验边界

完整私有最终索引包含精确source delta、固定源码原文件／SHA、实际命令、原失败、每轮method ID、全部planned→created→DROP→absence、PID／lease、模块及browser body原字节。仓库仅保留合成统计，任务六AC与claimed状态等待主Agent独立两轴审查及merger。

main只读引用在本轮为 `64fc8f46e29bb92c34727ff4ece73e93d0a214f5`，未吸收漂移；本票只本地提交，提交后分别检查main和HEAD公开历史。没有访问S库、业务资料或其他会话，没有push／PR／部署。03事故原152方法／65错误／1跳过的实际数据库与影响unknown；旧35目录数据库UUID0、07／08各4嵌套UUIDunknown继续保留，16个本票自有库核销不能补旧缺口。

真实模型语义质量、供应商token精度／上界、方法政策执行、实际App／微信与业务数据升级均未由本票证明。质量维度空放行、词法检索、DSH关闭、人工发送及S分叉库保留边界保持。

## 首次提交后的EOF规范与最终重新冻结

首版提交前首次staged diff检查发现`skill_version_lineage.py`及新增生命周期测试各有一个额外EOF空行，原来源即如此；此前unstaged检查没有覆盖新文件，是本轮检查缺口。原输出保留，首版提交后main／HEAD公开历史均issues0。随后只删除这两个末尾空行，旧原字节及AST证明保留，两文件去位置属性的AST完全相同，没有行为或规格变更。

最终1359路径manifest v2在所有补跑之前固定。HTTP41/41（105.326秒）、迁移4/4（2.988秒）、本地包57/57（2.176秒）、来源删除15/15（2.664秒）、unit58/58（0.090秒）重新通过，均无跳过；最终PG／HTTP并集117方法与原轮完全相同。前端、配置及模型装配未改，Node200／safe65的571份源码字节保持，不冒称重复运行这两组。

第三轮页面在最终源码完成后重新运行同一生产生命周期，1/1，Chrome1／context2／page2／learning1／reply4／外部0；ready274、complete277、critical25均保存原字节并与最终候选相同。两份执行artifact SHA仍为上文值；实际响应8份／4唯一SHA、observer errors0，全部逐字节匹配托管文件。自有13个PID逐项检查无残留，页面租约absent。前两页面独立保留，不复用其资源或调用额度。

本票十个PG／HTTP轮次共23个confirmed-created库，加三个页面各1个，总**26个自有库**全部逐名核销；最终PG／HTTP唯一method ID仍117，分轮执行总数239（原122＋重新冻结117），不是239/239单轮。页面受控模型轮次分母为三轮各5、合计15，真实外部0；HTTP脚本聚合模型轮次仍未另采集，不以239方法冒充调用数。S／业务／未知旧库完全未加入清理集合，旧资源缺口保持。

## 独立审查P2：历史正文最小读取修复

独立Standards发现一项P2：原历史首查询投影`version.content`，之后才核完整发布范围；审核目录的contact_id为空，导致B请求A专属历史时即使最终404或目录为空，也先把A正文读入内存。独立Spec报告缺失／越范围／错误均0；两份原报告、a276及之前两提交、原私有索引和全部原字节保持，修复仍待根独立复核。

新增公开HTTP／真实PG反例同时观察真实Cursor的fetchall／fetchone返回值：原B单项GET404及目录GET空仍物化A正文两次，先红1方法／1失败（2.335秒）。修复只将首查询改为非正文元数据，沿同一事务的既有范围与完整lineage核验通过后才逐版本读取正文；当前版本核验失败仍拒绝整项，不吞校验，不另建权限规则。contact→owner锁序、双CAS／同键回执复验、disabled及11目录最小投影不变。

最小绿1/1（1.790秒）：B单项／目录、跨Owner均无该私人正文读取，合法A历史在核验后恰读该版本正文一次。固定1359路径源码后，HTTP完整生命周期13/13（40.877秒，包含两独立后端实际PG锁等待、跨联系人、历史回滚、删除及合法独立旧包）、本地生命周期10＋11目录最小投影1共11/11（0.457秒），均无跳过。增量为24唯一method ID，四轮26次执行包含原红1；不是26/26单轮，也不宣称旧117方法在修复字节重跑。公开HTTP方法并集为13。

这四轮使用新私有guard副本及全新有限计划：原34项标准库fake先通过；每轮CREATE前按精确身份、双URL、O_EXCL／NOFOLLOW／0600／fsync登记，成功才created、核current_database，原poison／failfast及仅已知自有cleanup门保持。新4个confirmed-created库全部逐名DROP／EXISTS absence，独立租约／PID关闭；不使用原26库的已关闭额度，也不把旧unknown加入清理。

本轮未重跑Node、安全大组、SDK、完整unit或页面。原第三页面277个模块中275字节相同，变化恰为`notalone.persistence.skill_history`和`tests.integration.server.test_skill_lifecycle`；原浏览器body与artifact保留，不能把旧页面1/1归为新候选全部字节。前端及既有571路径原字节不变。新私有增量索引明确每个最终验证组选用的directory、执行计划／PID及源manifest，数组顺序不代表时间或最终轮次；旧117的明确选轮同样保留。

数据影响仅为历史正文读取次序和一项真实读取反例，没有结构迁移或资料写入语义变更。保持claimed及六AC空，不运行实际App／微信或真实外部模型，不签收、不合root／main、不push／PR／部署；03／35／07／08旧资源缺口继续保留。

## 独立最终复查、合并与正式签收

固定完整范围 `020451752889e63656409ad903224816aaa4f773 → b2e4bf42e3e1cf118e55da7f232fe1c355820339` 共35文件，经相互独立的Standards／Spec最终完整及P2增量复查。Standards原历史正文过读P2明确closed，新增／剩余hard均0、possible均0；Spec缺失／部分、越范围、错误均0，没有新增或未关闭问题。两份最终报告SHA256分别为 `8ee35d02a3a889c653fff997e06e04a05367662c81391013510e5990b68dd79a`、`803913060b88f139dd8f2a5c4cb77b0a9cd03b16d7e1a72ceb6e33d2dc98b2fd`，原初审报告及其P2记录均保留。

无冲突no-ff合入独立集成分支 `1f3f711c0b017e8977d65cf429309c15e0b17511`；合并树与最终候选树同为 `ec6962629de37a1d3825abef6709edb4ddf25469`。merger实际执行 `npm --prefix desktop run typecheck`、`git diff --check` 和Node标准库8组静态合同，全部通过：001–067连续、旧001–066及M2前58原字节、035基线、067源blob／SHA、065算法JSONB增量、所选页面严格67／067／重复0及旧历史setup、codec2／schema4与scene权威输入、500及3–16–2048预算、Grounded／质量门／词法装配保持、未来068无运行查询、冻结索引与TSV结构。合并提交后 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree` 和 `--ref HEAD --working-tree` 均issues0；main只读漂移未吸收。

证据分轮签收：a276最终117唯一PG／HTTP方法与修复24唯一方法按method ID并集为118，不能相加成141或单轮通过数。原十轮239次、新四轮26次含原红各自保留；最终修复闭包为HTTP13／13、本地11／11，B正文读取0、合法A1。三个旧页面各1／1合计learning3＋reply12为15次受控provider轮、真实外部0，HTTP聚合调用分母未单独收集；第三页面277模块中275与b2相同，两个变化模块不转认旧页面通过，未重跑Node／safe／unit／SDK或页面。原私有索引SHA256 `a16d6ea2092da8233ba0ceb995d0c04d1c5596bc1a6dfb5f78bdf995498cab04` 与修复索引 `7b5687184c48470c917b3805e1a8668e87e77a9c57fdb5f3e4c876a07620e7fb` 均按原字节复核；后两页面有实际响应原body，首轮仅响应摘要的缺口继续保留。

原26＋修复4共30个本票confirmed-created库逐名DROP／absence，原50＋修复4个自有PID均关闭、租约关闭；merger没有新建PG／HTTP／页面／App／探针／模型或租约。本票六项AC及Answer现齐全，正式resolved；当前01–12、14共13 resolved、0 claimed、2 open（13／15），AC77已勾／14未勾，13仅逻辑就绪尚未领取。

03事故152方法／65错误／1跳过的实际数据库及影响仍unknown；旧35目录精确数据库UUID仍0，07／08各4个嵌套UUID仍unknown，未查询或清理这些资源。方法政策继承留13，实际App／微信、真实模型质量及业务升级留后续真实验收；S分叉库保留，不合main、不push／PR／部署。
