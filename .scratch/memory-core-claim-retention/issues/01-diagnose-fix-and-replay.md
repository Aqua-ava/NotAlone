# 修复核心事实被扩写与阶段标签丢失

Triage: ready-for-agent
State: claimed
Type: task
Blocked by: none
> 阻塞说明（2026-10-06 订正）：原记录写「没有现成 ECNU 凭据」，与事实不符——`.env` 的 `NOTALONE_DEEPSEEK_BASE_URL` 已指向 ECNU 端点、模型 `ecnu-max`，2026-10-04 起多轮匿名对照都在该端点上完成（含本票 16 次重复测量）。当前真正的阻塞不是凭据，而是**目标本身**：模型对照已按预注册计划跑完并判定「无可观测的对照信号」，真实聊天严格覆盖仍 6/12、可选 2/6，整体目标未达成；继续推进需要新的预注册对照设计或改变目标范围，属用户决定事项。
>
> 处置（2026-10-06，用户决定）：**保持 `claimed`，不结票、不标 `wontfix`**。提示侧改动与全部证据保留，所有旧预算继续关闭、不自动重开；日后若要再投入，恢复条件是「一次新的预注册对照（更多材料窗口与重复、两臂随机顺序、以不确定率为主指标）」或「改变目标范围」，届时另批预算与范围。

按 [spec](../spec.md) 逐条归因未正确保留的必需主张，建立真实红反馈，在现有公开接缝完成有效修复、同批复测与本地提交。

## 验收

- [x] 区分报价的核心引用与额外扩写、历史主体／转述标签、当前未知和整项未生成；正确拒绝错误标签不称误拒。（本轮范围只覆盖“转述标记完整保留却被误判 uncertain”这一类；其他类别仍按各自既有结论记录。）
- [x] 首次红、修改前后完整输出与 Gold 可追溯，不覆盖失败或按输出改答案。（提示改动保留红绿顺序与命令，见[结果文档](../../../docs/memory-verification-report-support-leaf-20261004.md)。）
- [ ] 分 raw、接受及完整契约覆盖，独立统计正例损失和坏 auto；方案不使错误 auto 增加。
- [x] 旧认可资料、业务记忆与水位不写，私聊与凭据不进入 Git。
- [x] 相关检查、隔离全量、两轴评审、本地中文提交完成；无远端 Git。（单一改动集 `ddfa1f7`，两轴只读审查已记录。）

## Answer

**已完成（本地，0 次联网、0 预算）**：把语义稳定性提示叶并入产品来源核验提示 `SOURCE_VERIFICATION_SYSTEM_PROMPT`（新增 6 行，提示文件 SHA256 `d93ca1d6…`），产品在三种核验 verdict 下的后处理与转述候选的 `pending` 语义未变；新增 [提示契约与 fail-closed 测试](../../../backend/tests/unit/memory_extraction/test_verification_prompt_contract.py)（改动前 2 红 3 绿、改动后 5 项全过），记忆提取子集 175 项与全量 720 项通过，两轴只读审查完成。范围为用户批准的“只改核验提示一小段、不加 `described_party`、本地 0 联网”；证据与限制见[结果文档](../../../docs/memory-verification-report-support-leaf-20261004.md)。

**未完成**：产品提示未经真实模型对照，4/4 试点数字来自带 `described_party` 的变体提示，不能算作产品提示成绩；规格要求的“原始必需主张完整保留”这一整体目标尚未达成，spec 级验收（raw、接受与完整契约覆盖，正例损失与坏 auto 独立统计）保持未勾选。本任务整体仍为 `claimed`，下一步需要用户决定是否为真实模型匿名对照批新预算；未读真实聊天与留出、未写业务记忆与水位、未改默认采纳、无远端 Git。

## Comments

### 2026-10-16 剩余公开8窗有界退场

[独立本场结果](../../grounded-evaluation/remaining-public8-result-20261016.md)：closed4／16、三200与一个V远端未知、零重试，余12永久关闭。B01 raw/full封存且safe／supported、单窗必需raw3／接受3／完整3；因无完整batch result，外层仍保守将B01及B02列unknown，此单窗证据不覆盖原收据。B02无正式审核，其余六窗unrun；本场13必需、核心5必需分母保留，不签核心整体、原21完整、≥15用例门或逐类放行。proof仍null／UNKNOWN、默认空表不变。当前持续授权已足够推进离线修复与必要有界官方合成验证，Triage改ready-for-agent，历史等待新预算说明仅作历史；State／AC及旧失败保持，真实聊天、业务与ECNU均未处理。

### 2026-10-15 官方DeepSeek公开部分基线已关闭

按用户指定仅用官方DeepSeek，在原公开合成21窗中完成13窗、8窗未运行，实际25次请求、零重试，A13整组去向合同触发现有安全类停止，17次未用额度永久关闭。已完成子集必需raw15/15、程序接受15/15、完整契约9/15；A13的bad_auto来自混合auto/pending组规则，不改写为内容假事或错人，也不重开预算。核心B01/B02均未运行，不能用已完成子集的raw15/15补签核心保留率或旧留出。 分层字段、各窗缺口、停止原件及局限见[本轮结果](../../grounded-evaluation/deepseek-public21-result-20261015.md)。State及原AC保持，本轮不上传真实聊天、不写业务、不自动采纳。

2026-10-04：v3增量终审及独立参考已冻结：Standards新增硬规范／阻断0、原可选气味1保留，SHA fa47c316…；Spec当前缺失／scope creep／错误阻断0，SHA 0af14710…，明确保留首类别/话题核对不足及D7误标。原3方法／12人工给定正控制、3文件类型／AST通过，目标语义改善仍未实测；首反例、首草案、首审不覆盖。最终文档只补收据SHA和完成元数据，最小核对后仅本任务本地提交。48次尚未批准、旧预算闭账、0新模型/业务/默认/远端Git；ready-for-human／claimed，整体未完成。

2026-10-04：上述首审后补核类别/话题与本人共同完成的语用，发现新合成v2准备缺口，初正确判断不得扩大成完整类别语义正确。首输入、参考和两轴收据不改；v3仅修category/topic及D7 assertion/asserted/auto，原话／人物／scope IDs／subject／日期／风险保持，去向6auto／6pending。原3个契约控制换v3路径后重跑通过，3文件类型／AST通过，不算额外模型/测试样本。独立Spec及Standards已核此增量，最终收据待当前cached文档核对后独占保存；全程0新模型、业务、默认或旧预算改动。实际与E漏提目标仍未完成，48次仍待具体联网范围决定。

2026-10-04：本轮本机准备与四文档两轴终审完成。Standards硬规范／阻断0、可选重复测试helper气味1，SHA a7397c80…；Spec当前缺失／scope creep／实现错误0，SHA 79198570…，独立冻结D1—D12逐条判断支持v2（5auto／7pending）。初scope漏列自造D材料，首记录保留后补充范围说明fdf5fded…，没有授予新外部调用或真实资料。原症状仍2红，所有本机绿检查只说明接缝兼容；新48预算未批准，整体未完成、ready-for-human／claimed不变。收据／链接／统计和最终元数据增量核对后按工程规则保存仅本任务四文档的本地中文提交，不做远端Git。

2026-10-04：用户“好的，把这个设为目标继续弄”启动持续目标并继续本机准备。[本机记录](../../../docs/memory-party-participants-local-preparation-20261004.md)确认两C4原始返回已错、完整输入未遗漏、程序不改错正确分类；三个假设预记录，模型偏重主要人物的因果尚未实测。原／候选提示重放旧响应各2症状断言红、20个已知给定机会保留，3本机契约控制／3文件类型与AST通过；首9类型声明错误及首反馈保留，0新API、SDK真实构造或业务／默认改动。私有提示单叶准备和12条合成开发样本完成，不改schema／guard或旧参考；旧24及所有余额仍关闭，actual／private held未读，E漏提和实际6/12／2/6未改善。新的[4／20／24最多48次匿名对照](../../../docs/memory-party-participants-prompt-pilot-proposal-20261004.md)只准备，按workflow“实际实现需要超出当前spec或ticket”待该新预算具体决定；日常核验由Agent负责。State仍claimed、Blocked by none，Triage ready-for-human仅待新联网范围，当前文档验证／两轴审阅／本地提交继续完成，不标整体完成。

2026-10-04：[24次人物匿名对照结果](../../../docs/memory-party-guard-pilot-result-20261004.md)已关闭：阶段1完整通过才开阶段2，24V全部返回／台账／预约对应，E／R、运行／结构失败及未运行0。原／新坏auto6／0，正14/14完整保护，人物18/20；C4两轮把共同参与mixed误判contact，阶段2及整体门失败，不因安全pending或充分quote改Gold。raw先独审冻结再揭compiled／Flow，Fact与代码推导decision风险分层，原14／未知日期保持。worker11＋root6控制、类型与AST、SDK仅绑定、228SHA／7版本及两轴预检通过；运行／落盘失败统计修正和全部首失败保留。原J未补提，实际6/12及可选2/6保持，0actual／held／业务／默认／产品源码变更。24预算余额0、导入前真实闭账拒绝；State claimed、Triage ready-for-agent仅继续本机归因／具体方案，不开放新模型试验。当前三文档最小核验及两轴终审通过；真实mypy选项与C4误判方向文案已修，最终硬问题／阻塞0、可选气味1，终审SHA b3c88e0a…／7cb708b7…保留。按工程规则保存任务专属本地提交，无远端Git；整体spec未完成。

2026-10-04：用户明确“同意24次匿名对照”，批准d460b16的[具体提案](../../../docs/memory-party-guard-pilot-proposal-20261004.md)，原提案SHA95bfb4f0…保留。新独立目录／24上限仅匿名V，8先运行并由Agent原话全审，全部过门才准后16；原14／scope／sender／target／日期不改、E／R0。先相关TDD／类型／真实SDK合成凭据只绑定、独立参考／两轴预检与完整冻结，再唯一运行；raw先审后编译／Flow，失败和未运行分母不删，判败余额关闭，无公开invoke重试或调参。Triage回ready-for-agent、State claimed、Blocked by none；只现ECNU、不用官方key，不读actual／private held、不写业务或默认，不把C2给定候选核验称E补漏。旧预算仍关闭，整体有效修复及实际6/12／可选2/6保持未完成。

2026-10-04：当前四文档与限定私有实现／证据两轴终审完成。Standards硬规范0、非阻塞原四键测试转换重复气味1；Spec当前缺失／scope creep／实现错误均0，整体有效修复／实际同批／最终留出仍未完成。收据SHA67ec2ca8…／300cd863…分别保留，无审查模型调用或测试复跑。任务链接／引用SHA／状态及暂存diff最小核验后保存仅本任务四文档的中文本地提交；不提交私有材料、不捎并行macOS或reply工作、不做远端Git。新24次仍待用户具体决定、旧预算关闭、State claimed，实际6/12及可选2/6保持。

2026-10-04：本机准备完成，见[记录](../../../docs/memory-party-guard-local-preparation-20261004.md)。原安全断言仍red／热茶green；9worker＋4root不同人工契约控制、worker3文件mypy／AST及root首4文件mypy／AST通过，格式后root1文件mypy／4AST和4控制通过，首失败均保留。完整原V11键／system前缀保持，六键补充覆盖旧输出限制；唯一third_party assertion/asserted降级、错contact＋对象quote及mixed／unclear仍auto的反例保留。C1—C4独立参考通过，C4无来源完成体先保留再修正，未知日期不造。root114不同字节指纹／196私有权限核对通过，worker明确16依赖并非全部import闭包，scripted次数不是模型样本；早期mypy可能更新忽略缓存，最终禁缓存。0新API／SDK／真实凭据／actual-private held／业务／默认／产品源码／远端Git；知识E漏项及实际6/12／可选2/6不变。新的[24次匿名V-only提案](../../../docs/memory-party-guard-pilot-proposal-20261004.md)具体范围待决定，Triage转ready-for-human、State claimed、Blocked by none；所有旧预算关闭，继续两轴终审和任务专属本地提交，不把整体目标标完成。

2026-10-04：用户“继续下一步吧”只续行本机归因与具体准备。独立捕获反馈重复red，root另重放原两错auto及热茶正控制，0新模型调用；按单轴缩到单候选／单source只证明程序传播，不推断缩小LLM输入仍错。已读实际请求没有E三标签动态泄露或允许第三人错标的显式提示矛盾，模型人物判断为待测假设。完整原产品V追加临时人物／片段与窄guard的私有原型走同verify／原4键／Flow接缝；失败source未采用，新方案非相对它的单因比较。历史知识说明与R补漏不能重包，E知识状态未修复。新的[24次匿名V-only提案](../../../docs/memory-party-guard-pilot-proposal-20261004.md)仅准备，尚无协议／预算调用许可，所有旧余额关闭；任务ready-for-agent／claimed继续本机TDD、参考核对、相关验证、两轴收尾和本地提交，实际6/12及可选2/6不变。

2026-10-02：用户在明确下一步归因、修复和同批复测后回复“好的继续”，scope 与已有公开测试接缝已认可。root 发布一张无依赖完整纵切任务；无需重新拆分或询问普通实现权限。

2026-10-02：root 认领。独立归因、代码边界与新合成冻结分别只读核对；不先改生产提示。

2026-10-02：12项实测试探均未达发布条件，任务仍未完成。最新subject说明澄清在开发组严格覆盖14/18（原11/18），实际组4/12（原6/12）并新增1条标签错误auto，不能发布。逐target分组仅做25项匿名边界检查，不计为实测语义修复；留出未揭盲，业务记忆／水位未写。

2026-10-02：下一步提案位于 `docs/memory-candidate-revision-proposal-20261002.md`。拟在原核验前增加一次有界候选修订，超出当前spec的不增模型阶段范围；已请求用户决定有限试验，Triage改为ready-for-human，State保持claimed。当前报告／公开回归的验证、两轴审閱和本地提交继续完成；未批准前不实施或调用新阶段。

2026-10-02：用户回复“同意有限修订试验（推荐）”。按提案推进接口设计、私有原型与分阶段有限实验，Triage回到ready-for-agent，任务继续claimed。仅此新范围被批准；不把许可当作发布或全历史重提授权，不再询问此范围内普通文件／测试操作。

2026-10-02：当前六文件检查点两轴只读审阅完成：Standards确定违反0、可选重复查找气味1；Spec当前差异缺陷0，但整体有效修复／留出／发布仍未完成。170相关测试、两文件mypy及隔离全量1145通过（skip3）的验证对应公开回归。按工程规则保存任务专属本地提交，不将检查点或新阶段许可称为目标完成。

2026-10-03：候选修订私有原型v1冻结，root独立运行30项离线契约测试通过。首次红与冻结源码保留在仓库外；原生产E／V、业务记忆、水位和留出保持原状，实际模型调用仍为0。输入严格度、逐来源引用、字面重复新增拒绝及语义来源限制在联网前写明。编排器与独立契约审阅完成后才启动匿名兼容阶段，不把离线通过称为准确率收益。

2026-10-03：root独立16项编排测试、dry及独审25项契约检查通过后启动匿名首阶段。1R／0V：新增正文准确但漏必填evidence，revision_contract整体拒绝；schema、本地转换与绑定未丢要求，HTTP未观察。真实原样返回0API重放复现错误，首失败保持。按有限规则停止，固定／开发／自然实际／留出未运行，业务／水位写入0，正式路径未改。下一种职责划分仅形成 `docs/memory-candidate-revision-contract-proposal-20261003.md` 待决定方案；未把失败当完成或继续调参授权。

2026-10-03：五文档检查点两轴审阅完成。Standards发现任务仍ready-for-agent与下一步需决定不符，已改ready-for-human、State保持claimed；其余确定问题与气味0。Spec当前差异缺陷0，整体有效修复未完成。第二版只是具体提案，累计预算127未授权，不进入调用；文档状态及暂存差异检查通过后保存本地提交。

2026-10-03：目标续行时确认首轮实验进程已结束、reservations仍1、冻结来源／Gold／生产E／V未变；另存独审关闭记录，下一阶段approved=false。只读补核唯一额外字段拒项，原捕获E／V零网络重放与原话／Gold证明它完整正确且原pending正确，属于可选正例输入兼容损失1，不计必需漏提或V误拒，最终R损失未测。未修改已冻结原型，未执行第二版；其所需决定仍待用户答复，目标未完成。

2026-10-03：用户询问受阻位置、获知第二版改变引用职责及总预算126→127后明确回复“同意”。第二版私有实现和有限实验授权已收到，Triage回ready-for-agent，State保持claimed；原目标继续，不以这次决定当作准确率改善或生产发布许可。按原核验接缝、共用累计台账推进，不重写第一版首失败或Gold，不再询问这一范围内普通步骤。

2026-10-03：第二版R输出契约冻结，root独立36项模块＋18项编排离线测试通过，独审另有8项断言通过。匿名1R＋1原V成功，累计匿名3次含首失败；原候选严格正确，新增否定习惯字词待定，严格正确1／待定1、确定坏auto0／措辞待定auto1。兼容通过只准进入固定比较，未证明收益或发布。原固定夹具只用新副本补phase元数据，6窗12seed17raw逐值不变；0API dry通过，输入可选正例损失1仍照计。正在原24次上限内执行固定R／V，不读取留出或写业务记忆／水位。

2026-10-03：第二版固定阶段未达门并停止。10个实例R／V成功、1R失败、1未运行，21invoke／Ledger，累计24／127。必需严格6/12不变，可选2/6→1/6，完整正确9→8，原正确可选候选最终损失1；确定与歧义坏auto均0，但7条确定错误仍pending。首R失败为context-only来源无target，14字段与本地转换要求均完整，原样0API重放4项及root复跑通过。独审先冻17final＋2失败raw再揭V，原17seed分母及Gold不改。不进入开发、完整自然实际、留出或生产，旧认可／业务／水位不写。剩余有效修复尚未完成；下一条路线需明确新服务／模型与范围，Triage改ready-for-human，State仍claimed，当前文档验证、两轴审阅及任务专属本地提交继续。

2026-10-03：以ff1c5ff为起点的四文档检查点并行两轴审阅完成：Standards确定违反0／气味0，Spec当前差异缺陷0／超范围0。root本轮54项离线前置检查与原返回4项重放通过，diff／任务状态检查通过；没有重复执行旧1145项全量或将旧结果称新生产验证。只保存任务四文档本地提交，私有原话、失败／Gold和业务资料不入Git。整体任务未完成，State保持claimed；下一路线所需决策不影响当前文档收尾。

2026-10-03：目标续行后核实HEAD为c43246b、工作区干净、第二版关闭门仍false。只读配置与代码确认没有另一个现成provider；公开官方资料核到deepseek-v4-pro，但思考＋强制具名工具不兼容，不能把URL／模型覆盖称为可用。形成 `docs/memory-official-model-synthetic-pilot-proposal-20261003.md`：拟用Pro＋禁用思考、保留原E／V和门，只先比较2＋16次合成／匿名开发资料；新服务、配置、凭据条件及范围决定未满足，0新模型调用。实际同批、留出、有效修复和生产验证仍完整保留为后续要求，不把前置对照当成最终验收。研究文件被忽略且未强制入Git，原话／Gold／首失败不动；Triage继续ready-for-human、State claimed。

2026-10-03：用户明确询问“为什么用官方的？不用吧”，决定不使用官方服务。取消新服务提案及待确认18次对照，不再等待官方试验批准；始终0官方模型调用，继续限定当前ECNU。旧R试验仍关闭，不能借取消新服务恢复其余量或循环调提示。原有效修复／同批／留出完整目标继续；Agent先只读核对现有公开E／V接缝内还有没有具备直接错误机制依据的候选，不为凑实验提出新路线。此时可继续归因，Triage回ready-for-agent，State仍claimed；尚未决定或启动下一轮模型实测，不表示新R轮次被批准。

2026-10-03：新增窄归因确认旧plus同时更换E／V，未测试原max候选＋plus V。原17raw已有完整逐索引独审，9完整正确；6明确语义／标签错与2语义歧义分轴保留，后2的来源覆盖缺陷不能抹去。Spec范围核对依据原第39／46／53行与ADR-027模型配置授权，确认现有接口内的独立固定V比较可连续推进，不以取消官方或旧R余量作为许可。形成 `docs/memory-fixed-verifier-crossover-plan-20261003.md`：原12捕获×两臂最多24invoke，仅model_name不同；先0API准备和原返回重放，再冻结新预算和runner。尚无新API、有效修复或生产变更；旧R、来源／Gold和留出保持。

2026-10-03：固定V准备通过：root独立17项匿名测试、原12次V公开输入／完整Flow去向等值重放（17raw→15接受／2拒绝，额外字段保留）及0API双模型构造检查。独审发现预算可换目录重置、隐藏reasoning值在新token白名单被访问两项阻断，均在联网前修复并复审通过；冻结原17逐索引判断与比较规则。首次真实启动在私有cwd找不到项目.env，factory检查停止，session64418已exit1；预约／调用／台账／响应／进度均0，原失败与预算不删。显式原项目.env的0API配置核验通过。按Spec普通环境修复判定，形成 `docs/memory-fixed-verifier-bootstrap-resume-20261003.md`，只准备同一原24预算的一次零调用初始化续行；不重启旧入口、不改冻结模型变量、不再续行，不把初始化失败称为语义结果。完整目标仍未完成，业务／水位／留出不动。

2026-10-03：root独立10项匿名续行测试、原循环AST与唯一预算／默认拒绝核对及两轴前置审阅通过后，显式定位原项目.env仅续行一次。session80674终态exit0，原24预算全部使用，24预约／invoke／台账／位置结果，失败2（max非法返回、plus超时各1）；E／R调用0。23响应报告deepseek-v4-flash12、qwen3.8-flash11，不将报告名当权重证明。已报告tokens88,259，超时用量未知；续行执行446.105秒，SDK内部HTTP次数未观察。原首失败、启动和冻结材料均保留，生产源码／配置不变；业务／水位／官方调用0。

2026-10-03：固定V全量独审及root聚合复核完成，34候选位置／55公开quote、49已过结构引用均核对，Gold／17标签／规则不变。原／本次max／本次plus完整正确保留9／9／7，已知契约坏保留6／5／3，有效返回错误supported3／5／1，坏auto0／1／1；必需严格均6/12，可选2/6／2/6／1/6。plus正例损失2＝超时损失1＋正确第三人转述subject误拒1；两臂建议被误记为本人事实的坏auto仅为评测去向。max窗内真实但未声明来源quote正确触发批失败，失败少输出不计语义收益。关闭门approved=false，不运行开发／自然实际／留出／生产，不循环调此配置或重启预算。结果记录于 `docs/memory-fixed-verifier-crossover-result-20261003.md`；只读源码证明unsupported硬拒、uncertain只降级pending，不通过删除所有uncertain代替修复。完整目标未完成，任务继续ready-for-agent／claimed，当前只收尾这条实验路线的文档核验、两轴审阅与本地提交。

2026-10-03：以ee97801为起点的本轮四文档并行两轴审阅完成：Standards确定违反0／气味0，Spec阻断0／错误记录0／超范围0，整体有效修复仍未完成。root核验13项私有产物SHA、2项Git历史预运行文档SHA、7行语义指标、相对链接及只含本任务四文档的暂存范围，差异检查通过；本轮收尾0新API／DB，未重复旧全量或称文档验证为生产测试。27项匿名前置测试和24次实际对照分别记录，仅保存任务四文档本地中文提交，私密产物不入Git、不执行远端Git；任务继续claimed。

2026-10-03：只读核对确认原spec目标分组wire条款尚未做真实模型试验，旧25匿名边界检查不等于实际收益。保持当前ECNU／原E语义提示与14字段／原V及采纳，准备独立一次分组输出组织变量；不恢复R或固定V旧预算。新阶段2／32／48／32最多114invoke，逐门推进且失败关闭。独立冻结匿名Gold、原语义正例保护与规则，完整分母／错误轴／fresh正例不能按新输出调整；留出不提前解码。root25项新编排匿名测试、独立旧25＋2及三种SDK绑定通过，0真实API／凭据／DB；合成各窗scope保留原UUID，实际仍同一已确认联系人。方案与证据见 `docs/memory-target-group-wire-plan-20261003.md`，正在完成预运行两轴审阅和正式计划冻结，目标未完成、任务继续ready-for-agent／claimed。

2026-10-03：分组唯一计划已冻结，SHA21bee8e62247dd0ddd1b17c59ec573e743985c36e420b1b4bc3f94d32f26c803，原型／编排／公开计划均绑定。root匿名dry通过，两轴预审0阻断后启动唯一匿名session52100，终态exit0；1位置、2E/V invoke与2台账、失败0，阶段执行7.743秒。独立另跑26项编排检查通过（25＋JSON解码sentinel），真实服务结构通过不证明语义收益。正在按raw先审后V做独审及运行闭环，开发仍默认拒绝；冻结计划文档对应联网前状态，不修改它来重启实验。生产、业务记忆、水位和官方调用仍0变更。

2026-10-03：分组匿名全审判败。2正文／主体／语用／日期均准确，2quote字面真实但完整意义支撑1/2；漏已完成谓词必要问句的来源候选仍supported→auto，1项确定来源缺陷足够关闭。另一条habit的preference原提示允许，冻Gold类别集合过严及前置漏审单列，不能称为模型分类语义错；冻结严格0/2、现提示分类敏感性1/2都失败。旧Gold／首返回不改，业务auto仅模拟去向。28项运行核验通过，root全SHA复核与失败门重算完成；关闭gate false，开发dry先于凭据／API被拒，后三阶段未启动，预算2/114不补跑。结果见 `docs/memory-target-group-wire-result-20261003.md`；整体有效修复未完成，继续当前任务的闭环验证／两轴审阅／本地提交。

2026-10-03：以09c96e5为固定点的结果／任务两文件终审完成：Standards确定违反0／气味0，Spec阻断0／错误记录0／扩大范围0。root核验报告7项产物SHA、相对链接、claimed状态、2预约不增与后三stage未启动，diff检查通过；验证helper首次分类note文件名笔误0调用失败已保留，改用既有文件后通过，未改产物。只保存本任务两文件本地中文提交，不执行远端Git；原目标未完成，任务仍ready-for-agent／claimed，下一配置需要重新明确有限方案与既有授权边界，不沿本次关闭配置补跑。

2026-10-03：独立原17候选／12首结果对齐确认严格仍6/12；六损失为4扩写污染、1第三人部分标签错误及知识分量缺、1整参考未生成，核心来源ID漏引／完整合法误拒主因均0。新匿名Q来源缺口与它们无直接对应，暂不据此启动source说明主修复。原公开E→Flow→V的5项canned诊断通过只证明容量／局限；root核验4新产物SHA／权限及7原代码／返回SHA、统计分母，0新API／DB／凭据／held、生产及业务无改。来源和Gold不变，已失败配置／预算仍关闭，整体任务未完成。

2026-10-03：精确provenance核对前四项源码和32份公开E输入，#4 text与#2不同，先前只与#3 speech_act组合实测，历史E首超时无raw；不能将组合失败推作原speech_act下这处text的独立结果。两位协作者依据spec单字段说明试探条款核对，可准备一次精确#4正文单叶剥离，原字符串／flat E／原V／所有门和当前ECNU不变，不加actor／quote／R，另建唯一2／32／48／32最多114预算而不借旧余量。方案见 `docs/memory-knowledge-text-isolation-plan-20261003.md`；只形成私有原型及来源，不称收益或生产修复。匿名独审调用前指出每日金额性质歧义，root保留v1另存v2明确项目报酬，Gold／规则同样分版本保存；此时仍0真实模型调用，编排、root验证和两轴预审未完成，不启动网络。任务保持ready-for-agent／claimed，整体实际和最终留出验收仍保留。

2026-10-03：新单叶编排28项匿名接缝检查通过，root独立复跑28通过（1.357秒），不重复计为56用例；原E／单叶E／原V实际SDK具名工具绑定3项通过，仅合成key、0invoke。完整源码AST、运行schema唯一叶、全部依赖／scope／Gold／规则字节SHA、私有权限、报告链接和claimed状态均核验。完整四阶段规则SHA c07b8abcea7f8e748b576fc3374e13362b9556001a2199befece9833e749088e；Standards预审确定违反0／气味0、Spec阻断0／范围扩大0，审阅角色各自披露，不称私有runner作者自审或人类Gold。正式计划与预审draft等值冻结SHA531b7e1ce6d6a3a8832c311d78da654f98fe2998c55fe3000c634cbbf3a7d839，root匿名dry通过，在凭据前停止，真实budget/start此时仍无。预运行计划文档保持其形成时的准备状态，不在实测后改动冻结文档；只在后续结果记录推进或失败。整体修复未完成，业务／水位／官方服务调用0，新真实匿名阶段尚未启动。

2026-10-03：唯一新匿名run终态exit0，2E/V invoke／台账、1完整位置、失败及空0；四项必需主张raw和接受后完整契约均4/4，主体／语用／日期／来源完整正确，额外主张／坏auto／正例损失0。独审先冻结raw再揭V，Gold作者参与并披露非盲角色；runner作者只核运行闭环47/47，root另复算完整门和SHA。首次运行审计两个元数据假设错误保留后0API修正断言，冻结资料不改。服务报告7,543tokens，账单／HTTP次数未知；官方／DB／生产变更0。root匿名通过门SHA5151b92cb2e838be233dea31f6bfe0c090db63b9a25958bf1827199952d5095e，开发dry在凭据前通过后启动唯一session43519，固定16位置／32invoke上限，正在运行。结果见 `docs/memory-knowledge-text-isolation-result-20261003.md`，原实际历史6/12及全部最终验收要求保持，任务继续ready-for-agent／claimed。

2026-10-03：development session43519终态exit0，固定16位置、32invoke／台账、失败／空0。16raw先审冻结（SHAe642269721b4c6834e1318560fbea3095f5c3095a78ca1c2940099d8c300ee77）再揭V，全部29候选均supported并保留；原／候选严格8/18／10/18、旧正确语义保护9/12／8/12，候选确定3及歧义2坏auto、正例误拒0。类别约定和mixed-expiry边界敏感分析单列，不重标Gold；候选低于旧最低11/18，且保护／零坏auto门失败，符合old＋fresh同错复现的错误未减少。全审SHA391a798435803bf93362c57772ddbfce77f049a819d78de61c96213131866a37；运行324/324通过，首350/366为审计把额外role纳入原窗口比较，保留后仅修投影核对0API。root复算关闭门SHA7e20839e3684073e53a28d689d86642d500bd31d0fd65a4e4bc98296071ff624；actual入口dry在凭据前被拒，累计34/114，余量80不授权后阶段或调参。开发报告113,364tokens、加匿名120,907，金额／HTTP未知；本轮actual和held仅核既有字节指纹，未解码后续stage窗口或调用，生产／DB／业务／水位／官方调用0。当前只做本轮关闭文档检查、两轴审阅与任务专属本地提交，整体有效修复未完成，仍ready-for-agent／claimed。

2026-10-03：以b11b20f为固定点的本轮三文档两轴终审通过：Standards确定违反0／气味0，Spec阻断0／统计错误0／范围越界0；14字段措辞与最终命令说明已补核。root八项报告SHA／相对链接／状态／权限／关闭门／预算及后阶段检查通过；原修前SHA凭证与评审探针失败保留，修后另核。只保存本任务本地中文提交，关闭收尾0新API／DB，不将文档或匿名测试通过当成原实际有效修复，不做远端Git；任务仍ready-for-agent／claimed。

2026-10-03：续行核实HEAD4359a3e、工作区干净、原实际严格6/12和单叶关闭门不变，上一goal turn为有限对照／归因／提交的具体进展，整体仍未完成。两位只读explorer核对现公开Seam可表达正确结果但不能补漏或修正文，未找到直接对应旧六损失且可立即启动的现spec新配置；不把来源／日期副缺口替代核心目标，不把未测组合都称已失败。旧叙事8开发窗×2 B共16运行位置，0个保存首阶段正文／来源包，无法开展逐主张因果配对，污染及修复方向未知，不重跑旧试验。形成 `docs/memory-frozen-claim-annotation-proposal-20261003.md`：复用原叙事首结果，标注阶段只返回索引＋原12元字段，代码保持正文／来源；拟三臂共享首次叙事并逐门3／56／84／56总199对照，仍现ECNU。此新Interface／职责未获批准、未实施，0新模型调用；需按workflow及spec边界用户决定，Triage改ready-for-human、State仍claimed。只读缺证审计、具体提案的文档验证／两轴审阅／本地提交继续，原Gold、已关闭试验及全部实际／留出验收要求不改。

2026-10-03：提案经文档最小核对21/21、Standards34/34与Spec最终tip审阅后保存为64b4f8c；用户现明确回复“同意”。本提案范围回写spec，Triage回到ready-for-agent、State保持claimed。仓库外新实验目录为 `~/.notalone/audits/memory-frozen-claim-annotation-experiment-20261003/`，human-approval-v1绑定原提案SHA da3cb3aa9fcc53b0a16137d9b2bb342e66e0211ec5655ae276b817c793f72db8、scope与新199预算。原批准版本由64b4f8c保留；目录和文件0700／0600。开始沿已认可extract／Flow接缝以合成red→green实现冻结首包和标注Adapter，再冻结编排与独立审计。本轮尚无模型调用，不写业务或水位，原失败门／已关闭预算不重开，接口许可不当准确性收益。

2026-10-03：用户批准的正文冻结标注私有实现已红→绿，root独立Adapter17、runner20运行（19独立方法／1继承重复）及分析helper3全通过，六文件函数体类型检查通过。预检的审批和最终冻结缺口、离线来源隔离均已修；初红与初类型6错误保持。两轴预审后原计划SHA62da8243…冻结，匿名3调用4/4通过；开发24臂／8共享N、55调用／台账／预约，1可改写E空对象协议失败不补跑，完整分母保持。raw先冻结再V，全44Fact／16N审后原／可改写／冻结严格8／4／8（各18）、旧保护8／5／7（各12）；冻结坏auto确定4／歧义1，44supported和46逐字quote不当准确性证明。开发gate全部false、实际dry在凭据／factory前被拒，累计58/199，余141不授权重启、调参或后阶段；实际／留出0、旧6/12保持，业务／水位／默认路径／官方直连0。结果见docs/memory-frozen-claim-annotation-result-20261003.md，当前继续文档验证／两轴收尾／任务专属提交，整体未完成，ready-for-agent／claimed不变。只读一手调研及scope核对后，先在原完整Fact text说明单叶范围做0API表达可行性与旧试验差异核对；没有renderer或utterance存储、新预算／新模型调用许可，不复刻完整复制训练方法的名义来开试验。

2026-10-03：上轮关闭报告经root21项文档／证据核对与Standards／Spec收尾后保存为49c4411；只修正起始0调用的时态，整体仍未完成。新增0API差异审查确认“优先原词”大部分重复已测规则；其窄偏好未单测，但没有足够新机制据此再开模型轮次。原14Fact能表达完整语义，人工预期例不是可靠生成或准确率。

2026-10-03：形成待决[来源复制计划提案](../../../docs/memory-source-copy-plan-proposal-20261003.md)。拟单E返回原12元字段及copy_plan，程序从同窗片段、有界角色前缀与明确来源时间附注装配原14Fact，原V／Flow／采纳不变。此限制不同于锁定自由生成的N，但借字拼词、人物／关系／期间错误仍可能；不称论文完整复现或已禁止全部扩写。当前只有人工设计审查，未实现Adapter／renderer、无新预算或模型调用，actual／held不解码。新内部Tool及正文职责超出已批准spec，拟2／32／48／32总114一次有限对照，不借旧余额；原Gold和全部正例／坏auto门保持，P0需另完成全开发必需与旧保护／匿名语义，当前10种人工例不冒充全门。Triage改ready-for-human、State仍claimed，待该具体Interface与有限试验决定；普通文档核对、两轴审阅与本地提交继续完成，未批准前不实施或联网。

2026-10-03：用户再次明确不要使用DeepSeek官方key。此限制持续有效，提案明确只用既有ECNU ecnu-max，不直连或回退官方；ECNU不可用按失败关闭，不切凭据。本轮仅本机只读设计审查，未读取凭据或新增模型调用。

2026-10-03：用户明确回复“同意这次有限试验”，批准40bb3e3中来源复制计划的Interface及2／32／48／32最多114invoke。新私有目录memory-source-copy-plan-experiment-20261003的人类批准凭证SHA32a33e69a6f02a9ed7a25abf388c214eb68311a415826180d7b31cbd7ba758fe绑定原提案0ee17ce…和唯一范围，旧预算不重开。先用本机0API原型核全dev9、旧12保护及匿名4的完整语义可表达性，相关red→green／类型／SDK只绑定／两轴预检通过并冻结后才联网；原始计划与全部输出按门保留、判败关闭，不改Gold。Triage回到ready-for-agent、State保持claimed，开始私有实现，实际／留出尚未解码，业务／水位／默认路径不写，不用官方key。

2026-10-03：来源复制计划有限试验匿名门失败并关闭。25条人工预期组装对应12种计划，68项不同unittest、12文件mypy／AST、3项SDK仅绑定及两轴预审通过后，冻结计划SHA0cc850ec…。唯一匿名session53629终态exit0，1完整位置、2 E/V invoke／预约／台账、失败／空0；raw先冻SHA4ae2ba…后揭V，全审SHAb5465e…确认必需raw与最终严格3/4，三条准确、缺联系人不知道朋友当前报酬。三份引用逐字真实且意义完整，pending2／auto1仅评测去向，坏auto、误拒、不必要降级及extras均0。捕获运行闭环SHA20135c…通过，无伪造V或新调用；root失败门SHAbc94c1…、关闭收据SHAaa89ab…，累计2/114、余112关闭，开发dry预期BudgetRejected且预约不增，后三阶段未启动、actual／held只核字节未解码。报告见[本轮结果](../../../docs/memory-source-copy-plan-result-20261003.md)。服务reported9,817tokens，HTTP／账单未知，只用既有ECNU、不用官方key／直连；业务／水位／默认路径未改，历史实际6/12及2/6不变。首次本机凭证写作错误保留后0API纠正；不补跑或循环调本配置。当前继续结果文档核对、两轴终审及任务专属本地提交，整体修复未完成，仍ready-for-agent／claimed。

2026-10-03：用户询问下一步及是否需本人验收，获知明确原话由Agent核验后回复“好的，你来吧”。root在已认可extract接缝三次重放首次公开E均红，定位为原话已到达但首包漏生成，3计划→3Fact无丢条；合法人工计划注入可完整组装，只是正控制。两位只读explorer核规则／历史同窗及33份E的system/schema投影，确认知识说明换叶主要重复已测规则；旧匿名4/4与copy3/4差异不构成单变量因果证据，未读取内部思考、actual／held或凭据。新候选为单target独立提取、保留全部同窗context，区别于旧group单E；产品batch_size=1会重新裁context，不直接切换。私有原型3个不同公开extract／Flow检查及相关mypy／AST通过，首次placeholder红／测试格式错误／类型查找路径错误保留；0新API／业务写入，所有已关闭预算不动。具体[20次匿名对照提案](../../../docs/memory-single-target-omission-pilot-proposal-20261003.md)改变target标注与调用量，需新范围决定；Triage改ready-for-human、State仍claimed。普通文档核对、两轴审阅及任务专属本地提交继续完成，不把“你来吧”补写为已同意新预算，不把原型／诊断称实际准确率修复。

2026-10-03：用户收到上述具体20次匿名对照范围问题后，确认下一步由Agent承担，现回复“继续吧”。批准9bbd88b中的原提案SHA56995f6b…，新私有目录memory-single-target-omission-pilot-20261003的人类批准凭证SHA17b4bce6…绑定批准文档／固定10位置／20invoke，所有旧预算继续关闭。Triage回到ready-for-agent，State保持claimed；Agent继续本机编排、原接缝相关验证／SDK只绑定／两轴预检与冻结后唯一匿名运行，raw先审后V，所有输出／失败完整计分，不改默认／Gold或业务。只用现ECNU，不用官方key；此pilot不授权开发／实际／留出，整体修复仍未完成。

2026-10-03：上述pilot已结束并关闭，见[单目标匿名结果](../../../docs/memory-single-target-omission-pilot-result-20261003.md)。9项不同unittest、7文件类型／AST、2种原Tool SDK只绑定及两轴预检后冻结；唯一session78059终态exit0，固定10位置、19invoke／预约／无正文台账，失败0、合法空E1、零保留2、未运行0，余1关闭。首raw全审SHA7e98ac64…先冻结，再揭V，全审SHA3ba05d30…：13raw正文准确、12完整合法，12最终保留准确；原／候选最终均6/8，候选知识状态1/2、原正例保护5/6，1岗位被E附带历史缺源污染，原V正确拒绝。坏auto、完整合法误拒、不必要降级0，必要来源语义契约缺陷1，严格覆盖无收益，六门字段失败、不采用。独立闭环SHA2d7838d4…核900机械条目／10原Flow捕获重放；root失败门SHA9963be05…核315字节指纹及权限后闭账，均0新API。仅现ECNU ecnu-max，SDKreported70,085tokens，HTTP／账单未知；未改生产／业务／水位／旧五条，actual／held未解码，旧2/114仍关闭，实际6/12及2/6不变。所有后续阶段false，无补跑／调参／增臂。整体修复未完成，仍ready-for-agent／claimed／Blocked by none；当前完成结果文档的最小验证、两轴终审及任务专属本地提交。

2026-10-03：上述失败已两轴审查及本地64070f9保存。用户现回复“好继续”，仅批准独立事实与漏项核对的本机原型及新有限方案准备。原E／Flow与捕获V重放两个应记主张保留断言均红，首反馈SHAde0edebb…；原V拒绝复合缺源正确，不能放松。只读explorer核旧R、分组、复制与逐条已有失败职责后，原型采用临时逐target原话片段去向＋声明source片段，一次E、原14出口／system／Flow／V不变；错误skip及复合候选可机械通过的反例必须保留，不称模型改善。新[8次匿名提案](../../../docs/memory-atomic-coverage-pilot-proposal-20261003.md)仅准备，尚无新预算／模型调用，所有旧余额关闭。任务仍ready-for-agent／claimed，当前连续完成本机纵切、相关验证、结果核对、两轴审阅与任务专属本地提交。

2026-10-03：本机原型完成，见[本机结果](../../../docs/memory-atomic-coverage-local-prototype-20261003.md)。12原型＋7独立不同unittest、2文件mypy／AST通过；原两捕获缺陷仍红，人工4条只证明可表达，未知日期／风险／原14值不改，无实际V则不能auto。机械完整覆盖不能判断skip语义、隐藏必要source或原子性；反例均保留，原V仍正确拒绝复合岗位。独审发现总raw上限缺口已红绿修正，新60总raw比原60reviewable严格，重复evidence负担及全部结构损失须未来实测。worker收据SHA8ab12fdd…、独审SHAf5c1bd8a…、root49字节指纹／权限核对SHAff586c8c…，0API／真实SDK／凭据／actual-held／业务写，旧预算关闭、实际6/12及2/6不变。新的[8次匿名提案](../../../docs/memory-atomic-coverage-pilot-proposal-20261003.md)具体准备完，尚未批准联网或实现真实模型委托／runner；Triage改ready-for-human、State仍claimed、Blocked by none，只待该具体范围决定。结果文档最小验证、两轴终审与任务专属本地提交连续完成，不将整体目标或实际验收标成完成。

2026-10-03：用户在本机原型完成、本地提交993312b和具体最多8次匿名对照问题后回复“继续”，批准联合输出与原E/V各两轮的唯一匿名试验。Triage回ready-for-agent，State保持claimed；旧预算仍关闭。先完成私有真实SDK绑定委托与编排、相关TDD／类型、合成凭据只绑定和两轴预检，再完整冻结后运行；未冻结不读真实凭据或构造可出站模型。不读真实／留出、不写业务／水位／旧五条、不改默认，整体目标未完成。

2026-10-03：上述8次对照已完成并判败闭账，见[结果](../../../docs/memory-atomic-coverage-pilot-result-20261003.md)。11项编排不同unittest、6文件类型／AST、root两文件类型／AST、三Tool SDK仅绑定及两轴预检后冻结70依赖；唯一session71858 exit0、四位置、8invoke／预约／台账，失败／空／未运行0、余0。首raw独审SHA017f59b3…冻结后再揭V，全审SHAfd921940…确认原／联合完整raw与最终4/8／6/8、正文均6/8、知识均0/2。局部收益来自第一轮第三人标签；原V放过两错标签形成评测坏auto2，联合坏auto0、原全部正确raw保护4/4，第二轮持平。联合未知报酬两轮均E skip not_reusable、未进入V候选，两项关闭后捕获重放预期红、0新调用，四覆盖门失败，不采用或发布。40组机械核查和root171指纹／权限核对不当模型样本；SDK报告32,527tokens，HTTP／账单未知。仍只用ECNU、不用官方key，未读真实／留出值或写业务／水位／旧五条、未改产品源码／默认，实际6/12及2/6不变。任务仍ready-for-agent／claimed／Blocked by none；继续完成本轮文档最小验证、两轴收尾与任务专属本地提交，不把整体有效修复标成完成。新协议或新调用需先形成具体方案决定，旧预算禁止复开。

2026-10-03：用户“好的继续”批准下一轮本机验证及有限方案准备。原合成E／V首捕获安全断言已重放red（两条第三人auto），热茶正控制通过；没有字段丢失或确定性门绕过。历史知识规则已经单独试过，恢复原知识text叶不是新方法，九项V检查也已有失败；当前只准备V隐藏E三语用标签、来源独立判断及确定性不一致降级的私有方案。0新联网／凭据／业务／默认／产品源码，所有旧预算继续关闭；新具体[V-only提案](../../../docs/memory-source-pragmatics-pilot-proposal-20261003.md)尚未批准，不声称已补知识漏项。两位explorer首宽rg意外见旧仓库少量合成留出行已披露并停读，不能泛称所有agents留出读取0；私有actual／held值未读取，不使用暴露内容。任务仍ready-for-agent／claimed，本轮准备验证、两轴收尾与本地提交继续完成，整体验收保持。

2026-10-03：本机准备完成，见[记录](../../../docs/memory-source-pragmatics-local-preparation-20261003.md)。14项不同控制全绿、5文件mypy／AST、root1文件mypy／AST和2种SDK合成凭据仅绑定通过；原两方法捕获仍安全red／热茶green。人工正确source仅证明pending／pending／auto连接，同错source仍auto的反例保留；隐私嵌套投影与旧V提示细化边界缺口均首失败后局部修正，不称真实模型改善。root101指纹及110项权限核对通过，首次历史类型源码对比误用保留后修正核对路由。新API0、真实凭据读取／业务／默认／产品源码变更0，实际必需6/12及可选2/6不变，旧预算关闭。新V协议与独立8次只针对错放行，具体联合方案无法孤立证明隐藏的因果收益，也不补E知识漏提；普通核实由Agent完成。Triage改ready-for-human、State仍claimed、Blocked by none，只待这一次具体范围决定；当前文档核验、两轴终审及任务专属本地提交连续完成，整体任务未完成。

2026-10-03：用户在获知“最多8次、仅现ECNU的匿名对照；效果由Agent核实，确认的是新协议与预算范围”后回复“是的”，批准0846e3b中[有限提案](../../../docs/memory-source-pragmatics-pilot-proposal-20261003.md)（SHA14f9f71543ce8b600a549107a842cf7ea2f8908737463776ef8266caf5dc9bc0）。独立新目录上限8次V、E／R0，固定A／B原14候选与8位置，只有匿名阶段；旧预算关闭。先完成私有委托／编排的相关TDD、类型／AST、仅绑定、独立参考及两轴预检，授权／输入／代码／规则／配置／版本完整冻结后才读取现ECNU凭据及唯一运行。Triage回ready-for-agent、State claimed；不读actual／held、不写业务／水位／旧五条、不改默认／发布，整体任务仍未完成。


2026-10-03：来源语用有限试验闭账，见[结果](../../../docs/memory-source-pragmatics-pilot-result-20261003.md)。用户新授权8次V全部完成，唯一session18583 exit0、8预约／ledger，E／R0、失败／未运行0、余0，所有旧余额仍闭。18项不同控制、worker/root各4文件mypy／AST、2种SDK仅绑定、4份请求边界捕获后冻结103指纹；初漏19依赖及并行HEAD守卫拒绝已保留并修正冻结路由。24raw先独审冻结SHA5a10e831…再解锁全审SHAd93ea5c6…；root分立核对一致。source标签4/12、负例要求0/4、同次bad-auto原4／source4、合法正例等价支持保护8/8→4/8、新语义降级4。原14输入全24未改，四B-source最终risk经原Flow新增semantic:pragmatics，名义pending仍pending不能算等价保护；每臂核心正文／来源／日期及E标签正确8/12。192机械组与8捕获0API重放通过，96精确读取路径字节未变；SDK总22,701tokens，HTTP／金额未知，不混作新样本。采用门失败，模型独立来源仍同错而非确定性程序丢字段；J没有新E也仍漏，真实必需6/12及可选2/6保持。不采用、不发布、不补跑，不读actual／private held或写业务／水位／旧五条／产品／默认。Triage继续ready-for-agent、State claimed、Blocked by none，只准本机归因及方案准备／收尾，新协议、调用和实际复测未授权，整体有效修复未完成。完成本轮文档最小验证、两轴终审和任务专属本地提交。

2026-10-04：用户在获知旧24闭账、新最多48次（4／20／24）、仅ECNU且核验由Agent完成后明确回复“同意”，批准b077e50中的直接参与者提示单叶提案（原SHA aa313409…）。新的独立目录memory-party-participants-pilot-20261004绑定该答复与原提案；只准已知匿名A/B/C及12条手工合成D，E/R0，不读actual／held、不写业务／水位／旧五条或改默认。先完成新固定编排的TDD、SDK合成凭据仅绑定、独立参考和两轴预检；完整材料冻结后唯一启动4次，raw独审冻结后揭compiled／Flow，全部过门才继续20、24。任阶段判败／无明确收益关闭余量，不复开旧预算、调参或补跑。State仍claimed、Blocked by none，整体验收未完成；普通验证和修正在该具体范围内连续推进，不重复请求同一授权。

2026-10-04：阶段1已按冻结v2计划完成4次公开V调用（4/4位置、失败0、业务写入0），raw独审先通过：候选人物`mixed`为2/2、目标证据为2/2，基线两次均出现旧`contact`方向。full审计发现第1次候选新增`semantic:pragmatics`并由`uncertain/pragmatics`造成不必要降级，完整Fact无降级仅1/2，阶段门失败；余44次已关闭，阶段2／3未启动，无重试、调参或默认变更。结果见[阶段1结果](../../../docs/memory-party-participants-prompt-pilot-result-20261004.md)，原始收据在私有目录保存；本次不能称整体语义准确率修复或授权真实资料复测。

2026-10-04：阶段1失败后的本机诊断已完成，见仓库外私有`semantic-diagnosis-v1.json`。相同C4候选V-input字节级同SHA，但ECNU一次返回`uncertain/pragmatics`、一次返回`supported`；固定捕获响应离线重跑真实Flow确认，verdict才是Fact风险差异，quote末尾标点不是直接原因。现有Flow保持fail-closed，不在本地强制把uncertain改成supported。形成新的[语义稳定性有限对照提案](../../../docs/memory-party-semantic-stability-pilot-proposal-20261004.md)：只澄清report/reported与人物集合独立判断，最多8次、4／4分阶段，仅现有ECNU、匿名C4、无官方key／真实资料／业务写入；尚未批准联网，旧48次余额不复开。

2026-10-04：用户回复“批准”后，按新提案完成独立8次匿名对照，结果见[语义稳定性结果](../../../docs/memory-party-semantic-stability-pilot-result-20261004.md)。预检通过；候选两阶段合计`mixed 4/4`、目标证据4/4、完整Fact无新增semantic风险4/4、`report/reported`保持pending，基线4次仍为旧`contact`错误，坏auto与业务写入0。阶段2四次返回后收尾触发预算类累计slot检查，停止收据保留，未重试或增加第9次；8/8已审计并闭账，所有旧余额不复开。结果支持该提示叶在匿名C4上的局部改善，但不切产品默认、不读真实／留出、不授权发布；下一步若进入产品或真实同批范围需另行决定。

2026-10-04：用户在获知“只改来源核验提示一小段、不加`described_party`字段、本地0次联网”的范围后批准，遂把该提示叶并入产品默认。改动只有`verification_adapters.py`的`SOURCE_VERIFICATION_SYSTEM_PROMPT`一段（新SHA256 `d93ca1d6062842bf33349ec3c340ee37fd126f86a7d62b51e50b09b603cb638f`），schema、Flow、采纳门和窄guard未改。按先红后绿：改动前两条提示契约测试失败（提示未写明“完全被支持的转述不得仅因report/reported判uncertain”，也未保留“标记被丢掉仍须uncertain”），改后新增5项全过；三条流程测试始终守住`supported`不加`semantic:*`且仍`pending`、`uncertain`加`semantic:pragmatics`、`unsupported`拒收。全量单元720项通过；`mypy src/notalone/memory_extraction`仅剩`command.py:504`一处既有无关错误（`git stash`核对改动前同样存在）；`git diff --check`通过。改动与证据记在[来源核验提示转述支持单叶](../../../docs/memory-verification-report-support-leaf-20261004.md)。限制如实保留：本地只证明提示语义与产品后处理，未证明模型行为；试点数字来自带`described_party`的变体提示，不等于产品提示成绩。真实模型匿名对照仍需另批预算，整体修复仍未完成；State保持claimed，下一步状态为ready-for-human（待真实对照范围决定）。

2026-10-04：本轮改动完成两轴只读审查。Standards轴发现2条硬性违规，都在结果文档的验证数字上：全量单测裸命令`unittest discover -s tests/unit`（不加`-t .`）实际为715项加1个既有顶层包导入错误，只有`-t .`才是720项通过；“新测试文件mypy通过”未注明需要`--ignore-missing-imports`（默认单文件调用会报5个`import-untyped`，未改动的同类测试文件同样如此）。另有1条待定级项：文档未说明新段落与既有“标签丢失或升级仍须uncertain”句子的分工。可选建议3条（重复覆盖、断言句式脆弱、未用导入）。Spec轴结论为**产品代码零扩张**：与`HEAD`逐字节比对只有6行插入，schema/Flow/pragmatics/采纳门/其他提示段落均未改，全仓无`described_party`产品字段；红绿由审查方在`/tmp`影子副本独立复现（改动前2红3绿、改动后5项全过）；三条verdict行为与`flow.py`、`pragmatics.py`一致；试点数字与本地证据分层如实，未冒充产品成绩。已按审查修正：验证段改为逐条可复现命令，补记新段落与既有句子的分工、产品版与试点叶少一句`PragmaticInterpreter`说明的文本差异、以及提示句式断言的脆弱面；删除未用导入并补`issues=[]`断言；测试文件SHA更新为`ffa18a3386de2fe4641ab509bc0ab4d4234c6e7e782279c9658bc1ea3dbae25e`。审查未发现代码、隐私、业务写入或联网问题；真实模型对照仍是未完成项。

2026-10-04：用户要求“全部收尾”，遂核对剩余可执行性。仓库 `.env` 只含 `NOTALONE_DEEPSEEK_API_KEY`／`BASE_URL`／`MODEL`／`NOTALONE_OWNER_ID`／`NOTALONE_DATABASE_URL` 五个键名，没有 ECNU 条目；用户此前明确“不要使用 DeepSeek 官方 key”，而历次匿名对照都要求逐次明确批准后才能读取凭据并联一次网。因此**模型侧确认在当前环境不可执行**：不是预算未批，而是可用凭据缺失且官方 key 被禁止，Agent 不得自行读取或回退。已在任务头部记录该阻塞说明。本轮不含任何本地可继续推进的项：授权范围内的提示改动、红绿测试、隔离全量、两轴审查与本地提交（`ddfa1f7`、`28d93d6`）均已完成，任务整体目标（必需主张完整保留的模型侧证据）不能在无凭据条件下达成，故 `State` 保持 `claimed`，不再自行降级或宣称修复完成。若日后恢复：用户提供可用 ECNU 凭据并明确批准一次匿名对照，即可按既有模式重启；若决定不再投入，可把本任务按“提示侧已定稿、模型侧不再验证”改为 `wontfix` 并保留全部证据。

2026-10-04：用户确认“可以做”后着手真实模型对照，并核到关键事实：`.env` 的 `NOTALONE_DEEPSEEK_BASE_URL` 已指向 `https://chat.ecnu.edu.cn/open/api/v1`、模型 `ecnu-max`，该 key 在 ECNU 端点可用（先用一次极小结构化调用探测通过）。因此阻塞解除，按预注册计划完成产品提示的两臂匿名对照：仓库内先冻结材料与执行脚本（`.scratch/memory-core-claim-retention/product-prompt-comparison-v1/`，输入正文留在仓库外私有目录），基线臂从 `e015b96` 取改动前提示，候选臂用当前仓库提示，工具 schema 与用户消息两臂相同，共 4 次公开调用（2 窗口 × 2 臂），只连 ECNU、不读真实/留出、不写业务。结果：基线两窗口均 `supported`；候选中窗口 1 `supported`、窗口 2 `uncertain/pragmatics`，编译后多出 `semantic:pragmatics`。四条都保持 pending 且坏 auto 为 0，但“两窗口都 supported”“无新增语义风险”“不必要降级为 0”三条门槛失败。按计划判败闭账：预算 4/4 用完，不重试、不调参、不补跑；本轮不改动产品提示（既不为 4 次调用回滚已提交的单叶，也不追加预算跑出想要的结果）。结果与限制见[产品提示匿名对照结果](../../../docs/memory-product-prompt-comparison-result-20261004.md)，私有收据含 preflight、4 份原始返回与 `close-v1.json`。整体目标仍未达成：核心事实完整保留需要新的、预注册的对照（更多窗口与重复、两臂随机顺序、以不确定率为主指标），需要用户另行决定范围；State 保持 claimed。

2026-10-05：用户先明确「继续投入」，随后在读完[重复测量有限对照提案](../../../docs/memory-claim-retention-repetition-pilot-proposal-20261005.md)后**批准 16 次新预算（2 窗口 × 4 重复 × 2 臂，E=0／V=16／R=0）并接受窗口数仍为 2**，同时接受提案的处置约定：结果「有害」时只出结论、回滚另开实现票并再取得批准，本轮不改产品默认。方向批准与预算批准分开记录；本行只登记批准范围，不代表已产生语义结论。本轮准备按提案第 7 节做（0 API）：仓库内新增冻结计划 v2 与 runner（重复次数、冻结顺序表、分阶段门、失败与空返回计分母），先红后绿补测试，跑 `unittest`／`mypy`／AST／SDK 合成凭据只绑定／`--dry-run`，再两轴预检并冻结全部材料哈希；**冻结完成前不读取 ECNU 凭据、不联网**。旧预算全部继续关闭，不复开、不借用。`State` 保持 claimed、`Triage` 保持 ready-for-agent。

2026-10-05：v2 本机准备通过两轴审查后修正五个问题（0 API、0 联网、0 真实凭据读取）。1）[测试模块（现行位置）](../../../backend/tests/unit/experiments/test_memory_claim_retention_v2.py)不再在 import 期加载 `.scratch/` runner：改为 `setUpClass` 加载 + `unittest.skipUnless` 守卫，脚本缺失时 14 个依赖类整体跳过而不是让 `discover` 收集报错；新增临时仓库副本 + 子进程探针证明「缺失 → skipped、0 error」且「脚本存在时守卫不跳过」。2）冻结计划 `sources` 记录 runner 与 prepare 的 SHA256（文件原始字节），runner 新增 `check_source_integrity()` 并在 dry-run／preflight 校验；改脚本后必须重跑 prepare。3）同一 schema 的两个哈希（`ensure_ascii` True／False）统一为 `canonical_json_sha256`（`ensure_ascii=False, sort_keys=True, separators=(",", ":")`），prepare 通过 importlib 复用 runner 的同一实现，`frozen-plan-v2.json` 的 `schema_sha256` 已更新；`prepare --check` 也逐项核对源码与 schema SHA。4）提案第 7.2 节「SDK 合成凭据只绑定」落在同文件 `SyntheticCredentialBindingTest`：只用自造合成 key 构造 ECNU `ecnu-max` 并走 runner／产品同一形状的具名 `tool_choice` 绑定，`httpx` 同步／异步 `send` 被 patch 成抛错，只断言绑定成功，明确不证明真实调用可用。5）提案第 3 行与末段各补一句「正文写于批准前；批准后按第 7 节新增仓库内准备文件并在本票记录批准范围」，预算、门槛、顺序表与边界未改。`State` 保持 claimed、`Triage` 保持 ready-for-agent；冻结完成前不读凭据、不联网。

2026-10-05：上述 16 次对照已按冻结计划执行并闭账，结果见[重复测量对照结果](../../../docs/memory-claim-retention-repetition-pilot-result-20261005.md)。16/16 完成、0 重试、0 补位：两臂各 8 个位置**全部** `verdict=supported`、`issues=[]`，坏 auto 0、硬拒 0、转述候选 16/16 保持 pending、14 字段保真 16/16；阶段 1 三门与阶段 2 安全门／运行门通过，**主判定＝「无可观测的对照信号」**——按预注册不得当收益通过、不追加预算、默认不加。这同时说明 2026-10-04 候选臂窗口 2 那次 `uncertain/pragmatics` 在本轮 8 个候选位置未复现，更像单次抖动而非稳定效应；但本轮只有 2 个材料窗口，8 个位置是同材料重复、不是独立场景，因此既不宣称单叶有收益，也不推翻旧结论。**运行时偏差如实记录**：每次调用都出现「钉扎工具失败（InternalServerError），退回默认工具选择」——冻结 runner 内既有回退分支改为默认工具选择后成功，两臂同受影响，模型仍一致选择具名工具 `SourceVerificationOutput`；失败请求可能已到服务端，真实 HTTP 次数可能大于 16，且生产核验适配器没有这层回退，故本轮不是生产绑定路径的等价物。整体目标不变：真实聊天严格覆盖仍 6/12、可选 2/6，本轮不含提取调用；不改产品提示、不回滚、不宣称提升。预算 16/16 闭账，旧余额继续关闭。`State` 保持 claimed。

- 2026-10-12（离线评测准备）：用户确认先补Mac焦点及记忆质量方案，已形成[三票共同评测准备](../../unfinished-work/memory-quality-plan-20261012.md)。公开合成两窗共5个必需主张仅作为损失的合成近似，不读取旧私有窗口、不代签真实严格覆盖6/12／可选2/6。先冻结当前E/V路径基线与独立Gold，再依据稳定失败提出单变量候选；原目标、原State／Triage和验收不变，旧实验余额全部关闭。本轮模型／真实HTTP／业务库调用0，现有runner尚无真实HTTP硬门，方案存在不代表允许执行或整体修复完成。

- 2026-10-12（历史引用路径修正）：上述两条单元测试链接随仓库backend布局重排后失效，现分别指向backend/tests中的真实文件；提示契约测试与历史blob相同，v2测试后来还有路径适配，故标为“现行位置”。只修引用，不将现行版本冒称当时相同字节，不改旧结果、日期、源码SHA或预算。

- 2026-10-12（继续离线前置）：[21窗预检及工具交付](../../unfinished-work/memory-quality-preflight-20261012.md)记录独立Agent输入候选与旧oracle对照、非秘密源码／版本指纹，核心两窗的5条有限命题仍不能代替完整人工Gold。HTTP预约组件12／12纯合成通过，真实SDK重试及未知存储故障闭环尚待；生产和完整runner未接，模型／真实HTTP／本票业务库调用0。真实严格6/12、可选2/6不改写，原State、Triage和验收保持；42／84仍未开放。

- 2026-10-13（本持续目标的公开四窗终态）：[固定四窗结果](../../unfinished-work/goal-memory-20261013-diagnostic4-result.md)已实际closed8/8、8个真实200、44事件、driver857.171293708秒、CLI exit0；本轮A01／A02／A04／A05共4窗／5必需命题，正式raw／accepted／完整3/5、3/5、1/5，四份审核均general_error。A05历史借车的主体、方向、双null、来源和lineage完整正确，但另有来源支持的额外家庭事实，原Gold不增optional、不删输出救分；原A05旧迟到unknown保持。本票公开B01／B02本次未选，真实聊天未读或上传，历史真实严格6/12／可选2/6及原AC不改；四窗不能代替核心全量回放。新有限目标八run全部持久closed，累计42尝试／38个200／4旧read_timeout远端未知，关闭余额不复用、全量280与余1未启；原State／Triage、默认空放行表保持。后继最小来源／语用修复与完整公开回归装配继续准备，尚未获新调用或生产放行授权。


- 2026-10-13：新单V控制 `472f5c0d-7a7e-4620-9586-1698f76b7d97` 实际1请求/1个HTTP200，driver单调79.530892167秒、显式Agent V4 4/4与语义支持通过；固定公开A02旧E14/window/source/双null不变，仅V system换4c939d96。实际closed1/cap1、六event/capture_gaps空、lock无持有、本机入口exit0；全目标九stage累计43（39次200、四次旧ReadTimeout远端未知），关闭未用145与退役12不可借用，全量280尚未激活。详情见 [单V控制真实结果](../../unfinished-work/goal-memory-20261013-single-V-control-result.md)。 本次无新E调用或核心命题全量回归，不能以V支持替E14、原命题分母与source/lineage/完整质量；下一步严格拒未完整参考的140工具及公开119独审，原AC/State不变。


## Comments（本持续目标完整21窗中断终态 2026-10-13）

- [本场结果](../../unfinished-work/goal-memory-20261013-complete21-observation-result.md)：唯一8d0460a1已closed16/42、16真实200，driver2229.922556秒／exit1；A01–A07正式完成、A08因完整审核缺失unknown、其余13unrun，B01/B02未运行。七窗完整契约4/9不替代核心严格6/12／可选2/6旧成绩或全量140回归，原21／28分母、Gold及sealed保留。A06当前等行李分支与历史到达分支分报，实际raw／accepted2/2但完整0/2，不靠共用有效期救历史契约。没有补签、新调用或自动后继，旧余额及本场余26关闭；State／AC保持，完整当前观察和真实模型质量未达成。


## Comments（本持续目标四窗V技术停止 2026-10-13）

- [本场结果](../../unfinished-work/goal-memory-20261013-stage-priority-diagnostic4-result.md)：唯一e910bd79实际2请求（E200／V500）、CLOSED2/8、driver单调7.821042375秒／exit1；0正式审核、A05 unknown／其余三窗unrun，B01/B02仍未运行。本次E14合法工具输出不替代命题语义／source／lineage／完整回放；V服务500后响应只能存摘要而停，内部根因未知。0网络重构核新维度证据没有进入V正文，旧成功请求非模型参数相同，不签核心质量改善或真实6/12、可选2/6成绩变动。余6永闭；累计11closed／61尝试（56×200、1×500、旧4timeout远端未知），177关闭未用及退役12不可借，全140专属280未启。原AC／State、Gold／sealed和默认空放行不改，无重启／新模型授权。


## Comments（新证明协议有限技术停止 2026-10-13）

- [本场实际结果](../../unfinished-work/goal-memory-nullable-diagnostic4-result-20261013.md)：新run665225c9实际E200／V500、CLOSED2/8、8.084218832998886秒；正式审核0、A05 unknown／A06–A08 unrun。剩余6永久关闭，本目标12阶段全closed、累计63真实HTTP预约（57个200、2个500、4旧ReadTimeout远端未知）／183永闭未用／56未登记退役／280全140未启，工程分配582。根.env仅预算领取后读取一次既有ECNU三键，无真实聊天、App、微信、OCR、业务库、发送；默认空表、旧Gold／sealed／原AC和State保持。 本场没有形成V4/proof或完整命题审核，不能更新原六窗6/12、可选2/6、留出及完整回放结论。公开A05事后来源诊断只记旧Gold产权属性覆盖不足，不凭无指称原文补车主、不变Gold，也不能据此判错人／假事。原真实核心私有六窗输入及范围缺失继续保留；公开四窗不能替代原核心验收。


## Comments（单V真实响应与ECNU授权续记 2026-10-14）

- [实际结果](../../unfinished-work/goal-memory-nullable-V-tool-choice-probe-result-20261013.md)：唯一单V run5e292cb1实际HTTP200、CLOSED1/1、40.72790824999902秒；reported deepseek-flash与原预登记别名不同而停止，formal0／techfalse／proof=null UNKNOWN。事后禁网络严格DTO与来源核对不补签原审核。用户在终结后明确接受deepseek-flash，继续只用根.env给定ECNU配置并要求记住，不再把此别名授权列待决；新授权用于后继独立计划，旧闭账保持。全目标13closed／64真实预约（58个200、2个500、4旧timeout远端未知）／183永闭未用／56未登记退役／280未启，分配583；当前无active模型场、App612／发送8/12／来信0／现场暂缓保持。 原六窗6/12与可选2/6／留出不由公开单V覆盖，完整回放仍缺；原AC／State不变。


## Comments（新原21首窗正式安全停止 2026-10-14）

- [真实结果](../../unfinished-work/goal-memory-nullable-reference21-result-20261014.md)：独立582d73f8实际447.437282875秒、E/V均200（reported v4-flash）、CLOSED2/42，余40永久关闭。A01正式raw/full1窗，正文两命题保留，14字段12pass2fail，理由无来源补“此前被认作仓库管理员”严格记raw false_fact1，safety_error后剩20unrun；子集raw2／接受2／完整0，不把matcher passed或V4支持签全部字段。proofnull/programUNKNOWN／source_boundfalse／semantic_basisnull，自动0。累计14closed66HTTP／223永闭未用／56退役／full280未启，分配625；旧原Gold21/28+1和所有AC/State保持。当前仅通用E提示修复准备，未有新场登记或真实调用；现场暂缓、App612／消息8/12／来信0保持。


### 2026-10-16 受控歧义v3两窗正式小试

[独立v3结果](../../grounded-evaluation/typed-ambiguity-v3-pilot-result-20261016.md)：原公开A07／A10新run closed4／4，四次官方DeepSeek HTTP200、零重试，两窗completed但均general_error。E14逐字段40／42、必需raw3／接受3／完整1；A07缺地点归属歧义，A10否定借款缺敏感风险，两方向说明本次均保留原人物及肯定／否定。三条最终pending，proof全null／UNKNOWN，source_bound=false、semantic_basis=null；旧matcher两窗passed不当作完整质量。原Gold、旧失败／闭账、默认空表及State／AC保持，不与旧v2拼成完整21或≥15用例。本场未测B01／B02、私有实际或留出，不补签核心整体；下一步只读封存证据做离线标签诊断，无自动后继。


### 2026-10-16 指导两窗闭账与核心范围分开

[新独立指导场](../../grounded-evaluation/v3-label-guidance-public2-result-20261016.md)closed4／4、四HTTP200、零重试，A07／A10必需raw3／接受3／完整3、E14为42／42，两窗safe。该场只测公开指代两窗，不补签本票B02旧未知、核心5命题或真实6／12；三候选pending、proof全UNKNOWN、默认空放行保持。关闭时79源一致、26事件及四审核收据核验、自有worker／组退场，独立双轴0。旧失败不覆盖，不拼批次或复用余额；本票原未完成目标及State保持。


### 2026-10-16 指代主集部分结果不代签核心范围

[固定16窗新场](../../grounded-evaluation/v3-main16-result-20261016.md)closed22／32，前10窗已审核必需raw13／接受13／完整11；A11因V缺合法工具参数失败，后5窗未运行，余10次永久关闭。该场没有B01／B02或私有六窗，不补签旧B02未知、核心5命题整体或真实6／12。12条proof均UNKNOWN，评测auto4／pending8不代表业务采纳；旧失败、全部原分母／State／AC、默认空表保持。关闭原件、源码和进程核验见结果，后继仅独立离线准备，无自动重发。另经结果Spec复审发现A05冻结Gold及sealed审查将未解车主认作姐姐，与已批准D2冲突；上述raw／完整／safe为原封存机械计数，不将A05作为无争议质量或安全证据。原完整11中其余10可引用，原记录不改，未来参考另行显式修正。


2026-10-16：完整140新场`fd4d9056-1eb8-4848-8122-da7f7747e7d0`已closed2／280，首窗A01 E取得HTTP200、V读取超时且无响应，unknown1／unrun139，raw及full均0；B01/B02没有新场信用。余278永久关闭，85源与8事件及自有退场已核；[结果](../../grounded-evaluation/full140-v4-result-20261016.md)不替代旧部分场、真实／留出或核心整体门，原State／AC保持。


2026-10-16：完整140混合合同真实场已独立closed6／280、六HTTP200、零重试，三窗已审／137窗未跑；[实际结果](../../grounded-evaluation/full140-mixed-v-off-result-20261016.md)必需raw4／接受4／完整2，R002分类与有效起点错误进入评测auto，bad_auto2触发硬停（新增现实假事／错人0）。五proof均UNKNOWN/untrusted_source，余274关闭，资源退场核验完成；不拼旧样本凑≥15、不认证完整140、typed或逐类放行，默认空表及本票State／AC保持。后继只先离线定位，无自动补发或新批次。
