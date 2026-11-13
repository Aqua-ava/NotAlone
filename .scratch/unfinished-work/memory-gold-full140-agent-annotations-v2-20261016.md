# 全140来源保真修订 v2（2026-10-16）

> 状态：source-fidelity revision v2；Root已完成独立Standards／Spec审查，均0项。已见旧oracle及旧结果，非盲标，quality_certified=false。仅参考装配具备固定协议接入资格，不认证模型质量或维度放行。

基底是已修正R025／R031承诺风险与R024历史更正分支的[原full140判据](memory-gold-full140-agent-annotations-20261013.md)及配套JSON；这些既有修正逐值保留，不宣称为本版新增结果。仅将首21及嵌入parent21更新为[来源保真v2判据](memory-gold-agent-annotations-v2-20261016.md)：A05保留姐姐出借、联系人接收、已发生经历、contact／relationship_note／assertion／asserted／literal／H双null；物品车主未知、“她”缺唯一指称，非空说明且理想pending，不补Identity或反向产权。依据[D2合同](goal-memory-dimension-proof-interface-decision-20261013.md)第87行；typed proof范围不足不能一概否定普通字段已有角色。

旧21／140文件、旧annotation、所有freeze／封存审核／成绩保持，不按本版重算旧结果。本次独审仅覆盖A05及直接规则、140装配与不变性；其余139及R105延续旧独审，旧passed保留其原范围。新增119全部窗口（包括已正确保留受益人未知的R105）、来源档案、映射、公共oracle和输入均不改，不开放真实入口或预算。

## 固定集合与来源

公开123＋17按原运行顺序，不删难例。JSON参考顺序为新21 v2＋剩余119源码原序；local_to_reference_positions明确双射。新增119中的27旧strict、92弱oracle完整保存于provenance.public_source_manifest.legacy_case；空strict与缺strict分别为[]与null，不合并。public_window保存原来源、target和UTC时刻；源base为2026-09-15 UTC，每消息加一分钟，绝不用今天。

| 绑定 | 值 |
| --- | --- |
| v2 21文件SHA | `6ec7ee70a47b94d0cdf667be6478b8fe7cbe33e91bc3d4ec5e49ee340914f738` |
| v2 21规范对象SHA | `823d680bfa9e4c62024e570de0dddd2eb06e27d6fe05ba757e88e6dfb08f2635` |
| 固定140 case/oracle规范SHA | `ac73b6fc232ae5c93bfbd70126843294fa5de51f1532f511ff6ed70ba4037e62` |
| 119完整source/oracle档案规范SHA | `e76f7bab405d075c368097e57b476be2abc92acee69990b3724d8c691152de76` |
| v2 21 common_rules规范SHA | `7924580fc64d0b39598ada3db1f5d764d24a80d229858a3ff0f7894e5da8a39a` |
| 新119 common_rules规范SHA | `3f4a46b7fb536536278919c8a1aba1878961e72067d2e3a4d2dca10b8dc74dfd` |

原legacy none为29；原21中A14人类none增一个，本参考none为30（原21的A12/A14加新增119的28）。新119所有命题required=true，无新增optional；原A15-P2唯一可选不变。原旧oracle整体去向与新逐命题benchmark不强合并：当前/已完成/未来分别分支，不以case整体auto保证每候选auto。

沿用基底修正后仍为140窗、138个必需命题加1个可选命题；有限variants由155增至156，source_choices由161增至162，仅R024同一命题新增已发生更正分支，不增加命题或窗口分母。R025/R031保留明确承诺风险，原低风险白名单为`["", "low", "low_risk", "none", "无", "低风险"]`，承诺风险如`sensitivity:commitment`在该白名单外；两例原定去向、时间与门槛不变。

## 全局逐字段与审核边界

### scope

只适用于追加R001–R119。A01–A19/B01–B02只用本版parent21的v2 common_rules，不把本规则倒覆原21。

### source_only

固定公开123+17输入；所有源时间均由2026-09-15 UTC加消息分钟构造。Agent已见旧oracle，非盲标，quality_certified=false；不读取模型响应或改旧答案。

### inclusion

保留旧case级retain/none与固定原顺序。none不等于模型失败；retain必须逐必需命题评完整来源和限定，全输出含extra/duplicate仍审。

### e14

- `text`：逐命题正文符合body_requirements；同义/拆合可给raw覆盖，但不得丢否定、程度、数量、条件、时态、身份或阶段。
- `category`：严格取该variant.category，不能用relationship_note绕近况日期或把topic当category。
- `subject`：严格取该variant.subject，self/contact/shared是资料范围；第三人称谓仍留正文，不改成人物本人。
- `topic`：只取该variant.allowed_topics中的一个且符合正文粗主题，不凭topic增加职业或风险。
- `source_message_ids`：严格为variant.source_choices内真实消息ID集合，至少含target；必要相连语境不得省，context不可拼接不同话题。
- `confidence`：真实有限0..1，不bool；不编固定分值救分，置信度不证明现实或语义正确。
- `risk_flags`：按逐命题risk_rule；保留真实敏感及程序追加阻塞，不伪造风险，不为auto删除风险。
- `valid_at`：严格同variant.valid_at；来源时区政策日期不当实际开始，无法唯一推算时明确null。
- `invalid_at`：严格同variant.invalid_at；半开且end>start；未知终点null，禁止任意TTL。
- `speech_act`：严格同完整variant.speech_act；既成事件与未来安排不能拼标签。
- `assertion_status`：严格同variant.assertion_status；未知现实、条件与本人知识状态分开，不默认升级asserted。
- `figurative_type`：严格同variant.figurative_type；玩笑/反讽/夸张不提取，受质疑吹牛unknown不认证。
- `alternatives`：按逐命题alternatives_rule；有身份/阶段歧义必须诚实保留，无真实歧义须空，不凭未知未来制造现实猜测。
- `interpretation_reason`：按逐命题reason_rule，简短来源说明；不得新增事实/行为/因果/身份/永久认证，也不是内部推理。

### v4

- `candidate_index`：实际V输入的零起始整数，每候选一次不遗漏、重复、越界或bool。
- `verdict`：supported/uncertain/unsupported；比较完整正文、人物、限定、语用与时间，字符片段存在不证明完整语义；有明确错误unsupported，来源/角色不足uncertain。
- `issues`：supported须[]；其余须至少一个meaning/subject/negation/degree/quantity/condition/time/pragmatics/disconnected_context/insufficient_evidence，不写自由写库命令。
- `evidence`：每项只有message_id/quote，ID须该候选既有sources内，quote逐字非空原片段；supported至少有target，不能用候选文本或来源外context伪装证据。

### v_visibility

V4不检查E原confidence/risk_flags/alternatives/interpretation_reason，独审另核；V支持只降不升，不认证E全部14字段。此Gold固定legacyV4，不以新可空proof替代独审或质量门。

### destinations

ideal_destination为原三门benchmark：0.7门、风险/语用/未来时间门、语义支持之后的理想结果。生产第四AND门与逐维审批另报，默认空表不放行。reported/plan/conditional/unknown/敏感或非空alternatives均pending；safe+pending未知不等于full或auto。

### time

按源UTC2026-09-15星期二及每消息分钟；下周9/21–9/28，下个月10/1–11/1，来源周末9/19–9/21。历史动作双null；临时当前状态观察点且唯一终点才填；当天/次日明确短期资料用日边界，此为检索政策非真实结束。

### lineage

raw E先封存再揭V/final；对每实际E14与V4独审，再分别记raw/accepted/full。混合语用或时间一条输出不得冒充两个完整分支；所有额外、重复、未映射或bad auto仍统计。

### oracle_separation

provenance.public_source_manifest中的旧完整case对象不改；旧正则/presence/标签/去向评分与source语义分层报告。七公开冲突及新增字段差异不删除、不改旧答案、不当现实假事，也不能抹掉确定错误auto或错人。

## 七公开冲突的有界结论

| case | 保留旧oracle | 新来源语义与未知 |
| --- | --- |
| R057 | legacy case整体auto及每fact含到家/十点的弱matcher原样 | 到家完成P1与当天加班P2分开。十点时制与加班阶段未知，P2 unknown/pending双null，不能补10:00/22:00或完成阶段。 |
| R067 | strict旧日期双null原样 | 下周条件爬山plan/conditional；来源UTC整周9/21–9/28为资料检索期间，不确认不下雨。 |
| R073 | legacy整体pending原样 | 去年年底换工且非今年是历史assertion；本窗无先前错说或纠正关系，不能从不是猜correction。benchmark auto，生产AND默认空仍pending。 |
| R084 | legacy valid/invalid presence均true原样 | 这两天临时借住只明确当前观察，结束未知null，禁两天TTL。 |
| R085 | legacy valid/invalid presence均true原样 | 这几天出差只明确来源观察，结束未知null，禁猜几天。 |
| R112 | strict旧日期双null原样 | 明天不降雨才露营；plan/conditional，次日日区间9/16–9/17，不确认天气。 |
| R118 | strict未来培训旧日期双null原样 | 南京工作当前稳定事实双null，与下月青岛培训10/1–11/1 plan分离；无提前完成。 |

这些是两口径的明确有界解释，UNKNOWN落在字段或正文，不等于删去case或待人类填答案。旧程序评分仍单独原样计算；发现错人、无据角色、错误确定阶段或bad auto继续安全停止。新增完整字段也可能与旧弱/strict口径不同，例如R065的本人未决定知识状态用来源观察点、R007/R075/R099/R115另存明确未来或第三方命题；旧整体oracle不为新完整语义签认证。

## 逐119来源、命题与有限字段

每个编号对应JSON同编号，不从contains或pattern生成新语义。source_choices为零起始本窗索引，运行ID按原uuid5规则机械绑定。原文引用只含公开合成资料；每window旧完整case、原target与每message UTC在JSON来源档案单列。

### R001：复核：机构提及不等于身份

原运行位置`1`；参考位置`21`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L8)第8–16行。target=`[0]`；inputSHA=`10271db7b97dec3db8574c6a739acfb6aeabd07f0ef1c6395feceff95b597d2d`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：这家职业学校刚上线预约入口，回头试试。

旧完整oracle规范SHA：`dedb8990b974dd880e6d8430aeb3f0cfa2ec05ca5827c268439b9ced29a07b46`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只提及职业学校预约入口与回头试用；不证明用户学生、就读、任教或任职，不形成长期身份与偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只提及职业学校预约入口与回头试用；不证明用户学生、就读、任教或任职，不形成长期身份与偏好。

### R002：复核：明确学生身份

原运行位置`2`；参考位置`22`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L17)第17–26行。target=`[0]`；inputSHA=`3727eaee608158758edbd75bbb6a622f170496b3567b05a6d95c88b4393cc929`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我是这所大学的大三学生，目前读土木工程。

旧完整oracle规范SHA：`9ff5365ac7f398daa5b3bb4b25e7e8f1ff24fcd758b6be97fea89d9ade070a34`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R002-P1 必需**：用户是所述大学的大三学生；大学名称未知，不补学校层次。

- `R002-P1-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['study']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R002-P2 必需**：用户目前读土木工程，不能写成已毕业、已获学位或任职。

- `R002-P2-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['study']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R002-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R002-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R003：复核：借款未来计划

原运行位置`3`；参考位置`23`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L8)第8–18行。target=`[0]`；inputSHA=`eeae950b99ce95b7c48313543021c54dcf55f2715f9b0e9201b4273777aa1d4f`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：等发奖金后我准备办一笔借款，用来装修老房子。

旧完整oracle规范SHA：`6c878e79b9beaa8cfe33b3fa0be6c53a2b2b904985dc20108bce12d030844db2`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R003-P1 必需**：联系人准备等发奖金后办一笔借款，用于装修老房子；奖金未确认到手，借款未办，不补金额或所有权。

- `R003-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R003-P1-V2`：`contact / recent_state / plan+conditional+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R003-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R004：复核：夸张口号不等于偏好

原运行位置`4`；参考位置`24`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L8)第8–15行。target=`[0]`；inputSHA=`484221f5e2006148de18da36f43c02dff8bb129330284066ab2e5e360db9bc1b`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：赢了买别墅，输了去海底搬砖，哈哈开玩笑的。

旧完整oracle规范SHA：`ad22dd550fa2e05f84a3dbe9fb4e7c009e840dfe90eae822ef2604676b51b41b`；原expect=`none`；原strict=`0`，原值见JSON来源档案，未改。

纳入：`none`。明确哈哈开玩笑的夸张口号；不记购别墅、海底工作、输赢经历、人格或偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：明确哈哈开玩笑的夸张口号；不记购别墅、海底工作、输赢经历、人格或偏好。

### R005：复核：反讽收益不等于价值观

原运行位置`5`；参考位置`25`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L19)第19–26行。target=`[1]`；inputSHA=`6b968c27eacefa8ad1dbbd45756c71330e187a85e292c45d4313e7a56dc33ede`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：这份工作福利如何？
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：只要忍半年连轴转，就能享受三分钟长假，真划算。

旧完整oracle规范SHA：`3f610c2acded71830207f934b994b5a170965218e250812bfa0daa190b3c1371`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。半年连轴转换三分钟长假的反讽；不记福利事实、喜爱加班或价值观。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：半年连轴转换三分钟长假的反讽；不记福利事实、喜爱加班或价值观。

### R006：复核：短期方向不等于习惯

原运行位置`6`；参考位置`26`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L16)第16–23行。target=`[1]`；inputSHA=`e2e0d75a7fdfceba5875f6cb578450667f1636608d4b48a53de846e17eaf362d`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：这个解谜游戏先试哪一步？
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：这一轮先按相反方向操作看看，之后再改。

旧完整oracle规范SHA：`9c2bfa03a9de907228785b6dc421795b287b9a4df3b4eaa114680e595885ce81`；原expect=`none`；原strict=`0`，原值见JSON来源档案，未改。

纳入：`none`。解谜这一轮的临时操作建议；不记反向操作的习惯、人格或长期回复策略。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：解谜这一轮的临时操作建议；不记反向操作的习惯、人格或长期回复策略。

### R007：复核：临时状态保留期间

原运行位置`7`；参考位置`27`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L8)第8–20行。target=`[0]`；inputSHA=`82c7d796d083527704bb1fb44fe13c82f4a0fb9c52dcb8bcf6d792f4a38356d1`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：本周临时在北区办公室值班，下周就回原办公室。

旧完整oracle规范SHA：`f847b25723ddd3242a8c96767f3264d59bc76a03b5755d797126ae34c61831a2`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R007-P1 必需**：来源日观察用户本周临时在北区办公室值班；仅本周，非永久工作地点。

- `R007-P1-V1`：`self / recent_state / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=2026-09-21T00:00:00+00:00`；理想benchmark `auto`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R007-P2 必需**：用户安排下周回原办公室；尚未回去，不补具体办公室或周内日期。

- `R007-P2-V1`：`self / recent_state / plan+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R007-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R007-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R008：明确事实

原运行位置`8`；参考位置`28`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L27)第27–33行。target=`[0]`；inputSHA=`e3445627287525640421b1898c9413de0971826d3f9fa275e24c4001b1e45e00`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我现在在上海。

旧完整oracle规范SHA：`52cc1f2700d48e233c8a56ce3d498f11d81d261e86b34a22bf5460dd834b1585`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R008-P1 必需**：来源时点联系人现在在上海；是当前在地状态，不是永久住址、任职或已结束旅行。

- `R008-P1-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['other', 'travel']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `auto`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R008-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R009：未来计划

原运行位置`9`；参考位置`29`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L21)第21–27行。target=`[0]`；inputSHA=`5762fa373c9c6a38a17f118cb2e271d6c9ce3a783fd5f2d0493e59e56bd26f98`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我下个月准备去上海。

旧完整oracle规范SHA：`2821b37e792f5b0f86b1ceccffb16b045c196b5c0ecc6607745d34a5e972a825`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R009-P1 必需**：联系人准备下个月去上海；未发生，不补出发日、时长、目的。

- `R009-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R009-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R010：条件假设

原运行位置`10`；参考位置`30`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L34)第34–40行。target=`[0]`；inputSHA=`2f3af375add4452863748b81eb6b932f8c3f0ffd5d9d44d400e18c740482a3ef`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：如果我有 30 万，我就加仓。

旧完整oracle规范SHA：`7a5c2d2809c1e3845057bbb0bb5ca186c0d428370da8bd819c0d9e8b1d14a0ec`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R010-P1 必需**：联系人假设如果自己有30万，就加仓；保留拥有30万的前提、金额与加仓后件，不记已有资金或已经加仓。

- `R010-P1-V1`：`contact / recent_state / plan+hypothetical+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R010-P1-V2`：`contact / recent_state / plan+conditional+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R010-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R011：吹牛被点破

原运行位置`11`；参考位置`31`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L41)第41–47行。target=`[0]`；inputSHA=`4efac904d46a91a173d325e3b4ef239b0e57f9ff6cae62745bc00b4b1db89acd`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：明天 100w 到手，我贷款 30w 加仓。
- 消息1 `self` / `2026-09-15T00:01:00+00:00`：你又开始吹了。

旧完整oracle规范SHA：`6636b5150098c27cf45c852b4a3233b60459b35831fdf59a6b1feefae32961f3`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R011-P1 必需**：联系人说100w（100万）明天到手，但被用户指出在吹；保留数量、次日与可信度未知，不确认资金到账。

- `R011-P1-V1`：`contact / recent_state / plan+asserted+unknown`；topic=`['finance']`；source=`[0, 1]`；`valid_at=2026-09-16T00:00:00+00:00`，`invalid_at=2026-09-17T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：target0给金额与明天，context1指出吹牛；仅保留未证实说法，不能把质疑写成现实反证。

**R011-P2 必需**：联系人在同一受质疑说法中说贷款30w（30万）加仓；未证明贷款已发生，明天只明确修饰100w到手，不能移给贷款。

- `R011-P2-V1`：`contact / recent_state / plan+asserted+unknown`；topic=`['finance']`；source=`[0, 1]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R011-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R011-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R012：第三方引用

原运行位置`12`；参考位置`32`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L8)第8–14行。target=`[0]`；inputSHA=`7d2bf6ed6108a883248434076e030b9c9733f4c5453099da073c371c15ca3a1f`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：他说他要贷款 30 万。

旧完整oracle规范SHA：`2bb46e0d43563aecd39e2106f9715d69e9e6ccf844b58add98c1e94a2201c463`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R012-P1 必需**：联系人转述身份未知的他要贷款30万；贷款者是第三人，未办理，不能换成联系人或用户。

- `R012-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：alternatives须非空，明确本窗不能唯一识别所指第三人/归属；只保留来源允许解释，不能编姓名、身份、所有权、接受或受益关系。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R012-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R013：不确定表达

原运行位置`13`；参考位置`33`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L48)第48–54行。target=`[0]`；inputSHA=`1946816892783fbd6438365bcba4770e616ed7a1f3ba325914a085717ba664cc`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我可能下个月去上海。

旧完整oracle规范SHA：`bae2355bb323c860eb43872aa6e826a62d11789bb4c4c72ae2d19e7486d71e82`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R013-P1 必需**：联系人说自己可能下个月去上海；保留可能性，非已决定或已发生行程。

- `R013-P1-V1`：`contact / recent_state / plan+unknown+literal`；topic=`['travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R013-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R014：纠正撤回

原运行位置`14`；参考位置`34`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L28)第28–34行。target=`[0]`；inputSHA=`e01d287fc91a43c3f917593cdbce9baaf2d7315d7ca9314d16ed18e216040275`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我上次说错了，没有贷款，那是吹牛。

旧完整oracle规范SHA：`de492d0ed7564d6bf4f4741f9d8a13efef297c60403ad440c2d9a09f36da814a`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R014-P1 必需**：联系人明确撤回自己上次贷款说法：此前说错，没有贷款，那是吹牛；不记为已经还款或取消贷款申请。

- `R014-P1-V1`：`contact / relationship_note / correction+asserted+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R014-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R015：已发生行动

原运行位置`15`；参考位置`35`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L15)第15–23行。target=`[0]`；inputSHA=`ab0c5fd8999ca51be61fdb7c90c1fca681ea85f126189ab1b99133dd00587bae`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我已经提交贷款申请了。

旧完整oracle规范SHA：`c14d5ff3469554f60914d40f75d1d6215637887dd663b4738b7bb29faa396e58`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R015-P1 必需**：联系人已经提交贷款申请；完成的是申请提交，不是审批通过、贷款到账或加仓完成。

- `R015-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R015-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R016：反讽

原运行位置`16`；参考位置`36`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L55)第55–62行。target=`[1]`；inputSHA=`10cc30578d8744080c00302e78c2d0bc3f630d8b65f0a83269d9d39486354c57`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：周末加班快乐吗
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：你可真会挑时候，我这边刚忙完你就来事。

旧完整oracle规范SHA：`a71704643e91b7bc0d631b96fe71287bf5a79b26335fa0977d237e7cf36b7b14`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。相连加班问题中的挖苦；不记喜欢加班、双方稳定关系或忙完这一字面片段。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：相连加班问题中的挖苦；不记喜欢加班、双方稳定关系或忙完这一字面片段。

### R017：反话称赞

原运行位置`17`；参考位置`37`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L63)第63–70行。target=`[1]`；inputSHA=`9937779f021c4e1b18934a7e482b24b2615e5e2df1956283b5f413b42bd5f974`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我把你刚改好的文件删了……
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：你太厉害了，真是帮了我大忙。

旧完整oracle规范SHA：`c3d4e590ea3948c5af1f9a1b1d567388380422ff51ad1941b3ace4b99304f44a`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。删除文件语境中的反话称赞；不记真心赞赏、能力或帮忙成功。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：删除文件语境中的反话称赞；不记真心赞赏、能力或帮忙成功。

### R018：修辞反问

原运行位置`18`；参考位置`38`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L71)第71–77行。target=`[0]`；inputSHA=`b7e80f2cf35f34a00369189533383498916914749480df016100bf30816d6a9d`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：你觉得我像是缺那点钱的人吗？

旧完整oracle规范SHA：`b740f3fd307c7ebf5b7c6be93cebd7e9626bbc4623c4a2072475d9f4a2c90348`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。修辞反问；不推断财富、收入、不缺钱的人格或实际金额。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：修辞反问；不推断财富、收入、不缺钱的人格或实际金额。

### R019：夸张情绪

原运行位置`19`；参考位置`39`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L78)第78–84行。target=`[0]`；inputSHA=`a0d6be08038920a56563801a459aa5504913df413be810d1996c6f1483d30017`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：累死了，一点都不想动了。

旧完整oracle规范SHA：`d11849a0f92e07e2c76e026aa77f30063fd9c67630234c53df74ab8dc4738f2b`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。累死了的夸张情绪；不记死亡、疾病、永久不活动或长期偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：累死了的夸张情绪；不记死亡、疾病、永久不活动或长期偏好。

### R020：玩笑自夸

原运行位置`20`；参考位置`40`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L85)第85–91行。target=`[1]`；inputSHA=`8c864bf02306b242b81fce3a31fb73b0bf93fb3f62a10112478dcf7b0f470d0f`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：你最近健身效果不错啊
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：那当然，我就是这么优秀，人称健身房彭于晏。

旧完整oracle规范SHA：`e00ec16260479a686793ff8950e9f83fd49132764b2866ab384ff28c82fe9954`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。健身房彭于晏的玩笑自夸；不记真实身份、客观健身成绩或人格。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：健身房彭于晏的玩笑自夸；不记真实身份、客观健身成绩或人格。

### R021：转发外部内容

原运行位置`21`；参考位置`41`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L24)第24–31行。target=`[0]`；inputSHA=`c3de2f9c23bc702d3232ce22e308bf69d9c9990df7de424dfda878730db5f149`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：刚看到个视频说熬夜会致癌，吓死我了。

旧完整oracle规范SHA：`d45f91ebe8b307edb0286b8f24f4ce9b2f1fc359f828aa090a3648f94319c653`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。外部视频说法与对此的情绪；不记联系人熬夜、癌症、已证医学因果或健康偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：外部视频说法与对此的情绪；不记联系人熬夜、癌症、已证医学因果或健康偏好。

### R022：字面现状陈述

原运行位置`22`；参考位置`42`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L92)第92–98行。target=`[0]`；inputSHA=`1a24ec1cb63745b30996f935bc7ffa187d7521d60d371016c15337cbf421c190`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我最近换了工作，在一家新公司做运营。

旧完整oracle规范SHA：`b7ebc01c7c1460f9cc4890276c0445266381f17dab64bc1b2d6454d02a481767`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R022-P1 必需**：联系人最近已经换了工作；不补换工日期、旧雇主或离职原因。

- `R022-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R022-P2 必需**：联系人在一家新公司做运营；公司身份未知，不补职位级别、公司名称或任职时长。

- `R022-P2-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R022-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R022-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R023：无标记转述

原运行位置`23`；参考位置`43`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L32)第32–39行。target=`[0]`；inputSHA=`d206f1ac9c593d497f045758349df32556734686ec518db6064649d095f05e0e`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我妈让我十一回家相亲。

旧完整oracle规范SHA：`d18d98f50fab3bfa406a1cb1b266170d5bedc2808df16df254d0002714f766c9`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R023-P1 必需**：联系人转述母亲要求自己十一回家相亲；保存已提出要求，不证明联系人同意、已经回家或参加相亲。

- `R023-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['family']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R023-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R024：窗口内自我更正

原运行位置`24`；参考位置`44`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L35)第35–41行。target=`[1]`；inputSHA=`9d14b4ca3725661c3df053e8530f05eb826cebd714cc054a92ecb7e9ab539b86`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我下周去北京。
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：不对，是下周三不是下周一，我记错了。

旧完整oracle规范SHA：`7c9c684215edcc912f7a476453f8db75150ccf5e64c59b0ba4014f228f3a5d31`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R024-P1 必需**：联系人自我更正赴北京安排：下周三，不是下周一；保留改期关系，不能保留被更正的周一或说已赴北京。

- `R024-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0, 1]`；`valid_at=2026-09-23T00:00:00+00:00`，`invalid_at=2026-09-24T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：target1更正星期，相连context0给北京去向；仅保存更正后的未来安排。

- `R024-P1-V2`：`contact / relationship_note / correction+asserted+literal`；topic=`['travel']`；source=`[0, 1]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  正文：联系人已自我更正赴北京安排为下周三、不是下周一，并说明自己记错了；保存已发生更正及其安排内容，不证明行程已执行或现今在北京。
  时间：保存已发生更正动作的H框架，双null；下周三/下周一仅为更正中保留/否定的安排内容，不是更正动作的生效/失效时间。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  来源：target1给下周三而非下周一及自我更正，context0给联系人赴北京安排；两条合用才覆盖完整命题。
  理由：target1明示已发生自我更正与记错，相连context0给赴北京安排；保存更正动作及完整内容，不认定行程已执行。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R024-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R025：条件承诺

原运行位置`25`；参考位置`45`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L99)第99–105行。target=`[0]`；inputSHA=`cc48416a90310abc3302125c14d3ee18c58358077d42ec72206c3acc38093888`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：你来上海的话，我一定请你吃饭。

旧完整oracle规范SHA：`70a0975fe6bfb9d92bd4d4ba26a5af982471d9b3aa50241dc1021439f9feaf66`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R025-P1 必需**：联系人承诺若用户来上海，就一定请用户吃饭；保留用户来上海的前提、一定程度与请客角色，不证明用户将来或饭已发生。

- `R025-P1-V1`：`contact / recent_state / plan+conditional+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源含明确承诺，risk_flags须保留至少一个原低风险白名单外的承诺风险标记（如sensitivity:commitment）；不能用[]或仅低风险标记洗去承诺风险，不新增已履行、财务、健康或其他虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R025-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R026：习惯偏好

原运行位置`26`；参考位置`46`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L106)第106–112行。target=`[0]`；inputSHA=`6b5e3eecfa335f49f572619ef919a3c111ded576e158aed9122ea69dc9d6f9b7`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我平时不怎么吃辣的，微辣就行。

旧完整oracle规范SHA：`4bb8a292df6f75ad35c7264a6e762da0e5bf2620b59e43c6e498a34de3315d16`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R026-P1 必需**：联系人平时不怎么吃辣，微辣就行；保留少吃辣的程度与可接受微辣，不能写成完全不吃辣。

- `R026-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R026-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R027：否定事实

原运行位置`27`；参考位置`47`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L113)第113–119行。target=`[0]`；inputSHA=`229fee19e70d12695c59f61bd59cc99563bc03154fd3cfc999bfa41405d94113`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我不喝酒的，你们喝就行。

旧完整oracle规范SHA：`f069d1b00f3d2908545aab0a04bef8186a648082f4af30a068292bc22af0ee14`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R027-P1 必需**：联系人不喝酒；否定饮酒，不能写成只喝少量或不能喝酒的疾病。

- `R027-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R027-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R028：主体归属：用户计划

原运行位置`28`；参考位置`48`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L27)第27–35行。target=`[0]`；inputSHA=`f70f1cb40d0a4e8e0843ef550ab1aa8727a022e0c22962d450bd4ad053b688ba`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我下周要去广州出差。
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：好的，注意安全。

旧完整oracle规范SHA：`05aa08c7d967a05c198db6235bd24ccb431ca87ad7ea72a1a7ed075509bdc5cc`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R028-P1 必需**：用户下周要去广州出差；联系人仅提醒安全，不是联系人出差或共同出差。

- `R028-P1-V1`：`self / recent_state / plan+asserted+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R028-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R029：含糊健康

原运行位置`29`；参考位置`49`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L120)第120–126行。target=`[0]`；inputSHA=`292d262be26735a37f9254d73948a4e94f377613142df6c902866d31123cf360`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我可能有点感冒，嗓子不太舒服。

旧完整oracle规范SHA：`7a5e6250fcd938bcfedc1c8e0589326cd715abcb3ff78cc3e0b79897c876e49f`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R029-P1 必需**：联系人可能有点感冒；保留可能与有点，不能确诊或增强严重程度。

- `R029-P1-V1`：`contact / recent_state / assertion+unknown+literal`；topic=`['health']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：必须保留原有健康敏感性（如health或健康，至少一个在低风险白名单外）；不补诊断、治疗结果或病因。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R029-P2 必需**：来源时点联系人嗓子不太舒服；保留不太程度，不能补病因、治疗或感冒确诊。

- `R029-P2-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['health']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：必须保留原有健康敏感性（如health或健康，至少一个在低风险白名单外）；不补诊断、治疗结果或病因。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R029-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R029-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R030：疑问邀约

原运行位置`30`；参考位置`50`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L127)第127–133行。target=`[0]`；inputSHA=`f54457da3aa4146cb3ae252dc169bddc5406ce18cadfc6d9b44c49cc9726770a`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：周末要不要一起吃饭？

旧完整oracle规范SHA：`b8a143293955004f921c7402a5fb3bd406cea7160aff9d875121113926f6cf75`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。一次疑问邀约；不记已约饭、已同意、共同未来计划或饮食偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：一次疑问邀约；不记已约饭、已同意、共同未来计划或饮食偏好。

### R031：明确承诺

原运行位置`31`；参考位置`51`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L134)第134–141行。target=`[0]`；inputSHA=`8596c84a9e526a0f7894b8fb04a1e30df624c0d2218e90877d0b77a469916be8`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我答应你，这周末一定把方案改完再出去玩。

旧完整oracle规范SHA：`436716f52484f442b5c2ed058af74ca987730c37ea06e31449f9d83e41aa05a5`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R031-P1 必需**：联系人承诺这周末一定先把方案改完，再出去玩；保留时间、一定承诺与先完成后娱乐的顺序，两个动作均未完成。

- `R031-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-19T00:00:00+00:00`，`invalid_at=2026-09-21T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源含明确承诺，risk_flags须保留至少一个原低风险白名单外的承诺风险标记（如sensitivity:commitment）；不能用[]或仅低风险标记洗去承诺风险，不新增已履行、财务、健康或其他虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R031-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R032：对第三方的情绪

原运行位置`32`；参考位置`52`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L142)第142–149行。target=`[0]`；inputSHA=`d95eb8281d46f1b3f322380e50161c6b585519e4d87e50eb1817360f88383c50`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我同事真讨厌，气死我了。

旧完整oracle规范SHA：`6b2ffde7f8cc363888c8c689b5e01dbde565c2c5fd1dc7f69cc62e56f66d4bd5`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。对第三方的即时情绪与夸张；不记同事客观品格、稳定厌恶或关系事实。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：对第三方的即时情绪与夸张；不记同事客观品格、稳定厌恶或关系事实。

### R033：已取消的安排

原运行位置`33`；参考位置`53`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L42)第42–49行。target=`[1]`；inputSHA=`73cff7e8889cbd2f89defae916c409897c61ded3df31334fdbd796139e9b0fe5`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：本来下周要去上海出差的。
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：刚通知取消了，不用去了。

旧完整oracle规范SHA：`936c8b74cce8ceff672d374361b800b02326658085fc10d3c38110669367b8ee`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R033-P1 必需**：联系人原本下周的上海出差刚被通知取消，不用去；保存已取消结果，不保留有效的未来出行。

- `R033-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work', 'travel']`；source=`[0, 1]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R033-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R034：主体：联系人自述状态

原运行位置`34`；参考位置`54`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L36)第36–43行。target=`[0]`；inputSHA=`63227ff513c0de177bb58fefb90cad12829acbfe488792afb91d3b160afad18d`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我最近搬到杭州了。

旧完整oracle规范SHA：`982bfec624962534f9e5b9cda8c89e705d4f944d23f76e9c32c890c4bc116f2b`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R034-P1 必需**：联系人最近已搬到杭州；保存搬迁完成，不补具体住址、原因或如今仍居住的永久保证。

- `R034-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R034-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R035：主体：用户自述状态

原运行位置`35`；参考位置`55`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L44)第44–51行。target=`[0]`；inputSHA=`695efddf96f1fb0862621e345362283bd671250ec252cedb618c2cc08b9643ed`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我最近搬到成都了。

旧完整oracle规范SHA：`a28a7b9cee594161f6b67ed6d5579f19a4762978cb871ff1b263176060eef499`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R035-P1 必需**：用户最近已搬到成都；不是联系人搬迁，不补具体住址或原因。

- `R035-P1-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R035-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R036：明确转述

原运行位置`36`；参考位置`56`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L40)第40–47行。target=`[0]`；inputSHA=`46fa890b53205f7ce3880938b7b292fb77f02fc294ee8c103bb26bdeb9773afe`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：老李说他下周要去上海出差。

旧完整oracle规范SHA：`bbe827c41c6a08cb1c78ab3c703008c573559d437589afb88fd1b0a5383dfd00`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R036-P1 必需**：联系人转述老李说他下周要去上海出差；是老李的未来内容，不是联系人行程，不证明实际出发。

- `R036-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R036-P1-V2`：`contact / recent_state / plan+reported+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：保存被转引的未来安排本身，完整用下周区间；不得把历史report双null与未来plan期间混搭。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R036-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R037：听闻公司变动

原运行位置`37`；参考位置`57`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L48)第48–55行。target=`[0]`；inputSHA=`c936a2b3cf53f5ba0078d5af5cc00624ed7b01d4b5e4e7283da1578feb3f71cb`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：听张姐说公司下个月要裁员。

旧完整oracle规范SHA：`fe512454e6693c93f33622979c0869cd86e012abf87d52b8fe780ef59ded6414`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R037-P1 必需**：联系人听张姐说公司下个月要裁员；保持听闻链与公司身份未知，不确认裁员或联系人失业。

- `R037-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R037-P1-V2`：`contact / recent_state / plan+reported+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：仅当正文保存转引的下个月裁员安排本身，日期用月区间；不认证已经执行。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R037-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R038：转述医生建议

原运行位置`38`；参考位置`58`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L56)第56–63行。target=`[0]`；inputSHA=`1ade7d15fa97edcabbd8a882f25e9a33f74d22ea4d9e1a8f71f456fd157e2495`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：医生建议我多运动，少熬夜。

旧完整oracle规范SHA：`3d39888c062aa636f077a77efb95cafe8f144ebc9c71383e902d70d3a52812d8`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R038-P1 必需**：联系人转述医生建议自己多运动、少熬夜；保存第三方建议，不记联系人已遵从、已运动或患具体疾病。

- `R038-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['health']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留原有健康敏感性（如health或健康，至少一个在低风险白名单外）；不补诊断、治疗结果或病因。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R038-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R039：转发文章

原运行位置`39`；参考位置`59`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L64)第64–71行。target=`[0]`；inputSHA=`86fb094429ff03e982922bfc55383ec18bd5b5696603009249e84099dbcc4e59`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：这篇讲睡眠的文章写得挺好，你看看。

旧完整oracle规范SHA：`a502798a6cd01f3d99994ad45756d2ce8b87354c178fb3b07be68ee650937789`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。转发文章与一次观看建议；不记睡眠状态、长期阅读偏好或文章事实。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：转发文章与一次观看建议；不记睡眠状态、长期阅读偏好或文章事实。

### R040：转述领导评价

原运行位置`40`；参考位置`60`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L72)第72–79行。target=`[0]`；inputSHA=`84b16a68e79350ad7731cc8d2e0788fb70a2f7e5c110161d3fdfecf696c0f68c`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我们领导说我最近进步很大。

旧完整oracle规范SHA：`a0988dc7e7750dd45538541f83f862aab2940eb88963bf9152f52675db1f87f3`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R040-P1 必需**：联系人转述领导评价自己最近进步很大；保留第三方评价和很大程度，不写客观绩效已认证。

- `R040-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R040-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R041：第三方婚礼

原运行位置`41`；参考位置`61`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L80)第80–87行。target=`[0]`；inputSHA=`ce5da1edecad7e07de8b51447eeadd4ad0404c5ff2278f06b961aff371940604`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：小王说下个月结婚，喊我去喝喜酒。

旧完整oracle规范SHA：`8f4cf09ec4c96b7730888de998e3778e28bb8f1b51a0b6a0d491c7a96d8b3ded`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R041-P1 必需**：联系人转述小王说下个月结婚；结婚者是小王，尚未发生，非联系人结婚。

- `R041-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R041-P1-V2`：`contact / recent_state / plan+reported+literal`；topic=`['other']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：保存被转引的未来婚礼安排时用整月区间；不补实际婚礼日期。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R041-P2 必需**：联系人收到小王喝喜酒的邀请；邀请已提出，联系人是否接受、届时是否赴宴未知。

- `R041-P2-V1`：`contact / relationship_note / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R041-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R041-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R042：听说天气

原运行位置`42`；参考位置`62`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L88)第88–95行。target=`[0]`；inputSHA=`43df122d9082b9cda72b74a55e0c2fb5e852209ff33c5211cdf8fa90e895d128`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：听说明天要下大雪。

旧完整oracle规范SHA：`ac084106e6fabd5a64ce2661ddac996ce4527ee3073e03cae363644661b495ef`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。天气传闻；不记联系人地点、确定降雪或稳定关系资料。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：天气传闻；不记联系人地点、确定降雪或稳定关系资料。

### R043：问换工作

原运行位置`43`；参考位置`63`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L96)第96–103行。target=`[0]`；inputSHA=`777e1652eb5061d00e19cb3726895ef3be4a3252ac7b43a56d81057a0bc83755`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：你之前说想换工作，定了吗？

旧完整oracle规范SHA：`e1c6d82dd1c27137a853dddd77faf2ee5fa0b1173e9278db8b87ce7c40a88c48`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。仅询问此前换工想法；无本窗直接确认，不记已决定、已换工或仍有计划。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：仅询问此前换工想法；无本窗直接确认，不记已决定、已换工或仍有计划。

### R044：问减肥

原运行位置`44`；参考位置`64`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L104)第104–111行。target=`[0]`；inputSHA=`d922aa3223bd5aac45a960c54c2c291ddfad692152e8922cf8741f1f281bfbdc`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：你上次说要减肥，现在怎么样了？

旧完整oracle规范SHA：`f574b9402dc170d3d1176d998e6c3752cd9c723078893d8cdfb4f2c0acb4bc08`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。用户询问减肥进展；不以问题的预设确认联系人减肥、体重或健康状态。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：用户询问减肥进展；不以问题的预设确认联系人减肥、体重或健康状态。

### R045：占位：单图

原运行位置`45`；参考位置`65`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L8)第8–15行。target=`[0]`；inputSHA=`5acf19f1452235cfe29a63fb99b5cdfc7c77a2dd848684d438d73d90b4eabc6c`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[图片]

旧完整oracle规范SHA：`5557cd45789bff19d4acb4c0611001f1647a33a3a376ef4f559b4d3cf9710a6e`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只有图片占位；不猜图片正文、地点、人物或发送偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只有图片占位；不猜图片正文、地点、人物或发送偏好。

### R046：占位：单语音

原运行位置`46`；参考位置`66`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L16)第16–23行。target=`[0]`；inputSHA=`cad2963cd7ce4f06512c7594623ad52be171295ad087a675f8458772a2650919`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[语音]

旧完整oracle规范SHA：`9e23d762f121bed572c7f7795927e8bb8916e5dd595fdc169014193edb308bc2`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只有语音占位；不猜语音正文、语气、事实或发送偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只有语音占位；不猜语音正文、语气、事实或发送偏好。

### R047：占位：单表情

原运行位置`47`；参考位置`67`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L24)第24–31行。target=`[0]`；inputSHA=`ee639994f31d5fe609b51c053b2fe5cb6c6ac52948c6a235915158df6cae939a`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[表情]

旧完整oracle规范SHA：`a90b670fc74bc48a82835fdc987c5fd8d422ca07de53f9459bece2d4a8b96ac2`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只有表情占位；不猜具体情绪、态度或偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只有表情占位；不猜具体情绪、态度或偏好。

### R048：占位：动画表情

原运行位置`48`；参考位置`68`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L32)第32–39行。target=`[0]`；inputSHA=`682ff2c9c9627aabc5e05971adbe6517726c85919b69e5bbc6eaa1330dce4fd9`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[动画表情]

旧完整oracle规范SHA：`dc33d88cbafbbfbd870e5784006069f596ba80f2d7770e74b717a00807c95232`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只有动画表情占位；不猜动画内容、事实或偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只有动画表情占位；不猜动画内容、事实或偏好。

### R049：占位：单视频

原运行位置`49`；参考位置`69`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L40)第40–47行。target=`[0]`；inputSHA=`70243ba776e789289e8345670a1e3a3f485e08b4dc2eb0282603ee77c5f19246`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[视频]

旧完整oracle规范SHA：`ba0ef9e6789a844bdb6e77ec2cf2160f402e96b752a9f42b06f6094b70ede577`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只有视频占位；不猜视频内容、人物、经历或偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只有视频占位；不猜视频内容、人物、经历或偏好。

### R050：占位：单文件

原运行位置`50`；参考位置`70`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L48)第48–55行。target=`[0]`；inputSHA=`fa7975da83080bf657ce624306ef20a62fad01fd187813433e3d9395f964b13f`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[文件]

旧完整oracle规范SHA：`d809be09926f84be451a3e3729e9c2f13934bd43c0b6695de9fe2e3f30b8a2f2`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。只有文件占位；不猜文件类型、业务内容、完成状态或职业。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：只有文件占位；不猜文件类型、业务内容、完成状态或职业。

### R051：占位：单链接

原运行位置`51`；参考位置`71`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L56)第56–63行。target=`[0]`；inputSHA=`453c16dfeb1b318f25a3908006fbc0f1530deabc8cf29080b72546b52ce6d369`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[链接] 你看看这个。

旧完整oracle规范SHA：`03a2490093f4f549cb5aa2f47028f03bbd7a4cd8ec753b293b2d4b30228fe7d1`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。链接占位加一次观看请求；不记链接内容或长期兴趣。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：链接占位加一次观看请求；不记链接内容或长期兴趣。

### R052：占位：用户发图

原运行位置`52`；参考位置`72`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L64)第64–71行。target=`[0]`；inputSHA=`48d8aa57b8c71219ce4fff92e399fd5e89dc0ec3cf9d5733be027344dcc24ce5`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：[图片]

旧完整oracle规范SHA：`0b934c7553b89ec7bd9b2de01e14cff2f9a6e94dc24bc3bd4d110ec1fb030558`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。用户仅发图片占位；不猜用户事实，也不转为联系人事实。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：用户仅发图片占位；不猜用户事实，也不转为联系人事实。

### R053：占位：转账

原运行位置`53`；参考位置`73`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L72)第72–79行。target=`[0]`；inputSHA=`465a1dd82e9d9db4e5e9b0062e3ce4513b0d27dc9f3fc9943540575a0a5454a5`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[转账]

旧完整oracle规范SHA：`97c18afa6f66ed487958f31c85503b48b049f0669d1ef32d72e04584d777ca76`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。转账占位不含金额、方向或成功状态；不记任何实际转账事实。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：转账占位不含金额、方向或成功状态；不记任何实际转账事实。

### R054：占位：名片

原运行位置`54`；参考位置`74`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L80)第80–87行。target=`[0]`；inputSHA=`2f8572290c1a42f58cb7be2652112498016eb19ad37cb6e28e0543393d5a7458`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[名片] 这是我同事的联系方式。

旧完整oracle规范SHA：`3602b07576fa1567fba082d86cd01a2c1bdb0d183169dcc9d6c953f7dc3d5871`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。名片占位及同事联系方式指示；不猜同事身份、具体联系方式或任职机构。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：名片占位及同事联系方式指示；不猜同事身份、具体联系方式或任职机构。

### R055：占位：视频号

原运行位置`55`；参考位置`75`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L88)第88–95行。target=`[0]`；inputSHA=`e77fc8a28cb5e34e59680f35f97b7717ceae91bf0e9ccc47f9a02a9bece54693`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[视频号] 你看看这个视频。

旧完整oracle规范SHA：`86a28afc225ec089f56dc7d99fca872c078ef411099c794195c43319b5f0f6ee`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。视频号占位与一次观看请求；不猜内容、账号归属或偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：视频号占位与一次观看请求；不猜内容、账号归属或偏好。

### R056：占位：视频内容

原运行位置`56`；参考位置`76`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L96)第96–103行。target=`[0]`；inputSHA=`16c17cf061d057762074f3d9b3bd803d981544849e2aef63d189589edbc5e6da`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[视频] 这猫太可爱了。

旧完整oracle规范SHA：`553f2dbd48ac2886a21cb3b46000a9b5d71d920be2a0fa126b6291b34da581bf`；原expect=`none`；原strict=`null`，原值见JSON来源档案，未改。

纳入：`none`。视频占位与可爱评价；不记联系人养猫、视频中的猫归属、稳定养宠偏好。
无E候选／V调用是理想结果；实际模型错误或未知不得伪记none。

禁止：视频占位与可爱评价；不记联系人养猫、视频中的猫归属、稳定养宠偏好。

### R057：占位：语音加文字

原运行位置`57`；参考位置`77`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L104)第104–113行。target=`[0]`；inputSHA=`4d83061b8146ad55d20452dc7a9fcf5426d4034d55cd6e350d2ea8600dc5a098`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[语音] 我刚到家，今天加班到十点。

旧完整oracle规范SHA：`7c6c4aed34822aeb7ccaf813eecc0833911035b425dcb9c2f868c3f04c7c2362`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R057-P1 必需**：联系人刚到家；保存到家完成结果，不补家中地址、交通、家人或语音内容。

- `R057-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R057-P2 必需**：联系人文字描述今天加班到十点；保留今天、加班与十点，但十点上午/晚上及加班完成/安排阶段不能唯一判定。

- `R057-P2-V1`：`contact / recent_state / unknown+unknown+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：仅可在正文注明来源日的今天；十点时制和完成阶段未知，双null，不拼出10:00/22:00、不用今天来源时刻认证已加班。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：alternatives须非空，说明十点时制及完成/安排阶段未唯一确定；只列这些有文本根据的解释，不改变到家已完成主张。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R057-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R057-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R058：占位：图片加文字

原运行位置`58`；参考位置`78`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L114)第114–123行。target=`[0]`；inputSHA=`0d5ac5bafdb264508390c25d68cbc649fb61fc3ad01a951e3b8dfe273d48dbef`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[图片] 这是我家猫，三岁了，特别粘人。

旧完整oracle规范SHA：`116de94205a1ac295d922c524150cf100d050244245cfa4771c5abfe0431256b`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R058-P1 必需**：联系人说明旁文指的是自家猫，猫三岁；保留动物归属与年龄，不能猜图片、品种、猫名或数量。

- `R058-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R058-P2 必需**：联系人形容自家猫特别粘人；保留特别程度，是对猫的描述，不是联系人性格或图片识别事实。

- `R058-P2-V1`：`contact / relationship_note / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R058-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R058-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R059：占位：文件加文字

原运行位置`59`；参考位置`79`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L124)第124–133行。target=`[0]`；inputSHA=`aafde58e50b92f025c72fcb76c012fe62e9a4a918849aaff2ac16fa5bde9583d`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[文件] 方案我已经改好了，你看下。

旧完整oracle规范SHA：`46ec61012714b0ca31670dcc28c3f46881d71ede22849d5e3d8bf9f3c7cfe47d`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R059-P1 必需**：联系人已经把方案改好；保存改好完成，文件占位不能证明文件内容、发送成功或审阅通过。

- `R059-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R059-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R060：占位：混合加计划

原运行位置`60`；参考位置`80`；源码[backend/src/notalone/memory_extraction/cases/media.py](../../backend/src/notalone/memory_extraction/cases/media.py#L134)第134–143行。target=`[0]`；inputSHA=`6b15f88f073b64ab3f2eba240c35e75f9dcb8ffd2cb4472151a852e48095e52d`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：[语音][图片] 跟你说个事，我下周要出差。

旧完整oracle规范SHA：`024bcbcb891d8f8853b57cb60980324320ddec03a2febaa79a800d578e9bd042`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R060-P1 必需**：联系人文字说自己下周要出差；目的地未知，语音和图片占位不给额外行程、人物或正文。

- `R060-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R060-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R061：保真：否定喝酒

原运行位置`61`；参考位置`81`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L24)第24–33行。target=`[0]`；inputSHA=`709c8f0bad67d1e5e3865f6b1c7bb0edc906eb7faf195dd298438ed02a00a96d`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我不喝酒的，你们喝就行。

旧完整oracle规范SHA：`31bdc105c9db1915d6befe9259e77633d70b3c805917a6248d143ade92da58fd`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R061-P1 必需**：联系人不喝酒；完整保留否定，不改为少喝、戒酒计划或健康诊断。

- `R061-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R061-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R062：保真：否认借钱

原运行位置`62`；参考位置`82`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L34)第34–43行。target=`[0]`；inputSHA=`6a238e7aaf5f7c589d840e66f62d589abf15f2d37ef4104e664af741b5538068`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我没借钱给他，是他记错了。

旧完整oracle规范SHA：`ae384a126b122c1142a333b9ed2486316d8e8de20f5dc29dfdf8bb54d17c3286`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R062-P1 必需**：联系人否认借钱给身份未知的他，并说是他记错了；保留否定、借出方向和记错归属，不说联系人借入或已还款。

- `R062-P1-V1`：`contact / relationship_note / assertion+asserted+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：alternatives须非空，明确本窗不能唯一识别所指第三人/归属；只保留来源允许解释，不能编姓名、身份、所有权、接受或受益关系。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R062-P1-V2`：`contact / relationship_note / report+reported+literal`；topic=`['finance']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留借款/贷款/加仓的财务敏感风险（如financial或loan，至少一个在低风险白名单外）；不能以空或低风险洗去风险。
  歧义：alternatives须非空，明确本窗不能唯一识别所指第三人/归属；只保留来源允许解释，不能编姓名、身份、所有权、接受或受益关系。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R062-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R063：保真：海鲜过敏

原运行位置`63`；参考位置`83`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L44)第44–54行。target=`[0]`；inputSHA=`131827098aa928e043a6d9ad0db746dd7df533751047c2b928866c318df1b54b`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我对海鲜过敏。

旧完整oracle规范SHA：`5d047c1cf8f4c8a492a3ee6c654cbe7ea8c152943074db52ea4ae6a78c027275`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R063-P1 必需**：用户对海鲜过敏；健康主体是用户，非联系人，不补反应、诊断或治疗。

- `R063-P1-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['health']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：必须保留原有健康敏感性（如health或健康，至少一个在低风险白名单外）；不补诊断、治疗结果或病因。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R063-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R064：保真：可能出差

原运行位置`64`；参考位置`84`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L55)第55–64行。target=`[0]`；inputSHA=`0b36355a35bf1a130675bf97b9538e21a654c6e4e8747f87a322acface6fdd04`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我可能下个月去上海出差。

旧完整oracle规范SHA：`65b56c7bc61b3120af5d1df5762371b50f644e269835e9973808ae4d3034ca3c`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R064-P1 必需**：联系人可能下个月去上海出差；可能性仍未知，不能变成确定安排或已经在上海。

- `R064-P1-V1`：`contact / recent_state / plan+unknown+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R064-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R065：保真：未定换工作

原运行位置`65`；参考位置`85`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L65)第65–74行。target=`[0]`；inputSHA=`c8cb7943921ecc1803205724893d50a78ed8eeda678cf98214abdc2299d401a3`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我还没决定要不要换工作。

旧完整oracle规范SHA：`43ba8b18ae033f5838a1b7c7df0fd70b1191cfea75d65ee0244af3359fb8c993`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R065-P1 必需**：来源时点联系人还没决定要不要换工作；是当前未决定状态，不证明打算离职、拒绝换工或已经换工。

- `R065-P1-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `auto`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R065-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R066：保真：讨厌香菜

原运行位置`66`；参考位置`86`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L75)第75–84行。target=`[0]`；inputSHA=`47336eef22ef5591d831fae5ee71071773076094d066dcd771136f48f76fcc97`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我特别讨厌吃香菜，闻到都难受。

旧完整oracle规范SHA：`0504b4c0d3aa5996fcfa4034e2df23a4af7c9df4267335abe5747516260a9966`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R066-P1 必需**：联系人特别讨厌吃香菜，闻到都难受；保留特别程度与闻到难受的限定，不补过敏诊断。

- `R066-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R066-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R067：保真：条件爬山

原运行位置`67`；参考位置`87`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L85)第85–94行。target=`[0]`；inputSHA=`24709df283e9f9e07b58fc540756ba84e35530685058d16aa70f05d29bc83d2a`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：如果下周不下雨，我就去爬山。

旧完整oracle规范SHA：`15da4fb8db0a2b8dfc44429f0c105d17aa669d2f14afbdb1f3dbb003de122fa2`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R067-P1 必需**：联系人如果下周不下雨就去爬山；完整保留不下雨前提、下周和爬山后件，不确认天气或已决定无条件去。

- `R067-P1-V1`：`contact / recent_state / plan+conditional+literal`；topic=`['travel', 'other']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R067-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R068：保真：下周三回来

原运行位置`68`；参考位置`88`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L95)第95–104行。target=`[0]`；inputSHA=`c803ef2e1038c74733efce2efdb06515e41205e9d43955a11ca4ee4ee01be4b3`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我下周三才回上海。

旧完整oracle规范SHA：`35fadc91fc5fda132b9678db5856351ebf21f6d1c6cdb35a8d50df75d1f832f7`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R068-P1 必需**：联系人下周三才回上海；保留才与回到上海，尚未回来，不补从何处返回。

- `R068-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=2026-09-23T00:00:00+00:00`，`invalid_at=2026-09-24T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R068-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R069：保真：取消见面

原运行位置`69`；参考位置`89`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L105)第105–114行。target=`[0]`；inputSHA=`b0150e94bd44f158b6e9153755a13d5319ed5d18152ce170d87f7a86b14fc05b`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：原本约的周六见面取消了。

旧完整oracle规范SHA：`9d5072e8f0c9bc16a3594f0e332d8b30cf2cc795d9d6f3a6ba7972226cf01caa`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R069-P1 必需**：联系人所述原本约的周六见面已经取消；参与者及取消执行者未明，不认定用户参加、双方共同见面、仍有约定或已经见面。

- `R069-P1-V1`：`contact / relationship_note / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：alternatives须非空，说明原句没有明确见面参与者及另一方身份；不能用旧shared oracle或两位发送者推定用户参加。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R069-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R070：保真：只喝一点

原运行位置`70`；参考位置`90`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L115)第115–124行。target=`[0]`；inputSHA=`1551408ef6b627d9136298864e8be090f4e29f5ee5ff17c4e1630b13220df31a`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我平时只喝一点酒，不会多喝。

旧完整oracle规范SHA：`f8a760374b763f36c4f375a2ca14cac1caa9780e55cabe52173f508fbc410a1c`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R070-P1 必需**：联系人平时只喝一点酒，不会多喝；保留少量上限，不写完全不喝、经常多喝或酒精疾病。

- `R070-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R070-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R071：保真：下周一到周三

原运行位置`71`；参考位置`91`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L125)第125–134行。target=`[0]`；inputSHA=`e14f072a9de358e74edd0c091b5257edb9959dca2f2b572bf6c80d88024e8c1c`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我下周一到周三都在北京。

旧完整oracle规范SHA：`679cb7bff85792f41eee076dfd096add2fde0976bf881cc633bdd42bd31d92c8`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R071-P1 必需**：联系人下周一到周三都在北京；保留完整三日期间、未来在地安排，不补出差或旅行目的。

- `R071-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['other', 'travel']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-24T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R071-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R072：保真：只有周日有空

原运行位置`72`；参考位置`92`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L135)第135–144行。target=`[0]`；inputSHA=`10969a61d53a2c5719a4480f57a5fd4f1156a53bd2c4a8a225a73754b045af1e`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我只有周日有空，其他天都排满了。

旧完整oracle规范SHA：`c894de22a431fce3c6d37e647edfaa483f1659a5fa1517eeb48d87fdd2a29f90`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R072-P1 必需**：来源时点联系人只有周日有空，其他天都排满；保留只有与其余排满，不凭未写每周的原话推成永久习惯。

- `R072-P1-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `auto`。
  时间：原文未唯一给哪一周或长期周期，只定位来源观察时点，结束未知null；不把周日编成具体已发生日期。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R072-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R073：保真：去年换工作

原运行位置`73`；参考位置`93`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L145)第145–154行。target=`[0]`；inputSHA=`e51802bc5b17cda0b5f11e7c7dc9cb949ff03ebfa4e0559ed7bb28eb2ce7f72e`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我是去年年底换的工作，不是今年。

旧完整oracle规范SHA：`80492e0ad57198adf7684688302488464097582d0b710c379ca1aed2722eb968`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R073-P1 必需**：联系人去年年底换的工作，不是今年；这是带年份否定的历史陈述，未给本窗此前错误说法或更正动作。

- `R073-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：双null；去年年底保留正文，不精确猜2025年某日，不能补今年换工或此前纠正行动。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R073-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R074：保真：条件完工

原运行位置`74`；参考位置`94`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L155)第155–164行。target=`[0]`；inputSHA=`3e058f9f50c91620aa8688edc6a1519225ee363de64f4060f7df38eb1cf18506`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：如果周五前能完工，我周末就休息。

旧完整oracle规范SHA：`bf6893b6cf269591013860c11a93bba162385b5db0a25a446f2f3f79f9b637c6`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R074-P1 必需**：联系人如果周五前能完工，周末就休息；完整保留完工前提、周五前边界与周末休息，均不确认已发生。

- `R074-P1-V1`：`contact / recent_state / plan+conditional+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-19T00:00:00+00:00`，`invalid_at=2026-09-21T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R074-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R075：保真：没去过日本

原运行位置`75`；参考位置`95`；源码[backend/src/notalone/memory_extraction/cases/paraphrase.py](../../backend/src/notalone/memory_extraction/cases/paraphrase.py#L165)第165–174行。target=`[0]`；inputSHA=`223305af21acd4df73ba0e0a832d6d3532a0a6181772b59c6b5b8a63365db48c`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我没去过日本，一直想去。

旧完整oracle规范SHA：`f08f2939e4eeeb6b833f02d4b4a299eee46f5adc0e591a51f1ec07b68ea2b385`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R075-P1 必需**：联系人没去过日本；保留历史经历否定，不写去过、已经旅游或无法去。

- `R075-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R075-P2 必需**：联系人一直想去日本；长期意向存在，不是已订行程或给定具体出发日期。

- `R075-P2-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R075-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R075-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R076：转述老张来访

原运行位置`91`；参考位置`96`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L112)第112–119行。target=`[0]`；inputSHA=`dcfc1553571244499d616fc07a53790db9667582349c34e603f7a15efd8c9fd1`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：老张说他周末来家里坐坐。

旧完整oracle规范SHA：`d135d5af10be41174a676a6544c116f2f687954d84bc1e9f9d595b23867e81d0`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R076-P1 必需**：联系人转述老张说周末来家里坐坐；来访者是老张，所指家里归属未明，不记已经来访。

- `R076-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：alternatives须非空，所指家里归属未明；不默认联系人/用户住宅，不编地址。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R076-P1-V2`：`contact / recent_state / plan+reported+literal`；topic=`['other']`；source=`[0]`；`valid_at=2026-09-19T00:00:00+00:00`，`invalid_at=2026-09-21T00:00:00+00:00`；理想benchmark `pending`。
  时间：仅当保存被转引的未来来访安排，保留所指家里未知并使用来源周末区间；历史转述本身双null。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：alternatives须非空，所指家里归属未明；不默认联系人/用户住宅，不编地址。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R076-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R077：领导通知加班

原运行位置`92`；参考位置`97`；源码[backend/src/notalone/memory_extraction/cases/reported.py](../../backend/src/notalone/memory_extraction/cases/reported.py#L120)第120–127行。target=`[0]`；inputSHA=`803696724ed4d1ecc2cadefec12a0be2b08d973cc51d6a07ac6a54ebd02c1439`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：领导通知下周要加班。

旧完整oracle规范SHA：`6802c4cd55bd0834e7eff20cafa91d4f434e5a98fb419a34bbc3ea787ab456cd`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R077-P1 必需**：联系人转述领导通知下周要加班；不补执行对象、加班日数、已经加班或联系人已同意。

- `R077-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：若候选写明加班执行者，须非空alternatives注明通知未明确具体执行人；只保存通知内容不补角色时可为空。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R077-P1-V2`：`contact / recent_state / plan+reported+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：保存被通知的未来加班安排本身时使用整周区间；不能把领导通知历史动作变成未来生效的report。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：若候选写明加班执行者，须非空alternatives注明通知未明确具体执行人；只保存通知内容不补角色时可为空。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R077-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R078：上个月旅行

原运行位置`93`；参考位置`98`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L50)第50–58行。target=`[0]`；inputSHA=`b7e11a8ea8274ffb5228b9652b92018728a32193308a6d04f2013c21e412cc49`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我上个月刚去完西藏回来。

旧完整oracle规范SHA：`cc54c5849dd407844f47e52ced929b8c0ae9a08195a4425bb243054cde43ca90`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R078-P1 必需**：联系人上个月已去完西藏回来；保存完成旅行，不写仍在西藏或推算具体旅行起止日。

- `R078-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R078-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R079：固定习惯

原运行位置`94`；参考位置`99`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L59)第59–68行。target=`[0]`；inputSHA=`5e5f6529e2d4816ed1bd680e3fb3ec1a75e4b118e813d0019de578251f32ab10`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我每周三晚上都去打球。

旧完整oracle规范SHA：`810b4bff2e34c49b506d89cb39b27c7874528c1652ddacda0d1b1ffbfb03a3c2`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R079-P1 必需**：联系人每周三晚上都去打球；长期周期习惯，保留每周、周三和晚上，不补球类或场所。

- `R079-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R079-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R080：下周出差

原运行位置`95`；参考位置`100`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L69)第69–77行。target=`[0]`；inputSHA=`34a1a1324720b0309604c8b0d360608b8024e3fd39d209253bf4e1b0fd556df5`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我下周要去北京出差三天。

旧完整oracle规范SHA：`e3c4abd302d96765980702d3fdc6b138a62df346c258a13715418b7670738387`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R080-P1 必需**：联系人下周要去北京出差三天；保留三天时长，下周具体哪三天未知，不拼9月21日至24日为实际行程。

- `R080-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：资料期间取来源下周历周；正文另保留实际出差时长三天，不能把历周检索区间当三天实际起止。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R080-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R081：下月旅行

原运行位置`96`；参考位置`101`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L78)第78–86行。target=`[0]`；inputSHA=`d5228c6bf3a89b0889c13902bd22011ffd8252cc084045478dd8765adbe693ed`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我下个月要去大阪玩。

旧完整oracle规范SHA：`6be538dd5172afb36a53c426975a8ee0268b070f5239c67174841026c59fe94a`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R081-P1 必需**：联系人下个月要去大阪玩；保留未来与目的地，不补航班、具体日期、持续时长或工作目的。

- `R081-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R081-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R082：取消出差

原运行位置`97`；参考位置`102`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L87)第87–96行。target=`[0]`；inputSHA=`97fc803147567ae4b60da9eb286168b6a05b574aec954d613e65d4549213d606`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：原定下周的北京出差取消了。

旧完整oracle规范SHA：`54931a50e303e13183bf43fc344dcd29ac35b68ea09a245baaf94e6b7ecfeb75`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R082-P1 必需**：联系人原定下周北京出差已经取消；取消是完成结果，不保留有效未来计划或用下周生效期表达取消。

- `R082-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R082-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R083：行程改期

原运行位置`98`；参考位置`103`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L97)第97–105行。target=`[0]`；inputSHA=`a3171e62de486f11aae8f1ceb6535ebe87e5cabb07ccf6aac997221f1e6df336`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：本来说下周去北京，改成下个月了。

旧完整oracle规范SHA：`dba20a9220aa7c05c0c97dbf42803e8dc50a830e538126645135b0137770c6bf`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R083-P1 必需**：联系人去北京的安排由下周改成下个月；保留旧时段到新时段的改期关系，不说两个行程都有效或已赴北京。

- `R083-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R083-P1-V2`：`contact / relationship_note / correction+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：保存已发生更正动作的H框架，双null；下周/下个月仅为被更正的原定和改后内容，不是更正动作的生效/失效时间。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R083-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R084：临时借住

原运行位置`99`；参考位置`104`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L106)第106–115行。target=`[0]`；inputSHA=`0cdae351993b6d7455f1e28a892c475e8997419291f8c5178b1bdcb24ae22321`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我这两天在朋友家借住。

旧完整oracle规范SHA：`1125e2e3f0149f1b9e0bd2b4486ccba0a39488005b8a0acd7d689d26c7f228d7`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R084-P1 必需**：来源日观察联系人这两天临时在朋友家借住；保存借住、朋友家和临时期间词，不写永久住址或确定第二天结束。

- `R084-P1-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `auto`。
  时间：这两天是来源日附近的模糊临时观察，不能唯一推算结束；valid_at为来源观察点，invalid_at明确null，禁固定两天TTL。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R084-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R085：出差中

原运行位置`100`；参考位置`105`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L116)第116–125行。target=`[0]`；inputSHA=`5dd6691244d304dd2a0c65f8cca828369fd36f180eeb29d56a341273503ed723`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我这几天在上海出差。

旧完整oracle规范SHA：`d83355f2a970b3c91c4d561c19e8d98f4b637b49137693ffa5811d2c2d0ddc13`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R085-P1 必需**：来源日观察联系人这几天在上海出差；保留几天的模糊期间与当前出差，不写永久任职、已返回或确定结束日。

- `R085-P1-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `auto`。
  时间：这几天未给日数或唯一终点；valid_at为来源观察点，invalid_at明确null，禁猜日数或固定TTL。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R085-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R086：短期：次日日程

原运行位置`101`；参考位置`106`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L126)第126–135行。target=`[0]`；inputSHA=`bdad6d75d55d61b888bbc1dcaea59360bfec58054cb9cde5f013176d659a2f08`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我明天上午去医院复查，下午就回来了。

旧完整oracle规范SHA：`4443a7a0a7907a95428e483cc4626624bf6434685a7f11202b91e2472c50a596`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R086-P1 必需**：联系人安排明天上午去医院复查、下午回来；两个阶段都是次日日程，保留上午/下午，不说已复查或已返回。

- `R086-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['health']`；source=`[0]`；`valid_at=2026-09-16T00:00:00+00:00`，`invalid_at=2026-09-17T00:00:00+00:00`；理想benchmark `pending`。
  时间：按来源日次日整天资料区间，不编上午具体小时或下午返回时刻；次日结束为检索政策边界，不是实际返程时刻。
  风险：必须保留原有健康敏感性（如health或健康，至少一个在低风险白名单外）；不补诊断、治疗结果或病因。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R086-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R087：短期：当天瞬时状态

原运行位置`102`；参考位置`107`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L136)第136–145行。target=`[0]`；inputSHA=`65c82d3d8e9588b08fa9a731b2a9448e987abe82291f375903b61e20005ee83a`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我手机快没电了，回头再说。

旧完整oracle规范SHA：`9cd78a5daa9c20751df0d8a565156a8656204916a27bc534637d6f956db50e76`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R087-P1 必需**：来源时点联系人手机快没电了，回头再说；保留快没电程度，是当天瞬时设备状态，非已关机、断联或长期沟通偏好。

- `R087-P1-V1`：`contact / recent_state / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=2026-09-16T00:00:00+00:00`；理想benchmark `auto`。
  时间：valid_at为来源观察点，invalid_at不超过来源当天结束，本参考取次日零点；这是检索失效政策，不证明实际耗尽或充电时间。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R087-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R088：长期：稳定习惯留空有效期

原运行位置`103`；参考位置`108`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L146)第146–154行。target=`[0]`；inputSHA=`1c52553d619f6bcda57079ba5670f33570ae44c44cef85613e55a354e35a09c9`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我养了一只猫，已经三年了。

旧完整oracle规范SHA：`fb02380d88d72f974b93f44ba4fa983e72236cefdedc43705f7f76bfd26625f0`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R088-P1 必需**：联系人养了一只猫，已养三年；保留一只与饲养时长三年，不把猫年龄说成三岁或编购入日期。

- `R088-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R088-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R089：条件邀约

原运行位置`104`；参考位置`109`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L155)第155–162行。target=`[0]`；inputSHA=`0dd96a772858785e47737b86c3d47422a784c22953070f91b9727edbd1265562`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：你要是来成都，我带你去吃火锅。

旧完整oracle规范SHA：`43f5f8b152f7b212ad192c20e8b0a109333635f07a83501549ccb7d65d061ac0`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R089-P1 必需**：联系人承诺如果用户来成都，就带用户吃火锅；保留用户来成都前提与联系人带领角色，不说已成行或已吃。

- `R089-P1-V1`：`contact / recent_state / plan+conditional+literal`；topic=`['other', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R089-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R090：约定饭局

原运行位置`105`；参考位置`110`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L163)第163–171行。target=`[0]`；inputSHA=`03e39a13ab47f00fabfcda1bed7bc2d6d8197fae76af7fc996eaa03efef7904f`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我们约好下周五晚上七点吃饭。

旧完整oracle规范SHA：`d2706fc96d8ff453c8510a3e14e89e0f04df7597c170c50ffa235ff905f6caa8`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R090-P1 必需**：双方约好下周五晚上七点吃饭；未来已约定，未执行，主体shared，七点按晚上19点，不补场地。

- `R090-P1-V1`：`shared / recent_state / plan+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=2026-09-25T19:00:00+00:00`，`invalid_at=2026-09-26T00:00:00+00:00`；理想benchmark `pending`。
  时间：来源UTC下周五晚上七点为9月25日19点；当晚结束检索边界取次日零点，不声称饭局实际持续五小时。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R090-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R091：模糊未来

原运行位置`106`；参考位置`111`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L172)第172–179行。target=`[0]`；inputSHA=`8e9fa97fb5a0a925b124eab4c7bdd7b45fa2476bb5667826543e0cae20a5f83b`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我以后可能去上海发展。

旧完整oracle规范SHA：`3e259a126ab58a66c593a45724892ea515742a856ba3e2cf3fec76178d927a08`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R091-P1 必需**：联系人以后可能去上海发展；保留以后、可能，方向未定，具体时期未知，不写目前在上海或已确定职业。

- `R091-P1-V1`：`contact / recent_state / plan+unknown+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R091-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R092：出差已结束

原运行位置`107`；参考位置`112`；源码[backend/src/notalone/memory_extraction/cases/time.py](../../backend/src/notalone/memory_extraction/cases/time.py#L180)第180–187行。target=`[0]`；inputSHA=`fdbf126646af2977efc9f7f99ad70a82f3afdd402b47f7c2f8f97720de102035`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我上个月在成都出差，已经回来了。

旧完整oracle规范SHA：`af2bbbd3d7135ff9f2316b269abca2f5eeecfee523ef334faa1fa03e58b72f66`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R092-P1 必需**：联系人上个月在成都出差；这是已结束的历史行程，不写现在在成都或仍出差。

- `R092-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R092-P2 必需**：联系人已经从所述成都出差返回；不补返回地点、日期或交通。

- `R092-P2-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R092-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R092-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R093：主体：联系人自述习惯

原运行位置`108`；参考位置`113`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L52)第52–60行。target=`[0]`；inputSHA=`97406bd17fdcb86255e92234a08f0842793bab5a38594fea7f45e1bd8a850360`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我每天早上六点起床跑步。

旧完整oracle规范SHA：`d6692765c08abcc923677a689c5b1c7952452bed851dde2160ec641501e351cf`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R093-P1 必需**：联系人每天早上六点起床跑步；保留每天、早上六点及起床跑步习惯，不补里程或健身成绩。

- `R093-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R093-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R094：主体：联系人确认用户的事

原运行位置`109`；参考位置`114`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L61)第61–69行。target=`[0]`；inputSHA=`05c8a6fe6c7e2c8ae68cf191ef72b39996f4156e54da3bd0fec2819b4f8d75ca`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：你拿到驾照了，恭喜恭喜！

旧完整oracle规范SHA：`d053e54da54fad9bececa0e3a2c5fadb28751e1e28ffc7c315b86b3a74cf0015`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R094-P1 必需**：联系人陈述用户已拿到驾照；受证主体是用户，不把恭喜当联系人考取或官方查证。

- `R094-P1-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R094-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R095：主体：共同经历

原运行位置`110`；参考位置`115`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L70)第70–77行。target=`[0]`；inputSHA=`975adc47489838859ef5f11f1a1cefad3cf63d55a42f76a19a7b88a2919a7298`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我们上次一起爬山爬了六个小时。

旧完整oracle规范SHA：`ca81cd212b388b4bd73c41270cd2237919880565efc94bcbc049c2114281de77`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R095-P1 必需**：双方上次一起爬山用了六个小时；保留共同经历、上次与六小时，地点和确切日期未知。

- `R095-P1-V1`：`shared / common_fact / assertion+asserted+literal`；topic=`['travel', 'other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R095-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R096：主体：共同计划

原运行位置`111`；参考位置`116`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L78)第78–85行。target=`[0]`；inputSHA=`70a8b56c93699828cd0e242febf4d467ee4c560eb3d276fd75598c9947a882f2`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我们下个月一起去云南玩吧。

旧完整oracle规范SHA：`c87af471a5a07749e2a52fcb99a6fd889726dfd311180b39a9738fce9ca79d39`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R096-P1 必需**：用户提出双方下个月一起去云南玩；是未来共同计划提议，未证明联系人答应或行程执行。

- `R096-P1-V1`：`shared / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R096-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R097：主体：上下文计划归属联系人

原运行位置`112`；参考位置`117`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L86)第86–93行。target=`[1]`；inputSHA=`f9788b56e921b7d0e72f3cc460a8a0bd0bfbb1e3428fb61603327bad573deefe`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：你上次说要去日本来着。
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：对，我下个月去大阪。

旧完整oracle规范SHA：`81c61aff67285f1e24ac58d6045563fdcca05118e130b8ce96341fb6211b4c1d`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R097-P1 必需**：联系人确认自己下个月去大阪；用户上条关于日本仅作相连背景，当前目的地由target1给，不归给用户。

- `R097-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['travel']`；source=`[1]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R097-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R098：主体：联系人转述用户计划

原运行位置`113`；参考位置`118`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L94)第94–102行。target=`[0]`；inputSHA=`cfe70fd9760655726acffcb9fb89a7c1263bdc359d5570e026c39190c9fdfd58`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：你妈跟我说你下周要去广州出差。

旧完整oracle规范SHA：`b3dd720aa318a99e78a8451d4adfa0ec02032812ba39eb35e3ec7bebd8fdf4e3`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R098-P1 必需**：联系人转述用户母亲说用户下周要去广州出差；被转述计划主体self，不能归给联系人或母亲，不确认已出发。

- `R098-P1-V1`：`self / relationship_note / report+reported+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。
- `R098-P1-V2`：`self / recent_state / plan+reported+literal`；topic=`['work', 'travel']`；source=`[0]`；`valid_at=2026-09-21T00:00:00+00:00`，`invalid_at=2026-09-28T00:00:00+00:00`；理想benchmark `pending`。
  时间：保存用户被转引的未来出差安排时取下周区间，reported保持；历史听闻转述动作本身双null。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R098-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R099：主体：第三方事件里的联系人行动

原运行位置`114`；参考位置`119`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L103)第103–110行。target=`[0]`；inputSHA=`bd841265a8d4298c0d527283860c15b77c488e24df6aa10510013e865030d6cb`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我表哥上个月结婚，我回老家喝了喜酒。

旧完整oracle规范SHA：`5368c7018cfd0539d065be2ea0e8e92ab06ba89b086c6508c48f2a4ff56e855f`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R099-P1 必需**：联系人陈述表哥上个月结婚；结婚主体是表哥，保存亲友历史事件，不说联系人结婚或第三人当前职业。

- `R099-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['family']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R099-P2 必需**：联系人已回老家喝表哥的喜酒；本人参加经历已发生，不补喝酒数量、老家位置或确定参加日期。

- `R099-P2-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['family', 'travel']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R099-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R099-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R100：主体：用户健康状态

原运行位置`115`；参考位置`120`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L111)第111–118行。target=`[0]`；inputSHA=`f9d51bd98b15bd66b607e804ef99365ded4122b52cc654cd0df2e9995ba7ad7d`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我最近在吃中药调理身体。

旧完整oracle规范SHA：`e7eac952ffe875079aad249676b6a29d15f3f74441d234480d4d213fccc99422`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R100-P1 必需**：来源时点用户最近在吃中药调理身体；健康资料属于用户，保留近期持续状态，不补诊断、疗效或具体药名。

- `R100-P1-V1`：`self / recent_state / assertion+asserted+literal`；topic=`['health']`；source=`[0]`；`valid_at=2026-09-15T00:00:00+00:00`，`invalid_at=None`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：必须保留原有健康敏感性（如health或健康，至少一个在低风险白名单外）；不补诊断、治疗结果或病因。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R100-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R101：主体：混淆线索下的联系人计划

原运行位置`116`；参考位置`121`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L119)第119–126行。target=`[1]`；inputSHA=`c0914662748f0247039b48c9667ca98b1662f35a9b9ca0b069f2093765a86f9a`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：这周有空吗？
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：我下个月要去上海出差，这周末得准备材料。

旧完整oracle规范SHA：`b7f847ac0670d5a94d010db98694b6d7bda95bb1f8eab0a9aa03d297300cb108`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R101-P1 必需**：联系人下个月要去上海出差；未发生，不将用户这周有空问题拼成用户行程。

- `R101-P1-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['work', 'travel']`；source=`[1]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R101-P2 必需**：联系人这周末得准备材料；是尚待完成的工作安排，不能说材料已备好或推断材料用途/时长。

- `R101-P2-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['work']`；source=`[1]`；`valid_at=2026-09-19T00:00:00+00:00`，`invalid_at=2026-09-21T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R101-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R101-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R102：主体：混淆线索下的用户事实

原运行位置`117`；参考位置`122`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L127)第127–134行。target=`[1]`；inputSHA=`9b357bc4d668798f8a78e10005172f7359a19572c77d45b4c2fa04894b2ff09f`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我朋友也想学摄影。
- 消息1 `self` / `2026-09-15T00:01:00+00:00`：我上周刚买了个相机。

旧完整oracle规范SHA：`beafdcb2d7be3963d352130b9cad3f835b977fad64ed9ed734f6ff2513451970`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R102-P1 必需**：用户上周刚买了一个相机；保留完成购买与一个，联系人朋友想摄影不作为购买者、任职或用户摄影偏好证据。

- `R102-P1-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[1]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R102-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R103：主体：联系人的偏好否定

原运行位置`118`；参考位置`123`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L135)第135–142行。target=`[0]`；inputSHA=`bb71c8118eab5e1572ade76cac6f5bc36c993de8c4219710269acfbea8b16ca9`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我不打游戏的，平时就看看书。

旧完整oracle规范SHA：`0b6f912ddf88a91a0ec5c926f65ef89df034058888f0d146cc79a47d47595b2c`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R103-P1 必需**：联系人不打游戏；保留否定，不能写少打、想戒或不具备能力。

- `R103-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R103-P2 必需**：联系人平时就看看书；保留平时与就的习惯程度，不扩成每天阅读或专业学习。

- `R103-P2-V1`：`contact / preference / assertion+asserted+literal`；topic=`['study', 'other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R103-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R103-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R104：主体：用户的偏好否定

原运行位置`119`；参考位置`124`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L143)第143–150行。target=`[0]`；inputSHA=`a774b3afdd7651b803a19f35069ed6cf5af0bf958a9e7f593d875725d6e76b65`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我不吃香菜的。

旧完整oracle规范SHA：`5235ff27dc989dc4dd5fd434a35ceb5062a48a852e388417d7b8ecdd2120748b`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R104-P1 必需**：用户不吃香菜；主体self，保留否定，不补过敏或联系人偏好。

- `R104-P1-V1`：`self / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R104-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R105：主体：用户被同事请托

原运行位置`120`；参考位置`125`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L151)第151–159行。target=`[0]`；inputSHA=`22217f3fc6f65cf6c621741349b20f8a6a4626c6e7c98d5e32e5db1cc727f641`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我同事让我周末帮他顶个班。

旧完整oracle规范SHA：`d0517b76c11417c5869678d795b711ea0fa5fa54c6bca527f46ce8501b49b0d6`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R105-P1 必需**：用户的同事已提出请托，所请内容为希望用户周末帮未明的“他”顶班，未说明用户接受或执行；请托者为同事，受益人不能仅靠请托者位置确定。

- `R105-P1-V1`：`self / relationship_note / report+reported+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：引用的已提出请托H框架双null；周末只限定所请顶班内容，不移到提出/接收动作有效期。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：alternatives须非空，说明顶班受益人“他”无明确唯一指称句，保持UNKNOWN；不能仅因同事是请托者就将“他”定为该同事，也不编另一具体人。
  理由：来源明示同事提出请托与用户被请托，未名他缺唯一指称句；不由同事身份、男性代词或模板推受益人，不补接受/义务/执行。
- `R105-P1-V2`：`self / relationship_note / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：历史接收请托H框架双null；周末只属内层所请顶班内容，不作为接收动作日期。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：alternatives须非空，说明顶班受益人“他”无明确唯一指称句，保持UNKNOWN；不能仅因同事是请托者就将“他”定为该同事，也不编另一具体人。
  理由：来源明示同事提出请托与用户被请托，未名他缺唯一指称句；不由同事身份、男性代词或模板推受益人，不补接受/义务/执行。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R105-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R106：真假：跨话题拼接

原运行位置`121`；参考位置`126`；源码[backend/src/notalone/memory_extraction/cases/truth_intent.py](../../backend/src/notalone/memory_extraction/cases/truth_intent.py#L150)第150–159行。target=`[2]`；inputSHA=`b315afe08e7118d3afe86528ad97b1df743346d98b4de4af96a7186b58b2839e`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：你去新门店上班多久了？
- 消息1 `contact` / `2026-09-15T00:01:00+00:00`：回头跟你说。
- 消息2 `contact` / `2026-09-15T00:02:00+00:00`：听说你从上家走得挺急，交接都没顾上，那边还挺意外的。

旧完整oracle规范SHA：`19a1a02967c5b7573a2ae7d69b82b51a55faf83ddfb247d3c074bbb2f7c6705c`；原expect=`pending`；原strict=`null`，原值见JSON来源档案，未改。

**R106-P1 必需**：联系人听说用户从上家走得挺急、没有顾上交接，那边意外；保留听闻、挺急和交接否定，不把前文新门店拼为用户曾任职处。

- `R106-P1-V1`：`self / relationship_note / report+reported+literal`；topic=`['work']`；source=`[2]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R106-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R107：主体：昵称称呼

原运行位置`122`；参考位置`127`；源码[backend/src/notalone/memory_extraction/cases/subject.py](../../backend/src/notalone/memory_extraction/cases/subject.py#L160)第160–169行。target=`[1]`；inputSHA=`e2e0ef606fca02439285d4b93aa113aba4a2e642346a3f6fd489529cbbaf8202`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：小北，你现在还自己做饭吗？
- 消息1 `self` / `2026-09-15T00:01:00+00:00`：基本都自己做，外卖一周最多点一次。

旧完整oracle规范SHA：`ea8e3c0e3c53da46889cf3c0c16af4810bf3356ba0a438a06f1e50de73553635`；原expect=`auto`；原strict=`null`，原值见JSON来源档案，未改。

**R107-P1 必需**：用户基本都自己做饭；保留基本程度，不用昵称替代self，不增强为每顿或总是。

- `R107-P1-V1`：`self / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0, 1]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：context0明确询问自己做饭，target1的基本都自己做沿该问句补足做饭；必须引用相连0和1，不借昵称换主体。

**R107-P2 必需**：用户外卖一周最多点一次；保留一周、最多和一次上限，不改为固定每周点一次或完全不点。

- `R107-P2-V1`：`self / preference / assertion+asserted+literal`；topic=`['other']`；source=`[1]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R107-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R107-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R108：严格：否定饮酒

原运行位置`123`；参考位置`128`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L60)第60–63行。target=`[0]`；inputSHA=`0fef8029a343f00f4dc18bd7f88ce20d36851d75a8b44a2d6fb3e7575e84c854`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我不喝酒，你们喝就行。

旧完整oracle规范SHA：`c88095c3c8dae414d9cd3f7cb465ec5640574b0eb0b51fc0551919e540ee5f34`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R108-P1 必需**：联系人不喝酒；保留否定，不改少喝或暂时不喝。

- `R108-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R108-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R109：严格：否定牛奶

原运行位置`124`；参考位置`129`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L68)第68–80行。target=`[0]`；inputSHA=`8c816fd4ed7519891823f08da71fdec2085e8b6e28c61f8c26e6b470029a4b18`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我从来不喝牛奶，早餐喝豆浆。

旧完整oracle规范SHA：`0c71374344d62ae7e4a894ad84cf887c2470ab41488acde82fc7c05734a86d6a`；原expect=`auto`；原strict=`2`，原值见JSON来源档案，未改。

**R109-P1 必需**：联系人从来不喝牛奶；保留从来不，不改为少喝或过敏。

- `R109-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R109-P2 必需**：联系人早餐喝豆浆；保留早餐限定，不说所有时段只喝豆浆。

- `R109-P2-V1`：`contact / preference / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R109-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R109-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R110：严格：偶尔徒步

原运行位置`125`；参考位置`130`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L85)第85–88行。target=`[0]`；inputSHA=`ada93b803eae2d6cedaa0ad43d0820ac2abbd461840a46ca032109ef4359d961`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我偶尔去徒步，并不是每周都去。

旧完整oracle规范SHA：`3711f5c396cac44eab73703e9272e2dfe2a366f7dde24c0cdaf50b5bfd1fcc5d`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R110-P1 必需**：联系人偶尔去徒步，并不是每周都去；保留偶尔与每周否定，不增强频率。

- `R110-P1-V1`：`contact / preference / assertion+asserted+literal`；topic=`['travel', 'other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R110-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R111：严格：养猫数量

原运行位置`126`；参考位置`131`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L93)第93–105行。target=`[0]`；inputSHA=`47ec2f823c6a0a98eb69fb40109a6721ac9d0907019b63282c1a6b2075c154e5`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我家养了两只猫，没有养狗。

旧完整oracle规范SHA：`d95143f611e4ca3f4e5f157e3fd731965ef9d20a4726e3d1be21c35e190074a9`；原expect=`auto`；原strict=`2`，原值见JSON来源档案，未改。

**R111-P1 必需**：联系人家里养两只猫；保留两只数量与家里，不改成两种猫或其他人的猫。

- `R111-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R111-P2 必需**：联系人家里没有养狗；保留养狗否定，不推永不养狗的偏好。

- `R111-P2-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R111-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R111-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R112：严格：降雨前提

原运行位置`128`；参考位置`132`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L118)第118–122行。target=`[0]`；inputSHA=`a1680c837cb04fc3e1ef92730f544d120b09280cb5f835a52a7e45e5fe87723d`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：明天要是不降雨，我才去露营。

旧完整oracle规范SHA：`2a5308a134ed030918b518cd20e71865c6f8d23a1527cfcb5df5c24da3743d97`；原expect=`pending`；原strict=`1`，原值见JSON来源档案，未改。

**R112-P1 必需**：联系人明天要是不降雨才去露营；完整保留次日、不降雨的必要前提和才，不说会无条件露营或天气确定。

- `R112-P1-V1`：`contact / recent_state / plan+conditional+literal`；topic=`['travel', 'other']`；source=`[0]`；`valid_at=2026-09-16T00:00:00+00:00`，`invalid_at=2026-09-17T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R112-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R113：严格：现场工作限定

原运行位置`129`；参考位置`133`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L127)第127–131行。target=`[0]`；inputSHA=`776a1910fad37fcc1c583f3bc7eee9486487c9943d5631885b61bfe711183179`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我只有周三去现场办公，其他工作日都远程办公。

旧完整oracle规范SHA：`19184998f49e7f8294d6aabe3211d8a17f333321e9fc9c2e758e8a7c15bb3fa0`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R113-P1 必需**：用户只有周三去现场办公，其他工作日都远程办公；完整保留现场/远程互补、只有周三与其他工作日，不把周末也写成远程。

- `R113-P1-V1`：`self / preference / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R113-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R114：严格：姐姐职业

原运行位置`130`；参考位置`134`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L136)第136–144行。target=`[0]`；inputSHA=`5463b6852dfc35c0de1a673fc7ef35b552bf6b7478b98fabbaf46c57c99b92c7`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我姐在苏州做设计，我在无锡做仓库管理。

旧完整oracle规范SHA：`de17c13c631a3ba418c822675621f3221da5885542814779dfef9691828b684a`；原expect=`auto`；原strict=`2`，原值见JSON来源档案，未改。

**R114-P1 必需**：联系人姐姐在苏州做设计；是明确姐姐的职业资料，不是联系人在苏州，不补公司、职业资格或现实核实。

- `R114-P1-V1`：`contact / relationship_note / report+reported+literal`；topic=`['family', 'work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `pending`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R114-P2 必需**：联系人在无锡做仓库管理；不把姐姐设计工作拼入联系人职业，不补机构或工作年限。

- `R114-P2-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R114-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R114-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R115：严格：工作期间跨度

原运行位置`132`；参考位置`135`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L162)第162–166行。target=`[0]`；inputSHA=`171864b3b09d9aee9037b03e31dc39197f2caafd00188b365e0c5d0607861ffe`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：本周一到周三临时在南区值班，周四回原办公室。

旧完整oracle规范SHA：`e9e4721307a135329499a0c619340e15a587418f375f1f9b40f2085505879e9d`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R115-P1 必需**：用户本周一到周三临时在南区值班；完整期间为9月14日至17日零点；非永久工作地点，不把周四返回未来安排合成当前事实。

- `R115-P1-V1`：`self / recent_state / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-14T00:00:00+00:00`，`invalid_at=2026-09-17T00:00:00+00:00`；理想benchmark `auto`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R115-P2 必需**：用户安排本周四回原办公室；尚未回去，不说南区值班继续到周四结束或再补具体办公室。

- `R115-P2-V1`：`self / recent_state / plan+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=2026-09-17T00:00:00+00:00`，`invalid_at=2026-09-18T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R115-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R115-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R116：严格：历史学习时间

原运行位置`133`；参考位置`136`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L173)第173–177行。target=`[0]`；inputSHA=`d0cc934d170d09d62d64394d80e224f62df2ead31c1662667600d767f7519b18`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我是去年春天学会游泳的，不是今年。

旧完整oracle规范SHA：`0cfd74eadc5b68d49898fc27ec6bec13a64188f7df076d22e51aade8c470a95d`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R116-P1 必需**：联系人去年春天学会游泳，不是今年；保存学习完成与年份否定，不补2025年精确日期、熟练程度或更正动作。

- `R116-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R116-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R117：严格：取消安排

原运行位置`134`；参考位置`137`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L182)第182–186行。target=`[0]`；inputSHA=`15827da1360ac4def45d171146b2f1a675e5f2f944548d83a94d63f70fed97ae`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我们原定周六去看展览，已经取消了。

旧完整oracle规范SHA：`ffb7ae94c8d15ded3c4289c57d5c50dd78554f16a4b2e7ebefef1620a1c62909`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R117-P1 必需**：双方原定周六去看展览的安排已经取消；取消已发生，不写仍有效、已经看展或一方单独取消。

- `R117-P1-V1`：`shared / common_fact / assertion+asserted+literal`；topic=`['other']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R117-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R118：严格：当前与未来分离

原运行位置`135`；参考位置`138`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L191)第191–197行。target=`[0]`；inputSHA=`7ef0e1862b682a448f7356324067921f3f2ca159405bbdf8ee9c3dbf70857763`。

- 消息0 `contact` / `2026-09-15T00:00:00+00:00`：我现在在南京工作，下个月准备去青岛参加培训。

旧完整oracle规范SHA：`4d7e61d3081a93a2f9b1dacc3a70a23e748685c9dce701f023e3755590279e73`；原expect=`auto`；原strict=`2`，原值见JSON来源档案，未改。

**R118-P1 必需**：联系人现在在南京工作；稳定任职地点资料，不补公司、职位或永久不变。

- `R118-P1-V1`：`contact / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

**R118-P2 必需**：联系人下个月准备去青岛参加培训；未来安排与南京当前工作分开，不说已到青岛、已培训或南京工作结束。

- `R118-P2-V1`：`contact / recent_state / plan+asserted+literal`；topic=`['study', 'travel']`；source=`[0]`；`valid_at=2026-10-01T00:00:00+00:00`，`invalid_at=2026-11-01T00:00:00+00:00`；理想benchmark `pending`。
  时间：字段仅为来源时区可推算的观察点或资料检索期间，正文须保留原期间；不声称事件在边界精确开始或结束。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R118-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。 不得与R118-P2的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

### R119：严格：明确职业正向

原运行位置`137`；参考位置`139`；源码[backend/src/notalone/memory_extraction/semantic_evaluation_cases.py](../../backend/src/notalone/memory_extraction/semantic_evaluation_cases.py#L215)第215–219行。target=`[0]`；inputSHA=`5b90b4bae0bc1a1bce9b7154e809df9b7d3a6cf6610b2ba78f2da190562a3c72`。

- 消息0 `self` / `2026-09-15T00:00:00+00:00`：我在宁波的博物馆做讲解员，已经工作三年了。

旧完整oracle规范SHA：`bb468d78c05c259aa47d26e0865f6a55b1fa48ae0d5ca4fff59f77936fcb9547`；原expect=`auto`；原strict=`1`，原值见JSON来源档案，未改。

**R119-P1 必需**：用户在宁波的博物馆做讲解员，已经工作三年；保留城市、机构类型、职位与三年时长，不补馆名、入职日或联系人职业。

- `R119-P1-V1`：`self / common_fact / assertion+asserted+literal`；topic=`['work']`；source=`[0]`；`valid_at=None`，`invalid_at=None`；理想benchmark `auto`。
  时间：无明确期限的已完成动作、历史经历或长期事实，双null；原文相对发生时间留正文，不用来源日当发生日。
  风险：来源未给敏感风险，允许[]或合法低风险标记；不能补财务、健康、身份认证或虚构后果。
  歧义：该完整命题的人物与限定可确定，alternatives须为空；未来、条件或本人不知道本身不制造第二种现实猜测。
  理由：简短指出本窗直接来源与所保留限定；不新增执行者、因果、地点、永久认证、此前行为或内部推理。

禁止：不得新增原窗未给的身份、金额、动作执行者、所有权/受益人、目的地、已经接受/执行、具体日期、因果、长期偏好或现实认证。 不得与R119-P1的完整人物、否定、数量、程度、条件、阶段、期间或来源范围矛盾。

## 装配验证和数据影响

待审切片（提交`9d44e5fb`）仅处理公开合成来源与既有D2合同，不读取dotenv／凭据，不调用模型／socket／DNS／HTTP、App、微信、PG或业务写入；Git只读状态和diff核对，不提交。没有导入模型输出或按新参考重算旧成绩。实际离线验证见`.scratch/grounded-evaluation/reference-source-fidelity-v2-spec-20261016.md`；该切片交付时独立两轴仍待Root组织，后继实际审查见下节，最终运行合同与冻结另接。

提交`9d44e5fb`中的`validate_full_public_reference`显式v2只核固定路径／摘要、parent21、E14／V4、日期／来源／映射／规则作用域及结构，当时返回review_pending=true与execution_ready=false；纯结构Seam不生成审核packet，也不改真实pending状态。旧默认校验、评分及已审准入门保持。本文件不嵌自身或配套JSON最终SHA，避免循环摘要；JSON只绑定本文字节SHA。

## 2026-10-16 后继审核资格记录

Standards `grounded_eval_standards` 核9文件、绑定与不变性0项；Spec `grounded_eval_spec` 独立核实际source、contact sender／target 0、D2第87行及A05语义0项。本次语义复审仅A05及直接通则；full140核装配与不变性，其余139及R105延续旧独审。不是新盲标、现实真伪、模型质量、运行冻结或维度放行。

待审切片原件在本地提交`9d44e5fb`完整可达，其pending状态与旧摘要不作追溯改写。本次只如实更新审核元数据和固定绑定，窗口、输入、命题、分母、来源选择不变；旧成绩不重算。后继完整140固定协议另见[装配记录](../grounded-evaluation/full140-v4-reference-integration-20261016.md)。
