# 语义审核可裁决化：让指代维度真实基线能跑完（spec v1）

> Triage: ready-for-human
> 来源：2026-10-14 用户明确选择"立项改审核协议，再跑完整基线"。
> 上游：ADR-027（评测门槛）、ADR-033（来源语义核验）、ADR-036（按维度放行）、ADR-046（来源绑定维度依据）、ADR-047（有界来源语义证明）。
> 相关：`.scratch/memory-extraction-accuracy/issues/07-reference-resolution.md`、[现有预登记与三处阻断记录](../unfinished-work/goal-reference19-baseline-plan-20261014.md)。

## Problem Statement

任务07（指代消解维度）要拿到真实模型基线，但**现行受限入口无法跑完**：`run_ecnu_evaluation` 强制要求 `PhasedEvaluationAudit`，其逐窗审核必须给出每行 `meaning` 与 `safety` 判断，而机械层**按设计**不能判定这两项——`evaluation_review.py:389` 原文："来源的正文条件仍由 group.source/coherence 审核，机械层只核有限集合"。

后果已实测（4次真实请求、0条成绩，见预登记第12.3节）：任何机械答复方都会让每窗 `review_unresolved ≥ 1` → 裁决 `unknown/audit_unresolved` → `evaluation_offline.py:447-448` 立即 `_BatchStopped`，**第0窗即停**。同时实测证明通用入口也不是出路：它被冻结安全门（正文绑定、身份档、`expect_request`）逐层拒绝，而那些门**有意不可绕过**。

于是形成死结：**能跑完的入口不被信任，被信任的入口跑不完**。任务07因此长期停在 `claimed/needs-info`、0/5验收，且没有任何现行成绩。

### 关键依据：现行实现比ADR自己写的门更严（2026-10-14 复核）

这不是"为了跑通而放松"，而是**让实现回到ADR已经批准的门的定义**：

- **ADR-027 第2条**（`architecture/adr/027-memory-accuracy-evaluation-gate.md:23`）："达标签与放行：某维度至少 15 条用例中假事 0、记错人 0、一般错误 ≤1"；第54行进一步说明放行记录只包含"维度、用例数、假事数、记错人数、一般错误数"。
- **ADR-046 第19行**（`architecture/adr/046-source-bound-dimension-evidence.md`）逐字复用同一门："质量仍须按原≥15例、假事0、记错人0、一般错误≤1的正式证据达到门槛，再由用户逐类批准。"
- 即：**两份ADR定义的达标证据都是"去向级计数"**，不是"逐字段语义裁决"。
- 而`PhasedEvaluationAudit`要求审核人对每行`meaning`与`safety`原创出判断（`evaluation_review._review_statuses`把它们计入`review_unresolved`，`evaluation_phased_audit._decision`据此返回`unknown`）。这个要求**严于ADR-027／046所定义的门的证据形式**，且没有可机械落地的依据，因而把"取得ADR所要求的证据"这件事本身堵死了。

**因此本变更的准确定性是：把评测实现对齐到ADR-027／046已批准的门，而不是降低门。** 任务07要的"假事／记错人／一般错误"确实是语义判断，但ADR把它定义为**去向级计数**，而`evaluate_case`（`evaluation.py:163-200`）已能用冻结Gold确定性地算出它。

## Solution

把"语义正确"的判定依据从**未定义的审核人判断**收敛为**可裁决、可复现、可审计的依据**，并明确它**能**与**不能**证明什么。核心取舍：任务07的门槛指标本就是**去向级**的（假事／记错人／一般错误），而 `evaluate_case` 已能用冻结Gold**确定性地**判它（`evaluation.py:163-200`：主张谓词、主体、标签、有效期、去向逐项匹配）。因此不需要发明新语义判定层，只需要**让审核层承认该依据的效力边界**。

## Implementation Decisions

1. **采用已有 Gold 谓词判定作为语义层的权威依据**（选项a）。不新增语义分类器、不引入模型审核人。理由有三：它已是任务07达标口径的实际判据；完全确定性、可复现、逐条可追溯到冻结Gold；且**它是ADR-027／046所定义的门本身**，不是替代品。
2. **审核层职责重定义**：`PhasedEvaluationAudit` 的 `meaning`／`safety` 不再要求审核人原创判断，而是由**来源绑定 + Gold谓词匹配**推出；推不出的行仍记 `unresolved` 并触发停止（fail-closed 不变）。
3. **不放松任何既有安全门**：置信度0.7、风险白名单、语用 CONFIRMABLE、相关维度AND、空放行表全部不变；本变更**只影响评测时如何裁决**，不影响生产采纳路径。
4. **明确效力边界并写进结果文档**：本路径产出任务07自己的门槛计数，**不**提供 `quality_certified`、`typed_positive_certified`、来源指纹或"独立人工认证"；不得据此勾选需要独立语义审核的验收项。
5. **零改动用例／提示／schema／评分**：`expected_claims`、`cases/*.py`、提示与schema、`summarize()` 的门槛常量都不改；新增与修复用例仍按任务07原要求单独入库。
6. **治理**：ADR-046／047 均"已采纳、实施与隔离验证进行中"，本变更触及它们定义的来源证明义务，须先出**ADR修订或新ADR**，再动代码。
7. **并发顺序**：另一条工作流正在改 `evaluation_ecnu.py`、`evaluation_offline.py`、`evaluation_provider_contract.py`、`evaluation_records.py`（近期提交 `8d56c4a7`、`98c6b9d4`）。**先冻结文件所有权再改**，避免与其最高思考／预算限制作业冲突。

## Testing Decisions

- 只测外部行为：从窗口到最终去向与 `summarize()` 计数，不测内部函数或提示字面。
- 先在纯合成 transport 上验证：机械依据能把 `meaning`／`safety` 判成 `pass`／`fail`，且**推不出时必须仍 fail-closed**（不得默认通过）。
- 回归：受守卫的 `test_evaluation_ecnu`、`test_evaluation_sdk_budget`、`test_evaluation_http_budget`、`test_evaluation_phased_audit` 必须全绿；任务07既有19条用例不可改期望。
- 真实模型准确率不进常规单测（需凭据、非确定）。
- 两轴（Standards／Spec）独立评审后才提交。

## Out of Scope

- 维度的自动采纳放行（`reference` 运行时键当前不可推导，本变更即使达标签也不放行；放行须用户逐类批准）。
- 修改生产采纳规则、置信度门槛、风险白名单、语用规则或默认放行表。
- 业务库迁移、旧数据回填／重采纳、新供应商接入。
- 真实聊天数据参与（仍只用合成用例）。
- 140窗全量、typed来源证明首样本。

## Further Notes

- 现有预登记与三处阻断的完整证据在[goal-reference19-baseline-plan-20261014.md](../unfinished-work/goal-reference19-baseline-plan-20261014.md)；四窗诊断工具与cap32包装均已离线全绿但**不用于真实场**。
- 本spec自身**未**宣称已完成任何模型评测；任务07的五条验收保持未勾。
