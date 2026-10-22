# 拆分提取命令的「模型调用」与「提交」两段

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

按 [spec](../spec.md) 与 [ADR-099](../../../architecture/adr/099-parallel-batch-extraction.md) 对提取命令做行为不变的预重构：每批处理显式拆成两段。A 段构建窗口并完成提取与来源核验，产出该批结果；B 段完成裁决与采纳、写入、过程记录完成和水位提交。串行路径仍是逐批 A → B，行为与现状完全一致。

## 验收

- [ ] 现有提取命令单元用例全部通过；默认路径仍逐批串行，不出现并发行为。
- [ ] 每批的过程记录、模型台账条数、统计字段（批数、处理消息数、采纳、跳过、失败）与改动前一致。
- [ ] 失败批仍立即停止整轮；模型输出无效的连续失败仍触发跳过区间并推进水位。
- [ ] 新增一个用例锁定串行契约：进入某批 A 段之前，上一批 B 段已完成；A、B 交替且不交叉。
- [ ] 本地提交只含本票变更，并记录实际运行的最小验证。

## Comments

## Answer

`run_extraction` 的逐批循环已拆成显式 A/B 两段：A 段 `_plan_batch` + `_extract_batch`（窗口与载荷、批次键、TraceSession、提取与来源核验），B 段 `_commit_batch`（采纳、失败/跳过处理、模型台账、trace.complete 与水位提交、统计累计）；内部新增 `_PlannedBatch`、`_BatchExtraction`、`_RunProgress`。对外签名与默认值不变，TraceSession 仍横跨 A+B，模型事件归属不变；失败即停与 INVALID_OUTPUT 跳过阈值语义保持。

新增用例 `test_serial_batches_finish_commit_before_next_extraction`：以 begin/complete/commit 记录断言每批严格 `A:begin → A:extract → B:trace_complete → B:commit` 后才进入下一批 A，并核对完整统计与水位。

验证：
- `python -m unittest tests.unit.memory_extraction.test_command` → 30 tests OK（29 既有 + 1 新增）。
- 相关回归 `test_flow`、`test_recovery`、`test_task_trace`、`test_invalid_batch_retry` → 29 tests OK。
- 全量 `tests/unit`：改动前后失败集合完全一致（14F/5E 均为既有失败），本票未新增失败。
