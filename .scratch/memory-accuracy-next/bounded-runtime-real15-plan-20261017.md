# 原03有限真实15窗：公开预登记与接线小规格

Triage: ready-for-agent

日期：2026-10-17。本文是已完成预登记材料两轴独立复核的公开合成方案，不是执行记录。必要官方DeepSeek有限合成评测的持续授权见[剩余公开8窗方案第3行](../grounded-evaluation/remaining-public8-plan-20261016.md)。原03的[实施规格](runtime-evidence-implementation-spec-20261016.md)、[精确合同](runtime-evidence-wire-contract-20261016.md)和[决定稿](runtime-evidence-completion-decision-20261016.md)保持；旧成绩、封存、失败、预算余额均不拼接或恢复。核心技术恢复请求独立，不借其额度。

## 本场固定接口

- `execution_plan=reference_version=bounded-runtime15-v1`；E固定现有`grounded-v2`，任务固定`bounded-runtime-v1`，同次V固定`nullable-proof-v3`。生产旧默认、0.7、风险、语用与默认空放行表不改。
- 纯输入：`backend/src/notalone/memory_extraction/evaluation_bounded_cases.py`导出`BOUNDED_RUNTIME_INPUTS`和同序`BOUNDED_RUNTIME_CASES`，恰好15项。输入项为`id/case_name/source_route/messages/target_indices/control/delivery_goal`；`messages`每项精确`sender/text/occurred_at/message_type/text_representation`，`target_indices`为完整数组的原位置，全部消息均为target。该结构不含E标签、proof位置、basis、trust或实际来源UUID。
- 九键Gold：[bounded-runtime-real15-reference-20261017.json](bounded-runtime-real15-reference-20261017.json)。顶层、window、claim和variant沿`evaluation_review.validate_reference_structure`；七轴逐窗判据只放`common_rules.axis_expectations`，不扩E/V协议。Gold预登记材料已完成结构与语义两轴独立复核，状态为`agent_reviewed_reference`；仍需完整代码复审、实际任务及模型配置冻结，不能据材料复核直接执行或签运行质量。
- Gold的`input_sha256`只摘要`{messages:[{sender,text,occurred_at,message_type,text_representation}],target_indices:[...]}`，ISO保持实际偏移。`source_route`另冻，不能混入内容摘要。正式plan的`input_sha256`仍摘要完整loader Window，另外冻结实际scope、task_id、taskcfg三键、规则SHA、完整消息／target／活动来源及处理收据摘要；两个摘要分别核对，不能以纯内容摘要认证活动来源。
- `source_choices.indices`始终是窗口位置；正式审核用`prepare_case_review(..., actual_message_ids_by_index=tuple[str,...])`绑定实际UUID并进入packet/evidence摘要，再由原`score_case_review`校验。不得重写raw/final的来源IDs，旧uuid5及旧21/140路径保持。

## 来源、完整窗口与顺序

来源固定`2030-01-02T20:00:00+08:00`起、每条相差一分钟；这是合成来源时点，不是机器今天。每窗是独立合成owner/contact或至少独立联系人范围，初始无旧记忆、无水位、无其他消息，完整保留1–3条消息。七个正控按固定顺序在前，八个反控紧随，不能筛选、换题或成功后重排。

`jsonl`项真实经过`read_jsonl→normalize_document→PostgresIngestRepository.import_document`及显式选择的合成联系人；保留原双作者／身份检查。其余使用已确认合成binding的正式观察：合成CLI事件经`LocalWechatCli`解析及`normalize_cli_events`，再由`PostgresObservationStore.record_batch_with_messages`保存真实处理收据并创建观察任务。外部CLI输入是公开合成资料适配，不读真实微信；不往loader注入快照。不能为单作者JSONL添加寒暄、关闭校验或裁掉句子。观察仅认证现有文字链，不代表真实聊天渠道或桌面已验收。

每窗来源准备后、预算之前，真实loader及现有window builder必须恰好生成一个批次，消息／target与fixture完整相等，全部来源活动且同scope；否则拒绝冻结。本场不改默认batch/context，不设置人工水位隔离target，不通过裁窗取得正证。日期恢复由既有bounded runner从actual来源ISO复核，PG的UTC存储不能替代原偏移。

| 顺序 | ID | 完整公开原文（`／`分消息）与作者 | 路由 | 先验交付／唯一变化 |
| --- | --- | --- | --- | --- |
| 1 | P01 | contact：我刚刚到家。 | observation | 作者已完成到家、just、direct_quote |
| 2 | P02 | contact：这里的“她”指我哥。／contact：我姐前天把她的雨伞借给我了。 | observation | 同作者前置声明；出借人姐、所有者哥、接收者作者 |
| 3 | P03 | self：你已到学校了吗？／contact：我已经到了。 | jsonl | 异方、相邻、同动词“到”、目的地学校、完成 |
| 4 | P04 | contact：这里提到我姐和我同事。／contact：这里的“她”指我同事。／contact：我姐昨天把她的书借给我了。 | observation | 完整两角色目录；所有者同事而非出借人姐 |
| 5 | P05 | contact：我姐昨天让我明天帮她顶个班。这里的“她”指我同事。 | observation | 先验目标reported_request；不得补接受／履行 |
| 6 | P06 | self：我哥前天让我后天帮他顶个班。这里的“他”指我同事。 | observation | 先验目标received_request；作者本人、受益人同事 |
| 7 | P07 | contact：如果天晴，我计划明天只跑约3公里。 | observation | 条件+未来计划+only+approx+3000米，不写实际已跑 |
| 8 | N01 | P02的声明作者改为self，其余原文不变 | jsonl | 只变actual作者；用户的哥不能自动成为联系人的哥 |
| 9 | N02 | P02的事件在前、声明在后，原句不改 | observation | 只变时间顺序；不回溯授予事件前的唯一指称 |
| 10 | N03 | P04的声明消息末尾再加“这里的‘她’指我姐。”（实际采用中文双引号） | observation | 只增加同代词竞争声明；不以选中一个target藏另一条 |
| 11 | N04 | P02声明中的“她”改为“他”，事件仍为“她” | observation | 只变声明代词，不能借不同代词绑定所有者 |
| 12 | N05 | contact：我刚刚到家。谢谢。 | observation | 只加完整礼貌尾句，保持整个message／window；“谢谢”不补记忆 |
| 13 | N06 | P03问题作者由self改为contact，答案不改 | observation | 只变问题作者；同作者不满足受控问答证明 |
| 14 | N07 | P03答案改为“我已经抵达了。”，问题不改 | jsonl | 只变答案动词；语义近义不能替代受控逐字动词条件 |
| 15 | N08 | contact：如果下雨，我计划明天只跑约3公里。 | observation | 只变天气；仍保真实条件计划和日期，但超出晴天正证 |

N02交换时间顺序时，合成采集时间仍随消息位置递增，不能让loader按原时间悄悄复原顺序。N05只有一项到家命题；礼貌尾句不是新增必需命题，但整个原消息不得被截短。所有反控都应保留忠实候选及all；本场UNKNOWN指没有有界语义basis，不把它等同E14所有字段未知、不把合法null proof当非法、也不能因其安全pending就判内容合格。

## Gold、七轴及交付门

逐窗完整命题、来源选择、E14合法组合、禁止含义与七轴独立判据见九键Gold；本文与纯fixture字节一并冻结。七轴均有独立可判内容，目标是每轴15个实际独立审核窗口，而不是15个正向basis、15种中文机制、真实分布覆盖或生产资格。不能从一个轴的pass复制其他轴；不能用整个15混合总数、given-response或已有工程19/19填分母。

- **subject**：分别核actual作者／受话者、亲友关系归属、问答方向、请托recipient及beneficiary；subject字段正确不掩盖正文错人。
- **time**：分别核just、前天／昨天、请托外层与内层时间、问答完成、条件计划的本地半开期间和O观察前缀。完成／历史分支双null，不能把H填为当天实际事件时刻；P07/N08为`[2030-01-03T00:00:00+08:00,2030-01-04T00:00:00+08:00)`。
- **truth_intent**：逐窗核断言／报告／收到请托／条件计划、已发生与未接受未履行的区分；API此项只沿原assertion/asserted/literal/无备选组合，不因basis非空签valid。report及条件plan应unknown；允许的received分支可valid。内容歧义与修辞unknown不同。
- **paraphrase**：核该窗的全部必需事件、方向、角色、数量、条件及限定；MAIN/C必须实际逐字复制，reason/alternatives不得补事实，不能以引用保留单词就认完整事件已证。
- **reference**：逐窗分别核作者自指、显式声明、两角色竞争、问答省略或条件中作者；负控应保持所指未获有界正证，不能用最近人物、性别或模型target定身份。
- **media**：15窗仅核实际text/text、正式原文复制、活动规范来源及处理收据；不得从模型标签或有basis推出音图／processed_text能力，也不代表处理过图片／音频。合规v4 basis=null时此轴仍可valid，不能机械复制其他轴unknown。
- **reported**：逐窗核direct实际作者归属，或亲友请托的reported／received frame；不把原文引句弱化成“仅说过这段话”，不把请托升成已接受／义务／履行。

正控P05/P06来源各允许wire规定的reported及received两个合法E14 variant；不能靠case名指令模型选标签，也不能将另一合法frame判成假事／错人。首7交付门单独要求实际至少交付六规则及reported_request、received_request各一，basis3的能力、原target、all和当前来源逐项可核。若七窗语义忠实却缺所需frame、缺提案、丢必需dependency或只交UNKNOWN，报告delivery coverage缺口并关闭本场，不补跑或挑另一窗代替。正证不得接受任意新增事件、尾句或未列来源。

后8期待semantic_basis=null（合法proof可以null／缺失，或位置合法而程序UNKNOWN），subject/time/paraphrase/reference/reported均unknown；truth_intent按各窗合法E14与备选分支独立核；media应valid。快照须仍为完整v4、source_current=true、all；不存在删除／来源变更，不能把stale当合格UNKNOWN。若模型给非法proof应由实际合同停止批次，不能为“反控”放松错误类型、形状或链接校验。

## 原结果与sealed RAW→FULL

`original_result`沿`asdict(EvaluationResult)`的原字段：`name/dimension/expected/actual/passed/subject_ok/labels_ok/text_ok/validity_ok/error_kind/expected_subject/expected_labels/facts/rejected_count/failure_reason/semantic_annotated/verification_enabled/claims_recalled/unmatched_candidates/false_fact_count/wrong_subject_count/error_kinds/semantic_case_id/destination_ok`。`facts`来自同一次正式Flow已落PG trace的`pragmatics`且`phase=adoption`完整input，保留non_memory；原三门potential destination及reasons照实派生，不重跑Flow、V或模型，不拿保存后缺语用字段的MemoryCandidate猜原E14。fixture的单个名义expect只供旧matcher诊断，不能代替Gold各合法variant或正式轴成绩。

完整实际Window、原grounded_draft、grounded_compile／candidate_raw逐字关系、原provider request/response、验证结论与program、保存及当前API均以同一task/trace/候选链关联。RAW视图只揭示完整来源、E模型draft及其实际编译E14、Gold；独立审核原14槽、每项必需命题、来源和raw安全，封存run/case/nonce/view SHA与收据之后才开放V／程序／PG／API。模型labels不是语义Gold；不能由compiler实际结果反过来生成期望。

新固定分支的FULL审核在原review合同外另含：

```text
axis_reviews = {
  subject: {status: pass|fail|unresolved, basis: 非空独立判据说明},
  time: {status: pass|fail|unresolved, basis: 非空独立判据说明},
  truth_intent: {status: pass|fail|unresolved, basis: 非空独立判据说明},
  paraphrase: {status: pass|fail|unresolved, basis: 非空独立判据说明},
  reference: {status: pass|fail|unresolved, basis: 非空独立判据说明},
  media: {status: pass|fail|unresolved, basis: 非空独立判据说明},
  reported: {status: pass|fail|unresolved, basis: 非空独立判据说明}
}
```

七键及每轴两键精确闭集；status仅三值，basis必须引用本窗该轴的实际判据和观察，不得七项复用同一句“整体通过”。RAW不新增此字段，不揭V/program；FULL原raw部分必须与sealed逐字相等。FULL持久化时先分离axis_reviews，用原`score_case_review`核旧review，之后由独立轴status生成七条实际`EvaluationResult`交原`summarize`。raw_false_fact/raw_wrong_person及最终安全错误全场保留，不被axis pass覆盖；缺必需主张、字段或完整契约等general全场保守记入每轴，轴自身依据／语义不符另可fail。任一轴unresolved硬停且不生成passed；未审和未运行分母保留，不填safe。

计数只纳入本场具有完整sealed RAW/FULL及实际轴status的独立case，`semantic_case_id`由本窗内容／原target产生，不能用轴名伪增场景；每轴cases=15且false=0、wrong=0、general≤1才由原工具输出meets_gate。这个结论仍不产生生产逐类放行或任意中文准确性保证；六规则真实交付、逐轴语义质量与生命周期分别报告。

## 最小接线与退场

复用现有`evaluation_offline._run_evaluation_batch`的封闭formal_tasks分支，不建新runner。每case配置原实际task并仅领取EXTRACT一次，从既有PG trace取得同次事实；正常解析／规范化和任务准备不调模型。既有`PhasedEvaluationAudit`只新增本固定计划的内容投影／Gold注册／proof3/full-axis分支，旧21/140、旧public_window_projection和评分默认路径保持。

模型保留实际ChatDeepSeek对象；不以_RecordModel包装改变官方精确类型识别／tool_choice。现有预算transport与生产trace/proof3原始JSON hooks共同作用于同一请求，同步／异步共用同一持久cap；SDK与transport重试均0，禁止代理、重定向、probe、第二V和自动任务重领。使用现有run_once或首次失败立即关闭的进度回调，不改变生产默认恢复策略。接口／provider兼容由并行接线片实现，本文不宣称已经可真实运行。

只有一个实际批次／窗，硬cap固定30：15次E＋最多15次V；无reviewable候选时不调V，不把30写成已执行数。默认空表明确注入，不能继承关闭维度门的环境；无裁决额外请求。正式准入还须新UUID、独立0700/0600目录与台账、完整源码／schema／prompt／安装版本／actual source与task冻结、精确官方endpoint/model、thinking/tool_choice实际合同。DeepSeek官方配置沿现有provider合同，不走ECNU、不读取业务资料或核心固定／留出。

沿已实现本计划deadline：单调用及单审核phase600秒、整批14400秒，最终冻结绝对截止取更早者，不能在每窗重新延长。结构、身份、冻结、来源、记录、预算、技术或审核未知、安全错误、轴unresolved以及首7交付覆盖缺口均停止；先持久close及关闭收据，再回收本场owned进程。所有错误均占预约，不退款／重试／换题／续run；关闭未知保持unknown，不借旧56或任何已封场余额。已知期望UNKNOWN的安全范围反控与技术／审核unknown分别记录。

每窗实际保存/API回读仍pending；确认、修正、拒绝指纹、当前来源重绑、删除和残留0均在独立隔离库完成，不增加模型HTTP。先封存实际模型／审核原件，再做会擦除PG trace的来源删除；原件仅保留本场公开合成内容。旧资料／独立手录／其他scope保护及多source_ref替代语义沿原工程控制，不用质量分数代签生命周期。

## 当前状态

仅新增公开fixture、待审九键Gold和本文。没有模型调用、真实预算、凭据、业务库、真实聊天、GUI或提交。纯结构检查不证明语义、独立复审、正式准入或模型交付。Root须完成本材料与接线的独立复核、固定实际源码及全部运行指纹后才可唯一激活；不因持续授权或文件存在跳过冻结。

## 已完成的预登记材料复核

2026-10-17，两项独立审查固定`66eaec44`三份原材料：Standards硬规范和判断项均0；Spec实质问题0。两轴均核对15个独立内容窗、20个合法variant、105项逐轴判据及说明／夹具摘要，另核来源路由、30次上限、零重试及旧余额隔离。Spec从原文核作者、角色、内外时间和双frame，结构校验及E2必要表达核验不代签模型交付。

本次仅更新审核元数据并重算中文说明摘要；15窗正文、Gold命题、合法variant、禁止含义和七轴判据保持原字节含义。没有真实模型、预算、业务库或桌面操作，模型质量与正式执行记录仍为空。
