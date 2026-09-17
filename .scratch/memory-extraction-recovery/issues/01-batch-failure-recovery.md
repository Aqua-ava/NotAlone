# 01 — 提取失败的批次级恢复

**What to build:** 提取的批次失败不再永久卡住联系人。把运行时失败分成 `unavailable`（模型调用失败，可重试、不计数）与 `invalid_output`（模型有返回但输出不可用，同一输入会重现）；只对 `invalid_output` 按失败区间计数，只有区间起点与上次记录相同才累加，连续 3 次后跳过该区间：写入最近跳过记录、把水位推进到区间末尾，并在同一次运行里继续处理后续批次。未达阈值或 `unavailable` 失败仍停止本次运行且不推进水位。`ExtractionRunStats` 区分 `failed_batches`（本次运行提前停止）与 `skipped_batches`（已跳过的批次）并携带跳过区间明细；CLI 打印跳过信息，跳过的批次不计入退出码；后台 Worker 只在 `failed_batches>0` 时记 retryable 失败，纯跳过的运行视为步骤成功。同策略覆盖提取与写入裁决两类批次级模型调用失败。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无

## Comments

- 2026-09-17 认领并开始实现。设计经三轮 grilling 确认，产出 ADR-029 与本票；与召回第一期工单（`.scratch/memory-recall/`）互不依赖。
- 2026-09-17 完成实现与验证。code review 后按 Standards/Spec 两轴修正：移除未使用的阈值参数、复用词法阈值常量语义、补充写入裁决失败路径测试、登记 ADR 索引与数据库迁移文档。
- 验证记录：单元测试 528 个通过（含新增恢复策略 8 个、命令级 6 个、外壳分类 2 个）；集成测试 31 个通过（含水位数与失败状态的新 PostgreSQL 测试 5 个）；迁移 034 在 `notalone_test` 重复执行通过，已应用至 `notalone_test` 与 `notalone_dev`。
- 剩余风险：真实模型下"连续输出不可用"的端到端跳过未做真机验证；人工重试入口（重置水位或重试跳过区间）留后续票。
