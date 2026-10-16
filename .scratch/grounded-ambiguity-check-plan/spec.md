# 歧义核对：先补明确归属规则的显式提示

> 状态：设计双轴0；主 Agent已选择先prompt-only，E adapter离线切片及相关验证完成，待实现独审；checks不实现，不自动真实后继。
> 日期：2026-10-16。实现范围仅既有E adapter、对应SDK Mock测试及本目录spec／结果；不接真实runner／执行身份，不改ADR、旧合同／参考／结果、任务状态或放行表，不读凭据、不调用真实API、不创建预算。

## 问题与推荐

本稿推进[核心主张01](../memory-core-claim-retention/issues/01-diagnose-fix-and-replay.md)、[指代07](../memory-extraction-accuracy/issues/07-reference-resolution.md)、[逐维放行03](../memory-accuracy-next/issues/03-per-dimension-rollout.md)的共同缺口，不代签三票完成。[原21四槽场](../grounded-evaluation/reference21-semantic4-result-20261016.md)已 closed：A05 忠实保留原引句、出借／接收角色及历史动作，但没有明确所有者／指称未知，0.95 候选进入模拟 auto，已封 FULL 为 safety_error／contract_mismatch；V 不见 alternatives／reason，不能救完整契约。

只读核该场 `040b1621-542c-4f28-a150-a8d935add997` 的 event50—53：实际 E 请求完整含现有角色／owner／代词指导及八码 schema，原始参数已是 `ambiguity_codes=[]`、`unresolved=false`，adapter 逐值相同，编译未丢码。HTTP200、`finish_reason=tool_calls`、completion594／reasoning495，未见截断证据。reasoning 已按原策略移除，不能判断模型实际为何这样选。

**推荐先做新显式 prompt-only profile，暂不增加 checks schema。** 现有指导禁止按性别／亲属称呼认唯一，但未明确“最近先行词／窗口只提一个候选”是否足够证明物品归属。这是可补明的规则表达缺口，不能断言它就是 A05 内部成因。结构 checks 能使核对记录可审计，但合法却语义错误的 all-resolved 仍可过结构层，逐分句全维检查也可能误伤独立主命题。

## 已批准依据与原21逐窗兼容检查

[D2](../unfinished-work/goal-memory-dimension-proof-interface-decision-20261013.md)第87段及[参考 v2 修订](../grounded-evaluation/reference-source-fidelity-v2-spec-20261016.md)要求：A05 姐姐为出借施事、作者为接收方可明确，但不能以施事／性别填车主；未解归属保留未知。D2 的有限 typed Identity 语法不能泛化为“全部 E 指代都须另有固定 Identity 模板句”。已只读核原21全部输入和 v2 必需／可选主张，兼容要求如下；这不是新独审收据或模型成绩。

| 窗口 | 新指导必须保持 |
| --- | --- |
| A01、A03、A04、A07、A09 | 原人物、事项、地点未知及原肯定／否定、时间和风险；不补身份、产权 |
| A05 | 最近人物、唯一被提及的人、亲属／性别及出借角色不能单独证明车主；保留已明角色、历史经历和“她的车”，不反断言车不属于姐姐 |
| A02、A18、B02 | 完整相连话题问答可恢复老李／老陈／表弟的既有指称；不因没有独立 Identity 句统一降级。B02 当前“不知道”仍为联系人知识状态 |
| A06、A08、A11、A13、A16、A17 | 已明完成、书名、对象／数量及相连问答保持；不把购买者未明或无关产权强加到原主命题 |
| A10 | 老李／小王和正负两项保持，借入／借出方向仍未知；人物明确不证明方向明确 |
| A12、A14 | 原 none／排除范围保持，不为歧义核对制造资料 |
| A15 | 必需读完主张与可选借用关系分开核；方向／产权未知不使独立读完命题未知，可选关系也不强签确定 |
| A19、B01 | 独立偏好／计划、报价判断、未决定及条件咨询保持；不把明确知识状态误作模型证据不足，不凭“借”等词补码 |

不能把“位置或单一候选不足以证明产权”扩成“完整问答不能恢复人物”，也不能把全部候选标未知作为通过方式。上述21窗输入、Gold／参考、28必需＋1可选及理想去向均不改。

## 推荐切片的具体 Interface

提示 profile 为 `reference-uniqueness-v1`，仅 `GroundedV4ExtractionRuntime` 显式离线可选，尚未注册真实评测身份。复用既有 E adapter，增加封闭 `prompt_profile` 选择；原命名工具／动态 schema、`compile_labels_v4` 和 Flow 保持。默认仍返回旧 `GROUNDED_V4_PROMPT` 逐字内容，新 profile 只追加下段通则：

> 将第三人代词所称物品的所有权归到某个已知人物前，单独核对来源是否明确支持这条归属关系。最近出现的先行词、窗口只提及一个候选人、亲属称呼或代词性别本身，不能单独构成归属依据；出借、接收等已知行动角色也不能替代它。来源未明确该关系时，保留代词原字，并按实际未知选择物品归属及必要的人物指称类别；不补另一个所有者，也不反向断言不属于该人物。直接明示的所有者或有明确来源关系的指称不额外标未知。只核所保存主张实际依赖的关系，独立明确的动作、对象、数量、否定和历史性质继续保留。此处不要求每条消息另有固定 Identity 模板句，也不取消完整相连问答中已有的指称依据。

不改 kind／八码、正文／来源、依赖／合并／期间、confidence／风险、V／typed 或采纳门；[理由补全](../grounded-v4-ownership-reason/result-20261016.md)继续只表达既有码。v2／v3／v4 默认提示、schema 与行为做固定字节回归；生产默认 v2、空放行表保持。新 profile 要有新固定评测身份及 freeze，不能混入旧准入。它不是旧提示换名重抽；候选须实际包含新增规则，经兼容核对与独审，失败不反复调词到通过。

## 结构 checks 的备选与实质取舍

仅另一个新显式 E 合同可采用 checks，不自动叠加到上述切片。每目标分句保留原 kind、subject、topic、dependency、confidence、sensitivity；拟用精确包含原八码的 `ambiguity_checks` 替换冗余 codes／unresolved。每维必填状态、有限依据和实际分句引用：

| 状态 | 依据及映射 |
| --- | --- |
| not_applicable | 该维度不影响本项实际保存主张，basis=not_required；不生成码，不允许掩盖相关未知 |
| resolved | 所需范围内来源明确，basis=explicit_source／context_unique；不生成码，不认证现实身份／产权 |
| unresolved | 相关关系不能唯一确定，basis=insufficient_source／competing_readings；映射同名既有码 |

仍只用既有八码，other 不替代具体类，roles 与 owner 分别判断；程序按 unresolved 收集原 codes／布尔，再复用 v4 编译、固定 alternatives／reason和成员并集。引用只限当前分句及实际 dependency 链，不新增来源／依赖或 typed proof；不开放自由人物、产权故事或用户理由，不建持久 schema。缺维度、额外旧字段、未知值、状态—依据矛盾、链外／越界引用及原 guard 冲突整窗拒绝，不补默认、不修复调用。合法但语义错的 all-resolved 仍可能过结构层，须语义审核发现。

**具体成本是逐分句 checks 能否区分 A15 必需与可选关系**；若改为逐主张检查，会扩大当前一标签／编译 Interface，须先定清粒度，不能顺手生成自由候选或改 Gold。有限依据是否足以审计也应据实际控制决定。这些取舍支持先做 prompt-only，不需另建框架。

## 离线验证与证据边界

- 原 A05 捕获参数不改，经过旧默认与新 prompt-only 均仍应重放原无码 auto；改提示不能改写已返回参数。这是独立真实返回负控，不是给定正确码的自证。
- 新 profile 的实际 SDK Mock 请求须含新增通则，旧默认字节保持，错配 profile 拒绝；已有正控只核编译／门不变。明确所有者、相连问答、无关产权及独立已完成主张作过度保守负控；不按用例 ID、关键词或 Gold 补码。
- 若选择 checks，旧响应因缺 checks 严格拒绝只证明结构完整性；另保留结构合法但语义错的 all-resolved，让独立语义参考判失败。给定正确 checks 只证明映射。
- 沿现有公开 adapter／compiler／Flow seam 做 TDD、最小后相关回归、类型及双轴审查；不增 runner／harness／调用轮次／供应商。Mock 不能证明新提示能改善模型质量，已执行的离线检查见[实现结果](implementation-result-20261016.md)。

## 三层真实验证次序与预算边界

本稿不分配预算、不读凭据、不启动模型；旧场／余额保持 closed。持续授权不被本稿改写，具体新合同和资源由主 Agent 按现有范围判断并冻结，不新增抽象用户审批门。

1. **原21同场主集**：一个候选 profile，原顺序 A01—A19、B01／B02及参考 v2 不变。拟议另新 cap42、零重试、官方 DeepSeek、原 E max／V off 具名、四槽作者包装、4小时及较早截止；沿同 reference21 helper／审核桥／硬停。A01—A16 的≥15只按本场实际完成且正式审核的窗口统计，不以命题数、补充窗或旧场拼足；还须假事0、记错人0、一般错误≤1及原安全条件。
2. **同场核心 B01／B02**：按原顺序到达时核3＋2必需的 raw／接受／完整契约、全部 E14、正例损失与去向。主集完成不代签核心，B01不代替B02，未跑到即 unrun；不借旧场或单独补窗拼完整21。
3. **另新完整140合同**：仅原21有可解释完整结果并覆盖核心后，再决定完整回归。保持140窗／138必需＋1可选和独审参考，拟议另新 cap280、零重试、独占 worker／期限及 freeze，额度不转移。新 E profile 和140的 V配对须单独固定；旧 nullable 身份不能静默换四槽。若用纯语义四槽，须明确全140无受控来源准入。此层不自动注册／运行。

各层 RAW 先封存再 FULL，回执严格绑定，原技术／安全／semantic unknown 硬停保持；不丢 proof、不删难例、不改 Gold／阈值、不重试到通过。分列 raw／接受／完整、正例损失、bad_auto／ambiguous_auto、unknown／unrun及旧 matcher／独立 FULL。公开无受控来源场 typed 未评估／无信用，不补 verification_program、不写业务采纳或默认放行；私人严格6／12、可选2／6及留出独立保留。

主 Agent已选择先采用上述通则；checks仅保留为设计备选，完整140前另固定 V配对。当前只有E adapter离线实现，不改ADR或开始任何真实后继。
