# 21窗来源保真修订 v2（2026-10-16）

> 状态：source-fidelity revision v2；Root已完成独立Standards／Spec审查，均0项。已见旧oracle及旧结果，非盲标，quality_certified=false。仅参考装配具备固定协议接入资格，不认证模型质量或维度放行。

本版基于[原21判据](memory-gold-agent-annotations-20261012.md)与原JSON，旧材料、freeze、审核及成绩原件不改，不按新参考重算旧结果。仅A05产权、直接相关歧义通则及版本来源说明变化；其余窗口、全部输入／target／来源选择、28必需＋A15可选1不变。A14原有人类none仅覆盖其纳入性，不扩大人工认证。

修订依据为已批准[D2合同](goal-memory-dimension-proof-interface-decision-20261013.md)第87行：A05没有Identity，姐姐出借与联系人接收明确，车主未知；R105受益人未知已有正确判据，不改。编译器或来源逐字保留不能代签产权，typed scope不足也不能抹去普通字段已有角色。真实入口、模型预算、原三门与默认空表均不变。

## 核对方法和统一字段

- 固定21窗：A01–A16为现行 reference 主集，A17–A19为公开语义补充，B01–B02为核心公开观察。窗口不删、不补位。旧公开 holdout 只作回归，不当作新留出。
- 下文每个 `P` 为一个必需独立命题；语义相同的重复输出不增加覆盖。A15借书关系只作可选审计；A14依实际用户答复无必需命题，窗口仍保留。当前整理为**28个已列必需命题＋A15可选1个**，该数字经装配核对保留；A14用户回答仍只覆盖其纳入性，不扩大逐字段人工认证。
- `source` 为窗内零起始索引。每个实际消息ID为 `uuid5(NAMESPACE_URL, f'notalone-evaluation/{case.name}/{i}')`，时间 `T(i)=2026-09-15T00:00:00+00:00+i分钟`；至少有一条 target，不可用 context 单独制造事实。来源集合无顺序要求，可接受集合在各窗注明；无关额外来源仍是引用缺陷，不靠堆来源获得信用。[build_window](../../backend/src/notalone/memory_extraction/evaluation.py)第81–98行、[E来源规则](../../backend/src/notalone/memory_extraction/adapters.py)第108–112行。
- `subject` 表示资料归属：`self` 是 owner 本人范围，`contact/shared` 为当前联系人范围；第三人的称呼必须写在命题中，不能因 subject=contact 把第三人写成联系人。合成 owner/contact 分别为 `uuid5(NAMESPACE_URL, 'notalone-evaluation/owner')` 和 `uuid5(NAMESPACE_URL, 'notalone-evaluation/contact')`，不是实际身份或联系人授权。
- 来源保真修订：出借施事不证明物品产权；来源没有明确唯一指称句时，保留可核行动角色与已发生阶段，物品归属保持未知，非空alternatives须明确具体未解关系，不补Identity、反向产权或现实认证。typed proof的范围／可信前提UNKNOWN不一概否定普通正文中已有来源的角色和阶段。
- 所有下列保留命题的 `figurative_type=literal`；未知人物、对象或借用方向属于内容歧义，不等于修辞 unknown。实质歧义可在 `alternatives` 中保留确有依据的备选，不补身份或新事件。
- `H`：已完成历史事实的 `valid_at=null, invalid_at=null`，保留原句的文本时间限定；null不表示今天仍成立。`L`：稳定事实或偏好也为 `null/null`，不臆造开始时间或永恒有效。`I(i)`：当前临时状态的 `valid_at=T(i)` 为观察点，未知结束时 `invalid_at=null`，正文写来源日期；不猜真正开始时间。逐窗有明确期间或瞬时边界时覆盖这些缩写。
- 期间均取来源的 `+00:00` 偏移：本轮“昨天”为2026-09-14，“周末”为 `[2026-09-19T00:00:00+00:00, 2026-09-21T00:00:00+00:00)`，“下周”为 `[2026-09-21T00:00:00+00:00, 2026-09-28T00:00:00+00:00)`。这些是**整个计划期间的有效边界**，不是断言活动恰在期间起点发生；不能任选周六、周日或一个参展日。只写日期的日程取所指日期次日零点，任职等持续状态不得据此臆造终止日。
- 日期沿用户2026-10-05已确认的口径：[原台账票](../memory-extraction-accuracy/issues/11-release-ledger-and-next.md)第80–90行明确废弃“只有原文明示结束日期／期间才填 invalid_at”的旧规则；[现行domain-data](../../architecture/current/domain-data.md)第126–128行、[E提示](../../backend/src/notalone/memory_extraction/adapters.py)第83–104行为当前提取要求。瞬时状态的检索失效不得超过来源当天结束；未知持续期仍不套固定TTL。旧语用文档曾留过时句子，本轮已按既有决定同步，不需要用户再次决定同一规则，也不证明模型已遵守。
- “理想去向”只表示原三道门下、若维度已放行且来源核验支持、置信度≥0.7、风险在原白名单内时的 `auto/pending/none`。真实生产默认放行表仍为空，表中理想auto不代表已写业务记忆。[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)第26–38、52–64行。健康、借款、歧义、计划、请求、转述保持原风险／语用门，不能通过改 Gold 去掉模型实际风险标记。[采纳白名单](../../backend/src/notalone/memory_extraction/adoption.py)第50–53行、[语用分流](../../backend/src/notalone/memory_extraction/pragmatics.py)第60–88行。
- 分类沿现有五类和独审意见收紧：completed客观完成结果用 `common_fact`，临时状态／未来安排用 `recent_state`，亲友关系动态用 `relationship_note`，明确偏好才用 `preference`，确有应避内容才用 `taboo`。不把无法归类的关系备注当作所有其他分类的完整正确兜底；标签不能替代完整正文。A02仅按其三个语义组合分别确定分类。[分类定义](../../architecture/current/domain-data.md)第114–124行、[E分类示例](../../backend/src/notalone/memory_extraction/adapters.py)第46–50行。

## E 输出的14字段通用判据

公开工具返回外层只有 `facts`；每项必须含下表14字段，不能用字符串替代事实对象、漏字段或加写入动作。没有应记主张时 `facts=[]`。公开schema的合法性、原外壳接受、本文语义参考是三层检查；宽解析器接受不代表输出符合工具schema。本节列判据，未修改运行时。[E schema](../../backend/src/notalone/memory_extraction/adapters.py)第120–265行、[原事实类型校验](../../backend/src/notalone/memory_extraction/models.py)第89–155行。

| 字段 | 合法形态与本批语义判据 |
| --- | --- |
| `text` | 非空字符串；依逐命题必要含义和等价边界核对，不要求唯一逐字模板。不增加人物、行为人、事实阶段、因果、数量、条件或未知期限；保留必要否定与日期／期间。 |
| `category` | 单个现有枚举：`common_fact/preference/taboo/recent_state/relationship_note`；按逐命题单类或A02明确分支匹配，不能填topic或自由类别。 |
| `subject` | 单个 `self/contact/shared`；按逐命题资料归属。第三人事实仍须在正文保留第三人，双方讨论同一物品不自动变shared。 |
| `topic` | 单个 `health/work/family/travel/finance/study/emotion/other`；按下方有限主题映射。粗筛主题不证明身份、工作、财务交易或亲属角色，也不自动形成同名风险。 |
| `source_message_ids` | 非空字符串数组，每项为本窗消息UUID，满足逐命题必要source集合及至少一个target；不得借用别窗或无关来源。按照集合核语义支持，但重复引用另报，不增加覆盖。 |
| `confidence` | JSON number，有限且在 `[0,1]`；bool、null、字符串不是schema要求的number。保留模型实际数值，不编造固定0.8或逐命题唯一Gold分数。明确直接证据的E指导是≥0.8，原自动采纳门是≥0.7；低分导致pending与正文是否准确分开报告，不能为了过auto门改分。 |
| `risk_flags` | 字符串数组，可为空；项须非空字符串。必须忠实保留已有借款／健康风险及实际运行添加的阻塞项，具体允许／禁止见下方风险规则。不能把它变成采纳动作或新增受控枚举。 |
| `valid_at` | JSON null或带时区ISO8601字符串；按 `H/L/I(i)` 与逐命题明确日期，使用来源偏移而非实验当天。观察点不是已证明的实际开始时刻，期间起点不是活动恰在该刻发生。 |
| `invalid_at` | JSON null或带时区ISO8601字符串；明确政策边界和未知持续期按逐命题核对。两端都有值时须 `invalid_at>valid_at`，区间为半开。null不能写成空字符串或字符串“null”，检索失效不得写成真实离职／行为结束已证明。 |
| `speech_act` | 单个 `assertion/plan/question/request/report/correction/unknown`；依逐命题固定或有限组合，不能仅因“还没发生”把所有计划统称假设。none窗不补伪候选。 |
| `assertion_status` | 单个 `asserted/hypothetical/conditional/reported/unknown`；与对应speech/body组合绑定。明确未决定／不知道是自述状态的asserted，非模型证据不足；真实条件仍conditional。 |
| `figurative_type` | 单个 `literal/joke/sarcasm/hyperbole/unknown`；本批保留命题均literal。未知第三人／借用方向不变成修辞unknown，不补原句没有的玩笑或讽刺。 |
| `alternatives` | 字符串数组，非空项；确有内容歧义的必填范围及明确命题应空规则见下表。是少量用户可见备选解释，不是自由补故事或内部思考。 |
| `interpretation_reason` | 非空字符串，简短面向用户，说明原句与标签／来源的对应依据；不要求唯一措辞或固定字数。schema写字符串、Fact类型仅验字符串，但原Flow转换另要求非空，空值应记结构／转换失败，不能补理由冒充完整通过。不得与正文／标签／主体相矛盾，不含长链推理、模型内部思考、秘密或本窗外事实。 |

14字段是原工具对象，`timing` 等运行元数据不属于工具输出，不补入schema；confidence／reason等数值或文案不由 Agent 替模型造出来。结构合法只能证明接口，正确去向仍需原语用／风险／来源门及独立语义审核。[原Flow转换](../../backend/src/notalone/memory_extraction/flow.py)第415–445行。

## 逐窗技术标注

### A01 — 复核：未知第三人部门

输入：`0 T contact`「他不是仓库管理员，他在采购部。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第8–17行。

- P1：未知第三人不是仓库管理员；P2：同一未知第三人在采购部。两项均 `subject=contact, source={0}, category={relationship_note}, report/reported/literal, L, 理想pending`。部门和职务属于第三人关系资料，身份未知须保留歧义。
- 等价：可合并为完整正负复句，两个命题分别计覆盖；“采购部门／采购部”可等价。禁止把第三人改成联系人、把否定对象换成用户或补具体人名、职级、任职起点。

### A02 — 指代：跨消息老李

输入：`0 C self`「老李最近忙吗？」`1 T contact`「他约我周末去钓鱼。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第20–25行。

- P1：老李向联系人提出周末钓鱼的邀约，联系人没有明示接受。`subject=contact, source={0,1}`，category与其余字段绑定到下列具体组合。必须保留老李、邀约对象和周末钓鱼，不从context的问题推出老李很忙。
- 预注册下列三种正文／字段组合，同属P1的一个覆盖机会，不拆成三个分母；各组合不能混用标签与日期。它们是 Agent 的明确候选允许集合，仍由独立技术审查核定，不以新模型输出决定增删。

  | 组合 | 可接受正文的必要含义 | 固定字段与理想去向 |
  | --- | --- | --- |
  | A02-事实 | 联系人已收到老李邀请，邀请内容是周末钓鱼；原句未说明是否接受。 | `subject=contact, source={0,1}, category=relationship_note, assertion/asserted/literal, valid_at=null, invalid_at=null`；原门无其他阻塞时理想auto。 |
  | A02-转述 | 据联系人陈述，老李向联系人提出了周末钓鱼的邀约；不把邀约改成双方已约定。 | `subject=contact, source={0,1}, category=relationship_note, report/reported/literal, valid_at=null, invalid_at=null`；理想pending。 |
  | A02-安排 | 老李提出邀联系人周末钓鱼的安排，仅是第三方邀约，联系人参与未确定。 | `subject=contact, source={0,1}, category=recent_state, plan/asserted/literal, valid_at=2026-09-19T00:00:00+00:00, invalid_at=2026-09-21T00:00:00+00:00`；理想pending。 |

- `asserted` 在安排组合中只承诺“邀约安排已表达”，不承诺活动必发生；原句没有联系人已接受或自己决定去钓鱼的证据。若只有“联系人周末去钓鱼”而丢掉邀约与参与未定，不属于任何组合。原句关系内容在符合以上必要含义时获 raw 语义信用，完整契约按对应组合核；其他合理但未列明的表达保守留pending审计，完整契约标未决，不能未经冻结将其升级为通过。
- 当前说话者是在描述邀约，不是在向用户发起请求，本次不将 `request` 列为完整契约允许标签；准确保守的请求式输出仍保存和分项审计。旧严格oracle的 reported/pending继续原样报告，不作新标注唯一锚。对事实组合的准确正文作保守pending只说明安全，不能冒充该组合完整契约满足；安排组合的未来期间也不得改作“已经收到邀请”的发生日期。

### A03 — 指代：他借钱

输入：`0 T contact`「他昨天又跟我借钱了。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第28–33行。

- P1：身份不明第三人在2026-09-14又跟联系人借钱。`subject=contact, source={0}, category={relationship_note}, literal, H, 理想pending`。保留“又”，不编次数、金额或交付／还款状态。
- 预注册正文含义为“身份不明的第三人在2026-09-14又向／跟联系人借钱，原句没有确定实际交付或还款状态”。完整允许字段对收束为 **`(report,reported)`**，固定 `subject=contact, source={0}, category=relationship_note, figurative_type=literal, valid_at=null, invalid_at=null, 理想pending`；未知“他”沿E第61–66行的第三人规则，`alternatives` 必须说明具体人物无法定位，不补某位亲友姓名或角色。A05的姐姐身份和第一人称接收经历明确，不能据此豁免本窗未知“他”的规则。借款敏感性与人物身份未知保留在原风险／歧义门，任何auto均不符合本窗理想去向。之前允许assertion/asserted的技术候选未最终冻结，现依独审纠正，不改旧oracle。
- “跟我借钱”支持第三人向联系人借，不允许反转为联系人向第三人借；但实际借款已交付、仅提出请求或已经结清均未唯一确定。正文只用有据的原借钱措辞；输出若明确补其中一种交易完成状态，即使pending也不获得完整正文信用。`unknown` 标签的保守输出可保留安全审计，不自动扩入预注册完整契约集合。

### A04 — 指代：那个事

输入：`0 T contact`「那个事你先别跟别人说。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第35–41行。

- P1：来源时点，联系人请求用户暂不向别人透露所指但未识别的事项。`subject=contact, source={0}, category={relationship_note}, request/asserted/literal, I(0), 理想pending`。请求来自联系人，不能因执行请求的人是用户就改归self；事项未知，保留歧义。
- 分类取关系请求备注：禁止泄露给其他人不等于用户与联系人之间不能提及该话题，故不直接标为永久taboo。允许“暂时保密／先不要向别人说”且必须保留未识别事项和请求对象；不能补秘密正文、泄露已经发生或永久保密偏好。结束未知留null，不臆定当天结束。

### A05 — 指代：姐借车

输入：`0 T contact`「我姐把她的车借给我了。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第43–49行。

- P1：联系人作为接收方经历姐姐把原句所称“她的车”借给自己的事件；姐姐为出借施事、联系人为接收方，借用已发生，但物品车主未知，“她”缺明确唯一指称句。`subject=contact, source={0}, category={relationship_note}, assertion/asserted/literal, H, 理想pending`。
- 可保留原句或忠实主动／被动表达；不能把“她的车”改成“姐姐自己的车”，也不能反向断言车不属于姐姐。`alternatives`必须非空，明确物品车主／归属未知及“她”无法唯一指称，不编另一个具体所有人；仅泛称其他未决解释不足以明确这项关系。
- 本人参与的已发生经历及亲友关系动态保持，不机械改report/reported，不捏造金融风险。禁止联系人／用户拥有车、已归还、当前仍借用、期限已知或永久资产转移。未名产权保持UNKNOWN，不补Identity；本版不把有限typed proof范围不足等同于所有普通正文角色错误。

### A06 — 指代：机场等行李

输入：`0 C self`「你到机场了吗？」`1 T contact`「到了，正在等行李。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第51–57行。

- P1：联系人已经到机场。`subject=contact, source={0,1}, category={common_fact}, assertion/asserted/literal, H, 理想auto`。这是明确的客观完成结果，不用关系备注兜底，也不改成长期当前在机场状态。
- P2：2026-09-15来源时点联系人正在等行李。`subject=contact, source={1}`；正文还写“在机场等”时必须 `{0,1}`。`category={recent_state}, assertion/asserted/literal, valid_at=2026-09-15T00:01:00+00:00, invalid_at=2026-09-16T00:00:00+00:00, 理想auto`。
- 两项必须分开核完整契约；合并句可给两项 raw 语义信用，但历史到达与瞬时等待不能共用一个有效区间冒充完整正确。失效值是当天结束的检索边界，非等待实际结束时刻；其他更早失效值除非有额外原句证据，不因“未晚于当天”就接受任意值。禁止补航班、到达钟点、已取行李或查询时仍在等待。

### A07 — 指代：他们来家

输入：`0 T contact`「他们周末要来家里。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第59–65行。

- P1：未知“他们”计划在来源所指周末来所指家里。`subject=contact, source={0}, category={recent_state}, plan/asserted/literal, valid_at=2026-09-19T00:00:00+00:00, invalid_at=2026-09-21T00:00:00+00:00, 理想pending`。这是有限期间的未来安排，不能用relationship_note规避近况分类或时间要求。
- 保留来访者身份和所指家里归属未知；期间覆盖只表示周末，不声称周六零点来访。禁止补具体人、用户也参与、双方已确认、已经到访或房屋所有者。

### A08 — 指代：那本书

输入：`0 C self`「你上次说的那本书叫什么？」`1 T contact`「《活着》，我刚看完。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第67–73行。

- P1：联系人刚读完《活着》。`subject=contact, source={1}`，可接受额外相连问题0但它不是必需来源；`category={common_fact}, assertion/asserted/literal, H, 理想auto`。这是明确的完成阅读经历，不是口味偏好或无法归类的关系备注。
- “刚读完／刚看完”等价，须保留书名和完成性质。禁止补喜欢、推荐、阅读起止日；原句的“刚”不能改成未来准备读。

### A09 — 指代：那人

输入：`0 T contact`「那人昨天又来了。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第75–81行。

- P1：未知第三人在2026-09-14又来了。`subject=contact, source={0}, category={relationship_note}, report/reported/literal, H, 理想pending`；保留人物身份与到访地点未明的歧义。
- 可把昨天显式归一化为来源前一天，不能用实验当天替代；禁止联系人本人来了、具体次数、地点、拜访对象或任意人物身份。

### A10 — 指代：多第三方借钱

输入：`0 C self`「老李借你钱了吗？」`1 T contact`「借了，小王没借。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第83–89行。

- P1预注册正文：老李与联系人之间原问的“借你钱”事项肯定成立，方向未明；P2预注册正文：小王没有原问所指的对应借钱事项，方向同样未明。两个命题分别固定 `subject=contact, source={0,1}, category=relationship_note, figurative_type=literal, valid_at=null, invalid_at=null, 理想pending`。每个命题允许字段对仅为 `(report,reported)`（第三人关系的转述）或 `(assertion,asserted)`（联系人参与事件的直接陈述）；不交叉混为 report/asserted 或 assertion/reported 来获得完整字段信用。
- 允许忠实合并正负复句，但每个命题和角色仍分别计覆盖；文本保持借用方向未明，必须在非空 `alternatives` 保留方向歧义，用户可见说明可同时解释“第三人向联系人借／第三人借给联系人”两个有据读法，不能断定其中之一。借款敏感性和方向歧义必须保持原门pending，任何auto均不符合本窗理想去向。禁止交换老李、小王、丢掉否定、擅定贷方／借方、已交付金额、债务／还款状态。旧oracle只有pending，不能宣称它已经固定方向；其他未列标签只记安全／字段差异，待技术判断，不补为完整通过。

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

- P1：所问门票已买好，共两张。`subject=contact, source={0,1}, category={common_fact}, assertion/asserted/literal, H, 理想auto`。这是联系人范围的完成结果，不强指联系人亲自购买，不改为shared。
- 数量、对象和完成属于同一事件，分成两条时只有来源和事件联结足够、可完整恢复该命题才获覆盖一次；孤立“两张”不算完整。允许被动结果表达；禁止补票种、同行者、入场或购票人。

### A14 — 指代：发地址（用户已抽查：不存关系资料）

输入：`0 T contact`「我等下把地址发你。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第115–121行。

- 本轮用户对“这类只服务本次交流的稍后发地址动作，是否需要形成待确认资料？”实际答复 **“不存成关系资料（推荐）”**。采用现行E排除一次性安排细节的判据，本窗**理想none、无必需命题**，仍在21窗窗口分母。
- source0保留用于全部输出审计；没有候选时category、subject、语用标签与有效期字段不适用，不补造空候选。原句的“稍后发地址”仍是未来动作；若模型输出忠实计划pending，raw含义可正确，但违反该窗的纳入判据，不能算完整契约通过，也不能以“没auto”冒充正确none。
- 旧case/oracle的pending保持不改，与本次已明确的none差异分别报告，不删窗口或运行后改答案。禁止地址已发送、具体地址正文、发给第三人或长期发地址习惯；用户本次答复只覆盖这一纳入选择，不代表确认所有窗口、技术字段或其他短期信息的统一排除政策。

### A15 — 指代：借书看完

输入：`0 T contact`「你上次借我的书我看完了，谢谢。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第123–129行。

- P1必需：联系人已经读完所指书。`subject=contact, source={0}, category={common_fact}, assertion/asserted/literal, H, 理想auto`；书名未知不影响“读完”的已完成性质，不补书名。
- 可选P2：用户和联系人之间存在原句所指借书关系；`subject=contact, source={0}, category={relationship_note}, literal, H, 理想pending`，方向／所有权歧义保留，`assertion_status=unknown`，允许关系转述report或本人经历assertion但均不auto。只获得可选审计信用，不算必需补漏；不因这一歧义把确定读完事实全部丢弃。
- 禁止擅定出借人、借入人、书的所有者、归还状态或实际借用日期；不能从“谢谢”推出喜欢该书或双方共同阅读。

### A16 — 指代：面试结果

输入：`0 C self`「那个面试怎么样了？」`1 T contact`「过了，下周一入职。」[reference](../../backend/src/notalone/memory_extraction/cases/reference.py)第131–137行。

- P1：联系人通过所问面试。`subject=contact, source={0,1}, category={common_fact}, assertion/asserted/literal, H, 理想auto`；客观完成结果不以关系备注兜底。
- P2只预注册为一次**入职日程**：联系人计划在2026-09-21（来源所指下周一）入职。固定 `subject=contact, source={0,1}, category=recent_state, plan/asserted/literal, valid_at=2026-09-21T00:00:00+00:00, invalid_at=2026-09-22T00:00:00+00:00, 理想pending`。当前“只写日期日程”的规则给次日零点检索失效；这不是证明周二离职。原文未提供持续任职期限，本轮不另新增“从周一起一直任职”主张或空失效的第二分支；准确计划若invalid=null，则记录完整日期契约缺失，而不是改答案迁就。旧严格oracle的invalid=null继续原样报告。[旧严格期望](../../backend/src/notalone/memory_extraction/evaluation_cases.py)第65–71行、[当前日程日期规则](../../backend/src/notalone/memory_extraction/adapters.py)第95–101行。
- 两命题语用不同，完整契约必须分别标注；忠实复句可给raw语义信用。禁止补公司、职位、已入职、面试通过日期或周二离职。

### A17 — 严格：门票省略数量

输入：`0 C self`「展览门票买好了吗？」`1 T contact`「买好了，两张。」[语义case](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py)第109–115行。

- P1：所问展览门票已买好，共两张。`subject=contact, source={0,1}, category={common_fact}, assertion/asserted/literal, H, 理想auto`。与A13同类完成结果，展览对象必须从context恢复。
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
- P2：2026-09-15来源时点，联系人不知道表弟当前做什么工作。`subject=contact, source={1,2}` 或 `{0,2}`；两种来源都包含知识状态target2和明确的表弟指代依据。`category={recent_state}, assertion/asserted/literal, I(2), 理想auto`。这是来源时点的本人知识状态，不能用relationship_note绕开近况性质或观察日期；结束未知null。
- 明确的“不知道”是联系人自述的知识状态，非模型source uncertain；两个命题分别标注，不能用一个assertion将历史第三人经历升级auto。忠实复句可获分开的raw内容信用，但混合report／assertion不获整条完整契约认证。禁止联系人自己主持、表弟目前仍主持、表弟失业、联系人不知道自己的工作或补2024暑假具体日期。

## 逐命题主题、风险、歧义与解释

下表覆盖28个必需命题和A15可选命题，A12/A14无候选字段。topic的少数允许集合是**预注册粗主题边界**，不是任意8类都通过；需随正文语义选择，不能因为主题与风险都可能含finance就把普通报价判断变成敏感借贷。

| 命题 | `topic` 有限允许值 | 依据和不得增强的边界 |
| --- | --- | --- |
| A01-P1、A01-P2 | `work` | 第三人职务／部门；不证明联系人职业。 |
| A02-P1三个组合 | `other` | 钓鱼邀约关系，未给旅行地点或工作目的；不把邀约增成已接受。 |
| A03-P1 | `finance` | 原借款事项，不补交易完成。 |
| A04-P1 | `other` | 未识别事项的暂时保密请求，不能猜内容主题。 |
| A05-P1 | `family` | 明确姐姐与本人借车关系动态；不推出资产转移或出行。 |
| A06-P1、A06-P2 | `travel` | 机场到达／等行李，未补航班。 |
| A07-P1 | `other` | 未知人来访所指家里，不能因“家里”推成这些人是家人。 |
| A08-P1 | `study` 或 `other` | 阅读完成，可归阅读／休闲粗主题；不证明学历、专业、学习动机或偏好。 |
| A09-P1 | `other` | 未知人的来访，地点／用途未知。 |
| A10-P1、A10-P2 | `finance` | 对应借钱事项的肯定／否定，保留方向歧义。 |
| A11-P1 | `health` | 原感冒好转状态，不补诊断／治疗。 |
| A13-P1 | `other` | 原门票类型未明，不补出游目的。 |
| A15-P1、A15-可选P2 | `study` 或 `other` | 所指书的阅读／借书关系；不补书名或学习动机。 |
| A16-P1、A16-P2 | `work` | 面试结果／入职日程，不补公司、职位或持续任期。 |
| A17-P1 | `other` | 展览门票完成结果，不凭门票补旅行或工作身份。 |
| A18-P1、A18-P2 | `other` | 住址城市，非出游／籍贯／工作推断。 |
| A19-P1 | `other` | 明确红茶偏好，八类未有单独食物类。 |
| A19-P2 | `travel` 或 `work` | 厦门行程或参展活动粗主题；work不证明任职，travel不补具体出发日。 |
| B01-P1 | `study` 或 `finance` | 课程报价判断，可按课程或价格主题粗筛；finance不等于实际付款、借款或金融高风险。 |
| B01-P2 | `study` | 课程报名尚未决定，不证明已在该机构学习。 |
| B01-P3 | `study` 或 `other` | 与原课程关联的条件咨询或单独场地咨询；正文写课程关联时仍满足原必要source，不补实际借工具。 |
| B02-P1 | `family` | 表弟的历史活动经历；不把主持经历变成当前职业。 |
| B02-P2 | `work` | 联系人不知道表弟当前职业的知识状态；不是失业事实，不能改成联系人自己的工作。 |

### risk_flags 的必须、可接受和禁止项

`risk_flags` 原schema不是受控枚举；下列是语义审核要求，不修改其字段或采纳白名单。

- **必须**：A03和A10两项保持借款敏感性，允许忠实标签如 `loan`、`financial`、`借款`，至少一个实际敏感标记须在原门白名单之外；A11保持健康敏感性，允许 `health` 或 `健康`。不得用空数组、none、low替换它们以把理想pending变auto。借款否定仍是财务关系资料，不因“小王没借”就剥去本窗风险范围。
- **可接受**：其他原句没有证实敏感风险的命题允许 `[]`，或原白名单中合法的非空无风险标记 `low/low_risk/none/无/低风险`。实际有来源支持的额外敏感标记可以保留；未知标记依原门阻止auto，不能为评分静默删除，但另记其语义依据或不必要降级。A05借车不等于借款，B01讨论90元报价不等于金融交易，不为这些合成原句捏造金融／健康等风险。
- **按运行层分别记录**：`pragmatic:report/reported/plan/request/conditional/unknown/ambiguous` 等标签只在对应语用或歧义确实存在时有据；来源／未来有效期／V uncertain生成的 `semantic:*`、`pragmatic:future_validity` 等保留实际程序来源。记录E原字段与外壳添加项的差异，不让模型理由替代确定性裁决。低风险也不抹去真实计划／请求／转述的pending分流。
- **禁止**：虚构疾病、负债、转账、私人地址或其他本窗未给风险；把实质风险填成白名单低风险；添加“用户已确认／已核验真相”等永久认证标签；改白名单或去掉实际阻塞。无必要的风险保守pending可以说明安全，却不是所有理想auto命题都已满足完整去向。

风险判定沿[原采纳白名单](../../backend/src/notalone/memory_extraction/adoption.py)第50–53行和[语用阻塞生成](../../backend/src/notalone/memory_extraction/pragmatics.py)第66–83行；`financial` 已有[公开行为测试](../../backend/tests/unit/memory_extraction/test_evaluation.py)第204–212行证明会留pending，文档未新增词表实现。

### alternatives 与 interpretation_reason

- **必须有真实歧义说明**：A01/A03/A09未知第三人身份，A04未识别事项，A05物品车主／“她”指称未知，A07未知“他们”及所指家里归属，A10借入／借出方向，A15可选借书方向／所有权。`alternatives` 须非空，且只保留原句真的容许的解释；身份无法定位时可直接说明“本窗无法唯一确定所指第三人”，不要求编两位具体人。A10可列“第三人向联系人借”与“第三人借给联系人”的两种读法，否定项的每种读法都保留小王没借，不能丢否定。
- **应为空**：其余确定命题的 `alternatives=[]`；B01条件与未决定、B02本人“不知道”分别已有确定标签／知识对象，不因未来未发生或说话人不知道某事实就凭空增加不同主体或现实猜测。A02各组合准确保留“仅邀约、接受未说明”后无须再猜已接受；A15必需读完主张保留“所指书”而不补书名，不能把可选借书角色歧义塞入这一已完成命题并称作同一完整参考。
- **简短理由**：说明可见原句的直接依据即可，如“回答沿上条问题指向同一面试，结果已完成，入职仍是未来安排”；这只是允许的示例，不是唯一模板。理由可解释观察日或政策检索边界，但不得把它写成原文证明实际开始／结束；不得与标签、正文、人物、source或备选解释矛盾。字段非空合法性与理由语义准确分别核验，不能要求模型输出内部推理来证明自己。

## V 输出四键与证据判据

每个实际进入核验的候选按当次输入顺序分配零起始 `candidate_index`；不是P编号，也不是只给正确候选编号。外层只有 `results`，每项只有以下四键，candidate数不超过原60上限。无可核验候选时V不执行，不伪造一次空核验通过。[V schema与提示](../../backend/src/notalone/memory_extraction/verification_adapters.py)第30–121、149–153行、[契约校验](../../backend/src/notalone/memory_extraction/verification.py)第70–260行。

| 字段 | 原合法性与语义判据 |
| --- | --- |
| `candidate_index` | 真正整数，不能bool；满足 `0<=index<len(实际待核验候选)`，每个输入候选恰一次，不重复、遗漏或越界。按index回填原候选，不按返回顺序猜编号。 |
| `verdict` | 单个 `supported/uncertain/unsupported`。supported表示完整原主张和其可见人物／限定／标签／时间均有来源支持；uncertain是证据不足或真实歧义；unsupported是矛盾或无支持。任何返回值都不认证现实世界真伪。 |
| `issues` | 数组，项只取 `meaning/subject/negation/degree/quantity/condition/time/pragmatics/disconnected_context/insufficient_evidence`。supported须 `[]`；uncertain和unsupported须至少一个受控issue，不能添加自由正文、写库动作或固定“已认证”状态。 |
| `evidence` | 数组，每项恰有 `message_id` 与 `quote`。ID为该candidate原 `source_message_ids` 内的本窗消息，quote为对应消息中真实非空逐字子串，不改字、补词或引用候选正文冒充聊天。supported必须至少一个target来源片段；uncertain／unsupported允许 `[]`，不得为凑证据引用candidate原来源之外的context。 |

逐字片段存在只证明字符出处：片段可能遗漏条件、反转否定或不支撑某角色。独立语义审核仍需核完整命题、必要来源和上述E字段；机械校验没有要求每个source必须返回一段quote，文档不编造这种已经实现的规则，也不把“有一段target”说成全部来源／限定都支持。日期的政策检索边界不等于原文真的宣布结束时刻；V若误拒符合现行政策的候选，记录准确候选损失与字段争议，不改Gold救分。

V当前可见候选包含text、subject、category、topic、source、两日期及三语用字段，**不包含confidence、risk_flags、alternatives、interpretation_reason**；不能宣称一次supported已检查完E全部14字段。[V实际序列化](../../backend/src/notalone/memory_extraction/verification_adapters.py)第262–286行。独审对这些遗漏字段照原E原输出另核，实际运行的reason/置信度/风险不由V或Agent代填。

V只降不升：supported继续原语用／风险／置信度门，reported、计划或健康／借款仍可pending；uncertain附加实际 `semantic:*` 风险，unsupported拒绝，不改候选正文、主体、来源或时间。结构／证据契约非法或核验失败时按原Flow批次失败记录，不把失败当none，也不为了补覆盖重提候选。[原Flow核验处理](../../backend/src/notalone/memory_extraction/flow.py)第270–369行。V模型和E模型可能相关误判，一条V输出不能为自身或E原答案签独立语义正确证明。

## 等价、全量输出审计与执行边界

1. 先按以上原句独立语义核对，固定允许正文、必须限定、来源集合、分类与标签分支，再冻结；不先看新模型输出来放宽答案。整理者已见旧oracle的事实始终保留，独立复核不能冒充首次盲标。
2. 同义词、主动／被动和忠实拆合可以获得**raw语义覆盖**；数量、否定、条件、相对时间、完成性质和人物角色不得丢。无明确购买／维修执行者时保留结果，不能强写动作人。主张分母按独立命题，不按输出条数；重复无额外信用，但全部额外输出逐条审计。
3. **程序接受覆盖、完整契约覆盖另报**；混合语用／时间不得用单一字段统一通过，保守pending不等于满足可auto事实的完整契约。独审后A03只留report/reported，A02和A10仍按明确有限组合，A16只留入职日程；旧版topic／风险／备选解释／理由与V判据的历史独审不认证本次A05修订；v2独审仍待Root组织，不把“可评审集合”改写成“21窗技术字段全部已认证”。[核心spec](../memory-core-claim-retention/spec.md)第15–23、74–79行、[E拆分要求](../../backend/src/notalone/memory_extraction/adapters.py)第76–78行。
4. 旧 `evaluate_case` 正则结果保持原样，并与本技术语义审计分开：当前“不匹配旧严格期望的auto”会直接进入程序 `false_fact`，其中可能有同义、分类、标签或已变更日期口径的差异，不能全部称确定的现实语义造假。[评分器](../../backend/src/notalone/memory_extraction/evaluation.py)第174–211行。反之，确定坏auto、记错人不能被这些差异掩盖。
5. A14纳入性已有实际答复，仍不代替其他技术字段的独审终冻；本版未接真实执行入口，旧执行与封存另记。Agent核对不代替新完整计划／配置／源码哈希冻结或最终runner审查；不启动供应商，不复开旧预算，不写业务或改变生产放行。本文不宣称新的模型成绩，旧实际6/12与原07的0/5验收均不改。

## v1审核记录与本版边界

原独审经过和历史通过记录保留在[原21判据](memory-gold-agent-annotations-20261012.md)，不扩大为v2新语义复审范围。提交`9d44e5fb`时本版仅完成作者来源修订，独立审查待Root组织；该切片的结构检查不认证中文语义、模型输出、完整质量或执行就绪。配套JSON只绑定本中文字节SHA，本文件不嵌自身或配套JSON最终摘要，避免循环。

## 2026-10-16 后继审核资格记录

Standards `grounded_eval_standards` 核9文件、绑定与不变性0项；Spec `grounded_eval_spec` 独立核实际source、contact sender／target 0、D2第87行及A05语义0项。本次语义复审仅A05及直接通则；full140核装配与不变性，其余139及R105延续旧独审。不是新盲标、现实真伪、模型质量、运行冻结或维度放行。

待审切片原件在本地提交`9d44e5fb`完整可达，其pending状态与旧摘要不作追溯改写。本次只如实更新审核元数据和固定绑定，窗口、输入、命题、分母、来源选择不变；旧成绩不重算。后继完整140固定协议另见[装配记录](../grounded-evaluation/full140-v4-reference-integration-20261016.md)。
