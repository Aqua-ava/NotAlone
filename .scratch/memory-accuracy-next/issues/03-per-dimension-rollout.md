# 03 — 按维度放行自动采纳的准则与实现

**What to build:** 把评测达标签接入自动采纳：只有评测证明可靠的维度（如本轮的主体、改写保真）允许该类事实自动采纳，其余安静待确认；放行记录可追溯，回退简单。前置：任务 10 的模型对照与提示词整合结果。

**Triage:** ready-for-human
**State:** claimed
**Blocked by:** 无（10、01 已结）

- [ ] 维度判定键落在候选上（主体/时间/转述/指代/保真/媒体），不改变现有 0.7 与风险白名单语义（2026-10-13已补可空版本化结构、来源复核及合取门；生产`reference`／`reported`仍未知，相关集合为保守超集，字段与语义质量分别验收，尚不能据此放行）
- [x] 放行表与回退开关可配置，默认只放行已验证维度（本轮默认放行表=空集）
- [x] 达标签由评测工具输出（`summarize`）直接生成，不手写
- [x] 放宽门槛的准则文档化：达到"至少 15 条、假事 0、记错人 0、一般错误 ≤1"才允许新增一类

## Comments

- 2026-10-06：按批准提案启动 `time` + `truth_intent` 匿名合成评测，计划 44 条／88 次调用。第 3 条 `time` 用例出现首个 `false_fact`；现有 runner 未自动早停，人工停止时在途请求又完成，最终仅记录 24 条／39 次，随后关闭剩余预算。`time` 已出现假事，`truth_intent` 仅完成 19/20，故本轮是协议偏差下的未完成结果，不产生任何放行证据；详见[结果记录](../../../docs/memory-dimension-release-time-truth-intent-result-20261006.md)。不补跑、不改默认空放行表；如要再评测，需先修 runner、重新预注册并另批预算。
- 2026-10-06：已在本机修复 runner 的可选 `--stop-on-safety-error` 早停开关，并新增 2 项离线契约测试；937→939 项单元测试通过。修复只用于未来新预注册版本，本轮剩余 49 次不重用，未重新联网。
- 2026-10-06：按新批准的最多 40 次预算，使用修复后的 runner 完整执行 `truth_intent` 20 条合成用例。实际 32 次调用、调用失败 0；通过 16、假事 0、记错人 0、一般错误 4，未达标签，不放行。完整聚合结果见[truth_intent 结果](../../../docs/memory-dimension-release-truth-intent-result-20261006.md)；默认空放行表保持不变。
- 2026-10-06：对 4 条一般错误做本机归因：3 条是候选结构／来源核验后被确定性外壳拒绝或未生成，1 条是来源核验调用失败；没有发现可以在不猜测正文、来源或语用状态的前提下修补的确定性代码缺陷。保持提示、采纳门和默认放行表不变；后续若要改善需另立提示／模型对照，不把本轮失败包装成放行证据。
- 2026-10-06：按批准的最多 40 次预算完成当前提示两轮稳定性复测：第 1 轮 7/10、3 条一般错误；第 2 轮反转顺序 10/10，首轮 3 条均通过；两轮假事／记错人均 0，实际 35 次调用。未复现稳定缺陷，不改生产提示或放行表。结果见[稳定性复测报告](../../../docs/memory-truth-intent-repeatability-result-20261006.md)。
- 2026-10-06：按批准的最多 40 次预算完成失败形态 A/B 对照。A 当前提示 9/10 通过、1 条一般错误；B 修复提示叶 6/10 通过、4 条一般错误；两臂假事／记错人均 0。B 虽减少“明确事实”拒绝，却使三个安全控制新增一般错误，故不采用、不改生产提示、不扩展范围。结果见[修复对照报告](../../../docs/memory-truth-intent-repair-comparison-result-20261006.md)。

- 2026-10-06：基于档 A 归因形成新的[`time`／`truth_intent` 评测提案](../../../docs/memory-dimension-release-time-truth-intent-proposal-20261006.md)。本机 dry-run 核对 44 条用例、最多 88 次调用；提案未获预算批准前不读凭据、不联网、不修改放行表。

- 2026-10-06：档 A 结果的本机后归因（0 次联网、未读真实聊天）已完成。逐条聚合 40 条结果：10 条失败均有候选输出，未发现提取漏项或范围越界；`subject` 失败 2 条均为去向不符，假事／记错人／主体字段均为 0；`paraphrase` 失败 8 条集中在文本保真、有效期和去向，其中 3 条为假事。现有确定性 Flow、语用解释与采纳门没有安全的单点修补可以消除这些模型语义错误；不改变提示、不放宽门槛、不改默认空放行表。下一步若要提升覆盖，需另立预注册模型对照并单独批准预算；当前票继续 `claimed`。

- 2026-10-06：**档 A 评测已执行并判未过门（本票的放行证据到此为止）**。用户批准档 B′（先跑档 A ≤80 次，过门再接 `time` ＋ `truth_intent`，全轮 ≤168 封顶）后，按预注册范围跑完档 A：40／40 条用例、**79／80 次调用**、调用失败 0、补跑 0，模型 `ecnu-max`、端点 `chat.ecnu.edu.cn`、只用仓库内合成用例。结果 **`subject` 未达标签**（用例 20、通过 18、假事 0、记错人 0、一般错误 2 > 1）；**`paraphrase` 未达标签**（用例 20、通过 12、**假事 3 > 0**、记错人 0、一般错误 5）。三条假事触发预注册停止规则，故第二阶段 `time` ＋ `truth_intent` **未启动**、余量未使用、不补跑也不放宽门槛。失败形态：10 条失败用例**全部产出 1 条候选、无一漏提**，信号集中在去向不符 9、有效期不符 8、标签不符 7、保真／文本不符 7。因此放行维度数仍为 0，`DEFAULT_DIMENSION_RELEASE` 保持空集，所有候选继续安静待确认；`paraphrase` 即使日后达标也仍不可放行（维度键不可推导）。聚合指标与运行事实见[档 A 结果](../../../docs/memory-dimension-release-tier-a-result-20261006.md)，逐条原始输出在仓库外私有目录（0700／0600）。`State` 保持 `claimed`：验收第 1 条仍未达成，自动采纳覆盖率为 0 是当前正确行为；若要提升覆盖率需要先解决本轮暴露的去向与严格语义失败，并另批预算。
- 2026-10-05：机制部分实现完成（默认空放行表、门槛口径对齐、可回退）。新增
  `src/notalone/memory_extraction/dimensions.py`：`dimension_key` 只用受控字段
  判定（带有效期→`time`；`assertion`+`asserted` 且主体 self/contact→`subject`；
  其余确认陈述→`truth_intent`；其他一律 `None`＝不放行）。`paraphrase`／
  `reference`／`media`／`reported` 缺必要字段、当前不可推导，已在代码注释、
  ADR-036 与放行台账写明，即使达标也不能放行。`MemoryAdoption` 增加构造参数
  `dimension_release`（默认读 `NOTALONE_MEMORY_DIMENSION_GATE`，只有显式 `0`
  才关闭门），维度放行是独立第 4 道合取项，原有三道语义未改。`summarize().meets_gate`
  对齐 ADR-027 第 2 条，语义标注覆盖改为单独报告字段。新增 ADR-036、放行台账
  `docs/memory-adoption-dimension-release-ledger.md`，并在 ADR-033 末条显式记录
  被 ADR-036 修订。**未运行任何真实评测**（需另批预算与用户批准，见
  `docs/memory-dimension-release-evaluation-proposal-20261005.md`）；因此当前没有
  任何维度放行，全部候选待确认，直到新证据产生并逐类获批。

- 2026-10-05：用户明确选择「只有测准的类型自动记」——自动采纳从整体一刀切改为按评测放行维度：达到门槛的维度才允许自动采纳，未达标签的维度安静待确认；放行表与回退开关可配置，默认只放行已验证维度。门槛沿用本票既有准则（至少 15 条、假事 0、记错人 0、一般错误 ≤1），放行结论必须由评测工具输出而非手写。`State` 由 open 改为 claimed，开始实现；未达标签维度不因本票放宽门槛。
- 2026-10-05：勘察发现两处必须先处理的冲突，已向用户说明并取得路线决定。①**ADR-033（2026-10-02 采纳，晚于 ADR-027）在「取舍与边界」明确写「不以旧去向达标签替代语义准确率，不放宽门槛或接入维度自动放行」**，与本票的「接入维度放行」直接冲突；②现有评测工具的 `meets_gate` 额外要求「该维度全部用例都带语义标注且语义场景 ≥15」，与 ADR-027 第 2 条的达标签口径不一致，按现行代码**没有任何维度能达标**，而放行台账里「主体／改写保真达标签」是 2026-09-15／16 的旧口径结论。用户据此选择 **A + B′**：默认放行表先置空（严格合规，不沿用旧台账数字），同时准备评测方案并把准确调用次数报给用户批准，跑出达标签维度后再逐类放行。因此本票实现顺序为：先做机制与门槛口径对齐（默认空放行表、可回退），再另批评测产生放行证据；实现时须新增 ADR 记录 ADR-033 该条被本次决定修订，且不得用旧数字充当新证据。
- 2026-10-06：**票面现状核对（本轮只读核对与推进说明，未改代码）**。①四条验收里三条已落实：维度判定键 `dimension_key` 只用受控字段（`dimensions.py:91`）、默认空放行表与 `NOTALONE_MEMORY_DIMENSION_GATE=0` 回退（`dimensions.py:108` 起）、达标签由 `summarize().meets_gate` 输出（`evaluation.py:339`）、门槛口径「用例数 ≥15、假事 0、记错人 0、一般错误 ≤1」写进 ADR-036 与[放行台账](../../../docs/memory-adoption-dimension-release-ledger.md)。②第 1 条验收（六类维度键）当前只覆盖 `subject`／`time`／`truth_intent` 三类，`paraphrase`／`reference`／`media`／`reported` 因提取结果缺结构化字段**当前不可能放行**——这是本票已披露的缩减，不是新遗漏，要放行需先补字段（另立 ADR 与迁移）。③**本票不能标 `resolved` 的原因**：实际放行数为 0，放行一个维度需要「可推导 + 评测达标签 + 预算获批 + 用户逐类批准」，后两项都还没发生；[评测预算提案](../../../docs/memory-dimension-release-evaluation-proposal-20261005.md)（档 A ≤80 / 档 B ≤168 / 档 C ≤280 次）仍待用户拍板。未批准前不读凭据、不联网、不运行评测。④因此当前生产行为是：所有通过原有三道门槛的候选一律走 `_create_pending_candidate` 安静待确认，`AdoptedStats.adopted` 不增加。`State` 保持 `claimed`，等待预算决定。
- 2026-10-05：两轴只读审查完成，发现并已修复的问题：**①放行路径空转（硬性）**——`from_environment()` 只回传 `gate_enabled`、把 `allowed` 丢掉，而台账规定的放行操作正是改 `DEFAULT_DIMENSION_RELEASE`，照做在生产永不生效（且 `adoption.py` 里那次导入根本没被使用）。已改为先取该常量的放行集再叠加运维开关，并补端到端测试（打补丁改默认值后，默认构造的 `MemoryAdoption` 真的自动采纳）与"默认值类型非法即报错"测试。**②现行规格漏更（硬性）**——`domain-data.md`、`core-flows.md`、`pragmatic-interpretation.md`、`CONTEXT.md` 与 `README.md` 仍写"满足置信度与风险门槛即自动写入"，已全部补上第 4 道门与 ADR-036 指针。**③误导字段**——`semantic_gate_cases` 恒为常量且无人读取，已删除；并在 ADR-036 与预算提案里写明"达标签只是必要条件，标注覆盖不足时不能据此放行"。**④重复逻辑**——`None → from_environment()` 的解析在 `adoption.py` 与 `worker.py` 各写一份，已收敛为 `DimensionRelease.resolve()`，并明确生产只传 `None`、注入是测试接缝。**⑤命名歧义**——3 门的 `can_auto_adopt` 与 4 门的 `MemoryAdoption._can_auto_adopt` 同名异义，后者改名 `_passes_all_adoption_gates`。**⑥维度串漂移**——新增测试断言"运行时键集合 ⊆ 评测维度串集合、且差集恰为评测专用的 `condition`／`quantity`"，防止枚举与评测集再次漂移。**仍如实保留的未完成项**：验收第 1 条要求的六类维度键当前只覆盖 3 类（`subject`／`time`／`truth_intent`），`paraphrase`／`reference`／`media`／`reported` 因缺结构化字段**当前不可能放行**，要放行需先补字段（另立 ADR 与迁移）——这是本票已披露的缩减，不是遗漏；`time` 维度放行只覆盖带有效期的候选，口径已记入台账。验证：单元 931 项通过、相关集成 20 项通过、mypy 在改动模块无新增问题。

- 2026-10-10（下一步角色同步）：按当前验收与最近评测记录，剩余推进需要缺失字段的 ADR／迁移范围决定、新的预注册对照及预算、达标后的逐类放行批准。依据仓库 Triage 定义，将下一步角色同步为 `ready-for-human`；总清单同步该标签，`State` 仍为 `claimed`，四条验收保持三项已勾、一项未勾。此次只修正任务元信息，没有新增模型调用、字段、迁移或放行。

- 2026-10-12（离线评测准备）：用户确认先补Mac焦点及记忆质量方案，已形成[三票共同评测准备](../../unfinished-work/memory-quality-plan-20261012.md)。公开主集123＋语义补充17共140例按原集合核对，质量计数、严格命题标注及运行键可推导性分开；当前键仍仅subject／time／truth_intent，其余缺字段维度即使达标签也不能放行。拟议42／84真实HTTP是新方案硬上限，计数门、配置及Gold未冻结前执行关闭；不重用旧预算、不补字段／迁移或放行，默认空表及本票claimed／ready-for-human、3/4验收保持，本轮模型／真实HTTP／业务库操作0。

- 2026-10-12（继续离线前置）：[21窗预检及工具交付](../../unfinished-work/memory-quality-preflight-20261012.md)补独立Agent输入候选、oracle冲突与可从代码确定的配置指纹。HTTP预约组件12／12纯合成通过，未知写关闭故障只能停当前句柄，外层禁恢复、真实SDK及完整runner仍待。Agent盲读不是人工Gold；未改期望、结构化字段、维度键或默认空放行表。模型／真实HTTP／本票业务库调用0，原State、Triage、验收与旧成绩保持，不自动放行。

- 2026-10-13（本持续目标的公开四窗终态）：[固定四窗结果](../../unfinished-work/goal-memory-20261013-diagnostic4-result.md)唯一run86b6已closed8/8、8个真实200、44事件、driver857.171293708秒、CLI exit0；正式4completed但四份semantic audit均general_error，必需raw／accepted／完整3/5、3/5、1/5，原21窗／28命题及未选17窗保留。matcher4passed不替代语义质量，本次不满足≥15／零假事／零记错人／一般错误≤1的新增放行证据。A05两个auto仅是benchmark理想三门，生产第4道维度门、默认空表、0.7与风险语义未改，无业务写库或用户逐类批准。运行时仍仅subject／time／truth_intent三键，paraphrase／reference／media／reported缺typed依据，质量及字段缺口分别保留；原AC3/4、State／Triage不改。八个本目标run持久closed合42尝试／38个200／4旧read_timeout远端未知，关闭余额不复用、全量280与余1不启；继续最小修复设计和完整公开回归接线，不能由这四窗自行放行。


- 2026-10-13：新单V控制 `472f5c0d-7a7e-4620-9586-1698f76b7d97` 实际1请求/1个HTTP200，driver单调79.530892167秒、显式Agent V4 4/4与语义支持通过；固定公开A02旧E14/window/source/双null不变，仅V system换4c939d96。实际closed1/cap1、六event/capture_gaps空、lock无持有、本机入口exit0；全目标九stage累计43（39次200、四次旧ReadTimeout远端未知），关闭未用145与退役12不可借用，全量280尚未激活。详情见 [单V控制真实结果](../../unfinished-work/goal-memory-20261013-single-V-control-result.md)。 单V不认证任一维≥15例、typed运行时依据或自动采纳效果；默认空放行表、门槛和用户逐类批准保持，没有生产放行或业务库写入，原AC/State不变。


## Comments（本持续目标完整21窗中断终态 2026-10-13）

- [本场结果](../../unfinished-work/goal-memory-20261013-complete21-observation-result.md)：8d0460a1真实16次均200且closed，正式7completed／1unknown／13unrun，七窗9必需raw8／accepted8／完整4，E失败7/98、V失败4/28及语义2/7；≥15质量门及21／140完整语义观察未满足。A08实际评测auto与旧matcher false_fact1作为风险保留，但其full审核缺失，不补签正式bad_auto或签安全0。评测理想三门auto不等于生产放行；本场未改运行时字段、默认空表、原Gold／审核／AC／State，维度字段及合取门另轨核验，质量证据仍待达原门后逐类批准。累计59真实HTTP与171关闭未用／12退役／280未启在总522中分列，不复用或自动激活。

- 2026-10-13（用户批准字段切片）：[实施合同与隔离证据](../../unfinished-work/goal-dimension-evidence-contract-20261013.md)已独立提交`5552f9f1`，36文件当前SHA与提交blob核对、两轴未解决均0。108相关unit／API、12个自有隔离PG及18源码mypy通过；跨时区两subcase真红→绿，来源实际晚1秒仍拒绝，12库全部清理。nullable JSONB与候选／来源摘要、保存和AUTO事务二次复核、候选上下文来源删除清proof、所有相关维度依据及批准的AND门已接通；旧NULL未知且不回填，原三门和默认空表不变。生产指代／转述锚点仍None，5–7维是保守超集而非完整分类器，已采纳confirmed／owner上下文删除只给待决方案；业务迁移、App投影验收及至少15例真实语义质量未签。原AC保持3/4、claimed，运行结构不代替质量或逐类批准。


## Comments（本持续目标四窗V技术停止 2026-10-13）

- [本场结果](../../unfinished-work/goal-memory-20261013-stage-priority-diagnostic4-result.md)：原03运行字段、窗口投影兼容及两SYSTEM提示共同冻结后，唯一e910bd79实际E200／V500、CLOSED2/8，driver单调7.821042375秒／exit1；正式审核0，A05 unknown／其余三窗unrun。0网络真实formatter重构核非空dimension_evidence不进入V正文，候选仍十一槽；这是字段投影接线证据，不能签任何维度≥15／假事0／记错人0／一般错误≤1或自动放行。响应21字节非JSON仅存摘要，V内部500根因未知，余6永久关闭。11stage全closed，累计61尝试（56个200、1个500、旧4timeout远端未知）／177永闭未用，退役12／full280未启；实际默认空表、原三门及AND门、Gold／旧sealed／AC／State保持，字段与语义仍分别验收且逐类批准。


## Comments（新证明协议有限技术停止 2026-10-13）

- [本场实际结果](../../unfinished-work/goal-memory-nullable-diagnostic4-result-20261013.md)：新run665225c9实际E200／V500、CLOSED2/8、8.084218832998886秒；正式审核0、A05 unknown／A06–A08 unrun。剩余6永久关闭，本目标12阶段全closed、累计63真实HTTP预约（57个200、2个500、4旧ReadTimeout远端未知）／183永闭未用／56未登记退役／280全140未启，工程分配582。根.env仅预算领取后读取一次既有ECNU三键，无真实聊天、App、微信、OCR、业务库、发送；默认空表、旧Gold／sealed／原AC和State保持。 D1–D3已批准实现及隔离验证；新增结构不等于真实有效proof或任一维度达标签。本场V500没有proof，原A05未名“她”的产权UNKNOWN，旧Gold不是新reference依据的正向例。所有相关维度有效依据＋逐类批准的AND门继续有效，旧候选不回填或重采纳，业务迁移0；原AC仍3/4，不自行放行。


## Comments（单V真实响应与ECNU授权续记 2026-10-14）

- [实际结果](../../unfinished-work/goal-memory-nullable-V-tool-choice-probe-result-20261013.md)：唯一单V run5e292cb1实际HTTP200、CLOSED1/1、40.72790824999902秒；reported deepseek-flash与原预登记别名不同而停止，formal0／techfalse／proof=null UNKNOWN。事后禁网络严格DTO与来源核对不补签原审核。用户在终结后明确接受deepseek-flash，继续只用根.env给定ECNU配置并要求记住，不再把此别名授权列待决；新授权用于后继独立计划，旧闭账保持。全目标13closed／64真实预约（58个200、2个500、4旧timeout远端未知）／183永闭未用／56未登记退役／280未启，分配583；当前无active模型场、App612／发送8/12／来信0／现场暂缓保持。 NULL proof没有有效维度关系，用户模型授权不等于逐类放行，原AC3/4、AND／默认空表、业务迁移0和旧回填0保持。
