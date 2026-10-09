# Hindsight 实验两轴审查

固定点为任务发布提交 `481cc3f016cdae6bac5b28acfd9076317c49be71`，审查实现提交 `50a9a16daf9507907f33930e0924a1e9d260b1cb`。两个独立只读 Agent 并行审查，范围为：

```sh
git diff 481cc3f...50a9a16 -- .scratch/hindsight-memory-recall experiments/hindsight src/notalone/experiments tests/unit/experiments
```

并发任务提交 `909035d` 的三份人物核验文档完整保留，未纳入本实验评审。

## Standards

书面标准：**0 个硬性违规**。已核对 `AGENTS.md` 产品边界、`docs/agents/engineering.md` 的适配层、环境、合成测试要求和任务状态规则。未见生产路径改装、真实私密资料、越界检索、外部发送或提前宣称收尾完成。

可选判断：**2 处 possible Duplicated Code**。

- `hindsight_baseline.py:365–406` 与 `hindsight_comparison_io.py:36–76` 重复执行 Git 提交/差异读取及逐文件 SHA-256 汇集。模块集合和输出字段存在真实差异；未来可提取共有证据采集形状，降低遗漏风险。
- `hindsight_dataset.py:834–852` 三次重复近期状态条件，分别控制分类、生效和失效时间。未来可先计算一个有意义的布尔值，统一近期状态集合。

这两项是 Fowler 基线的可选判断，不违反书面标准、不阻塞结项。审查建议保留本轮冻结源码和证据，因此本轮没有为整理建议修改已评估算法。Observed/Captured 包装具有失败观察与权威审计职责，不构成纯 Middle Man。

只读摘要抽查确认 v1/v2 数据和 gold 哈希匹配；正式冻结配置、计划和校准哈希匹配；103 次/臂、100 次实际 HTTP、0 失败；P95 门为 false；两轮 bank 清理归零、两个生命周期运行各 27 点通过。

## Spec

**0 项缺失或部分实现、0 项范围扩张、0 项错误实现。** 审查时 04 保持 claimed、根收尾明确待完成，没有误报状态。

独立解析逐尝试数据，重算 103 次/臂、固定交替，A/B 改写 Recall 1.67%/15.00%、质量组误注入 15/95→12/95，以及按 `ceil(0.95N)` 得到 B P95 1,782.961 ms。失败和权威字段违规均为 0，与报告的未达门槛结论一致。

真实 Context、权威回读与 `validate_current` 保持本地身份、来源、置信度和版本。1,744 个 dev 阈值的独立排序得到相同 tau，冻结早于 final，参与源码及预验摘要一致。阶段覆盖重算为 96.67%→15%→15%→15%，3,365 个空映射候选全部拒绝。首轮 19/30 失败完整保留；实际生命周期 27 点通过；正式四个 bank 活动计数和索引归零。静态 310 条索引与陈旧副本删除证据明确区分。

Standards 共 0 个硬性违规、2 个可选重复逻辑判断，最高级别仍为可选整理；Spec 共 0 个偏差。

## 根收尾

根收尾的 697 项单元测试和 13 模块 mypy 通过。仅补充状态、审查与清理记录，未改冻结源、数据、阈值或正式结果。API/pg0 停止与数据库目录移除见 [finalization.json](finalization.json)；公开模型与独立 venv 缓存保留。实验执行完成，生产接入未获放行。
