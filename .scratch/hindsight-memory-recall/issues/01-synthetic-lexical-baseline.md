# 01 — 合成数据与词法基线

> Triage: ready-for-agent
> State: resolved
> Blocked by: None
> 规格：[Hindsight 本机记忆召回对照实验](../spec.md)
> 来源：2026-10-04 用户认可四项任务粒度与依赖，并授权发布和执行。

## 交付行为

给定本任务新建的合成已采纳记忆、当前正文与预先标注的相关 ID，使用真实词法检索和回复上下文组装，输出按本地记忆身份计分的基线结果及数据版本。无需 Hindsight 即可演示和复验。

## 验收

- [x] 校准和最终数据按场景分离，先标 gold 后运行；至少 60 条最终中文改写正例，每个主 bank 至少 300 条合成已采纳关系记忆。
- [x] 包含多相关项、低词面重合、同主题难负例、直述、无关短句、不同 owner/同名联系人和独立预算压力组；主收益组 gold 可容纳于 5 条/600 字符。
- [x] 真实 Context 完成预算及当前性复验后按本地 ID 计算 Recall@5、Precision@5、无关注入和正例空结果；失败正例不移出分母。
- [x] 本人记忆单独报告，保持现有路径和 3 条/240 字符预算；不混入联系人主指标。
- [x] 数据、gold、种子与查询规则可冻结并复现，静态有效期在整轮运行内稳定；可保存逐 query 结果。
- [x] 在确认的 Context/runner 接缝完成 red → green 与相关回归、类型检查；旧 109 条结果不重命名为 Recall@5。
- [x] 只处理新建合成资料，不连接业务库，不修改默认产品行为。

## 完成记录

已交付 [数据、接缝与结果说明](../../../experiments/hindsight/DATASET.md)，正式冻结 `hindsight-synthetic-v2`：397 条合成快照、133 条 query；最终 60 个改写 query 来自 20 个独立主题。人工语义审查在首次 A 运行前补齐跨主题 gold，审查前 v1 未评测并保留。

- 实际命令（均先 `conda activate NotAlone`，显式 `PYTHONPATH=src`）：`python -m unittest discover -s tests/unit/experiments -v`（9 项通过）；`python -m unittest tests.unit.retrieval.test_recall_evaluation tests.unit.retrieval.test_lexical tests.unit.reply.test_context_retrieval -v`（66 项通过，包含旧 109 条评测原门槛）；`python -m mypy src/notalone/experiments --follow-imports=silent`（4 个源码文件通过）；`python -m notalone.experiments.hindsight_baseline --freeze-only` 与同入口 A 实际运行完成。
- A 结果：最终改写宏 Recall@5 为 1.67%，直述 94.17%；最终 95 条质量组无关注入 15/95（15.79%）、45 个非 gold ID；范围、预算、重复违规均 0，失败 0/133。
- red → green：真实 Context 正例、错范围 gold 冻结拒绝、Port 初检异常被 Context 降级时仍保留实验失败及 gold 分母。后者只增加实验观察包装，生产 Context 行为未改变。
- 数据影响：只初始化和导出新建合成资料，不连接业务库或外部推理，不修改生产装配。本人路径和独立预算保持现行行为。
- 剩余风险：合成 query 来自 20 个主题的重复表达，不能按 60 个独立场景外推真实效果；低覆盖属于合成压力组观测。Hindsight 实际收益、完整时延、外部副本删除和本机资源成本由后续任务验证。

## Comments
