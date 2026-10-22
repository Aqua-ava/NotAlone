# 提取命令的批次流水线

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

按 [spec](../spec.md) 实现批次流水线：提取命令新增批次并发度参数（默认 1）。A 段（提取与来源核验）按批并行至该并发度；B 段（采纳、写入、过程记录完成、水位提交）在单写队列中按批序串行。预取在途批数不超过并发度；任一批失败即停止后续提交；已预取未提交的批把过程记录收为停止，不推进水位、不计数；模型输出无效的连续失败仍按原阈值跳过并推进水位。水位只按批序前进。

## 验收

- [ ] 单元用例：并发度 3 时提取调用在途峰值恰为 3，无死锁，且不超过上限。
- [ ] 单元用例：采纳、写入、水位严格按批序提交（按批号与提交时水位值断言）。
- [ ] 单元用例：第 k 批失败后第 k+1 批不提交；水位停在失败批之前；预取批的过程记录状态为停止。
- [ ] 单元用例：模型输出无效的连续失败跳过区间与串行一致。
- [ ] 默认并发度 1 时既有串行用例全部通过。

## Comments

## Answer

`run_extraction` 新增可选参数 `batch_concurrency`（默认 1；bool、非 int、小于 1 抛 `ValueError`）。并发度 1 完全走原有逐批 A→B 串行循环，不建线程池；大于 1 走批次流水线：

- 主线程只预计算批序与水位链（`_BatchStep`），不提前构建窗口载荷；`ThreadPoolExecutor(max_workers=batch_concurrency)` 按序提交，每批在本线程内构建载荷、开始 trace、进入独立 `TraceSession` 与独立 `_TimedExtractionRuntime`，完成提取 + 来源核验。
- `_BatchWriteGate`（Condition）保证 B 段单写且严格批序：`MemoryAdoption`、模型台账、`trace.complete`、水位提交、统计累计只在轮到本批的线程执行。
- `_commit_batch` 返回失败时置中止并唤醒全部等待者：已预取批收 `status="stopped"`（`reason="aborted_after_batch_failure"`、水位三者相等、`watermark_commit="not_advanced"`、`not_executed` 齐全），不推进水位、不累加统计；尚未开始的排队批不创建 trace。
- 未预期异常与模型停止：先 `gate.abort()` 唤醒等待者，trace 由现有异常路径收尾，再把异常抛给调用方；无死锁。

新增 6 个用例：并发峰值恰为 3、采纳与水位严格按批序、第 3 批失败后预取批停止、并发下 INVALID_OUTPUT 跳过区间与串行一致、模型停止传播且无挂起、非法并发度拒绝。

验证：
- `tests.unit.memory_extraction.test_command` + `tests.unit.tasks.test_runtime_execution` → 47 tests OK。
- `discover tests/unit/memory_extraction` → 1063 tests，13 个失败与改动前集合完全一致，无新增。
- 全量 `tests/unit` 改动前后失败集合逐条一致（14F/5E 既有）。
- 并发用例连续重复 50 次稳定。

已知边界：trace 适配器由多线程共享（begin 已加锁串行化）；已预取但被停止的批不补出站台账；并发度 1~4 的装配校验与接入留给票 04。
