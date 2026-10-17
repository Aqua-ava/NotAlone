# 08：集成明确长期表达偏好及准备阶段删除

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 06
Source unit: U8 / S源票08
Migration mapping: S062→063 (canonical)

## 交付行为

用户明确保存、修改和删除长期表达要求，下次适用；一次性要求不持久化，偏好删除后固定上下文和隐藏联系人缓存都不能恢复它。

## 范围与兼容

- 复用S显式动作、范围、回执、上下文装配与删除闭包，追加canonical063；保留当前明确意图优先。
- 独立于07接入可用回复端口，随本票扩展格式/依赖；尚无实际回复请求的prepare阶段也要登记依赖。

## 依赖说明

06只因canonical062前缀阻塞本票，非偏好功能依赖本人概览。01格式合同经链传递；不必等07。

## 验收标准

- [x] canonical063保留062前缀，新增偏好/动作/使用依赖的全量、前向、重复、来源删除均在自有合成库验证。
- [x] 只有明确长期动作写入，可看/改/删；普通user_instruction、样本保存或一次性策略不静默成为偏好。
- [x] 下一次适用回复实际读取偏好，当前明确意图冲突时优先；公开回执显示实际使用，不把合成通过当语义质量资格。
- [x] prepare时登记偏好身份及完整来源，执行前删除清固定JSON；生成后使用记录、样本依赖及原来源删除同样闭合。
- [x] A→B→A、隐藏缓存、重试命令、晚返回、面板关闭及重启覆盖当期已有输入模式/偏好回执，保留无关编辑；精确Skill scene由11接入后再扩展，政策由13接续。
- [x] 公开HTTP/PG、React管理、偏好/样本/历史及准备生命周期相关回归和两轴审查完成。

## 验证入口

沿用expression preferences、偏好与概览组合、样本来源/删除及联系人内容恢复HTTP组；新增prepare无C请求时删除偏好。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

本轮仅发布，本票保持open。未来实施须明确启动并使用独立集成树；S分叉库保持原样。完成本票也不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-16：06签收后领取，在独立codex/integration-08工作树推进；与另一张就绪票并行，新增冻结结构在集成时顺序提升修订。仅本任务自有资源，不合入main，S分叉库保留。


## Answer

来源为固定 `b4429b5c→562f85e4` 的08增量；canonical `063_expression_preferences.sql` 保留源S062原字节，001–062未改。已接入明确长期操作、owner／当前联系人与输入模式范围、生成时实际偏好回执、原来源／样本／候选删除闭包。普通指令、选择、复制与主动样本保存不产生偏好。

M2增量包括两类偏好值对象的严格冻结与来源形状复验（codec version2；初版独立分树schema3，本轮同步07后组合结构为schema4）；prepare尚无reply_request时在owner锁与turn CAS内复验快照，并登记偏好UUID、origin UUID及全部source UUID。删除在同事务清除固定JSON与恢复输入，不依赖先GET。main隐藏联系人恢复带回当时实际偏好回执；偏好删除取消在途作业、清旧重试引用并权威复验全部缓存，保留独立草稿。

已完成的分轮验证（不能相加成唯一分母）：

- 明确保存公开HTTP首条红为目录404，接入后1/1绿。偏好HTTP首轮22中21通过、1准备编码失败；补齐新冻结结构后，偏好＋真实001–062→063升级25/25通过（其中24偏好、1升级）。手录／消息来源prepare=0 request时删除的两反例均先红，补事务依赖后两反例及现有prepare链3/3绿。
- 单元 `NOTALONE_DISABLE_DOTENV=1 NOTALONE_ENV_FILE=/dev/null PYTHONPATH=src:.. python -m unittest discover -s tests/unit -t . -q` 为1338/1338；TypeScript检查通过。偏好Node／有限HTTP组合22/22；额外隐藏A→B→A公开HTTP1/1，验证在B删全局偏好后A候选、回执和相关编辑消失，两边独立草稿保留。
- 首次相关后端组94中86通过、7失败、1错误。五项是已删除键由旧500调整为显式409，源测试断言已更新；两项是旧手工测试装配未包偏好上下文，已按生产装配适配；一项是053旧空依赖误解析尚不存在的偏好表，空依赖直接返回可用。有限恢复18中15通过，3个生命周期case因旧夹具生成69字库名被新63字门在CREATE之前拒绝；未执行这三次CREATE，不能记为业务通过。已缩短本任务迁移夹具前缀；后续守卫轮业务通过如下，原轮结果仍单列保留。

执行证据缺口单列：94相关组虽事前显式设置双测试URL、Core类也有before-create marker，但还会从受控实例嵌套创建session_delete类库及3个lifecycle方法库，本轮漏了这些嵌套UUID的持久事前登记。原UUID未从已有日志恢复，不能凭finally或无cleanup错误认证这些库退场；未连接候选库、扫描前缀或清理未知库。后续恢复组已登记的bootstrap与session_delete两库逐名absence=true，此证据不覆盖前轮缺口。主Agent曾要求暂停新增PG／HTTP／页面，随后只读核验并批准受控新轮。仅本轮进程的Connection.execute建库守卫遇未知类型／非完整受控CREATE或DROP（包括注释和多语句）先拒绝，planned 0600/fsync先于CREATE，成功才记created；显式host=/tmp且实际host／port／user绑定首次本地admin实例，current_database精确相等；DROP仅允许本轮确证创建的精确名字并核absence。该边界不覆盖未枚举的独立Cursor／Async／Connection.connect或未来新路径；已选模块的迁移子进程静态无CREATE，双URL精确一致。

仅合成数据和本任务资源；S分叉库、业务库、main及其他会话文件未修改。本票尚未实际App／微信、真实外部模型、语义质量资格或最终两轴审查；State与AC保持claimed／未勾，实际剩余验证继续在本票记录。

非数据库增量验证又捕获一个M-only恢复反例：DELETE未决时重新读取已保存讨论，会重新显示待删偏好回执；该公开Main／preload反例先红。新增按删除生命周期计数的读取／操作隔离，面板隐藏后再聚焦也保持隔离，结算后才权威恢复合法快照；纯受控传输Node组14/14通过（含修复反例），没有新增PG、HTTP监听、页面或模型运行。

守卫核阅后的新轮各自独立，不与旧轮相加：

- 无数据库模拟覆盖planned先于真实边界、未知DROP／超长库名／失败CREATE不获删除权、leading comment／注释／多语句／未知query拒绝、显式本地连接与实例漂移拒绝；`/tmp/notalone08-guard-simulation-strengthened.log`。夹具导入绑定另有无数据库模拟，检查0600计划、双URL与重复计划拒绝。
- `/tmp/notalone08-guard-smoke-command.sh` 小批4/4，2.726秒，PID78738，5库逐名absence=true，marker均drop_confirmed；索引 `<本机私有临时目录>/notalone08-guarded-gllhd5w1/database-absence.json`。
- `/tmp/notalone08-guard-regression-command.sh` 封闭8模块121/121，119.901秒，PID78877：原94＋偏好26＋真实升级1；8库逐名absence=true、marker均drop_confirmed，索引 `<本机私有临时目录>/notalone08-guarded-68wy56d3/database-absence.json`。新增两项验证重启后的原偏好回执／更新须显式重新prepare、样本删除直接擦除准备JSON；当前意图、历史、样本、session删除和生命周期相关组均绿。
- `/tmp/notalone08-node-final-command.sh` 偏好8文件23/23，16.024秒，使用真实Main／preload／React和有限本机HTTP。9个独立HTTP夹具在导入测试装配前先落盘本轮唯一身份并绑定双URL，Core仍执行独立before-create marker；各自严格001–063、repeat0、实际模块摘要匹配。每个最终JSON直接记录实际迁移名／重复值、模型调用数、childPID、before-import与Core身份、清理结果和child exit0；随后只检查记录PID均不存在。精确索引 `/tmp/notalone08-http-runtime-index.json`。这些受控合成模型结果不构成真实模型语义质量资格。
- `tests.unit.reply.test_prepared_context_codec` 4/4，直接调用get_type_hints(ReplyContext)证明偏好类型可在运行时解析；新增前面已有全unit1338/1338。本轮TS检查通过，普通页面dispatch已接入expression-preferences，随后有限页面结果如下。

完整私有proof索引 `/tmp/notalone08-proof-index.json` 已区分JSON直接记录、执行门条件和日志中的退出／清理断言；数据库旧94的4个未恢复UUID仍是未闭合证据缺口。未触碰未知资源，也没有把后续absence证据用于替旧轮补证。

在候选 `a1e819c316ef6a38f818437789dad38fc0d8fe10` 上，主Agent协调并再次确认两租约absent后，执行 `/tmp/notalone08-page-command.sh`：唯一 `expression-preferences` case、240秒上限、1个无头Chrome，case／scenario通过，受控模型2次、cleanupConfirmed=true。实际生产React保存／修改／scope切换、当前意图、后端真实重启后的目录恢复，以及偏好和原来源删除均通过。浏览器实际响应字节与当前执行产物摘要、实际Python模块摘要、63个迁移名与repeat0均保存到仓库外；最终精确库absence=true，13个本轮记录PID均已不存在，headless／App双租约复查均absent。页面索引 `/tmp/notalone08-page-runtime-index.json`，原始 `/tmp/notalone08-page.log`；该结果只覆盖普通页面＋隔离HTTP／PG，没有Electron、实际App／微信或真实外部模型验收。

页面完成并核销资源后同步过root `0f6f3635` 的嵌套归属证据文档；该固定页面候选仍为version2／schema_revision3。随后本轮同步07签收tip并将两种冻结结构组合为schema4，以下联合HTTP记录覆盖实际生产装配。独立Standards／Spec与merger签收由主Agent继续，当前State与AC保持不变。

独立审查修复（原候选54d77bdd）：Spec P2捕获偏好变更后首次无候选仍同键重试；Standards无硬项、possible P3为HTTP／页面九项模块摘要清单重复。新增真实Main／preload受控延迟反例先红（generation_failed），复用现有prepared_context恢复分类和显式按钮：当前偏好修订漂移也进入后端原身份／实际attempt终态／封键合同；普通重试不能重投旧JSON，明确核对后新key／新prepare，保留用户draft／已有候选编辑和当前目的／方向。running／unknown或终态GET故障保持独立作业身份，刷新与隐藏恢复不自动生成。runStrategy同类入口也用共享分类；其普通／隐藏反例分别先红后绿。继续讨论catch已对该非重试错误执行权威读取，沿同一requires_reprepare投影恢复。删除路径另证首次无候选的晚返回不能复活。

本增量纯组40/40（恢复各输入模式、Main／preload／React SSR、清单一致性及独立准备作业），TS通过；后端unit1338/1338。真实HTTP仅一个明确反例分两轮：首轮已到新revision2，但末断言错把完成后未重读的idle历史当完整快照，0!=2失败；补明确只读readSavedSession后第二轮1/1绿。两轮各一个事前导入身份／Core before-create登记库，最终JSON均exact63／repeat0、model_calls1、child exit0、DB absence，随后记录PID均不存在；索引 `/tmp/notalone08-review-http-index.json`。原失败日志保留 `/tmp/notalone08-review-http.log`，绿轮 `/tmp/notalone08-review-http-green.log`。一次混入HTTP bridge文件的纯组执行被Conda门在建库前拒绝（19绿1门拒绝），后续明确排除该文件的无资源组通过。未重跑121或页面，旧页面固定候选不挪用于此增量。

长度文案复算校准：实际旧前缀 `notalone_interruption_migration_`＋32hex＋`_test`为69字，当前 `notalone_interrupt_`＋32hex＋`_test`为56字。旧18轮三次超过63字在CREATE前被拒绝的日志与结论不改，也不补旧未知UUID。

同步07签收tip `38e975e6` 时按双方语义处理7处冲突，保留历史导航与完整受控依赖、Main独立作业、两套页面case和两类偏好对象；codec version2／schema_revision4严格要求完整导航、历史范围与偏好合同，旧schema3不静默补字段。迁移仍精确001–063，07独立页面夹具也更新为63／repeat0。合并后完整unit1353/1353、TypeScript通过，偏好与准备恢复纯组40/40、概览展示／调度纯组14/14；这些纯组没有HTTP／PG／页面。

联合真实HTTP固定5个方法共用1个事前登记库，每轮cap1、failfast=True；守卫unknown DDL／query／实例／ownership拒绝后poison latch禁止后续CREATE，仍仅允许已确证created精确DROP。无DB模拟先通过。首轮实际执行2方法（1过、1失败）：500条冻结通过，新增继续测试遗漏显式requirement_changes，既有澄清合同返回409；补确认字段，未放宽产品后，第二轮5/5通过（20.597秒）。分别证明生产prepare两种结构均非空且严格codec往返／继续／重启、schema3要求重新prepare且保留输入、偏好或其他联系人本人导航来源在无C请求时先SQL擦除固定JSON／恢复输入再拒绝late、合法旧联系人／本人导航与实际偏好回执及样本删除、full500窗口／三轨预算保持。两轮各1库marker drop_confirmed、精确absence=true及记录PID不存在；原失败和单轮分母保留，索引 `/tmp/notalone08-joined-http-index.json`。JSON仅直接记录实际迁移／模块摘要／DB／PID／模型调用和计数观察；通过与failfast分母以原unittest日志为准，退场另以精确absence查询和随后PID检查为证。原94四个未知UUID缺口、18轮三次CREATE前拒绝、旧页面固定ref均保持，不以本轮补旧证。

实际UI增量复验固定代码候选 `8271b29492950fbf650805c25856eb5db33f6236`：仅扩已有expression-preferences页面case／夹具，无产品钩子。类型检查及最小纯组14/14通过后，实读App／headless双租约均absent，沿已协调窗口执行 `/tmp/notalone08-page-review-command.sh`（单case、240秒上限、1Chrome、1库）。首次无候选prepare后实际模型等待有限门（60秒上限），从生产UI PATCH偏好为revision2，finally释放旧结果；旧快照被拒，页面显示明确“核对旧准备并重新生成”，独立草稿仍原样，当前只保留原失败键且模型入口仍1；点击该动作后才出现新键、revision2候选与实际偏好回执。既有当前意图、范围切换、真实服务重启、偏好和来源删除也完成，case／scenario绿、cleanupConfirmed=true。

该轮受控模型入口及返回各3次、硬限4，外部0；codec version2／schema_revision4，迁移exact63／repeat0。实际Python模块、执行产物和浏览器响应字节摘要已核对执行输入；JSON直接保存before-import／Core事前planned marker（同库／同PID）、请求键／终态／修订观察及模型计数，父进程另直接保存child exit0。随后精确自有库absence=true、16个记录PID均不存在，App／headless双租约复查absent。索引 `/tmp/notalone08-page-review-runtime-index.json`（0600），原日志 `/tmp/notalone08-page-review.log`；UI断言与case通过以日志为证，资源退场另由精确查询和进程／租约观察证明，不凭finally推断。此次页面仅1轮，无新增页面失败；此前联合HTTP首轮失败、review HTTP末断言失败、原94资源缺口及旧a1e页面固定引用均保留。起初一次typecheck误在仓库根调用npm返回ENOENT，未运行测试或建资源，后在desktop执行通过。没有App／微信或真实模型验收，不重跑121，State与AC保持claimed／未勾，待独立增量两轴签收。


最终签收（2026-10-16）：独立Spec与Standards完整、组合接缝及a1ac最后页面窄审均0未关闭，原P2显式重新准备及P3清单重复已关闭。独立merger在clean根36bef1b0无冲突no-ff合入a1ac，提交 `3e903976cf0808f888c34f6c54dbc6973fb1c34f`；合并树与该候选一致。最小diff检查发现偏好值对象EOF多余空行，原失败保留；实现者仅删两空行提交 `ec1e09512390f69c0b4889b5757632d560e42f1c`，merger独立核对精确换行差及带位置AST相同后合入 `df209de1e91de2572b6a5705c14d44d0cef90b3a`。最终产品／测试／架构与ec1e一致，除该EOF静态校准均与已审a1ac相同；旧页面252份模块SHA仍属于8271／a1ac运行身份，单一模块新字节未重跑，不改写旧proof。

本次只实际执行类型检查、工作树／暂存／M2差异检查、固定Git字节／文本合同及Conda AST静态核对；修复后通过，未启业务资源或增加动态分母。001–063连续、前62／M2前58精确字节、063固定源blob、十夹具迁移门／生命周期尾序、codec2/schema4及两种结构、三处Grounded、500冻结／三SQL范围／三轨预算均保留。分轮成绩、原失败、原94四UUID与03／35／07资源未知、最新页面3次／cap4及1库／16PID／双租约核销分列于[08集成记录](../frontier-08-validation.md)，新绿不补旧未知。六项AC据当前工程范围签收，09仍open；没有实际App／微信或真实模型资格，没有迁移S库、合入main或远端操作。
