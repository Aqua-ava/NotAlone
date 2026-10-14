# 指代维度现行基线：新有限实际评测预登记

本场是任务[07 指代消解维度](../../memory-extraction-accuracy/issues/07-reference-resolution.md)自2026-09-16以来的**第一次完整真实基线**：现行主集16条＋语义补充3条，另按既有P1顺序连带核心两窗，共21窗。历史13/15属于旧集合成绩，不作现行基线；本场不修改任何用例、期望、提示、schema、评分或放行表。

## 1. 用户授权与本场边界

- 2026-10-14用户明确选择"同意，花这笔额度把指代卷子考完"，即为本场独立固定有限预算、样本、绝对窗口与停止条件的授权。凭据仍是根`.env`既有ECNU配置，请求模型`ecnu-max`，端点`https://chat.ecnu.edu.cn/open/api/v1`；报告标签按[别名授权](goal-ecnu-model-authorization-20261014.md)如实接受`deepseek-flash`／`deepseek-v4-flash`，不据此宣称同权重或供应商稳定。
- 本场只测质量，**不做**：提示词压缩、候选对照、维度放行、业务库迁移、旧数据回填／重采纳、官方DeepSeek或其他供应商、真实聊天上传。全部保持为0。
- 本场不自动后继。跑完即闭账：无论结果如何，下一次真实调用都须另立有限计划并再次取得用户同意。

## 2. 固定场次与累计分账

- 唯一新run UUID：`待激活前由Root在私有登记中固定并冻结本计划SHA`。
- 固定绝对窗口：**不写死在本公开计划里，而由激活时的私有登记一次性固定为带时区的`absolute_start`／`last_http_start`／`absolute_end`**，并在领取预算前写入冻结收据。约束是：`last_http_start`晚于`absolute_start`，`absolute_end`比`last_http_start`至少晚**1845秒**（E 300＋V 300＋raw审核600＋full审核600＋收尾45）；激活时必须满足`absolute_start ≤ 现在 < last_http_start`，过期不顺延、不重开、不续跑。这样避免公开文档里的日期与本地时区换算不一致。
- 真实HTTP硬上限：**42次请求尝试**（＝2×21窗，与既有P1口径一致）。每个窗一次E，仅在有可审候选时调用至多一次V；失败、超时、空响应、SDK重试与任何fallback**全部计入**，未知在途不退预约。本场`request_timeout_seconds=300.0`、`max_retries=0`。
- 累计分账：激活前累计真实HTTP为**68次**（62确认200＋2确认500＋4旧ReadTimeout远端未知），已完成15个实际目录、全部CLOSED、锁free；223次未用额度永久关闭、56次未登记额度已退役、full140的280仍未激活，工程分配627。本场新增≤42，激活后目标实际最多110。**不借用任何已关闭／退役余额，不激活full140的280。**

## 3. 样本、分段与分母

`case_set=reference21`，`case_positions=None`（即原21窗全套），按既有固定顺序：

| 位置 | 集合 | 条数 |
| --- | --- | --- |
| 0–15 | **主集16条**（`cases/reference.py`，`dimension=reference`） | 16 |
| 16–18 | **语义补充3条**（`严格：门票省略数量`、`严格：跨消息第三人`、`严格：跨话题拼接`） | 3 |
| 19–20 | 核心公开两窗（`严格：报价判断与条件咨询`、`严格：第三人历史经历与当前未知`），按既有P1顺序连带 | 2 |

- 为什么不能只跑指代19窗：冻结入口`evaluation_ecnu.run_ecnu_evaluation`的`reference21`分支只接受`case_positions=None`（原21全套）或**至多4窗**的显式诊断；任何19窗这类中间子集都被`ecnu_invalid_case_positions`拒绝。因此本场取原21全套，与既有P1口径一致；这是入口的既定约束，不是范围放宽。
- 报告口径（[既有方案第5节](memory-quality-plan-20261012.md)强制要求）：主集16、补充3、合计19**分开报告**；核心两窗另报，不并入指代成绩。
- 指代维度达标签判据：**用例数≥15、假事0、记错人0、一般错误≤1**，由`summarize()`输出。核心两窗不参与该判据。
- 分母完整性：预登记全21窗。未运行的窗如实标`unrun`，**未运行不是通过**；不得只报已完成部分冒充整场。
- 语义标注覆盖另报：`expected_claims is not None`的严格条数为**19条中8条**（主集16内为5条），单独列出，不混入达标签。

## 4. 来源、Gold、配置与版本冻结

激活前必须在私有目录（0700目录／0600文件、`nlink==1`）一次性冻结并逐项核对：

1. **源码**：`backend/src/notalone/memory_extraction/`全部`*.py`，加`backend/pyproject.toml`、`backend/src/notalone/__init__.py`、`scopes.py`、`memory/{__init__,adapters,models,ports,timing}.py`、`memory_trace/{__init__,context,ports,transport}.py`、`ledger/{__init__,models,ports}.py`、`backend/src/notalone/runtime_config.py`；逐个SHA256，激活前后比对，任一漂移停发。
2. **Gold与准则**：`.scratch/unfinished-work/memory-gold-reference-20261012.json`（文件SHA`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`／规范SHA`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`）与`.scratch/unfinished-work/memory-gold-agent-annotations-20261012.md`（SHA`7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91`）。原21窗／28必需＋A15可选1、困难例与分母**不改**。
3. **非秘密模型清单**：端点、请求模型`ecnu-max`、temperature 0、timeout 300秒、max_retries 0、thinking **enabled**（与产品提取装配一致）、`verification_mode=nullable-proof-v1`、E工具`forced`、V省略`tool_choice`、允许报告标签集合、`response_identity_policy=ecnu_configured_route_known_labels_v1`。秘密值不写入清单。
4. **安装版本**：`openai`、`langchain-core`、`langchain-deepseek`、`langchain-openai`、`httpx`、`httpx2`、`langsmith`、`pydantic`；与冻结清单不一致即停。
5. **本计划自身**：文件SHA与规范SHA在激活时写入私有收据，之后不得改写（本场结果另记于本节之后，不改预登记字节）。

漂移判据：**每个冻结文件的SHA256**、本计划SHA、安装版本、端点、请求模型、SDK键、prompt／schema规范SHA、来源或截止时间任一变化，**停发并关闭本场**，不补发。`baseline_commit`只作记录与格式校验（40位hex），**代码不拿它当漂移门**；真正生效的是逐文件SHA比对，所以"工作区有非本场改动"本身不触发停发，只有改动落在冻结集合内才触发。

### 4.1 私有目录与只读核对

- 私有执行目录（0700／文件0600）：`desktop/artifacts/goal-reference19-baseline-prepare-20261014/`，含`draft_run_baseline21.py`（驱动，取自上一场已验证驱动）、`root_launch_baseline21.py`（唯一入口）、`review_responder.py`（审核答复方）、`root-prior-ledger-v1.json`（由实际注册库只读生成）。
- 实际输出目录：`desktop/artifacts/goal-reference19-baseline-real-20261014-<run_id前8位>/`；审核桥目录同场独立。二者与私有目录同为0700／0600。
- 只读依赖：`desktop/artifacts/goal-nullable21-prepare-20261013/`的`explicit_review_bridge.py`、`root_activation_support.py`、`root_launch_new21.py`、`draft_run_new21.py`（原字节不改）。
- 材料总数：**74个文件**（73个源码／Gold／账本／旧工具＋`review_responder.py`）全部逐个SHA256冻结；任一缺失或漂移即停。`review_responder.py`已加入`REQUIRED_PRIVATE_SOURCES`，因为**决定每窗裁决的正是它**：不冻结它，冻结就不覆盖真正做判定的代码。
- 冻结可见性：`draft_run_baseline21.py`的E候选文件SHA为`e0530874c7e84634835613e62b561f338dc0564c2bdf4e68aa2a25d92d3faedb`、提示规范SHA为`6cefca2dfad58cdc88b1734720940f03d2e55d77d80aeab83853ba0c3a55fef9`，与[上一场记录](goal-memory-A01-source-fidelity-plan-20261014.md)逐字相同，说明源码冻结后未漂移。

## 5. 执行顺序与停止条件

串行、单在途，顺序固定：领取budget → 读取一次根`.env`最小凭据 → 逐窗E（→必要时V）→ 逐窗语义审核 → raw封存 → full审核 → 收尾。

- 持久预约：每次实际transport发送前原子预约一次，达42即硬拒下一次发送；`EvaluationBudgetAbort`为`BaseException`，SDK重试不得吞掉。
- **立即停止**条件：首个`false_fact`或`wrong_subject`；人工独审发现确定坏auto；HTTP／解析／审核失败；非法结构；载荷越界；冻结漂移；计数／权限故障；超时窗到期。停止即关闭本批后续请求，原输出不覆盖、难例不删、不补位。
- 合法空E按该例期望计漏提或合法`none`，占用已发生请求，**不重试补候选**。已预约超时标结果未知，不伪造空核验。未执行的V标未执行。
- 一般错误按完整计划保留，累计超过1即本场不可能成为放行证据；仍只在预注册范围内继续既定观察，不据此进入候选或下一阶段。

## 6. 语义审核协议

- 每窗一次显式语义审核，回调只接收操作者判断、**没有默认通过**；`criteria_sha256`必须等于冻结准则文件摘要。判定词表与拒绝条件沿既有实现（`safe/supported`、`general_error/{coverage_miss,contract_mismatch}`、`safety_error/{false_fact,wrong_subject,contract_mismatch}`、`unknown/audit_unresolved`）。
- 审核依据是审核包内的**实际窗口、实际候选、程序核验结果与原始响应**，加冻结的Agent标注准则文件；不预填安全结论、**不宣称盲审**、不称用户认证。
- 审核答复由**在激活前冻结的判据**（本计划、冻结准则文件、`view`内自带的`reference_case`主张与`e_fields`）逐行推导并绑定`view_sha256`／`raw_evidence_sha256`；同一`view`必须推出同一答复，判据不依赖当次模型输出。**不能根据结果调宽或调窄判据**；判据在跑之前固定，跑之后只核对。
- 无法由冻结判据落地的行或主张**不得**默认判安全：一律记`unknown`／`unresolved`并写明理由，触发停止条件。审核人不得改写用例、期望、提示或评分；`safety_error`与`false_fact`不得由"未发现错误"自动推出。
- 顺序：raw独立封存并完成审核后，才揭V／程序去向与final；raw结论不得事后按结果回改。
- 允许的合成原始I/O单独私有保存（0700／0600），完整保留失败与额外候选；不保存密钥、不保存模型内部思考、不复制正文到Git或公开汇总。
- 实施限制（如实记录）：本场逐字段审核粒度高于"是否达标签"所需，属既有协议的固定成本；本场**不**宣称独立人工认证、盲审或`quality_certified`。
- **答复方的真实能力边界（两轴审查后更正）**：冻结的答复方只能机械判定`subject/category/topic/source_message_ids/speech_act/assertion_status/figurative_type/valid_at/invalid_at`这9类结构化字段；`meaning`、`safety`、`window_checks.forbidden_meanings`与主张组的来源／连贯检查**一律保持`unresolved`**。这不是答复方写得弱，而是后端本身把语义层留给审核人：`evaluation_review._variant_matches`注释明写"来源的正文条件仍由group.source/coherence审核，机械层只核有限集合"。因此**任何**机械答复方都必然让该窗`review_unresolved≥1` → 裁决`unknown/audit_unresolved` → 触发停止。见第10节。

## 7. 报告与放行边界

- 输出：主集16／补充3／合计19分开的通过、假事、记错人、一般错误、运行失败与空结果；逐例去向（自动／待确认／不生成）与主体；指代对象是否明确、含糊是否保守`pending`；明确对象漏提与含糊对象保守pending**分开计数**。
- 报告独立列出未运行、未知与额外输出，不以`meets_gate=true`直接宣布生产可自动采纳。
- **放行恒定不变**：`DEFAULT_DIMENSION_RELEASE`保持空集、门保持开启；0.7置信度、风险白名单、语用CONFIRMABLE与所有相关维度AND不变。指代运行时键当前不可推导，本场即使达标签也**不能**进入自动采纳；达到"含糊指代不进入自动采纳"这一条靠既有空放行表与fail-closed实现，不靠本场成绩。
- `quality_certified=false`、`typed_positive_certified=false`始终；本场不能关闭任务07、核心01或维度03，也不能替代140窗、留出集或typed来源证明。

## 8. 预登记时点状态

本预登记写就时：新run UUID**未固定**、私有登记0、模型凭据读取0、真实HTTP 0、PG／App／微信／OCR／发送0。本文件发布本身不构成激活；激活须先完成第4节冻结、私有driver与审核桥的最小验证、独立两轴审查，再由用户确认唯一一次激活。

### 8.1 已完成离线验证（仍无真实调用）

- 私有控制（临时合成HOME／SQLite／假key，禁真实DNS／socket／transport／根`.env`／实际registry）：**17／17通过**，含完整21窗真实SDK合成控制、cap42、固定时窗、来源与冻结漂移、重复激活、HTTP500与未知标签停止。
- 仓库相关受守卫回归：`test_evaluation_ecnu`＋`test_evaluation_sdk_budget`＋`test_evaluation_http_budget` 共**72／72通过**。
- 旧账基线：由实际注册库只读生成`root-prior-ledger-v1.json`，得15个目标阶段／68请求／223关闭余款，加P1另账1个目录共16；与本票累计记录一致，未关闭任何他人账本。
- 私有源码mypy：报错仅为环境缺`py.typed`的`import-untyped`噪声，与上一场驱动逐字同构；**不**据此宣称类型干净。
- **既有用例回归未全绿（与本场改动无关，且正在被其他工作流修复）**：首次核验时`python -m unittest discover -s tests/unit/memory_extraction -t .`为387项中1项失败——`test_expiry_prompt_contract.test_prompt_keeps_empty_expiry_only_for_long_lived_facts`断言`只有真正长期有效的事实`连续出现，但装配后的`EXTRACTION_SYSTEM_PROMPT`把该句折行，连续子串不存在；当时`adapters.py`与测试文件在HEAD均未修改，属HEAD既有缺陷。**随后另一条工作流修改了`EXTRACTION_SCHEMA`的`invalid_at`描述，该测试现已通过（13/13）**。因此该缺陷不再阻断，但它同时说明本场的源码冻结已失效（见下条）。
- **冻结已被并发工作流打破（本场因此更不可激活）**：`backend/src/notalone/memory_extraction/adapters.py`已被其他工作流修改，SHA由冻结的`e0530874…3faedb`变为`6abf4b18…a1f2b`，`EXTRACTION_SCHEMA`随之变化。本场冻结集合含该文件，`invocation_scope`会在首个请求发出前以`ecnu_runtime_contract_changed`停发。**故即使第10节的阻断被排除，也必须先重新冻结源码、重算全部SHA并重跑受守卫回归，才能激活。**
- **全量后端测试现状（如实记录，非本场引入）**：`python -m unittest discover -s backend/tests -t backend`为**2229项中58失败＋162错误＋55跳过**；失败分布在`tests.integration.server`、`tests.unit.tasks`等其他子系统，与本场文档改动无关，也不代表本场评测链路。本记录**不**把它当成"全量既有用例回归通过"。
- 未做：真实登记、key读取、HTTP、PG、App、微信、OCR、发送、业务库迁移、维度放行。

## 9. 本场实际终态

（待执行后另记，不改动以上预登记字节。）

## 10. 激活前阻断：本预登记不能产出基线（2026-10-14 两轴审查后）

**结论：不得按本文件激活。** 独立两轴审查（Standards／Spec）在激活前发现一处hard级缺陷，我已复核确认：

1. 冻结答复方对每窗的`meaning`与`safety`恒为`unresolved`（`review_responder.py:435/449/462/497`）。
2. `evaluation_review._review_statuses`把这些值计入`review_unresolved`（`evaluation_review.py:304-315,488`）。
3. `evaluation_phased_audit._decision`见`review_unresolved`即返回`("unknown","audit_unresolved")`（`evaluation_phased_audit.py:104-106`）。
4. `evaluation_offline`见`unknown`立即`_BatchStopped`（`evaluation_offline.py:447-448`）。

所以任何机械答复方都会让**第0窗**就停止：整场只会发出约1–2次真实请求，其余20窗`unrun`。这不只是答复方实现问题——后端把语义层明确留给审核人，机械层不可能落地`meaning/safety`。**照本文件激活等于用用户的额度换一个预先注定的第0窗停止**，故本场不激活。

**同时更正本文件先前的过度承诺**：第1节曾把本场描述为"第一次完整真实基线……共21窗"，第3节写"分母完整性：预登记全21窗"。在原计划的"操作者当场逐字段审核"前提下这两句成立；改用机械答复方后不成立。上面已按事实改写。

### 本次两轴审查发现与本轮修复

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| hard (Spec) | 机械答复方必然第0窗停止，产出不了基线 | **不改代码绕过**；记录为阻断，交用户决定路径 |
| hard (Standards) | `review_responder.py`未在冻结集合内，冻结不覆盖真正做判定的代码 | 已加入`REQUIRED_PRIVATE_SOURCES`；材料数73→**74** |
| P2 | "主集内8条严格标注"错，实为19条中8条／主集16内5条 | 已更正 |
| P2 | "HEAD"被列为漂移判据但代码从不校验 | 已改为逐文件SHA为唯一漂移门，`baseline_commit`只作记录；并说明工作区非本场改动本身不触发停发 |
| P2 | §8.1引用的"21窗合成控制"用的是`fail`答复方，未覆盖真实答复方 | 已如实注明；私有控制现为**36／36**（含答复方19项） |
| smell | 导入`CASE_POSITIONS`未使用；响应方无持久状态、无CLI，新进程无法续答 | 记录；激活前须补一个循环驱动并把状态持久化到审核目录内 |

### 可供用户选择的路径（本文件不代替选择）

- **A：不花额度，先补语义审核能力。** 保持本预登记不激活，另立"可靠逐窗语义审核"的接缝（人或独立模型）后再跑完整21窗。代价：本维度基线继续缺位。
- **B：降级为技术诊断。** 只跑`case_positions=(1,)`之类单窗，如实报告"技术闭环＋该窗E实际输出＋审核unknown"，明确不产出维度成绩。代价：预算换不到质量结论。
- **C：改口径再测。** 经用户批准后修改评测协议（例如让机械层能落地`meaning/safety`，或引入明确非确定性的审核人并相应改写安全性论证），须单独立项、重跑受守卫回归与两轴审查。

在用户选定路径前，本场保持**未激活／0真实HTTP／0凭据读取**。

本预登记与本节记录已本地提交；私有工具在`desktop/artifacts/`按`.gitignore`不入库。

## 11. 第二次阻断：注册库在并发评测中被实时改写（2026-10-14）

在按第10节路径B准备四窗诊断时，**注册库`~/.notalone-memory-evaluations`在几分钟内被其他工作流改写**，本场的旧账基线再次失效：

| 观测时点 | 实际状态 |
| --- | --- |
| 首次生成账本 | 16个目录／15目标阶段／68请求／223关闭余款 |
| 生成激活计划时 | 17个目录／16目标阶段／69请求／**264**未用 |
| 规划完成后数分钟 | **18个目录**：新增`8f866a57…`（limit42／used1／已关闭，10:48创建）与`b8c6c199…`（**limit280／used0／已关闭**，10:54创建） |

- `limit280`正是**退役的full140额度池**；它被激活并在**0次请求**后关闭，使"未用"口径从223变264再变**585**——把一处从未打算复用的退役池算成了可复用余量。这恰好印证[既有方案](memory-quality-plan-20261012.md)的约束：`full280_reallocation_permitted:false`、旧余额不复用。
- 结论：**在这种并发环境下，"冻结旧账再跑"的方案不可靠**。本场私有入口对未知目录与数量漂移一律拒绝激活（fail-closed），它会正确拒绝启动——这是保护，不是故障。**本场保持未激活。**

### 11.1 已完成的四窗诊断工具（离线验证通过，未执行）

- `draft_run_diag4.py`／`root_launch_diag4.py`／`test_diag4.py`，0700／0600。
- 样本取冻结入口允许的**至多四窗**，四类子类各一例：位置1`指代：跨消息老李`（跨消息）、5`指代：机场等行李`（省略主语）、9`指代：多第三方借钱`（多第三方）、4`指代：姐借车`（含糊指代且**期望AUTO**，最易暴露"把含糊写成确定"）。
- cap＝2×4＝**8**次请求；固定`timeout=300`、`max_retries=0`、`nullable-proof-v1`、E`forced`／V省略`tool_choice`；原21窗Gold分母与`case_names`不变。
- 离线控制**6／6通过**：四窗形状与cap、四类子类与位置对应、旧账接受与未知目录／数量漂移拒绝、时窗与冻结不完整拒绝、执行确实把`(1,5,9,4)`与cap交给冻结入口且不经Mock。
- 激活材料已重新冻结**77个文件**；激活计划写到`root-activation-diag4.json`但**未使用**，绑定输出目录`desktop/artifacts/goal-reference19-diag4-real-20261014-e5fd00e9/`。
- 执行时仍受第10节同一限制：机械答复方无法落地`meaning/safety`，故四窗诊断也只报"技术闭环＋该窗实际输出"，**不产出维度成绩**。

### 11.2 为什么"等并发停手"也拿不到成绩（本轮复核，2026-10-14）

用户选择等并发工作流停手再跑四窗诊断。复核后必须更正一个预期：**等干净窗口并不能让四窗诊断产出成绩**，因为拦路的不是并发，是审核协议本身。

- 诊断路径（`case_positions`非None、`synthetic_transport is None`）**仍强制要求`PhasedEvaluationAudit`**（`evaluation_ecnu.py:222-224`），没有任何"小批量免审核"的旁路。
- 冻结答复方对`meaning`／`safety`恒返回`unresolved`（`review_responder.py:435/449/462`），因此每窗`review_unresolved≥1` → 裁决`unknown` → `_BatchStopped`。第0窗即停。
- 于是四窗诊断的真实产出只有：**技术闭环成立（约1-2次真实请求、真实验证了凭据／端点／请求契约）＋该窗E的真实输出＋一条如实记的`unknown`**。它不是维度成绩，也不满足任务07的≥15条门。
- **因此本目标当前的唯一实质阻塞是"谁来提供逐窗语义审核"**，与额度、与并发窗口都无关。并发只决定"能不能稳定地跑"，不决定"能不能有结果"。

**唯一能产出真成绩的路径**是第10节路径C：经用户批准修改评测协议，让审核层能合法落地`meaning`／`safety`（例如引入明确非确定性的审核人并相应重写安全性论证，或定义可机械判定的语义代理指标）。那属于产品代码与安全边界改动，须单独立项、重跑受守卫回归与两轴审查；且当前`evaluation_*.py`正被另一条工作流修改中，不宜同时改。

**本轮复核附带确认**：并发工作流已把`provider_profile`（ECNU／官方Flash-max）加入`run_ecnu_evaluation`，但ECNU档案的`base_url`／`endpoint`／`request_model`与配置形状**未变**（`provider_profile`只用于请求体校验），故四窗工具与42项私有控制仍全绿；材料数仍为77、无缺失。这与第11节一样只说明"接口暂时兼容"，不改变上面的结论。

## 12. 更正：任务07的门槛指标本来就不走审核路径（2026-10-14 复核）

第10／11.2节的结论"不产出维度成绩"只对**带审核的受限入口**成立。复核任务07自身定义后必须更正：

- 任务07的验收原文是"该维度达标签：至少15条中假事0、记错人0、一般错误≤1"，口径即`evaluation.py`的`summarize()`（`GATE_MIN_CASES=15`、`GATE_MAX_GENERAL_ERRORS=1`）。该函数docstring明写：**语义标注覆盖只作单独字段报告，不参与达标签判定**，也不要求`PhasedEvaluationAudit`。
- 通用评测入口`evaluation.py`（任务01迁入的正式工具）正是产出该指标的工具：`evaluate_case`→`summarize()`，线路是"窗口→结构化候选→外壳校验→语用分流→最终去向"（[spec](spec.md)第4条），**全程没有审核人**。历史13/15就是这么跑出来的。
- 因此"必须有人逐窗做14字段语义审核"是**受限入口`evaluation_ecnu`特有的**（ADR-033／046／047的来源证明工作流），不是任务07门槛的必要条件。第10／11.2节把两者混为一谈，此处更正。

### 12.1 该路径仍需要的两件实事（未做）

1. **来源核验V不能省**：离线实测，本dimension的AUTO用例在只跑E（`verification_runtime=None`）时，事实会带`semantic:unverified`风险标记→去向被压成`pending`，期望`auto`的6条会全判一般错误（实测`指代：机场等行李`：expected `auto`→actual `pending`、`error_kind=general`、`risk_flags=('semantic:unverified',)`）。所以必须E＋V，**16条成本≤32次请求**。
2. **该入口没有硬计数门**：`EvaluationTransport`（`evaluation_http_budget.py:415`）已支持"发送前原子预约"，且`build_deepseek_model`接受`http_client`注入；但通用CLI没接它。要把32上限变成真实硬门，需一个私有包装：自建`EvaluationBudget`（cap32）→`httpx.Client(transport=EvaluationTransport(budget))`→传给`build_deepseek_model(http_client=...)`→跑16条→`summarize()`。此包装**尚未编写或验证**。
3. 另外需要：冻结通用入口所需的源码SHA、只读一次根`.env`取`NOTALONE_DEEPSEEK_API_KEY`（该CLI另需`NOTALONE_EVALUATION_API_KEY`或改为显式注入）、以及如实声明"本结果由来源核验V支持，**不含**ADR-033／047要求的独立来源证明语义审核，故不能替代`quality_certified`或typed证明"。

**结论**：任务07的门槛指标**可以**在不改产品代码、不引入审核人的前提下取得，成本≤32次请求；代价是证据强度低于受限入口（无逐窗语义审核、无来源指纹）。这条路是否走，属用户的取舍，本文件不代为决定，也未开始实现该包装。
