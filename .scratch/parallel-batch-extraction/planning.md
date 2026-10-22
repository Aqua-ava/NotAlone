# 提取批次流水线：任务索引与工作流状态

> 规格：[spec.md](spec.md)；决策：[ADR-099](../../architecture/adr/099-parallel-batch-extraction.md)。
> 基线：改前实测 945 条导入约 1.5~2 小时（单批 32s／76s／103s，模型调用占绝大部分）。实现尚未开始；按 Blocked by 顺序由 Agent 领取，State 在领取/完成时更新。

## 正式任务

| 编号 | 任务 | State | Blocked by |
| --- | --- | --- | --- |
| 01 | [拆分提取命令的「模型调用」与「提交」两段](issues/01-split-extraction-and-commit.md) | open | none |
| 02 | [模型优先级控制支持有界后台并发](issues/02-bounded-background-concurrency.md) | open | none |
| 03 | [提取命令的批次流水线](issues/03-batch-pipeline.md) | open | 01 |
| 04 | [装配层接通批次并发与租约复验](issues/04-wiring-concurrency-and-lease-guard.md) | open | 02, 03 |
| 05 | [串行与并行终态一致集成回归](issues/05-serial-parallel-final-state-parity.md) | open | 03 |
| 06 | [开发版真实导入端到端验收与文档收敛](issues/06-real-import-end-to-end-validation.md) | open | 04, 05 |
