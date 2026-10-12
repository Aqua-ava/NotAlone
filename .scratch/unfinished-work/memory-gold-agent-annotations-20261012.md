# 21 窗记忆评测的 Agent 技术核对（2026-10-12）

> 状态：Agent 可复审标注，尚未最终冻结；不是人工认证。整理者已读现有 oracle，不能称盲审或独立于旧答案的首次判断。本文不修改输入、旧 oracle、评分器、提示、schema、采纳门、放行表或业务资料，不开放模型执行门。新增功能冻结，OCR 暂停。

本文承接[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)和[原审查包](memory-gold-review-packet-20261012.md)，由 Agent 先完成可从原句和已采纳规则核对的部分。原准确率[spec](../memory-extraction-accuracy/spec.md)第40行要求用户**抽查**用例期望；核心事实[spec](../memory-core-claim-retention/spec.md)第26、62–64行要求 Agent 自行核实、联网前独立复核冻结，且不把 Agent Gold 标作用户确认。因此不要求用户填21窗技术表。用户只需抽查 A14 的实际纳入取舍；其余技术允许集合由独立 Agent 复核，若复核仍无法消除分歧，执行门继续关闭，不伪称所有字段已认证。

## 核对方法和统一字段

- 固定21窗：A01–A16为现行 reference 主集，A17–A19为公开语义补充，B01–B02为核心公开观察。窗口不删、不补位。旧公开 holdout 只作回归，不当作新留出。
- 下文每个 `P` 为一个必需独立命题；语义相同的重复输出不增加覆盖。A15借书关系只作可选审计，A14是否增加必需命题待用户抽查；当前整理为**28个已列必需命题＋A14待定1个＋A15可选1个**，此数字不是终冻主张分母。
- `source` 为窗内零起始索引。每个实际消息ID为 `uuid5(NAMESPACE_URL, f'notalone-evaluation/{case.name}/{i}')`，时间 `T(i)=2026-09-15T00:00:00+00:00+i分钟`；至少有一条 target，不可用 context 单独制造事实。来源集合无顺序要求，可接受集合在各窗注明；无关额外来源仍是引用缺陷，不靠堆来源获得信用。[build_window](../../backend/src/notalone/memory_extraction/evaluation.py)第81–98行、[E来源规则](../../backend/src/notalone/memory_extraction/adapters.py)第108–112行。
- `subject` 表示资料归属：`self` 是 owner 本人范围，`contact/shared` 为当前联系人范围；第三人的称呼必须写在命题中，不能因 subject=contact 把第三人写成联系人。合成 owner/contact 分别为 `uuid5(NAMESPACE_URL, 'notalone-evaluation/owner')` 和 `uuid5(NAMESPACE_URL, 'notalone-evaluation/contact')`，不是实际身份或联系人授权。
- 所有下列保留命题的 `figurative_type=literal`；未知人物、对象或借用方向属于内容歧义，不等于修辞 unknown。实质歧义可在 `alternatives` 中保留确有依据的备选，不补身份或新事件。
- `H`：已完成历史事实的 `valid_at=null, invalid_at=null`，保留原句的文本时间限定；null不表示今天仍成立。`L`：稳定事实或偏好也为 `null/null`，不臆造开始时间或永恒有效。`I(i)`：当前临时状态的 `valid_at=T(i)` 为观察点，未知结束时 `invalid_at=null`，正文写来源日期；不猜真正开始时间。逐窗有明确期间或瞬时边界时覆盖这些缩写。
- 期间均取来源的 `+00:00` 偏移：本轮“昨天”为2026-09-14，“周末”为 `[2026-09-19T00:00:00+00:00, 2026-09-21T00:00:00+00:00)`，“下周”为 `[2026-09-21T00:00:00+00:00, 2026-09-28T00:00:00+00:00)`。这些是**整个计划期间的有效边界**，不是断言活动恰在期间起点发生；不能任选周六、周日或一个参展日。只写日期的日程取所指日期次日零点，任职等持续状态不得据此臆造终止日。
- 日期沿用户2026-10-05已确认的口径：[原台账票](../memory-extraction-accuracy/issues/11-release-ledger-and-next.md)第80–90行明确废弃“只有原文明示结束日期／期间才填 invalid_at”的旧规则；[现行domain-data](../../architecture/current/domain-data.md)第126–128行、[E提示](../../backend/src/notalone/memory_extraction/adapters.py)第83–104行为当前提取要求。瞬时状态的检索失效不得超过来源当天结束；未知持续期仍不套固定TTL。旧语用文档曾留过时句子，本轮已按既有决定同步，不需要用户再次决定同一规则，也不证明模型已遵守。
- “理想去向”只表示原三道门下、若维度已放行且来源核验支持、置信度≥0.7、风险在原白名单内时的 `auto/pending/none`。真实生产默认放行表仍为空，表中理想auto不代表已写业务记忆。[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)第26–38、52–64行。健康、借款、歧义、计划、请求、转述保持原风险／语用门，不能通过改 Gold 去掉模型实际风险标记。[采纳白名单](../../backend/src/notalone/memory_extraction/adoption.py)第50–53行、[语用分流](../../backend/src/notalone/memory_extraction/pragmatics.py)第60–88行。
- 分类允许集合是 Agent 对现有五类的语义核对，**尚待独立技术复核**，不是分类都算对。`relationship_note` 是未能归入其他类的关系资料，`common_fact` 是客观事实，`recent_state` 保留临时／未来性质，`preference` 需真实偏好，`taboo` 需确有应避内容；标签不能替代完整正文。[分类定义](../../architecture/current/domain-data.md)第114–124行、[E分类示例](../../backend/src/notalone/memory_extraction/adapters.py)第46–50行。

## 逐窗技术标注

### A01 — 复核：未知第三人部门

输入：`0 T contact`「他不是仓库管理员，他在采购部。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第8–17行。

- P1：未知第三人不是仓库管理员；P2：同一未知第三人在采购部。两项均 `subject=contact, source={0}, category={relationship_note}, report/reported/literal, L, 理想pending`。部门和职务属于第三人关系资料，身份未知须保留歧义。
- 等价：可合并为完整正负复句，两个命题分别计覆盖；“采购部门／采购部”可等价。禁止把第三人改成联系人、把否定对象换成用户或补具体人名、职级、任职起点。

### A02 — 指代：跨消息老李

输入：`0 C self`「老李最近忙吗？」`1 T contact`「他约我周末去钓鱼。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第20–25行。

- P1：老李向联系人提出周末钓鱼的邀约，联系人没有明示接受。`subject=contact, source={0,1}, category={relationship_note}`。必须保留老李、邀约对象和周末钓鱼，不从context的问题推出老李很忙。
- 允许标签分支待独立复核：①把**已经收到邀约**作为第一人称关系经历，`assertion/asserted/literal, H`，在无实质歧义或敏感风险且原门全部满足时理想auto；②把**老李发出的邀约／安排**作为转述，`report/reported/literal, H`，理想pending；③若正文改为尚待实现的钓鱼安排，`plan/asserted/literal`、整个周末期间边界、理想pending，但仍须说清仅是邀约，不能声称联系人已接受或双方已约定。
- 原句的关系内容可在不同分支获 raw 语义信用，分支的去向分开核；旧严格oracle的 reported/pending不是新的唯一技术答案。对①准确正文作保守pending只说明安全，不能冒充①完整契约满足。若以 `request` 描述第三人提出请求，须明确它不是当前说话者在向用户发请求，独审再核其字段适用性，暂不算已终冻完整契约。
- 邀约事实的 `H` 不把将来钓鱼时间写成邀约发生日期；活动期间分支不补确切钓鱼日、出发地点或接受状态。

### A03 — 指代：他借钱

输入：`0 T contact`「他昨天又跟我借钱了。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第28–33行。

- P1：身份不明第三人在2026-09-14又跟联系人借钱。`subject=contact, source={0}, category={relationship_note}, literal, H, 理想pending`。保留“又”，不编次数、金额或交付／还款状态。
- Agent允许 `report/reported`（第三人借钱关系的转述）或 `assertion/asserted`（联系人直接经历的借钱事件），待独审核对；两者都不得消除未知身份和借款风险，均不能auto。文本保持“向／跟联系人借钱”的方向，不把它反转为联系人向第三人借钱；仅“借钱了”不足以补已经实际交付。

### A04 — 指代：那个事

输入：`0 T contact`「那个事你先别跟别人说。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第35–41行。

- P1：来源时点，联系人请求用户暂不向别人透露所指但未识别的事项。`subject=contact, source={0}, category={relationship_note}, request/asserted/literal, I(0), 理想pending`。请求来自联系人，不能因执行请求的人是用户就改归self；事项未知，保留歧义。
- 分类取关系请求备注：禁止泄露给其他人不等于用户与联系人之间不能提及该话题，故不直接标为永久taboo。允许“暂时保密／先不要向别人说”且必须保留未识别事项和请求对象；不能补秘密正文、泄露已经发生或永久保密偏好。结束未知留null，不臆定当天结束。

### A05 — 指代：姐借车

输入：`0 T contact`「我姐把她的车借给我了。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第43–49行。

- P1：联系人作为接收方经历了姐姐把姐姐自己的车借给自己的事件；可写“联系人的姐姐把她自己的车借给了联系人”。`subject=contact, source={0}, category={relationship_note}, assertion/asserted/literal, H, 理想auto`，仍须通过原风险／置信度／来源门。
- 这是联系人本人作为接收方参与的第一人称经历，不能仅因句中出现姐姐就机械标纯第三人转述。姐姐所有权作为事件内必要归属保留，不另提永久资产资料。`b2e88d336558ac6dc3529d405343c93dfa85f183`加入第三人事件规则之后，`b207cfdaf77e950dd7258ca206ebb7bf3cb02129`仍入库此第一人称经历auto用例；这一历史顺序与现行E的本人经历定义共同支持本标注，并不单以旧分数证明正确。[E语用定义](../../backend/src/notalone/memory_extraction/adapters.py)第29–34行。
- 允许主动／被动等价；禁止联系人拥有车、当前仍借用、车已归还、借用期限已知，或把车写成用户的。原审查包把此行断定为 report/reported/pending 的说法需纠正。

### A06 — 指代：机场等行李

输入：`0 C self`「你到机场了吗？」`1 T contact`「到了，正在等行李。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第51–57行。

- P1：联系人已经到机场。`subject=contact, source={0,1}, category={common_fact,relationship_note}, assertion/asserted/literal, H, 理想auto`。完成事实分类允许共同已知的客观经历或关系事件备注，不把它改成长期当前在机场状态。
- P2：2026-09-15来源时点联系人正在等行李。`subject=contact, source={1}`；正文还写“在机场等”时必须 `{0,1}`。`category={recent_state}, assertion/asserted/literal, valid_at=2026-09-15T00:01:00+00:00, invalid_at=2026-09-16T00:00:00+00:00, 理想auto`。
- 两项必须分开核完整契约；合并句可给两项 raw 语义信用，但历史到达与瞬时等待不能共用一个有效区间冒充完整正确。失效值是当天结束的检索边界，非等待实际结束时刻；其他更早失效值除非有额外原句证据，不因“未晚于当天”就接受任意值。禁止补航班、到达钟点、已取行李或查询时仍在等待。

### A07 — 指代：他们来家

输入：`0 T contact`「他们周末要来家里。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第59–65行。

- P1：未知“他们”计划在来源所指周末来所指家里。`subject=contact, source={0}, category={recent_state,relationship_note}, plan/asserted/literal, valid_at=2026-09-19T00:00:00+00:00, invalid_at=2026-09-21T00:00:00+00:00, 理想pending`。未来安排或第三人关系备注两类均不得改变期间和歧义。
- 保留来访者身份和家属归属未知；期间覆盖只表示周末，不声称周六零点来访。禁止补具体人、用户也参与、双方已确认、已经到访或房屋所有者。

### A08 — 指代：那本书

输入：`0 C self`「你上次说的那本书叫什么？」`1 T contact`「《活着》，我刚看完。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第67–73行。

- P1：联系人刚读完《活着》。`subject=contact, source={1}`，可接受额外相连问题0但它不是必需来源；`category={common_fact,relationship_note}, assertion/asserted/literal, H, 理想auto`。分类为完成阅读经历或阅读关系备注，不是口味偏好。
- “刚读完／刚看完”等价，须保留书名和完成性质。禁止补喜欢、推荐、阅读起止日；原句的“刚”不能改成未来准备读。

### A09 — 指代：那人

输入：`0 T contact`「那人昨天又来了。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第75–81行。

- P1：未知第三人在2026-09-14又来了。`subject=contact, source={0}, category={relationship_note}, report/reported/literal, H, 理想pending`；保留人物身份与到访地点未明的歧义。
- 可把昨天显式归一化为来源前一天，不能用实验当天替代；禁止联系人本人来了、具体次数、地点、拜访对象或任意人物身份。

### A10 — 指代：多第三方借钱

输入：`0 C self`「老李借你钱了吗？」`1 T contact`「借了，小王没借。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第83–89行。

- P1：老李的“借你钱”肯定项成立；P2：小王的对应借钱项否定。两项均 `subject=contact, source={0,1}, category={relationship_note}, literal, H, 理想pending`。允许 `report/reported` 或联系人作为参与者的 `assertion/asserted`，仍待独审；借款敏感性及借用方向歧义必须继续阻塞auto。
- 允许忠实合并正负复句；不能交换老李、小王或把其中一项丢掉。原“借你钱”可能指借给或向对方借，正文保留原关系措辞并明确方向未能唯一确定；不得擅定谁贷谁借、已交付金额或债务／还款状态。原oracle只有pending，不能宣称它已经固定方向。

### A11 — 指代：感冒好点

输入：`0 C self`「你感冒好点了吗？」`1 T contact`「好多了，谢谢关心。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第91–97行。

- P1：2026-09-15来源时点联系人的感冒明显好转。`subject=contact, source={0,1}, category={recent_state}, assertion/asserted/literal, I(1), 理想pending`；既有健康风险不改为无风险。
- “好多了／明显好转”等价；不能弱化为仅“感冒中”或增强为完全康复。不补发病时间、治疗、未知康复日；它不是“等行李”式瞬时状态，没有可推算终点时失效null，不套当天或七天TTL，也不声称查询当天仍然感冒。

### A12 — 指代：咱们那家店

输入：`0 T contact`「咱们上次说的那家店还去吗？」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第99–105行。

- 不生成必需主张，理想none，`speech_act=question`；category、subject、assertion_status、figurative和有效期作为不存在的候选字段不适用。保留来源0用于全部输出的禁止项审计，窗口仍计分母。
- 问句中的预设不认证共同到店经历、店名、地址、已约好同行或行程仍有效。不要从“咱们”加一个shared事实。[E排除规则](../../backend/src/notalone/memory_extraction/adapters.py)第69–74行。

### A13 — 指代：门票

输入：`0 C self`「门票买好了吗？」`1 T contact`「买好了，两张。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第107–113行。

- P1：所问门票已买好，共两张。`subject=contact, source={0,1}, category={common_fact,relationship_note}, assertion/asserted/literal, H, 理想auto`。这是联系人范围的完成结果，不强指联系人亲自购买，不改为shared。
- 数量、对象和完成属于同一事件，分成两条时只有来源和事件联结足够、可完整恢复该命题才获覆盖一次；孤立“两张”不算完整。允许被动结果表达；禁止补票种、同行者、入场或购票人。

### A14 — 指代：发地址（仅纳入性待用户抽查）

输入：`0 T contact`「我等下把地址发你。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第115–121行。

- **未选纳入分支。** 若按现行E“一次性安排的细节不要输出”，本窗none且无必需命题，仍在21窗分母；若保留有关系用途的短期承诺，P1为联系人稍后向用户发送地址的计划，`subject=contact, source={0}, category={recent_state}, plan/asserted/literal, 理想pending`。
- 纳入分支的“等下”没有可唯一推算的钟点或明确终止期间，`valid_at=null, invalid_at=null`，正文保留来源日期及相对措辞，不任意把动作钉在当天某时刻。此不确定值的适用性也待独立技术复核，不能借null宣称永久有效。
- 用户只需回答这一实际取舍：“这类只服务本次交流的稍后发地址动作，是否需要形成待确认资料？”无须选择枚举、日期或其他技术字段。两个分支对旧pendingoracle的差异预先保留，不通过删除窗口或运行后改答案救分。禁止地址已发送、地址具体内容、发给第三人或长期会发地址的习惯。

### A15 — 指代：借书看完

输入：`0 T contact`「你上次借我的书我看完了，谢谢。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第123–129行。

- P1必需：联系人已经读完所指书。`subject=contact, source={0}, category={common_fact,relationship_note}, assertion/asserted/literal, H, 理想auto`；书名未知不影响“读完”的已完成性质，不补书名。
- 可选P2：用户和联系人之间存在原句所指借书关系；`subject=contact, source={0}, category={relationship_note}, literal, H, 理想pending`，方向／所有权歧义保留，`assertion_status=unknown`，允许关系转述report或本人经历assertion但均不auto。只获得可选审计信用，不算必需补漏；不因这一歧义把确定读完事实全部丢弃。
- 禁止擅定出借人、借入人、书的所有者、归还状态或实际借用日期；不能从“谢谢”推出喜欢该书或双方共同阅读。

### A16 — 指代：面试结果

输入：`0 C self`「那个面试怎么样了？」`1 T contact`「过了，下周一入职。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第131–137行。

- P1：联系人通过所问面试。`subject=contact, source={0,1}, category={common_fact,relationship_note}, assertion/asserted/literal, H, 理想auto`。
- P2：联系人计划在2026-09-21（下周一）入职。`subject=contact, source={0,1}, category={recent_state}, plan/asserted/literal, valid_at=2026-09-21T00:00:00+00:00, 理想pending`。若命题为一次**入职日程**，当前“只写日期日程”的规则给 `invalid_at=2026-09-22T00:00:00+00:00`，这是入职安排退出检索边界，不是任职结束日；此技术分支待独审。若正文表达**从周一起持续任职的预期状态**，实际任职持续期未知，invalid_at=null，不允许把两种正文混用同一Gold。旧严格oracle的invalid=null继续原样报告。[旧严格期望](../../backend/src/notalone/memory_extraction/evaluation_cases.py)第65–71行、[当前日程日期规则](../../backend/src/notalone/memory_extraction/adapters.py)第95–101行。
- 两命题语用不同，完整契约必须分别标注；忠实复句可给raw语义信用。禁止补公司、职位、已入职、面试通过日期或周二离职。

### A17 — 严格：门票省略数量

输入：`0 C self`「展览门票买好了吗？」`1 T contact`「买好了，两张。」[语义case](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)第109–115行。

- P1：所问展览门票已买好，共两张。`subject=contact, source={0,1}, category={common_fact,relationship_note}, assertion/asserted/literal, H, 理想auto`。与A13同类完成结果，展览对象必须从context恢复。
- 允许被动结果而不强造购买人；两张票的对象、数量和完成必须同属该事件。禁止三张票、双方各两张、已看展、具体展名、同行人或认为购买人必为联系人。不能把旧主动句正则当作实际执行者证据。

### A18 — 严格：跨消息第三人

输入：`0 C self`「老陈现在住哪里？」`1 T contact`「他住天津，我住重庆。」[语义case](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)第149–159行。

- P1：老陈住天津。`subject=contact, source={0,1}, category={relationship_note}, report/reported/literal, L, 理想pending`。第三人的居住关系资料，不是联系人自己住天津。
- P2：联系人住重庆。`subject=contact, source={1}`，允许相连问题0但非必需；`category={common_fact}, assertion/asserted/literal, L, 理想auto`。
- 两项主体人物及语用不同，完整契约分别标注；合并只能获得分别可定位的raw内容信用。禁止交换城市／人物、变成籍贯、补居住起点，或用一个assertion让老陈的第三人信息auto。

### A19 — 严格：跨话题拼接

输入：`0 T contact`「我平时喜欢喝红茶。」`1 T contact`「另外，下周计划去厦门参展。」[语义case](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)第202–212行。

- P1：联系人平时喜欢喝红茶。`subject=contact, source={0}, category={preference}, assertion/asserted/literal, L, 理想auto`。这是明确习惯偏好，不能删“平时”改成某次体验。
- P2：联系人计划在2026-09-21至2026-09-27期间去厦门参展。`subject=contact, source={1}, category={recent_state}, plan/asserted/literal, valid_at=2026-09-21T00:00:00+00:00, invalid_at=2026-09-28T00:00:00+00:00, 理想pending`；边界覆盖整个下周，具体出发、参展和返回日未知。
- 不同话题分别输出；不能拼成喜欢去厦门喝茶、已在厦门参展或周一必定出发。旧期望空日期和新期间边界差异单列，不运行后补改。

### B01 — 严格：报价判断与条件咨询

输入：`0 C contact`「你怎么看那家泥塑体验课的报价？」`1 T self`「我觉得两次课90元挺合适，不过报不报名还没决定。」`2 T self`「如果周末有空，我只去问场地是否能借工具。」[语义case](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)第223–251行。

- P1：用户认为两次泥塑体验课90元的这一报价合适。`subject=self, source={0,1}, category={relationship_note}, assertion/asserted/literal, H, 理想auto`。仅此课程报价判断，不是长期价格偏好，不能照抄受控payload的preference。
- P2：2026-09-15来源时点，用户尚未决定是否报名该泥塑体验课。`subject=self, source={0,1}, category={recent_state}, assertion/asserted/literal, I(1), 理想auto`。明确自述的决定状态，不是语用unknown或V证据不足；结束未知留null，不删掉“不报名尚未决定”这项难例。
- P3：用户仅在来源所指周末有空时，去询问场地能否借工具。`subject=self, source={2}`；若正文明确场地属于该课程，接受必要集合 `{0,2}` 或 `{0,1,2}`。`category={recent_state}, plan/conditional/literal, valid_at=2026-09-19T00:00:00+00:00, invalid_at=2026-09-21T00:00:00+00:00, 理想pending`。期间不能表达成用户已确定有空或某日必去。
- 三项分别核完整字段；P1＋P2的忠实合并可获两个raw命题覆盖，但历史报价判断和当前决定状态的时间不同，单一有效期不证明二者完整正确。P3不同语用不能合成一个assertion。禁止已决定报名、长期偏好90元课程、一定咨询、场地能借或实际借过工具；“只去问”不能扩成购买／报名／借用意向。相同条件句的忠实否定／仅限表达可等价。

### B02 — 严格：第三人历史经历与当前未知

输入：`0 T contact`「2024年暑假，我表弟曾在社区读书会负责活动主持。」`1 C self`「你表弟现在做什么工作？」`2 T contact`「现在他做什么工作，我不知道。」[语义case](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)第253–276行。

- P1：联系人的表弟在2024年暑假曾负责社区读书会活动主持。`subject=contact, source={0}, category={relationship_note}, report/reported/literal, H, 理想pending`。年份／暑假／曾经须保留；“暑假”不能推成统一精确开始／结束日，valid/invalid明确null。
- P2：2026-09-15来源时点，联系人不知道表弟当前做什么工作。`subject=contact, source={1,2}` 或 `{0,2}`；两种来源都包含知识状态target2和明确的表弟指代依据。`category={recent_state,relationship_note}, assertion/asserted/literal, I(2), 理想auto`。近期知识状态或本人知识关系备注的两种分类都不得丢掉观察日期与未知对象；结束未知null，待独审核分类允许集合。
- 明确的“不知道”是联系人自述的知识状态，非模型source uncertain；两个命题分别标注，不能用一个assertion将历史第三人经历升级auto。忠实复句可获分开的raw内容信用，但混合report／assertion不获整条完整契约认证。禁止联系人自己主持、表弟目前仍主持、表弟失业、联系人不知道自己的工作或补2024暑假具体日期。

## 等价、全量输出审计与执行边界

1. 先按以上原句独立语义核对，固定允许正文、必须限定、来源集合、分类与标签分支，再冻结；不先看新模型输出来放宽答案。整理者已见旧oracle的事实始终保留，独立复核不能冒充首次盲标。
2. 同义词、主动／被动和忠实拆合可以获得**raw语义覆盖**；数量、否定、条件、相对时间、完成性质和人物角色不得丢。无明确购买／维修执行者时保留结果，不能强写动作人。主张分母按独立命题，不按输出条数；重复无额外信用，但全部额外输出逐条审计。
3. **程序接受覆盖、完整契约覆盖另报**；混合语用／时间不得用单一字段统一通过，保守pending不等于满足可auto事实的完整契约。A02/A03/A10标签允许集、A16日程／持续状态分支等仍待独立技术复核，不把“尚未最终冻结”改写成“21窗技术字段全部已认证”。[核心spec](../memory-core-claim-retention/spec.md)第15–23、74–79行、[E拆分要求](../../backend/src/notalone/memory_extraction/adapters.py)第76–78行。
4. 旧 `evaluate_case` 正则结果保持原样，并与本技术语义审计分开：当前“不匹配旧严格期望的auto”会直接进入程序 `false_fact`，其中可能有同义、分类、标签或已变更日期口径的差异，不能全部称确定的现实语义造假。[评分器](../../backend/src/notalone/memory_extraction/evaluation.py)第174–211行。反之，确定坏auto、记错人不能被这些差异掩盖。
5. A14纳入性未得到实际答复，技术允许集也未独审终冻，当前真实ECNU执行继续关闭。Agent核对不代替人工抽查记录、新完整计划／配置／源码哈希冻结或最终runner审查；不启动供应商，不复开旧预算，不写业务或改变生产放行。本文不宣称新的模型成绩，旧实际6/12与原07的0/5验收均不改。

## 本文件的验证和数据影响

仅读取已提交公开合成输入、任务、架构、代码与上述两处历史提交；只新建本文。在Conda `NotAlone` 中以 `NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 python -I` 的标准库静态脚本核对21窗标题／顺序／公开case名称、42处本地链接可达，以及28个当前必需候选＋A14待定1个＋A15可选1个的算术；没有导入项目或SDK。另以文件文本检查确认无尾随空白；`git diff --check -- .scratch/unfinished-work/memory-gold-agent-annotations-20261012.md` 返回0，但新文件尚未暂存，该Git检查不能替代本文文本检查。模型／SDK网络／App／微信／OCR／业务数据库调用均0；未读取秘密、私有模型返回或真实聊天。子Agent不创建提交，独立复核与任务专属本地提交由主Agent承接。

主Agent最终静态核对已确认本文21窗名称／顺序及28个已列必需候选算术，本文42处本地链接目标可达；6份本主题文档合计147处目标可达，历史原票前缀／验收及提取源码／放行台账不变。文档独立审查只能确认标注来源、候选边界和记录准确，不能替代尚未完成的逐字段技术终冻或模型质量验收。
