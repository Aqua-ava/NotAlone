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

上述83项是本轮工程检查，SDK响应为Mock；不与旧批次累加质量分母。

## 集成与真实验证

- 核心代码 `d159417d` → 集成 `2cfe0a4b`：保留显式历史／条件前件依赖和已知未决标记；核心边界测试与结果 `c42252cf` → `660cf31c`。
- 指代独立测试与Agent Gold／计划 `eeeeb0dd` → `6674c85d`，生产修改已包含在核心共享提交，未重复改写。
- E2边界提示 `3e9403d4` → `f9b8ebff`，保持旧v3/v4/schema。最终43项运行时／依赖／SDK相关回归通过。
- 集成后bounded相关46项、依赖相关10项通过；v3提示澄清后proof相关27项通过。各组有重叠，不累加为唯一测试数；不重跑旧长全量。
- 本票状态澄清与v3六行提示各经Standards／Spec独立Agent审查，均0实质问题；提示改善幅度不能由代码审查推断。
- [两次独立真实场](runtime15-agent-result-20261018.md)共4次已知HTTP200、零重试：首场位置越界拒绝，次场V正文无法脱敏保存，正式审核均0。每场仅首窗unknown、后14unrun，余28分别永久关闭；七轴质量及六规则真实交付未达标。

工程修复和本地集成完成不等于原三票全部质量义务完成。核心六窗／四留出、本票15窗真实proof3／七轴门保持未覆盖，原03第一AC不勾、State继续claimed，生产放行表仍空。不会把Agent替代人工解释为降低质量门。

公开历史与当前文件扫描已执行，结果12项均来自既有工程说明的本机路径（当前／历史各6），本轮未新增；未越界改写历史。所有本票自有模型进程与测试库已清理，临时三字段凭据文件已删除；未构建App或新增大体积构建缓存。

最终集成Standards／Spec固定`5b4153b7...f9b8ebff`独立复审均0新增实质阻塞；未以此认证真实质量。
