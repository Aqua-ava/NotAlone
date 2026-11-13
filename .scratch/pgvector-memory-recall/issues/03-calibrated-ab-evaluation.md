# 03 — 独立阈值校准与 A/B 评测

> Triage: ready-for-agent
> State: resolved
> Blocked by: 01, 02
> 规格：[原 PostgreSQL＋pgvector 记忆召回隔离评估](../spec.md)

## 交付行为

复用冻结的合成数据和 gold，使用 A「现有词法基线」与 B「pgvector 候选加本地复验」完成独立 dev 校准和最终对照。阈值只在 dev 选择，最终结果不得回调配置。

## 验收

- [x] 保存实际模型、扩展、数据哈希、阈值、候选预算和运行环境。
- [x] 开发集与最终集严格分离；最终改写 Recall@5、直述召回、无关注入和空结果分母完整保留。
- [x] 计时包含 embedding、向量查询、候选映射、本地复验和上下文选择；报告 P50/P95/最大值及失败。
- [x] 运行相同查询、资料范围、预算和当前性复验；不使用 Hindsight 服务。
- [x] 结果明确说明是否达到 +10pp、无关注入不增加和 P95≤1s 门槛。

## Answer

已完成 dev 独立阈值校准和 final A/B runner，结果保存模型摘要、扩展版本、数据摘要、阈值、候选预算、逐 query 结果、延迟和 gates。最终改写 Recall@5 为 A 1.67%、B 26.39%，提升 24.72 个百分点；直接 Recall@5 两组均为 94.17%（直述组误注入由 5 增到 13）；B 完整检索 P50/P95/最大值为 16.62/28.22/54.06 ms，失败为 0。B 质量组无关注入为 36/95，高于 A 的 15/95，因此“无关注入不增加”失败；最终 verdict 为“未达到门槛”。

校准隔离：`calibration.threshold_rows` 保存全部 601 个 dev 候选阈值及其 dev 注入数与召回，`threshold_source` 明示 final 相似度不进入阈值网格；28 个阈值满足 dev 注入上限，选中的 `tau=0.5767089472239593` 在 dev 上注入 0、改写宏 Recall 0.467。收尾前的版本把 final 相似度也放进了候选网格，已修正并重跑，冻结 `tau` 与全部指标不变，但旧做法本身不再保留。

验证（实际命令，模型路径与本轮临时目录为真实值）：

```text
PYTHONPATH=src:. /tmp/notalone-hindsight-runtime-f7dd3f4/venv/bin/python -m experiments.pgvector.evaluate \
  --model-path /tmp/notalone-hindsight-runtime-f7dd3f4/models/hub/models--BAAI--bge-small-zh-v1.5/snapshots/7999e1d3359715c523056ef9478215996d62a620 \
  --output experiments/pgvector/runs/native-v3 \
  --runtime-dir /tmp/notalone-pgvector-memory-recall-run-20261004-v3
```

单轮运行 80.45 秒，写入 393 条 512 维向量；`provenance` 在运行开始时采样，`environment` 记录 Python/平台/依赖版本。产物：[result.json](../../../experiments/pgvector/runs/native-v3/result.json)。

限制：两臂使用内存夹具基线，未直连正式 `PostgresRetrieval`；阈值网格只含 dev 分值，不搜索 final 邻近阈值；“失败/超时不从分母移除”在本轮失败数为 0，且记忆检索端口没有超时参数，只有代码路径证据。

## Comments

- 2026-10-04：实现完成并标记 resolved；验收由主 Agent 独立重算产物后逐项确认。
- 2026-10-04：收尾复查发现阈值候选网格取自全部 133 条 query（含 final 相似度），违反“阈值只在 dev 校准”；已改为只用 dev 候选分值并落盘 `threshold_rows`，重跑后指标与 `tau` 不变。产物路径改指 `runs/native-v3`，并补齐 `candidate_limit`、`environment` 与运行开始时采样的 `provenance`。
