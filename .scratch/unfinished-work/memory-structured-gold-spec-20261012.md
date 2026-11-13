# 结构化标准答案与显式审核计分规格（2026-10-12）

> 承接[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)，基点`b947e853`。本片仍只做离线评测工具，不新增产品功能、不读取真实凭据或调用供应商，OCR暂停。21窗中文判据已独审，用户只抽查A14为none。

## 问题与交付

已交付的[ECNU入口](../../backend/src/notalone/memory_extraction/evaluation_ecnu.py)要求独审回调，但中文标准答案尚未结构化，窗口级safe／general_error不能替代逐字段对账。本片把已核定的21窗、28必需＋1可选命题装配成公开合成JSON，并提供显式Agent审核表的完整性校验和计数。机械工具不自行判断中文语义，不以关键词、旧matcher或V=supported签语义正确。

## Implementation Decisions

1. 参考文件固定三层：reference→windows→claims／variants。每窗绑定位置、公开名称、input摘要与target索引；每命题有必要含义、required标记及禁止项。variant将正文条件、来源选择、subject／category／topic、语用、日期和理想去向绑定为整组，不取允许字段的笛卡尔积。通用E14／V4、confidence、风险、歧义、理由和日期政策保留明确中文判据与来源。
2. 参考provenance明确Agent标注、已见旧oracle、独立技术复审、只A14用户抽查；文件摘要和合法结构都不是模型质量认证。加载时核定21窗、28必需＋1可选、A12/A14 none、公开名称／顺序／输入／target和原中文判据摘要。不存在可执行默认放行或隐式改旧期望。
3. 新公开Seam为`prepare_case_review(reference, case_id, evidence)`和`score_case_review(packet, review)`：evidence只包含允许的合成原E、实际V输入、原V、最终facts和原matcher结果；packet冻结整套证据摘要、各层全量索引和原payload摘要。所有实际E和V返回项，包括被拒／重复／额外及none窗输出，必须一行一审。
4. review按索引／摘要显式填写E14字段、V4字段和V语义、人物／事实安全、纳入性、E→V→最终对应判断，结果只取`pass/fail/unresolved`。使用原句和独审参考，模型自己的理由不作为独立证明。无默认pass；缺行、多行、重索引、证据／参考漂移或非法枚举拒绝评分，无法核清的对应留unresolved。
5. 每个命题显式给出候选证据组、variant及raw含义、拆合联结、来源／分支／最终对应和去向审核。覆盖允许many-to-many，同义／忠实合句可有raw信用；单一字段不能满足不同日期／语用的两个完整契约。忠实拆分必须整体有据且每个成员原字段均审，不跨错误输出挑字段拼正确答案。重复不增加命题信用，错误重复仍单独计。
6. 机械报告分别给出固定必需／可选分母、raw／接受／完整契约覆盖、逐字段失败／未决、额外／重复／排除输出及安全项。程序接受必须关联实际最终层且去向不为none；完整契约还须整个证据组E14、对应V与分支／来源／日期／去向审核通过。未知／失败／未运行保留分母，不当空none。语义判断可信度来自审核者，结果始终`quality_certified=False`，旧matcher结果完整另报。
7. shared批次回调最小补入已脱敏保存的`provider_requests`，用于核实际V输入与原candidate_index关系；不读取内部思考、headers或秘密，不猜V序号等于E原序号。本片不增加真实执行main、默认审核器、供应商／模型fallback、自动P2或放行。

完整契约计数另核可直接比较的variant字段：subject、category、有限topic、三个语用字段及两带时区日期的同一时刻；每个证据组成员须各自匹配，明显不合不能靠误填pass计full。来源UUID按公开case名和原索引确定，须落在完整允许集合；source_choices的正文适用条件仍由Agent审核，不用关键词猜。重复来源不增加信用，另保留审核问题。

failed／unknown仍保留已捕获且明确独审通过的E raw信用，区分提取漏失与后续V／运行失败；接受／完整信用和正确none为0。unrun仍全0，不给不存在的捕获造覆盖。

公开装配门另设`validate_public_reference(reference, expected_reference_sha256=..., annotation_sha256=...)`纯Seam：期望参考摘要取实际独审固定材料，中文摘要由调用方从显式材料提供，函数不读文件或秘密；再核公开固定计划／分母／none／E14／V4与各窗结构。通用prepare可用于单窗工作例，不能代替这个真实21窗门。摘要绑定不认证审查者或语义。

prepare的全量packet同时含E/V/最终层，不能凭一个完整表格证明raw先审，也不声称首次盲审。真正执行前仍须装配先仅揭E视图、保存并封存raw审核、再揭V／程序层的审查次序与私有记录；这是最终运行冻结的独立缺项，不能以本片机械计分工具代替。

### 纯审核接口的数据形状

`evidence`恰含`run_status/extraction/verification_inputs/verification/final_facts/original_result`：依次为运行状态、原E事实数组、实际V候选数组、原V结果数组、带原destination的最终事实数组和原matcher结果。只接受有限JSON；不执行任意对象转换。`completed/empty/failed/unknown/unrun`分开，不把失败视作正确none。

failed／unknown可保留缺键或非法索引的原E/V JSON对象，完整覆盖强制为0；审核表仍列全14／4字段，缺字段不得填pass、非法V索引不得声称对应已通过。非对象或无法安全规范化的返回拒绝评分，原捕获保留为未评分失败，不删成合法空结果；completed／empty继续硬核合法外形与V索引完整性。

`review`绑定`reviewer/case_id/reference_sha256/evidence_sha256/run_status`，另含`e_rows/v_rows/claims/window_checks`。每个E行有原`raw_index/payload_sha256`、精确14字段的审核、meaning／inclusion审核、safety、classification、lineage和非空basis。safety取`safe/false_fact/wrong_person/ambiguous/unresolved`；classification取`required/optional/extra/duplicate/excluded`。lineage显式保存实际V输入与最终层索引及对应审核，不能只靠序号猜。

每个V行有原`result_index/payload_sha256`、精确4字段审核、semantic、对应E索引、lineage和basis。实际V输入和最终层全量归属必须交代。每个Gold命题恰一行`claim_id/groups`；每组列`raw_indices/variant_id/final_indices`及`raw_meaning/coherence/branch/source/time/lineage/destination`七个审核值。所有普通审核值只取`pass/fail/unresolved`，没有默认pass。窗口`window_checks`恰含`inclusion/forbidden_meanings/lineage`。

完全无法确定对应的实际V输入／最终项不猜归属：窗口lineage必须标unresolved，报告单列未映射索引，此项不获接受／完整契约信用。窗口lineage为pass却留下缺口则拒绝评分。已证实的其他组仍可保留raw／接受部分计数，整窗不通过，也不算正确none。

公开参考JSON的variant逐条保留body_requirements、subject、category、allowed_topics、source_choices（indices和when）、三个语用字段、两日期、time_rule、ideal_destination、risk_rule、alternatives_rule、reason_rule。无法证明索引对应时审核值留unresolved；摘要仅证明所审对象一致，不能把审查者判断升级为工具自动语义证明。

## Testing Decisions

- 参考装配Seam：公开固定计划、摘要、分母与有限variant完整性；以已有中文独审为独立依据，A02三分支、A06来源条件和A14 none不靠自生成期望验自己。
- 审核Seam：固定的合成工作例验证漏行／漂移停、正确候选V拒绝导致raw有但接受无、混合字段合句仅raw、拆分覆盖只一次、坏额外auto不被好候选掩盖、合法空与未知分开、未决不通过、V错判单列。逐片red→green。
- 批次Seam：回调实际收到已保存的脱敏请求，原P0及203项相关回归不变。禁止真实transport／socket／DNS和默认dotenv，不读私有结果；类型检查与双轴审查后任务专属本地提交。

## Out of Scope

真实模型运行、实际密钥、业务资料／写入、产品提示／schema／parser／旧matcher／case修改、默认维度放行、真实6/12改分、首次盲标或全窗用户认证、架构字段／迁移、新产品票和OCR／Mac启动。最终run ID、目录、期限、完整来源与版本冻结只在本片离线实现经审查后装配，不能把参考JSON的reviewed状态当作已完成一次真实运行冻结。
