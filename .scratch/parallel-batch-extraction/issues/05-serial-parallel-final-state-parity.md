# 串行与并行终态一致集成回归

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 03

按 [spec](../spec.md) 用同一份合成消息集与相同假运行时，分别以并发度 1 和 3 跑完整提取，断言业务终态一致：确认记忆、待确认候选、水位、过程记录状态与进度回执。

## 验收

- [ ] Postgres 集成用例通过；两种并发度的业务终态逐项一致。
- [ ] 并发度 3 的用例断言实际出现并行（在途峰值大于 1），不是退化成串行。
- [ ] 用例不写真实聊天、不调用真实模型。
- [ ] 记录用例耗时，确认适合放进相关集成回归。

## Comments

## Answer

新增 Postgres 集成回归 `backend/tests/integration/memory_extraction/test_serial_parallel_parity.py`（用例 `test_serial_and_parallel_reach_the_same_business_final_state`）。6 条合成消息、`batch_size=1` 形成 6 批，覆盖自动采纳与保留待确认两种模式：

- 每个场景使用独立 owner/contact scope，串行（并发 1）与并行（并发 3）各跑一遍；不写真实聊天、不调用真实模型。
- 断言终态一致：确认记忆与待确认候选按（文本、类别、topic、状态、采纳方式）多重集相等；水位映射回消息序号相等；每批一条过程记录且状态序列一致；`ExtractionRunStats` 全字段逐项相等（`skipped_ranges` 只比长度、序号与 code）。
- 断言并发 3 确实并行：三方闩锁记录在途峰值，`peak > 1` 且 `<= 3`；有界等待 5 秒，退化为串行会快速失败而不是挂起。
- 场景非空保障：批数、失败批、跳过区间、采纳、重复、契约拒绝均非零；非自动模式下 pending 与非记忆跳过非零。

验证：
- `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_parallel_parity_test python -m unittest tests.integration.memory_extraction.test_serial_parallel_parity -v` → 1 test OK（约 3.8s）。
- 连续 10 次重复运行全部通过（单次 3.7~4.7s）。
- 运行后测试库 owner 与过程记录行数归零；库保留供复核。
- 该库上既有 `test_extraction_trace` 的 4 个失败可单独复现，与本次新增无关。
