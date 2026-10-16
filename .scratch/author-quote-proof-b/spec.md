# 作者到家事件的有限引句包装兼容

日期：2026-10-16。状态：有限实现、隔离验证及独立双轴审查完成，已整合主树；实际结果见[验证记录](result-20261016.md)。来源为用户明确采纳[决策稿 B](../grounded-evaluation/typed-proof-representation-decision-20261016.md)并要求实施及验证；它是原[按维度放行03](../memory-accuracy-next/issues/03-per-dimension-rollout.md)的有限工程切片，不完成该票的广泛质量 AC。

## 问题、目标与边界

grounded 编译器保留作者引句，而 ADR-047 的旧有限候选语法只接受直接改写，二者对完整“作者刚到家”事件不能接通。本切片将严格包装作为同一原事件的候选表示，经同次 V 提案和独立全文解析生成依据；不新增通用发言主张，不剥引号后伪装旧规则。

只接受可信单消息、恰一 target、候选唯一来源且当前活动来源链完整的 `AUTHOR_ARRIVAL_H1`。来源去除首尾空白后仅为 `我刚到家` 或 `我刚刚到家`，可带一个末尾 `。`。候选去除首尾空白后仅为 `用户原话：“<完整来源去除首尾空白后的正文>”` 或 `联系人原话：“<同上>”`；内部逐字一致，包括来源已有的句末标点，不做模糊归一化。

独立核 actual sender、外层作者、内文第一人称和 fact.subject 一致，完整事件为 arrive_home/completed，recency 为 just，category=common_fact，语用 assertion/asserted/literal，valid_at/invalid_at 均 null，frame=direct。新包装分支按已完成客观事件收紧分类，旧直接arrival规则不重解释。刚不能生成绝对日期。日期前缀、上下文括号、续句、多引句、额外尾句、嵌套引用、否定、条件、其他事件及多消息均不在正例范围。

## Implementation Decisions

- 保留 `verify_proposal/reverify_basis` 纯 Interface 和现有 I/O 分工。先核实际跨度；非法结构/位置继续严格失败，不静默丢弃 proof。范围、可信来源和正文语法不足仍按当前原因 UNKNOWN；包装不证明现实事件为真。
- 新增显式 `nullable-proof-v2`，仅供显式离线 producer；不改生产默认或任何既有真实执行计划。旧 `legacy-v4` / `nullable-proof-v1` 拒新版本，旧版本语义不变。新模式保留同次 V、原四字段合同和只降不升；缺失/null proof 不自签。
- proof version=2，仍仅 version/atom_links/reference/reported 四键；仅允许 `AUTHOR_ARRIVAL_H1/author_quote_h1`、direct。须有完整原事件 atom link、作者自指 reference link、direct reported link。原文和候选位置始终是实际字符串 Unicode 码点半开区间；候选 atom/reported 覆盖完整包装，不能只提交内文或作者锚。来源链接完整覆盖现有到达产生式，沿旧首尾空白/可选一个句号规则；reference 是来源内作者“我”的自指，外层作者另由程序独立核验。
- 旧 RULE_VARIANTS、旧 _GRAMMARS、旧规则集摘要和 basis1 装配语义保持。新增规则/表示注册及摘要独立，不用修改全局摘要重新解释旧依据。
- DimensionEvidence version=3，保持现有十一键；SemanticBasis version=2，arrival rule_version=2。外层2仅配旧basis1或null，外层3仅配新basis2或null，交叉版本拒绝。旧 NULL/v1/v2 不回填、不重采纳。
- 新 basis 保留现有完整图字段，增加严格 `representation` 和 `capabilities`。representation 只含 version=1、kind=author_quote_h1、source（完整来源 MessageSpan）、candidate（完整包装 TextSpan）、author（外层作者 TextSpan）、inner（完整引句内文 TextSpan）；不存正文。首尾空白可以在全文边界之外，内文和来源去除首尾空白后逐字一致；图内事件及限定坐标必须映射回实际 fact.text，不用临时去包装字符串坐标代替。
- capabilities 由服务端独立解析后生成，固定封闭集合，不接收模型布尔值或自由能力。`author_binding → subject`；`arrival_event_preservation → paraphrase`；`author_self_reference → reference`；`direct_attribution → reported`；`recency_preservation → time`。每项均需对应完整图、表示及来源复核；不能沿用旧 v2 basis 非空即全四项映射。仅作者/引句对齐不能签 reference/reported，truth_intent/media 继续原独立路径。
- binder、保存事务、读取和确认前按当前实际来源重新解析同版本完整 basis；改作者、正文、阶段/语用/H、任何必要跨度/摘要/能力/来源状态均失效。生成 hash 或 source_bound 布尔不能替代重验。
- 新增下一编号前向 SQL 迁移，056/057不改；旧库明确拒绝新外层版本，新迁移仅隔离库验证且重复为空。查看/API导出保留版本、能力与无正文定位，跨 owner_id+contact_id 拒绝。候选拒绝/删除、来源删除和整窗来源失效清除依据并复核残留。

实现预计涉及 source_proof、verification/verification_adapters、evidence、memory/dimension_evidence、dimensions、persistence/dimension_evidence 与 memory_store、新前向迁移和必要测试；可以依职责提取内部小模块，但不扩展为通用 AST。grounded 编译器、Gold、现有评分器和真实执行入口不改。

## Testing Decisions

沿用户已批准 B 决策稿的四个 Seam，使用 TDD 每个垂直切片先红再绿：

1. verify_proposal/reverify_basis：可信 self/contact、刚/刚刚、句号/空白与非ASCII坐标；错误作者/subject/语用/H、部分包装、尾句、嵌套引用、否定/条件、其他事件、额外上下文、不可信/失效来源、缺链接、越界/bool/float/错UUID负控。检查真实关系与失败原因。
2. 实际 grounded-v3 编译 → 单次 Fake V adapter → 严格解析 → build_dimension_evidence → binder → 维度合取；不得手注 basis/source_bound。检验缺 proof 不自签、旧模式拒 proof2、弱锚不签全维度、默认空放行表仍 pending，原语用/0.7/风险门保持。
3. 新依据序列化往返、明确版本配对、摘要/坐标/能力/原文/语用/来源状态篡改，旧 basis 按旧版本回归。不能从预期生成函数生成断言期望，重要坐标用独立手算字面量。
4. 实际受控 loader/producer → 隔离保存事务 → 回读/API导出 → 确认前重核 → 跨scope拒绝 → 拒绝/候选删除/来源删除及残留复核。复用现有 v2 隔离持久测试 Seam，业务库不连接、不迁移。

最小相关单元与类型检查先运行，再跑完整相关集成；完成后 Standards 与 Spec 两轴独立审查并本地提交。保存真实红绿日志和隔离资源清理记录；实现结果另写，不以规格推定通过。

## Out of Scope

不新增模型请求、供应商、自动重试或后台读取；不补造原公开窗口的 trusted 元数据、不修改旧冻结原件/Gold/审核、不补签 A05；不新增业务库迁移、放行类、用户确认事实或现实认证。默认空表、生产 grounded-v2、所有相关维度合取、原语用/0.7/风险门及用户亲自发送继续。四类实施控制不证明真实模型提供 proof 的质量，不覆盖通用指代/转述、跨消息、省略、多第三方、产权、原核心5命题及留出集，也不拼历史样本凑≥15。
