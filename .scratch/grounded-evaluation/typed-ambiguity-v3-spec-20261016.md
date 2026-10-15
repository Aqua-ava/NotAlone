# grounded-v3：受控歧义类别与固定解释

日期：2026-10-16。状态：显式离线实现、回归及独立双轴审查已完成；没有真实 v3 模型成绩，生产默认仍为 v2。主 Agent 在 remaining8 已关闭、owned worker group 消失并独立核对原冻结 73／73 一致后授权接续实现。原运行证据、审核和预算均不修改。

## 用户问题与已有证据

当前 `grounded-v2` 让模型标注程序已定位的原文分句，再确定性编译原十四槽候选。它禁止模型自由生成正文、日期、理由及替代解释，保住了原话与来源边界；但每个标签只有 `unresolved: bool`，编译器无论遇到哪类歧义，都只生成“原文指代在本窗口无法唯一确定，保留原句。”。

[旧官方 DeepSeek 结果](deepseek-public21-result-20261015.md)中，A07 的通用说明没有分别保存来访者身份与“家里”归属未知，A10 的两条候选没有给出借入／借出两种方向。这是现有字段表达能力不足，不能只改提示词后声称已解决。完整判据仍以[冻结前来源标注](../unfinished-work/memory-gold-agent-annotations-20261012.md)为准，不能用本规格改写旧 Gold、已封审核或旧成绩。

本片解决“原句存在何种未决解释，以及如何有界展示”，不解决实际人物消解，也不让解释变成关系事实。A03 的 `kind`、A10 否定借款的 `sensitivity` 是独立的模型标签问题；A08 的前缀最低置信度传播、A13 的混合去向及 `bad_auto` 裁决已有明确合同，本片均保持。

## 约束与 ADR 边界

遵守 [ADR-027](../../architecture/adr/027-memory-accuracy-evaluation-gate.md)的修错范围、只降不升及逐类质量门槛。`owner_id + contact_id`、目标分句和来源范围、依赖、期间计算、原十四槽下游接口、语用／风险／置信度门、V 只降不升、typed source proof、默认维度放行表为空均不变。不自动采纳歧义候选，不生成 `semantic_basis` 或将结构合法冒充语义证明。

与 [ADR-051](../../architecture/adr/051-grounded-memory-extraction.md)“模型不能提供自由正文、替代解释、理由、日期或任意风险文字”的现有表述存在需明确修订的边界：新增的是封闭枚举标签，解释字符串仍完全由程序固定渲染，模型不能写 `alternatives`。[ADR-058](../../architecture/adr/058-controlled-ambiguity-labels.md)现已明确补充这一例外及版本边界，保留 051 的历史原因；没有直接覆盖旧 ADR。

## Implementation Decisions

### 1. 显式版本，默认选择不改

新增显式 `grounded-v3`，只在明确选择该模式的离线评测与测试中启用。`GroundedExtractionRuntime(model=...)`、现有生产装配及评测省略参数时的默认行为保持原样；生产不在本片自动迁移。旧 `legacy-e14`、v1 和 v2 输入、记录、追踪及回放保持原协议解释，缺少版本的旧冻结不得推断成 v3。

建议新增公开接缝 `grounded_schema_v3(window)`、`compile_labels_v3(window, draft)` 和 `GroundedV3ExtractionRuntime.extract(window)`。工具名使用 `GroundedMemoryLabelsV3`，避免 v2 与 v3 返回互相误收。新追踪和评测的实际协议均标记 `grounded-v3`；一次实际调用、一次原样响应、一次确定性编译，结构失败整窗可见拒绝，不回退 v2、不增补模型修复调用、不隐式重试。

### 2. 唯一新增模型字段

每个原先已命名的 target 标签新增必填 `ambiguity_codes`。其他七个字段及语义保持。示意：

```json
{
  "units": {
    "0:0": {
      "kind": "plan",
      "subject": "contact",
      "topic": "other",
      "dependency": null,
      "unresolved": true,
      "ambiguity_codes": ["entity_identity", "place_ownership"],
      "confidence": 0.8,
      "sensitivity": "none"
    }
  }
}
```

`ambiguity_codes` 是最多四项的字符串数组，封闭取值如下。它只说明未决的类别，不包含人物、金额、方向选择、日期或事实值。

| code | 模型标签语义 | 程序说明应表达的内容 |
| --- | --- | --- |
| `entity_identity` | 原句所指人物或群体在当前窗口不能唯一定位。 | 人物身份未明；不能列举猜测姓名、亲友身份，不能把“他们”推成家人。 |
| `place_ownership` | 原句所指地点，尤其“家里”的归属未明。 | 地点／所指家里归属未明；不能认定是用户、联系人、来访者的家，也不认定法律所有权。 |
| `borrowing_direction` | 原句允许“向对方借”与“借给对方”的方向读法，窗口不能唯一选定。 | 两种方向都明确展示，均沿用原人物、肯定／否定与完成程度，不选其中之一。 |
| `other_unresolved` | 存在上述三类以外的实质未知，例如所指事项不明。 | 明示当前窗口仍有其他未决解释，保留原句；不能代替应已列出的具体类别。 |

动态 schema 为每个 target 建立精确对象键，不让模型填写 `unit`，不新增自由字符串。数组设置枚举、最大项数、`uniqueItems`；`unresolved=false` 时只能是空数组，`unresolved=true` 时至少一项。保留现有第三人依赖约束、`additionalProperties=false` 和全部 target 必填。供应商是否强制实施 schema 不能作为本地信任依据。

本地编译器独立检查精确字段集、数组实际类型、每项实际字符串类型、未知值、重复值和 `unresolved` 一致性。缺少字段、`true + []`、`false + 非空数组`、额外 `alternatives/text/name/role/date`、越界键或损坏依赖均整窗拒绝。不能静默补空数组、丢弃未知码或去重后继续。

“漏项”分开处理：结构上的缺字段和未决却空码可确定性拒绝；模型只标身份却漏标地点归属，属于语义遗漏，不能假装程序由编号自动证明完整。新提示要求列全同时存在的类别，V 和人工来源审核逐项判错；不得按用例编号或 Gold 自动补类别。原有裸第三人无依据的保守兜底仍只能降级；若原规则把候选降为未决，v3 必须同步保留 `entity_identity` 说明，不制造消歧证据。

### 3. 固定渲染与原句绑定

固定顺序为 `entity_identity`、`place_ownership`、`borrowing_direction`、`other_unresolved`。身份、地点和其他类别各生成一条；方向生成两条，因此每个候选最多五条 `alternatives`。渲染器不接收模型解释文本，只接收校验后的枚举集合、当前候选已经持有的原文分句及既有依赖原文。不得查询窗口外人物、其他联系人或来源。

固定说明可使用“原句所指人物身份在本窗口无法唯一确定”“原句所指地点／家里归属在本窗口无法唯一确定”等模板。方向解释必须显式出现“向对方借”和“借给对方”，并把**当前对应引句及其已选依赖原文逐字附在每一种读法中**。这两条是未决的方向说明，不是两条新的事实，也不增加候选条数或命题信用。

每一种方向读法都必须明确：人物由所附原句定位；原句中的否定仍是否定；不认定交易已交付、债务已形成或已还清。固定说明分别为“所引原句中的‘借’，一种可能的方向是向对方借入；人物与是否发生均以同条原引句为准，本窗不确认此方向”和“所引原句中的‘借’，另一种可能的方向是借给对方；人物与是否发生均以同条原引句为准，本窗不确认此方向”，后接该条的完整原引句与既有依赖原文。可以在实现前统一润色模板，但两种方向、原句绑定、非事实断言的边界须保持。

例如 A10 第二命题的两条说明均须完整可见“小王没借。”，不能输出肯定的小王借款事实；第一命题保留“借了，”及其原问的人物关系，不把老李、小王交换。不增加自由姓名、角色或 polarity 字段，不据 `subject` 猜借贷双方，不把联系人资料归属当成实际借款主体，也不为生成“没有向对方借／没有借给对方”的新句子增加否定解析器或按 Gold 句式写正则。方向是对原句谓词的两种未决读法，否定、条件和完成程度始终由逐字原句承载。

这项设计明确保留一个能力界限：如果实际 Gold 审核认为“固定方向说明＋逐字原句”仍不足以完整呈现某命题，结果应记为完整契约未满足；不得为了得分局部解析极性、补主体或预签 A10 通过。字段可表达两类方向，不代表模型选码正确，也不保证所有中文语境下的解释已足够清楚。

每条说明最多 8400 个 Unicode 字符，至多五条，故总长最多 42000 字符（UTF-8 最多 168000 字节）。程序检查最终完整说明，超限整窗可见拒绝，不能截断原句或否定、悄悄丢一类歧义后继续成功。该上界仅属于显式 v3，不限制或重新解释旧 v2 数据。

### 4. 合并传播与共享编译

现有定位在 [grounded_adapter.py](../../backend/src/notalone/memory_extraction/grounded_adapter.py)：`grounded_schema` 从 `GROUNDED_SCHEMA` 克隆每个 target 的标签，替换为精确字段及动态依赖枚举；`GroundedExtractionRuntime.extract` 执行一次调用、保存 `grounded_draft` 后调用编译器。[grounded.py](../../backend/src/notalone/memory_extraction/grounded.py) 的 `compile_labels` 把 v2 命名对象转换为内部 rows，再由 `_checked_compile`／`_compile` 生成候选。

可复用原分句、字段校验、依赖、日期、完成问答与原文拼接，新增 v3 外层严格校验及一个私有的受控歧义输入。v2 的公开 `ROW_KEYS`、schema、`compile_labels`、工具名和输出语义均保持；不能给 v2 公共入口新增宽松可选字段，或把默认分支改成接受 v3。v3 只通过显式私有路径把已验证码交给共享编译，不通过输出正文反查分句，也不复制整套编译器形成两个会漂移的实现。

前缀与条件前件合并时，按现有 members 并集传播歧义码，保留原最低置信度、风险和来源规则。依赖中的歧义不能无条件污染每个候选；只有原先实际参与合并／未决传播的来源范围才参加，不能扫描整窗标签补码。同一消息未知第三人同类资料的 `unknown_groups` 合并目前只续接原文、最低置信度及风险；v3 必须同步并集其已验证类别，再固定渲染，不能因后句的地点／方向码不同而丢解释，也不能多生一个具体人物实体。内部可保留分句对应关系，但不增加 E14 字段或业务迁移。

### 5. 提示与评测的最小接入

v3 提示只新增类别的语义、应列全实质歧义、两方向与否定保护，以及模型不能写解释字符串的限制。v2 提示保持字节不动。本片不顺带改 `kind`、风险、confidence 提示或评分，以便将协议表达能力与模型语义表现分别归因。

显式评测选择应沿现有 [evaluation_extraction.py](../../backend/src/notalone/memory_extraction/evaluation_extraction.py) 的 `EvaluationExtractionMode`、`extraction_contract`、`extraction_tool_name`、`extraction_runtime` 扩展；记录器、请求合同、分阶段审计对 grounded 模式的白名单也必须精确接受 v3，并保留逐窗实际 input／prompt／schema 摘要。不得仅改 enum 却绕过动态请求校验，或伪装为 v2。旧 guard 和缺省选择保持。

现有 remaining8 模式有固定 v2 协议守卫，本片不把它改成任意 subset 或新协议入口，不修改旧 73 文件冻结及其证据。后续 v3 的真实计划应独立说明集合、模式、顺序和预算；只在必须的选择边界接入，不先建立通用 Harness、预算平台或自动迭代循环。

## Testing Decisions

实现沿纯 `compile_labels_v3` 和单次 `Runtime.extract(window)` 接缝逐片 red→green。这里列验收行为，不预写镜像实现的测试，不用真实网络证明本地结构规则。

1. **结构与兼容性**：v3 缺字段、真假与数组矛盾、重复／未知码、错误类型、非 target 或自由字符串字段均失败；全部合法组合及枚举顺序变化产生确定输出。v2 固定基线输入与完整 E14 输出保持逐值一致；v2 拒 v3 字段，v3 拒缺码的 v2 标签，错工具／错版本可见失败。
2. **同时存在的未知**：使用未出现在旧样本中的人物和地点表达验证身份＋地点两码都可见；只一类未知时不多造第二类。多个成员与同消息第三人合并的码不丢失、不重复、不改变原文顺序、资料归属和来源。
3. **借贷方向与否定**：分别覆盖明确两读、正负复句、问答依赖、不同说话人及人物顺序。两条方向解释均携带对应原句与既有上下文，负项在两种读法都不能变成肯定；不能把借款请求推成已交付、补金额／还款、把姓名从其他句搬入。已明确“向／跟我借”或“借给我”的单向来源不得被模型无故标成两读；该错误进入语义审核，不能靠固定 renderer 伪装来源支持。
4. **保护反例**：未知身份不枚举具体人，“家里”不推成家人或用户参与；“我没说他借了”“并非没有借”“如果没借就……”等嵌套／双否定／条件只保留原句，不解析极性或改写借贷事实。未知事项不假称未知人物。书已读完的独立事实不因可选借书关系歧义被整体丢弃；不改变旧 A15 必需／可选分母。
5. **既有确定性边界**：时间只能来自来源，未支持期间保持未知；深依赖、环、后文／裸指代自证继续失败。原前缀 min confidence、风险传播和 A13 组去向裁决不改；任何新增码只可能阻断采纳，不抬置信度或授予 proof。
6. **实际 SDK 的本地 MockTransport**：断言一次 E 请求、v3 精确工具与动态 schema、无自由文本／额外调用；原始 labels、编译 E14、协议版本分别追踪；记录失败停写。默认生产 runtime 和 v2 请求仍走旧契约。评测漏 freeze、错版本、请求漂移须在发送／凭据前拒绝；分阶段 raw 封存后不能按 V 改写。

最小纯编译测试、实际 SDK Mock、相关提取／评测回归及类型检查完成后，进行 Standards／Spec 独立审查。文档或离线 Mock 通过均不等于模型已能正确选码，也不关闭三张记忆任务。

## 后续真实验证与完成判据

必须新建协议版本的独立 run 与 freeze，冻结实际完整源码 closure、安装版本、逐窗原 input／v3 prompt／schema、固定集合和顺序、官方 DeepSeek 配置、有限请求数、零重试、每次／整批绝对截止与关闭收据。原闭合 run、旧余额、旧 raw/full、旧 v2 成绩全部保留；不能把重放编译器输出当成新的真实模型成绩。

输入仍为已授权公开合成数据，不上传真实聊天，不访问业务 PG、App、CLI、凭据探测或自动发送。真实启用沿既有预算／审计合同，不因多了枚举省略 V、人工逐字段来源审核或安全停止；需要多少调用由主 Agent 在具体计划中合理固定，本草案不创建预算。

真实结果分别报告：标签完整合法、语义选码、各类实际歧义覆盖、原文／人物／否定、E14 与 V、必需 raw／程序接受／完整契约，以及 pending／auto／none。A07／A10 的修复只是回归；后续独立合成泛化样本必须覆盖相同维度且包含反例，不能按旧句子写特殊规则。

按 ADR-027，待申请某一维度放行时，该维度至少 15 窗／用例，假事 0、记错人 0、一般错误 ≤1，并另核相关字段依据与 typed source proof。若只完成旧 21 的部分或新小诊断子集，不得声称达标。质量通过不自动改默认空放行表；放行仍是独立证据记录与决定。当前未知 proof 不能靠新枚举补成 verified。

## Out of Scope

本片不切换生产装配、不修改 UI，不运行真实模型，不动剩余八窗执行器／计划、旧冻结、预算、Gold 或封存审核；由主 Agent 集成并本地提交。本实现不包含自由候选改写、通用人物／地点／借贷关系解析、外部知识查询、自动修复调用、A03／A10 风险提示调整、A08／A13 置信度或评分政策重定义、来源可信元数据补造、维度放行、业务迁移／回填、记忆与 Skill 演进十五票、双联系人或真实来信验收。

## 实现与验证记录

显式 v3 已接入纯编译、单次 SDK runtime、评测模式选择、动态逐窗冻结、编译记录和 raw→sealed→full 审核。原 provider contract 已按选择的工具名统一验证，不需增加供应商策略或放宽字段；官方最高思考、零重试、预算与硬停止合同仍复用。remaining8 明确拒绝 v3 的新增反例在预算与凭据之前生效。

首次红灯为 `compile_labels_v3` 缺失；后续独立红灯覆盖同消息合并丢后句歧义、借贷说明为空、超限未拒绝、runtime 缺失、评测不认识 v3，以及 phased audit 把 v3 当旧 E14。各片均先保存失败后实现对应行为。日志位于本机忽略目录 `desktop/artifacts/grounded-v3-red-*-20261016.log`。

最终完整记忆提取单元 440／440，5.186 秒；评测 ECNU／offline／SDK／wire 集成 99／99，20.180 秒；7 个修改源模块 mypy 通过。日志分别为 `desktop/artifacts/grounded-v3-final-unit-20261016.log`、`grounded-v3-final-integration-20261016.log`、`grounded-v3-final-types-20261016.log`。在激活 Conda `NotAlone`、设置 `NOTALONE_DISABLE_DOTENV=1` 后，从 `backend/` 执行：

```sh
python -B -m unittest discover -s tests/unit/memory_extraction -t . -v
python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline tests.integration.memory_extraction.test_evaluation_sdk_budget tests.integration.memory_extraction.test_evaluation_wire_contract -v
python -B -m mypy src/notalone/memory_extraction/grounded.py src/notalone/memory_extraction/grounded_adapter.py src/notalone/memory_extraction/evaluation_extraction.py src/notalone/memory_extraction/evaluation_offline.py src/notalone/memory_extraction/evaluation_records.py src/notalone/memory_extraction/evaluation_phased_audit.py src/notalone/memory_extraction/evaluation_ecnu.py --follow-imports=silent --ignore-missing-imports
```

Spec 独立审查发现 1 个 P2：同消息未知第三人合并时，后成员虽引用同来源消息的不同分句，但方向说明漏了该依赖原文。已用新公开合成反例先红后绿修复；v3 私有合并同时保存码与逐成员实际原句／上下文，未修改 v2 正文。独立增量复核 35／35，剩余 0。红／绿日志为 `grounded-v3-review-red-context-20261016.log`、`grounded-v3-review-green-context-20261016.log`。Standards 独立审查明确违规 0、smell 判断项 0，亦增量核对了该修复；两轴最终剩余问题均为 0。

全为公开合成输入、本地 MockTransport 和隔离临时预算；没有实际凭据、真实网络、业务 PG 或 GUI 操作，也不据此声明质量达标。另一个扩大检查曾运行真实模型冒烟入口，但因未提供专用凭据而跳过，没有真实模型调用；该跳过不计入上述最终 539 项通过。
