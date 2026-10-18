# 原03 Agent快速验收与集成

Triage: ready-for-agent
State: claimed

2026-10-18用户明确授权三个新会话并行执行、由Agent验收，不等待人工。`reviewer_kind=agent`；本次改变审核执行者及调度顺序，不改变假事0、错人0、一般错误≤1、逐维度至少15窗及实际proof交付门。旧批次、Gold、失败、余额和旧审核身份保持。

## 固定范围

- 基线：`5b4153b7f2f0e10399d44b23f82b54dfe2503bac`；集成分支：`codex/memory-accuracy-integration-20261018`。
- 复用已实现的`bounded-runtime-v1`、grounded-v2、nullable-proof-v3、proof3/basis3/evidence4及071迁移；当前基线最大迁移072，不重建、不改号、不迁移业务库。
- 复用2026-10-17完整工程证据及已审15窗计划。必要新真实场仍使用原15窗完整输入、Gold、官方DeepSeek、最多30次HTTP、零重试、RAW先封存再FULL，独立冻结最终源码和实际来源/任务。不混入其他两票样例，不借旧额度，不把模型或技术未知当通过。
- 独立审核的身份记录放在绑定run/phase/case/view摘要的元数据中，保留现有严格review协议。Agent对每轴作实际判断，不从Mock或matcher自动生成质量成绩。
- 生产放行表仍空；不扩大真实联系人读取、外部发送或媒体处理。桌面验收不在本票范围。

## 快速工程检查

Conda NotAlone；显式`NOTALONE_DISABLE_DOTENV=1`、工作树`PYTHONPATH`及`-B`，不读取业务连接。

1. `python -B -m unittest tests.unit.tasks.test_runtime_config tests.unit.tasks.test_runtime_execution tests.unit.memory_extraction.test_bounded_flow tests.unit.memory_extraction.test_bounded_runtime_proof -v`：48项通过。
2. `python -B -m unittest tests.integration.tasks.test_bounded_runtime_acceptance tests.integration.tasks.test_runtime_config tests.integration.server.test_task_runtime_config_api tests.integration.tasks.test_bounded_evaluation_sources.BoundedEvaluationSourcesTest.test_actual_sdk_outputs_confirm_correct_reject_and_rebind_without_new_model_call -v`：35项通过，包含19个正式来源/任务/API控制、8个配置持久化、7个HTTP合同、1个实际SDK Mock生命周期控制。随机自有隔离库由测试删除。
3. 独立Agent只读缺口审查：基础接线与生命周期已有覆盖，未发现需要重建框架的证据；真实模型proof3交付及七轴质量仍缺。

上述83项是本轮工程检查，SDK响应为Mock，真实模型成绩为0；不与旧批次累加质量分母。最终结果与三线提交待完成后追加。
