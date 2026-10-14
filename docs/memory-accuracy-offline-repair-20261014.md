# 记忆准确性：离线错例整理、时效契约修复与待批评测

2026-10-14 用户批准先整理错例、修复和本地回归；完整评测前报告调用次数与预算，自动采纳继续关闭。本轮只读取仓库记录和公开合成用例，不读取真实聊天、私有原始响应或根 `.env`，不运行外部模型、App 或业务库。本轮没有新增质量成绩。

## 错例与证据边界

| 问题 | 已有证据 | 本轮处置与剩余验证 |
| --- | --- | --- |
| 主体、去向、语用标签不匹配 | [档 A](memory-dimension-release-tier-a-result-20261006.md)：主体 20 例中一般错误 2；不是记错人 2 次 | 保留失败；既有提示已明确资料归属与直接参与，不能据此声称模型已遵守。完整回归仍需实测。 |
| 改写丢失否定、限定或改变事实 | 同一档 A：保真 20 例中假事 3、一般错误 5；与主体合计 10 个失败全部有候选，8 个有时效不符信号 | 不删困难例、不改 Gold、不以有输出代替正确；本轮修复可确定的时效输入冲突，尚无因果证据把这些旧失败全部归因于它。 |
| 明确事实被拒绝或漏提 | [真假意图评测](memory-dimension-release-truth-intent-result-20261006.md)：20 例一般错误 4；[稳定性复测](memory-truth-intent-repeatability-result-20261006.md)首轮 3 个错误第二轮均通过 | 属于待实测稳定性问题；不把正确的来源拒绝改为放行。[旧候选提示对照](memory-truth-intent-repair-comparison-result-20261006.md)变差，不能重新作为已证修复采用。 |
| 理由或备选编造前情、人物关系 | [21 窗观察](../.scratch/unfinished-work/goal-memory-20261013-complete21-observation-result.md)的 A04，以及[后续 A01 安全停止](../.scratch/unfinished-work/goal-memory-nullable-reference21-result-20261014.md) | 现行 E 提示已逐槽禁止无据补前情；[A01 局部回归](../.scratch/unfinished-work/goal-memory-A01-source-fidelity-result-20261014.md)通过仅覆盖该窗。本轮不重复加同义提示，不把 V supported 当作理由槽通过。 |
| 历史经历、当前状态与未来安排混为一条 | 21 窗观察 A05–A08：主体行为、分类、时效或标签错误；A08 完整审核缺失 | 既有 E/V 已补阶段规则。本轮发现 E 系统提示与 invalid_at schema 相反，修复字段说明；旧失败、未知及未运行结果不改。 |
| 指代、转述与来源证明缺失 | 最新 A01 的 proof=null、source_bound=false，仍 pending；[ADR-047](../architecture/adr/047-bounded-source-semantic-proof.md)只支持有界证明 | 结构可保存不等于有效语义证明；未知继续未知，不填合成锚点、不从 Gold 补证据、不更改 AND 门。 |
| HTTP 500、超时或审核中断 | 上述历史结果分别保留技术失败及未运行分母 | 这类失败不算语义通过，也不能由提示修复消除；本轮只回归现有离线计数和停止控制。 |

本表引用聚合记录，不复刻私人正文，也不把不同轮次的最好结果拼成达标签。

## 本轮可复现修复

测试接缝沿用现有 `EXTRACTION_SYSTEM_PROMPT` 与 `EXTRACTION_SCHEMA` 模型输入契约，以及现有提取、采纳、来源证明和评测入口测试。它们验证指令一致性与程序行为，不能验证模型遵守率。

基线 `bfe821393565178ea35116c96b3ec673bed77040` 上时效契约 12 项中 1 项失败：旧测试要求“只有真正长期有效的事实”这一限制，但现行系统提示已明确历史事实及不可推算结束时间的例外。不能把系统提示倒退为旧规则来让测试变绿。

核对发现真正冲突在 `invalid_at` 工具字段：仍写“只有真正长期有效的事实才用 JSON null”，且要求短期安排无条件填结束时间；系统提示却允许无期限历史与无法推算的期限留空。新增字段契约先红，再只改该字段描述：

- 可推算的短期结束时间必须填，日程次日零点和瞬时状态当天结束保持。
- 长期事实、没有明示资料期限的历史事实、无法推算的结束时间允许 null，不臆造期限。
- 来源时间缺失、naive 或无法核实时不推算、不用当前时间补。

系统提示、Gold、用例正文、评分器、模型配置、字段类型、0.7、风险规则、来源核验与维度门均未修改。默认 `DEFAULT_DIMENSION_RELEASE.allowed` 仍为空、`gate_enabled=True`；没有读取或修改本机环境覆盖项。旧冻结计划中的源码摘要不适用于这次新 schema，后续必须重新冻结，不能沿用旧账或旧清单启动。

## 完整评测的拟议预算（未批准、未启动）

复核实际代码集合：主集 123＋语义补充 17＝140 例，名称不变。现有 `full140` 入口支持这套固定全集。

| 维度 | 主集 | 补充 | 合计 | E＋至多一次 V 请求上限 |
| --- | ---: | ---: | ---: | ---: |
| 主体 | 19 | 1 | 20 | 40 |
| 改写保真 | 17 | 3 | 20 | 40 |
| 真假意图 | 20 | 0 | 20 | 40 |
| 时间 | 20 | 4 | 24 | 48 |
| 指代 | 16 | 3 | 19 | 38 |
| 转述 | 15 | 2 | 17 | 34 |
| 媒体 | 16 | 0 | 16 | 32 |
| 条件（评测补充） | 0 | 3 | 3 | 6 |
| 数量（评测补充） | 0 | 1 | 1 | 2 |
| 总计 | 123 | 17 | 140 | **280** |

建议下一场只申请**一轮 140 例、最多 280 次真实 HTTP 请求尝试**，单窗口一次提取 E、有可审候选时至多一次核验 V；串行、无自动重试、不追加对照臂、不借旧余额。使用既有 ECNU 配置，不切供应商；来源只用公开合成材料，模型配置和允许的服务标签在激活前重冻。

这是请求额度预算，**不是人民币报价**。仓库记录不足以给出当前 ECNU 单价、可用余额或可靠 token 上限，本轮未读取凭据或查账；货币成本未知，不能承诺 280 请求对应固定金额。若需要金额硬封顶，须在启动前另核计费与 token 限制，现有请求计数门不构成金额门。

首个假事、记错人、技术错误、非法结构、审核缺失或冻结漂移即停止，余量关闭；未运行不是通过、不补位。因此 280 是上限，不承诺为跑完而越过安全停止。报告原分母、完成/未知/未运行数、每维工具统计及独立语义复核，不能仅凭 matcher 或 V supported 判质量。

这 140 例都已用于开发或已被开发者查看，**不是新的盲留出集**。一轮全量只能验证现有公开集合回归；新留出仍需独立出题、冻结答案和单独报告范围/预算，本次 280 不包含也不认证它。条件/数量不足 15 例且是评测补充维度，不得独立声称达标签。真实来源证明链路、业务迁移和 App 验收也不由本评测替代。

本轮停在离线交付；用户批准预算后才可准备该场激活。无论是否达标，本任务均不启用自动采纳。

## 本地验证

所有 Python 验证先加载本机 Conda 的 `etc/profile.d/conda.sh`、`conda activate NotAlone`，再在 `backend/` 执行；禁 dotenv。首次直接 activate 因 shell 尚未初始化失败，未运行测试，后续正确加载 Conda。

- `python -m unittest tests.unit.memory_extraction.test_expiry_prompt_contract -q`：原 12 项 1 失败；新增契约后 13 项 1 失败；修复后 13 项通过。
- `unittest.defaultTestLoader.discover('tests/unit/memory_extraction', top_level_dir='.')`：388 项通过；外层拒绝 socket.connect 与 DNS，真实模型请求 0。
- `python -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline tests.integration.memory_extraction.test_evaluation_sdk_budget tests.integration.memory_extraction.test_evaluation_wire_contract -q`：76 项通过，使用合成 transport/凭据及临时目录；没有实际模型或业务库操作。
- `python -m mypy --follow-imports=silent src/notalone/memory_extraction/adapters.py`：1 个源文件通过。
- 独立 Standards／Spec 两轴只读审查：各 0 项阻断发现；按 Standards 收口提示去除报告中的本机绝对路径。8 个报告引用可达，`git diff --check` 通过。

数据影响：只改模型输入字段说明和离线测试；没有候选/记忆写库、迁移、旧数据回填、来源重处理或外部发送。本轮自动采纳放行数仍为 0。
