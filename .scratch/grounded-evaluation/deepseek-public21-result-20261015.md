# 官方 DeepSeek 公开21窗部分基线结果

日期：2026-10-15。唯一 run 为 `0e5203b8-cfe9-4de4-bea9-9caba5ca76d5`，已关闭。原21窗中完成13窗、未运行8窗；这是一场公开合成数据的部分基线，`plan_complete=false`、`quality_certified=false`，不认证生产质量、完整21窗、完整140窗或旧私有六窗／留出成绩。

本记录只汇总原封存记录，不重写审核、改分、改Gold、修改冻结计划或开启后继。执行范围见[本轮计划](next-public-run-plan-20261015.md)。本场没有上传真实聊天、连接业务库或释放默认维度放行；默认放行表仍为空。下文 `auto/pending` 是评测流程的模拟最终去向，不是用户业务资料的实际自动采纳。

## 实际运行与关闭

原件位于本机忽略目录 `desktop/artifacts/grounded-public21-prepare-20261015/prepared-deepseek-run-01/`：`freeze.json`、`result.json`、`finish.json`、`evaluation/manifest.json`、165份顺序事件及 `audit/A01` 至 `A13` 的两阶段视图、审核和回执。本次离线汇总未读取凭据，文档不披露凭据。

- 请求model与25份响应model字段均为 `deepseek-flash`，实际端点为 `https://api.deepseek.com/chat/completions`；未使用ECNU或其他模型回退。请求为 `thinking={type:enabled}`、`reasoning_effort=max`，E／V均省略 `tool_choice`。
- 固定 `case_set=reference21`、`case_positions=None`、`extraction_mode=grounded-v2`：模型返回逐片段labels，由程序编译E14，再进行 `nullable-proof-v1` 核验。此核验模式与生产默认V4有差异，不能把本场当生产默认配置的端到端成绩。
- 原始事件记录13次E、12次V，共25次真实HTTP请求、25次HTTP200、25份adapter输出；A12空提取不调用V。`max_retries=0`，没有重试、回退或自动后继，不能按42次预算假定已运行42次。
- A13封存裁决为 `safety_error/contract_mismatch`，正式停止码为 `case_semantic_audit_safety_error`。持久关闭回执为 `closed=true`、`reserved_requests=25`、`request_limit=42`；剩余17次永久关闭，不恢复或复用。
- 完成收据为13 completed、1 empty、0 failed、0 unknown、8 unrun；empty包含在已完成13窗内。正式人工语义裁决为8 safe、4 general_error、1 safety_error、0 unknown。
- 关闭原件 `cleanup_error_codes=[]`、`records_error_code=null`、`receipt_error_code=null`、`capture_gaps=[]`，执行器正常退出0。165个事件的原件、结果内副本及逐payload摘要一致。复核时冻结71项文件摘要全部一致，无漂移。响应和adapter中的内部推理内容按既定规则脱敏，不将这些预期脱敏路径称为证据缺口。

## 分层成绩

本轮只完成指代主集前13／16窗；主集后3窗、语义补充3窗、核心2窗均未运行，不合并为已通过。原全套21窗／28个必需命题及A15可选命题的分母保持。

| 层次 | 已完成子集的原记录 | 限制 |
| --- | --- | --- |
| 模型labels | 13份原E输出，均单独留证 | `kind/dependency/unresolved/sensitivity/confidence`是模型标签，不等于程序编译或语义审核通过。 |
| 程序编译E14 | 13份 `extraction_program`；15条实际候选，A12为零候选 | 字段合法不等于标签、风险、歧义和去向满足冻结契约。 |
| 必需命题raw | 15／15 | 只认证已完成子集的原文含义与组连贯；不补判未运行13个必需命题。 |
| 程序接受 | 15／15 | 包括pending；不能据此称完整auto契约已满足。 |
| 完整契约 | 9／15 | A03、A07、A08、A10两命题、A13共6个必需命题未满足。 |
| 人工V四字段及语义 | 15条结果：14语义pass、1 fail | A03的 `verdict/issues` 各1 fail；`candidate_index/evidence` 均15 pass。 |
| 程序proof | 15条均 `UNKNOWN`：`untrusted_source` 6、`scope_not_supported` 9；模型proof均null | 人工V内容判断不把程序UNKNOWN变成机器证明；不据supported补签E全部14字段。 |
| 原matcher | 13窗中9 passed；原汇总 `false_facts=4/general_errors=1/wrong_subjects=0`，`meets_gate=false` | 这些错误指标不按互斥窗口相加。保留旧机械口径；其false_fact标签不等于独立审核确认现实语义造假，亦不替代本场停止规则。 |

15条编译后raw E14由来源人工逐字段审核，未知项均0：

| 字段 | pass | fail |
| --- | ---: | ---: |
| text | 15 | 0 |
| category | 15 | 0 |
| subject | 15 | 0 |
| topic | 15 | 0 |
| source_message_ids | 15 | 0 |
| confidence | 15 | 0 |
| risk_flags | 14 | 1 |
| valid_at | 15 | 0 |
| invalid_at | 15 | 0 |
| speech_act | 14 | 1 |
| assertion_status | 14 | 1 |
| figurative_type | 15 | 0 |
| alternatives | 12 | 3 |
| interpretation_reason | 15 | 0 |

`confidence` 此处通过表示保留实际有限数值并符合冻结字段判据，不能把它读成真实置信度校准通过、充分召回或全体达到自动采纳门槛。全部已完成审核的raw false_fact、raw wrong_person、最终false_fact、wrong_person及ambiguous_auto均0；现有评分器的bad_auto为1，仅来自下述A13组去向规则。

## 逐窗来源人工结论

表内计数为“必需raw／程序接受／完整契约”，不按输出条数增加命题信用；每窗以同名 `audit/Axx-raw-review.json`、`Axx-full-review.json` 及对应视图为准。

| 窗口 | 必需计数 | 原封存裁决 | 实际结论 |
| --- | --- | --- | --- |
| A01 未知第三人部门 | 2／2／2 | safe | 保留否定与部门两命题，不编第三人身份；一条复句不使两项必需内容丢失，report/reported、歧义及pending符合原契约。 |
| A02 跨消息老李 | 1／1／1 | safe | 以相连来源保留邀约，不补接受、同行结果或无据人物关系，实际auto符合选定分支。 |
| A03 他借钱 | 1／1／0 | general_error | 原话方向、昨天、又及借款敏感性保留；模型 `kind=relationship_event` 被编译为assertion/asserted，违反冻结的report/reported。V仍supported且issues为空，漏掉该语用问题；实际pending，没有坏auto。 |
| A04 那个事 | 1／1／1 | safe | 保留未知事项的请求与来源，不编具体事项；歧义及pending符合原契约。 |
| A05 姐借车 | 1／1／1 | safe | 来源中的姐姐及借车事实有据，未补借款、车主或其他人物；完整契约通过。 |
| A06 机场等行李 | 2／2／2 | safe | 到达与正在等行李分别保留，来源、阶段、时间和实际去向通过。 |
| A07 他们来家 | 1／1／0 | general_error | 未来安排及期间通过；通用“指代无法唯一确定”未分别说明“他们身份”和“家里归属”两处未知，alternatives失败。未新增错误人物事实。 |
| A08 那本书 | 1／1／0 | general_error | 书及读完事件联结、E14与V内容通过；模型prefix为0.6、event为0.8，程序编译候选实际0.6，最终pending，未达到该命题理想auto。无auto，故不触发bad_auto。 |
| A09 那人 | 1／1／1 | safe | 保留未知第三人及原事件，report/reported、歧义和pending符合原契约。 |
| A10 多第三方借钱 | 2／2／0 | general_error | 两命题人物及肯定／否定保留，但两条alternatives均空，未给借入／借出两读；“小王没借”另缺借款敏感标记。两条均pending，不以此掩盖字段缺失，也未发生坏auto。 |
| A11 感冒好点 | 1／1／1 | safe | 保留好转而非痊愈、健康风险及来源时效，实际pending通过。 |
| A12 咱们那家店 | 0／0／0 | safe | 问句编译为零候选，正确none；无V请求，不补关系资料。 |
| A13 门票 | 1／1／0 | safety_error | 两条共同保留数量、对象与完成，合为一个命题；0.85 auto与0.55 pending混合，整组去向不完整，按既有评分规则升格停止，详见下节。 |

A14、A15、A16、A17、A18、A19、B01、B02均保持unrun。它们没有本场人工安全或完整契约结论；旧成绩不能补入。

## A13的精确停止规则

原输入为“门票买好了吗？”／“买好了，两张。”。冻结[来源判据](../unfinished-work/memory-gold-agent-annotations-20261012.md)允许来源、事件联结充分的拆分合计覆盖一次；P1理想auto，不补购买执行者。原raw审核将raw索引 `[0,1]` 合为 `A13-P1`，没有重复计召回。原full审核保持这些封存判断，映射final索引 `[0,1]`，唯一组失败为 `destination=fail`：数量候选的实际confidence为0.55、最终pending，而另一条为0.85、最终auto。两条safety均safe，28项E字段检查及两条V内容检查均pass。

现有[评分器](../../backend/src/notalone/memory_extraction/evaluation_review.py)的 `_safety_counts` 第339–342行把“destination失败组”与组内auto成员取交集，故auto索引0计为 `bad_auto=1`。[裁决器](../../backend/src/notalone/memory_extraction/evaluation_phased_audit.py)第103–104行优先返回 `safety_error/contract_mismatch`，先于完整必需覆盖缺失的一般错误分支；[批执行器](../../backend/src/notalone/memory_extraction/evaluation_offline.py)第545–546行据此停止。

这是有效人工组审核与现有评分规则共同产生的**去向合同安全分类**，不是审核JSON／哈希无效，也不是本窗发现内容假事、错人或歧义auto。原matcher的false_fact1另存于 `original_result`，不是本次语义停止触发点。独立离线复算 `_check_sealed_raw`、`score_case_review` 和 `_decision` 稳定重现原结论：raw1、accepted1、full0；安全计数中只有bad_auto1。该诊断不改封存结论或正式停止记录，也不把原运行改判safe。

## 时限事实与尚未解决的问题

冻结配置是 `request_timeout_seconds=300`、`max_retries=0`，不能把300秒写成实际请求的绝对墙钟上限。A13原事件文件的mtime与birthtime一致：

| 阶段 | provider_request落盘UTC | provider_response落盘UTC | 落盘间隔 |
| --- | --- | --- | ---: |
| E，event154→155 | 2026-10-15T14:58:34.873Z | 2026-10-15T15:03:37.924Z | 303.051秒 |
| V，event158→159 | 2026-10-15T15:03:37.963Z | 2026-10-15T15:12:53.586Z | 555.623秒，约9分16秒 |

事件JSON本身没有时间戳；上表是本机原事件文件的落盘时间证据，不是纯网络／模型处理耗时，也不是可跨复制档案保真的协议字段。它不支持“A13 V约17分钟”的精确表述。两次请求均有原HTTP200响应，不将超过配置数值的落盘间隔改记为重试或超时；本记录未诊断其底层超时语义。

raw内容覆盖、confidence合法性、置信度校准及完整auto去向仍须分开。A08和A13证明合法低分可保留raw与程序接受，却失去理想auto的完整信用；A13混合去向又被既有规则归入bad_auto。是否需要区分“保守pending导致组覆盖不足”与“确有不安全auto”，以及如何衡量真实confidence与覆盖阈值，仍是后续待定义的问题。本场不通过调分、放宽阈值、改人工组或修改评分器来恢复预算或补签成绩。

后续生产质量、指代至少15例门槛、原21窗完整回归、完整140及旧私有／留出可比性均未由本场完成。默认放行继续为空；本次13窗结果只用于定位标签、编译、核验与评测契约的具体不足。

## 本次离线复核

在Conda `NotAlone`中以 `PYTHONPATH=backend/src python -B` 只读执行：对A01–A13各自的原raw/full调用 `_check_sealed_raw`，对原full-view内packet和原full-review调用 `score_case_review`；对A13继续调用 `_decision`。所有13份封存投影一致，汇总如上。另逐项比对冻结71文件SHA，并核验165个磁盘事件与result副本及 `canonical_sha256(payload)`，均零差异。未修改任何原视图、审核、回执、预算或冻结文件，未读取凭据或发起新模型请求。
