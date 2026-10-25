# 120、审阅身份和内容时钟的源码核对

本次工作只查公开规格、脚本和固定源码，没有打开既有私有suite、真实资料、.env或原累计账本。旧资格作为历史协议单列；本轮执行不再等待输出、费用或资格门槛。按[最新用户范围](scope-update.md)，记忆初步跑通即满足当前阶段的质量推进条件，完整质量矩阵与盲评不是当前前置；原始unknown不重写。

## “120”从哪里来

1. `.scratch/layered-relationship-memory/spec.md:207–212` 的T3明确要求主体、否定、时间、计划、条件、冲突、纠正、长期／临时八类，每类至少15个独立场景；先固定输入支持关系，再逐条检查模型输出，关键语义错误为零。
2. 同文件`:244–246` 的快速验收v2明确允许独立Agent按真实 `reviewer.kind=agent` 执行14例有限冒烟；保留完整126材料和正式全量合同，不能通过更改human标签转签旧资格。这证明“Agent能审阅”与“旧代码会签发verified”是不同事实。
3. `backend/src/notalone/memory/organization_quality_report.py:7–13,71–99` 定义八类、所需阶段和 `human_approved`。该函数实际判断 `reviewer.kind == 'human'`、非空name及approved；正式报告检查输入标注、输出审阅和calibration。不是因交接写了human120而推断真人条件。
4. `backend/src/notalone/memory/organization_quality_review.py:8–12,26–53,68–95` 接受human或agent真实身份，但绑定实际input/output hash、版本来源、维度、独立scenario_key、支持／禁用主张、qualifiers及verifier挑战。接受Agent记录不表示正式聚合器将它计为human。
5. `backend/src/notalone/memory/organization_quality_suite.py:112–130` 明确基线恰120个独立scenario_key、八类各15；另4条owner/contact×L2/L3摘要反馈、2条owner/contact底层事实更正。两条支线不扩充120独立基线。
6. `backend/src/notalone/experiments/organization_quality_suite.py:18–52` 是operator create/read/summary/export/calibrate入口，管理固定成员及跨进程物理额度；它自己不发送模型请求。单run的create/annotate/review/execute/report/calibrate在 `backend/src/notalone/experiments/organization_quality.py:109–160`，execute走真实公开HTTP，不由一个套件命令凭空完成120。
7. `.scratch/dsh-ts-migration/baseline/evaluation-protocol.md:20,29` 明确原120与本轮36工程组织材料分开；当前1056／1152分母不含120，也不能用36覆盖成绩替代它。

因此本轮不能把“120人类时间资格”当作一个合并门槛：场景覆盖、审阅身份、来源时间、模型证据及运行租约是各自独立的证据。没有源码依据的新门槛不新增；已经撤销的执行门槛不复活。

## 可执行的合法满足方式

以下仅说明以后明确选择复现旧suite的原 `verified` 时如何满足代码合同，不要求根在当前阶段执行。该历史路径需在全新私有合成suite预注册120个独立基线及4+2支线，通过真实公开质量输入取得实际input/version/hash，再提交真实签署者身份的annotations、执行、逐输出review及全局calibrate。原报告要求human的字段只有真正相应签署才可填写human；Agent仍写agent。不得读取旧账本后复制签名、把Agent冒充人类或直接写verified。

对应入口（由根提供真实隔离服务、token环境变量名、contract、私有payload和原同问题账本；本任务没有执行）：

```sh
python -m notalone.experiments.organization_quality_suite create --manifest "$PRIVATE_SUITE_MANIFEST" --directory "$NEW_PRIVATE_SUITE"
python -m notalone.experiments.organization_quality annotate --backend-base-url "$PRIVATE_BASE_URL" --token-env "$TOKEN_ENV_NAME" --case-id "$CASE_ID" --input "$ANNOTATIONS" --output "$NEW_ANNOTATION_RECEIPT"
python -m notalone.experiments.organization_quality execute --backend-base-url "$PRIVATE_BASE_URL" --token-env "$TOKEN_ENV_NAME" --run-id "$RUN_ID" --output "$NEW_EXECUTION_RECEIPT"
python -m notalone.experiments.organization_quality review --backend-base-url "$PRIVATE_BASE_URL" --token-env "$TOKEN_ENV_NAME" --case-id "$CASE_ID" --input "$OUTPUT_REVIEW" --output "$NEW_REVIEW_RECEIPT"
python -m notalone.experiments.organization_quality_suite summary --directory "$NEW_PRIVATE_SUITE" --contract-id "$CONTRACT_ID"
python -m notalone.experiments.organization_quality_suite calibrate --directory "$NEW_PRIVATE_SUITE" --contract-id "$CONTRACT_ID" --payload "$GLOBAL_CALIBRATION"
```

创建run、实际quality-input和完整成员清单还要按该公开服务合同先准备，不能把上述示例误称已执行。跨子run仍绑定根原问题账本和外层唯一reserve，旧800次仅属于历史轮次，不自动继承为新预算。若本轮只按新迁移合同由具名Agent盲评，则如实输出该合同的质量结论，旧suite保留not_executed/unknown；不要求先获得其旧verified才允许采集本轮1152。

## 内容时间和运行时间

- `nonreply-formal-model-seam/plan.mjs:17–31` 及旧 `memory_extraction/evaluation.py:82–101` 核对的是9/15消息锚点与逐分钟排序。这只是source message time，不自动是eval as_of。提取材料无公共as_of；实际正文是否使用当日时间必须查固定源和本轮真实请求，不能假定必须mock Date。
- 提取新 `extraction-bounded.ts` 的Date运算以来源anchor为输入；Skill新 `skill-learning-runtime.ts`／`skill-learning-materials.ts` 保留源观察与讨论输入，原driver `clock-evidence.json` 已核对没有公共内容clock。`created_at`、SDK called_at、source generation等运行资料仍要与模型实际输入分开核对。本轮小集只说明实际捕获的输入，不把少量样例推及全部140/12。
- L2/L3材料明确 `input.as_of`，原具名driver允许 `evaluationClock.mode='frozen_content'`。e600会把该clock用于L3内部租约，实际PG租约失败；根后续64943d1修复了新臂内容与租约clock，具名driver新增一对12HTTP证据。旧冻结臂内部lease仍可能处于过去，正式一致性不得伪写已解决。本编排保持可注入，等待根最终pin；不篡改Date、PG now、lease或oracle。
- 根可以预注册观察截点：`observationContext.inspect({plan_sha256,source}) → {cutoff,scope,registration_sha256,interpretation}`。它是实验解释和审阅上下文，不能假称未提供的公共内容clock已经被注入，更不能改变真实deadline与PG lease。
- 五阶段、首token、首事件和最终持久化只取driver实际事件。transport只有写出／headers／字节／协议事件，不包含原业务完整五阶段；`elapsed_ms`仅是诊断总耗时，不填补缺失阶段，不据它判延迟达标。

本轮输出393216或旧8192、省略max_tokens都保留；费用和fingerprint未知保留。实际参数／提示词／schema的差异和未核对部分继续记录，不因取消输出／费用门槛自动证明其他配置或质量相等。

## top_p的单字段官方等价

2026-10-25直接核验[Chat Completions API的top_p字段](https://api-docs.deepseek.com/api/create-chat-completion/)（页面342–348行）和[Anthropic兼容表](https://api-docs.deepseek.com/guides/anthropic_api/)（104–106行）：deepseek-flash处于non-thinking时，有效top_p固定1.0，传入值被忽略；Chat缺省也为1。故实际wire已确认model=deepseek-flash、thinking.disabled时，旧显式top_p=1与新省略该字段由官方合同证明有效值相同，不再为此单独拒绝或保留“默认未知”。

该判断须绑定实际wire，不以源码默认代替；raw中的显式／省略状态不改写。结论不延伸为全协议、Prompt／schema、response model/fingerprint、费用或时延等价。文档查阅未调用模型或携带任何业务数据。
