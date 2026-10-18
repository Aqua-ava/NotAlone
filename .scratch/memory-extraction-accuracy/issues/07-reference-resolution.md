# 07 — 指代消解维度评测与修复

**What to build:** 把"他/她/那个/这件事指谁、指什么"测全：跨消息指代、省略主语、多个第三方同时出现、指代含糊时应保守。至少 15 条合成用例。重点保证含糊指代不会被写成确定事实（宁可不采纳，也不能猜错）。发现判错按允许手段修复，并保证全部既有用例回归通过。

**Triage:** ready-for-agent
**State:** claimed
**Blocked by:** 01（评测骨架）；02 的产出用例可并入

- [ ] 该维度达标签：至少 15 条中假事 0、记错人 0、一般错误 ≤1
- [x] 覆盖跨消息指代、省略主语、多第三方、含糊指代
- [ ] 指代含糊的候选不得进入自动采纳
- [ ] 修复只用允许手段；全量既有用例回归通过
- [x] 新增与修复对应用例入库

## Comments（实现记录 2026-09-15）

- 用例：指代维度 15 条（跨消息指代：老李、那本书、面试结果、门票、借书看完；省略主语/宾语：机场、发地址、感冒好点；多第三方：老李小王借钱、老李钓鱼；含糊指代：他借钱、那个事、他们来家、那人）。
- 真实模型 `ecnu-max` 最终用例集三轮：10/15、10/15、11/15；更早一版用例集三轮为 14/15（达标签）、11/15、12/15，其中一轮出现 2 条假事（"省略主语方案""搬家日期"把未来安排标成 assertion 自动采纳），这两条候选已替换。最终集安全项：两轮假事 0、记错人 0，一轮假事 1。
- 主要缺口是一般错误：短消息与含糊指代偶发不提取（每轮 3-5 条），以及已修掉但偶发的 family 类目混填。多轮重跑已复现，不是用例期望错误。
- 结论：**未达标签，不放行**；指代维度继续只进待确认。下一步建议：压缩整合提示词（排除条目过多可能造成召回抑制）并用任务 10 的模型对照验证；必要时把"指代不清"做成生成后的确定性降级规则再评。

## Comments

### 2026-10-16 剩余公开8窗有界退场

[独立本场结果](../../grounded-evaluation/remaining-public8-result-20261016.md)：closed4／16、三200与一个V远端未知、零重试，余12永久关闭。B01 raw/full封存且safe／supported、单窗必需raw3／接受3／完整3；因无完整batch result，外层仍保守将B01及B02列unknown，此单窗证据不覆盖原收据。B02无正式审核，其余六窗unrun；本场13必需、核心5必需分母保留，不签核心整体、原21完整、≥15用例门或逐类放行。proof仍null／UNKNOWN、默认空表不变。当前持续授权已足够推进离线修复与必要有界官方合成验证，Triage改ready-for-agent，历史等待新预算说明仅作历史；State／AC及旧失败保持，真实聊天、业务与ECNU均未处理。

### 2026-10-15 官方DeepSeek公开部分基线已关闭

按用户指定仅用官方DeepSeek，在原公开合成21窗中完成13窗、8窗未运行，实际25次请求、零重试，A13整组去向合同触发现有安全类停止，17次未用额度永久关闭。已完成子集必需raw15/15、程序接受15/15、完整契约9/15；A13的bad_auto来自混合auto/pending组规则，不改写为内容假事或错人，也不重开预算。指代主集仅完成13/16窗，原至少15例门槛未满足；15个命题不能改算15个窗口。 分层字段、各窗缺口、停止原件及局限见[本轮结果](../../grounded-evaluation/deepseek-public21-result-20261015.md)。State及原AC保持，本轮不上传真实聊天、不写业务、不自动采纳。

- 现状（2026-09-16）：最新两轮全量为 13/15（一般错误 2、2），未达标签（≤1）；压缩尝试期间曾低至 11/15。失败集中在含糊指代的保守化与短消息漏提，用例波动大。本轮不修，维持"暂不放行"；修复归属与口径待定，未纳入下一轮票 01-05。

- 2026-10-10（不需人在场的核查）：当前 `evaluation_cases.CASES` 中指代维度实际为 16 条，历史 13/15 是当时结果，不能沿用为当前集合的基线。生产 `DEFAULT_DIMENSION_RELEASE` 仍为 `allowed=frozenset(), gate_enabled=True`；维度、采纳、评测和提取公开流程的确定性回归与追踪 HTTP 共 110 项通过。该结果证明门槛接线与保守去向，不证明真实模型指代准确率达标；未改提示词、评测期望或放行表，也未调用供应商。下一步缺当前用例集的模型/配置、对照方案与调用预算；暂转 `needs-info`，保持 `open` 和原门槛，不重用其他已关闭实验的预算。条件齐备后先固定 16 条现行基线，再针对实际失败做最小修复并回归既有集合。

- 2026-10-12（离线评测准备）：用户确认先补Mac焦点及记忆质量方案，已形成[三票共同评测准备](../../unfinished-work/memory-quality-plan-20261012.md)。指代主集16条与语义补充3条分开报告，历史13/15不改写为现行基线；新方案先当前基线、仅稳定一般错误才接候选准备，不能对难例特判。现有runner没有真实HTTP硬计数门，非秘密配置和Gold尚待冻结，本文模型／HTTP／业务库调用0；原`open / needs-info`、0/5验收、旧预算关闭与未放行边界保持。

- 2026-10-12（继续评测前置）：用户确认按工作流继续，领取原票的评测工具前置工作，State改为claimed，Triage仍needs-info、五条模型验收均未勾。接缝限定HTTPX同步／异步transport发送前预约：本轮只以纯合成transport验证真实请求尝试的持久硬上限、重试不退款、固定run与端点、单在途和成功持久关闭后不可重开；关闭记录写入故障只能保证当前句柄停发，外层未知运行拒绝恢复尚待补齐；不接生产模型或完整评测runner，不改提示、schema、维度放行或产品默认行为。独立标准答案、实际非秘密配置与运行装配仍需核定；42／84仅拟议上限，模型实验未开放。

- 2026-10-12（前置结果）：[预检与HTTP组件交付](../../unfinished-work/memory-quality-preflight-20261012.md)已形成；组件12／12纯合成通过，独立Agent输入核对发现转述auto、瞬时时间空字段及借用方向等需核定项，未改答案或启动模型。源码／版本快照不证明实际供应商配置；真实SDK、未知故障闭环和完整runner仍待。State保持claimed／Triage needs-info，原五条模型验收0/5，默认空放行表和旧成绩保持。

- 2026-10-12（工具接缝续验）：[预算与最终请求验收](../../unfinished-work/memory-budget-integration-20261012.md)补实际SDK同步／异步重试、单次持久批次领取与未知故障停发，以及合成E/V最终请求契约；30项接缝及完整相关146／146受守卫回归通过。OpenAI3.3.1默认HTTPX2，本轮只认证官方legacy HTTPX注入，不认证factory整条装配；已领取run拒绝重开，成功响应后保存故障逃出batch即停发。本轮供应商／真实HTTP0，App／微信／OCR0，未读密钥／私有资料／业务库；人工Gold、实际供应商配置、完整原始结果保存与runner仍缺。State／Triage及原模型验收0/5不改，旧成绩与空放行表保持。

- 2026-10-12（继续ECNU与P0工具）：用户答“继续使用”确认沿用ECNU，公开官方参数已形成[配置复核](../../unfinished-work/ecnu-model-config-20261012.md)。[私有记录与P0整场](../../unfinished-work/memory-offline-records-result-20261012.md)完成26项新验证、完整相关172／172；允许请求／响应及解析前原消息先持久，内部思考无原文旁路，不能安全脱敏时留缺口停批，闭合／全计划对账后才返回收据。仅固定假端点Mock执行，无真实ECNU入口、供应商调用或业务库；[21窗人工审查包](../../unfinished-work/memory-gold-review-packet-20261012.md)仍未认证，真实ECNU装配／身份漂移判据及模型质量待验。State claimed／Triage needs-info与原模型0/5不改，旧预算关闭、空放行表、新功能冻结及OCR暂停保持。

- 2026-10-12（技术答案自主核对）：用户要求继续、需要其亲自操作或取舍时停下。原准确率spec只要求用户抽查，核心spec要求Agent自行核实，初版“21窗逐字段人工认证”额外门已撤回；[Agent技术核对](../../unfinished-work/memory-gold-agent-annotations-20261012.md)不称用户认证或独立盲审。A05借车是本人参与经历，不因出现姐姐一概reported；A06瞬时状态当日失效已在2026-10-05确认，pragmatic旧文档同步既有决定，未改prompt／schema。当前仅向用户提交A14“一次性发地址动作是否纳入”的具体抽查，旧pending期望与现行一次性细节排除存在取舍，未代填答复。[真实接线前置](../../unfinished-work/memory-ecnu-driver-readiness-20261012.md)已列出期限／请求body冻结／响应型号观测等实际driver缺项，尚未实现或执行。真实模型／HTTP／业务库／App／OCR0，未读凭据、未改公开case／评分／空放行表；42／84仍未激活，State claimed／Triage needs-info及原验收0/5保持，等待具体取舍后继续离线验证与冻结。

- 2026-10-12（A14抽查答复后续接）：用户明确“不存成关系资料（推荐）”，本例none、窗口仍保留于21分母；仅此取舍由用户核定，不写成全窗人工认证。[技术标注](../../unfinished-work/memory-gold-agent-annotations-20261012.md)继续收束有限正文／字段组合及独立复核；依[受限接线规格](../../unfinished-work/memory-ecnu-driver-spec-20261012.md)补ECNU期限／请求body／源码冻结／成功响应型号观测门及双侧SDK工具接线，仍先精确Mock／假凭据加载器验证，不读取真实密钥或启动供应商。旧matcher与必需独审分开报告，审计无默认safe，完整技术Gold未终冻；原状态／验收0/5、默认空放行表、旧预算关闭与OCR暂停／功能冻结保持。

- 2026-10-12（ECNU工具片交付）：[受限实施结果](../../unfinished-work/memory-ecnu-driver-result-20261012.md)新增contract15＋ECNU16，主Agent完整相关203／203、5源码mypy与7文件AST通过；两侧发送前核期限／源码／7键body，先存允许响应再比成功型号，持久领取后一次loader、关闭故障不续开，内存prompt／schema变化与E原JSON类型非法在下一调用前停。独审回调无默认safe，原matcher另报，质量认证仍false；[技术参考](../../unfinished-work/memory-gold-agent-annotations-20261012.md)E14／V4、topic／风险／歧义／理由经另一Agent复审及有限纠正，不冒称用户认证或可执行Gold终冻。代码两轴0项，最终交付元数据增审由Root收口。真实供应商／密钥／私有资料／业务库／App／OCR0，旧公开case／prompt／schema／评分与空放行台账不变；42／84未激活，仍需结构化参考／逐字段审核对账与完整运行冻结，原State／Triage及模型0/5保留。

- 2026-10-12（结构化答案与审核装配）：[本片结果](../../unfinished-work/memory-structured-gold-result-20261012.md)完成21窗／28必需＋A15可选1、34绑定variant和40来源选择的JSON装配；独立Agent核对全部语义与21输入摘要0差异，仅A14为用户抽查。显式审核16项、真实参考加载5项和已脱敏V输入接点1项，完整相关225／225、3源码mypy与6文件AST通过；分报raw／接受／完整、全量E/V字段、重复／额外／未知和安全，不能以V=supported签语义质量。Spec初审发现真实21窗加载门缺失和V失败误清已捕获raw，已修正，最终Standards／Spec均0项未解决。raw先封存再揭V的执行桥及完整运行冻结／真实基线仍缺，不在本片读密钥或发供应商；原公开case／prompt／schema／matcher／空放行表、历史成绩、42／84未激活和原模型验收0/5保持，新增功能冻结、OCR暂停。

- 2026-10-13（raw封存执行接点）：[本片结果](../../unfinished-work/memory-phased-audit-result-20261013.md)完成raw仅E视图→显式审核→私有回执核验→full及完整报告先存后决策，实际ECNU入口拒绝旧协议。新增13项phased与4项整场接点，完整相关242／242、3源码mypy通过；Standards发现保存能力默认参数可覆盖当前case/状态，已补真实红灯并改为内部固定闭包，最终两轴未解决发现0项。本轮仅键名探测确认当前环境没有NOTALONE_EVALUATION_API_KEY，未读取秘密值或产品.env；仓库外隐藏输入向导已准备，需要用户在本机准备专用入口，随后完整运行冻结及有限真实基线。真实供应商／HTTP／业务库／App／OCR0，42／84未激活，旧预算关闭、原状态及模型0/5、默认空放行、新功能冻结／OCR暂停保持。

- 2026-10-13（明确凭据来源）：用户指出仓库.env已有密钥并明确要求直接使用。按[完整运行规格](../../unfinished-work/memory-p1-execution-spec-20261013.md)改为持久领取后显式loader仅提取根.env的NOTALONE_DEEPSEEK_API_KEY，不要求重新录入，不改一般CLI自动加载行为、ECNU固定配置或资料范围。已仅核文件普通／当前用户所有／0600，秘密值仍未读，运行冻结和有限等待桥正在准备；42尚未激活，原State／Triage、模型0/5及旧成绩不改，功能冻结、OCR暂停。

- 2026-10-13（一次公开P1技术停止）：[本次结果](../../unfinished-work/memory-p1-execution-result-20261013.md)完成59源／固定21窗／Gold／版本／期限冻结，桥21项假材料检查及最终两轴0项后唯一执行，持久领取后按用户指定根.env只读约定密钥。首请求HTTP500、21字节响应只能保存摘要而触发硬停，实际预约／尝试1／42、unknown1／unrun20，无E/V语义成绩或合法空E。预算closed标记与SQLite闭合／manifest／1请求1终态已核，两客户端及握手清理无缺；正式completion收据因记录器停止不可用，单独Root对账不能代替。无补发、P2或失败run重开，余41关闭；真实聊天／App／微信／OCR／业务库0，原状态、模型0/5、默认空放行与真实核心6/12保持。当前缺可安全解析的服务响应及完整模型基线，不再要求用户重新录入密钥，功能冻结／OCR暂停。

- 2026-10-13（本持续目标的公开四窗终态）：本轮用户解除OCR暂停并授权现有任务必要修复，记忆部分按新的有限总cap480、旧余额不复用连续推进；[固定四窗结果](../../unfinished-work/goal-memory-20261013-diagnostic4-result.md)唯一run86b6已closed8/8、8个真实200、44事件、driver857.171293708秒、CLI exit0。原Gold21窗／28必需命题不改，本次A01／A02／A04／A05为4窗／5命题，正式raw／accepted／完整3/5、3/5、1/5，四窗均general_error；A01无据身份备选、A02核验误降语用、A04理由添“当面”、A05有据额外候选均保留。旧程序matcher4passed不作质量证据，未选17窗与旧未知未补分。八个本目标run持久SQLite全closed，累计42真实尝试／38个200／4旧read_timeout远端未知；60源码未漂移、记录／收据／cleanup无错、锁持有已释放但文件保留，旧关闭余额不借，全量280与余1未启。仍缺≥15现行质量门和完整既有回归，原五条验收不勾、State／Triage及默认空表不改；下一步最小来源／语用修复与140窗执行方案准备，不宣称目标完成或外部阻塞。


- 2026-10-13：新单V控制 `472f5c0d-7a7e-4620-9586-1698f76b7d97` 实际1请求/1个HTTP200，driver单调79.530892167秒、显式Agent V4 4/4与语义支持通过；固定公开A02旧E14/window/source/双null不变，仅V system换4c939d96。实际closed1/cap1、六event/capture_gaps空、lock无持有、本机入口exit0；全目标九stage累计43（39次200、四次旧ReadTimeout远端未知），关闭未用145与退役12不可借用，全量280尚未激活。详情见 [单V控制真实结果](../../unfinished-work/goal-memory-20261013-single-V-control-result.md)。 本次只证固定A02核验结果；原86b该窗uncertain/pragmatics及full0、全部Gold/旧sealed/未运行保持，未建立完整21窗或≥15例质量通过，原AC/State不变。


## Comments（本持续目标完整21窗中断终态 2026-10-13）

- [本场结果](../../unfinished-work/goal-memory-20261013-complete21-observation-result.md)：唯一8d0460a1已closed16/42、16真实HTTP200、86事件、driver单调2229.922556秒／入口exit1；A01–A07正式完成，A08 full审核未提交达到原600秒而unknown，A09–A19及B01/B02共13unrun。原raw封存、Gold21／28必需和全部分母不改，不补签或resume，余26永久关闭。七窗9必需机械raw8／accepted8／完整4，四general_error；旧matcher另报8程序结果中的false_fact1，不以未完成的安全审核签假事0。指代至少15、一般错误≤1及全量回归仍缺，State／AC和默认空放行表保持；累计本目标59真实HTTP（55个200＋旧4次timeout远端未知）。


## Comments（本持续目标四窗V技术停止 2026-10-13）

- [本场结果](../../unfinished-work/goal-memory-20261013-stage-priority-diagnostic4-result.md)：唯一e910bd79已CLOSED2/8，实际E200／V500、六事件、driver单调7.821042375秒／exit1；正式审核0，A05 unknown、A06–A08三窗unrun，无raw/full补签。V的21字节非JSON错误只存摘要，具体停止为响应脱敏不可用而闭账；合法构造请求收到服务500，内部根因未明。离线重构证明新维度字段未进入真实V正文，旧成功V的非模型参数相同，但SYSTEM／正文变化，不能当语义修复或指代≥15通过。余6永久关闭；本目标11closed、61真实尝试（56个200／1个500／旧4timeout远端未知）、177永闭未用、12退役／full280未启。原Gold、旧sealed、AC／State及默认空表保持，不借余额、不重启，尚无新prepare／HTTP授权。


## Comments（新证明协议有限技术停止 2026-10-13）

- [本场实际结果](../../unfinished-work/goal-memory-nullable-diagnostic4-result-20261013.md)：新run665225c9实际E200／V500、CLOSED2/8、8.084218832998886秒；正式审核0、A05 unknown／A06–A08 unrun。剩余6永久关闭，本目标12阶段全closed、累计63真实HTTP预约（57个200、2个500、4旧ReadTimeout远端未知）／183永闭未用／56未登记退役／280全140未启，工程分配582。根.env仅预算领取后读取一次既有ECNU三键，无真实聊天、App、微信、OCR、业务库、发送；默认空表、旧Gold／sealed／原AC和State保持。 实际E保留姐姐出借、联系人接收及已发生行动，未声称产权；旧Gold要求的车主属性覆盖不足，但获批D3明确未名“她”不能凭模板认定产权。事后公开来源诊断非盲性、非正式审核，不补签假事0／错人0／一般错误≤1。两个schema离线合法不能证明ECNU兼容或V500原因；现行完整指代集和全量回归仍缺。


## Comments（单V真实响应与ECNU授权续记 2026-10-14）

- [实际结果](../../unfinished-work/goal-memory-nullable-V-tool-choice-probe-result-20261013.md)：唯一单V run5e292cb1实际HTTP200、CLOSED1/1、40.72790824999902秒；reported deepseek-flash与原预登记别名不同而停止，formal0／techfalse／proof=null UNKNOWN。事后禁网络严格DTO与来源核对不补签原审核。用户在终结后明确接受deepseek-flash，继续只用根.env给定ECNU配置并要求记住，不再把此别名授权列待决；新授权用于后继独立计划，旧闭账保持。全目标13closed／64真实预约（58个200、2个500、4旧timeout远端未知）／183永闭未用／56未登记退役／280未启，分配583；当前无active模型场、App612／发送8/12／来信0／现场暂缓保持。 完整指代集与全量既有质量仍缺，A05产权UNKNOWN不凭模板或旧Gold补出；原5AC不变。


## Comments（新原21首窗正式安全停止 2026-10-14）

- [真实结果](../../unfinished-work/goal-memory-nullable-reference21-result-20261014.md)：独立582d73f8实际447.437282875秒、E/V均200（reported v4-flash）、CLOSED2/42，余40永久关闭。A01正式raw/full1窗，正文两命题保留，14字段12pass2fail，理由无来源补“此前被认作仓库管理员”严格记raw false_fact1，safety_error后剩20unrun；子集raw2／接受2／完整0，不把matcher passed或V4支持签全部字段。proofnull/programUNKNOWN／source_boundfalse／semantic_basisnull，自动0。累计14closed66HTTP／223永闭未用／56退役／full280未启，分配625；旧原Gold21/28+1和所有AC/State保持。当前仅通用E提示修复准备，未有新场登记或真实调用；现场暂缓、App612／消息8/12／来信0保持。

## Comments（A01来源最小修复实际局部回归2026-10-14）

[新A01独立cap2结果](../../unfinished-work/goal-memory-A01-source-fidelity-result-20261014.md)实际343.930431209秒／两200v4-flash，E14通过、raw133.443秒／full155.735秒、局部2必需raw2／接受2／完整2、安全0，技术1/1完成；原全21／28＋1、140、私有六窗口／留出及逐维度≥15未认证。原Gold／答案／分母／AC／State不改，旧虚构失败保留。proofnull／UNKNOWN、version2 source_boundfalse／semantic_basisnull、pending／0auto；AND／空放行表及业务迁移0保持。Root独立CLOSED2/2／unused0、旧账全16目录锁free／PIDgone／清理空，累计15场closed68＝62确认200＋2确认500＋4旧timeout未知，223永久关闭、56退役／280未激活／分配627；不借额度或自动后继。现场继续暂缓。


### 2026-10-16 受控歧义v3两窗正式小试

[独立v3结果](../../grounded-evaluation/typed-ambiguity-v3-pilot-result-20261016.md)：原公开A07／A10新run closed4／4，四次官方DeepSeek HTTP200、零重试，两窗completed但均general_error。E14逐字段40／42、必需raw3／接受3／完整1；A07缺地点归属歧义，A10否定借款缺敏感风险，两方向说明本次均保留原人物及肯定／否定。三条最终pending，proof全null／UNKNOWN，source_bound=false、semantic_basis=null；旧matcher两窗passed不当作完整质量。原Gold、旧失败／闭账、默认空表及State／AC保持，不与旧v2拼成完整21或≥15用例。本场未测B01／B02、私有实际或留出，不补签核心整体；下一步只读封存证据做离线标签诊断，无自动后继。


### 2026-10-16 v3标签指导两窗完整审核通过

[独立新场结果](../../grounded-evaluation/v3-label-guidance-public2-result-20261016.md)closed4／4、四官方DeepSeek HTTP200、零重试；A07同时保留人物身份／地点归属未定，A10两条保留方向及否定项financial，E14为42／42，必需raw3／接受3／完整3，两窗safe。A10-P1的V uncertain/pragmatics依冻结真实歧义判据显式通过，不改原E合法分支，不强求V supported。三条均pending、typed proof仍UNKNOWN，未达到≥15用例质量门或完成既有全量回归。原v3小试40／42、完整1／3与全部旧失败分列，不认证提示因果或稳定率；关闭时79源／台账／四phase收据及worker清理核实，结果双轴均0。本票State及原五AC保持。


### 2026-10-16 固定16窗主集契约停止

[独立主集结果](../../grounded-evaluation/v3-main16-result-20261016.md)已closed22／32、22次官方DeepSeek HTTP200、零重试，余10永久关闭；A01–A10完成raw／full，A11的V没有结构化工具参数而failed，A12–A16 unrun。已审核13个必需raw13／接受13／完整11、E14为167／168，8窗safe、2窗general_error（A04空事项歧义、A08实际0.65导致pending）；不因HTTP200或V supported补分。12条proof均UNKNOWN，最终评测auto4／pending8，无业务采纳。关闭时79源一致、139事件与20份审核收据核验、worker／组gone；仅10窗不足≥15，原票State／五AC、旧失败及空放行表保持，不拼旧场。另经结果Spec复审发现A05冻结Gold及sealed审查将未解车主认作姐姐，与已批准D2冲突；上述raw／完整／safe为原封存机械计数，不将A05作为无争议质量或安全证据。原完整11中其余10可引用，原记录不改，未来参考另行显式修正。


2026-10-16：已审来源v2与v4固定完整140入口完成离线装配；真实新场`fd4d9056-1eb8-4848-8122-da7f7747e7d0`closed2／280，首窗V读取超时远端未知、后139未跑，raw／full0。没有新场完成或≥15质量信用，旧A05争议不由此覆盖；余278永久关闭、不补发未知V。[结果](../../grounded-evaluation/full140-v4-result-20261016.md)保留140／138＋1分母及原State／AC。


2026-10-16：完整140混合合同真实场已独立closed6／280、六HTTP200、零重试，三窗已审／137窗未跑；[实际结果](../../grounded-evaluation/full140-mixed-v-off-result-20261016.md)必需raw4／接受4／完整2，R002分类与有效起点错误进入评测auto，bad_auto2触发硬停（新增现实假事／错人0）。五proof均UNKNOWN/untrusted_source，余274关闭，资源退场核验完成；不拼旧样本凑≥15、不认证完整140、typed或逐类放行，默认空表及本票State／AC保持。后继只先离线定位，无自动补发或新批次。

### 2026-10-16 唯一性对照的部分证据与独立交付项

[本场实际结果](../../grounded-evaluation/reference21-uniqueness-result-20261016.md)：新run closed28/42，27个HTTP200，第28次A15 E触发600秒墙钟退场且远端结果未知，余14永久关闭。A01–A14的RAW/FULL分别封存并收据匹配，部分必需raw/接受/完整15/15，A14为唯一一般错误；外层仍15unknown/6unrun，无完整batch result，不能用15个事实组充作至少15个窗口或拼接旧场。A15未知、A16未跑；第1/3/4条验收保持未勾，State仍claimed，默认放行表为空。

独立核对后仅勾第2与第5条的范围/仓库交付信用：跨消息A02/08/13、省略A06/11、多第三方A10及含糊A01/03/04/05/07/09已覆盖；[现行16条指代用例](../../../backend/src/notalone/memory_extraction/cases/reference.py)、[事项码回归](../../../backend/tests/unit/memory_extraction/test_grounded_v4.py)、[给定码与原无码负控](../../../backend/tests/unit/memory_extraction/test_grounded_v4_runtime.py)及[原21窗helper合成回归](../../../desktop/tests/fixtures/test_reference21_v4_public.py)已入库。它们不替代未完成的全量真实模型回归或证明所有语义含糊都能被模型选码；原A05无码仍auto负控及全部历史失败保留。


### 2026-10-18 Agent快速验收与E2依赖修复

用户明确授权Agent替代人工验收，`reviewer_kind=agent`，原安全／数量门不变。E2已标未决目标被省略句引用时的说明丢失已真实红绿修复，16窗口标签控制不当模型成绩；29相关与827全部提取单测通过。[独立16窗新场](../reference-agent-baseline-result-20261018.md)closed29/32，已审15窗，假事实0／错人0／bad_auto1／一般3，A16未跑，必需raw16/18、完整14/18，不能关票。旧预算与全部旧成绩不改，默认空表保持；后继仅按四个实际缺口修正E2通则提示。

### 2026-10-18 四通则与思考配置对照仍未达标

[四通则non-thinking独立场](../reference-agent-prompt-result-20261018.md)完成16/16、closed31/32，假事实0／错人0／bad_auto0／一般2，必需raw18/18、完整17/18；A07分类与A14一次性细节仍错。[只切E thinking/max的独立场](../reference-agent-thinking-result-20261018.md)closed29/32，15窗已审、A16未跑，假事实0／错人0／bad_auto1／一般3，必需raw16/18、完整13/18；A15已完成读书误标关系备注并auto触发安全停止。两场分开计，不签达标、不切默认配置。当前所有预算已关闭，先离线归因再决定后继修复；State、未通过AC及生产空放行表保持。

### 2026-10-18 合同顺序修订后主集及独立诊断

[新场分组结果](../reference-agent-contract-result-20261018.md)closed43/48：原16完整审核，假事实0／错人0／bad_auto0／一般3，必需raw18/18、完整16/18；独立诊断8窗只完成6窗，raw5/7、完整2/7，一般3与bad_auto1，D07/D08未跑。明确规则顺序后仍复现事项未知和一次性交换纳入错误，不能关票或改生产默认。后续先评估字段分类/纳入核验机制，不以无变化重跑或混组分母求通过；全部预算已关闭，原State/未通过AC保持。

### 2026-10-18 成对教学对照仍未达标

[教学独立场](../reference-agent-fewshot-result-20261018.md)closed41/48：主16全审，raw18/18、最终E14完整15/18、含V完整14/18，一般3、安全0；诊断6/8，raw5/7、完整2/7，一般2及bad_auto1，D07/D08未跑。A14与D03一次性交换本次正确排除，但第三人/关系类别及V时间判断仍错。完整提取833项单测通过不替代语义质量；八个实验预算均关闭，累计175次请求。先查证官方模型配置再确定下一干预，保持任务未完成、默认空表及旧Gold/成绩。

### 2026-10-18 专用Pro16入口与首场结果

[Pro16实际结果](../reference-pro16-result-20261018.md)：专用封闭入口`542398af`完成SDK／owned验证与双审后，新场closed28/32、28HTTP200。A01–A14完成28份RAW/FULL回执：safe8、一般6，已审假事实／错人／bad_auto0；A15 V响应无法安全完整留存，仅844字节摘要，立即停止为unknown，A16 unrun。原18必需＋1可选分母保持，必需raw15／接受13／完整7；不能签至少15窗门或把已审安全0外推。worker已退出，临时凭据已删除，capture_gap1保留；首场凭据格式错误另closed0/32、另一次仅prepared未激活。原State／AC／D8失败与默认空放行表保持，下一步依据真实标签、V与具体理由缺口选择独立干预。

### 2026-10-18 E类型教学单项仍未达标

[教学场结果](../reference-kind-teaching-result-20261018.md)：`b2c80417`新封闭E教学在12专用／33相关／874提取单测、7源码mypy及双审0剩余后冻结，新场closed28/32。A01／A03／A09／A10原E标签错误本次均消失；14窗safe10、一般4（A01／A07／A10 V错误及A05程序理由），raw15／接受13／完整9 of18，已审安全0。A15 V再次仅摘要保存而unknown，A16 unrun，capture_gap1，不猜缺失响应或拼接旧成绩。worker已退出、临时凭据已删除；后继先定位记录失败路径，再检验V作者引句及既有周界政策的专用接线。原Gold／分母／D8失败／未通过AC与默认空放行保持。

### 2026-10-18 核验保真档与留证诊断准备

[保真计划](../reference-verification-retention-plan-20261018.md)新增独立V档，复用作者引句与既有完整周／周末检索约定，E教学及四槽schema保持。固定留证失败码已独立提交`061d27b4`；摘要硬停与unknown、旧nonfinite语义保持。35相关／888提取单测／7源码mypy和双审通过。尚未启动新API，等待主集成统一冻结；A05泛化理由缺口仍独立未解决，原Gold／AC／D8失败／生产空表不变。

### 2026-10-18 A05有限原文理由补全

独立补齐E2既有出借文法的角色、完成词及未明产权说明，只追加interpretation_reason，不扩语法、正向proof或身份信用。10定向检查（72组肯定变体及边界负控）、SDK到pending保存、2源码mypy及891提取单测通过；140窗固定标签对照仅1处reason变化、其他字段一致。联合冻结明确同时包含V保真提示和程序理由修复。A05旧场一般错误与整体未达标保持，须新实际验收后再判断，未运行新API或生产放行。

### 2026-10-18 统一源码联合场技术硬停

[联合场结果](../reference-retention-result-20261018.md)：source7bef5d1f、run34aa026e closed10/32，4窗safe3／一般1（A01 V资料归属误拒），必需raw5／接受3／FULL3 of18。A05第10个HTTP200仅832B摘要，新增固定码nested_json_invalid；无RAW视图，unknown，A06–A16unrun。worker退出、临时key删除、8回执独审通过；累计241请求，旧场不可回推。A05离线理由修复不据此签模型通过，原Gold／分母／AC／D8／生产空表保持。后继先只读评估V推理与兼容工具策略，不新API。

### 2026-10-18 独立V推理第六版离线接线

[独立计划](../reference-v-thinking-plan-20261018.md)已实施E Pro disabled／none／forced与V Pro enabled／max／omitted，各8192，分阶段合同第六版独立冻结。923提取单测、6源码mypy、最终16定向用例及双审通过；新增真实owned子进程Mock验证和nested_json_invalid未知硬停覆盖。仅工程信用，没有新API或语义成绩；原16／18＋1／32／零重试、Gold／提示／schema／A05编译器及生产空表保持。交主线集成统一回归后再决定冻结；State、未通过AC、旧D8失败与全部旧场结果不变。
